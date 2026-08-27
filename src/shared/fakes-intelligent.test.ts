import { describe, expect, it } from 'vitest';
import { distributeFakes, type FakeOrigin, type FakeTarget } from './fakes-intelligent';

function toCoord(text: string): { x: number; y: number } {
  const [xs, ys] = text.split('|');
  return { x: Number(xs), y: Number(ys) };
}

/** Distância euclidiana em campos (2 decimais), igual ao fieldsBetween do repo. */
function fieldsBetweenText(a: string, b: string): number {
  const ca = toCoord(a);
  const cb = toCoord(b);
  return Math.round(Math.hypot(cb.x - ca.x, cb.y - ca.y) * 100) / 100;
}

function origin(playerName: string, coord: string): FakeOrigin {
  return {
    playerName,
    coord,
    distanceTo: (target: string) => fieldsBetweenText(coord, target),
  };
}

function fakeTarget(coord: string, distanceFields = 10): FakeTarget {
  return { coord, distanceFields };
}

describe('distributeFakes', () => {
  it('atribui cada origem ao alvo mais próximo ainda não usado', () => {
    // alfa (500|500): T1 a 8 campos; bravo (530|500): T1 a 22 e T2 a 10.
    const result = distributeFakes(
      [origin('alfa', '500|500'), origin('bravo', '530|500')],
      [fakeTarget('508|500'), fakeTarget('520|500')],
    );
    expect(result.assignments).toEqual([
      { playerName: 'alfa', origin: '500|500', target: '508|500', distanceFields: 8 },
      { playerName: 'bravo', origin: '530|500', target: '520|500', distanceFields: 10 },
    ]);
    expect(result.unassignedTargets).toEqual([]);
    expect(result.idleOrigins).toEqual([]);
  });

  it('maxPerOrigin default 1 — origem única pega só o mais próximo', () => {
    const result = distributeFakes([origin('delta', '500|500')], [
      fakeTarget('502|500'),
      fakeTarget('504|500'),
      fakeTarget('506|500'),
    ]);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]).toEqual({
      playerName: 'delta',
      origin: '500|500',
      target: '502|500',
      distanceFields: 2,
    });
    expect(result.unassignedTargets).toEqual(['504|500', '506|500']);
  });

  it('maxPerOrigin > 1 deixa a mesma origem pegar vários fakes', () => {
    const result = distributeFakes(
      [origin('delta', '500|500')],
      [fakeTarget('502|500'), fakeTarget('504|500'), fakeTarget('506|500')],
      { maxPerOrigin: 2 },
    );
    expect(result.assignments.map((a) => a.target)).toEqual(['502|500', '504|500']);
    expect(result.unassignedTargets).toEqual(['506|500']);
    expect(result.idleOrigins).toEqual([]);
  });

  it('maxFields corta alvos distantes e aposenta a origem', () => {
    const result = distributeFakes([origin('eco', '500|500')], [
      fakeTarget('900|500'), // 400 campos
      fakeTarget('510|500'), // 10 campos
    ], { maxFields: 5 });
    expect(result.assignments).toEqual([]);
    expect(result.idleOrigins).toEqual(['500|500']);
    expect(result.unassignedTargets).toEqual(['900|500', '510|500']);
  });

  it('todas as origens sem fake elegível → idleOrigins na ordem de entrada', () => {
    const result = distributeFakes(
      [origin('alfa', '100|100'), origin('bravo', '110|110')],
      [fakeTarget('990|500'), fakeTarget('950|520')],
    );
    expect(result.assignments).toEqual([]);
    expect(result.idleOrigins).toEqual(['100|100', '110|110']);
    expect(result.unassignedTargets).toEqual(['990|500', '950|520']);
  });

  it('sobra alvo → unassignedTargets', () => {
    // alfa (500|500) pega 502; bravo (520|500) pega 518; sobra 508.
    const result = distributeFakes(
      [origin('alfa', '500|500'), origin('bravo', '520|500')],
      [fakeTarget('502|500'), fakeTarget('508|500'), fakeTarget('518|500')],
    );
    expect(result.assignments.map((a) => `${a.origin}->${a.target}`)).toEqual([
      '500|500->502|500',
      '520|500->518|500',
    ]);
    expect(result.unassignedTargets).toEqual(['508|500']);
  });

  it('é determinístico: duas execuções com as mesmas entradas geram o mesmo resultado', () => {
    const origins = [origin('alfa', '500|500'), origin('bravo', '530|500')];
    const targets = [fakeTarget('508|500'), fakeTarget('520|500'), fakeTarget('940|400')];
    expect(JSON.stringify(distributeFakes(origins, targets))).toBe(
      JSON.stringify(distributeFakes(origins, targets)),
    );
  });

  it('fail-closed: coordenada inválida, nick vazio ou distanceTo ruim lançam PT-BR', () => {
    expect(() =>
      distributeFakes([{ playerName: 'alfa', coord: 'abc', distanceTo: () => 0 }], []),
    ).toThrow(/coordenada da origem fake/i);
    expect(() =>
      distributeFakes([{ playerName: '  ', coord: '500|500', distanceTo: () => 0 }], [fakeTarget('501|500')]),
    ).toThrow(/nick ausente/i);
    expect(() =>
      distributeFakes([{ playerName: 'alfa', coord: '500|500', distanceTo: undefined as unknown as () => number }], []),
    ).toThrow(/origem fake.*inválida/i);
    expect(() =>
      distributeFakes(
        [{ playerName: 'alfa', coord: '500|500', distanceTo: () => Number.NaN }],
        [fakeTarget('501|500')],
      ),
    ).toThrow(/distanceTo.*retornou valor inválido/i);
    expect(() => distributeFakes([], [{ coord: 'xxxx', distanceFields: 1 }])).toThrow(/alvo fake/i);
    expect(() =>
      distributeFakes([origin('alfa', '500|500')], [{ coord: '501|500', distanceFields: -3 }]),
    ).toThrow(/distanceFields inválido/i);
  });

  it('fail-closed: opções fora do contrato lançam erro claro', () => {
    expect(() => distributeFakes([], [], { maxPerOrigin: 0 })).toThrow(/maxPerOrigin/i);
    expect(() => distributeFakes([], [], { maxPerOrigin: 1.5 })).toThrow(/maxPerOrigin/i);
    expect(() => distributeFakes([], [], { maxFields: -1 })).toThrow(/maxFields/i);
    expect(() => distributeFakes([], [], { maxFields: Number.POSITIVE_INFINITY })).toThrow(/maxFields/i);
  });
});
