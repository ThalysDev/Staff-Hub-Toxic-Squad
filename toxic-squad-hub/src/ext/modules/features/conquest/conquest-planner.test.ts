// Engine pura da Conquista de Aldeias Livres (onda 5b): filtros, ranking por
// critérios e custo em nobres do pior caso — ambiente node, sem DOM.
import { describe, expect, it } from 'vitest';
import {
  BARBARIAN_LOYALTY_ESTIMATE,
  MAX_NOBLES_PER_TARGET,
  conquestDistance,
  conquestRankingLabel,
  defaultConquestRanking,
  estimateLoyalty,
  noblesNeededFor,
  parseConquestRanking,
  planConquest,
  type ConquestCandidate,
} from './conquest-planner';

const BARBARA: ConquestCandidate = {
  id: '1',
  name: 'Bárbara',
  x: 512,
  y: 478,
  points: 850,
  ownerId: '0',
  farm: 0,
  barracos: 0,
};

const PROXIMA: ConquestCandidate = { ...BARBARA, id: '2', name: 'Perto', x: 500, y: 500, points: 400 };
const LONGE: ConquestCandidate = { ...BARBARA, id: '3', name: 'Longe', x: 600, y: 600, points: 120 };
const GRANDE: ConquestCandidate = { ...BARBARA, id: '4', name: 'Grande', x: 505, y: 505, points: 4_000 };

const ORIGIN = { x: 500, y: 500 };

function plan(candidates: ConquestCandidate[], overrides: Partial<Parameters<typeof planConquest>[0]> = {}) {
  return planConquest({
    candidates,
    origin: ORIGIN,
    maxPoints: 1_000,
    maxDistance: 30,
    minLoyalty: 0,
    ranking: defaultConquestRanking(),
    ...overrides,
  });
}

describe('parseConquestRanking', () => {
  it('texto vazio = ranking padrão (distância e pontos crescentes)', () => {
    expect(parseConquestRanking('')).toEqual({
      ok: true,
      criteria: [
        { key: 'distancia', direction: 'asc' },
        { key: 'pontos', direction: 'asc' },
      ],
    });
    expect(parseConquestRanking('   ').ok).toBe(true);
  });

  it('lê critérios na ordem com direção padrão por critério', () => {
    expect(parseConquestRanking('pontos,farm,barracos,distancia')).toEqual({
      ok: true,
      criteria: [
        { key: 'pontos', direction: 'asc' },
        { key: 'farm', direction: 'desc' },
        { key: 'barracos', direction: 'desc' },
        { key: 'distancia', direction: 'asc' },
      ],
    });
  });

  it("sufixo '-' inverte a direção do critério", () => {
    expect(parseConquestRanking('pontos-,distancia')).toEqual({
      ok: true,
      criteria: [
        { key: 'pontos', direction: 'desc' },
        { key: 'distancia', direction: 'asc' },
      ],
    });
  });

  it('critério desconhecido, repetido ou token vazio derruba o parse inteiro', () => {
    expect(parseConquestRanking('madeira').ok).toBe(false);
    expect(parseConquestRanking('pontos,pontos').ok).toBe(false);
    expect(parseConquestRanking('pontos,,').ok).toBe(false);
    const bad = parseConquestRanking('muralha');
    expect(!bad.ok && bad.reason).toMatch(/não é aceito/);
  });

  it('round-trip do rótulo canônico', () => {
    const parsed = parseConquestRanking('pontos-,distancia');
    expect(parsed.ok && conquestRankingLabel(parsed.criteria)).toBe('pontos-, distancia');
    expect(conquestRankingLabel(defaultConquestRanking())).toBe('distancia, pontos');
  });
});

describe('distância, lealdade e custo em nobres', () => {
  it('distância euclidiana entre coordenadas', () => {
    expect(conquestDistance({ x: 500, y: 500 }, { x: 503, y: 504 })).toBe(5);
    expect(conquestDistance({ x: 500, y: 500 }, { x: 500, y: 500 })).toBe(0);
  });

  it('lealdade: informada vence; aldeia livre sem dado estima 100; jogador sem dado = null', () => {
    expect(estimateLoyalty({ ...BARBARA, loyalty: 40 })).toBe(40);
    expect(estimateLoyalty(BARBARA)).toBe(BARBARIAN_LOYALTY_ESTIMATE);
    expect(estimateLoyalty({ ...BARBARA, ownerId: '12345' })).toBeNull();
  });

  it('nobres do pior caso: teto de 5 e piso de 1', () => {
    expect(noblesNeededFor(100)).toBe(5);
    expect(noblesNeededFor(60)).toBe(3);
    expect(noblesNeededFor(1)).toBe(1);
    expect(noblesNeededFor(0)).toBe(1);
    expect(noblesNeededFor(999)).toBe(MAX_NOBLES_PER_TARGET);
  });
});

describe('planConquest', () => {
  it('filtra por pontos, distância e lealdade, contando cada motivo', () => {
    const result = plan(
      [
        PROXIMA,
        LONGE, // 141 campos da origem → distância
        GRANDE, // 4.000 pontos → pontos
        { ...BARBARA, id: '5', name: 'Pequena', x: 501, y: 501, loyalty: 10 }, // lealdade < mínimo
      ],
      { minLoyalty: 50 },
    );
    expect(result.excluded).toEqual({ points: 1, distance: 1, loyalty: 1, noOrigin: 0, unknownLoyalty: 0 });
    expect(result.ranked.map((target) => target.id)).toEqual(['2']);
    expect(result.target?.id).toBe('2');
  });

  it('rankeia pelo critério pedido e devolve o primeiro como alvo', () => {
    const byDistance = plan([LONGE, PROXIMA, { ...BARBARA, id: '6', name: 'Média', x: 520, y: 500 }], {
      maxDistance: 200,
    });
    expect(byDistance.ranked.map((target) => target.id)).toEqual(['2', '6', '3']);
    const byPoints = plan([LONGE, PROXIMA], { maxDistance: 200, ranking: [{ key: 'pontos', direction: 'asc' }] });
    expect(byPoints.target?.id).toBe('3');
    const byPointsDesc = plan([LONGE, PROXIMA], {
      maxDistance: 200,
      ranking: [{ key: 'pontos', direction: 'desc' }],
    });
    expect(byPointsDesc.target?.id).toBe('2');
  });

  it('empate no ranking desempata por id (determinístico, ordem lexicográfica)', () => {
    const gêmeaA: ConquestCandidate = { ...BARBARA, id: '10', x: 501, y: 501 };
    const gêmeaB: ConquestCandidate = { ...BARBARA, id: '9', x: 501, y: 501 };
    // '10' < '9' na ordem lexicográfica — o desempate é estável e repetível.
    expect(plan([gêmeaA, gêmeaB]).target?.id).toBe('10');
    expect(plan([gêmeaB, gêmeaA]).target?.id).toBe('10');
  });

  it('alvo do plano traz distância, lealdade e nobres do pior caso', () => {
    const result = plan([PROXIMA]);
    expect(result.target).toMatchObject({
      id: '2',
      name: 'Perto',
      x: 500,
      y: 500,
      points: 400,
      distance: 0,
      loyalty: 100,
      noblesNeeded: 5,
      priority: 1,
    });
    expect(result.message).toContain('Perto (500|500)');
    expect(result.message).toContain('5 nobres no pior caso');
  });

  it('sem origem com teto de distância: ninguém é elegível (fail-closed)', () => {
    const result = plan([PROXIMA, LONGE], { origin: null, maxDistance: 20 });
    expect(result.target).toBeNull();
    expect(result.excluded.noOrigin).toBe(2);
    expect(result.message).toContain('sem origem para medir distância');
  });

  it('sem origem e sem teto de distância o plano sai com distância null', () => {
    const result = plan([PROXIMA], { origin: null, maxDistance: 0 });
    expect(result.target?.distance).toBeNull();
    expect(result.target?.id).toBe('2');
  });

  it('aldeia de jogador sem lealdade é excluída com contagem própria', () => {
    const result = plan([{ ...BARBARA, id: '7', ownerId: '999', x: 501, y: 501 }]);
    expect(result.target).toBeNull();
    expect(result.excluded.unknownLoyalty).toBe(1);
  });

  it('lista vazia e teto de pontos zerado (sem teto) se comportam como esperado', () => {
    const empty = plan([]);
    expect(empty.target).toBeNull();
    expect(empty.ranked).toEqual([]);
    expect(empty.message).toContain('Nenhuma aldeia livre elegível');
    const noCap = plan([GRANDE], { maxPoints: 0, maxDistance: 200 });
    expect(noCap.target?.id).toBe('4');
  });

  it('resultado é congelado (deep freeze) e não muta a entrada', () => {
    const candidates = [PROXIMA, LONGE];
    const result = plan(candidates, { maxDistance: 200 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.ranked)).toBe(true);
    expect(candidates.map((candidate) => candidate.id)).toEqual(['2', '3']);
  });

  it('limite do relatório ranqueado respeita maxCandidates', () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      ...BARBARA,
      id: String(index + 1),
      x: 501 + index,
      y: 501,
    }));
    const result = plan(many, { maxCandidates: 3 });
    expect(result.ranked).toHaveLength(3);
    expect(result.target?.priority).toBe(1);
  });
});
