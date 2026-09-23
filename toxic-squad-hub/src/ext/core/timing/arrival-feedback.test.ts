import { describe, expect, it } from 'vitest';
import { learnedCompensationMs, matchArrival, parseArrivalText } from './arrival-feedback';

const NOW = new Date(2026, 8, 23, 14, 30, 0).getTime();

describe('parseArrivalText', () => {
  it('hoje / amanhã / em DD.MM. com ms', () => {
    expect(parseArrivalText('hoje às 14:56:00:260', NOW)).toBe(new Date(2026, 8, 23, 14, 56, 0, 260).getTime());
    expect(parseArrivalText('amanhã às 01:02:03:004', NOW)).toBe(new Date(2026, 8, 24, 1, 2, 3, 4).getTime());
    expect(parseArrivalText('em 26.09. às 07:01:00:186', NOW)).toBe(new Date(2026, 8, 26, 7, 1, 0, 186).getTime());
  });
  it('sem ms e lixo', () => {
    expect(parseArrivalText('hoje às 14:59:35', NOW)).toBe(new Date(2026, 8, 23, 14, 59, 35, 0).getTime());
    expect(parseArrivalText('sem horário', NOW)).toBeNull();
  });
  it('virada de ano', () => {
    const dez = new Date(2026, 11, 31, 23, 0, 0).getTime();
    expect(parseArrivalText('em 01.01. às 00:10:00:000', dez)).toBe(new Date(2027, 0, 1, 0, 10, 0, 0).getTime());
  });
});

describe('matchArrival', () => {
  const T = { x: 720, y: 502 };
  const rows = [
    { target: T, origin: { x: 1, y: 1 }, arrivalMs: 10_260 },
    { target: T, origin: { x: 1, y: 1 }, arrivalMs: 10_360 },
    { target: T, origin: { x: 9, y: 9 }, arrivalMs: 10_110 },
    { target: { x: 1, y: 1 }, arrivalMs: 10_100 },
  ];
  it('trem: primeira chegada do grupo da MESMA origem', () => {
    expect(matchArrival(rows, { target: T, origin: { x: 1, y: 1 }, expectedMs: 10_100, train: true })).toBe(10_260);
  });
  it('comando simples: ambíguo (2+ candidatas) = null; única = ela', () => {
    expect(matchArrival(rows, { target: T, origin: { x: 1, y: 1 }, expectedMs: 10_300, train: false })).toBeNull();
    expect(matchArrival(rows, { target: T, origin: { x: 9, y: 9 }, expectedMs: 10_100, train: false })).toBe(10_110);
  });
  it('fora da tolerância = null', () => {
    expect(matchArrival(rows, { target: T, expectedMs: 90_000, train: false })).toBeNull();
  });
  it('ms com menos de 3 dígitos', () => {
    expect(parseArrivalText('hoje às 14:56:00:5', NOW)).toBe(new Date(2026, 8, 23, 14, 56, 0, 5).getTime());
  });
});

describe('learnedCompensationMs', () => {
  it('mediana de compensação+erro, com teto; null com < 2 amostras', () => {
    expect(learnedCompensationMs([{ errorMs: 20, compensationMs: 10, at: 0 }], 400)).toBeNull();
    expect(
      learnedCompensationMs(
        [
          { errorMs: 20, compensationMs: 10, at: 0 },
          { errorMs: 30, compensationMs: 10, at: 1 },
          { errorMs: 500, compensationMs: 10, at: 2 },
        ],
        400,
      ),
    ).toBe(40);
    expect(
      learnedCompensationMs(
        [
          { errorMs: -50, compensationMs: 10, at: 0 },
          { errorMs: -60, compensationMs: 10, at: 1 },
        ],
        400,
      ),
    ).toBe(0);
  });
});
