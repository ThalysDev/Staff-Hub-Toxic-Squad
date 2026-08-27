// Parser de relatórios de ESPIIONAGEM do TW BR colados como TEXTO (roadmap P2).
//
// O usuário cola o CORPO do relatório (cabeçalho "Espionagem em ... no dia ...",
// tabela de tropas com nomes e quantidades, muralha) e a ferramenta extrai o
// alvo, as unidades espiadas, a muralha e as populações ofensiva/defensiva do
// alvo pelos pesos herdados de units.ts. Puro e determinístico.
//
// Reconhecimento (flexível de propósito — a entrada é clipboard do usuário):
// - Alvo: coordenada da linha "Espionagem em ..."; sem essa linha (ou sem coord
//   nela), a PRIMEIRA coordenada "x|y" do texto.
// - Tropas: pares "NomeDaUnidade quantidade" em QUALQUER linha, números pt-BR
//   com ponto de milhar ("10.000"). Plural aceito ("Lanceiros"): o casamento é
//   por PREFIXO do nome do catálogo, case/acento-insensível, prefixo mais longo
//   vence ("Arqueiro a Cavalo" à frente de "Arqueiro"). Primeira ocorrência de
//   cada unidade vence. Unidade reconhecida com 0 conta como reconhecida
//   (relatório de aldeia vazia não é erro).
// - Muralha: "Muralha Nível X" ou "Muralha: X" (aceita 0–20); ausente → null.
// - Espionagem não tem "Perdas" do ALVO: linhas com "perdas" (perda do próprio
//   explorador, no relatório do atacante) são ignoradas por completo.
//
// Fail-closed PT-BR: sem coordenada OU sem nenhuma unidade reconhecida → throw
// com mensagem clara, nunca dado errado silencioso.

import { formatCoord, parseCoord } from './coords';
import { UNITS, defensivePopulation, offensivePopulation, type UnitCounts, type UnitId } from './units';

export interface SpyReportData {
  /** Alvo espiado, normalizado "x|y" (ex.: "471|463"). */
  coord: string;
  /** Unidades ESPIADAS no alvo; unidade ausente = 0 (não trazida no relatório). */
  units: UnitCounts;
  /** Nível da muralha do alvo (0–20) ou null quando o relatório não traz. */
  wallLevel: number | null;
  /** População defensiva do alvo (defensivePopulation — pesos da ferramenta). */
  defPop: number;
  /** População ofensiva do alvo (offensivePopulation — pesos da ferramenta). */
  offPop: number;
}

/** População por full ofensivo usada como DEFAULT na sugestão (parâmetro da UI). */
export const DEFAULT_POP_PER_FULL = 20000;

/** Muralha máxima do jogo; valor fora de 0–20 no texto não vira wallLevel. */
const MAX_WALL_LEVEL = 20;

// Bônus de muralha da sugestão de fulls: +10% por nível ACIMA de 10, teto +50%.
// REGRA-DE-POLEGAR configurável da ferramenta — muralha alta encarece a
// limpeza, então a sugestão sobe. NÃO é mecânica oficial do jogo.
const WALL_BONUS_PCT_PER_LEVEL = 10;
const WALL_BONUS_PCT_CAP = 50;
const WALL_BONUS_FROM_LEVEL = 10;

/** minúsculas, sem acentos (NFD), espaços colapsados — para casamento de nomes. */
function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface UnitNameMatcher {
  id: UnitId;
  /** Nome normalizado — define a ordem (mais longo primeiro). */
  name: string;
  /** Casa quando o nome (como prefixo da palavra) encerra o trecho anterior ao número. */
  atEnd: RegExp;
}

/** Catálogo para casamento por prefixo; prefixo MAIS LONGO testado primeiro. */
const UNIT_MATCHERS: UnitNameMatcher[] = Object.values(UNITS)
  .map((def) => {
    const name = normalizeText(def.name);
    return { id: def.id, name, atEnd: new RegExp(`(?:^|\\s)${escapeRegExp(name)}[a-z]*$`) };
  })
  .sort((a, b) => b.name.length - a.name.length);

/** Unidade cujo nome (por prefixo, plural incluído) termina o trecho "before". */
function unitIdBefore(before: string): UnitId | null {
  for (const matcher of UNIT_MATCHERS) {
    if (matcher.atEnd.test(before)) return matcher.id;
  }
  return null;
}

/** Quantidade pt-BR válida: "10.000" (grupos de milhar) ou "500" — senão null. */
function parseTroopCount(raw: string): number | null {
  const cleaned = raw.replace(/\.+$/, ''); // ponto final de frase: "10.000."
  if (!/^\d{1,3}(?:\.\d{3})+$/.test(cleaned) && !/^\d+$/.test(cleaned)) return null;
  return Number(cleaned.replace(/\./g, ''));
}

const NUMBER_TOKEN_RE = /\d[\d.]*/g;

/** Soma os pares "unidade quantidade" de UMA linha normalizada em `units`. */
function scanLineUnits(norm: string, units: UnitCounts): void {
  for (const match of norm.matchAll(NUMBER_TOKEN_RE)) {
    const value = parseTroopCount(match[0]);
    if (value === null) continue;
    // Trecho antes do número, sem pontuação final ("Lanceiro:" → "lanceiro").
    const before = norm.slice(0, match.index ?? 0).replace(/[^a-z]+$/, '');
    if (before === '') continue;
    const id = unitIdBefore(before);
    if (id === null) continue;
    if (units[id] === undefined) units[id] = value; // primeira ocorrência vence
  }
}

/** "Muralha Nível 12" / "Muralha: 12" / "Muralha de nível 12" (em texto normalizado). */
const WALL_RE = /muralha(?:\s+(?:de\s+)?nivel)?\s*:?\s*(\d{1,2})(?!\d)/;

/** Coordenada "x|y" válida, com bornes para não pegar pedaço de número maior. */
const COORD_RE = /(?<!\d)(\d{1,3})\s*\|\s*(\d{1,3})(?!\d)/g;

/** Primeira coordenada válida do texto, normalizada "x|y"; nenhuma → null. */
function firstCoord(text: string): string | null {
  for (const match of text.matchAll(COORD_RE)) {
    const coord = parseCoord(match[0]);
    if (coord !== null) return formatCoord(coord);
  }
  return null;
}

/**
 * Converte o corpo colado de um relatório de espionagem. Fail-closed: lança
 * erro PT-BR claro quando não há coordenada "x|y" no texto OU quando nenhuma
 * unidade do catálogo foi reconhecida.
 */
export function parseSpyReport(text: string): SpyReportData {
  const units: UnitCounts = {};
  let coord: string | null = null;
  let wallLevel: number | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeText(rawLine);
    if (line === '') continue;
    // Linha de perdas (do atacante) não descreve o alvo: ignorada por inteiro.
    if (line.includes('perdas')) continue;

    if (coord === null && line.includes('espionagem em')) {
      coord = firstCoord(line);
    }
    if (wallLevel === null) {
      const wallMatch = WALL_RE.exec(line);
      if (wallMatch !== null) {
        const level = Number(wallMatch[1]);
        if (Number.isInteger(level) && level >= 0 && level <= MAX_WALL_LEVEL) wallLevel = level;
      }
    }
    scanLineUnits(line, units);
  }

  if (coord === null) coord = firstCoord(text);
  if (coord === null) {
    throw new Error(
      'Relatório de espionagem inválido: nenhuma coordenada no formato "x|y" (ex.: 471|463) foi encontrada no texto.',
    );
  }
  if (Object.keys(units).length === 0) {
    throw new Error(
      'Relatório de espionagem inválido: nenhuma unidade foi reconhecida — cole o corpo do relatório com os pares "unidade quantidade" (ex.: "Lanceiro 10.000").',
    );
  }

  return {
    coord,
    units,
    wallLevel,
    defPop: defensivePopulation(units),
    offPop: offensivePopulation(units),
  };
}

export interface FullSuggestion {
  /** Fulls ofensivos sugeridos para limpar o alvo (mínimo 1). */
  fulls: number;
  /** Explicação do cálculo em PT-BR (inclui o aviso de regra-de-polegar). */
  detail: string;
}

/**
 * Sugestão HONESTA de fulls ofensivos para limpar a defesa espiada:
 * base = ceil(defPop / popPerFull) (mínimo 1; popPerFull default 20000 e é
 * parâmetro da UI); muralha adiciona +10% por nível ACIMA de 10, com teto de
 * +50%, aplicado à base e arredondado para cima. REGRA-DE-POLEGAR
 * CONFIGURÁVEL da ferramenta — NÃO é verdade oficial do jogo; serve como
 * ponto de partida para a decisão do comandante, não como garantia.
 */
export function suggestFulls(
  defPop: number,
  wallLevel: number | null,
  popPerFull: number = DEFAULT_POP_PER_FULL,
): FullSuggestion {
  if (!Number.isFinite(defPop) || defPop < 0) {
    throw new Error('População defensiva inválida para a sugestão de fulls — informe um número maior ou igual a zero.');
  }
  if (!Number.isFinite(popPerFull) || popPerFull <= 0) {
    throw new Error('População por full inválida — informe um número maior que zero.');
  }

  const base = Math.max(1, Math.ceil(defPop / popPerFull));
  const levelsAbove = wallLevel === null ? 0 : Math.max(0, wallLevel - WALL_BONUS_FROM_LEVEL);
  const bonusPct = Math.min(WALL_BONUS_PCT_CAP, levelsAbove * WALL_BONUS_PCT_PER_LEVEL);
  // Aritmética inteira: (base × (100 + bônus)) / 100 evita erro de ponto
  // flutuante no ceil quando o produto é inteiro.
  const fulls = Math.max(1, Math.ceil((base * (100 + bonusPct)) / 100));

  const ptBr = (value: number): string => value.toLocaleString('pt-BR');
  const plural = (n: number): string => (n === 1 ? 'full' : 'fulls');
  const parts: string[] = [
    `População defensiva ${ptBr(defPop)} ÷ ${ptBr(popPerFull)} por full = ${(defPop / popPerFull).toFixed(2).replace('.', ',')} → base de ${base} ${plural(base)} (arredondado para cima)`,
  ];
  if (bonusPct > 0) {
    parts.push(
      `muralha nível ${wallLevel} adiciona +${bonusPct}% (+${WALL_BONUS_PCT_PER_LEVEL}% por nível acima de ${WALL_BONUS_FROM_LEVEL}, teto +${WALL_BONUS_PCT_CAP}%) → ${fulls} ${plural(fulls)}`,
    );
  } else if (wallLevel !== null) {
    parts.push(
      `muralha nível ${wallLevel} não altera a conta (bônus conta a partir do nível ${WALL_BONUS_FROM_LEVEL + 1})`,
    );
  }
  parts.push('regra-de-polegar configurável, não uma mecânica do jogo');
  return { fulls, detail: `${parts.join('; ')}.` };
}
