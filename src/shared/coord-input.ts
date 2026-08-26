// Normalizador de campo de coordenadas colado (texto sujo da área de transferência).
//
// Aceita qualquer mistura de separadores: espaço, tab, ";", "," e quebras de linha
// (\r\n, \n ou \r). Token válido é "x|y" com 1–3 dígitos por eixo. Preserva a
// ordem de primeira aparição, remove duplicatas e CONTA o que foi descartado —
// o caller decide avisar o usuário; nunca descarta em silêncio. Vazio não lança:
// simplesmente reconhece 0 coordenadas.

/** Par "x|y" com até 3 dígitos por eixo (mesmo formato do resto do app). */
const COORD_FORMAT = /^\d{1,3}\|\d{1,3}$/;
/** Separadores aceitos no texto colado. */
const SEPARATORS = /[\t ;,\r\n]+/;

export interface NormalizedCoords {
  /** Coordenadas únicas na ordem de primeira aparição ("x|y"). */
  coords: string[];
  /** Linha única limpa pronta para reuso — igual a coords.join(' '). */
  display: string;
  count: number;
  duplicatesRemoved: number;
  invalidTokens: number;
}

export function normalizeCoordText(raw: string): NormalizedCoords {
  const coords: string[] = [];
  const seen = new Set<string>();
  let duplicatesRemoved = 0;
  let invalidTokens = 0;

  for (const token of raw.split(SEPARATORS)) {
    if (token === '') continue;
    if (!COORD_FORMAT.test(token)) {
      invalidTokens += 1;
      continue;
    }
    if (seen.has(token)) {
      duplicatesRemoved += 1;
      continue;
    }
    seen.add(token);
    coords.push(token);
  }

  return { coords, display: coords.join(' '), count: coords.length, duplicatesRemoved, invalidTokens };
}

/** Rótulo PT-BR do resultado: base + extras só quando houver algo ignorado. */
export function coordCountLabel(n: NormalizedCoords): string {
  const parts: string[] = [n.count === 1 ? '1 coordenada reconhecida' : `${n.count} coordenadas reconhecidas`];
  if (n.duplicatesRemoved > 0) {
    parts.push(n.duplicatesRemoved === 1 ? '· 1 duplicada ignorada' : `· ${n.duplicatesRemoved} duplicadas ignoradas`);
  }
  if (n.invalidTokens > 0) {
    parts.push(n.invalidTokens === 1 ? '· 1 trecho inválido ignorado' : `· ${n.invalidTokens} trechos inválidos ignorados`);
  }
  return parts.join(' ');
}
