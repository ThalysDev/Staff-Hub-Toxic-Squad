// Conversor da fonte "Disponível na aldeia (agora)" (v0.31) — a análise do
// colega: medir o filtro de tropas pelas unidades FISICAMENTE presentes na
// aldeia neste momento (linha "Na Aldeia" da defesa — inclui apoio recebido
// de terceiros), opcionalmente somando o que está "a caminho". O snapshot de
// defesa (mesma coleta do SG_3, parser já separa as duas sub-linhas) vira um
// TroopSnapshot sintético — e o filterTroops inteiro (mínimos, modalidade,
// escopo por aldeia/jogador com soma, coords/K/eixos, classificação) opera
// nele sem NENHUMA duplicação de lógica.

import type { DefenseSnapshot, TroopEntry, TroopSnapshot } from './sg2-engine';
import type { UnitCounts } from './units';

/** Soma as duas fontes de unidades campo a campo (chaves ausentes = 0). */
function somarUnits(base: UnitCounts, extra: UnitCounts): UnitCounts {
  const soma: UnitCounts = { ...base };
  for (const [unit, count] of Object.entries(extra)) {
    const chave = unit as keyof UnitCounts;
    soma[chave] = (soma[chave] ?? 0) + (count ?? 0);
  }
  return soma;
}

/**
 * Snapshot de tropas sintético a partir da defesa coletada:
 * - `incluirTransito=false` → "Paradas (só Na Aldeia)" (default da análise);
 * - `incluirTransito=true` → "Paradas + a caminho" (soma o apoio chegando).
 * O campo `commandsCount` não existe nessa tela — fica ausente (o filtro não
 * o usa). Identidade/preservação de ordem vêm direto da coleta.
 */
export function defenseToTroopSnapshot(defense: DefenseSnapshot, incluirTransito: boolean): TroopSnapshot {
  const entries: TroopEntry[] = defense.entries.map((village) => ({
    playerId: village.playerId,
    playerName: village.playerName,
    coord: village.coord,
    villageId: village.villageId,
    villageName: village.name,
    units: incluirTransito ? somarUnits(village.unitsInVillage, village.unitsInTransit) : { ...village.unitsInVillage },
  }));
  return {
    kind: 'defense',
    source: 'per-member',
    collectedAt: defense.collectedAt,
    entries,
  };
}
