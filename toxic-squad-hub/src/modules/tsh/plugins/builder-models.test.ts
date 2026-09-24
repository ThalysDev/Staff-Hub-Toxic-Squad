// Modelos e regras por aldeia do Construtor.
import { describe, expect, it } from 'vitest';
import { PREREQS } from './builder-mass';
import { modelForVillage, modelTargets, parseCoordList, PRESETS, readModels, readRules } from './builder-models';

describe('modelos do Construtor', () => {
  const rules = readRules([
    { kind: 'coord', coords: ['500|500'], modelId: 'def' },
    { kind: 'grupo', groupId: 7, modelId: 'off' },
    { kind: 'grupo', groupId: -1, modelId: 'x' }, // inválida: some
  ]);
  const groups = new Map([[7, new Set(['1', '2'])]]);

  it('coordenada vence grupo, grupo vence o padrão, sem nada = sem modelo', () => {
    expect(rules).toHaveLength(2);
    expect(modelForVillage({ id: '1', x: 500, y: 500 }, rules, groups, 'pad')).toBe('def');
    expect(modelForVillage({ id: '2', x: 1, y: 1 }, rules, groups, 'pad')).toBe('off');
    expect(modelForVillage({ id: '3', x: 1, y: 1 }, rules, groups, 'pad')).toBe('pad');
    expect(modelForVillage({ id: '3' }, rules, groups, '')).toBeNull();
  });

  it('coordenadas coladas de qualquer jeito', () => {
    expect(parseCoordList('500|500, 501|502\n510|510 lixo')).toEqual(['500|500', '501|502', '510|510']);
  });

  it('modelos salvos inválidos somem; passos viram metas', () => {
    const models = readModels([{ id: 'a', name: 'A', steps: [{ building: 'farm', level: 20 }] }, { id: '', steps: [] }, { id: 'b', steps: [{ building: 'igreja', level: 1 }] }]);
    expect(models.map((m) => m.id)).toEqual(['a']);
    expect(modelTargets(models[0])).toEqual([{ building: 'farm', level: 20 }]);
  });

  it('modelos prontos respeitam os pré-requisitos na própria ordem', () => {
    for (const preset of PRESETS) {
      const lv: Record<string, number> = { main: 1, farm: 1, storage: 1 };
      for (const s of preset.steps) {
        for (const [b, need] of Object.entries(PREREQS[s.building] ?? {})) {
          expect(lv[b] ?? 0, `${preset.name}: ${s.building} precisa de ${b} ${need}`).toBeGreaterThanOrEqual(need ?? 0);
        }
        lv[s.building] = Math.max(lv[s.building] ?? 0, s.level);
      }
    }
  });
});
