// Formatação de texto de saída (resumos de jogador e tabelas para o fórum).

import { formatCoord, parseCoordList, type Coord } from './coords';

export function playerSummary(player: string, count: number, coords: Coord[]): string {
  return `${player};${count};${coords.map(formatCoord).join(' ')}`;
}

export interface PlayerSummary {
  player: string;
  count: number;
  coords: Coord[];
}

export function parsePlayerSummary(line: string): PlayerSummary | null {
  const parts = line.split(';');
  const player = parts[0]?.trim();
  const countText = parts[1]?.trim();
  const coordsText = parts[2]?.trim();
  if (player === undefined || player === '' || countText === undefined || coordsText === undefined) {
    return null;
  }
  const count = Number(countText);
  if (!Number.isInteger(count) || count < 0) return null;
  return { player, count, coords: parseCoordList(coordsText) };
}

// Formato clássico de tabela do fórum TW BR: [table] + linha de cabeçalho com [||]
// + linhas de dados com [|]. O formato exato será validado contra fixtures reais
// do fórum na fase de capturas.
export function bbcodeTable(headers: string[], rows: string[][]): string {
  const headerLine = `[**]${headers.join('[||]')}[/**]`;
  const bodyLines = rows.map((row) => `[**]${row.join('[|]')}[/**]`);
  return `[table]\n${[headerLine, ...bodyLines].join('\n')}\n[/table]`;
}