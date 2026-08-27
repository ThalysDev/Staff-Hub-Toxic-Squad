import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Copy,
  FilterX,
  Ghost,
  Layers,
  Shield,
  Swords,
  TrendingUp,
  Users,
} from 'lucide-react';
import type { TroopSnapshot } from '@shared/sg2-engine';
import {
  SUMMARY_UNIT_ORDER,
  formatSummaryPlayerTsv,
  formatSummaryVillageTsv,
  summarizeSnapshot,
} from '@shared/sg2-summary';
import type {
  Sg2Summary,
  SummaryFilters,
  SummaryPlayerRow,
  SummaryVillageRow,
} from '@shared/sg2-summary';
import { UNITS, type UnitCounts, type UnitId } from '@shared/units';
import { TW_UNIT_ICONS } from '../../assets';
import { useToast } from '../../hooks/useToast';
import ToastViewport from '../../components/Toast';

/**
 * SG_2 — "Resumo Geral" dos dados de tropas em memória.
 * Renderizado ABAIXO do painel "Dados em Memória": filtros vivos (sem botão
 * aplicar) sobre o snapshot, cards de estatística e duas visões ordenáveis
 * (por jogador com totais / por aldeia com paginação), com cópia em TSV.
 * Todo o cálculo vem do motor puro '@shared/sg2-summary'.
 */

const NUMBER_FMT = new Intl.NumberFormat('pt-BR');
const DECIMAL_FMT = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Aldeias por página na aba "Por aldeia". */
const VILLAGE_PAGE_SIZE = 50;

type ClassificationFilter = 'todas' | 'ofensivas' | 'defensivas' | 'vazias';
type SortDir = 'asc' | 'desc';
type SortState = { key: string; dir: SortDir };
type Tab = 'players' | 'villages';

/** { summary, error } mutualmente exclusivos — erro de filtro não derruba a página. */
type SummaryState = { summary: Sg2Summary | null; error: string | null };

function unitName(id: UnitId): string {
  return UNITS[id]?.name ?? id;
}

/** Ks 0-99 de um texto ("55 77" → [55, 77]); vazio = sem filtro. */
function parseKs(text: string): number[] {
  return [...new Set((text.match(/\d{1,2}/g) ?? []).map(Number).filter((k) => k >= 0 && k <= 99))];
}

/** Valor de eixo (0..999); vazio/inválido = sem filtro no eixo. */
function parseAxisValue(text: string): number | null {
  const value = Number(text);
  if (text.trim() === '' || !Number.isInteger(value) || value < 0 || value > 999) return null;
  return value;
}

/** Mínimo por unidade: inteiro >= 1; vazio/0/inválido = sem mínimo. */
function parseUnitMinimum(text: string): number | null {
  const value = Number(text);
  if (text.trim() === '' || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function emptyUnitInputs(): Record<UnitId, string> {
  return Object.fromEntries(SUMMARY_UNIT_ORDER.map((id) => [id, ''])) as Record<UnitId, string>;
}

/** Chave numérica de ordenação da coord ("123|456" → 123*1000+456); sem coord vai para o fim. */
function coordSortValue(coord: string): number {
  const match = /^(\d{1,3})\|(\d{1,3})$/.exec(coord);
  if (match === null) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]) * 1000 + Number(match[2]);
}

function compareValues(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'pt-BR');
}

function playerSortValue(row: SummaryPlayerRow, key: string): number | string {
  switch (key) {
    case 'playerName': return row.playerName;
    case 'villageCount': return row.villageCount;
    case 'offensiveCount': return row.offensiveCount;
    case 'defensiveCount': return row.defensiveCount;
    case 'emptyCount': return row.emptyCount;
    case 'offPop': return row.offPop;
    case 'defPop': return row.defPop;
    default:
      if (key.startsWith('unit:')) return row.units[key.slice(5) as UnitId] ?? 0;
      return 0;
  }
}

function villageSortValue(row: SummaryVillageRow, key: string): number | string {
  switch (key) {
    case 'playerName': return row.playerName;
    case 'villageName': return row.villageName;
    case 'coord': return coordSortValue(row.coord);
    case 'klass': return row.klass === 'ofensiva' ? 0 : row.klass === 'defensiva' ? 1 : 2;
    case 'offPop': return row.offPop;
    case 'defPop': return row.defPop;
    case 'incomingAttacksCount': return row.incomingAttacksCount ?? 0;
    default:
      if (key.startsWith('unit:')) return row.units[key.slice(5) as UnitId] ?? 0;
      return 0;
  }
}

interface SortThProps {
  label: string;
  columnKey: string;
  sort: SortState;
  onToggle: (key: string, defaultDir: SortDir) => void;
  numeric?: boolean;
  defaultDir?: SortDir;
  title?: string;
}

/** th ordenável: botão .sg2-sum-sort com ▲/▼ e aria-sort no th. */
function SortTh({ label, columnKey, sort, onToggle, numeric = false, defaultDir, title }: SortThProps): JSX.Element {
  const active = sort.key === columnKey;
  const initialDir: SortDir = defaultDir ?? (numeric ? 'desc' : 'asc');
  return (
    <th
      scope="col"
      className={numeric ? 'cell-num' : undefined}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      title={title}
    >
      <button
        type="button"
        className="sg2-sum-sort"
        aria-label={active
          ? `Ordenar por ${label} (atualmente ${sort.dir === 'asc' ? 'crescente' : 'decrescente'})`
          : `Ordenar por ${label}`}
        onClick={() => onToggle(columnKey, initialDir)}
      >
        <span>{label}</span>
        <span className="sg2-sum-sort-arrow" aria-hidden="true">
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
}

export interface MemorySummarySectionProps {
  snapshot: TroopSnapshot;
  collectedLabel: string;
  sourceLabel: string;
}

export default function MemorySummarySection({ snapshot, collectedLabel, sourceLabel }: MemorySummarySectionProps): JSX.Element {
  const { toasts, push, dismiss } = useToast();

  // ---- Filtros internos (vivos — sem botão aplicar) ----
  const [playerQueryText, setPlayerQueryText] = useState('');
  const [kText, setKText] = useState('');
  const [kMode, setKMode] = useState<'incluir' | 'excluir'>('incluir');
  const [minXText, setMinXText] = useState('');
  const [maxXText, setMaxXText] = useState('');
  const [minYText, setMinYText] = useState('');
  const [maxYText, setMaxYText] = useState('');
  const [classification, setClassification] = useState<ClassificationFilter>('todas');
  const [unitMinInputs, setUnitMinInputs] = useState<Record<UnitId, string>>(emptyUnitInputs);

  // ---- Visão / ordenação / paginação ----
  const [tab, setTab] = useState<Tab>('players');
  const [playerSort, setPlayerSort] = useState<SortState>({ key: 'playerName', dir: 'asc' });
  const [villageSort, setVillageSort] = useState<SortState>({ key: 'offPop', dir: 'desc' });
  const [villagePage, setVillagePage] = useState(1);

  function buildFilters(): SummaryFilters {
    const filters: SummaryFilters = {};
    const query = playerQueryText.trim();
    if (query !== '') filters.playerQuery = query;
    const ks = parseKs(kText);
    if (ks.length > 0) filters.kFilter = { ks, mode: kMode };
    const axes: { minX?: number; maxX?: number; minY?: number; maxY?: number } = {};
    const minX = parseAxisValue(minXText);
    const maxX = parseAxisValue(maxXText);
    const minY = parseAxisValue(minYText);
    const maxY = parseAxisValue(maxYText);
    if (minX !== null) axes.minX = minX;
    if (maxX !== null) axes.maxX = maxX;
    if (minY !== null) axes.minY = minY;
    if (maxY !== null) axes.maxY = maxY;
    if (Object.keys(axes).length > 0) filters.axesRange = axes;
    if (classification !== 'todas') filters.classification = classification;
    const minimums: Partial<UnitCounts> = {};
    for (const id of SUMMARY_UNIT_ORDER) {
      const value = parseUnitMinimum(unitMinInputs[id] ?? '');
      if (value !== null) minimums[id] = value;
    }
    if (Object.keys(minimums).length > 0) filters.unitMinimums = minimums;
    return filters;
  }

  /** Resumo vivo: qualquer digitação recalcula; throw do motor vira erro exibido. */
  const state: SummaryState = useMemo(() => {
    try {
      return { summary: summarizeSnapshot(snapshot, buildFilters()), error: null };
    } catch (error) {
      return {
        summary: null,
        error: error instanceof Error ? error.message : 'Falha ao resumir os dados em memória.',
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- buildFilters lê exatamente estes estados.
  }, [snapshot, playerQueryText, kText, kMode, minXText, maxXText, minYText, maxYText, classification, unitMinInputs]);

  const summary = state.summary;

  const playerRows = useMemo<SummaryPlayerRow[]>(() => {
    const rows = summary?.byPlayer ?? [];
    const dir = playerSort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const primary = compareValues(playerSortValue(a, playerSort.key), playerSortValue(b, playerSort.key));
      if (primary !== 0) return dir * primary;
      return dir * compareValues(a.playerName, b.playerName);
    });
  }, [summary, playerSort]);

  const villageRows = useMemo<SummaryVillageRow[]>(() => {
    const rows = summary?.byVillage ?? [];
    const dir = villageSort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const primary = compareValues(villageSortValue(a, villageSort.key), villageSortValue(b, villageSort.key));
      if (primary !== 0) return dir * primary;
      const tie = compareValues(a.playerName, b.playerName);
      if (tie !== 0) return dir * tie;
      return dir * compareValues(coordSortValue(a.coord), coordSortValue(b.coord));
    });
  }, [summary, villageSort]);

  /** Totais do rodapé "Por jogador" — somados das linhas filtradas exibidas. */
  const playerTotals = useMemo(() => {
    const rows = summary?.byPlayer ?? [];
    const units = Object.fromEntries(
      SUMMARY_UNIT_ORDER.map((id) => [id, rows.reduce((sum, row) => sum + (row.units[id] ?? 0), 0)]),
    ) as UnitCounts;
    return {
      villageCount: rows.reduce((sum, row) => sum + row.villageCount, 0),
      offensiveCount: rows.reduce((sum, row) => sum + row.offensiveCount, 0),
      defensiveCount: rows.reduce((sum, row) => sum + row.defensiveCount, 0),
      emptyCount: rows.reduce((sum, row) => sum + row.emptyCount, 0),
      offPop: rows.reduce((sum, row) => sum + row.offPop, 0),
      defPop: rows.reduce((sum, row) => sum + row.defPop, 0),
      units,
    };
  }, [summary]);

  const pageCount = Math.max(1, Math.ceil(villageRows.length / VILLAGE_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, villagePage), pageCount);
  const pagedVillageRows = villageRows.slice(
    (currentPage - 1) * VILLAGE_PAGE_SIZE,
    currentPage * VILLAGE_PAGE_SIZE,
  );

  // Filtro ou ordenação mudaram → volta para a 1ª página da aba "Por aldeia".
  useEffect(() => {
    setVillagePage(1);
  }, [state, villageSort]);

  function toggleSort(setter: (next: SortState) => void, current: SortState, key: string, defaultDir: SortDir): void {
    if (current.key === key) {
      setter({ key, dir: current.dir === 'asc' ? 'desc' : 'asc' });
    } else {
      setter({ key, dir: defaultDir });
    }
  }

  function clearFilters(): void {
    setPlayerQueryText('');
    setKText('');
    setKMode('incluir');
    setMinXText('');
    setMaxXText('');
    setMinYText('');
    setMaxYText('');
    setClassification('todas');
    setUnitMinInputs(emptyUnitInputs());
  }

  async function copyPlayersTable(): Promise<void> {
    if (playerRows.length === 0) {
      push('info', 'Sem resultados para copiar.');
      return;
    }
    try {
      await navigator.clipboard.writeText(formatSummaryPlayerTsv(playerRows, SUMMARY_UNIT_ORDER));
      push('ok', `Tabela de jogadores copiada (${playerRows.length} linha(s), TSV).`);
    } catch {
      push('error', 'Não foi possível copiar — permissão de área de transferência negada.');
    }
  }

  async function copyVillagesTable(): Promise<void> {
    if (villageRows.length === 0) {
      push('info', 'Sem resultados para copiar.');
      return;
    }
    try {
      // Copia TODAS as aldeias filtradas (não só a página visível).
      await navigator.clipboard.writeText(formatSummaryVillageTsv(villageRows, SUMMARY_UNIT_ORDER));
      push('ok', `Tabela de aldeias copiada (${villageRows.length} aldeia(s), TSV).`);
    } catch {
      push('error', 'Não foi possível copiar — permissão de área de transferência negada.');
    }
  }

  return (
    <section className="sg2-sum page-section" aria-labelledby="sg2-sum-title">
      <h2 className="section-title" id="sg2-sum-title">Resumo Geral</h2>
      <div className="card">
        <div className="card-body">
          <p className="muted">Dados de {collectedLabel} · coleta {sourceLabel}</p>

          {/* ===== Barra de filtros (vivos) ===== */}
          <div className="sg2-sum-filters" role="search" aria-label="Filtros do resumo geral">
            <label className="sg2-sum-label">
              <span>Jogador</span>
              <input
                type="search"
                className="input"
                placeholder="Nick (contém)"
                aria-label="Buscar por jogador"
                value={playerQueryText}
                onChange={(event) => setPlayerQueryText(event.target.value)}
              />
            </label>

            <label className="sg2-sum-label">
              <span>Continentes K</span>
              <input
                className="input"
                placeholder="55 77"
                aria-label="Continentes K"
                value={kText}
                onChange={(event) => setKText(event.target.value)}
              />
              <select
                className="select"
                aria-label="Modo do filtro por continente"
                value={kMode}
                onChange={(event) => setKMode(event.target.value === 'excluir' ? 'excluir' : 'incluir')}
              >
                <option value="incluir">incluir</option>
                <option value="excluir">excluir</option>
              </select>
            </label>

            <div className="sg2-sum-label">
              <span>Eixos X/Y (mín/máx)</span>
              <input type="number" className="input" min={0} max={999} placeholder="min X" aria-label="Eixo X mínimo" value={minXText} onChange={(event) => setMinXText(event.target.value)} />
              <input type="number" className="input" min={0} max={999} placeholder="máx X" aria-label="Eixo X máximo" value={maxXText} onChange={(event) => setMaxXText(event.target.value)} />
              <input type="number" className="input" min={0} max={999} placeholder="min Y" aria-label="Eixo Y mínimo" value={minYText} onChange={(event) => setMinYText(event.target.value)} />
              <input type="number" className="input" min={0} max={999} placeholder="máx Y" aria-label="Eixo Y máximo" value={maxYText} onChange={(event) => setMaxYText(event.target.value)} />
            </div>

            <label className="sg2-sum-label">
              <span>Classificação</span>
              <select
                className="select"
                aria-label="Classificação das aldeias"
                value={classification}
                onChange={(event) => setClassification(event.target.value as ClassificationFilter)}
              >
                <option value="todas">Todas</option>
                <option value="ofensivas">Ofensivas</option>
                <option value="defensivas">Defensivas</option>
                <option value="vazias">Vazias</option>
              </select>
            </label>

            <div className="sg2-sum-label">
              <span>Mínimo por unidade</span>
              {SUMMARY_UNIT_ORDER.map((id) => (
                <label key={id} className="sg2-sum-unit">
                  <img src={TW_UNIT_ICONS[id]} width={16} height={16} alt="" aria-hidden="true" />
                  <span className="sg2-sum-unit-name muted">{unitName(id)}</span>
                  <input
                    type="number"
                    className="input"
                    min={0}
                    placeholder="0"
                    aria-label={`Quantidade mínima de ${unitName(id)}`}
                    value={unitMinInputs[id] ?? ''}
                    onChange={(event) => setUnitMinInputs((current) => ({ ...current, [id]: event.target.value }))}
                  />
                </label>
              ))}
            </div>

            <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
              <FilterX size={14} aria-hidden="true" />
              Limpar filtros
            </button>
          </div>

          {state.error !== null && (
            <div className="callout callout--danger" role="alert">
              <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
              <div className="callout-body">
                <p className="callout-title">Falha no filtro</p>
                <p>{state.error}</p>
              </div>
            </div>
          )}

          {summary !== null && summary.summaryOnly && (
            <div className="callout callout--warn">
              <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
              <div className="callout-body">
                <p className="callout-title">Coleta em modo Resumo</p>
                <p>
                  Esta coleta veio do modo Resumo (1 requisição, por jogador) e não traz as aldeias:
                  os filtros por K e eixos não têm efeito e a aba "Por aldeia" fica vazia. Para o
                  detalhe por aldeia, recolete com "Coletar Informações de Tropas" (por membro).
                </p>
              </div>
            </div>
          )}

          {summary !== null && (
            <div className="sg2-sum-stats">
              <div className="sg2-sum-stat">
                <span className="sg2-sum-stat-label"><Users size={14} aria-hidden="true" /> Jogadores</span>
                <strong className="sg2-sum-stat-value">{NUMBER_FMT.format(summary.totals.players)}</strong>
              </div>
              <div className="sg2-sum-stat">
                <span className="sg2-sum-stat-label"><Layers size={14} aria-hidden="true" /> Aldeias</span>
                <strong className="sg2-sum-stat-value">{NUMBER_FMT.format(summary.totals.villages)}</strong>
              </div>
              <div className="sg2-sum-stat">
                <span className="sg2-sum-stat-label"><Swords size={14} aria-hidden="true" /> Ofensivas</span>
                <strong className="sg2-sum-stat-value">{NUMBER_FMT.format(summary.totals.offensive)}</strong>
              </div>
              <div className="sg2-sum-stat">
                <span className="sg2-sum-stat-label"><Shield size={14} aria-hidden="true" /> Defensivas</span>
                <strong className="sg2-sum-stat-value">{NUMBER_FMT.format(summary.totals.defensive)}</strong>
              </div>
              <div className="sg2-sum-stat">
                <span className="sg2-sum-stat-label"><Ghost size={14} aria-hidden="true" /> Vazias</span>
                <strong className="sg2-sum-stat-value">{NUMBER_FMT.format(summary.totals.empty)}</strong>
              </div>
              <div className="sg2-sum-stat">
                <span className="sg2-sum-stat-label"><Swords size={14} aria-hidden="true" /> Pop. Ofensiva</span>
                <strong className="sg2-sum-stat-value">{NUMBER_FMT.format(summary.totals.offPop)}</strong>
              </div>
              <div className="sg2-sum-stat">
                <span className="sg2-sum-stat-label"><Shield size={14} aria-hidden="true" /> Pop. Defensiva</span>
                <strong className="sg2-sum-stat-value">{NUMBER_FMT.format(summary.totals.defPop)}</strong>
              </div>
              <div className="sg2-sum-stat">
                <span className="sg2-sum-stat-label"><TrendingUp size={14} aria-hidden="true" /> Médias por aldeia</span>
                <span className="sg2-sum-stat-value">
                  {DECIMAL_FMT.format(summary.totals.avgOffPopPerVillage)} <span className="muted">off</span>
                  {' · '}
                  {DECIMAL_FMT.format(summary.totals.avgDefPopPerVillage)} <span className="muted">def</span>
                </span>
              </div>
            </div>
          )}
        </div>

        {summary !== null && (
          <>
            {/* ===== Abas ===== */}
            <div className="sg2-sum-tabs">
              <div role="tablist" aria-label="Visão do resumo geral" className="sg2-sum-tablist">
                <button
                  type="button"
                  id="sg2-sum-tab-players"
                  role="tab"
                  aria-selected={tab === 'players'}
                  aria-controls="sg2-sum-panel"
                  className={tab === 'players' ? 'sg2-sum-tab is-active' : 'sg2-sum-tab'}
                  onClick={() => setTab('players')}
                >
                  Por jogador
                </button>
                <button
                  type="button"
                  id="sg2-sum-tab-villages"
                  role="tab"
                  aria-selected={tab === 'villages'}
                  aria-controls="sg2-sum-panel"
                  className={tab === 'villages' ? 'sg2-sum-tab is-active' : 'sg2-sum-tab'}
                  onClick={() => setTab('villages')}
                >
                  Por aldeia
                </button>
              </div>
              <span className="spacer" />
              {tab === 'players' ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyPlayersTable()} disabled={playerRows.length === 0}>
                  <Copy size={14} aria-hidden="true" />
                  Copiar tabela
                </button>
              ) : (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyVillagesTable()} disabled={villageRows.length === 0}>
                  <Copy size={14} aria-hidden="true" />
                  Copiar tabela
                </button>
              )}
            </div>

            {tab === 'players' ? (
              <div id="sg2-sum-panel" role="tabpanel" aria-labelledby="sg2-sum-tab-players">
                {playerRows.length === 0 ? (
                  <p className="sg2-sum-empty muted">Nenhuma linha corresponde aos filtros.</p>
                ) : (
                  <div className="table-wrap">
                    <table className="table" aria-label="Resumo por jogador">
                      <thead>
                        <tr>
                          <SortTh label="Jogador" columnKey="playerName" sort={playerSort} onToggle={(key, dir) => toggleSort(setPlayerSort, playerSort, key, dir)} />
                          <SortTh label="Aldeias" columnKey="villageCount" numeric sort={playerSort} onToggle={(key, dir) => toggleSort(setPlayerSort, playerSort, key, dir)} />
                          <SortTh label="Ofensivas" columnKey="offensiveCount" numeric sort={playerSort} onToggle={(key, dir) => toggleSort(setPlayerSort, playerSort, key, dir)} />
                          <SortTh label="Defensivas" columnKey="defensiveCount" numeric sort={playerSort} onToggle={(key, dir) => toggleSort(setPlayerSort, playerSort, key, dir)} />
                          <SortTh label="Vazias" columnKey="emptyCount" numeric sort={playerSort} onToggle={(key, dir) => toggleSort(setPlayerSort, playerSort, key, dir)} />
                          <SortTh label="Pop Off" columnKey="offPop" numeric sort={playerSort} onToggle={(key, dir) => toggleSort(setPlayerSort, playerSort, key, dir)} title="População ofensiva" />
                          <SortTh label="Pop Def" columnKey="defPop" numeric sort={playerSort} onToggle={(key, dir) => toggleSort(setPlayerSort, playerSort, key, dir)} title="População defensiva" />
                          {SUMMARY_UNIT_ORDER.map((id) => (
                            <SortTh
                              key={id}
                              label={unitName(id)}
                              columnKey={`unit:${id}`}
                              numeric
                              sort={playerSort}
                              onToggle={(key, dir) => toggleSort(setPlayerSort, playerSort, key, dir)}
                            />
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {playerRows.map((row) => (
                          <tr key={row.playerId}>
                            <td className="cell-nowrap">{row.playerName}</td>
                            <td className="cell-num tabular">{NUMBER_FMT.format(row.villageCount)}</td>
                            <td className="cell-num tabular">{NUMBER_FMT.format(row.offensiveCount)}</td>
                            <td className="cell-num tabular">{NUMBER_FMT.format(row.defensiveCount)}</td>
                            <td className="cell-num tabular">{NUMBER_FMT.format(row.emptyCount)}</td>
                            <td className="cell-num tabular">{NUMBER_FMT.format(row.offPop)}</td>
                            <td className="cell-num tabular">{NUMBER_FMT.format(row.defPop)}</td>
                            {SUMMARY_UNIT_ORDER.map((id) => (
                              <td key={id} className="cell-num tabular">{NUMBER_FMT.format(row.units[id] ?? 0)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <th scope="row">Totais</th>
                          <td className="cell-num tabular">{NUMBER_FMT.format(playerTotals.villageCount)}</td>
                          <td className="cell-num tabular">{NUMBER_FMT.format(playerTotals.offensiveCount)}</td>
                          <td className="cell-num tabular">{NUMBER_FMT.format(playerTotals.defensiveCount)}</td>
                          <td className="cell-num tabular">{NUMBER_FMT.format(playerTotals.emptyCount)}</td>
                          <td className="cell-num tabular">{NUMBER_FMT.format(playerTotals.offPop)}</td>
                          <td className="cell-num tabular">{NUMBER_FMT.format(playerTotals.defPop)}</td>
                          {SUMMARY_UNIT_ORDER.map((id) => (
                            <td key={id} className="cell-num tabular">{NUMBER_FMT.format(playerTotals.units[id] ?? 0)}</td>
                          ))}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            ) : (
              <div id="sg2-sum-panel" role="tabpanel" aria-labelledby="sg2-sum-tab-villages">
                {villageRows.length === 0 ? (
                  <p className="sg2-sum-empty muted">Nenhuma linha corresponde aos filtros.</p>
                ) : (
                  <>
                    <div className="table-wrap">
                      <table className="table" aria-label="Resumo por aldeia">
                        <thead>
                          <tr>
                            <SortTh label="Jogador" columnKey="playerName" sort={villageSort} onToggle={(key, dir) => toggleSort(setVillageSort, villageSort, key, dir)} />
                            <SortTh label="Aldeia" columnKey="villageName" sort={villageSort} onToggle={(key, dir) => toggleSort(setVillageSort, villageSort, key, dir)} />
                            <SortTh label="Coord" columnKey="coord" numeric defaultDir="asc" sort={villageSort} onToggle={(key, dir) => toggleSort(setVillageSort, villageSort, key, dir)} />
                            <SortTh label="Classe" columnKey="klass" numeric defaultDir="asc" sort={villageSort} onToggle={(key, dir) => toggleSort(setVillageSort, villageSort, key, dir)} />
                            <SortTh label="Pop Off" columnKey="offPop" numeric sort={villageSort} onToggle={(key, dir) => toggleSort(setVillageSort, villageSort, key, dir)} title="População ofensiva" />
                            <SortTh label="Pop Def" columnKey="defPop" numeric sort={villageSort} onToggle={(key, dir) => toggleSort(setVillageSort, villageSort, key, dir)} title="População defensiva" />
                            <SortTh label="Ataques" columnKey="incomingAttacksCount" numeric sort={villageSort} onToggle={(key, dir) => toggleSort(setVillageSort, villageSort, key, dir)} title="Ataques recebidos" />
                            {SUMMARY_UNIT_ORDER.map((id) => (
                              <SortTh
                                key={id}
                                label={unitName(id)}
                                columnKey={`unit:${id}`}
                                numeric
                                sort={villageSort}
                                onToggle={(key, dir) => toggleSort(setVillageSort, villageSort, key, dir)}
                              />
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {pagedVillageRows.map((row) => (
                            <tr key={`${row.playerId}-${row.coord}`}>
                              <td className="cell-nowrap">{row.playerName}</td>
                              <td className="cell-nowrap">{row.villageName}</td>
                              <td className="cell-nowrap tabular">{row.coord}</td>
                              <td className="cell-nowrap">
                                {row.klass === 'ofensiva' ? (
                                  'Ofensiva'
                                ) : row.klass === 'defensiva' ? (
                                  'Defensiva'
                                ) : (
                                  <span className="muted">Vazia</span>
                                )}
                              </td>
                              <td className="cell-num tabular">{NUMBER_FMT.format(row.offPop)}</td>
                              <td className="cell-num tabular">{NUMBER_FMT.format(row.defPop)}</td>
                              <td className="cell-num tabular">
                                {row.incomingAttacksCount === undefined ? (
                                  <span className="muted">—</span>
                                ) : (
                                  NUMBER_FMT.format(row.incomingAttacksCount)
                                )}
                              </td>
                              {SUMMARY_UNIT_ORDER.map((id) => (
                                <td key={id} className="cell-num tabular">{NUMBER_FMT.format(row.units[id] ?? 0)}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="sg2-sum-pager">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={currentPage <= 1}
                        onClick={() => setVillagePage(currentPage - 1)}
                      >
                        <ChevronLeft size={14} aria-hidden="true" />
                        Anterior
                      </button>
                      <span className="muted" aria-live="polite">
                        Página {currentPage} de {pageCount} · {NUMBER_FMT.format(villageRows.length)} aldeias
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={currentPage >= pageCount}
                        onClick={() => setVillagePage(currentPage + 1)}
                      >
                        Próxima
                        <ChevronRight size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </section>
  );
}
