// Modelo de dados do mundo Tribal Wars e contratos de análise (SG_1).
// Fontes: map dumps oficiais (/map/*.txt) + páginas autenticadas da tribo.

export interface WorldVillage {
  id: number;
  name: string;
  x: number;
  y: number;
  playerId: number; // 0 = bárbaro
  /** Tribo do dono (0 = sem tribo/bárbaro) — enriquecido via player.txt. */
  allyId: number;
  points: number;
  bonus: number;
}

export interface WorldPlayer {
  id: number;
  name: string;
  allyId: number; // 0 = sem tribo
  villages: number;
  points: number;
  rank: number;
}

export interface WorldAlly {
  id: number;
  name: string;
  tag: string;
  members: number;
  villages: number;
  points: number;
  rank: number;
}

export interface WorldDataStatus {
  fetchedAt: string | null;
  villageCount: number;
  playerCount: number;
  allyCount: number;
}

/** Marcação de tribo no mapa mundial (rótulos da ferramenta original). */
export type TribeMarking = 'Marrom' | 'Azul' | 'Azul Ally' | 'Vermelho';

export interface TribeMarkingEntry {
  allyId: number;
  tag: string;
  name: string;
  marking: TribeMarking;
}

/** Relações diplomáticas da tribo do jogador (screen=ally&mode=contracts). */
export interface DiplomacyRelations {
  ownAllyId: number;
  ownTag: string;
  enemies: { allyId: number; tag: string; name: string }[];
  allies: { allyId: number; tag: string; name: string }[];
  naps: { allyId: number; tag: string; name: string }[];
}

/** Entrada da Análise de Aldeias (SG_1) — rótulos originais do formulário. */
export interface Sg1Input {
  /** TAG TRIBO ANALISADA (TAG) */
  ownTag: string;
  /** TAG TRIBOS INIMIGAS (TAG;TAG;TAG) */
  enemyTags: string[];
  /** K DESEJADO (45 46 55) — continentes das aldeias próprias a considerar */
  kDesired: number[];
  /** COORDENADAS INIMIGAS DESCONSIDERADAS (123|456 456|123 ...) */
  enemyCoordsDiscard: { x: number; y: number }[];
  /** K ALDEIAS INIMIGAS DESCONSIDERADAS (45 46 55) */
  kEnemyDiscard: number[];
  /** COORDENADAS INIMIGAS CONSIDERADAS — se informadas, substituem as da(s) tag(s) */
  enemyCoordsConsider: { x: number; y: number }[];
  /** COORDENADAS ALIADAS CONSIDERADAS — acrescentam ao conjunto próprio */
  allyCoordsConsider: { x: number; y: number }[];
}

export interface Sg1BucketResult {
  index: number;
  label: string;
  count: number;
  /** Coordenadas no bucket, no formato "123|456". */
  coords: string[];
}

export interface Sg1Result {
  generatedAt: string;
  ownVillageCount: number;
  enemyVillageCount: number;
  /** minutos por campo do NOBRE no mundo (efetivo, já com speed/unit_speed). */
  nobleMinutesPerField: number;
  buckets: Sg1BucketResult[];
}

/** Metadados de unidade vindos de interface.php?func=get_unit_info. */
export interface UnitInfo {
  speed: number;
  pop: number;
  attack: number;
  defense: number;
  carry: number;
}
