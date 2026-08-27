// Contador FULL/SEMI por jogador a partir de um snapshot de tropas (SG_2).
//
// Classificação por POPULAÇÃO OFENSIVA da aldeia (= Σ unidades × população da
// unidade): "full" quando ≥ fullPop; "semi" quando ≥ semiPop e < fullPop.
// A população POR UNIDADE é INJETADA pelo caller (vem do unit-info do mundo) —
// aqui NUNCA se hardcoda população, porque varia entre mundos/eras do jogo.
//
// Puro e determinístico; abaixo dos dois limiares a aldeia não conta como
// nem full nem semi (e jogador sem nenhuma delas não aparece no resultado).

import { continentOf } from './coords';

export interface FullSemiEntry {
  playerName: string;
  coord: { x: number; y: number };
  units: Record<string, number>;
}

export interface FullSemiInput {
  entries: FullSemiEntry[];
  /** População mínima para a aldeia contar como FULL (do unit-info do mundo). */
  fullPop: number;
  /** População mínima para contar como SEMI (deve ser < fullPop). */
  semiPop: number;
  /** População por unidade — injetada pelo caller; unidade ausente = não somada. */
  popByUnit: Record<string, number>;
}

export interface PlayerFullSemi {
  playerName: string;
  fulls: number;
  semis: number;
  /** Coordenadas "x|y": aldeias FULL primeiro, depois as SEMI (ordem do snapshot). */
  coords: string[];
}

export interface FullSemiResult {
  players: PlayerFullSemi[];
  /** Unidades presentes nas tropas mas sem população em popByUnit (contam 0) — avisar o caller. */
  unknownUnits: string[];
}

/** População ofensiva de uma aldeia pela tabela injetada; desconhecida = 0. */
function offensivePop(units: Record<string, number>, popByUnit: Record<string, number>): number {
  let total = 0;
  for (const [unit, count] of Object.entries(units)) {
    const unitPop = popByUnit[unit];
    if (unitPop === undefined) continue;
    total += (count ?? 0) * unitPop;
  }
  return total;
}

/** Validação fail-closed compartilhada dos limiares (mensagens idênticas ao contador antigo). */
function validatePops(fullPop: number, semiPop: number): void {
  if (!Number.isInteger(fullPop) || fullPop <= 0) {
    throw new Error(`População de FULL inválida (use um inteiro maior que 0): ${String(fullPop)}.`);
  }
  if (!Number.isInteger(semiPop) || semiPop <= 0) {
    throw new Error(`População de SEMI inválida (use um inteiro maior que 0): ${String(semiPop)}.`);
  }
  if (semiPop >= fullPop) {
    throw new Error(`População de SEMI (${semiPop}) deve ser MENOR que a de FULL (${fullPop}).`);
  }
}

export function fullSemiByPlayer(input: FullSemiInput): FullSemiResult {
  const { fullPop, semiPop, popByUnit } = input;
  validatePops(fullPop, semiPop);

  const unknown = new Set<string>();
  const byPlayer = new Map<string, { fulls: string[]; semis: string[] }>();
  for (const entry of input.entries) {
    for (const unit of Object.keys(entry.units)) {
      if (popByUnit[unit] === undefined) unknown.add(unit);
    }
    const pop = offensivePop(entry.units, popByUnit);
    if (pop < semiPop) continue; // abaixo de ambos os limiares: não é nem full nem semi
    const player = byPlayer.get(entry.playerName) ?? { fulls: [], semis: [] };
    const coord = `${entry.coord.x}|${entry.coord.y}`;
    if (pop >= fullPop) player.fulls.push(coord);
    else player.semis.push(coord);
    byPlayer.set(entry.playerName, player);
  }

  // Ordena por nº de fulls desc, depois semis desc, depois nick (PT-BR).
  const players = [...byPlayer.entries()]
    .map(([playerName, tally]) => ({
      playerName,
      fulls: tally.fulls.length,
      semis: tally.semis.length,
      coords: [...tally.fulls, ...tally.semis],
    }))
    .sort(
      (a, b) => b.fulls - a.fulls || b.semis - a.semis || a.playerName.localeCompare(b.playerName, 'pt-BR'),
    );

  return { players, unknownUnits: [...unknown].sort((a, b) => a.localeCompare(b, 'pt-BR')) };
}

/** Resumo amigável ao copia-e-cola: uma linha por jogador — "nick;fulls;semis;coords". */
export function formatFullSemi(players: PlayerFullSemi[]): string {
  return players.map((p) => `${p.playerName};${p.fulls};${p.semis};${p.coords.join(' ')}`).join('\n');
}

// ---------------------------------------------------------------------------
// RELATÓRIO premium (SG_2 → SG_4): mesmo motor de classificação FULL/SEMI com
// filtros (unidades, continente, jogador), detalhe por aldeia/continente e
// formatters para os relatórios da operação. fullSemiByPlayer continua como
// API simples compatível.
// ---------------------------------------------------------------------------

export type FullSemiSortBy = 'fulls' | 'semis' | 'total' | 'nick';

/** Aldeia contabilizada do relatório: tier + população ofensiva usada na classificação. */
export interface VillageFullSemi {
  /** Coordenada "x|y". */
  coord: string;
  /** Continente via continentOf({x, y}) — K 0–99. */
  k: number;
  /** População ofensiva somada (só unidades contabilizadas). */
  pop: number;
  tier: 'full' | 'semi';
}

export interface PlayerFullSemiReport {
  playerName: string;
  fulls: number;
  semis: number;
  /** Aldeias FULL primeiro, depois as SEMI; dentro de cada tier, ordem do snapshot. */
  villages: VillageFullSemi[];
  /** Contagem por continente: só Ks com ao menos 1 aldeia; ordenado por k crescente. */
  byK: { k: number; fulls: number; semis: number }[];
}

export interface FullSemiReportOptions {
  /** Limiar FULL (população das unidades contabilizadas). */
  fullPop: number;
  /** Limiar SEMI (< fullPop). */
  semiPop: number;
  /** IDs das unidades CONTABILIZADAS na soma (ex.: só ofensivas). Vazio = TODAS as unidades do snapshot contam. */
  unitIds?: string[];
  /** Filtro por continente aplicado POR ALDEIA (K 0-99; incluir vazio = 0 aldeias — fail-closed igual Sg2Filters.kFilter). */
  kFilter?: { ks: number[]; mode: 'incluir' | 'excluir' };
  /** Filtro por jogador aplicado APÓS a agregação: 'incluir' = só estes nicks; 'excluir' = todos menos estes. Vazio+incluir = ninguém. */
  playerFilter?: { names: string[]; mode: 'incluir' | 'excluir' };
  /** Ordenação do array players. Default 'fulls'. */
  sortBy?: FullSemiSortBy;
  /** Ocultar jogadores com menos que N fulls (default 0). */
  minFulls?: number;
  /** Ocultar jogadores com menos que N semis (default 0). */
  minSemis?: number;
}

export interface FullSemiReport {
  players: PlayerFullSemiReport[];
  /** Unidades das tropas com contagem > 0 fora de popByUnit (contam 0) — avisar o caller. */
  unknownUnits: string[];
  /** Soma dos jogadores VISÍVEIS do relatório. villages = aldeias contabilizadas (full+semi). */
  totals: { players: number; fulls: number; semis: number; villages: number };
}

const SORT_MODES: readonly FullSemiSortBy[] = ['fulls', 'semis', 'total', 'nick'];

function comparatorFor(sortBy: FullSemiSortBy): (a: PlayerFullSemiReport, b: PlayerFullSemiReport) => number {
  const byNick = (a: PlayerFullSemiReport, b: PlayerFullSemiReport): number =>
    a.playerName.localeCompare(b.playerName, 'pt-BR');
  switch (sortBy) {
    case 'nick':
      return byNick;
    case 'semis':
      return (a, b) => b.semis - a.semis || b.fulls - a.fulls || byNick(a, b);
    case 'total':
      return (a, b) => b.fulls + b.semis - (a.fulls + a.semis) || byNick(a, b);
    default: // 'fulls': mesma ordenação do contador antigo.
      return (a, b) => b.fulls - a.fulls || b.semis - a.semis || byNick(a, b);
  }
}

/**
 * Relatório premium FULL/SEMI: classifica cada aldeia e devolve o detalhamento
 * estruturado (aldeias, continentes) + formatters prontos para SG_4.
 *
 * Ordem dos filtros: kFilter POR ALDEIA antes do tier; playerFilter e
 * minFulls/minSemis APÓS a agregação (o jogador some inteiro do relatório,
 * inclusive dos totals); sortBy apenas reordena o array final.
 * Aldeias abaixo de semiPop são IGNORADAS do relatório (nem totals as veem).
 */
export function fullSemiReport(
  input: { entries: FullSemiEntry[]; popByUnit: Record<string, number> },
  options: FullSemiReportOptions,
): FullSemiReport {
  const { entries, popByUnit } = input;
  const { fullPop, semiPop } = options;
  validatePops(fullPop, semiPop);

  const sortBy = options.sortBy ?? 'fulls';
  if (!SORT_MODES.includes(sortBy)) {
    throw new Error(
      `Ordenação inválida (use fulls, semis, total ou nick): ${String(options.sortBy)}.`,
    );
  }

  const kFilter = options.kFilter;
  if (kFilter !== undefined) {
    const invalidKs = kFilter.ks.filter((k) => !Number.isInteger(k) || k < 0 || k > 99);
    if (invalidKs.length > 0) {
      throw new Error(`Continente(s) inválido(s) no filtro K (use inteiros de 0 a 99): ${invalidKs.join(', ')}.`);
    }
  }
  const kSet = kFilter !== undefined ? new Set(kFilter.ks) : null;

  const minFulls = options.minFulls ?? 0;
  const minSemis = options.minSemis ?? 0;
  if (!Number.isInteger(minFulls) || minFulls < 0) {
    throw new Error(`Mínimo de FULLS inválido (use um inteiro maior ou igual a 0): ${String(options.minFulls)}.`);
  }
  if (!Number.isInteger(minSemis) || minSemis < 0) {
    throw new Error(`Mínimo de SEMIS inválido (use um inteiro maior ou igual a 0): ${String(options.minSemis)}.`);
  }

  const namesFilter = options.playerFilter;

  // unitIds ausente OU vazio = todas as unidades do snapshot entram na soma.
  const unitIds = options.unitIds;
  const unitSet = unitIds !== undefined && unitIds.length > 0 ? new Set(unitIds) : null;

  const unknown = new Set<string>();
  interface Tally {
    fulls: VillageFullSemi[];
    semis: VillageFullSemi[];
    byK: Map<number, { fulls: number; semis: number }>;
  }
  const byPlayer = new Map<string, Tally>();

  for (const entry of entries) {
    const k = continentOf(entry.coord);
    // Filtro por continente POR ALDEIA, antes do tier ('incluir' com ks vazio:
    // o conjunto vazio não contém nenhum K → nada passa, igual Sg2Filters).
    if (kSet !== null && kFilter !== undefined) {
      if (kFilter.mode === 'incluir' ? !kSet.has(k) : kSet.has(k)) continue;
    }

    let pop = 0;
    for (const [unit, rawCount] of Object.entries(entry.units)) {
      const count = rawCount ?? 0;
      if (count <= 0) continue;
      const unitPop = popByUnit[unit];
      if (unitPop === undefined) {
        // Unidade contada mas sem população no mundo: vale 0 e é reportada —
        // independe de unitIds (caller decide avisar ou bloquear).
        unknown.add(unit);
        continue;
      }
      if (unitSet === null || unitSet.has(unit)) pop += count * unitPop;
    }

    if (pop < semiPop) continue; // abaixo dos dois limiares: aldeia ignorada do relatório
    const tier: VillageFullSemi['tier'] = pop >= fullPop ? 'full' : 'semi';
    const village: VillageFullSemi = { coord: `${entry.coord.x}|${entry.coord.y}`, k, pop, tier };

    const existingTally = byPlayer.get(entry.playerName);
    const tally: Tally = existingTally ?? { fulls: [], semis: [], byK: new Map() };
    if (tier === 'full') tally.fulls.push(village);
    else tally.semis.push(village);
    const kb: { fulls: number; semis: number } = tally.byK.get(k) ?? { fulls: 0, semis: 0 };
    if (tier === 'full') kb.fulls += 1;
    else kb.semis += 1;
    tally.byK.set(k, kb);
    byPlayer.set(entry.playerName, tally);
  }

  let reports: PlayerFullSemiReport[] = [...byPlayer.entries()].map(([playerName, tally]) => ({
    playerName,
    fulls: tally.fulls.length,
    semis: tally.semis.length,
    villages: [...tally.fulls, ...tally.semis],
    byK: [...tally.byK.entries()]
      .map(([k, count]) => ({ k, fulls: count.fulls, semis: count.semis }))
      .sort((a, b) => a.k - b.k),
  }));

  if (namesFilter !== undefined) {
    const names = new Set(namesFilter.names);
    reports = reports.filter((p) => (namesFilter.mode === 'incluir' ? names.has(p.playerName) : !names.has(p.playerName)));
  }
  reports = reports.filter((p) => p.fulls >= minFulls && p.semis >= minSemis);

  reports.sort(comparatorFor(sortBy));

  const totals = reports.reduce(
    (acc, p) => ({
      players: acc.players + 1,
      fulls: acc.fulls + p.fulls,
      semis: acc.semis + p.semis,
      villages: acc.villages + p.villages.length,
    }),
    { players: 0, fulls: 0, semis: 0, villages: 0 },
  );

  return { players: reports, unknownUnits: [...unknown].sort((a, b) => a.localeCompare(b, 'pt-BR')), totals };
}

const coordsOfTier = (p: PlayerFullSemiReport, tier: VillageFullSemi['tier']): string[] =>
  p.villages.filter((v) => v.tier === tier).map((v) => v.coord);

/** "nick;fulls;semis;coords" — MESMA saída do formatFullSemi antigo (coordenadas separadas por espaço). */
export function formatFullSemiRows(players: PlayerFullSemiReport[]): string {
  return players
    .map((p) => `${p.playerName};${p.fulls};${p.semis};${[...coordsOfTier(p, 'full'), ...coordsOfTier(p, 'semi')].join(' ')}`)
    .join('\n');
}

/** INFORMAÇÕES ORIGEM do SG_4 ("Nick;Nro Fulls;Coordenadas Origem"): origem do NT = só as aldeias FULL. */
export function formatOriginsRows(players: PlayerFullSemiReport[]): string {
  return players.map((p) => `${p.playerName};${p.fulls};${coordsOfTier(p, 'full').join(' ')}`).join('\n');
}

/** Uma linha por jogador só com as coordenadas do tier pedido ('ambos' = fulls + semis, nessa ordem). */
export function formatTargetsRows(players: PlayerFullSemiReport[], tier: 'full' | 'semi' | 'ambos'): string {
  return players
    .map((p) => (tier === 'ambos' ? [...coordsOfTier(p, 'full'), ...coordsOfTier(p, 'semi')] : coordsOfTier(p, tier)).join(' '))
    .join('\n');
}
