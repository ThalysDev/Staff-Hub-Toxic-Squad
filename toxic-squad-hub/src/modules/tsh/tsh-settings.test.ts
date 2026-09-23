// Cobertura da parada programada universal + janela ativa (P1-1, revisão
// Onda 0): isScheduleStopped/stopLabel/scheduleError/withinActiveWindow são
// puras e carregam regra de produto — nada de regressão silenciosa aqui.

import { describe, expect, it } from 'vitest';
import { isScheduleStopped, scheduleError, stopLabel, withinActiveWindow, type TshSchedule } from './tsh-settings';
import { numberFieldIssue } from './tsh-settings-ui';

const AT = new Date(2026, 8, 23, 12, 0, 0); // 23/09/2026 12:00 local

describe('isScheduleStopped', () => {
  it('desligada nunca para', () => {
    expect(isScheduleStopped({ stopEnabled: false, stopAt: '2026-01-01T00:00' }, AT)).toBe(false);
  });
  it('ligada sem stopAt não para', () => {
    expect(isScheduleStopped({ stopEnabled: true }, AT)).toBe(false);
  });
  it('stopAt no futuro não para', () => {
    expect(isScheduleStopped({ stopEnabled: true, stopAt: '2026-09-23T18:00' }, AT)).toBe(false);
  });
  it('stopAt no passado para', () => {
    expect(isScheduleStopped({ stopEnabled: true, stopAt: '2026-09-23T08:00' }, AT)).toBe(true);
  });
  it('stopAt exatamente agora para (inclusive)', () => {
    expect(isScheduleStopped({ stopEnabled: true, stopAt: '2026-09-23T12:00' }, AT)).toBe(true);
  });
  it('stopAt ilegível com parada ligada PARA (fail-closed)', () => {
    expect(isScheduleStopped({ stopEnabled: true, stopAt: '9999-99-99T99:99' }, AT)).toBe(true);
  });
  it('stopEnabled não-booleano não para', () => {
    expect(isScheduleStopped({ stopEnabled: 'true' as unknown as boolean, stopAt: '2026-01-01T00:00' }, AT)).toBe(false);
  });
});

describe('stopLabel', () => {
  it('futuro vira "para em …"', () => {
    expect(stopLabel({ stopEnabled: true, stopAt: '2026-09-23T18:00' }, AT)).toBe('para em 2026-09-23 18:00');
  });
  it('passado vira "atingida"', () => {
    expect(stopLabel({ stopEnabled: true, stopAt: '2026-09-23T08:00' }, AT)).toBe(
      'parada programada atingida (2026-09-23 08:00)',
    );
  });
  it('data ilegível é rotulada como inválida (não crasha)', () => {
    expect(stopLabel({ stopEnabled: true, stopAt: 'lixo' }, AT)).toBe('parada programada (data inválida)');
  });
});

describe('scheduleError (parada programada)', () => {
  it('formato correto passa', () => {
    expect(scheduleError({ stopEnabled: true, stopAt: '2026-09-23T18:00' })).toBeNull();
  });
  it('formato errado é barrado no Salvar', () => {
    expect(scheduleError({ stopAt: 'amanhã' })).toBe('Parada programada deve ser data e hora válidas.');
  });
  it('regex válida mas data irreal é barrada (P2-1)', () => {
    expect(scheduleError({ stopAt: '9999-99-99T99:99' })).toBe('Parada programada deve ser uma data real.');
  });
  it('cooldown e janela seguem válidos', () => {
    expect(scheduleError({ cooldownMinutes: 10, activeFrom: '08:00', activeTo: '23:00' })).toBeNull();
  });
});

describe('withinActiveWindow', () => {
  const at = (h: number, m: number): Date => new Date(2026, 8, 23, h, m);
  it('sem janela = sempre', () => {
    expect(withinActiveWindow({}, at(3, 0))).toBe(true);
  });
  it('dentro da janela normal', () => {
    expect(withinActiveWindow({ activeFrom: '08:00', activeTo: '18:00' }, at(12, 0))).toBe(true);
  });
  it('fora da janela normal', () => {
    expect(withinActiveWindow({ activeFrom: '08:00', activeTo: '18:00' }, at(19, 0))).toBe(false);
  });
  it('janela cruza a meia-noite (23→06)', () => {
    const schedule: TshSchedule = { activeFrom: '23:00', activeTo: '06:00' };
    expect(withinActiveWindow(schedule, at(2, 0))).toBe(true);
    expect(withinActiveWindow(schedule, at(23, 30))).toBe(true);
    expect(withinActiveWindow(schedule, at(12, 0))).toBe(false);
  });
  it('janela degenerada (início == fim) = sempre', () => {
    expect(withinActiveWindow({ activeFrom: '08:00', activeTo: '08:00' }, at(20, 0))).toBe(true);
  });
});

describe('numberFieldIssue (Onda C — validação visível)', () => {
  it('vazio e dentro da faixa passam', () => {
    expect(numberFieldIssue('', { min: 1, max: 10 })).toBeNull();
    expect(numberFieldIssue('5', { min: 1, max: 10 })).toBeNull();
    expect(numberFieldIssue('2,5', { min: 1, max: 10 })).toBeNull();
  });
  it('fora da faixa e lixo viram mensagem', () => {
    expect(numberFieldIssue('0', { min: 1 })).toBe('mínimo 1');
    expect(numberFieldIssue('99', { max: 10 })).toBe('máximo 10');
    expect(numberFieldIssue('abc', {})).toBe('não é um número');
  });
});
