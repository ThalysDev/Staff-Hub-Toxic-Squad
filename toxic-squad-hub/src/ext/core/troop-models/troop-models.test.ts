import { describe, expect, it } from 'vitest';
import {
  TROOP_MODEL_PRESETS,
  TroopModelError,
  isBuiltinTroopModelId,
  modelPopulation,
  normalizeTroopModelStore,
  removeCustomModel,
  resolveModelUnits,
  troopModelById,
  troopModelSchema,
  troopModelStoreSchema,
  upsertCustomModel,
  type TroopModel,
} from './troop-models';

/** População por unidade do jogo (fixture local: este módulo é puro e não conhece custos). */
const UNIT_POP: Readonly<Record<string, number>> = {
  spear: 1,
  sword: 1,
  axe: 1,
  archer: 1,
  spy: 0,
  light: 4,
  marcher: 5,
  heavy: 4,
  ram: 5,
  catapult: 8,
  knight: 10,
  snob: 100,
};

function customModel(overrides: Partial<TroopModel> = {}): TroopModel {
  return {
    id: 'custom:abc123',
    name: 'Meu modelo',
    desc: 'Teste',
    units: { spear: 100 },
    builtin: false,
    ...overrides,
  };
}

function storeWith(models: readonly TroopModel[]): { models: TroopModel[]; version: 1 } {
  return { models: [...models], version: 1 };
}

const presetIds = TROOP_MODEL_PRESETS.map((preset) => preset.id);

describe('TROOP_MODEL_PRESETS — os 5 modelos fixos', () => {
  it('traz os 5 presets builtin com as composições da spec', () => {
    expect(TROOP_MODEL_PRESETS.map((preset) => preset.id)).toEqual([
      'preset:dispensar',
      'preset:lanceiro',
      'preset:lanca-com-cl',
      'preset:defesa',
      'preset:ataque',
    ]);
    expect(TROOP_MODEL_PRESETS.every((preset) => preset.builtin)).toBe(true);
    expect(TROOP_MODEL_PRESETS.map((preset) => preset.name)).toEqual([
      'Dispensar',
      'Lanceiro',
      'Lança com CL',
      'Defesa',
      'Ataque',
    ]);
    const units = Object.fromEntries(TROOP_MODEL_PRESETS.map((preset) => [preset.id, preset.units]));
    expect(units['preset:dispensar']).toEqual({});
    expect(units['preset:lanceiro']).toEqual({ spear: 'max' });
    expect(units['preset:lanca-com-cl']).toEqual({ spear: 'max', light: 'max' });
    expect(units['preset:defesa']).toEqual({ spear: 'max', sword: 'max', archer: 'max', heavy: 'max' });
    expect(units['preset:ataque']).toEqual({ axe: 'max', light: 'max', marcher: 'max', ram: 'max' });
    expect(presetIds.map(isBuiltinTroopModelId)).toEqual([true, true, true, true, true]);
    expect(isBuiltinTroopModelId('custom:abc123')).toBe(false);
  });
});

describe('normalizeTroopModelStore — fail-closed com presets sempre presentes', () => {
  it('lixo total (null, número, string, array, models não-array, versão futura) vira só os presets', () => {
    const garbage: unknown[] = [
      null,
      undefined,
      42,
      'modelos',
      [],
      { models: 'nope' },
      { models: [{ id: 'x' }], version: 9 },
    ];
    for (const input of garbage) {
      const store = normalizeTroopModelStore(input);
      expect(store.version).toBe(1);
      expect(store.models.map((model) => model.id)).toEqual(presetIds);
      expect(store.models.every((model) => model.builtin)).toBe(true);
    }
  });

  it('store vazia ({} e { models: [], version: 1 }) devolve os presets', () => {
    expect(normalizeTroopModelStore({}).models.map((model) => model.id)).toEqual(presetIds);
    expect(normalizeTroopModelStore({ models: [], version: 1 }).models.map((model) => model.id)).toEqual(presetIds);
  });

  it('preserva modelo custom válido depois dos presets', () => {
    const store = normalizeTroopModelStore(storeWith([customModel()]));
    expect(store.models.map((model) => model.id)).toEqual([...presetIds, 'custom:abc123']);
    expect(store.models[5]?.units).toEqual({ spear: 100 });
    expect(store.models[5]?.builtin).toBe(false);
  });

  it('descarta entradas inválidas (unidade desconhecida, valor negativo, nome vazio) e mantém as boas', () => {
    const store = normalizeTroopModelStore(
      storeWith([
        customModel({ id: 'custom:unidade-ruim', units: { dragon: 'max' } as TroopModel['units'] }),
        customModel({ id: 'custom:negativo', units: { spear: -1 } }),
        customModel({ id: 'custom:sem-nome', name: '' }),
        customModel({ id: 'custom:ok' }),
      ]),
    );
    expect(store.models.map((model) => model.id)).toEqual([...presetIds, 'custom:ok']);
  });

  it('substitui preset adulterado pela definição canônica (sem duplicar)', () => {
    const store = normalizeTroopModelStore(
      storeWith([
        {
          id: 'preset:lanceiro',
          name: 'Adulterado',
          desc: 'hack',
          units: { axe: 'max' },
          builtin: false,
        },
      ]),
    );
    expect(store.models).toHaveLength(TROOP_MODEL_PRESETS.length);
    const lanceiro = store.models.find((model) => model.id === 'preset:lanceiro');
    expect(lanceiro?.name).toBe('Lanceiro');
    expect(lanceiro?.units).toEqual({ spear: 'max' });
    expect(lanceiro?.builtin).toBe(true);
  });

  it('rebaixa a custom um modelo de id não-preset marcado como builtin', () => {
    const store = normalizeTroopModelStore(storeWith([customModel({ id: 'custom:falso-builtin', builtin: true })]));
    expect(store.models.find((model) => model.id === 'custom:falso-builtin')?.builtin).toBe(false);
  });

  it('deduplica ids repetidos (o primeiro vence) e não muta a store de entrada', () => {
    const input = storeWith([customModel({ name: 'Primeiro' }), customModel({ name: 'Segundo' })]);
    const store = normalizeTroopModelStore(input);
    expect(store.models.filter((model) => model.id === 'custom:abc123')).toHaveLength(1);
    expect(store.models.find((model) => model.id === 'custom:abc123')?.name).toBe('Primeiro');
    expect(input.models).toHaveLength(2);
  });

  it('troopModelById acha preset e custom, e é undefined para id desconhecido', () => {
    const store = storeWith([customModel()]);
    expect(troopModelById(store, 'preset:ataque')?.name).toBe('Ataque');
    expect(troopModelById(store, 'custom:abc123')?.name).toBe('Meu modelo');
    expect(troopModelById(store, 'custom:nada')).toBeUndefined();
  });
});

describe('upsertCustomModel / removeCustomModel — CRUD dos modelos custom', () => {
  it('adiciona modelo novo preservando os presets e sem mutar a store de entrada', () => {
    const base = normalizeTroopModelStore({});
    const store = upsertCustomModel(base, customModel({ name: 'Fake 100' }));
    expect(store.version).toBe(1);
    expect(store.models.map((model) => model.id)).toEqual([...presetIds, 'custom:abc123']);
    expect(store.models.at(-1)?.name).toBe('Fake 100');
    expect(store.models.at(-1)?.builtin).toBe(false);
    expect(base.models.map((model) => model.id)).toEqual(presetIds);
  });

  it('substitui o modelo custom existente pelo id (sem duplicar)', () => {
    const created = upsertCustomModel(normalizeTroopModelStore({}), customModel());
    const edited = upsertCustomModel(created, customModel({ name: 'Editado', units: { light: 'max' } }));
    expect(edited.models).toHaveLength(TROOP_MODEL_PRESETS.length + 1);
    const stored = edited.models.find((model) => model.id === 'custom:abc123');
    expect(stored?.name).toBe('Editado');
    expect(stored?.units).toEqual({ light: 'max' });
  });

  it('RECUSA modelo builtin (erro tipado BUILTIN_READONLY): preset do catálogo nunca é editável', () => {
    const base = normalizeTroopModelStore({});
    const preset = TROOP_MODEL_PRESETS[1]!;
    expect(() => upsertCustomModel(base, { ...preset, units: { spear: 1 } })).toThrow(TroopModelError);
    try {
      upsertCustomModel(base, preset);
      expect.unreachable('upsert de preset deveria lançar');
    } catch (error) {
      expect(error).toBeInstanceOf(TroopModelError);
      expect((error as TroopModelError).code).toBe('BUILTIN_READONLY');
    }
    // Id de preset com `builtin: false` fabricado pela UI também é recusado.
    try {
      upsertCustomModel(base, customModel({ id: 'preset:ataque' }));
      expect.unreachable('id de preset deveria lançar');
    } catch (error) {
      expect((error as TroopModelError).code).toBe('BUILTIN_READONLY');
    }
    expect(base.models.map((model) => model.id)).toEqual(presetIds);
  });

  it('recusa modelo fora do schema com INVALID_MODEL (nada é gravado)', () => {
    const base = normalizeTroopModelStore({});
    try {
      upsertCustomModel(base, customModel({ units: { dragon: 'max' } as TroopModel['units'] }));
      expect.unreachable('unidade desconhecida deveria lançar');
    } catch (error) {
      expect((error as TroopModelError).code).toBe('INVALID_MODEL');
      expect((error as TroopModelError).message).toContain('units.dragon');
    }
    try {
      upsertCustomModel(base, customModel({ units: { spear: -5 } }));
      expect.unreachable('valor negativo deveria lançar');
    } catch (error) {
      expect((error as TroopModelError).code).toBe('INVALID_MODEL');
    }
  });

  it('remove modelo custom e é no-op para id custom inexistente', () => {
    const created = upsertCustomModel(normalizeTroopModelStore({}), customModel());
    const removed = removeCustomModel(created, 'custom:abc123');
    expect(removed.models.map((model) => model.id)).toEqual(presetIds);
    expect(created.models).toHaveLength(TROOP_MODEL_PRESETS.length + 1);
    const untouched = removeCustomModel(created, 'custom:nao-existe');
    expect(untouched.models.map((model) => model.id)).toEqual(created.models.map((model) => model.id));
  });

  it('BLOQUEIA remoção de preset (erro tipado BUILTIN_READONLY)', () => {
    const base = normalizeTroopModelStore({});
    try {
      removeCustomModel(base, 'preset:defesa');
      expect.unreachable('remoção de preset deveria lançar');
    } catch (error) {
      expect(error).toBeInstanceOf(TroopModelError);
      expect((error as TroopModelError).code).toBe('BUILTIN_READONLY');
    }
    expect(base.models.map((model) => model.id)).toEqual(presetIds);
  });
});

describe('resolveModelUnits / modelPopulation — modelo contra a leitura real', () => {
  it("resolve 'max' com o disponível e número clampado ao disponível", () => {
    const base = normalizeTroopModelStore({});
    const ataque = troopModelById(base, 'preset:ataque')!;
    expect(resolveModelUnits(ataque, { axe: 100, light: 50, marcher: 20, ram: 10 })).toEqual({
      axe: 100,
      light: 50,
      marcher: 20,
      ram: 10,
    });
    // Número = teto pedido; o disponível manda quando é menor.
    expect(resolveModelUnits(customModel({ units: { spear: 500 } }), { spear: 120 })).toEqual({ spear: 120 });
    expect(resolveModelUnits(customModel({ units: { spear: 30 } }), { spear: 120 })).toEqual({ spear: 30 });
  });

  it('omite unidades sem disponibilidade e ignora chaves desconhecidas', () => {
    const model = customModel({ units: { spear: 'max', axe: 50, light: 0 } });
    expect(resolveModelUnits(model, { spear: 0, light: 10 })).toEqual({});
    expect(resolveModelUnits(model, {})).toEqual({});
    // Leitura suja (−5, NaN) conta como zero; 'Dispensar' nunca resolve nada.
    expect(resolveModelUnits(model, { spear: -5, axe: Number.NaN })).toEqual({});
    expect(resolveModelUnits(troopModelById(normalizeTroopModelStore({}), 'preset:dispensar')!, { spear: 999 })).toEqual(
      {},
    );
  });

  it('modelPopulation soma a população das unidades resolvidas (fixture UNIT_POP)', () => {
    const base = normalizeTroopModelStore({});
    // Ataque (axe 1 + light 4 + marcher 5 + ram 5) com disponível total.
    expect(modelPopulation(troopModelById(base, 'preset:ataque')!, UNIT_POP, { axe: 100, light: 50, marcher: 20, ram: 10 })).toBe(
      450,
    );
    // Clampado ao disponível e sem contar unidade indisponível.
    expect(modelPopulation(customModel({ units: { spear: 10, sword: 5 } }), UNIT_POP, { spear: 3 })).toBe(3);
    // Pop desconhecida conta zero; modelo vazio tem população zero.
    expect(modelPopulation(customModel({ units: { dragon: 'max' } as TroopModel['units'] }), UNIT_POP, { dragon: 9 })).toBe(
      0,
    );
    expect(modelPopulation(troopModelById(base, 'preset:dispensar')!, UNIT_POP, { spear: 999 })).toBe(0);
  });
});

describe('schemas zod dos modelos de tropa', () => {
  it('troopModelSchema rejeita unidade desconhecida, valor negativo e string inválida', () => {
    const valid = { id: 'custom:x', name: 'X', desc: '', units: { spear: 'max', sword: 0 }, builtin: false };
    expect(troopModelSchema.safeParse(valid).success).toBe(true);
    expect(troopModelSchema.safeParse({ ...valid, units: { dragon: 'max' } }).success).toBe(false);
    expect(troopModelSchema.safeParse({ ...valid, units: { spear: -1 } }).success).toBe(false);
    expect(troopModelSchema.safeParse({ ...valid, units: { spear: 1.5 } }).success).toBe(false);
    expect(troopModelSchema.safeParse({ ...valid, units: { spear: 'tudo' } }).success).toBe(false);
    expect(troopModelSchema.safeParse({ ...valid, units: { spear: 'max' }, name: '' }).success).toBe(false);
    expect(troopModelSchema.safeParse({ id: 'x', name: 'x' }).success).toBe(false);
  });

  it('troopModelStoreSchema exige models array e version 1 (com defaults de leitura tolerante)', () => {
    expect(troopModelStoreSchema.safeParse({ models: [], version: 1 }).success).toBe(true);
    expect(troopModelStoreSchema.safeParse({ models: 'nope', version: 1 }).success).toBe(false);
    expect(troopModelStoreSchema.safeParse({ models: [], version: 2 }).success).toBe(false);
    const tolerant = troopModelStoreSchema.parse({});
    expect(tolerant).toEqual({ models: [], version: 1 });
  });
});
