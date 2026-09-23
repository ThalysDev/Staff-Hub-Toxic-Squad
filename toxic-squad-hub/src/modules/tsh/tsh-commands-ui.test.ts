// Partes PURAS da tela "Comandos" (ambiente node, sem DOM): validação do alvo,
// distância, conversão chegada→envio, formatação pt-BR, resumo de tropas e a
// ordenação da lista por status/sendAt.
import { describe, expect, it } from 'vitest';
import type { ScheduledCommandRecord } from '../../ext/core/scheduler-state';
import {
  arrivalToSendAt,
  commandKindBadgeClass,
  commandKindLabel,
  commandStatusBadgeClass,
  commandStatusLabel,
  fieldsDistance,
  formatDecimalPtBr,
  formatInt,
  formatTimestamp,
  orderCommandRows,
  parseDatetimeLocal,
  parseTargetInput,
  parseUnitCount,
  sendToArrival,
  summarizeUnits,
  toDatetimeLocalValue,
  unitLabel,
} from './tsh-commands-ui';

let seq = 0;
function mkRecord(overrides: Partial<ScheduledCommandRecord> = {}): ScheduledCommandRecord {
  seq += 1;
  const base: ScheduledCommandRecord = {
    id: `cid_teste${seq}`,
    kind: 'attack',
    sourceVillageId: '100001',
    source: { x: 500, y: 500 },
    target: { x: 500, y: 500 },
    units: { axe: 100 },
    timingMode: 'send',
    sendAt: new Date(2026, 8, 22, 12, 0, 0).toISOString(),
    paused: false,
    createdAt: new Date(2026, 8, 22, 11, 0, 0).toISOString(),
    events: [],
  };
  return { ...base, ...overrides };
}

describe('parseTargetInput', () => {
  it('aceita "x|y" canônico (com espaços) e separador alternativo', () => {
    expect(parseTargetInput('534|551')).toEqual({ x: 534, y: 551 });
    expect(parseTargetInput(' 5 | 7 ')).toEqual({ x: 5, y: 7 });
    expect(parseTargetInput('534,551')).toEqual({ x: 534, y: 551 });
    expect(parseTargetInput('0|0')).toEqual({ x: 0, y: 0 });
  });

  it('rejeita inválidos (fail-closed)', () => {
    for (const bad of ['534', 'abc', '1000|5', '5|1000', '-1|5', '534|', '|551', '534|551|9', '']) {
      expect(parseTargetInput(bad)).toBeNull();
    }
  });
});

describe('fieldsDistance', () => {
  it('calcula a distância euclidiana em campos', () => {
    expect(fieldsDistance({ x: 100, y: 100 }, { x: 103, y: 104 })).toBe(5);
    expect(fieldsDistance({ x: 500, y: 500 }, { x: 500, y: 500 })).toBe(0);
    expect(fieldsDistance({ x: 0, y: 0 }, { x: 1, y: 1 })).toBeCloseTo(Math.SQRT2, 12);
  });
});

describe('conversão chegada→envio', () => {
  const chegada = new Date(2026, 8, 22, 12, 0, 0);

  it('envio = chegada − tempo de viagem', () => {
    expect(arrivalToSendAt(chegada, 30).getTime()).toBe(new Date(2026, 8, 22, 11, 30, 0).getTime());
    expect(arrivalToSendAt(chegada, 0).getTime()).toBe(chegada.getTime());
  });

  it('viagem negativa é tratada como zero (nunca envio no futuro da chegada)', () => {
    expect(arrivalToSendAt(chegada, -5).getTime()).toBe(chegada.getTime());
  });

  it('sendToArrival é a operação inversa', () => {
    const envio = arrivalToSendAt(chegada, 37.5);
    expect(sendToArrival(envio, 37.5).getTime()).toBe(chegada.getTime());
  });
});

describe('formatação pt-BR', () => {
  it('formatTimestamp "dd/mm HH:MM:SS"', () => {
    expect(formatTimestamp(new Date(2026, 8, 22, 7, 5, 3))).toBe('22/09 07:05:03');
    expect(formatTimestamp(new Date(2026, 0, 1, 23, 59, 59))).toBe('01/01 23:59:59');
  });

  it('datetime-local ida e volta no relógio local (segundos inclusos)', () => {
    const date = new Date(2026, 8, 22, 7, 5, 3);
    const value = toDatetimeLocalValue(date);
    expect(value).toBe('2026-09-22T07:05:03');
    const back = parseDatetimeLocal(value);
    expect(back).not.toBeNull();
    expect(back?.getTime()).toBe(date.getTime());
  });

  it('parseDatetimeLocal rejeita lixo e formato sem hora', () => {
    expect(parseDatetimeLocal('2026-09-22')).toBeNull();
    expect(parseDatetimeLocal('não é data')).toBeNull();
    expect(parseDatetimeLocal('')).toBeNull();
  });

  it('formatInt com milhar pt-BR e formatDecimalPtBr com 1 casa', () => {
    expect(formatInt(0)).toBe('0');
    expect(formatInt(999)).toBe('999');
    expect(formatInt(3500)).toBe('3.500');
    expect(formatInt(1234567)).toBe('1.234.567');
    expect(formatDecimalPtBr(5)).toBe('5');
    expect(formatDecimalPtBr(12.34)).toBe('12,3');
  });

  it('parseUnitCount: vazio/lixo/negativo = 0; decimais viram inteiro', () => {
    expect(parseUnitCount('')).toBe(0);
    expect(parseUnitCount('abc')).toBe(0);
    expect(parseUnitCount('-3')).toBe(0);
    expect(parseUnitCount('50')).toBe(50);
    expect(parseUnitCount('50,7')).toBe(50);
  });
});

describe('summarizeUnits', () => {
  it('população (pela tabela do motor) + as 3 maiores unidades', () => {
    // machado 1 pop ×2000 + aríete 5 pop ×50 + nobre 100 pop ×1 = 2350
    expect(summarizeUnits({ axe: 2000, ram: 50, snob: 1, spy: 0 })).toBe(
      '2.350 pop · Machado ×2.000, Aríete ×50, Nobre ×1',
    );
  });

  it('vazio (ou só zeros) = "—"', () => {
    expect(summarizeUnits({})).toBe('—');
    expect(summarizeUnits({ spy: 0 })).toBe('—');
  });

  it('rótulos pt-BR das unidades', () => {
    expect(unitLabel('spear')).toBe('Lança');
    expect(unitLabel('marcher')).toBe('Arq. Cavalo');
    expect(unitLabel('snob')).toBe('Nobre');
  });
});

describe('badges de tipo e status', () => {
  it('rótulos pt-BR', () => {
    expect(commandKindLabel('attack')).toBe('Ataque');
    expect(commandKindLabel('fake')).toBe('Fake');
    expect(commandKindLabel('support')).toBe('Apoio');
    expect(commandKindLabel('noble')).toBe('Nobre');
    expect(commandStatusLabel('agendado')).toBe('Agendado');
    expect(commandStatusLabel('janela')).toBe('Na janela');
    expect(commandStatusLabel('pausado')).toBe('Pausado');
  });

  it('cores: ataque vermelho, enviado verde, falhou/incerto em destaque de perigo', () => {
    expect(commandKindBadgeClass('attack')).toContain('tsh-badge--muta');
    expect(commandKindBadgeClass('fake')).toBe('tsh-badge');
    expect(commandStatusBadgeClass('enviado')).toContain('tsh-badge--on');
    expect(commandStatusBadgeClass('falhou')).toContain('tsh-badge--muta');
    expect(commandStatusBadgeClass('incerto')).toContain('tsh-badge--muta');
    expect(commandStatusBadgeClass('pausado')).toBe('tsh-badge');
  });
});

describe('orderCommandRows', () => {
  const now = new Date(2026, 8, 22, 12, 0, 0);

  it('vivos (agendados/janela/pausados) por sendAt ↑, histórico por sendAt ↓', () => {
    const futuro1 = mkRecord({ id: 'futuro1', sendAt: new Date(2026, 8, 22, 13, 0, 0).toISOString() });
    const futuro2 = mkRecord({ id: 'futuro2', sendAt: new Date(2026, 8, 22, 12, 30, 0).toISOString() });
    const pausado = mkRecord({ id: 'pausado', paused: true, sendAt: new Date(2026, 8, 22, 11, 0, 0).toISOString() });
    const enviado = mkRecord({
      id: 'enviado',
      sendAt: new Date(2026, 8, 22, 10, 0, 0).toISOString(),
      events: [{ status: 'enviado', at: new Date(2026, 8, 22, 10, 0, 1).toISOString() }],
    });
    const perdido = mkRecord({ id: 'perdido', sendAt: new Date(2026, 8, 22, 9, 0, 0).toISOString() }); // agora > sendAt+250ms → falhou

    const rows = orderCommandRows([futuro1, perdido, futuro2, pausado, enviado], now);
    expect(rows.map((row) => row.record.id)).toEqual(['pausado', 'futuro2', 'futuro1', 'enviado', 'perdido']);
    expect(rows.map((row) => row.status)).toEqual(['pausado', 'agendado', 'agendado', 'enviado', 'falhou']);
  });

  it('comando na janela de envio ainda é "vivo" (status "janela")', () => {
    // janela = sendAt em [agora − allowLateMs, agora + focusLeadMs]: 10s à frente está no lead de 15s.
    const naJanela = mkRecord({ id: 'janela', sendAt: new Date(2026, 8, 22, 12, 0, 10).toISOString() });
    const futuro = mkRecord({ id: 'futuro', sendAt: new Date(2026, 8, 22, 18, 0, 0).toISOString() });
    const rows = orderCommandRows([futuro, naJanela], now);
    expect(rows.map((row) => row.record.id)).toEqual(['janela', 'futuro']);
    expect(rows[0]?.status).toBe('janela');
  });
});
