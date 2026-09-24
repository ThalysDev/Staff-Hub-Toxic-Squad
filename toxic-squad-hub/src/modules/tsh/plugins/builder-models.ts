// Modelos de construção e regras por aldeia (v3.9.0) — ideia das telas
// "Construtor & Redutor" (Modelos / Aldeias por Grupo e Coordenada), feita do
// nosso jeito. Puro/testável: a tela (builder-panel.ts) e o ciclo usam isto.

import { z } from 'zod';
import { BUILDINGS, PREREQS, type BuildingId, type BuildTarget } from './builder-mass';

export const builderModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().default('Modelo'),
  steps: z.array(z.object({ building: z.enum(BUILDINGS), level: z.number().int().min(1).max(99) })).default([]),
});
export type BuilderModel = z.infer<typeof builderModelSchema>;

export const builderRuleSchema = z.union([
  z.object({ kind: z.literal('grupo'), groupId: z.number().int().positive(), groupName: z.string().default(''), modelId: z.string() }),
  z.object({ kind: z.literal('coord'), coords: z.array(z.string()).default([]), modelId: z.string() }),
]);
export type BuilderRule = z.infer<typeof builderRuleSchema>;

export function readModels(raw: unknown): BuilderModel[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m) => {
    const r = builderModelSchema.safeParse(m);
    return r.success ? [r.data] : [];
  });
}

export function readRules(raw: unknown): BuilderRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m) => {
    const r = builderRuleSchema.safeParse(m);
    return r.success ? [r.data] : [];
  });
}

/** "500|500, 501|502 510|510" → ["500|500","501|502","510|510"] (inválidas somem). */
export function parseCoordList(text: string): string[] {
  return [...text.matchAll(/(\d{1,3})\|(\d{1,3})/g)].map((m) => `${Number(m[1])}|${Number(m[2])}`);
}

/**
 * Modelo de cada aldeia: regra de COORDENADA vence, depois GRUPO (na ordem da
 * lista), depois o modelo padrão. null = sem modelo (a aldeia não constrói).
 */
export function modelForVillage(
  village: { id: string; x?: number; y?: number },
  rules: readonly BuilderRule[],
  groupVillages: ReadonlyMap<number, ReadonlySet<string>>,
  defaultModelId: string,
): string | null {
  const coord = village.x !== undefined && village.y !== undefined ? `${village.x}|${village.y}` : null;
  if (coord !== null) {
    const byCoord = rules.find((r) => r.kind === 'coord' && r.coords.includes(coord));
    if (byCoord !== undefined) return byCoord.modelId;
  }
  const byGroup = rules.find((r) => r.kind === 'grupo' && (groupVillages.get(r.groupId)?.has(village.id) ?? false));
  if (byGroup !== undefined) return byGroup.modelId;
  return defaultModelId !== '' ? defaultModelId : null;
}

export function modelTargets(model: BuilderModel | undefined): BuildTarget[] {
  return (model?.steps ?? []).map((s) => ({ building: s.building, level: s.level }));
}

/** Nível máximo clássico de cada edifício (o jogo recusa acima; a tela limita). */
export const MAX_LEVEL: Record<BuildingId, number> = {
  main: 30, barracks: 25, stable: 20, garage: 15, watchtower: 20, snob: 3, smith: 20, place: 1, statue: 1,
  market: 25, wood: 30, stone: 30, iron: 30, farm: 30, storage: 30, hide: 10, wall: 20,
};

export const BUILDING_NAME: Record<BuildingId, string> = {
  main: 'Ed. principal', barracks: 'Quartel', stable: 'Estábulo', garage: 'Oficina', watchtower: 'Torre de vigia', snob: 'Academia',
  smith: 'Ferreiro', place: 'Praça', statue: 'Estátua', market: 'Mercado', wood: 'Bosque', stone: 'Poço de argila', iron: 'Mina de ferro',
  farm: 'Fazenda', storage: 'Armazém', hide: 'Esconderijo', wall: 'Muralha',
};

/**
 * Avisos de pré-requisito de cada passo, simulando o modelo desde uma aldeia
 * nova (Ed. principal/Fazenda/Armazém/Praça no 1). Aldeia já crescida pode
 * não precisar — por isso é aviso, não erro.
 */
export function prereqWarnings(steps: readonly { building: BuildingId; level: number }[]): (string | null)[] {
  const lv: Partial<Record<BuildingId, number>> = { main: 1, farm: 1, storage: 1, place: 1 };
  return steps.map((s) => {
    const miss = Object.entries(PREREQS[s.building] ?? {})
      .filter(([b, need]) => (lv[b as BuildingId] ?? 0) < (need ?? 0))
      .map(([b, need]) => `${BUILDING_NAME[b as BuildingId]} ${need}`);
    lv[s.building] = Math.max(lv[s.building] ?? 0, s.level);
    return miss.length > 0 ? `Pede ${miss.join(' e ')} antes — até lá o construtor pula este passo e segue a fila.` : null;
  });
}

/** Modelos prontos (ordem pensada para crescer sem travar em fazenda/armazém). */
export const PRESETS: { id: string; name: string; steps: { building: BuildingId; level: number }[] }[] = [
  {
    id: 'inicial',
    name: 'Pacote inicial',
    steps: [
      { building: 'wood', level: 5 }, { building: 'stone', level: 5 }, { building: 'iron', level: 5 },
      { building: 'main', level: 5 }, { building: 'farm', level: 5 }, { building: 'storage', level: 5 },
      { building: 'barracks', level: 3 }, { building: 'wood', level: 10 }, { building: 'stone', level: 10 },
      { building: 'iron', level: 10 }, { building: 'main', level: 10 }, { building: 'smith', level: 5 },
      { building: 'market', level: 3 }, { building: 'wall', level: 5 },
    ],
  },
  {
    id: 'recursos',
    name: 'Recursos até 25',
    steps: [
      { building: 'wood', level: 20 }, { building: 'stone', level: 20 }, { building: 'iron', level: 20 },
      { building: 'storage', level: 20 }, { building: 'farm', level: 20 },
      { building: 'wood', level: 25 }, { building: 'stone', level: 25 }, { building: 'iron', level: 25 },
      { building: 'storage', level: 25 },
    ],
  },
  {
    id: 'ofensiva',
    name: 'Aldeia ofensiva',
    steps: [
      { building: 'main', level: 20 }, { building: 'barracks', level: 25 }, { building: 'smith', level: 20 },
      { building: 'stable', level: 20 }, { building: 'garage', level: 10 }, { building: 'farm', level: 30 },
      { building: 'storage', level: 30 }, { building: 'wall', level: 20 },
    ],
  },
  {
    id: 'defensiva',
    name: 'Aldeia defensiva',
    steps: [
      { building: 'main', level: 20 }, { building: 'barracks', level: 25 }, { building: 'smith', level: 20 },
      { building: 'wall', level: 20 }, { building: 'farm', level: 30 }, { building: 'stable', level: 15 },
      { building: 'storage', level: 30 }, { building: 'hide', level: 10 },
    ],
  },
  {
    id: 'nobre',
    name: 'Academia (nobres)',
    steps: [
      { building: 'main', level: 20 }, { building: 'barracks', level: 5 }, { building: 'storage', level: 15 },
      { building: 'smith', level: 20 }, { building: 'market', level: 10 },
      { building: 'snob', level: 1 }, { building: 'farm', level: 30 },
    ],
  },
];
