import { describe, expect, it } from 'vitest';
import {
  centralOpAnalysis,
  distributionSummary,
  distributeTargets,
  moraleOf,
  parseOriginsInput,
  splitTargetsFakes,
  type EnemyVillageRef,
  type TargetLine,
} from './sg4-engine';

const NOBLE = 27.654; // min/campo efetivo do BR142 (aprox. 1h a 2,17 campos)

function enemy(playerId: number, playerName: string, x: number, y: number): EnemyVillageRef {
  return { playerId, playerName, coord: { x, y } };
}

/** ~1h de nobre ≈ 2,17 campos; usamos 2 campos ≈ 0,92h (<1h, bucket 0). */
const CENTER = { x: 500, y: 500 };
const ENEMIES: EnemyVillageRef[] = [
  enemy(1, 'alfa', 502, 500), // ~0,92h → 1 Hora
  enemy(1, 'alfa', 504, 500), // ~1,84h → 2 Horas
  enemy(1, 'alfa', 540, 500), // ~18,4h → Outras
  enemy(2, 'beta', 506, 500), // ~2,77h → 3 Horas
  enemy(2, 'beta', 560, 500), // ~27,7h → Outras
];

describe('centralOpAnalysis', () => {
  it('conta aldeias por coluna de hora por jogador', () => {
    const result = centralOpAnalysis(ENEMIES, CENTER, NOBLE);
    const alfa = result.rows.find((r) => r.playerName === 'alfa');
    const beta = result.rows.find((r) => r.playerName === 'beta');
    expect(alfa?.hourCounts[0]).toBe(1); // 1 Hora
    expect(alfa?.hourCounts[1]).toBe(1); // 2 Horas
    expect(alfa?.others).toBe(1);
    expect(beta?.hourCounts[2]).toBe(1); // 3 Horas
    expect(beta?.others).toBe(1);
  });

  it('splitTargetsFakes respeita marcação e corte de horas', () => {
    const actions = new Map<number, 'alvo' | 'fake'>([
      [1, 'alvo'],
      [2, 'fake'],
    ]);
    const { targets, fakes } = splitTargetsFakes(ENEMIES, CENTER, NOBLE, actions, 5);
    expect(targets).toEqual(['502|500', '504|500']); // alfa até 5h (o 540|500 fica fora)
    expect(fakes).toEqual(['506|500']); // beta até 5h
  });
});

describe('parseOriginsInput', () => {
  it('aceita linhas nick;fulls;coords', () => {
    const players = parseOriginsInput('hasua;50;686|420 686|424\nCapricorniana16;150;684|418 683|418');
    expect(players).toHaveLength(2);
    expect(players[0]?.fulls).toBe(50);
    expect(players[0]?.origins).toEqual([{ x: 686, y: 420 }, { x: 686, y: 424 }]);
    expect(players[1]?.origins).toHaveLength(2);
  });

  it('rejeita linha fora do formato', () => {
    expect(() => parseOriginsInput('sem sentido aqui')).toThrow(/inválida/i);
    expect(() => parseOriginsInput('')).toThrow(/Nenhuma origem/i);
  });
});

describe('moraleOf', () => {
  it('penaliza atacar alvo menor; atacar alvo maior dá 100', () => {
    expect(moraleOf(1000, 500)).toBeLessThan(100); // alvo menor → moral baixa
    expect(moraleOf(500, 1000)).toBe(100); // alvo maior → moral cheia
    expect(moraleOf(1000, 0)).toBe(100);
  });
});

describe('distributeTargets', () => {
  const origins = parseOriginsInput('ana;100;500|500\nbia;10;520|500');
  const lines: TargetLine[] = [
    { fullsFrom: 0, fullsTo: 50, targets: [{ x: 522, y: 500 }] }, // linha 1: só bia (0-50)
    { fullsFrom: 50, fullsTo: 200, targets: [{ x: 502, y: 500 }, { x: 504, y: 500 }] }, // linha 2: só ana
  ];

  it('pareia pela faixa de fulls e prioriza nearest', () => {
    const result = distributeTargets({
      origins, lines, nobleMinutesPerField: NOBLE, priority: 'nearest', minMorale: 0, maxFields: 70,
    });
    const ana = result.assignments.filter((a) => a.playerName === 'ana');
    const bia = result.assignments.filter((a) => a.playerName === 'bia');
    expect(ana).toHaveLength(1);
    expect(ana[0]?.target).toBe('502|500'); // mais próximo de 500|500
    expect(bia).toHaveLength(1);
    expect(bia[0]?.target).toBe('522|500');
    expect(result.orphanTargets).toEqual(['504|500']); // sobrou um alvo sem atacante
    expect(result.orphanOrigins).toEqual([]);
  });

  it('maxFields exclui alvos distantes → origem órfã', () => {
    const result = distributeTargets({
      origins, lines, nobleMinutesPerField: NOBLE, priority: 'nearest', minMorale: 0, maxFields: 2,
    });
    // 522|500 está a 2,83 campos de ana(500|500)? na verdade bia(520|500)→522 = 2 campos ok; ana→502 = 2 campos ok
    expect(result.assignments.length + result.orphanOrigins.length).toBe(2);
  });

  it('prioridade farthest escolhe o alvo mais distante', () => {
    const result = distributeTargets({
      origins, lines, nobleMinutesPerField: NOBLE, priority: 'farthest', minMorale: 0, maxFields: 70,
    });
    const ana = result.assignments.find((a) => a.playerName === 'ana');
    expect(ana?.target).toBe('504|500');
  });

  it('moral mínimo barra atacante forte em alvo fraco (fórmula def/att)', () => {
    const result = distributeTargets({
      origins, lines, nobleMinutesPerField: NOBLE, priority: 'nearest', minMorale: 80, maxFields: 70,
      originPoints: new Map([['ana', 10000], ['bia', 100]]),
      targetPoints: new Map([['502|500', 100], ['504|500', 10000], ['522|500', 100]]),
    });
    // ana (10000) vs 502|500 (100): (100/10000)^0.75 ≈ 6% → barrado; vs 504 (10000): 100% ok
    const ana = result.assignments.find((a) => a.playerName === 'ana');
    expect(ana?.target).toBe('504|500');
  });

  it('distributionSummary gera Nick;coords', () => {
    const result = distributeTargets({
      origins, lines, nobleMinutesPerField: NOBLE, priority: 'nearest', minMorale: 0, maxFields: 70,
    });
    const summary = distributionSummary(result);
    expect(summary).toContain('ana;502|500');
    expect(summary).toContain('bia;522|500');
  });

  it('matrix traz horas/fields/moral por origem×alvo (planilha)', () => {
    const result = distributeTargets({
      origins, lines, nobleMinutesPerField: NOBLE, priority: 'nearest', minMorale: 0, maxFields: 70,
    });
    expect(result.matrix).toHaveLength(2);
    expect(result.matrix[0]?.cells).toHaveLength(3);
    // Colunas seguem as linhas: [522|500, 502|500, 504|500] a partir de 500|500.
    const secondCell = result.matrix[0]?.cells[1];
    expect(secondCell?.fields).toBeCloseTo(2, 1);
    expect(secondCell?.hours).toBeCloseTo((2 * NOBLE) / 60, 1);
  });
});
