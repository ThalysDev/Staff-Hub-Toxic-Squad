// Testes do Template C (engine pura da Onda 4): ordem de prioridade, mínimo de
// saque do alvo, fail-closed sem tropas e imutabilidade das entradas.
import { describe, expect, it } from 'vitest';
import {
  FARM_TEMPLATE_C_DEFAULTS,
  FARM_TEMPLATE_C_POINTS_HAUL_FACTOR,
  buildFarmCLot,
  farmTemplateCSchema,
  farmTemplateCSummary,
  normalizeFarmTemplateC,
} from './farm-template-c';

/** Capacidades de carga do contrato do Assistente (subconjunto usado nos testes). */
const CAPACITY: Record<string, number> = { light: 80, marcher: 50, heavy: 50, ram: 0, spear: 25 };

function template(overrides: Partial<Parameters<typeof buildFarmCLot>[2]> = {}) {
  return { ...FARM_TEMPLATE_C_DEFAULTS, ...overrides };
}

describe('normalizeFarmTemplateC', () => {
  it('lixo não-objeto devolve os defaults congelados', () => {
    for (const junk of [null, undefined, 'C', 42, []]) {
      const normalized = normalizeFarmTemplateC(junk);
      expect(normalized).toEqual(FARM_TEMPLATE_C_DEFAULTS);
      expect(Object.isFrozen(normalized)).toBe(true);
      expect(Object.isFrozen(normalized.priority)).toBe(true);
    }
  });

  it('campo com tipo errado cai no default do campo (merge campo a campo)', () => {
    const normalized = normalizeFarmTemplateC({
      id: 7,
      name: 'Meu C',
      priority: 'light',
      minHaulPerCommand: 'muito',
      reScoutHours: null,
      warehouseFullPct: 0,
    });

    expect(normalized).toEqual({
      id: FARM_TEMPLATE_C_DEFAULTS.id,
      name: 'Meu C',
      priority: FARM_TEMPLATE_C_DEFAULTS.priority,
      minHaulPerCommand: FARM_TEMPLATE_C_DEFAULTS.minHaulPerCommand,
      reScoutHours: FARM_TEMPLATE_C_DEFAULTS.reScoutHours,
      warehouseFullPct: FARM_TEMPLATE_C_DEFAULTS.warehouseFullPct,
    });
  });

  it('normaliza prioridade: minúsculas, sem repetição e sem vazio', () => {
    const normalized = normalizeFarmTemplateC({ priority: ['LIGHT', 'light', 'Marcher', ''] });

    expect(normalized.priority).toEqual(['light', 'marcher']);
  });

  it('prioridade toda inválida volta para a prioridade padrão', () => {
    expect(normalizeFarmTemplateC({ priority: ['1x', '-'] }).priority).toEqual(FARM_TEMPLATE_C_DEFAULTS.priority);
    expect(normalizeFarmTemplateC({ priority: [] }).priority).toEqual(FARM_TEMPLATE_C_DEFAULTS.priority);
  });

  it('schema aceita objeto mínimo e completa com defaults', () => {
    const parsed = farmTemplateCSchema.parse({ name: 'Farm rápido' });

    expect(parsed.name).toBe('Farm rápido');
    expect(parsed.priority).toEqual([...FARM_TEMPLATE_C_DEFAULTS.priority]);
    expect(parsed.minHaulPerCommand).toBe(FARM_TEMPLATE_C_DEFAULTS.minHaulPerCommand);
  });
});

describe('buildFarmCLot', () => {
  it('respeita a ordem de prioridade (só a primeira unidade quando ela basta)', () => {
    const decision = buildFarmCLot({ light: 10, marcher: 10, heavy: 10 }, { points: 100 }, template(), CAPACITY);

    expect(decision).toEqual({ units: { light: 3 }, estimatedHaul: 240 });
  });

  it('desce para a próxima unidade quando a de maior prioridade acaba', () => {
    const decision = buildFarmCLot({ light: 1, marcher: 10 }, { points: 100 }, template(), CAPACITY);

    expect(decision).toEqual({ units: { light: 1, marcher: 3 }, estimatedHaul: 230 });
  });

  it('usa os pontos do alvo quando eles superam o piso do template', () => {
    const decision = buildFarmCLot({ light: 100 }, { points: 1000 }, template({ minHaulPerCommand: 200 }), CAPACITY);

    expect(decision).toEqual({ units: { light: 13 }, estimatedHaul: 13 * CAPACITY.light! });
    if ('estimatedHaul' in decision) {
      expect(decision.estimatedHaul).toBeGreaterThanOrEqual(1000 * FARM_TEMPLATE_C_POINTS_HAUL_FACTOR);
    }
  });

  it('nunca ultrapassa o estoque disponível de cada unidade', () => {
    const decision = buildFarmCLot({ light: 2, marcher: 100 }, { points: 100 }, template(), CAPACITY);

    expect(decision).toEqual({ units: { light: 2, marcher: 1 }, estimatedHaul: 2 * 80 + 50 });
  });

  it('sem tropas devolve skip com o motivo do déficit de saque', () => {
    const decision = buildFarmCLot({}, { points: 100 }, template(), CAPACITY);

    expect(decision).toHaveProperty('skip');
    if ('skip' in decision) {
      expect(decision.skip).toContain('Tropas insuficientes');
      expect(decision.skip).toContain('200');
      expect(decision.skip).toContain('100 ponto(s)');
    }
  });

  it('unidade do lote sem capacidade de saque é inofensiva (nunca entra no lote)', () => {
    const decision = buildFarmCLot(
      { light: 10, ram: 50 },
      { points: 100 },
      template({ priority: ['light', 'ram'] }),
      CAPACITY,
    );

    expect(decision).toEqual({ units: { light: 3 }, estimatedHaul: 240 });
  });

  it('prioridade sem nenhuma unidade com capacidade devolve skip explícito', () => {
    const decision = buildFarmCLot({ ram: 50 }, { points: 100 }, template({ priority: ['ram'] }), CAPACITY);

    expect(decision).toHaveProperty('skip');
    if ('skip' in decision) expect(decision.skip).toContain('capacidade de saque');
  });

  it('leva sempre ao menos uma unidade (um comando sem tropa não existe)', () => {
    const decision = buildFarmCLot(
      { light: 5 },
      { points: 0 },
      template({ minHaulPerCommand: 0 }),
      CAPACITY,
    );

    expect(decision).toEqual({ units: { light: 1 }, estimatedHaul: CAPACITY.light });
  });

  it('pontos inválidos do alvo contam como 0 (piso do template decide)', () => {
    const decision = buildFarmCLot({ light: 10 }, { points: Number.NaN }, template(), CAPACITY);

    expect(decision).toEqual({ units: { light: 3 }, estimatedHaul: 240 });
  });

  it('não muta as entradas e devolve estruturas congeladas', () => {
    const available = { light: 4, marcher: 9 };
    const target = { points: 500 };
    const policy = template({ priority: ['light', 'marcher'] });
    const capacity = { light: 80, marcher: 50 };
    const snapshot = JSON.stringify({ available, target, policy, capacity });

    const decision = buildFarmCLot(available, target, policy, capacity);

    expect(JSON.stringify({ available, target, policy, capacity })).toBe(snapshot);
    expect(Object.isFrozen(decision)).toBe(true);
    if ('units' in decision) {
      expect(Object.isFrozen(decision.units)).toBe(true);
      expect(decision.units).toEqual({ light: 4, marcher: 4 });
    }
  });
});

describe('farmTemplateCSummary', () => {
  it('resume a política normalizada para o status do ciclo', () => {
    const summary = farmTemplateCSummary(template({ priority: ['LIGHT', 'heavy'], minHaulPerCommand: 300 }));

    expect(summary).toContain('light → heavy');
    expect(summary).toContain('mínimo 300');
    expect(summary).toContain(`${FARM_TEMPLATE_C_DEFAULTS.warehouseFullPct}%`);
  });
});
