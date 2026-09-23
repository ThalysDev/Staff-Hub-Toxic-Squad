import { describe, expect, it } from 'vitest';
import {
  SUPPORT_UNITS,
  analyzeSupportDefenseTargets,
  planSupportAllocation,
  planSupportDefenseGoals,
  supportAllocationSettingsSchema,
  supportDefenseSettingsSchema,
  supportPlannerDurationSeconds,
  supportPlannerSnapshotSchema,
  type SupportAllocationDestination,
  type SupportAllocationSettings,
  type SupportDefenseSettings,
  type SupportPlannerSnapshot,
  type SupportUnitAmounts,
} from './support-planner';

const planningAt = '1970-01-01T00:00:00.000Z';

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

const source = (index: number, coordinate: string, troops: Partial<SupportUnitAmounts>) => ({
  villageId: `village_source${String(index).padStart(4, '0')}`,
  coordinate,
  groupIds: [] as string[],
  troops: units(troops),
});

const snapshot = (
  sourceVillages: ReturnType<typeof source>[],
  overrides: Partial<SupportPlannerSnapshot> = {},
): SupportPlannerSnapshot =>
  supportPlannerSnapshotSchema.parse({
    accountId: 'account_masssupport01',
    worldId: 'world_masssupport001',
    worldSpeed: 1,
    unitSpeed: 1,
    hasArchers: true,
    sourceVillages,
    groups: [],
    pendingCommands: [],
    targetVillages: [],
    ...overrides,
  });

const allocationSettings = (
  destinations: Array<Partial<SupportAllocationDestination> & { coordinate: string }>,
  overrides: Partial<Omit<SupportAllocationSettings, 'mode' | 'destinations'>> = {},
): SupportAllocationSettings =>
  supportAllocationSettingsSchema.parse({ mode: 'immediate', destinations, ...overrides });

const plan = (
  sourceVillages: ReturnType<typeof source>[],
  immediateSettings: SupportAllocationSettings,
  overrides: Partial<SupportPlannerSnapshot> = {},
) =>
  planSupportAllocation({
    snapshot: snapshot(sourceVillages, overrides),
    settings: immediateSettings,
    planningAt,
  });

const target = (
  coordinate: string,
  currentSupport: Partial<SupportUnitAmounts> | undefined,
  incomingSupport: Partial<SupportUnitAmounts> = {},
): SupportPlannerSnapshot['targetVillages'][number] => ({
  coordinate,
  ...(currentSupport === undefined ? {} : { currentSupport: units(currentSupport) }),
  incomingSupport: units(incomingSupport),
});

const defenseSettings = (
  targets: unknown[],
  goal: unknown,
  overrides: Partial<Omit<SupportDefenseSettings, 'mode' | 'targets' | 'goal'>> = {},
): SupportDefenseSettings => supportDefenseSettingsSchema.parse({ mode: 'defense-goal', targets, goal, ...overrides });

const defenseSnapshot = (
  sourceVillages: ReturnType<typeof source>[],
  targetVillages: SupportPlannerSnapshot['targetVillages'],
  overrides: Partial<SupportPlannerSnapshot> = {},
) => snapshot(sourceVillages, { targetVillages, ...overrides });

describe('planejador de apoio imediato', () => {
  it('reproduz viagem euclidiana, população e arredondamento de aflição (vetor dourado 1)', () => {
    const result = plan(
      [source(1, '500|500', { spear: 3, sword: 2 })],
      allocationSettings([{ coordinate: '503|504', afflictionPercent: 20 }], { allocationStrategy: 'max_available' }),
      { worldSpeed: 2 },
    );

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({
      id: 'command_3cb4a3b0bd7b750e',
      accountId: 'account_masssupport01',
      worldId: 'world_masssupport001',
      sourceVillageId: 'village_source0001',
      sourceCoordinate: '500|500',
      targetCoordinate: '503|504',
      units: units({ spear: 3, sword: 2 }),
      distance: 5,
      durationSeconds: 2750,
      arrivalAt: '1970-01-01T00:45:50.000Z',
      population: 5,
    });
    expect(result.summary).toMatchObject({ commands: 1, destinations: 1, population: 5 });
  });

  it('usa a unidade mais lenta e aplica o mínimo de 1 segundo na duração', () => {
    expect(
      supportPlannerDurationSeconds({
        distance: 1,
        units: units({ spear: 1, light: 100 }),
        worldSpeed: 1,
        unitSpeed: 1,
        afflictionPercent: 0,
      }),
    ).toBe(1080);
    expect(
      supportPlannerDurationSeconds({
        distance: 0,
        units: units({ spear: 1 }),
        worldSpeed: 1,
        unitSpeed: 1,
        afflictionPercent: 0,
      }),
    ).toBe(0);
    expect(
      supportPlannerDurationSeconds({
        distance: 0.001,
        units: units({ spear: 1 }),
        worldSpeed: 1,
        unitSpeed: 1,
        afflictionPercent: 0,
      }),
    ).toBe(1);
  });

  it('mantém apenas unidades cuja chegada cabe na janela pontual inclusiva (vetor 2)', () => {
    const result = plan(
      [source(1, '500|500', { spear: 3, sword: 4 })],
      allocationSettings(
        [
          {
            coordinate: '501|500',
            activeUnits: ['spear', 'sword'],
            arrivalWindow: {
              startAt: '1970-01-01T00:18:00.000Z',
              endAt: '1970-01-01T00:18:00.000Z',
            },
          },
        ],
        { allocationStrategy: 'max_available' },
      ),
    );

    expect(result.commands.map((command) => command.units)).toEqual([units({ spear: 3 })]);
    expect(result.commands[0]?.id).toBe('command_f8ecaf5ea0dfe01b');
    expect(result.commands[0]?.durationSeconds).toBe(1080);
  });

  it('janela de chegada inatingível zera a alocação (sem comandos)', () => {
    const result = plan(
      [source(1, '500|500', { spear: 3, sword: 4 })],
      allocationSettings(
        [
          {
            coordinate: '501|500',
            activeUnits: ['spear', 'sword'],
            arrivalWindow: {
              startAt: '1970-01-01T00:19:00.000Z',
              endAt: '1970-01-01T00:19:00.000Z',
            },
          },
        ],
        { allocationStrategy: 'max_available' },
      ),
    );

    expect(result.commands).toHaveLength(0);
    expect(result.results[0]?.state).toBe('unavailable');
    expect(result.results[0]?.exclusionReasons).toEqual(['Nenhuma origem elegível com tropas disponíveis']);
  });

  it('desconta reserva por aldeia e comandos pendentes normalizados (vetor 3)', () => {
    const first = source(1, '499|500', { spear: 10 });
    const second = source(2, '502|500', { spear: 7 });
    const result = plan(
      [first, second],
      allocationSettings([{ coordinate: '500|500', activeUnits: ['spear'] }], {
        allocationStrategy: 'max_available',
        reserveByUnit: units({ spear: 4 }),
      }),
      {
        targetVillages: [{ coordinate: '500|500' }],
        pendingCommands: [
          {
            sourceVillageId: second.villageId,
            units: units({ spear: 1 }),
          },
        ],
      },
    );

    expect(result.commands.map((command) => command.units.spear)).toEqual([6, 2]);
    expect(result.commands.map((command) => command.id)).toEqual([
      'command_76729a67928287b1',
      'command_10adea940e0c18e6',
    ]);
    expect(result.summary.troops.spear).toBe(8);
  });

  it('envia todo o estoque proporcional de cada origem a um destino (vetor 4)', () => {
    const result = plan(
      [source(1, '499|500', { spear: 3, sword: 2 }), source(2, '502|500', { light: 4 })],
      allocationSettings([{ coordinate: '500|500' }]),
    );

    expect(result.commands.map((command) => command.units)).toEqual([
      units({ light: 4 }),
      units({ spear: 3, sword: 2 }),
    ]);
    expect(result.commands.map((command) => command.id)).toEqual([
      'command_f0b8396a7b72920e',
      'command_af4fb2b075262e9a',
    ]);
    expect(result.summary.population).toBe(9);
  });

  it('honra prioridade de distância e limite de aldeias apenas no modo max_available (vetor 5)', () => {
    const result = plan(
      [source(1, '501|500', { spear: 2 }), source(2, '502|500', { spear: 7 }), source(3, '503|500', { spear: 5 })],
      allocationSettings([{ coordinate: '500|500', activeUnits: ['spear'] }], {
        allocationStrategy: 'max_available',
        distancePriority: 'farthest',
        villageLimit: 2,
      }),
    );

    expect(result.commands.map((command) => command.sourceCoordinate)).toEqual(['502|500', '503|500']);
    expect(result.commands.map((command) => command.id)).toEqual([
      'command_94d0933718b2530e',
      'command_00422ec05a91b7c9',
    ]);
    expect(result.summary.troops.spear).toBe(12);
  });

  it('preenche o orçamento de população restante na ordem canônica de unidades (vetor 6)', () => {
    const result = plan(
      [source(1, '499|500', { spear: 2, heavy: 2 })],
      allocationSettings([{ coordinate: '500|500', troopMode: 'population', populationLimit: 6 }]),
    );

    expect(result.commands[0]?.units).toEqual(units({ spear: 2, heavy: 1 }));
    expect(result.summary.population).toBe(6);
  });

  it('distribui limites unitários proporcionais pelo maior resto fracionário (vetor 7)', () => {
    const result = plan(
      [source(1, '499|500', { spear: 3 }), source(2, '502|500', { spear: 2 })],
      allocationSettings([
        {
          coordinate: '500|500',
          troopMode: 'unit',
          unitLimits: { spear: 2 },
          activeUnits: ['spear'],
        },
      ]),
    );

    expect(result.commands.map((command) => command.units.spear)).toEqual([1, 1]);
  });

  it('trata limites omitidos como ilimitados e zero explícito como zero (vetor 8)', () => {
    const result = plan(
      [source(1, '499|500', { spear: 2, sword: 5, heavy: 3 }), source(2, '502|500', { spear: 5, sword: 7, heavy: 4 })],
      allocationSettings(
        [
          {
            coordinate: '500|500',
            troopMode: 'unit',
            unitLimits: { spear: 4, heavy: 0 },
            activeUnits: ['spear', 'sword', 'heavy'],
          },
        ],
        { allocationStrategy: 'max_available' },
      ),
    );

    expect(result.summary.troops).toEqual(units({ spear: 4, sword: 12 }));
  });

  it('para a alocação max_available por unidade após cumprir todos os limites positivos', () => {
    const result = plan(
      [
        source(1, '499|500', { spear: 2, sword: 5 }),
        source(2, '502|500', { spear: 5, sword: 7 }),
        source(3, '503|500', { spear: 9, sword: 11 }),
      ],
      allocationSettings(
        [
          {
            coordinate: '500|500',
            troopMode: 'unit',
            unitLimits: { spear: 4 },
            activeUnits: ['spear', 'sword'],
          },
        ],
        { allocationStrategy: 'max_available' },
      ),
    );

    expect(result.commands.map((command) => command.sourceCoordinate)).toEqual(['499|500', '502|500']);
    expect(result.summary.troops).toEqual(units({ spear: 4, sword: 12 }));
  });

  it('honra a filiação a grupo de origem registrada no snapshot canônico', () => {
    const groupId = 'group_frontline01';
    const included = { ...source(1, '499|500', { spear: 3 }), groupIds: [groupId] };
    const viaList = { ...source(3, '503|500', { spear: 2 }), groupIds: [] };
    const excluded = source(2, '502|500', { spear: 7 });
    const result = plan(
      [included, viaList, excluded],
      allocationSettings([{ coordinate: '500|500', activeUnits: ['spear'] }], { sourceGroupId: groupId }),
      { groups: [{ id: groupId, villageIds: [viaList.villageId] }] },
    );

    expect(result.summary.troops.spear).toBe(5);
    expect(result.commands.map((command) => command.sourceCoordinate)).toEqual(['499|500', '503|500']);
  });

  it('reaplica o divisor proporcional ao estoque decrescente entre destinos ordenados (vetor 9)', () => {
    const result = plan(
      [source(1, '500|500', { spear: 8 })],
      allocationSettings([
        { coordinate: '501|500', activeUnits: ['spear'] },
        { coordinate: '502|500', activeUnits: ['spear'] },
      ]),
    );

    expect(result.results.map((destination) => destination.troops.spear)).toEqual([4, 2]);
    expect(result.commands.map((command) => command.id)).toEqual([
      'command_f3f36519afa53c0f',
      'command_9010e3ecdd86e627',
    ]);
    expect(result.summary.troops.spear).toBe(6);
  });

  it('nunca aloca o mesmo estoque duas vezes no modo max_available (vetor 10)', () => {
    const immediateSettings = allocationSettings(
      [
        { coordinate: '501|500', activeUnits: ['spear'] },
        { coordinate: '502|500', activeUnits: ['spear'] },
      ],
      { allocationStrategy: 'max_available' },
    );
    const first = plan([source(1, '500|500', { spear: 8 })], immediateSettings);
    const second = plan([source(1, '500|500', { spear: 8 })], immediateSettings);

    expect(first.results.map((destination) => destination.troops.spear)).toEqual([8, 0]);
    expect(first.results.map((destination) => destination.state)).toEqual(['ready', 'unavailable']);
    expect(first.summary.troops.spear).toBe(8);
    expect(first.commands[0]?.id).toBe('command_2fe6f20ec1892a27');
    expect(first).toEqual(second);
    expect(SUPPORT_UNITS.every((unit) => first.summary.troops[unit] >= 0)).toBe(true);
  });

  it('é determinístico sob entrada invertida (mesmos comandos)', () => {
    const sources = [
      source(1, '499|500', { spear: 3, sword: 2 }),
      source(2, '502|500', { light: 4 }),
      source(3, '503|500', { spear: 5 }),
    ];
    const settings = allocationSettings([{ coordinate: '500|500' }]);
    const forward = plan(sources, settings);
    const backward = plan([...sources].reverse(), settings);

    expect(forward.commands).toEqual(backward.commands);
    expect(forward.summary).toEqual(backward.summary);
  });

  it('id canônico é ESTÁVEL entre planejamentos em instantes diferentes (modo imediato)', () => {
    // A chegada imediata é estimativa (planningAt + duração): muda a cada
    // ciclo. O id do comando lógico NÃO pode mudar com ela — o dedupe do
    // livro-razão de execução depende do mesmo id para não reenviar.
    const world = snapshot([source(1, '499|500', { spear: 10 })]);
    const settings = allocationSettings([{ coordinate: '500|500' }], { allocationStrategy: 'max_available' });

    const first = planSupportAllocation({ snapshot: world, settings, planningAt: '1970-01-01T00:00:00.000Z' });
    const second = planSupportAllocation({ snapshot: world, settings, planningAt: '1970-01-01T00:07:30.000Z' });

    expect(first.commands).toHaveLength(1);
    expect(second.commands).toHaveLength(1);
    expect(first.commands[0]!.id).toBe(second.commands[0]!.id);
    // A chegada EXIBIDA continua o estimativo de cada instante (honesto na
    // prévia); só a identidade do comando é estável.
    expect(first.commands[0]!.arrivalAt).not.toBe(second.commands[0]!.arrivalAt);
  });

  it('id canônico da defesa agendada distingue chegadas agendadas diferentes (identidade do comando)', () => {
    const world = defenseSnapshot([source(1, '499|500', { spear: 100 })], [target('500|500', {})]);
    const baseGoal = { mode: 'unit', unitLimits: { spear: 100 } } as const;

    const first = planSupportDefenseGoals({
      snapshot: world,
      settings: defenseSettings([{ coordinate: '500|500' }], baseGoal, {
        executionMode: 'scheduled',
        scheduledArrivalAt: '1970-01-01T00:18:31.000Z',
      }),
      planningAt,
    });
    const second = planSupportDefenseGoals({
      snapshot: world,
      settings: defenseSettings([{ coordinate: '500|500' }], baseGoal, {
        executionMode: 'scheduled',
        scheduledArrivalAt: '1970-01-01T00:22:00.000Z',
      }),
      planningAt,
    });

    expect(first.commands).toHaveLength(1);
    expect(second.commands).toHaveLength(1);
    expect(first.commands[0]!.id).not.toBe(second.commands[0]!.id);
    // Mesma força, mesma origem/alvo: tudo bate exceto a chegada marcada.
    expect(first.commands[0]!.units).toEqual(second.commands[0]!.units);
    expect(first.commands[0]!.arrivalAt).toBe('1970-01-01T00:18:31.000Z');
    expect(second.commands[0]!.arrivalAt).toBe('1970-01-01T00:22:00.000Z');
  });

  it('não muta a entrada (snapshot e configurações)', () => {
    const first = source(1, '499|500', { spear: 10, sword: 3 });
    const second = source(2, '502|500', { spear: 7 });
    const inputSnapshot = snapshot([first, second]);
    const inputSettings = allocationSettings([{ coordinate: '500|500' }], { allocationStrategy: 'max_available' });
    const before = JSON.stringify(inputSnapshot);
    const beforeSettings = JSON.stringify(inputSettings);

    planSupportAllocation({ snapshot: inputSnapshot, settings: inputSettings, planningAt });

    expect(JSON.stringify(inputSnapshot)).toBe(before);
    expect(JSON.stringify(inputSettings)).toBe(beforeSettings);
  });

  it('congela o plano retornado em profundidade', () => {
    const result = plan(
      [source(1, '499|500', { spear: 10 })],
      allocationSettings([{ coordinate: '500|500' }], { allocationStrategy: 'max_available' }),
    );

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.summary)).toBe(true);
    expect(Object.isFrozen(result.summary.troops)).toBe(true);
    expect(Object.isFrozen(result.results)).toBe(true);
    expect(Object.isFrozen(result.results[0])).toBe(true);
    expect(Object.isFrozen(result.results[0]?.troops)).toBe(true);
    expect(Object.isFrozen(result.results[0]?.exclusionReasons)).toBe(true);
    expect(Object.isFrozen(result.commands)).toBe(true);
    expect(Object.isFrozen(result.commands[0])).toBe(true);
    expect(Object.isFrozen(result.commands[0]?.units)).toBe(true);
    expect(() => {
      result.commands[0]!.units.spear = 999;
    }).toThrow(TypeError);
  });

  it('agrega o resumo corretamente a partir dos comandos planejados', () => {
    const result = plan(
      [source(1, '499|500', { spear: 10, sword: 2 }), source(2, '502|500', { light: 4 })],
      allocationSettings([{ coordinate: '500|500' }]),
    );

    expect(result.summary.destinations).toBe(result.results.length);
    expect(result.summary.commands).toBe(result.commands.length);
    const totals = units();
    for (const command of result.commands) {
      for (const unit of SUPPORT_UNITS) totals[unit] += command.units[unit];
    }
    expect(result.summary.troops).toEqual(totals);
    expect(result.summary.population).toBe(result.commands.reduce((total, command) => total + command.population, 0));
  });
});

describe('análise de metas de defesa', () => {
  it('calcula déficits de população pesada com e sem apoio em trânsito', () => {
    const world = defenseSnapshot(
      [],
      [target('500|500', { spear: 1000, sword: 500, heavy: 100 }, { heavy: 50, spy: 999 })],
    );
    const base = defenseSettings([{ coordinate: '500|500' }], {
      mode: 'population',
      populationLimit: 3000,
      compositionPreset: 'heavy',
    });

    const withoutIncoming = analyzeSupportDefenseTargets({
      snapshot: world,
      settings: { ...base, includeIncomingSupport: false },
    }).targets[0];
    const withIncoming = analyzeSupportDefenseTargets({ snapshot: world, settings: base }).targets[0];

    expect(withoutIncoming).toMatchObject({
      currentPopulation: 1900,
      targetPopulation: 3000,
      needed: units({ heavy: 165, sword: 275, spear: 165 }),
      completionPercent: 63,
      isComplete: false,
    });
    expect(withIncoming).toMatchObject({
      currentPopulation: 2100,
      needed: units({ heavy: 135, sword: 225, spear: 135 }),
      completionPercent: 70,
    });
  });

  it('reproduz todos os presets recuperados de composição de população', () => {
    const world = defenseSnapshot([], [target('500|500', {})]);
    const cases = [
      ['heavy', units({ heavy: 150, sword: 250, spear: 150 })],
      ['balanced', units({ sword: 400, spear: 300, heavy: 50, archer: 100 })],
      ['anti-cavalry', units({ spear: 700, sword: 200, heavy: 25 })],
      ['equal', units({ spear: 100, sword: 100, archer: 100, light: 100, marcher: 100, heavy: 25 })],
    ] as const;

    for (const [compositionPreset, expected] of cases) {
      const analysis = analyzeSupportDefenseTargets({
        snapshot: world,
        settings: defenseSettings([{ coordinate: '500|500' }], {
          mode: 'population',
          populationLimit: compositionPreset === 'equal' ? 600 : 1000,
          compositionPreset,
        }),
      });
      expect(analysis.targets[0]?.needed, compositionPreset).toEqual(expected);
    }
  });

  it('calcula déficits por unidade, apoio em trânsito e conclusão independentemente', () => {
    const world = defenseSnapshot([], [target('500|500', { spear: 120, sword: 20, heavy: 2 }, { sword: 5, heavy: 1 })]);
    const result = analyzeSupportDefenseTargets({
      snapshot: world,
      settings: defenseSettings([{ coordinate: '500|500' }], {
        mode: 'unit',
        unitLimits: { spear: 100, sword: 50, heavy: 10 },
      }),
    }).targets[0];

    expect(result).toMatchObject({
      currentPopulation: 157,
      targetPopulation: 190,
      needed: units({ sword: 25, heavy: 7 }),
      completionPercent: 83,
      isComplete: false,
    });
  });

  it('usa a meta por alvo como sobreposição completa e separa percentual de conclusão', () => {
    const world = defenseSnapshot([], [target('500|500', { sword: 100 }), target('501|500', { heavy: 30 })]);
    const analysis = analyzeSupportDefenseTargets({
      snapshot: world,
      settings: defenseSettings(
        [
          { coordinate: '500|500', goal: { mode: 'unit', unitLimits: { spear: 100 } } },
          { coordinate: '501|500', goal: { mode: 'population', populationLimit: 100, compositionPreset: 'heavy' } },
        ],
        { mode: 'population', populationLimit: 9999, compositionPreset: 'balanced' },
      ),
    });

    expect(analysis.targets[0]).toMatchObject({
      targetPopulation: 100,
      needed: units({ spear: 100 }),
      completionPercent: 100,
      isComplete: false,
    });
    expect(analysis.targets[1]).toMatchObject({
      currentPopulation: 120,
      targetPopulation: 100,
      needed: units(),
      completionPercent: 120,
      isComplete: true,
    });
  });

  it('marca alvos sem dados como indisponíveis e ausentes como inválidos', () => {
    const analysis = analyzeSupportDefenseTargets({
      snapshot: defenseSnapshot([], [target('500|500', undefined)]),
      settings: defenseSettings([{ coordinate: '500|500' }, { coordinate: '501|500' }], {
        mode: 'unit',
        unitLimits: { spear: 10 },
      }),
    });

    expect(analysis.targets.map((entry) => entry.state)).toEqual(['unavailable', 'invalid']);
    expect(analysis.totalNeededPopulation).toBe(0);
  });

  it('congela a análise retornada em profundidade', () => {
    const analysis = analyzeSupportDefenseTargets({
      snapshot: defenseSnapshot([], [target('500|500', { spear: 10 })]),
      settings: defenseSettings([{ coordinate: '500|500' }], { mode: 'unit', unitLimits: { spear: 100 } }),
    });

    expect(Object.isFrozen(analysis)).toBe(true);
    expect(Object.isFrozen(analysis.targets)).toBe(true);
    expect(Object.isFrozen(analysis.targets[0])).toBe(true);
    expect(Object.isFrozen(analysis.targets[0]?.needed)).toBe(true);
    expect(Object.isFrozen(analysis.totalNeeded)).toBe(true);
  });
});

describe('planejador de metas de defesa', () => {
  it('desconta reserva e comandos pendentes antes de planejar a defesa', () => {
    const origin = source(1, '499|500', { spear: 100, sword: 50, archer: 2, heavy: 10 });
    const destination = target('500|500', {});
    const world = defenseSnapshot([origin], [destination], {
      pendingCommands: [
        {
          sourceVillageId: origin.villageId,
          units: units({ spear: 25, sword: 7, archer: 2, heavy: 3 }),
        },
      ],
    });
    const result = planSupportDefenseGoals({
      snapshot: world,
      settings: defenseSettings(
        [{ coordinate: '500|500' }],
        { mode: 'unit', unitLimits: { spear: 1000, sword: 1000, archer: 1000, heavy: 1000 } },
        { reserveByUnit: units({ spear: 10, sword: 5, heavy: 2 }), allocationStrategy: 'max_available' },
      ),
      planningAt,
    });

    expect(result.summary.troops).toEqual(units({ spear: 65, sword: 38, heavy: 5 }));
  });

  it('prioriza menor conclusão e consome o estoque compartilhado uma única vez', () => {
    const result = planSupportDefenseGoals({
      snapshot: defenseSnapshot(
        [source(1, '499|500', { spear: 70 })],
        [target('500|500', { sword: 5 }), target('501|500', { sword: 10 })],
      ),
      settings: defenseSettings(
        [{ coordinate: '500|500' }, { coordinate: '501|500' }],
        { mode: 'unit', unitLimits: { spear: 50 } },
        { allocationStrategy: 'max_available' },
      ),
      planningAt,
    });

    expect(result.results.map((entry) => entry.troops.spear)).toEqual([50, 20]);
    expect(result.summary.troops.spear).toBe(70);
  });

  it('aplica o guard estrito de 30 segundos apenas na chegada agendada exata', () => {
    const world = defenseSnapshot([source(1, '499|500', { spear: 100 })], [target('500|500', {})]);
    const base = { snapshot: world, planningAt };
    const atGuard = planSupportDefenseGoals({
      ...base,
      settings: defenseSettings(
        [{ coordinate: '500|500' }],
        { mode: 'unit', unitLimits: { spear: 100 } },
        { executionMode: 'scheduled', scheduledArrivalAt: '1970-01-01T00:18:30.000Z' },
      ),
    });
    const afterGuard = planSupportDefenseGoals({
      ...base,
      settings: defenseSettings(
        [{ coordinate: '500|500' }],
        { mode: 'unit', unitLimits: { spear: 100 } },
        { executionMode: 'scheduled', scheduledArrivalAt: '1970-01-01T00:18:30.001Z' },
      ),
    });
    const immediate = planSupportDefenseGoals({
      ...base,
      settings: defenseSettings(
        [{ coordinate: '500|500' }],
        { mode: 'unit', unitLimits: { spear: 100 } },
        { executionMode: 'immediate' },
      ),
    });

    expect(atGuard.commands).toHaveLength(0);
    expect(afterGuard.commands).toHaveLength(1);
    expect(afterGuard.commands[0]?.arrivalAt).toBe('1970-01-01T00:18:30.001Z');
    expect(immediate.commands).toHaveLength(1);
    expect(immediate.commands[0]?.arrivalAt).toBe('1970-01-01T00:18:00.000Z');
  });

  it('expõe razões de exclusão em pt-BR para cada estado', () => {
    const immediate = planSupportAllocation({
      snapshot: snapshot([], { targetVillages: [{ coordinate: '500|500' }] }),
      settings: allocationSettings([{ coordinate: '500|500' }]),
      planningAt,
    });
    expect(immediate.results[0]?.exclusionReasons).toEqual(['Nenhuma origem elegível com tropas disponíveis']);

    const partial = planSupportAllocation({
      snapshot: snapshot([source(1, '499|500', { spear: 5 })]),
      settings: allocationSettings([{ coordinate: '500|500', troopMode: 'population', populationLimit: 10 }]),
      planningAt,
    });
    expect(partial.results[0]?.state).toBe('partial');
    expect(partial.results[0]?.exclusionReasons).toEqual([
      'O estoque disponível não atende integralmente o limite solicitado',
    ]);

    const defensePartial = planSupportDefenseGoals({
      snapshot: defenseSnapshot([source(1, '499|500', { spear: 5 })], [target('500|500', {})]),
      settings: defenseSettings(
        [{ coordinate: '500|500' }],
        { mode: 'unit', unitLimits: { spear: 100 } },
        { allocationStrategy: 'max_available' },
      ),
      planningAt,
    });
    expect(defensePartial.results[0]?.state).toBe('partial');
    expect(defensePartial.results[0]?.exclusionReasons).toEqual([
      'O estoque disponível atende apenas parte do déficit',
    ]);

    const guard = planSupportDefenseGoals({
      snapshot: defenseSnapshot([source(1, '499|500', { spear: 100 })], [target('500|500', {})]),
      settings: defenseSettings(
        [{ coordinate: '500|500' }],
        { mode: 'unit', unitLimits: { spear: 100 } },
        { executionMode: 'scheduled', scheduledArrivalAt: '1970-01-01T00:18:30.000Z' },
      ),
      planningAt,
    });
    expect(guard.results[0]?.state).toBe('unavailable');
    expect(guard.results[0]?.exclusionReasons).toEqual(['Nenhuma origem pode enviar depois do guard de 30 segundos']);

    const invalid = planSupportDefenseGoals({
      snapshot: defenseSnapshot([], [target('500|500', {})]),
      settings: defenseSettings([{ coordinate: '500|500' }, { coordinate: '501|500' }], {
        mode: 'unit',
        unitLimits: { spear: 10 },
      }),
      planningAt,
    });
    expect(invalid.results.map((entry) => entry.exclusionReasons)).toEqual([
      ['Nenhuma origem elegível com tropas disponíveis'],
      ['O alvo não existe no snapshot ativo'],
    ]);

    const unavailable = planSupportDefenseGoals({
      snapshot: defenseSnapshot([], [target('500|500', undefined)]),
      settings: defenseSettings([{ coordinate: '500|500' }], { mode: 'unit', unitLimits: { spear: 10 } }),
      planningAt,
    });
    expect(unavailable.results[0]?.exclusionReasons).toEqual(['Os dados de apoio do alvo não estão disponíveis']);
  });

  it('congela o plano de defesa retornado em profundidade', () => {
    const result = planSupportDefenseGoals({
      snapshot: defenseSnapshot([source(1, '499|500', { spear: 100 })], [target('500|500', {})]),
      settings: defenseSettings(
        [{ coordinate: '500|500' }],
        { mode: 'unit', unitLimits: { spear: 100 } },
        { allocationStrategy: 'max_available' },
      ),
      planningAt,
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.summary)).toBe(true);
    expect(Object.isFrozen(result.results)).toBe(true);
    expect(Object.isFrozen(result.results[0])).toBe(true);
    expect(Object.isFrozen(result.commands)).toBe(true);
    expect(Object.isFrozen(result.commands[0])).toBe(true);
    expect(Object.isFrozen(result.commands[0]?.units)).toBe(true);
    expect(result.commands[0]?.id).toMatch(/^command_[a-f0-9]{16}$/);
  });
});
