// Filtros de busca das tabelas da Sala de Guerra (monitoramento): derivados
// puros e fail-soft, mesma doutrina do sg5-view-filter — EMPTY congelado +
// contains acento/case-insensitive (fold) nos dois lados. Sem DOM, sem rede,
// sem estado: a UI espalha EMPTY_WAR_VIEW_FILTER e chama o filtro da tabela.
//
// Tipagem estrutural (genérica): as linhas reais da UI encaixam sem cast e os
// campos extras são preservados — o filtro devolve as MESMAS referências que
// passaram, na ordem recebida (o input nunca é mutado).
import { fold } from './fold';

/** Linha da tabela "por jogador" do monitoramento: atribuição vs. envio real. */
export interface WarPerPlayerRow {
  playerName: string;
  assigned: number;
  sent: number;
}

/** Linha do scorecard por jogador: participação em ops e aderência ao esperado. */
export interface WarScorecardRow {
  playerName: string;
  opsParticipated: number;
  expected: number;
  sent: number;
  missed: number;
}

/** Linha do pós-op por alvo (resultado da operação na coord). */
export interface WarOutcomeRow {
  coord: string;
}

export interface WarViewFilter {
  /** Contains acento/case-insensitive no playerName (per-player/scorecard) ou coord (outcomes). Vazio = todos. */
  query: string;
}

/** Filtro neutro: tudo passa (fail-soft por padrão). Congelado — espalhe para derivar. */
export const EMPTY_WAR_VIEW_FILTER: WarViewFilter = Object.freeze({ query: '' });

/** Query efetiva já dobrada: '' quando o filtro é nulo/inválido (fail-soft — nunca lança). */
function foldedQuery(filter: WarViewFilter | null | undefined): string {
  const raw = typeof filter?.query === 'string' ? filter.query.trim() : '';
  return raw === '' ? '' : fold(raw);
}

/** Verdadeiro só com busca ativa (query não vazia após trim); filtro nulo/inválido = falso. */
export function hasWarFilter(filter: WarViewFilter | null | undefined): boolean {
  return foldedQuery(filter) !== '';
}

/**
 * Contains fold(value) ⊇ query — "joao" vinca "João". Query vazia passa tudo;
 * valor não-string (linha torta da UI) nunca vinca em vez de lançar.
 */
function textPasses(value: string | undefined, query: string): boolean {
  if (query === '') return true;
  return fold(typeof value === 'string' ? value : '').includes(query);
}

/** Filtra a tabela por jogador por fold(playerName) contendo a query. Fail-soft: rows nulo = []. */
export function filterPerPlayer<Row extends WarPerPlayerRow>(
  rows: readonly Row[] | null | undefined,
  filter: WarViewFilter | null | undefined,
): Row[] {
  const query = foldedQuery(filter);
  return (rows ?? []).filter((row) => textPasses(row === null ? undefined : row.playerName, query));
}

/** Filtra o scorecard por fold(playerName) — mesma semântica do filterPerPlayer. Fail-soft: rows nulo = []. */
export function filterScorecard<Row extends WarScorecardRow>(
  rows: readonly Row[] | null | undefined,
  filter: WarViewFilter | null | undefined,
): Row[] {
  const query = foldedQuery(filter);
  return (rows ?? []).filter((row) => textPasses(row === null ? undefined : row.playerName, query));
}

/** Filtra o pós-op por alvo por fold(coord). Fail-soft: rows nulo = []. */
export function filterOutcomes<Row extends WarOutcomeRow>(
  rows: readonly Row[] | null | undefined,
  filter: WarViewFilter | null | undefined,
): Row[] {
  const query = foldedQuery(filter);
  return (rows ?? []).filter((row) => textPasses(row === null ? undefined : row.coord, query));
}
