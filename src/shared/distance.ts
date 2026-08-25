// Distâncias e tempos de deslocamento. TW usa distância euclidiana para tempo de tropa.

import type { Coord } from './coords';

export function fieldsBetween(a: Coord, b: Coord): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.round(Math.sqrt(dx * dx + dy * dy) * 100) / 100;
}

// Fórmula paramétrica: minutesPerField vem da config do mundo; a calibração fina
// será validada contra fixtures reais na fase de capturas.
export function travelHours(fields: number, minutesPerField: number, worldSpeed: number): number {
  return (fields * minutesPerField) / 60 / worldSpeed;
}

export function nearestTravelHours(
  origin: Coord,
  targets: Coord[],
  minutesPerField: number,
  worldSpeed: number
): { target: Coord; hours: number } | null {
  let best: { target: Coord; hours: number } | null = null;
  for (const target of targets) {
    const hours = travelHours(fieldsBetween(origin, target), minutesPerField, worldSpeed);
    // Empate: a primeira ocorrência vence (ordem do array preservada).
    if (best === null || hours < best.hours) {
      best = { target, hours };
    }
  }
  return best;
}