import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  AlertTriangle,
  Copy,
  Hourglass,
  Info,
  Trash2,
  TrendingDown,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  DEFAULT_MIN_OFF_POP_GROWTH,
  DEFAULT_MIN_VILLAGE_GROWTH,
  MAX_TROOPS_HISTORY,
  diffTroopsVersions,
  type TroopsDiffRow,
  type TroopsHistoryVersion,
} from '@shared/snapshot-history';
import {
  AUDIT_SIGNAL_LABEL,
  DEFAULT_INACTIVE_ABS_OFF_POP,
  DEFAULT_SHARP_DECLINE_OFF_POP,
  DEFAULT_SHARP_DECLINE_VILLAGES,
  auditSignals,
  formatAuditDiffTsv,
  formatPlayerTimelineTsv,
  playerTimeline,
  reconcileSelection,
  tribeTimeline,
  type AuditSignal,
  type AuditSignalKind,
  type PlayerTimelinePoint,
} from '@shared/member-audit';
import { fold } from '@shared/fold';
import { useToast } from '../../hooks/useToast';

/**
 * SG_2 — "Auditoria de Membros" (substitui o antigo "Histórico e Evolução",
 * que migra para aba própria). Página de DECISÃO: menos flood, mais sinal.
 * Seção autossuficiente (só o prop `refreshKey`, que o pai incrementa após
 * cada coleta arquivar versão nova — recarrega sem remontar a aba). No mount
 * (e a cada refreshKey) lê `troopsHistory.list()` — versões COMPACTAS mais
 * recente primeiro — e consome o motor puro '@shared/member-audit' para
 * produzir: comparador A→B com sinais de auditoria, ficha por membro e
 * evolução agregada da tribo. Remoção de versão é idempotente no main.
 */

const NUMBER_FMT = new Intl.NumberFormat('pt-BR');

const SOURCE_LABEL: Record<TroopsHistoryVersion['source'], string> = {
  summary: 'Resumo',
  'per-member': 'Por membro',
};

/** Ordem fixa de prioridade dos sinais (massivo primeiro — é o que decide OP). */
const KIND_ORDER: AuditSignalKind[] = ['massive-recruit', 'sharp-decline', 'joined', 'left', 'inactive'];

const SIGNAL_ICON: Record<AuditSignalKind, LucideIcon> = {
  'massive-recruit': AlertTriangle,
  'sharp-decline': TrendingDown,
  joined: UserPlus,
  left: UserMinus,
  inactive: Hourglass,
};

const SIGNAL_PILL: Record<AuditSignalKind, string> = {
  'massive-recruit': 'pill--error',
  'sharp-decline': 'pill--warn',
  joined: 'pill--ok',
  left: 'pill--info',
  inactive: 'pill--muted',
};

const SITUATION_LABEL: Record<PlayerTimelinePoint['situation'], string> = {
  presente: 'Presente',
  entrou: 'Entrou',
  saiu: 'Saiu',
  ausente: 'Ausente',
};

/** Tooltip do grupo de alertas: expõe os limiares exatos em vez de escondê-los. */
const SIGNALS_TOOLTIP =
  `Limiares do período: recrutamento massivo com Δoff ≥ +${NUMBER_FMT.format(DEFAULT_MIN_OFF_POP_GROWTH)}` +
  ` ou +${NUMBER_FMT.format(DEFAULT_MIN_VILLAGE_GROWTH)} aldeias (possível preparação de OP);` +
  ` queda acentuada com perda de ${NUMBER_FMT.format(DEFAULT_SHARP_DECLINE_OFF_POP)} de pop ofensiva` +
  ` ou ${NUMBER_FMT.format(DEFAULT_SHARP_DECLINE_VILLAGES)} aldeias;` +
  ` inativo = mudança dentro da tolerância (|Δoff| e |Δdef| ≤ ${NUMBER_FMT.format(DEFAULT_INACTIVE_ABS_OFF_POP)} e aldeias sem variação).`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Falha de comunicação com o processo principal.';
}

/** Data legível e à prova de ISO malformado (nunca "Invalid Date" na tela). */
function formatQuando(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('pt-BR');
}

/** Data curta dd/MM HH:mm — resumo do cabeçalho e ficha do membro. */
function formatCurto(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Rótulo do seletor: data da coleta + origem (ex.: "26/08/2026 21:34 · Por membro"). */
function versionLabel(version: TroopsHistoryVersion): string {
  return `${formatQuando(version.collectedAt)} · ${SOURCE_LABEL[version.source]}`;
}

/** Delta com sinal explícito: +1.234 / −500 / ±0 (Intl pt-BR nos valores). */
function formatSigned(value: number): string {
  if (value > 0) return `+${NUMBER_FMT.format(value)}`;
  if (value < 0) return `−${NUMBER_FMT.format(Math.abs(value))}`;
  return '±0';
}

/** Cor do delta: verde para crescimento, vermelho para perda, neutro para estável. */
function DeltaValue({ delta }: { delta: number }): JSX.Element {
  if (delta > 0) return <span className="hist-delta hist-delta--up">{formatSigned(delta)}</span>;
  if (delta < 0) return <span className="hist-delta hist-delta--down">{formatSigned(delta)}</span>;
  return <span className="hist-delta hist-delta--flat">{formatSigned(delta)}</span>;
}

/** Célula "A → B (Δ)" das colunas numéricas da auditoria. */
function EvolutionCell({ a, b, delta }: { a: number; b: number; delta: number }): JSX.Element {
  return (
    <span className="audit-transition">
      <span className="tabular">{NUMBER_FMT.format(a)}</span>
      <span className="audit-arrow" aria-hidden="true">→</span>
      <span className="tabular">{NUMBER_FMT.format(b)}</span>
      <DeltaValue delta={delta} />
    </span>
  );
}

/** Célula "valor (Δ)" da ficha do membro; Δ null (1ª coleta) vira travessão. */
function TimelineCell({ value, delta }: { value: number; delta: number | null }): JSX.Element {
  return (
    <span className="audit-transition">
      <span className="tabular">{NUMBER_FMT.format(value)}</span>
      {delta === null ? <span className="muted">—</span> : <DeltaValue delta={delta} />}
    </span>
  );
}

function SituationCell({ situation }: { situation: PlayerTimelinePoint['situation'] }): JSX.Element {
  if (situation === 'ausente') return <span className="muted">—</span>;
  if (situation === 'saiu') return <span className="pill pill--error">{SITUATION_LABEL[situation]}</span>;
  if (situation === 'entrou') return <span className="pill pill--ok">{SITUATION_LABEL[situation]}</span>;
  return <span className="pill">{SITUATION_LABEL[situation]}</span>;
}

/** Até 2 pills de sinal; tipos extras colapsam em "+N". */
function SignalCell({ kinds }: { kinds: AuditSignalKind[] | undefined }): JSX.Element {
  if (kinds === undefined || kinds.length === 0) return <span className="muted">—</span>;
  const shown = kinds.slice(0, 2);
  const extra = kinds.length - shown.length;
  return (
    <span className="audit-signal">
      {shown.map((kind) => (
        <span key={kind} className={`pill ${SIGNAL_PILL[kind]}`}>{AUDIT_SIGNAL_LABEL[kind]}</span>
      ))}
      {extra > 0 && <span className="muted">+{extra}</span>}
    </span>
  );
}

/** Linha "mudou algo" — complemento do filtro "Somente mudanças" (default ON). */
function isChangedRow(row: TroopsDiffRow): boolean {
  return row.isNew || row.offPopDelta !== 0 || row.defPopDelta !== 0 || row.villageCountDelta !== 0;
}

/**
 * Reconciliação da seleção A/B vem do motor (@shared/member-audit
 * reconcileSelection): mantém o que existe, re-aplica defaults para id sumido.
 */

export default function MemberAuditSection({ refreshKey = 0 }: { refreshKey?: number }): JSX.Element {
  const { push } = useToast();

  /** null = carregando; [] com erro = falha no IPC (callout danger, sem crash). */
  const [versions, setVersions] = useState<TroopsHistoryVersion[] | null>(null);
  const [error, setError] = useState('');
  /** Ids das versões do comparador — A (antiga) → B (nova). */
  const [aId, setAId] = useState('');
  const [bId, setBId] = useState('');
  const [query, setQuery] = useState('');
  /** Página de decisão: por padrão esconde quem não mudou nada. */
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [selectedPlayer, setSelectedPlayer] = useState('');
  const [removing, setRemoving] = useState(false);

  // Última seleção em ref: load() reconcilia sem entrar nas deps do efeito
  // (trocar seletor NÃO pode reler o histórico no IPC).
  const aIdRef = useRef(aId);
  const bIdRef = useRef(bId);
  useEffect(() => {
    aIdRef.current = aId;
    bIdRef.current = bId;
  }, [aId, bId]);

  const load = useCallback((isCancelled?: () => boolean): Promise<void> => {
    return window.staffhub.troopsHistory.list().then((list) => {
      // Corrida de refreshKey (mount + bump de auto-coleta): a resposta VELHA
      // não pode sobrescrever a lista nova que já chegou (P3 revisão 2).
      if (isCancelled?.()) return;
      setVersions(list);
      const next = reconcileSelection(list, aIdRef.current, bIdRef.current);
      aIdRef.current = next.aId;
      bIdRef.current = next.bId;
      setAId(next.aId);
      setBId(next.bId);
      // Ficha: jogador selecionado que não existe mais em nenhuma versão
      // (removeu a única que o tinha / rotação do cap) volta ao vazio — sem
      // select fantasma mostrando timeline toda "ausente".
      setSelectedPlayer((current) =>
        current === '' || list.some((version) => version.players.some((player) => player.playerName === current))
          ? current
          : '',
      );
      setError('');
    });
  }, []);

  // Mount + cada bump de refreshKey (pai arquiva versão nova após coleta).
  useEffect(() => {
    let cancelled = false;
    const isCancelled = (): boolean => cancelled;
    load(isCancelled).catch((err: unknown) => {
      if (cancelled) return;
      const message = errorMessage(err);
      setError(message);
      // Falha TRANSIENTE de refresh (auto-coleta bumpou refreshKey, IPC falhou)
      // não apaga o que já estava carregado — só a 1ª carga fica vazia.
      setVersions((current) => current ?? []);
      push('error', message);
    });
    return () => {
      cancelled = true;
    };
  }, [load, refreshKey, push]);

  /** Diff A→B + sinais, recalculados a cada troca de seletor. */
  const analysis = useMemo<{ diff: TroopsDiffRow[]; signals: AuditSignal[] } | null>(() => {
    if (versions === null || versions.length < 2) return null;
    const a = versions.find((version) => version.id === aId);
    const b = versions.find((version) => version.id === bId);
    if (a === undefined || b === undefined || a.id === b.id) return null;
    const diff = diffTroopsVersions(a, b);
    return { diff, signals: auditSignals(diff) };
  }, [versions, aId, bId]);

  /** Sinais agrupados por kind na ordem fixa de prioridade (um card por kind). */
  const signalGroups = useMemo(() => {
    if (analysis === null) return [];
    const byKind = new Map<AuditSignalKind, AuditSignal[]>();
    for (const signal of analysis.signals) {
      const items = byKind.get(signal.kind) ?? [];
      items.push(signal);
      byKind.set(signal.kind, items);
    }
    return KIND_ORDER.flatMap((kind) => {
      const items = byKind.get(kind);
      return items === undefined ? [] : [{ kind, items }];
    });
  }, [analysis]);

  /** Kinds por jogador (dedup, ordem de prioridade) para a coluna "Sinal". */
  const kindsByPlayer = useMemo(() => {
    if (analysis === null) return new Map<string, AuditSignalKind[]>();
    const byPlayer = new Map<string, AuditSignalKind[]>();
    for (const signal of analysis.signals) {
      const kinds = byPlayer.get(signal.playerName) ?? [];
      if (!kinds.includes(signal.kind)) kinds.push(signal.kind);
      byPlayer.set(signal.playerName, kinds);
    }
    for (const [name, kinds] of byPlayer) {
      byPlayer.set(name, [...kinds].sort((k1, k2) => KIND_ORDER.indexOf(k1) - KIND_ORDER.indexOf(k2)));
    }
    return byPlayer;
  }, [analysis]);

  /** Busca (fold: ignora acento/caixa) + "somente mudanças", com contagem de ocultados. */
  const { visibleRows, hiddenCount } = useMemo(() => {
    if (analysis === null) return { visibleRows: [] as TroopsDiffRow[], hiddenCount: 0 };
    const needle = fold(query);
    const matchingSearch =
      needle === '' ? analysis.diff : analysis.diff.filter((row) => fold(row.playerName).includes(needle));
    if (!onlyChanges) return { visibleRows: matchingSearch, hiddenCount: 0 };
    const visible = matchingSearch.filter(isChangedRow);
    return { visibleRows: visible, hiddenCount: matchingSearch.length - visible.length };
  }, [analysis, query, onlyChanges]);

  /** União de nomes de jogadores em TODAS as versões, ordem pt-BR sem caixa. */
  const playerNames = useMemo(() => {
    if (versions === null) return [];
    const names = new Set<string>();
    for (const version of versions) {
      for (const player of version.players) names.add(player.playerName);
    }
    return [...names].sort((n1, n2) => n1.localeCompare(n2, 'pt-BR', { sensitivity: 'base' }));
  }, [versions]);

  const timeline = useMemo(
    () => (versions === null || selectedPlayer === '' ? [] : playerTimeline(versions, selectedPlayer)),
    [versions, selectedPlayer],
  );

  const tribe = useMemo(() => (versions === null ? [] : tribeTimeline(versions)), [versions]);

  async function copyDiffTable(): Promise<void> {
    if (visibleRows.length === 0) {
      push('info', 'Sem resultados para copiar.');
      return;
    }
    try {
      await navigator.clipboard.writeText(formatAuditDiffTsv(visibleRows));
      push('ok', `Tabela de auditoria copiada (${visibleRows.length} linha(s), TSV).`);
    } catch {
      push('error', 'Não foi possível copiar — permissão de área de transferência negada.');
    }
  }

  async function copyTimelineTable(): Promise<void> {
    if (timeline.length === 0) {
      push('info', 'Sem resultados para copiar.');
      return;
    }
    try {
      await navigator.clipboard.writeText(formatPlayerTimelineTsv(timeline));
      push('ok', `Linha do tempo do membro copiada (${timeline.length} linha(s), TSV).`);
    } catch {
      push('error', 'Não foi possível copiar — permissão de área de transferência negada.');
    }
  }

  async function handleRemove(): Promise<void> {
    const b = versions?.find((version) => version.id === bId);
    if (b === undefined || removing) return;
    const confirmed = window.confirm(
      `Remover a versão de ${formatQuando(b.collectedAt)} do histórico? Esta ação não pode ser desfeita.`,
    );
    if (!confirmed) return;
    setRemoving(true);
    try {
      await window.staffhub.troopsHistory.remove(b.id);
      push('ok', 'Versão removida do histórico.');
      await load(); // recarrega e reaplica defaults (id removido não existe mais)
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      push('error', message);
    } finally {
      setRemoving(false);
    }
  }

  const hasVersions = versions !== null && versions.length > 0;
  const oldest = hasVersions ? versions[versions.length - 1] : undefined;
  const newest = hasVersions ? versions[0] : undefined;

  return (
    <section className="audit page-section" aria-labelledby="audit-title">
      {/* ===== Cabeçalho + resumo (N versões · intervalo) — sem listar datas ===== */}
      <div className="audit-head">
        <h2 className="section-title" id="audit-title">Auditoria de Membros</h2>
        {versions !== null && (
          <p className="muted audit-summary">
            {NUMBER_FMT.format(versions.length)} de {NUMBER_FMT.format(MAX_TROOPS_HISTORY)} versões
            {oldest !== undefined && newest !== undefined && (
              <>
                {' · '}
                {formatCurto(oldest.collectedAt)}
                {' → '}
                {formatCurto(newest.collectedAt)}
              </>
            )}
          </p>
        )}
      </div>

      {error !== '' && (
        <div className="callout callout--danger" role="alert">
          <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
          <div className="callout-body">
            <p className="callout-title">Falha ao carregar o histórico</p>
            <p>{error}</p>
          </div>
        </div>
      )}

      {versions === null && error === '' && <p className="muted">Carregando histórico de coletas…</p>}

      {/* Sem erro junto: falha de carga mostra SÓ o danger (não o "arquive
          coletas" — seria contraditório dizendo que nada foi arquivado). */}
      {versions !== null && versions.length < 2 && error === '' && (
        <div className="callout callout--info">
          <Info size={18} className="callout-icon" aria-hidden="true" />
          <div className="callout-body">
            <p className="callout-title">Arquive ao menos duas coletas</p>
            <p>
              Cada "Coletar Informações de Tropas" feita na aba "Análise de Tropas" arquiva
              automaticamente uma versão do histórico. Com duas ou mais versões, esta auditoria mostra
              quem cresceu, quem caiu, quem entrou e quem sumiu entre as coletas.
              {versions.length === 1
                ? ' Atualmente há 1 versão arquivada.'
                : ' Nenhuma versão arquivada ainda.'}
            </p>
          </div>
        </div>
      )}

      {versions !== null && versions.length >= 2 && (
        <>
          {/* ===== Comparador A→B (bloco principal) ===== */}
          <div className="card">
            <div className="card-body col" style={{ gap: 16 }}>
              <div className="audit-compare-head">
                <h3 className="audit-block-title">Comparador</h3>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    void handleRemove();
                  }}
                  disabled={removing || bId === ''}
                  title="Remover a versão selecionada em 'Para (nova)'"
                  aria-label="Remover a versão selecionada em 'Para (nova)'"
                >
                  <Trash2 size={14} aria-hidden="true" /> Remover versão
                </button>
              </div>

              <div className="audit-controls">
                <label className="audit-field">
                  <span className="muted">De (antiga)</span>
                  <select
                    className="select"
                    value={aId}
                    onChange={(event) => setAId(event.target.value)}
                    aria-label="Versão antiga (De) do histórico"
                  >
                    {versions.map((version) => (
                      <option key={version.id} value={version.id} disabled={version.id === bId}>
                        {versionLabel(version)}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="audit-arrow" aria-hidden="true">→</span>
                <label className="audit-field">
                  <span className="muted">Para (nova)</span>
                  <select
                    className="select"
                    value={bId}
                    onChange={(event) => setBId(event.target.value)}
                    aria-label="Versão nova (Para) do histórico"
                  >
                    {versions.map((version) => (
                      <option key={version.id} value={version.id} disabled={version.id === aId}>
                        {versionLabel(version)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="audit-field audit-field--grow">
                  <span className="muted">Filtrar jogador</span>
                  <input
                    className="input"
                    type="search"
                    placeholder="Filtrar jogador (ignora acento/caixa)"
                    aria-label="Filtrar jogador (ignora acento/caixa)"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={onlyChanges}
                    onChange={(event) => setOnlyChanges(event.target.checked)}
                  />
                  Somente mudanças
                </label>
                <button type="button" className="btn" onClick={() => void copyDiffTable()}>
                  <Copy size={14} aria-hidden="true" /> Copiar TSV
                </button>
              </div>

              {analysis === null ? (
                <p className="muted">Selecione duas versões distintas para comparar.</p>
              ) : (
                <>
                  {/* ===== Cards de sinal (um por tipo presente) ===== */}
                  <div>
                    <h3 className="audit-block-title" title={SIGNALS_TOOLTIP}>Sinais de auditoria</h3>
                    {signalGroups.length === 0 ? (
                      <p className="muted">Nenhum sinal de auditoria no período selecionado.</p>
                    ) : (
                      <div className="audit-alerts">
                        {signalGroups.map(({ kind, items }) => {
                          const Icon = SIGNAL_ICON[kind];
                          return (
                            <div key={kind} className="audit-alert-card">
                              <p className="audit-alert-title">
                                <Icon size={14} aria-hidden="true" /> {AUDIT_SIGNAL_LABEL[kind]}
                              </p>
                              <ul className="audit-alert-list">
                                {items.map((signal) => (
                                  <li key={signal.playerName} className="audit-alert-item">
                                    <strong>{signal.playerName}</strong>
                                    <span className={`pill ${SIGNAL_PILL[kind]}`}>
                                      Δoff {formatSigned(signal.offPopDelta)}
                                    </span>
                                    <span className={`pill ${SIGNAL_PILL[kind]}`}>
                                      Δaldeias {formatSigned(signal.villageCountDelta)}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* ===== Tabela de auditoria ===== */}
                  <div className="table-wrap">
                    <table
                      className="table"
                      aria-label="Auditoria de membros entre as versões selecionadas"
                    >
                      <thead>
                        <tr>
                          <th scope="col">Jogador</th>
                          <th scope="col" className="cell-num">Pop Off (A→B Δ)</th>
                          <th scope="col" className="cell-num">Pop Def (A→B Δ)</th>
                          <th scope="col" className="cell-num">Aldeias (A→B Δ)</th>
                          <th scope="col">Sinal</th>
                          <th scope="col">Novo?</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleRows.map((row) => (
                          <tr key={row.playerName} className={row.isNew ? 'audit-row-new' : undefined}>
                            <td className="cell-nowrap">{row.playerName}</td>
                            <td className="cell-num">
                              <EvolutionCell a={row.offPopA} b={row.offPopB} delta={row.offPopDelta} />
                            </td>
                            <td className="cell-num">
                              <EvolutionCell a={row.defPopA} b={row.defPopB} delta={row.defPopDelta} />
                            </td>
                            <td className="cell-num">
                              <EvolutionCell
                                a={row.villageCountA}
                                b={row.villageCountB}
                                delta={row.villageCountDelta}
                              />
                            </td>
                            <td className="cell-nowrap">
                              <SignalCell kinds={kindsByPlayer.get(row.playerName)} />
                            </td>
                            <td className="cell-nowrap">
                              {row.isNew ? <span className="pill pill--ok">Novo</span> : <span className="muted">—</span>}
                            </td>
                          </tr>
                        ))}
                        {visibleRows.length === 0 && (
                          <tr>
                            <td colSpan={6} className="muted">Nenhum jogador corresponde ao filtro.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <p className="muted audit-filters-note">
                    Ordenado por crescimento de pop ofensiva · {NUMBER_FMT.format(visibleRows.length)}{' '}
                    jogador(es)
                    {hiddenCount > 0 && (
                      <>
                        {' · '}
                        {NUMBER_FMT.format(hiddenCount)} ocultado(s) por 'somente mudanças'
                      </>
                    )}
                  </p>
                </>
              )}
            </div>
          </div>

          {/* ===== Ficha do membro ===== */}
          <div className="card">
            <div className="card-body col" style={{ gap: 16 }}>
              <div className="audit-controls">
                <label className="audit-field">
                  <span className="muted">Ficha do membro</span>
                  <select
                    className="select"
                    value={selectedPlayer}
                    onChange={(event) => setSelectedPlayer(event.target.value)}
                    aria-label="Selecionar jogador para a ficha"
                  >
                    <option value="">Selecione…</option>
                    {playerNames.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </label>
                {timeline.length > 0 && (
                  <button type="button" className="btn" onClick={() => void copyTimelineTable()}>
                    <Copy size={14} aria-hidden="true" /> Copiar TSV
                  </button>
                )}
              </div>
              {selectedPlayer === '' ? (
                <p className="muted">Selecione um jogador para ver a linha do tempo.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table" aria-label={`Linha do tempo de ${selectedPlayer}`}>
                    <thead>
                      <tr>
                        <th scope="col">Data</th>
                        <th scope="col">Situação</th>
                        <th scope="col" className="cell-num">Pop Off (Δ)</th>
                        <th scope="col" className="cell-num">Pop Def (Δ)</th>
                        <th scope="col" className="cell-num">Aldeias (Δ)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {timeline.map((point) => (
                        <tr key={point.versionId}>
                          <td className="cell-nowrap">{formatCurto(point.collectedAt)}</td>
                          <td><SituationCell situation={point.situation} /></td>
                          <td className="cell-num">
                            <TimelineCell value={point.offPop} delta={point.offPopDelta} />
                          </td>
                          <td className="cell-num">
                            <TimelineCell value={point.defPop} delta={point.defPopDelta} />
                          </td>
                          <td className="cell-num">
                            <TimelineCell value={point.villageCount} delta={point.villageCountDelta} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* ===== Evolução da tribo (agregado, ASC) ===== */}
          <div className="card">
            <div className="card-body col" style={{ gap: 16 }}>
              <h3 className="audit-block-title">Evolução da tribo</h3>
              <div className="table-wrap">
                <table className="table" aria-label="Evolução da tribo ao longo das coletas">
                  <thead>
                    <tr>
                      <th scope="col">Data</th>
                      <th scope="col" className="cell-num">Jogadores</th>
                      <th scope="col" className="cell-num">Aldeias</th>
                      <th scope="col" className="cell-num">Pop Off (Δ)</th>
                      <th scope="col" className="cell-num">Pop Def (Δ)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tribe.map((point, index) => {
                      const prev = index > 0 ? tribe[index - 1] : undefined;
                      return (
                        <tr key={point.versionId}>
                          <td className="cell-nowrap">{formatQuando(point.collectedAt)}</td>
                          <td className="cell-num tabular">{NUMBER_FMT.format(point.players)}</td>
                          <td className="cell-num tabular">{NUMBER_FMT.format(point.villages)}</td>
                          <td className="cell-num">
                            {prev === undefined ? (
                              <span className="muted">—</span>
                            ) : (
                              <DeltaValue delta={point.offPop - prev.offPop} />
                            )}
                          </td>
                          <td className="cell-num">
                            {prev === undefined ? (
                              <span className="muted">—</span>
                            ) : (
                              <DeltaValue delta={point.defPop - prev.defPop} />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
