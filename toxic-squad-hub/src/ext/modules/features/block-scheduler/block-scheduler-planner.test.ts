import { describe, expect, it } from 'vitest';
import {
  BLOCK_SCHEDULER_ALGORITHM_VERSION,
  BLOCK_SCHEDULER_LIMITS,
  blockPlanInputSchema,
  parsePerSlotCounts,
  planBlockSchedule,
  validateBlockPlanInput,
  type BlockCalcMode,
  type BlockCoord,
  type BlockPlanInput,
} from './block-scheduler-planner';

type TravelStub = (from: BlockCoord, to: BlockCoord) => number;

const euclidean: TravelStub = (from, to) => Math.hypot(from.x - to.x, from.y - to.y);
const manhattan: TravelStub = (from, to) => Math.abs(from.x - to.x) + Math.abs(from.y - to.y);

const pairKey = (from: BlockCoord, to: BlockCoord): string => `${from.x}|${from.y}->${to.x}|${to.y}`;

/** Stub determinístico por tabela: par ausente é inalcançável (Infinity). */
const tableTravel = (table: Readonly<Record<string, number>>): TravelStub => {
  return (from, to) => table[pairKey(from, to)] ?? Number.POSITIVE_INFINITY;
};

const makeInput = (input: {
  origins: readonly BlockCoord[];
  targets: readonly BlockCoord[];
  commandsPerOrigin?: string;
  commandsPerTarget?: string;
  allowSameOriginTarget?: boolean;
  calcMode?: BlockCalcMode;
  travelMinutes?: TravelStub;
  timing?: BlockPlanInput['timing'];
}): BlockPlanInput => ({
  origins: input.origins,
  targets: input.targets,
  commandsPerOrigin: input.commandsPerOrigin ?? '1',
  commandsPerTarget: input.commandsPerTarget ?? '1',
  allowSameOriginTarget: input.allowSameOriginTarget ?? false,
  calcMode: input.calcMode ?? 'mais_perto',
  travelMinutes: input.travelMinutes ?? euclidean,
  timing: input.timing ?? null,
});

const sumTravel = (plan: ReturnType<typeof planBlockSchedule>): number =>
  plan.commands.reduce((total, command) => total + command.travelMinutes, 0);

const countBy = (values: readonly string[]): Record<string, number> =>
  values.reduce<Record<string, number>>((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {});

describe('parsePerSlotCounts', () => {
  it('lê cotas por aldeia ("2;1") e cota única ("2")', () => {
    expect(parsePerSlotCounts('2;1')).toEqual([2, 1]);
    expect(parsePerSlotCounts('2')).toEqual([2]);
    expect(parsePerSlotCounts(' 2 ; 1 ')).toEqual([2, 1]);
    expect(parsePerSlotCounts('3;3;3;3')).toEqual([3, 3, 3, 3]);
  });

  it('devolve null para lixo, vazio, decimal e sinal', () => {
    for (const raw of ['', '   ', 'abc', '2;', ';2', '2;;1', '1.5', '2;a', '-2', '+2', '1e3'])
      expect(parsePerSlotCounts(raw), raw).toBeNull();
  });

  it('rejeita zero, negativo e acima do teto', () => {
    expect(parsePerSlotCounts('0')).toBeNull();
    expect(parsePerSlotCounts('0;2')).toBeNull();
    expect(parsePerSlotCounts('2;0')).toBeNull();
    expect(parsePerSlotCounts('-1;2')).toBeNull();
    expect(parsePerSlotCounts(String(BLOCK_SCHEDULER_LIMITS.perSlot + 1))).toBeNull();
  });
});

describe('planBlockSchedule — matriz e cotas', () => {
  it('monta a matriz 2×2 com cotas exatas dos dois lados', () => {
    const origins = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const targets = [
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ];
    const plan = planBlockSchedule(
      makeInput({ origins, targets, commandsPerOrigin: '2;2', commandsPerTarget: '2;2' }),
    );

    expect(plan.version).toBe(BLOCK_SCHEDULER_ALGORITHM_VERSION);
    expect(plan.commands).toHaveLength(4);
    expect(plan.commands.map(({ origin, target }) => [pairKey(origin, target)])).toEqual([
      ['0|0->0|100'],
      ['0|0->0|100'],
      ['100|0->100|100'],
      ['100|0->100|100'],
    ]);
    expect(plan.commands.map(({ index }) => index)).toEqual([0, 1, 2, 3]);
    expect(countBy(plan.commands.map(({ origin }) => `${origin.x}|${origin.y}`))).toEqual({
      '0|0': 2,
      '100|0': 2,
    });
    expect(countBy(plan.commands.map(({ target }) => `${target.x}|${target.y}`))).toEqual({
      '0|100': 2,
      '100|100': 2,
    });
    expect(plan.warnings).toEqual([]);
  });

  it('cota única ("1") vale para todas as aldeias e alvos', () => {
    const origins = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const targets = [
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ];
    const plan = planBlockSchedule(makeInput({ origins, targets }));

    expect(plan.commands).toHaveLength(2);
    expect(plan.commands.map(({ origin, target }) => pairKey(origin, target))).toEqual([
      '0|0->0|100',
      '100|0->100|100',
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it('corta pelo menor lado e avisa em pt-BR quando as cotas são desiguais', () => {
    const plan = planBlockSchedule(
      makeInput({
        origins: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
        targets: [{ x: 0, y: 100 }],
        commandsPerOrigin: '1;1',
        commandsPerTarget: '1',
      }),
    );

    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]?.origin).toEqual({ x: 0, y: 0 });
    expect(plan.warnings).toEqual([
      'Cotas desiguais entre origem (2) e alvo (1): o plano foi limitado a 1 comando.',
      'Origem 100|0 ficou sem par: 1 comando não alocado.',
    ]);
  });

  it('avisa alvo não preenchido quando sobra demanda', () => {
    const plan = planBlockSchedule(
      makeInput({
        origins: [{ x: 0, y: 0 }],
        targets: [
          { x: 0, y: 100 },
          { x: 500, y: 500 },
        ],
        commandsPerOrigin: '1',
        commandsPerTarget: '1;1',
      }),
    );

    expect(plan.commands).toHaveLength(1);
    expect(plan.warnings).toEqual([
      'Cotas desiguais entre origem (1) e alvo (2): o plano foi limitado a 1 comando.',
      'Alvo 500|500 não foi preenchido: falta 1 comando.',
    ]);
  });
});

describe('planBlockSchedule — modos de cálculo', () => {
  it('mais_perto escolhe a cada passo o par de menor viagem', () => {
    const origins = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];
    const targets = [
      { x: 0, y: 5 },
      { x: 9, y: 9 },
    ];
    const plan = planBlockSchedule(
      makeInput({
        origins,
        targets,
        travelMinutes: tableTravel({
          '0|0->0|5': 3,
          '0|0->9|9': 7,
          '1|0->0|5': 5,
          '1|0->9|9': 4,
        }),
      }),
    );

    expect(plan.commands.map(({ origin, target, travelMinutes }) => [pairKey(origin, target), travelMinutes])).toEqual([
      ['0|0->0|5', 3],
      ['1|0->9|9', 4],
    ]);
  });

  it('otimizado melhora o greedy quando o par mínimo global sacrifica a segunda escolha', () => {
    const origins = [
      { x: 0, y: 0 },
      { x: 0, y: 2 },
    ];
    const targets = [
      { x: 1, y: 0 },
      { x: 9, y: 0 },
    ];
    const travelMinutes = tableTravel({
      '0|0->1|0': 1,
      '0|0->9|0': 2,
      '0|2->1|0': 2,
      '0|2->9|0': 10,
    });
    const greedy = planBlockSchedule(makeInput({ origins, targets, travelMinutes, calcMode: 'mais_perto' }));
    const optimized = planBlockSchedule(makeInput({ origins, targets, travelMinutes, calcMode: 'otimizado' }));

    expect(greedy.commands.map(({ origin, target }) => pairKey(origin, target))).toEqual(['0|0->1|0', '0|2->9|0']);
    expect(sumTravel(greedy)).toBe(11);
    expect(optimized.commands.map(({ origin, target }) => pairKey(origin, target))).toEqual(['0|0->9|0', '0|2->1|0']);
    expect(sumTravel(optimized)).toBe(4);
    expect(sumTravel(optimized)).toBeLessThanOrEqual(sumTravel(greedy));
    expect(optimized.commands).toHaveLength(greedy.commands.length);
  });

  it('otimizado preserva as cotas dos dois lados ao trocar alvos', () => {
    const origins = [
      { x: 0, y: 0 },
      { x: 0, y: 2 },
    ];
    const targets = [
      { x: 1, y: 0 },
      { x: 9, y: 0 },
    ];
    const plan = planBlockSchedule(
      makeInput({
        origins,
        targets,
        commandsPerOrigin: '1;1',
        commandsPerTarget: '1;1',
        calcMode: 'otimizado',
        travelMinutes: tableTravel({
          '0|0->1|0': 1,
          '0|0->9|0': 2,
          '0|2->1|0': 2,
          '0|2->9|0': 10,
        }),
      }),
    );

    expect(countBy(plan.commands.map(({ origin }) => `${origin.x}|${origin.y}`))).toEqual({ '0|0': 1, '0|2': 1 });
    expect(countBy(plan.commands.map(({ target }) => `${target.x}|${target.y}`))).toEqual({ '1|0': 1, '9|0': 1 });
    expect(plan.warnings).toEqual([]);
  });

  it('não explode em 20×20 (400 comandos) nos dois modos', () => {
    const origins = Array.from({ length: 20 }, (_, index) => ({ x: index * 10, y: 0 }));
    const targets = Array.from({ length: 20 }, (_, index) => ({ x: (19 - index) * 10, y: 500 }));
    const plans = (['mais_perto', 'otimizado'] as const).map((calcMode) =>
      planBlockSchedule(
        makeInput({
          origins,
          targets,
          commandsPerOrigin: '20',
          commandsPerTarget: '20',
          calcMode,
          travelMinutes: manhattan,
        }),
      ),
    );

    for (const plan of plans) {
      expect(plan.commands).toHaveLength(400);
      expect(plan.warnings).toEqual([]);
      expect(plan.commands.filter(({ origin }) => origin.x === 0)).toHaveLength(20);
      expect(plan.commands.filter(({ target }) => target.x === 0)).toHaveLength(20);
    }
    expect(sumTravel(plans[1]!)).toBeLessThanOrEqual(sumTravel(plans[0]!));
  });
});

describe('planBlockSchedule — regra origem=alvo', () => {
  it('bloqueia o par da própria coordenada e avisa', () => {
    const plan = planBlockSchedule(
      makeInput({
        origins: [{ x: 10, y: 10 }],
        targets: [{ x: 10, y: 10 }],
        allowSameOriginTarget: false,
      }),
    );

    expect(plan.commands).toEqual([]);
    expect(plan.warnings).toEqual([
      'Pares origem=alvo bloqueados: 1 (origem e alvo na mesma coordenada).',
      'Origem 10|10 ficou sem par: 1 comando não alocado.',
      'Alvo 10|10 não foi preenchido: falta 1 comando.',
    ]);
  });

  it('permite o par da própria coordenada quando a opção está ligada', () => {
    const plan = planBlockSchedule(
      makeInput({
        origins: [{ x: 10, y: 10 }],
        targets: [{ x: 10, y: 10 }],
        allowSameOriginTarget: true,
      }),
    );

    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]).toMatchObject({ origin: { x: 10, y: 10 }, target: { x: 10, y: 10 }, index: 0 });
    expect(plan.warnings).toEqual([]);
  });

  it('ignora o par proibido e usa o par disponível do mesmo alvo', () => {
    const plan = planBlockSchedule(
      makeInput({
        origins: [
          { x: 10, y: 10 },
          { x: 20, y: 10 },
        ],
        targets: [{ x: 10, y: 10 }],
        commandsPerOrigin: '1;1',
        commandsPerTarget: '2',
        allowSameOriginTarget: false,
      }),
    );

    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]?.origin).toEqual({ x: 20, y: 10 });
    expect(plan.warnings).toEqual([
      'Pares origem=alvo bloqueados: 1 (origem e alvo na mesma coordenada).',
      'Origem 10|10 ficou sem par: 1 comando não alocado.',
      'Alvo 10|10 não foi preenchido: falta 1 comando.',
    ]);
  });
});

describe('planBlockSchedule — viagem injetada e imutabilidade', () => {
  it('usa travelMinutes injetada, com memoização, e copia as coordenadas', () => {
    const calls: string[] = [];
    const stub: TravelStub = (from, to) => {
      calls.push(pairKey(from, to));
      return 42.5;
    };
    const origins = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ];
    const targets = [{ x: 9, y: 9 }];
    const plan = planBlockSchedule(
      makeInput({
        origins,
        targets,
        commandsPerOrigin: '1;1',
        commandsPerTarget: '2',
        travelMinutes: stub,
        calcMode: 'otimizado',
      }),
    );

    expect(plan.commands.map(({ travelMinutes }) => travelMinutes)).toEqual([42.5, 42.5]);
    expect(calls).toEqual(['1|1->9|9', '2|2->9|9']);
    expect(plan.commands[0]?.origin).not.toBe(origins[0]);
    expect(plan.commands[0]?.origin).toEqual(origins[0]);
  });

  it('congela o plano e não muta a entrada', () => {
    const origins = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const targets = [{ x: 0, y: 100 }];
    const input = makeInput({ origins, targets, commandsPerOrigin: '1;1', commandsPerTarget: '1' });
    const plan = planBlockSchedule(input);

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.commands)).toBe(true);
    expect(Object.isFrozen(plan.commands[0])).toBe(true);
    expect(Object.isFrozen(plan.commands[0]?.origin)).toBe(true);
    expect(Object.isFrozen(plan.commands[0]?.target)).toBe(true);
    expect(Object.isFrozen(plan.warnings)).toBe(true);

    origins[0]!.x = 999;
    origins.push({ x: 7, y: 7 });
    expect(plan.commands[0]?.origin).toEqual({ x: 0, y: 0 });
    expect(input.origins).toHaveLength(3);
  });

  it('é determinístico: a mesma entrada produz o mesmo plano', () => {
    const input = makeInput({
      origins: [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 50, y: 0 },
      ],
      targets: [
        { x: 4, y: 4 },
        { x: 60, y: 0 },
      ],
      commandsPerOrigin: '1;2;1',
      commandsPerTarget: '2;2',
      calcMode: 'otimizado',
      travelMinutes: manhattan,
    });

    expect(planBlockSchedule(input)).toEqual(planBlockSchedule(input));
  });

  it('trata viagem inválida como inalcançável e avisa', () => {
    const plan = planBlockSchedule(
      makeInput({
        origins: [{ x: 0, y: 0 }],
        targets: [{ x: 1, y: 1 }],
        travelMinutes: () => Number.NaN,
      }),
    );

    expect(plan.commands).toEqual([]);
    expect(plan.warnings).toContain('Viagem inválida em 1 par origem-alvo: tratada como inalcançável.');
    expect(plan.warnings).toContain('Origem 0|0 ficou sem par: 1 comando não alocado.');
  });
});

describe('blockPlanInputSchema e validateBlockPlanInput', () => {
  it('rejeita coordenada NaN e fracionária', () => {
    const base = {
      targets: [{ x: 1, y: 1 }],
      commandsPerOrigin: '1',
      commandsPerTarget: '1',
      allowSameOriginTarget: false,
      calcMode: 'mais_perto',
      travelMinutes: euclidean,
      timing: null,
    };

    expect(blockPlanInputSchema.safeParse({ ...base, origins: [{ x: Number.NaN, y: 0 }] }).success).toBe(false);
    expect(blockPlanInputSchema.safeParse({ ...base, origins: [{ x: 0, y: 1.5 }] }).success).toBe(false);
    expect(blockPlanInputSchema.safeParse({ ...base, origins: [{ x: -1, y: 0 }] }).success).toBe(false);
    expect(blockPlanInputSchema.safeParse({ ...base, origins: [{ x: 0, y: 0 }] }).success).toBe(true);
    expect(() =>
      planBlockSchedule(makeInput({ origins: [{ x: Number.NaN, y: 0 }], targets: base.targets })),
    ).toThrow();
  });

  it('erro pt-BR para janela de chegada invertida', () => {
    const input = makeInput({
      origins: [{ x: 0, y: 0 }],
      targets: [{ x: 1, y: 1 }],
      timing: { windowFromMs: 2_000, windowFromToMs: 1_000 },
    });

    expect(validateBlockPlanInput(input)).toBe('Janela de chegada inválida: o fim é anterior ao início.');
    expect(() => planBlockSchedule(input)).toThrow('Janela de chegada inválida: o fim é anterior ao início.');
  });

  it('erro pt-BR para cotas malformadas e fora do número de aldeias', () => {
    const origins = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];
    const targets = [{ x: 5, y: 5 }];

    expect(validateBlockPlanInput(makeInput({ origins, targets, commandsPerOrigin: '0' }))).toBe(
      'Cotas de origem inválidas: use "2;1" (uma por aldeia) ou "2" (todas as aldeias).',
    );
    expect(validateBlockPlanInput(makeInput({ origins, targets, commandsPerOrigin: '1;1;1' }))).toBe(
      'Cotas de origem: informe 1 valor ou exatamente 2 valores separados por ";".',
    );
    expect(validateBlockPlanInput(makeInput({ origins, targets, commandsPerTarget: 'abc' }))).toBe(
      'Cotas de alvo inválidas: use "2;1" (uma por alvo) ou "2" (todos os alvos).',
    );
    expect(validateBlockPlanInput(makeInput({ origins: [], targets }))).toBe('Informe ao menos uma aldeia de origem.');
    expect(validateBlockPlanInput(makeInput({ origins, targets: [] }))).toBe('Informe ao menos um alvo.');
    expect(validateBlockPlanInput(makeInput({ origins, targets }))).toBeNull();
  });

  it('erro pt-BR quando o plano passa do teto de comandos', () => {
    const origins = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ];
    const targets = [
      { x: 5, y: 5 },
      { x: 6, y: 5 },
      { x: 7, y: 5 },
    ];
    const input = makeInput({ origins, targets, commandsPerOrigin: '1000', commandsPerTarget: '1000' });

    expect(validateBlockPlanInput(input)).toBe(
      `O plano excede o teto de ${BLOCK_SCHEDULER_LIMITS.commands} comandos.`,
    );
    expect(() => planBlockSchedule(input)).toThrow(/teto de 2000 comandos/);
  });

  it('aceita chegada comum e janela válida sem agendar horário', () => {
    const origins = [{ x: 0, y: 0 }];
    const targets = [{ x: 3, y: 4 }];

    const arrival = planBlockSchedule(makeInput({ origins, targets, timing: { arrivalMs: 1_700_000_000_000 } }));
    expect(arrival.commands).toHaveLength(1);
    expect(Object.keys(arrival.commands[0]!).sort()).toEqual(['index', 'origin', 'target', 'travelMinutes']);

    const window = makeInput({ origins, targets, timing: { windowFromMs: 1_000, windowFromToMs: 2_000 } });
    expect(validateBlockPlanInput(window)).toBeNull();
    expect(planBlockSchedule(window).commands).toHaveLength(1);

    expect(
      validateBlockPlanInput(makeInput({ origins, targets, timing: { windowFromMs: 1_000 } })),
    ).toBe('Janela de chegada incompleta: informe o início e o fim.');
    expect(
      validateBlockPlanInput(
        makeInput({ origins, targets, timing: { arrivalMs: 1_000, windowFromMs: 1_000, windowFromToMs: 2_000 } }),
      ),
    ).toBe('Informe chegada comum OU janela de chegada, nunca as duas.');
  });
});
