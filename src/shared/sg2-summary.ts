// Motor do "Resumo Geral dos Dados em Memória" (SG_2): agrega um TroopSnapshot
// em totais, linha por jogador e linha por aldeia, com filtros combináveis.
// Puro e determinístico — sem fs/rede/DOM; a UI só consome os resultados.

import { continentOf, formatCoord, inAxesRange } from './coords';
import type { TroopSnapshot } from './sg2-engine';
import { classifyVillage, defensivePopulation, offensivePopulation, UNITS } from './units';
import type { UnitCounts, UnitId } from './units';

/** Unidades do resumo na ordem de declaração do catálogo, EXCETO milícia (não conta). */
export const SUMMARY_UNIT_ORDER: readonly UnitId[] = (Object.keys(UNITS) as UnitId[]).filter((id) => id !== 'militia');

export interface SummaryFilters {
  /** Contains case-insensitive em playerName (com trim); vazio/ausente = todos. */
  playerQuery?: string;
  /**
   * Filtro por continente K — só afeta ALDEIA com coordenada real:
   * - fail-closed igual ao filtro de tropas: Ks devem ser inteiros 0–99, senão
   *   erro PT-BR (validado SEMPRE, inclusive em modo resumo);
   * - 'incluir' com lista vazia NÃO passa nenhuma aldeia (nunca "tudo");
   * - em snapshot de resumo (sem coordenadas) é no-op.
   */
  kFilter?: { ks: number[]; mode: 'incluir' | 'excluir' };
  /** Faixa de eixos — só afeta aldeia com coordenada real; no-op em modo resumo. */
  axesRange?: { minX?: number; maxX?: number; minY?: number; maxY?: number };
  /** A aldeia (ou a própria entrada, em resumo) precisa ter >= mínimo em TODAS as unidades pedidas. */
  unitMinimums?: Partial<UnitCounts>;
  /**
   * Classificação por ALDEIA via classifyVillage ('vazias' = classe 'empty').
   * Em modo resumo (sem aldeias) NÃO derruba nada — as entradas por jogador passam.
   */
  classification?: 'todas' | 'ofensivas' | 'defensivas' | 'vazias';
}

export interface SummaryPlayerRow {
  playerId: number;
  playerName: string;
  villageCount: number;
  /** Soma das unidades das aldeias/entradas aceitas do jogador. */
  units: UnitCounts;
  offensiveCount: number;
  defensiveCount: number;
  emptyCount: number;
  offPop: number;
  defPop: number;
}

export interface SummaryVillageRow {
  playerId: number;
  playerName: string;
  /** "x|y" da aldeia (formato da ferramenta). */
  coord: string;
  villageName: string;
  units: UnitCounts;
  klass: 'ofensiva' | 'defensiva' | 'vazia';
  offPop: number;
  defPop: number;
  incomingAttacksCount?: number;
}

export interface Sg2Summary {
  totals: {
    players: number;
    villages: number;
    units: UnitCounts;
    offensive: number;
    defensive: number;
    empty: number;
    offPop: number;
    defPop: number;
    /** População média por ALDEIA com 1 casa decimal (0 quando não há aldeias). */
    avgOffPopPerVillage: number;
    avgDefPopPerVillage: number;
  };
  /** Ordenado por villageCount desc, depois playerName asc (localeCompare pt-BR). */
  byPlayer: SummaryPlayerRow[];
  /** Ordenado por playerName asc (localeCompare pt-BR), depois coord asc (string). */
  byVillage: SummaryVillageRow[];
  /** true quando snapshot.source === 'summary' (entradas sem coordenada real). */
  summaryOnly: boolean;
}

const CLASSIFICATION_LABEL: Record<'offensive' | 'defensive' | 'empty', 'ofensivas' | 'defensivas' | 'vazias'> = {
  offensive: 'ofensivas',
  defensive: 'defensivas',
  empty: 'vazias',
};

const VILLAGE_KLASS: Record<'offensive' | 'defensive' | 'empty', 'ofensiva' | 'defensiva' | 'vazia'> = {
  offensive: 'ofensiva',
  defensive: 'defensiva',
  empty: 'vazia',
};

type UnitMinimum = [UnitId, number];

function meetsMinimums(units: UnitCounts, minimums: readonly UnitMinimum[]): boolean {
  return minimums.every(([unit, minimum]) => (units[unit] ?? 0) >= (minimum ?? 0));
}

function addUnits(target: UnitCounts, units: UnitCounts): void {
  for (const [unit, count] of Object.entries(units)) {
    target[unit as UnitId] = (target[unit as UnitId] ?? 0) + (count ?? 0);
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Agrega o snapshot aplicando os filtros (entrada que falha em QUALQUER filtro
 * fica fora de byPlayer, byVillage e dos totais — sem filtro, tudo passa).
 *
 * Snapshots de resumo (source === 'summary', coords {x:-1,y:-1}): summaryOnly=true,
 * byVillage fica vazia e cada entrada conta só em byPlayer/totais de unidades
 * (villageCount 0, sem classificação). Nesse modo kFilter/axesRange/classification
 * são no-ops — mas os Ks do kFilter ainda são validados (fail-closed).
 */
export function summarizeSnapshot(snapshot: TroopSnapshot, filters?: SummaryFilters): Sg2Summary {
  // Fail-closed primeiro: K inválido é erro de dados, mesmo que o filtro vá ser no-op.
  const kFilter = filters?.kFilter;
  if (kFilter !== undefined) {
    const invalidKs = kFilter.ks.filter((k) => !Number.isInteger(k) || k < 0 || k > 99);
    if (invalidKs.length > 0) {
      throw new Error(`Continente(s) inválido(s) no filtro K (use inteiros de 0 a 99): ${invalidKs.join(', ')}.`);
    }
  }
  const kSet = kFilter !== undefined ? new Set(kFilter.ks) : null;
  const axesRange = filters?.axesRange;
  const playerQuery = filters?.playerQuery?.trim().toLowerCase() ?? '';
  const minimums = Object.entries(filters?.unitMinimums ?? {}) as UnitMinimum[];
  const classification = filters?.classification ?? 'todas';

  const players = new Map<number, SummaryPlayerRow>();
  const byVillage: SummaryVillageRow[] = [];
  const totalsUnits: UnitCounts = {};
  let villageCount = 0;
  let offensive = 0;
  let defensive = 0;
  let empty = 0;
  let offPopTotal = 0;
  let defPopTotal = 0;
  // Média por ALDEIA: só a população de entradas COM coordenada entra (senão
  // snapshot misto com entrada sem coord inflaria a média).
  let villageOffPop = 0;
  let villageDefPop = 0;

  for (const entry of snapshot.entries) {
    if (playerQuery !== '' && !entry.playerName.toLowerCase().includes(playerQuery)) continue;
    const hasCoord = entry.coord.x >= 0 && entry.coord.y >= 0;
    // Filtros de geo só têm efeito onde há coordenada real (resumo = no-op).
    if (hasCoord) {
      if (axesRange !== undefined && !inAxesRange(entry.coord, axesRange)) continue;
      if (kSet !== null && kFilter !== undefined) {
        const k = continentOf(entry.coord);
        // 'incluir' com ks vazio: conjunto vazio não contém nenhum K → nada passa.
        if (kFilter.mode === 'incluir' ? !kSet.has(k) : kSet.has(k)) continue;
      }
    }
    // Mínimos: por aldeia quando há coordenada; sobre a própria entrada no resumo.
    if (minimums.length > 0 && !meetsMinimums(entry.units, minimums)) continue;
    // Classificação só existe por aldeia; em resumo não derruba nada.
    let klass: 'offensive' | 'defensive' | 'empty' | null = null;
    if (hasCoord) {
      klass = classifyVillage(entry.units);
      if (classification !== 'todas' && CLASSIFICATION_LABEL[klass] !== classification) continue;
    }

    const row =
      players.get(entry.playerId) ??
      {
        playerId: entry.playerId,
        playerName: entry.playerName,
        villageCount: 0,
        units: {},
        offensiveCount: 0,
        defensiveCount: 0,
        emptyCount: 0,
        offPop: 0,
        defPop: 0,
      };
    const offPop = offensivePopulation(entry.units);
    const defPop = defensivePopulation(entry.units);
    addUnits(row.units, entry.units);
    addUnits(totalsUnits, entry.units);
    row.offPop += offPop;
    row.defPop += defPop;
    offPopTotal += offPop;
    defPopTotal += defPop;
    if (klass !== null) {
      row.villageCount += 1;
      villageCount += 1;
      villageOffPop += offPop;
      villageDefPop += defPop;
      if (klass === 'offensive') {
        row.offensiveCount += 1;
        offensive += 1;
      } else if (klass === 'defensive') {
        row.defensiveCount += 1;
        defensive += 1;
      } else {
        row.emptyCount += 1;
        empty += 1;
      }
      const village: SummaryVillageRow = {
        playerId: entry.playerId,
        playerName: entry.playerName,
        coord: formatCoord(entry.coord),
        villageName: entry.villageName,
        units: { ...entry.units },
        klass: VILLAGE_KLASS[klass],
        offPop,
        defPop,
        ...(entry.incomingAttacksCount !== undefined ? { incomingAttacksCount: entry.incomingAttacksCount } : {}),
      };
      byVillage.push(village);
    }
    players.set(entry.playerId, row);
  }

  const byPlayer = [...players.values()].sort(
    (a, b) => b.villageCount - a.villageCount || a.playerName.localeCompare(b.playerName, 'pt-BR'),
  );
  const byVillageSorted = [...byVillage].sort(
    (a, b) =>
      a.playerName.localeCompare(b.playerName, 'pt-BR') ||
      (a.coord < b.coord ? -1 : a.coord > b.coord ? 1 : 0),
  );

  return {
    totals: {
      players: byPlayer.length,
      villages: villageCount,
      units: totalsUnits,
      offensive,
      defensive,
      empty,
      offPop: offPopTotal,
      defPop: defPopTotal,
      avgOffPopPerVillage: villageCount > 0 ? round1(villageOffPop / villageCount) : 0,
      avgDefPopPerVillage: villageCount > 0 ? round1(villageDefPop / villageCount) : 0,
    },
    byPlayer,
    byVillage: byVillageSorted,
    summaryOnly: snapshot.source === 'summary',
  };
}

function joinTsv(lines: readonly string[]): string {
  return lines.join('\n');
}

/** TSV por jogador: Jogador, Aldeias, Ofensivas, Defensivas, Vazias, PopOff, PopDef + unidades. Sem BOM. */
export function formatSummaryPlayerTsv(rows: readonly SummaryPlayerRow[], unitOrder: readonly UnitId[] = SUMMARY_UNIT_ORDER): string {
  const header = [
    'Jogador',
    'Aldeias',
    'Ofensivas',
    'Defensivas',
    'Vazias',
    'PopOff',
    'PopDef',
    ...unitOrder.map((unit) => UNITS[unit].name),
  ].join('\t');
  const lines = rows.map((row) =>
    [
      row.playerName,
      row.villageCount,
      row.offensiveCount,
      row.defensiveCount,
      row.emptyCount,
      row.offPop,
      row.defPop,
      ...unitOrder.map((unit) => row.units[unit] ?? 0),
    ].join('\t'),
  );
  return joinTsv([header, ...lines]);
}

/** TSV por aldeia: Jogador, Aldeia, Coordenada, Classe, PopOff, PopDef, Ataques (0 se ausente) + unidades. Sem BOM. */
export function formatSummaryVillageTsv(rows: readonly SummaryVillageRow[], unitOrder: readonly UnitId[] = SUMMARY_UNIT_ORDER): string {
  const header = [
    'Jogador',
    'Aldeia',
    'Coordenada',
    'Classe',
    'PopOff',
    'PopDef',
    'Ataques',
    ...unitOrder.map((unit) => UNITS[unit].name),
  ].join('\t');
  const lines = rows.map((row) =>
    [
      row.playerName,
      row.villageName,
      row.coord,
      row.klass,
      row.offPop,
      row.defPop,
      row.incomingAttacksCount ?? 0,
      ...unitOrder.map((unit) => row.units[unit] ?? 0),
    ].join('\t'),
  );
  return joinTsv([header, ...lines]);
}
