// Testes do Planner de OP em Massa (v0.29.0 — semânticas da ferramenta real):
// parsing de GRUPOS "1;2", validação, cruzamento por modo/cotas/repetição,
// chegadas fixa/intervalo/sequencial, torre, moral, conflito de ms, IDs de
// vila e determinismo. Datas no fuso local (mesma disciplina de night-bonus).

import { describe, expect, it } from 'vitest';
import {
  generateMassPlan,
  parseMassCoordGroups,
  pointSegmentDistanceFields,
  pushArrivalOutOfNightWindow,
  validateMassGroup,
} from './mass-planner-engine';
import type { MassGroupConfig, MassPlanContext } from './mass-planner-types';

/** Narrowing estrito do índice (noUncheckedIndexedAccess): falha o teste se ausente. */
function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('comando esperado não existe no resultado');
  return value;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Forma NightBonusCfg (igual ao WorldConfig) — o IPC de mundo devolve
// {active,startHour,endHour} e o caller do renderer converte para a engine.
const BN_BR142 = { nightBonusActive: true, nightStartHour: 23, nightEndHour: 7 };
const BN_OFF = { nightBonusActive: false, nightStartHour: 0, nightEndHour: 0 };

function baseCtx(overrides?: Partial<MassPlanContext>): MassPlanContext {
  return {
    unitMinutesPerField: { ram: 26.67, snob: 31.11, catapult: 26.67, axe: 16 },
    nightBonus: BN_OFF,
    villagePoints: new Map(),
    ownerByCoord: new Map(),
    playerPoints: new Map(),
    villageIdByCoord: new Map([
      ['500|500', 213],
      ['510|510', 777],
    ]),
    moralActive: false,
    ...overrides,
  };
}

/** Grupo mínimo: 1 origem 500|500 → 1 alvo 510|510 (distância ~14.14), ariete. */
function baseGroup(overrides?: Partial<MassGroupConfig>): MassGroupConfig {
  return {
    id: 'g1',
    nome: 'nuke',
    origins: [{ coord: '500|500', x: 500, y: 500 }],
    originQuotas: [1],
    targets: [{ coord: '510|510', x: 510, y: 510 }],
    targetQuotas: [1],
    repeatOriginSamePlayer: false,
    towers: [],
    towerRadius: 15,
    slowestUnit: 'ram',
    assignMode: 'otimizado',
    minDistance: 0,
    maxDistance: 2000,
    arrivalKind: 'fixa',
    arrivalBaseMs: new Date(2026, 7, 29, 22, 0, 0, 0).getTime(),
    windowStartMs: new Date(2026, 7, 29, 22, 0, 0, 0).getTime(),
    windowEndMs: new Date(2026, 7, 29, 22, 10, 0, 0).getTime(),
    attackDelaySeconds: 30,
    nightBonus: 'desativado',
    avoidMsConflict: false,
    minMorale: 0,
    catapultTargets: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Parsing de grupos e cotas ("A B; C D" + "1;2") — semântica do tool real
// ---------------------------------------------------------------------------

describe('parseMassCoordGroups', () => {
  it('separa grupos por ";" e resolve cotas por grupo (prova real: "1;2")', () => {
    const parsed = parseMassCoordGroups('560|365; 545|397', '1;2');
    expect(parsed.entries.map((entry) => entry.coord)).toEqual(['560|365', '545|397']);
    expect(parsed.quotas).toEqual([1, 2]);
    expect(parsed.quotaError).toBeNull();
  });

  it('um único valor de cota aplica a TODOS os grupos', () => {
    const parsed = parseMassCoordGroups('500|500 501|501; 502|502', '2');
    expect(parsed.entries.map((entry) => entry.coord)).toEqual(['500|500', '501|501', '502|502']);
    expect(parsed.quotas).toEqual([2, 2, 2]);
  });

  it('contagem de valores diferente dos grupos reproduz o erro real do tool', () => {
    const parsed = parseMassCoordGroups('500|500; 501|501; 502|502', '1;2');
    expect(parsed.quotaError).toBe('O número de separadores (;) é diferente.');
  });

  it('valor não inteiro/zero reproduz o erro real do tool', () => {
    expect(parseMassCoordGroups('500|500', '0').quotaError).toBe('Valor de comando inválido.');
    // Contagem casada (2 grupos, 2 valores): aí o valor inválido é que fala.
    expect(parseMassCoordGroups('500|500; 501|501', '1;x').quotaError).toBe('Valor de comando inválido.');
  });

  it('dedupe global e contagem de inválidos atravessam os grupos', () => {
    const parsed = parseMassCoordGroups('500|500 500|500; abc', '1');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.duplicatesRemoved).toBe(1);
    expect(parsed.invalidTokens).toBe(1);
  });

  it('texto simples sem cotas (torres) não produz erro', () => {
    const parsed = parseMassCoordGroups('552|552 553|553', '');
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.quotas).toEqual([1, 1]);
    expect(parsed.quotaError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Geometria da Torre de Vigia
// ---------------------------------------------------------------------------

describe('pointSegmentDistanceFields', () => {
  it('ponto sobre o segmento dista 0', () => {
    expect(pointSegmentDistanceFields(505, 505, 500, 500, 510, 510)).toBe(0);
  });

  it('perpendicular no meio do segmento mede a altura', () => {
    expect(pointSegmentDistanceFields(510, 514, 500, 500, 520, 500)).toBe(14);
  });

  it('projeção além das pontas mede até a extremidade mais próxima', () => {
    expect(pointSegmentDistanceFields(495, 500, 500, 500, 520, 500)).toBe(5);
    expect(pointSegmentDistanceFields(525, 500, 500, 500, 520, 500)).toBe(5);
  });
});

describe('pushArrivalOutOfNightWindow', () => {
  it('mundo sem bônus noturno nunca empurra', () => {
    const arrival = new Date(2026, 7, 29, 1, 0, 0).getTime();
    expect(pushArrivalOutOfNightWindow(arrival, BN_OFF)).toEqual({ arrivalMs: arrival, pushed: false });
  });

  it('janela 23→7: chegada 01:00 vai para 07:00 do mesmo dia', () => {
    const arrival = new Date(2026, 7, 29, 1, 0, 0).getTime();
    const pushed = pushArrivalOutOfNightWindow(arrival, BN_BR142);
    expect(pushed.pushed).toBe(true);
    expect(new Date(pushed.arrivalMs).getHours()).toBe(7);
  });

  it('janela 23→7: chegada 23:30 vai para 07:00 do dia SEGUINTE', () => {
    const arrival = new Date(2026, 7, 29, 23, 30, 0).getTime();
    const pushed = pushArrivalOutOfNightWindow(arrival, BN_BR142);
    expect(pushed.pushed).toBe(true);
    const at = new Date(pushed.arrivalMs);
    expect(at.getHours()).toBe(7);
    expect(at.getDate()).toBe(30);
  });

  it('borda de fechamento é exclusiva: 07:00 exato não é empurrado', () => {
    const arrival = new Date(2026, 7, 29, 7, 0, 0).getTime();
    expect(pushArrivalOutOfNightWindow(arrival, BN_BR142)).toEqual({ arrivalMs: arrival, pushed: false });
  });
});

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

describe('validateMassGroup', () => {
  it('grupo válido não tem erros', () => {
    expect(validateMassGroup(baseGroup(), baseCtx())).toEqual({});
  });

  it('exige nome (teto 40), origens e destinos', () => {
    const errors = validateMassGroup(baseGroup({ nome: '', origins: [], targets: [] }), baseCtx());
    expect(errors.nome).toBeDefined();
    expect(errors.origins).toBeDefined();
    expect(errors.targets).toBeDefined();
    expect(validateMassGroup(baseGroup({ nome: 'x'.repeat(41) }), baseCtx()).nome).toBeDefined();
    expect(validateMassGroup(baseGroup({ nome: 'x'.repeat(40) }), baseCtx()).nome).toBeUndefined();
  });

  it('cotas divergentes das listas ou não inteiras são erro', () => {
    expect(
      validateMassGroup(baseGroup({ originQuotas: [] }), baseCtx()).commandsPerOrigin,
    ).toBeDefined();
    expect(
      validateMassGroup(baseGroup({ targetQuotas: [1, 1] }), baseCtx()).commandsPerTarget,
    ).toBeDefined();
    expect(
      validateMassGroup(baseGroup({ originQuotas: [0] }), baseCtx()).commandsPerOrigin,
    ).toBeDefined();
  });

  it('unidade sem velocidade no mundo é erro', () => {
    expect(validateMassGroup(baseGroup({ slowestUnit: 'knight' }), baseCtx()).slowestUnit).toBeDefined();
  });

  it('distâncias inválidas são erro', () => {
    const errors = validateMassGroup(baseGroup({ minDistance: 10, maxDistance: 10 }), baseCtx());
    expect(errors.maxDistance).toBeDefined();
  });

  it('intervalo exige início e fim (fim depois do início)', () => {
    const base = new Date(2026, 7, 29, 22, 0, 0).getTime();
    const errors = validateMassGroup(
      baseGroup({ arrivalKind: 'intervalo', windowEndMs: base }),
      baseCtx(),
    );
    expect(errors.windowEndMs).toBeDefined();
    const ok = validateMassGroup(
      baseGroup({ arrivalKind: 'intervalo', windowStartMs: base, windowEndMs: base + 60_000 }),
      baseCtx(),
    );
    expect(ok.windowStartMs).toBeUndefined();
    expect(ok.windowEndMs).toBeUndefined();
  });

  it('modo sequencial exige delay ≥ 0', () => {
    const errors = validateMassGroup(
      baseGroup({ arrivalKind: 'sequencial', attackDelaySeconds: -5 }),
      baseCtx(),
    );
    expect(errors.attackDelaySeconds).toBeDefined();
  });

  it('mundo SEM moral: moral mínima não é erro', () => {
    expect(validateMassGroup(baseGroup({ minMorale: 70 }), baseCtx()).minMorale).toBeUndefined();
  });

  it('torres exigem raio positivo', () => {
    const errors = validateMassGroup(
      baseGroup({ towers: [{ coord: '505|505', x: 505, y: 505 }], towerRadius: 0 }),
      baseCtx(),
    );
    expect(errors.towers).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Geração
// ---------------------------------------------------------------------------

describe('generateMassPlan — cruzamento e modos', () => {
  // O1=500|500, O2=505|505; T1=510|510, T2=520|520.
  function fourPointGroup(overrides?: Partial<MassGroupConfig>): MassGroupConfig {
    return baseGroup({
      origins: [
        { coord: '500|500', x: 500, y: 500 },
        { coord: '505|505', x: 505, y: 505 },
      ],
      originQuotas: [1, 1],
      targets: [
        { coord: '510|510', x: 510, y: 510 },
        { coord: '520|520', x: 520, y: 520 },
      ],
      targetQuotas: [1, 1],
      ...overrides,
    });
  }

  it('otimizado (guloso pelo par mais curto) com empate determinístico', () => {
    const result = generateMassPlan([fourPointGroup()], baseCtx());
    expect(result.commands).toHaveLength(2);
    const pairs = result.commands.map((command) => `${command.origin}->${command.target}`);
    expect(pairs).toContain('505|505->510|510');
    expect(pairs).toContain('500|500->520|520');
  });

  it('mais-perto e mais-longe atribuem por alvo na ordem digitada', () => {
    const perto = generateMassPlan([fourPointGroup({ assignMode: 'mais-perto' })], baseCtx());
    const pares = perto.commands.map((command) => `${command.origin}->${command.target}`);
    expect(pares).toContain('505|505->510|510');
    expect(pares).toContain('500|500->520|520');

    const longe = generateMassPlan([fourPointGroup({ assignMode: 'mais-longe' })], baseCtx());
    const paresLonge = longe.commands.map((command) => `${command.origin}->${command.target}`);
    expect(paresLonge).toContain('500|500->510|510');
    expect(paresLonge).toContain('505|505->520|520');
  });

  it('por-jogador distribui os alvos de forma justa entre os jogadores de origem', () => {
    const ctx = baseCtx({
      ownerByCoord: new Map([
        ['500|500', 'JogadorA'],
        ['505|505', 'JogadorB'],
      ]),
    });
    const result = generateMassPlan([fourPointGroup({ assignMode: 'por-jogador' })], ctx);
    expect(result.commands).toHaveLength(2);
    const owners = result.commands.map((command) => command.originOwner).sort();
    expect(owners).toEqual(['JogadorA', 'JogadorB']);
  });

  it('cotas: comandos por origem/alvo controlam a repetição (cota por vila)', () => {
    const result = generateMassPlan(
      [baseGroup({ originQuotas: [3], targetQuotas: [3] })],
      baseCtx(),
    );
    expect(result.commands).toHaveLength(3);
    expect(result.warnings.join('\n')).not.toContain('sem origem elegível');
  });

  it('cotas por GRUPO: "1;2" dá cota 1 à 1ª vila e 2 à 2ª (prova real)', () => {
    const result = generateMassPlan(
      [
        baseGroup({
          origins: [
            { coord: '500|500', x: 500, y: 500 },
            { coord: '505|505', x: 505, y: 505 },
          ],
          originQuotas: [1, 2],
          targets: [{ coord: '510|510', x: 510, y: 510 }],
          targetQuotas: [3],
        }),
      ],
      baseCtx(),
    );
    expect(result.commands).toHaveLength(3);
    const porOrigem = new Map<string, number>();
    for (const command of result.commands) {
      porOrigem.set(command.origin, (porOrigem.get(command.origin) ?? 0) + 1);
    }
    expect(porOrigem.get('500|500')).toBe(1);
    expect(porOrigem.get('505|505')).toBe(2);
  });

  it('demanda sem capacidade vira aviso citando os alvos carentes', () => {
    const result = generateMassPlan(
      [
        baseGroup({
          targets: [
            { coord: '510|510', x: 510, y: 510 },
            { coord: '511|511', x: 511, y: 511 },
          ],
          targetQuotas: [2, 2],
        }),
      ],
      baseCtx(),
    );
    expect(result.commands).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('3 comando(s) sem origem elegível');
  });

  it('repetição desligada limita 1 alvo por (origem, jogador), mas permite ondas no MESMO alvo', () => {
    const ctx = baseCtx({
      ownerByCoord: new Map([
        ['510|510', 'Inimigo'],
        ['511|511', 'Inimigo'],
      ]),
    });
    const group = baseGroup({
      targets: [
        { coord: '510|510', x: 510, y: 510 },
        { coord: '511|511', x: 511, y: 511 },
      ],
      targetQuotas: [1, 1],
      originQuotas: [2],
    });
    expect(generateMassPlan([group], ctx).commands).toHaveLength(1);
    const waves = generateMassPlan(
      [
        baseGroup({
          targets: [{ coord: '510|510', x: 510, y: 510 }],
          targetQuotas: [2],
          originQuotas: [2],
        }),
      ],
      ctx,
    );
    expect(waves.commands).toHaveLength(2);
    const withRepeat = generateMassPlan([{ ...group, repeatOriginSamePlayer: true }], ctx);
    expect(withRepeat.commands).toHaveLength(2);
  });
});

describe('generateMassPlan — filtros', () => {
  it('torre no meio da trajetória descarta o par; torre fora do raio mantém', () => {
    const blocked = generateMassPlan(
      [baseGroup({ towers: [{ coord: '505|505', x: 505, y: 505 }] })],
      baseCtx(),
    );
    expect(blocked.commands).toHaveLength(0);
    expect(blocked.discards).toContainEqual({ reason: 'Trajetória dentro do raio da Torre de Vigia', count: 1 });

    const kept = generateMassPlan(
      [
        baseGroup({
          origins: [{ coord: '500|500', x: 500, y: 500 }],
          targets: [{ coord: '520|500', x: 520, y: 500 }],
          towers: [{ coord: '510|516', x: 510, y: 516 }],
        }),
      ],
      baseCtx(),
    );
    expect(kept.commands).toHaveLength(1);
  });

  it('distância mínima/máxima filtram com descartes contados', () => {
    const result = generateMassPlan([baseGroup({ minDistance: 20, maxDistance: 30 })], baseCtx());
    expect(result.commands).toHaveLength(0);
    expect(result.discards).toContainEqual({ reason: 'Distância menor que o mínimo', count: 1 });

    const far = generateMassPlan([baseGroup({ maxDistance: 10 })], baseCtx());
    expect(far.commands).toHaveLength(0);
    expect(far.discards).toContainEqual({ reason: 'Distância maior que o máximo', count: 1 });
  });

  it('moral mínima descarta par abaixo do limiar e exige pontos (contado)', () => {
    const ctx = baseCtx({
      moralActive: true,
      villagePoints: new Map([['510|510', 100_000]]),
      ownerByCoord: new Map([['500|500', 'Atacante']]),
      playerPoints: new Map([['Atacante', 1_000_000]]),
    });
    const below = generateMassPlan([baseGroup({ minMorale: 70 })], ctx);
    expect(below.commands).toHaveLength(0);
    expect(below.discards).toContainEqual({ reason: 'Moral abaixo do mínimo', count: 1 });

    const above = generateMassPlan([baseGroup({ minMorale: 50 })], ctx);
    expect(above.commands).toHaveLength(1);

    const noPoints = generateMassPlan([baseGroup({ minMorale: 1 })], baseCtx({ moralActive: true }));
    expect(noPoints.commands).toHaveLength(0);
    expect(noPoints.discards).toContainEqual({ reason: 'Moral exigida sem pontos no dump (origem/alvo)', count: 1 });
  });
});

describe('generateMassPlan — chegadas e partida', () => {
  it('chegada fixa: partida = chegada − distância × minutos/campo; IDs de vila no comando', () => {
    const result = generateMassPlan([baseGroup()], baseCtx());
    const command = need(result.commands[0]);
    expect(command.distanceFields).toBeCloseTo(14.14, 2);
    const expectedSend = new Date(2026, 7, 29, 22, 0, 0).getTime() - Math.round(command.travelMinutes * 60_000);
    expect(Math.abs(command.sendMs - expectedSend)).toBeLessThanOrEqual(1000);
    expect(command.originVillageId).toBe(213);
    expect(command.targetVillageId).toBe(777);
  });

  it('intervalo espalha as chegadas ENTRE o início e o fim', () => {
    const result = generateMassPlan(
      [
        baseGroup({
          targets: [
            { coord: '510|510', x: 510, y: 510 },
            { coord: '511|511', x: 511, y: 511 },
            { coord: '512|512', x: 512, y: 512 },
            { coord: '513|513', x: 513, y: 513 },
          ],
          targetQuotas: [1, 1, 1, 1],
          originQuotas: [4],
          arrivalKind: 'intervalo',
          windowStartMs: new Date(2026, 7, 29, 22, 0, 0, 0).getTime(),
          windowEndMs: new Date(2026, 7, 29, 22, 10, 0, 0).getTime(),
        }),
      ],
      baseCtx(),
    );
    expect(result.commands).toHaveLength(4);
    const base = new Date(2026, 7, 29, 22, 0, 0).getTime();
    const offsets = result.commands.map((command) => command.arrivalMs - base).sort((a, b) => a - b);
    expect(offsets).toEqual([0, 150_000, 300_000, 450_000]);
  });

  it('modo sequencial: o ataque MAIS PERTO fica na base; os seguintes atrasam pelo delay (prova real)', () => {
    const result = generateMassPlan(
      [
        baseGroup({
          origins: [{ coord: '500|500', x: 500, y: 500 }],
          originQuotas: [2],
          targets: [
            { coord: '511|511', x: 511, y: 511 }, // mais LONGE (15.56) — digitado 1º
            { coord: '510|510', x: 510, y: 510 }, // mais PERTO (14.14)
          ],
          targetQuotas: [1, 1],
          arrivalKind: 'sequencial',
          attackDelaySeconds: 30,
        }),
      ],
      baseCtx(),
    );
    expect(result.commands).toHaveLength(2);
    const base = new Date(2026, 7, 29, 22, 0, 0).getTime();
    const porAlvo = new Map(result.commands.map((command) => [command.target, command.arrivalMs]));
    expect(porAlvo.get('510|510')).toBe(base); // mais perto = base
    expect(porAlvo.get('511|511')).toBe(base + 30_000); // seguinte = +delay
  });

  it('proteção de bônus noturno empurra chegada para o fim da janela', () => {
    const result = generateMassPlan(
      [
        baseGroup({
          arrivalBaseMs: new Date(2026, 7, 29, 1, 0, 0).getTime(),
          nightBonus: 'reagendar',
        }),
      ],
      baseCtx({ nightBonus: BN_BR142 }),
    );
    const command = need(result.commands[0]);
    expect(new Date(command.arrivalMs).getHours()).toBe(7);
    expect(result.warnings.join(' ')).toContain('1 chegada(s) empurrada(s)');
    expect(new Date(command.sendMs).getTime()).toBeLessThan(command.arrivalMs);
  });

  it('proteção pedida em mundo sem bônus noturno avisa e não altera chegada', () => {
    const arrival = new Date(2026, 7, 29, 1, 0, 0).getTime();
    const result = generateMassPlan([baseGroup({ arrivalBaseMs: arrival, nightBonus: 'reagendar' })], baseCtx());
    expect(result.commands[0]?.arrivalMs).toBe(arrival);
    expect(result.warnings.join(' ')).toContain('sem efeito');
  });

  it('viagem que cruza a janela noturna custa 2× (solver bisseção)', () => {
    const result = generateMassPlan(
      [baseGroup({ arrivalBaseMs: new Date(2026, 7, 29, 10, 0, 0).getTime() })],
      baseCtx({ nightBonus: BN_BR142 }),
    );
    const command = need(result.commands[0]);
    expect(command.travelMinutes).toBeGreaterThan(14.14 * 26.67);
  });
});

describe('generateMassPlan — conflito de ms, ordem e determinismo', () => {
  it('dois comandos no mesmo ms para o mesmo jogador ganham +1ms em cascata', () => {
    const ctx = baseCtx({ ownerByCoord: new Map([['510|510', 'Inimigo']]) });
    const fake = baseGroup({ id: 'fake', nome: 'fake', slowestUnit: 'axe', avoidMsConflict: true });
    const nuke = baseGroup({ id: 'nuke', nome: 'nuke', avoidMsConflict: true });
    const result = generateMassPlan([fake, nuke], ctx);
    const [first, second] = result.commands;
    expect(need(first).arrivalMs + 1).toBe(need(second).arrivalMs);
  });

  it('ordena a OP por chegada crescente entre grupos e é determinística', () => {
    const ctx = baseCtx({
      nightBonus: BN_BR142,
      ownerByCoord: new Map([['510|510', 'Inimigo']]),
    });
    const groups = [
      baseGroup({ id: 'fake', nome: 'fake', slowestUnit: 'axe', arrivalKind: 'sequencial', avoidMsConflict: true }),
      baseGroup({
        id: 'nobre',
        nome: 'nobre',
        slowestUnit: 'snob',
        nightBonus: 'reagendar',
        originQuotas: [2],
        targetQuotas: [2],
      }),
    ];
    const a = generateMassPlan(groups, ctx);
    const b = generateMassPlan(groups, ctx);
    expect(b).toEqual(a);
    const early = baseGroup({
      id: 'early',
      nome: 'early',
      slowestUnit: 'axe',
      arrivalBaseMs: new Date(2026, 7, 29, 20, 0, 0).getTime(),
    });
    const late = baseGroup({
      id: 'late',
      nome: 'late',
      slowestUnit: 'axe',
      arrivalBaseMs: new Date(2026, 7, 29, 21, 0, 0).getTime(),
    });
    const ordered = generateMassPlan([late, early], baseCtx());
    expect(ordered.commands[0]?.groupId).toBe('early');
    expect(ordered.commands[1]?.groupId).toBe('late');
  });

  it('falha fail-closed quando o grupo não tem coordenadas', () => {
    expect(() => generateMassPlan([baseGroup({ targets: [] })], baseCtx())).toThrow(/sem origens ou sem destinos/);
  });

  it('OP real da staff (2428×183 = 444k pares) passa do antigo teto de 250k e gera', () => {
    const many = (start: number, n: number): MassGroupConfig['origins'] =>
      Array.from({ length: n }, (_, i) => {
        const x = start + (i % 30);
        const y = start + Math.floor(i / 30);
        return { coord: `${x}|${y}`, x, y };
      });
    const big = baseGroup({
      origins: many(100, 300),
      originQuotas: many(100, 300).map(() => 1),
      targets: many(400, 850),
      targetQuotas: many(400, 850).map(() => 1),
    });
    // 300×850 = 255k > teto antigo de 250k — hoje gera normal.
    const result = generateMassPlan([big], baseCtx());
    expect(result.commands.length).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => warning.includes('OP pesada'))).toBe(true);
  });

  it('falha quando o cruzamento excede o teto sanitário de 1M de pares', () => {
    const many = (start: number, n: number): MassGroupConfig['origins'] =>
      Array.from({ length: n }, (_, i) => {
        const x = start + (i % 60);
        const y = start + Math.floor(i / 60);
        return { coord: `${x}|${y}`, x, y };
      });
    const big = baseGroup({
      origins: many(100, 1200),
      originQuotas: many(100, 1200).map(() => 1),
      targets: many(400, 1000),
      targetQuotas: many(400, 1000).map(() => 1),
    });
    expect(() => generateMassPlan([big], baseCtx())).toThrow(/teto/);
  });
});
