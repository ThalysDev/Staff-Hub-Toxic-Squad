// Testes do Mapeador de Bárbaras (engine pura da Onda 4): janela de pontos,
// distância máxima, ordenação por distância, frescor da exploração e o
// contrato da lista compartilhada com o Auto Farm.
import { describe, expect, it } from 'vitest';
import {
  MAPPER_CONFIG_DEFAULTS,
  MAPPER_CYCLE_ESTIMATE_MS,
  buildMapperTargetList,
  isMapperListStale,
  mapperCoordinates,
  mapperTargetListSchema,
  needsRescout,
  normalizeMapperConfig,
  scoreBarbarianTargets,
  targetCoordinate,
  toBarbarianTarget,
  type BarbarianTarget,
  type ScoredTarget,
} from './barbarian-mapper';

const ORIGIN = { x: 500, y: 500 };
const NOW = Date.parse('2026-09-23T12:00:00.000Z');

function target(overrides: Partial<BarbarianTarget> = {}): BarbarianTarget {
  return { id: 101, x: 500, y: 500, points: 500, ownerId: 0, ...overrides };
}

function config(overrides: Partial<typeof MAPPER_CONFIG_DEFAULTS> = {}) {
  return normalizeMapperConfig({ ...MAPPER_CONFIG_DEFAULTS, ...overrides });
}

function scored(overrides: Partial<ScoredTarget> = {}): ScoredTarget {
  return {
    id: 101,
    x: 500,
    y: 500,
    points: 500,
    ownerId: 0,
    score: 500,
    distanceFields: 0,
    lastScoutedAt: null,
    ...overrides,
  };
}

describe('normalizeMapperConfig', () => {
  it('lixo devolve os defaults e valor fora de faixa cai no default do campo', () => {
    expect(normalizeMapperConfig(null)).toEqual(MAPPER_CONFIG_DEFAULTS);
    expect(normalizeMapperConfig({ maxDistance: 0, updateValue: 99_999, updateMode: 'minutos' })).toEqual(
      MAPPER_CONFIG_DEFAULTS,
    );
  });

  it('janela de pontos invertida é corrigida (não pode filtrar tudo)', () => {
    const normalized = normalizeMapperConfig({ minScore: 800, maxScore: 100 });

    expect(normalized.minScore).toBe(100);
    expect(normalized.maxScore).toBe(800);
  });
});

describe('toBarbarianTarget', () => {
  it('converte id textual do dump e devolve null para linha estranha', () => {
    expect(toBarbarianTarget({ id: '102', x: 502, y: 503, points: 72 })).toEqual({
      id: 102,
      x: 502,
      y: 503,
      points: 72,
      ownerId: 0,
    });
    expect(toBarbarianTarget({ id: '', x: 502, y: 503, points: 72 })).toBeNull();
    expect(toBarbarianTarget({ id: 'x1', x: 502, y: 503, points: 72 })).toBeNull();
    expect(toBarbarianTarget({ id: '102', x: 502, y: Number.NaN, points: 72 })).toBeNull();
  });
});

describe('scoreBarbarianTargets', () => {
  it('mantém só bárbaras dentro da janela de pontos e da distância máxima', () => {
    const scoredTargets = scoreBarbarianTargets(
      [
        target({ id: 1, points: 500 }),
        target({ id: 2, points: 50 }), // abaixo do mínimo
        target({ id: 3, points: 9_000 }), // acima do máximo
        target({ id: 4, points: 500, x: 530, y: 500 }), // 30 campos (limite)
        target({ id: 5, points: 500, x: 531, y: 500 }), // além do limite
        target({ id: 6, points: 500, ownerId: 77 }), // aldeia de jogador
      ],
      ORIGIN,
      config({ minScore: 100, maxScore: 1_000, maxDistance: 30 }),
      NOW,
    );

    expect(scoredTargets.map((candidate) => candidate.id)).toEqual([1, 4]);
    expect(scoredTargets[0]?.score).toBe(500);
    expect(scoredTargets[1]?.distanceFields).toBe(30);
  });

  it('ordena por distância (empate: mais pontos primeiro, depois id)', () => {
    const scoredTargets = scoreBarbarianTargets(
      [
        target({ id: 20, x: 510, y: 500, points: 100 }),
        target({ id: 30, x: 510, y: 500, points: 900 }),
        target({ id: 40, x: 501, y: 500, points: 100 }),
      ],
      ORIGIN,
      config({ maxDistance: 50 }),
      NOW,
    );

    expect(scoredTargets.map((candidate) => candidate.id)).toEqual([40, 30, 20]);
  });

  it('sem exploração registrada o alvo nasce com lastScoutedAt null (nunca inventa frescor)', () => {
    const [only] = scoreBarbarianTargets([target()], ORIGIN, config(), NOW);

    expect(only?.lastScoutedAt).toBeNull();
  });

  it('instante de exploração comprovado entra; data no futuro é descartada', () => {
    const scouted = scoreBarbarianTargets([target({ id: 7 })], ORIGIN, config(), NOW, { '7': NOW - 60_000 });
    expect(scouted[0]?.lastScoutedAt).toBe(NOW - 60_000);

    const future = scoreBarbarianTargets([target({ id: 7 })], ORIGIN, config(), NOW, { '7': NOW + 60_000 });
    expect(future[0]?.lastScoutedAt).toBeNull();
  });

  it('origem inválida devolve lista vazia (nada é pontuado sem referência)', () => {
    expect(scoreBarbarianTargets([target()], { x: Number.NaN, y: 500 }, config(), NOW)).toEqual([]);
  });

  it('não muta as entradas e congela a saída', () => {
    const targets = [target({ id: 7 })];
    const snapshot = JSON.stringify(targets);

    const scoredTargets = scoreBarbarianTargets(targets, ORIGIN, config(), NOW);

    expect(JSON.stringify(targets)).toBe(snapshot);
    expect(Object.isFrozen(scoredTargets)).toBe(true);
    expect(Object.isFrozen(scoredTargets[0])).toBe(true);
  });
});

describe('needsRescout', () => {
  it('alvo sem exploração comprovada sempre precisa de exploração', () => {
    expect(needsRescout(scored({ lastScoutedAt: null }), config(), NOW)).toBe(true);
  });

  it('modo horas: vence no horizonte configurado', () => {
    const policy = config({ updateMode: 'horas', updateValue: 6 });

    expect(needsRescout(scored({ lastScoutedAt: NOW - 5 * 60 * 60 * 1000 }), policy, NOW)).toBe(false);
    expect(needsRescout(scored({ lastScoutedAt: NOW - 6 * 60 * 60 * 1000 }), policy, NOW)).toBe(true);
  });

  it('modo ciclos: usa a régua estimada do ciclo do Hub', () => {
    const policy = config({ updateMode: 'ciclos', updateValue: 3 });

    expect(needsRescout(scored({ lastScoutedAt: NOW - 2 * MAPPER_CYCLE_ESTIMATE_MS }), policy, NOW)).toBe(false);
    expect(needsRescout(scored({ lastScoutedAt: NOW - 3 * MAPPER_CYCLE_ESTIMATE_MS }), policy, NOW)).toBe(true);
  });

  it('data futura ou agora inválido contam como "precisa explorar"', () => {
    expect(needsRescout(scored({ lastScoutedAt: NOW + 60_000 }), config(), NOW)).toBe(true);
    expect(needsRescout(scored({ lastScoutedAt: NOW }), config(), Number.NaN)).toBe(true);
  });
});

describe('lista compartilhada do Mapper', () => {
  const list = buildMapperTargetList({
    generatedAt: new Date(NOW).toISOString(),
    origin: ORIGIN,
    originSource: 'aldeia aberta',
    config: config(),
    targets: [scored({ id: 1, x: 501, y: 501 }), scored({ id: 2, x: 501, y: 501 })],
  });

  it('remove coordenadas repetidas e passa no contrato zod (round-trip)', () => {
    expect(list.targets).toHaveLength(1);
    expect(mapperTargetListSchema.parse(JSON.parse(JSON.stringify(list)))).toEqual(list);
    expect(mapperCoordinates(list)).toEqual(new Set(['501|501']));
    expect(targetCoordinate({ x: 501, y: 501 })).toBe('501|501');
  });

  it('lista velha (ou com data ruim) é reprovada pelo gate de frescor', () => {
    expect(isMapperListStale(list, NOW + 5 * 60 * 60 * 1000, 6)).toBe(false);
    expect(isMapperListStale(list, NOW + 7 * 60 * 60 * 1000, 6)).toBe(true);
    expect(isMapperListStale({ generatedAt: 'ontem' }, NOW, 6)).toBe(true);
  });
});
