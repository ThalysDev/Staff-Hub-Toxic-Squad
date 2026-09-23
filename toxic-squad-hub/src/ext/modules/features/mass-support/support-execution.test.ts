import { describe, expect, it } from 'vitest';
import { type PlannedSupportCommand, type SupportUnitAmounts } from './support-planner';
import {
  SUPPORT_COMMAND_ACTION_KIND,
  SUPPORT_SEND_LEAD_MS,
  appendSupportExecution,
  createSupportExecutionLedger,
  hasExecutedSupportCommand,
  isSupportCommandDue,
  listExecutedSupportCommandIds,
  pruneSupportExecutionLedger,
  selectNextSupportCommand,
  supportCommandComparator,
  supportCommandSendAtMs,
  supportExecutionLedgerSchema,
  toSupportCommandAction,
} from './support-execution';

const ALPHA_VILLAGE = 'village_alpha000001';
const BETA_VILLAGE = 'village_beta0000002';

const units = (values: Partial<SupportUnitAmounts> = {}): SupportUnitAmounts => ({
  spear: 0,
  sword: 0,
  archer: 0,
  spy: 0,
  light: 0,
  marcher: 0,
  heavy: 0,
  ...values,
});

const command = (
  overrides: Partial<PlannedSupportCommand> &
    Pick<PlannedSupportCommand, 'id' | 'sourceVillageId' | 'sourceCoordinate' | 'targetCoordinate'>,
): PlannedSupportCommand => ({
  accountId: 'account_masssupport01',
  worldId: 'world_masssupport001',
  units: units(),
  distance: 10,
  durationSeconds: 3600,
  arrivalAt: '1970-01-01T01:00:00.000Z',
  population: 0,
  ...overrides,
});

describe('seleção do próximo comando de apoio', () => {
  it('reproduz a ordem canônica alvo → duração → origem → id', () => {
    const t1 = command({
      id: 'command_0000000000000003',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '100|100',
      targetCoordinate: '10|10',
      durationSeconds: 500,
    });
    const t2 = command({
      id: 'command_0000000000000002',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '100|100',
      targetCoordinate: '10|10',
      durationSeconds: 300,
    });
    const t3 = command({
      id: 'command_0000000000000001',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '090|090',
      targetCoordinate: '10|10',
      durationSeconds: 300,
    });
    const t4 = command({
      id: 'command_0000000000000000',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '090|090',
      targetCoordinate: '10|10',
      durationSeconds: 300,
    });
    const t5 = command({
      id: 'command_0000000000000004',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '0|0',
      targetCoordinate: '20|20',
      durationSeconds: 100,
    });
    const t6 = command({
      id: 'command_0000000000000005',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '0|0',
      targetCoordinate: '50|50',
      durationSeconds: 100,
    });

    expect([t6, t2, t4, t1, t5, t3].sort(supportCommandComparator).map((item) => item.id)).toEqual([
      'command_0000000000000000',
      'command_0000000000000001',
      'command_0000000000000002',
      'command_0000000000000003',
      'command_0000000000000004',
      'command_0000000000000005',
    ]);
  });

  it('escolhe o primeiro da ordem determinística mesmo com entrada embaralhada', () => {
    const t1 = command({
      id: 'command_0000000000000003',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '100|100',
      targetCoordinate: '10|10',
    });
    const t2 = command({
      id: 'command_0000000000000002',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '100|100',
      targetCoordinate: '20|20',
    });
    const t3 = command({
      id: 'command_0000000000000001',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '100|100',
      targetCoordinate: '30|30',
    });
    const scrambled = [t3, t1, t2];

    const result = selectNextSupportCommand(scrambled, { sourceVillageId: ALPHA_VILLAGE, executedCommandIds: [] });

    expect(result.command).toBe(t1);
    expect(result.reason).toBe('Enviar apoio de 100|100 para 10|10 (população 0).');
  });

  it('filtra pela aldeia da aba: comandos de outra aldeia nunca são enviados daqui', () => {
    const alpha = command({
      id: 'command_0000000000000001',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '100|100',
      targetCoordinate: '20|20',
    });
    const beta = command({
      id: 'command_0000000000000002',
      sourceVillageId: BETA_VILLAGE,
      sourceCoordinate: '200|200',
      targetCoordinate: '10|10',
    });

    expect(
      selectNextSupportCommand([beta, alpha], { sourceVillageId: ALPHA_VILLAGE, executedCommandIds: [] }).command,
    ).toBe(alpha);
    expect(
      selectNextSupportCommand([alpha, beta], { sourceVillageId: BETA_VILLAGE, executedCommandIds: [] }).command,
    ).toBe(beta);
  });

  it('pula comandos já executados (dedupe por id canônico) e avança na ordem', () => {
    const t1 = command({
      id: 'command_0000000000000003',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '100|100',
      targetCoordinate: '10|10',
    });
    const t2 = command({
      id: 'command_0000000000000002',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '100|100',
      targetCoordinate: '20|20',
    });
    const t3 = command({
      id: 'command_0000000000000001',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '100|100',
      targetCoordinate: '30|30',
    });
    const commands = [t1, t2, t3];
    const picked: string[] = [];
    let executed: string[] = [];
    while (picked.length < commands.length) {
      const result = selectNextSupportCommand(commands, {
        sourceVillageId: ALPHA_VILLAGE,
        executedCommandIds: executed,
      });
      expect(result.command).not.toBeNull();
      picked.push(result.command!.id);
      executed = [...executed, result.command!.id];
    }
    expect(picked).toEqual(['command_0000000000000003', 'command_0000000000000002', 'command_0000000000000001']);
    const exhausted = selectNextSupportCommand(commands, {
      sourceVillageId: ALPHA_VILLAGE,
      executedCommandIds: executed,
    });
    expect(exhausted.command).toBeNull();
    expect(exhausted.reason).toBe('Todos os comandos planejados já foram enviados.');
  });

  it('razões pt-BR para cada caso vazio, com o dedupe confinado à aldeia da aba', () => {
    const alphaDone = command({
      id: 'command_0000000000000001',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '100|100',
      targetCoordinate: '10|10',
    });
    const beta = command({
      id: 'command_0000000000000002',
      sourceVillageId: BETA_VILLAGE,
      sourceCoordinate: '200|200',
      targetCoordinate: '20|20',
    });

    expect(selectNextSupportCommand([], { sourceVillageId: ALPHA_VILLAGE, executedCommandIds: [] })).toEqual({
      command: null,
      reason: 'Nenhum comando de apoio planejado para esta sessão.',
    });
    // Só comandos de outra aldeia: a Praça da aba atual nunca os enviaria —
    // a razão de ORIGEM precede qualquer dedupe (o pendente do beta não conta).
    expect(selectNextSupportCommand([beta], { sourceVillageId: ALPHA_VILLAGE, executedCommandIds: [] })).toEqual({
      command: null,
      reason: 'Nenhum comando parte desta aldeia.',
    });
    // Todos os comandos DESTA aldeia já foram enviados; o pendente do beta
    // não entra no dedupe nem na seleção.
    expect(
      selectNextSupportCommand([alphaDone, beta], {
        sourceVillageId: ALPHA_VILLAGE,
        executedCommandIds: ['command_0000000000000001'],
      }),
    ).toEqual({
      command: null,
      reason: 'Todos os comandos planejados já foram enviados.',
    });
  });

  it('não muta entradas: ordem original preservada, ids executados intactos e comando devolvido por referência', () => {
    const t1 = command({
      id: 'command_0000000000000003',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '100|100',
      targetCoordinate: '10|10',
    });
    const t2 = command({
      id: 'command_0000000000000002',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '100|100',
      targetCoordinate: '20|20',
    });
    const scrambled = [t2, t1];
    const executed = ['command_0000000000000003'];

    const result = selectNextSupportCommand(scrambled, {
      sourceVillageId: ALPHA_VILLAGE,
      executedCommandIds: executed,
    });

    expect(scrambled).toEqual([t2, t1]);
    expect(executed).toEqual(['command_0000000000000003']);
    expect(result.command).toBe(t2);
  });

  it('com nowMs no contexto, comando de envio futuro fica AGENDADO (sem action) até a janela sendAt − lead', () => {
    // Chegada 02:00:00 com viagem de 3600s → sendAt 01:00:00 (futuro).
    const scheduled = command({
      id: 'command_0000000000000009',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '100|100',
      targetCoordinate: '10|10',
      durationSeconds: 3600,
      arrivalAt: '1970-01-01T02:00:00.000Z',
    });
    const now = Date.parse('1970-01-01T00:30:00.000Z');

    expect(supportCommandSendAtMs(scheduled)).toBe(Date.parse('1970-01-01T01:00:00.000Z'));
    expect(isSupportCommandDue(scheduled, now)).toBe(false);

    const waiting = selectNextSupportCommand([scheduled], {
      sourceVillageId: ALPHA_VILLAGE,
      executedCommandIds: [],
      nowMs: now,
    });
    expect(waiting.command).toBeNull();
    expect(waiting.reason).toContain('Comando agendado');
    expect(waiting.reason).toContain('100|100');
    expect(waiting.reason).toContain('10|10');
    expect(waiting.reason).toContain('1970-01-01T01:00:00.000Z');
    expect(waiting.reason).toContain('1970-01-01T02:00:00.000Z');

    // Dentro da janela (now >= sendAt − lead): vira action normalmente.
    const dueNow = Date.parse('1970-01-01T01:00:00.000Z') - SUPPORT_SEND_LEAD_MS;
    expect(isSupportCommandDue(scheduled, dueNow)).toBe(true);
    const due = selectNextSupportCommand([scheduled], {
      sourceVillageId: ALPHA_VILLAGE,
      executedCommandIds: [],
      nowMs: dueNow,
    });
    expect(due.command).toBe(scheduled);

    // Sem nowMs (prévia): todos os comandos seguem elegíveis.
    expect(
      selectNextSupportCommand([scheduled], { sourceVillageId: ALPHA_VILLAGE, executedCommandIds: [] }).command,
    ).toBe(scheduled);
  });

  it('agendado e imediato convivem: o imediato é enviado agora, o agendado espera', () => {
    const scheduled = command({
      id: 'command_0000000000000008',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '100|100',
      targetCoordinate: '30|30',
      durationSeconds: 3600,
      arrivalAt: '1970-01-01T02:00:00.000Z',
    });
    const immediate = command({
      id: 'command_0000000000000007',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '100|100',
      targetCoordinate: '20|20',
      durationSeconds: 600,
      arrivalAt: '1970-01-01T00:10:00.000Z',
    });
    const now = Date.parse('1970-01-01T00:00:00.000Z');

    const picked = selectNextSupportCommand([scheduled, immediate], {
      sourceVillageId: ALPHA_VILLAGE,
      executedCommandIds: [],
      nowMs: now,
    });

    expect(picked.command).toBe(immediate);

    const onlyScheduledLeft = selectNextSupportCommand([scheduled, immediate], {
      sourceVillageId: ALPHA_VILLAGE,
      executedCommandIds: ['command_0000000000000007'],
      nowMs: now,
    });
    expect(onlyScheduledLeft.command).toBeNull();
    expect(onlyScheduledLeft.reason).toContain('Comando agendado');
  });
});

describe('mapeamento para a action certificada do Agendador', () => {
  it('vetor dourado: payload exato com coordenadas numéricas e zero-fill das 7 unidades', () => {
    const action = toSupportCommandAction(
      command({
        id: 'command_0123456789abcdef',
        sourceVillageId: ALPHA_VILLAGE,
        sourceCoordinate: '300|300',
        targetCoordinate: '534|552',
        units: units({ spear: 100, light: 40, heavy: 25 }),
      }),
    );

    expect(action).toEqual({
      kind: SUPPORT_COMMAND_ACTION_KIND,
      payload: {
        commandId: 'command_0123456789abcdef',
        kind: 'support',
        target: { x: 534, y: 552 },
        units: { spear: 100, sword: 0, archer: 0, spy: 0, light: 40, marcher: 0, heavy: 25 },
      },
    });
    expect(action.kind).toBe('command-scheduler');
  });

  it('coordenada 0|0 e unidades ausentes viram zeros; frações são truncadas', () => {
    const action = toSupportCommandAction(
      command({
        id: 'command_0000000000000001',
        sourceVillageId: ALPHA_VILLAGE,
        sourceCoordinate: '0|0',
        targetCoordinate: '0|0',
        units: units({ spear: 12.9, spy: -3 }),
      }),
    );

    expect(action.payload.target).toEqual({ x: 0, y: 0 });
    expect(action.payload.units).toEqual(units({ spear: 12, spy: 0 }));
  });

  it('coordenada inválida ou fora do domínio do planner falha fechado (TypeError)', () => {
    const base = { sourceVillageId: ALPHA_VILLAGE, sourceCoordinate: '100|100' };
    expect(() =>
      toSupportCommandAction(command({ id: 'command_0000000000000001', ...base, targetCoordinate: 'abc|12' })),
    ).toThrow(TypeError);
    expect(() =>
      toSupportCommandAction(command({ id: 'command_0000000000000001', ...base, targetCoordinate: '534' })),
    ).toThrow(TypeError);
    expect(() =>
      toSupportCommandAction(command({ id: 'command_0000000000000001', ...base, targetCoordinate: '534|-12' })),
    ).toThrow(TypeError);
    expect(() =>
      toSupportCommandAction(command({ id: 'command_0000000000000001', ...base, targetCoordinate: '534|1200' })),
    ).toThrow(TypeError);
  });

  it('não muta o comando de entrada e congela a action em profundidade', () => {
    const input = command({
      id: 'command_0000000000000001',
      sourceVillageId: ALPHA_VILLAGE,
      sourceCoordinate: '300|300',
      targetCoordinate: '534|552',
      units: units({ light: 40 }),
    });
    const snapshot = { ...input, units: { ...input.units } };

    const action = toSupportCommandAction(input);

    expect(input).toEqual(snapshot);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(action)).toBe(true);
    expect(Object.isFrozen(action.payload)).toBe(true);
    expect(Object.isFrozen(action.payload.units)).toBe(true);
  });
});

describe('livro-razão de execução', () => {
  const WORLD_A = 'world_masssupport001';
  const WORLD_B = 'world_masssupport002';
  const idA = 'command_000000000000000a';
  const idB = 'command_000000000000000b';
  const idC = 'command_000000000000000c';

  it('cria livro-razão vazio, congelado e com versão canônica', () => {
    const ledger = createSupportExecutionLedger();
    expect(ledger).toEqual({ version: 1, worlds: {} });
    expect(Object.isFrozen(ledger)).toBe(true);
  });

  it('append registra por mundo, ordena por executedAt com desempate por id e é idempotente', () => {
    const ledger = createSupportExecutionLedger();
    const first = appendSupportExecution(ledger, {
      worldId: WORLD_A,
      commandId: idB,
      executedAt: '2026-08-15T00:10:00.000Z',
    });
    const second = appendSupportExecution(first, {
      worldId: WORLD_A,
      commandId: idA,
      executedAt: '2026-08-15T00:05:00.000Z',
    });
    const third = appendSupportExecution(second, {
      worldId: WORLD_A,
      commandId: idC,
      executedAt: '2026-08-15T00:05:00.000Z',
    });
    const duplicate = appendSupportExecution(third, {
      worldId: WORLD_A,
      commandId: idB,
      executedAt: '2026-08-15T00:10:00.000Z',
    });

    expect(third.worlds[WORLD_A]?.map((entry) => entry.commandId)).toEqual([idA, idC, idB]);
    expect(duplicate).toEqual(third);
    // Outro mundo não é tocado.
    const otherWorld = appendSupportExecution(third, {
      worldId: WORLD_B,
      commandId: idB,
      executedAt: '2026-08-15T00:20:00.000Z',
    });
    expect(otherWorld.worlds[WORLD_A]).toEqual(third.worlds[WORLD_A]);
    expect(Object.isFrozen(third.worlds[WORLD_A]![0])).toBe(true);
  });

  it('query por mundo: has e list sem vazamento entre mundos', () => {
    const ledger = appendSupportExecution(
      appendSupportExecution(createSupportExecutionLedger(), {
        worldId: WORLD_A,
        commandId: idB,
        executedAt: '2026-08-15T00:10:00.000Z',
      }),
      { worldId: WORLD_A, commandId: idA, executedAt: '2026-08-15T00:05:00.000Z' },
    );

    expect(hasExecutedSupportCommand(ledger, WORLD_A, idA)).toBe(true);
    expect(hasExecutedSupportCommand(ledger, WORLD_A, idB)).toBe(true);
    expect(hasExecutedSupportCommand(ledger, WORLD_A, idC)).toBe(false);
    expect(hasExecutedSupportCommand(ledger, WORLD_B, idA)).toBe(false);
    expect(listExecutedSupportCommandIds(ledger, WORLD_A)).toEqual([idA, idB]);
    expect(listExecutedSupportCommandIds(ledger, WORLD_B)).toEqual([]);
    expect(Object.isFrozen(listExecutedSupportCommandIds(ledger, WORLD_A))).toBe(true);
  });

  it('poda por retenção e teto por mundo, removendo mundos vazios, sem mutar a entrada', () => {
    const now = '2026-08-15T12:00:00.000Z';
    const ledger = appendSupportExecution(
      appendSupportExecution(
        appendSupportExecution(createSupportExecutionLedger(), {
          worldId: WORLD_A,
          commandId: idA,
          executedAt: '2026-08-15T11:50:00.000Z',
        }),
        { worldId: WORLD_A, commandId: idB, executedAt: '2026-08-15T11:00:00.000Z' },
      ),
      { worldId: WORLD_A, commandId: idC, executedAt: '2026-08-15T10:00:00.000Z' },
    );

    // 90 minutos de retenção: cai apenas o mais antigo (10:00).
    const byAge = pruneSupportExecutionLedger(ledger, { now, retentionMs: 90 * 60 * 1000 });
    expect(byAge.worlds[WORLD_A]?.map((entry) => entry.commandId)).toEqual([idB, idA]);
    // Teto de 1 com retenção ampla: mantém só o mais recente (11:50).
    const byCap = pruneSupportExecutionLedger(ledger, { now, retentionMs: 3 * 60 * 60 * 1000, maxEntriesPerWorld: 1 });
    expect(byCap.worlds[WORLD_A]?.map((entry) => entry.commandId)).toEqual([idA]);
    // Teto 0 esvazia o mundo e ele some do livro-razão.
    const zeroCap = pruneSupportExecutionLedger(ledger, {
      now,
      retentionMs: 3 * 60 * 60 * 1000,
      maxEntriesPerWorld: 0,
    });
    expect(zeroCap.worlds[WORLD_A]).toBeUndefined();
    expect(ledger.worlds[WORLD_A]).toHaveLength(3);
  });

  it('persistência: shape JSON puro sobrevive a round-trip e reparse do schema', () => {
    const ledger = appendSupportExecution(
      appendSupportExecution(createSupportExecutionLedger(), {
        worldId: WORLD_A,
        commandId: idB,
        executedAt: '2026-08-15T00:10:00.000Z',
      }),
      { worldId: WORLD_B, commandId: idC, executedAt: '2026-08-15T00:05:00.000Z' },
    );

    const roundTrip = supportExecutionLedgerSchema.parse(JSON.parse(JSON.stringify(ledger)));
    expect(roundTrip).toEqual(ledger);
  });

  it('entrada inválida falha fechado: id não canônico, timestamp inválido, estado corrompido', () => {
    expect(() =>
      appendSupportExecution(createSupportExecutionLedger(), {
        worldId: WORLD_A,
        commandId: 'nope',
        executedAt: '2026-08-15T00:00:00.000Z',
      }),
    ).toThrow();
    expect(() =>
      appendSupportExecution(createSupportExecutionLedger(), { worldId: WORLD_A, commandId: idA, executedAt: 'ontem' }),
    ).toThrow();
    expect(() =>
      appendSupportExecution({ version: 2, worlds: {} } as unknown as ReturnType<typeof createSupportExecutionLedger>, {
        worldId: WORLD_A,
        commandId: idA,
        executedAt: '2026-08-15T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('poda com now inválido ou retenção negativa falha fechado', () => {
    const ledger = createSupportExecutionLedger();
    expect(() => pruneSupportExecutionLedger(ledger, { now: 'nope', retentionMs: 1000 })).toThrow(TypeError);
    expect(() => pruneSupportExecutionLedger(ledger, { now: '2026-08-15T12:00:00.000Z', retentionMs: -1 })).toThrow(
      TypeError,
    );
  });
});
