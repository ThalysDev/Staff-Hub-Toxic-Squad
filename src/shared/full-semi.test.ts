import { describe, expect, it } from 'vitest';
import { formatFullSemi, fullSemiByPlayer, type FullSemiEntry } from './full-semi';

/** População por unidade FICTÍCIA do teste (no app real vem do unit-info do mundo). */
const POP = { axe: 40, light: 80 };

const BASE = { fullPop: 2000, semiPop: 1000, popByUnit: POP };

function entry(playerName: string, x: number, y: number, units: Record<string, number>): FullSemiEntry {
  return { playerName, coord: { x, y }, units };
}

describe('fullSemiByPlayer', () => {
  const entries: FullSemiEntry[] = [
    entry('ana', 500, 500, { axe: 50 }), // 2000 = fullPop exato → FULL
    entry('ana', 501, 501, { axe: 30 }), // 1200 entre os limiares → SEMI
    entry('bia', 600, 600, { light: 25 }), // 2000 → FULL
    entry('bia', 601, 601, { axe: 24 }), // 960 abaixo de ambos → não conta
    entry('carlos', 700, 700, { axe: 25 }), // 1000 = semiPop exato → SEMI
    entry('bia', 602, 602, { axe: 20, light: 15 }), // 800+1200=2000 → FULL
  ];

  it('classifica nos limiares: exatamente em fullPop é FULL; em semiPop é SEMI', () => {
    const { players } = fullSemiByPlayer({ ...BASE, entries });
    expect(players.find((p) => p.playerName === 'ana')).toMatchObject({ fulls: 1, semis: 1 });
    // carlos: 25×40 = 1000 = semiPop exato → semi
    expect(players.find((p) => p.playerName === 'carlos')?.semis).toBe(1);
  });

  it('abaixo dos dois limiares não aparece (nem na conta nem nas coordenadas)', () => {
    const { players } = fullSemiByPlayer({ ...BASE, entries });
    const bia = players.find((p) => p.playerName === 'bia');
    expect(bia?.fulls).toBe(2);
    expect(bia?.semis).toBe(0);
    expect(bia?.coords).toEqual(['600|600', '602|602']); // a de 960 ficou fora
  });

  it('coordenadas vêm FULLS primeiro, depois SEMIS', () => {
    const { players } = fullSemiByPlayer({ ...BASE, entries });
    // ana: 1 full (500|500) e 1 semi (501|501) → na coordenada, full antes da semi
    const ana = players.find((p) => p.playerName === 'ana');
    expect(ana?.coords).toEqual(['500|500', '501|501']);
    // Ordenação geral: bia (2 fulls) vem antes de ana (1 full)
    expect(players.map((p) => p.playerName)).toEqual(['bia', 'ana', 'carlos']);
  });

  it('ordena por fulls desc, semis desc, nick', () => {
    const tied: FullSemiEntry[] = [
      // mira: 2 fulls → primeira
      entry('mira', 300, 300, { light: 25 }),
      entry('mira', 301, 301, { axe: 50 }),
      // empate em 1 full: dani tem 1 semi → vem antes dos de 0 semis; alba/rafa/zeca desempatam pelo nick
      entry('dani', 400, 400, { axe: 50 }),
      entry('dani', 401, 401, { axe: 30 }), // 1200 → semi
      entry('zeca', 100, 100, { axe: 50 }),
      entry('rafa', 500, 500, { light: 25 }),
      entry('alba', 200, 200, { axe: 50 }),
    ];
    const { players } = fullSemiByPlayer({ ...BASE, entries: tied });
    expect(players.map((p) => p.playerName)).toEqual(['mira', 'dani', 'alba', 'rafa', 'zeca']);
  });

  it('unidade ausente no popByUnit conta 0 e é reportada em unknownUnits', () => {
    const result = fullSemiByPlayer({
      ...BASE,
      entries: [entry('duda', 800, 800, { axe: 50, paladin: 9 })], // 2000 + desconhecida
    });
    expect(result.players[0]?.fulls).toBe(1); // paladin ignorado, mas axa chega no limiar
    expect(result.unknownUnits).toEqual(['paladin']);
  });

  it('validação fail-closed: fullPop/semiPop inválidos e semiPop ≥ fullPop lançam PT-BR', () => {
    expect(() => fullSemiByPlayer({ ...BASE, entries: [], fullPop: 0 })).toThrow(/FULL inválida/i);
    expect(() => fullSemiByPlayer({ ...BASE, entries: [], fullPop: -5 })).toThrow(/FULL inválida/i);
    expect(() => fullSemiByPlayer({ ...BASE, entries: [], semiPop: 0 })).toThrow(/SEMI inválida/i);
    expect(() => fullSemiByPlayer({ ...BASE, entries: [], semiPop: 2000 })).toThrow(/MENOR/i);
    expect(() => fullSemiByPlayer({ ...BASE, entries: [], semiPop: 3000 })).toThrow(/MENOR/i);
  });
});

describe('formatFullSemi', () => {
  it('gera linhas "nick;fulls;semis;coords" com coordenadas separadas por espaço', () => {
    const { players } = fullSemiByPlayer({
      ...BASE,
      entries: [entry('ana', 500, 500, { axe: 50 }), entry('ana', 501, 501, { axe: 30 })],
    });
    expect(formatFullSemi(players)).toBe('ana;1;1;500|500 501|501');
  });

  it('lista vazia gera string vazia (nada reconhecido)', () => {
    expect(formatFullSemi([])).toBe('');
  });
});
