// Motor de verificação de blind (SG_3) — quanto FALTA por aldeia do front para
// atingir as unidades desejadas, com contagem "paradas" ou "paradas + a caminho".
// Puro e testável; tipos de snapshot de defesa em './sg2-engine'.

import type { DefenseSnapshot } from './sg2-engine';
import type { UnitCounts } from './units';
import { bbcodeTable } from './formatters';

export interface BlindCheckInput {
  defense: DefenseSnapshot;
  desiredUnits: Partial<UnitCounts>;
  /** "paradas" = só tropas na aldeia; "paradas-e-transito" soma o que está a caminho. */
  countMode: 'paradas' | 'paradas-e-transito';
  coordsFilter: { x: number; y: number }[];
  /**
   * Blind por nível de aldeia (roadmap 13): o desejado escala com os PONTOS da
   * aldeia — fator = clamp(pontos / pontosReferencia, fatorMin, fatorMax).
   * Aldeia com o dobro dos pontos de referência pede o dobro de blind (até o
   * teto). Ausente = comportamento original (desejado fixo p/ todas).
   */
  levelScaling?: { referencePoints: number; minFactor: number; maxFactor: number };
}

export interface BlindVillageResult {
  playerId: number;
  playerName: string;
  coord: { x: number; y: number };
  villageName: string;
  /** max(0, desejado − disponível) por unidade informada que ainda falta. */
  missing: Partial<UnitCounts>;
}

/** Aldeia entra no resultado se falta QUALQUER unidade (OR, ferramenta original). */
export function checkBlind(input: BlindCheckInput): BlindVillageResult[] {
  const coordSet = new Set(input.coordsFilter.map((c) => `${c.x}|${c.y}`));
  const results: BlindVillageResult[] = [];
  for (const entry of input.defense.entries) {
    if (coordSet.size > 0 && !coordSet.has(`${entry.coord.x}|${entry.coord.y}`)) continue;
    // Escala por nível (pontos) quando configurado — senão fator 1 (original).
    const scaling = input.levelScaling;
    const factor =
      scaling !== undefined && scaling.referencePoints > 0
        ? Math.min(scaling.maxFactor, Math.max(scaling.minFactor, entry.points / scaling.referencePoints))
        : 1;
    const missing: Partial<UnitCounts> = {};
    let lacksAny = false;
    for (const [unit, desired] of Object.entries(input.desiredUnits)) {
      const available =
        (entry.unitsInVillage[unit as keyof UnitCounts] ?? 0) +
        (input.countMode === 'paradas-e-transito' ? (entry.unitsInTransit[unit as keyof UnitCounts] ?? 0) : 0);
      const lack = Math.max(0, Math.ceil((desired ?? 0) * factor) - available);
      if (lack > 0) {
        missing[unit as keyof UnitCounts] = lack;
        lacksAny = true;
      }
    }
    if (!lacksAny) continue;
    results.push({
      playerId: entry.playerId,
      playerName: entry.playerName,
      coord: entry.coord,
      villageName: entry.name,
      missing,
    });
  }
  results.sort((a, b) => a.playerName.localeCompare(b.playerName, 'pt-BR') || `${a.coord.x}|${a.coord.y}`.localeCompare(`${b.coord.x}|${b.coord.y}`));
  return results;
}

const UNIT_LABELS: Record<string, string> = {
  spear: 'Lanceiros',
  sword: 'Espadachins',
  archer: 'Arqueiros',
  heavy: 'Cav. Pesada',
};

/** Tabela BBCode pronta para o tópico de blindagem (Pedido | Aldeia | Falta). */
export function blindBbcodeTable(results: BlindVillageResult[]): string {
  const rows = results.map((result, index) => [
    String(index + 1),
    `${result.villageName} (${result.coord.x}|${result.coord.y})`,
    Object.entries(result.missing)
      .map(([unit, amount]) => `${UNIT_LABELS[unit] ?? unit} ${amount?.toLocaleString('pt-BR')}`)
      .join(', '),
  ]);
  return bbcodeTable(['Pedido', 'Aldeia', 'Falta'], rows);
}
