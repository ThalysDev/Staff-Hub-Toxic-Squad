import { z } from 'zod';

/**
 * Planejador puro de balanceamento unificado de recursos — porta do motor
 * rei-do-tribal (unified-balancer) para o contrato do Hub: função pura,
 * determinística e fail-closed, com contratos Zod inline no mesmo formato dos
 * demais planejadores (op-planner, support-planner).
 *
 * O ALGORITMO é portado byte a byte do motor de origem (referência read-only
 * em `packages/engines/src/unified-balancer.ts` do projeto irmão) — com uma
 * única adaptação numérica: a distância euclidiana usa Math.hypot no lugar do
 * Math.sqrt(x²+y²) do motor, com resultados idênticos no domínio inteiro
 * 0..999 das coordenadas TW e alinhada à convenção do resource-planner. As
 * cinco camadas (urgência de fila parada 3 → fila 2 → necessidade 1 → troca
 * cruzada → equalização), derivação de demanda (stalledNeed/queueNeed via
 * resourceMaximum de nextItemCost + horizonNeed; constructionNeed apenas com
 * fila ociosa; aldeias pequenas via storageTargetRatio), blacklist direcional
 * com AND por aldeia OU grupo, reserva de aldeias prontas (isBuiltDonor por
 * pontos/população → storageCapacity × storageReserveRatio, senão capacidade
 * cheia), urgência = base + total/capacidade, matemática de mercadores
 * (disponíveis − reserva − usados; enchimento guloso wood/clay/iron dentro da
 * capacidade), descartes (notWorthIt, merchantCapacity, tooSmall, distance com
 * deduplicação de pares), swap transacional com rollback completo, passada de
 * equalização e estatísticas derivadas das transferências aceitas — os vetores
 * dourados do motor valem aqui sem adaptação.
 *
 * Vocabulário alinhado ao resource-planner do Hub: recursos wood/clay/iron,
 * coordenadas numéricas {x, y} com distância euclidiana. O que muda em relação
 * ao motor é apenas o envelope: contratos Zod locais, IDs sem branding e plano
 * de saída congelado.
 */

const finiteRatioSchema = z.number().finite().min(0).max(1);
const nonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const idTail = '[a-z0-9][a-z0-9-]{7,127}';
const villageIdSchema = z.string().regex(new RegExp(`^village_${idTail}$`));
const groupIdSchema = z.string().regex(new RegExp(`^group_${idTail}$`));
const snapshotIdSchema = z.string().regex(new RegExp(`^snapshot_${idTail}$`));
const accountIdSchema = z.string().regex(new RegExp(`^account_${idTail}$`));
const worldIdSchema = z.string().regex(new RegExp(`^world_${idTail}$`));
const transferIdSchema = z.string().regex(new RegExp(`^transfer_${idTail}$`));
const isoTimestampSchema = z.string().datetime({ offset: true });
const safeTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      !/(?:https?|socks[45]?):\/\/|\b(?:authorization|cookie)\s*:|\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+|\b(?:password|token|secret|sid)\s*[=:]|<\/?[a-z][^>]*>/i.test(
        value,
      ),
    'Transport details, secrets, and raw HTML are forbidden at the renderer boundary',
  );

/** Presets de modo do contrato de origem (growth/balanced/war). */
export const UNIFIED_BALANCE_PRESETS = Object.freeze({
  growth: Object.freeze({
    aggressiveness: 0.7,
    maxDistance: 50,
    maxTransfersPerCycle: 500,
    constructionHorizonHours: 12,
    baseTargetRatio: 0.6,
    periodHours: 1,
  }),
  balanced: Object.freeze({
    aggressiveness: 0.5,
    maxDistance: 30,
    maxTransfersPerCycle: 300,
    constructionHorizonHours: 6,
    baseTargetRatio: 0.5,
    periodHours: 3,
  }),
  war: Object.freeze({
    aggressiveness: 0.3,
    maxDistance: 20,
    maxTransfersPerCycle: 200,
    constructionHorizonHours: 3,
    baseTargetRatio: 0.3,
    periodHours: 6,
  }),
});
export const unifiedBalanceModeSchema = z.enum(['growth', 'balanced', 'war']);
export type UnifiedBalanceMode = z.infer<typeof unifiedBalanceModeSchema>;

export const unifiedBalanceResourceBundleSchema = z
  .object({ wood: nonnegativeIntegerSchema, clay: nonnegativeIntegerSchema, iron: nonnegativeIntegerSchema })
  .strict();
export const unifiedBalanceCoordinateSchema = z
  .object({ x: z.number().int().min(0).max(999), y: z.number().int().min(0).max(999) })
  .strict();
export const unifiedBalanceConstructionSchema = z
  .object({
    queueState: z.enum(['stalled', 'active', 'idle']),
    horizonNeed: unifiedBalanceResourceBundleSchema,
    nextItemCost: unifiedBalanceResourceBundleSchema,
  })
  .strict();
export const unifiedBalanceVillageSchema = z
  .object({
    villageId: villageIdSchema,
    name: safeTextSchema.pipe(z.string().max(120)),
    coordinate: unifiedBalanceCoordinateSchema,
    points: nonnegativeIntegerSchema,
    population: nonnegativeIntegerSchema,
    storageCapacity: positiveIntegerSchema,
    resources: unifiedBalanceResourceBundleSchema,
    availableMerchants: nonnegativeIntegerSchema,
    groupIds: z.array(groupIdSchema).max(500),
    regionId: nonnegativeIntegerSchema,
    construction: unifiedBalanceConstructionSchema,
    permissions: z.object({ canDonate: z.boolean(), canReceive: z.boolean() }).strict(),
  })
  .strict()
  .superRefine((village, context) => {
    for (const resource of ['wood', 'clay', 'iron'] as const) {
      if (village.resources[resource] > village.storageCapacity) {
        context.addIssue({
          code: 'custom',
          path: ['resources', resource],
          message: 'Village resources cannot exceed storage capacity',
        });
      }
    }
    if (new Set(village.groupIds).size !== village.groupIds.length) {
      context.addIssue({ code: 'custom', path: ['groupIds'], message: 'Village group identifiers must be unique' });
    }
  });
export const unifiedBalanceSnapshotSchema = z
  .object({
    snapshotId: snapshotIdSchema,
    accountId: accountIdSchema,
    worldId: worldIdSchema,
    revision: nonnegativeIntegerSchema,
    capturedAt: isoTimestampSchema,
    villages: z.array(unifiedBalanceVillageSchema).max(500),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const villageIds = snapshot.villages.map((village) => village.villageId);
    if (new Set(villageIds).size !== villageIds.length) {
      context.addIssue({ code: 'custom', path: ['villages'], message: 'Snapshot village identifiers must be unique' });
    }
  });

export const unifiedBalanceBlacklistEntrySchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('village'), villageId: villageIdSchema, canDonate: z.boolean(), canReceive: z.boolean() })
    .strict(),
  z
    .object({ kind: z.literal('group'), groupId: groupIdSchema, canDonate: z.boolean(), canReceive: z.boolean() })
    .strict(),
]);

export const unifiedBalanceConfigSchema = z
  .object({
    scriptId: z.literal('unified-balancer'),
    version: z.literal(1),
    mode: unifiedBalanceModeSchema,
    enabled: z.boolean(),
    periodHours: z.number().int().min(1).max(24),
    aggressiveness: finiteRatioSchema,
    constructionHorizonHours: z.number().int().min(0).max(48),
    baseTargetRatio: finiteRatioSchema,
    smallVillages: z
      .object({
        enabled: z.boolean(),
        pointsThreshold: nonnegativeIntegerSchema,
        storageTargetRatio: finiteRatioSchema,
      })
      .strict(),
    builtVillages: z
      .object({
        enabled: z.boolean(),
        pointsThreshold: nonnegativeIntegerSchema,
        populationThreshold: nonnegativeIntegerSchema,
        storageReserveRatio: finiteRatioSchema,
      })
      .strict(),
    merchants: z
      .object({ reserve: nonnegativeIntegerSchema, capacity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
      .strict(),
    regions: z.object({ enabled: z.boolean(), count: z.number().int().min(1).max(20) }).strict(),
    limits: z
      .object({ maxDistance: z.number().finite().nonnegative(), maxTransfersPerCycle: nonnegativeIntegerSchema })
      .strict(),
    blacklist: z.array(unifiedBalanceBlacklistEntrySchema).max(500),
    marketOffersEnabled: z.literal(false),
  })
  .strict();

export const UNIFIED_BALANCE_LAYERS = Object.freeze(['stalled', 'queue', 'need', 'swap', 'equalization'] as const);
export const unifiedBalanceLayerSchema = z.enum(UNIFIED_BALANCE_LAYERS);
const nonEmptyResourceBundleSchema = unifiedBalanceResourceBundleSchema.refine(
  (resources) => resources.wood > 0 || resources.clay > 0 || resources.iron > 0,
  'Transfer must contain at least one resource',
);
export const unifiedBalanceTransferSchema = z
  .object({
    transferId: transferIdSchema,
    sourceVillageId: villageIdSchema,
    sourceCoordinate: unifiedBalanceCoordinateSchema,
    targetVillageId: villageIdSchema,
    targetCoordinate: unifiedBalanceCoordinateSchema,
    resources: nonEmptyResourceBundleSchema,
    merchants: positiveIntegerSchema,
    distance: z.number().finite().nonnegative(),
    layer: unifiedBalanceLayerSchema,
    reason: safeTextSchema,
    urgency: z.number().finite().nonnegative(),
  })
  .strict()
  .refine((transfer) => transfer.sourceVillageId !== transfer.targetVillageId, {
    path: ['targetVillageId'],
    message: 'Transfer source and target must differ',
  });
const resourceHealthSchema = z
  .object({ wood: finiteRatioSchema, clay: finiteRatioSchema, iron: finiteRatioSchema })
  .strict();
export const unifiedBalanceStatisticsSchema = z
  .object({
    totals: unifiedBalanceResourceBundleSchema,
    resourcesMoved: nonnegativeIntegerSchema,
    villagesInvolved: nonnegativeIntegerSchema,
    directTransfers: nonnegativeIntegerSchema,
    crossSwapPairs: nonnegativeIntegerSchema,
    discarded: z
      .object({
        tooSmall: nonnegativeIntegerSchema,
        notWorthIt: nonnegativeIntegerSchema,
        distance: nonnegativeIntegerSchema,
        merchantCapacity: nonnegativeIntegerSchema,
      })
      .strict(),
    health: z.object({ before: resourceHealthSchema, after: resourceHealthSchema }).strict(),
    acceptedMarketOffers: z.literal(0),
  })
  .strict();
export const unifiedBalancePlanSchema = z
  .object({
    state: z.enum(['ready', 'balanced']),
    transfers: z.array(unifiedBalanceTransferSchema).max(10_000),
    statistics: unifiedBalanceStatisticsSchema,
  })
  .strict();

export type UnifiedBalanceResourceBundle = z.infer<typeof unifiedBalanceResourceBundleSchema>;
export type UnifiedBalanceCoordinate = z.infer<typeof unifiedBalanceCoordinateSchema>;
export type UnifiedBalanceConstruction = z.infer<typeof unifiedBalanceConstructionSchema>;
export type UnifiedBalanceVillage = z.infer<typeof unifiedBalanceVillageSchema>;
export type UnifiedBalanceSnapshot = z.infer<typeof unifiedBalanceSnapshotSchema>;
export type UnifiedBalanceBlacklistEntry = z.infer<typeof unifiedBalanceBlacklistEntrySchema>;
export type UnifiedBalanceConfig = z.infer<typeof unifiedBalanceConfigSchema>;
export type UnifiedBalanceLayer = z.infer<typeof unifiedBalanceLayerSchema>;
export type UnifiedBalanceTransfer = z.infer<typeof unifiedBalanceTransferSchema>;
export type UnifiedBalanceStatistics = z.infer<typeof unifiedBalanceStatisticsSchema>;
export type UnifiedBalancePlan = z.infer<typeof unifiedBalancePlanSchema>;

export interface UnifiedBalancePlanInput {
  readonly snapshot: UnifiedBalanceSnapshot;
  readonly config: UnifiedBalanceConfig;
}

const RESOURCES = ['wood', 'clay', 'iron'] as const;

type Coordinate = UnifiedBalanceVillage['coordinate'];

interface VillageState {
  readonly village: UnifiedBalanceVillage;
  readonly canDonate: boolean;
  readonly canReceive: boolean;
  readonly reserve: UnifiedBalanceResourceBundle;
  readonly resources: UnifiedBalanceResourceBundle;
  merchantsUsed: number;
}

interface Demand {
  readonly target: VillageState;
  readonly resources: UnifiedBalanceResourceBundle;
  readonly layer: 'stalled' | 'queue' | 'need';
  readonly urgency: number;
  readonly reason: string;
}

const emptyResources = (): UnifiedBalanceResourceBundle => ({ wood: 0, clay: 0, iron: 0 });

const copyResources = (resources: UnifiedBalanceResourceBundle): UnifiedBalanceResourceBundle => ({ ...resources });

const resourceTotal = (resources: UnifiedBalanceResourceBundle): number =>
  RESOURCES.reduce((total, resource) => total + resources[resource], 0);

const hasResources = (resources: UnifiedBalanceResourceBundle): boolean => resourceTotal(resources) > 0;

const sameResources = (left: UnifiedBalanceResourceBundle, right: UnifiedBalanceResourceBundle): boolean =>
  RESOURCES.every((resource) => left[resource] === right[resource]);

const resourceMaximum = (
  left: UnifiedBalanceResourceBundle,
  right: UnifiedBalanceResourceBundle,
): UnifiedBalanceResourceBundle => ({
  wood: Math.max(left.wood, right.wood),
  clay: Math.max(left.clay, right.clay),
  iron: Math.max(left.iron, right.iron),
});

const resourceMinimum = (
  left: UnifiedBalanceResourceBundle,
  right: UnifiedBalanceResourceBundle,
): UnifiedBalanceResourceBundle => ({
  wood: Math.min(left.wood, right.wood),
  clay: Math.min(left.clay, right.clay),
  iron: Math.min(left.iron, right.iron),
});

const resourceDeficit = (
  current: UnifiedBalanceResourceBundle,
  desired: UnifiedBalanceResourceBundle,
): UnifiedBalanceResourceBundle => ({
  wood: Math.max(0, desired.wood - current.wood),
  clay: Math.max(0, desired.clay - current.clay),
  iron: Math.max(0, desired.iron - current.iron),
});

const resourceExcess = (
  current: UnifiedBalanceResourceBundle,
  reserve: UnifiedBalanceResourceBundle,
): UnifiedBalanceResourceBundle => ({
  wood: Math.max(0, current.wood - reserve.wood),
  clay: Math.max(0, current.clay - reserve.clay),
  iron: Math.max(0, current.iron - reserve.iron),
});

/** Distância euclidiana entre coordenadas numéricas {x, y} (convenção do resource-planner). */
export const unifiedBalanceDistance = (origin: Coordinate, target: Coordinate): number =>
  Math.hypot(origin.x - target.x, origin.y - target.y);

const blacklistPermissions = (
  village: UnifiedBalanceVillage,
  blacklist: UnifiedBalanceConfig['blacklist'],
): Pick<VillageState, 'canDonate' | 'canReceive'> => {
  let canDonate = village.permissions.canDonate;
  let canReceive = village.permissions.canReceive;
  for (const entry of blacklist) {
    const applies =
      entry.kind === 'village'
        ? entry.villageId === village.villageId
        : village.groupIds.some((groupId) => groupId === entry.groupId);
    if (!applies) continue;
    canDonate &&= entry.canDonate;
    canReceive &&= entry.canReceive;
  }
  return { canDonate, canReceive };
};

const isBuiltDonor = (village: UnifiedBalanceVillage, config: UnifiedBalanceConfig): boolean =>
  !config.builtVillages.enabled ||
  village.points >= config.builtVillages.pointsThreshold ||
  village.population >= config.builtVillages.populationThreshold;

const resourcesAt = (value: number): UnifiedBalanceResourceBundle => ({ wood: value, clay: value, iron: value });

const reserveFor = (village: UnifiedBalanceVillage, config: UnifiedBalanceConfig): UnifiedBalanceResourceBundle => {
  if (!isBuiltDonor(village, config)) return resourcesAt(village.storageCapacity);
  return resourcesAt(Math.ceil(village.storageCapacity * config.builtVillages.storageReserveRatio));
};

const toState = (village: UnifiedBalanceVillage, config: UnifiedBalanceConfig): VillageState => ({
  village,
  ...blacklistPermissions(village, config.blacklist),
  reserve: reserveFor(village, config),
  resources: copyResources(village.resources),
  merchantsUsed: 0,
});

const urgencyFor = (resources: UnifiedBalanceResourceBundle, capacity: number, base: number): number =>
  base + resourceTotal(resources) / capacity;

const demandsFor = (state: VillageState, config: UnifiedBalanceConfig): Demand[] => {
  if (!state.canReceive) return [];
  const { construction } = state.village;
  const demands: Demand[] = [];
  const stalledNeed =
    construction.queueState === 'stalled'
      ? resourceMaximum(construction.nextItemCost, construction.horizonNeed)
      : emptyResources();
  if (hasResources(stalledNeed)) {
    demands.push({
      target: state,
      resources: stalledNeed,
      layer: 'stalled',
      urgency: urgencyFor(stalledNeed, state.village.storageCapacity, 3),
      reason: 'Fila de construção parada',
    });
  }
  const queueNeed =
    construction.queueState === 'active'
      ? resourceMaximum(construction.nextItemCost, construction.horizonNeed)
      : emptyResources();
  if (hasResources(queueNeed)) {
    demands.push({
      target: state,
      resources: queueNeed,
      layer: 'queue',
      urgency: urgencyFor(queueNeed, state.village.storageCapacity, 2),
      reason: 'Fila de construção ativa',
    });
  }
  const constructionNeed = construction.queueState === 'idle' ? construction.horizonNeed : emptyResources();
  const smallNeed =
    config.smallVillages.enabled && state.village.points < config.smallVillages.pointsThreshold
      ? resourceDeficit(
          state.resources,
          resourcesAt(Math.floor(state.village.storageCapacity * config.smallVillages.storageTargetRatio)),
        )
      : emptyResources();
  const need = resourceMaximum(constructionNeed, smallNeed);
  if (hasResources(need)) {
    demands.push({
      target: state,
      resources: need,
      layer: 'need',
      urgency: urgencyFor(need, state.village.storageCapacity, 1),
      reason: hasResources(constructionNeed) ? 'Necessidade no horizonte de construção' : 'Aldeia pequena prioritária',
    });
  }
  return demands;
};

const layerOrder: Readonly<Record<UnifiedBalanceLayer, number>> = {
  stalled: 0,
  queue: 1,
  need: 2,
  swap: 3,
  equalization: 4,
};

const transferComparator = (left: UnifiedBalanceTransfer, right: UnifiedBalanceTransfer): number =>
  layerOrder[left.layer]! - layerOrder[right.layer]! ||
  right.urgency - left.urgency ||
  left.distance - right.distance ||
  left.targetVillageId.localeCompare(right.targetVillageId) ||
  left.sourceVillageId.localeCompare(right.sourceVillageId) ||
  left.transferId.localeCompare(right.transferId);

/** ID ordinal em base 36 (semântica do motor de origem — não é hash). */
const transferId = (ordinal: number): UnifiedBalanceTransfer['transferId'] =>
  `transfer_${ordinal.toString(36).padStart(8, '0')}`;

const health = (states: readonly VillageState[]): UnifiedBalanceStatistics['health']['before'] => {
  const totals = emptyResources();
  let capacity = 0;
  for (const state of states) {
    capacity += state.village.storageCapacity;
    for (const resource of RESOURCES) totals[resource] += state.resources[resource];
  }
  if (capacity === 0) return emptyResources();
  return {
    wood: totals.wood / capacity,
    clay: totals.clay / capacity,
    iron: totals.iron / capacity,
  };
};

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
};

export const planUnifiedBalance = (input: UnifiedBalancePlanInput): UnifiedBalancePlan => {
  const snapshot = unifiedBalanceSnapshotSchema.parse(input.snapshot);
  const config = unifiedBalanceConfigSchema.parse(input.config);
  const states = [...snapshot.villages]
    .sort((left, right) => left.villageId.localeCompare(right.villageId))
    .map((village) => toState(village, config));
  const before = health(states);
  const transfers: UnifiedBalanceTransfer[] = [];
  const discarded = { tooSmall: 0, notWorthIt: 0, distance: 0, merchantCapacity: 0 };
  const rejectedDistancePairs = new Set<string>();
  let ordinal = 0;

  const tryTransfer = (
    source: VillageState,
    target: VillageState,
    requested: UnifiedBalanceResourceBundle,
    layer: UnifiedBalanceLayer,
    reason: string,
    urgency: number,
  ): UnifiedBalanceTransfer | undefined => {
    if (source.village.villageId === target.village.villageId || !source.canDonate || !target.canReceive)
      return undefined;
    if (config.regions.enabled && source.village.regionId !== target.village.regionId) return undefined;
    const distance = unifiedBalanceDistance(source.village.coordinate, target.village.coordinate);
    if (config.limits.maxDistance > 0 && distance > config.limits.maxDistance) {
      const pair = `${source.village.villageId}:${target.village.villageId}`;
      if (!rejectedDistancePairs.has(pair)) {
        rejectedDistancePairs.add(pair);
        discarded.distance += 1;
      }
      return undefined;
    }
    const sourceExcess = resourceExcess(source.resources, source.reserve);
    const targetSpace = resourceDeficit(target.resources, resourcesAt(target.village.storageCapacity));
    const possible = resourceMinimum(requested, resourceMinimum(sourceExcess, targetSpace));
    const availableMerchants = Math.max(
      0,
      source.village.availableMerchants - config.merchants.reserve - source.merchantsUsed,
    );
    const capacity = availableMerchants * config.merchants.capacity;
    let remainingCapacity = capacity;
    const allocated = emptyResources();
    for (const resource of RESOURCES) {
      const amount = Math.min(possible[resource], remainingCapacity);
      allocated[resource] = amount;
      remainingCapacity -= amount;
    }
    const amount = resourceTotal(allocated);
    if (amount <= 0) {
      if (hasResources(requested) && availableMerchants <= 0) discarded.merchantCapacity += 1;
      else if (hasResources(requested)) discarded.tooSmall += 1;
      return undefined;
    }
    if (amount < config.merchants.capacity * config.aggressiveness) {
      discarded.notWorthIt += 1;
      return undefined;
    }
    const merchants = Math.ceil(amount / config.merchants.capacity);
    if (merchants > availableMerchants) {
      discarded.merchantCapacity += 1;
      return undefined;
    }
    // A transferência é executada (aqui amount >= limiar de notWorthIt e cabe
    // nos mercadores). Se ficou ABAIXO do pedido por excedente/armazenamento da
    // origem, ela é uma execução PARCIAL e entra no plano — NUNCA um descarte
    // (a estatística `discarded.merchantCapacity` só conta o que de fato não
    // pôde ser enviado por falta de mercador: amount <= 0 ou merchants > livre).
    for (const resource of RESOURCES) {
      source.resources[resource] -= allocated[resource];
      target.resources[resource] += allocated[resource];
    }
    source.merchantsUsed += merchants;
    const transfer: UnifiedBalanceTransfer = {
      transferId: transferId(ordinal++),
      sourceVillageId: source.village.villageId,
      sourceCoordinate: source.village.coordinate,
      targetVillageId: target.village.villageId,
      targetCoordinate: target.village.coordinate,
      resources: allocated,
      merchants,
      distance,
      layer,
      reason,
      urgency,
    };
    transfers.push(transfer);
    return transfer;
  };

  const demands = states
    .flatMap((state) => demandsFor(state, config))
    .sort(
      (left, right) =>
        layerOrder[left.layer]! - layerOrder[right.layer]! ||
        right.urgency - left.urgency ||
        left.target.village.villageId.localeCompare(right.target.village.villageId),
    );
  for (const demand of demands) {
    const remaining = copyResources(demand.resources);
    const candidates = states
      .filter((state) => state.village.villageId !== demand.target.village.villageId)
      .sort(
        (left, right) =>
          unifiedBalanceDistance(left.village.coordinate, demand.target.village.coordinate) -
            unifiedBalanceDistance(right.village.coordinate, demand.target.village.coordinate) ||
          left.village.villageId.localeCompare(right.village.villageId),
      );
    for (const candidate of candidates) {
      if (!hasResources(remaining)) break;
      if (config.limits.maxTransfersPerCycle > 0 && transfers.length >= config.limits.maxTransfersPerCycle) break;
      const transfer = tryTransfer(candidate, demand.target, remaining, demand.layer, demand.reason, demand.urgency);
      if (transfer !== undefined) {
        for (const resource of RESOURCES) remaining[resource] -= transfer.resources[resource];
      }
    }
  }

  for (const [index, first] of states.entries()) {
    for (const second of states.slice(index + 1)) {
      if (config.limits.maxTransfersPerCycle > 0 && transfers.length + 2 > config.limits.maxTransfersPerCycle) continue;
      for (const outgoing of RESOURCES) {
        for (const incoming of RESOURCES) {
          if (outgoing === incoming) continue;
          const outgoingTarget = Math.floor((first.resources[outgoing] + second.resources[outgoing]) / 2);
          const incomingTarget = Math.floor((first.resources[incoming] + second.resources[incoming]) / 2);
          const firstExcess = Math.max(
            0,
            first.resources[outgoing] - Math.max(first.reserve[outgoing], outgoingTarget),
          );
          const secondNeed = Math.max(0, outgoingTarget - second.resources[outgoing]);
          const secondExcess = Math.max(
            0,
            second.resources[incoming] - Math.max(second.reserve[incoming], incomingTarget),
          );
          const firstNeed = Math.max(0, incomingTarget - first.resources[incoming]);
          const volume = Math.min(firstExcess, secondNeed, secondExcess, firstNeed);
          if (volume <= 0) continue;
          const out = emptyResources();
          const back = emptyResources();
          out[outgoing] = volume;
          back[incoming] = volume;
          const firstBefore = copyResources(first.resources);
          const secondBefore = copyResources(second.resources);
          const firstMerchantsBefore = first.merchantsUsed;
          const secondMerchantsBefore = second.merchantsUsed;
          const transfersBefore = transfers.length;
          const ordinalBefore = ordinal;
          const discardedBefore = { ...discarded };
          const forward = tryTransfer(first, second, out, 'swap', 'Troca cruzada de recursos complementares', 1);
          const reciprocal =
            forward === undefined
              ? undefined
              : tryTransfer(second, first, back, 'swap', 'Troca cruzada de recursos complementares', 1);
          if (
            forward !== undefined &&
            reciprocal !== undefined &&
            sameResources(forward.resources, out) &&
            sameResources(reciprocal.resources, back) &&
            resourceTotal(forward.resources) === resourceTotal(reciprocal.resources)
          )
            break;
          Object.assign(discarded, discardedBefore);
          if (forward !== undefined || reciprocal !== undefined) {
            Object.assign(first.resources, firstBefore);
            Object.assign(second.resources, secondBefore);
            first.merchantsUsed = firstMerchantsBefore;
            second.merchantsUsed = secondMerchantsBefore;
            transfers.splice(transfersBefore);
            ordinal = ordinalBefore;
          }
        }
      }
    }
  }

  for (const resource of RESOURCES) {
    const donors = [...states].sort(
      (left, right) =>
        right.resources[resource] - left.resources[resource] ||
        left.village.villageId.localeCompare(right.village.villageId),
    );
    const recipients = [...states].sort(
      (left, right) =>
        left.resources[resource] - right.resources[resource] ||
        left.village.villageId.localeCompare(right.village.villageId),
    );
    for (const recipient of recipients) {
      const recipientTarget = Math.floor(recipient.village.storageCapacity * config.baseTargetRatio);
      let deficit = Math.max(0, recipientTarget - recipient.resources[resource]);
      for (const donor of donors) {
        if (deficit <= 0) break;
        if (config.limits.maxTransfersPerCycle > 0 && transfers.length >= config.limits.maxTransfersPerCycle) break;
        const donorTarget = Math.floor(donor.village.storageCapacity * config.baseTargetRatio);
        const excess = Math.max(0, donor.resources[resource] - Math.max(donor.reserve[resource], donorTarget));
        if (excess <= 0) continue;
        const bundle = emptyResources();
        bundle[resource] = Math.min(excess, deficit);
        const transfer = tryTransfer(donor, recipient, bundle, 'equalization', 'Equalização de armazenamento', 0);
        if (transfer !== undefined) deficit -= transfer.resources[resource];
      }
    }
  }

  const ordered = [...transfers].sort(transferComparator);
  const totals = ordered.reduce(
    (total, transfer) => ({
      wood: total.wood + transfer.resources.wood,
      clay: total.clay + transfer.resources.clay,
      iron: total.iron + transfer.resources.iron,
    }),
    emptyResources(),
  );
  const villages = new Set(ordered.flatMap((transfer) => [transfer.sourceVillageId, transfer.targetVillageId]));
  const reciprocalPairs = new Set(
    ordered
      .filter((transfer) => transfer.layer === 'swap')
      .map((transfer) => [transfer.sourceVillageId, transfer.targetVillageId].sort().join(':')),
  );
  const after = health(states);
  const plan: UnifiedBalancePlan = {
    state: ordered.length === 0 ? 'balanced' : 'ready',
    transfers: ordered,
    statistics: {
      totals,
      resourcesMoved: resourceTotal(totals),
      villagesInvolved: villages.size,
      directTransfers: ordered.filter((transfer) => transfer.layer !== 'swap').length,
      crossSwapPairs: reciprocalPairs.size,
      discarded,
      health: { before, after },
      acceptedMarketOffers: 0,
    },
  };
  return deepFreeze(unifiedBalancePlanSchema.parse(plan));
};
