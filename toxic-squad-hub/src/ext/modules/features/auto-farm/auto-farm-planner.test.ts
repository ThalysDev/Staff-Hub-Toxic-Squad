import { describe, expect, it } from 'vitest';
import type { AutoFarmSnapshot, AutoFarmTarget } from './auto-farm-contracts';
import { autoFarmSnapshotSchema } from './auto-farm-contracts';
import { planAutoFarm, planAutoFarmPreview } from './auto-farm-planner';
import { autoFarmSettingsSchema } from './auto-farm-settings';

const CAPTURED_AT = '2026-08-23T15:00:00.000Z';

function target(overrides: Partial<AutoFarmTarget> = {}): AutoFarmTarget {
  return {
    id: 'target-1',
    x: 503,
    y: 504,
    points: 120,
    barbarian: true,
    evidenceSources: ['AM_REPORT'],
    templateIds: ['A', 'B'],
    availableTemplateIds: ['A', 'B'],
    lastResult: 'SUCCESS',
    ...overrides,
  };
}

function snapshot(overrides: Partial<AutoFarmSnapshot> = {}): AutoFarmSnapshot {
  return {
    capability: 'AVAILABLE',
    source: {
      villageId: '238755',
      x: 500,
      y: 500,
      troops: { light: 100, spy: 10 },
    },
    templates: [
      { id: 'A', gameTemplateId: '23', description: 'Leves', units: { light: 10 } },
      { id: 'B', gameTemplateId: '101', description: 'Exploração', units: { light: 5, spy: 1 } },
    ],
    plunderFilters: {
      onlyCurrentVillage: false,
      includeAttacked: true,
      includeFullLosses: true,
      includePartialLosses: true,
      onlyFullHauls: false,
    },
    targets: [target()],
    capturedAt: CAPTURED_AT,
    ...overrides,
  };
}

describe('planejador puro do Auto Farm', () => {
  it('calcula distância por coordenadas e não confunde pontos com distância', () => {
    const decision = planAutoFarm(snapshot({ targets: [target({ points: 999_999 })] }), {
      maximumDistanceFields: 5,
    });

    expect(decision.kind).toBe('PLAN');
    if (decision.kind === 'PLAN') {
      expect(decision.distanceFields).toBe(5);
      expect(decision.target.points).toBe(999_999);
    }
  });

  it('falha fechado quando a capacidade ou a coordenada de origem não foi comprovada', () => {
    expect(planAutoFarm(snapshot({ capability: 'UNKNOWN' }), {})).toMatchObject({
      kind: 'NO_WORK',
      code: 'CAPABILITY_UNKNOWN',
    });
    expect(planAutoFarm(snapshot({ capability: 'UNAVAILABLE' }), {})).toMatchObject({
      kind: 'NO_WORK',
      code: 'CAPABILITY_UNAVAILABLE',
    });
    expect(
      planAutoFarm(snapshot({ source: { villageId: '238755', y: 500, troops: { light: 100 } } }), {}),
    ).toMatchObject({ kind: 'NO_WORK', code: 'SOURCE_COORDINATES_UNAVAILABLE' });
  });

  it('exige que o template configurado exista e tenha tropas suficientes', () => {
    expect(
      planAutoFarm(snapshot({ templates: [{ id: 'B', gameTemplateId: '101', units: { spy: 1 } }] }), {
        templateId: 'A',
      }),
    ).toMatchObject({
      kind: 'NO_WORK',
      code: 'TEMPLATE_NOT_FOUND',
    });

    const insufficient = planAutoFarm(
      snapshot({ source: { villageId: '238755', x: 500, y: 500, troops: { light: 9 } } }),
      { templateId: 'A' },
    );
    expect(insufficient).toMatchObject({
      kind: 'NO_WORK',
      code: 'NO_EXECUTABLE_TARGET',
      exclusions: { INSUFFICIENT_TROOPS: 1 },
    });
  });

  it('contabiliza os motivos de exclusão sem selecionar alvos inelegíveis', () => {
    const decision = planAutoFarm(
      snapshot({
        targets: [
          target({ id: 'player', barbarian: false }),
          target({ id: 'far', x: 550, y: 550 }),
          target({ id: 'without-template', templateIds: ['B'], availableTemplateIds: ['B'] }),
          target({ id: 'loss', lastResult: 'LOSS' }),
        ],
      }),
      { maximumDistanceFields: 20, blockAfterLoss: true },
    );

    expect(decision).toMatchObject({
      kind: 'NO_WORK',
      code: 'NO_ELIGIBLE_TARGET',
      exclusions: {
        NOT_BARBARIAN: 1,
        OUTSIDE_MAXIMUM_DISTANCE: 1,
        TEMPLATE_UNAVAILABLE_FOR_TARGET: 1,
        BLOCKED_AFTER_LOSS: 1,
      },
    });
  });

  it('permite reavaliar um alvo derrotado somente quando a regra está desativada', () => {
    const blocked = planAutoFarm(snapshot({ targets: [target({ lastResult: 'LOSS' })] }), { blockAfterLoss: true });
    const allowed = planAutoFarm(snapshot({ targets: [target({ lastResult: 'LOSS' })] }), { blockAfterLoss: false });

    expect(blocked.kind).toBe('NO_WORK');
    expect(allowed.kind).toBe('PLAN');
  });

  it('prioriza o alvo menos recente e usa distância e id como desempates determinísticos', () => {
    const recent = target({ id: 'recent', x: 501, y: 500, lastAttackAt: '2026-08-23T14:50:00.000Z' });
    const oldFar = target({ id: 'old-far', x: 510, y: 500, lastAttackAt: '2026-08-23T14:00:00.000Z' });
    const oldNear = target({ id: 'old-near', x: 502, y: 500, lastAttackAt: '2026-08-23T14:00:00.000Z' });
    const original = snapshot({ targets: [recent, oldFar, oldNear] });
    const reversed = snapshot({ targets: [...original.targets].reverse() });

    const first = planAutoFarm(original, { targetPriority: 'least-recently-attacked' });
    const second = planAutoFarm(reversed, { targetPriority: 'least-recently-attacked' });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ kind: 'PLAN', target: { id: 'old-near' } });

    expect(planAutoFarm(original, { targetPriority: 'nearest' })).toMatchObject({
      kind: 'PLAN',
      target: { id: 'recent' },
    });
  });

  it('devolve todas as aldeias elegíveis na mesma ordem determinística da execução futura', () => {
    const preview = planAutoFarmPreview(
      snapshot({
        targets: [
          target({ id: 'far', x: 510, y: 500 }),
          target({ id: 'near', x: 501, y: 500 }),
          target({ id: 'disabled', x: 502, y: 500, availableTemplateIds: [] }),
        ],
      }),
      { targetPriority: 'nearest' },
    );

    expect(preview).toMatchObject({
      kind: 'PLAN',
      gameTemplateId: '23',
      totalTargets: 3,
      executableActions: 2,
      templateHaulCapacity: 800,
      actions: [
        { order: 1, target: { id: 'near' }, roundStatus: 'EXECUTABLE', remainingTroopsAfter: { light: 90 } },
        { order: 2, target: { id: 'far' }, roundStatus: 'EXECUTABLE', remainingTroopsAfter: { light: 80 } },
      ],
      exclusions: { TEMPLATE_DISABLED_FOR_TARGET: 1 },
    });
  });

  it('falha fechado quando os filtros não comprovam cobertura completa', () => {
    expect(
      planAutoFarm(snapshot({ plunderFilters: { ...snapshot().plunderFilters, includeFullLosses: false } }), {}),
    ).toMatchObject({ kind: 'NO_WORK', code: 'FILTER_COVERAGE_INCOMPLETE' });
  });

  it('simula o orçamento de tropas e o limite de comandos sem criar uma fila executável', () => {
    const targets = [1, 2, 3, 4].map((id) => target({ id: String(id), x: 500 + id, y: 500 }));
    const budget = planAutoFarmPreview(
      snapshot({ source: { villageId: '238755', x: 500, y: 500, troops: { light: 25 } }, targets }),
      { maximumCommandsPerRound: 10 },
    );
    expect(budget).toMatchObject({
      kind: 'PLAN',
      executableActions: 2,
      waitingForTroops: 2,
      actions: [
        { roundStatus: 'EXECUTABLE', remainingTroopsAfter: { light: 15 } },
        { roundStatus: 'EXECUTABLE', remainingTroopsAfter: { light: 5 } },
        { roundStatus: 'WAITING_FOR_TROOPS' },
        { roundStatus: 'WAITING_FOR_TROOPS' },
      ],
    });

    expect(planAutoFarmPreview(snapshot({ targets }), { maximumCommandsPerRound: 1 })).toMatchObject({
      kind: 'PLAN',
      executableActions: 1,
      waitingForCommandLimit: 3,
      actions: [
        { roundStatus: 'EXECUTABLE' },
        { roundStatus: 'COMMAND_LIMIT_REACHED' },
        { roundStatus: 'COMMAND_LIMIT_REACHED' },
        { roundStatus: 'COMMAND_LIMIT_REACHED' },
      ],
    });
  });

  it('aplica blacklist, cooldown e reservas já conhecidas pelo Hub', () => {
    const targets = [
      target({ id: '1', x: 501, y: 500 }),
      target({ id: '2', x: 502, y: 500, lastAttackAt: '2026-08-23T14:55:00.000Z' }),
      target({ id: '3', x: 503, y: 500 }),
      target({ id: '4', x: 504, y: 500 }),
      target({ id: '5', x: 505, y: 500 }),
    ];
    expect(
      planAutoFarm(
        snapshot({ targets }),
        { targetBlacklist: ['1'], minimumTargetCooldownMinutes: 10 },
        { scheduledTargetCoordinates: ['503|500'], inFlightTargetCoordinates: ['504|500'] },
      ),
    ).toMatchObject({
      kind: 'PLAN',
      target: { id: '5' },
      exclusions: { BLACKLISTED_TARGET: 1, TARGET_COOLDOWN: 1, SCHEDULED_TARGET: 1, TARGET_IN_FLIGHT: 1 },
    });
  });

  it('não altera a entrada e devolve decisão e dados internos congelados', () => {
    const input = snapshot();
    const before = structuredClone(input);
    const decision = planAutoFarm(input, {});

    expect(input).toEqual(before);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.exclusions)).toBe(true);
    if (decision.kind === 'PLAN') expect(Object.isFrozen(decision.target)).toBe(true);
  });
});

describe('contratos e configurações do Auto Farm', () => {
  it('migra as configurações legadas sem preservar regras não comprovadas', () => {
    expect(
      autoFarmSettingsSchema.parse({
        templateId: 'default',
        maxDistance: 12,
        minLight: 10,
        maxLosses: 2,
      }),
    ).toEqual({
      templateId: 'A',
      maximumDistanceFields: 12,
      intervalMinutes: 15,
      targetPriority: 'least-recently-attacked',
      blockAfterLoss: true,
      minimumTargetCooldownMinutes: 0,
      maximumCommandsPerRound: 10000,
      targetBlacklist: [],
      ignoreScheduledTargets: true,
      ignoreTargetsInFlight: true,
    });
  });

  it('rejeita templates vazios, repetidos ou fora de A/B', () => {
    expect(() =>
      autoFarmSnapshotSchema.parse(snapshot({ templates: [{ id: 'A', gameTemplateId: '23', units: {} }] })),
    ).toThrow();
    expect(() =>
      autoFarmSnapshotSchema.parse(
        snapshot({
          templates: [
            { id: 'A', gameTemplateId: '23', units: { light: 10 } },
            { id: 'A', gameTemplateId: '24', units: { light: 20 } },
          ],
        }),
      ),
    ).toThrow();
    expect(() => autoFarmSettingsSchema.parse({ templateId: 'C' })).toThrow();
  });
});
