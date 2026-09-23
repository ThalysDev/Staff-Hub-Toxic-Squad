import { describe, expect, it } from 'vitest';
import {
  barbarianCultivatorSettingsSchema,
  planBarbarianCultivation,
  type BarbarianCultivatorTarget,
} from './barbarian-cultivator';

function target(overrides: Partial<BarbarianCultivatorTarget> = {}): BarbarianCultivatorTarget {
  return {
    id: 'alvo-1',
    x: 503,
    y: 504,
    points: 1200,
    barbarian: true,
    ...overrides,
  };
}

describe('planejador puro do Cultivador de Bárbaras', () => {
  it('escolhe o primeiro alvo bárbaro e o primeiro edifício não protegido', () => {
    const decision = planBarbarianCultivation(
      barbarianCultivatorSettingsSchema.parse({ catapultsPerWave: 25 }),
      [target({ id: 'alvo-1' }), target({ id: 'alvo-2' })],
      30,
    );

    expect(decision).toEqual({ kind: 'PLAN', targetId: 'alvo-1', building: 'main', catapult: 25 });
  });

  it('ignora alvos que não são bárbaros', () => {
    const decision = planBarbarianCultivation(
      barbarianCultivatorSettingsSchema.parse({}),
      [target({ id: 'de-jogador', barbarian: false })],
      100,
    );

    expect(decision).toEqual({ kind: 'NO_WORK', reason: 'Nenhuma construção bárbara está elegível para cultivo.' });
  });

  it('sem edifício elegível (tudo protegido) devolve NO_WORK da origem', () => {
    const protegidos = ['main', 'barracks', 'stable', 'market', 'wood', 'stone', 'iron', 'farm', 'storage'];
    const decision = planBarbarianCultivation(
      barbarianCultivatorSettingsSchema.parse({ protectedBuildings: protegidos }),
      [target()],
      100,
    );

    expect(decision).toEqual({ kind: 'NO_WORK', reason: 'Nenhuma construção bárbara está elegível para cultivo.' });
  });

  it('catapultas insuficientes bloqueiam a prévia', () => {
    const decision = planBarbarianCultivation(barbarianCultivatorSettingsSchema.parse({}), [target()], 10);

    expect(decision).toEqual({ kind: 'NO_WORK', reason: 'Nenhuma construção bárbara está elegível para cultivo.' });
  });
});
