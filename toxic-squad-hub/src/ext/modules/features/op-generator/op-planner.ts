import { z } from 'zod';
import { fnv1a64 } from '../../shared/canonical-ids';

/**
 * Gerador de OPs — planejador puro de operações de ataque e apoio. Pareia
 * aldeias de origem com alvos por seis critérios, com refinamento iterativo
 * de distâncias (soma e gargalo) dentro de um orçamento fixo de trabalho.
 *
 * A matemática de pareamento é portada byte a byte do motor rei-do-tribal
 * (montar-pares-v1): os vetores dourados do motor valem aqui sem adaptação.
 * O que muda é o contrato do Hub: sem modelos e sem entryIds fornecidos pelo
 * usuário — cada entrada recebe um ID canônico determinístico (FNV-1a 64
 * sobre tag|comando|critério|grupo|alcance|alvos normalizados), então
 * re-planejar a mesma OP produz o MESMO resultado e a deduplicação entre
 * ciclos acontece naturalmente (a dedupe formal chega em onda posterior).
 */

export const OP_PLANNER_CRITERIA = Object.freeze([
  'distribuir',
  'mais_proximas',
  'mais_distantes',
  'equalizar',
  'dispersar_perto',
  'dispersar_longe',
] as const);

export const OP_PLANNER_ALGORITHM_VERSION = 'op-planner-1' as const;

export const OP_PLANNER_LIMITS = Object.freeze({
  entries: 50,
  targetsTextCharacters: 20_000,
  targetsPerEntry: 500,
  snapshotItems: 500,
  pairsPerEntry: 10_000,
} as const);

export const OP_PLANNER_PROBLEMS = Object.freeze(['unknown-group', 'missing-targets'] as const);

export const opPlannerCriterionSchema = z.enum(OP_PLANNER_CRITERIA);
export const opPlannerRefinementSchema = z.enum(['complete', 'partial', 'none']);
export const opPlannerProblemSchema = z.enum(OP_PLANNER_PROBLEMS);

export const opPlannerEntrySchema = z
  .object({
    tag: z.string().trim().max(120),
    commandKind: z.enum(['attack', 'support']),
    criterion: opPlannerCriterionSchema,
    targetsText: z.string().max(OP_PLANNER_LIMITS.targetsTextCharacters),
    // Alcance em campos; null/ausente = sem limite. 0 é proibido: hoje viraria
    // alcance ILIMITADO (buildPairing), colidindo com o semântico de null.
    maximumDistanceFields: z.number().int().min(1).nullable(),
    groupId: z
      .string()
      .nullable()
      .transform((value) => (value === '' ? null : value)),
  })
  .strict();

export const opPlannerConfigSchema = z
  .object({
    entries: z.array(opPlannerEntrySchema).max(OP_PLANNER_LIMITS.entries).default([]),
  })
  .strict()
  .superRefine((config, context) => {
    config.entries.forEach((entry, index) => {
      if (parseOpPlannerTargets(entry.targetsText).targets.length > OP_PLANNER_LIMITS.targetsPerEntry) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'targetsText'],
          message: 'Entrada excede o limite de alvos normalizados',
        });
      }
    });
  });

export const opPlannerVillageSchema = z
  .object({
    villageId: z.string(),
    coordinate: z.string(),
    groupIds: z.array(z.string()).max(OP_PLANNER_LIMITS.snapshotItems),
  })
  .strict();

export const opPlannerGroupSchema = z.object({ groupId: z.string() }).strict();

export const opPlannerSnapshotSchema = z
  .object({
    villages: z.array(opPlannerVillageSchema).max(OP_PLANNER_LIMITS.snapshotItems),
    groups: z.array(opPlannerGroupSchema).max(OP_PLANNER_LIMITS.snapshotItems),
  })
  .strict();

export const opPlannerWarningSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('duplicate-targets'), count: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('ignored-target-lines'), count: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('own-targets'), coordinates: z.array(z.string()).min(1) }).strict(),
  z.object({ type: z.literal('targets-without-origin'), coordinates: z.array(z.string()).min(1) }).strict(),
  z.object({ type: z.literal('incomplete-refinement'), refinement: z.enum(['partial', 'none']) }).strict(),
]);

export const opPlannerPairSchema = z
  .object({
    sourceVillageId: z.string(),
    sourceCoordinate: z.string(),
    targetCoordinate: z.string(),
    distanceFields: z.number().finite().nonnegative(),
  })
  .strict();

export const opPlannerEntryMetricsSchema = z
  .object({
    origins: z.number().int().nonnegative(),
    targets: z.number().int().nonnegative(),
    pairs: z.number().int().nonnegative(),
    minimumPerTarget: z.number().int().nonnegative(),
    maximumPerTarget: z.number().int().nonnegative(),
    totalDistanceFields: z.number().finite().nonnegative(),
    averageDistanceFields: z.number().finite().nonnegative(),
    maximumDistanceFields: z.number().finite().nonnegative(),
    refinement: opPlannerRefinementSchema,
  })
  .strict();

export const opPlannerEntryResultSchema = z
  .object({
    entryId: z.string(),
    commandKind: z.enum(['attack', 'support']),
    tag: z.string(),
    criterion: opPlannerCriterionSchema,
    normalizedTargets: z.array(z.string()).max(OP_PLANNER_LIMITS.targetsPerEntry),
    pairs: z.array(opPlannerPairSchema).max(OP_PLANNER_LIMITS.pairsPerEntry),
    metrics: opPlannerEntryMetricsSchema,
    warnings: z.array(opPlannerWarningSchema).max(5),
    problems: z.array(opPlannerProblemSchema).max(OP_PLANNER_PROBLEMS.length),
  })
  .strict();

export const opPlannerPlanSchema = z
  .object({
    state: z.enum(['ready', 'blocked', 'empty']),
    algorithmVersion: z.literal(OP_PLANNER_ALGORITHM_VERSION),
    results: z.array(opPlannerEntryResultSchema).max(OP_PLANNER_LIMITS.entries),
    effectsAllowed: z.literal(false),
    sentToTribalWars: z.literal(false),
    scheduledCommands: z.literal(0),
  })
  .strict();

export type OpCriterion = z.infer<typeof opPlannerCriterionSchema>;
export type OpPlannerRefinement = z.infer<typeof opPlannerRefinementSchema>;
export type OpPlannerProblem = z.infer<typeof opPlannerProblemSchema>;
export type OpPlannerEntry = z.infer<typeof opPlannerEntrySchema>;
export type OpPlannerConfig = z.infer<typeof opPlannerConfigSchema>;
export type OpPlannerVillage = z.infer<typeof opPlannerVillageSchema>;
export type OpPlannerGroup = z.infer<typeof opPlannerGroupSchema>;
export type OpPlannerSnapshot = z.infer<typeof opPlannerSnapshotSchema>;
export type OpPlannerWarning = z.infer<typeof opPlannerWarningSchema>;
export type OpPlannerPair = z.infer<typeof opPlannerPairSchema>;
export type OpPlannerEntryMetrics = z.infer<typeof opPlannerEntryMetricsSchema>;
export type OpPlannerEntryResult = z.infer<typeof opPlannerEntryResultSchema>;
export type OpPlannerPlan = z.infer<typeof opPlannerPlanSchema>;

export interface OpPlannerPlanInput {
  readonly config: OpPlannerConfig;
  readonly snapshot: OpPlannerSnapshot;
}

interface Point {
  readonly x: number;
  readonly y: number;
}
interface PairIndex {
  readonly sourceIndex: number;
  readonly targetIndex: number;
}
interface PairingResult {
  readonly pairs: readonly PairIndex[];
  readonly refinement: OpPlannerRefinement;
}

const EPSILON = 1e-9;
const REFINEMENT_WORK_BUDGET = 22_000_000;
const MAX_REFINEMENT_PASSES = 40;

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
};

const point = (coordinate: string): Point => {
  const [x, y] = coordinate.split('|').map(Number);
  return { x: x!, y: y! };
};
const distance = (left: Point, right: Point): number => Math.hypot(left.x - right.x, left.y - right.y);
const outsideSquare = (left: Point, right: Point, reach: number): boolean =>
  Math.abs(left.x - right.x) > reach || Math.abs(left.y - right.y) > reach;
const withinReach = (left: Point, right: Point, reach: number | undefined): boolean =>
  reach === undefined || (!outsideSquare(left, right, reach) && distance(left, right) <= reach);

const createSlots = (
  originCount: number,
  targetCount: number,
): { readonly slots: readonly number[]; readonly minimumCapacity: number; readonly maximumCapacity: number } => {
  if (originCount === 0 || targetCount === 0) return { slots: [], minimumCapacity: 0, maximumCapacity: 0 };
  const minimumCapacity = Math.floor(originCount / targetCount);
  const maximumCapacity = minimumCapacity + (originCount % targetCount > 0 ? 1 : 0);
  const slots: number[] = [];
  for (let round = 0; round < maximumCapacity; round += 1) {
    for (let targetIndex = 0; targetIndex < targetCount; targetIndex += 1) slots.push(targetIndex);
  }
  return { slots, minimumCapacity, maximumCapacity };
};

const impossibleTargets = (
  origins: readonly Point[],
  targets: readonly Point[],
  reach: number | undefined,
): Uint8Array | undefined => {
  if (reach === undefined) return undefined;
  const mask = new Uint8Array(targets.length);
  targets.forEach((target, targetIndex) => {
    if (origins.some((origin) => withinReach(origin, target, reach))) return;
    mask[targetIndex] = 1;
  });
  return mask;
};

const equalizationTargetOrder = (origins: readonly Point[], targets: readonly Point[]): Int32Array => {
  const centroid = origins.reduce((total, origin) => ({ x: total.x + origin.x, y: total.y + origin.y }), {
    x: 0,
    y: 0,
  });
  const center = { x: centroid.x / origins.length, y: centroid.y / origins.length };
  const distances = targets.map((target) => distance(target, center));
  return Int32Array.from(
    targets.map((_, index) => index).sort((left, right) => distances[right]! - distances[left]! || left - right),
  );
};

const initialAssignment = (
  origins: readonly Point[],
  targets: readonly Point[],
  // vendored: origem compila sem noUnusedParameters; o userscript usa
  // noUnusedParameters — underscore é a convenção TS de parâmetro aceito-mas-não-usado.
  _slots: readonly number[],
  criterion: OpCriterion,
  reach: number | undefined,
  maximumCapacity: number,
  impossible?: Uint8Array,
): Int32Array => {
  const assignment = new Int32Array(origins.length).fill(-1);
  const remaining = origins.map((_, index) => index);
  if (criterion === 'dispersar_longe' || criterion === 'dispersar_perto') {
    const far = criterion === 'dispersar_longe';
    const targetCounts = new Int32Array(targets.length);
    let progressed = true;
    while (remaining.length > 0 && progressed) {
      progressed = false;
      for (let targetIndex = 0; targetIndex < targets.length && remaining.length > 0; targetIndex += 1) {
        if (targetCounts[targetIndex]! >= maximumCapacity || impossible?.[targetIndex]) continue;
        let selectedPosition = -1;
        let selectedDistance = 0;
        for (let position = 0; position < remaining.length; position += 1) {
          const sourceIndex = remaining[position]!;
          if (!withinReach(origins[sourceIndex]!, targets[targetIndex]!, reach)) continue;
          const candidateDistance = distance(origins[sourceIndex]!, targets[targetIndex]!);
          if (
            selectedPosition === -1 ||
            (far ? candidateDistance > selectedDistance : candidateDistance < selectedDistance)
          ) {
            selectedPosition = position;
            selectedDistance = candidateDistance;
          }
        }
        if (selectedPosition !== -1) {
          const sourceIndex = remaining[selectedPosition]!;
          assignment[sourceIndex] = targetCounts[targetIndex]! * targets.length + targetIndex;
          targetCounts[targetIndex] = targetCounts[targetIndex]! + 1;
          remaining.splice(selectedPosition, 1);
          progressed = true;
        }
      }
    }
    return assignment;
  }

  const targetOrder = criterion === 'equalizar' ? equalizationTargetOrder(origins, targets) : undefined;
  const unavailable = reach === undefined ? undefined : new Uint8Array(targets.length);
  const far = criterion === 'mais_distantes';
  for (let round = 0; round < maximumCapacity && remaining.length > 0; round += 1) {
    const useEqualizationOrder = targetOrder !== undefined && remaining.length >= targets.length;
    for (let position = 0; position < targets.length && remaining.length > 0; position += 1) {
      const targetIndex = useEqualizationOrder ? targetOrder[position]! : position;
      if (impossible?.[targetIndex] || unavailable?.[targetIndex]) continue;
      let selectedPosition = -1;
      let selectedDistance = 0;
      for (let remainingPosition = 0; remainingPosition < remaining.length; remainingPosition += 1) {
        const sourceIndex = remaining[remainingPosition]!;
        if (!withinReach(origins[sourceIndex]!, targets[targetIndex]!, reach)) continue;
        if (criterion === 'distribuir') {
          selectedPosition = remainingPosition;
          break;
        }
        const candidateDistance = distance(origins[sourceIndex]!, targets[targetIndex]!);
        if (
          selectedPosition === -1 ||
          (far ? candidateDistance > selectedDistance : candidateDistance < selectedDistance)
        ) {
          selectedPosition = remainingPosition;
          selectedDistance = candidateDistance;
        }
      }
      if (selectedPosition !== -1) {
        assignment[remaining[selectedPosition]!] = round * targets.length + targetIndex;
        remaining.splice(selectedPosition, 1);
      } else if (unavailable !== undefined) unavailable[targetIndex] = 1;
    }
  }
  return assignment;
};

const allocationState = (targetCount: number, slots: readonly number[], assignment: Int32Array, relocate: boolean) => {
  if (!relocate) return { counts: new Int32Array(0), emptySlots: [] as number[] };
  const counts = new Int32Array(targetCount);
  const occupied = new Uint8Array(slots.length);
  assignment.forEach((slotIndex) => {
    if (slotIndex !== -1) {
      const targetIndex = slots[slotIndex]!;
      counts[targetIndex] = counts[targetIndex]! + 1;
      occupied[slotIndex] = 1;
    }
  });
  return { counts, emptySlots: slots.map((_, index) => index).filter((index) => !occupied[index]) };
};

const relocateEmptySlots = (
  origins: readonly Point[],
  targets: readonly Point[],
  slots: readonly number[],
  assignment: Int32Array,
  counts: Int32Array,
  minimumCapacity: number,
  emptySlots: number[],
  reach: number,
  maximize: boolean,
  knownDistances?: Float64Array,
): boolean => {
  let changed = false;
  for (let sourceIndex = 0; sourceIndex < assignment.length && emptySlots.length > 0; sourceIndex += 1) {
    if (assignment[sourceIndex] === -1) continue;
    const currentTarget = slots[assignment[sourceIndex]!]!;
    if (counts[currentTarget]! - 1 < minimumCapacity) continue;
    let selected = -1;
    let selectedDistance = knownDistances?.[sourceIndex] ?? distance(origins[sourceIndex]!, targets[currentTarget]!);
    for (let emptyIndex = 0; emptyIndex < emptySlots.length; emptyIndex += 1) {
      const candidateDistance = distance(origins[sourceIndex]!, targets[slots[emptySlots[emptyIndex]!]!]!);
      if (candidateDistance > reach + EPSILON) continue;
      if (maximize ? candidateDistance > selectedDistance + EPSILON : candidateDistance < selectedDistance - EPSILON) {
        selected = emptyIndex;
        selectedDistance = candidateDistance;
      }
    }
    if (selected !== -1) {
      const nextSlot = emptySlots[selected]!;
      const oldSlot = assignment[sourceIndex]!;
      assignment[sourceIndex] = nextSlot;
      counts[currentTarget] = counts[currentTarget]! - 1;
      const nextTarget = slots[nextSlot]!;
      counts[nextTarget] = counts[nextTarget]! + 1;
      emptySlots[selected] = oldSlot;
      if (knownDistances !== undefined) knownDistances[sourceIndex] = selectedDistance;
      changed = true;
    }
  }
  return changed;
};

const refineSum = (
  origins: readonly Point[],
  targets: readonly Point[],
  slots: readonly number[],
  assignment: Int32Array,
  passes: number,
  reach: number,
  maximize: boolean,
  minimumCapacity: number,
  relocate: boolean,
): void => {
  const { counts, emptySlots } = allocationState(targets.length, slots, assignment, relocate);
  for (let pass = 0; pass < passes; pass += 1) {
    let changed = false;
    for (let left = 0; left < assignment.length; left += 1) {
      if (assignment[left] === -1) continue;
      const leftSlot = assignment[left]!;
      const currentLeft = distance(origins[left]!, targets[slots[leftSlot]!]!);
      for (let right = left + 1; right < assignment.length; right += 1) {
        if (assignment[right] === -1) continue;
        const rightSlot = assignment[right]!;
        const swappedLeft = distance(origins[left]!, targets[slots[rightSlot]!]!);
        const swappedRight = distance(origins[right]!, targets[slots[leftSlot]!]!);
        if (swappedLeft > reach + EPSILON || swappedRight > reach + EPSILON) continue;
        const currentRight = distance(origins[right]!, targets[slots[rightSlot]!]!);
        if (
          maximize
            ? swappedLeft + swappedRight > currentLeft + currentRight + EPSILON
            : swappedLeft + swappedRight < currentLeft + currentRight - EPSILON
        ) {
          assignment[left] = rightSlot;
          assignment[right] = leftSlot;
          changed = true;
          break;
        }
      }
    }
    if (
      emptySlots.length > 0 &&
      relocateEmptySlots(origins, targets, slots, assignment, counts, minimumCapacity, emptySlots, reach, maximize)
    )
      changed = true;
    if (!changed) break;
  }
};

const refineBottleneck = (
  origins: readonly Point[],
  targets: readonly Point[],
  slots: readonly number[],
  assignment: Int32Array,
  passes: number,
  reach: number,
  minimumCapacity: number,
  relocate: boolean,
): void => {
  const distances = new Float64Array(assignment.length);
  assignment.forEach((slot, index) => {
    distances[index] = slot === -1 ? 0 : distance(origins[index]!, targets[slots[slot]!]!);
  });
  const { counts, emptySlots } = allocationState(targets.length, slots, assignment, relocate);
  for (let pass = 0; pass < passes; pass += 1) {
    let changed = false;
    const sourceOrder = origins
      .map((_, index) => index)
      .filter((index) => assignment[index] !== -1)
      .sort((left, right) => distances[right]! - distances[left]! || left - right);
    for (const left of sourceOrder) {
      let selected = -1;
      let best = distances[left]!;
      let nextLeftDistance = 0;
      let nextRightDistance = 0;
      for (let right = 0; right < assignment.length; right += 1) {
        if (right === left || assignment[right] === -1) continue;
        const currentBottleneck = Math.max(distances[left]!, distances[right]!);
        const swappedLeft = distance(origins[left]!, targets[slots[assignment[right]!]!]!);
        const swappedRight = distance(origins[right]!, targets[slots[assignment[left]!]!]!);
        if (swappedLeft > reach || swappedRight > reach) continue;
        const swappedBottleneck = Math.max(swappedLeft, swappedRight);
        if (swappedBottleneck < currentBottleneck - EPSILON && swappedBottleneck < best - EPSILON) {
          best = swappedBottleneck;
          selected = right;
          nextLeftDistance = swappedLeft;
          nextRightDistance = swappedRight;
        }
      }
      if (selected !== -1) {
        const leftSlot = assignment[left]!;
        assignment[left] = assignment[selected]!;
        assignment[selected] = leftSlot;
        distances[left] = nextLeftDistance;
        distances[selected] = nextRightDistance;
        changed = true;
      }
    }
    if (
      emptySlots.length > 0 &&
      relocateEmptySlots(
        origins,
        targets,
        slots,
        assignment,
        counts,
        minimumCapacity,
        emptySlots,
        reach,
        false,
        distances,
      )
    )
      changed = true;
    if (!changed) break;
  }
};

const refinementBudget = (
  originCount: number,
  assignedCount: number,
  missingSlots: number,
  equalize: boolean,
  reachChecks: number,
) => {
  const none = { refinement: 'none' as const, bottleneckPasses: 0, sumPasses: 0, relocate: false };
  if (originCount <= 0 || originCount > 6_500) return none;
  const remainingWork = REFINEMENT_WORK_BUDGET - (originCount * originCount) / 2 - reachChecks;
  if (remainingWork <= 0) return none;
  const relocate = missingSlots > 0 && assignedCount * missingSlots <= 5_000_000;
  const relocationWork = relocate ? assignedCount * missingSlots : 0;
  const sumWork = originCount * originCount + relocationWork;
  const bottleneckWork = 6 * originCount * originCount + relocationWork;
  const sumPasses = Math.min(MAX_REFINEMENT_PASSES, Math.floor(remainingWork / sumWork));
  if (!equalize)
    return sumPasses >= 1 ? { refinement: 'complete' as const, bottleneckPasses: 0, sumPasses, relocate } : none;
  const bottleneckPasses = Math.min(MAX_REFINEMENT_PASSES, Math.floor((0.6 * remainingWork) / bottleneckWork));
  const equalizeSumPasses = Math.min(MAX_REFINEMENT_PASSES, Math.floor((0.4 * remainingWork) / sumWork));
  if (bottleneckPasses >= 2 && equalizeSumPasses >= 1)
    return { refinement: 'complete' as const, bottleneckPasses, sumPasses: equalizeSumPasses, relocate };
  return sumPasses >= 1 ? { refinement: 'partial' as const, bottleneckPasses: 0, sumPasses, relocate } : none;
};

const buildPairing = (
  origins: readonly Point[],
  targets: readonly Point[],
  criterion: OpCriterion,
  maximumDistance: number | null,
): PairingResult => {
  const { slots, minimumCapacity, maximumCapacity } = createSlots(origins.length, targets.length);
  if (slots.length === 0) return { pairs: [], refinement: 'none' };
  const reach = maximumDistance !== null && maximumDistance > 0 ? maximumDistance : undefined;
  const impossible = impossibleTargets(origins, targets, reach);
  const assignment = initialAssignment(origins, targets, slots, criterion, reach, maximumCapacity, impossible);
  let refinement: OpPlannerRefinement = 'none';
  if (criterion === 'mais_proximas' || criterion === 'mais_distantes' || criterion === 'equalizar') {
    const assignedCount = [...assignment].filter((slot) => slot !== -1).length;
    const budget = refinementBudget(
      origins.length,
      assignedCount,
      slots.length - assignedCount,
      criterion === 'equalizar',
      reach === undefined ? 0 : origins.length * targets.length,
    );
    refinement = budget.refinement;
    const distanceLimit = reach ?? Number.POSITIVE_INFINITY;
    if (criterion === 'mais_proximas' && refinement !== 'none')
      refineSum(
        origins,
        targets,
        slots,
        assignment,
        budget.sumPasses,
        distanceLimit,
        false,
        minimumCapacity,
        budget.relocate,
      );
    if (criterion === 'mais_distantes' && refinement !== 'none')
      refineSum(
        origins,
        targets,
        slots,
        assignment,
        budget.sumPasses,
        distanceLimit,
        true,
        minimumCapacity,
        budget.relocate,
      );
    if (criterion === 'equalizar' && refinement !== 'none') {
      if (refinement === 'complete')
        refineBottleneck(
          origins,
          targets,
          slots,
          assignment,
          budget.bottleneckPasses,
          distanceLimit,
          minimumCapacity,
          budget.relocate,
        );
      const bottleneck = Math.min(
        assignment.reduce(
          (maximum, slot, sourceIndex) =>
            slot === -1 ? maximum : Math.max(maximum, distance(origins[sourceIndex]!, targets[slots[slot]!]!)),
          0,
        ),
        distanceLimit,
      );
      refineSum(
        origins,
        targets,
        slots,
        assignment,
        budget.sumPasses,
        bottleneck,
        false,
        minimumCapacity,
        budget.relocate,
      );
    }
  }
  const pairs = [...assignment].flatMap((slot, sourceIndex): PairIndex[] =>
    slot === -1 ? [] : [{ sourceIndex, targetIndex: slots[slot]! }],
  );
  pairs.sort((left, right) => left.targetIndex - right.targetIndex || left.sourceIndex - right.sourceIndex);
  return { pairs, refinement };
};

const emptyMetrics = (origins: number, targets: number): OpPlannerEntryMetrics => ({
  origins,
  targets,
  pairs: 0,
  minimumPerTarget: 0,
  maximumPerTarget: 0,
  totalDistanceFields: 0,
  averageDistanceFields: 0,
  maximumDistanceFields: 0,
  refinement: 'none',
});

/**
 * Normaliza coordenadas `x|y` (0..999): mantém a PRIMEIRA ocorrência de cada
 * alvo e conta duplicatas e linhas ignoradas — fail-closed, sem nunca inventar
 * alvos que o usuário não digitou.
 */
export function parseOpPlannerTargets(text: string): {
  readonly targets: readonly string[];
  readonly duplicates: number;
  readonly ignoredLines: number;
} {
  const normalized = (value: string): readonly string[] =>
    [...value.matchAll(/\d+\|\d+/g)].flatMap(([raw]) => {
      const [x, y] = raw.split('|').map(Number);
      return x! <= 999 && y! <= 999 ? [`${x}|${y}`] : [];
    });
  const seen = new Set<string>();
  for (const raw of normalized(text)) seen.add(raw);
  const targets = [...seen];
  const matches = normalized(text).length;
  const ignoredLines = text.split('\n').filter((line) => line.trim() !== '' && normalized(line).length === 0).length;
  return { targets, duplicates: matches - targets.length, ignoredLines };
}

export function validateOpPlannerEntry(
  entry: OpPlannerEntry,
  snapshot: OpPlannerSnapshot,
): {
  readonly parsedTargets: ReturnType<typeof parseOpPlannerTargets>;
  readonly problems: OpPlannerProblem[];
} {
  const parsedTargets = parseOpPlannerTargets(entry.targetsText);
  const problems: OpPlannerProblem[] = [];
  if (entry.groupId !== null && !snapshot.groups.some((group) => group.groupId === entry.groupId!))
    problems.push('unknown-group');
  if (parsedTargets.targets.length === 0) problems.push('missing-targets');
  return { parsedTargets, problems };
}

export const planOpPlanner = (input: OpPlannerPlanInput): OpPlannerPlan => {
  const config = opPlannerConfigSchema.parse(input.config);
  const snapshot = opPlannerSnapshotSchema.parse(input.snapshot);
  const parsedEntries = config.entries.map((entry) => {
    const { parsedTargets, problems } = validateOpPlannerEntry(entry, snapshot);
    const origins =
      entry.groupId === null
        ? snapshot.villages
        : snapshot.villages.filter((village) => village.groupIds.includes(entry.groupId!));
    return { entry, parsed: parsedTargets, origins, problems };
  });
  const productionEmpty = snapshot.villages.length === 0 && snapshot.groups.length === 0;
  const blocked = !productionEmpty && parsedEntries.some(({ problems }) => problems.length > 0);

  const results: OpPlannerEntryResult[] = parsedEntries.map(({ entry, parsed, origins, problems }) => {
    // ID canônico determinístico (FNV-1a 64 de canonical-ids): a mesma entrada
    // com os mesmos alvos normalizados produz SEMPRE o mesmo entryId (dedupe
    // entre ciclos). Grupo e alcance mudam os pares, então fazem parte do hash.
    const entryId = `op_${fnv1a64(`${entry.tag}|${entry.commandKind}|${entry.criterion}|${entry.groupId ?? ''}|${entry.maximumDistanceFields ?? ''}|${parsed.targets.join(',')}`)}`;
    const warnings: OpPlannerWarning[] = [];
    if (parsed.duplicates > 0) warnings.push({ type: 'duplicate-targets', count: parsed.duplicates });
    if (parsed.ignoredLines > 0) warnings.push({ type: 'ignored-target-lines', count: parsed.ignoredLines });
    const ownCoordinates =
      entry.commandKind === 'attack'
        ? parsed.targets.filter((target) => snapshot.villages.some((village) => village.coordinate === target))
        : [];
    if (ownCoordinates.length > 0) warnings.push({ type: 'own-targets', coordinates: ownCoordinates });
    if (productionEmpty || blocked) {
      return {
        entryId,
        commandKind: entry.commandKind,
        tag: entry.tag,
        criterion: entry.criterion,
        normalizedTargets: [...parsed.targets],
        pairs: [],
        metrics: emptyMetrics(origins.length, parsed.targets.length),
        warnings,
        problems: productionEmpty ? [] : problems,
      };
    }

    const targetPoints = parsed.targets.map(point);
    const pairing = buildPairing(
      origins.map((origin) => point(origin.coordinate)),
      targetPoints,
      entry.criterion,
      entry.maximumDistanceFields,
    );
    const pairs: OpPlannerPair[] = pairing.pairs.map(({ sourceIndex, targetIndex }) => ({
      sourceVillageId: origins[sourceIndex]!.villageId,
      sourceCoordinate: origins[sourceIndex]!.coordinate,
      targetCoordinate: parsed.targets[targetIndex]!,
      distanceFields: distance(point(origins[sourceIndex]!.coordinate), targetPoints[targetIndex]!),
    }));
    const counts = parsed.targets.map(
      (_, targetIndex) => pairing.pairs.filter((pair) => pair.targetIndex === targetIndex).length,
    );
    const totalDistanceFields = pairs.reduce((total, pair) => total + pair.distanceFields, 0);
    const targetsWithoutOrigin = counts.flatMap((count, index) => (count === 0 ? [parsed.targets[index]!] : []));
    if (targetsWithoutOrigin.length > 0)
      warnings.push({ type: 'targets-without-origin', coordinates: targetsWithoutOrigin });
    if (
      (entry.criterion === 'mais_proximas' ||
        entry.criterion === 'mais_distantes' ||
        entry.criterion === 'equalizar') &&
      pairs.length > 0 &&
      pairing.refinement !== 'complete'
    ) {
      warnings.push({ type: 'incomplete-refinement', refinement: pairing.refinement });
    }
    const metrics: OpPlannerEntryMetrics = {
      origins: origins.length,
      targets: parsed.targets.length,
      pairs: pairs.length,
      minimumPerTarget: counts.length === 0 ? 0 : Math.min(...counts),
      maximumPerTarget: counts.length === 0 ? 0 : Math.max(...counts),
      totalDistanceFields,
      averageDistanceFields: pairs.length === 0 ? 0 : totalDistanceFields / pairs.length,
      maximumDistanceFields: pairs.length === 0 ? 0 : Math.max(...pairs.map((pair) => pair.distanceFields)),
      refinement: pairing.refinement,
    };
    return {
      entryId,
      commandKind: entry.commandKind,
      tag: entry.tag,
      criterion: entry.criterion,
      normalizedTargets: [...parsed.targets],
      pairs,
      metrics,
      warnings,
      problems: [],
    };
  });

  const state =
    productionEmpty || config.entries.length === 0
      ? 'empty'
      : blocked
        ? 'blocked'
        : results.every((result) => result.pairs.length === 0)
          ? 'empty'
          : 'ready';
  const plan: OpPlannerPlan = {
    state,
    algorithmVersion: OP_PLANNER_ALGORITHM_VERSION,
    results,
    effectsAllowed: false,
    sentToTribalWars: false,
    scheduledCommands: 0,
  };
  return deepFreeze(opPlannerPlanSchema.parse(plan));
};

// Nomes canônicos do registro de módulos (module-plugins): o planner é o
// mesmo, apenas com a nomenclatura herdada do contrato rei-do-tribal.
export const opGeneratorConfigSchema = opPlannerConfigSchema;
export const planOpGenerator = planOpPlanner;
export type OpGeneratorConfig = OpPlannerConfig;
export type OpGeneratorGroup = OpPlannerGroup;
export type OpGeneratorVillage = OpPlannerVillage;
