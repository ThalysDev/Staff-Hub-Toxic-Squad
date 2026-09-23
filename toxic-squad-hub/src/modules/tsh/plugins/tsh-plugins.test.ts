// Lógica PURA nova dos plugins TSH portados da extensão (ambiente node, sem
// DOM): capa do lote de recrutamento, decodificação/importação do template GC
// e as regras do Agendador (fakes 2%, janela de envio, eventos, matcher da
// confirmação pendente).
import { describe, expect, it } from 'vitest';
import { capRecruitmentBatch } from './recruitment';
import { decodeBuilderImport } from './mega-builder';
import {
  FAKE_LIMIT_FRACTION,
  appendSchedulerEvent,
  commandInSendWindow,
  commandPopulation,
  matchesPendingCommandConfirmation,
  minimumAttackPopulation,
} from './command-scheduler';
import type { HubSchedulerState, ScheduledCommandRecord } from '../../../ext/core/scheduler-state';

describe('capRecruitmentBatch (lote cabível)', () => {
  it('limita o déficit pelo recurso mais escasso (custo cheio lido da tela)', () => {
    expect(
      capRecruitmentBatch(100, { wood: 1000, stone: 90, iron: 100 }, { wood: 50, stone: 30, iron: 10 }),
    ).toBe(3);
    expect(capRecruitmentBatch(7, { wood: 1000, stone: 1000, iron: 1000 }, { wood: 50, stone: 30, iron: 10 })).toBe(7);
  });

  it('custo ilegível = sem capa (comportamento da extensão: déficit cheio)', () => {
    expect(capRecruitmentBatch(80, { wood: 10, stone: 10, iron: 10 }, {})).toBe(80);
    expect(capRecruitmentBatch(80, { wood: 1000, stone: 10, iron: 10 }, { wood: 50 })).toBe(80);
  });

  it('sem recursos não recruta nada (fail-closed)', () => {
    expect(capRecruitmentBatch(50, { wood: 0, stone: 0, iron: 0 }, { wood: 50, stone: 30, iron: 10 })).toBe(0);
  });
});

describe('decodeBuilderImport (template GC)', () => {
  /** Monta um template GC válido no formato byte a byte do codec. */
  function buildGcTemplate(steps: Array<[number, number]>, threshold: number, name: string): string {
    const bytes: number[] = [0, 0];
    for (const [buildingIndex, increment] of steps) bytes.push(buildingIndex, increment);
    // Layout do codec: limiar em markerIndex-2 (um byte de folga antes do
    // marcador de 4 bytes), nome ASCII e trailer de 5 bytes.
    bytes.push(threshold, 0, 0xf4, 0x80, 0x80, 0x80);
    for (const character of name) bytes.push(character.charCodeAt(0));
    bytes.push(0, 0, 0, 0, 0);
    return btoa(bytes.map((byte) => String.fromCharCode(byte)).join(''));
  }

  it('decodifica passos ordenados, nome e limiar de fazenda', () => {
    // 0=main, 18=wall (ordem de byte do jogo); limiar 10.
    const imported = decodeBuilderImport(buildGcTemplate([[0, 5], [18, 10]], 10, 'Aldeia RX'));
    expect(imported).toEqual({
      ok: true,
      steps: [
        { buildingId: 'main', targetLevel: 5 },
        { buildingId: 'wall', targetLevel: 10 },
      ],
      name: 'Aldeia RX',
      threshold: 10,
    });
  });

  it('limiar fora do conjunto permitido volta ao padrão 5', () => {
    const imported = decodeBuilderImport(buildGcTemplate([[0, 3]], 7, 'X'));
    expect(imported.ok && imported.threshold).toBe(5);
  });

  it('rejeita edifícios de igreja (não suportados)', () => {
    // 4=church.
    const imported = decodeBuilderImport(buildGcTemplate([[4, 1]], 10, 'Igreja'));
    expect(!imported.ok && imported.reason).toMatch(/igreja/);
  });

  it('base64 inválido e marcador ausente falham com mensagem pt-BR', () => {
    const invalid = decodeBuilderImport('!!!');
    expect(!invalid.ok && invalid.reason).toMatch(/Base64 válido/);
    const noMarker = btoa([0, 0, 0, 5, 10, 0, 0, 0, 0, 0, 0].map((byte) => String.fromCharCode(byte)).join(''));
    const markerless = decodeBuilderImport(noMarker);
    expect(!markerless.ok && markerless.reason).toMatch(/marcador/);
  });
});

describe('proteção de fakes do Agendador (2% do br142)', () => {
  it('população soma o custo por unidade', () => {
    expect(commandPopulation({ spear: 10, spy: 5, snob: 1 })).toBe(10 + 10 + 100);
    expect(commandPopulation({})).toBe(0);
  });

  it('mínimo = teto de 2% dos pontos do alvo', () => {
    expect(FAKE_LIMIT_FRACTION).toBe(0.02);
    expect(minimumAttackPopulation(4000)).toBe(80);
    expect(minimumAttackPopulation(1)).toBe(1);
    expect(minimumAttackPopulation(0)).toBe(0);
  });
});

describe('commandInSendWindow (focusLead 15s / allowLate 250ms)', () => {
  const window = { focusLeadMs: 15_000, allowLateMs: 250 };
  const at = (offsetMs: number): string => new Date(1_000_000 + offsetMs).toISOString();

  it('aceita dentro da lead e atrasos até allowLate', () => {
    expect(commandInSendWindow({ sendAt: at(10_000) }, 1_000_000, window)).toBe(true);
    expect(commandInSendWindow({ sendAt: at(-100) }, 1_000_000, window)).toBe(true);
  });

  it('rejeita além da lead, atraso maior que allowLate e datas ilegíveis', () => {
    expect(commandInSendWindow({ sendAt: at(20_000) }, 1_000_000, window)).toBe(false);
    expect(commandInSendWindow({ sendAt: at(-300) }, 1_000_000, window)).toBe(false);
    expect(commandInSendWindow({ sendAt: 'não-data' }, 1_000_000, window)).toBe(false);
  });
});

describe('appendSchedulerEvent', () => {
  const command: ScheduledCommandRecord = {
    id: 'cid_1',
    kind: 'attack',
    sourceVillageId: '79788',
    target: { x: 534, y: 551 },
    units: { spear: 100 },
    timingMode: 'send',
    sendAt: '2026-09-21T00:00:00Z',
    paused: false,
    createdAt: '2026-09-20T00:00:00Z',
    events: [{ status: 'agendado', at: '2026-09-20T00:00:00Z' }],
  };
  const state: HubSchedulerState = { commands: [command], transit: [] };

  it('acrescenta o evento ao comando certo sem mutar o estado original', () => {
    const next = appendSchedulerEvent(state, 'cid_1', 'enviado', '2026-09-21T00:00:01Z', 'Envio concluído.');
    expect(next.commands[0]?.events).toHaveLength(2);
    expect(next.commands[0]?.events[1]).toEqual({
      status: 'enviado',
      at: '2026-09-21T00:00:01Z',
      detail: 'Envio concluído.',
    });
    expect(state.commands[0]?.events).toHaveLength(1);
  });

  it('comando ausente mantém o estado intacto', () => {
    expect(appendSchedulerEvent(state, 'cid_2', 'falhou', '2026-09-21T00:00:01Z')).toEqual(state);
  });
});

describe('matchesPendingCommandConfirmation (fail-closed)', () => {
  const expected = { kind: 'attack' as const, target: { x: 534, y: 551 }, units: { spear: 100 } };

  it('casa tipo + alvo + unidades 1:1', () => {
    expect(
      matchesPendingCommandConfirmation({ kind: 'attack', target: { x: 534, y: 551 }, units: { spear: 100 } }, expected),
    ).toBe(true);
  });

  it('rejeita tipo trocado, alvo diferente e unidade diferente', () => {
    expect(
      matchesPendingCommandConfirmation({ kind: 'support', target: { x: 534, y: 551 }, units: { spear: 100 } }, expected),
    ).toBe(false);
    expect(
      matchesPendingCommandConfirmation({ kind: 'attack', target: { x: 1, y: 1 }, units: { spear: 100 } }, expected),
    ).toBe(false);
    expect(
      matchesPendingCommandConfirmation({ kind: 'attack', target: { x: 534, y: 551 }, units: { spear: 99 } }, expected),
    ).toBe(false);
  });

  it('tela ilegível (sem alvo/unidades) nunca casa', () => {
    expect(matchesPendingCommandConfirmation(undefined, expected)).toBe(false);
    expect(matchesPendingCommandConfirmation({ kind: 'attack' }, expected)).toBe(false);
    expect(matchesPendingCommandConfirmation({ kind: 'attack', target: { x: 534, y: 551 } }, expected)).toBe(false);
  });
});
