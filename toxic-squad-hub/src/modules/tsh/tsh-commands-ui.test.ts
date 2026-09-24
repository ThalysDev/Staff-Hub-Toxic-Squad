// Partes PURAS da tela "Comandos" (ambiente node, sem DOM): validação do alvo,
// distância, conversão chegada→envio, formatação pt-BR, resumo de tropas e a
// ordenação da lista por status/sendAt. Onda 1: colar horário, percentual,
// listas de coordenadas, ids únicos, repetição sequencial, trem de nobres,
// plano em bloco e o mapeamento para o Mapa de Operações.
import { describe, expect, it } from 'vitest';
import type { ScheduledCommandRecord } from '../../ext/core/scheduler-state';
import {
  arrivalToSendAt,
  buildBlockRecords,
  buildNobleTrainRecords,
  commandKindBadgeClass,
  commandKindLabel,
  commandStatusBadgeClass,
  commandStatusLabel,
  dedupeRecordIds,
  fieldsDistance,
  formatDecimalPtBr,
  formatInt,
  formatTimestamp,
  orderCommandRows,
  parseClipboardTime,
  parseCoordList,
  parseDatetimeLocal,
  parseTargetInput,
  parseUnitCount,
  replicateCommandInput,
  resolvePercentUnits,
  sendToArrival,
  summarizePercentUnits,
  summarizeUnits,
  timingStrategyLabel,
  toDatetimeLocalValue,
  toViewerCommands,
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
    // Separador de milhar pt-BR (Onda 1): '1.500' = 1500, não 1.
    expect(parseUnitCount('1.500')).toBe(1500);
    expect(parseUnitCount('12.000')).toBe(12000);
    expect(parseUnitCount('1.5')).toBe(1);
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

describe('parseClipboardTime (colar horário)', () => {
  const now = new Date(2026, 8, 22, 12, 0, 0);

  it('horário ainda por vir fica HOJE; já passado (ou igual) vai para AMANHÃ', () => {
    const hoje = parseClipboardTime('23:59:59', now);
    expect(hoje?.getTime()).toBe(new Date(2026, 8, 22, 23, 59, 59).getTime());
    const amanha = parseClipboardTime('07:23:45', now);
    expect(amanha?.getTime()).toBe(new Date(2026, 8, 23, 7, 23, 45).getTime());
    const igual = parseClipboardTime('12:00:00', now);
    expect(igual?.getTime()).toBe(new Date(2026, 8, 23, 12, 0, 0).getTime());
  });

  it('aceita HH:mm:ss:ms (e "."), HH:mm e espaços', () => {
    expect(parseClipboardTime(' 07:23:45:250 ', now)?.getMilliseconds()).toBe(250);
    expect(parseClipboardTime('07:23:45.25', now)?.getMilliseconds()).toBe(250);
    expect(parseClipboardTime('07:23:45:1', now)?.getMilliseconds()).toBe(100);
    expect(parseClipboardTime('23:59', now)?.getSeconds()).toBe(0);
  });

  it('texto ilegível ou fora de faixa = null (nada é preenchido)', () => {
    for (const bad of ['', 'abc', '25:00:00', '12:60:00', '12:00:60', '12', '1|2']) {
      expect(parseClipboardTime(bad, now)).toBeNull();
    }
  });
});

describe('resolvePercentUnits (percentual × disponível)', () => {
  it('floor do percentual e descarta o que zera', () => {
    expect(resolvePercentUnits({ axe: 50 }, { axe: 101 })).toEqual({ axe: 50 });
    expect(resolvePercentUnits({ axe: 100 }, { axe: 3 })).toEqual({ axe: 3 });
    expect(resolvePercentUnits({ axe: 1 }, { axe: 99 })).toEqual({}); // 0,99 → 0, não entra
    expect(resolvePercentUnits({ axe: 0, spear: 100 }, { axe: 10, spear: 10 })).toEqual({ spear: 10 });
  });

  it('clampa percentual > 100 e ignora unidade fora do elenco / disponível ilegível', () => {
    expect(resolvePercentUnits({ axe: 250 }, { axe: 10 })).toEqual({ axe: 10 });
    expect(resolvePercentUnits({ dragao: 50 } as never, { axe: 10 })).toEqual({});
    expect(resolvePercentUnits({ axe: 50 }, {})).toEqual({});
    expect(resolvePercentUnits({ axe: Number.NaN }, { axe: 10 })).toEqual({});
  });
});

describe('parseCoordList (textareas do bloco)', () => {
  it('separa por espaço/quebra/";", deduplica e aceita x,y', () => {
    const parsed = parseCoordList('500|500 501|501\n502|502; 500|500');
    expect(parsed.coords).toEqual([
      { x: 500, y: 500 },
      { x: 501, y: 501 },
      { x: 502, y: 502 },
    ]);
    expect(parsed.invalid).toEqual([]);
    expect(parseCoordList('534,551').coords).toEqual([{ x: 534, y: 551 }]);
  });

  it('reporta os tokens ilegíveis em vez de sumir com eles', () => {
    const parsed = parseCoordList('500|500 abc 1000|5');
    expect(parsed.coords).toEqual([{ x: 500, y: 500 }]);
    expect(parsed.invalid).toEqual(['abc', '1000|5']);
  });
});

describe('dedupeRecordIds', () => {
  it('sufixa colisões com o existente e entre os próprios registros', () => {
    const out = dedupeRecordIds(
      [mkRecord({ id: 'cid_x' }), mkRecord({ id: 'cid_x' }), mkRecord({ id: 'cid_x' })],
      ['cid_x', 'cid_x-2'],
    );
    expect(out.map((record) => record.id)).toEqual(['cid_x-3', 'cid_x-4', 'cid_x-5']);
  });

  it('id livre passa intacto', () => {
    const out = dedupeRecordIds([mkRecord({ id: 'cid_livre' })], ['cid_outro']);
    expect(out[0]?.id).toBe('cid_livre');
  });
});

describe('replicateCommandInput (sequencial)', () => {
  const base = {
    kind: 'attack' as const,
    sourceVillageId: '100001',
    target: { x: 500, y: 500 },
    units: { axe: 100 },
    timingMode: 'send' as const,
    sendAt: new Date(2026, 8, 22, 20, 0, 0).toISOString(),
    arrivalAt: new Date(2026, 8, 22, 21, 0, 0).toISOString(),
  };

  it('replica deslocando partida E chegada pelo intervalo', () => {
    const out = replicateCommandInput(base, 3, 1500);
    expect(out).toHaveLength(3);
    expect(Date.parse(out[1]!.sendAt) - Date.parse(out[0]!.sendAt)).toBe(1500);
    expect(Date.parse(out[2]!.arrivalAt ?? '') - Date.parse(out[1]!.arrivalAt ?? '')).toBe(1500);
    expect(Date.parse(out[1]!.arrivalAt ?? '') - Date.parse(out[1]!.sendAt)).toBe(60 * 60_000);
  });

  it('clampa 1–20 repetições e não inventa horário ilegível', () => {
    expect(replicateCommandInput(base, 0, 1000)).toHaveLength(1);
    expect(replicateCommandInput(base, 99, 1000)).toHaveLength(20);
    expect(replicateCommandInput({ ...base, sendAt: 'lixo' }, 5, 1000)).toHaveLength(1);
  });
});

describe('buildNobleTrainRecords (trem de nobres)', () => {
  const input = {
    sourceVillageId: '100001',
    sourceName: 'Origem',
    source: { x: 500, y: 500 },
    target: { x: 510, y: 500 },
    firstArrivalMs: Date.UTC(2026, 8, 22, 20, 0, 0),
    trainSize: 3 as const,
    gapMs: 300,
    noblesAvailable: 2,
    allowLoneSnob: false,
    autoSplitExtraNobles: false,
    escort: { axe: 100 },
    // Escolta 30 min; com nobre 60 min (o nobre é a unidade mais lenta).
    travelMinutesFor: (units: Partial<Record<string, number>>) => ((units.snob ?? 0) > 0 ? 60 : 30),
  };

  it('cria um registro por slot, com chegadas defasadas pelo gap e sem nobre no slot 0', () => {
    const result = buildNobleTrainRecords(input);
    expect(result.ok).toBe(true);
    const records = result.ok ? result.records : [];
    expect(records).toHaveLength(3);
    expect(records.map((record) => record.kind)).toEqual(['noble', 'noble', 'noble']);
    expect(records[0]?.units).toEqual({ axe: 100 });
    expect(records[1]?.units).toEqual({ axe: 100, snob: 1 });
    expect(records[2]?.units).toEqual({ axe: 100, snob: 1 });
    const arrivals = records.map((record) => Date.parse(record.arrivalAt ?? ''));
    expect(arrivals[0]).toBe(input.firstArrivalMs);
    expect(arrivals[1]! - arrivals[0]!).toBe(300);
    expect(arrivals[2]! - arrivals[1]!).toBe(300);
    // Partida = chegada − viagem do PRÓPRIO conjunto.
    expect(arrivals[0]! - Date.parse(records[0]!.sendAt)).toBe(30 * 60_000);
    expect(arrivals[1]! - Date.parse(records[1]!.sendAt)).toBe(60 * 60_000);
    expect(records.every((record) => record.timingMode === 'arrival')).toBe(true);
  });

  it('nobres insuficientes recusa com mensagem pt-BR (nunca trem incompleto silencioso)', () => {
    const result = buildNobleTrainRecords({ ...input, noblesAvailable: 1 });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('Nobres insuficientes');
  });

  it('nobre solitário autoriza o trem incompleto (primeiros slots de nobre)', () => {
    const result = buildNobleTrainRecords({ ...input, trainSize: 5, noblesAvailable: 2, allowLoneSnob: true });
    const records = result.ok ? result.records : [];
    expect(records).toHaveLength(5);
    expect(records.map((record) => record.units.snob ?? 0)).toEqual([0, 1, 1, 0, 0]);
  });

  it('viagem indisponível recusa o plano em vez de chutar horário', () => {
    const result = buildNobleTrainRecords({ ...input, travelMinutesFor: () => null });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('Tempo de viagem indisponível');
  });
});

describe('buildBlockRecords (plano em bloco)', () => {
  const arrivalMs = Date.UTC(2026, 8, 22, 20, 0, 0);
  const nowMs = arrivalMs - 24 * 60 * 60_000;
  const commands = [
    { origin: { x: 500, y: 500 }, target: { x: 510, y: 500 }, travelMinutes: 30, index: 0 },
    { origin: { x: 500, y: 500 }, target: { x: 520, y: 500 }, travelMinutes: 30.004, index: 1 },
    { origin: { x: 600, y: 600 }, target: { x: 520, y: 500 }, travelMinutes: 30, index: 2 },
  ];
  const base = {
    originFor: (coord: { x: number; y: number }) =>
      coord.x === 500 ? { id: '100001', name: 'A' } : { id: '100002', name: 'B' },
    kind: 'attack' as const,
    units: { axe: 100 },
    percentMode: false,
    unitsPercent: {},
    timing: { mode: 'arrival' as const, arrivalMs },
    nowMs,
    avoidMsConflicts: true,
    forceLate: false,
  };

  it('partida empurrada avisa a nova chegada; na JANELA, empurrar para fora recusa o comando', () => {
    const pushed = buildBlockRecords({ ...base, commands });
    expect(pushed.warnings.some((warning) => warning.includes('empurrada +5 s'))).toBe(true);
    // Janela de 2 s: a 2ª partida de 500|500 seria empurrada 5 s → fora da janela.
    const windowed = buildBlockRecords({
      ...base,
      commands,
      timing: { mode: 'window' as const, fromMs: arrivalMs, toMs: arrivalMs + 2_000 },
    });
    expect(windowed.records.filter((record) => record.source?.x === 500)).toHaveLength(1);
    expect(windowed.warnings.some((warning) => warning.includes('fora da janela'))).toBe(true);
  });

  it('partida = chegada − viagem e o espaçamento separa partidas da MESMA origem', () => {
    const built = buildBlockRecords({ ...base, commands });
    expect(built.records).toHaveLength(3);
    const from500 = built.records.filter((record) => record.source?.x === 500);
    expect(from500).toHaveLength(2);
    const departures = from500.map((record) => Date.parse(record.sendAt)).sort((a, b) => a - b);
    expect(departures[1]! - departures[0]!).toBe(5_000);
    // A outra origem não é afetada pelo espaçamento da primeira.
    const from600 = built.records.find((record) => record.source?.x === 600);
    expect(Date.parse(from600?.sendAt ?? '')).toBe(arrivalMs - 30 * 60_000);
    expect(from600?.sourceName).toBe('B');
  });

  it('sem evitar conflito de ms, as partidas ficam como planejadas', () => {
    const built = buildBlockRecords({ ...base, commands, avoidMsConflicts: false });
    const departures = built.records
      .filter((record) => record.source?.x === 500)
      .map((record) => Date.parse(record.sendAt))
      .sort((a, b) => a - b);
    expect(departures[1]! - departures[0]!).toBe(240);
  });

  it('partida no passado é ignorada com aviso — e aceita quando forceLate marca forced', () => {
    const past = buildBlockRecords({ ...base, commands, nowMs: arrivalMs + 60 * 60_000 });
    expect(past.records).toHaveLength(0);
    expect(past.warnings.some((warning) => warning.includes('forçar atraso'))).toBe(true);
    const forced = buildBlockRecords({ ...base, commands, nowMs: arrivalMs + 60 * 60_000, forceLate: true });
    expect(forced.records).toHaveLength(3);
    expect(forced.records.every((record) => record.forced === true)).toBe(true);
  });

  it('janela distribui as chegadas e o percentual fica gravado no registro', () => {
    const built = buildBlockRecords({
      ...base,
      commands: commands.slice(0, 2),
      timing: { mode: 'window', fromMs: arrivalMs, toMs: arrivalMs + 60_000 },
      percentMode: true,
      units: {},
      unitsPercent: { axe: 50 },
      avoidMsConflicts: false,
    });
    const arrivals = built.records.map((record) => Date.parse(record.arrivalAt ?? '')).sort((a, b) => a - b);
    expect(arrivals).toEqual([arrivalMs, arrivalMs + 60_000]);
    expect(built.records.every((record) => record.percentMode === true)).toBe(true);
    expect(built.records[0]?.unitsPercent).toEqual({ axe: 50 });
    expect(built.records[0]?.units).toEqual({});
  });

  it('origem que não é aldeia sua é ignorada com aviso', () => {
    const built = buildBlockRecords({ ...base, commands, originFor: () => undefined });
    expect(built.records).toHaveLength(0);
    expect(built.warnings.every((warning) => warning.includes('não é uma aldeia sua'))).toBe(true);
  });
});

describe('toViewerCommands (mapa de operações)', () => {
  const now = new Date(2026, 8, 22, 12, 0, 0);

  it('mapeia registros vivos com status derivado e pula removidos/sem origem', () => {
    const vivo = mkRecord({
      id: 'vivo',
      source: { x: 500, y: 500 },
      sendAt: new Date(2026, 8, 22, 13, 0, 0).toISOString(),
      arrivalAt: new Date(2026, 8, 22, 14, 0, 0).toISOString(),
    });
    const removido = mkRecord({
      id: 'removido',
      source: { x: 500, y: 500 },
      events: [{ status: 'removido', at: new Date(2026, 8, 22, 11, 0, 0).toISOString() }],
    });
    const semOrigem = mkRecord({ id: 'sem-origem' });
    // Registro migrado do formulário legado: sem coordenada de origem.
    delete semOrigem.source;
    const set = toViewerCommands([vivo, removido, semOrigem], now, undefined, () => 42);
    expect(set.commands.map((command) => command.id)).toEqual(['vivo']);
    expect(set.skipped).toBe(2);
    expect(set.commands[0]?.status).toBe('agendado');
    expect(set.commands[0]?.groupId).toBe(42);
    expect(set.commands[0]!.arrivalMs - set.commands[0]!.departureMs).toBe(60 * 60_000);
  });

  it('fake sai marcado e sem grupo quando o mapa não conhece a origem', () => {
    const fake = mkRecord({ id: 'fake', kind: 'fake', source: { x: 500, y: 500 } });
    const set = toViewerCommands([fake], now);
    expect(set.commands[0]?.fakeFlagged).toBe(true);
    expect(set.commands[0]?.groupId).toBeUndefined();
  });
});

describe('rótulos da Onda 1', () => {
  it('timingStrategyLabel em pt-BR (direto é o default)', () => {
    expect(timingStrategyLabel('direto')).toContain('Direto');
    expect(timingStrategyLabel('snipe')).toContain('Snipe');
    expect(timingStrategyLabel('dodge')).toContain('antes do impacto e voltar');
    expect(timingStrategyLabel(undefined)).toContain('Direto');
  });

  it('summarizePercentUnits lista só os percentuais positivos', () => {
    expect(summarizePercentUnits({ axe: 50, snob: 100, spy: 0 })).toBe('Machado 50%, Nobre 100%');
    expect(summarizePercentUnits({})).toBe('—');
  });
});
