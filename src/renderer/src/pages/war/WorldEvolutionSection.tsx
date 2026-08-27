import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { AlertTriangle, History, Info, Map as MapIcon, Pause, Play, X } from 'lucide-react';
import {
  diffWorldVersions,
  MAX_WORLD_HISTORY,
  type WorldDiffRow,
  type WorldHistoryVersion,
} from '@shared/world-history';
import type { TribeMarking, WorldAlly, WorldVillage } from '@shared/types';
import WorldMapCanvas from '../sg1/WorldMapCanvas';
import ToastViewport from '../../components/Toast';
import { useToast } from '../../hooks/useToast';

/**
 * Sala de Guerra — "Evolução do Mundo" (roadmap 18: diff de dumps).
 * Seção autossuficiente (sem props): no mount lê `worldHistory.list()` — versões
 * agregadas por tribo, mais recente primeiro — e compara duas delas com o motor
 * puro '@shared/world-history'. O arquivamento em si não vive aqui: cada
 * "Atualizar dados do mundo" da SG_1 arquiva uma versão; esta seção apenas
 * consome o histórico acumulado. As mudanças de dono exibidas são as da versão B
 * (persistidas vs a coleta IMEDIATAMENTE anterior a ela), e o botão "Mostrar no
 * mapa" carrega o dump atual (villages+tribes) e pinta as coords no
 * WorldMapCanvas via `highlights`.
 *
 * P2-25 "Linha de Frente animada": o modo linha do tempo troca o diff A/B por um
 * slider cronológico (1 = mais antiga, N = mais recente). No passo K o mapa
 * destaca a UNIÃO CUMULATIVA das changesSincePrevious das versões 1..K (aldeias
 * que trocaram de dono ATÉ aquele momento), enquanto a lista lateral mostra só
 * as mudanças da versão corrente. "Reproduzir" avança o slider sozinho a cada
 * 1,2 s até o fim e para; qualquer pausa/manual/troca de modo limpa o timer.
 */

const NUMBER_FMT = new Intl.NumberFormat('pt-BR');

/** Limite visual da tabela de evolução (o motor pode devolver ~573 linhas). */
const MAX_DIFF_ROWS = 25;
/** Limite visual da lista de mudanças de dono (a contagem total sempre aparece). */
const MAX_CHANGE_ITEMS = 100;
/** Passo da reprodução da linha do tempo: um avanço de slider a cada 1,2 s. */
const TIMELINE_TICK_MS = 1200;

/**
 * Marcações neutras para o mapa: o canvas aplica 'Marrom' a qualquer allyId sem
 * entrada — aqui só interessam os destaques brancos das mudanças, não diplomacia.
 */
const NEUTRAL_MARKINGS: ReadonlyMap<number, TribeMarking> = new Map();

/** Conjunto vazio estável — fallback quando o histórico ainda não carregou. */
const NO_HIGHLIGHTS: ReadonlySet<string> = new Set();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Falha de comunicação com o processo principal.';
}

/** Data legível e à prova de ISO malformado (nunca "Invalid Date" na tela). */
function formatQuando(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('pt-BR');
}

/** Delta com sinal explícito: +1.234 / −500 / ±0 (Intl pt-BR nos valores). */
function formatSigned(value: number): string {
  if (value > 0) return `+${NUMBER_FMT.format(value)}`;
  if (value < 0) return `−${NUMBER_FMT.format(Math.abs(value))}`;
  return '±0';
}

/** Cor do delta: verde para crescimento, vermelho para perda, neutro para estável. */
function DeltaValue({ delta }: { delta: number }): JSX.Element {
  if (delta > 0) return <span className="wevol-delta wevol-delta--up">{formatSigned(delta)}</span>;
  if (delta < 0) return <span className="wevol-delta wevol-delta--down">{formatSigned(delta)}</span>;
  return <span className="wevol-delta wevol-delta--flat">{formatSigned(delta)}</span>;
}

/** Célula "A → B (Δ)" das colunas numéricas da evolução. */
function EvolutionCell({ a, b, delta }: { a: number; b: number; delta: number }): JSX.Element {
  return (
    <span className="wevol-transition">
      <span className="tabular">{NUMBER_FMT.format(a)}</span>
      <span className="wevol-arrow" aria-hidden="true">→</span>
      <span className="tabular">{NUMBER_FMT.format(b)}</span>{' '}
      <DeltaValue delta={delta} />
    </span>
  );
}

/** Tag da tribo pelo allyId; 0 = bárbara; sem dicionário carregado degrada para "tribo N". */
function ownerLabel(allyId: number, tribesById: ReadonlyMap<number, WorldAlly> | null): string {
  if (allyId === 0) return 'bárbara';
  return tribesById?.get(allyId)?.tag ?? `tribo ${allyId}`;
}

export default function WorldEvolutionSection(): JSX.Element {
  const { toasts, push, dismiss } = useToast();

  /** null = carregando; [] com erro = falha no IPC (callout danger, sem crash). */
  const [versions, setVersions] = useState<WorldHistoryVersion[] | null>(null);
  const [error, setError] = useState('');
  /** Ids das versões selecionadas — A (antiga) → B (nova). Vazios até o load. */
  const [aId, setAId] = useState('');
  const [bId, setBId] = useState('');
  /** Dicionário allyId → tribo para traduzir as mudanças de dono em tags. */
  const [tribesById, setTribesById] = useState<Map<number, WorldAlly> | null>(null);
  /** Mapa das mudanças: dump atual + visibilidade (o botão alterna abrir/fechar). */
  const [villages, setVillages] = useState<readonly WorldVillage[] | null>(null);
  const [mapVisible, setMapVisible] = useState(false);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapError, setMapError] = useState('');
  /** Modo "linha do tempo" (P2-25): slider cumulativo no lugar do diff A/B. */
  const [timelineMode, setTimelineMode] = useState(false);
  /** Passo corrente K (1..N) na ordem cronológica — mais antiga → mais recente. */
  const [timelineStep, setTimelineStep] = useState(1);
  /** Reprodução automática do slider (interval com cleanup na pausa/fim/unmount). */
  const [playing, setPlaying] = useState(false);

  // Mount: lista o histórico (mais recente primeiro). Defaults de comparação:
  // A = penúltima (índice 1), B = primeira/mais recente (índice 0).
  useEffect(() => {
    let cancelled = false;
    window.staffhub.worldHistory
      .list()
      .then((list) => {
        if (cancelled) return;
        setVersions(list);
        setBId(list[0]?.id ?? '');
        setAId(list[1]?.id ?? '');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = errorMessage(err);
        setError(message);
        setVersions([]);
        push('error', message);
      });
    return () => {
      cancelled = true;
    };
  }, [push]);

  const aVersion = useMemo(
    () => versions?.find((version) => version.id === aId),
    [versions, aId],
  );
  const bVersion = useMemo(
    () => versions?.find((version) => version.id === bId),
    [versions, bId],
  );

  /**
   * Ordem cronológica (mais antiga primeiro): `worldHistory.list()` devolve o
   * histórico mais recente primeiro; o slider da linha do tempo percorre o eixo
   * do tempo no sentido natural (1 = mais antiga, N = mais recente).
   */
  const chronological = useMemo<readonly WorldHistoryVersion[]>(
    () => (versions === null ? [] : [...versions].reverse()),
    [versions],
  );

  /**
   * Prefixos cumulativos da linha do tempo: `cumulativeByStep[k]` é a UNIÃO das
   * coordenadas das changesSincePrevious das versões cronológicas 1..k+1 — as
   * aldeias que já trocaram de dono ATÉ aquele momento. Cada Set é criado uma
   * única vez por versão do histórico (N ≤ MAX_WORLD_HISTORY = 10), garantindo
   * referência ESTÁVEL por passo: o WorldMapCanvas re-pinta só os destaques,
   * sem realocar o Set a cada tick do slider/reprodução.
   */
  const cumulativeByStep = useMemo<readonly ReadonlySet<string>[]>(() => {
    const prefixes: ReadonlySet<string>[] = [];
    let accumulated: ReadonlySet<string> = new Set();
    for (const version of chronological) {
      const next = new Set(accumulated);
      for (const change of version.changesSincePrevious) next.add(change.coord);
      accumulated = next;
      prefixes.push(accumulated);
    }
    return prefixes;
  }, [chronological]);

  /** Passo K sempre dentro de 1..N (o histórico pode encolher entre renders). */
  const totalSteps = chronological.length;
  const clampedStep = Math.max(1, Math.min(timelineStep, totalSteps));
  /** Versão corrente do slider (passo K na ordem cronológica). */
  const stepVersion = chronological[clampedStep - 1];
  /** Destaques do passo K: união cumulativa das versões 1..K. */
  const timelineHighlights = cumulativeByStep[clampedStep - 1] ?? NO_HIGHLIGHTS;

  // Dicionário de tags para o bloco de mudanças de dono — fail-soft: sem ele a
  // lista degrada para "tribo N" (o mapa carrega o dicionário de novo ao abrir).
  // A "versão em foco" depende do modo: B no diff A/B, passo K na linha do tempo.
  const focusedVersion = timelineMode ? stepVersion : bVersion;
  useEffect(() => {
    if (focusedVersion === undefined || focusedVersion.changesSincePrevious.length === 0 || tribesById !== null) {
      return;
    }
    let cancelled = false;
    window.staffhub.world
      .tribes()
      .then((tribes) => {
        if (cancelled) return;
        setTribesById(new Map(tribes.map((tribe) => [tribe.id, tribe])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [focusedVersion, tribesById]);

  /**
   * Diff A→B, recalculado a cada troca de seletor. `diffWorldVersions` já ordena
   * por |Δ aldeias| DESC (maiores movimentos no topo) — a ordem é preservada
   * como vem do motor, só aplicamos o limite visual de 25 linhas.
   */
  const diff = useMemo<WorldDiffRow[]>(() => {
    if (aVersion === undefined || bVersion === undefined || aVersion.id === bVersion.id) return [];
    return diffWorldVersions(aVersion, bVersion);
  }, [aVersion, bVersion]);

  /** Destaques do mapa no modo diff A/B: TODAS as coords mudadas da versão B. */
  const changeHighlights = useMemo<ReadonlySet<string>>(
    () => new Set(bVersion?.changesSincePrevious.map((change) => change.coord) ?? []),
    [bVersion],
  );

  /**
   * Fonte única da UI conforme o modo: diff A/B usa a versão B; linha do tempo
   * usa o passo K (lista = só a versão corrente; mapa = união cumulativa 1..K).
   */
  const activeChanges = focusedVersion?.changesSincePrevious ?? [];
  const activeHighlights = timelineMode ? timelineHighlights : changeHighlights;

  // Reprodução (P2-25): avança o slider a cada 1,2 s até o fim. O cleanup limpa
  // o interval na pausa manual, na troca de modo e no unmount — nenhum timer órfão.
  useEffect(() => {
    if (!playing || totalSteps === 0) return;
    const timer = window.setInterval(() => {
      setTimelineStep((step) => Math.min(step + 1, totalSteps));
    }, TIMELINE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [playing, totalSteps]);

  // Chegada ao último passo encerra a reprodução (o efeito acima limpa o timer).
  useEffect(() => {
    if (playing && timelineStep >= totalSteps) setPlaying(false);
  }, [playing, timelineStep, totalSteps]);

  /** Troca A mantendo B estritamente mais nova (lista vem mais recente primeiro). */
  function selectA(id: string): void {
    setAId(id);
    if (versions === null) return;
    const idxA = versions.findIndex((version) => version.id === id);
    const idxB = versions.findIndex((version) => version.id === bId);
    if (idxA >= 0 && idxB >= idxA) {
      const newer = versions[idxA - 1];
      if (newer !== undefined) setBId(newer.id);
    }
  }

  /** Troca B mantendo A estritamente mais antiga (lista vem mais recente primeiro). */
  function selectB(id: string): void {
    setBId(id);
    if (versions === null) return;
    const idxB = versions.findIndex((version) => version.id === id);
    const idxA = versions.findIndex((version) => version.id === aId);
    if (idxB >= 0 && idxA <= idxB) {
      const older = versions[idxB + 1];
      if (older !== undefined) setAId(older.id);
    }
  }

  /** Alterna diff A/B ↔ linha do tempo; pausa a reprodução e entra na versão mais recente. */
  function toggleTimelineMode(): void {
    setPlaying(false);
    if (!timelineMode) setTimelineStep(Math.max(1, totalSteps));
    setTimelineMode(!timelineMode);
  }

  /** ▶/⏸ da linha do tempo: ▶ no último passo reinicia do 1; ⏸ limpa o timer via cleanup. */
  function togglePlay(): void {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (timelineStep >= totalSteps) setTimelineStep(1);
    setPlaying(true);
  }

  /** Abre o mapa carregando o dump atual (villages+tribes) na primeira abertura; depois alterna. */
  async function toggleMap(): Promise<void> {
    if (mapVisible) {
      setMapVisible(false);
      return;
    }
    if (villages !== null && tribesById !== null) {
      setMapVisible(true);
      return;
    }
    setMapLoading(true);
    setMapError('');
    try {
      const [loadedVillages, loadedTribes] = await Promise.all([
        window.staffhub.world.villages(),
        window.staffhub.world.tribes(),
      ]);
      setVillages(loadedVillages);
      setTribesById(new Map(loadedTribes.map((tribe) => [tribe.id, tribe])));
      setMapVisible(true);
      push('ok', `Mapa aberto com ${NUMBER_FMT.format(activeHighlights.size)} mudança(s) em destaque.`);
    } catch (err) {
      const message = errorMessage(err);
      setMapError(message);
      push('error', message);
    } finally {
      setMapLoading(false);
    }
  }

  const hasComparison = aVersion !== undefined && bVersion !== undefined && aVersion.id !== bVersion.id;
  /** Modo linha do tempo exige ≥2 versões (mesma régua do diff A/B). */
  const timelineReady = versions !== null && versions.length >= 2;

  /** Data do passo corrente (label visível + aria-valuetext do slider). */
  const sliderDate = stepVersion === undefined ? '—' : formatQuando(stepVersion.collectedAt);
  const sliderValueText =
    stepVersion === undefined
      ? 'Nenhuma versão no histórico'
      : `Versão ${NUMBER_FMT.format(clampedStep)} de ${NUMBER_FMT.format(totalSteps)}, coletada em ${sliderDate}`;

  /** Frase-explicativa do bloco de mudanças — por modo (diff A/B vs linha do tempo). */
  const changesDescription = timelineMode
    ? activeChanges.length === 0
      ? 'Nenhuma aldeia trocou de dono entre esta versão e a coleta imediatamente anterior.'
      : `${NUMBER_FMT.format(activeChanges.length)} aldeia(s) mudaram de dono nesta versão — no mapa, os destaques brancos acumulam as ${NUMBER_FMT.format(activeHighlights.size)} mudança(s) desde a primeira versão.`
    : activeChanges.length === 0
      ? 'Nenhuma aldeia trocou de dono entre a versão B e a coleta imediatamente anterior.'
      : `${NUMBER_FMT.format(activeChanges.length)} aldeia(s) mudaram de dono desde a coleta imediatamente anterior à versão B — no mapa aparecem como destaques brancos.`;

  return (
    <section className="card" aria-labelledby="wevol-title">
      <div className="card-header">
        <h2 className="card-title" id="wevol-title">Evolução do Mundo</h2>
        <span className="spacer" />
        {versions !== null && versions.length > 0 && (
          <span className="pill pill--muted">
            {NUMBER_FMT.format(versions.length)} de {NUMBER_FMT.format(MAX_WORLD_HISTORY)} versões
          </span>
        )}
        {timelineReady && (
          <button
            type="button"
            className="btn btn-sm"
            aria-pressed={timelineMode}
            onClick={toggleTimelineMode}
          >
            <History size={16} aria-hidden="true" />
            Modo linha do tempo
          </button>
        )}
      </div>
      <div className="card-body col" style={{ gap: 16 }}>
        <p className="muted">
          Compara duas versões arquivadas do mundo: quem cresceu ou encolheu em aldeias e
          pontos, e quais aldeias trocaram de dono. Cada versão nasce de um
          "Atualizar dados do mundo" na SG_1 — ou percorra a linha do tempo para ver
          as conquistas se acumulando no mapa.
        </p>

        {error !== '' && (
          <div className="callout callout--danger" role="alert">
            <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
            <div className="callout-body">
              <p className="callout-title">Falha ao carregar o histórico do mundo</p>
              <p>{error}</p>
            </div>
          </div>
        )}

        {versions === null && error === '' && <p className="muted">Carregando histórico do mundo…</p>}

        {versions !== null && versions.length < 2 && (
          <div className="callout callout--info">
            <Info size={18} className="callout-icon" aria-hidden="true" />
            <div className="callout-body">
              <p className="callout-title">Histórico insuficiente para comparar</p>
              <p>
                O histórico nasce a cada 'Atualizar dados do mundo' (SG_1) — duas
                atualizações habilitam a comparação.
                {versions.length === 1 ? ' Atualmente há 1 versão arquivada.' : ' Nenhuma versão arquivada ainda.'}
              </p>
            </div>
          </div>
        )}

        {timelineReady && !timelineMode && !hasComparison && (
          <p className="muted">Selecione duas versões distintas para comparar.</p>
        )}

        {versions !== null && versions.length >= 2 && !timelineMode && hasComparison && (
          <>
            {/* ===== Seletores de versão ===== */}
            <div className="row wevol-selectors" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
              <label className="wevol-selector" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="muted">Versão A (antiga)</span>
                <select
                  className="select"
                  value={aId}
                  onChange={(event) => selectA(event.target.value)}
                  aria-label="Versão A (antiga) do histórico do mundo"
                >
                  {versions.map((version) => (
                    <option key={version.id} value={version.id} disabled={versions.findIndex((v) => v.id === version.id) <= versions.findIndex((v) => v.id === bId)}>
                      {formatQuando(version.collectedAt)}
                    </option>
                  ))}
                </select>
              </label>
              <span className="wevol-arrow" aria-hidden="true">→</span>
              <label className="wevol-selector" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="muted">Versão B (nova)</span>
                <select
                  className="select"
                  value={bId}
                  onChange={(event) => selectB(event.target.value)}
                  aria-label="Versão B (nova) do histórico do mundo"
                >
                  {versions.map((version) => (
                    <option key={version.id} value={version.id} disabled={versions.findIndex((v) => v.id === version.id) >= versions.findIndex((v) => v.id === aId)}>
                      {formatQuando(version.collectedAt)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {/* ===== Tabela de evolução por tribo ===== */}
            <div className="table-wrap">
              <table className="table" aria-label="Evolução das tribos entre as versões selecionadas">
                <thead>
                  <tr>
                    <th scope="col">Tribo</th>
                    <th scope="col" className="cell-num">Aldeias A→B (Δ)</th>
                    <th scope="col" className="cell-num">Pontos A→B (Δ)</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.slice(0, MAX_DIFF_ROWS).map((row) => (
                    <tr key={row.allyId}>
                      <td className="cell-nowrap">{row.tag}</td>
                      <td className="cell-num">
                        <EvolutionCell a={row.villagesA} b={row.villagesB} delta={row.villagesDelta} />
                      </td>
                      <td className="cell-num">
                        <EvolutionCell a={row.pointsA} b={row.pointsB} delta={row.pointsDelta} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                {diff.length > MAX_DIFF_ROWS && (
                  <tfoot>
                    <tr>
                      <td colSpan={3} className="muted wevol-more">
                        +{NUMBER_FMT.format(diff.length - MAX_DIFF_ROWS)} tribos
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <p className="muted">
              Ordenado por movimento de aldeias no período (maior |Δ| primeiro) · tribo só
              em A saiu do cenário, só em B é nova.
            </p>
          </>
        )}

        {/* ===== Modo linha do tempo (P2-25) ===== */}
        {timelineReady && timelineMode && (
          <div className="tline-panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="row tline-header" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <span className="pill pill--muted tline-counter">
                {NUMBER_FMT.format(clampedStep)} de {NUMBER_FMT.format(totalSteps)} versões ·{' '}
                {NUMBER_FMT.format(activeHighlights.size)} aldeias mudaram de dono até aqui
              </span>
              <span className="spacer" />
              <button
                type="button"
                className="btn"
                aria-pressed={playing}
                onClick={togglePlay}
                disabled={totalSteps < 2}
              >
                {playing ? (
                  <>
                    <Pause size={16} aria-hidden="true" /> Pausar
                  </>
                ) : (
                  <>
                    <Play size={16} aria-hidden="true" /> Reproduzir
                  </>
                )}
              </button>
            </div>
            <div className="row tline-slider-row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <span className="muted tline-slider-end">mais antiga</span>
              <input
                type="range"
                className="tline-slider"
                style={{ flex: '1 1 220px' }}
                min={1}
                max={totalSteps}
                step={1}
                value={clampedStep}
                onChange={(event) => {
                  setPlaying(false); // arrastar o slider pausa a reprodução
                  setTimelineStep(Number(event.target.value));
                }}
                aria-label="Versão do histórico na linha do tempo"
                aria-valuetext={sliderValueText}
              />
              <span className="muted tline-slider-end">mais recente</span>
            </div>
            <p className="muted tline-current">
              Versão corrente: <strong>{sliderDate}</strong> — no mapa, os destaques acumulam
              todas as aldeias que trocaram de dono da primeira versão até aqui.
            </p>
          </div>
        )}

        {/* ===== Mudanças de dono da versão em foco (B no diff; passo K na linha do tempo) ===== */}
        {timelineReady && (timelineMode || hasComparison) && (
          <div className="wevol-changes-panel">
            <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <h3 className="wevol-panel-title">
                {timelineMode
                  ? `Mudanças de dono (versão ${NUMBER_FMT.format(clampedStep)} de ${NUMBER_FMT.format(totalSteps)})`
                  : 'Mudanças de dono (versão B)'}
              </h3>
              <span className="spacer" />
              <button
                type="button"
                className="btn"
                onClick={() => void toggleMap()}
                disabled={mapLoading || (!mapVisible && activeHighlights.size === 0)}
              >
                {mapLoading ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" /> Carregando mapa…
                  </>
                ) : mapVisible ? (
                  <>
                    <X size={16} aria-hidden="true" /> Fechar mapa
                  </>
                ) : (
                  <>
                    <MapIcon size={16} aria-hidden="true" /> Mostrar no mapa
                  </>
                )}
              </button>
            </div>
            <p className="muted">{changesDescription}</p>

            {mapError !== '' && (
              <div className="callout callout--danger" role="alert">
                <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
                <div className="callout-body">
                  <p className="callout-title">Falha ao carregar o mapa do mundo</p>
                  <p>{mapError}</p>
                </div>
              </div>
            )}

            {activeChanges.length > 0 && (
              <ul className="wevol-change-list wevol-changes" role="list">
                {activeChanges.slice(0, MAX_CHANGE_ITEMS).map((change) => (
                  <li key={change.coord} className="wevol-change-item" role="listitem">
                    <span className="cell-nowrap wevol-change-coord">{change.coord}</span>
                    <span className="wevol-change-flow">
                      {ownerLabel(change.fromAllyId, tribesById)}
                      <span className="wevol-arrow" aria-hidden="true">→</span>
                      <strong>{ownerLabel(change.toAllyId, tribesById)}</strong>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {activeChanges.length > MAX_CHANGE_ITEMS && (
              <p className="muted">
                +{NUMBER_FMT.format(activeChanges.length - MAX_CHANGE_ITEMS)} mudanças não listadas
              </p>
            )}

            {mapVisible && villages !== null && (
              <WorldMapCanvas villages={villages} markings={NEUTRAL_MARKINGS} highlights={activeHighlights} />
            )}
          </div>
        )}
      </div>
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </section>
  );
}
