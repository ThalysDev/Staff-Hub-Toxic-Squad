import { z } from 'zod';

/**
 * Planejador puro de retirada de apoio (support withdrawal) — portado verbatim
 * do pacote de engines do projeto irmão (support-manager do rei-do-tribal),
 * adaptado ao vocabulário do Hub: unidades nas chaves canônicas do jogo e
 * registros com nomes alinhados ao repositório. Função pura, determinística e
 * fail-closed: apenas planeja disposições, nunca envia nada
 * (effectsAllowed/sentToTribalWars fixos em false).
 *
 * Semântica portada sem alterações:
 * - minimização gulosa de distância L1 por unidade contra o alvo percentual;
 * - teto agregado de 125% do percentual (cap = floor(totalUnits * pct * 1.25 / 100));
 * - seleção manual valida TODOS os recordIds e lança em id ausente/estrangeiro;
 * - busca exaustiva em grupos de até 150 registros; primeira-melhoria acima disso;
 * - disposições: selected | retained | not-fractionable;
 * - agrupamento por aldeia anfitriã (guarnição) ou destino (apoio enviado);
 * - ordenação canônica por recordId e derivação de estado/metrics/avisos do contrato.
 */

export const SUPPORT_WITHDRAWAL_UNITS = Object.freeze([
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
export const SUPPORT_WITHDRAWAL_PERCENTAGES = Object.freeze([10, 25, 50, 100] as const);
export const SUPPORT_WITHDRAWAL_WARNINGS = Object.freeze([
  'snapshot-unavailable',
  'snapshot-incomplete',
  'snapshot-truncated',
  'not-fractionable',
  'withdrawal-semantics-unverified',
] as const);

export type SupportWithdrawalUnit = (typeof SUPPORT_WITHDRAWAL_UNITS)[number];
export type SupportWithdrawalDisposition = 'selected' | 'retained' | 'not-fractionable';

const countSchema = z.number().int().nonnegative();
const ascending = (values: readonly string[]) =>
  new Set(values).size === values.length && values.every((value, index) => index === 0 || values[index - 1]! < value);
const canonicalUnitOrder = (unitIds: readonly SupportWithdrawalUnit[]) =>
  new Set(unitIds).size === unitIds.length &&
  unitIds.every(
    (unit, index) =>
      index === 0 || SUPPORT_WITHDRAWAL_UNITS.indexOf(unit) > SUPPORT_WITHDRAWAL_UNITS.indexOf(unitIds[index - 1]!),
  );
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export const supportWithdrawalUnitSchema = z.enum(SUPPORT_WITHDRAWAL_UNITS);
export const supportWithdrawalTroopsSchema = z
  .object({
    spear: countSchema,
    sword: countSchema,
    axe: countSchema,
    archer: countSchema,
    spy: countSchema,
    light: countSchema,
    marcher: countSchema,
    heavy: countSchema,
    ram: countSchema,
    catapult: countSchema,
    knight: countSchema,
    snob: countSchema,
  })
  .strict();
export type SupportWithdrawalTroops = z.infer<typeof supportWithdrawalTroopsSchema>;

const percentageSchema = z.union([z.literal(10), z.literal(25), z.literal(50), z.literal(100)]);
const groupSchema = z.object({ groupId: z.string(), name: z.string() }).strict();
const membershipSchema = z.object({ villageId: z.string(), groupIds: z.array(z.string()) }).strict();

export const supportWithdrawalOutgoingSupportSchema = z
  .object({
    supportId: z.string(),
    originVillageId: z.string(),
    originName: z.string(),
    originCoordinate: z.string(),
    destinationVillageId: z.string(),
    destinationName: z.string(),
    destinationCoordinate: z.string(),
    destinationKind: z.enum(['own', 'player', 'barbarian']),
    ownerName: z.string().nullable(),
    playerName: z.string().nullable(),
    tribeName: z.string().nullable(),
    troops: supportWithdrawalTroopsSchema,
  })
  .strict();
export type SupportWithdrawalOutgoingSupport = z.infer<typeof supportWithdrawalOutgoingSupportSchema>;

export const supportWithdrawalGarrisonSchema = z
  .object({
    awayId: z.string(),
    hostVillageId: z.string(),
    hostName: z.string(),
    hostCoordinate: z.string(),
    originVillageId: z.string(),
    originName: z.string(),
    originCoordinate: z.string(),
    ownerName: z.string().nullable(),
    troops: supportWithdrawalTroopsSchema,
  })
  .strict();
export type SupportWithdrawalGarrison = z.infer<typeof supportWithdrawalGarrisonSchema>;

export const supportWithdrawalSnapshotSchema = z
  .object({
    accountId: z.string(),
    worldId: z.string(),
    availability: z.enum(['available', 'unavailable', 'unsupported']),
    coverage: z.enum(['complete', 'partial']),
    truncated: z.boolean(),
    groups: z.array(groupSchema),
    memberships: z.array(membershipSchema),
    outgoingSupports: z.array(supportWithdrawalOutgoingSupportSchema),
    garrisons: z.array(supportWithdrawalGarrisonSchema),
  })
  .strict();
export type SupportWithdrawalSnapshot = z.infer<typeof supportWithdrawalSnapshotSchema>;

export const supportWithdrawalDraftSchema = z
  .object({
    scope: z.enum(['own', 'player', 'barbarian', 'garrison']),
    /** '0' = todas as aldeias; qualquer outro valor deve existir em snapshot.groups. */
    groupId: z.string(),
    unitIds: z
      .array(supportWithdrawalUnitSchema)
      .min(1)
      .max(SUPPORT_WITHDRAWAL_UNITS.length)
      .refine(canonicalUnitOrder, {
        path: ['unitIds'],
        message: 'Units must be unique and use canonical order',
      }),
    selection: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('manual'),
          recordIds: z.array(z.string()).refine(ascending, {
            path: ['recordIds'],
            message: 'Manual record identifiers must be unique and use binary order',
          }),
        })
        .strict(),
      z.object({ kind: z.literal('percentage'), percent: percentageSchema }).strict(),
    ]),
  })
  .strict();
export type SupportWithdrawalDraft = z.infer<typeof supportWithdrawalDraftSchema>;

export const supportWithdrawalPlanningInputSchema = z
  .object({
    snapshot: supportWithdrawalSnapshotSchema,
    draft: supportWithdrawalDraftSchema,
    evaluatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.draft.groupId !== '0' && !input.snapshot.groups.some(({ groupId }) => groupId === input.draft.groupId)) {
      context.addIssue({
        code: 'custom',
        path: ['draft', 'groupId'],
        message: 'Selected group must exist in the snapshot',
      });
    }
  });
export type SupportWithdrawalPlanningInput = z.infer<typeof supportWithdrawalPlanningInputSchema>;

export const supportWithdrawalResultSchema = z
  .object({
    recordId: z.string(),
    recordKind: z.enum(['outgoing', 'garrison']),
    scope: z.enum(['own', 'player', 'barbarian', 'garrison']),
    groupingKey: z.string(),
    originVillageId: z.string(),
    destinationVillageId: z.string(),
    originName: z.string(),
    destinationName: z.string(),
    originCoordinate: z.string(),
    destinationCoordinate: z.string(),
    troops: supportWithdrawalTroopsSchema,
    disposition: z.enum(['selected', 'retained', 'not-fractionable']),
  })
  .strict()
  .superRefine((result, context) => {
    if ((result.recordKind === 'garrison') !== (result.scope === 'garrison'))
      context.addIssue({ code: 'custom', path: ['scope'], message: 'Garrison records and scope must agree' });
    if (result.groupingKey !== result.destinationVillageId)
      context.addIssue({
        code: 'custom',
        path: ['groupingKey'],
        message: 'Analysis groups by destination or host village',
      });
  });
export type SupportWithdrawalResult = z.infer<typeof supportWithdrawalResultSchema>;

/**
 * Estado, métricas e avisos derivados dos vetores de resultado — derivação
 * exata do contrato de origem (fail-closed: nunca inventa facts).
 */
export const deriveSupportWithdrawalPlan = (input: {
  availability: 'available' | 'unavailable' | 'unsupported';
  coverage: 'complete' | 'partial';
  truncated: boolean;
  unitIds: readonly SupportWithdrawalUnit[];
  results: readonly SupportWithdrawalResult[];
}) => {
  const totalUnits = input.results.reduce(
    (sum, result) => sum + input.unitIds.reduce((subtotal, unit) => subtotal + result.troops[unit], 0),
    0,
  );
  const selected = input.results.filter(({ disposition }) => disposition === 'selected');
  const selectedUnits = selected.reduce(
    (sum, result) => sum + input.unitIds.reduce((subtotal, unit) => subtotal + result.troops[unit], 0),
    0,
  );
  const notFractionableGroups = new Set(
    input.results.filter(({ disposition }) => disposition === 'not-fractionable').map(({ groupingKey }) => groupingKey),
  ).size;
  const warnings = SUPPORT_WITHDRAWAL_WARNINGS.filter(
    (warning) =>
      (warning === 'snapshot-unavailable' && input.availability !== 'available') ||
      (warning === 'snapshot-incomplete' && input.coverage === 'partial') ||
      (warning === 'snapshot-truncated' && input.truncated) ||
      (warning === 'not-fractionable' && notFractionableGroups > 0) ||
      (warning === 'withdrawal-semantics-unverified' &&
        input.availability === 'available' &&
        input.coverage === 'complete' &&
        !input.truncated &&
        input.results.length > 0),
  );
  return {
    state:
      input.availability === 'available' &&
      input.coverage === 'complete' &&
      !input.truncated &&
      input.results.length === 0
        ? ('empty' as const)
        : ('blocked' as const),
    metrics: {
      records: input.results.length,
      groups: new Set(input.results.map(({ groupingKey }) => groupingKey)).size,
      totalUnits,
      selectedUnits,
      effectivePercent: totalUnits > 0 ? (selectedUnits / totalUnits) * 100 : 0,
      notFractionableGroups,
    },
    warnings,
  };
};

export const supportWithdrawalPlanSchema = z
  .object({
    accountId: z.string(),
    worldId: z.string(),
    evaluatedAt: z.string().datetime({ offset: true }),
    unitIds: z
      .array(supportWithdrawalUnitSchema)
      .min(1)
      .max(SUPPORT_WITHDRAWAL_UNITS.length)
      .refine(canonicalUnitOrder, { message: 'Units must be unique and use canonical order' }),
    availability: z.enum(['available', 'unavailable', 'unsupported']),
    coverage: z.enum(['complete', 'partial']),
    truncated: z.boolean(),
    state: z.enum(['empty', 'blocked']),
    results: z.array(supportWithdrawalResultSchema),
    metrics: z
      .object({
        records: countSchema,
        groups: countSchema,
        totalUnits: countSchema,
        selectedUnits: countSchema,
        effectivePercent: z.number().finite().min(0).max(100),
        notFractionableGroups: countSchema,
      })
      .strict(),
    warnings: z.array(z.enum(SUPPORT_WITHDRAWAL_WARNINGS)).max(SUPPORT_WITHDRAWAL_WARNINGS.length),
    effectsAllowed: z.literal(false),
    sentToTribalWars: z.literal(false),
    plannedWithdrawals: z.literal(0),
    effect: z.null(),
  })
  .strict()
  .superRefine((plan, context) => {
    if (!ascending(plan.results.map(({ recordId }) => recordId)))
      context.addIssue({ code: 'custom', path: ['results'], message: 'Results must be unique and use binary order' });
    const derived = deriveSupportWithdrawalPlan(plan);
    if (plan.state !== derived.state)
      context.addIssue({ code: 'custom', path: ['state'], message: 'Plan state must be derived and fail closed' });
    if (!same(plan.metrics, derived.metrics))
      context.addIssue({ code: 'custom', path: ['metrics'], message: 'Metrics must be derived from result vectors' });
    if (!same(plan.warnings, derived.warnings))
      context.addIssue({ code: 'custom', path: ['warnings'], message: 'Warnings must be factual and canonical' });
    if (
      (plan.availability !== 'available' || plan.coverage === 'partial' || plan.truncated) &&
      plan.results.length !== 0
    )
      context.addIssue({
        code: 'custom',
        path: ['results'],
        message: 'Incomplete authority cannot expose analysis results',
      });
    if (plan.availability !== 'available' && plan.coverage !== 'partial')
      context.addIssue({ code: 'custom', path: ['coverage'], message: 'Unavailable authority is partial' });
    if (plan.truncated && plan.coverage !== 'partial')
      context.addIssue({ code: 'custom', path: ['coverage'], message: 'Truncated authority is partial' });
    const groups = new Map<string, SupportWithdrawalResult[]>();
    for (const result of plan.results)
      groups.set(result.groupingKey, [...(groups.get(result.groupingKey) ?? []), result]);
    for (const [groupingKey, group] of groups) {
      const hasNotFractionable = group.some(({ disposition }) => disposition === 'not-fractionable');
      if (hasNotFractionable && group.some(({ disposition }) => disposition !== 'not-fractionable'))
        context.addIssue({
          code: 'custom',
          path: ['results'],
          message: `Not-fractionable disposition must cover the whole group ${groupingKey}`,
        });
      if (hasNotFractionable && group.every((result) => plan.unitIds.every((unit) => result.troops[unit] === 0)))
        context.addIssue({
          code: 'custom',
          path: ['results'],
          message: 'A zero-unit group is retained, not marked not-fractionable',
        });
    }
  });
export type SupportWithdrawalPlan = z.infer<typeof supportWithdrawalPlanSchema>;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

const deepFreeze = <T>(value: T): DeepReadonly<T> => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value as DeepReadonly<T>;
};

const binaryCompare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const selectedUnitCount = (troops: SupportWithdrawalTroops, units: readonly SupportWithdrawalUnit[]) =>
  units.reduce((sum, unit) => sum + troops[unit], 0);
const distance = (
  selected: SupportWithdrawalTroops,
  target: Partial<Record<SupportWithdrawalUnit, number>>,
  units: readonly SupportWithdrawalUnit[],
) => units.reduce((sum, unit) => sum + Math.abs(selected[unit] - (target[unit] ?? 0)), 0);

type SupportWithdrawalCandidate = Omit<SupportWithdrawalPlan['results'][number], 'disposition'>;
type SupportWithdrawalCandidateResult = SupportWithdrawalCandidate & { disposition: SupportWithdrawalDisposition };

const zeroTroops = (): SupportWithdrawalTroops => ({
  spear: 0,
  sword: 0,
  axe: 0,
  archer: 0,
  spy: 0,
  light: 0,
  marcher: 0,
  heavy: 0,
  ram: 0,
  catapult: 0,
  knight: 0,
  snob: 0,
});

export const planSupportWithdrawal = (
  unparsed: SupportWithdrawalPlanningInput,
): DeepReadonly<SupportWithdrawalPlan> => {
  const input = supportWithdrawalPlanningInputSchema.parse(unparsed);
  const { snapshot, draft } = input;
  const base = {
    accountId: snapshot.accountId,
    worldId: snapshot.worldId,
    evaluatedAt: input.evaluatedAt,
    unitIds: draft.unitIds,
    availability: snapshot.availability,
    coverage: snapshot.coverage,
    truncated: snapshot.truncated,
  };
  const finish = (results: SupportWithdrawalCandidateResult[]) => {
    const canonical = [...results].sort((left, right) => binaryCompare(left.recordId, right.recordId));
    const derived = deriveSupportWithdrawalPlan({ ...base, results: canonical });
    return deepFreeze(
      supportWithdrawalPlanSchema.parse({
        ...base,
        ...derived,
        results: canonical,
        effectsAllowed: false,
        sentToTribalWars: false,
        plannedWithdrawals: 0,
        effect: null,
      }),
    );
  };
  if (snapshot.availability !== 'available' || snapshot.coverage === 'partial' || snapshot.truncated) return finish([]);

  const memberVillageIds =
    draft.groupId === '0'
      ? null
      : new Set(
          snapshot.memberships
            .filter(({ groupIds }) => groupIds.includes(draft.groupId))
            .map(({ villageId }) => villageId),
        );
  const candidates: SupportWithdrawalCandidate[] =
    draft.scope === 'garrison'
      ? snapshot.garrisons
          .filter(({ hostVillageId }) => memberVillageIds === null || memberVillageIds.has(hostVillageId))
          .map((record) => ({
            recordId: record.awayId,
            recordKind: 'garrison',
            scope: 'garrison',
            groupingKey: record.hostVillageId,
            originVillageId: record.originVillageId,
            destinationVillageId: record.hostVillageId,
            originName: record.originName,
            destinationName: record.hostName,
            originCoordinate: record.originCoordinate,
            destinationCoordinate: record.hostCoordinate,
            troops: record.troops,
          }))
      : snapshot.outgoingSupports
          .filter(
            (record) =>
              record.destinationKind === draft.scope &&
              (memberVillageIds === null || memberVillageIds.has(record.originVillageId)),
          )
          .map((record) => ({
            recordId: record.supportId,
            recordKind: 'outgoing',
            scope: record.destinationKind,
            groupingKey: record.destinationVillageId,
            originVillageId: record.originVillageId,
            destinationVillageId: record.destinationVillageId,
            originName: record.originName,
            destinationName: record.destinationName,
            originCoordinate: record.originCoordinate,
            destinationCoordinate: record.destinationCoordinate,
            troops: record.troops,
          }));
  candidates.sort((left, right) => binaryCompare(left.recordId, right.recordId));

  if (draft.selection.kind === 'manual') {
    const available = new Set(candidates.map(({ recordId }) => recordId));
    if (draft.selection.recordIds.some((recordId) => !available.has(recordId)))
      throw new Error('Manual selection contains a missing or foreign record identifier');
    const selected = new Set(draft.selection.recordIds);
    return finish(
      candidates.map((candidate) => ({
        ...candidate,
        disposition: selected.has(candidate.recordId) ? 'selected' : 'retained',
      })),
    );
  }

  const byGroup = new Map<string, SupportWithdrawalCandidate[]>();
  for (const candidate of candidates) {
    const group = byGroup.get(candidate.groupingKey);
    if (group === undefined) byGroup.set(candidate.groupingKey, [candidate]);
    else group.push(candidate);
  }
  const results: SupportWithdrawalCandidateResult[] = [];
  for (const group of byGroup.values()) {
    const ordered = [...group].sort(
      (left, right) =>
        selectedUnitCount(right.troops, draft.unitIds) - selectedUnitCount(left.troops, draft.unitIds) ||
        binaryCompare(left.recordId, right.recordId),
    );
    const totals = zeroTroops();
    for (const candidate of ordered) for (const unit of draft.unitIds) totals[unit] += candidate.troops[unit];
    const totalUnits = selectedUnitCount(totals, draft.unitIds);
    if (totalUnits === 0) {
      results.push(...ordered.map((candidate) => ({ ...candidate, disposition: 'retained' as const })));
      continue;
    }
    if (draft.selection.percent === 100) {
      results.push(...ordered.map((candidate) => ({ ...candidate, disposition: 'selected' as const })));
      continue;
    }
    const target: Partial<Record<SupportWithdrawalUnit, number>> = {};
    for (const unit of draft.unitIds) target[unit] = (totals[unit] * draft.selection.percent) / 100;
    const cap = Math.floor((totalUnits * draft.selection.percent * 1.25) / 100);
    const selectedTroops = zeroTroops();
    const selectedIds = new Set<string>();
    let selectedUnits = 0;
    let currentDistance = distance(selectedTroops, target, draft.unitIds);
    const exhaustive = ordered.length <= 150;
    for (let iteration = 0; iteration < ordered.length; iteration += 1) {
      let chosen: SupportWithdrawalCandidate | undefined;
      let chosenDistance = currentDistance;
      for (const candidate of ordered) {
        if (selectedIds.has(candidate.recordId)) continue;
        const candidateUnits = selectedUnitCount(candidate.troops, draft.unitIds);
        if (candidateUnits <= 0 || selectedUnits + candidateUnits > cap) continue;
        const nextDistance = draft.unitIds.reduce(
          (sum, unit) => sum + Math.abs(selectedTroops[unit] + candidate.troops[unit] - (target[unit] ?? 0)),
          0,
        );
        if (nextDistance < chosenDistance) {
          chosen = candidate;
          chosenDistance = nextDistance;
        }
        if (!exhaustive && chosen !== undefined) break;
      }
      if (chosen === undefined) break;
      for (const unit of draft.unitIds) selectedTroops[unit] += chosen.troops[unit];
      selectedUnits += selectedUnitCount(chosen.troops, draft.unitIds);
      selectedIds.add(chosen.recordId);
      currentDistance = chosenDistance;
    }
    const notFractionable = selectedIds.size === 0;
    results.push(
      ...ordered.map((candidate) => ({
        ...candidate,
        disposition: notFractionable
          ? ('not-fractionable' as const)
          : selectedIds.has(candidate.recordId)
            ? ('selected' as const)
            : ('retained' as const),
      })),
    );
  }
  return finish(results);
};
