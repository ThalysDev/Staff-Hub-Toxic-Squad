// Testes do Planner de OP em Massa: geometria da torre, proteção de bônus
// noturno, validação, cruzamento por modo/capacidade/repetição, agendamento de
// chegadas, conflito de ms e determinismo. Tudo com datas construídas no fuso
// local (mesma disciplina de night-bonus.test.ts) — nada de relógio real.

import { describe, expect, it } from 'vitest';
import {
  generateMassPlan,
  parseMassCoordText,
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
    targets: [{ coord: '510|510', x: 510, y: 510 }],
    towers: [],
    towerRadius: 15,
    slowestUnit: 'ram',
    assignMode: 'otimizado',
    commandsPerOrigin: 1,
    commandsPerTarget: 1,
    repeatOriginSamePlayer: false,
    minDistance: 0,
    maxDistance: 2000,
    arrivalKind: 'fixa',
    arrivalBaseMs: new Date(2026, 7, 29, 22, 0, 0, 0).getTime(),
    windowMinutes: 5,
    perVillageSeconds: 30,
    nightBonus: 'desativado',
    avoidMsConflict: false,
    minMorale: 0,
    catapultTargets: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Geometria da Torre de Vigia
// ---------------------------------------------------------------------------

describe('pointSegmentDistanceFields', () => {
  it('ponto sobre o segmento dista 0', () => {
    expect(pointSegmentDistanceFields(505, 505, 500, 500, 510, 510)).toBe(0);
  });

  it('perpendicular no meio do segmento mede a altura', () => {
    // Segmento horizontal (500,500)→(520,500); torre 14 campos acima do meio.
    expect(pointSegmentDistanceFields(510, 514, 500, 500, 520, 500)).toBe(14);
  });

  it('projeção além das pontas mede até a extremidade mais próxima', () => {
    // Torreta "antes" da origem: a distância é até a própria origem.
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
    expect(new Date(pushed.arrivalMs).getDate()).toBe(29);
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

  it('dia limpo (12:00) passa intacto', () => {
    const arrival = new Date(2026, 7, 29, 12, 0, 0).getTime();
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

  it('exige nome, origens e destinos', () => {
    const errors = validateMassGroup(baseGroup({ nome: '', origins: [], targets: [] }), baseCtx());
    expect(errors.nome).toBeDefined();
    expect(errors.origins).toBeDefined();
    expect(errors.targets).toBeDefined();
  });

  it('unidade sem velocidade no mundo é erro', () => {
    const errors = validateMassGroup(baseGroup({ slowestUnit: 'knight' }), baseCtx());
    expect(errors.slowestUnit).toBeDefined();
  });

  it('capacidades e distâncias inválidas são erro', () => {
    const errors = validateMassGroup(
      baseGroup({ commandsPerOrigin: 0, commandsPerTarget: -1, minDistance: 10, maxDistance: 10 }),
      baseCtx(),
    );
    expect(errors.commandsPerOrigin).toBeDefined();
    expect(errors.commandsPerTarget).toBeDefined();
    expect(errors.maxDistance).toBeDefined();
  });

  it('intervalo exige janela ≥ 1 minuto', () => {
    const errors = validateMassGroup(baseGroup({ arrivalKind: 'intervalo', windowMinutes: 0 }), baseCtx());
    expect(errors.windowMinutes).toBeDefined();
  });

  it('por-aldeia exige intervalo de segundos ≥ 0', () => {
    const errors = validateMassGroup(baseGroup({ arrivalKind: 'fixa-por-aldeia', perVillageSeconds: -5 }), baseCtx());
    expect(errors.perVillageSeconds).toBeDefined();
  });

  it('mundo SEM moral: moral mínima não é erro (engine ignora com aviso)', () => {
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

describe('parseMassCoordText', () => {
  it('normaliza separadores mistos, deduplica e conta inválidos', () => {
    const parsed = parseMassCoordText('500|500 501|501; 502|502\n500|500 abc');
    expect(parsed.entries.map((entry) => entry.coord)).toEqual(['500|500', '501|501', '502|502']);
    expect(parsed.duplicatesRemoved).toBe(1);
    expect(parsed.invalidTokens).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Geração
// ---------------------------------------------------------------------------

describe('generateMassPlan — cruzamento e modos', () => {
  // O1=500|500, O2=505|505; T1=510|510, T2=520|520.
  // d(O1,T1)=14.14 d(O1,T2)=28.28 d(O2,T1)=7.07 d(O2,T2)=21.21.
  function fourPointGroup(overrides?: Partial<MassGroupConfig>): MassGroupConfig {
    return baseGroup({
      origins: [
        { coord: '500|500', x: 500, y: 500 },
        { coord: '505|505', x: 505, y: 505 },
      ],
      targets: [
        { coord: '510|510', x: 510, y: 510 },
        { coord: '520|520', x: 520, y: 520 },
      ],
      ...overrides,
    });
  }

  it('otimizado minimiza a distância total do conjunto (guloso pelo par mais curto)', () => {
    const result = generateMassPlan([fourPointGroup()], baseCtx());
    expect(result.commands).toHaveLength(2);
    const pairs = result.commands.map((command) => `${command.origin}->${command.target}`);
    // Pares ordenados: (O2→T1 7.07) primeiro, depois (O1→T2 28.28) — total 35.35,
    // empate com o pareamento alternativo; o guloso determinístico escolhe estes.
    expect(pairs).toContain('505|505->510|510');
    expect(pairs).toContain('500|500->520|520');
  });

  it('mais-perto atribui por alvo na ordem digitada com a origem mais próxima', () => {
    const result = generateMassPlan([fourPointGroup({ assignMode: 'mais-perto' })], baseCtx());
    const pairs = result.commands.map((command) => `${command.origin}->${command.target}`);
    expect(pairs).toContain('505|505->510|510'); // T1 (7.07) antes de T2 (21.21 sobra)
    expect(pairs).toContain('500|500->520|520');
  });

  it('mais-longe prefere as origens mais distantes de cada alvo', () => {
    const result = generateMassPlan([fourPointGroup({ assignMode: 'mais-longe' })], baseCtx());
    const pairs = result.commands.map((command) => `${command.origin}->${command.target}`);
    expect(pairs).toContain('500|500->510|510'); // 28.28 > 7.07
    expect(pairs).toContain('505|505->520|520'); // 21.21 > 14.14
  });

  it('capacidades: comandos por origem/alvo controlam a repetição', () => {
    const result = generateMassPlan(
      [baseGroup({ commandsPerOrigin: 3, commandsPerTarget: 3 })],
      baseCtx(),
    );
    // 1 origem × 1 alvo: 3 usos de origem, 3 de alvo → 3 comandos.
    expect(result.commands).toHaveLength(3);
    expect(result.warnings.join('\n')).not.toContain('sem origem elegível');
  });

  it('demanda sem capacidade vira aviso citando os alvos carentes', () => {
    const result = generateMassPlan(
      [
        baseGroup({
          targets: [
            { coord: '510|510', x: 510, y: 510 },
            { coord: '511|511', x: 511, y: 511 },
          ],
          commandsPerTarget: 2,
        }),
      ],
      baseCtx(),
    );
    // Demanda 4, capacidade 1 → 1 comando + 3 carentes.
    expect(result.commands).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('3 comando(s) sem origem elegível');
  });

  it('repetição no mesmo player desligada limita 1 alvo por (origem, jogador), mas permite ondas no MESMO alvo', () => {
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
      commandsPerOrigin: 2,
    });
    // Dois alvos do mesmo jogador, repetição desligada → só 1 alvo recebe.
    const blocked = generateMassPlan([group], ctx);
    expect(blocked.commands).toHaveLength(1);
    // Ondas no MESMO alvo continuam valendo (2 comandos no 510|510).
    const waves = generateMassPlan(
      [
        baseGroup({
          targets: [{ coord: '510|510', x: 510, y: 510 }],
          commandsPerOrigin: 2,
          commandsPerTarget: 2,
        }),
      ],
      ctx,
    );
    expect(waves.commands).toHaveLength(2);
    // Repetição ligada libera os dois alvos do mesmo jogador.
    const withRepeat = generateMassPlan([{ ...group, repeatOriginSamePlayer: true }], ctx);
    expect(withRepeat.commands).toHaveLength(2);
  });
});

describe('generateMassPlan — filtros', () => {
  it('torre no meio da trajetória descarta o par; torre fora do raio mantém', () => {
    const towerMid = baseGroup({ towers: [{ coord: '505|505', x: 505, y: 505 }] });
    const blocked = generateMassPlan([towerMid], baseCtx());
    expect(blocked.commands).toHaveLength(0);
    expect(blocked.discards).toContainEqual({ reason: 'Trajetória dentro do raio da Torre de Vigia', count: 1 });

    // Torre a 16 campos da trajetória (segmento horizontal longo): passa.
    const farTower = baseGroup({
      origins: [{ coord: '500|500', x: 500, y: 500 }],
      targets: [{ coord: '520|500', x: 520, y: 500 }],
      towers: [{ coord: '510|516', x: 510, y: 516 }],
    });
    const kept = generateMassPlan([farTower], baseCtx());
    expect(kept.commands).toHaveLength(1);
  });

  it('distância mínima/máxima filtram com descartes contados', () => {
    const result = generateMassPlan(
      [baseGroup({ minDistance: 20, maxDistance: 30 })],
      baseCtx(),
    );
    // d=14.14: abaixo do mínimo → descartado.
    expect(result.commands).toHaveLength(0);
    expect(result.discards).toContainEqual({ reason: 'Distância menor que o mínimo', count: 1 });

    const far = generateMassPlan([baseGroup({ maxDistance: 10 })], baseCtx());
    expect(far.commands).toHaveLength(0);
    expect(far.discards).toContainEqual({ reason: 'Distância maior que o máximo', count: 1 });
  });

  it('moral mínima descarta par abaixo do limiar e exige pontos (fail-soft contado)', () => {
    const ctx = baseCtx({
      moralActive: true,
      villagePoints: new Map([['510|510', 100_000]]),
      ownerByCoord: new Map([['500|500', 'Atacante']]),
      playerPoints: new Map([['Atacante', 1_000_000]]),
    });
    // moral = (100k/1M × 3 + 0.3) × 100 = 60.
    const below = generateMassPlan([baseGroup({ minMorale: 70 })], ctx);
    expect(below.commands).toHaveLength(0);
    expect(below.discards).toContainEqual({ reason: 'Moral abaixo do mínimo', count: 1 });

    const above = generateMassPlan([baseGroup({ minMorale: 50 })], ctx);
    expect(above.commands).toHaveLength(1);

    // Sem pontos no dump: descarte contado, nunca silencioso.
    const noPoints = generateMassPlan([baseGroup({ minMorale: 1 })], baseCtx({ moralActive: true }));
    expect(noPoints.commands).toHaveLength(0);
    expect(noPoints.discards).toContainEqual({ reason: 'Moral exigida sem pontos no dump (origem/alvo)', count: 1 });
  });

  it('mundo sem moral: minMorale é ignorado com aviso', () => {
    const result = generateMassPlan([baseGroup({ minMorale: 80 })], baseCtx());
    expect(result.commands).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('mundo sem moral');
  });
});

describe('generateMassPlan — chegadas e partida', () => {
  it('chegada fixa: partida = chegada − distância × minutos/campo', () => {
    const result = generateMassPlan([baseGroup()], baseCtx());
    expect(result.commands).toHaveLength(1);
    const command = need(result.commands[0]);
    // d(500|500→510|510) = 14.14 campos × 26.67 min = ~377.2 min.
    expect(command.distanceFields).toBeCloseTo(14.14, 2);
    const expectedSend = new Date(2026, 7, 29, 22, 0, 0).getTime() - Math.round(command.travelMinutes * 60_000);
    // travelMinutes vem arredondado a 2 casas (≤ 300ms de diferença na partida).
    expect(Math.abs(command.sendMs - expectedSend)).toBeLessThanOrEqual(1000);
    // Viagem de ~6h17 parte no MESMO dia (29/08) — nada é empurrado de dia.
    expect(new Date(command.sendMs).getDate()).toBe(29);
  });

  it('chegada em intervalo espalha os comandos dentro da janela', () => {
    const result = generateMassPlan(
      [
        baseGroup({
          targets: [
            { coord: '510|510', x: 510, y: 510 },
            { coord: '511|511', x: 511, y: 511 },
            { coord: '512|512', x: 512, y: 512 },
            { coord: '513|513', x: 513, y: 513 },
          ],
          arrivalKind: 'intervalo',
          windowMinutes: 10,
          commandsPerOrigin: 4,
        }),
      ],
      baseCtx(),
    );
    expect(result.commands).toHaveLength(4);
    const arrivals = result.commands.map((command) => command.arrivalMs - new Date(2026, 7, 29, 22, 0, 0).getTime());
    expect(arrivals).toEqual([0, 150_000, 300_000, 450_000]);
  });

  it('chegada fixa com intervalo por aldeia desloca por alvo distinto', () => {
    const result = generateMassPlan(
      [
        baseGroup({
          targets: [
            { coord: '510|510', x: 510, y: 510 },
            { coord: '511|511', x: 511, y: 511 },
            { coord: '510|510', x: 510, y: 510 }, // duplicada: dedupe no parse; aqui vira alvo distinto de índice
          ],
          arrivalKind: 'fixa-por-aldeia',
          perVillageSeconds: 30,
          commandsPerOrigin: 3,
        }),
      ],
      baseCtx(),
    );
    expect(result.commands).toHaveLength(3);
    const base = new Date(2026, 7, 29, 22, 0, 0).getTime();
    const offsets = [...new Set(result.commands.map((command) => command.arrivalMs - base))].sort((a, b) => a - b);
    expect(offsets).toEqual([0, 30_000, 60_000]);
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
    // Partida recalculada para a nova chegada (07:00 − viagem).
    expect(new Date(command.sendMs).getTime()).toBeLessThan(command.arrivalMs);
  });

  it('proteção pedida em mundo sem bônus noturno avisa e não altera chegada', () => {
    const arrival = new Date(2026, 7, 29, 1, 0, 0).getTime();
    const result = generateMassPlan([baseGroup({ arrivalBaseMs: arrival, nightBonus: 'reagendar' })], baseCtx());
    expect(result.commands[0]?.arrivalMs).toBe(arrival);
    expect(result.warnings.join(' ')).toContain('sem efeito');
  });

  it('viagem que cruza a janela noturna custa 2× (solver inverso aplicado)', () => {
    // BR142 BN 23→7: partida 22:00 do dia 28, viagem cruza a meia-noite.
    const group = baseGroup({
      arrivalBaseMs: new Date(2026, 7, 29, 10, 0, 0).getTime(),
    });
    const result = generateMassPlan([group], baseCtx({ nightBonus: BN_BR142 }));
    const command = need(result.commands[0]);
    // Viagem clássica ~377min; cruzando a janela (23→07) a viagem dura mais.
    expect(command.travelMinutes).toBeGreaterThan(14.14 * 26.67);
  });
});

describe('generateMassPlan — conflito de ms e determinismo', () => {
  it('dois comandos no mesmo ms para o mesmo jogador ganham +1ms em cascata', () => {
    const ctx = baseCtx({ ownerByCoord: new Map([['510|510', 'Inimigo']]) });
    const fake = baseGroup({ id: 'fake', nome: 'fake', slowestUnit: 'axe', avoidMsConflict: true });
    const nuke = baseGroup({ id: 'nuke', nome: 'nuke', avoidMsConflict: true });
    const result = generateMassPlan([fake, nuke], ctx);
    expect(result.commands).toHaveLength(2);
    const [first, second] = result.commands;
    expect(need(first).arrivalMs + 1).toBe(need(second).arrivalMs);
  });

  it('conflito de ms entre grupos SEM a marcação não é alterado', () => {
    const ctx = baseCtx({ ownerByCoord: new Map([['510|510', 'Inimigo']]) });
    const result = generateMassPlan(
      [
        baseGroup({ id: 'a', nome: 'a', slowestUnit: 'axe' }),
        baseGroup({ id: 'b', nome: 'b', slowestUnit: 'axe' }),
      ],
      ctx,
    );
    const [first, second] = result.commands;
    expect(need(first).arrivalMs).toBe(need(second).arrivalMs);
  });

  it('mesmo input gera exatamente a mesma operação (determinismo)', () => {
    const ctx = baseCtx({
      nightBonus: BN_BR142,
      ownerByCoord: new Map([['510|510', 'Inimigo']]),
    });
    const groups = [
      baseGroup({ id: 'fake', nome: 'fake', slowestUnit: 'axe', arrivalKind: 'intervalo', avoidMsConflict: true }),
      baseGroup({ id: 'nobre', nome: 'nobre', slowestUnit: 'snob', nightBonus: 'reagendar', commandsPerOrigin: 2, commandsPerTarget: 2 }),
    ];
    const a = generateMassPlan(groups, ctx);
    const b = generateMassPlan(groups, ctx);
    expect(b).toEqual(a);
  });

  it('ordena a OP por chegada crescente entre grupos', () => {
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
    const result = generateMassPlan([late, early], baseCtx());
    expect(result.commands[0]?.groupId).toBe("early");
    expect(result.commands[1]?.groupId).toBe('late');
  });

  it('falha fail-closed quando o grupo não tem coordenadas', () => {
    expect(() => generateMassPlan([baseGroup({ targets: [] })], baseCtx())).toThrow(/sem origens ou sem destinos/);
  });

  it('falha quando o cruzamento excede o teto de pares', () => {
    const many = (start: number): MassGroupConfig['origins'] =>
      Array.from({ length: 501 }, (_, i) => {
        const x = start + (i % 30);
        const y = start + Math.floor(i / 30);
        return { coord: `${x}|${y}`, x, y };
      });
    const big = baseGroup({ origins: many(100), targets: many(400) });
    expect(() => generateMassPlan([big], baseCtx())).toThrow(/teto/);
  });
});
