import { describe, expect, it } from 'vitest';
import type { ScheduledCommandRecord } from '../../ext/core/scheduler-state';
import {
  cancelManyCommands,
  cardActionsFor,
  countByKind,
  exportCommands,
  formatDelta,
  importCommands,
  matchesHistory,
  matchesQuery,
  precisionSummary,
  sendResultOf,
} from './tsh-central-logic';

function rec(over: Partial<ScheduledCommandRecord> = {}): ScheduledCommandRecord {
  return {
    id: 'c1',
    kind: 'support',
    sourceVillageId: '35454',
    sourceName: '1171 - Nobre, Toxic Squad!',
    source: { x: 719, y: 502 },
    target: { x: 718, y: 502 },
    targetName: '1176 - Nobre, Toxic Squad!',
    units: { spear: 200 },
    timingMode: 'send',
    sendAt: new Date(Date.now() + 3_600_000).toISOString(),
    paused: false,
    createdAt: new Date().toISOString(),
    events: [],
    ...over,
  };
}

describe('Central — ações por estado', () => {
  it('enviado nunca oferece "Pausar" (bug do histórico da 3.2)', () => {
    expect(cardActionsFor('enviado')).not.toContain('pausar');
    expect(cardActionsFor('enviado')).toEqual(['reagendar', 'apagar']);
  });
  it('pendente pausa/cancela; pausado retoma; enviando não tem ação', () => {
    expect(cardActionsFor('agendado')).toEqual(['pausar', 'cancelar']);
    expect(cardActionsFor('pausado')).toEqual(['retomar', 'cancelar']);
    expect(cardActionsFor('enviando')).toEqual([]);
  });
});

describe('Central — precisão do envio', () => {
  const sent = rec({
    events: [
      { status: 'enviado', at: '', detail: 'Comando support para 718|502 confirmado às 09:48:00.003 (alvo 09:48:00.000; compensação 40 ms; relógio ±88 ms, fonte http).' },
    ],
  });
  it('lê o desvio do clique', () => {
    expect(sendResultOf(sent)).toEqual({ confirmedAt: '09:48:00.003', clickDeltaMs: 3 });
  });
  it('prefere a chegada conferida no resumo', () => {
    const conferido = rec({
      events: [
        ...sent.events,
        { status: 'enviado', at: '', detail: 'Chegada real 10:04:00.001 (planejada 10:04:00.000; +1 ms).' },
      ],
    });
    expect(sendResultOf(conferido)?.arrivalDeltaMs).toBe(1);
    expect(precisionSummary([conferido, sent])).toEqual({ count: 2, meanAbsMs: 2, worstAbsMs: 3 });
  });
  it('virada da meia-noite não vira 24 h de erro', () => {
    const r = rec({ events: [{ status: 'enviado', at: '', detail: 'confirmado às 00:00:00.010 (alvo 23:59:59.990; x)' }] });
    expect(sendResultOf(r)?.clickDeltaMs).toBe(20);
  });
  it('formata o sinal', () => {
    expect(formatDelta(3)).toBe('+3 ms');
    expect(formatDelta(-12)).toBe('−12 ms');
    expect(formatDelta(0)).toBe('0 ms');
  });
});

describe('Central — filtros e contagem', () => {
  it('busca por coordenada e por nome sem acento', () => {
    expect(matchesQuery(rec(), '718|502')).toBe(true);
    expect(matchesQuery(rec(), 'toxic')).toBe(true);
    expect(matchesQuery(rec(), '999|999')).toBe(false);
  });
  it('filtro do histórico', () => {
    expect(matchesHistory('enviado', 'falhas')).toBe(false);
    expect(matchesHistory('incerto', 'falhas')).toBe(true);
    expect(matchesHistory('falhou', 'enviados')).toBe(false);
  });
  it('conta por tipo', () => {
    expect(countByKind([rec(), rec({ kind: 'attack' }), rec({ kind: 'attack' })])).toMatchObject({ attack: 2, support: 1 });
  });
});

describe('Central — exportar/importar', () => {
  it('ida e volta: importa como novo, sem eventos, com id livre', () => {
    const text = exportCommands('br142', [rec({ events: [{ status: 'enviado', at: '' }] })]);
    const out = importCommands(text, 'br142', new Set(['c1']), Date.now());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.records).toHaveLength(1);
    expect(out.result.records[0]!.id).toBe('c1-2');
    expect(out.result.records[0]!.events.map((e) => e.status)).toEqual(['agendado']);
  });
  it('horário passado fica de fora', () => {
    const text = exportCommands('br142', [rec({ sendAt: new Date(Date.now() - 1000).toISOString() })]);
    const out = importCommands(text, 'br142', new Set(), Date.now());
    expect(out.ok && out.result.past).toBe(1);
  });
  it('outro mundo é recusado ANTES de gravar; origem de outra conta fica de fora', () => {
    const outro = importCommands(exportCommands('br141', [rec()]), 'br142', new Set(), Date.now());
    expect(outro.ok).toBe(false);
    const alheio = importCommands(exportCommands('br142', [rec()]), 'br142', new Set(), Date.now(), new Set(['999']));
    expect(alheio.ok && alheio.result.foreign).toBe(1);
    expect(alheio.ok && alheio.result.records).toHaveLength(0);
  });
  it('cancelar em lote mantém o registro como cancelado (histórico)', () => {
    const out = cancelManyCommands([rec(), rec({ id: 'c2' })], new Set(['c1']), 'agora');
    expect(out).toHaveLength(2);
    expect(out[0]!.events.at(-1)?.status).toBe('removido');
    expect(out[1]!.events).toHaveLength(0);
  });
  it('texto qualquer é recusado com mensagem clara', () => {
    const out = importCommands('oi', 'br142', new Set(), Date.now());
    expect(out.ok).toBe(false);
  });
});
