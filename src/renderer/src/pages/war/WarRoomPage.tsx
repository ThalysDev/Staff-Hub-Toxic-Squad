import { useEffect, useMemo, useState } from 'react';
import { Copy, Crosshair, Download, Paperclip, RefreshCw, Trash2, Upload, Users } from 'lucide-react';
import type { OpArchiveEntry, OpConferenceSnapshot, OpTotalsSnapshot, Sg5VerifyResult } from '@shared/ipc-types';
import { groupToOriginsText, groupToTargetsText, type GroupEntry } from '@shared/groups-rules';
import { buildArrivalTimeline, formatCountdown } from '@shared/sg5-arrivals';
import { formatHms } from '@shared/sg4-timing';
import { buildScorecard, parseDistribution, warRoomStatus } from '@shared/war-room';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import ProgressBar from '../../components/ProgressBar';
import ToastViewport from '../../components/Toast';
import { useSessionStatus } from '../../hooks/useSessionStatus';
import { useToast, type ToastVariant } from '../../hooks/useToast';
import type { PageId } from '../../modules';

type DistributionEntry = ReturnType<typeof parseDistribution>[number];
type ParsedDistribution = { entries: DistributionEntry[] } | { error: string };

interface WarRoomPageProps {
  /** Leva o líder à criação de OP quando a sala está vazia. */
  onNavigate: (page: PageId) => void;
}

/** 1 jogador / 2 jogadores — sem "(s)" de sistema. */
function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

/** Alvos sem comando e jogadores com falta ≥1 ficam em vermelho. */
function coverageClass(coveragePct: number): string {
  if (coveragePct >= 80) return 'ok';
  if (coveragePct >= 50) return 'text-warn';
  return 'error';
}

export default function WarRoomPage({ onNavigate }: WarRoomPageProps) {
  const { toasts, push, dismiss } = useToast();
  const session = useSessionStatus();
  const [ops, setOps] = useState<OpArchiveEntry[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [verifyResult, setVerifyResult] = useState<Sg5VerifyResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'verify' | 'attach' | null>(null);
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());

  useEffect(() => {
    const unsubscribe = window.staffhub.events.onQueueProgress(setProgress);
    return unsubscribe;
  }, []);

  async function loadOps(): Promise<OpArchiveEntry[]> {
    const list = await window.staffhub.opArchive.list();
    setOps(list);
    return list;
  }

  // Estado inicial: lista do arquivo uma vez no mount.
  useEffect(() => {
    loadOps().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    });
  }, []);

  const selected = useMemo(() => ops.find((op) => op.id === selectedId) ?? null, [ops, selectedId]);

  function handleSelect(id: string): void {
    setSelectedId(id);
    setVerifyResult(null); // troca de OP nunca mistura painel antigo
    setError('');
  }

  // Distribuição da OP selecionada (parse puro — erro fica inline).
  const parsedDistribution = useMemo<ParsedDistribution | null>(() => {
    if (selected === null) return null;
    try {
      return { entries: parseDistribution(selected.distribution) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [selected]);

  const warRoom = useMemo(() => {
    if (parsedDistribution === null || 'error' in parsedDistribution || verifyResult === null) return null;
    return warRoomStatus(
      parsedDistribution.entries,
      verifyResult.villages.map((village) => ({ coord: village.coord, commands: village.commands })),
    );
  }, [parsedDistribution, verifyResult]);

  const timeline = useMemo(() => {
    if (verifyResult === null) return null;
    return buildArrivalTimeline(
      verifyResult.villages.map((village) => ({
        coord: village.coord,
        commands: village.commands,
        loadedAt: village.loadedAt,
      })),
    );
  }, [verifyResult]);

  // Countdown ao vivo só enquanto existe agenda de chegadas.
  useEffect(() => {
    if (timeline === null || timeline.entries.length === 0) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [timeline]);

  /** Próximas 6 chegadas; as caídas há menos de 1 min aparecem como "atrasado". */
  const upcomingArrivals = useMemo(
    () =>
      timeline === null
        ? []
        : timeline.entries.filter((entry) => entry.arrivalAt > nowTick - 60_000).slice(0, 6),
    [timeline, nowTick],
  );

  // Scorecard sobre a lista ATUAL do arquivo (recarrega após anexar conferência).
  // Fail-closed em render: OP arquivada com distribution malformada (ex.: JSON
  // editado à mão) mostra erro legível em vez de derrubar a página.
  const scorecard = useMemo<{ rows: ReturnType<typeof buildScorecard> | null; error: string }>(() => {
    try {
      return { rows: buildScorecard(ops), error: '' };
    } catch (err) {
      return { rows: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [ops]);

  const commandCount = verifyResult?.villages.reduce((sum, village) => sum + village.commands.length, 0) ?? 0;

  async function runVerify(): Promise<void> {
    if (selected === null) return;
    setBusy('verify');
    setError('');
    try {
      const entries = parseDistribution(selected.distribution);
      const result = await window.staffhub.sg5.verify(entries);
      setVerifyResult(result);
      const totalCommands = result.villages.reduce((sum, village) => sum + village.commands.length, 0);
      push(
        'ok',
        `Reverificação concluída: ${pluralize(totalCommands, 'comando', 'comandos')} em ${pluralize(result.villages.length, 'aldeia', 'aldeias')}.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    } finally {
      setBusy(null);
    }
  }

  async function runAttach(): Promise<void> {
    if (selected === null || warRoom === null) return;
    setBusy('attach');
    setError('');
    try {
      // Totalizador fresco dos alvos antes de anexar (convertido para snapshot).
      const totalsResult = await window.staffhub.sg5.totals(selected.targets);
      const totals: OpTotalsSnapshot[] = totalsResult.totals.map((total) => ({
        playerName: total.playerName,
        attacks: total.attacks,
        fakes: total.fakes,
        nobleAttacks: total.nobleAttacks,
        supports: total.supports,
        total: total.total,
      }));
      const conference: OpConferenceSnapshot = {
        verifiedAt: new Date().toISOString(),
        coveragePct: warRoom.coveragePct,
        perPlayer: warRoom.perPlayer.map((row) => ({
          playerName: row.playerName,
          assigned: row.assigned,
          sent: row.sent,
        })),
        targetsWithoutCommand: [...warRoom.targetsWithoutCommand],
      };
      await window.staffhub.opArchive.attachConference(selected.id, conference, totals);
      await loadOps(); // recarrega o arquivo para o scorecard refletir na hora
      push('ok', `Conferência anexada à OP "${selected.title}".`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="col">
      <PageHeader
        kicker="Sala de Guerra"
        title="Monitoramento da OP"
        description="Acompanhe a OP arquivada ao vivo: cobertura dos alvos, próximas chegadas e scorecard da equipe."
      />

      {/* ---- Seletor da OP ativa ---- */}
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">OP ativa</h2>
        </div>
        <div className="card-body">
          {ops.length === 0 ? (
            <EmptyState
              icon={Crosshair}
              title="Nenhuma OP arquivada ainda"
              hint="Crie a operação e arquive-a para acompanhar aqui, ao vivo."
              action={
                <button type="button" className="btn" onClick={() => onNavigate('sg4')}>
                  <Crosshair size={15} aria-hidden="true" />
                  Criar OP
                </button>
              }
            />
          ) : (
            <>
              <label className="field" style={{ maxWidth: 420 }}>
                <span className="field-label">Selecionar OP arquivada</span>
                <select
                  className="select"
                  value={selectedId}
                  onChange={(event) => handleSelect(event.target.value)}
                >
                  <option value="">— escolha uma OP —</option>
                  {ops.map((op) => (
                    <option key={op.id} value={op.id}>
                      {op.title} · {new Date(op.createdAt).toLocaleString('pt-BR')}
                    </option>
                  ))}
                </select>
              </label>

              {selected !== null && (
                <div className="row" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn"
                    style={{ minWidth: 210 }}
                    onClick={() => void runVerify()}
                    disabled={busy !== null}
                  >
                    <RefreshCw size={16} aria-hidden="true" />
                    {busy === 'verify' ? (
                      <>
                        <span className="btn-spinner" aria-hidden="true" /> Reverificando…
                      </>
                    ) : (
                      'Reverificar agora'
                    )}
                  </button>
                  {busy !== null && progress !== null && (
                    <ProgressBar done={progress.done} total={progress.total} label={progress.label} />
                  )}
                </div>
              )}

              {selected === null && <p className="muted" style={{ marginTop: 8 }}>Selecione uma OP acima para começar o monitoramento.</p>}
              {parsedDistribution !== null && 'error' in parsedDistribution && (
                <p className="error" role="alert">Distribuição inválida: {parsedDistribution.error}</p>
              )}
            </>
          )}
        </div>
      </section>

      {error !== '' && (
        <p className="error" role="alert">{error}</p>
      )}

      {/* ---- Grupos salvos (Análise de Tropas) ---- */}
      <GroupsCard world={session.world} push={push} />

      {/* ---- Painel de guerra ---- */}
      {warRoom !== null && (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Painel de guerra</h2>
            <span className="spacer" />
            <span className="pill pill--muted">
              {pluralize(commandCount, 'comando', 'comandos')} ·{' '}
              {pluralize(timeline?.unresolved ?? 0, 'sem horário', 'sem horários')}
            </span>
          </div>

          <div className="col" style={{ gap: 16 }}>
            {/* (a) Cobertura */}
            <div className="row" style={{ gap: 12, alignItems: 'baseline' }}>
              <span className={coverageClass(warRoom.coveragePct)} style={{ fontSize: 42, fontWeight: 800 }}>
                {warRoom.coveragePct}%
              </span>
              <span className="muted">de cobertura dos alvos da OP</span>
            </div>

            {/* (b) Alvos sem comando */}
            {warRoom.targetsWithoutCommand.length > 0 ? (
              <div className="col" style={{ gap: 6 }}>
                <strong>Alvos sem comando ({warRoom.targetsWithoutCommand.length})</strong>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {warRoom.targetsWithoutCommand.map((coord) => (
                    <span key={coord} className="pill cell-nowrap">{coord}</span>
                  ))}
                </div>
              </div>
            ) : (
              <p className="ok">Todos os alvos têm pelo menos um comando chegando.</p>
            )}

            {/* (c) Situação por jogador */}
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Jogador</th>
                    <th scope="col" className="cell-num">Alvos</th>
                    <th scope="col" className="cell-num">Enviados</th>
                    <th scope="col" className="cell-num">Falta</th>
                  </tr>
                </thead>
                <tbody>
                  {warRoom.perPlayer.map((row) => {
                    const missing = row.assigned - row.sent;
                    return (
                      <tr key={row.playerName}>
                        <td className="cell-nowrap">{row.playerName}</td>
                        <td className="cell-num">{row.assigned}</td>
                        <td className="cell-num">{row.sent}</td>
                        <td className={`cell-num${missing > 0 ? ' error' : ''}`}>{missing > 0 ? missing : 0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* (d) Próximas chegadas */}
            <div className="col" style={{ gap: 6 }}>
              <strong>Próximas chegadas</strong>
              {upcomingArrivals.length === 0 ? (
                <p className="muted">Nenhum comando com horário em formato máquina para contar chegadas.</p>
              ) : (
                upcomingArrivals.map((entry) => (
                  <div key={entry.commandId} className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                    <strong className="cell-nowrap">{formatHms(new Date(entry.arrivalAt))}</strong>
                    <span className="cell-nowrap">alvo {entry.coord}</span>
                    <span className="cell-nowrap">{entry.playerName}{entry.hasNoble ? ' ♛' : ''}</span>
                    <span className={entry.arrivalAt <= nowTick ? 'muted' : 'ok'}>
                      {formatCountdown(entry.arrivalAt - nowTick)}
                    </span>
                  </div>
                ))
              )}
            </div>

            {/* (e) Anexar conferência */}
            <div className="row">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void runAttach()}
                disabled={busy !== null || warRoom === null}
              >
                <Paperclip size={16} aria-hidden="true" />
                {busy === 'attach' ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" /> Anexando…
                  </>
                ) : (
                  'Anexar conferência à OP'
                )}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ---- Scorecard de participação ---- */}
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Scorecard de participação</h2>
          <span className="spacer" />
          <span className="pill pill--muted">
            {pluralize(scorecard.rows?.length ?? 0, 'jogador', 'jogadores')}
          </span>
        </div>
        {scorecard.error !== '' ? (
          <p className="error" role="alert">
            Arquivo de OPs com distribuição malformada: {scorecard.error}
          </p>
        ) : (scorecard.rows ?? []).length === 0 ? (
          <EmptyState
            compact
            icon={Paperclip}
            title="Sem conferências ainda"
            hint="Anexe uma conferência a partir do monitoramento acima."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Jogador</th>
                  <th scope="col" className="cell-num">OPs</th>
                  <th scope="col" className="cell-num">Esperado</th>
                  <th scope="col" className="cell-num">Enviado</th>
                  <th scope="col" className="cell-num">Faltou</th>
                </tr>
              </thead>
              <tbody>
                {(scorecard.rows ?? []).map((row) => (
                  <tr key={row.playerName}>
                    <td className="cell-nowrap">{row.playerName}</td>
                    <td className="cell-num">{row.opsParticipated}</td>
                    <td className="cell-num">{row.expected}</td>
                    <td className="cell-num">{row.sent}</td>
                    <td className={`cell-num${row.missed > 0 ? ' error' : ''}`}>{row.missed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

type PushToast = (variant: ToastVariant, message: string) => void;

/** Exportar/Remover em curso sobre um grupo específico. */
type GroupWorking = { id: string; kind: 'export' | 'remove' } | null;

function sameWorld(sessionWorld: string | null, entryWorld: string): boolean {
  return sessionWorld !== null && entryWorld.toLowerCase() === sessionWorld.toLowerCase();
}

/**
 * Card "Grupos": grupos salvos na Análise de Tropas (SG_4), prontos para
 * montar a próxima OP — copiar origens/alvos, exportar/importar arquivo e
 * remover. Grupos de outro mundo ficam visíveis, mas sem botões de uso.
 */
function GroupsCard({ world, push }: { world: string | null; push: PushToast }) {
  const [groups, setGroups] = useState<GroupEntry[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [listError, setListError] = useState('');
  const [working, setWorking] = useState<GroupWorking>(null);
  const [importing, setImporting] = useState(false);

  async function loadGroups(): Promise<void> {
    const list = await window.staffhub.groups.list();
    setGroups(list);
  }

  // Lista inicial + recarga manual (botão Recarregar).
  useEffect(() => {
    loadGroups().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      setListError(message);
      push('error', message);
      setGroups([]); // sai do "carregando" — o erro fica explícito acima da lista vazia
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reload(): Promise<void> {
    setListError('');
    try {
      await loadGroups();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setListError(message);
      push('error', message);
    }
  }

  const selected = useMemo(
    () => groups?.find((group) => group.id === selectedId) ?? null,
    [groups, selectedId],
  );
  const selectedSameWorld = selected !== null && sameWorld(world, selected.mundo);
  /** Motivo do bloqueio dos botões de uso (title) ou undefined se liberado. */
  const usageBlockedTitle =
    world === null
      ? 'Login do mundo não identificado — abra o jogo para usar este grupo.'
      : !selectedSameWorld
        ? 'Grupo de outro mundo'
        : undefined;

  function copyGroupText(buildText: (entry: GroupEntry) => string, okMessage: string): void {
    if (selected === null) return;
    navigator.clipboard.writeText(buildText(selected)).then(
      () => push('ok', okMessage),
      () => push('error', 'Não foi possível copiar — permissão de área de transferência negada.'),
    );
  }

  async function exportSelected(): Promise<void> {
    if (selected === null) return;
    setWorking({ id: selected.id, kind: 'export' });
    try {
      const result = await window.staffhub.groups.exportGroup(selected.id);
      if (result.ok) {
        push(
          'ok',
          result.path !== undefined
            ? `Grupo "${selected.nome}" exportado para ${result.path}.`
            : result.detail,
        );
      } else {
        push('error', result.detail);
      }
    } catch (err) {
      push('error', err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(null);
    }
  }

  async function removeSelected(): Promise<void> {
    if (selected === null) return;
    if (!window.confirm(`Remover o grupo "${selected.nome}"? Esta ação não pode ser desfeita.`)) return;
    setWorking({ id: selected.id, kind: 'remove' });
    try {
      await window.staffhub.groups.remove(selected.id);
      setSelectedId('');
      push('ok', `Grupo "${selected.nome}" removido.`);
      await reload();
    } catch (err) {
      push('error', err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(null);
    }
  }

  async function importFromFile(): Promise<void> {
    setImporting(true);
    try {
      const result = await window.staffhub.groups.importGroup();
      if (result.ok) {
        push('ok', result.entry !== undefined ? `Grupo "${result.entry.nome}" importado.` : result.detail);
        await reload();
      } else {
        push('error', result.detail);
      }
    } catch (err) {
      push('error', err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  const importButtonContent = importing ? (
    <>
      <span className="btn-spinner" aria-hidden="true" /> Importando…
    </>
  ) : (
    <>
      <Upload size={14} aria-hidden="true" /> Importar grupo (arquivo)
    </>
  );

  return (
    <section className="card" aria-labelledby="war-groups-title">
      <div className="card-header">
        <h2 className="card-title" id="war-groups-title">Grupos</h2>
        <span className="spacer" />
        {groups !== null && groups.length > 0 && (
          <span className="pill pill--muted">{pluralize(groups.length, 'grupo', 'grupos')}</span>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void reload()}>
          <RefreshCw size={14} aria-hidden="true" />
          Recarregar
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void importFromFile()} disabled={importing}>
          {importButtonContent}
        </button>
      </div>

      {listError !== '' && <p className="error" role="alert">Falha ao listar grupos: {listError}</p>}

      {groups === null && listError === '' ? (
        <p className="muted">Carregando grupos…</p>
      ) : groups !== null && groups.length === 0 ? (
        <EmptyState
          compact
          icon={Users}
          title="Nenhum grupo salvo"
          hint="Crie na Análise de Tropas (filtrar → Contar Full/Semi → Salvar como grupo)."
          action={
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void importFromFile()} disabled={importing}>
              {importButtonContent}
            </button>
          }
        />
      ) : groups !== null ? (
        <div className="col" style={{ gap: 12 }}>
          <div role="radiogroup" aria-label="Grupos salvos" className="col" style={{ gap: 6 }}>
            {groups.map((entry) => {
              const isSameWorld = sameWorld(world, entry.mundo);
              return (
                <label key={entry.id} className="checkbox-field">
                  <input
                    type="radio"
                    name="war-room-group"
                    value={entry.id}
                    checked={entry.id === selectedId}
                    onChange={() => setSelectedId(entry.id)}
                  />
                  <span>
                    <strong>{entry.nome}</strong>{' '}
                    <span className={`pill${isSameWorld ? '' : ' pill--muted'}`}>{entry.mundo}</span>{' '}
                    <span className="muted">{entry.papel}</span> · {entry.coords.length} coords ·{' '}
                    <span className="muted">{entry.autor} · {new Date(entry.criadoEm).toLocaleDateString('pt-BR')}</span>
                    {!isSameWorld && <span className="muted"> · outro mundo</span>}
                  </span>
                </label>
              );
            })}
          </div>

          {selected !== null && (
            <div className="col" style={{ gap: 8 }}>
              {selected.criterio !== '' && (
                <p className="field-hint">Critério do grupo: {selected.criterio}</p>
              )}
              {selected.perPlayer.length === 0 ? (
                <p className="muted">Este grupo não tem detalhe por jogador.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Jogador</th>
                        <th scope="col" className="cell-num">Fulls</th>
                        <th scope="col" className="cell-num">Semis</th>
                        <th scope="col" className="cell-num">Coordenadas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.perPlayer.map((player) => (
                        <tr key={player.playerName}>
                          <td className="cell-nowrap">{player.playerName}</td>
                          <td className="cell-num">{player.fulls}</td>
                          <td className="cell-num">{player.semis}</td>
                          <td className="cell-num">{player.coords.length}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={!selectedSameWorld || working !== null || importing}
                  title={usageBlockedTitle}
                  onClick={() =>
                    copyGroupText(groupToOriginsText, `Origens do grupo "${selected.nome}" copiadas — cole em INFORMAÇÕES ORIGEM (SG_4).`)
                  }
                >
                  <Copy size={14} aria-hidden="true" />
                  Copiar origens (SG_4)
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={!selectedSameWorld || working !== null || importing}
                  title={usageBlockedTitle}
                  onClick={() =>
                    copyGroupText(groupToTargetsText, `Coordenadas alvo do grupo "${selected.nome}" copiadas — prontas para colar.`)
                  }
                >
                  <Copy size={14} aria-hidden="true" />
                  Copiar alvos
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={working !== null || importing}
                  onClick={() => void exportSelected()}
                >
                  {working !== null && working.id === selected.id && working.kind === 'export' ? (
                    <>
                      <span className="btn-spinner" aria-hidden="true" /> Exportando…
                    </>
                  ) : (
                    <>
                      <Download size={14} aria-hidden="true" /> Exportar
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-ghost--danger btn-sm"
                  disabled={working !== null || importing}
                  onClick={() => void removeSelected()}
                >
                  {working !== null && working.id === selected.id && working.kind === 'remove' ? (
                    <>
                      <span className="btn-spinner" aria-hidden="true" /> Removendo…
                    </>
                  ) : (
                    <>
                      <Trash2 size={14} aria-hidden="true" /> Remover
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
