import { describe, expect, it } from 'vitest';
import { NOBLE_TIME_BUCKETS, bucketFor, bucketLabelListLabel } from './buckets';

describe('NOBLE_TIME_BUCKETS', () => {
  it('tem exatamente 11 buckets com rótulos originais', () => {
    expect(NOBLE_TIME_BUCKETS).toHaveLength(11);
    expect(NOBLE_TIME_BUCKETS.map((b) => b.label)).toEqual([
      'A MENOS DE 1 HORA',
      'DE 1 HORA A 2 HORAS',
      'DE 2 HORAS A 3 HORAS',
      'DE 3 HORAS A 4 HORAS',
      'DE 4 HORAS A 5 HORAS',
      'DE 5 HORAS A 8 HORAS',
      'DE 8 HORAS A 12 HORAS',
      'DE 12 HORAS A 18 HORAS',
      'DE 18 HORAS A 24 HORAS',
      'DE 24 HORAS A 34 HORAS',
      'A MAIS DE 34 HORAS',
    ]);
  });

  it('tem limites [min, max) contíguos, com o último max = Infinity', () => {
    expect(NOBLE_TIME_BUCKETS[0]?.min).toBe(0);
    for (let i = 0; i < NOBLE_TIME_BUCKETS.length - 1; i++) {
      expect(NOBLE_TIME_BUCKETS[i]?.max).toBe(NOBLE_TIME_BUCKETS[i + 1]?.min);
    }
    expect(NOBLE_TIME_BUCKETS[10]?.max).toBe(Infinity);
  });
});

describe('bucketFor', () => {
  it('mapeia horas para o bucket [min, max)', () => {
    expect(bucketFor(0)).toBe(0);
    expect(bucketFor(0.5)).toBe(0);
    expect(bucketFor(1)).toBe(1);
    expect(bucketFor(1.5)).toBe(1);
    expect(bucketFor(2)).toBe(2);
    expect(bucketFor(4.999999)).toBe(4);
    expect(bucketFor(5)).toBe(5);
    expect(bucketFor(7.99)).toBe(5);
    expect(bucketFor(8)).toBe(6);
    expect(bucketFor(12)).toBe(7);
    expect(bucketFor(18)).toBe(8);
    expect(bucketFor(24)).toBe(9);
    expect(bucketFor(33.9)).toBe(9);
    expect(bucketFor(34)).toBe(10);
    expect(bucketFor(100)).toBe(10);
  });

  it('horas inválidas retornam -1 (fail-closed, nunca no bucket "<1h")', () => {
    expect(bucketFor(-2)).toBe(-1);
    expect(bucketFor(Number.NaN)).toBe(-1);
    expect(bucketFor(Number.POSITIVE_INFINITY)).toBe(-1);
  });
});

describe('bucketLabelListLabel', () => {
  it('gera os prefixos originais das listas de coords', () => {
    expect(bucketLabelListLabel(0)).toBe('ALDEIAS COM DISTANCIA DE NOBRE MENOR QUE 1 HORA DO INIMIGO');
    expect(bucketLabelListLabel(1)).toBe('ALDEIAS COM DISTANCIA DE NOBRE DE 1 HORA A 2 HORAS DO INIMIGO');
    expect(bucketLabelListLabel(5)).toBe('ALDEIAS COM DISTANCIA DE NOBRE DE 5 HORAS A 8 HORAS DO INIMIGO');
    expect(bucketLabelListLabel(10)).toBe('ALDEIAS COM DISTANCIA DE NOBRE DE MAIS DE 34 HORAS DO INIMIGO');
  });

  it('lança RangeError para índice fora da faixa', () => {
    expect(() => bucketLabelListLabel(-1)).toThrow(RangeError);
    expect(() => bucketLabelListLabel(11)).toThrow(RangeError);
  });
});