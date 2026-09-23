// Plugin TSH 'command-scheduler' — porta do plugin da extensão
// (toxic-squad-hub-ext/.../modules/features/command-scheduler/plugin.ts) para
// o motor de ciclos do userscript. O mais delicado do port:
// - comandos agendados vivem em ctx.storage (chave "scheduler", forma do
//   estado do Agendador v2: { commands: ScheduledCommandRecord[], transit }).
//   Status/janela vêm do scheduler-state vendado: comandos PAUSADOS nunca
//   disparam; status TERMINAIS (enviado/incerto/falhou/removido) são fatos
//   persistidos em events e NUNCA rederivados pelo relógio;
// - "agora" é o RELÓGIO DO SERVIDOR (server-clock vendado): offset medido do
//   "Hora do servidor" da própria tela;
// - janela do original: focusLeadMs 15s / allowLateMs 250ms (settings);
// - FAKE protection: ataque/fake com pontos do alvo exige população ≥ 2% dos
//   pontos (limite observado no br142 — game-data da extensão);
// - F2: UMA mutação por ciclo. ONDA A (regra de ouro): o passo 1 é um
//   PRÉ-ARME (prearmCommandStep1, `prearmLeadMs` antes do horário — nenhuma
//   tropa sai) e o clique final (clickCommandConfirmNow, síncrono) acontece na
//   MIRA de precisão da tela de confirmação: relógio medido (core/game-clock),
//   espera em Worker + espera ativa final, compensação de latência. Cravado
//   atrasado além da tolerância NUNCA sai (vira 'falhou' com o motivo);
//   a confirmação só é clicada quando CASA com um comando agendado desta aldeia;
// - zero timers persistentes: o heartbeat de 30s (e o boot da página — a
//   confirmação recém-aberta mira na hora) chama o ciclo; as miras dormem
//   DENTRO da promise (teto < TTL do lock) revalidando pausa/terminal.

import { z } from 'zod';
import { alert } from '../tsh-alerts';
import { registerTsh, releaseTshLock, renewTshLock, tshTabId, type TshAutomation, type TshCycleContext } from '../tsh-runtime';
import { awaitRoutineMutation } from '../tsh-humanize';
import {
  cancelGameCommandsAtTarget,
  clickCommandConfirmNow,
  commandConfirmScreenState,
  isUncertainMutationError,
  normalizeVillageId,
  nativeTrainMatches,
  prearmCommandStep1,
  prepareNativeTrain,
  readNativeTrainFromScreen,
} from '../tsh-transport';
import { pacedGet } from '../../../core/net';
import {
  activeSchedulerCommandRecords,
  deriveSchedulerCommandStatus,
  type HubSchedulerState,
  type ScheduledCommandRecord,
  type ScheduledCommandStatus,
  type SchedulerTimingStrategy,
} from '../../../ext/core/scheduler-state';
import { laneForSchedulerRecord } from '../../../ext/core/humanize/humanize-policy';
import {
  clockInfo,
  ensureClockCalibrated,
  recordArrivalFeedback,
  serverNowMs,
  waitUntilServerMs,
} from '../../../core/game-clock';
import { matchArrival, parseArrivalText, plausibleLatency, type ArrivalRow } from '../../../ext/core/timing/arrival-feedback';
import { pageWindow } from '../../../core/page';
import {
  MAX_PREARM_ATTEMPTS,
  PREARM_EVENT_DETAIL,
  clockLabelMs,
  decideConfirmAction,
  decidePrearm,
  latencyCompensationMs,
  prearmAttempts,
} from '../../../ext/core/timing/precise-fire';
import type { ScheduledCommand, UnitType } from '../../../ext/modules/shared/module-types';
import { fnv1a64 } from '../../../ext/modules/shared/canonical-ids';
import { openSchedulerCommands, resolvePercentUnits } from '../tsh-commands-ui';

// ── Fábrica de comandos (usada pela UI "Comandos"; formato EXATO do motor) ──

export interface NewScheduledCommandInput {
  kind: ScheduledCommandRecord['kind'];
  sourceVillageId: string;
  sourceName?: string;
  source?: { x: number; y: number };
  target: { x: number; y: number };
  targetName?: string;
  targetPoints?: number;
  units: Partial<Record<UnitType, number>>;
  timingMode: 'arrival' | 'send';
  /** Estratégia de envio (Onda 1); ausente = `'direto'`. */
  timingStrategy?: SchedulerTimingStrategy;
  /** ISO 8601, hora do SERVIDOR, segundos. */
  sendAt: string;
  arrivalAt?: string;
  // --- Onda 1 (todos opcionais: registro antigo continua idêntico) ---
  cancelCount?: number;
  sequentialCount?: number;
  forced?: boolean;
  catapultTarget?: string;
  percentMode?: boolean;
  unitsPercent?: Partial<Record<string, number>>;
  /** Onda E: ataques adicionais do trem nativo (#2..#5). */
  trainUnits?: ReadonlyArray<Partial<Record<UnitType, number>>>;
  /** Texto do primeiro evento (o que o plano pediu — aparece na lista/histórico). */
  detail?: string;
}

/** Cria um ScheduledCommandRecord (id canônico cid_<fnv1a64>, pausado=false). */
export function createScheduledCommand(input: NewScheduledCommandInput): ScheduledCommandRecord {
  const { detail, ...fields } = input;
  // O percentual entra no id canônico (duas séries em % no mesmo horário não são
  // o mesmo comando); registro sem percentual mantém o id de sempre.
  const percentKey = input.percentMode === true ? `|${JSON.stringify(input.unitsPercent ?? {})}` : '';
  // Trem nativo entra no id (mesmo #1 com adicionais diferentes = outro comando).
  const trainKey = input.trainUnits !== undefined ? `|train${JSON.stringify(input.trainUnits)}` : '';
  const canonical = `${input.kind}|${input.sourceVillageId}|${input.target.x}|${input.target.y}|${input.sendAt}|${JSON.stringify(input.units)}${percentKey}${trainKey}`;
  const at = new Date().toISOString();
  return {
    ...fields,
    id: `cid_${fnv1a64(canonical)}`,
    paused: false,
    createdAt: at,
    events: [{ status: 'agendado', at, ...(detail !== undefined ? { detail } : {}) }],
  };
}

const UNIT_TYPES: readonly UnitType[] = [
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
];

const SCHEDULER_STORAGE_KEY = 'scheduler';
/** Teto da mira: sempre < TTL do lock de aba (2min) — nunca segura o módulo. */
const AIM_MAX_WAIT_MS = 60_000;

const schedulerSettings = z.object({
  focusLeadMs: z.number().int().min(5000).max(120000).default(15000),
  allowLateMs: z.number().int().min(0).max(5000).default(250),
  autoSend: z.boolean().default(true),
  // Onda A — precisão: antecedência do pré-arme (abre a confirmação antes do
  // horário) e compensação de latência do clique final.
  prearmLeadMs: z.number().int().min(3000).max(60000).default(8000),
  latencyMode: z.enum(['auto', 'manual']).default('auto'),
  latencyManualMs: z.number().int().min(0).max(400).default(0),
});

type SchedulerSettings = z.infer<typeof schedulerSettings>;

/** Defaults do Agendador (mesmos do schema; expostos para o formulário do painel). */
export const DEFAULT_SETTINGS: SchedulerSettings = {
  focusLeadMs: 15000,
  allowLateMs: 250,
  autoSend: true,
  prearmLeadMs: 8000,
  latencyMode: 'auto',
  latencyManualMs: 0,
};

// ---------------------------------------------------------------------------
// Proteção de fakes (porta mínima do game-data da extensão; br142: 2%).
// ---------------------------------------------------------------------------

/** Limite de fakes do mundo canário br142 (fração dos pontos da aldeia ALVO). */
export const FAKE_LIMIT_FRACTION = 0.02;

// P2 (revisão Onda 6): o limite REAL vem do mundo (interface.php?func=get_config,
// tag <fake_limit> em %) — como o game-data da origem. Mundo sem valor conhecido
// = 0 = SEM checagem (fail-open da origem); o 2% fixo travava mundos ≠ br142.
let cachedFakeFraction: number | null = null;

export async function worldFakeLimitFraction(): Promise<number> {
  if (cachedFakeFraction !== null) return cachedFakeFraction;
  try {
    const doc = new DOMParser().parseFromString(await pacedGet('/interface.php?func=get_config'), 'text/xml');
    if (doc.querySelector('parsererror') === null) {
      const raw = Number((doc.querySelector('fake_limit')?.textContent ?? '').trim().replace(',', '.'));
      if (Number.isFinite(raw) && raw > 0) {
        cachedFakeFraction = raw / 100;
        return cachedFakeFraction;
      }
    }
  } catch {
    /* get_config inacessível → fail-open (sem checagem) */
  }
  cachedFakeFraction = 0;
  return 0;
}

/** População consumida por unidade (padrão Tribal Wars). */
export const UNIT_POPULATION: Record<UnitType, number> = {
  spear: 1,
  sword: 1,
  axe: 1,
  archer: 1,
  spy: 2,
  light: 4,
  marcher: 5,
  heavy: 6,
  ram: 5,
  catapult: 8,
  knight: 10,
  snob: 100,
};

/** População total de um conjunto de unidades. */
export function commandPopulation(units: Partial<Record<UnitType, number>>): number {
  return Object.entries(units).reduce(
    (total, [unit, amount]) => total + (UNIT_POPULATION[unit as UnitType] ?? 0) * (amount ?? 0),
    0,
  );
}

/** População mínima de um ataque que respeita o limite de fakes (fração do mundo). */
export function minimumAttackPopulation(targetPoints: number, fraction: number = FAKE_LIMIT_FRACTION): number {
  return Math.ceil(targetPoints * fraction);
}

// ---------------------------------------------------------------------------
// Lógica pura do ciclo (testável).
// ---------------------------------------------------------------------------

/** Comando dentro da janela de envio (lead/late do original). */
export function commandInSendWindow(
  command: Pick<ScheduledCommand, 'sendAt'>,
  nowMs: number,
  window: { focusLeadMs: number; allowLateMs: number },
): boolean {
  const sendAt = Date.parse(command.sendAt);
  return Number.isFinite(sendAt) && sendAt <= nowMs + window.focusLeadMs && sendAt >= nowMs - window.allowLateMs;
}

/** Acrescenta um evento de status a um comando do estado (inaltera ausente). */
export function appendSchedulerEvent(
  state: HubSchedulerState,
  commandId: string,
  status: ScheduledCommandStatus,
  at: string,
  detail?: string,
): HubSchedulerState {
  return {
    ...state,
    commands: state.commands.map((command) =>
      command.id === commandId
        ? { ...command, events: [...command.events, { status, at, ...(detail !== undefined ? { detail } : {}) }] }
        : command,
    ),
  };
}

interface PendingCommandConfirmation {
  kind: 'attack' | 'support';
  target?: { x: number; y: number };
  units?: Partial<Record<UnitType, number>>;
}

/**
 * Casa uma confirmação pendente com o comando esperado (porta do matcher da
 * extensão): kind + coordenada + unidades 1:1. Ilegível → false (nunca
 * confirma às cegas).
 */
export function matchesPendingCommandConfirmation(
  pending: PendingCommandConfirmation | undefined,
  expected: { kind: 'attack' | 'support'; target: { x: number; y: number }; units: Partial<Record<UnitType, number>> },
): boolean {
  if (pending?.target === undefined) return false;
  if (pending.kind !== expected.kind) return false;
  if (pending.target.x !== expected.target.x || pending.target.y !== expected.target.y) return false;
  if (pending.units === undefined) return false;
  for (const [unit, amount] of Object.entries(expected.units)) {
    if (pending.units[unit as UnitType] !== amount) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Leitura da tela.
// ---------------------------------------------------------------------------

function parseGameInteger(value: string | null | undefined): number {
  if (!value) return 0;
  const normalized = value.trim().replace(/\s/g, '');
  const brazilian = normalized.replace(/\./g, '').replace(',', '.');
  const parsed = Number(brazilian.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

/**
 * "Agora" na perspectiva do servidor — relógio de precisão (core/game-clock:
 * medição HTTP/Timing do jogo/tela, a de menor incerteza). O parâmetro fica
 * pela compatibilidade das chamadas.
 */
function readServerNow(doc: Document): Date {
  void doc;
  return new Date(serverNowMs());
}

/** Confirmação pendente na Praça (tela try=confirm) — leitura defensiva. */
function readPendingCommandConfirmation(doc: Document): PendingCommandConfirmation | undefined {
  const form = doc.querySelector<HTMLFormElement>(
    'form#command-data-form[action*="action=command"], form[action*="screen=place"][action*="action=command"]',
  );
  if (form === null) return undefined;
  if (form.querySelector('input[name="submit_confirm"], input.troop_confirm_go') === null) return undefined;
  const kind: 'attack' | 'support' = form.querySelector('input[name="support"]') !== null ? 'support' : 'attack';
  const xInput = form.querySelector<HTMLInputElement>('input[name="x"]');
  const yInput = form.querySelector<HTMLInputElement>('input[name="y"]');
  const units: Partial<Record<UnitType, number>> = {};
  let hasUnits = false;
  for (const unit of UNIT_TYPES) {
    const input = form.querySelector<HTMLInputElement>(`input[name="${unit}"]`);
    if (input === null) continue;
    units[unit] = parseGameInteger(input.value);
    hasUnits = true;
  }
  return {
    kind,
    ...(xInput !== null && yInput !== null
      ? { target: { x: parseGameInteger(xInput.value), y: parseGameInteger(yInput.value) } }
      : {}),
    ...(hasUnits ? { units } : {}),
  };
}

function transportCommandKind(kind: ScheduledCommand['kind']): 'attack' | 'support' {
  return kind === 'support' ? 'support' : 'attack';
}

/**
 * Tropas DISPONÍVEIS na aldeia aberta, lidas da Praça de Reunião:
 * 1. tabela de tropas da aldeia (`#units_home .unit-item-<unit>[data-unit-count]`
 *    — a MESMA leitura já provada pelo auto-farm);
 * 2. fallback: contagem da própria linha do `input[name=<unit>]` (link/data-all).
 * Nenhuma unidade legível = `undefined` (fail-closed: o percentual NUNCA vira
 * um envio às cegas).
 */
function readAvailableUnits(doc: Document): Partial<Record<UnitType, number>> | undefined {
  const units: Partial<Record<UnitType, number>> = {};
  let readable = 0;
  for (const unit of UNIT_TYPES) {
    const cell = doc.querySelector<HTMLElement>(`#units_home .unit-item-${unit}[data-unit-count]`);
    if (cell !== null) {
      units[unit] = parseGameInteger(cell.dataset.unitCount);
      readable += 1;
      continue;
    }
    const input = doc.querySelector<HTMLInputElement>(`input[name="${unit}"]`);
    if (input === null) continue;
    const row = input.closest('tr') ?? input.parentElement;
    const entry = row?.querySelector<HTMLElement>('.units-entry-all, [data-unit-count]') ?? null;
    const count = Math.max(
      parseGameInteger(input.getAttribute('data-all')),
      parseGameInteger(entry?.textContent ?? null),
    );
    if (count <= 0) continue;
    units[unit] = count;
    readable += 1;
  }
  return readable === 0 ? undefined : units;
}

function readSchedulerState(ctx: TshCycleContext): HubSchedulerState {
  return ctx.storage.get<HubSchedulerState>(SCHEDULER_STORAGE_KEY, { commands: [], transit: [] });
}

function commandUnitsRecord(command: { units: Partial<Record<UnitType, number>> }): Record<string, number> {
  const units: Record<string, number> = {};
  // P3 (revisão Onda 6): chaves filtradas pela whitelist de unidades — o valor
  // é interpolado em seletores de input; chave inválida nunca chega lá.
  const valid = new Set<string>(UNIT_TYPES);
  for (const [unit, amount] of Object.entries(command.units)) {
    if (valid.has(unit) && (amount ?? 0) > 0) units[unit] = amount ?? 0;
  }
  return units;
}

const TERMINAL_COMMAND_STATUSES: ReadonlySet<string> = new Set(['enviado', 'incerto', 'falhou', 'removido']);

/** Fato terminal persistido (enviado/incerto/falhou/removido) — nunca rederivado pelo relógio. */
function hasTerminalEvent(record: ScheduledCommandRecord): boolean {
  return record.events.some((event) => TERMINAL_COMMAND_STATUSES.has(event.status));
}

/**
 * Registros que ESTE ciclo pode disparar: ativos pelo relógio (pausa e fatos
 * terminais respeitados) MAIS os `forced` sem fato terminal — o forçado é
 * justamente o que o relógio já marcaria como "falhou" (partida atrasada) e
 * ainda assim deve sair.
 */
export function schedulableSchedulerRecords(
  state: HubSchedulerState,
  villageId: string,
  now: Date,
  window: { focusLeadMs: number; allowLateMs: number },
): ScheduledCommandRecord[] {
  const normalized = normalizeVillageId(villageId);
  const active = activeSchedulerCommandRecords(state, now, window);
  const activeIds = new Set(active.map((record) => record.id));
  const forced = state.commands.filter(
    (record) =>
      record.forced === true &&
      !record.paused &&
      !activeIds.has(record.id) &&
      !hasTerminalEvent(record) &&
      normalizeVillageId(record.sourceVillageId) === normalized,
  );
  return [...active, ...forced].filter((record) => normalizeVillageId(record.sourceVillageId) === normalized);
}

/**
 * Comando dentro da janela de envio. `forced` aceita ATRASO (o operador
 * assumiu o risco ao marcar "agendar mesmo impossível"): basta o horário ter
 * chegado — a checagem de atraso normal continua valendo para os demais.
 */
export function recordInSendWindow(
  record: Pick<ScheduledCommandRecord, 'sendAt' | 'forced'>,
  nowMs: number,
  window: { focusLeadMs: number; allowLateMs: number },
): boolean {
  const sendAt = Date.parse(record.sendAt);
  if (!Number.isFinite(sendAt)) return false;
  if (record.forced === true) return sendAt <= nowMs + window.focusLeadMs;
  return commandInSendWindow(record, nowMs, window);
}

/** Comando ainda disparável depois da mira (não pausado, sem status terminal). */
export function stillFirable(
  record: ScheduledCommandRecord | undefined,
  window: { focusLeadMs: number; allowLateMs: number },
  now: Date,
): boolean {
  if (record === undefined || record.paused) return false;
  const status = deriveSchedulerCommandStatus(record, now, window);
  // "falhou" derivado do RELÓGIO não é fato para comando forçado: só um evento
  // terminal (enviado/incerto/falhou/removido) aborta o disparo forçado.
  if (status === 'falhou' && record.forced === true) return !hasTerminalEvent(record);
  return !TERMINAL_COMMAND_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// P1-1 (revisão de marco): Envio automático DESLIGADO segura o disparo.
// ---------------------------------------------------------------------------

export type AutoSendHoldDecision = 'fire' | 'hold' | 'expired';

/**
 * O que o Envio automático desligado faz com um comando que SERIA disparado
 * agora: `fire` = autoSend ligado (segue o fluxo normal), `hold` = nada é
 * enviado e o comando continua vivo (reavaliado a cada heartbeat), `expired` =
 * a janela de atraso venceu com o comando segurado — o relógio já o mostraria
 * "falhou" e o hold só pode terminar assim (nunca dispara depois do vencimento).
 * `forced` aceita atraso por definição (risco assumido ao agendar): não vence.
 */
export function shouldHoldForAutoSend(
  settings: { autoSend: boolean },
  record: Pick<ScheduledCommandRecord, 'sendAt' | 'forced'>,
  nowMs: number,
  window: { focusLeadMs: number; allowLateMs: number },
): AutoSendHoldDecision {
  if (settings.autoSend) return 'fire';
  const sendAt = Date.parse(record.sendAt);
  // sendAt ilegível: o gate de janela já falha fechado — não há o que segurar.
  if (!Number.isFinite(sendAt)) return 'fire';
  if (record.forced === true) return 'hold';
  return nowMs > sendAt + window.allowLateMs ? 'expired' : 'hold';
}

/** Prefixo do evento de hold (status 'janela', não-terminal) — reconhece o segurado em ciclos posteriores. */
export const AUTO_SEND_HOLD_DETAIL = 'Envio automático desligado — comando segurado';

/** Registro já segurado pelo Envio automático desligado (evento de hold presente). */
function wasHeldForAutoSend(record: ScheduledCommandRecord): boolean {
  return record.events.some(
    (event) => event.status === 'janela' && (event.detail ?? '').startsWith(AUTO_SEND_HOLD_DETAIL),
  );
}

/**
 * Comandos desta aldeia que ficaram SEGURADOS pelo Envio automático desligado e
 * cuja janela de atraso venceu: viram fato terminal 'falhou' (motivo autoSend)
 * — o hold nunca dispara depois do vencimento, nem ao religar o Envio
 * automático. Sem evento de hold o registro não entra: um comando que o módulo
 * nunca viu devido não ganha um motivo que não é dele.
 */
export function autoSendExpiredHeldRecords(
  state: HubSchedulerState,
  villageId: string,
  nowMs: number,
  window: { focusLeadMs: number; allowLateMs: number },
): ScheduledCommandRecord[] {
  const normalized = normalizeVillageId(villageId);
  return state.commands.filter(
    (record) =>
      normalizeVillageId(record.sourceVillageId) === normalized &&
      !record.paused &&
      !hasTerminalEvent(record) &&
      wasHeldForAutoSend(record) &&
      // A decisão é a MESMA do caminho principal, avaliada como "autoSend off".
      shouldHoldForAutoSend({ autoSend: false }, record, nowMs, window) === 'expired',
  );
}

/** Horário do sendAt (HH:MM:SS do relógio do servidor) para mensagens. */
function sendAtClockLabel(record: Pick<ScheduledCommandRecord, 'sendAt'>): string {
  const sendAt = Date.parse(record.sendAt);
  return Number.isFinite(sendAt) ? new Date(sendAt).toISOString().slice(11, 19) : '?';
}

/** Comando devido mais antigo (menor sendAt) entre os disparáveis desta aldeia. */
function earliestDueRecord(
  own: readonly ScheduledCommandRecord[],
  nowMs: number,
  window: { focusLeadMs: number; allowLateMs: number },
): ScheduledCommandRecord | undefined {
  return own
    .filter((record) => recordInSendWindow(record, nowMs, window))
    .sort((left, right) => Date.parse(left.sendAt) - Date.parse(right.sendAt))[0];
}

/**
 * Unidades que o disparo vai enviar. Percentual (`percentMode`) é resolvido
 * AGORA, contra as tropas atuais da aldeia de origem: o comando em % só dispara
 * com a Praça da aldeia de origem aberta e com as tropas legíveis — qualquer
 * outra situação aborta sem evento terminal (fail-closed, nada é enviado).
 * `undefined` = abortado (o status já foi publicado).
 */
async function resolveFireUnits(
  ctx: TshCycleContext,
  record: ScheduledCommandRecord,
): Promise<Record<string, number> | undefined> {
  const frozen = commandUnitsRecord(record);
  if (record.percentMode !== true) return frozen;
  if (normalizeVillageId(record.sourceVillageId) !== normalizeVillageId(ctx.villageId)) {
    ctx.status(
      `Comando ${record.id} em percentual: é preciso estar na aldeia de origem (${record.sourceName ?? record.sourceVillageId}) para ler as tropas — envio abortado.`,
      'warn',
    );
    return undefined;
  }
  const available = readAvailableUnits(document);
  if (available === undefined) {
    ctx.status(
      `Comando ${record.id} em percentual: não foi possível ler as tropas disponíveis nesta tela (abra a Praça da aldeia de origem) — envio abortado.`,
      'warn',
    );
    return undefined;
  }
  const resolved = commandUnitsRecord({ units: resolvePercentUnits(record.unitsPercent ?? {}, available) });
  if (Object.keys(resolved).length === 0) {
    ctx.status(
      `Comando ${record.id} em percentual resultou em zero unidades (tropas da aldeia insuficientes?) — envio abortado.`,
      'warn',
    );
    return undefined;
  }
  return resolved;
}

// Guarda de re-entrância: com a mira (sleep), o heartbeat seguinte tentaria
// rodar um 2º ciclo concorrente do mesmo módulo na MESMA aba — o lock de aba
// não protege contra isso (mesma tab id).
let cycleInFlight = false;

/**
 * Cancelamento Cronometrado (Onda 1): no instante `sendAt`, cancela até
 * `cancelCount` comandos PRÓPRIOS com destino ao alvo. Mesma janela/mira do
 * envio; o transporte já é faixa de PRECISÃO (sem humanização). O resumo
 * (cancelados/falhas) vira o detalhe do evento terminal.
 *
 * P2-2 (revisão): a Visão de Comandos é PRÉ-LIDA durante a mira (leitura na
 * fila normal) e o disparo recebe o HTML pronto — no instante sendAt só os
 * POSTs de cancelamento ocupam a fila urgente.
 */
interface CancelPreread {
  readonly target: string;
  readonly html: string;
  readonly at: number;
}

let cancelPreread: CancelPreread | null = null;
const CANCEL_PREREAD_TTL_MS = 45_000;

function freshCancelPreread(target: string, nowMs: number): string | undefined {
  if (cancelPreread === null || cancelPreread.target !== target) return undefined;
  return nowMs - cancelPreread.at <= CANCEL_PREREAD_TTL_MS ? cancelPreread.html : undefined;
}

/** Pré-leitura otimista: falha silenciosa — o transporte busca no disparo. */
async function prereadCancelPage(ctx: TshCycleContext, target: string): Promise<void> {
  try {
    const html = await pacedGet(
      `/game.php?village=${normalizeVillageId(ctx.villageId)}&screen=overview_villages&mode=commands&page=-1`,
      { fresh: true },
    );
    cancelPreread = { target, html, at: Date.now() };
  } catch {
    // otimização: sem pré-leitura o disparo segue buscando (comportamento original)
  }
}

async function fireCancelCommand(ctx: TshCycleContext, record: ScheduledCommandRecord, target: string): Promise<void> {
  const count = record.cancelCount ?? 1;
  ctx.storage.set(
    SCHEDULER_STORAGE_KEY,
    appendSchedulerEvent(
      readSchedulerState(ctx),
      record.id,
      'enviando',
      new Date().toISOString(),
      `Cancelamento de até ${count} comando(s) com destino ${target} iniciado.`,
    ),
  );
  try {
    const preparsedHtml = freshCancelPreread(target, Date.now());
    const result = await cancelGameCommandsAtTarget(target, count, preparsedHtml);
    // Pré-canário: NENHUM cancelamento feito (cancelled 0) com falha de POST é
    // fato terminal 'falhou' — gravar 'enviado' aqui era um selo que mentia.
    // Misto (algum cancelado + falha) continua 'enviado', com o detalhe.
    const allFailed = result.cancelled === 0 && result.failed > 0;
    ctx.storage.set(
      SCHEDULER_STORAGE_KEY,
      appendSchedulerEvent(
        readSchedulerState(ctx),
        record.id,
        allFailed ? 'falhou' : 'enviado',
        new Date().toISOString(),
        result.message,
      ),
    );
    if (allFailed) {
      alert('comando_falhou', `Cancelamento em ${target} (comando ${record.id}) falhou: ${result.message}`);
    }
    ctx.status(`Cancelamento em ${target}: ${result.message}`, result.failed > 0 ? 'warn' : 'ok');
  } catch (error) {
    if (isUncertainMutationError(error)) {
      clearPrearm(ctx, record.id);
      ctx.storage.set(
        SCHEDULER_STORAGE_KEY,
        appendSchedulerEvent(
          readSchedulerState(ctx),
          record.id,
          'incerto',
          new Date().toISOString(),
          error instanceof Error ? error.message : String(error),
        ),
      );
      ctx.status(
        `Cancelamento em ${target} INCERTO: ${error instanceof Error ? error.message : String(error)} — releia o Visão de Comandos antes de nova tentativa.`,
        'warn',
      );
      return;
    }
    // Falha PRÉ-mutação (alvo inválido/rede): nenhum evento terminal — a janela
    // segue aberta para o próximo ciclo (fail-closed, sem retry cego).
    throw error;
  }
}

/**
 * P1-1 (revisão de marco): Envio automático DESLIGADO — nada é enviado no
 * caminho principal (antes o gate só existia no ramo da confirmação pendente e
 * a mira disparava assim mesmo, contradizendo a ajuda do painel).
 *
 * Semântica: o comando devido PERMANECE segurado, sem evento terminal, e é
 * reavaliado a cada heartbeat — religar o Envio automático dentro da janela o
 * dispara; a janela vencida (fora do allowLateMs; `forced` não vence) vira o
 * fato 'falhou' com o motivo. O hold é gravado UMA vez por comando (evento
 * 'janela', não-terminal — não há status novo) e o status do ciclo repete a
 * instrução para o operador.
 */
function holdSchedulerCommands(
  ctx: TshCycleContext,
  state: HubSchedulerState,
  own: readonly ScheduledCommandRecord[],
  pending: PendingCommandConfirmation | undefined,
  now: Date,
  window: { focusLeadMs: number; allowLateMs: number },
): void {
  const nowMs = now.getTime();
  for (const record of autoSendExpiredHeldRecords(state, ctx.villageId, nowMs, window)) {
    ctx.storage.set(
      SCHEDULER_STORAGE_KEY,
      appendSchedulerEvent(
        readSchedulerState(ctx),
        record.id,
        'falhou',
        new Date().toISOString(),
        `${AUTO_SEND_HOLD_DETAIL} e a janela de envio venceu — nada foi enviado.`,
      ),
    );
    ctx.status(
      `Comando ${record.id} segurado pelo Envio automático desligado e a janela (${sendAtClockLabel(record)}) venceu — marcado como falhou, nada foi enviado.`,
      'warn',
    );
    alert(
      'comando_falhou',
      `Comando ${record.id} para ${record.target.x}|${record.target.y} venceu segurado (Envio automático desligado) — nada foi enviado.`,
    );
  }

  const held = own.filter(
    (record) =>
      recordInSendWindow(record, nowMs, window) &&
      shouldHoldForAutoSend({ autoSend: false }, record, nowMs, window) === 'hold',
  );
  if (held.length === 0) {
    ctx.status(
      pending !== undefined
        ? 'Envio automático desativado: confirme o comando manualmente na tela aberta.'
        : 'Envio automático desativado — nada é enviado enquanto estiver desligado.',
      'info',
    );
    return;
  }
  for (const record of held) {
    if (!wasHeldForAutoSend(record)) {
      ctx.storage.set(
        SCHEDULER_STORAGE_KEY,
        appendSchedulerEvent(
          readSchedulerState(ctx),
          record.id,
          'janela',
          new Date().toISOString(),
          `${AUTO_SEND_HOLD_DETAIL} no horário ${sendAtClockLabel(record)}; ligue o Envio automático para enviar.`,
        ),
      );
    }
    ctx.status(
      `Envio automático desligado — comando ${record.id} segurado no horário ${sendAtClockLabel(record)}; ligue o Envio automático para enviar.`,
      'warn',
    );
  }
}

async function runCycle(ctx: TshCycleContext): Promise<void> {
  if (cycleInFlight) return; // mira em andamento: não empilha ciclo
  cycleInFlight = true;
  try {
    await runCycleGuarded(ctx);
  } finally {
    cycleInFlight = false;
  }
}

async function runCycleGuarded(ctx: TshCycleContext): Promise<void> {
  const parsed = schedulerSettings.safeParse(ctx.storage.get('settings', DEFAULT_SETTINGS));
  if (!parsed.success) {
    ctx.status('Configurações do Agendador inválidas — nada foi feito. Revise focusLeadMs/allowLateMs/autoSend.', 'warn');
    return;
  }
  const settings: SchedulerSettings = parsed.data;
  const state = readSchedulerState(ctx);
  if (state.commands.length === 0) {
    ctx.status('Nenhum comando agendado (estado vazio).', 'info');
    return;
  }
  const now = readServerNow(document);
  const windowCfg = { focusLeadMs: settings.focusLeadMs, allowLateMs: settings.allowLateMs };
  const records = activeSchedulerCommandRecords(state, now, windowCfg);
  // Onda 1: `forced` entra mesmo já atrasado (o relógio o marcaria "falhou");
  // o resto segue a janela normal.
  const own = schedulableSchedulerRecords(state, ctx.villageId, now, windowCfg);
  const pending = readPendingCommandConfirmation(document);

  // P1-1 (revisão): Envio automático desligado SEGURA o disparo — o caminho
  // principal nunca envia com o toggle desligado (o hold/vencimento é o único
  // efeito do ciclo).
  if (!settings.autoSend) {
    holdSchedulerCommands(ctx, state, own, pending, now, windowCfg);
    return;
  }

  // P3 (revisão): o comando devido é escolhido ANTES do early-return da
  // confirmação pendente — o cancelamento cronometrado NÃO usa a Praça e não
  // pode esperar por uma confirmação aberta de outro comando.
  const dueAtRead = earliestDueRecord(own, now.getTime(), windowCfg);

  // Calibração do relógio (Onda A): com cravado desta aldeia nos próximos
  // 30 min, garante medição HTTP recente — sem bloquear o ciclo.
  const nextOwnSendAt = own
    .map((record) => Date.parse(record.sendAt))
    .filter((sendAt) => Number.isFinite(sendAt) && sendAt >= now.getTime())
    .sort((left, right) => left - right)[0];
  if (nextOwnSendAt !== undefined && nextOwnSendAt - now.getTime() <= 30 * 60_000) {
    void ensureClockCalibrated();
  }
  // Onda E: confere chegadas reais de envios anteriores (autocalibração).
  if (pending === undefined) await verifyArrivals(ctx, nextOwnSendAt);

  // Passo 2 (tela de confirmação aberta — normalmente pelo PRÉ-ARME): só
  // confirma quando CASA com um comando agendado desta aldeia; a MIRA de
  // precisão espera o ms planejado (nunca clica antes da hora).
  if (pending !== undefined && dueAtRead?.kind !== 'cancel') {
    await handlePendingConfirmation(ctx, state, own, pending, settings);
    return;
  }

  // Passo 1: comando dentro da janela de envio (mais antigo primeiro).
  let due = dueAtRead;
  if (due === undefined) {
    const nextSendAt = own
      .map((record) => Date.parse(record.sendAt))
      .filter((sendAt) => Number.isFinite(sendAt))
      .sort((left, right) => left - right)[0];
    const anyVillageDue = records.some((record) => recordInSendWindow(record, now.getTime(), windowCfg));
    // MIRA ANTECIPADA (Onda 9): tick de 30s × janela de focusLeadMs — o
    // próximo comando desta aldeia chegando em ≤90s faz o ciclo DORMIR até a
    // janela abrir e rederivá-lo (pausa/terminal respeitados na rederivação).
    if (!anyVillageDue && nextSendAt !== undefined) {
      const opensAt = nextSendAt - settings.focusLeadMs;
      const waitMs = opensAt - now.getTime();
      if (waitMs > 0 && waitMs <= 90_000) {
        ctx.status(
          `Próximo comando desta aldeia em ${Math.max(0, Math.round((nextSendAt - now.getTime()) / 1000))}s — aguardando a janela…`,
          'info',
        );
        // P2-2 (revisão): cancelamento chegando — pré-lê a Visão de Comandos
        // AGORA (fila normal, sem aguardar) para que no sendAt só os POSTs
        // urgentes corram.
        const proximo = own
          .filter((record) => Number.isFinite(Date.parse(record.sendAt)) && Date.parse(record.sendAt) === nextSendAt)
          .find((record) => record.kind === 'cancel');
        if (proximo !== undefined) {
          void prereadCancelPage(ctx, `${proximo.target.x}|${proximo.target.y}`);
        }
        void ensureClockCalibrated();
        await waitUntilServerMs(opensAt);
        // P2 (revisão Onda 9): renova o lock após o sono longo.
        renewTshLock('command-scheduler', ctx.world);
        const stateAfterWait = readSchedulerState(ctx);
        const nowAfter = readServerNow(document);
        due = schedulableSchedulerRecords(stateAfterWait, ctx.villageId, nowAfter, windowCfg)
          .filter((record) => recordInSendWindow(record, nowAfter.getTime(), windowCfg))
          .sort((left, right) => Date.parse(left.sendAt) - Date.parse(right.sendAt))[0];
      }
    }
    if (due === undefined) {
      if (anyVillageDue) {
        ctx.status('Um comando de OUTRA aldeia está na janela — abra a Praça da aldeia de origem para enviá-lo.', 'info');
      } else {
        ctx.status(
          nextSendAt === undefined
            ? 'Nenhum comando está dentro da janela de envio.'
            : `Próximo envio desta aldeia em ${Math.max(0, Math.round((nextSendAt - now.getTime()) / 1000))}s.`,
          'info',
        );
      }
      return;
    }
  }

  // Unidades do disparo: percentual é resolvido AGORA contra as tropas da
  // aldeia de origem (fail-closed: sem leitura, nada é enviado).
  const fireUnits = await resolveFireUnits(ctx, due);
  if (fireUnits === undefined) return;

  // FAKE protection: ataque/fake com pontos do alvo precisa de população
  // mínima (fração do mundo via get_config; mundo sem limite = sem checagem).
  if ((due.kind === 'attack' || due.kind === 'fake') && due.targetPoints !== undefined) {
    const fraction = await worldFakeLimitFraction();
    if (fraction > 0) {
      const minimum = minimumAttackPopulation(due.targetPoints, fraction);
      const population = commandPopulation(fireUnits);
      if (population < minimum) {
        const percent = `${Math.round(fraction * 1000) / 10}%`;
        ctx.status(
          `População do ataque (${population}) abaixo do limite de fakes do mundo (${minimum} = ${percent} dos pontos do alvo).`,
          'warn',
        );
        return;
      }
    }
  }

  // Cancelamento cronometrado: não usa a Praça — mira de precisão até o ms
  // planejado (menos a compensação de latência) e dispara os POSTs.
  if (due.kind === 'cancel') {
    const compensation = currentCompensationMs(settings, true);
    const fireAt = Date.parse(due.sendAt) - compensation;
    const deltaMs = fireAt - serverNowMs();
    if (deltaMs > AIM_MAX_WAIT_MS) {
      ctx.status(`Comando ${due.id} vence em ${Math.round(deltaMs / 1000)}s — próximo ciclo mira o envio.`, 'info');
      return;
    }
    if (deltaMs > 0) {
      ctx.status(
        `Cancelamento ${due.id} na mira: dispara às ${clockLabelMs(fireAt)}${hiddenTabNote()}.`,
        'info',
      );
      renewTshLock('command-scheduler', ctx.world);
      const dueId = due.id;
      const ok = await waitUntilServerMs(
        fireAt,
        () => !stillFirable(findRecord(ctx, dueId), windowCfg, readServerNow(document)),
        { precise: true },
      );
      const record = findRecord(ctx, dueId);
      if (!ok || !stillFirable(record, windowCfg, readServerNow(document))) {
        ctx.status(`Comando ${dueId} foi pausado/concluído durante a mira — cancelamento abortado.`, 'info');
        return;
      }
    }
    await fireCancelCommand(ctx, due, `${due.target.x}|${due.target.y}`);
    // P2 (revisão Onda A): uma confirmação pré-aberta na mesma tela não pode
    // ficar órfã por causa do cancelamento — segue para a mira dela.
    if (pending !== undefined) {
      const stateAfter = readSchedulerState(ctx);
      const nowAfter = readServerNow(document);
      await handlePendingConfirmation(
        ctx,
        stateAfter,
        schedulableSchedulerRecords(stateAfter, ctx.villageId, nowAfter, windowCfg),
        pending,
        settings,
      );
    }
    return;
  }

  // PRÉ-ARME (Onda A): abre a tela de confirmação `prearmLeadMs` antes do
  // horário; o clique final acontece na mira de precisão (aimAndConfirm).
  const attempts = prearmAttempts(due.events);
  if (attempts >= MAX_PREARM_ATTEMPTS) {
    ctx.storage.set(
      SCHEDULER_STORAGE_KEY,
      appendSchedulerEvent(
        readSchedulerState(ctx),
        due.id,
        'falhou',
        new Date().toISOString(),
        `A tela de confirmação não abriu após ${attempts} tentativas (tropas insuficientes, alvo inválido ou erro do jogo) — nada foi enviado.`,
      ),
    );
    ctx.status(`Comando ${due.id}: a tela de confirmação não abriu — marcado como falhou (nada foi enviado).`, 'warn');
    alert('comando_falhou', `Comando ${due.id} para ${due.target.x}|${due.target.y}: a confirmação não abriu — nada foi enviado.`);
    return;
  }
  // Faixa humanizada (fakes): sem pré-arme antecipado — o passo 1 sai no
  // horário, pela porta de humanização (regra de ouro: só cravado é cravado).
  const dueLane = laneForSchedulerRecord(due);
  const prearmLead = dueLane === 'precisao' ? Math.min(settings.prearmLeadMs, settings.focusLeadMs) : 0;
  // Reivindicação entre abas (P1 revisão Onda A): outra aba já pré-armou este
  // comando há pouco — esta NÃO repete o passo 1 (evita envio duplicado).
  const claim = ctx.storage.get<PrearmRecord | null>(prearmKey(ctx.villageId), null);
  if (claim !== null && claim.id === due.id && claim.tab !== tshTabId() && Date.now() - claim.at < PREARM_CLAIM_TTL_MS) {
    ctx.status(`Comando ${due.id} já foi pré-armado por outra aba — aguardando a confirmação dela.`, 'info');
    return;
  }
  const decision = decidePrearm({ sendAtMs: Date.parse(due.sendAt), nowServerMs: serverNowMs(), prearmLeadMs: prearmLead });
  if (decision.kind === 'wait') {
    if (decision.inMs > AIM_MAX_WAIT_MS) {
      ctx.status(`Comando ${due.id} vence em ${Math.round(decision.inMs / 1000)}s — próximo ciclo prepara o envio.`, 'info');
      return;
    }
    ctx.status(
      `Comando ${due.id}: abrindo a confirmação em ${Math.ceil(decision.inMs / 1000)}s (envio às ${clockLabelMs(Date.parse(due.sendAt))}).`,
      'info',
    );
    renewTshLock('command-scheduler', ctx.world);
    void ensureClockCalibrated();
    const dueId = due.id;
    const ok = await waitUntilServerMs(
      Date.parse(due.sendAt) - prearmLead,
      () => !stillFirable(findRecord(ctx, dueId), windowCfg, readServerNow(document)),
      { precise: dueLane === 'precisao' && prearmLead === 0 },
    );
    if (!ok || !stillFirable(findRecord(ctx, dueId), windowCfg, readServerNow(document))) {
      ctx.status(`Comando ${dueId} foi pausado/concluído antes do pré-arme — nada foi feito.`, 'info');
      return;
    }
  }
  if (due.forced === true) {
    const lateMs = serverNowMs() - Date.parse(due.sendAt);
    if (lateMs > settings.allowLateMs) {
      ctx.status(
        `Comando ${due.id} FORÇADO: ${Math.round(lateMs / 1000)}s fora da janela — enviando mesmo assim (risco assumido ao agendar).`,
        'warn',
      );
    }
  }
  const target = `${due.target.x}|${due.target.y}`;
  const opts = commandOptionsFor(due);
  const dueId = due.id;
  const dueSendAt = Date.parse(due.sendAt);
  // Tudo que marca o pré-arme acontece NO instante do submit (depois da porta
  // de humanização e da fila urgente — P1/P2 revisão Onda A): a reivindicação
  // entre abas, o evento de tentativa e a liberação do lock para a página nova
  // (id de aba novo) mirar sem esperar o TTL.
  const beforeSubmit = (): void => {
    ctx.storage.set(prearmKey(ctx.villageId), {
      id: dueId,
      units: fireUnits,
      at: Date.now(),
      tab: tshTabId(),
    } satisfies PrearmRecord);
    ctx.storage.set(
      SCHEDULER_STORAGE_KEY,
      appendSchedulerEvent(
        readSchedulerState(ctx),
        dueId,
        'janela',
        new Date().toISOString(),
        `${PREARM_EVENT_DETAIL} (envio às ${clockLabelMs(dueSendAt)}).`,
      ),
    );
    releaseTshLock('command-scheduler', ctx.world);
  };
  const reachedHere = await prearmCommandStep1(target, fireUnits, opts, beforeSubmit);
  if (!reachedHere) {
    renewTshLock('command-scheduler', ctx.world); // não navegou: a aba retoma o lock
    throw new Error(
      'O passo 1 foi enviado, mas a tela de confirmação não apareceu neste contexto — o agendador tenta de novo no próximo ciclo (nenhuma tropa foi enviada).',
    );
  }
  renewTshLock('command-scheduler', ctx.world);
  await aimAndConfirm(ctx, due, fireUnits, settings);
}

// ---------------------------------------------------------------------------
// Onda A — mira de precisão na tela de confirmação.
// ---------------------------------------------------------------------------

/** Tropas resolvidas no pré-arme (casar a confirmação de comando em percentual) + reivindicação da aba. */
interface PrearmRecord {
  id: string;
  units: Record<string, number>;
  at: number;
  tab: string;
}

/** Uma aba reivindica o pré-arme por este tempo (outra aba não repete o passo 1). */
const PREARM_CLAIM_TTL_MS = 45_000;

/** Pré-arme por ALDEIA (P2 revisão Onda A: um slot único era sobrescrito entre aldeias). */
function prearmKey(villageId: string): string {
  return `prearm:${normalizeVillageId(villageId)}`;
}

function clearPrearm(ctx: TshCycleContext, recordId: string): void {
  const key = prearmKey(ctx.villageId);
  const current = ctx.storage.get<PrearmRecord | null>(key, null);
  if (current !== null && current.id === recordId) ctx.storage.set(key, null);
}

/**
 * Escolhe o comando que a tela de confirmação aberta representa (P1 revisão
 * Onda A): 1º o PRÉ-ARMADO desta aldeia (se a tela casa com ele); senão, entre
 * os que casam, o de horário MAIS PRÓXIMO do agora. Puro/testável.
 */
export function pickConfirmCandidate<T extends { id: string; sendAt: string }>(
  candidates: readonly T[],
  prearmedId: string | null,
  nowMs: number,
  matches: (candidate: T) => boolean,
): T | undefined {
  const matching = candidates.filter(matches);
  const prearmed = prearmedId === null ? undefined : matching.find((candidate) => candidate.id === prearmedId);
  if (prearmed !== undefined) return prearmed;
  return [...matching]
    .filter((candidate) => Number.isFinite(Date.parse(candidate.sendAt)))
    .sort((a, b) => Math.abs(Date.parse(a.sendAt) - nowMs) - Math.abs(Date.parse(b.sendAt) - nowMs))[0];
}

/** Tela de confirmação aberta: identifica o comando e segue para a mira. */
async function handlePendingConfirmation(
  ctx: TshCycleContext,
  state: HubSchedulerState,
  own: readonly ScheduledCommandRecord[],
  pending: PendingCommandConfirmation,
  settings: SchedulerSettings,
): Promise<void> {
  const prearm = ctx.storage.get<PrearmRecord | null>(prearmKey(ctx.villageId), null);
  // O pré-armado DESTA aldeia entra mesmo se o relógio já o marcaria "falhou":
  // a mira decide e registra o motivo (janela perdida) em vez de silenciar.
  const prearmed = prearm !== null ? state.commands.find((record) => record.id === prearm.id) : undefined;
  const prearmedOk =
    prearmed !== undefined &&
    aliveRecord(prearmed) &&
    normalizeVillageId(prearmed.sourceVillageId) === normalizeVillageId(ctx.villageId);
  const candidates =
    prearmedOk && !own.some((record) => record.id === prearmed.id) ? [...own, prearmed] : [...own];
  const screenTrain = readNativeTrainFromScreen();
  const unitsFor = (record: ScheduledCommandRecord): Record<string, number> | null =>
    record.percentMode === true ? (prearm?.id === record.id ? prearm.units : null) : commandUnitsRecord(record);
  const matching = pickConfirmCandidate(
    candidates.filter((record) => record.kind !== 'cancel'),
    prearmedOk ? (prearm?.id ?? null) : null,
    serverNowMs(),
    (record) => {
      const units = unitsFor(record);
      if (units === null) return false; // percentual sem pré-arme: tropas não casáveis
      // Revisão Onda E: o trem da tela precisa bater com o do registro —
      // sem trem = nenhum adicional preenchido; com trem = o mesmo ou nenhum
      // ainda (o motor monta).
      const train = record.trainUnits ?? [];
      if (screenTrain.length > 0 && (train.length === 0 || !nativeTrainMatches(train))) return false;
      return matchesPendingCommandConfirmation(pending, {
        kind: transportCommandKind(record.kind),
        target: record.target,
        units,
      });
    },
  );
  if (matching === undefined) {
    ctx.status(
      'Há uma confirmação de comando aberta, mas ela não corresponde a um comando agendado desta aldeia na janela atual.',
      'info',
    );
    return;
  }
  await aimAndConfirm(ctx, matching, unitsFor(matching) ?? commandUnitsRecord(matching), settings);
}

function findRecord(ctx: TshCycleContext, id: string): ScheduledCommandRecord | undefined {
  return readSchedulerState(ctx).commands.find((command) => command.id === id);
}

function commandOptionsFor(record: ScheduledCommandRecord): {
  attack: boolean;
  lane: ReturnType<typeof laneForSchedulerRecord>;
  catapultTarget?: string;
} {
  return {
    attack: record.kind !== 'support',
    lane: laneForSchedulerRecord(record),
    ...(record.catapultTarget !== undefined ? { catapultTarget: record.catapultTarget } : {}),
  };
}

function currentCompensationMs(settings: SchedulerSettings, forCancel = false): number {
  const info = clockInfo();
  return latencyCompensationMs({
    mode: settings.latencyMode,
    manualMs: settings.latencyManualMs,
    rttMedianMs: info.rttMedianMs,
    // O aprendido vem de cliques na Praça; o cancelamento é outro caminho.
    learnedMs: forCancel ? null : info.learnedCompensationMs,
  });
}

// ---------------------------------------------------------------------------
// Onda E — autocalibração pela CHEGADA REAL (o jogo mostra a chegada com ms).
// ---------------------------------------------------------------------------

interface ArrivalCheck {
  id: string;
  kind: 'attack' | 'support';
  target: { x: number; y: number };
  origin?: { x: number; y: number };
  train: boolean;
  /** Chegada planejada (sendAt + duração da viagem), quadro do jogo. */
  expectedArrivalMs: number;
  /** Antecedência EFETIVA do clique (sendAt − instante do clique), ms. */
  leadMs: number;
  queuedAt: number;
  attempts: number;
}

const VERIFY_STORAGE_KEY = 'arrival-checks';
const VERIFY_MAX_AGE_MS = 15 * 60_000;
const VERIFY_MAX_ATTEMPTS = 3;

/** Origem do registro: a gravada ou, na aldeia aberta, a do game_data. */
function recordOrigin(record: ScheduledCommandRecord, villageId: string): { x: number; y: number } | undefined {
  if (record.source !== undefined) return record.source;
  if (normalizeVillageId(record.sourceVillageId) !== normalizeVillageId(villageId)) return undefined;
  const village = (pageWindow().game_data as { village?: { x?: unknown; y?: unknown } } | undefined)?.village;
  return typeof village?.x === 'number' && typeof village.y === 'number' ? { x: village.x, y: village.y } : undefined;
}

/**
 * Enfileira a conferência da chegada real (revisão Onda E): SÓ cravados
 * (faixa de precisão) que saíram pela MIRA, não forçados — fake humanizado,
 * envio atrasado e forçado não ensinam latência (poluiriam o autoajuste).
 */
function queueArrivalCheck(ctx: TshCycleContext, record: ScheduledCommandRecord, leadMs: number): void {
  if (record.arrivalAt === undefined || record.forced === true || record.kind === 'cancel') return;
  const expected = Date.parse(record.arrivalAt);
  if (!Number.isFinite(expected)) return;
  const checks = ctx.storage.get<ArrivalCheck[]>(VERIFY_STORAGE_KEY, []);
  const origin = recordOrigin(record, ctx.villageId);
  const next: ArrivalCheck = {
    id: record.id,
    kind: record.kind === 'support' ? 'support' : 'attack',
    target: record.target,
    ...(origin !== undefined ? { origin } : {}),
    train: record.trainUnits !== undefined && record.trainUnits.length > 0,
    expectedArrivalMs: expected,
    leadMs,
    queuedAt: Date.now(),
    attempts: 0,
  };
  ctx.storage.set(VERIFY_STORAGE_KEY, [...checks.filter((check) => check.id !== record.id), next].slice(-10));
}

/**
 * Confere UMA leva de chegadas reais por ciclo (1 leitura da Visão de
 * Comandos, fila normal) — nunca com um cravado a menos de 2 min, para não
 * disputar a rede com a mira. Resultado: amostra de autocalibração + evento
 * informativo no registro ("chegada real … (+X ms)").
 */
async function verifyArrivals(ctx: TshCycleContext, nextOwnSendAt: number | undefined): Promise<void> {
  const nowLocal = Date.now();
  const checks = ctx.storage
    .get<ArrivalCheck[]>(VERIFY_STORAGE_KEY, [])
    .filter((check) => nowLocal - check.queuedAt < VERIFY_MAX_AGE_MS && check.attempts < VERIFY_MAX_ATTEMPTS);
  if (checks.length === 0) return;
  if (nextOwnSendAt !== undefined && nextOwnSendAt - serverNowMs() < 120_000) return;
  const ready = checks.filter((check) => nowLocal - check.queuedAt > 3_000);
  if (ready.length === 0) return;
  const kind = ready[0]?.kind ?? 'attack';
  let html: string;
  try {
    html = await pacedGet(
      `/game.php?village=${normalizeVillageId(ctx.villageId)}&screen=overview_villages&mode=commands&type=${kind}&page=-1`,
      { fresh: true },
    );
  } catch {
    return; // leitura é otimização — tenta no próximo ciclo
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nowFrame = serverNowMs();
  // Colunas pelo CABEÇALHO (Comando / Aldeia de origem / Chegada), não por posição fixa.
  const header = Array.from(doc.querySelectorAll('#commands_table tr:first-child th, #commands_table tr:first-child td')).map(
    (cell) => (cell.textContent ?? '').trim().toLowerCase(),
  );
  const colArrival = header.findIndex((text) => text.startsWith('chegada'));
  const colOrigin = header.findIndex((text) => text.includes('origem'));
  const arrivalCol = colArrival >= 0 ? colArrival : 2;
  const coordOf = (text: string): { x: number; y: number } | undefined => {
    const match = /\((\d{1,3})\|(\d{1,3})\)[^(]*$/.exec(text);
    return match === null ? undefined : { x: Number(match[1]), y: Number(match[2]) };
  };
  const rows: ArrivalRow[] = [];
  for (const tr of Array.from(doc.querySelectorAll('#commands_table tr.nowrap'))) {
    const cells = tr.children;
    const target = coordOf(cells[0]?.textContent ?? '');
    const origin = colOrigin >= 0 ? coordOf(cells[colOrigin]?.textContent ?? '') : undefined;
    const arrival = parseArrivalText(cells[arrivalCol]?.textContent ?? '', nowFrame);
    if (target === undefined || arrival === null) continue;
    rows.push({ target, ...(origin !== undefined ? { origin } : {}), arrivalMs: arrival });
  }
  const remaining: ArrivalCheck[] = [];
  for (const check of checks) {
    if (check.kind !== kind || !ready.includes(check)) {
      remaining.push(check);
      continue;
    }
    if (!aliveOrSent(readSchedulerState(ctx).commands.find((command) => command.id === check.id))) continue;
    const real = matchArrival(rows, {
      target: check.target,
      ...(check.origin !== undefined ? { origin: check.origin } : {}),
      expectedMs: check.expectedArrivalMs,
      train: check.train,
    });
    if (real === null) {
      remaining.push({ ...check, attempts: check.attempts + 1 });
      continue;
    }
    const errorMs = real - check.expectedArrivalMs;
    // Amostra = latência REAL do clique (antecedência efetiva + erro): imune a
    // atrasos e ao arredondamento do plano. Implausível = descartada.
    if (plausibleLatency(check.leadMs + errorMs)) {
      recordArrivalFeedback({ errorMs, compensationMs: check.leadMs, at: Date.now() });
    }
    ctx.storage.set(
      SCHEDULER_STORAGE_KEY,
      appendSchedulerEvent(
        readSchedulerState(ctx),
        check.id,
        'enviado',
        new Date().toISOString(),
        `Chegada real ${clockLabelMs(real)} (planejada ${clockLabelMs(check.expectedArrivalMs)}; ${errorMs >= 0 ? '+' : ''}${errorMs} ms).`,
      ),
    );
    ctx.status(`Chegada conferida: ${errorMs >= 0 ? '+' : ''}${errorMs} ms do planejado.`, 'ok');
  }
  ctx.storage.set(VERIFY_STORAGE_KEY, remaining);
}

function hiddenTabNote(): string {
  return document.hidden ? ' — aba em 2º plano: mantenha o computador acordado' : '';
}

/** Registro existente e não removido (conferência de chegada). */
function aliveOrSent(record: ScheduledCommandRecord | undefined): boolean {
  return record !== undefined && !record.events.some((event) => event.status === 'removido');
}

/** Registro vivo (não pausado, sem fato terminal persistido). */
function aliveRecord(record: ScheduledCommandRecord | undefined): boolean {
  return record !== undefined && !record.paused && !hasTerminalEvent(record);
}

/**
 * Na tela de confirmação: mira até `sendAt − compensação` e clica no ms
 * (clickCommandConfirmNow é síncrono). Cravado que chega atrasado além da
 * tolerância NÃO sai — vira 'falhou' com o motivo (seria outro comando).
 */
async function aimAndConfirm(
  ctx: TshCycleContext,
  record: ScheduledCommandRecord,
  units: Record<string, number>,
  settings: SchedulerSettings,
): Promise<void> {
  const target = `${record.target.x}|${record.target.y}`;
  const opts = commandOptionsFor(record);
  const sendAtMs = Date.parse(record.sendAt);
  const compensation = currentCompensationMs(settings);
  // Matcher ANTES da mira: tela divergente nunca é mirada (fail-closed).
  const screen = commandConfirmScreenState(target, units, opts);
  if (screen !== 'match') {
    ctx.status(
      `Comando ${record.id}: a tela de confirmação aberta não corresponde ao comando (tipo, alvo ou tropas) — nada foi confirmado.`,
      'warn',
    );
    return;
  }
  // Onda E: relógio ainda impreciso (página nova, sem medição) e tempo de
  // sobra → mede ANTES de mirar (a calibração leva alguns segundos).
  if (clockInfo().uncertaintyMs > 60 && sendAtMs - serverNowMs() > 12_000) {
    ctx.status(`Comando ${record.id}: medindo o relógio do servidor antes da mira…`, 'info');
    const limite = Math.max(0, sendAtMs - serverNowMs() - 5_000);
    await Promise.race([ensureClockCalibrated(), new Promise((resolve) => setTimeout(resolve, limite))]);
  }
  // Onda E: trem nativo montado ANTES da mira (nunca no instante do clique).
  if (record.trainUnits !== undefined && record.trainUnits.length > 0) {
    try {
      await prepareNativeTrain(record.trainUnits);
    } catch (error) {
      ctx.status(
        `Comando ${record.id}: trem não montado — ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
      return;
    }
  }
  const decision = decideConfirmAction({
    sendAtMs,
    nowServerMs: serverNowMs(),
    compensationMs: compensation,
    allowLateMs: settings.allowLateMs,
    forced: record.forced === true,
    lane: opts.lane,
  });
  if (decision.kind === 'late') {
    clearPrearm(ctx, record.id);
    ctx.storage.set(
      SCHEDULER_STORAGE_KEY,
      appendSchedulerEvent(
        readSchedulerState(ctx),
        record.id,
        'falhou',
        new Date().toISOString(),
        `Janela perdida: a confirmação ficou pronta ${decision.lateMs} ms depois do horário (${clockLabelMs(sendAtMs)}) — um cravado atrasado NÃO é enviado. Aumente a "Antecipação do pré-arme".`,
      ),
    );
    ctx.status(`Comando ${record.id}: janela perdida por ${decision.lateMs} ms — nada foi enviado.`, 'warn');
    alert('comando_falhou', `Comando ${record.id} para ${target}: janela perdida por ${decision.lateMs} ms — nada foi enviado.`);
    return;
  }
  const aimed = decision.kind === 'aim';
  if (decision.kind === 'aim') {
    if (decision.waitMs > AIM_MAX_WAIT_MS) {
      ctx.status(
        `Confirmação de ${record.id} aberta cedo (${Math.round(decision.waitMs / 1000)}s antes) — a mira começa no próximo ciclo.`,
        'info',
      );
      return;
    }
    const info = clockInfo();
    ctx.status(
      `Comando ${record.id} na mira: clique às ${clockLabelMs(decision.fireAtMs)} (compensação ${compensation} ms · relógio ±${info.uncertaintyMs} ms)${hiddenTabNote()}.`,
      'info',
    );
    renewTshLock('command-scheduler', ctx.world);
    const ok = await waitUntilServerMs(decision.fireAtMs, () => !aliveRecord(findRecord(ctx, record.id)), {
      precise: opts.lane === 'precisao',
    });
    if (!ok || !aliveRecord(findRecord(ctx, record.id))) {
      ctx.status(`Comando ${record.id} foi pausado/removido durante a mira — nada foi enviado.`, 'info');
      return;
    }
  }
  // Faixa humanizada (fakes): o clique final também passa pela porta de
  // humanização (como no fluxo antigo) — só o cravado sai no ms exato.
  if (opts.lane === 'humanizado') {
    const liberado = await awaitRoutineMutation('fake');
    if (!liberado) {
      ctx.status(`Pausa de humanização ativa — confirmação do fake ${record.id} adiada.`, 'info');
      return;
    }
    if (!aliveRecord(findRecord(ctx, record.id))) return;
  }
  // ── Disparo: NADA entre o fim da espera e o clique ──
  const clickedAtServer = serverNowMs();
  try {
    // O clique NAVEGA: libera o lock desta aba para a página seguinte (id de
    // aba novo) seguir o agendador na hora — sem isto ela ficava até 2 min
    // travada e o próximo cravado da mesma aldeia podia ser perdido (Onda E).
    // Se o clique falhar, o `finally` do runtime renova o lock.
    releaseTshLock('command-scheduler', ctx.world);
    clickCommandConfirmNow(target, units, opts, record.trainUnits ?? []);
  } catch (error) {
    renewTshLock('command-scheduler', ctx.world); // nada navegou: a aba retoma o lock
    if (isUncertainMutationError(error)) {
      ctx.storage.set(
        SCHEDULER_STORAGE_KEY,
        appendSchedulerEvent(
          readSchedulerState(ctx),
          record.id,
          'incerto',
          new Date().toISOString(),
          error instanceof Error ? error.message : String(error),
        ),
      );
      ctx.status(
        `Comando ${record.id} INCERTO: ${error instanceof Error ? error.message : String(error)} — releia o jogo antes de qualquer nova tentativa.`,
        'warn',
      );
      return;
    }
    throw error;
  }
  const info = clockInfo();
  clearPrearm(ctx, record.id);
  if (opts.lane === 'precisao' && aimed) queueArrivalCheck(ctx, record, sendAtMs - clickedAtServer);
  ctx.storage.set(
    SCHEDULER_STORAGE_KEY,
    appendSchedulerEvent(
      readSchedulerState(ctx),
      record.id,
      'enviado',
      new Date().toISOString(),
      `Comando ${record.kind}${record.trainUnits !== undefined ? ` (trem de ${record.trainUnits.length + 1})` : ''} para ${target} confirmado às ${clockLabelMs(clickedAtServer)} (alvo ${clockLabelMs(sendAtMs)}; compensação ${compensation} ms; relógio ±${info.uncertaintyMs} ms, fonte ${info.source}).`,
    ),
  );
  ctx.status(`Comando ${record.id} enviado para ${target} às ${clockLabelMs(clickedAtServer)} (${record.kind}).`, 'ok');
  if (record.kind === 'noble') {
    alert('comando_enviado', `Nobre enviado para ${target} (comando ${record.id}).`);
  }
}


export const commandSchedulerAutomation: TshAutomation = {
  id: 'command-scheduler',
  label: 'Agendador de Comandos',
  desc: 'Agende ataques/fakes/apoios/nobres pelo botão "Comandos": disparam sozinhos no horário marcado, pela Praça de Reunião da aldeia de origem (relógio do servidor). Agendar já é a autorização — não precisa "Armar".',
  category: 'producao',
  screen: 'place',
  cooldownMs: 20_000,
  mutating: true,
  // Onda 9 (dono): o agendamento explícito É a autorização — sem ARMAR. O
  // toggle Ativo continua sendo o opt-in; F2/lock/cooldown seguem valendo.
  armExempt: true,
  // Onda A: a tela de confirmação aberta pelo pré-arme mira LOGO ao carregar.
  bootOnLoad: true,
  extraActions: [
    {
      label: 'Comandos',
      open: (shadow, world, rerender) => {
        void openSchedulerCommands(shadow, world, rerender);
      },
    },
  ],
  settingsDefaults: DEFAULT_SETTINGS,
  // Só escalares de configuração: a lista de comandos (storage 'scheduler') é
  // estado de execução do Agendador, não configuração — e o limite de fakes é
  // lido do próprio mundo (get_config), sem override em settings.
  settingsForm: [
    {
      key: 'focusLeadMs',
      label: 'Antecipação da janela (ms)',
      type: 'number',
      min: 5000,
      max: 120000,
      step: 1000,
      help: 'Quanto antes do horário o agendador começa a cuidar do comando (mira e pré-arme). O envio em si NUNCA sai antes do horário.',
    },
    {
      key: 'allowLateMs',
      label: 'Tolerância de atraso (ms)',
      type: 'number',
      min: 0,
      max: 5000,
      step: 50,
      help: 'Atraso máximo DEPOIS do horário agendado em que o comando ainda dispara.',
    },
    {
      key: 'prearmLeadMs',
      label: 'Antecipação do pré-arme (ms)',
      type: 'number',
      min: 3000,
      max: 60000,
      step: 500,
      help: 'Quanto ANTES do horário o agendador abre a tela de confirmação (passo 1, nenhuma tropa sai). O clique final acontece no milissegundo marcado. Aumente se a sua internet/página demora para carregar.',
    },
    {
      key: 'latencyMode',
      label: 'Compensação de latência',
      type: 'select',
      options: [
        { value: 'auto', label: 'Automática (metade do tempo de resposta medido + envio do navegador)' },
        { value: 'manual', label: 'Manual (valor abaixo)' },
      ],
      help: 'O clique sai alguns ms antes do horário para o pedido CHEGAR ao servidor no horário. Automática usa a medição do relógio.',
    },
    {
      key: 'latencyManualMs',
      label: 'Compensação manual (ms)',
      type: 'number',
      min: 0,
      max: 400,
      step: 5,
      help: 'Usada só no modo Manual.',
    },
    {
      key: 'autoSend',
      label: 'Envio automático',
      type: 'boolean',
      help: 'Desligado: nada é enviado. O comando devido fica SEGURADO e é reavaliado a cada ciclo — religar dentro da tolerância de atraso o dispara; passada a tolerância, ele é marcado como falhou (sem envio). Exceção: comandos marcados como "forçar" permanecem segurados até a janela deles vencer (forçar aceita atraso, não dispara às cegas). A confirmação aberta fica para você confirmar à mão.',
    },
  ],
  runCycle,
};

registerTsh(commandSchedulerAutomation);
