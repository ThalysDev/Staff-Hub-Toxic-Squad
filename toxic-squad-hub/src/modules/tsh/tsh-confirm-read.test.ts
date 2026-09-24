// Decisões puras da confirmação (Aflição / duração real / recusa do jogo).
import { describe, expect, it } from 'vitest';
import { durationVerdict, formatHms, parseHmsMs } from './tsh-confirm-read';

const MIN = 60_000;

describe('duração real na confirmação', () => {
  const base = { sendAtMs: 0, arrivalAtMs: 30 * MIN, nowMs: -10 * MIN };

  it('igual (dentro do arredondamento) = segue', () => {
    expect(durationVerdict({ ...base, realMs: 30 * MIN + 900, arrivalLocked: true })).toEqual({ kind: 'ok' });
  });

  it('Aflição de 50%: 30 min viram 20 min → reagenda 10 min mais tarde e calcula a %', () => {
    const v = durationVerdict({ ...base, realMs: 20 * MIN, arrivalLocked: true });
    expect(v).toMatchObject({ kind: 'reagendar', newSendAtMs: 10 * MIN, boostPct: 50 });
  });

  it('encurtou poucos segundos: mira o novo horário na MESMA confirmação', () => {
    const v = durationVerdict({ sendAtMs: 0, arrivalAtMs: 30 * MIN, nowMs: -8_000, realMs: 30 * MIN - 5_000, arrivalLocked: true });
    expect(v).toMatchObject({ kind: 'mirar-novo', newSendAtMs: 5_000 });
  });

  it('viagem mais longa num comando por chegada: não chega na hora', () => {
    expect(durationVerdict({ ...base, realMs: 31 * MIN, arrivalLocked: true })).toMatchObject({ kind: 'atrasaria', lateMs: MIN });
  });

  it('comando por envio: só a chegada muda', () => {
    expect(durationVerdict({ ...base, realMs: 20 * MIN, arrivalLocked: false })).toMatchObject({ kind: 'nova-chegada', newArrivalAtMs: 20 * MIN });
  });

  it('o novo horário de envio já passou: curta-demais (mensagem própria)', () => {
    const v = durationVerdict({ sendAtMs: 0, arrivalAtMs: 30 * MIN, nowMs: 6_000, realMs: 30 * MIN - 5_000, arrivalLocked: true });
    expect(v).toMatchObject({ kind: 'curta-demais', lateByMs: 1_000 });
  });

  it('H:MM:SS', () => {
    expect(parseHmsMs('Duração: 1:02:03')).toBe((3600 + 120 + 3) * 1000);
    expect(parseHmsMs('—')).toBeNull();
    expect(formatHms(1_600_000)).toBe('0:26:40');
  });
});

describe('tentativas de pré-arme após reagendar', async () => {
  const { prearmAttempts, PREARM_EVENT_DETAIL } = await import('../../ext/core/timing/precise-fire');
  it('o reagendamento pela duração real zera a contagem', () => {
    const tentativa = { status: 'janela', detail: `${PREARM_EVENT_DETAIL} x` };
    expect(prearmAttempts([tentativa, tentativa])).toBe(2);
    expect(prearmAttempts([tentativa, { status: 'agendado', detail: 'Duração real 0:20:00 na confirmação (planejada 0:30:00): … — reagendado de A para B' }, tentativa])).toBe(1);
  });
});
