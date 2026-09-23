// Modelos de Tropa globais (Onda 0): composições nomeadas — 5 presets fixos +
// modelos custom do usuário — reutilizadas por Recrutamento, Apoio, fakes e
// Sequência de Nobres. A persistência é POR MUNDO; aqui vive só o motor PURO
// (tipos, zod e transformações de store): sem DOM, sem rede, sem storage.
//
// Invariante fail-closed: TODA store devolvida por este módulo tem os 5 presets
// presentes e CANÔNICOS (preset adulterado no storage é substituído pela
// definição de `TROOP_MODEL_PRESETS`) e modelos inválidos são DESCARTADOS em
// vez de propagados. Os ids `preset:<slug>` são reservados: só os presets são
// `builtin` e nem upsert nem remove os tocam.

import { z } from 'zod';
import type { UnitType } from '../../modules/shared/module-types';

// O tipo de unidade é o COMPARTILHADO do motor de módulos (12 unidades do
// jogo) — reexportado para os consumidores de modelos não precisarem importar
// o contrato inteiro do motor.
export type { UnitType } from '../../modules/shared/module-types';

/** Valor de uma unidade no modelo: quantidade fixa ou `'max'` = tudo que houver. */
export type TroopModelValue = number | 'max';

export interface TroopModel {
  /** `'preset:<slug>'` (fixo) ou `'custom:<slug>'` (do usuário). */
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  readonly units: Readonly<Partial<Record<UnitType, TroopModelValue>>>;
  /** Presets não podem ser editados nem removidos. */
  readonly builtin: boolean;
}

export interface TroopModelStore {
  models: TroopModel[];
  version: 1;
}

const TROOP_MODEL_UNIT_TYPES = [
  'spear',
  'sword',
  'axe',
  'archer',
  'spy',
  'light',
  'marcher',
  'heavy',
  'ram',
  'catapult',
  'knight',
  'snob',
] as const satisfies readonly UnitType[];

/**
 * Presets fixos (na ordem de exibição). `'Dispensar'` tem `units` vazio: é o
 * modelo que não recruta nem envia nada. Nos demais, `'max'` significa "tudo
 * que a aldeia tiver daquela unidade" — a resolução contra a leitura real é
 * feita por `resolveModelUnits`.
 */
export const TROOP_MODEL_PRESETS: readonly TroopModel[] = [
  {
    id: 'preset:dispensar',
    name: 'Dispensar',
    desc: 'Nenhuma unidade — modelo vazio (nada é recrutado nem enviado).',
    units: {},
    builtin: true,
  },
  {
    id: 'preset:lanceiro',
    name: 'Lanceiro',
    desc: 'Só lanças, tudo que a aldeia tiver.',
    units: { spear: 'max' },
    builtin: true,
  },
  {
    id: 'preset:lanca-com-cl',
    name: 'Lança com CL',
    desc: 'Lanças com Cavalaria Leve — fake clássico.',
    units: { spear: 'max', light: 'max' },
    builtin: true,
  },
  {
    id: 'preset:defesa',
    name: 'Defesa',
    desc: 'Defesa completa: lanças, espadas, arqueiros e cavalaria pesada.',
    units: { spear: 'max', sword: 'max', archer: 'max', heavy: 'max' },
    builtin: true,
  },
  {
    id: 'preset:ataque',
    name: 'Ataque',
    desc: 'Ofensiva completa: machados, cavalaria leve, arqueiros a cavalo e aríetes.',
    units: { axe: 'max', light: 'max', marcher: 'max', ram: 'max' },
    builtin: true,
  },
];

const PRESET_IDS: ReadonlySet<string> = new Set(TROOP_MODEL_PRESETS.map((preset) => preset.id));

/** True quando o id é de um preset fixo (id reservado: não editável nem removível). */
export function isBuiltinTroopModelId(id: string): boolean {
  return PRESET_IDS.has(id);
}

// ---------------------------------------------------------------------------
// Validação (fronteira do storage / da UI)
// ---------------------------------------------------------------------------

export const troopModelValueSchema = z.union([z.literal('max'), z.number().int().nonnegative()]);

/**
 * Contrato de UM modelo: `units` só aceita chaves de unidade do jogo
 * (desconhecida é rejeitada) com quantidade inteira ≥ 0 ou `'max'`. `units` é
 * obrigatório — omitir o campo criaria um "Dispensar" silencioso, que é
 * exatamente o erro que o fail-closed evita.
 */
export const troopModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  desc: z.string().default(''),
  units: z.partialRecord(z.enum(TROOP_MODEL_UNIT_TYPES), troopModelValueSchema),
  // `builtin` só é autoridade para ids de preset: `normalizeTroopModelStore`
  // rebaixa qualquer modelo de custom marcado como builtin.
  builtin: z.boolean().default(false),
});

/** Contrato da store por mundo. `version` é o carimbo de migração futura. */
export const troopModelStoreSchema = z.object({
  models: z.array(troopModelSchema).default([]),
  version: z.literal(1).default(1),
});

/**
 * Envelope da NORMALIZAÇÃO: aceita `models` cru e valida cada entrada depois,
 * uma a uma — com o schema estrito acima, um único modelo corrompido no storage
 * derrubaria junto os custom VÁLIDOS (perda silenciosa).
 */
const troopModelStoreEnvelopeSchema = z.object({
  models: z.array(z.unknown()).default([]),
  version: z.literal(1).default(1),
});

export type TroopModelErrorCode = 'BUILTIN_READONLY' | 'INVALID_MODEL';

export class TroopModelError extends Error {
  constructor(
    readonly code: TroopModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TroopModelError';
  }
}

/** Cópia de um modelo gravável: sempre custom (builtin nunca vem de fora) e sem chaves indefinidas. */
function copyAsCustomModel(model: TroopModel): TroopModel {
  const units: Partial<Record<UnitType, TroopModelValue>> = {};
  for (const [unit, value] of Object.entries(model.units)) {
    if (value === undefined) continue;
    units[unit as UnitType] = value;
  }
  return { id: model.id, name: model.name, desc: model.desc, units, builtin: false };
}

function copyPreset(preset: TroopModel): TroopModel {
  return { id: preset.id, name: preset.name, desc: preset.desc, units: { ...preset.units }, builtin: true };
}

/**
 * Normaliza a store lida do storage (ou de qualquer origem não confiável):
 * envelope ilegível (não-objeto, `models` não-array, versão diferente de 1) vira
 * só os presets; entradas de modelo inválidas são descartadas UMA A UMA (as
 * válidas sobrevivem); os presets são sempre reescritos na forma canônica e ids
 * repetidos são descartados (o primeiro vence) — ids de preset nem chegam a
 * entrar como custom, e modelos custom nunca entram como `builtin`.
 */
export function normalizeTroopModelStore(input: unknown): TroopModelStore {
  const envelope = troopModelStoreEnvelopeSchema.safeParse(input);
  const stored = envelope.success ? envelope.data.models : [];
  const models = TROOP_MODEL_PRESETS.map(copyPreset);
  const seen = new Set(models.map((model) => model.id));
  for (const raw of stored) {
    const parsed = troopModelSchema.safeParse(raw);
    if (!parsed.success) continue;
    const model = copyAsCustomModel(parsed.data);
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return { models, version: 1 };
}

/** Modelo da store pelo id (normaliza antes: presets resolvem mesmo em store não normalizada). */
export function troopModelById(store: TroopModelStore, id: string): TroopModel | undefined {
  return normalizeTroopModelStore(store).models.find((model) => model.id === id);
}

/**
 * Cria ou substitui um modelo CUSTOM pelo id. Modelo `builtin` — ou com id de
 * preset, mesmo que venha com `builtin: false` — é REJEITADO com
 * `TroopModelError('BUILTIN_READONLY')`: os presets são somente leitura pela
 * UI, então chegar aqui é erro de programação e falhar alto evita corromper o
 * preset. Modelo fora do schema é rejeitado com `INVALID_MODEL` (nada é
 * gravado). A store de entrada é normalizada antes e NUNCA é mutada.
 */
export function upsertCustomModel(store: TroopModelStore, model: TroopModel): TroopModelStore {
  if (model.builtin || isBuiltinTroopModelId(model.id)) {
    throw new TroopModelError(
      'BUILTIN_READONLY',
      `O modelo "${model.id}" é um preset fixo: não pode ser criado nem editado.`,
    );
  }
  const parsed = troopModelSchema.safeParse(model);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'modelo'))];
    throw new TroopModelError(
      'INVALID_MODEL',
      `Modelo de tropa inválido — nada foi gravado. Revise: ${fields.join(', ')}.`,
    );
  }
  const next = copyAsCustomModel(parsed.data);
  const base = normalizeTroopModelStore(store);
  const index = base.models.findIndex((candidate) => candidate.id === next.id);
  const models =
    index >= 0 ? base.models.map((candidate, at) => (at === index ? next : candidate)) : [...base.models, next];
  return { models, version: 1 };
}

/**
 * Remove um modelo CUSTOM pelo id (no-op para id custom inexistente). Preset é
 * BLOQUEADO com `TroopModelError('BUILTIN_READONLY')` — os modelos fixos não
 * têm caminho de remoção. A store de entrada nunca é mutada.
 */
export function removeCustomModel(store: TroopModelStore, id: string): TroopModelStore {
  if (isBuiltinTroopModelId(id)) {
    throw new TroopModelError('BUILTIN_READONLY', `O preset "${id}" é fixo: não pode ser removido.`);
  }
  const base = normalizeTroopModelStore(store);
  return { models: base.models.filter((model) => model.id !== id), version: 1 };
}

/** Disponível da unidade (leitura suja de página é higienizada: não finito ou ≤ 0 conta como zero). */
function availableAmount(available: Readonly<Record<string, number>>, unit: string): number {
  const raw = available[unit];
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

/**
 * Modelo resolvido contra a leitura real da aldeia: `'max'` vira o disponível
 * da unidade e número vira `min(número, disponível)`. Unidades sem
 * disponibilidade (ou resolvidas em zero) são OMITIDAS — zero não é chave de
 * formulário do jogo nem de recrutamento.
 */
export function resolveModelUnits(
  model: TroopModel,
  available: Readonly<Record<string, number>>,
): Record<string, number> {
  const resolved: Record<string, number> = {};
  for (const [unit, value] of Object.entries(model.units)) {
    if (value === undefined) continue;
    const have = availableAmount(available, unit);
    const wanted = value === 'max' ? have : Math.max(0, Math.floor(value));
    const amount = Math.min(wanted, have);
    if (amount > 0) resolved[unit] = amount;
  }
  return resolved;
}

/**
 * População total do modelo resolvido (`resolveModelUnits` × `unitPop`). Pop
 * desconhecida ou ilegível conta como zero (o total nunca inventa custo).
 */
export function modelPopulation(
  model: TroopModel,
  unitPop: Readonly<Record<string, number>>,
  available: Readonly<Record<string, number>>,
): number {
  const resolved = resolveModelUnits(model, available);
  let total = 0;
  for (const [unit, amount] of Object.entries(resolved)) {
    const pop = unitPop[unit];
    if (pop === undefined || !Number.isFinite(pop)) continue;
    total += amount * Math.max(0, pop);
  }
  return total;
}
