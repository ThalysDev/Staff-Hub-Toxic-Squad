import { z } from 'zod';
import { autoFarmTemplateIdSchema } from './auto-farm-contracts';

export const AUTO_FARM_TARGET_PRIORITIES = Object.freeze(['nearest', 'least-recently-attacked'] as const);

const targetReferenceSchema = z
  .string()
  .trim()
  .regex(/^(?:\d+|\d{1,3}\|\d{1,3})$/, 'Use o ID numérico ou a coordenada x|y do alvo.');

const currentSettingsSchema = z.object({
  templateId: autoFarmTemplateIdSchema.default('A'),
  maximumDistanceFields: z.number().finite().positive().max(1_000).default(20),
  intervalMinutes: z.number().int().min(2).max(1_440).default(15),
  targetPriority: z.enum(AUTO_FARM_TARGET_PRIORITIES).default('least-recently-attacked'),
  blockAfterLoss: z.boolean().default(true),
  minimumTargetCooldownMinutes: z.number().int().min(0).max(10_080).default(0),
  maximumCommandsPerRound: z.number().int().min(1).max(10_000).default(10_000),
  targetBlacklist: z.array(targetReferenceSchema).max(10_000).default([]),
  ignoreScheduledTargets: z.boolean().default(true),
  ignoreTargetsInFlight: z.boolean().default(true),
});

/**
 * Migração de configurações da prova de conceito anterior. `maxDistance`
 * tinha o nome ambíguo, enquanto `minLight` e `maxLosses` descreviam regras
 * que o módulo ainda não conseguia comprovar. O schema remove essas chaves e
 * converte o antigo template `default` em A antes da validação.
 */
function normalizeLegacyAutoFarmSettings(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const legacy = input as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...legacy };
  if (normalized.maximumDistanceFields === undefined && typeof legacy.maxDistance === 'number') {
    normalized.maximumDistanceFields = legacy.maxDistance;
  }
  if (legacy.templateId === 'default') normalized.templateId = 'A';
  delete normalized.maxDistance;
  delete normalized.minLight;
  delete normalized.maxLosses;
  return normalized;
}

export const autoFarmSettingsSchema = z.preprocess(normalizeLegacyAutoFarmSettings, currentSettingsSchema);

export type AutoFarmTargetPriority = (typeof AUTO_FARM_TARGET_PRIORITIES)[number];
export type AutoFarmSettings = z.infer<typeof autoFarmSettingsSchema>;
