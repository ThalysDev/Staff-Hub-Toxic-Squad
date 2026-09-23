import { z } from 'zod';

/**
 * Decodificador do template de construção GC (código binário base64) — portado
 * byte a byte do motor rei-do-tribal (auto-construction.ts): a semântica de
 * decodificação é a mesma, o contrato e a nomenclatura são os do Hub.
 *
 * Formato do template (ordem fixa do jogo): [0,0] cabeçalho, pares
 * (índice do edifício, incremento 1-30) acumulando níveis-alvo cumulativos,
 * byte de limiar de fazenda ∈ {5,10,15,20}, marcador 0xF4 0x80 0x80 0x80,
 * nome ASCII, trailer de 5 bytes. A varredura do marcador parte do FIM do
 * buffer e o último marcador encontrado vence; pares inválidos encerram a
 * leitura; o limiar fora do conjunto permitido volta ao padrão 5.
 *
 * Base64: implementação JS pura (sem atob/btoa) — o Hub roda em service
 * worker MV3 e em contexto de página, então o codec não depende de globais
 * do worker; a validação canônica (regex + re-encode round-trip) é idêntica
 * à do motor de origem.
 */

/** Chaves canônicas de edifício do template GC, na ordem de byte do jogo. */
export const GC_TEMPLATE_BUILDINGS = Object.freeze([
  'main',
  'barracks',
  'stable',
  'garage',
  'church',
  'church_f',
  'watchtower',
  'snob',
  'smith',
  'place',
  'statue',
  'market',
  'wood',
  'stone',
  'iron',
  'farm',
  'storage',
  'hide',
  'wall',
] as const);

export const GC_TEMPLATE_FARM_THRESHOLDS = Object.freeze([5, 10, 15, 20] as const);

export const GC_TEMPLATE_LIMITS = Object.freeze({
  stepsPerModel: 256,
  modelName: 100,
  encodedCharacters: 2_732,
  decodedBytes: 2_048,
} as const);

const GC_MARKER = Object.freeze([0xf4, 0x80, 0x80, 0x80] as const);

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export type GcTemplateBuildingId = (typeof GC_TEMPLATE_BUILDINGS)[number];
export type GcTemplateCodecErrorCode =
  'GC_BASE64_INVALID' | 'GC_INPUT_TOO_LARGE' | 'GC_MARKER_MISSING' | 'GC_NO_VALID_STEPS' | 'MODEL_OUT_OF_BOUNDS';

export class GcTemplateCodecError extends Error {
  constructor(readonly code: GcTemplateCodecErrorCode) {
    super(code);
    this.name = 'GcTemplateCodecError';
  }
}

export interface DecodedGcTemplate {
  readonly name: string;
  readonly orderedSteps: readonly { readonly buildingId: GcTemplateBuildingId; readonly targetLevel: number }[];
  readonly farmPriority: { readonly enabled: boolean; readonly thresholdPercent: number };
}

const base64Decode = (encoded: string): Uint8Array => {
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of encoded) {
    if (character === '=') break;
    const value = BASE64_ALPHABET.indexOf(character);
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
};

const base64Encode = (bytes: Uint8Array): string => {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64_ALPHABET[first >> 2]!;
    encoded += BASE64_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)]!;
    encoded += second === undefined ? '=' : BASE64_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)]!;
    encoded += third === undefined ? '=' : BASE64_ALPHABET[third & 0x3f]!;
  }
  return encoded;
};

const decodeBase64 = (encoded: string): Uint8Array => {
  if (
    encoded.length > GC_TEMPLATE_LIMITS.encodedCharacters ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new GcTemplateCodecError(
      encoded.length > GC_TEMPLATE_LIMITS.encodedCharacters ? 'GC_INPUT_TOO_LARGE' : 'GC_BASE64_INVALID',
    );
  }
  const bytes = base64Decode(encoded);
  if (base64Encode(bytes) !== encoded) throw new GcTemplateCodecError('GC_BASE64_INVALID');
  if (bytes.length > GC_TEMPLATE_LIMITS.decodedBytes) throw new GcTemplateCodecError('GC_INPUT_TOO_LARGE');
  return bytes;
};

export const decodeGcTemplate = (encoded: string): DecodedGcTemplate => {
  const bytes = decodeBase64(encoded);
  let markerIndex = -1;
  for (let index = bytes.length - GC_MARKER.length; index >= 0; index -= 1) {
    if (GC_MARKER.every((byte, offset) => bytes[index + offset] === byte)) {
      markerIndex = index;
      break;
    }
  }
  if (markerIndex < 0) throw new GcTemplateCodecError('GC_MARKER_MISSING');
  const levels = new Map<string, number>();
  const orderedSteps: { buildingId: GcTemplateBuildingId; targetLevel: number }[] = [];
  for (let index = 2; index + 1 < markerIndex - 2; index += 2) {
    const buildingId = GC_TEMPLATE_BUILDINGS[bytes[index]!];
    const increment = bytes[index + 1]!;
    if (buildingId === undefined || increment < 1 || increment > 30) break;
    const targetLevel = (levels.get(buildingId) ?? 0) + increment;
    levels.set(buildingId, targetLevel);
    orderedSteps.push({ buildingId, targetLevel });
  }
  if (orderedSteps.length === 0) throw new GcTemplateCodecError('GC_NO_VALID_STEPS');
  const rawThreshold = bytes[markerIndex - 2]!;
  const thresholdPercent = [5, 10, 15, 20].includes(rawThreshold) ? rawThreshold : 5;
  const nameBytes = bytes.slice(
    markerIndex + GC_MARKER.length,
    Math.max(markerIndex + GC_MARKER.length, bytes.length - 5),
  );
  const name = String.fromCharCode(...nameBytes).replace(/[^\x20-\x7e]/g, '');
  return {
    name,
    orderedSteps,
    farmPriority: { enabled: true, thresholdPercent },
  };
};

const gcTemplateModelIdPattern = '^model_[a-z0-9][a-z0-9-]{7,127}$';
const safeNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(GC_TEMPLATE_LIMITS.modelName)
  .refine(
    (value) =>
      !/(?:https?|socks[45]?):\/\/|\b(?:authorization|cookie)\s*:|\b(?:password|token|secret|sid|url)\s*[=:]|<\/?[a-z][^>]*>/i.test(
        value,
      ),
    'Detalhes de transporte, segredos, URLs e HTML cru são proibidos',
  );
export const gcTemplateStepSchema = z
  .object({
    buildingId: z.enum(GC_TEMPLATE_BUILDINGS),
    targetLevel: z.number().int().min(1).max(30),
  })
  .strict();
export const gcTemplateModelSchema = z
  .object({
    modelId: z.string().regex(new RegExp(gcTemplateModelIdPattern)),
    name: safeNameSchema,
    orderedSteps: z.array(gcTemplateStepSchema).max(GC_TEMPLATE_LIMITS.stepsPerModel),
    farmPriority: z
      .object({
        enabled: z.boolean(),
        thresholdPercent: z.union(
          GC_TEMPLATE_FARM_THRESHOLDS.map((value) => z.literal(value)) as [
            z.ZodLiteral<5>,
            z.ZodLiteral<10>,
            z.ZodLiteral<15>,
            z.ZodLiteral<20>,
          ],
        ),
      })
      .strict(),
  })
  .strict();
export type GcTemplateModel = z.infer<typeof gcTemplateModelSchema>;

export const toGcTemplateModel = (decoded: DecodedGcTemplate, modelId: string): GcTemplateModel => {
  const result = gcTemplateModelSchema.safeParse({
    modelId,
    name: decoded.name,
    orderedSteps: decoded.orderedSteps,
    farmPriority: {
      enabled: decoded.farmPriority.enabled,
      thresholdPercent: [5, 10, 15, 20].includes(decoded.farmPriority.thresholdPercent)
        ? decoded.farmPriority.thresholdPercent
        : 5,
    },
  });
  if (!result.success) throw new GcTemplateCodecError('MODEL_OUT_OF_BOUNDS');
  return result.data;
};
