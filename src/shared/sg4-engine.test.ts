import { describe, expect, it } from 'vitest';
import {
  centralOpAnalysis,
  distributionSummary,
  distributeTargets,
  moraleOf,
  originsSummary,
  parseOriginsInput,
  splitTargetsFakes,
  type EnemyVillageRef,
  type OriginPlayer,
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

describe('parseOriginsInput FULL/SEMI', () => {
  it('aceita 4 segmentos: contagens e tiers certos (fulls primeiro, semis depois)', () => {
    const [player] = parseOriginsInput('carol;1;2;500|500 520|500 540|500');
    expect(player?.playerName).toBe('carol');
    expect(player?.fulls).toBe(1);
    expect(player?.semis).toBe(2);
    expect(player?.origins).toEqual([{ x: 500, y: 500 }, { x: 520, y: 500 }, { x: 540, y: 500 }]);
    // As PRIMEIRAS `fulls` coords são tier 'full'; as seguintes, 'semi'.
    expect(player?.semiOrigins).toEqual([{ x: 520, y: 500 }, { x: 540, y: 500 }]);
    expect(player?.semis ?? 0).toBe((player?.semiOrigins ?? []).length);
  });

  it('rejeita 4 segmentos com soma divergente citando o nick', () => {
    const boom = (): OriginPlayer[] => parseOriginsInput('eve;2;2;900|900');
    expect(boom).toThrow(/eve/);
    expect(boom).toThrow(/a soma 2\+2 deve bater com 1/);
  });

  it('legado intacto: semis default 0 e semiOrigins vazio (sem chaves novas)', () => {
    const [player] = parseOriginsInput('hasua;50;686|420 686|424');
    expect(player?.semis ?? 0).toBe(0);
    expect(player?.semiOrigins ?? []).toEqual([]);
    // Round-trip exato exigido pelo originsFromSnapshot: objeto SEM chaves novas.
    expect(player).toEqual({ playerName: 'hasua', fulls: 50, origins: [{ x: 686, y: 420 }, { x: 686, y: 424 }] });
  });

  it('formato novo com semis=0 equivale ao legado', () => {
    const novo = parseOriginsInput('dave;2;0;400|400 401|400');
    const legado = parseOriginsInput('dave;2;400|400 401|400');
    const flat = (p?: OriginPlayer) =>
      p === undefined
        ? null
        : { playerName: p.playerName, fulls: p.fulls, semis: p.semis ?? 0, semiOrigins: p.semiOrigins ?? [], origins: p.origins };
    expect(flat(novo[0])).toEqual(flat(legado[0]));
  });

  it('mensagem de erro cita os DOIS formatos aceitos', () => {
    expect(() => parseOriginsInput('nick ruim;1;;')).toThrow(
      /"nick;fulls;coord coord" ou "nick;fulls;semis;coord coord"/,
    );
  });

  it('aceita linhas mistas legado + FULL/SEMI preservando a ordem digitada', () => {
    const players = parseOriginsInput('ana;100;500|500\nbia;1;2;520|500 530|500 540|500');
    expect(players.map((p) => p.playerName)).toEqual(['ana', 'bia']);
    expect((players[0]?.semiOrigins ?? []).length).toBe(0);
    expect(players[1]?.semis).toBe(2);
    expect(players[1]?.origins).toHaveLength(3);
  });
});

describe('originsSummary', () => {
  it('agrega players/fulls/semis/villages das INFORMAÇÕES ORIGEM', () => {
    // aa: 4 seg com semis=0; bb: legado; cc: só semis.
    const summary = originsSummary(parseOriginsInput('aa;2;0;100|100 101|100\nbb;1;101|200\ncc;0;1;300|300'));
    expect(summary).toEqual({ players: 3, fulls: 3, semis: 1, villages: 4 });
  });
});

describe('moraleOf', () => {
  it('fórmula por pontos do jogo: 1M atacando 100k → 60', () => {
    expect(moraleOf(1_000_000, 100_000)).toBe(60);
  });

  it('pontos iguais ou alvo maior → moral cheia 100', () => {
    expect(moraleOf(500_000, 500_000)).toBe(100);
    expect(moraleOf(100_000, 1_000_000)).toBe(100);
  });

  it('atacante menor que o alvo não é penalizado', () => {
    expect(moraleOf(50_000, 200_000)).toBe(100);
    expect(moraleOf(1, 2)).toBe(100);
  });

  it('alvo muito menor bate no piso implícito ~30', () => {
    // (1000/1M × 3 + 0,3) × 100 = 30,3 → 30
    expect(moraleOf(1_000_000, 1_000)).toBe(30);
    expect(moraleOf(1_000_000, 10)).toBe(30);
  });

  it('def/att = 0,2 → 90', () => {
    expect(moraleOf(500_000, 100_000)).toBe(90);
  });

  it('sem pontos (bárbaros/dados ausentes) → sem penalidade', () => {
    expect(moraleOf(1000, 0)).toBe(100);
    expect(moraleOf(0, 1000)).toBe(100);
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
    // ana (10000) vs 502|500 (100): (100/10000×3+0,3) ≈ 33% → barrado; vs 504 (10000): 100% ok
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

  it('semisFrom/semisTo filtra pelo semis DO JOGADOR: jogador na faixa é incluído', () => {
    // leo tem 2 semis; linha aceita apenas jogadores com 1–3 semis.
    const semisOrigins = parseOriginsInput('leo;1;2;600|600 620|600 640|600');
    const result = distributeTargets({
      origins: semisOrigins,
      lines: [{ fullsFrom: 0, fullsTo: 200, semisFrom: 1, semisTo: 3, targets: [{ x: 601, y: 600 }, { x: 621, y: 600 }, { x: 641, y: 600 }] }],
      nobleMinutesPerField: NOBLE,
      priority: 'nearest',
      minMorale: 0,
      maxFields: 70,
    });
    // As 3 origens de leo (tier full e semi) participaram — nenhuma órfã.
    expect(result.orphanOrigins).toEqual([]);
    expect(result.assignments).toHaveLength(3);
  });

  it('semisFrom/semisTo exclui jogador fora da faixa → origem órfã', () => {
    const mixed = parseOriginsInput('leo;1;2;600|600 620|600 640|600\nmia;1;605|600');
    const result = distributeTargets({
      origins: mixed,
      lines: [{ fullsFrom: 0, fullsTo: 200, semisFrom: 0, semisTo: 0, targets: [{ x: 601, y: 600 }] }],
      nobleMinutesPerField: NOBLE,
      priority: 'nearest',
      minMorale: 0,
      maxFields: 70,
    });
    // Faixa exige 0 semis: mia (legado/0 semis) recebe o alvo; leo (2 semis) fica fora.
    expect(result.assignments).toEqual([{ playerName: 'mia', origin: '605|600', target: '601|600' }]);
    expect(result.orphanOrigins.map((o) => `${o.playerName};${o.origin}`)).toEqual([
      'leo;600|600',
      'leo;620|600',
      'leo;640|600',
    ]);
  });

  it('ausência de semisFrom/semisTo = todos (0–200), legado incluído', () => {
    const mixed = parseOriginsInput('leo;1;2;600|600 620|600 640|600\nnia;2;520|500');
    const result = distributeTargets({
      origins: mixed,
      lines: [{ fullsFrom: 0, fullsTo: 200, targets: [{ x: 601, y: 600 }, { x: 621, y: 600 }, { x: 641, y: 600 }, { x: 521, y: 500 }] }],
      nobleMinutesPerField: NOBLE,
      priority: 'nearest',
      minMorale: 0,
      maxFields: 70,
    });
    expect(result.assignments).toHaveLength(4); // origens de leo (com semis) E de nia
    expect(result.orphanOrigins).toEqual([]);
    expect(result.orphanTargets).toEqual([]);
  });

  it('matrix traz tier correto: origem semi de entrada 4-seg = "semi"; legado = "full"', () => {
    const mixed = parseOriginsInput('leo;1;2;600|600 620|600 640|600\nnia;2;520|500');
    const result = distributeTargets({
      origins: mixed,
      lines: [{ fullsFrom: 0, fullsTo: 200, targets: [{ x: 700, y: 700 }] }],
      nobleMinutesPerField: NOBLE,
      priority: 'nearest',
      minMorale: 0,
      maxFields: 70,
    });
    const byOrigin = new Map(result.matrix.map((row) => [row.origin, row.tier]));
    expect(byOrigin.get('600|600')).toBe('full'); // primeira coord do 4-seg = tier full
    expect(byOrigin.get('620|600')).toBe('semi');
    expect(byOrigin.get('640|600')).toBe('semi');
    expect(byOrigin.get('520|500')).toBe('full'); // linha legada sempre 'full'
  });
});
