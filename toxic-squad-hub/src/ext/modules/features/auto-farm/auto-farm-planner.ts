import type { AutoFarmSettings } from './auto-farm-settings';
import { autoFarmSettingsSchema } from './auto-farm-settings';
import type {
  AutoFarmPlunderFilters,
  AutoFarmTarget,
  AutoFarmTemplate,
  AutoFarmTemplateId,
  AutoFarmUnitAmounts,
  AutoFarmUnitType,
} from './auto-farm-contracts';
import { autoFarmSnapshotSchema } from './auto-farm-contracts';

export const AUTO_FARM_EXCLUSION_REASONS = Object.freeze([
  'NOT_BARBARIAN',
  'OUTSIDE_MAXIMUM_DISTANCE',
  'TEMPLATE_UNAVAILABLE_FOR_TARGET',
  'TEMPLATE_DISABLED_FOR_TARGET',
  'INSUFFICIENT_TROOPS',
  'BLOCKED_AFTER_LOSS',
  'BLACKLISTED_TARGET',
  'TARGET_COOLDOWN',
  'SCHEDULED_TARGET',
  'TARGET_IN_FLIGHT',
] as const);

export const AUTO_FARM_ROUND_STATUSES = Object.freeze([
  'EXECUTABLE',
  'WAITING_FOR_TROOPS',
  'COMMAND_LIMIT_REACHED',
] as const);

export const AUTO_FARM_UNIT_HAUL: Readonly<Record<AutoFarmUnitType, number>> = Object.freeze({
  spear: 25,
  sword: 15,
  axe: 10,
  archer: 10,
  spy: 0,
  light: 80,
  marcher: 50,
  heavy: 50,
  ram: 0,
  catapult: 0,
  knight: 100,
  snob: 0,
});

export type AutoFarmExclusionReason = (typeof AUTO_FARM_EXCLUSION_REASONS)[number];
export type AutoFarmExclusionCounts = Readonly<Record<AutoFarmExclusionReason, number>>;
export type AutoFarmRoundStatus = (typeof AUTO_FARM_ROUND_STATUSES)[number];

export type AutoFarmNoWorkCode =
  | 'CAPABILITY_UNAVAILABLE'
  | 'CAPABILITY_UNKNOWN'
  | 'FILTER_COVERAGE_INCOMPLETE'
  | 'SOURCE_COORDINATES_UNAVAILABLE'
  | 'TEMPLATE_NOT_FOUND'
  | 'NO_ELIGIBLE_TARGET'
  | 'NO_EXECUTABLE_TARGET';

export interface AutoFarmPlanningContext {
  /** Coordenadas x|y com comando ainda agendado no Hub. */
  scheduledTargetCoordinates?: readonly string[];
  /** Coordenadas x|y comprovadas na lista de comandos em trânsito do jogo. */
  inFlightTargetCoordinates?: readonly string[];
}

export type AutoFarmDecision =
  | Readonly<{
      kind: 'NO_WORK';
      code: AutoFarmNoWorkCode;
      reason: string;
      exclusions: AutoFarmExclusionCounts;
    }>
  | Readonly<{
      kind: 'PLAN';
      sourceVillageId: string;
      target: Readonly<Pick<AutoFarmTarget, 'id' | 'x' | 'y' | 'points'>>;
      templateId: AutoFarmTemplateId;
      distanceFields: number;
      exclusions: AutoFarmExclusionCounts;
    }>;

export interface AutoFarmPreviewAction {
  order: number;
  sourceVillageId: string;
  target: Readonly<Pick<AutoFarmTarget, 'id' | 'x' | 'y' | 'points' | 'lastResult'>> & {
    readonly evidenceSources: readonly AutoFarmTarget['evidenceSources'][number][];
  };
  templateId: AutoFarmTemplateId;
  gameTemplateId: string;
  distanceFields: number;
  roundStatus: AutoFarmRoundStatus;
  requiredUnits: Readonly<AutoFarmUnitAmounts>;
  remainingTroopsAfter?: Readonly<AutoFarmUnitAmounts>;
  haulCapacity: number;
}

export type AutoFarmPreviewDecision =
  | Extract<AutoFarmDecision, { kind: 'NO_WORK' }>
  | Readonly<{
      kind: 'PLAN';
      sourceVillageId: string;
      capturedAt: string;
      templateId: AutoFarmTemplateId;
      gameTemplateId: string;
      actions: readonly AutoFarmPreviewAction[];
      totalTargets: number;
      executableActions: number;
      waitingForTroops: number;
      waitingForCommandLimit: number;
      templateHaulCapacity: number;
      plunderFilters: Readonly<AutoFarmPlunderFilters>;
      exclusions: AutoFarmExclusionCounts;
    }>;

interface EligibleTarget {
  target: AutoFarmTarget;
  distanceFields: number;
}

function emptyExclusions(): Record<AutoFarmExclusionReason, number> {
  return {
    NOT_BARBARIAN: 0,
    OUTSIDE_MAXIMUM_DISTANCE: 0,
    TEMPLATE_UNAVAILABLE_FOR_TARGET: 0,
    TEMPLATE_DISABLED_FOR_TARGET: 0,
    INSUFFICIENT_TROOPS: 0,
    BLOCKED_AFTER_LOSS: 0,
    BLACKLISTED_TARGET: 0,
    TARGET_COOLDOWN: 0,
    SCHEDULED_TARGET: 0,
    TARGET_IN_FLIGHT: 0,
  };
}

function freezeExclusions(exclusions: Record<AutoFarmExclusionReason, number>): AutoFarmExclusionCounts {
  return Object.freeze({ ...exclusions });
}

function noWork(
  code: AutoFarmNoWorkCode,
  reason: string,
  exclusions: Record<AutoFarmExclusionReason, number> | AutoFarmExclusionCounts,
): Extract<AutoFarmDecision, { kind: 'NO_WORK' }> {
  return Object.freeze({ kind: 'NO_WORK', code, reason, exclusions: freezeExclusions({ ...exclusions }) });
}

function hasTroops(troops: AutoFarmUnitAmounts, template: AutoFarmTemplate): boolean {
  return Object.entries(template.units).every(([unit, required]) => {
    if (required === undefined) return true;
    return (troops[unit as AutoFarmUnitType] ?? 0) >= required;
  });
}

function spendTemplate(troops: AutoFarmUnitAmounts, template: AutoFarmTemplate): AutoFarmUnitAmounts {
  const remaining: AutoFarmUnitAmounts = { ...troops };
  for (const [unit, required] of Object.entries(template.units)) {
    if (required === undefined || required <= 0) continue;
    const typedUnit = unit as AutoFarmUnitType;
    remaining[typedUnit] = Math.max(0, (remaining[typedUnit] ?? 0) - required);
  }
  return remaining;
}

function templateHaulCapacity(template: AutoFarmTemplate): number {
  return Object.entries(template.units).reduce(
    (total, [unit, quantity]) => total + (quantity ?? 0) * AUTO_FARM_UNIT_HAUL[unit as AutoFarmUnitType],
    0,
  );
}

function targetIdOrder(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function leastRecentAttackTime(target: AutoFarmTarget): number {
  return target.lastAttackAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(target.lastAttackAt);
}

function compareTargets(left: EligibleTarget, right: EligibleTarget, settings: AutoFarmSettings): number {
  if (settings.targetPriority === 'least-recently-attacked') {
    const byAttackTime = leastRecentAttackTime(left.target) - leastRecentAttackTime(right.target);
    if (byAttackTime !== 0) return byAttackTime;
  }
  const byDistance = left.distanceFields - right.distanceFields;
  if (byDistance !== 0) return byDistance;
  return targetIdOrder(left.target.id, right.target.id);
}

function coordinate(target: Pick<AutoFarmTarget, 'x' | 'y'>): string {
  return `${target.x}|${target.y}`;
}

function plunderFilterDivergences(filters: AutoFarmPlunderFilters): string[] {
  const divergences: string[] = [];
  if (filters.onlyCurrentVillage) divergences.push('somente ataques desta aldeia');
  if (!filters.includeAttacked) divergences.push('aldeias já atacadas ocultas');
  if (!filters.includeFullLosses) divergences.push('perdas totais ocultas');
  if (!filters.includePartialLosses) divergences.push('perdas parciais ocultas');
  if (filters.onlyFullHauls) divergences.push('somente saques com carga total');
  return divergences;
}

function noEligibleReason(exclusions: Record<AutoFarmExclusionReason, number>): string {
  if (exclusions.TEMPLATE_DISABLED_FOR_TARGET > 0) {
    return 'O jogo mantém o template escolhido desabilitado para os alvos lidos; nenhuma aldeia foi planejada.';
  }
  if (exclusions.BLOCKED_AFTER_LOSS > 0) {
    return 'Todos os alvos restantes foram bloqueados pela regra de perdas; nenhuma aldeia foi planejada.';
  }
  if (exclusions.BLACKLISTED_TARGET > 0) return 'Todos os alvos restantes estão na lista de bloqueio.';
  if (exclusions.TARGET_COOLDOWN > 0) return 'Todos os alvos restantes ainda estão em cooldown.';
  if (exclusions.SCHEDULED_TARGET > 0 || exclusions.TARGET_IN_FLIGHT > 0) {
    return 'Todos os alvos restantes já possuem comando agendado ou em trânsito.';
  }
  return 'Nenhum alvo atende às regras atuais do Auto Farm.';
}

function isBlacklisted(target: AutoFarmTarget, settings: AutoFarmSettings): boolean {
  const references = new Set(settings.targetBlacklist);
  return references.has(target.id) || references.has(coordinate(target));
}

function isInCooldown(target: AutoFarmTarget, settings: AutoFarmSettings, capturedAtMs: number): boolean {
  if (settings.minimumTargetCooldownMinutes === 0 || target.lastAttackAt === undefined) return false;
  return capturedAtMs - Date.parse(target.lastAttackAt) < settings.minimumTargetCooldownMinutes * 60_000;
}

/**
 * Planejador puro e determinístico do Auto Farm. Recebe somente fatos já
 * coletados e preferências validadas, nunca acessa DOM/rede e seleciona no
 * máximo um alvo executável por ciclo.
 */
export function planAutoFarm(
  snapshotInput: unknown,
  settingsInput: unknown,
  planningContext: AutoFarmPlanningContext = {},
): AutoFarmDecision {
  const preview = planAutoFarmPreview(snapshotInput, settingsInput, planningContext);
  if (preview.kind === 'NO_WORK') return preview;
  const selected = preview.actions.find((action) => action.roundStatus === 'EXECUTABLE');
  if (!selected) {
    return noWork(
      'NO_EXECUTABLE_TARGET',
      'Há candidatos válidos, mas nenhuma ação cabe nas tropas e no limite da rodada atual.',
      preview.exclusions,
    );
  }
  return Object.freeze({
    kind: 'PLAN',
    sourceVillageId: preview.sourceVillageId,
    target: selected.target,
    templateId: preview.templateId,
    distanceFields: selected.distanceFields,
    exclusions: preview.exclusions,
  });
}

/**
 * Prévia completa e somente leitura. Simula uma rodada com orçamento de
 * tropas, mas a execução futura continuará reavaliando e enviando no máximo
 * uma ação por ciclo.
 */
export function planAutoFarmPreview(
  snapshotInput: unknown,
  settingsInput: unknown,
  planningContext: AutoFarmPlanningContext = {},
): AutoFarmPreviewDecision {
  const snapshot = autoFarmSnapshotSchema.parse(snapshotInput);
  const settings = autoFarmSettingsSchema.parse(settingsInput);
  const exclusions = emptyExclusions();

  if (snapshot.capability === 'UNAVAILABLE') {
    return noWork('CAPABILITY_UNAVAILABLE', 'O Assistente de Saque não está disponível neste ambiente.', exclusions);
  }
  if (snapshot.capability === 'UNKNOWN') {
    return noWork(
      'CAPABILITY_UNKNOWN',
      'Não foi possível comprovar a disponibilidade do Assistente de Saque.',
      exclusions,
    );
  }
  const filterDivergences = plunderFilterDivergences(snapshot.plunderFilters);
  if (filterDivergences.length > 0) {
    return noWork(
      'FILTER_COVERAGE_INCOMPLETE',
      `A lista de saques está incompleta (${filterDivergences.join(', ')}). Ajuste os filtros do jogo e gere outra prévia.`,
      exclusions,
    );
  }
  if (snapshot.source.x === undefined || snapshot.source.y === undefined) {
    return noWork(
      'SOURCE_COORDINATES_UNAVAILABLE',
      'As coordenadas da aldeia de origem não foram comprovadas.',
      exclusions,
    );
  }
  const template = snapshot.templates.find((candidate) => candidate.id === settings.templateId);
  if (!template) {
    return noWork('TEMPLATE_NOT_FOUND', `O template ${settings.templateId} não foi encontrado.`, exclusions);
  }

  const scheduled = new Set(planningContext.scheduledTargetCoordinates ?? []);
  const inFlight = new Set(planningContext.inFlightTargetCoordinates ?? []);
  const capturedAtMs = Date.parse(snapshot.capturedAt);
  const sourceInitiallyHasTroops = hasTroops(snapshot.source.troops, template);
  const eligible: EligibleTarget[] = [];
  for (const target of snapshot.targets) {
    if (!target.barbarian) {
      exclusions.NOT_BARBARIAN += 1;
      continue;
    }
    const distanceFields = Math.hypot(target.x - snapshot.source.x, target.y - snapshot.source.y);
    if (distanceFields > settings.maximumDistanceFields) {
      exclusions.OUTSIDE_MAXIMUM_DISTANCE += 1;
      continue;
    }
    if (!target.templateIds.includes(settings.templateId)) {
      exclusions.TEMPLATE_UNAVAILABLE_FOR_TARGET += 1;
      continue;
    }
    // Quando a origem inteira não completa o modelo, o jogo desabilita todos
    // os botões. Esses alvos continuam na prévia como WAITING_FOR_TROOPS.
    if (sourceInitiallyHasTroops && !target.availableTemplateIds.includes(settings.templateId)) {
      exclusions.TEMPLATE_DISABLED_FOR_TARGET += 1;
      continue;
    }
    if (settings.blockAfterLoss && target.lastResult === 'LOSS') {
      exclusions.BLOCKED_AFTER_LOSS += 1;
      continue;
    }
    if (isBlacklisted(target, settings)) {
      exclusions.BLACKLISTED_TARGET += 1;
      continue;
    }
    if (isInCooldown(target, settings, capturedAtMs)) {
      exclusions.TARGET_COOLDOWN += 1;
      continue;
    }
    const targetCoordinate = coordinate(target);
    if (settings.ignoreScheduledTargets && scheduled.has(targetCoordinate)) {
      exclusions.SCHEDULED_TARGET += 1;
      continue;
    }
    if (settings.ignoreTargetsInFlight && inFlight.has(targetCoordinate)) {
      exclusions.TARGET_IN_FLIGHT += 1;
      continue;
    }
    eligible.push({ target, distanceFields });
  }

  eligible.sort((left, right) => compareTargets(left, right, settings));
  if (eligible.length === 0) {
    return noWork('NO_ELIGIBLE_TARGET', noEligibleReason(exclusions), exclusions);
  }

  let remainingTroops: AutoFarmUnitAmounts = { ...snapshot.source.troops };
  let executableActions = 0;
  let waitingForTroops = 0;
  let waitingForCommandLimit = 0;
  const haulCapacity = templateHaulCapacity(template);
  const requiredUnits = Object.freeze({ ...template.units });
  const actions = eligible.map(({ target, distanceFields }, index): AutoFarmPreviewAction => {
    let roundStatus: AutoFarmRoundStatus;
    let remainingTroopsAfter: Readonly<AutoFarmUnitAmounts> | undefined;
    if (executableActions >= settings.maximumCommandsPerRound) {
      roundStatus = 'COMMAND_LIMIT_REACHED';
      waitingForCommandLimit += 1;
    } else if (!hasTroops(remainingTroops, template)) {
      roundStatus = 'WAITING_FOR_TROOPS';
      waitingForTroops += 1;
      exclusions.INSUFFICIENT_TROOPS += 1;
    } else {
      roundStatus = 'EXECUTABLE';
      executableActions += 1;
      remainingTroops = spendTemplate(remainingTroops, template);
      remainingTroopsAfter = Object.freeze({ ...remainingTroops });
    }
    const targetSummary = Object.freeze({
      id: target.id,
      x: target.x,
      y: target.y,
      ...(target.points !== undefined ? { points: target.points } : {}),
      lastResult: target.lastResult,
      evidenceSources: Object.freeze([...target.evidenceSources]),
    });
    return Object.freeze({
      order: index + 1,
      sourceVillageId: snapshot.source.villageId,
      target: targetSummary,
      templateId: settings.templateId,
      gameTemplateId: template.gameTemplateId,
      distanceFields,
      roundStatus,
      requiredUnits,
      ...(remainingTroopsAfter ? { remainingTroopsAfter } : {}),
      haulCapacity,
    });
  });
  return Object.freeze({
    kind: 'PLAN',
    sourceVillageId: snapshot.source.villageId,
    capturedAt: snapshot.capturedAt,
    templateId: settings.templateId,
    gameTemplateId: template.gameTemplateId,
    actions: Object.freeze(actions),
    totalTargets: snapshot.targets.length,
    executableActions,
    waitingForTroops,
    waitingForCommandLimit,
    templateHaulCapacity: haulCapacity,
    plunderFilters: Object.freeze({ ...snapshot.plunderFilters }),
    exclusions: freezeExclusions(exclusions),
  });
}
