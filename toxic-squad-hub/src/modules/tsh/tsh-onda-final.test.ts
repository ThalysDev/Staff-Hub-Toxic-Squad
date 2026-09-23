// Regressões das revisões finais (Ondas 9-19): sinal do offset servidor↔local
// (P1 corrigido) e parse de taxa decimal da Troca Premium (P2 corrigido).
import { describe, expect, it } from 'vitest';

import { localToServerEpoch, serverToLocal } from './tsh-commands-ui';
import { parseExchangeRate } from './plugins/premium-exchange';

describe('offset servidor ↔ local (P1 Onda 9 — sinal)', () => {
  // offset = servidor − local; sendAt (servidor) = local + offset.
  it('servidor adiantado 1h: sendAt = escolha + 1h', () => {
    const escolha = new Date(2026, 8, 22, 10, 0, 0).getTime();
    const offset = 60 * 60 * 1000;
    expect(localToServerEpoch(new Date(escolha), offset)).toBe(escolha + offset);
  });
  it('servidor atrasado 30min: sendAt = escolha − 30min', () => {
    const escolha = new Date(2026, 8, 22, 10, 0, 0).getTime();
    const offset = -30 * 60 * 1000;
    expect(localToServerEpoch(new Date(escolha), offset)).toBe(escolha - 30 * 60 * 1000);
  });
  it('exibição inverte a gravação (ida e volta)', () => {
    const offset = 3 * 60 * 60 * 1000;
    const escolha = new Date(2026, 8, 22, 15, 30, 0);
    const gravado = new Date(localToServerEpoch(escolha, offset)).toISOString();
    const exibido = serverToLocal(gravado, offset);
    expect(exibido.getTime()).toBe(escolha.getTime());
  });
});

describe('parseExchangeRate (P2 Onda 11-19 — decimal pt-BR)', () => {
  it('"28.000" (milhar) → 28000', () => {
    expect(parseExchangeRate('28.000')).toBe(28000);
  });
  it('"35,71" (decimal com vírgula) → 35.71 — antes virava 3571', () => {
    expect(parseExchangeRate('35,71')).toBeCloseTo(35.71, 2);
  });
  it('"1.234.567" → 1234567', () => {
    expect(parseExchangeRate('1.234.567')).toBe(1234567);
  });
  it('"500" inteiro simples', () => {
    expect(parseExchangeRate('500')).toBe(500);
  });
  it('lixo → 0', () => {
    expect(parseExchangeRate('abc')).toBe(0);
  });
});
