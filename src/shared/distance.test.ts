import { describe, expect, it } from 'vitest';
import { fieldsBetween } from './distance';

describe('fieldsBetween', () => {
  it('distância euclidiana com 2 casas decimais', () => {
    expect(fieldsBetween({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(fieldsBetween({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe(1.41);
    expect(fieldsBetween({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(10);
    expect(fieldsBetween({ x: 535, y: 268 }, { x: 535, y: 268 })).toBe(0);
  });
});

