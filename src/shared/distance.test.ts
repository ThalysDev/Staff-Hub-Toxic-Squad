import { describe, expect, it } from 'vitest';
import { fieldsBetween, nearestTravelHours, travelHours } from './distance';

describe('fieldsBetween', () => {
  it('distância euclidiana com 2 casas decimais', () => {
    expect(fieldsBetween({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(fieldsBetween({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe(1.41);
    expect(fieldsBetween({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(10);
    expect(fieldsBetween({ x: 535, y: 268 }, { x: 535, y: 268 })).toBe(0);
  });
});

describe('travelHours', () => {
  it('campos * minutos por campo / 60 / velocidade do mundo', () => {
    expect(travelHours(5, 35, 1)).toBeCloseTo((5 * 35) / 60, 10);
    expect(travelHours(5, 35, 2)).toBeCloseTo((5 * 35) / 60 / 2, 10);
    expect(travelHours(10, 30, 1)).toBe(5);
    expect(travelHours(0, 35, 1)).toBe(0);
  });
});

describe('nearestTravelHours', () => {
  const origin = { x: 0, y: 0 };

  it('retorna o alvo mais próximo com suas horas', () => {
    const result = nearestTravelHours(origin, [{ x: 10, y: 0 }, { x: 3, y: 4 }, { x: 1, y: 0 }], 35, 1);
    expect(result).not.toBeNull();
    expect(result?.target).toEqual({ x: 1, y: 0 });
    expect(result?.hours).toBeCloseTo(35 / 60, 10);
  });

  it('lista vazia → null', () => {
    expect(nearestTravelHours(origin, [], 35, 1)).toBeNull();
  });

  it('empate: primeira ocorrência vence', () => {
    const result = nearestTravelHours(origin, [{ x: 3, y: 4 }, { x: 0, y: 5 }], 35, 1);
    expect(result?.target).toEqual({ x: 3, y: 4 });
  });
});