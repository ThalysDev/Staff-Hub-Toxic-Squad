import { describe, expect, it } from 'vitest';
import { HTTP_MAX_AGE_MS, clockSourceLabel, effectiveUncertainty, pickClockSource } from './clock-source';

describe('pickClockSource', () => {
  const now = 10_000_000;
  it('prefere a menor incerteza', () => {
    const choice = pickClockSource(
      [
        { kind: 'tela', offsetMs: 900, uncertaintyMs: 1000, measuredAtMs: now },
        { kind: 'jogo', offsetMs: 120, uncertaintyMs: 150, measuredAtMs: now },
        { kind: 'http', offsetMs: 100, uncertaintyMs: 30, measuredAtMs: now },
      ],
      now,
    );
    expect(choice?.kind).toBe('http');
  });
  it('http envelhece (deriva) e expira', () => {
    const http = { kind: 'http' as const, offsetMs: 0, uncertaintyMs: 30, measuredAtMs: now - 20 * 60_000 };
    expect(effectiveUncertainty(http, now)).toBe(90);
    const jogo = { kind: 'jogo' as const, offsetMs: 0, uncertaintyMs: 150, measuredAtMs: now };
    expect(pickClockSource([http, jogo], now)?.kind).toBe('http');
    const velho = { ...http, measuredAtMs: now - HTTP_MAX_AGE_MS - 1 };
    expect(pickClockSource([velho, jogo], now)?.kind).toBe('jogo');
  });
  it('sem candidatos → null', () => {
    expect(pickClockSource([null], now)).toBeNull();
  });
  it('rótulos', () => {
    expect(clockSourceLabel('http')).toContain('servidor');
  });
});
