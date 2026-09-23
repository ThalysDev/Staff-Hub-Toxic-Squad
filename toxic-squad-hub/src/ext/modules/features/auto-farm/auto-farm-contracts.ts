import { z } from 'zod';

export const AUTO_FARM_TEMPLATE_IDS = Object.freeze(['A', 'B'] as const);
export const AUTO_FARM_TARGET_RESULTS = Object.freeze(['SUCCESS', 'PARTIAL', 'SCOUTED', 'LOSS', 'UNKNOWN'] as const);
export const AUTO_FARM_CAPABILITIES = Object.freeze(['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN'] as const);
export const AUTO_FARM_TARGET_EVIDENCE_SOURCES = Object.freeze(['AM_REPORT'] as const);
export const AUTO_FARM_UNIT_TYPES = Object.freeze([
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
] as const);

const coordinatePartSchema = z.number().int().min(0).max(999);
const unitQuantitySchema = z.number().int().nonnegative().max(1_000_000_000);

export const autoFarmTemplateIdSchema = z.enum(AUTO_FARM_TEMPLATE_IDS);
export const autoFarmTargetResultSchema = z.enum(AUTO_FARM_TARGET_RESULTS);
export const autoFarmCapabilitySchema = z.enum(AUTO_FARM_CAPABILITIES);
export const autoFarmTargetEvidenceSourceSchema = z.enum(AUTO_FARM_TARGET_EVIDENCE_SOURCES);
export const autoFarmUnitTypeSchema = z.enum(AUTO_FARM_UNIT_TYPES);
export const autoFarmUnitAmountsSchema = z
  .object({
    spear: unitQuantitySchema,
    sword: unitQuantitySchema,
    axe: unitQuantitySchema,
    archer: unitQuantitySchema,
    spy: unitQuantitySchema,
    light: unitQuantitySchema,
    marcher: unitQuantitySchema,
    heavy: unitQuantitySchema,
    ram: unitQuantitySchema,
    catapult: unitQuantitySchema,
    knight: unitQuantitySchema,
    snob: unitQuantitySchema,
  })
  .partial()
  .strict();

export const autoFarmSourceSchema = z
  .object({
    villageId: z.string().min(1),
    x: coordinatePartSchema.optional(),
    y: coordinatePartSchema.optional(),
    troops: autoFarmUnitAmountsSchema,
  })
  .strict();

/**
 * Os filtros do Assistente de Saque alteram quais relatórios existem no DOM.
 * Eles são fatos de integridade do snapshot, não preferências do Auto Farm.
 */
export const autoFarmPlunderFiltersSchema = z
  .object({
    onlyCurrentVillage: z.boolean(),
    includeAttacked: z.boolean(),
    includeFullLosses: z.boolean(),
    includePartialLosses: z.boolean(),
    onlyFullHauls: z.boolean(),
  })
  .strict();

export const autoFarmTemplateSchema = z
  .object({
    id: autoFarmTemplateIdSchema,
    /** Id numérico usado pelo próprio Assistente de Saque (ex.: 23/101). */
    gameTemplateId: z.string().regex(/^\d+$/),
    description: z.string().trim().max(120).optional(),
    units: autoFarmUnitAmountsSchema,
  })
  .strict()
  .refine((template) => Object.values(template.units).some((quantity) => quantity !== undefined && quantity > 0), {
    path: ['units'],
    message: 'O template de saque precisa conter ao menos uma unidade.',
  });

export const autoFarmTargetSchema = z
  .object({
    id: z.string().min(1),
    x: coordinatePartSchema,
    y: coordinatePartSchema,
    points: z.number().int().nonnegative().optional(),
    barbarian: z.boolean(),
    evidenceSources: z
      .array(autoFarmTargetEvidenceSourceSchema)
      .min(1)
      .max(AUTO_FARM_TARGET_EVIDENCE_SOURCES.length)
      .refine((sources) => new Set(sources).size === sources.length, 'As fontes de evidência não podem se repetir.'),
    templateIds: z
      .array(autoFarmTemplateIdSchema)
      .max(AUTO_FARM_TEMPLATE_IDS.length)
      .refine((ids) => new Set(ids).size === ids.length, 'Os templates presentes não podem se repetir.'),
    availableTemplateIds: z
      .array(autoFarmTemplateIdSchema)
      .max(AUTO_FARM_TEMPLATE_IDS.length)
      .refine((ids) => new Set(ids).size === ids.length, 'Os templates disponíveis não podem se repetir.'),
    lastResult: autoFarmTargetResultSchema,
    lastAttackAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const autoFarmSnapshotSchema = z
  .object({
    capability: autoFarmCapabilitySchema,
    source: autoFarmSourceSchema,
    plunderFilters: autoFarmPlunderFiltersSchema,
    templates: z
      .array(autoFarmTemplateSchema)
      .max(AUTO_FARM_TEMPLATE_IDS.length)
      .refine((templates) => new Set(templates.map((template) => template.id)).size === templates.length, {
        message: 'Os templates de saque não podem se repetir.',
      }),
    targets: z.array(autoFarmTargetSchema).max(10_000),
    capturedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type AutoFarmTemplateId = z.infer<typeof autoFarmTemplateIdSchema>;
export type AutoFarmTargetResult = z.infer<typeof autoFarmTargetResultSchema>;
export type AutoFarmTargetEvidenceSource = z.infer<typeof autoFarmTargetEvidenceSourceSchema>;
export type AutoFarmUnitType = z.infer<typeof autoFarmUnitTypeSchema>;
export type AutoFarmUnitAmounts = z.infer<typeof autoFarmUnitAmountsSchema>;
export type AutoFarmSource = z.infer<typeof autoFarmSourceSchema>;
export type AutoFarmPlunderFilters = z.infer<typeof autoFarmPlunderFiltersSchema>;
export type AutoFarmTemplate = z.infer<typeof autoFarmTemplateSchema>;
export type AutoFarmTarget = z.infer<typeof autoFarmTargetSchema>;
export type AutoFarmSnapshot = z.infer<typeof autoFarmSnapshotSchema>;
