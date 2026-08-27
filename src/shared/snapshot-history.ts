// Histórico de tropas: versões COMPACTAS agregadas por jogador.
// Por que agregado: uma tribo de ~55 jogadores tem milhares de aldeias; guardar o
// snapshot completo por versão custaria ~3MB cada (inviável no storage do Electron
// com 20 versões). Agregando por jogador (soma de unidades + offPop/defPop) cada
// versão fica em ~30KB — 100x menor — e ainda suporta diff de crescimento e
// detecção de recrutamento maciço, que é o que a tela de histórico consome.

import type { TroopSnapshot } from './sg2-engine';
import { defensivePopulation, offensivePopulation } from './units';
import type { UnitCounts } from './units';

/** Versão COMPACTA do histórico: agregado por jogador (não por aldeia — 55 jogadores ≈ 30KB vs 3MB). */
export interface TroopsPlayerAggregate {
  playerId: number;
  playerName: string;
  /** Entradas com coordenada real (modo por membro); resumo (coord -1) conta 0. */
  villageCount: number;
  /** Soma das unidades de TODAS as entradas do jogador (inclusive resumo). */
  units: UnitCounts;
  offPop: number;
  defPop: number;
}

/** Uma coleta salva no histórico, já agregada por jogador. */
export interface TroopsHistoryVersion {
  /** Gerado por {@link newVersionId} (timestamp + contador atômico). */
  id: string;
  collectedAt: string;
  source: 'summary' | 'per-member';
  players: TroopsPlayerAggregate[];
}

/** Linha do diff entre duas versões (A = antiga, B = nova). */
export interface TroopsDiffRow {
  playerName: string;
  offPopA: number;
  offPopB: number;
  offPopDelta: number;
  defPopA: number;
  defPopB: number;
  defPopDelta: number;
  villageCountA: number;
  villageCountB: number;
  villageCountDelta: number;
  /** true quando o jogador só existe em B (entrou na coleta). */
  isNew: boolean;
}

/**
 * Agrega um snapshot inteiro por jogador: soma as unidades de todas as entradas,
 * conta como aldeia apenas as entradas com coordenada real (resumo usa coord -1)
 * e calcula offPop/defPop pela mesma régua de '@shared/units' (catapulta e
 * explorador fora do score ofensivo, pesada com peso 4 — herdado do original).
 * Resultado ordenado por offPop DESC, empate por nome pt-BR (determinístico).
 * Fail-closed: snapshot sem entries lança — salvar versão vazia esconderia regresso.
 */
export function aggregateSnapshot(snapshot: TroopSnapshot): TroopsPlayerAggregate[] {
  if (snapshot.entries.length === 0) {
    throw new Error(
      'Snapshot de tropas vazio (nenhuma entry) — não há o que agregar no histórico. Colete as tropas antes de salvar uma versão.',
    );
  }
  const byPlayer = new Map<number, { playerName: string; villageCount: number; units: UnitCounts }>();
  for (const entry of snapshot.entries) {
    const current = byPlayer.get(entry.playerId) ?? { playerName: entry.playerName, villageCount: 0, units: {} };
    if (entry.coord.x >= 0 && entry.coord.y >= 0) current.villageCount += 1;
    for (const [unit, count] of Object.entries(entry.units)) {
      const key = unit as keyof UnitCounts;
      current.units[key] = (current.units[key] ?? 0) + (count ?? 0);
    }
    byPlayer.set(entry.playerId, current);
  }
  const players: TroopsPlayerAggregate[] = [...byPlayer.entries()].map(([playerId, agg]) => ({
    playerId,
    playerName: agg.playerName,
    villageCount: agg.villageCount,
    units: agg.units,
    offPop: offensivePopulation(agg.units),
    defPop: defensivePopulation(agg.units),
  }));
  players.sort((a, b) => b.offPop - a.offPop || a.playerName.localeCompare(b.playerName, 'pt-BR'));
  return players;
}

/**
 * Diff A(antiga) → B(nova): união de jogadores (quem sumiu fica com A e delta
 * negativo; quem entrou fica isNew com A zerado). Ordenado por offPopDelta DESC
 * (crescimento primeiro — o que interessa na vigilância de OP), empate por nome
 * pt-BR. Não muta os inputs; devolve linhas novas.
 */
export function diffTroopsVersions(a: TroopsHistoryVersion, b: TroopsHistoryVersion): TroopsDiffRow[] {
  const byNameA = new Map(a.players.map((player) => [player.playerName, player]));
  const byNameB = new Map(b.players.map((player) => [player.playerName, player]));
  const names = new Set<string>([...byNameA.keys(), ...byNameB.keys()]);
  const rows: TroopsDiffRow[] = [];
  for (const playerName of names) {
    const pa = byNameA.get(playerName);
    const pb = byNameB.get(playerName);
    const offPopA = pa?.offPop ?? 0;
    const offPopB = pb?.offPop ?? 0;
    const defPopA = pa?.defPop ?? 0;
    const defPopB = pb?.defPop ?? 0;
    const villageCountA = pa?.villageCount ?? 0;
    const villageCountB = pb?.villageCount ?? 0;
    rows.push({
      playerName,
      offPopA,
      offPopB,
      offPopDelta: offPopB - offPopA,
      defPopA,
      defPopB,
      defPopDelta: defPopB - defPopA,
      villageCountA,
      villageCountB,
      villageCountDelta: villageCountB - villageCountA,
      isNew: pa === undefined,
    });
  }
  rows.sort((r1, r2) => r2.offPopDelta - r1.offPopDelta || r1.playerName.localeCompare(r2.playerName, 'pt-BR'));
  return rows;
}

/** Limiares padrão de recrutamento maciço (ver {@link detectMassiveRecruitment}). */
export const DEFAULT_MIN_OFF_POP_GROWTH = 20000;
export const DEFAULT_MIN_VILLAGE_GROWTH = 3;

/**
 * Recrutamento maciço (sinal clássico de OP inimiga): jogador cujo crescimento
 * entre versões atinge offPopDelta >= minOffPopGrowth (padrão 20000 — popup de
 * trem de ataque) OU villageCountDelta >= minVillageGrowth (padrão 3 — nobres).
 * Limiar é >= (no limite conta) e preserva a ordem recebida (já ranqueada).
 */
export function detectMassiveRecruitment(
  diff: readonly TroopsDiffRow[],
  opts?: { minOffPopGrowth?: number; minVillageGrowth?: number },
): TroopsDiffRow[] {
  const minOffPopGrowth = opts?.minOffPopGrowth ?? DEFAULT_MIN_OFF_POP_GROWTH;
  const minVillageGrowth = opts?.minVillageGrowth ?? DEFAULT_MIN_VILLAGE_GROWTH;
  return diff.filter((row) => row.offPopDelta >= minOffPopGrowth || row.villageCountDelta >= minVillageGrowth);
}

/** Tamanho máximo do histórico mantido (rotação: as mais antigas caem fora). */
export const MAX_TROOPS_HISTORY = 20;

/**
 * Cap do histórico com rotação: ordena por collectedAt DESC (ISO-8601 compara
 * lexicograficamente) e mantém as N mais recentes, a mais nova no índice 0.
 * Devolve SEMPRE um array novo — o array original não é tocado (versões em si
 * são reaproveitadas por referência, pois são imutáveis na prática).
 */
export function capHistory(versions: readonly TroopsHistoryVersion[]): TroopsHistoryVersion[] {
  return [...versions]
    .sort((v1, v2) => (v1.collectedAt < v2.collectedAt ? 1 : v1.collectedAt > v2.collectedAt ? -1 : 0))
    .slice(0, MAX_TROOPS_HISTORY);
}

// Contador atômico a nível de módulo: dois ids no mesmo milissegundo (rajada de
// saves) ainda divergem; módulo grande o bastante para nunca colidir na prática.
let versionCounter = 0;

/** Id determinístico-único (`th-<timestamp>-<contador>`) para novas versões do histórico. */
export function newVersionId(): string {
  versionCounter = (versionCounter + 1) % 1_000_000_000;
  return `th-${Date.now()}-${versionCounter}`;
}
