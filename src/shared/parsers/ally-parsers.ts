// Parsers das páginas de tribo do Tribal Wars BR (screen=ally), autenticadas.
// Parsing 100% regex/string (sem Electron/DOM), casado com os fixtures reais BR142.
// Fail-closed: estrutura inesperada lança ParseError; nunca retorna dados parciais.

import type { DiplomacyRelations } from '@shared/types';
import type { UnitCounts, UnitId } from '@shared/units';

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

const TAG_STRIP = /<[^>]+>/g;

/** Remove tags, decodifica entidades HTML e colapsa espaços em um único espaço. */
function visibleText(value: string): string {
  return value
    .replace(TAG_STRIP, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Inteiro pt-BR com separador de milhar, ex.: "18.794.467" → 18794467. */
function parseIntHtml(value: string, what: string): number {
  const compact = value.replace(TAG_STRIP, '').replace(/\s+/g, '');
  if (!/^\d[\d.]*$/.test(compact)) {
    throw new ParseError(`${what}: não é um número inteiro válido ("${compact}")`);
  }
  return Number(compact.replace(/\./g, ''));
}

/**
 * Inteiro de coluna que o jogo pode ocultar ("?" no HTML, ex.: ataques a chegar
 * de felipe.loku no fixture BR142). Retorna null = desconhecido, sem inventar valor.
 */
function parseIntHtmlKnown(value: string, what: string): number | null {
  if (value.replace(TAG_STRIP, '').replace(/\s+/g, '') === '?') return null;
  return parseIntHtml(value, what);
}

/** Células <td> de uma linha (conteúdo interno de cada célula). */
function extractCells(html: string, what: string): readonly string[] {
  const cells = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1] ?? '');
  if (cells.length === 0) {
    throw new ParseError(`${what}: nenhuma célula <td> encontrada`);
  }
  return cells;
}

/**
 * Conteúdo da primeira <table> cujo texto (tag inicial inclusive) contém `marker`.
 * A marker identifica a tela: sem ela, a estrutura esperada não está presente.
 */
function findTableWith(html: string, marker: string, what: string): string {
  for (const match of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)) {
    if ((match[0] ?? '').includes(marker)) return match[1] ?? '';
  }
  throw new ParseError(`${what}: tabela com "${marker}" não encontrada`);
}

/**
 * Tabela de dados de unidades "vis w100": para membros com 1000+ aldeias o jogo
 * renderiza um PAGER de paginação ANTES da tabela real, e o pager também usa
 * class="vis w100" — porém sem cabeçalho. Por isso não basta a 1ª ocorrência:
 * pegamos a 1ª "vis w100" com <th> e conteúdo de unidades (ícone unit_*) ou
 * link info_village (visão por aldeia).
 */
function findUnitsDataTable(html: string, what: string): string {
  for (const match of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)) {
    if (!(match[0] ?? '').includes('vis w100')) continue;
    const table = match[1] ?? '';
    if (!table.includes('<th')) continue; // pager de paginação: sem <th>
    if (!/(info_village|unit_\w+\.webp)/.test(table)) continue;
    return table;
  }
  throw new ParseError(`${what}: tabela "vis w100" com cabeçalho (<th>) não encontrada`);
}

// ---------------------------------------------------------------------------
// screen=ally&mode=members (Sumário)
// ---------------------------------------------------------------------------

export interface AllyMember {
  playerId: number;
  name: string;
  points: number;
  villagesCount: number;
  /** true quando a linha abre com o ícone de modo de férias (stat/vacation.webp). */
  inVacation: boolean;
}

export interface AllyMembersResult {
  members: AllyMember[];
}

/**
 * Linha = membro: hidden input player_id[N][id], link info_player?id=N,
 * pontos com separador <span class="grey">.</span> e nº de aldeias.
 * A coluna "Modo de férias" pode conter um 2º link info_player (sitter da conta)
 * — por isso o id/nome vêm da 1ª célula e o id do hidden/primeiro link.
 */
export function parseAllyMembers(html: string): AllyMembersResult {
  const table = findTableWith(html, 'name="player_id[', 'tabela de membros');
  const rows = [...table.matchAll(/<tr\b[^>]*class="row_[ab][^>]*>([\s\S]*?)<\/tr>/g)];
  if (rows.length === 0) {
    throw new ParseError('Tabela de membros sem linhas (esperadas <tr class="row_a|row_b">)');
  }
  const members: AllyMember[] = [];
  for (const row of rows) {
    const cells = extractCells(row[1] ?? '', 'linha da tabela de membros');
    if (cells.length < 5) {
      throw new ParseError(`Linha de membro com ${cells.length} células; esperadas ao menos 5`);
    }
    const head = cells[0] ?? '';
    const idMatch = /name="player_id\[(\d+)\]\[id\]"/.exec(head);
    const linkMatch = /screen=info_player[^>]*id=(\d+)[^>]*>([\s\S]*?)<\/a>/.exec(head);
    if (idMatch === null && linkMatch === null) {
      throw new ParseError('Linha de membro sem player_id/info_player');
    }
    const name = linkMatch === null ? '' : visibleText(linkMatch[2] ?? '');
    if (name === '') {
      throw new ParseError('Linha de membro sem nome');
    }
    members.push({
      playerId: Number(idMatch?.[1] ?? linkMatch?.[1]),
      name,
      points: parseIntHtml(cells[2] ?? '', 'pontos do membro'),
      villagesCount: parseIntHtml(cells[4] ?? '', 'nº de aldeias do membro'),
      inVacation: /stat\/vacation\.webp/.test(head),
    });
  }
  return { members };
}

// ---------------------------------------------------------------------------
// Dropdown "Selecionar membro" (members_troops / members_defense)
// ---------------------------------------------------------------------------

export interface MemberSelectorResult {
  options: { playerId: number; name: string }[];
}

export function parseMemberSelector(html: string): MemberSelectorResult {
  const select = /<select\b[^>]*name="player_id"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1];
  if (select === undefined) {
    throw new ParseError('Dropdown de membro (select name="player_id") não encontrado');
  }
  const options: MemberSelectorResult['options'] = [];
  for (const match of select.matchAll(/<option\b[^>]*value="(\d+)"[^>]*>([\s\S]*?)<\/option>/g)) {
    const name = visibleText(match[2] ?? '');
    if (name === '') {
      throw new ParseError('Opção do dropdown de membro sem nome');
    }
    options.push({ playerId: Number(match[1]), name });
  }
  return { options };
}

// ---------------------------------------------------------------------------
// Tabela de unidades (members_troops / members_defense)
// ---------------------------------------------------------------------------

/** Tropas treinadas/recrutadas de um jogador (members_troops) ou na defesa. */
export interface TrainedUnitsRow {
  playerId: number;
  name: string;
  points: number;
  units: UnitCounts;
  /** Coluna "Comandos activos", quando presente no cabeçalho. */
  commandsCount?: number;
  /** Coluna "Ataques a chegar", quando presente no cabeçalho. */
  incomingAttacksCount?: number;
}

export interface AllyUnitsResult {
  players: TrainedUnitsRow[];
}

const UNIT_IMG_TO_ID: Record<string, UnitId> = {
  unit_spear: 'spear',
  unit_sword: 'sword',
  unit_axe: 'axe',
  unit_archer: 'archer',
  unit_spy: 'spy',
  unit_light: 'light',
  unit_marcher: 'marcher',
  unit_heavy: 'heavy',
  unit_ram: 'ram',
  unit_catapult: 'catapult',
  unit_knight: 'knight',
  unit_snob: 'snob',
  unit_militia: 'militia',
};

/** Ordem canônica das colunas de unidades no BR142 (header do fixture real). */
const UNIT_ORDER: readonly UnitId[] = [
  'spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy',
  'ram', 'catapult', 'knight', 'snob', 'militia',
];

type UnitsColumn =
  | { kind: 'unit'; unit: UnitId }
  | { kind: 'commands' }
  | { kind: 'incoming' };

/** Mapeia os <th> do cabeçalho (imgs unit_*.webp, commands_outgoing.webp, att.webp). */
function parseUnitsHeader(headerRowHtml: string): readonly UnitsColumn[] {
  const columns: UnitsColumn[] = [];
  for (const th of headerRowHtml.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)) {
    const cell = th[1] ?? '';
    const unitImg = /unit\/(unit_\w+)\.webp/.exec(cell)?.[1];
    if (unitImg !== undefined) {
      const unit = UNIT_IMG_TO_ID[unitImg];
      if (unit === undefined) {
        throw new ParseError(`Imagem de unidade desconhecida no cabeçalho: "${unitImg}"`);
      }
      columns.push({ kind: 'unit', unit });
      continue;
    }
    if (/commands_outgoing\.webp/.test(cell)) {
      columns.push({ kind: 'commands' });
      continue;
    }
    if (/unit\/att\.webp/.test(cell)) {
      columns.push({ kind: 'incoming' });
    }
  }
  if (columns.length === 0) {
    throw new ParseError('Cabeçalho da tabela sem colunas de unidades');
  }
  // As colunas devem seguir a ordem canônica (subsequência); reordenação = erro.
  let lastIndex = -1;
  for (const column of columns) {
    if (column.kind !== 'unit') continue;
    const index = UNIT_ORDER.indexOf(column.unit);
    if (index <= lastIndex) {
      throw new ParseError(`Ordem inesperada de colunas de unidades (${column.unit})`);
    }
    lastIndex = index;
  }
  return columns;
}

/**
 * Tabela "vis w100" de unidades: 1ª célula = link info_player (linha = jogador na
 * visão sem membro selecionado), 2ª = pontos, demais seguem o cabeçalho.
 * A linha de totais ("Sumário") é ignorada; qualquer outra divergência é erro.
 */
function parseUnitsTable(tableHtml: string, what: string): AllyUnitsResult {
  const rows = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)];
  const headerIndex = rows.findIndex((row) => (row[1] ?? '').includes('<th'));
  if (headerIndex === -1) {
    throw new ParseError(`${what}: linha de cabeçalho (<th>) não encontrada`);
  }
  const columns = parseUnitsHeader(rows[headerIndex]?.[1] ?? '');
  const expectedCells = 2 + columns.length;
  const players: TrainedUnitsRow[] = [];
  for (let r = 0; r < rows.length; r++) {
    if (r === headerIndex) continue;
    const cells = extractCells(rows[r]?.[1] ?? '', what);
    if (visibleText(cells[0] ?? '') === 'Sumário') continue; // linha de totais no fim
    if (cells.length !== expectedCells) {
      throw new ParseError(`${what}: linha com ${cells.length} células; esperadas ${expectedCells}`);
    }
    const head = cells[0] ?? '';
    const linkMatch = /screen=info_player[^>]*id=(\d+)[^>]*>([\s\S]*?)<\/a>/.exec(head);
    if (linkMatch === null) {
      throw new ParseError(`${what}: linha sem link info_player`);
    }
    const rowResult: TrainedUnitsRow = {
      playerId: Number(linkMatch[1]),
      name: visibleText(linkMatch[2] ?? ''),
      points: parseIntHtml(cells[1] ?? '', `${what}: pontos`),
      units: {},
    };
    for (let i = 0; i < columns.length; i++) {
      const column = columns[i];
      const cell = cells[2 + i];
      if (column === undefined || cell === undefined) {
        throw new ParseError(`${what}: célula ${2 + i} ausente na linha`);
      }
      if (column.kind === 'unit') {
        rowResult.units[column.unit] = parseIntHtml(cell, `${what}: unidade ${column.unit}`);
      } else if (column.kind === 'commands') {
        const count = parseIntHtmlKnown(cell, `${what}: comandos activos`);
        if (count !== null) rowResult.commandsCount = count;
      } else {
        const count = parseIntHtmlKnown(cell, `${what}: ataques a chegar`);
        if (count !== null) rowResult.incomingAttacksCount = count;
      }
    }
    players.push(rowResult);
  }
  return { players };
}

/**
 * screen=ally&mode=members_troops: "Tropas" = unidades pertencentes ao jogador
 * (recrutadas; a própria tela informa "incluindo tropas atualmente fora da aldeia").
 * A tabela é obrigatória aqui — página sem ela → ParseError (fail-closed).
 */
export function parseMembersTroops(html: string): AllyUnitsResult {
  return parseUnitsTable(findTableWith(html, 'vis w100', 'tabela de tropas'), 'tabela de tropas');
}

/**
 * screen=ally&mode=members_defense: mesma estrutura, porém o BR142 não renderiza
 * tabela alguma quando nenhum membro está selecionado (fixture real) — nesse caso
 * o resultado vazio é o dado correto da página, não um erro.
 */
export function parseMembersDefense(html: string): AllyUnitsResult {
  for (const match of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)) {
    if ((match[0] ?? '').includes('vis w100')) {
      return parseUnitsTable(match[1] ?? '', 'tabela de defesa');
    }
  }
  return { players: [] };
}

// ---------------------------------------------------------------------------
// Visão POR ALDEIA (membro selecionado): members_troops&player_id=N / members_defense&player_id=N
// ---------------------------------------------------------------------------

export interface VillageUnitsRow {
  villageId: number;
  name: string;
  coord: { x: number; y: number };
  points: number;
  units: UnitCounts;
}

export interface MemberVillageTroopsResult {
  villages: VillageUnitsRow[];
}

export interface VillageDefenseRow {
  villageId: number;
  name: string;
  coord: { x: number; y: number };
  points: number;
  /** Tropas fisicamente na aldeia (sub-linha "Na Aldeia"). */
  unitsInVillage: UnitCounts;
  /** Tropas a caminho (sub-linha "a caminho"). */
  unitsInTransit: UnitCounts;
}

export interface MemberVillageDefenseResult {
  villages: VillageDefenseRow[];
}

/** "001- REBOUÇAS - (675|488) K46" → id do link + coordenada do rótulo. */
function parseVillageCell(cell: string, what: string): { villageId: number; name: string; coord: { x: number; y: number } } {
  const link = /screen=info_village[^>]*id=(\d+)[^>]*>([\s\S]*?)<\/a>/.exec(cell);
  if (link === null) {
    throw new ParseError(`${what}: célula da aldeia sem link info_village`);
  }
  const name = visibleText(link[2] ?? '');
  const coord = /\((\d{1,3})\|(\d{1,3})\)/.exec(name);
  if (coord === null) {
    throw new ParseError(`${what}: nome da aldeia sem coordenada "(x|y)" ("${name}")`);
  }
  return { villageId: Number(link[1]), name, coord: { x: Number(coord[1]), y: Number(coord[2]) } };
}

function unitsFromCells(cells: readonly string[], start: number, columns: readonly UnitsColumn[], what: string): UnitCounts {
  const units: UnitCounts = {};
  let cursor = start;
  for (const column of columns) {
    if (column.kind !== 'unit') continue;
    const cell = cells[cursor];
    if (cell === undefined) {
      throw new ParseError(`${what}: célula da unidade ${column.unit} ausente`);
    }
    units[column.unit] = parseIntHtmlKnown(cell, `${what}: unidade ${column.unit}`) ?? 0;
    cursor += 1;
  }
  return units;
}

/**
 * members_troops&player_id=N — 1 linha por aldeia: [aldeia, pontos, ...13 unidades
 * (mapeadas pelos ícones do cabeçalho), extras hidden no fim ignoradas].
 * Fixtures: tests/fixtures/br142/troops-{reboucas,spartacus}-rows.html
 */
export function parseMemberVillageTroops(html: string): MemberVillageTroopsResult {
  const table = findUnitsDataTable(html, 'tabela de tropas por aldeia');
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)];
  const headerIndex = rows.findIndex((row) => (row[1] ?? '').includes('<th'));
  if (headerIndex === -1) {
    throw new ParseError('tabela de tropas por aldeia: cabeçalho (<th>) não encontrado');
  }
  const columns = parseUnitsHeader(rows[headerIndex]?.[1] ?? '');
  const villages: VillageUnitsRow[] = [];
  for (let r = headerIndex + 1; r < rows.length; r++) {
    const cells = extractCells(rows[r]?.[1] ?? '', 'tabela de tropas por aldeia');
    if (cells.length < 2 + columns.filter((c) => c.kind === 'unit').length) {
      throw new ParseError(`tabela de tropas por aldeia: linha com ${cells.length} células (mínimo esperado: ${2 + columns.filter((c) => c.kind === 'unit').length})`);
    }
    const head = parseVillageCell(cells[0] ?? '', 'tabela de tropas por aldeia');
    villages.push({
      ...head,
      points: parseIntHtml(cells[1] ?? '', 'tabela de tropas por aldeia: pontos'),
      units: unitsFromCells(cells, 2, columns, 'tabela de tropas por aldeia'),
    });
  }
  if (villages.length === 0) {
    throw new ParseError('tabela de tropas por aldeia sem linhas de aldeia');
  }
  return { villages };
}

/**
 * members_defense&player_id=N — GRUPOS de 2 sub-linhas com rowspan=2 na célula da
 * aldeia/pontos: sub-linha "Na Aldeia" (unidades presentes) + sub-linha
 * "a caminho" (em trânsito). Fixtures: defense-{reboucas,spartacus}-rows.html
 */
export function parseMemberVillageDefense(html: string): MemberVillageDefenseResult {
  const table = findUnitsDataTable(html, 'tabela de defesa por aldeia');
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)];
  const headerIndex = rows.findIndex((row) => (row[1] ?? '').includes('<th'));
  if (headerIndex === -1) {
    throw new ParseError('tabela de defesa por aldeia: cabeçalho (<th>) não encontrado');
  }
  const columns = parseUnitsHeader(rows[headerIndex]?.[1] ?? '');
  const villages: VillageDefenseRow[] = [];
  for (let r = headerIndex + 1; r < rows.length; r++) {
    const cells = extractCells(rows[r]?.[1] ?? '', 'tabela de defesa por aldeia');
    // Linha inicial do grupo: contém o link da aldeia + pontos + rótulo "Na Aldeia".
    if (!/screen=info_village/.test(cells[0] ?? '')) continue;
    const head = parseVillageCell(cells[0] ?? '', 'tabela de defesa por aldeia');
    const points = parseIntHtml(cells[1] ?? '', 'tabela de defesa por aldeia: pontos');
    const unitsInVillage = unitsFromCells(cells, 3, columns, 'tabela de defesa por aldeia (Na Aldeia)');
    // Sub-linha seguinte = "a caminho" (sem célula da aldeia por causa do rowspan).
    const transitRow = rows[r + 1];
    const transitCells = transitRow ? extractCells(transitRow[1] ?? '', 'tabela de defesa por aldeia (trânsito)') : [];
    const transitLabel = visibleText(transitCells[0] ?? '');
    if (!/caminho/i.test(transitLabel)) {
      throw new ParseError(`tabela de defesa por aldeia: esperada sub-linha "a caminho", veio "${transitLabel}"`);
    }
    const unitsInTransit = unitsFromCells(transitCells, 1, columns, 'tabela de defesa por aldeia (a caminho)');
    villages.push({ ...head, points, unitsInVillage, unitsInTransit });
    r += 1; // consome a sub-linha de trânsito
  }
  if (villages.length === 0) {
    throw new ParseError('tabela de defesa por aldeia sem grupos de aldeia');
  }
  return { villages };
}

/**
 * Números de páginas (>=2) apontados pelos links do pager (paged-nav-item);
 * page=-1 ("todos") e page=0/1 são ignorados. Sem pager = [].
 * O jogo usa aspas simples no class ('paged-nav-item'); aspas duplas também é aceito.
 */
export function extractPagedNavPages(html: string): number[] {
  const pages = new Set<number>();
  for (const anchor of html.matchAll(
    /<a\b[^>]*\bclass\s*=\s*(?:"[^"]*paged-nav-item[^"]*"|'[^']*paged-nav-item[^']*')[^>]*>/g,
  )) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(anchor[0] ?? '');
    // page=-1 não casa (\d+ não aceita "-"); \b evita prefixos (ex.: "vpage=")
    const page = /\bpage=(\d+)(?!\d)/.exec(href?.[1] ?? href?.[2] ?? '')?.[1];
    if (page === undefined) continue;
    const pageNumber = Number(page);
    if (pageNumber < 2) continue; // 0/1 = página atual; nunca há pager para elas
    pages.add(pageNumber);
  }
  return [...pages].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// screen=ally&mode=contracts (Diplomacia)
// ---------------------------------------------------------------------------

export interface AllyRelation {
  allyId: number;
  tag: string;
  name: string;
}

export type AllyContractsResult = DiplomacyRelations;

function contractSection(name: string): 'allies' | 'naps' | 'enemies' | null {
  const normalized = name.toLowerCase();
  if (normalized.includes('aliad')) return 'allies';
  if (normalized.includes('pna') || normalized.includes('não-agressão')) return 'naps';
  if (normalized.includes('inimig')) return 'enemies';
  return null;
}

/**
 * Tabela id="partners" com seções Aliados / Pactos de não-agressão (PNA) / Inimigos.
 * Tribo própria: id em TribalWars.updateGameData ("ally":"40") e o cabeçalho <h2>
 * ("Toxic Squad Sul (Nível 18)") — nesta versão BR o cabeçalho expõe o NOME da
 * tribo; a página não traz uma tag distinta da própria tribo.
 * Nas linhas de contrato o texto do link info_ally é a tag exibida (ex.: "~TDU~");
 * a página não expõe o nome completo, então name recebe o mesmo identificador.
 */
export function parseContracts(html: string): AllyContractsResult {
  const table = findTableWith(html, 'id="partners"', 'tabela de diplomacia');

  const ownAllyIdMatch = /"ally":"(\d+)"/.exec(html);
  if (ownAllyIdMatch === null) {
    throw new ParseError('Dados do jogo sem o campo "ally" (id da tribo do jogador)');
  }

  const h2Match = /<h2\b[^>]*>([\s\S]*?)<\/h2>/.exec(html);
  if (h2Match === null) {
    throw new ParseError('Cabeçalho da tribo (<h2>) não encontrado');
  }
  const ownTag = visibleText(h2Match[1] ?? '')
    .replace(/\s*\(Nível\s*\d+\)\s*$/i, '')
    .trim();
  if (ownTag === '') {
    throw new ParseError('Nome/tag da tribo própria vazio no <h2>');
  }

  const result: AllyContractsResult = { ownAllyId: Number(ownAllyIdMatch[1]), ownTag, enemies: [], allies: [], naps: [] };
  const chunks = table.split(/<th\b[^>]*>([\s\S]*?)<\/th>/);
  if (chunks.length === 1) {
    throw new ParseError('Seções Aliados/PNA/Inimigos não encontradas na tabela de diplomacia');
  }
  for (let i = 1; i < chunks.length; i += 2) {
    const section = contractSection(visibleText(chunks[i] ?? ''));
    const content = chunks[i + 1];
    if (section === null || content === undefined) continue;
    const relations: AllyRelation[] = [];
    for (const row of content.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
      const linkMatch = /screen=info_ally[^>]*id=(\d+)[^>]*>([\s\S]*?)<\/a>/.exec(row[1] ?? '');
      if (linkMatch === null) continue; // linha decorativa (espaçador)
      const tag = visibleText(linkMatch[2] ?? '');
      if (tag === '') {
        throw new ParseError('Linha de contrato sem texto de tribo');
      }
      relations.push({ allyId: Number(linkMatch[1]), tag, name: tag });
    }
    result[section] = relations;
  }
  return result;
}