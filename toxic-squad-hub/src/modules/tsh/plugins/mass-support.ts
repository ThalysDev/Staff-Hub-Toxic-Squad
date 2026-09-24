// Apoio em Massa — porta do plugin mass-support da extensão Toxic Squad Hub
// (toxic-squad-hub-ext/.../modules/features/mass-support/plugin.ts) sobre as
// ENGINES vendadas em src/ext (support-planner + support-execution):
// - snapshot de origens: na extensão vinha das Visualizações (hubWorldState);
//   aqui é lido da Praça "Apoio em massa" (place&mode=call, page=-1, grupo
//   configurado) via pacedDoc — mesmas âncoras já usadas pela Suite Vanta
//   (#village_troup_list, tr.call-village, td[data-unit][data-count]);
// - PRÉVIA por padrão (porta do context.armed da origem): o runtime só roda
//   ciclos de módulo mutante ARMADO; dentro do ciclo, settings.armed !== true
//   mantém a prévia (status + 'last-plan') e NADA é enviado. Execução exige
//   settings.armed = true E armação no painel (dupla confirmação);
// - execução (F2: 1 mutação por ciclo): selectNextSupportCommand escolhe o
//   próximo comando da aldeia da aba, dedupe pelo livro-razão ('ledger') e
//   submitCommand2Step(..., attack:false, lane) — o fluxo de 2 passos da Praça.
//   O passo 1 navega: o comando fica rastreado em 'pending-command' e o
//   heartbeat completa a CONFIRMAÇÃO (passo 2) no ciclo seguinte, com o
//   matcher fail-closed do transporte (tela que não bate → nada confirmado);
// - FAIXA DE ENVIO (Onda 1): apoio imediato é ROTINA → lane 'humanizado'
//   (delays/intervalo/pausa da política), nunca 'precisao'. O apoio de defesa
//   CRONOMETRADO não passa pelo disparo direto: o plano vira registro no
//   Agendador (`kind: 'support'`, `sendAt` = chegada − viagem) e é o motor
//   dele que envia na janela, na faixa 'precisao' derivada do registro;
// - velocidades do mundo: interface.php?func=get_config público (porta do
//   worldGameConfigFor/game-data), fallback br142 (1.5/0.75) → 1/1;
// - desvio documentado: o modo defesa nasce com targetVillages: [] (o
//   userscript não tem leitor de apoio atual dos alvos) — alvos ficam
//   'invalid' e o modo devesa só forma comandos quando isso mudar (mesma
//   mensagem NO_WORK da origem);
// - destinos/alvos também entram por TEXTO "x|y por linha" (settings
//   destinationsText/targetsText, um editor por lista): preenchidos, viram os
//   arrays da engine no ciclo (destino = troopMode 'all'; alvo = coordenada);
//   vazios, valem as listas "destinations"/"targets" salvas (compat). Linha
//   ruim vira nota no status e é ignorada — nunca inventa alvo.

import { z } from 'zod';
import { registerTsh, isTshEnabled, type TshCycleContext } from '../tsh-runtime';
import { isUncertainMutationError, normalizeVillageId, submitCommand2Step } from '../tsh-transport';
import { automationReserveBlock } from '../tsh-reserva';
import { gm } from '../../../core/storage';
import type { TimingLane } from '../../../ext/core/humanize/humanize-policy';
import {
  parseSchedulerCommandRecord,
  type HubSchedulerState,
  type ScheduledCommandRecord,
} from '../../../ext/core/scheduler-state';
import { createScheduledCommand } from './command-scheduler';
import { pacedDoc } from '../../vanta/vanta-net';
import { pacedGet } from '../../../core/net';
import { pageWindow } from '../../../core/page';
import { parseGameInteger, serverNowIso, coordinateLinesNote, parseCoordinateLines } from './op-generator';
import { SCHEDULE_MIN_LEAD_MS } from '../../vanta/apoio-massa-logic';
import {
  SUPPORT_UNITS,
  planSupportAllocation,
  planSupportDefenseGoals,
  supportDefenseGoalSchema,
  supportPlannerPopulation,
  type PlannedSupportCommand,
  type SupportAllocationPlan,
  type SupportAllocationSettings,
  type SupportDefenseSettings,
  type SupportPlannerSnapshot,
  type SupportPlannerSourceVillage,
  type SupportUnit,
  type SupportUnitAmounts,
} from '../../../ext/modules/features/mass-support/support-planner';
import {
  appendSupportExecution,
  createSupportExecutionLedger,
  listExecutedSupportCommandIds,
  pruneSupportExecutionLedger,
  selectNextSupportCommand,
  toSupportCommandAction,
  type SupportExecutionLedger,
} from '../../../ext/modules/features/mass-support/support-execution';

// ── Settings (porta do massSupportSettings da origem) ──────────────────────

const supportCoordinateSchema = z.string().regex(/^(?:0|[1-9]\d{0,2})\|(?:0|[1-9]\d{0,2})$/);

const massSupportDestinationSchema = z
  .object({
    coordinate: supportCoordinateSchema,
    troopMode: z.enum(['population', 'unit', 'all']).default('all'),
    populationLimit: z.number().int().min(0).max(1_000_000_000).optional(),
    afflictionPercent: z.number().min(0).max(100).optional(),
  })
  .strict();
export type MassSupportDestination = z.infer<typeof massSupportDestinationSchema>;

/** Teto do planner (destinations/targets .max(500) no schema da engine). */
const MAX_LIST_ITEMS = 500;
/** Teto de caracteres dos textareas — impede storage patológico (≈6 mil linhas). */
const MAX_TEXT_CHARS = 20_000;

export const massSupportSettingsSchema = z
  .object({
    mode: z.enum(['immediate', 'defense']).default('immediate'),
    sourceGroupId: z.string().trim().nullable().default(null),
    allocationStrategy: z.enum(['max_available', 'proportional']).default('max_available'),
    distancePriority: z.enum(['closest', 'farthest']).default('closest'),
    villageLimit: z.number().int().min(0).max(500).default(0),
    reserveByUnit: z.record(z.string(), z.number().int().nonnegative()).default({}),
    destinations: z.array(massSupportDestinationSchema).max(500).default([]),
    targets: z
      .array(z.object({ coordinate: supportCoordinateSchema, goal: supportDefenseGoalSchema.optional() }).strict())
      .max(500)
      .default([]),
    /**
     * Editores de TEXTO "x|y por linha" (o painel não tem editor de listas
     * aninhadas): preenchidos, são convertidos para destinations/targets no
     * ciclo; vazios, valem as listas "destinations"/"targets" salvas (compat).
     */
    destinationsText: z.string().max(MAX_TEXT_CHARS).default(''),
    targetsText: z.string().max(MAX_TEXT_CHARS).default(''),
    compositionPreset: z.enum(['heavy', 'balanced', 'anti-cavalry', 'custom', 'equal']).default('heavy'),
    executionMode: z.enum(['immediate', 'scheduled']).default('immediate'),
    scheduledArrivalAt: z.string().trim().optional(),
    defensePopulationLimit: z.number().int().positive().max(1_000_000_000).default(5000),
    hasArchers: z.boolean().default(true),
    /** Chave de execução do plugin (porta do context.armed da origem): prévia até virar true. */
    armed: z.boolean().optional(),
  })
  .strict();
export type MassSupportSettings = z.infer<typeof massSupportSettingsSchema>;
type MassSupportDefenseTarget = MassSupportSettings['targets'][number];

/** Defaults efetivos do schema (o que o plugin assume com settings vazio). */
export const DEFAULT_SETTINGS: MassSupportSettings = {
  mode: 'immediate',
  // '' (não null): o campo é de TEXTO — o formulário só relê string.
  sourceGroupId: '',
  allocationStrategy: 'max_available',
  distancePriority: 'closest',
  villageLimit: 0,
  reserveByUnit: {},
  destinations: [],
  // P1 (revisão Onda 8): sem esta chave o loadSettings descartava o valor
  // salvo e o campo "Chegada agendada" reabria vazio a cada configuração.
  scheduledArrivalAt: '',
  targets: [],
  destinationsText: '',
  targetsText: '',
  compositionPreset: 'heavy',
  executionMode: 'immediate',
  defensePopulationLimit: 5000,
  hasArchers: true,
  // Sem esta chave o switch "armed" reabria SEMPRE desligado e o próximo
  // Salvar gravava false por cima (auditoria de formulários, 23/09).
  armed: false,
};

// ── Texto "x|y por linha" → listas que a engine consome ────────────────────

export interface MassSupportTextLists {
  destinations: MassSupportDestination[];
  targets: MassSupportDefenseTarget[];
  /** Notas pt-BR para o status (linhas inválidas, duplicatas, prevalência). */
  notes: string[];
}

/**
 * Resolve destinations/targets efetivos do ciclo: texto preenchido vence e é
 * convertido no formato da engine (destino = tropa inteira, troopMode 'all';
 * alvo de defesa = só coordenada, sem meta por alvo); texto vazio mantém as
 * listas salvas (compat). Linha inválida vira nota no status e é ignorada.
 */
export function resolveMassSupportLists(settings: MassSupportSettings): MassSupportTextLists {
  const notes: string[] = [];
  let destinations = settings.destinations;
  let targets = settings.targets;
  if (settings.destinationsText.trim() !== '') {
    const parsed = parseCoordinateLines(settings.destinationsText);
    destinations = parsed.targets
      .slice(0, MAX_LIST_ITEMS)
      .map((line): MassSupportDestination => ({ coordinate: line.coordinate, troopMode: 'all' }));
    if (parsed.targets.length > MAX_LIST_ITEMS)
      notes.push(`destinationsText: teto de ${MAX_LIST_ITEMS} — só os primeiros destinos entram no plano.`);
    const note = coordinateLinesNote('destinationsText', parsed);
    if (note !== '') notes.push(note);
  }
  if (settings.targetsText.trim() !== '') {
    const parsed = parseCoordinateLines(settings.targetsText);
    targets = parsed.targets
      .slice(0, MAX_LIST_ITEMS)
      .map((line): MassSupportDefenseTarget => ({ coordinate: line.coordinate }));
    if (parsed.targets.length > MAX_LIST_ITEMS)
      notes.push(`targetsText: teto de ${MAX_LIST_ITEMS} — só os primeiros alvos entram no plano.`);
    const note = coordinateLinesNote('targetsText', parsed);
    if (note !== '') notes.push(note);
  }
  if (settings.destinationsText.trim() !== '' && settings.destinations.length > 0)
    notes.push('destinationsText prevalece sobre a lista "destinations" salva.');
  if (settings.targetsText.trim() !== '' && settings.targets.length > 0)
    notes.push('targetsText prevalece sobre a lista "targets" salva.');
  return { destinations, targets, notes };
}

// ── Leitura das origens: Praça "Apoio em massa" (place&mode=call) ──────────

export interface PlaceCallVillage {
  villageId: string;
  coordinate: string;
  troops: SupportUnitAmounts;
}

const zeroUnits = (): SupportUnitAmounts => ({ spear: 0, sword: 0, archer: 0, spy: 0, light: 0, marcher: 0, heavy: 0 });

/**
 * Tropas disponíveis por aldeia própria na tabela de apoio em massa — mesmas
 * âncoras da Suite Vanta: linhas tr.call-village de #village_troup_list, link
 * da aldeia (village=n<id> + "(x|y)") e células td[data-unit] com data-count.
 * Só as 7 unidades de apoio entram; linha sem id/coordenada é ignorada.
 */
export function parsePlaceCallTroops(doc: Document): PlaceCallVillage[] {
  const table = doc.querySelector('#village_troup_list');
  if (table === null) return [];
  const villages: PlaceCallVillage[] = [];
  for (const row of Array.from(table.querySelectorAll('tr.call-village'))) {
    const link = row.querySelector<HTMLAnchorElement>('td:first-child a[href*="village=n"]');
    if (link === null) continue;
    const villageId = normalizeVillageId(
      new URL(link.href, 'https://tribalwars.com.br').searchParams.get('village') ?? '',
    );
    const match = /\((\d{1,3})\|(\d{1,3})\)/.exec(link.textContent ?? '');
    if (villageId === '' || match === null) continue;
    const troops = zeroUnits();
    for (const cell of Array.from(row.querySelectorAll('td[data-unit]'))) {
      const unit = cell.getAttribute('data-unit') ?? '';
      if (!(SUPPORT_UNITS as readonly string[]).includes(unit)) continue;
      troops[unit as SupportUnit] = parseGameInteger(cell.getAttribute('data-count') ?? cell.textContent);
    }
    villages.push({ villageId, coordinate: `${match[1]}|${match[2]}`, troops });
  }
  return villages;
}

async function fetchPlaceCallVillages(villageId: string, groupId: string): Promise<PlaceCallVillage[]> {
  const group = groupId === '' ? '0' : groupId;
  const doc = await pacedDoc(
    `/game.php?village=${encodeURIComponent(villageId)}&screen=place&mode=call&group=${encodeURIComponent(group)}&page=-1`,
  );
  return parsePlaceCallTroops(doc);
}

// ── Velocidades do mundo (porta mínima do worldGameConfigFor) ──────────────

const worldSpeedsCache = new Map<string, { worldSpeed: number; unitSpeed: number }>();
const DEFAULT_SPEEDS = Object.freeze({ worldSpeed: 1, unitSpeed: 1 });
const BR142_SPEEDS = Object.freeze({ worldSpeed: 1.5, unitSpeed: 0.75 });

async function resolveWorldSpeeds(worldId: string): Promise<{ worldSpeed: number; unitSpeed: number }> {
  const cached = worldSpeedsCache.get(worldId);
  if (cached !== undefined) return cached;
  const base = worldId.trim().toLowerCase() === 'br142' ? BR142_SPEEDS : DEFAULT_SPEEDS;
  try {
    const doc = new DOMParser().parseFromString(await pacedGet('/interface.php?func=get_config'), 'text/xml');
    if (doc.querySelector('parsererror') !== null) return base;
    const read = (tag: string): number | undefined => {
      const value = Number((doc.querySelector(tag)?.textContent ?? '').trim().replace(',', '.'));
      return Number.isFinite(value) && value > 0 ? value : undefined;
    };
    const worldSpeed = read('speed');
    const unitSpeed = read('unit_speed');
    if (worldSpeed !== undefined && unitSpeed !== undefined) {
      const resolved = { worldSpeed, unitSpeed };
      worldSpeedsCache.set(worldId, resolved);
      return resolved;
    }
  } catch {
    // sem rede/parse: mantém a tabela de fallback (fail-open da origem)
  }
  return base;
}

// ── Planejamento (porta do computeMassSupportPlan da origem) ───────────────

function supportReserveByUnit(reserve: Record<string, number>): SupportUnitAmounts {
  const full: SupportUnitAmounts = { spear: 0, sword: 0, archer: 0, spy: 0, light: 0, marcher: 0, heavy: 0 };
  for (const unit of SUPPORT_UNITS) {
    const amount = reserve[unit];
    if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) full[unit] = Math.floor(amount);
  }
  return full;
}

function playerName(): string {
  return pageWindow().game_data?.player?.name ?? '';
}

type MassSupportPlanResult =
  | { ok: true; mode: 'immediate' | 'defense'; plan: SupportAllocationPlan }
  | { ok: false; reason: string };

async function computeMassSupportPlan(input: {
  worldId: string;
  currentVillageId: string;
  settings: MassSupportSettings;
  ledger: SupportExecutionLedger;
  planningAt: string;
}): Promise<MassSupportPlanResult> {
  const { settings } = input;
  const sourceGroupId = settings.sourceGroupId === null || settings.sourceGroupId === '' ? '0' : settings.sourceGroupId;
  let placeVillages: PlaceCallVillage[];
  try {
    placeVillages = await fetchPlaceCallVillages(input.currentVillageId, sourceGroupId);
  } catch (error) {
    return {
      ok: false,
      reason: `Falha ao ler a Praça de Reunião (Apoio em massa): ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
  if (placeVillages.length === 0) {
    return {
      ok: false,
      reason: 'Nenhuma leitura de aldeias disponível: abra a Praça de Reunião (Apoio em massa) para o Hub conhecer tropas e coordenadas.',
    };
  }
  const speeds = await resolveWorldSpeeds(input.worldId);
  const groupIds = sourceGroupId === '0' ? [] : [sourceGroupId];
  const sourceVillages: SupportPlannerSourceVillage[] = placeVillages.map((village) => ({
    villageId: village.villageId,
    coordinate: village.coordinate,
    groupIds,
    troops: village.troops,
  }));
  const snapshot: SupportPlannerSnapshot = {
    accountId: playerName() || 'conta-do-hub',
    worldId: input.worldId,
    worldSpeed: speeds.worldSpeed,
    unitSpeed: speeds.unitSpeed,
    hasArchers: settings.hasArchers,
    sourceVillages,
    groups: sourceGroupId === '0' ? [] : [{ id: sourceGroupId, villageIds: sourceVillages.map((v) => v.villageId) }],
    pendingCommands: [],
    targetVillages: [], // sem leitor de apoio atual dos alvos no userscript (desvio documentado)
  };
  const common = {
    sourceGroupId,
    allocationStrategy: settings.allocationStrategy,
    distancePriority: settings.distancePriority,
    villageLimit: settings.villageLimit,
    reserveByUnit: supportReserveByUnit(settings.reserveByUnit),
  };
  if (settings.mode === 'defense') {
    if (settings.targets.length === 0) return { ok: false, reason: 'Nenhum alvo de defesa configurado para o modo defesa.' };
    if (settings.compositionPreset === 'custom')
      return {
        ok: false,
        reason: 'O preset de composição personalizado exige pesos por unidade (disponível apenas no modo JSON avançado).',
      };
    if (
      settings.executionMode === 'scheduled' &&
      (!settings.scheduledArrivalAt || Number.isNaN(Date.parse(settings.scheduledArrivalAt)))
    ) {
      return {
        ok: false,
        reason: 'O modo agendado exige um horário de chegada válido (ISO 8601) no campo "Chegada agendada".',
      };
    }
    const defenseSettings: SupportDefenseSettings = {
      mode: 'defense-goal',
      ...common,
      targets: settings.targets.map((target) => ({
        coordinate: target.coordinate,
        ...(target.goal !== undefined ? { goal: target.goal } : {}),
      })),
      goal: {
        mode: 'population',
        populationLimit: settings.defensePopulationLimit,
        compositionPreset: settings.compositionPreset,
        activeUnits: ['spear', 'sword', 'archer', 'light', 'marcher', 'heavy'],
        customWeights: {},
      },
      includeIncomingSupport: true,
      afflictionPercent: 0,
      executionMode: settings.executionMode,
      ...(settings.executionMode === 'scheduled' && settings.scheduledArrivalAt
        ? { scheduledArrivalAt: settings.scheduledArrivalAt }
        : {}),
    };
    const supportPlan = planSupportDefenseGoals({ snapshot, settings: defenseSettings, planningAt: input.planningAt });
    if (supportPlan.commands.length === 0)
      return {
        ok: false,
        reason: 'Nenhum comando de apoio de defesa pôde ser formado: os alvos ainda não têm leitura de apoio nas Visualizações.',
      };
    return { ok: true, mode: 'defense', plan: supportPlan };
  }
  if (settings.destinations.length === 0)
    return { ok: false, reason: 'Nenhum destino de apoio configurado para o modo imediato.' };
  const immediateSettings: SupportAllocationSettings = {
    mode: 'immediate',
    ...common,
    destinations: settings.destinations.map((destination) => ({
      coordinate: destination.coordinate,
      troopMode: destination.troopMode,
      populationLimit:
        destination.populationLimit && destination.populationLimit > 0 ? destination.populationLimit : 5000,
      afflictionPercent: destination.afflictionPercent ?? 0,
      activeUnits: [...SUPPORT_UNITS],
      unitLimits: {},
    })),
  };
  const supportPlan = planSupportAllocation({ snapshot, settings: immediateSettings, planningAt: input.planningAt });
  if (supportPlan.commands.length === 0)
    return { ok: false, reason: 'Nenhum comando de apoio pôde ser formado com as tropas disponíveis.' };
  const executedIds = listExecutedSupportCommandIds(input.ledger, input.worldId);
  if (executedIds.length === 0) return { ok: true, mode: 'immediate', plan: supportPlan };
  const inFlight = supportPlan.commands
    .filter((command) => executedIds.includes(command.id))
    .map((command) => ({ sourceVillageId: command.sourceVillageId, units: command.units }));
  if (inFlight.length === 0) return { ok: true, mode: 'immediate', plan: supportPlan };
  const replanned = planSupportAllocation({
    snapshot: { ...snapshot, pendingCommands: inFlight },
    settings: immediateSettings,
    planningAt: input.planningAt,
  });
  if (replanned.commands.length === 0)
    return { ok: false, reason: 'Nenhum comando de apoio pôde ser formado com as tropas disponíveis.' };
  return { ok: true, mode: 'immediate', plan: replanned };
}

/** Comando planejado → entradas do transporte (target "x|y" + unidades completas). */
export function commandToTransport(command: PlannedSupportCommand): { target: string; units: SupportUnitAmounts } {
  const action = toSupportCommandAction(command);
  return { target: `${action.payload.target.x}|${action.payload.target.y}`, units: action.payload.units };
}

// ── Livro-razão de execução (ctx.storage 'ledger') ─────────────────────────

const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LEDGER_MAX_ENTRIES_PER_WORLD = 1000;

type CycleStorage = TshCycleContext['storage'];

function isSupportExecutionLedger(value: unknown): value is SupportExecutionLedger {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { version?: unknown; worlds?: unknown };
  return record.version === 1 && typeof record.worlds === 'object' && record.worlds !== null;
}

function loadLedger(storage: CycleStorage): SupportExecutionLedger {
  const stored = storage.get<unknown>('ledger', null);
  return isSupportExecutionLedger(stored) ? stored : createSupportExecutionLedger();
}

function recordExecuted(storage: CycleStorage, worldId: string, commandId: string): void {
  const now = serverNowIso();
  try {
    const updated = pruneSupportExecutionLedger(
      appendSupportExecution(loadLedger(storage), { worldId, commandId, executedAt: now }),
      { now, retentionMs: LEDGER_RETENTION_MS, maxEntriesPerWorld: LEDGER_MAX_ENTRIES_PER_WORLD },
    );
    storage.set('ledger', updated);
  } catch {
    // ledger com entradas corrompidas: reinicia registando SÓ o comando deste
    // ciclo. Risco documentado: ids anteriores perdem o dedupe e podem ser
    // replanejados — caso freak (o gm.get já rejeita JSON inválido).
    storage.set(
      'ledger',
      appendSupportExecution(createSupportExecutionLedger(), { worldId, commandId, executedAt: now }),
    );
  }
}

function executedCommandIds(storage: CycleStorage, worldId: string): readonly string[] {
  try {
    return listExecutedSupportCommandIds(loadLedger(storage), worldId);
  } catch {
    return [];
  }
}

// ── Rastreio do fluxo de 2 passos entre ciclos (ctx.storage 'pending-command') ──

/**
 * Faixa do apoio IMEDIATO (rotina): humanizada. O apoio cravado não usa o
 * disparo direto — o modo defesa cronometrado registra no Agendador, cuja
 * faixa ('precisao') é derivada do próprio registro pelo motor.
 */
const ROUTINE_LANE: TimingLane = 'humanizado';

interface PendingSupportCommand {
  commandId: string;
  sourceCoordinate: string;
  targetCoordinate: string;
  units: SupportUnitAmounts;
  /** step1 = passo 1 submetido (nada enviado); confirm-issued = clique de confirmação disparado. */
  phase: 'step1' | 'confirm-issued';
  savedAt: string;
  /**
   * Faixa de envio do disparo direto (Onda 1). Ausente em registro gravado
   * antes desta revisão: a confirmação cai em `ROUTINE_LANE` — o disparo
   * direto do plugin SEMPRE foi a rotina do apoio imediato.
   */
  lane?: TimingLane;
}

/** Mesmo seletor canônico do transporte para a tela de confirmação do comando. */
function isCommandConfirmScreen(): boolean {
  return (
    document.querySelector(
      'form#command-data-form[action*="action=command"], form[action*="screen=place"][action*="action=command"]',
    ) !== null
  );
}

function transportMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transportCode(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : '';
}

/**
 * Ciclo na tela de confirmação: completa o passo 2 do comando rastreado.
 * O matcher do transporte revalida tipo (apoio), alvo e tropas — tela que não
 * corresponde NUNCA é confirmada (porta do matchesPendingCommandConfirmation).
 */
async function reconcilePendingConfirm(
  ctx: TshCycleContext,
  pending: PendingSupportCommand | null,
  settings: MassSupportSettings,
): Promise<void> {
  if (pending === null) {
    ctx.status(
      'Confirmação pendente não corresponde a um comando do Apoio em Massa — nenhuma confirmação será enviada.',
      'warn',
    );
    return;
  }
  if (settings.armed !== true) {
    ctx.status('Confirmação pendente do Apoio em Massa em modo de prévia — nada foi confirmado (armed=false).', 'info');
    return;
  }
  ctx.storage.set('pending-command', { ...pending, phase: 'confirm-issued' });
  try {
    // Passo 2 do apoio imediato: ROTINA → faixa humanizada (a mesma do passo 1
    // gravado no rastreio; registro antigo sem lane cai na rotina).
    await submitCommand2Step(pending.targetCoordinate, pending.units, {
      attack: false,
      lane: pending.lane ?? ROUTINE_LANE,
    });
    recordExecuted(ctx.storage, ctx.world, pending.commandId);
    ctx.storage.set('pending-command', null);
    ctx.status(
      `Confirmação enviada: apoio de ${pending.sourceCoordinate} para ${pending.targetCoordinate} (pop ${supportPlannerPopulation(pending.units)}).`,
      'ok',
    );
  } catch (error) {
    if (isUncertainMutationError(error)) {
      // mutação inconclusiva: marca como enviada (sem retry) para nunca duplicar
      recordExecuted(ctx.storage, ctx.world, pending.commandId);
      ctx.storage.set('pending-command', null);
      ctx.status(`Confirmação inconclusiva: ${transportMessage(error)} — comando marcado como enviado, sem retry.`, 'warn');
      return;
    }
    if (transportCode(error) === 'RESULT_UNCERTAIN') {
      ctx.storage.set('pending-command', null);
      ctx.status(
        'A tela de confirmação atual não corresponde ao comando rastreado — confirmação abandonada por segurança.',
        'warn',
      );
      return;
    }
    ctx.status(
      `Confirmação não concluída: ${transportMessage(error)} — o próximo ciclo tenta novamente nesta tela.`,
      'warn',
    );
  }
}

// ── Agendador: defesa CRONOMETRADA registra em vez de disparar direto ──────

/** Chave do storage do Agendador de Comandos (a MESMA do módulo do motor). */
const schedulerStorageKey = (world: string): string => `tsh-auto:${world}:command-scheduler:scheduler`;

function readSchedulerState(world: string): HubSchedulerState {
  return gm.get<HubSchedulerState>(schedulerStorageKey(world), { commands: [], transit: [] });
}

/** "x|y" do planner → coordenada; null fora do domínio (fail-closed). */
function parseCoordinatePair(raw: string): { x: number; y: number } | null {
  const [rawX, rawY] = raw.split('|');
  const x = Number(rawX);
  const y = Number(rawY);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 999 || y > 999) return null;
  return { x, y };
}

export interface SupportSchedulerDraft {
  readonly records: readonly ScheduledCommandRecord[];
  /** Comandos impossíveis de agendar, com o motivo em pt-BR (nada é inventado). */
  readonly skipped: readonly { readonly command: PlannedSupportCommand; readonly reason: string }[];
}

/**
 * Comandos planejados da defesa AGENDADA → registros do Agendador (`kind:
 * 'support'`, `timingMode: 'send'`, `sendAt` = chegada − viagem; o motor
 * deriva a faixa 'precisao' do próprio registro). Comando sem coordenada, sem
 * chegada/duração legível, com partida já passada (ou a menos de
 * `SCHEDULE_MIN_LEAD_MS` do agora) ou sem unidades é RECUSADO com motivo —
 * nunca um envio imediato disfarçado de agendado.
 */
export function buildSupportSchedulerRecords(
  commands: readonly PlannedSupportCommand[],
  nowMs: number,
): SupportSchedulerDraft {
  const records: ScheduledCommandRecord[] = [];
  const skipped: { command: PlannedSupportCommand; reason: string }[] = [];
  for (const command of commands) {
    const source = parseCoordinatePair(command.sourceCoordinate);
    const target = parseCoordinatePair(command.targetCoordinate);
    if (source === null || target === null) {
      skipped.push({ command, reason: `Comando ${command.id} com coordenada ilegível — não foi agendado.` });
      continue;
    }
    const arrivalMs = Date.parse(command.arrivalAt);
    if (!Number.isFinite(arrivalMs) || !Number.isFinite(command.durationSeconds)) {
      skipped.push({ command, reason: `Comando ${command.id} sem chegada/duração legível — não foi agendado.` });
      continue;
    }
    const sendAtMs = arrivalMs - command.durationSeconds * 1000;
    if (sendAtMs - nowMs < SCHEDULE_MIN_LEAD_MS) {
      skipped.push({
        command,
        reason: `Comando ${command.id}: partida já passou ou está a menos de ${Math.round(
          SCHEDULE_MIN_LEAD_MS / 1000,
        )}s do agora — janela impossível para o Agendador; não foi agendado.`,
      });
      continue;
    }
    const units: Record<string, number> = {};
    for (const unit of SUPPORT_UNITS) {
      const amount = Math.max(0, Math.floor(command.units[unit] ?? 0));
      if (amount > 0) units[unit] = amount;
    }
    if (Object.keys(units).length === 0) {
      skipped.push({ command, reason: `Comando ${command.id} sem unidades — não foi agendado.` });
      continue;
    }
    records.push(
      createScheduledCommand({
        kind: 'support',
        sourceVillageId: command.sourceVillageId,
        source,
        target,
        units,
        timingMode: 'send',
        sendAt: new Date(sendAtMs).toISOString(),
        arrivalAt: new Date(arrivalMs).toISOString(),
        detail: 'Apoio de defesa agendado pelo Apoio em Massa — o Agendador dispara na janela.',
      }),
    );
  }
  return { records, skipped };
}

/**
 * Grava o plano da defesa agendada no storage do Agendador (id canônico →
 * replanejar a mesma entrada gera o mesmo id: dedupe natural contra reenvio).
 * Fail-closed: Agendador DESLIGADO (o toggle é o opt-in; armar não vale para
 * ele — `armExempt`), registro inválido ou id já existente → NADA é gravado.
 */
function scheduleDefensePlan(
  ctx: TshCycleContext,
  commands: readonly PlannedSupportCommand[],
  withNotes: (message: string) => string,
  nowMs: number,
): void {
  if (!isTshEnabled('command-scheduler')) {
    ctx.status(
      withNotes(
        'O Agendador de Comandos está DESLIGADO — o plano de defesa não foi agendado (nada foi enviado). Ligue o módulo (aba Automações) e rode de novo.',
      ),
      'warn',
    );
    return;
  }
  const draft = buildSupportSchedulerRecords(commands, nowMs);
  const state = readSchedulerState(ctx.world);
  const existingIds = new Set(state.commands.map((command) => command.id));
  const created: ScheduledCommandRecord[] = [];
  let duplicated = 0;
  let rejected = 0;
  for (const record of draft.records) {
    if (existingIds.has(record.id)) {
      duplicated += 1;
      continue;
    }
    const parsed = parseSchedulerCommandRecord(record);
    if (!parsed.ok) {
      rejected += 1;
      continue;
    }
    created.push(parsed.record);
  }
  if (created.length > 0) {
    gm.set(schedulerStorageKey(ctx.world), { ...state, commands: [...state.commands, ...created] });
  }
  const parts = [`${created.length} apoio(s) agendado(s) — o Agendador dispara`];
  if (duplicated > 0) parts.push(`${duplicated} já estava(m) agendado(s) no mesmo horário (nada duplicado)`);
  if (rejected > 0) parts.push(`${rejected} recusado(s) pelo contrato do Agendador`);
  if (draft.skipped.length > 0) parts.push(draft.skipped.map((entry) => entry.reason).join(' '));
  ctx.status(
    withNotes(`${parts.join(' · ')}.`),
    created.length > 0 ? 'ok' : duplicated > 0 ? 'info' : 'warn',
  );
}

// ── Plugin ─────────────────────────────────────────────────────────────────

const MODE_LABEL: Record<'immediate' | 'defense', string> = { immediate: 'imediato', defense: 'defesa' };

registerTsh({
  id: 'mass-support',
  label: 'Apoio em Massa',
  desc: 'Planeja apoios em massa (imediato/defesa). Prévia por padrão; com "Enviar de verdade" LIGADO nas configurações e o módulo ativado/armado, envia 1 apoio por ciclo pela Praça de Reunião em 2 passos.',
  category: 'producao',
  screen: 'place',
  mutating: true,
  cooldownMs: 60_000, // 1 comando por ciclo: cadência p/ planos de vários comandos
  settingsDefaults: DEFAULT_SETTINGS,
  // Escalares + editores de texto de configuração. Ficam FORA do formulário
  // as estruturas aninhadas que o plugin lê como listas/objetos: destinations,
  // targets (alvos com meta) e reserveByUnit — as duas primeiras têm EDITOR DE
  // TEXTO abaixo (destinationsText/targetsText). `armed` É exposto no form
  // (chave de execução do plugin, dupla confirmação com o ARMAR do painel).
  settingsForm: [
    {
      key: 'armed',
      label: 'Enviar de verdade (desliga o modo prévia)',
      type: 'boolean',
      help: 'DESLIGADO = só prévia do plano. LIGADO + módulo ativado/armado no painel = envia 1 apoio por ciclo pela Praça (confirmação dupla).',
    },
    {
      key: 'mode',
      label: 'Modo',
      type: 'select',
      options: [
        { value: 'immediate', label: 'Imediato' },
        { value: 'defense', label: 'Defesa' },
      ],
      help: 'Imediato envia para os destinos; defesa planeja população-alvo nos alvos.',
    },
    {
      key: 'destinationsText',
      label: 'Destinos de apoio (modo imediato)',
      type: 'textarea',
      placeholder: '500|500\n501|503',
      help: 'Uma coordenada x|y por linha — cada destino recebe a tropa inteira disponível. Preenchido, substitui a lista "destinations" do JSON; vazio, vale a lista salva. Linha inválida é ignorada e avisada no status.',
    },
    {
      key: 'targetsText',
      label: 'Alvos de defesa (modo defesa)',
      type: 'textarea',
      placeholder: '500|500\n501|503',
      help: 'Uma coordenada x|y por linha — cada alvo recebe a população do campo abaixo. Preenchido, substitui a lista "targets" do JSON; vazio, vale a lista salva. Linha inválida é ignorada e avisada no status.',
    },
    { key: 'sourceGroupId', label: 'Grupo das origens', type: 'text', placeholder: '0', help: '0 = sem filtro de grupo.' },
    {
      key: 'allocationStrategy',
      label: 'Distribuição das tropas',
      type: 'select',
      options: [
        { value: 'max_available', label: 'Máximo disponível' },
        { value: 'proportional', label: 'Proporcional' },
      ],
    },
    {
      key: 'distancePriority',
      label: 'Prioridade de distância',
      type: 'select',
      options: [
        { value: 'closest', label: 'Alvos mais próximos' },
        { value: 'farthest', label: 'Alvos mais distantes' },
      ],
    },
    { key: 'villageLimit', label: 'Limite de aldeias de origem', type: 'number', min: 0, max: 500, help: '0 = sem limite.' },
    {
      key: 'compositionPreset',
      label: 'Composição (modo defesa)',
      type: 'select',
      options: [
        { value: 'heavy', label: 'Pesada' },
        { value: 'balanced', label: 'Equilibrada' },
        { value: 'anti-cavalry', label: 'Anticavalaria' },
        { value: 'equal', label: 'Uniforme' },
        { value: 'custom', label: 'Personalizada' },
      ],
      help: '"Personalizada" segue bloqueada: exige pesos por unidade (só no JSON avançado).',
    },
    {
      key: 'executionMode',
      label: 'Execução (modo defesa)',
      type: 'select',
      options: [
        { value: 'immediate', label: 'Imediata' },
        { value: 'scheduled', label: 'Agendada' },
      ],
      help: 'Agendada exige a chegada em ISO 8601 no campo abaixo.',
    },
    {
      key: 'scheduledArrivalAt',
      label: 'Chegada agendada (ISO 8601)',
      type: 'text',
      placeholder: '2026-01-01T12:00:00Z',
    },
    {
      key: 'defensePopulationLimit',
      label: 'População por alvo (defesa)',
      type: 'number',
      min: 1,
      max: 1_000_000_000,
      help: 'População total que cada alvo de defesa deve receber.',
    },
    { key: 'hasArchers', label: 'Mundo com arqueiros', type: 'boolean' },
    {
      key: 'reserveByUnit',
      label: 'Reserva por unidade (fica na origem)',
      type: 'record',
      help: 'Quantidade de cada unidade que NÃO é enviada (fica defendendo a aldeia de origem). 0 = sem reserva da unidade.',
      recordKeys: [
        { key: 'spear', label: 'Lança', min: 0, step: 50 },
        { key: 'sword', label: 'Espada', min: 0, step: 50 },
        { key: 'axe', label: 'Machado', min: 0, step: 50 },
        { key: 'archer', label: 'Arqueiro', min: 0, step: 50 },
        { key: 'spy', label: 'Explorador', min: 0, step: 10 },
        { key: 'light', label: 'Cav. Leve', min: 0, step: 50 },
        { key: 'marcher', label: 'Arq. Cavalo', min: 0, step: 50 },
        { key: 'heavy', label: 'Cav. Pesada', min: 0, step: 50 },
        { key: 'ram', label: 'Aríete', min: 0, step: 10 },
        { key: 'catapult', label: 'Catapulta', min: 0, step: 10 },
      ],
    },
  ],
  async runCycle(ctx): Promise<void> {
    let settings: MassSupportSettings;
    try {
      settings = massSupportSettingsSchema.parse(ctx.storage.get('settings', DEFAULT_SETTINGS));
    } catch {
      ctx.status('Configurações inválidas do Apoio em Massa — revise a chave "settings".', 'warn');
      return;
    }
    // Tela de confirmação pendente: reconcilia o passo 2 ANTES de planejar.
    const pending = ctx.storage.get<PendingSupportCommand | null>('pending-command', null);
    if (isCommandConfirmScreen()) {
      await reconcilePendingConfirm(ctx, pending, settings);
      return;
    }
    if (pending !== null) {
      if (pending.phase === 'confirm-issued') {
        // clique de confirmação disparado antes da página morrer: fail-closed
        // contra reenvio — registra no livro-razão SEM reexecutar.
        recordExecuted(ctx.storage, ctx.world, pending.commandId);
        ctx.status(
          `Confirmação de apoio para ${pending.targetCoordinate} disparada no ciclo anterior — marcada como enviada para não duplicar.`,
          'warn',
        );
      } else {
        // passo 1 sem confirmação: nenhuma tropa saiu (o envio real é o passo 2).
        ctx.storage.set('pending-command', null);
      }
    }

    // Editores de texto "x|y por linha" → listas da engine (compat: texto
    // vazio mantém as listas salvas). Notas de linha ruim acompanham o status.
    const lists = resolveMassSupportLists(settings);
    const settingsForPlan: MassSupportSettings = {
      ...settings,
      destinations: lists.destinations,
      targets: lists.targets,
    };
    const withNotes = (message: string): string => (lists.notes.length === 0 ? message : `${message} ${lists.notes.join(' ')}`);

    const planningAt = serverNowIso();
    const computed = await computeMassSupportPlan({
      worldId: ctx.world,
      currentVillageId: normalizeVillageId(ctx.villageId),
      settings: settingsForPlan,
      ledger: loadLedger(ctx.storage),
      planningAt,
    });
    if (!computed.ok) {
      ctx.status(withNotes(computed.reason), 'info');
      return;
    }
    ctx.storage.set('last-plan', {
      generatedAt: planningAt,
      mode: computed.mode,
      summary: computed.plan.summary,
      results: computed.plan.results,
      commands: computed.plan.commands,
    });
    if (settings.armed !== true) {
      ctx.status(
        withNotes(
          `Prévia Apoio em Massa (${MODE_LABEL[computed.mode]}): ${computed.plan.summary.commands} comando(s), população ${computed.plan.summary.population} — execução desligada (armed=false).`,
        ),
        'ok',
      );
      return;
    }

    // Defesa CRONOMETRADA: sem disparo direto (o apoio cravado perderia a mira
    // no fluxo de 2 passos) — o plano inteiro vira registro no Agendador, que
    // dispara na janela, na faixa 'precisao' derivada do registro.
    if (computed.mode === 'defense' && settings.executionMode === 'scheduled') {
      scheduleDefensePlan(ctx, computed.plan.commands, withNotes, Date.parse(planningAt));
      return;
    }

    // Execução (o runtime já exigiu armação): 1 comando por ciclo (F2).
    const currentVillage = normalizeVillageId(ctx.villageId);
    if (currentVillage === '') {
      ctx.status(withNotes('Nenhuma aldeia foi lida.'), 'info');
      return;
    }
    const selection = selectNextSupportCommand(computed.plan.commands, {
      sourceVillageId: currentVillage,
      executedCommandIds: executedCommandIds(ctx.storage, ctx.world),
      nowMs: Date.parse(planningAt),
    });
    if (selection.command === null) {
      ctx.status(withNotes(selection.reason), 'info');
      return;
    }
    const command = selection.command;
    const transport = commandToTransport(command);
    // v3.5.0: apoio não volta — tropas reservadas para um comando agendado
    // desta aldeia ficam em casa.
    const reserva = automationReserveBlock(ctx.world, ctx.villageId, transport.units as Partial<Record<string, number>>);
    if (reserva !== null) {
      ctx.status(withNotes(reserva), 'warn');
      return;
    }
    ctx.status(
      `Enviando apoio de ${command.sourceCoordinate} para ${transport.target} (pop ${command.population}) — 1 comando neste ciclo.`,
      'info',
    );
    ctx.storage.set<PendingSupportCommand | null>('pending-command', {
      commandId: command.id,
      sourceCoordinate: command.sourceCoordinate,
      targetCoordinate: transport.target,
      units: transport.units,
      phase: 'step1',
      savedAt: planningAt,
      lane: ROUTINE_LANE,
    });
    try {
      // Apoio imediato = ROTINA: lane 'humanizado' (nunca a faixa de precisão,
      // que é de nobre/snipe/dodge/cancelamento e do apoio CRAVADO).
      await submitCommand2Step(transport.target, transport.units, { attack: false, lane: ROUTINE_LANE });
      recordExecuted(ctx.storage, ctx.world, command.id);
      ctx.storage.set('pending-command', null);
      ctx.status(
        `Apoio de ${command.sourceCoordinate} para ${transport.target} enviado (pop ${command.population}) — próximo comando no ciclo seguinte.`,
        'ok',
      );
    } catch (error) {
      if (isUncertainMutationError(error)) {
        recordExecuted(ctx.storage, ctx.world, command.id);
        ctx.storage.set('pending-command', null);
        ctx.status(`Envio inconclusivo: ${transportMessage(error)} — comando marcado como enviado, sem retry.`, 'warn');
        return;
      }
      if (transportCode(error) === 'CONFIRM_SCREEN_NOT_REACHED') {
        // passo 1 submetido e a navegação encerrou o contexto: nenhuma tropa
        // saiu — o próximo ciclo completa a confirmação na tela que abrir.
        ctx.status(
          `Passo 1 enviado para ${transport.target}; a confirmação (passo 2) será completada pelo próximo ciclo nesta tela — nenhuma tropa enviada ainda.`,
          'info',
        );
        return;
      }
      ctx.storage.set('pending-command', null);
      ctx.status(`Envio de apoio falhou: ${transportMessage(error)}`, 'warn');
    }
  },
});
