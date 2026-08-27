import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { AlertTriangle, Info, Map as MapIcon, X } from 'lucide-react';
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
 */

const NUMBER_FMT = new Intl.NumberFormat('pt-BR');

/** Limite visual da tabela de evolução (o motor pode devolver ~573 linhas). */
const MAX_DIFF_ROWS = 25;
/** Limite visual da lista de mudanças de dono (a contagem total sempre aparece). */
const MAX_CHANGE_ITEMS = 100;

/**
 * Marcações neutras para o mapa: o canvas aplica 'Marrom' a qualquer allyId sem
 * entrada — aqui só interessam os destaques brancos das mudanças, não diplomacia.
 */
const NEUTRAL_MARKINGS: ReadonlyMap<number, TribeMarking> = new Map();

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

  // Dicionário de tags para o bloco de mudanças de dono — fail-soft: sem ele a
  // lista degrada para "tribo N" (o mapa carrega o dicionário de novo ao abrir).
  useEffect(() => {
    if (bVersion === undefined || bVersion.changesSincePrevious.length === 0 || tribesById !== null) {
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
  }, [bVersion, tribesById]);

  /**
   * Diff A→B, recalculado a cada troca de seletor. `diffWorldVersions` já ordena
   * por |Δ aldeias| DESC (maiores movimentos no topo) — a ordem é preservada
   * como vem do motor, só aplicamos o limite visual de 25 linhas.
   */
  const diff = useMemo<WorldDiffRow[]>(() => {
    if (aVersion === undefined || bVersion === undefined || aVersion.id === bVersion.id) return [];
    return diffWorldVersions(aVersion, bVersion);
  }, [aVersion, bVersion]);

  /** Mudanças de dono da versão B (vs a coleta imediatamente anterior a ela). */
  const changes = bVersion?.changesSincePrevious ?? [];
  /** Destaques do mapa: TODAS as coords mudadas (não só as 100 listadas). */
  const changeHighlights = useMemo<ReadonlySet<string>>(
    () => new Set((bVersion?.changesSincePrevious ?? []).map((change) => change.coord)),
    [bVersion],
  );

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
      push('ok', `Mapa aberto com ${NUMBER_FMT.format(changeHighlights.size)} mudança(s) em destaque.`);
    } catch (err) {
      const message = errorMessage(err);
      setMapError(message);
      push('error', message);
    } finally {
      setMapLoading(false);
    }
  }

  const hasComparison = aVersion !== undefined && bVersion !== undefined && aVersion.id !== bVersion.id;

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
      </div>
      <div className="card-body col" style={{ gap: 16 }}>
        <p className="muted">
          Compara duas versões arquivadas do mundo: quem cresceu ou encolheu em aldeias e
          pontos, e quais aldeias trocaram de dono. Cada versão nasce de um
          "Atualizar dados do mundo" na SG_1.
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

        {versions !== null && versions.length >= 2 && !hasComparison && (
          <p className="muted">Selecione duas versões distintas para comparar.</p>
        )}

        {versions !== null && versions.length >= 2 && hasComparison && (
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

            {/* ===== Mudanças de dono da versão B ===== */}
            <div className="wevol-changes-panel">
              <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <h3 className="wevol-panel-title">Mudanças de dono (versão B)</h3>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn"
                  onClick={() => void toggleMap()}
                  disabled={mapLoading || changes.length === 0}
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
              <p className="muted">
                {changes.length === 0
                  ? 'Nenhuma aldeia trocou de dono entre a versão B e a coleta imediatamente anterior.'
                  : `${NUMBER_FMT.format(changes.length)} aldeia(s) mudaram de dono desde a coleta imediatamente anterior à versão B — no mapa aparecem como destaques brancos.`}
              </p>

              {mapError !== '' && (
                <div className="callout callout--danger" role="alert">
                  <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
                  <div className="callout-body">
                    <p className="callout-title">Falha ao carregar o mapa do mundo</p>
                    <p>{mapError}</p>
                  </div>
                </div>
              )}

              {changes.length > 0 && (
                <ul className="wevol-change-list wevol-changes" role="list">
                  {changes.slice(0, MAX_CHANGE_ITEMS).map((change) => (
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
              {changes.length > MAX_CHANGE_ITEMS && (
                <p className="muted">
                  +{NUMBER_FMT.format(changes.length - MAX_CHANGE_ITEMS)} mudanças não listadas
                </p>
              )}

              {mapVisible && villages !== null && (
                <WorldMapCanvas villages={villages} markings={NEUTRAL_MARKINGS} highlights={changeHighlights} />
              )}
            </div>
          </>
        )}
      </div>
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </section>
  );
}
