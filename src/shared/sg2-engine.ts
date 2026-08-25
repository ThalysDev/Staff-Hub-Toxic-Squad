// Motor de filtro de tropas (SG_2) e tipos de snapshot usados por services e UI.
// Puro e determinístico; classificação ofensiva/defensiva vem de '@shared/units'.

import { classifyVillage } from './units';
import type { UnitCounts } from './units';
import { inAxesRange } from './coords';

export interface TroopEntry {
  playerId: number;
  playerName: string;
  /** {x:-1,y:-1} em snapshots de resumo (por jogador, sem aldeia específica). */
  coord: { x: number; y: number };
  villageId?: number;
  villageName: string;
  units: UnitCounts;
  commandsCount?: number;
  incomingAttacksCount?: number;
}

export interface TroopSnapshot {
  kind: 'troops' | 'defense';
  source: 'summary' | 'per-member';
  collectedAt: string;
  entries: TroopEntry[];
}

export interface DefenseVillageEntry {
  playerId: number;
  playerName: string;
  villageId: number;
  name: string;
  coord: { x: number; y: number };
  points: number;
  unitsInVillage: UnitCounts;
  unitsInTransit: UnitCounts;
}

export interface DefenseSnapshot {
  kind: 'defense';
  collectedAt: string;
  entries: DefenseVillageEntry[];
}

export interface Sg2Filters {
  /** Mínimos por unidade; vazio = classificação geral (ofensivas/defensivas). */
  unitMinimums?: Partial<UnitCounts>;
  mode: 'possuem' | 'nao-possuem';
  scope: 'aldeia' | 'jogador';
  coordsFilter?: { x: number; y: number }[];
  axesRange?: { minX?: number; maxX?: number; minY?: number; maxY?: number };
}

export interface Sg2FilterResult {
  players: {
    playerId: number;
    playerName: string;
    villageCount: number;
    /** "123|456" por aldeia que bateu o filtro. */
    coords: string[];
  }[];
  totalVillages: number;
  classification?: { offensive: number; defensive: number; empty: number };
}

function hasMinimums(entryUnits: UnitCounts, minimums: Partial<UnitCounts>): boolean {
  return Object.entries(minimums).every(([unit, minimum]) => (entryUnits[unit as keyof UnitCounts] ?? 0) >= (minimum ?? 0));
}

function passesEntry(entry: TroopEntry, filters: Sg2Filters): boolean {
  const minimums = filters.unitMinimums ?? {};
  const keys = Object.keys(minimums) as (keyof UnitCounts)[];
  if (keys.length === 0) return true;
  if (filters.mode === 'possuem') return hasMinimums(entry.units, minimums);
  // "não possuem": basta FALHAR em UM dos mínimos (OR semântico da ferramenta original).
  return keys.some((unit) => (entry.units[unit] ?? 0) < (minimums[unit] ?? 0));
}

/**
 * Filtro da tela "Realizar Filtro de Tropas".
 * - escopo 'aldeia': cada aldeia compara os mínimos individualmente;
 * - escopo 'jogador': soma as unidades do jogador antes de comparar (todas as
 *   aldeias dele entram no resultado);
 * - coordsFilter ativo: só entries com coordenada válida na lista (resumo sem
 *   coords é ignorado);
 * - sem mínimos: devolve classificação ofensiva/defensiva de cada aldeia.
 */
export function filterTroops(snapshot: TroopSnapshot, filters: Sg2Filters): Sg2FilterResult {
  const coordsFilter = filters.coordsFilter ?? [];
  const coordSet = new Set(coordsFilter.map((c) => `${c.x}|${c.y}`));
  const minimums = filters.unitMinimums ?? {};
  const hasMinimumFilters = Object.keys(minimums).length > 0;
  // Snapshots de RESUMO (por jogador, sem aldeia) não suportam consultas por
  // aldeia nem classificação — fail-closed com orientação, nunca número errado.
  const isSummary = snapshot.entries.some((entry) => entry.coord.x < 0);
  if (isSummary && (!hasMinimumFilters || filters.scope === 'aldeia' || (coordsFilter.length > 0) || (filters.axesRange !== undefined))) {
    throw new Error(
      'A coleta em modo Resumo (1 requisição) não traz aldeias — use "Coletar Informações de Tropas" (por membro) para filtro/classificação por aldeia. O resumo só suporta filtro simples por jogador.',
    );
  }

  const byPlayer = new Map<number, { playerName: string; coords: string[] }>();
  const addPlayerVillage = (entry: TroopEntry): void => {
    const current = byPlayer.get(entry.playerId) ?? { playerName: entry.playerName, coords: [] };
    if (entry.coord.x >= 0 && entry.coord.y >= 0) current.coords.push(`${entry.coord.x}|${entry.coord.y}`);
    byPlayer.set(entry.playerId, current);
  };

  const classification = { offensive: 0, defensive: 0, empty: 0 };

  /** Filtros de coordenada e eixo são COMBINÁVEIS: a aldeia precisa passar nos dois. */
  const passesGeo = (entry: TroopEntry): boolean => {
    if (entry.coord.x < 0) return true; // resumo: sem geo
    if (coordSet.size > 0 && !coordSet.has(`${entry.coord.x}|${entry.coord.y}`)) return false;
    if (filters.axesRange && !inAxesRange(entry.coord, filters.axesRange)) return false;
    return true;
  };

  if (filters.scope === 'jogador' && hasMinimumFilters) {
    // Soma por jogador primeiro.
    const sums = new Map<number, { playerName: string; units: UnitCounts; entries: TroopEntry[] }>();
    for (const entry of snapshot.entries) {
      if (!passesGeo(entry)) continue;
      const current = sums.get(entry.playerId) ?? { playerName: entry.playerName, units: {}, entries: [] };
      for (const [unit, count] of Object.entries(entry.units)) {
        current.units[unit as keyof UnitCounts] = (current.units[unit as keyof UnitCounts] ?? 0) + (count ?? 0);
      }
      current.entries.push(entry);
      sums.set(entry.playerId, current);
    }
    for (const [playerId, sum] of sums) {
      const synthetic: TroopEntry = { playerId, playerName: sum.playerName, coord: { x: -1, y: -1 }, villageName: '', units: sum.units };
      if (!passesEntry(synthetic, filters)) continue;
      for (const entry of sum.entries) addPlayerVillage(entry);
    }
  } else {
    for (const entry of snapshot.entries) {
      if (!passesGeo(entry)) continue;
      if (!hasMinimumFilters) {
        const label = classifyVillage(entry.units);
        classification[label] += 1;
        continue; // sem filtro de unidades: só classifica
      }
      if (passesEntry(entry, filters)) addPlayerVillage(entry);
    }
  }

  const players = [...byPlayer.entries()].map(([playerId, info]) => ({
    playerId,
    playerName: info.playerName,
    villageCount: info.coords.length,
    coords: info.coords,
  }));
  const totalVillages = players.reduce((sum, player) => sum + player.villageCount, 0);
  const result: Sg2FilterResult = { players, totalVillages };
  if (!hasMinimumFilters) result.classification = classification;
  return result;
}

/** Resumo copiável "nick;qtde;coord coord" (formato da ferramenta original). */
export function playersSummary(result: Sg2FilterResult): string {
  return result.players
    .map((player) => `${player.playerName};${player.villageCount};${player.coords.join(' ')}`)
    .join('\n');
}
