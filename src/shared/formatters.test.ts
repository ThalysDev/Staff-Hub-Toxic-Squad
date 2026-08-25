import { describe, expect, it } from 'vitest';
import { bbcodeTable, parsePlayerSummary, playerSummary } from './formatters';

describe('playerSummary / parsePlayerSummary', () => {
  const coords = [
    { x: 1, y: 2 },
    { x: 3, y: 4 },
  ];

  it('formata "nick;count;coord coord"', () => {
    expect(playerSummary('gandalf', 3, coords)).toBe('gandalf;3;1|2 3|4');
    expect(playerSummary('gandalf', 0, [])).toBe('gandalf;0;');
  });

  it('faz round-trip', () => {
    expect(parsePlayerSummary(playerSummary('gandalf', 3, coords))).toEqual({
      player: 'gandalf',
      count: 3,
      coords,
    });
  });

  it('tolera espaços extras', () => {
    expect(parsePlayerSummary('  gandalf ;  3 ;  1|2 , 3|4  ')).toEqual({
      player: 'gandalf',
      count: 3,
      coords,
    });
  });

  it('rejeita linhas malformadas', () => {
    expect(parsePlayerSummary('')).toBeNull();
    expect(parsePlayerSummary('abc')).toBeNull();
    expect(parsePlayerSummary(';3;1|2')).toBeNull();
    expect(parsePlayerSummary('a;x;1|2')).toBeNull();
    expect(parsePlayerSummary('a;-1;1|2')).toBeNull();
    expect(parsePlayerSummary('a;3')).toBeNull();
  });
});

describe('bbcodeTable', () => {
  it('gera tabela no formato clássico do fórum TW BR', () => {
    expect(bbcodeTable(['H1', 'H2'], [['a', 'b'], ['c', 'd']])).toBe(
      '[table]\n[**]H1[||]H2[/**]\n[**]a[|]b[/**]\n[**]c[|]d[/**]\n[/table]'
    );
  });

  it('suporta uma coluna e zero linhas', () => {
    expect(bbcodeTable(['U'], [['x']])).toBe('[table]\n[**]U[/**]\n[**]x[/**]\n[/table]');
    expect(bbcodeTable(['H'], [])).toBe('[table]\n[**]H[/**]\n[/table]');
  });
});