// Catálogo fixo de unidades da versão BR (pt-BR). A presença de arqueiros num mundo
// (worldHasArchers) é configuração do mundo, fora do catálogo.

export type UnitId =
  | 'spear'
  | 'sword'
  | 'axe'
  | 'archer'
  | 'spy'
  | 'light'
  | 'marcher'
  | 'heavy'
  | 'ram'
  | 'catapult'
  | 'knight'
  | 'snob'
  | 'militia';

export type UnitRole = 'offensive' | 'defensive' | 'support';

export interface UnitDef {
  id: UnitId;
  /** Nome pt-BR usado pela ferramenta. */
  name: string;
  /** População que a unidade ocupa na aldeia. */
  population: number;
  role: UnitRole;
}

export const UNITS: Record<UnitId, UnitDef> = {
  spear: { id: 'spear', name: 'Lanceiro', population: 1, role: 'defensive' },
  sword: { id: 'sword', name: 'Espadachim', population: 1, role: 'defensive' },
  axe: { id: 'axe', name: 'Bárbaro', population: 1, role: 'offensive' },
  archer: { id: 'archer', name: 'Arqueiro', population: 1, role: 'defensive' },
  spy: { id: 'spy', name: 'Explorador', population: 2, role: 'support' },
  light: { id: 'light', name: 'Cavalaria Leve', population: 4, role: 'offensive' },
  marcher: { id: 'marcher', name: 'Arqueiro a Cavalo', population: 5, role: 'offensive' },
  heavy: { id: 'heavy', name: 'Cavalaria Pesada', population: 6, role: 'defensive' },
  ram: { id: 'ram', name: 'Ariete', population: 5, role: 'offensive' },
  catapult: { id: 'catapult', name: 'Catapulta', population: 8, role: 'offensive' },
  knight: { id: 'knight', name: 'Paladino', population: 10, role: 'offensive' },
  snob: { id: 'snob', name: 'Nobre', population: 100, role: 'offensive' },
  militia: { id: 'militia', name: 'Milícia', population: 0, role: 'defensive' },
};

export type UnitCounts = Partial<Record<UnitId, number>>;

// Decisão de score herdada da ferramenta original: no score ofensivo entram apenas
// axe, light, marcher, ram, snob e knight. Catapulta (apesar de role "offensive")
// e Explorador NÃO contam, igual ao original.
const OFFENSIVE_SCORE_UNITS: readonly UnitId[] = ['axe', 'light', 'marcher', 'ram', 'snob', 'knight'];

export function offensivePopulation(counts: UnitCounts): number {
  let total = 0;
  for (const id of OFFENSIVE_SCORE_UNITS) {
    total += (counts[id] ?? 0) * UNITS[id].population;
  }
  return total;
}

// Peso da Cavalaria Pesada é 4, herdado da ferramenta original (não a população 6
// do jogo); Milícia não conta.
export function defensivePopulation(counts: UnitCounts): number {
  return (
    (counts.spear ?? 0) +
    (counts.sword ?? 0) +
    (counts.archer ?? 0) +
    (counts.heavy ?? 0) * 4
  );
}

export type VillageClass = 'offensive' | 'defensive' | 'empty';

export function classifyVillage(counts: UnitCounts): VillageClass {
  const off = offensivePopulation(counts);
  const def = defensivePopulation(counts);
  if (off === 0 && def === 0) return 'empty';
  // Empate não-zero conta como defensivo (regra determinística adotada).
  return off > def ? 'offensive' : 'defensive';
}