import { describe, expect, it } from 'vitest';
import { planWallDemolition, wallDemolitionSettingsSchema, type WallDemolitionTarget } from './wall-demolition';

function target(overrides: Partial<WallDemolitionTarget> = {}): WallDemolitionTarget {
  return {
    id: 'alvo-1',
    x: 503,
    y: 504,
    points: 1200,
    wallLevel: 6,
    barbarian: true,
    ...overrides,
  };
}

describe('planejador puro do Demolidor de Muralhas', () => {
  it('planeja a primeira muralha elegível com aríetes suficientes', () => {
    const decision = planWallDemolition(
      wallDemolitionSettingsSchema.parse({ minRams: 15, maxAttempts: 2, minWallLevel: 3 }),
      [target({ id: 'baixa', wallLevel: 1 }), target({ id: 'alvo-1', wallLevel: 6 })],
      20,
    );

    expect(decision).toEqual({ kind: 'PLAN', targetId: 'alvo-1', ram: 15, attempts: 2 });
  });

  it('lista vazia devolve NO_WORK explícito de prévia', () => {
    const decision = planWallDemolition(wallDemolitionSettingsSchema.parse({}), [], 100);

    expect(decision.kind).toBe('NO_WORK');
    if (decision.kind === 'NO_WORK') {
      expect(decision.reason).toContain('Nenhum alvo cadastrado');
    }
  });

  it('sem aríetes suficientes devolve o motivo da origem', () => {
    const decision = planWallDemolition(wallDemolitionSettingsSchema.parse({ minRams: 10 }), [target()], 5);

    expect(decision).toEqual({ kind: 'NO_WORK', reason: 'Nenhuma muralha elegível possui aríetes suficientes.' });
  });

  it('muralha abaixo do mínimo não é elegível', () => {
    const decision = planWallDemolition(wallDemolitionSettingsSchema.parse({ minWallLevel: 5 }), [target({ wallLevel: 4 })], 50);

    expect(decision).toEqual({ kind: 'NO_WORK', reason: 'Nenhuma muralha elegível possui aríetes suficientes.' });
  });
});
