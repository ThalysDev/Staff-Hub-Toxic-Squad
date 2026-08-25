import type { UnitCounts } from '../units';
// Parser das linhas de comandos (widget "Comandos a caminho"/"Chegando") do TW BR.
// Validado contra tests/fixtures/br142/incomings-own.html (701 comandos reais).
// O mesmo widget aparece na página info_village com comandos compartilhados.

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export interface IncomingCommandRow {
  commandId: number;
  /** Nome do comando (renomeável pelo jogador; padrão = tipo, ex.: "Suporte"). */
  name: string;
  /** Tipo pelo ícone: attack | support | ... */
  type: string;
  /** Todos os data-icon-hint da linha (ex.: "Ataque pequeno (1-1000 tropas)", "Com nobre"). */
  hints: string[];
  /** true quando algum hint indica presença de nobre ("Com nobre"). */
  hasNoble: boolean;
  /** Classe de tamanho lida dos hints: 'pequeno' | 'médio' | 'grande' | null. */
  sizeHint: 'pequeno' | 'médio' | 'grande' | null;
  destination: { name: string; coord: string };
  origin: { name: string; coord: string };
  playerName: string;
  /** Distância em campos, ex.: "96.8". */
  fieldsDistance: number;
  /** Chegada como texto do jogo ("hoje às 01:11:07:212"). */
  arrivesAtText: string;
  /** "Chega em" como texto do jogo ("1:08:03"). */
  arrivesInText: string;
}

const TAG_STRIP = /<[^>]+>/g;

function text(value: string): string {
  return value.replace(TAG_STRIP, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

/** "(612|606)" dentro do nome da aldeia. */
function coordOf(villageText: string): string {
  const match = /(\d{1,3}\|\d{1,3})/.exec(villageText);
  return match?.[1] ?? '';
}

/**
 * Extrai todas as linhas de comando de uma página. Retorna vazio quando a
 * página não tem o widget (não é erro — aldeia sem comandos compartilhados).
 */
export function parseIncomingCommandRows(html: string): IncomingCommandRow[] {
  const rows: IncomingCommandRow[] = [];
  for (const rowMatch of html.matchAll(/<tr[^>]*row_[ab][^>]*>([\s\S]*?)<\/tr>/g)) {
    const row = rowMatch[1] ?? '';
    const idMatch = /command_ids\[(\d+)\]/.exec(row);
    if (idMatch === null) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1] ?? '');
    if (cells.length < 7) continue;
    const type = /data-command-type="(\w+)"/.exec(row)?.[1] ?? 'unknown';
    const hints = [...row.matchAll(/data-icon-hint="([^"]*)"/g)].map((m) => m[1] ?? '');
    const hasNoble = hints.some((hint) => /com nobre/i.test(hint));
    const sizeMatch = /ataque (pequeno|m[eé]dio|grande)/i.exec(hints.join(' | '));
    const sizeHint = sizeMatch === null ? null : (sizeMatch[1]?.toLowerCase() as 'pequeno' | 'médio' | 'grande');
    rows.push({
      commandId: Number(idMatch[1]),
      name: text(cells[0] ?? ''),
      type,
      hints,
      hasNoble,
      sizeHint,
      destination: { name: text(cells[1] ?? '').replace(/\s*\(\d{1,3}\|\d{1,3}\).*/, ''), coord: coordOf(text(cells[1] ?? '')) },
      origin: { name: text(cells[2] ?? '').replace(/\s*\(\d{1,3}\|\d{1,3}\).*/, ''), coord: coordOf(text(cells[2] ?? '')) },
      playerName: text(cells[3] ?? ''),
      fieldsDistance: Number((text(cells[4] ?? '').replace(',', '.') || '0')),
      arrivesAtText: text(cells[5] ?? ''),
      arrivesInText: text(cells[6] ?? ''),
    });
  }
  return rows;
}

/**
 * Totalizador de participação (SG_5b): contagens por jogador sobre as linhas
 * de comando — ataques vs suportes/fakes por volume.
 */
export interface PlayerCommandTotal {
  playerName: string;
  attacks: number;
  supports: number;
  total: number;
  /** Ataques pequenos sem nobre = fakes (classificação da ferramenta original). */
  fakes: number;
  /** Ataques grandes (hint "Ataque grande"). */
  largeAttacks: number;
  /** Ataques com nobre. */
  nobleAttacks: number;
}

export function totalsByPlayer(rows: IncomingCommandRow[]): PlayerCommandTotal[] {
  const map = new Map<string, PlayerCommandTotal>();
  for (const row of rows) {
    const entry = map.get(row.playerName) ?? { playerName: row.playerName, attacks: 0, supports: 0, total: 0, fakes: 0, largeAttacks: 0, nobleAttacks: 0 };
    if (row.type === 'attack') {
      entry.attacks += 1;
      if (row.sizeHint === 'pequeno' && !row.hasNoble) entry.fakes += 1;
      if (row.sizeHint === 'grande') entry.largeAttacks += 1;
      if (row.hasNoble) entry.nobleAttacks += 1;
    } else {
      entry.supports += 1;
    }
    entry.total += 1;
    map.set(row.playerName, entry);
  }
  return [...map.values()].sort((a, b) => b.total - a.total || a.playerName.localeCompare(b.playerName, 'pt-BR'));
}

// ---------------------------------------------------------------------------
// Visão de unidades da PRÓPRIA conta (screen=overview_villages&mode=units):
// quando o player_id da tela de tribo é o da conta logada, o jogo ignora o
// parâmetro e devolve o resumo por jogador — as tropas por aldeia da própria
// conta vêm desta tabela (id=units_table), com 5 sub-linhas por aldeia:
// "suas próprias" | "Na Aldeia" | "fora" | "em trânsito" | "total".
// ---------------------------------------------------------------------------

export interface OwnUnitsVillage {
  villageId: number;
  name: string;
  coord: { x: number; y: number };
  /** Tropas pertencentes (SG_2), onde estiverem. */
  own: UnitCounts;
  /** Tropas fisicamente na aldeia (SG_3). */
  inVillage: UnitCounts;
  /** Tropas em trânsito (SG_3, "a caminho"). */
  inTransit: UnitCounts;
}

function parseUnitCells(cells: readonly string[], order: readonly string[]): UnitCounts {
  const units: UnitCounts = {};
  order.forEach((unit, index) => {
    const cell = cells[index];
    if (cell === undefined) throw new ParseError(`célula da unidade ${unit} ausente`);
    const value = cell.replace(TAG_STRIP, '').replace(/\s+/g, '');
    units[unit as keyof UnitCounts] = value === '?' ? 0 : (parseIntHtmlSafe(value) ?? 0);
  });
  return units;
}

function parseIntHtmlSafe(value: string): number | null {
  if (!/^\d[\d.]*$/.test(value)) return null;
  return Number(value.replace(/\./g, ''));
}

/** Página é o resumo por jogador (jogo ignorou o player_id = conta logada)? */
export function isMemberSummaryPage(html: string): boolean {
  return /mode=members_troops&order=player/.test(html);
}

export function parseOwnUnitsTable(html: string): { villages: OwnUnitsVillage[] } {
  const start = html.indexOf('<table id="units_table"');
  if (start === -1) throw new ParseError('Tabela de unidades da própria conta (units_table) não encontrada.');
  const end = html.indexOf('</table>', start);
  const table = html.slice(start, end);
  const unitOrder = [...table.matchAll(/unit_(\w+)\.webp/g)].map((m) => UNIT_ALIAS[m[1] ?? ''] ?? (m[1] as string));
  const uniqueOrder = [...new Set(unitOrder)];
  if (uniqueOrder.length < 10) throw new ParseError('Cabeçalho de unidades não reconhecido na tabela própria.');

  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1] ?? '');
  const villages: OwnUnitsVillage[] = [];
  let current: OwnUnitsVillage | null = null;
  for (const row of rows) {
    const villageMatch = /quickedit-vn[^>]*data-id="(\d+)"[\s\S]*?quickedit-label[^>]*>([^<]*)</.exec(row);
    if (villageMatch !== null) {
      const name = villageMatch[2] ?? '';
      const coord = /\((\d{1,3})\|(\d{1,3})\)/.exec(name);
      current = {
        villageId: Number(villageMatch[1]),
        name: name.replace(/\s*\(\d{1,3}\|\d{1,3}\).*/, '').trim(),
        coord: { x: Number(coord?.[1] ?? 0), y: Number(coord?.[2] ?? 0) },
        own: {}, inVillage: {}, inTransit: {},
      };
      villages.push(current);
    }
    if (current === null) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1] ?? '');
    // Rótulo por POSIÇÃO: linha da aldeia = [aldeia, rótulo, unidades…];
    // sub-linhas = [rótulo, unidades…]. (Nome de aldeia pode conter "fora"/"em tr".)
    const labelIndex = villageMatch !== null ? 1 : 0;
    const labelCell = cells[labelIndex];
    if (labelCell === undefined) continue;
    const label = labelCell.replace(TAG_STRIP, '').trim();
    const unitCells = cells.slice(labelIndex + 1);
    // "em tr" (sem o â) é à prova de mojibake na leitura latin1 do fixture.
    if (/suas pr/i.test(label)) current.own = parseUnitCells(unitCells, uniqueOrder);
    else if (/na aldeia/i.test(label)) current.inVillage = parseUnitCells(unitCells, uniqueOrder);
    else if (/em tr/i.test(label)) current.inTransit = parseUnitCells(unitCells, uniqueOrder);
  }
  if (villages.length === 0) throw new ParseError('Tabela própria sem aldeias.');
  return { villages };
}

const UNIT_ALIAS: Record<string, string> = {
  spear: 'spear', sword: 'sword', axe: 'axe', archer: 'archer', spy: 'spy',
  light: 'light', marcher: 'marcher', heavy: 'heavy', ram: 'ram',
  catapult: 'catapult', knight: 'knight', snob: 'snob', militia: 'militia',
};
