import { describe, expect, it } from 'vitest';
import {
  MAX_WORLD_HISTORY,
  capWorldHistory,
  computeOwnerChanges,
  computeWorldAggregates,
  diffWorldVersions,
  newWorldVersionId,
  type WorldHistoryVersion,
  type WorldTribeAggregate,
} from './world-history';

const village = (x: number, y: number, allyId: number) => ({ x, y, allyId });

const tribe = (allyId: number, tag: string, villages: number, points: number): WorldTribeAggregate => ({
  allyId,
  tag,
  villages,
  points,
});

const makeVersion = (tribes: WorldTribeAggregate[]): WorldHistoryVersion => ({
  id: newWorldVersionId(),
  collectedAt: new Date().toISOString(),
  world: 'br128',
  tribes,
  changesSincePrevious: [],
});

describe('computeWorldAggregates', () => {
  it('descarta aldeias bárbaras e sem tribo (allyId 0)', () => {
    const aggregates = computeWorldAggregates(
      [village(100, 100, 0), village(200, 200, 0), village(300, 300, 7)],
      [{ id: 7, tag: 'TOXIC', points: 1000 }],
    );
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]?.allyId).toBe(7);
  });

  it('soma a quantidade de aldeias por tribo e toma tag/pontos do ally.txt', () => {
    const aggregates = computeWorldAggregates(
      [village(1, 1, 7), village(2, 2, 7), village(3, 3, 9)],
      [
        { id: 7, tag: 'TOXIC', points: 42000 },
        { id: 9, tag: 'NOVA', points: 500 },
      ],
    );
    expect(aggregates).toEqual([
      { allyId: 7, tag: 'TOXIC', villages: 2, points: 42000 },
      { allyId: 9, tag: 'NOVA', villages: 1, points: 500 },
    ]);
  });

  it('ordena por aldeias desc (empate: pontos desc, depois tag asc)', () => {
    const aggregates = computeWorldAggregates(
      [
        village(1, 1, 1),
        village(2, 2, 1),
        village(3, 3, 1),
        village(4, 4, 1),
        village(5, 5, 1),
        village(6, 6, 2),
        village(7, 7, 2),
        village(8, 8, 2),
        village(9, 9, 3),
        village(10, 10, 3),
        village(11, 11, 3),
      ],
      [
        { id: 1, tag: 'LIDER', points: 100 },
        { id: 2, tag: 'ZZZ', points: 900 },
        { id: 3, tag: 'AAA', points: 900 },
      ],
    );
    // 5 aldeias lidera; 2/3 empatam em 3 aldeias e 900 pontos → tag 'AAA' < 'ZZZ'.
    expect(aggregates.map((a) => a.tag)).toEqual(['LIDER', 'AAA', 'ZZZ']);
  });

  it('allyId sem cadastro no ally.txt entra com tag "?" e pontos 0 (race entre dumps)', () => {
    const aggregates = computeWorldAggregates([village(1, 1, 999)], []);
    expect(aggregates).toEqual([{ allyId: 999, tag: '?', villages: 1, points: 0 }]);
  });

  it('sem aldeias de tribo devolve lista vazia', () => {
    expect(computeWorldAggregates([village(1, 1, 0)], [{ id: 7, tag: 'TOXIC', points: 10 }])).toEqual([]);
  });
});

describe('computeOwnerChanges', () => {
  it('detecta troca de dono entre tribos pela união das coordenadas', () => {
    const changes = computeOwnerChanges(
      [village(500, 500, 1), village(501, 501, 2)],
      [village(500, 500, 3), village(501, 501, 2)],
    );
    expect(changes).toEqual([{ coord: '500|500', fromAllyId: 1, toAllyId: 3 }]);
  });

  it('registra conquista de aldeia bárbara com fromAllyId 0', () => {
    const changes = computeOwnerChanges([village(10, 20, 0)], [village(10, 20, 7)]);
    expect(changes).toEqual([{ coord: '10|20', fromAllyId: 0, toAllyId: 7 }]);
  });

  it('registra abandono com toAllyId 0', () => {
    const changes = computeOwnerChanges([village(10, 20, 7)], [village(10, 20, 0)]);
    expect(changes).toEqual([{ coord: '10|20', fromAllyId: 7, toAllyId: 0 }]);
  });

  it('sem nenhuma troca de dono devolve lista vazia (bárbaras inclusive)', () => {
    const changes = computeOwnerChanges(
      [village(1, 1, 7), village(2, 2, 0)],
      [village(1, 1, 7), village(2, 2, 0)],
    );
    expect(changes).toEqual([]);
  });

  it('coord só em um dos dumps conta como allyId 0 no lado ausente', () => {
    const changes = computeOwnerChanges(
      [village(1, 1, 6)], // "sumiu" do dump atual → abandono implícito
      [village(2, 2, 5)], // aldeia nova já conquistada → conquista vinda de 0
    );
    expect(changes).toEqual([
      { coord: '1|1', fromAllyId: 6, toAllyId: 0 },
      { coord: '2|2', fromAllyId: 0, toAllyId: 5 },
    ]);
  });

  it('lança erro PT-BR com coordenada duplicada no array anterior', () => {
    expect(() =>
      computeOwnerChanges([village(5, 5, 1), village(5, 5, 2)], [village(6, 6, 1)]),
    ).toThrowError(/duplicada na lista anterior/);
  });

  it('lança erro PT-BR com coordenada duplicada no array atual', () => {
    expect(() =>
      computeOwnerChanges([village(6, 6, 1)], [village(5, 5, 2), village(5, 5, 3)]),
    ).toThrowError(/Aldeia "5\|5" duplicada na lista atual/);
  });

  it('a MESMA coordenada nos dois arrays é o caso normal (não lança)', () => {
    expect(() => computeOwnerChanges([village(5, 5, 1)], [village(5, 5, 2)])).not.toThrow();
  });
});

describe('diffWorldVersions', () => {
  it('une as tribos: tribo nova em B entra com villagesA 0 e delta positivo', () => {
    const a = makeVersion([tribe(1, 'VELHA', 10, 1000)]);
    const b = makeVersion([tribe(1, 'VELHA', 10, 1000), tribe(2, 'NOVA', 3, 300)]);
    const rows = diffWorldVersions(a, b);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.allyId === 2)).toMatchObject({
      tag: 'NOVA',
      villagesA: 0,
      villagesB: 3,
      villagesDelta: 3,
      pointsA: 0,
      pointsB: 300,
      pointsDelta: 300,
    });
  });

  it('tribo que saiu (só em A) fica com villagesB 0 e delta negativo', () => {
    const a = makeVersion([tribe(1, 'FANTASMA', 8, 800), tribe(2, 'FICA', 5, 500)]);
    const b = makeVersion([tribe(2, 'FICA', 5, 500)]);
    const row = diffWorldVersions(a, b).find((r) => r.allyId === 1);
    expect(row).toMatchObject({ tag: 'FANTASMA', villagesA: 8, villagesB: 0, villagesDelta: -8, pointsDelta: -800 });
  });

  it('calcula deltas B − A de aldeias e pontos', () => {
    const a = makeVersion([tribe(1, 'TOXIC', 40, 4000)]);
    const b = makeVersion([tribe(1, 'TOXIC', 45, 4600)]);
    expect(diffWorldVersions(a, b)[0]).toMatchObject({
      villagesA: 40,
      villagesB: 45,
      villagesDelta: 5,
      pointsA: 4000,
      pointsB: 4600,
      pointsDelta: 600,
    });
  });

  it('ordena por |villagesDelta| desc, empate por pointsDelta desc, empate por tag asc', () => {
    const a = makeVersion([
      tribe(1, 'AAA', 2, 100),
      tribe(2, 'BBB', 9, 500),
      tribe(3, 'CCC', 0, 0),
      tribe(4, 'DDD', 10, 1000),
    ]);
    const b = makeVersion([
      tribe(1, 'AAA', 6, 300), // +4 aldeias, +200 pontos
      tribe(2, 'BBB', 5, 900), // -4 aldeias, +400 pontos (empata |4| e ganha no pointsDelta)
      tribe(3, 'CCC', 4, 200), // +4 aldeias, +200 pontos (empata com AAA → tag decide)
      tribe(4, 'DDD', 10, 1000), // sem mudança → vai por último
    ]);
    expect(diffWorldVersions(a, b).map((r) => r.tag)).toEqual(['BBB', 'AAA', 'CCC', 'DDD']);
  });
});

describe('capWorldHistory', () => {
  const versions = (count: number): WorldHistoryVersion[] =>
    Array.from({ length: count }, (_, i) => makeVersion([tribe(i + 1, `T${i}`, i, i)]));

  it(`mantém até ${MAX_WORLD_HISTORY} versões sem descartar nada`, () => {
    const input = versions(10);
    const capped = capWorldHistory(input);
    expect(capped).toHaveLength(10);
    expect(capped.map((v) => v.id)).toEqual(input.map((v) => v.id));
  });

  it('com 11 versões descarta a mais antiga e mantém as 10 mais recentes', () => {
    const input = versions(11);
    const capped = capWorldHistory(input);
    expect(capped).toHaveLength(MAX_WORLD_HISTORY);
    expect(capped.map((v) => v.id)).toEqual(input.slice(1).map((v) => v.id));
    expect(capped.map((v) => v.id)).not.toContain(input[0]?.id);
  });

  it('não muta o array de entrada e sempre devolve um array novo', () => {
    const input = versions(3);
    const capped = capWorldHistory(input);
    expect(capped).not.toBe(input);
    expect(input).toHaveLength(3);
    capped.push(makeVersion([]));
    expect(input).toHaveLength(3); // resultado é cópia: mexer nele não afeta a entrada
  });
});

describe('newWorldVersionId', () => {
  it('gera ids únicos em chamadas consecutivas', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newWorldVersionId()));
    expect(ids.size).toBe(50);
  });
});

describe('imutabilidade das entradas', () => {
  it('agregação e delta não mutam os arrays recebidos (congelados não lançam)', () => {
    const villages = Object.freeze([village(1, 1, 7), village(2, 2, 7), village(3, 3, 0)]);
    const allies = Object.freeze([{ id: 7, tag: 'TOXIC', points: 100 }]);
    const prev = Object.freeze([village(1, 1, 7)]);
    const next = Object.freeze([village(1, 1, 9)]);

    expect(() => computeWorldAggregates(villages, allies)).not.toThrow();
    expect(() => computeOwnerChanges(prev, next)).not.toThrow();
    expect(villages).toHaveLength(3);
    expect(prev[0]).toEqual({ x: 1, y: 1, allyId: 7 });
  });
});
