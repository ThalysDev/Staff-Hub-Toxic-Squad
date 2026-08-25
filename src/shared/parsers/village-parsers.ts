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
    rows.push({
      commandId: Number(idMatch[1]),
      name: text(cells[0] ?? ''),
      type,
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
}

export function totalsByPlayer(rows: IncomingCommandRow[]): PlayerCommandTotal[] {
  const map = new Map<string, PlayerCommandTotal>();
  for (const row of rows) {
    const entry = map.get(row.playerName) ?? { playerName: row.playerName, attacks: 0, supports: 0, total: 0 };
    if (row.type === 'attack') entry.attacks += 1;
    else entry.supports += 1;
    entry.total += 1;
    map.set(row.playerName, entry);
  }
  return [...map.values()].sort((a, b) => b.total - a.total || a.playerName.localeCompare(b.playerName, 'pt-BR'));
}
