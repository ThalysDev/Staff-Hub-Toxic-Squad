import { describe, expect, it } from 'vitest';
import { SUPPORT_LINE_UNITS, lineTiming, parseSupportLine, type SupportLine } from './support-line-codec';
import { SUPPORT_SEND_GAP_MS, distributeSupport, type DistributorInput, type DistributorOrigin } from './support-distributor';

/** 23/09/2026 12:00:00.000 UTC — relógio fixo dos testes. */
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0, 0);

/** Minutos por campo do jogo (a referência é a unidade mais lenta: espada, 22). */
const SPEEDS: Readonly<Record<string, number>> = {
  spear: 18,
  sword: 22,
  axe: 18,
  archer: 18,
  spy: 9,
  light: 10,
  marcher: 10,
  heavy: 11,
  ram: 20,
  catapult: 20,
};

const units = (values: Partial<Record<string, number>> = {}): Record<string, number> => {
  const result: Record<string, number> = {};
  for (const unit of SUPPORT_LINE_UNITS) result[unit] = values[unit] ?? 0;
  return result;
};

const origin = (
  villageId: number,
  x: number,
  troops: Partial<Record<string, number>>,
  overrides: Partial<DistributorOrigin> = {},
): DistributorOrigin => ({
  villageId,
  x,
  y: 500,
  units: units(troops),
  hasPaladin: false,
  underAttack: false,
  scheduledUnits: units(),
  ...overrides,
});

const line = (troops: Partial<Record<string, number>>, tail = ''): SupportLine => {
  const text = `500|500 ${SUPPORT_LINE_UNITS.map((unit) => troops[unit] ?? 0).join('/')}${tail === '' ? '' : ` ${tail}`}`;
  const parsed = parseSupportLine(text, NOW);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
};

const input = (
  origins: readonly DistributorOrigin[],
  lines: readonly SupportLine[],
  overrides: Partial<DistributorInput> = {},
): DistributorInput => ({
  origins,
  lines,
  mode: 'minimo',
  preference: 'mais_perto',
  includeSlowerUnits: false,
  skipVillagesWithPaladin: true,
  ignoreScheduled: true,
  allowAttackedVillages: false,
  avoidMsConflicts: false,
  reserveUnits: units(),
  // Minutos de viagem = distância de Manhattan até 500|500 (determinístico).
  travelMinutes: (from) => Math.abs(from.x - 500) + Math.abs(from.y - 500),
  unitSpeedsMinutesPerField: SPEEDS,
  ...overrides,
});

describe('support-distributor', () => {
  it('minimo fecha a cota da linha com duas origens, na ordem da preferência', () => {
    const result = distributeSupport(
      input([origin(1, 100, { spear: 40 }), origin(2, 200, { spear: 60 })], [line({ spear: 100 })]),
      NOW,
    );
    expect(result.assignments.map((entry) => [entry.originVillageId, entry.units.spear])).toEqual([
      [2, 60],
      [1, 40],
    ]);
    expect(result.unmet).toEqual([]);
    expect(result.totalAssignedUnits.spear).toBe(100);
    expect(result.assignments.every((entry) => entry.lineIndex === 0)).toBe(true);
  });

  it('maximo esgota a origem mais perto e só então passa para a seguinte', () => {
    const result = distributeSupport(
      input([origin(1, 100, { spear: 150 }), origin(2, 200, { spear: 300 })], [line({ spear: 400 })], {
        mode: 'maximo',
      }),
      NOW,
    );
    expect(result.assignments.map((entry) => [entry.originVillageId, entry.units.spear])).toEqual([
      [2, 300],
      [1, 150],
    ]);
    expect(result.unmet).toEqual([]);
    expect(result.totalAssignedUnits.spear).toBe(450);
  });

  it('maximo manda tudo da origem mesmo passando do pedido', () => {
    const result = distributeSupport(
      input([origin(1, 100, { spear: 100 }), origin(2, 200, { spear: 300 })], [line({ spear: 100 })], {
        mode: 'maximo',
      }),
      NOW,
    );
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]!.originVillageId).toBe(2);
    expect(result.assignments[0]!.units.spear).toBe(300);
  });

  it('pacotes exige a linha inteira vinda de UMA origem que tenha tudo', () => {
    const lines = [line({ spear: 50, sword: 10 })];
    const origins = [origin(1, 200, { spear: 100 }), origin(2, 100, { spear: 50, sword: 10 })];
    const result = distributeSupport(input(origins, lines, { mode: 'pacotes' }), NOW);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]!.originVillageId).toBe(2);
    expect(result.assignments[0]!.units).toEqual(units({ spear: 50, sword: 10 }));
    expect(result.unmet).toEqual([]);
  });

  it('pacotes sem origem completa vai para unmet com o pedido inteiro faltando', () => {
    const lines = [line({ spear: 50, sword: 10 })];
    const origins = [origin(1, 200, { spear: 100 }), origin(2, 100, { spear: 50, sword: 9 })];
    const result = distributeSupport(input(origins, lines, { mode: 'pacotes' }), NOW);
    expect(result.assignments).toEqual([]);
    expect(result.unmet).toHaveLength(1);
    expect(result.unmet[0]!.lineIndex).toBe(0);
    expect(result.unmet[0]!.missing).toEqual(units({ spear: 50, sword: 10 }));
  });

  it('mais_perto e mais_longe escolhem origens opostas', () => {
    const origins = [origin(1, 100, { spear: 100 }), origin(2, 200, { spear: 100 })];
    const lines = [line({ spear: 100 })];
    const nearest = distributeSupport(input(origins, lines), NOW);
    const farthest = distributeSupport(input(origins, lines, { preference: 'mais_longe' }), NOW);
    expect(nearest.assignments[0]!.originVillageId).toBe(2);
    expect(farthest.assignments[0]!.originVillageId).toBe(1);
  });

  it('respeita reserveUnits (tropas que ficam de fora)', () => {
    const result = distributeSupport(
      input([origin(1, 200, { spear: 100 })], [line({ spear: 100 })], { reserveUnits: units({ spear: 60 }) }),
      NOW,
    );
    expect(result.assignments[0]!.units.spear).toBe(40);
    expect(result.unmet[0]!.missing.spear).toBe(60);
  });

  it('ignoreScheduled desconta as tropas já agendadas', () => {
    const origins = [origin(1, 200, { spear: 100 }, { scheduledUnits: units({ spear: 70 }) })];
    const lines = [line({ spear: 100 })];
    const ignored = distributeSupport(input(origins, lines, { ignoreScheduled: true }), NOW);
    const counted = distributeSupport(input(origins, lines, { ignoreScheduled: false }), NOW);
    expect(ignored.assignments[0]!.units.spear).toBe(30);
    expect(ignored.unmet[0]!.missing.spear).toBe(70);
    expect(counted.assignments[0]!.units.spear).toBe(100);
    expect(counted.unmet).toEqual([]);
  });

  it('pula aldeia com paladino quando configurado', () => {
    const origins = [origin(1, 200, { spear: 100 }, { hasPaladin: true })];
    const lines = [line({ spear: 100 })];
    const skipped = distributeSupport(input(origins, lines, { skipVillagesWithPaladin: true }), NOW);
    const allowed = distributeSupport(input(origins, lines, { skipVillagesWithPaladin: false }), NOW);
    expect(skipped.assignments).toEqual([]);
    expect(skipped.unmet[0]!.missing.spear).toBe(100);
    expect(allowed.assignments[0]!.units.spear).toBe(100);
  });

  it('pula aldeia sob ataque quando não permitido', () => {
    const origins = [origin(1, 200, { spear: 100 }, { underAttack: true })];
    const lines = [line({ spear: 100 })];
    const blocked = distributeSupport(input(origins, lines, { allowAttackedVillages: false }), NOW);
    const allowed = distributeSupport(input(origins, lines, { allowAttackedVillages: true }), NOW);
    expect(blocked.assignments).toEqual([]);
    expect(blocked.unmet[0]!.missing.spear).toBe(100);
    expect(allowed.assignments[0]!.units.spear).toBe(100);
  });

  it('pula origem na própria coordenada do destino', () => {
    const origins = [origin(1, 500, { spear: 100 })];
    const result = distributeSupport(input(origins, [line({ spear: 100 })]), NOW);
    expect(result.assignments).toEqual([]);
    expect(result.unmet[0]!.missing.spear).toBe(100);
  });

  it('unmet traz o que faltou depois de esgotar as origens', () => {
    const result = distributeSupport(
      input([origin(1, 200, { spear: 40 }), origin(2, 300, { spear: 20 })], [line({ spear: 100 })]),
      NOW,
    );
    // Ordem de atendimento: a origem mais perto (2, x=300) primeiro.
    expect(result.assignments.map((entry) => entry.units.spear)).toEqual([20, 40]);
    expect(result.unmet).toEqual([{ lineIndex: 0, missing: units({ spear: 40 }) }]);
  });

  it('avoidMsConflicts adianta a partida em 300ms (chegada nunca depois do alvo)', () => {
    const lines = [line({ sword: 20 }, '24/09-21:30:00:000'), line({ sword: 30 }, '24/09-21:30:00:000')];
    const origins = [origin(1, 200, { sword: 100 })];
    const spaced = distributeSupport(input(origins, lines, { avoidMsConflicts: true }), NOW);
    const free = distributeSupport(input(origins, lines, { avoidMsConflicts: false }), NOW);
    const arrivalMs = Date.UTC(2026, 8, 24, 21, 30, 0, 0);
    // Espada é a unidade mais lenta da tabela: viagem de 300min x 60s x 1000ms.
    expect(free.assignments[0]!.departAtMs).toBe(arrivalMs - 300 * 60_000);
    expect(free.assignments[1]!.departAtMs).toBe(arrivalMs - 300 * 60_000);
    expect(spaced.assignments[0]!.departAtMs).toBe(arrivalMs - 300 * 60_000);
    // O espaçamento ADIANTA a segunda partida — a chegada não pode atrasar.
    expect(spaced.assignments[0]!.departAtMs! - spaced.assignments[1]!.departAtMs!).toBe(SUPPORT_SEND_GAP_MS);
    expect(spaced.assignments.every((entry) => entry.departAtMs! + 300 * 60_000 <= arrivalMs)).toBe(true);
    expect(spaced.unmet).toEqual([]);
  });

  it('avoidMsConflicts com chegada cravada adianta a partida da mesma linha', () => {
    const lines = [line({ sword: 100 }, '24/09-21:30:00:000')];
    const origins = [origin(1, 200, { sword: 60 }), origin(2, 300, { sword: 40 })];
    const result = distributeSupport(
      input(origins, lines, { avoidMsConflicts: true, travelMinutes: () => 60 }),
      NOW,
    );
    const arrivalMs = Date.UTC(2026, 8, 24, 21, 30, 0, 0);
    expect(result.assignments).toHaveLength(2);
    const departures = result.assignments.map((entry) => entry.departAtMs!);
    expect(departures[0]).toBe(arrivalMs - 60 * 60_000);
    expect(departures[0]! - departures[1]!).toBe(SUPPORT_SEND_GAP_MS);
    for (const departure of departures) expect(departure + 60 * 60_000).toBeLessThanOrEqual(arrivalMs);
    expect(result.unmet).toEqual([]);
  });

  it('janela apertada demais para adiantar recusa o assignment com reason (missing vazio)', () => {
    // Janela de 100ms: adiantar 300ms faria a chegada antes do início.
    const lines = [line({ sword: 100 }, 'i24/09-21:29:59:900 24/09-21:30:00:000')];
    const origins = [origin(1, 200, { sword: 60 }), origin(2, 300, { sword: 40 })];
    const result = distributeSupport(
      input(origins, lines, { avoidMsConflicts: true, travelMinutes: () => 60 }),
      NOW,
    );
    expect(result.assignments).toHaveLength(1);
    expect(result.unmet).toHaveLength(1);
    expect(result.unmet[0]!.lineIndex).toBe(0);
    // missing vazio: nada FALTOU — a recusa é de segurança (âncora de chegada).
    expect(result.unmet[0]!.missing).toEqual(units());
    expect(result.unmet[0]!.reason).toMatch(/colisão de milissegundo/);
    expect(result.unmet[0]!.reason).toMatch(/janela/);
  });

  it('linha imediata segue sem partida agendada e não consome o espaçamento', () => {
    const lines = [
      line({ sword: 10 }, '24/09-21:30:00:000'),
      line({ sword: 10 }),
      line({ sword: 10 }, '24/09-21:30:00:000'),
    ];
    const result = distributeSupport(
      input([origin(1, 200, { sword: 100 })], lines, { avoidMsConflicts: true, travelMinutes: () => 60 }),
      NOW,
    );
    const arrivalMs = Date.UTC(2026, 8, 24, 21, 30, 0, 0);
    expect(result.assignments[1]!.departAtMs).toBeNull();
    expect(result.assignments[0]!.departAtMs).toBe(arrivalMs - 60 * 60_000);
    expect(result.assignments[0]!.departAtMs! - result.assignments[2]!.departAtMs!).toBe(SUPPORT_SEND_GAP_MS);
  });

  it('includeSlowerUnits completa a cota com unidade mais lenta', () => {
    const origins = [origin(1, 200, { spear: 40, sword: 100 })];
    const lines = [line({ spear: 100 })];
    const strict = distributeSupport(input(origins, lines, { includeSlowerUnits: false }), NOW);
    const flexible = distributeSupport(input(origins, lines, { includeSlowerUnits: true }), NOW);
    expect(strict.assignments[0]!.units).toEqual(units({ spear: 40 }));
    expect(strict.unmet[0]!.missing.spear).toBe(60);
    expect(flexible.assignments).toHaveLength(1);
    expect(flexible.assignments[0]!.units).toEqual(units({ spear: 40, sword: 60 }));
    expect(flexible.unmet).toEqual([]);
  });

  it('não usa unidades mais rápidas nem pedidas para completar cota', () => {
    // Exploração e cav. leve são MAIS RÁPIDAS que a lança pedida: não entram.
    const origins = [origin(1, 200, { spear: 40, spy: 100, light: 100 })];
    const result = distributeSupport(input(origins, [line({ spear: 100 })], { includeSlowerUnits: true }), NOW);
    expect(result.assignments[0]!.units).toEqual(units({ spear: 40 }));
    expect(result.unmet[0]!.missing.spear).toBe(60);
  });

  it('linha imediata não agenda partida (departAtMs null)', () => {
    const result = distributeSupport(
      input([origin(1, 200, { spear: 100 })], [line({ spear: 100 })]),
      NOW,
    );
    expect(result.assignments[0]!.departAtMs).toBeNull();
  });

  it('linha cravada calcula a partida pela velocidade da unidade mais lenta do comboio', () => {
    const lines = [line({ sword: 10 }, '24/09-21:30:00:000'), line({ spear: 10 }, '24/09-21:30:00:000')];
    const origins = [origin(1, 200, { sword: 10 }), origin(2, 300, { spear: 10 })];
    const result = distributeSupport(
      input(origins, lines, { travelMinutes: () => 60, avoidMsConflicts: false }),
      NOW,
    );
    const arrivalMs = Date.UTC(2026, 8, 24, 21, 30, 0, 0);
    // Espada (22 min/campo) é a referência: viagem injetada entra como está.
    expect(result.assignments[0]!.departAtMs).toBe(arrivalMs - 60 * 60_000);
    // Lança (18 min/campo) escala pela unidade mais lenta do comboio: 18/22.
    expect(result.assignments[1]!.departAtMs).toBe(arrivalMs - Math.round(60 * (18 / 22) * 60_000));
  });

  it('janela usa a data-alvo para agendar a partida', () => {
    const lines = [line({ sword: 10 }, 'i24/09-20:00:00:000 24/09-21:30:00:000')];
    const origins = [origin(1, 200, { sword: 10 })];
    expect(lineTiming(lines[0]!)).toBe('janela');
    const result = distributeSupport(input(origins, lines, { travelMinutes: () => 60 }), NOW);
    expect(result.assignments[0]!.departAtMs).toBe(Date.UTC(2026, 8, 24, 21, 30, 0, 0) - 60 * 60_000);
  });

  it('linha sem unidades pedidas é reportada em unmet sem envio', () => {
    const result = distributeSupport(input([origin(1, 200, { spear: 100 })], [line({})]), NOW);
    expect(result.assignments).toEqual([]);
    expect(result.unmet).toEqual([{ lineIndex: 0, missing: units() }]);
  });

  it('não muta a entrada e devolve resultado congelado', () => {
    const origins = [origin(1, 200, { spear: 100 }, { scheduledUnits: units({ spear: 10 }) })];
    const lines = [line({ spear: 100 }, 'i24/09-20:00:00:000 24/09-21:30:00:000')];
    const before = JSON.stringify({ origins, lines });
    const result = distributeSupport(input(origins, lines, { reserveUnits: units({ spear: 5 }) }), NOW);
    expect(JSON.stringify({ origins, lines })).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.assignments)).toBe(true);
    expect(Object.isFrozen(result.assignments[0])).toBe(true);
    expect(Object.isFrozen(result.assignments[0]!.units)).toBe(true);
    expect(Object.isFrozen(result.unmet)).toBe(true);
    expect(result.assignments[0]!.units.spear).toBe(85);
  });
});
