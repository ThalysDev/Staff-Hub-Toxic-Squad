import { describe, expect, it } from 'vitest';
import {
  BROWSER_DISPATCH_MS,
  HUMANIZED_LATE_GRACE_MS,
  MAX_LATENCY_COMPENSATION_MS,
  PREARM_EVENT_DETAIL,
  clockLabelMs,
  decideConfirmAction,
  decidePrearm,
  latencyCompensationMs,
  prearmAttempts,
  spinBudgetMs,
  travelDurationMs,
} from './precise-fire';

describe('latencyCompensationMs', () => {
  it('auto = metade do RTT + envio do navegador, com teto', () => {
    expect(latencyCompensationMs({ mode: 'auto', manualMs: 0, rttMedianMs: 80 })).toBe(40 + BROWSER_DISPATCH_MS);
    expect(latencyCompensationMs({ mode: 'auto', manualMs: 0, rttMedianMs: 5_000 })).toBe(MAX_LATENCY_COMPENSATION_MS);
    expect(latencyCompensationMs({ mode: 'auto', manualMs: 0, rttMedianMs: null })).toBe(BROWSER_DISPATCH_MS);
  });
  it('manual respeita 0..teto', () => {
    expect(latencyCompensationMs({ mode: 'manual', manualMs: 35, rttMedianMs: 999 })).toBe(35);
    expect(latencyCompensationMs({ mode: 'manual', manualMs: -5, rttMedianMs: null })).toBe(0);
  });
});

describe('decidePrearm', () => {
  it('espera até sendAt − lead', () => {
    expect(decidePrearm({ sendAtMs: 100_000, nowServerMs: 80_000, prearmLeadMs: 8_000 })).toEqual({
      kind: 'wait',
      inMs: 12_000,
    });
  });
  it('pré-arma já dentro do lead ou vencido', () => {
    expect(decidePrearm({ sendAtMs: 100_000, nowServerMs: 95_000, prearmLeadMs: 8_000 }).kind).toBe('prearm-now');
    expect(decidePrearm({ sendAtMs: 100_000, nowServerMs: 200_000, prearmLeadMs: 8_000 }).kind).toBe('prearm-now');
  });
});

describe('decideConfirmAction', () => {
  const base = { sendAtMs: 100_000, compensationMs: 30, allowLateMs: 250, forced: false, lane: 'precisao' as const };
  it('mira até sendAt − compensação (NUNCA clica antes)', () => {
    expect(decideConfirmAction({ ...base, nowServerMs: 90_000 })).toEqual({ kind: 'aim', waitMs: 9_970, fireAtMs: 99_970 });
  });
  it('clica no instante e dentro da tolerância', () => {
    expect(decideConfirmAction({ ...base, nowServerMs: 99_970 }).kind).toBe('fire');
    expect(decideConfirmAction({ ...base, nowServerMs: 100_250 }).kind).toBe('fire');
  });
  it('cravado atrasado além da tolerância = janela perdida (não sai)', () => {
    expect(decideConfirmAction({ ...base, nowServerMs: 100_251 })).toEqual({ kind: 'late', lateMs: 251 });
  });
  it('humanizado mantém a carência antiga; forçado sai sempre', () => {
    expect(decideConfirmAction({ ...base, lane: 'humanizado', nowServerMs: 100_000 + HUMANIZED_LATE_GRACE_MS }).kind).toBe(
      'fire',
    );
    expect(decideConfirmAction({ ...base, forced: true, nowServerMs: 900_000 }).kind).toBe('fire');
  });
});

describe('utilitários', () => {
  it('spin maior em aba de fundo', () => {
    expect(spinBudgetMs(true)).toBeGreaterThan(spinBudgetMs(false));
  });
  it('conta só eventos de pré-arme', () => {
    expect(
      prearmAttempts([
        { status: 'agendado' },
        { status: 'janela', detail: `${PREARM_EVENT_DETAIL} às 10:00:00.000` },
        { status: 'janela', detail: 'Envio automático desligado — comando segurado' },
      ]),
    ).toBe(1);
  });
  it('viagem arredondada ao segundo', () => {
    expect(travelDurationMs(10.5041)).toBe(630_000); // 630,246s → 630s
    expect(travelDurationMs(0)).toBe(0);
    expect(travelDurationMs(Number.NaN)).toBe(0);
  });
  it('rótulo com milissegundos', () => {
    expect(clockLabelMs(new Date(2026, 0, 1, 9, 5, 7, 42).getTime())).toBe('09:05:07.042');
  });
});
