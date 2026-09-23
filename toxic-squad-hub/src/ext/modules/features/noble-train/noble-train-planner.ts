import { z } from 'zod';

/**
 * Sequência de Nobres (2-5) — planejador PURO do clássico "trem de nobres":
 * o slot 0 limpa o alvo e os slots seguintes noblam, cada chegada separada
 * pelo gap calibrado. Comandos cravados têm precisão máxima de milissegundos,
 * então esta engine só CALCULA os slots (offset relativo à chegada do slot 0);
 * o envio preciso é do Agendador de Comandos existente.
 *
 * Determinística e fail-closed: sem nobres suficientes para os slots de nobre
 * — a menos que `allowLoneSnob` autorize um trem incompleto — o plano é
 * RECUSADO com mensagem pt-BR em vez de sair silenciosamente incompleto. Os
 * nobres excedentes só entram no trem com `autoSplitExtraNobles`, e sempre nas
 * ÚLTIMAS chegadas (mais nobres por último é o lado seguro do combo).
 */

export const NOBLE_TRAIN_ALGORITHM_VERSION = 'noble-train-1' as const;

export const NOBLE_TRAIN_SIZES = Object.freeze([2, 3, 4, 5] as const);

export const NOBLE_TRAIN_MIN_GAP_MS = 100;

export const NOBLE_TRAIN_DEFAULT_GAP_MS = 300;

export type NobleTrainSize = (typeof NOBLE_TRAIN_SIZES)[number];

export interface NobleTrainInput {
  readonly trainSize: NobleTrainSize;
  /** Gap em ms ENTRE chegadas consecutivas (o "gap calibrado"). default 300 */
  readonly gapMs: number;
  /** Nobres disponíveis na origem (>= trainSize, ou 1+ se allowLoneSnob) */
  readonly noblesAvailable: number;
  /** Permitir trem com 1 nobre por slot mesmo sem escolta */
  readonly allowLoneSnob: boolean;
  /** Auto-dividir nobres extras entre os slots após o primeiro (auto-split) */
  readonly autoSplitExtraNobles: boolean;
}

export interface NobleTrainSlot {
  readonly slotIndex: number; // 0 = limpa (primeiro), 1..N-1 = nobres
  readonly arrivalOffsetMs: number; // relativo à chegada do slot 0: slot*gapMs
  readonly nobles: number; // nobres neste slot (slot 0 pode ter 0)
}

export interface NobleTrainPlan {
  readonly version: typeof NOBLE_TRAIN_ALGORITHM_VERSION;
  readonly slots: readonly NobleTrainSlot[];
  readonly totalNobles: number;
  readonly spanMs: number; // (trainSize-1)*gapMs
}

export const nobleTrainInputSchema = z
  .object({
    trainSize: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    // O gap é o dado mais sensível do trem (precisão de ms): piso de 100 ms
    // na fronteira e default do contrato quando o chamador omite.
    gapMs: z.number().int().min(NOBLE_TRAIN_MIN_GAP_MS).default(NOBLE_TRAIN_DEFAULT_GAP_MS),
    noblesAvailable: z.number().int().nonnegative(),
    allowLoneSnob: z.boolean(),
    autoSplitExtraNobles: z.boolean(),
  })
  .strict();

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

/**
 * Erros de contrato do trem em pt-BR (null = válido). Sem nobres suficientes
 * para um nobre por slot de nobre o plano é recusado, exceto no modo
 * `allowLoneSnob` com pelo menos 1 nobre (trem incompleto é válido lá).
 */
export function validateNobleTrain(input: NobleTrainInput): string | null {
  if (!NOBLE_TRAIN_SIZES.includes(input.trainSize)) {
    return `Tamanho de trem inválido: use de ${NOBLE_TRAIN_SIZES[0]} a ${NOBLE_TRAIN_SIZES.at(-1)} nobres (informado: ${input.trainSize}).`;
  }
  if (!Number.isFinite(input.gapMs) || input.gapMs < NOBLE_TRAIN_MIN_GAP_MS) {
    return `Gap entre chegadas inválido: o mínimo é ${NOBLE_TRAIN_MIN_GAP_MS} ms (informado: ${input.gapMs} ms).`;
  }
  const requiredNobles = input.trainSize - 1;
  if (input.noblesAvailable >= requiredNobles) return null;
  if (input.allowLoneSnob && input.noblesAvailable >= 1) return null;
  return `Nobres insuficientes na origem: o trem de ${input.trainSize} exige ${requiredNobles} nobres e há ${input.noblesAvailable} disponíveis. Autorize o nobre sozinho para enviar o trem incompleto ou libere mais nobres.`;
}

/**
 * Calcula os slots do trem. O slot 0 (limpa) nunca leva nobre; os slots 1..N-1
 * recebem 1 nobre cada e, com `autoSplitExtraNobles`, o excedente pinga um a um
 * a partir do ÚLTIMO slot de nobre (ciclando) — as últimas chegadas concentram
 * mais nobres. No modo `allowLoneSnob` sem nobres para todos os slots, os
 * PRIMEIROS slots de nobre são preenchidos e o resto fica em 0.
 *
 * Entrada inválida (forma ou contrato) lança TypeError/ZodError — nunca devolve
 * um trem incompleto em silêncio.
 */
export function planNobleTrain(input: NobleTrainInput): NobleTrainPlan {
  const parsed = nobleTrainInputSchema.parse(input);
  const problem = validateNobleTrain(parsed);
  if (problem !== null) throw new TypeError(problem);

  const nobleSlots = parsed.trainSize - 1;
  const noblesPerSlot = new Array<number>(nobleSlots).fill(0);
  if (parsed.noblesAvailable >= nobleSlots) {
    noblesPerSlot.fill(1);
    const extras = parsed.autoSplitExtraNobles ? parsed.noblesAvailable - nobleSlots : 0;
    for (let index = 0; index < extras; index += 1) {
      const target = nobleSlots - 1 - (index % nobleSlots);
      noblesPerSlot[target] = (noblesPerSlot[target] ?? 0) + 1;
    }
  } else {
    // Trem incompleto autorizado por `allowLoneSnob` (validateNobleTrain já
    // garantiu >= 1 nobre): preenche os primeiros slots de nobre.
    for (let index = 0; index < parsed.noblesAvailable; index += 1) noblesPerSlot[index] = 1;
  }

  const plan: NobleTrainPlan = {
    version: NOBLE_TRAIN_ALGORITHM_VERSION,
    slots: Array.from({ length: parsed.trainSize }, (_, slotIndex) => ({
      slotIndex,
      arrivalOffsetMs: slotIndex * parsed.gapMs,
      nobles: slotIndex === 0 ? 0 : (noblesPerSlot[slotIndex - 1] ?? 0),
    })),
    totalNobles: noblesPerSlot.reduce((total, nobles) => total + nobles, 0),
    spanMs: (parsed.trainSize - 1) * parsed.gapMs,
  };
  return deepFreeze(plan);
}
