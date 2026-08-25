import { describe, expect, it } from 'vitest';
import { NOBLE_TIME_BUCKETS } from './buckets';
import type { Coord } from './coords';
import {
  buildEnemySet,
  computeSg1Buckets,
  effectiveNobleMinutesPerField,
} from './sg1-engine';

// Min/campo efetivo do BR142: 31.111… / (1.5 × 0.75) ≈ 27.65432.
const MPF_BR142 = effectiveNobleMinutesPerField(31.111111111111, 1.5, 0.75);

describe('effectiveNobleMinutesPerField', () => {
  it('fórmula TW: speed_xml / (worldSpeed × unitSpeed)', () => {
    expect(MPF_BR142).toBeCloseTo(31.111111111111 / 1.125, 10);
    expect(MPF_BR142).toBeCloseTo(27.654320987654322, 10);
    expect(effectiveNobleMinutesPerField(18, 1.5, 0.75)).toBe(16);
  });

  it('velocidades inválidas → RangeError (fail-closed)', () => {
    expect(() => effectiveNobleMinutesPerField(0, 1.5, 0.75)).toThrow(RangeError);
    expect(() => effectiveNobleMinutesPerField(18, 0, 0.75)).toThrow(RangeError);
    expect(() => effectiveNobleMinutesPerField(18, 1.5, Number.NaN)).toThrow(RangeError);
  });
});

describe('computeSg1Buckets', () => {
  it('cada faixa de tempo cai no bucket certo (inimigo na origem)', () => {
    const ownVillages = [
      { x: 1, y: 0 }, // 1 campo  → ~0.46h → bucket 0 (<1h)
      { x: 3, y: 0 }, // 3 campos → ~1.38h → bucket 1
      { x: 6, y: 0 }, // 6 campos → ~2.77h → bucket 2
      { x: 7, y: 0 }, // 7 campos → ~3.23h → bucket 3
      { x: 10, y: 0 }, // 10 campos → ~4.61h → bucket 4
      { x: 13, y: 0 }, // 13 campos → ~5.99h → bucket 5
      { x: 18, y: 0 }, // 18 campos → ~8.30h → bucket 6
      { x: 27, y: 0 }, // 27 campos → ~12.44h → bucket 7
      { x: 40, y: 0 }, // 40 campos → ~18.44h → bucket 8
      { x: 53, y: 0 }, // 53 campos → ~24.43h → bucket 9
      { x: 74, y: 0 }, // 74 campos → ~34.11h → bucket 10 (>34h)
    ];
    const result = computeSg1Buckets({
      ownVillages,
      enemyVillages: [{ x: 0, y: 0 }],
      nobleMinutesPerField: MPF_BR142,
    });
    expect(result).toHaveLength(11);
    for (let i = 0; i < 11; i++) {
      expect(result[i]).toMatchObject({ index: i, label: NOBLE_TIME_BUCKETS[i]?.label, count: 1 });
      expect(result[i]?.coords).toEqual([`${ownVillages[i]?.x ?? NaN}|0`]);
    }
    expect(result[0]?.coords).toEqual(['1|0']);
    expect(result[10]?.coords).toEqual(['74|0']);
  });

  it('usa apenas o inimigo mais próximo', () => {
    const result = computeSg1Buckets({
      ownVillages: [{ x: 500, y: 500 }],
      enemyVillages: [
        { x: 520, y: 500 }, // 20 campos → ~9.2h
        { x: 500, y: 501 }, // 1 campo → ~0.46h
      ],
      nobleMinutesPerField: MPF_BR142,
    });
    expect(result[0]?.count).toBe(1);
    expect(result.reduce((s, b) => s + b.count, 0)).toBe(1);
  });

  it('kDesiredFilter restringe as aldeias próprias por continente', () => {
    const result = computeSg1Buckets(
      {
        ownVillages: [
          { x: 455, y: 455 }, // K44
          { x: 555, y: 555 }, // K55
        ],
        enemyVillages: [{ x: 500, y: 500 }],
        nobleMinutesPerField: MPF_BR142,
      },
      { kDesiredFilter: [55] }
    );
    expect(result.reduce((s, b) => s + b.count, 0)).toBe(1);
    expect(result.flatMap((b) => b.coords)).toEqual(['555|555']);
  });

  it('sem filtro, todas as aldeias próprias entram', () => {
    const result = computeSg1Buckets({
      ownVillages: [
        { x: 455, y: 455 },
        { x: 555, y: 555 },
      ],
      enemyVillages: [{ x: 500, y: 500 }],
      nobleMinutesPerField: MPF_BR142,
    });
    expect(result.reduce((s, b) => s + b.count, 0)).toBe(2);
  });

  it('conjunto inimigo vazio → erro claro (fail-closed)', () => {
    expect(() =>
      computeSg1Buckets({ ownVillages: [{ x: 0, y: 0 }], enemyVillages: [], nobleMinutesPerField: MPF_BR142 })
    ).toThrow(/Conjunto inimigo vazio/);
  });

  it('nobleMinutesPerField inválido → erro claro, nunca bucket <1h', () => {
    expect(() =>
      computeSg1Buckets({
        ownVillages: [{ x: 1, y: 0 }],
        enemyVillages: [{ x: 0, y: 0 }],
        nobleMinutesPerField: Number.NaN,
      })
    ).toThrow(/Tempo de nobre inválido/);
  });

  it('smoke: ~1000 aldeias de cada lado roda e fecha as contagens', () => {
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const own: Coord[] = [];
    const enemy: Coord[] = [];
    for (let i = 0; i < 1000; i++) {
      own.push({ x: Math.floor(rnd() * 1000), y: Math.floor(rnd() * 1000) });
      enemy.push({ x: Math.floor(rnd() * 1000), y: Math.floor(rnd() * 1000) });
    }
    const result = computeSg1Buckets({ ownVillages: own, enemyVillages: enemy, nobleMinutesPerField: MPF_BR142 });
    expect(result).toHaveLength(11);
    expect(result.reduce((s, b) => s + b.count, 0)).toBe(1000);
    expect(result.reduce((s, b) => s + b.coords.length, 0)).toBe(1000);
  });
});

describe('buildEnemySet', () => {
  const own = [
    { x: 455, y: 455 },
    { x: 556, y: 556 },
  ];
  const enemyTagVillages = [
    { x: 455, y: 455 }, // K44
    { x: 555, y: 555 }, // K55
  ];

  it('sem filtros, repassa os conjuntos', () => {
    const { own: o, enemy: e } = buildEnemySet(own, enemyTagVillages);
    expect(o).toEqual(own);
    expect(e).toEqual(enemyTagVillages);
  });

  it('kEnemyDiscard remove por continente', () => {
    const { enemy } = buildEnemySet(own, enemyTagVillages, { kEnemyDiscard: [44] });
    expect(enemy).toEqual([{ x: 555, y: 555 }]);
  });

  it('enemyCoordsDiscard remove por coordenada exata', () => {
    const { enemy } = buildEnemySet(own, enemyTagVillages, {
      enemyCoordsDiscard: [{ x: 555, y: 555 }],
    });
    expect(enemy).toEqual([{ x: 455, y: 455 }]);
  });

  it('enemyCoordsConsider substitui o conjunto inimigo (discards não se aplicam)', () => {
    const { enemy } = buildEnemySet(own, enemyTagVillages, {
      enemyCoordsConsider: [{ x: 600, y: 600 }],
      kEnemyDiscard: [60],
      enemyCoordsDiscard: [{ x: 600, y: 600 }],
    });
    expect(enemy).toEqual([{ x: 600, y: 600 }]);
  });

  it('allyCoordsConsider acrescenta ao conjunto próprio', () => {
    const { own: o, enemy } = buildEnemySet(own, enemyTagVillages, {
      allyCoordsConsider: [{ x: 700, y: 700 }],
    });
    expect(o).toEqual([...own, { x: 700, y: 700 }]);
    expect(enemy).toEqual(enemyTagVillages);
  });

  it('duplicatas exatas são removidas (primeira ocorrência vence)', () => {
    const { own: o, enemy: e } = buildEnemySet(
      [{ x: 1, y: 1 }],
      [{ x: 2, y: 2 }, { x: 2, y: 2 }],
      { allyCoordsConsider: [{ x: 1, y: 1 }] }
    );
    expect(o).toEqual([{ x: 1, y: 1 }]);
    expect(e).toEqual([{ x: 2, y: 2 }]);
  });
});