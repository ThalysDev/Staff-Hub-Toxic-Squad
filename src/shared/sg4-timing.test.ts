import { describe, expect, it } from 'vitest';
import type { OriginPlayer } from './sg4-engine';
import {
  computeSendTimes,
  formatHms,
  formatSendSchedule,
  nobleTrain,
  type SendPair,
  type SendScheduleRow,
  type SendTimeInput,
} from './sg4-timing';

// Datas fixas (nunca relógio real): âncora = dia da chegada, 15/08/2026 meio-dia local.
const ANCHOR = new Date(2026, 7, 15, 12, 0, 0, 0);

const JOAO: OriginPlayer = { playerName: 'joao', fulls: 50, origins: [{ x: 400, y: 300 }] };

const PAR: SendPair = { originPlayer: JOAO, originCoord: '400|300', targetCoord: '402|303' };

function inputWith(
  travelMinutes: number,
  overrides?: {
    desiredArrival?: SendTimeInput['desiredArrival'];
    baseDate?: Date | undefined;
  },
): SendTimeInput {
  const input: SendTimeInput = {
    desiredArrival: { hour: 22, minute: 0 },
    baseDate: ANCHOR,
    travelMinutesPerPair: () => travelMinutes,
  };
  // Atribuição condicional: com exactOptionalPropertyTypes, NÃO se espalha/atribui
  // "baseDate: undefined" sobre uma propriedade opcional "baseDate?: Date" —
  // remove-se com delete para simular a ausência do campo.
  if (overrides?.desiredArrival !== undefined) input.desiredArrival = overrides.desiredArrival;
  if (overrides && 'baseDate' in overrides) {
    if (overrides.baseDate !== undefined) input.baseDate = overrides.baseDate;
    else delete input.baseDate;
  }
  return input;
}

describe('computeSendTimes', () => {
  it('(a) chegada 22:00 com viagem de 90 min → enviar 20:30:00', () => {
    const [row] = computeSendTimes([PAR], inputWith(90));
    expect(row).toBeDefined();
    expect(row!.nick).toBe('joao');
    expect(row!.originCoord).toBe('400|300');
    expect(row!.targetCoord).toBe('402|303');
    expect(row!.sendAt.getFullYear()).toBe(2026);
    expect(row!.sendAt.getMonth()).toBe(7);
    expect(row!.sendAt.getDate()).toBe(15);
    expect(row!.sendAt.getHours()).toBe(20);
    expect(row!.sendAt.getMinutes()).toBe(30);
    expect(row!.sendAt.getSeconds()).toBe(0);
    expect(row!.travelMinutes).toBe(90);
    expect(formatHms(row!.sendAt)).toBe('20:30:00');
  });

  it('(b) viagem que cruza a meia-noite: chegar 00:30 de D com viagem de 8h → sair 16:30 de D-1', () => {
    const [row] = computeSendTimes(
      [PAR],
      inputWith(480, { desiredArrival: { hour: 0, minute: 30 } }),
    );
    expect(row).toBeDefined();
    // Dia anterior CORRETO no Date — sem "empurrar" para caber no mesmo dia.
    expect(row!.sendAt.getDate()).toBe(14);
    expect(row!.sendAt.getMonth()).toBe(7);
    expect(row!.sendAt.getHours()).toBe(16);
    expect(row!.sendAt.getMinutes()).toBe(30);
    // A linha colável mostra só HH:MM:SS (formato original), aqui 16:30:00.
    expect(formatHms(row!.sendAt)).toBe('16:30:00');
  });

  it('aceita DistributionResult + origens informadas e remonta os pares', () => {
    const result = {
      matrix: [],
      lineTargets: [{ x: 402, y: 303 }],
      assignments: [{ playerName: 'joao', origin: '400|300', target: '402|303' }],
      orphanOrigins: [],
      orphanTargets: [],
    };
    const rows = computeSendTimes(
      { distribution: result, origins: [JOAO] },
      inputWith(60),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetCoord).toBe('402|303');
    expect(rows[0]?.nick).toBe('joao');

    // Fail-closed: assignment de jogador fora da lista INFORMACOES ORIGEM.
    const desconhecido = {
      ...result,
      assignments: [{ playerName: 'maria', origin: '400|300', target: '402|303' }],
    };
    expect(() => computeSendTimes({ distribution: desconhecido, origins: [JOAO] }, inputWith(60)))
      .toThrow(/INFORMACOES ORIGEM/);
  });

  it('valida fail-closed: sem baseDate, horário ilegal ou viagem inválida lançam erro', () => {
    expect(() =>
      computeSendTimes([PAR], inputWith(90, { baseDate: undefined })),
    ).toThrow(/relógio/);
    expect(() =>
      computeSendTimes([PAR], inputWith(90, { desiredArrival: { hour: 24, minute: 0 } })),
    ).toThrow(/Chegada desejada inválida/);
    expect(() =>
      computeSendTimes([PAR], {
        desiredArrival: { hour: 22, minute: 0 },
        baseDate: ANCHOR,
        travelMinutesPerPair: () => Number.NaN,
      }),
    ).toThrow(/Tempo de viagem inválido/);
    expect(() =>
      computeSendTimes([PAR], {
        desiredArrival: { hour: 22, minute: 0 },
        baseDate: ANCHOR,
        travelMinutesPerPair: () => -5,
      }),
    ).toThrow(/Tempo de viagem inválido/);
  });
});

describe('nobleTrain', () => {
  it('(c) 3 nobres com espaçamento de 300s → +0s/+300s/+600s, todos isNoble', () => {
    const base = computeSendTimes([PAR], inputWith(90));
    const train = nobleTrain(base, { noblesPerTarget: 3, spacingSec: 300 });
    expect(train).toHaveLength(3);
    expect(base[0]?.sendAt.getTime()).toBeDefined();
    const firstMs = train[0]?.sendAt.getTime() ?? 0;
    // Mesmíssima origem/alvo em todas as linhas do trem.
    for (const row of train) {
      expect(row.nick).toBe('joao');
      expect(row.originCoord).toBe('400|300');
      expect(row.targetCoord).toBe('402|303');
      expect(row.isNoble).toBe(true);
    }
    expect((train[1]?.sendAt.getTime() ?? 0) - firstMs).toBe(300_000);
    expect((train[2]?.sendAt.getTime() ?? 0) - firstMs).toBe(600_000);
  });

  it('vários alvos: cada linha de agenda vira um trem próprio, na ordem', () => {
    const rows: SendScheduleRow[] = [
      { nick: 'joao', originCoord: '400|300', targetCoord: '402|303', sendAt: ANCHOR, travelMinutes: 60 },
      { nick: 'maria', originCoord: '500|500', targetCoord: '503|502', sendAt: ANCHOR, travelMinutes: 45 },
    ];
    const train = nobleTrain(rows, { noblesPerTarget: 2, spacingSec: 60 });
    expect(train.map((row) => `${row.nick};${row.targetCoord}`)).toEqual([
      'joao;402|303',
      'joao;402|303',
      'maria;503|502',
      'maria;503|502',
    ]);
  });

  it('(d) validações fail-closed em PT-BR', () => {
    const rows: SendScheduleRow[] = [
      { nick: 'joao', originCoord: '400|300', targetCoord: '402|303', sendAt: ANCHOR, travelMinutes: 60 },
    ];
    expect(() => nobleTrain(rows, { noblesPerTarget: 0, spacingSec: 300 })).toThrow(
      /maior ou igual a 1/,
    );
    expect(() => nobleTrain(rows, { noblesPerTarget: -1, spacingSec: 300 })).toThrow(
      /maior ou igual a 1/,
    );
    expect(() => nobleTrain(rows, { noblesPerTarget: 3, spacingSec: -10 })).toThrow(
      /Espaçamento entre nobres inválido/,
    );
    expect(() => nobleTrain([], { noblesPerTarget: 0, spacingSec: 0 })).toThrow();
  });
});

describe('formatSendSchedule', () => {
  it('(e) agrupa por nick e cada linha bate com "nick;ddd|ddd;dd:dd:dd"', () => {
    const rows: SendScheduleRow[] = [
      // Interleave proposital: na saída as linhas de cada nick ficam JUNTAS.
      { nick: 'maria', originCoord: '500|500', targetCoord: '555|444', sendAt: new Date(2026, 7, 15, 21, 10), travelMinutes: 50 },
      { nick: 'joao', originCoord: '400|300', targetCoord: '402|303', sendAt: new Date(2026, 7, 15, 20, 30), travelMinutes: 90 },
      { nick: 'maria', originCoord: '500|501', targetCoord: '512|498', sendAt: new Date(2026, 7, 15, 22, 0), travelMinutes: 0 },
    ];
    const text = formatSendSchedule(rows);
    const lines = text.split('\n');
    // Cabeçalho-comentário com a chegada desejada reconstruída das linhas (22:00).
    expect(lines[0]).toBe('# Chegada desejada: 22:00:00');
    // Agrupado por nick, ordem da 1ª aparição preservada.
    expect(lines.slice(1)).toEqual([
      'maria;555|444;21:10:00',
      'maria;512|498;22:00:00',
      'joao;402|303;20:30:00',
    ]);
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/^[A-Za-zÀ-ÿ0-9_]+;\d{1,3}\|\d{1,3};\d{2}:\d{2}:\d{2}$/);
    }
  });

  it('trem de nobres sai no formato colável com os três horários espaçados', () => {
    const base = computeSendTimes([PAR], inputWith(90));
    const text = formatSendSchedule(nobleTrain(base, { noblesPerTarget: 3, spacingSec: 300 }));
    expect(text.split('\n')).toEqual([
      '# Chegada desejada: 22:00:00',
      'joao;402|303;20:30:00',
      'joao;402|303;20:35:00',
      'joao;402|303;20:40:00',
    ]);
  });

  it('sem linhas não há texto para colar', () => {
    expect(formatSendSchedule([])).toBe('');
  });
});
