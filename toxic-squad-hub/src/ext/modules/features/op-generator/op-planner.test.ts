import { describe, expect, it } from 'vitest';
import { fnv1a64 } from '../../shared/canonical-ids';
import {
  opPlannerConfigSchema,
  opPlannerEntrySchema,
  opPlannerPlanSchema,
  opPlannerSnapshotSchema,
  planOpPlanner,
  type OpCriterion,
  type OpPlannerConfig,
  type OpPlannerEntry,
  type OpPlannerSnapshot,
} from './op-planner';

function baseSnapshot(): OpPlannerSnapshot {
  return opPlannerSnapshotSchema.parse({
    groups: [{ groupId: 'group_alpha-0001' }],
    villages: [
      { villageId: '1001', coordinate: '100|100', groupIds: ['group_alpha-0001'] },
      { villageId: '1002', coordinate: '110|100', groupIds: ['group_alpha-0001'] },
      { villageId: '1003', coordinate: '120|100', groupIds: ['group_alpha-0001'] },
      { villageId: '1004', coordinate: '130|100', groupIds: ['group_alpha-0001'] },
    ],
  });
}

function configFor(criterion: OpCriterion, targetsText = '200|200\n300|300'): OpPlannerConfig {
  return opPlannerConfigSchema.parse({
    entries: [
      {
        tag: 'nobre',
        commandKind: 'attack',
        criterion,
        targetsText,
        maximumDistanceFields: null,
        groupId: 'group_alpha-0001',
      },
    ],
  });
}

describe('planOpPlanner', () => {
  it('distribui origens canonicamente e ordena pares por alvo e depois origem', () => {
    const plan = planOpPlanner({ snapshot: baseSnapshot(), config: configFor('distribuir') });

    expect(plan.state).toBe('ready');
    expect(plan.algorithmVersion).toBe('op-planner-1');
    expect(plan.results[0]?.pairs).toEqual([
      {
        sourceVillageId: '1001',
        sourceCoordinate: '100|100',
        targetCoordinate: '200|200',
        distanceFields: Math.hypot(100, 100),
      },
      {
        sourceVillageId: '1003',
        sourceCoordinate: '120|100',
        targetCoordinate: '200|200',
        distanceFields: Math.hypot(80, 100),
      },
      {
        sourceVillageId: '1002',
        sourceCoordinate: '110|100',
        targetCoordinate: '300|300',
        distanceFields: Math.hypot(190, 200),
      },
      {
        sourceVillageId: '1004',
        sourceCoordinate: '130|100',
        targetCoordinate: '300|300',
        distanceFields: Math.hypot(170, 200),
      },
    ]);
    expect(plan.results[0]?.metrics).toMatchObject({
      origins: 4,
      targets: 2,
      pairs: 4,
      minimumPerTarget: 2,
      maximumPerTarget: 2,
    });
    expect(plan).toMatchObject({ effectsAllowed: false, sentToTribalWars: false, scheduledCommands: 0 });
  });

  it('mantém vetores dourados independentes para os seis critérios', () => {
    const goldenSnapshot = opPlannerSnapshotSchema.parse({
      groups: [{ groupId: 'group_alpha-0001' }],
      villages: [
        { villageId: '2001', coordinate: '6|15', groupIds: ['group_alpha-0001'] },
        { villageId: '2002', coordinate: '15|10', groupIds: ['group_alpha-0001'] },
        { villageId: '2003', coordinate: '8|12', groupIds: ['group_alpha-0001'] },
        { villageId: '2004', coordinate: '12|2', groupIds: ['group_alpha-0001'] },
        { villageId: '2005', coordinate: '6|9', groupIds: ['group_alpha-0001'] },
      ],
    });
    const targets = '4|13\n9|10\n7|9';
    const expected = {
      distribuir: ['6|15→4|13', '12|2→4|13', '15|10→9|10', '6|9→9|10', '8|12→7|9'],
      mais_proximas: ['6|15→4|13', '15|10→9|10', '8|12→9|10', '12|2→7|9', '6|9→7|9'],
      mais_distantes: ['15|10→4|13', '12|2→4|13', '6|9→9|10', '6|15→7|9', '8|12→7|9'],
      equalizar: ['6|15→4|13', '15|10→9|10', '12|2→9|10', '8|12→7|9', '6|9→7|9'],
      dispersar_perto: ['6|15→4|13', '15|10→4|13', '8|12→9|10', '12|2→9|10', '6|9→7|9'],
      dispersar_longe: ['12|2→4|13', '6|9→4|13', '15|10→9|10', '8|12→9|10', '6|15→7|9'],
    } as const;
    const expectedMetrics = {
      distribuir: [28.754452953818394, 13.601470508735444, 'none'],
      mais_proximas: [20.666820369288608, 8.602325267042627, 'complete'],
      mais_distantes: [37.4105426103618, 13.601470508735444, 'complete'],
      equalizar: [21.534708530232102, 8.54400374531753, 'complete'],
      dispersar_perto: [26.01025309855489, 11.40175425099138, 'none'],
      dispersar_longe: [32.39243697153303, 13.601470508735444, 'none'],
    } as const;

    for (const criterion of Object.keys(expected) as (keyof typeof expected)[]) {
      const result = planOpPlanner({ snapshot: goldenSnapshot, config: configFor(criterion, targets) }).results[0]!;
      expect(
        result.pairs.map((pair) => `${pair.sourceCoordinate}→${pair.targetCoordinate}`),
        criterion,
      ).toEqual(expected[criterion]);
      expect(result.metrics.totalDistanceFields, criterion).toBeCloseTo(expectedMetrics[criterion][0], 12);
      expect(result.metrics.maximumDistanceFields, criterion).toBeCloseTo(expectedMetrics[criterion][1], 12);
      expect(result.metrics.refinement, criterion).toBe(expectedMetrics[criterion][2]);
    }
  });

  it('normaliza primeiras ocorrências e avisa duplicados, ignoradas, próprias e sem origem sem bloquear', () => {
    const result = planOpPlanner({
      snapshot: baseSnapshot(),
      config: configFor('distribuir', '200|200 e 200|200\nlinha inválida\n100|100\n300|300\n400|400\n500|500\n600|600'),
    }).results[0]!;

    expect(result.normalizedTargets).toEqual(['200|200', '100|100', '300|300', '400|400', '500|500', '600|600']);
    expect(result.warnings).toEqual([
      { type: 'duplicate-targets', count: 1 },
      { type: 'ignored-target-lines', count: 1 },
      { type: 'own-targets', coordinates: ['100|100'] },
      { type: 'targets-without-origin', coordinates: ['500|500', '600|600'] },
    ]);
  });

  it('não acusa alvo próprio em entradas de apoio', () => {
    const config = opPlannerConfigSchema.parse({
      entries: [{ ...configFor('distribuir', '100|100').entries[0]!, commandKind: 'support' }],
    });
    const result = planOpPlanner({ snapshot: baseSnapshot(), config }).results[0]!;

    expect(result.warnings).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'own-targets' })]));
  });

  it('bloqueia o plano inteiro quando qualquer entrada tem um problema tipado', () => {
    const config = opPlannerConfigSchema.parse({
      entries: [
        configFor('mais_proximas').entries[0]!,
        { ...configFor('distribuir').entries[0]!, groupId: 'group_missing-0001' },
      ],
    });
    const plan = planOpPlanner({ snapshot: baseSnapshot(), config });

    expect(plan.state).toBe('blocked');
    expect(plan.results.map((result) => ({ pairs: result.pairs.length, problems: result.problems }))).toEqual([
      { pairs: 0, problems: [] },
      { pairs: 0, problems: ['unknown-group'] },
    ]);
  });

  it('trata alvos vazios como problema e bloqueia o plano', () => {
    const plan = planOpPlanner({ snapshot: baseSnapshot(), config: configFor('distribuir', '') });

    expect(plan.state).toBe('blocked');
    expect(plan.results[0]?.problems).toEqual(['missing-targets']);
    expect(plan.results[0]?.pairs).toEqual([]);
  });

  it('dá precedência autoritativa ao snapshot vazio sobre configuração incompleta', () => {
    const emptySnapshot = opPlannerSnapshotSchema.parse({ groups: [], villages: [] });
    const incomplete = opPlannerConfigSchema.parse({
      entries: [
        {
          tag: '',
          commandKind: 'attack',
          criterion: 'distribuir',
          targetsText: '',
          maximumDistanceFields: null,
          groupId: null,
        },
      ],
    });
    const plan = planOpPlanner({ snapshot: emptySnapshot, config: incomplete });

    expect(plan.state).toBe('empty');
    expect(plan.results[0]).toMatchObject({ pairs: [], problems: [], normalizedTargets: [] });
  });

  it('configuração sem entradas produz estado vazio', () => {
    const plan = planOpPlanner({ snapshot: baseSnapshot(), config: opPlannerConfigSchema.parse({ entries: [] }) });

    expect(plan.state).toBe('empty');
    expect(plan.results).toEqual([]);
  });

  it('grupo conhecido sem aldeias produz estado vazio com aviso de alvos sem origem', () => {
    const emptyGroupSnapshot = opPlannerSnapshotSchema.parse({
      groups: [{ groupId: 'group_alpha-0001' }],
      villages: [],
    });
    const plan = planOpPlanner({ snapshot: emptyGroupSnapshot, config: configFor('distribuir') });

    expect(plan.state).toBe('empty');
    expect(plan.results[0]?.metrics).toMatchObject({ origins: 0, targets: 2, pairs: 0 });
    expect(plan.results[0]?.warnings).toContainEqual({
      type: 'targets-without-origin',
      coordinates: ['200|200', '300|300'],
    });
  });

  it('trata grupo nulo ou vazio como todas as aldeias do snapshot', () => {
    const config = opPlannerConfigSchema.parse({
      entries: [{ ...configFor('distribuir').entries[0]!, groupId: '' }],
    });
    const plan = planOpPlanner({ snapshot: baseSnapshot(), config });

    expect(plan.state).toBe('ready');
    expect(plan.results[0]?.metrics).toMatchObject({ origins: 4, pairs: 4 });
  });

  it('aplica alcance opcional e avisa o alvo globalmente inalcançável sem inventar comando', () => {
    const reachSnapshot = opPlannerSnapshotSchema.parse({
      groups: [{ groupId: 'group_alpha-0001' }],
      villages: [
        { villageId: '3001', coordinate: '0|0', groupIds: ['group_alpha-0001'] },
        { villageId: '3002', coordinate: '9|0', groupIds: ['group_alpha-0001'] },
        { villageId: '3003', coordinate: '20|0', groupIds: ['group_alpha-0001'] },
      ],
    });
    const config = opPlannerConfigSchema.parse({
      entries: [{ ...configFor('distribuir', '1|0\n10|0\n100|0').entries[0]!, maximumDistanceFields: 2 }],
    });
    const result = planOpPlanner({ snapshot: reachSnapshot, config }).results[0]!;

    expect(result.pairs.map((pair) => `${pair.sourceCoordinate}→${pair.targetCoordinate}`)).toEqual([
      '0|0→1|0',
      '9|0→10|0',
    ]);
    expect(result.metrics).toMatchObject({
      pairs: 2,
      totalDistanceFields: 2,
      averageDistanceFields: 1,
      maximumDistanceFields: 1,
    });
    expect(result.warnings).toContainEqual({ type: 'targets-without-origin', coordinates: ['100|0'] });
    expect(result).not.toHaveProperty('commands');
  });

  it('deriva entryId canônico determinístico no formato op_<hex16>', () => {
    const first = planOpPlanner({ snapshot: baseSnapshot(), config: configFor('mais_proximas', '500|500') })
      .results[0]!;
    const second = planOpPlanner({ snapshot: baseSnapshot(), config: configFor('mais_proximas', '500|500') })
      .results[0]!;
    const differentTag = planOpPlanner({
      snapshot: baseSnapshot(),
      config: opPlannerConfigSchema.parse({
        entries: [{ ...configFor('mais_proximas', '500|500').entries[0]!, tag: 'fake' }],
      }),
    }).results[0]!;
    const invertedTargets = planOpPlanner({
      snapshot: baseSnapshot(),
      config: configFor('mais_proximas', '600|600\n500|500'),
    }).results[0]!;

    expect(first.entryId).toMatch(/^op_[a-f0-9]{16}$/);
    expect(second.entryId).toBe(first.entryId);
    expect(differentTag.entryId).not.toBe(first.entryId);
    expect(invertedTargets.entryId).not.toBe(first.entryId);
  });

  it('inclui groupId e maximumDistanceFields no entryId: configs diferentes não colidem no hash', () => {
    const snapshot = baseSnapshot();
    const base = {
      tag: 'nobre',
      commandKind: 'attack' as const,
      criterion: 'mais_proximas' as const,
      targetsText: '500|500\n600|600',
      maximumDistanceFields: null,
      groupId: 'group_alpha-0001',
    };
    const entry = (overrides: Partial<OpPlannerEntry> = {}): OpPlannerEntry =>
      opPlannerEntrySchema.parse({ ...base, ...overrides });

    const noGroup = planOpPlanner({
      snapshot,
      config: opPlannerConfigSchema.parse({ entries: [entry({ groupId: null })] }),
    }).results[0]!.entryId;
    const withGroup = planOpPlanner({ snapshot, config: opPlannerConfigSchema.parse({ entries: [entry({})] }) })
      .results[0]!.entryId;
    const noReach = planOpPlanner({
      snapshot,
      config: opPlannerConfigSchema.parse({ entries: [entry({ maximumDistanceFields: null })] }),
    }).results[0]!.entryId;
    const withReach = planOpPlanner({
      snapshot,
      config: opPlannerConfigSchema.parse({ entries: [entry({ maximumDistanceFields: 5 })] }),
    }).results[0]!.entryId;

    expect(noGroup).not.toBe(withGroup);
    expect(noReach).not.toBe(withReach);
  });

  it('usa o fnv1a64 canônico (canonical-ids): o entryId bate com o hash direto do canônico', () => {
    const entry = configFor('mais_proximas', '500|500').entries[0]!;
    const result = planOpPlanner({ snapshot: baseSnapshot(), config: { entries: [entry] } }).results[0]!;

    // Comparação indireta das duas implementações: mesmo algortimo → mesmo ID
    // (a cópia local foi aposentada em favor do canonical-ids).
    const canonicalInput = `${entry.tag}|${entry.commandKind}|${entry.criterion}|${entry.groupId ?? ''}|${entry.maximumDistanceFields ?? ''}|500|500`;
    expect(result.entryId).toBe(`op_${fnv1a64(canonicalInput)}`);
  });

  it('proíbe maximumDistanceFields === 0 no schema (limite nulo cobre "sem limite")', () => {
    const entry = {
      tag: 'nobre',
      commandKind: 'attack',
      criterion: 'distribuir',
      targetsText: '200|200',
      maximumDistanceFields: 0,
      groupId: null,
    } as const;

    expect(opPlannerEntrySchema.safeParse(entry).success).toBe(false);
    // nullable continua aceito como "sem limite".
    expect(opPlannerEntrySchema.safeParse({ ...entry, maximumDistanceFields: null }).success).toBe(true);
    expect(opPlannerEntrySchema.safeParse({ ...entry, maximumDistanceFields: 1 }).success).toBe(true);
  });

  it('é determinístico e idêntico com a ordem de entrada invertida', () => {
    const snapshot = opPlannerSnapshotSchema.parse({
      groups: [{ groupId: 'group_alpha-0001' }],
      villages: [
        { villageId: '4001', coordinate: '0|0', groupIds: ['group_alpha-0001'] },
        { villageId: '4002', coordinate: '10|0', groupIds: ['group_alpha-0001'] },
        { villageId: '4003', coordinate: '20|0', groupIds: ['group_alpha-0001'] },
      ],
    });
    const config = configFor('mais_proximas', '1|0\n11|0\n21|0');
    const inverted = opPlannerSnapshotSchema.parse({
      ...snapshot,
      villages: [...snapshot.villages].reverse(),
    });

    const first = planOpPlanner({ snapshot, config });
    const second = planOpPlanner({ snapshot, config });
    const third = planOpPlanner({ snapshot: inverted, config });

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
  });

  it('não muta o snapshot nem a configuração de entrada', () => {
    const snapshot = baseSnapshot();
    const config = configFor('equalizar', '4|13\n9|10\n7|9');
    const snapshotBefore = structuredClone(snapshot);
    const configBefore = structuredClone(config);

    planOpPlanner({ snapshot, config });

    expect(snapshot).toEqual(snapshotBefore);
    expect(config).toEqual(configBefore);
    expect(JSON.stringify({ snapshot, config })).toBe(
      JSON.stringify({ snapshot: snapshotBefore, config: configBefore }),
    );
  });

  it('congela o plano em profundidade', () => {
    const plan = planOpPlanner({ snapshot: baseSnapshot(), config: configFor('distribuir') });
    const result = plan.results[0]!;

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.results)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.pairs)).toBe(true);
    expect(Object.isFrozen(result.pairs[0])).toBe(true);
    expect(Object.isFrozen(result.metrics)).toBe(true);
    expect(Object.isFrozen(result.warnings)).toBe(true);
    expect(Object.isFrozen(result.normalizedTargets)).toBe(true);
  });

  it('revalida a saída contra o schema do plano', () => {
    const plan = planOpPlanner({ snapshot: baseSnapshot(), config: configFor('equalizar', '4|13\n9|10\n7|9') });

    expect(opPlannerPlanSchema.safeParse(plan).success).toBe(true);
    expect(opPlannerPlanSchema.parse(plan)).toEqual(plan);
  });

  it('mantém entradas congeladas intactas', () => {
    const config = configFor('equalizar', '4|13\n9|10\n7|9');
    const snapshot = baseSnapshot();
    const before = JSON.stringify({ snapshot, config });
    Object.freeze(config.entries);
    Object.freeze(config);
    Object.freeze(snapshot.villages);
    Object.freeze(snapshot);

    const first = planOpPlanner({ snapshot, config });
    const second = planOpPlanner({ snapshot, config });
    expect(second).toEqual(first);
    expect(JSON.stringify({ snapshot, config })).toBe(before);
  });

  it('mantém refinamento completo e determinístico nos limites máximos de entrada', () => {
    const villages = Array.from({ length: 500 }, (_, index) => ({
      villageId: `village-${index}`,
      coordinate: `${index % 500}|${Math.floor(index / 500)}`,
      groupIds: ['group_alpha-0001'],
    }));
    const largeSnapshot = opPlannerSnapshotSchema.parse({ groups: [{ groupId: 'group_alpha-0001' }], villages });
    const targets = Array.from({ length: 500 }, (_, index) => `${index % 500}|${100 + Math.floor(index / 500)}`).join(
      '\n',
    );
    const result = planOpPlanner({ snapshot: largeSnapshot, config: configFor('equalizar', targets) }).results[0]!;

    expect(result.metrics.refinement).toBe('complete');
    expect(result.warnings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'incomplete-refinement' })]),
    );
    expect(result.pairs).toHaveLength(500);
  });
});
