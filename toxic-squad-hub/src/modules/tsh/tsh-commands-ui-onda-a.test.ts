// Onda A — precisão na Central de Agendamentos: milissegundos, referência do
// horário digitado, viagem arredondada ao segundo e contagem regressiva.
import { describe, expect, it } from 'vitest';
import {
  arrivalToSendAt,
  formatEta,
  formatTimestampMs,
  parseClipboardTime,
  parseMillisInput,
  pruneCommandHistory,
  referenceOffsetMs,
  sendToArrival,
} from './tsh-commands-ui';

describe('Onda A — Central com milissegundos', () => {
  it('parseMillisInput limita 0..999 e tolera lixo', () => {
    expect(parseMillisInput('450')).toBe(450);
    expect(parseMillisInput('1500')).toBe(999);
    expect(parseMillisInput('-3')).toBe(0);
    expect(parseMillisInput('abc')).toBe(0);
    expect(parseMillisInput('')).toBe(0);
  });
  it('formatTimestampMs mostra os ms', () => {
    expect(formatTimestampMs(new Date(2026, 8, 22, 7, 5, 3, 9))).toBe('22/09 07:05:03.009');
  });
  it('colar HH:mm:ss:ms preserva os ms (antes eram descartados)', () => {
    const parsed = parseClipboardTime('12:00:00:500', new Date(2026, 8, 22, 10, 0, 0));
    expect(parsed?.getMilliseconds()).toBe(500);
  });
  it('referência servidor = offset 0; computador = offset medido', () => {
    expect(referenceOffsetMs('servidor', 1_234)).toBe(0);
    expect(referenceOffsetMs('local', 1_234)).toBe(1_234);
  });
  it('viagem arredondada ao segundo nas duas direções', () => {
    const chegada = new Date(2026, 8, 22, 12, 0, 0, 250);
    const envio = arrivalToSendAt(chegada, 10.5041); // 630,246s → 630s
    expect(chegada.getTime() - envio.getTime()).toBe(630_000);
    expect(sendToArrival(envio, 10.5041).getTime()).toBe(chegada.getTime());
  });
  it('formatEta: horas, mm:ss.mmm e vencido', () => {
    expect(formatEta(2 * 3_600_000 + 5 * 60_000)).toBe('em 2h05m');
    expect(formatEta(133_450)).toBe('em 02:13.450');
    expect(formatEta(-3_200)).toBe('passou há 3s');
    expect(formatEta(-200)).toBe('agora');
  });
});

describe('Onda C — limpar histórico', () => {
  const mk = (id: string, status: string | null, sendAt = '2026-09-23T12:00:00.000Z') =>
    ({
      id,
      kind: 'attack',
      sourceVillageId: '1',
      target: { x: 1, y: 1 },
      units: { axe: 1 },
      timingMode: 'send',
      sendAt,
      paused: false,
      createdAt: '2026-09-23T10:00:00.000Z',
      events: [{ status: 'agendado', at: '2026-09-23T10:00:00.000Z' }, ...(status === null ? [] : [{ status, at: '2026-09-23T12:00:00.000Z' }])],
    }) as unknown as import('../../ext/core/scheduler-state').ScheduledCommandRecord;
  it('remove enviados/falhos e mantém vivos e incertos', () => {
    const { kept, removed } = pruneCommandHistory([
      mk('vivo', null),
      mk('env', 'enviado'),
      mk('fal', 'falhou'),
      mk('inc', 'incerto'),
      mk('atrasado-sem-fato', null, '2020-01-01T00:00:00.000Z'), // relógio diria "falhou": fica
    ]);
    expect(removed).toBe(2);
    expect(kept.map((r) => r.id)).toEqual(['vivo', 'inc', 'atrasado-sem-fato']);
  });
});
