import { describe, expect, it } from 'vitest';
import { originsFromSnapshot } from './origins-from-snapshot';
import type { TroopEntry, TroopSnapshot } from './sg2-engine';
import { parseOriginsInput } from './sg4-engine';

function village(playerId: number, playerName: string, x: number, y: number, units: TroopEntry['units']): TroopEntry {
  return { playerId, playerName, coord: { x, y }, villageName: `Aldeia ${x}|${y}`, units };
}

/** Snapshot coerente com a coleta POR MEMBRO do SG_2: 2 jogadores, aldeias com e sem snob. */
const SNAPSHOT: TroopSnapshot = {
  kind: 'troops',
  source: 'per-member',
  collectedAt: '2026-08-26T12:00:00.000Z',
  entries: [
    // Alice: 2 aldeias "full" (com nobre) + 1 sem snob (não vira origem).
    village(1, 'Alice', 500, 500, { axe: 6000, snob: 1 }),
    village(1, 'Alice', 501, 500, { axe: 6000, snob: 3 }),
    village(1, 'Alice', 502, 500, { spear: 9000 }),
    // Bruno: só aldeias SEM snob → fica fora das INFORMAÇÕES ORIGEM.
    village(2, 'Bruno', 400, 400, { sword: 8000 }),
    village(2, 'Bruno', 401, 400, { axe: 6000 }),
  ],
};

describe('originsFromSnapshot', () => {
  it('gera linhas "nick;fulls;coords" no formato do SG_4', () => {
    const text = originsFromSnapshot(SNAPSHOT);
    const lines = text.split('\n');
    // Formato do parseOriginsInput: nick;fulls;coords separadas por espaço.
    const lineFormat = /^([^;\n]{2,40});\d+;\d{1,3}\|\d{1,3}(?: \d{1,3}\|\d{1,3})*$/;
    for (const line of lines) expect(line).toMatch(lineFormat);
    expect(lines).toEqual(['Alice;2;500|500 501|500']);
  });

  it('é redondo: parseOriginsInput recupera nick/fulls/coords', () => {
    const players = parseOriginsInput(originsFromSnapshot(SNAPSHOT));
    expect(players).toEqual([
      { playerName: 'Alice', fulls: 2, origins: [{ x: 500, y: 500 }, { x: 501, y: 500 }] },
    ]);
  });

  it('minSnobs=2 exclui a aldeia com apenas 1 snob', () => {
    const text = originsFromSnapshot(SNAPSHOT, { minSnobs: 2 });
    expect(text).toBe('Alice;1;501|500');
    const players = parseOriginsInput(text);
    expect(players[0]?.origins).toEqual([{ x: 501, y: 500 }]);
  });

  it('snapshot vazio gera texto vazio', () => {
    const empty: TroopSnapshot = { kind: 'troops', source: 'per-member', collectedAt: '', entries: [] };
    expect(originsFromSnapshot(empty)).toBe('');
  });
});
