// Coordenadas de aldeia do Tribal Wars: pares inteiros 0..999 no formato "x|y".

export interface Coord {
  x: number;
  y: number;
}

export interface AxesRange {
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;
}

const MAX_AXIS = 999;

export function parseCoord(text: string): Coord | null {
  const match = /^\s*(\d{1,3})\s*\|\s*(\d{1,3})\s*$/.exec(text);
  if (match === null) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x > MAX_AXIS || y > MAX_AXIS) return null;
  return { x, y };
}

export function parseCoordList(text: string): Coord[] {
  const result: Coord[] = [];
  const seen = new Set<string>();
  for (const token of text.split(/[\s,;]+/)) {
    const coord = parseCoord(token);
    if (coord === null) continue;
    const key = `${coord.x}|${coord.y}`;
    if (seen.has(key)) continue; // sem duplicatas: primeira ocorrência vence
    seen.add(key);
    result.push(coord);
  }
  return result;
}

export function formatCoord(coord: Coord): string {
  return `${coord.x}|${coord.y}`;
}

export function formatCoordList(coords: Coord[], separator: 'space' | 'newline'): string {
  const sep = separator === 'space' ? ' ' : '\n';
  return coords.map(formatCoord).join(sep);
}

export function continentOf(coord: Coord): number {
  return Math.floor(coord.y / 100) * 10 + Math.floor(coord.x / 100);
}

export function inAxesRange(coord: Coord, range: AxesRange): boolean {
  if (range.minX !== undefined && coord.x < range.minX) return false;
  if (range.maxX !== undefined && coord.x > range.maxX) return false;
  if (range.minY !== undefined && coord.y < range.minY) return false;
  if (range.maxY !== undefined && coord.y > range.maxY) return false;
  return true;
}