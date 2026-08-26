import { useEffect, useMemo, useState } from 'react';
import { Crosshair, Paperclip, RefreshCw } from 'lucide-react';
import type { OpArchiveEntry, OpConferenceSnapshot, OpTotalsSnapshot, Sg5VerifyResult } from '@shared/ipc-types';
import { buildArrivalTimeline, formatCountdown } from '@shared/sg5-arrivals';
import { formatHms } from '@shared/sg4-timing';
import { buildScorecard, parseDistribution, warRoomStatus } from '@shared/war-room';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import ProgressBar from '../../components/ProgressBar';
import ToastViewport from '../../components/Toast';
import { useToast } from '../../hooks/useToast';
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
