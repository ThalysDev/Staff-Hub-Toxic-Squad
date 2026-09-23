import { z } from 'zod';
import { fnv1a64 } from '../../shared/canonical-ids';

/**
 * Planejador de apoio em massa — portado byte a byte do motor rei-do-tribal
 * (mass-support): a matemática de distância, duração, alocação e déficit de
 * defesa é a mesma; o contrato e o vocabulário são os do Hub. Função pura,
 * determinística e fail-closed: os planos retornados são congelados em
 * profundidade e nunca mutam a entrada.
 *
 * Domínio restrito às 7 unidades de apoio (lança, espada, arqueiro,
 * explorador, cav. leve, arqueiro a cavalo e cav. pesada) com os valores
 * canônicos de população por unidade e minutos por campo do jogo.
 */

export const SUPPORT_UNITS = Object.freeze(['spear', 'sword', 'archer', 'spy', 'light', 'marcher', 'heavy'] as const);

export type SupportUnit = (typeof SUPPORT_UNITS)[number];

const POPULATION: Readonly<Record<SupportUnit, number>> = Object.freeze({
  spear: 1,
  sword: 1,
  archer: 1,
  spy: 0,
  light: 1,
  marcher: 1,
  heavy: 4,
});

const MINUTES_PER_FIELD: Readonly<Record<SupportUnit, number>> = Object.freeze({
  spear: 18,
  sword: 22,
  archer: 18,
  spy: 9,
  light: 10,
  marcher: 10,
  heavy: 11,
});

const quantitySchema = z.number().int().nonnegative().max(1_000_000_000);
const coordinateSchema = z.string().regex(/^(?:0|[1-9]\d{0,2})\|(?:0|[1-9]\d{0,2})$/);
const isoTimestampSchema = z.string().datetime({ offset: true });

export const supportUnitSchema = z.enum(SUPPORT_UNITS);
export const supportUnitAmountsSchema = z
  .object({
    spear: quantitySchema,
    sword: quantitySchema,
    archer: quantitySchema,
    spy: quantitySchema,
    light: quantitySchema,
    marcher: quantitySchema,
    heavy: quantitySchema,
  })
  .strict();
export const supportUnitLimitsSchema = supportUnitAmountsSchema.partial().strict();
export const supportUnitWeightsSchema = z
  .object({
    spear: z.number().nonnegative().finite(),
    sword: z.number().nonnegative().finite(),
    archer: z.number().nonnegative().finite(),
    spy: z.number().nonnegative().finite(),
    light: z.number().nonnegative().finite(),
    marcher: z.number().nonnegative().finite(),
    heavy: z.number().nonnegative().finite(),
  })
  .partial()
  .strict();

const zeroUnitAmounts = (): SupportUnitAmounts => ({
  spear: 0,
  sword: 0,
  archer: 0,
  spy: 0,
  light: 0,
  marcher: 0,
  heavy: 0,
});
const defaultActiveUnits = (): SupportUnit[] => [...SUPPORT_UNITS];
const hasPositiveLimit = (limits: Partial<Record<SupportUnit, number | undefined>>): boolean =>
  Object.values(limits).some((quantity) => quantity !== undefined && quantity > 0);

export const supportArrivalWindowSchema = z
  .object({ startAt: isoTimestampSchema, endAt: isoTimestampSchema })
  .strict()
  .refine((window) => Date.parse(window.startAt) <= Date.parse(window.endAt), {
    path: ['endAt'],
    message: 'Arrival window start must not be after its end',
  });

export const supportDefenseGoalSchema = z
  .discriminatedUnion('mode', [
    z
      .object({
        mode: z.literal('population'),
        populationLimit: z.number().int().positive().max(1_000_000_000),
        compositionPreset: z.enum(['heavy', 'balanced', 'anti-cavalry', 'equal', 'custom']).default('heavy'),
        activeUnits: z
          .array(supportUnitSchema.exclude(['spy']))
          .min(1)
          .max(SUPPORT_UNITS.length - 1)
          .refine((units) => new Set(units).size === units.length, 'Defense population units must be unique')
          .default(['spear', 'sword', 'archer', 'light', 'marcher', 'heavy']),
        customWeights: supportUnitWeightsSchema.default({}),
      })
      .strict(),
    z.object({ mode: z.literal('unit'), unitLimits: supportUnitLimitsSchema }).strict(),
  ])
  .superRefine((goal, context) => {
    if (goal.mode === 'unit') {
      if (!hasPositiveLimit(goal.unitLimits)) {
        context.addIssue({
          code: 'custom',
          path: ['unitLimits'],
          message: 'A unit goal must request at least one unit',
        });
      }
      return;
    }
    if (goal.compositionPreset !== 'custom') return;
    const hasWeight = goal.activeUnits.some((unit) => (goal.customWeights[unit] ?? 0) > 0);
    if (!hasWeight) {
      context.addIssue({
        code: 'custom',
        path: ['customWeights'],
        message: 'Custom defense composition requires a positive weight for an active unit',
      });
    }
  });

const commonSettingsShape = {
  sourceGroupId: z.union([z.literal('0'), z.string()]).default('0'),
  allocationStrategy: z.enum(['proportional', 'max_available']).default('proportional'),
  distancePriority: z.enum(['closest', 'farthest']).default('closest'),
  villageLimit: z.number().int().nonnegative().max(500).default(0),
  reserveByUnit: supportUnitAmountsSchema.default(zeroUnitAmounts),
};

const validateAllocationSettings = (
  settings: { allocationStrategy: 'proportional' | 'max_available'; villageLimit: number },
  context: z.RefinementCtx,
) => {
  if (settings.allocationStrategy !== 'max_available' && settings.villageLimit > 0) {
    context.addIssue({
      code: 'custom',
      path: ['villageLimit'],
      message: 'A positive village limit is valid only with max_available',
    });
  }
};

export const supportAllocationDestinationSchema = z
  .object({
    coordinate: coordinateSchema,
    afflictionPercent: z.number().min(0).max(100).default(0),
    arrivalWindow: supportArrivalWindowSchema.optional(),
    troopMode: z.enum(['all', 'population', 'unit']).default('all'),
    populationLimit: z.number().int().positive().max(1_000_000_000).default(5000),
    unitLimits: supportUnitLimitsSchema.default({}),
    activeUnits: z
      .array(supportUnitSchema)
      .min(1)
      .max(SUPPORT_UNITS.length)
      .refine((units) => new Set(units).size === units.length, 'Active units must be unique')
      .default(defaultActiveUnits),
  })
  .strict()
  .superRefine((destination, context) => {
    if (destination.troopMode === 'unit' && !hasPositiveLimit(destination.unitLimits)) {
      context.addIssue({
        code: 'custom',
        path: ['unitLimits'],
        message: 'Unit troop mode requires at least one positive unit limit',
      });
    }
  });

export const supportAllocationSettingsSchema = z
  .object({
    mode: z.literal('immediate'),
    ...commonSettingsShape,
    destinations: z.array(supportAllocationDestinationSchema).min(1).max(500),
  })
  .strict()
  .superRefine((settings, context) => {
    validateAllocationSettings(settings, context);
    const coordinates = settings.destinations.map((destination) => destination.coordinate);
    if (new Set(coordinates).size !== coordinates.length) {
      context.addIssue({
        code: 'custom',
        path: ['destinations'],
        message: 'Immediate destination coordinates must be unique',
      });
    }
  });

export const supportDefenseTargetSchema = z
  .object({ coordinate: coordinateSchema, goal: supportDefenseGoalSchema.optional() })
  .strict();

export const supportDefenseSettingsSchema = z
  .object({
    mode: z.literal('defense-goal'),
    ...commonSettingsShape,
    targets: z.array(supportDefenseTargetSchema).min(1).max(500),
    goal: supportDefenseGoalSchema,
    includeIncomingSupport: z.boolean().default(true),
    afflictionPercent: z.number().min(0).max(50).default(0),
    arrivalWindow: supportArrivalWindowSchema.optional(),
    executionMode: z.enum(['immediate', 'scheduled']).default('immediate'),
    scheduledArrivalAt: isoTimestampSchema.optional(),
  })
  .strict()
  .superRefine((settings, context) => {
    validateAllocationSettings(settings, context);
    if (settings.executionMode === 'scheduled' && settings.scheduledArrivalAt === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['scheduledArrivalAt'],
        message: 'Scheduled defense execution requires an exact arrival time',
      });
    }
    if (settings.executionMode === 'immediate' && settings.scheduledArrivalAt !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['scheduledArrivalAt'],
        message: 'Immediate defense execution cannot carry a scheduled arrival time',
      });
    }
    if (settings.executionMode === 'scheduled' && settings.arrivalWindow !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['arrivalWindow'],
        message: 'Scheduled defense execution uses an exact arrival time, not a window',
      });
    }
    const coordinates = settings.targets.map((target) => target.coordinate);
    if (new Set(coordinates).size !== coordinates.length) {
      context.addIssue({ code: 'custom', path: ['targets'], message: 'Defense target coordinates must be unique' });
    }
  });

export const supportPlannerSnapshotSchema = z
  .object({
    accountId: z.string(),
    worldId: z.string(),
    worldSpeed: z.number().positive().finite(),
    unitSpeed: z.number().positive().finite(),
    hasArchers: z.boolean(),
    sourceVillages: z
      .array(
        z
          .object({
            villageId: z.string(),
            coordinate: coordinateSchema,
            groupIds: z.array(z.string()).max(500),
            troops: supportUnitAmountsSchema,
          })
          .strict(),
      )
      .max(500),
    groups: z
      .array(
        z
          .object({
            id: z.string(),
            villageIds: z.array(z.string()).max(500),
          })
          .strict(),
      )
      .max(500),
    pendingCommands: z
      .array(
        z
          .object({
            sourceVillageId: z.string(),
            units: supportUnitAmountsSchema,
          })
          .strict(),
      )
      .max(10_000),
    targetVillages: z
      .array(
        z
          .object({
            coordinate: coordinateSchema,
            currentSupport: supportUnitAmountsSchema.optional(),
            incomingSupport: supportUnitAmountsSchema.optional(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export type SupportUnitAmounts = z.infer<typeof supportUnitAmountsSchema>;
export type SupportUnitLimits = z.infer<typeof supportUnitLimitsSchema>;
export type SupportUnitWeights = z.infer<typeof supportUnitWeightsSchema>;
export type SupportArrivalWindow = z.infer<typeof supportArrivalWindowSchema>;
export type SupportDefenseGoal = z.infer<typeof supportDefenseGoalSchema>;
export type SupportAllocationDestination = z.infer<typeof supportAllocationDestinationSchema>;
export type SupportAllocationSettings = z.infer<typeof supportAllocationSettingsSchema>;
export type SupportDefenseTarget = z.infer<typeof supportDefenseTargetSchema>;
export type SupportDefenseSettings = z.infer<typeof supportDefenseSettingsSchema>;
export type SupportPlannerSnapshot = z.infer<typeof supportPlannerSnapshotSchema>;
export type SupportPlannerSourceVillage = SupportPlannerSnapshot['sourceVillages'][number];

export interface SupportAllocationSummary {
  destinations: number;
  commands: number;
  population: number;
  troops: SupportUnitAmounts;
}

export interface SupportDestinationResult {
  coordinate: string;
  state: 'ready' | 'partial' | 'complete' | 'unavailable' | 'invalid';
  exclusionReasons: string[];
  commandIds: string[];
  troops: SupportUnitAmounts;
  population: number;
}

export interface PlannedSupportCommand {
  id: string;
  accountId: string;
  worldId: string;
  sourceVillageId: string;
  sourceCoordinate: string;
  targetCoordinate: string;
  units: SupportUnitAmounts;
  distance: number;
  durationSeconds: number;
  arrivalAt: string;
  population: number;
}

const emptyUnits = (): SupportUnitAmounts => ({
  spear: 0,
  sword: 0,
  archer: 0,
  spy: 0,
  light: 0,
  marcher: 0,
  heavy: 0,
});

const copyUnits = (units: SupportUnitAmounts): SupportUnitAmounts => ({ ...units });

const parseCoordinate = (coordinate: string): readonly [number, number] => {
  const [x, y] = coordinate.split('|').map(Number);
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError(`Invalid coordinate: ${coordinate}`);
  }
  return [x, y];
};

export const supportPlannerDistance = (origin: string, destination: string): number => {
  const [originX, originY] = parseCoordinate(origin);
  const [destinationX, destinationY] = parseCoordinate(destination);
  return Math.sqrt((originX - destinationX) ** 2 + (originY - destinationY) ** 2);
};

export const supportPlannerPopulation = (units: SupportUnitAmounts): number =>
  SUPPORT_UNITS.reduce((total, unit) => total + units[unit] * POPULATION[unit], 0);

const slowestUnit = (units: SupportUnitAmounts): SupportUnit | undefined => {
  let result: SupportUnit | undefined;
  for (const unit of SUPPORT_UNITS) {
    if (units[unit] <= 0) continue;
    if (result === undefined || MINUTES_PER_FIELD[unit] > MINUTES_PER_FIELD[result]) result = unit;
  }
  return result;
};

export const supportPlannerDurationSeconds = (input: {
  distance: number;
  units: SupportUnitAmounts;
  worldSpeed: number;
  unitSpeed: number;
  afflictionPercent: number;
}): number => {
  const unit = slowestUnit(input.units);
  if (unit === undefined || input.distance <= 0) return 0;
  const rawSeconds = Math.round((60 * input.distance * MINUTES_PER_FIELD[unit]) / (input.worldSpeed * input.unitSpeed));
  const afflictedSeconds =
    input.afflictionPercent > 0 ? Math.round(rawSeconds / (1 + input.afflictionPercent / 100)) : rawSeconds;
  return Math.max(1, afflictedSeconds);
};

interface Candidate {
  source: SupportPlannerSourceVillage;
  remaining: SupportUnitAmounts;
  distance: number;
}

interface Allocation {
  source: SupportPlannerSourceVillage;
  units: SupportUnitAmounts;
}

interface PlannedWithDestinationIndex {
  destinationIndex: number;
  command: PlannedSupportCommand;
}

const hasAnyUnits = (units: SupportUnitAmounts): boolean => SUPPORT_UNITS.some((unit) => units[unit] > 0);

const allowedUnits = (
  snapshot: SupportPlannerSnapshot,
  destination: SupportAllocationDestination,
): ReadonlySet<SupportUnit> =>
  new Set(destination.activeUnits.filter((unit) => snapshot.hasArchers || (unit !== 'archer' && unit !== 'marcher')));

const unitArrivalFits = (
  sourceCoordinate: string,
  destination: SupportAllocationDestination,
  unit: SupportUnit,
  snapshot: SupportPlannerSnapshot,
  planningAtMs: number,
): boolean => {
  if (destination.arrivalWindow === undefined) return true;
  const oneUnit = emptyUnits();
  oneUnit[unit] = 1;
  const durationSeconds = supportPlannerDurationSeconds({
    distance: supportPlannerDistance(sourceCoordinate, destination.coordinate),
    units: oneUnit,
    worldSpeed: snapshot.worldSpeed,
    unitSpeed: snapshot.unitSpeed,
    afflictionPercent: destination.afflictionPercent,
  });
  if (durationSeconds === 0) return false;
  const arrivalAt = planningAtMs + durationSeconds * 1000;
  return (
    arrivalAt >= Date.parse(destination.arrivalWindow.startAt) &&
    arrivalAt <= Date.parse(destination.arrivalWindow.endAt)
  );
};

const fitArrivalWindow = (
  sourceCoordinate: string,
  destination: SupportAllocationDestination,
  proposed: SupportUnitAmounts,
  snapshot: SupportPlannerSnapshot,
  planningAtMs: number,
): SupportUnitAmounts => {
  if (destination.arrivalWindow === undefined) return proposed;
  const fitted = copyUnits(proposed);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slowest = slowestUnit(fitted);
    if (slowest === undefined) return emptyUnits();
    const durationSeconds = supportPlannerDurationSeconds({
      distance: supportPlannerDistance(sourceCoordinate, destination.coordinate),
      units: fitted,
      worldSpeed: snapshot.worldSpeed,
      unitSpeed: snapshot.unitSpeed,
      afflictionPercent: destination.afflictionPercent,
    });
    const arrivalAt = planningAtMs + durationSeconds * 1000;
    if (
      arrivalAt >= Date.parse(destination.arrivalWindow.startAt) &&
      arrivalAt <= Date.parse(destination.arrivalWindow.endAt)
    )
      return fitted;
    fitted[slowest] = 0;
  }
  return emptyUnits();
};

const toAllocation = (
  candidate: Candidate,
  proposed: SupportUnitAmounts,
  destination: SupportAllocationDestination,
  snapshot: SupportPlannerSnapshot,
  planningAtMs: number,
): Allocation | undefined => {
  const fitted = fitArrivalWindow(candidate.source.coordinate, destination, proposed, snapshot, planningAtMs);
  return hasAnyUnits(fitted) ? { source: candidate.source, units: fitted } : undefined;
};

const allocatePopulation = (
  candidates: readonly Candidate[],
  destination: SupportAllocationDestination,
  settings: SupportAllocationSettings,
  snapshot: SupportPlannerSnapshot,
  planningAtMs: number,
  activeUnits: ReadonlySet<SupportUnit>,
): Allocation[] => {
  if (settings.allocationStrategy === 'max_available') {
    const selected = settings.villageLimit > 0 ? candidates.slice(0, settings.villageLimit) : candidates;
    const allocations: Allocation[] = [];
    let budget = destination.populationLimit;
    for (const candidate of selected) {
      if (budget <= 0) break;
      const proposed = emptyUnits();
      for (const unit of SUPPORT_UNITS) {
        if (budget <= 0) break;
        if (
          !activeUnits.has(unit) ||
          !unitArrivalFits(candidate.source.coordinate, destination, unit, snapshot, planningAtMs)
        )
          continue;
        const weight = POPULATION[unit];
        if (weight <= 0) continue;
        const available = candidate.remaining[unit];
        const amount = Math.min(available, Math.floor(budget / weight));
        if (amount <= 0) continue;
        proposed[unit] = amount;
        budget -= amount * weight;
      }
      const allocation = toAllocation(candidate, proposed, destination, snapshot, planningAtMs);
      if (allocation !== undefined) allocations.push(allocation);
    }
    return allocations;
  }

  let availablePopulation = 0;
  for (const candidate of candidates) {
    for (const unit of SUPPORT_UNITS) {
      if (
        activeUnits.has(unit) &&
        unitArrivalFits(candidate.source.coordinate, destination, unit, snapshot, planningAtMs)
      ) {
        availablePopulation += candidate.remaining[unit] * POPULATION[unit];
      }
    }
  }
  const ratio = availablePopulation > 0 ? Math.min(1, destination.populationLimit / availablePopulation) : 0;
  const provisional: Array<{ candidate: Candidate; units: SupportUnitAmounts; population: number }> = [];
  let allocatedPopulation = 0;
  for (const candidate of candidates) {
    const proposed = emptyUnits();
    let villagePopulation = 0;
    for (const unit of SUPPORT_UNITS) {
      if (
        !activeUnits.has(unit) ||
        !unitArrivalFits(candidate.source.coordinate, destination, unit, snapshot, planningAtMs)
      )
        continue;
      const available = candidate.remaining[unit];
      const initial = Math.floor(available * ratio);
      if (initial <= 0) continue;
      const weight = POPULATION[unit];
      const remainingBudget = destination.populationLimit - allocatedPopulation - villagePopulation;
      const budgetAmount = weight > 0 ? Math.floor(remainingBudget / weight) : initial;
      const amount = Math.min(initial, budgetAmount);
      if (amount <= 0) continue;
      proposed[unit] = amount;
      villagePopulation += amount * weight;
    }
    if (hasAnyUnits(proposed)) {
      provisional.push({ candidate, units: proposed, population: villagePopulation });
      allocatedPopulation += villagePopulation;
    }
    if (allocatedPopulation >= destination.populationLimit) break;
  }

  if (allocatedPopulation < destination.populationLimit) {
    let remainingBudget = destination.populationLimit - allocatedPopulation;
    for (const candidate of candidates) {
      if (remainingBudget <= 0) break;
      let entry = provisional.find((item) => item.candidate.source.villageId === candidate.source.villageId);
      for (const unit of SUPPORT_UNITS) {
        if (remainingBudget <= 0) break;
        if (
          !activeUnits.has(unit) ||
          !unitArrivalFits(candidate.source.coordinate, destination, unit, snapshot, planningAtMs)
        )
          continue;
        const weight = POPULATION[unit];
        if (weight <= 0) continue;
        const alreadyAllocated = entry?.units[unit] ?? 0;
        const available = candidate.remaining[unit] - alreadyAllocated;
        const amount = Math.min(available, Math.floor(remainingBudget / weight));
        if (amount <= 0) continue;
        if (entry === undefined) {
          entry = { candidate, units: emptyUnits(), population: 0 };
          provisional.push(entry);
        }
        entry.units[unit] += amount;
        entry.population += amount * weight;
        remainingBudget -= amount * weight;
      }
    }
  }

  return provisional.flatMap(({ candidate, units }) => {
    const allocation = toAllocation(candidate, units, destination, snapshot, planningAtMs);
    return allocation === undefined ? [] : [allocation];
  });
};

const allocateByUnit = (
  candidates: readonly Candidate[],
  destination: SupportAllocationDestination,
  settings: SupportAllocationSettings,
  snapshot: SupportPlannerSnapshot,
  planningAtMs: number,
  activeUnits: ReadonlySet<SupportUnit>,
): Allocation[] => {
  if (settings.allocationStrategy === 'max_available') {
    const selected = settings.villageLimit > 0 ? candidates.slice(0, settings.villageLimit) : candidates;
    const remainingLimits = new Map<SupportUnit, number>();
    for (const unit of SUPPORT_UNITS) {
      const limit = destination.unitLimits[unit];
      if (activeUnits.has(unit) && limit !== undefined && limit > 0) remainingLimits.set(unit, limit);
    }
    const allocations: Allocation[] = [];
    for (const candidate of selected) {
      if ([...remainingLimits.values()].every((remaining) => remaining <= 0)) break;
      const proposed = emptyUnits();
      for (const unit of SUPPORT_UNITS) {
        if (
          !activeUnits.has(unit) ||
          !unitArrivalFits(candidate.source.coordinate, destination, unit, snapshot, planningAtMs)
        )
          continue;
        const configuredLimit = destination.unitLimits[unit];
        if (configuredLimit === undefined) {
          proposed[unit] = candidate.remaining[unit];
        } else {
          const remainingLimit = remainingLimits.get(unit) ?? 0;
          if (remainingLimit <= 0) continue;
          const amount = Math.min(candidate.remaining[unit], remainingLimit);
          proposed[unit] = amount;
          remainingLimits.set(unit, remainingLimit - amount);
        }
      }
      const allocation = toAllocation(candidate, proposed, destination, snapshot, planningAtMs);
      if (allocation !== undefined) allocations.push(allocation);
    }
    return allocations;
  }

  const bySource = new Map<string, SupportUnitAmounts>();
  for (const unit of SUPPORT_UNITS) {
    if (!activeUnits.has(unit)) continue;
    const configuredLimit = destination.unitLimits[unit];
    const eligible = candidates.flatMap((candidate) => {
      if (!unitArrivalFits(candidate.source.coordinate, destination, unit, snapshot, planningAtMs)) return [];
      const available = candidate.remaining[unit];
      return available > 0 ? [{ candidate, available }] : [];
    });
    if (configuredLimit === undefined) {
      for (const { candidate, available } of eligible) {
        const allocated = bySource.get(candidate.source.villageId) ?? emptyUnits();
        allocated[unit] = available;
        bySource.set(candidate.source.villageId, allocated);
      }
      continue;
    }
    const totalAvailable = eligible.reduce((total, item) => total + item.available, 0);
    const ratio = totalAvailable > 0 ? Math.min(1, configuredLimit / totalAvailable) : 0;
    const portions = eligible.map(({ candidate, available }) => {
      const raw = available * ratio;
      return { candidate, available, amount: Math.floor(raw), remainder: raw - Math.floor(raw) };
    });
    let remainder =
      Math.min(configuredLimit, totalAvailable) - portions.reduce((total, item) => total + item.amount, 0);
    if (remainder > 0) {
      const ranked = [...portions].sort((left, right) => right.remainder - left.remainder);
      for (const portion of ranked) {
        if (remainder <= 0) break;
        if (portion.amount < portion.available) {
          portion.amount += 1;
          remainder -= 1;
        }
      }
    }
    for (const portion of portions) {
      if (portion.amount <= 0) continue;
      const allocated = bySource.get(portion.candidate.source.villageId) ?? emptyUnits();
      allocated[unit] = portion.amount;
      bySource.set(portion.candidate.source.villageId, allocated);
    }
  }
  return candidates.flatMap((candidate) => {
    const proposed = bySource.get(candidate.source.villageId);
    if (proposed === undefined) return [];
    const allocation = toAllocation(candidate, proposed, destination, snapshot, planningAtMs);
    return allocation === undefined ? [] : [allocation];
  });
};

const allocateAll = (
  candidates: readonly Candidate[],
  destination: SupportAllocationDestination,
  settings: SupportAllocationSettings,
  snapshot: SupportPlannerSnapshot,
  planningAtMs: number,
  activeUnits: ReadonlySet<SupportUnit>,
): Allocation[] => {
  const selected =
    settings.allocationStrategy === 'max_available' && settings.villageLimit > 0
      ? candidates.slice(0, settings.villageLimit)
      : candidates;
  const divisor =
    settings.allocationStrategy === 'proportional' && settings.destinations.length > 1
      ? settings.destinations.length
      : 1;
  return selected.flatMap((candidate) => {
    const proposed = emptyUnits();
    for (const unit of SUPPORT_UNITS) {
      if (
        !activeUnits.has(unit) ||
        !unitArrivalFits(candidate.source.coordinate, destination, unit, snapshot, planningAtMs)
      )
        continue;
      proposed[unit] = Math.floor(candidate.remaining[unit] / divisor);
    }
    const allocation = toAllocation(candidate, proposed, destination, snapshot, planningAtMs);
    return allocation === undefined ? [] : [allocation];
  });
};

/**
 * Identidade de chegada do modo imediato no hash do id: a chegada imediata é
 * uma ESTIMATIVA (`planningAt + duração`) que muda a cada ciclo — usá-la no
 * hash geraria um id novo para o MESMO comando lógico e o dedupe do
 * livro-razão de execução nunca bateria (dupla mutação entre ciclos).
 */
const IMMEDIATE_ARRIVAL_IDENTITY = 'immediate';

/**
 * ID canônico determinístico do comando lógico. `arrivalIdentity` substitui o
 * arrivalAt no hash: 'immediate' no modo imediato (chegada estimada, instável
 * por ciclo) ou a chegada agendada real no modo defesa agendado (parte da
 * identidade do comando — mesma força para alvos/horas diferentes são
 * comandos diferentes).
 */
const canonicalCommandId = (
  command: Omit<PlannedSupportCommand, 'id'>,
  arrivalIdentity: string,
): PlannedSupportCommand['id'] => {
  const canonical = [
    command.accountId,
    command.worldId,
    command.sourceVillageId,
    command.sourceCoordinate,
    command.targetCoordinate,
    ...SUPPORT_UNITS.map((unit) => `${unit}:${command.units[unit]}`),
    command.distance.toString(),
    command.durationSeconds.toString(),
    arrivalIdentity,
    command.population.toString(),
  ].join('|');
  return `command_${fnv1a64(canonical)}`;
};

const commandComparator = (left: PlannedSupportCommand, right: PlannedSupportCommand): number =>
  left.targetCoordinate.localeCompare(right.targetCoordinate) ||
  left.durationSeconds - right.durationSeconds ||
  left.sourceCoordinate.localeCompare(right.sourceCoordinate) ||
  left.id.localeCompare(right.id);

const destinationState = (
  destination: SupportAllocationDestination,
  troops: SupportUnitAmounts,
  population: number,
  commandCount: number,
): SupportDestinationResult['state'] => {
  if (commandCount === 0) return 'unavailable';
  if (destination.troopMode === 'population') return population >= destination.populationLimit ? 'ready' : 'partial';
  if (destination.troopMode === 'unit') {
    const complete = SUPPORT_UNITS.every((unit) => {
      const limit = destination.unitLimits[unit];
      return limit === undefined || limit <= 0 || troops[unit] >= limit;
    });
    return complete ? 'ready' : 'partial';
  }
  return 'ready';
};

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

export interface SupportAllocationPlanInput {
  snapshot: SupportPlannerSnapshot;
  settings: SupportAllocationSettings;
  planningAt: string;
}

export interface SupportAllocationPlan {
  summary: SupportAllocationSummary;
  results: SupportDestinationResult[];
  commands: PlannedSupportCommand[];
}

export const planSupportAllocation = (input: SupportAllocationPlanInput): SupportAllocationPlan => {
  const snapshot = supportPlannerSnapshotSchema.parse(input.snapshot);
  const settings = supportAllocationSettingsSchema.parse(input.settings);
  const planningAtMs = Date.parse(input.planningAt);
  if (!Number.isFinite(planningAtMs)) throw new TypeError('planningAt must be an ISO timestamp');

  const pendingBySource = new Map<string, SupportUnitAmounts>();
  for (const pending of snapshot.pendingCommands) {
    const total = pendingBySource.get(pending.sourceVillageId) ?? emptyUnits();
    for (const unit of SUPPORT_UNITS) total[unit] += pending.units[unit];
    pendingBySource.set(pending.sourceVillageId, total);
  }
  const remainingBySource = new Map<string, SupportUnitAmounts>();
  for (const village of snapshot.sourceVillages) {
    const pending = pendingBySource.get(village.villageId) ?? emptyUnits();
    const remaining = emptyUnits();
    for (const unit of SUPPORT_UNITS) {
      remaining[unit] = Math.max(0, village.troops[unit] - settings.reserveByUnit[unit] - pending[unit]);
    }
    remainingBySource.set(village.villageId, remaining);
  }

  const planned: PlannedWithDestinationIndex[] = [];
  const configuredGroupVillageIds =
    settings.sourceGroupId === '0'
      ? undefined
      : new Set(snapshot.groups.find((group) => group.id === settings.sourceGroupId)?.villageIds ?? []);
  for (const [destinationIndex, destination] of settings.destinations.entries()) {
    const activeUnits = allowedUnits(snapshot, destination);
    let candidates: Candidate[] = snapshot.sourceVillages.flatMap((sourceVillage) => {
      if (sourceVillage.coordinate === destination.coordinate) return [];
      if (
        settings.sourceGroupId !== '0' &&
        !sourceVillage.groupIds.includes(settings.sourceGroupId) &&
        !configuredGroupVillageIds?.has(sourceVillage.villageId)
      )
        return [];
      const remaining = remainingBySource.get(sourceVillage.villageId);
      if (remaining === undefined || !SUPPORT_UNITS.some((unit) => activeUnits.has(unit) && remaining[unit] > 0))
        return [];
      return [
        {
          source: sourceVillage,
          remaining,
          distance: supportPlannerDistance(sourceVillage.coordinate, destination.coordinate),
        },
      ];
    });
    if (settings.allocationStrategy === 'max_available') {
      candidates = [...candidates].sort((left, right) =>
        settings.distancePriority === 'closest' ? left.distance - right.distance : right.distance - left.distance,
      );
    }

    const allocations =
      destination.troopMode === 'population'
        ? allocatePopulation(candidates, destination, settings, snapshot, planningAtMs, activeUnits)
        : destination.troopMode === 'unit'
          ? allocateByUnit(candidates, destination, settings, snapshot, planningAtMs, activeUnits)
          : allocateAll(candidates, destination, settings, snapshot, planningAtMs, activeUnits);

    for (const allocation of allocations) {
      const remaining = remainingBySource.get(allocation.source.villageId);
      if (remaining === undefined) continue;
      for (const unit of SUPPORT_UNITS) remaining[unit] -= allocation.units[unit];
      const distance = supportPlannerDistance(allocation.source.coordinate, destination.coordinate);
      const durationSeconds = supportPlannerDurationSeconds({
        distance,
        units: allocation.units,
        worldSpeed: snapshot.worldSpeed,
        unitSpeed: snapshot.unitSpeed,
        afflictionPercent: destination.afflictionPercent,
      });
      const commandWithoutId: Omit<PlannedSupportCommand, 'id'> = {
        accountId: snapshot.accountId,
        worldId: snapshot.worldId,
        sourceVillageId: allocation.source.villageId,
        sourceCoordinate: allocation.source.coordinate,
        targetCoordinate: destination.coordinate,
        units: copyUnits(allocation.units),
        distance,
        durationSeconds,
        arrivalAt: new Date(planningAtMs + durationSeconds * 1000).toISOString(),
        population: supportPlannerPopulation(allocation.units),
      };
      planned.push({
        destinationIndex,
        command: { id: canonicalCommandId(commandWithoutId, IMMEDIATE_ARRIVAL_IDENTITY), ...commandWithoutId },
      });
    }
  }

  planned.sort((left, right) => commandComparator(left.command, right.command));
  const commands = planned.map(({ command }) => command);
  const results = settings.destinations.map((destination, destinationIndex): SupportDestinationResult => {
    const destinationCommands = planned
      .filter((entry) => entry.destinationIndex === destinationIndex)
      .map((entry) => entry.command);
    const troops = emptyUnits();
    for (const command of destinationCommands) {
      for (const unit of SUPPORT_UNITS) troops[unit] += command.units[unit];
    }
    const population = destinationCommands.reduce((total, command) => total + command.population, 0);
    const state = destinationState(destination, troops, population, destinationCommands.length);
    return {
      coordinate: destination.coordinate,
      state,
      exclusionReasons:
        state === 'ready'
          ? []
          : state === 'partial'
            ? ['O estoque disponível não atende integralmente o limite solicitado']
            : ['Nenhuma origem elegível com tropas disponíveis'],
      commandIds: destinationCommands.map((command) => command.id),
      troops,
      population,
    };
  });
  const troops = emptyUnits();
  for (const command of commands) {
    for (const unit of SUPPORT_UNITS) troops[unit] += command.units[unit];
  }
  return deepFreeze({
    summary: {
      destinations: results.length,
      commands: commands.length,
      population: commands.reduce((total, command) => total + command.population, 0),
      troops,
    },
    results,
    commands,
  });
};

const DEFENSE_PRESET_WEIGHTS: Readonly<
  Record<'heavy' | 'balanced' | 'anti-cavalry', Readonly<Partial<Record<SupportUnit, number>>>>
> = Object.freeze({
  heavy: Object.freeze({ heavy: 0.6, sword: 0.25, spear: 0.15 }),
  balanced: Object.freeze({ sword: 0.4, spear: 0.3, heavy: 0.2, archer: 0.1 }),
  'anti-cavalry': Object.freeze({ spear: 0.7, sword: 0.2, heavy: 0.1 }),
});

export interface SupportDefenseTargetAnalysis {
  coordinate: string;
  state: 'needs-support' | 'complete' | 'unavailable' | 'invalid';
  currentPopulation: number;
  targetPopulation: number;
  needed: SupportUnitAmounts;
  currentSupport: SupportUnitAmounts;
  completionPercent: number;
  isComplete: boolean;
}

export interface SupportDefenseAnalysis {
  targets: SupportDefenseTargetAnalysis[];
  totalNeededPopulation: number;
  totalNeeded: SupportUnitAmounts;
}

const defenseWeights = (
  goal: Extract<SupportDefenseGoal, { mode: 'population' }>,
): Partial<Record<SupportUnit, number>> => {
  if (
    goal.compositionPreset === 'heavy' ||
    goal.compositionPreset === 'balanced' ||
    goal.compositionPreset === 'anti-cavalry'
  )
    return { ...DEFENSE_PRESET_WEIGHTS[goal.compositionPreset] };
  if (goal.compositionPreset === 'custom')
    return Object.fromEntries(
      SUPPORT_UNITS.flatMap((unit) => {
        const weight = goal.customWeights[unit];
        return weight === undefined ? [] : [[unit, weight]];
      }),
    );
  const equalWeight = 1 / goal.activeUnits.length;
  return Object.fromEntries(goal.activeUnits.map((unit) => [unit, equalWeight]));
};

const populationDefenseDeficit = (
  goal: Extract<SupportDefenseGoal, { mode: 'population' }>,
  currentSupport: SupportUnitAmounts,
): SupportUnitAmounts => {
  const missingPopulation = goal.populationLimit - supportPlannerPopulation(currentSupport);
  const needed = emptyUnits();
  if (missingPopulation <= 0) return needed;
  const weights = defenseWeights(goal);
  const orderedWeights = Object.entries(weights)
    .filter((entry): entry is [SupportUnit, number] => entry[1] !== undefined && entry[1] > 0)
    .sort((left, right) => right[1] - left[1]);
  const totalWeight = orderedWeights.reduce((total, [, weight]) => total + weight, 0);
  if (totalWeight <= 0) return needed;
  let allocatedPopulation = 0;
  for (const [unit, weight] of orderedWeights) {
    const population = POPULATION[unit];
    if (population <= 0) continue;
    const amount = Math.floor(((weight / totalWeight) * missingPopulation) / population);
    if (amount <= 0) continue;
    needed[unit] = amount;
    allocatedPopulation += amount * population;
  }
  let remainder = missingPopulation - allocatedPopulation;
  for (const [unit] of orderedWeights) {
    const population = POPULATION[unit];
    if (population <= 0) continue;
    const amount = Math.floor(remainder / population);
    if (amount > 0) {
      needed[unit] += amount;
      remainder -= amount * population;
    }
    if (remainder <= 0) break;
  }
  return needed;
};

const unitDefenseDeficit = (
  goal: Extract<SupportDefenseGoal, { mode: 'unit' }>,
  currentSupport: SupportUnitAmounts,
): SupportUnitAmounts => {
  const needed = emptyUnits();
  for (const unit of SUPPORT_UNITS) {
    needed[unit] = Math.max(0, (goal.unitLimits[unit] ?? 0) - currentSupport[unit]);
  }
  return needed;
};

const defenseTargetPopulation = (goal: SupportDefenseGoal): number =>
  goal.mode === 'population'
    ? goal.populationLimit
    : SUPPORT_UNITS.reduce((total, unit) => total + (goal.unitLimits[unit] ?? 0) * POPULATION[unit], 0);

export const analyzeSupportDefenseTargets = (input: {
  snapshot: SupportPlannerSnapshot;
  settings: SupportDefenseSettings;
}): SupportDefenseAnalysis => {
  const snapshot = supportPlannerSnapshotSchema.parse(input.snapshot);
  const settings = supportDefenseSettingsSchema.parse(input.settings);
  const targetByCoordinate = new Map(snapshot.targetVillages.map((target) => [target.coordinate, target]));
  const targets = settings.targets.map((configuredTarget): SupportDefenseTargetAnalysis => {
    const targetVillage = targetByCoordinate.get(configuredTarget.coordinate);
    if (targetVillage === undefined) {
      return {
        coordinate: configuredTarget.coordinate,
        state: 'invalid',
        currentPopulation: 0,
        targetPopulation: 0,
        needed: emptyUnits(),
        currentSupport: emptyUnits(),
        completionPercent: 0,
        isComplete: false,
      };
    }
    if (targetVillage.currentSupport === undefined) {
      return {
        coordinate: configuredTarget.coordinate,
        state: 'unavailable',
        currentPopulation: 0,
        targetPopulation: 0,
        needed: emptyUnits(),
        currentSupport: emptyUnits(),
        completionPercent: 0,
        isComplete: false,
      };
    }
    const currentSupport = copyUnits(targetVillage.currentSupport);
    if (settings.includeIncomingSupport && targetVillage.incomingSupport !== undefined) {
      for (const unit of SUPPORT_UNITS) currentSupport[unit] += targetVillage.incomingSupport[unit];
    }
    const goal = configuredTarget.goal ?? settings.goal;
    const currentPopulation = supportPlannerPopulation(currentSupport);
    const targetPopulation = defenseTargetPopulation(goal);
    const needed =
      goal.mode === 'population'
        ? populationDefenseDeficit(goal, currentSupport)
        : unitDefenseDeficit(goal, currentSupport);
    const isComplete = SUPPORT_UNITS.every((unit) => needed[unit] <= 0);
    return {
      coordinate: configuredTarget.coordinate,
      state: isComplete ? 'complete' : 'needs-support',
      currentPopulation,
      targetPopulation,
      needed,
      currentSupport,
      completionPercent: targetPopulation > 0 ? Math.round((currentPopulation / targetPopulation) * 100) : 100,
      isComplete,
    };
  });
  const totalNeeded = emptyUnits();
  for (const target of targets) {
    for (const unit of SUPPORT_UNITS) totalNeeded[unit] += target.needed[unit];
  }
  return deepFreeze({
    targets,
    totalNeededPopulation: supportPlannerPopulation(totalNeeded),
    totalNeeded,
  });
};

interface DefenseCandidate extends Candidate {
  travelSeconds: number;
}

const availableStock = (
  snapshot: SupportPlannerSnapshot,
  settings: Pick<SupportDefenseSettings, 'reserveByUnit'>,
): Map<string, SupportUnitAmounts> => {
  const pendingBySource = new Map<string, SupportUnitAmounts>();
  for (const pending of snapshot.pendingCommands) {
    const total = pendingBySource.get(pending.sourceVillageId) ?? emptyUnits();
    for (const unit of SUPPORT_UNITS) total[unit] += pending.units[unit];
    pendingBySource.set(pending.sourceVillageId, total);
  }
  return new Map(
    snapshot.sourceVillages.map((village) => {
      const pending = pendingBySource.get(village.villageId) ?? emptyUnits();
      const remaining = emptyUnits();
      for (const unit of SUPPORT_UNITS) {
        remaining[unit] = Math.max(0, village.troops[unit] - settings.reserveByUnit[unit] - pending[unit]);
      }
      return [village.villageId, remaining];
    }),
  );
};

const defenseImmediateDestination = (
  target: SupportDefenseTargetAnalysis,
  settings: SupportDefenseSettings,
): SupportAllocationDestination => ({
  coordinate: target.coordinate,
  afflictionPercent: settings.afflictionPercent,
  ...(settings.arrivalWindow === undefined ? {} : { arrivalWindow: settings.arrivalWindow }),
  troopMode: 'unit',
  populationLimit: 5000,
  unitLimits: Object.fromEntries(
    SUPPORT_UNITS.flatMap((unit) => (target.needed[unit] > 0 ? [[unit, target.needed[unit]]] : [])),
  ),
  activeUnits: SUPPORT_UNITS.filter((unit) => target.needed[unit] > 0),
});

const allocateDefenseMaximum = (
  candidates: readonly DefenseCandidate[],
  target: SupportDefenseTargetAnalysis,
  destination: SupportAllocationDestination,
  settings: SupportDefenseSettings,
  snapshot: SupportPlannerSnapshot,
  planningAtMs: number,
): Allocation[] => {
  let ordered = [...candidates].sort((left, right) =>
    settings.distancePriority === 'closest'
      ? left.travelSeconds - right.travelSeconds
      : right.travelSeconds - left.travelSeconds,
  );
  if (settings.villageLimit > 0 && settings.villageLimit < ordered.length) {
    ordered = [...ordered]
      .map((candidate) => ({
        candidate,
        score: SUPPORT_UNITS.reduce(
          (score, unit) => score + Math.min(candidate.remaining[unit], target.needed[unit]),
          0,
        ),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, settings.villageLimit)
      .map(({ candidate }) => candidate)
      .sort((left, right) =>
        settings.distancePriority === 'closest'
          ? left.travelSeconds - right.travelSeconds
          : right.travelSeconds - left.travelSeconds,
      );
  }
  const remainingNeed = copyUnits(target.needed);
  const allocations: Allocation[] = [];
  for (const candidate of ordered) {
    if (SUPPORT_UNITS.every((unit) => remainingNeed[unit] <= 0)) break;
    const proposed = emptyUnits();
    for (const unit of SUPPORT_UNITS) {
      if (remainingNeed[unit] <= 0) continue;
      if (
        settings.executionMode === 'immediate' &&
        !unitArrivalFits(candidate.source.coordinate, destination, unit, snapshot, planningAtMs)
      )
        continue;
      const amount = Math.min(candidate.remaining[unit], remainingNeed[unit]);
      if (amount <= 0) continue;
      proposed[unit] = amount;
      remainingNeed[unit] -= amount;
    }
    const allocation = toAllocation(candidate, proposed, destination, snapshot, planningAtMs);
    if (allocation !== undefined) allocations.push(allocation);
  }
  return allocations;
};

export interface SupportDefensePlanInput {
  snapshot: SupportPlannerSnapshot;
  settings: SupportDefenseSettings;
  planningAt: string;
}

export const planSupportDefenseGoals = (input: SupportDefensePlanInput): SupportAllocationPlan => {
  const snapshot = supportPlannerSnapshotSchema.parse(input.snapshot);
  const settings = supportDefenseSettingsSchema.parse(input.settings);
  const planningAtMs = Date.parse(input.planningAt);
  if (!Number.isFinite(planningAtMs)) throw new TypeError('planningAt must be an ISO timestamp');
  const scheduledArrivalMs =
    settings.executionMode === 'scheduled' ? Date.parse(settings.scheduledArrivalAt ?? '') : undefined;
  if (settings.executionMode === 'scheduled' && !Number.isFinite(scheduledArrivalMs)) {
    throw new TypeError('scheduledArrivalAt must be an ISO timestamp');
  }

  const analysis = analyzeSupportDefenseTargets({ snapshot, settings });
  const analysisByCoordinate = new Map(analysis.targets.map((target) => [target.coordinate, target]));
  const remainingBySource = availableStock(snapshot, settings);
  const configuredGroupVillageIds =
    settings.sourceGroupId === '0'
      ? undefined
      : new Set(snapshot.groups.find((group) => group.id === settings.sourceGroupId)?.villageIds ?? []);
  const planned: PlannedWithDestinationIndex[] = [];
  const prioritizedTargets = analysis.targets
    .map((target, destinationIndex) => ({ target, destinationIndex }))
    .filter(({ target }) => target.state === 'needs-support')
    .sort(
      (left, right) =>
        left.target.completionPercent - right.target.completionPercent ||
        left.target.coordinate.localeCompare(right.target.coordinate),
    );

  for (const { target, destinationIndex } of prioritizedTargets) {
    const destination = defenseImmediateDestination(target, settings);
    const activeUnits = allowedUnits(snapshot, destination);
    const candidates: DefenseCandidate[] = snapshot.sourceVillages
      .flatMap((sourceVillage) => {
        if (sourceVillage.coordinate === target.coordinate) return [];
        if (
          settings.sourceGroupId !== '0' &&
          !sourceVillage.groupIds.includes(settings.sourceGroupId) &&
          !configuredGroupVillageIds?.has(sourceVillage.villageId)
        )
          return [];
        const remaining = remainingBySource.get(sourceVillage.villageId);
        if (remaining === undefined || !SUPPORT_UNITS.some((unit) => activeUnits.has(unit) && remaining[unit] > 0))
          return [];
        const candidateUnits = emptyUnits();
        for (const unit of SUPPORT_UNITS) {
          if (activeUnits.has(unit)) candidateUnits[unit] = remaining[unit];
        }
        const distance = supportPlannerDistance(sourceVillage.coordinate, target.coordinate);
        const travelSeconds = supportPlannerDurationSeconds({
          distance,
          units: candidateUnits,
          worldSpeed: snapshot.worldSpeed,
          unitSpeed: snapshot.unitSpeed,
          afflictionPercent: settings.afflictionPercent,
        });
        if (travelSeconds <= 0) return [];
        if (scheduledArrivalMs !== undefined && scheduledArrivalMs - travelSeconds * 1000 <= planningAtMs + 30_000)
          return [];
        return [{ source: sourceVillage, remaining, distance, travelSeconds }];
      })
      .sort((left, right) => right.travelSeconds - left.travelSeconds);

    let allocations: Allocation[];
    if (settings.allocationStrategy === 'max_available') {
      allocations = allocateDefenseMaximum(candidates, target, destination, settings, snapshot, planningAtMs);
    } else {
      const immediateSettings: SupportAllocationSettings = {
        mode: 'immediate',
        sourceGroupId: settings.sourceGroupId,
        allocationStrategy: 'proportional',
        distancePriority: settings.distancePriority,
        villageLimit: 0,
        reserveByUnit: settings.reserveByUnit,
        destinations: [destination],
      };
      allocations = allocateByUnit(candidates, destination, immediateSettings, snapshot, planningAtMs, activeUnits);
    }

    for (const allocation of allocations) {
      const remaining = remainingBySource.get(allocation.source.villageId);
      if (remaining === undefined) continue;
      for (const unit of SUPPORT_UNITS) remaining[unit] -= allocation.units[unit];
      const distance = supportPlannerDistance(allocation.source.coordinate, target.coordinate);
      const durationSeconds = supportPlannerDurationSeconds({
        distance,
        units: allocation.units,
        worldSpeed: snapshot.worldSpeed,
        unitSpeed: snapshot.unitSpeed,
        afflictionPercent: settings.afflictionPercent,
      });
      const arrivalAt =
        scheduledArrivalMs === undefined
          ? new Date(planningAtMs + durationSeconds * 1000).toISOString()
          : new Date(scheduledArrivalMs).toISOString();
      const commandWithoutId: Omit<PlannedSupportCommand, 'id'> = {
        accountId: snapshot.accountId,
        worldId: snapshot.worldId,
        sourceVillageId: allocation.source.villageId,
        sourceCoordinate: allocation.source.coordinate,
        targetCoordinate: target.coordinate,
        units: copyUnits(allocation.units),
        distance,
        durationSeconds,
        arrivalAt,
        population: supportPlannerPopulation(allocation.units),
      };
      // Identidade do id: chegada agendada real (agendado) ou o marcador
      // estável do modo imediato (defesa imediata também nasce de
      // planningAt + duração — id estável entre ciclos).
      const arrivalIdentity =
        scheduledArrivalMs === undefined ? IMMEDIATE_ARRIVAL_IDENTITY : new Date(scheduledArrivalMs).toISOString();
      planned.push({
        destinationIndex,
        command: { id: canonicalCommandId(commandWithoutId, arrivalIdentity), ...commandWithoutId },
      });
    }
  }

  planned.sort((left, right) => commandComparator(left.command, right.command));
  const commands = planned.map(({ command }) => command);
  const results = settings.targets.map((configuredTarget, destinationIndex): SupportDestinationResult => {
    const targetAnalysis = analysisByCoordinate.get(configuredTarget.coordinate);
    const destinationCommands = planned
      .filter((entry) => entry.destinationIndex === destinationIndex)
      .map((entry) => entry.command);
    const troops = emptyUnits();
    for (const command of destinationCommands) {
      for (const unit of SUPPORT_UNITS) troops[unit] += command.units[unit];
    }
    const population = supportPlannerPopulation(troops);
    if (targetAnalysis === undefined || targetAnalysis.state === 'invalid') {
      return {
        coordinate: configuredTarget.coordinate,
        state: 'invalid',
        exclusionReasons: ['O alvo não existe no snapshot ativo'],
        commandIds: [],
        troops,
        population,
      };
    }
    if (targetAnalysis.state === 'unavailable') {
      return {
        coordinate: configuredTarget.coordinate,
        state: 'unavailable',
        exclusionReasons: ['Os dados de apoio do alvo não estão disponíveis'],
        commandIds: [],
        troops,
        population,
      };
    }
    if (targetAnalysis.state === 'complete') {
      return {
        coordinate: configuredTarget.coordinate,
        state: 'complete',
        exclusionReasons: [],
        commandIds: [],
        troops,
        population,
      };
    }
    const fullyCovered = SUPPORT_UNITS.every((unit) => troops[unit] >= targetAnalysis.needed[unit]);
    const state: SupportDestinationResult['state'] =
      destinationCommands.length === 0 ? 'unavailable' : fullyCovered ? 'ready' : 'partial';
    return {
      coordinate: configuredTarget.coordinate,
      state,
      exclusionReasons:
        state === 'ready'
          ? []
          : state === 'partial'
            ? ['O estoque disponível atende apenas parte do déficit']
            : [
                settings.executionMode === 'scheduled'
                  ? 'Nenhuma origem pode enviar depois do guard de 30 segundos'
                  : 'Nenhuma origem elegível com tropas disponíveis',
              ],
      commandIds: destinationCommands.map((command) => command.id),
      troops,
      population,
    };
  });
  const troops = emptyUnits();
  for (const command of commands) {
    for (const unit of SUPPORT_UNITS) troops[unit] += command.units[unit];
  }
  return deepFreeze({
    summary: {
      destinations: results.length,
      commands: commands.length,
      population: supportPlannerPopulation(troops),
      troops,
    },
    results,
    commands,
  });
};
