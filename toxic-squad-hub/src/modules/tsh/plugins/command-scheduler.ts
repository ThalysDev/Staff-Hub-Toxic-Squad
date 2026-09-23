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
// - F2: UMA mutação por ciclo — submitCommand2Step (2 passos certificados,
//   matcher fail-closed dentro do transporte). Passo 1 pendente (tela de
//   confirmação aberta) só é confirmado quando CASA com um comando agendado
//   desta aldeia na janela + carência (CONFIRM_LATE_GRACE_MS 60s do original);
// - zero timers: o heartbeat de 30s chama o ciclo. Para não perder a janela
//   de 15s entre heartbeats, o ciclo MIRA: quando o comando vence em ≤60s,
//   dorme o restante DENTRO da própria promise (teto < TTL do lock de aba)
//   e dispara no sendAt exato — revalidando pausa/terminal depois da mira.

import { z } from 'zod';
import { alert } from '../tsh-alerts';
import { registerTsh, renewTshLock, type TshAutomation, type TshCycleContext } from '../tsh-runtime';
import { cancelGameCommandsAtTarget, isUncertainMutationError, normalizeVillageId, submitCommand2Step } from '../tsh-transport';
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
import { parseServerTimeText, serverNow } from '../../../ext/core/execution/server-clock';
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
  /** Texto do primeiro evento (o que o plano pediu — aparece na lista/histórico). */
  detail?: string;
}

/** Cria um ScheduledCommandRecord (id canônico cid_<fnv1a64>, pausado=false). */
export function createScheduledCommand(input: NewScheduledCommandInput): ScheduledCommandRecord {
  const { detail, ...fields } = input;
  // O percentual entra no id canônico (duas séries em % no mesmo horário não são
  // o mesmo comando); registro sem percentual mantém o id de sempre.
  const percentKey = input.percentMode === true ? `|${JSON.stringify(input.unitsPercent ?? {})}` : '';
  const canonical = `${input.kind}|${input.sourceVillageId}|${input.target.x}|${input.target.y}|${input.sendAt}|${JSON.stringify(input.units)}${percentKey}`;
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
const CONFIRM_LATE_GRACE_MS = 60_000;
/** Teto da mira: sempre < TTL do lock de aba (2min) — nunca segura o módulo. */
const AIM_MAX_WAIT_MS = 60_000;

const schedulerSettings = z.object({
  focusLeadMs: z.number().int().min(5000).max(120000).default(15000),
  allowLateMs: z.number().int().min(0).max(5000).default(250),
  autoSend: z.boolean().default(true),
});

type SchedulerSettings = z.infer<typeof schedulerSettings>;

/** Defaults do Agendador (mesmos do schema; expostos para o formulário do painel). */
export const DEFAULT_SETTINGS: SchedulerSettings = {
  focusLeadMs: 15000,
  allowLateMs: 250,
  autoSend: true,
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

/** "Agora" na perspectiva do servidor (offset do "Hora do servidor" da tela). */
function readServerNow(doc: Document): Date {
  const local = new Date();
  const timeText = doc.querySelector('#serverTime, #server_time, .server-time')?.textContent;
  const dateText = doc.querySelector('#serverDate, #server_date, .server-date')?.textContent;
  const combined =
    timeText === undefined || timeText === null
      ? undefined
      : dateText === undefined || dateText === null
        ? timeText
        : `${timeText} ${dateText}`;
  const serverTime = combined === undefined ? undefined : parseServerTimeText(combined, local);
  if (serverTime === undefined) return serverNow(0, local);
  const offset = serverTime.getTime() - local.getTime();
  // Offset absurdo (> 1 dia) indica parse errado, não relógio — ignora.
  return Math.abs(offset) > 24 * 60 * 60 * 1000 ? serverNow(0, local) : serverNow(offset, local);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function fireCommand(
  ctx: TshCycleContext,
  record: ScheduledCommandRecord,
  resolvedUnits?: Record<string, number>,
): Promise<void> {
  const target = `${record.target.x}|${record.target.y}`;
  if (record.kind === 'cancel') {
    await fireCancelCommand(ctx, record, target);
    return;
  }
  const units = resolvedUnits ?? (await resolveFireUnits(ctx, record));
  if (units === undefined) return; // percentual ilegível/inválido: nada foi enviado
  ctx.storage.set(
    SCHEDULER_STORAGE_KEY,
    appendSchedulerEvent(readSchedulerState(ctx), record.id, 'enviando', new Date().toISOString(), `Envio iniciado para ${target}.`),
  );
  try {
    // Regra de ouro (Onda 1): a faixa vem SEMPRE de laneForSchedulerRecord —
    // cravado = precisão de ms; fake sai humanizado automaticamente.
    // P1-2 (revisão): o alvo da catapulta do registro vai junto — sem ele a
    // catapulta bateria no alvo PADRÃO do jogo enquanto o operador mira outro.
    await submitCommand2Step(target, units, {
      attack: record.kind !== 'support',
      lane: laneForSchedulerRecord(record),
      ...(record.catapultTarget !== undefined ? { catapultTarget: record.catapultTarget } : {}),
    });
    ctx.storage.set(
      SCHEDULER_STORAGE_KEY,
      appendSchedulerEvent(
        readSchedulerState(ctx),
        record.id,
        'enviado',
        new Date().toISOString(),
        `Comando ${record.kind} para ${target} enviado pela Praça.`,
      ),
    );
    ctx.status(`Comando ${record.id} enviado para ${target} (${record.kind}).`, 'ok');
    // Canal de alertas (Onda 6): só o nobre avisa — os demais envios seriam spam.
    if (record.kind === 'noble') {
      alert('comando_enviado', `Nobre enviado para ${target} (comando ${record.id}).`);
    }
  } catch (error) {
    if (isUncertainMutationError(error)) {
      // Mutação inconclusiva: registra o fato terminal — NUNCA reenvia às cegas.
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
    // Falha PRÉ-mutação (formulário/tela errada): nenhum evento terminal — a
    // janela segue aberta para o próximo ciclo (fail-closed, sem retry cego).
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
  // pode esperar 30s por uma confirmação aberta de outro comando.
  const dueAtRead = earliestDueRecord(own, now.getTime(), windowCfg);

  // Passo 2: confirmação pendente na tela só é fechada quando CASA com um
  // comando agendado desta aldeia (janela + carência do original). Um cancel
  // devido passa direto (segue para o disparo abaixo).
  if (pending !== undefined && dueAtRead?.kind !== 'cancel') {
    const nowMs = now.getTime();
    const hasDue = own.some((record) => {
      const sendAt = Date.parse(record.sendAt);
      return (
        Number.isFinite(sendAt) &&
        sendAt <= nowMs + settings.focusLeadMs &&
        sendAt >= nowMs - settings.allowLateMs - CONFIRM_LATE_GRACE_MS
      );
    });
    // Cancelamento não passa pela Praça e percentual não tem tropas congeladas
    // para casar com a tela — os dois NÃO são confirmados por este caminho.
    const matching = own
      .filter((record) => record.kind !== 'cancel' && record.percentMode !== true)
      .find((record) =>
        matchesPendingCommandConfirmation(pending, {
          kind: transportCommandKind(record.kind),
          target: record.target,
          units: record.units,
        }),
      );
    if (!hasDue || matching === undefined) {
      ctx.status(
        'Há uma confirmação de comando aberta, mas ela não corresponde a um comando agendado desta aldeia na janela atual.',
        'info',
      );
      return;
    }
    await fireCommand(ctx, matching);
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
    // MIRA ANTECIPADA (Onda 9): tick de 30s × janela de focusLeadMs — sem
    // isto, um tick que cai no vão entre janelas perde o comando. O próximo
    // comando desta aldeia chegando em ≤90s faz o ciclo DORMIR até a janela
    // abrir e rederivá-lo (pausa/terminal feitos no intervalo são respeitados
    // pela rederivação + stillFirable da mira).
    if (!anyVillageDue && nextSendAt !== undefined) {
      const opensAt = nextSendAt - settings.focusLeadMs;
      const waitMs = opensAt - now.getTime();
      if (waitMs > 0 && waitMs <= 90_000) {
        ctx.status(
          `Próximo comando desta aldeia em ${Math.max(0, Math.round((nextSendAt - now.getTime()) / 1000))}s — aguardando a janela…`,
          'info',
        );
        // P2-2 (revisão): cancelamento chegando — pré-lê a Visão de Comandos
        // AGORA (fila normal) para que no sendAt só os POSTs urgentes corram.
        // Pré-canário: SEM aguardar — a pré-leitura é otimização e não pode
        // segurar a mira (com a fila normal ocupada, o await acordava o ciclo
        // DEPOIS da janela e o comando virava 'falhou' sem disparar). Roda
        // concorrente ao sleep; se não ficar pronta a tempo, o disparo usa o
        // fallback normal (busca no transporte). prereadCancelPage engole os
        // próprios erros — nenhuma promise rejeitada fica solta.
        const proximo = own
          .filter((record) => Number.isFinite(Date.parse(record.sendAt)) && Date.parse(record.sendAt) === nextSendAt)
          .find((record) => record.kind === 'cancel');
        if (proximo !== undefined) {
          void prereadCancelPage(ctx, `${proximo.target.x}|${proximo.target.y}`);
        }
        await sleep(Math.min(waitMs, 90_000));
        // P2 (revisão Onda 9): renova o lock após o sono longo — a mira final
        // (≤60s) some ao early-aim e podia estourar o TTL de 2min do lock.
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
  // A conta usa as tropas REAIS (no percentual, as resolvidas acima).
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

  // Mira: o comando vence dentro da lead — dorme o restante (teto 60s, sem
  // timers persistentes; o heartbeat não consegue sozinho a janela de 15s).
  const deltaMs = Date.parse(due.sendAt) - readServerNow(document).getTime();
  if (deltaMs > AIM_MAX_WAIT_MS) {
    ctx.status(`Comando ${due.id} vence em ${Math.round(deltaMs / 1000)}s — próximo ciclo mira o envio.`, 'info');
    return;
  }
  if (deltaMs > 0) {
    ctx.status(`Comando ${due.id} na mira: envio em ${Math.round(deltaMs / 1000)}s.`, 'info');
    renewTshLock('command-scheduler', ctx.world); // P2: mira ≤60s sempre sob lock vivo
    await sleep(deltaMs);
    // Revalida depois da mira: pausado/terminal no intervalo NUNCA dispara.
    const stateAfterAim = readSchedulerState(ctx);
    const record = stateAfterAim.commands.find((command) => command.id === due.id);
    if (!stillFirable(record, windowCfg, readServerNow(document))) {
      ctx.status(`Comando ${due.id} foi pausado/concluído durante a mira — envio abortado.`, 'info');
      return;
    }
  }
  if (due.forced === true) {
    const lateMs = readServerNow(document).getTime() - Date.parse(due.sendAt);
    if (lateMs > settings.allowLateMs) {
      ctx.status(
        `Comando ${due.id} FORÇADO: ${Math.round(lateMs / 1000)}s fora da janela — enviando mesmo assim (risco assumido ao agendar).`,
        'warn',
      );
    }
  }
  await fireCommand(ctx, due, fireUnits);
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
      help: 'O comando pode disparar até este tempo ANTES do horário agendado (sendAt).',
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
      key: 'autoSend',
      label: 'Envio automático',
      type: 'boolean',
      help: 'Desligado: nada é enviado. O comando devido fica SEGURADO e é reavaliado a cada ciclo — religar dentro da tolerância de atraso o dispara; passada a tolerância, ele é marcado como falhou (sem envio). Exceção: comandos marcados como "forçar" permanecem segurados até a janela deles vencer (forçar aceita atraso, não dispara às cegas). A confirmação aberta fica para você confirmar à mão.',
    },
  ],
  runCycle,
};

registerTsh(commandSchedulerAutomation);
