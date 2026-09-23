import { describe, expect, it } from 'vitest';
import { createWorldState, normalizeWorldState, setModuleSettings, type HubWorldState } from './state/hub-state';
import {
  activeSchedulerCommandRecords,
  CATAPULT_TARGETS,
  deriveSchedulerCommandStatus,
  mergeSchedulerTransit,
  migrateLegacySchedulerCommands,
  parseSchedulerCommandRecord,
  recordSchedulerCommandEvent,
  removeSchedulerCommand,
  SCHEDULER_CANCEL_COUNTS,
  SCHEDULER_DEFAULT_WINDOW,
  schedulerMotorCommands,
  setSchedulerCommandPaused,
  upsertSchedulerCommand,
  type HubSchedulerState,
  type ScheduledCommandRecord,
} from './scheduler-state';

const now = new Date('2026-08-20T20:00:00.000Z');

function command(overrides: Partial<ScheduledCommandRecord> = {}): ScheduledCommandRecord {
  return {
    id: 'cid_0000000000000001',
    kind: 'attack',
    sourceVillageId: '238755',
    source: { x: 498, y: 501 },
    target: { x: 500, y: 500 },
    units: { spear: 250 },
    timingMode: 'send',
    sendAt: '2026-08-20T20:39:23.000Z',
    arrivalAt: '2026-08-20T21:04:41.000Z',
    paused: false,
    createdAt: now.toISOString(),
    events: [{ status: 'agendado', at: now.toISOString() }],
    ...overrides,
  };
}

function stateWith(settingsCommands: unknown[], villageCoords?: { x: number; y: number }): HubWorldState {
  let state = createWorldState({ worldId: 'br142', worldLabel: 'Mundo 142', playerName: 'Toxic' });
  state = setModuleSettings(state, 'command-scheduler', { commands: settingsCommands });
  if (villageCoords) {
    state.villageSnapshots = { '238755': { x: villageCoords.x, y: villageCoords.y, updatedAt: now.toISOString() } };
  }
  return state;
}

describe('estado do Agendador — upsert/remove/pausa', () => {
  it('upsert cria comando com evento agendado e atualiza preservando createdAt e eventos', () => {
    const base = createWorldState({ worldId: 'br142', worldLabel: 'Mundo 142', playerName: 'Toxic' });
    const created = upsertSchedulerCommand(base, command(), now);
    expect(created.scheduler?.commands).toHaveLength(1);
    expect(created.scheduler?.commands[0]?.events).toEqual([{ status: 'agendado', at: now.toISOString() }]);

    const later = new Date('2026-08-20T20:10:00.000Z');
    const updated = upsertSchedulerCommand(created, command({ units: { spear: 300 }, events: [] }), later);
    const stored = updated.scheduler?.commands[0];
    expect(stored?.units).toEqual({ spear: 300 });
    expect(stored?.createdAt).toBe(now.toISOString());
    expect(stored?.events).toHaveLength(1);
  });

  it('remove apaga o comando do vetor; pausar/retomar alterna o campo paused', () => {
    const base = upsertSchedulerCommand(
      createWorldState({ worldId: 'br142', worldLabel: 'Mundo 142', playerName: 'Toxic' }),
      command(),
      now,
    );
    const paused = setSchedulerCommandPaused(base, 'cid_0000000000000001', true, now);
    expect(paused.scheduler?.commands[0]?.paused).toBe(true);
    const resumed = setSchedulerCommandPaused(paused, 'cid_0000000000000001', false, now);
    expect(resumed.scheduler?.commands[0]?.paused).toBe(false);
    const removed = removeSchedulerCommand(resumed, 'cid_0000000000000001', now);
    expect(removed.scheduler?.commands).toHaveLength(0);
  });

  it('transições do motor persistem fatos terminais (enviado/incerto) que o relógio nunca reverte', () => {
    let state = upsertSchedulerCommand(
      createWorldState({ worldId: 'br142', worldLabel: 'Mundo 142', playerName: 'Toxic' }),
      command(),
      now,
    );
    state = recordSchedulerCommandEvent(
      state,
      'cid_0000000000000001',
      { status: 'incerto', detail: 'Confirmação pendente.' },
      now,
    );
    // Muito depois da janela: o fato persistido vence a derivação por relógio.
    const late = new Date('2026-08-21T02:00:00.000Z');
    expect(
      deriveSchedulerCommandStatus(state.scheduler!.commands[0]!, late, { focusLeadMs: 15_000, allowLateMs: 250 }),
    ).toBe('incerto');
    // Id de outro módulo (ex. Apoio em Massa) é no-op.
    expect(recordSchedulerCommandEvent(state, 'command_abc', { status: 'enviado' }, now)).toBe(state);
  });

  it('derivação por relógio: agendado → janela (sendAt − focusLead) → falhou (sendAt + allowLate)', () => {
    const at = (iso: string) =>
      deriveSchedulerCommandStatus(command(), new Date(iso), { focusLeadMs: 15_000, allowLateMs: 250 });
    expect(at('2026-08-20T20:10:00.000Z')).toBe('agendado');
    expect(at('2026-08-20T20:39:10.000Z')).toBe('janela');
    expect(at('2026-08-20T20:40:00.000Z')).toBe('falhou');
    // Pausado vence tudo (antes de janela).
    expect(
      deriveSchedulerCommandStatus(command({ paused: true }), new Date('2026-08-20T20:39:10.000Z'), {
        focusLeadMs: 15_000,
        allowLateMs: 250,
      }),
    ).toBe('pausado');
  });

  it('mergeSchedulerTransit: a leitura fresca substitui a anterior por completo', () => {
    const base = mergeSchedulerTransit(
      createWorldState({ worldId: 'br142', worldLabel: 'Mundo 142', playerName: 'Toxic' }),
      [{ commandId: '111', type: 'attack', readAt: now.toISOString() }],
      now,
    );
    const refreshed = mergeSchedulerTransit(base, [], new Date('2026-08-20T20:05:00.000Z'));
    expect(refreshed.scheduler?.transit).toEqual([]);
  });
});

describe('validação do registro na fronteira do upsert (schema zod)', () => {
  it('registro válido passa com defaults sensíveis onde o contrato permite (timingMode/paused)', () => {
    const parsed = parseSchedulerCommandRecord(command());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.id).toBe('cid_0000000000000001');
    // Defaults: timingMode 'send' e paused false quando ausentes.
    const { timingMode: _t, paused: _p, ...minimal } = command();
    const defaulted = parseSchedulerCommandRecord({ ...minimal, sendAt: '2026-08-20T21:00:00.000Z' });
    expect(defaulted.ok).toBe(true);
    if (defaulted.ok) {
      expect(defaulted.record.timingMode).toBe('send');
      expect(defaulted.record.paused).toBe(false);
    }
  });

  it('sem events, sendAt ilegível, unidade desconhecida ou quantidade inválida rejeitam com campos em pt-BR', () => {
    const { events: _events, ...withoutEvents } = command();
    const noEvents = parseSchedulerCommandRecord(withoutEvents);
    expect(noEvents.ok).toBe(false);
    if (!noEvents.ok) expect(noEvents.message).toContain('eventos');

    const badSendAt = parseSchedulerCommandRecord({ ...command(), sendAt: 'amanhã' });
    expect(badSendAt.ok).toBe(false);
    if (!badSendAt.ok) expect(badSendAt.message).toContain('horário de envio');

    // Unidade fora do elenco do jogo (typo de UI) nunca é gravada.
    const unknownUnit = parseSchedulerCommandRecord({ ...command(), units: { spiar: 5 } });
    expect(unknownUnit.ok).toBe(false);

    // Quantidade inválida (0/negativo/fracionário) idem — o matcher do motor
    // compara 1:1 com a tela.
    const badAmount = parseSchedulerCommandRecord({ ...command(), units: { spy: 0 } });
    expect(badAmount.ok).toBe(false);

    // Alvo fora do tabuleiro é recusado na fronteira, não no motor.
    const offMap = parseSchedulerCommandRecord({ ...command(), target: { x: 1200, y: 500 } });
    expect(offMap.ok).toBe(false);
  });
});

describe('migração única de settings.commands', () => {
  const legacyCommand = {
    id: 'cmd-legado-1',
    kind: 'attack',
    sourceVillageId: '238755',
    target: { x: 500, y: 500 },
    sendAt: '2026-08-20T21:00:00.000Z',
    units: { spear: 250, ram: 20 },
    targetPoints: 50_200,
  };

  it('normalizeWorldState copia os comandos legados para o estado novo exatamente uma vez', () => {
    const state = stateWith([legacyCommand], { x: 498, y: 501 });
    const first = normalizeWorldState(state);
    const migrated = first.scheduler?.commands.find((candidate) => candidate.id === 'cmd-legado-1');
    expect(migrated).toMatchObject({
      kind: 'attack',
      sourceVillageId: '238755',
      source: { x: 498, y: 501 },
      target: { x: 500, y: 500 },
      units: { spear: 250, ram: 20 },
      targetPoints: 50_200,
      timingMode: 'send',
      paused: false,
    });
    expect(migrated?.arrivalAt).toBeUndefined();
    // Os settings legados NÃO são apagados (higiene de storage apenas) — a
    // fonte única do motor é o state.scheduler, com dedupe por id.
    expect(first.modules['command-scheduler'].settings.commands).toHaveLength(1);

    // Segunda passada (qualquer mensagem futura): idempotente — remover do
    // estado novo não ressuscita o legado.
    const removed = removeSchedulerCommand(first, 'cmd-legado-1', now);
    const renormalized = normalizeWorldState(removed);
    expect(renormalized.scheduler?.commands.find((candidate) => candidate.id === 'cmd-legado-1')).toBeUndefined();
  });

  it('migração sem coordenada da origem segue honesta: source ausente, envio intacto', () => {
    const migrated = migrateLegacySchedulerCommands(stateWith([legacyCommand]));
    const record = migrated.scheduler?.commands[0];
    expect(record?.source).toBeUndefined();
    expect(record?.sendAt).toBe('2026-08-20T21:00:00.000Z');
  });

  it('comandos legados inválidos (id vazio, kind estranho, sendAt ilegível) são ignorados', () => {
    const migrated = migrateLegacySchedulerCommands(
      stateWith([
        { ...legacyCommand, id: '' },
        { ...legacyCommand, id: 'x2', kind: 'siege' },
        { ...legacyCommand, id: 'x3', sendAt: 'not-a-date' },
        { ...legacyCommand, id: 'x4', target: { x: -5, y: 0 } },
        'não-objeto',
      ]),
    );
    expect(migrated.scheduler?.commands).toHaveLength(0);
    // Flag gravada mesmo assim: mundos sem legado válido não reavaliam.
    expect(migrated.scheduler?.legacyMigratedAt).toBeDefined();
  });

  it('mundos sem comandos legados ganham o slot vazio com a flag de migração', () => {
    const normalized = normalizeWorldState(
      createWorldState({ worldId: 'br142', worldLabel: 'Mundo 142', playerName: 'Toxic' }),
    );
    expect(normalized.scheduler).toMatchObject({ commands: [], transit: [] });
    expect(normalized.scheduler?.legacyMigratedAt).toBeDefined();
  });
});

describe('fonte única do motor (Onda 3)', () => {
  it('comandos do snapshot da página seguem aceitos, com dedupe por id contra o estado novo', () => {
    const scheduler: HubSchedulerState = {
      commands: [command()],
      transit: [],
      legacyMigratedAt: now.toISOString(),
    };
    const state = {
      ...createWorldState({ worldId: 'br142', worldLabel: 'Mundo 142', playerName: 'Toxic' }),
      scheduler,
    };
    const page = [
      { ...command(), units: { spear: 999 } }, // mesmo id: cópia do snapshot perde
      { ...command(), id: 'cid_page_only', sendAt: '2026-08-20T22:00:00.000Z' }, // id desconhecido dispara
    ];
    const merged = schedulerMotorCommands(state, page, now);
    expect(merged).toHaveLength(2);
    expect(merged.find((candidate) => candidate.id === 'cid_0000000000000001')?.units).toEqual({ spear: 250 });
    expect(merged.find((candidate) => candidate.id === 'cid_page_only')).toBeDefined();
  });

  it('comando pausado ou terminal no estado novo NÃO é ressuscitado pela cópia do snapshot', () => {
    const buildState = (record: ScheduledCommandRecord): HubWorldState => ({
      ...createWorldState({ worldId: 'br142', worldLabel: 'Mundo 142', playerName: 'Toxic' }),
      scheduler: { commands: [record], transit: [] },
    });
    const page = [{ ...command() }];
    const paused = schedulerMotorCommands(buildState(command({ paused: true })), page, now);
    expect(paused).toHaveLength(0);
    const sent = schedulerMotorCommands(
      buildState(command({ events: [{ status: 'enviado', at: now.toISOString() }] })),
      page,
      now,
    );
    expect(sent).toHaveLength(0);
    const failedByClock = schedulerMotorCommands(
      buildState(command({ sendAt: '2026-08-20T18:00:00.000Z' })),
      page,
      new Date('2026-08-20T20:00:00.000Z'),
    );
    expect(failedByClock).toHaveLength(0);
  });

  it('activeSchedulerCommandRecords lista só comandos ativos (agendado/janela)', () => {
    const records: HubSchedulerState = {
      commands: [
        command({ id: 'a' }),
        command({ id: 'b', paused: true }),
        command({ id: 'c', events: [{ status: 'incerto', at: now.toISOString() }] }),
      ],
      transit: [],
    };
    expect(activeSchedulerCommandRecords(records, now).map((record) => record.id)).toEqual(['a']);
  });

  it('a janela da derivação vem dos settings do módulo (allowLateMs custom estende a vida do comando)', () => {
    // sendAt 20:39:23; now 20:39:40 (17s depois). Default (250ms) → falhou.
    const state = {
      ...createWorldState({ worldId: 'br142', worldLabel: 'Mundo 142', playerName: 'Toxic' }),
      scheduler: { commands: [command()], transit: [] },
    };
    const at = new Date('2026-08-20T20:39:40.000Z');
    expect(schedulerMotorCommands(state, [], at)).toHaveLength(0);
    // Com allowLateMs=30s (settings do módulo), o comando segue ativo.
    expect(schedulerMotorCommands(state, [], at, { focusLeadMs: 15_000, allowLateMs: 30_000 })).toHaveLength(1);
  });

  it('settings.commands legados NÃO alimentam mais o motor — estado novo é a fonte única', () => {
    // Mundo com comandos legados nos settings mas SEM slot do estado novo
    // (normalização pré-Onda): nada dispara até normalizeWorldState migrar.
    const raw = stateWith([command()]);
    expect(schedulerMotorCommands(raw, [], now)).toHaveLength(0);
    const normalized = normalizeWorldState(raw);
    expect(schedulerMotorCommands(normalized, [], now)).toHaveLength(1);
  });
});

describe('Onda 1 — cancelamento, sequencial, snipe/dodge, forçar, catapulta e percentual', () => {
  it('kind=cancel com cancelCount faz roundtrip (todas as quantidades canônicas passam)', () => {
    for (const cancelCount of SCHEDULER_CANCEL_COUNTS) {
      const parsed = parseSchedulerCommandRecord(command({ kind: 'cancel', cancelCount }));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.record.kind).toBe('cancel');
      expect(parsed.record.cancelCount).toBe(cancelCount);
      expect(parsed.record.units).toEqual({ spear: 250 });
    }
  });

  it('cancelCount fora da lista canônica (21, 6, 0, fracionário) é recusado na fronteira', () => {
    // 6 está na faixa 1..20 mas NÃO é quantidade canônica: a lista manda.
    for (const cancelCount of [21, 6, 0, 2.5]) {
      const parsed = parseSchedulerCommandRecord(command({ kind: 'cancel', cancelCount }));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toContain('quantidade de cancelamentos');
    }
  });

  it('cancelCount em comando que não é cancelar é recusado (campo não vaza para outros kinds)', () => {
    const parsed = parseSchedulerCommandRecord(command({ kind: 'attack', cancelCount: 5 }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain('quantidade de cancelamentos');
    // kind=cancel SEM cancelCount segue aceito (o formulário pode não ter escolhido a quantidade).
    expect(parseSchedulerCommandRecord(command({ kind: 'cancel' })).ok).toBe(true);
  });

  it('registro ANTIGO (pré-Onda 1, fixture mínima) continua parseando e sem campos novos', () => {
    const legacy = {
      id: 'cid_legacy_0001',
      kind: 'attack',
      sourceVillageId: '238755',
      target: { x: 500, y: 500 },
      units: { spear: 250 },
      sendAt: '2026-08-20T20:39:23.000Z',
      createdAt: now.toISOString(),
      events: [],
    };
    const parsed = parseSchedulerCommandRecord(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Defaults antigos intactos.
    expect(parsed.record.timingMode).toBe('send');
    expect(parsed.record.paused).toBe(false);
    // Campos da Onda 1 ausentes — nada é inventado no registro antigo.
    expect(parsed.record.cancelCount).toBeUndefined();
    expect(parsed.record.sequentialCount).toBeUndefined();
    expect(parsed.record.timingStrategy).toBeUndefined();
    expect(parsed.record.forced).toBeUndefined();
    expect(parsed.record.catapultTarget).toBeUndefined();
    expect(parsed.record.percentMode).toBeUndefined();
    expect(parsed.record.unitsPercent).toBeUndefined();
    expect(Object.keys(parsed.record)).not.toContain('timingStrategy');
  });

  it('catapultTarget aceita só as chaves do jogo ("" = Padrão) e recusa alvo inventado', () => {
    for (const catapultTarget of ['', 'wall', 'smith', 'garbage'] as const) {
      const parsed = parseSchedulerCommandRecord(command({ catapultTarget }));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.record.catapultTarget).toBe(catapultTarget);
    }
    const invalid = parseSchedulerCommandRecord(command({ catapultTarget: 'townhall' }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.message).toContain('alvo da catapulta');
  });

  it('percentMode com unitsPercent 50 guarda o percentual; 150/negativo/tropa estranha recusam', () => {
    const parsed = parseSchedulerCommandRecord(
      command({ percentMode: true, unitsPercent: { spear: 50, ram: 100 } }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.percentMode).toBe(true);
    expect(parsed.record.unitsPercent).toEqual({ spear: 50, ram: 100 });

    const over = parseSchedulerCommandRecord(command({ percentMode: true, unitsPercent: { spear: 150 } }));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.message).toContain('percentual de tropas');

    const negative = parseSchedulerCommandRecord(command({ percentMode: true, unitsPercent: { spear: -1 } }));
    expect(negative.ok).toBe(false);

    // Tropa fora do elenco do jogo (typo de UI) nunca é gravada — igual ao `units`.
    const unknownUnit = parseSchedulerCommandRecord(command({ percentMode: true, unitsPercent: { spiar: 50 } }));
    expect(unknownUnit.ok).toBe(false);
    if (!unknownUnit.ok) expect(unknownUnit.message).toContain('percentual de tropas');
  });

  it('sequentialCount aceita os limites 1..20 e recusa 0/21/fracionário', () => {
    for (const sequentialCount of [1, 20]) {
      const parsed = parseSchedulerCommandRecord(command({ sequentialCount }));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.record.sequentialCount).toBe(sequentialCount);
    }
    for (const sequentialCount of [0, 21, 2.5]) {
      const parsed = parseSchedulerCommandRecord(command({ sequentialCount }));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toContain('repetições do comando');
    }
  });

  it('estratégia de envio: direto/snipe/dodge passam, valor estranho recusa (timingMode legado intacto)', () => {
    for (const timingStrategy of ['direto', 'snipe', 'dodge'] as const) {
      const parsed = parseSchedulerCommandRecord(command({ timingStrategy }));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.record.timingStrategy).toBe(timingStrategy);
    }
    const invalid = parseSchedulerCommandRecord({ ...command(), timingStrategy: 'turbo' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.message).toContain('estratégia de envio');

    // O `timingMode` antigo (QUAL horário o operador digitou) segue só arrival/send.
    const legacyField = parseSchedulerCommandRecord({ ...command(), timingMode: 'snipe' });
    expect(legacyField.ok).toBe(false);
    if (!legacyField.ok) expect(legacyField.message).toContain('modo de horário');
  });

  it('forced flag faz roundtrip (ausente = não forçado) e valor não-booleano recusa', () => {
    const forced = parseSchedulerCommandRecord(command({ forced: true }));
    expect(forced.ok).toBe(true);
    if (forced.ok) expect(forced.record.forced).toBe(true);

    const absent = parseSchedulerCommandRecord(command());
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.record.forced).toBeUndefined();

    const invalid = parseSchedulerCommandRecord({ ...command(), forced: 'sim' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.message).toContain('forçar envio');
  });

  it('registro completo da Onda 1 sobrevive ao JSON da persistência (roundtrip de tudo junto)', () => {
    const full = command({
      sequentialCount: 3,
      forced: true,
      catapultTarget: 'smith',
      percentMode: true,
      unitsPercent: { catapult: 100 },
      timingStrategy: 'dodge',
    });
    const parsed = parseSchedulerCommandRecord(full);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const state = upsertSchedulerCommand(
      createWorldState({ worldId: 'br142', worldLabel: 'Mundo 142', playerName: 'Toxic' }),
      parsed.record,
      now,
    );
    const persisted: unknown = JSON.parse(JSON.stringify(state.scheduler?.commands[0]));
    const reparsed = parseSchedulerCommandRecord(persisted);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.record).toMatchObject({
      sequentialCount: 3,
      forced: true,
      catapultTarget: 'smith',
      percentMode: true,
      unitsPercent: { catapult: 100 },
      timingStrategy: 'dodge',
      timingMode: 'send',
    });
  });

  it('kind=cancel segue o MESMO fluxo de janela/envio dos outros kinds (motor e derivação)', () => {
    const parsed = parseSchedulerCommandRecord(command({ kind: 'cancel', cancelCount: 3, timingStrategy: 'snipe' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const record = parsed.record;
    const state: HubWorldState = {
      ...createWorldState({ worldId: 'br142', worldLabel: 'Mundo 142', playerName: 'Toxic' }),
      scheduler: { commands: [record], transit: [] },
    };
    expect(activeSchedulerCommandRecords(state.scheduler, now).map((candidate) => candidate.id)).toEqual([record.id]);
    expect(deriveSchedulerCommandStatus(record, new Date('2026-08-20T20:10:00.000Z'), SCHEDULER_DEFAULT_WINDOW)).toBe(
      'agendado',
    );
    expect(deriveSchedulerCommandStatus(record, new Date('2026-08-20T20:39:10.000Z'), SCHEDULER_DEFAULT_WINDOW)).toBe(
      'janela',
    );
    expect(deriveSchedulerCommandStatus(record, new Date('2026-08-20T20:40:00.000Z'), SCHEDULER_DEFAULT_WINDOW)).toBe(
      'falhou',
    );

    const motor = schedulerMotorCommands(state, [], now);
    expect(motor).toHaveLength(1);
    expect(motor[0]).toMatchObject({ id: record.id, kind: 'cancel', sendAt: record.sendAt });

    // Pausar e o fato terminal valem para cancel como para qualquer outro kind.
    const paused = setSchedulerCommandPaused(state, record.id, true, now);
    expect(schedulerMotorCommands(paused, [], now)).toHaveLength(0);
    const sent = recordSchedulerCommandEvent(state, record.id, { status: 'enviado' }, now);
    expect(schedulerMotorCommands(sent, [], new Date('2026-08-20T20:39:30.000Z'))).toHaveLength(0);
  });

  it('vocabulário exportado: 12 alvos de catapulta + Padrão e a lista canônica de cancelamentos', () => {
    expect(Object.keys(CATAPULT_TARGETS)).toEqual([
      '',
      'main',
      'snob',
      'storage',
      'wood',
      'stable',
      'statue',
      'farm',
      'smith',
      'market',
      'iron',
      'wall',
      'garbage',
    ]);
    expect(Object.values(CATAPULT_TARGETS)).toEqual([
      'Padrão',
      'Edifício Principal',
      'Academia',
      'Armazém',
      'Bosque',
      'Estábulo',
      'Estátua',
      'Fazenda',
      'Ferreiro',
      'Mercado',
      'Mina de Ferro',
      'Muralha',
      'Lixeira',
    ]);
    expect([...SCHEDULER_CANCEL_COUNTS]).toEqual([1, 2, 3, 4, 5, 10, 15, 20]);
  });
});
