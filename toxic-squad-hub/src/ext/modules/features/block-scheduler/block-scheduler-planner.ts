import { z } from 'zod';

/**
 * Agendamento em Bloco — engine PURA da matriz origem×alvo em massa.
 *
 * Recebe aldeias de ORIGEM (por grupo ou coordenadas, já resolvidas pelo
 * chamador), ALVOS e as cotas de comando de cada lado, e devolve a lista de
 * comandos (origem → alvo) que respeita as duas cotas ao mesmo tempo: o total
 * é sempre `min(soma origem, soma alvo)`.
 *
 * Modos de cálculo:
 * - `mais_perto`: greedy — a cada comando, escolhe o par (origem com cota
 *   restante, alvo com demanda restante) de MENOR viagem; empate resolve pela
 *   ordem de entrada (menor índice de origem, depois menor índice de alvo).
 * - `otimizado`: greedy + melhoria local 2-opt — troca os ALVOS entre dois
 *   comandos enquanto a soma total de viagens diminuir (teto de 50 passadas).
 *   A troca preserva as cotas dos dois lados (cada comando mantém a origem e o
 *   multiconjunto de alvos não muda), então o resultado nunca é pior que o
 *   greedy e continua válido.
 *
 * Fronteira de responsabilidade: esta engine NÃO lê relógio e NÃO calcula
 * horário de envio. `travelMinutes` é injetada — o chamador conhece unidades,
 * velocidade e torres de vigia — e a janela de chegada é apenas VALIDADA; quem
 * converte viagem em `sendAt` é o scheduler. Todo valor de tempo do contrato é
 * epoch em ms.
 *
 * Fail-closed: entrada estruturalmente inválida → `ZodError`; regra de negócio
 * violada (janela invertida, cotas malformadas, teto de comandos) → `Error` com
 * a mensagem pt-BR de `validateBlockPlanInput`. Nada de aviso silencioso:
 * origem sem par, alvo não preenchido, cotas cortadas pelo lado menor, pares
 * origem=alvo bloqueados e viagens inválidas aparecem em `warnings`.
 */

export const BLOCK_SCHEDULER_ALGORITHM_VERSION = 'block-scheduler-1' as const;

export const BLOCK_SCHEDULER_LIMITS = Object.freeze({
  origins: 100,
  targets: 100,
  commands: 2_000,
  perSlot: 1_000,
  perSlotTextCharacters: 4_000,
  /** Avisos detalhados por categoria antes de resumir o excedente. */
  detailedWarnings: 5,
  /** Teto de passadas do refinamento 2-opt (para em estabilizar). */
  refinementPasses: 50,
} as const);

export const BLOCK_CALC_MODES = Object.freeze(['otimizado', 'mais_perto'] as const);

export const blockCalcModeSchema = z.enum(BLOCK_CALC_MODES);

const nonnegativeIntegerSchema = z.number().int().nonnegative();

export const blockCoordSchema = z
  .object({ x: nonnegativeIntegerSchema, y: nonnegativeIntegerSchema })
  .strict();

export const blockTimingSchema = z
  .object({
    arrivalMs: nonnegativeIntegerSchema.optional(),
    windowFromMs: nonnegativeIntegerSchema.optional(),
    windowFromToMs: nonnegativeIntegerSchema.optional(),
  })
  .strict()
  .nullable();

export type BlockCalcMode = z.infer<typeof blockCalcModeSchema>;

export interface BlockCoord {
  readonly x: number;
  readonly y: number;
}

export interface BlockPlanInput {
  readonly origins: readonly BlockCoord[];
  readonly targets: readonly BlockCoord[];
  /** "2;1" → origem[0] envia 2, origem[1] envia 1; "2" → todas 2 */
  readonly commandsPerOrigin: string;
  /** idem por alvo; com máximo dinâmico: o total é limitado pelo menor lado */
  readonly commandsPerTarget: string;
  readonly allowSameOriginTarget: boolean;
  readonly calcMode: BlockCalcMode;
  /** viagem em MINUTOS (fração ok); injetada — engine não conhece unidades */
  readonly travelMinutes: (from: BlockCoord, to: BlockCoord) => number;
  /**
   * Chegada alvo comum (ms epoch) OU janela {fromMs,toMs} OU null = partida
   * imediata. Os valores opcionais aceitam `undefined` explícito para que a
   * saída de `blockPlanInputSchema.parse` seja atribuível a este contrato.
   */
  readonly timing: Readonly<{
    arrivalMs?: number | undefined;
    windowFromMs?: number | undefined;
    windowFromToMs?: number | undefined;
  }> | null;
}

export interface BlockPlanCommand {
  readonly origin: BlockCoord;
  readonly target: BlockCoord;
  readonly travelMinutes: number;
  /** Ordem de criação (0..n-1): a posição no vetor `commands`. */
  readonly index: number;
}

export interface BlockPlan {
  readonly version: typeof BLOCK_SCHEDULER_ALGORITHM_VERSION;
  readonly commands: readonly BlockPlanCommand[];
  /** pt-BR: origem sem par, alvo não preenchido, cotas cortadas, etc. */
  readonly warnings: readonly string[];
}

export const blockPlanInputSchema = z
  .object({
    origins: z.array(blockCoordSchema).max(BLOCK_SCHEDULER_LIMITS.origins),
    targets: z.array(blockCoordSchema).max(BLOCK_SCHEDULER_LIMITS.targets),
    commandsPerOrigin: z.string().max(BLOCK_SCHEDULER_LIMITS.perSlotTextCharacters),
    commandsPerTarget: z.string().max(BLOCK_SCHEDULER_LIMITS.perSlotTextCharacters),
    allowSameOriginTarget: z.boolean(),
    calcMode: blockCalcModeSchema,
    travelMinutes: z.custom<BlockPlanInput['travelMinutes']>(
      (value) => typeof value === 'function',
      'travelMinutes deve ser uma função',
    ),
    timing: blockTimingSchema,
  })
  .strict();

const EPSILON = 1e-9;

interface MutableCommand {
  originIndex: number;
  targetIndex: number;
  travel: number;
}

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
};

const coordinateLabel = (coordinate: BlockCoord): string => `${coordinate.x}|${coordinate.y}`;

const plural = (count: number, singular: string, pluralForm: string): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;

const sameCoordinate = (left: BlockCoord, right: BlockCoord): boolean =>
  left.x === right.x && left.y === right.y;

const isCoordinate = (value: unknown): value is BlockCoord =>
  typeof value === 'object' &&
  value !== null &&
  Number.isInteger((value as BlockCoord).x) &&
  Number.isInteger((value as BlockCoord).y) &&
  (value as BlockCoord).x >= 0 &&
  (value as BlockCoord).y >= 0;

const expandQuotas = (counts: readonly number[], slotCount: number): number[] =>
  counts.length === 1 ? new Array<number>(slotCount).fill(counts[0]!) : [...counts];

const totalQuota = (counts: readonly number[]): number => counts.reduce((total, count) => total + count, 0);

/**
 * Lê cotas no formato "2;1" (uma por aldeia, na ordem de entrada) ou "2"
 * (mesmo valor para todas). Devolve `null` para qualquer coisa que não seja
 * inteiro positivo dentro do teto — zero, negativo, decimal, vazio e lixo são
 * rejeitados (fail-closed: nunca inventa uma cota).
 */
export function parsePerSlotCounts(raw: string): number[] | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const counts: number[] = [];
  for (const token of raw.split(';')) {
    const trimmed = token.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const value = Number(trimmed);
    if (!Number.isSafeInteger(value) || value <= 0 || value > BLOCK_SCHEDULER_LIMITS.perSlot) return null;
    counts.push(value);
  }
  return counts;
}

/** Valida a entrada do plano e devolve a primeira violação em pt-BR (ou null). */
export function validateBlockPlanInput(input: BlockPlanInput): string | null {
  if (!Array.isArray(input.origins) || !Array.isArray(input.targets))
    return 'Informe as aldeias de origem e os alvos.';
  if (input.origins.length === 0) return 'Informe ao menos uma aldeia de origem.';
  if (input.targets.length === 0) return 'Informe ao menos um alvo.';
  if (input.origins.length > BLOCK_SCHEDULER_LIMITS.origins)
    return `Limite de ${BLOCK_SCHEDULER_LIMITS.origins} aldeias de origem excedido.`;
  if (input.targets.length > BLOCK_SCHEDULER_LIMITS.targets)
    return `Limite de ${BLOCK_SCHEDULER_LIMITS.targets} alvos excedido.`;
  if (input.calcMode !== 'otimizado' && input.calcMode !== 'mais_perto')
    return 'Modo de cálculo inválido: use "otimizado" ou "mais_perto".';
  if (typeof input.travelMinutes !== 'function')
    return 'Informe a função de viagem (travelMinutes) entre origem e alvo.';
  for (const coordinate of [...input.origins, ...input.targets]) {
    if (!isCoordinate(coordinate)) return `Coordenada inválida: ${coordinateLabel(coordinate)}.`;
  }

  const perOrigin = parsePerSlotCounts(input.commandsPerOrigin);
  if (perOrigin === null)
    return 'Cotas de origem inválidas: use "2;1" (uma por aldeia) ou "2" (todas as aldeias).';
  if (perOrigin.length !== 1 && perOrigin.length !== input.origins.length)
    return `Cotas de origem: informe 1 valor ou exatamente ${input.origins.length} valores separados por ";".`;
  const perTarget = parsePerSlotCounts(input.commandsPerTarget);
  if (perTarget === null)
    return 'Cotas de alvo inválidas: use "2;1" (uma por alvo) ou "2" (todos os alvos).';
  if (perTarget.length !== 1 && perTarget.length !== input.targets.length)
    return `Cotas de alvo: informe 1 valor ou exatamente ${input.targets.length} valores separados por ";".`;

  const commands = Math.min(
    totalQuota(expandQuotas(perOrigin, input.origins.length)),
    totalQuota(expandQuotas(perTarget, input.targets.length)),
  );
  if (commands > BLOCK_SCHEDULER_LIMITS.commands)
    return `O plano excede o teto de ${BLOCK_SCHEDULER_LIMITS.commands} comandos.`;

  const timing = input.timing ?? null;
  if (timing !== null) {
    const hasArrival = timing.arrivalMs !== undefined;
    const hasWindow = timing.windowFromMs !== undefined || timing.windowFromToMs !== undefined;
    if (hasArrival && hasWindow) return 'Informe chegada comum OU janela de chegada, nunca as duas.';
    if (timing.windowFromMs !== undefined && timing.windowFromToMs === undefined)
      return 'Janela de chegada incompleta: informe o início e o fim.';
    if (timing.windowFromToMs !== undefined && timing.windowFromMs === undefined)
      return 'Janela de chegada incompleta: informe o início e o fim.';
    for (const value of [timing.arrivalMs, timing.windowFromMs, timing.windowFromToMs]) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0))
        return 'Horários devem ser epoch em ms (inteiro não negativo).';
    }
    if (
      timing.windowFromMs !== undefined &&
      timing.windowFromToMs !== undefined &&
      timing.windowFromToMs < timing.windowFromMs
    )
      return 'Janela de chegada inválida: o fim é anterior ao início.';
  }
  return null;
}

/**
 * Greedy: a cada comando escolhe o par (origem com cota, alvo com demanda) de
 * menor viagem. Viagens inválidas (NaN/infinito/negativas) são tratadas como
 * inalcançáveis e nunca viram comando — o par fica para os avisos.
 */
const allocateGreedy = (
  origins: readonly BlockCoord[],
  targets: readonly BlockCoord[],
  originRemaining: number[],
  targetRemaining: number[],
  total: number,
  allowSameOriginTarget: boolean,
  travel: (originIndex: number, targetIndex: number) => number,
  skippedSamePair: Set<number>,
): MutableCommand[] => {
  const commands: MutableCommand[] = [];
  for (let created = 0; created < total; created += 1) {
    let bestOrigin = -1;
    let bestTarget = -1;
    let bestTravel = Number.POSITIVE_INFINITY;
    for (let originIndex = 0; originIndex < origins.length; originIndex += 1) {
      if (originRemaining[originIndex]! <= 0) continue;
      for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
        if (targetRemaining[targetIndex]! <= 0) continue;
        if (!allowSameOriginTarget && sameCoordinate(origins[originIndex]!, targets[targetIndex]!)) {
          skippedSamePair.add(originIndex * targets.length + targetIndex);
          continue;
        }
        const candidate = travel(originIndex, targetIndex);
        if (candidate < bestTravel) {
          bestTravel = candidate;
          bestOrigin = originIndex;
          bestTarget = targetIndex;
        }
      }
    }
    if (bestOrigin === -1) break;
    originRemaining[bestOrigin] = originRemaining[bestOrigin]! - 1;
    targetRemaining[bestTarget] = targetRemaining[bestTarget]! - 1;
    commands.push({ originIndex: bestOrigin, targetIndex: bestTarget, travel: bestTravel });
  }
  return commands;
};

/**
 * 2-opt de alvos: troca os alvos de dois comandos quando a soma cai. As cotas
 * dos dois lados ficam intactas (origens fixas, multiconjunto de alvos igual),
 * então qualquer troca aceita continua um plano válido.
 */
const refineSwaps = (
  commands: readonly MutableCommand[],
  origins: readonly BlockCoord[],
  targets: readonly BlockCoord[],
  allowSameOriginTarget: boolean,
  travel: (originIndex: number, targetIndex: number) => number,
): void => {
  let improved = true;
  for (let pass = 0; pass < BLOCK_SCHEDULER_LIMITS.refinementPasses && improved; pass += 1) {
    improved = false;
    for (let left = 0; left < commands.length && !improved; left += 1) {
      const leftCommand = commands[left]!;
      for (let right = left + 1; right < commands.length; right += 1) {
        const rightCommand = commands[right]!;
        if (leftCommand.targetIndex === rightCommand.targetIndex) continue;
        if (
          !allowSameOriginTarget &&
          (sameCoordinate(origins[leftCommand.originIndex]!, targets[rightCommand.targetIndex]!) ||
            sameCoordinate(origins[rightCommand.originIndex]!, targets[leftCommand.targetIndex]!))
        )
          continue;
        const swappedLeft = travel(leftCommand.originIndex, rightCommand.targetIndex);
        const swappedRight = travel(rightCommand.originIndex, leftCommand.targetIndex);
        if (swappedLeft + swappedRight >= leftCommand.travel + rightCommand.travel - EPSILON) continue;
        const previousTarget = leftCommand.targetIndex;
        leftCommand.targetIndex = rightCommand.targetIndex;
        leftCommand.travel = swappedLeft;
        rightCommand.targetIndex = previousTarget;
        rightCommand.travel = swappedRight;
        improved = true;
        break;
      }
    }
  }
};

export function planBlockSchedule(input: BlockPlanInput): BlockPlan {
  const parsed = blockPlanInputSchema.parse(input);
  const violation = validateBlockPlanInput(input);
  if (violation !== null) throw new Error(violation);

  const origins = parsed.origins.map((coordinate) => ({ x: coordinate.x, y: coordinate.y }));
  const targets = parsed.targets.map((coordinate) => ({ x: coordinate.x, y: coordinate.y }));
  const perOrigin = expandQuotas(parsePerSlotCounts(parsed.commandsPerOrigin)!, origins.length);
  const perTarget = expandQuotas(parsePerSlotCounts(parsed.commandsPerTarget)!, targets.length);
  const originRemaining = [...perOrigin];
  const targetRemaining = [...perTarget];
  const sumOrigin = totalQuota(perOrigin);
  const sumTarget = totalQuota(perTarget);
  const total = Math.min(sumOrigin, sumTarget);

  // Memo por par: `travelMinutes` é injetada e pode ser cara; cada par é
  // consultado no máximo uma vez e um valor inválido vira inalcançável.
  const travelCache = new Map<number, number>();
  let invalidTravelPairs = 0;
  const travel = (originIndex: number, targetIndex: number): number => {
    const key = originIndex * targets.length + targetIndex;
    const cached = travelCache.get(key);
    if (cached !== undefined) return cached;
    const raw = parsed.travelMinutes(origins[originIndex]!, targets[targetIndex]!);
    const valid = Number.isFinite(raw) && raw >= 0;
    if (!valid) invalidTravelPairs += 1;
    const value = valid ? raw : Number.POSITIVE_INFINITY;
    travelCache.set(key, value);
    return value;
  };

  const skippedSamePair = new Set<number>();
  const commands = allocateGreedy(
    origins,
    targets,
    originRemaining,
    targetRemaining,
    total,
    parsed.allowSameOriginTarget,
    travel,
    skippedSamePair,
  );
  if (parsed.calcMode === 'otimizado')
    refineSwaps(commands, origins, targets, parsed.allowSameOriginTarget, travel);

  const warnings: string[] = [];
  if (sumOrigin !== sumTarget)
    warnings.push(
      `Cotas desiguais entre origem (${sumOrigin}) e alvo (${sumTarget}): o plano foi limitado a ${plural(total, 'comando', 'comandos')}.`,
    );
  if (skippedSamePair.size > 0)
    warnings.push(
      `Pares origem=alvo bloqueados: ${skippedSamePair.size} (origem e alvo na mesma coordenada).`,
    );
  if (invalidTravelPairs > 0)
    warnings.push(
      invalidTravelPairs === 1
        ? 'Viagem inválida em 1 par origem-alvo: tratada como inalcançável.'
        : `Viagens inválidas em ${invalidTravelPairs} pares origem-alvo: tratadas como inalcançáveis.`,
    );

  const unmatchedOrigins = origins
    .map((_, originIndex) => originIndex)
    .filter((originIndex) => originRemaining[originIndex]! > 0);
  for (const originIndex of unmatchedOrigins.slice(0, BLOCK_SCHEDULER_LIMITS.detailedWarnings))
    warnings.push(
      `Origem ${coordinateLabel(origins[originIndex]!)} ficou sem par: ${plural(
        originRemaining[originIndex]!,
        'comando não alocado',
        'comandos não alocados',
      )}.`,
    );
  if (unmatchedOrigins.length > BLOCK_SCHEDULER_LIMITS.detailedWarnings)
    warnings.push(
      `Mais ${unmatchedOrigins.length - BLOCK_SCHEDULER_LIMITS.detailedWarnings} origem(ns) ficaram sem par.`,
    );

  const unfilledTargets = targets
    .map((_, targetIndex) => targetIndex)
    .filter((targetIndex) => targetRemaining[targetIndex]! > 0);
  for (const targetIndex of unfilledTargets.slice(0, BLOCK_SCHEDULER_LIMITS.detailedWarnings)) {
    const missing = targetRemaining[targetIndex]!;
    warnings.push(
      `Alvo ${coordinateLabel(targets[targetIndex]!)} não foi preenchido: ${
        missing === 1 ? 'falta 1 comando' : `faltam ${missing} comandos`
      }.`,
    );
  }
  if (unfilledTargets.length > BLOCK_SCHEDULER_LIMITS.detailedWarnings)
    warnings.push(
      `Mais ${unfilledTargets.length - BLOCK_SCHEDULER_LIMITS.detailedWarnings} alvo(s) não foram preenchidos.`,
    );

  const plan: BlockPlan = {
    version: BLOCK_SCHEDULER_ALGORITHM_VERSION,
    commands: commands.map((command, index) => ({
      origin: origins[command.originIndex]!,
      target: targets[command.targetIndex]!,
      travelMinutes: command.travel,
      index,
    })),
    warnings,
  };
  return deepFreeze(plan);
}
