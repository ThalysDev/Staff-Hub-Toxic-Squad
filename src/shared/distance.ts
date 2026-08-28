// Distâncias e tempos de deslocamento. TW usa distância euclidiana para tempo de tropa.

import type { Coord } from './coords';

export function fieldsBetween(a: Coord, b: Coord): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.round(Math.sqrt(dx * dx + dy * dy) * 100) / 100;
}
