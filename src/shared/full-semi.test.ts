import { describe, expect, it } from 'vitest';
import {
  formatFullSemi,
  formatFullSemiRows,
  formatOriginsRows,
  formatTargetsRows,
  fullSemiByPlayer,
  fullSemiReport,
  type FullSemiEntry,
  type FullSemiReportOptions,
  type FullSemiSortBy,
} from './full-semi';

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

describe('fullSemiReport — estrutura do relatório', () => {
  const OPT = { fullPop: 2000, semiPop: 1000 };

  /** Snapshot-base: cada aldeia comentada com pop resultante e continente. */
  const SNAP: FullSemiEntry[] = [
    entry('ana', 500, 500, { axe: 50 }), // 2000 FULL K55
    entry('ana', 501, 501, { axe: 30 }), // 1200 SEMI K55
    entry('bia', 600, 600, { light: 25 }), // 2000 FULL K66
    entry('bia', 602, 602, { light: 25 }), // 2000 FULL K66
    entry('carlos', 700, 700, { axe: 25 }), // 1000 SEMI K77
    entry('carlos', 701, 701, { axe: 10 }), // 400 → abaixo dos limiares, ignorada
  ];

  function report(entries: FullSemiEntry[], extra: Omit<FullSemiReportOptions, 'fullPop' | 'semiPop'> = {}): ReturnType<typeof fullSemiReport> {
    return fullSemiReport({ entries, popByUnit: POP }, { ...OPT, ...extra });
  }

  it('relata cada aldeia com k/pop/tier; FULLS primeiro, depois SEMIS, ordem do snapshot preservada', () => {
    const { players } = report(SNAP);
    expect(players.map((p) => p.playerName)).toEqual(['bia', 'ana', 'carlos']);
    expect(players[2]?.villages).toEqual([{ coord: '700|700', k: 77, pop: 1000, tier: 'semi' }]);
    expect(players[1]?.villages).toEqual([
      { coord: '500|500', k: 55, pop: 2000, tier: 'full' },
      { coord: '501|501', k: 55, pop: 1200, tier: 'semi' },
    ]);
    // a aldeia de 400 (abaixo dos limiares) não existe no relatório
    expect(players[0]?.villages).toHaveLength(2);
  });

  it('unitIds restringe a soma: aldeia cujas unidades ficaram fora da lista nem entra no relatório', () => {
    const { players, totals } = report(SNAP, { unitIds: ['axe'] });
    // bia só tinha light (2000 por light, mas fora da soma → aldeias dela viram 0 e somem)
    expect(players.map((p) => p.playerName)).toEqual(['ana', 'carlos']);
    // seguem: full de ana, semi de ana e semi de carlos (todas só com axe contabilizado)
    expect(totals).toMatchObject({ players: 2, fulls: 1, semis: 2, villages: 3 });
    // aldeia mista: SÓ o axe conta na população
    const { players: duo } = report([entry('duo', 800, 800, { axe: 50, light: 10 })], { unitIds: ['axe'] });
    expect(duo[0]).toMatchObject({ fulls: 1, semis: 0 }); // 2000 do axe; os 800 de light fora
  });

  it('unitIds ausente OU vazio = TODAS as unidades do snapshot contam', () => {
    const mixed = [entry('duo', 800, 800, { axe: 20, light: 20 })]; // 800+1600 = 2400
    expect(report(mixed, { unitIds: [] }).players[0]).toMatchObject({ fulls: 1, semis: 0 });
    expect(report(mixed).players[0]).toMatchObject({ fulls: 1, semis: 0 });
  });

  it('unknownUnits: unidades com contagem > 0 fora do popByUnit são reportadas mesmo FORA de unitIds; contagem 0 não é reportada', () => {
    const es: FullSemiEntry[] = [
      entry('duo', 800, 800, { axe: 50, paladin: 9, ram: 0 }),
      entry('bia', 600, 600, { light: 25, scout: 3 }),
    ];
    const { unknownUnits, players } = report(es, { unitIds: ['axe'] });
    expect(unknownUnits).toEqual(['paladin', 'scout']); // independe de unitIds; ordenado pt-BR
    expect(players.map((p) => p.playerName)).toEqual(['duo']); // aldeia da bia ficou sem unidades na soma
    expect(players[0]?.fulls).toBe(1); // paladin vale 0, mas o axe chega no limiar
  });

  it('kFilter incluir: só entram aldeias dos continentes listados', () => {
    const { players, totals } = report(SNAP, { kFilter: { ks: [66], mode: 'incluir' } });
    expect(players.map((p) => p.playerName)).toEqual(['bia']);
    expect(totals).toMatchObject({ players: 1, fulls: 2, semis: 0, villages: 2 });
  });

  it('kFilter excluir: remove APENAS as aldeias dos continentes listados', () => {
    const { players, totals } = report(SNAP, { kFilter: { ks: [66], mode: 'excluir' } });
    expect(players.map((p) => p.playerName)).toEqual(['ana', 'carlos']);
    expect(totals).toMatchObject({ players: 2, fulls: 1, semis: 2, villages: 3 });
  });

  it('kFilter incluir com ks vazio = 0 aldeias (fail-closed, igual Sg2Filters)', () => {
    const { players, totals } = report(SNAP, { kFilter: { ks: [], mode: 'incluir' } });
    expect(players).toEqual([]);
    expect(totals.players).toBe(0);
  });

  it('kFilter com K fora de 0-99 lança PT-BR', () => {
    expect(() => report(SNAP, { kFilter: { ks: [55, 120], mode: 'incluir' } })).toThrow(/Continente\(s\) inválido\(s\)/i);
    expect(() => report(SNAP, { kFilter: { ks: [-1], mode: 'excluir' } })).toThrow(/Continente\(s\) inválido\(s\)/i);
  });

  it('playerFilter incluir: só nicks exatos (case-sensitive); lista vazia = ninguém', () => {
    const { players } = report(SNAP, { playerFilter: { names: ['ana'], mode: 'incluir' } });
    expect(players.map((p) => p.playerName)).toEqual(['ana']);
    const { players: none, totals } = report(SNAP, { playerFilter: { names: [], mode: 'incluir' } });
    expect(none).toEqual([]);
    expect(totals).toMatchObject({ players: 0, fulls: 0, semis: 0, villages: 0 });
    const { players: cs } = report(SNAP, { playerFilter: { names: ['ANA'], mode: 'incluir' } });
    expect(cs).toEqual([]); // sem fold de maiúsculas/minúsculas
  });

  it('playerFilter excluir: todos menos os nicks listados', () => {
    const { players, totals } = report(SNAP, { playerFilter: { names: ['ana'], mode: 'excluir' } });
    expect(players.map((p) => p.playerName)).toEqual(['bia', 'carlos']);
    expect(totals.players).toBe(2);
  });

  it('minFulls oculta jogadores com menos que N fulls — do relatório E dos totals', () => {
    const { players, totals } = report(SNAP, { minFulls: 2 });
    expect(players.map((p) => p.playerName)).toEqual(['bia']);
    expect(totals).toMatchObject({ players: 1, fulls: 2, semis: 0, villages: 2 });
  });

  it('minSemis oculta jogadores com menos que N semis', () => {
    const { players, totals } = report(SNAP, { minSemis: 1 });
    expect(players.map((p) => p.playerName)).toEqual(['ana', 'carlos']);
    expect(totals).toMatchObject({ players: 2, fulls: 1, semis: 2, villages: 3 });
  });

  it('byK agrega por continente ordenado por k crescente, só com Ks que têm aldeia', () => {
    const es: FullSemiEntry[] = [
      entry('dora', 300, 300, { axe: 50 }), // FULL K33
      entry('dora', 305, 302, { axe: 30 }), // SEMI K33
      entry('dora', 150, 250, { axe: 50 }), // FULL K21
      entry('dora', 935, 180, { axe: 30 }), // SEMI K19
      entry('dora', 938, 183, { light: 25 }), // FULL K19
    ];
    const { players } = report(es);
    expect(players[0]?.byK).toEqual([
      { k: 19, fulls: 1, semis: 1 },
      { k: 21, fulls: 1, semis: 0 },
      { k: 33, fulls: 1, semis: 1 },
    ]);
  });

  it('totals batem com o array visível: villages = full+semi das aldeias CONTABILIZADAS', () => {
    const { players, totals } = report(SNAP);
    expect(totals).toEqual({
      players: 3,
      fulls: players.reduce((sum, p) => sum + p.fulls, 0),
      semis: players.reduce((sum, p) => sum + p.semis, 0),
      villages: players.reduce((sum, p) => sum + p.villages.length, 0),
    });
    expect(totals).toMatchObject({ players: 3, fulls: 3, semis: 2, villages: 5 }); // a de 400 não existe pro relatório
  });

  it('validação fail-closed reaproveitada: limiares inválidos lançam as mesmas mensagens PT-BR', () => {
    expect(() => fullSemiReport({ entries: [], popByUnit: POP }, { ...OPT, fullPop: 0 })).toThrow(/FULL inválida/i);
    expect(() => fullSemiReport({ entries: [], popByUnit: POP }, { ...OPT, semiPop: -5 })).toThrow(/SEMI inválida/i);
    expect(() => fullSemiReport({ entries: [], popByUnit: POP }, { ...OPT, semiPop: 3000 })).toThrow(/MENOR/i);
  });

  it('sortBy inválido lança (fail-closed)', () => {
    expect(() =>
      fullSemiReport({ entries: [], popByUnit: POP }, { ...OPT, sortBy: 'aleatorio' as FullSemiSortBy }),
    ).toThrow(/Ordenação inválida/i);
  });
});

describe('fullSemiReport — sortBy', () => {
  const OPT = { fullPop: 2000, semiPop: 1000 };

  function report(entries: FullSemiEntry[], sortBy?: FullSemiSortBy): ReturnType<typeof fullSemiReport> {
    return fullSemiReport(
      { entries, popByUnit: POP },
      sortBy === undefined ? { ...OPT } : { ...OPT, sortBy },
    );
  }

  const ES: FullSemiEntry[] = [
    entry('rita', 100, 100, { axe: 40 }), // 1600 SEMI
    entry('rita', 101, 101, { axe: 30 }), // SEMI
    entry('rita', 102, 102, { axe: 26 }), // SEMI (1040)
    entry('lisa', 500, 500, { axe: 50 }), // FULL
    entry('lisa', 501, 501, { axe: 30 }), // SEMI
    entry('bruno', 600, 600, { axe: 30 }), // SEMI
    entry('tonho', 700, 700, { axe: 50 }), // FULL
  ];

  it("sortBy 'fulls' (default): mesma ordenação do contador antigo (fulls desc, empate por semis)", () => {
    const defaultOrder = report(ES).players.map((p) => p.playerName);
    // lisa (1 full + 1 semi) desempata sobre tonho (1 full, 0 semis); depois rita (3 semis) e bruno (1 semi)
    expect(defaultOrder).toEqual(['lisa', 'tonho', 'rita', 'bruno']);
    expect(report(ES, 'fulls').players.map((p) => p.playerName)).toEqual(defaultOrder);
  });

  it("sortBy 'semis': mais semis primeiro; empate por fulls desc depois nick", () => {
    // lisa (1 semi + 1 full) vem antes de bruno (1 semi, 0 fulls); tonho (0 semis) cai pro fim
    expect(report(ES, 'semis').players.map((p) => p.playerName)).toEqual(['rita', 'lisa', 'bruno', 'tonho']);
  });

  it("sortBy 'total': fulls+semis decide, empate vai pro nick", () => {
    const es: FullSemiEntry[] = [
      entry('zeca', 100, 100, { axe: 30 }),
      entry('zeca', 101, 101, { axe: 30 }), // 2 semis → total 2
      entry('caio', 200, 200, { axe: 30 }),
      entry('caio', 201, 201, { axe: 26 }), // 2 semis → total 2
      entry('bia', 300, 300, { axe: 50 }), // total 1
    ];
    expect(report(es, 'total').players.map((p) => p.playerName)).toEqual(['caio', 'zeca', 'bia']);
  });

  it("sortBy 'nick': ordem alfabética PT-BR", () => {
    const es: FullSemiEntry[] = [
      entry('zeca', 100, 100, { axe: 50 }),
      entry('bernardo', 200, 200, { axe: 30 }),
      entry('alba', 300, 300, { axe: 25 }),
    ];
    expect(report(es, 'nick').players.map((p) => p.playerName)).toEqual(['alba', 'bernardo', 'zeca']);
  });
});

describe('formatters do relatório', () => {
  const ENTRIES: FullSemiEntry[] = [
    entry('ana', 500, 500, { axe: 50 }), // FULL
    entry('ana', 501, 501, { axe: 30 }), // SEMI
    entry('bia', 600, 600, { light: 25 }), // FULL
    entry('carlos', 700, 700, { axe: 25 }), // SEMI
  ];

  const repPlayers = (): ReturnType<typeof fullSemiReport>['players'] =>
    fullSemiReport({ entries: ENTRIES, popByUnit: POP }, { fullPop: 2000, semiPop: 1000 }).players;

  it('formatFullSemiRows tem EXATAMENTE a mesma saída do formatFullSemi antigo', () => {
    const oldResult = fullSemiByPlayer({ entries: ENTRIES, fullPop: 2000, semiPop: 1000, popByUnit: POP });
    expect(formatFullSemiRows(repPlayers())).toBe(formatFullSemi(oldResult.players));
    expect(formatFullSemiRows(repPlayers())).toBe('ana;1;1;500|500 501|501\nbia;1;0;600|600\ncarlos;0;1;700|700');
  });

  it('formatOriginsRows usa SÓ as aldeias FULL e OMITTE jogador sem full (linha nick;0; quebraria o parser do SG_4)', () => {
    expect(formatOriginsRows(repPlayers())).toBe('ana;1;500|500\nbia;1;600|600');
    expect(formatOriginsRows([])).toBe('');
  });

  it("formatTargetsRows filtra por tier e 'ambos' junta fulls+semis (nessa ordem)", () => {
    const players = repPlayers();
    expect(formatTargetsRows(players, 'full')).toBe('500|500\n600|600\n'); // carlos não tem full → linha vazia
    expect(formatTargetsRows(players, 'semi')).toBe('501|501\n\n700|700');
    expect(formatTargetsRows(players, 'ambos')).toBe('500|500 501|501\n600|600\n700|700');
  });
});
