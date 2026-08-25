import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseIncomingCommandRows, totalsByPlayer } from './village-parsers';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL('../../../tests/fixtures/br142/${name}'.replace('${name}', name), import.meta.url)), 'latin1');
}

describe('parseIncomingCommandRows (fixture real: 701 comandos)', () => {
  it('extrai todas as linhas com id/tipo/origem/destino/jogador', () => {
    const rows = parseIncomingCommandRows(fixture('incomings-own.html'));
    expect(rows).toHaveLength(701);
    const first = rows[0]!;
    expect(first.commandId).toBe(874042204);
    expect(first.type).toBe('support');
    expect(first.name).toBe('Suporte');
    expect(first.destination.coord).toBe('612|606');
    expect(first.origin.coord).toBe('533|550');
    expect(first.playerName).toBe('R O D R I G U E S');
    expect(first.fieldsDistance).toBeCloseTo(96.8, 1);
    expect(first.arrivesAtText).toContain('hoje');
    expect(first.arrivesInText).toBe('1:08:03');
  });

  it('contém a linha de ataque real entre os suportes (2 marcadores attack = ícone+hover da mesma linha)', () => {
    const rows = parseIncomingCommandRows(fixture('incomings-own.html'));
    const attacks = rows.filter((r) => r.type === 'attack');
    expect(attacks).toHaveLength(1);
    expect(rows.filter((r) => r.type === 'support')).toHaveLength(700);
  });

  it('página sem o widget devolve vazio (não é erro)', () => {
    expect(parseIncomingCommandRows('<html>outra tela</html>')).toEqual([]);
  });
});

describe('totalsByPlayer', () => {
  it('agrega ataques/suportes/total por jogador ordenado por total', () => {
    const rows = parseIncomingCommandRows(fixture('incomings-own.html'));
    const totals = totalsByPlayer(rows);
    expect(totals[0]?.playerName).toBe('R O D R I G U E S');
    expect(totals[0]?.total).toBe(701);
    expect(totals.reduce((sum, t) => sum + t.attacks, 0)).toBe(1);
  });
});
