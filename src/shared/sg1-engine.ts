// Motor da Análise de Aldeias (SG_1): para CADA aldeia própria, tempo de NOBRE até a
// aldeia inimiga mais próxima, distribuído nos 11 buckets da ferramenta original
// (src/shared/buckets.ts). Rótulos, faixas e formato das listas são herdados.

import { NOBLE_TIME_BUCKETS, bucketFor } from './buckets';
import { continentOf, formatCoord, type Coord } from './coords';
import { fieldsBetween } from './distance';
import type { Sg1BucketResult } from './types';

export interface Sg1EngineParams {
  ownVillages: Coord[];
  enemyVillages: Coord[];
  /** minutos por campo do NOBRE já efetivos (ver effectiveNobleMinutesPerField). */
  nobleMinutesPerField: number;
}

export interface Sg1Filters {
  /** K DESEJADO — continentes das aldeias PRÓPRIAS a considerar (espaço no formulário). */
  kDesiredFilter?: number[];
}

export function computeSg1Buckets(params: Sg1EngineParams, filters?: Sg1Filters): Sg1BucketResult[] {
  if (params.enemyVillages.length === 0) {
    throw new Error('Conjunto inimigo vazio: sem aldeias inimigas não há análise de distância');
  }
  const buckets: Sg1BucketResult[] = NOBLE_TIME_BUCKETS.map((bucket, index) => ({
    index,
    label: bucket.label,
    count: 0,
    coords: [],
  }));
  const kDesired = filters?.kDesiredFilter;
  for (const own of params.ownVillages) {
    if (kDesired !== undefined && !kDesired.includes(continentOf(own))) continue;
    // Distância euclidiana (2 casas) até o inimigo mais próximo; empate: 1º vence.
    let nearestFields: number | null = null;
    for (const enemy of params.enemyVillages) {
      const fields = fieldsBetween(own, enemy);
      if (nearestFields === null || fields < nearestFields) nearestFields = fields;
    }
    const hours = ((nearestFields ?? 0) * params.nobleMinutesPerField) / 60;
    const index = bucketFor(hours);
    if (index < 0) {
      throw new Error(
        `Tempo de nobre inválido para a aldeia ${formatCoord(own)}: ${hours}h ` +
          `(nobleMinutesPerField=${params.nobleMinutesPerField}?) — análise abandonada`
      );
    }
    const bucket = buckets[index]!;
    bucket.count += 1;
    bucket.coords.push(formatCoord(own));
  }
  return buckets;
}

/**
 * Minutos por campo efetivos do NOBRE: speed do nobre no XML (min/campo a speed 1)
 * dividido por (worldSpeed × unitSpeed). Ex.: 31.111… / (1.5 × 0.75) = 27.654… min/campo.
 * A calibração fina será conferida contra tempos reais do jogo na fase SG_4.
 */
export function effectiveNobleMinutesPerField(
  unitInfoSpeed: number,
  worldSpeed: number,
  unitSpeed: number
): number {
  const values = [unitInfoSpeed, worldSpeed, unitSpeed];
  if (values.some((v) => !Number.isFinite(v) || v <= 0)) {
    throw new RangeError(
      `Velocidades inválidas para min/campo efetivo: speed_xml=${unitInfoSpeed}, ` +
        `worldSpeed=${worldSpeed}, unitSpeed=${unitSpeed} (todas devem ser > 0)`
    );
  }
  return unitInfoSpeed / (worldSpeed * unitSpeed);
}

export interface BuildEnemySetOpts {
  /** K ALDEIAS INIMIGAS DESCONSIDERADAS — continentes removidos do conjunto inimigo. */
  kEnemyDiscard?: number[];
  /** COORDENADAS INIMIGAS DESCONSIDERADAS — coords exatas removidas do conjunto inimigo. */
  enemyCoordsDiscard?: Coord[];
  /** COORDENADAS INIMIGAS CONSIDERADAS — se informadas, SUBSTITUEM o conjunto da(s) tag(s). */
  enemyCoordsConsider?: Coord[];
  /** COORDENADAS ALIADAS CONSIDERADAS — acrescentam ao conjunto próprio. */
  allyCoordsConsider?: Coord[];
}

export interface EnemySet {
  own: Coord[];
  enemy: Coord[];
}

function coordKey(c: Coord): string {
  return `${c.x}|${c.y}`;
}

function dedupeCoords(coords: Coord[]): Coord[] {
  const seen = new Set<string>();
  const result: Coord[] = [];
  for (const c of coords) {
    const key = coordKey(c);
    if (seen.has(key)) continue; // sem duplicatas: primeira ocorrência vence
    seen.add(key);
    result.push(c);
  }
  return result;
}

/**
 * Aplica os filtros do formulário SG_1:
 * - enemyCoordsConsider não vazio → substitui o conjunto inimigo (discards NÃO se aplicam
 *   a coords explicitamente consideradas);
 * - kEnemyDiscard/enemyCoordsDiscard removem do conjunto das tags (por continente e por
 *   coordenada exata);
 * - allyCoordsConsider acrescentam ao conjunto próprio.
 */
export function buildEnemySet(
  ownVillages: Coord[],
  enemyTagVillages: Coord[],
  opts: BuildEnemySetOpts = {}
): EnemySet {
  const own = dedupeCoords([...ownVillages, ...(opts.allyCoordsConsider ?? [])]);
  const consider = opts.enemyCoordsConsider;
  let enemy: Coord[];
  if (consider !== undefined && consider.length > 0) {
    enemy = consider;
  } else {
    const discardK = new Set(opts.kEnemyDiscard ?? []);
    const discardCoords = new Set((opts.enemyCoordsDiscard ?? []).map(coordKey));
    enemy = enemyTagVillages.filter((v) => !discardK.has(continentOf(v)) && !discardCoords.has(coordKey(v)));
  }
  return { own, enemy: dedupeCoords(enemy) };
}