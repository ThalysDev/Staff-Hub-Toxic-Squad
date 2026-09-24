// Coleta (v3.6.0) — estado REAL dos níveis e divisão EQUILIBRADA.
//
// Estado: a tela de coleta publica `var village = {…}` com cada nível em
// `options[id]`: `is_locked` (não desbloqueado) e `scavenging_squad`
// (não nulo = em coleta, com `return_time` em segundos). Verificado no BR142
// em 24/09/2026. Antes o módulo procurava `.timer`/`.scavenge-active` no DOM
// — nível bloqueado contava como livre e o jogo recusava o envio.
//
// Equilibrada: divide as tropas entre TODOS os níveis livres para voltarem
// juntos. A duração cresce com capacidade × fator de saque do nível, então
// durações iguais pedem capacidade ∝ 1/fator (nível 1: 0,10 → peso 10;
// 2: 0,25 → 4; 3: 0,50 → 2; 4: 0,75 → 1,33). Puro/testável.

import type { UnitType } from '../../../ext/modules/shared/module-types';

export interface ScavengeLevel {
  id: number;
  locked: boolean;
  /** Em coleta: volta em (epoch, s). */
  returnUnix: number | null;
}

/** Níveis da tela de coleta (null = objeto `village` ilegível). */
export function readScavengeLevels(scriptsText: string): ScavengeLevel[] | null {
  const m = /var village\s*=\s*(\{[\s\S]*?\});\s*\n/.exec(scriptsText);
  if (m === null || m[1] === undefined) return null;
  let village: { options?: Record<string, { is_locked?: boolean; scavenging_squad?: { return_time?: number } | null }> };
  try {
    village = JSON.parse(m[1]) as typeof village;
  } catch {
    return null;
  }
  if (village.options === undefined) return null;
  return Object.entries(village.options)
    .map(([id, o]) => ({
      id: Number(id),
      locked: o.is_locked === true,
      returnUnix: o.scavenging_squad !== null && o.scavenging_squad !== undefined && typeof o.scavenging_squad.return_time === 'number' ? o.scavenging_squad.return_time : null,
    }))
    .filter((l) => Number.isInteger(l.id) && l.id >= 1)
    .sort((a, b) => a.id - b.id);
}

/** Tropas que a coleta aceita (as que carregam recursos). */
export const SCAVENGE_UNITS: readonly UnitType[] = ['spear', 'sword', 'axe', 'archer', 'light', 'marcher', 'heavy', 'knight'];

/** Fator de saque padrão por nível (o jogo publica o real; este é a reserva). */
export const DEFAULT_LOOT_FACTOR: Record<number, number> = { 1: 0.1, 2: 0.25, 3: 0.5, 4: 0.75 };

export interface SplitSquad {
  levelId: number;
  units: Partial<Record<UnitType, number>>;
}

/**
 * Divide as tropas entre os níveis livres para voltarem juntos (peso 1/fator).
 * Nível que ficaria abaixo do mínimo sai e o restante é redividido. Tropas
 * que não carregam (explorador, aríete…) ficam de fora.
 */
export function splitEquilibrada(
  available: Partial<Record<UnitType, number>>,
  freeLevelIds: readonly number[],
  lootFactor: (levelId: number) => number,
  minUnitsPerSquad: number,
): SplitSquad[] {
  let levels = [...freeLevelIds].sort((a, b) => a - b);
  const pool = SCAVENGE_UNITS.map((u) => [u, Math.max(0, Math.floor(available[u] ?? 0))] as const).filter(([, n]) => n > 0);
  while (levels.length > 0) {
    const weights = levels.map((id) => 1 / Math.max(0.01, lootFactor(id)));
    const total = weights.reduce((s, w) => s + w, 0);
    const squads: SplitSquad[] = levels.map((levelId) => ({ levelId, units: {} }));
    for (const [unit, n] of pool) {
      let restante = n;
      levels.forEach((_, i) => {
        const parte = Math.floor((n * (weights[i] ?? 0)) / total);
        if (parte > 0) {
          (squads[i] as SplitSquad).units[unit] = parte;
          restante -= parte;
        }
      });
      // Sobras do arredondamento vão para o nível de maior peso (o mais curto).
      if (restante > 0 && squads[0] !== undefined) squads[0].units[unit] = (squads[0].units[unit] ?? 0) + restante;
    }
    const size = (s: SplitSquad): number => Object.values(s.units).reduce((a, b) => a + (b ?? 0), 0);
    const pequenos = squads.filter((s) => size(s) < minUnitsPerSquad);
    if (pequenos.length === 0) return squads.filter((s) => size(s) > 0);
    // Tira o nível mais LONGO (menor peso) e tenta de novo.
    levels = levels.slice(0, -1);
  }
  return [];
}
