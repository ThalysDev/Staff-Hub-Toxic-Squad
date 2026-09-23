import { z } from 'zod';
import type { HubWorldState } from './state/hub-state';
import type { ScheduledCommand, UnitType } from '../modules/shared/module-types';

/**
 * Estado do Agendador de Comandos v2 (spec scheduler-redesign-v2 §7.1): o
 * comando vira cidadão de primeira classe do mundo, com ciclo de vida,
 * `paused` por comando e histórico de eventos — em vez de linha de um
 * object-list nas regras do módulo.
 *
 * Fail-closed por construção: status terminais (`enviado`/`incerto`/`falhou`/
 * `removido`) são FATOS persistidos em `events` e nunca rederivados pelo
 * relógio; o motor só dispara comandos com status ativo (agendado/janela) e
 * `paused === false`. Desde a Onda 3 o estado novo é a FONTE ÚNICA do motor.
 */

export type ScheduledCommandKind = 'attack' | 'support' | 'noble' | 'fake';

export type ScheduledCommandStatus = 'agendado' | 'janela' | 'enviando' | 'enviado' | 'incerto' | 'falhou' | 'removido';

/** Status exibido: deriva do relógio + eventos, incluindo o estado pausado (UI). */
export type ScheduledCommandViewStatus = ScheduledCommandStatus | 'pausado';

export interface ScheduledCommandEvent {
  status: ScheduledCommandStatus;
  at: string;
  detail?: string;
}

export interface ScheduledCommandRecord {
  /** Id canônico (`cid_<fnv1a64>` no Composer; comandos migrados preservam o id legado). */
  id: string;
  kind: ScheduledCommandKind;
  sourceVillageId: string;
  sourceName?: string;
  /**
   * Coordenada da aldeia de origem. Ausente quando desconhecida (comandos
   * migrados do formulário legado sem leitura de Visualizações): sem ela o
   * Composer não deriva chegada, mas o motor envia normal (o legado nunca
   * teve coordenada e o envio não depende dela).
   */
  source?: { x: number; y: number };
  target: { x: number; y: number };
  targetName?: string;
  /** Pontos da aldeia alvo (via `ajax=target_selection`): habilitam a checagem do limite de fakes no agendamento. */
  targetPoints?: number;
  /** Unidades congeladas no agendamento (o matcher do motor compara 1:1 com a tela). */
  units: Partial<Record<UnitType, number>>;
  /** Modo em que o horário foi digitado; o outro é sempre derivado e exibido. */
  timingMode: 'arrival' | 'send';
  /** ISO 8601, hora do SERVIDOR, segundos. */
  sendAt: string;
  /** Chegada derivada (recalculada quando tropas/origem mudam). Ausente quando inderivável (migração sem coordenada). */
  arrivalAt?: string;
  paused: boolean;
  templateRef?: { id: string; label: string; builtin: boolean };
  createdAt: string;
  events: ReadonlyArray<ScheduledCommandEvent>;
}

export interface TransitCommandRecord {
  /** data-id do jogo (span.quickedit-out). */
  commandId: string;
  type: 'attack' | 'support' | 'other';
  targetLabel?: string;
  target?: { x: number; y: number };
  /** ISO com milissegundos (o jogo exibe a chegada com ms). */
  arrivesAtMs?: string;
  /**
   * Link de cancelamento do próprio jogo (`action=cancel&…&h=`). A presença
   * do link é o sinal AUTORITATIVO de que o comando ainda pode ser cancelado
   * (a janela de 600s é aplicada pelo jogo; o Hub não a re-deriva).
   */
  cancelUrl?: string;
  /** Quando a Praça foi lida. */
  readAt: string;
}

export interface HubSchedulerState {
  commands: ScheduledCommandRecord[];
  /** Espelho somente-leitura dos comandos em trânsito no jogo (última leitura vence). */
  transit: TransitCommandRecord[];
  /**
   * Carimbo da migração ÚNICA de `settings.commands` do command-scheduler.
   * Presente, a migração nunca roda de novo (comandos removidos no estado
   * novo não são ressuscitados pelo formulário legado).
   */
  legacyMigratedAt?: string;
}

// ---------------------------------------------------------------------------
// Validação na fronteira (hub:scheduler-upsert-command)
// ---------------------------------------------------------------------------

const coordinateSchema = z.object({ x: z.number().int().min(0).max(999), y: z.number().int().min(0).max(999) });

const SCHEDULER_UNIT_TYPES = [
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
] as const;

const commandEventSchema = z.object({
  status: z.enum(['agendado', 'janela', 'enviando', 'enviado', 'incerto', 'falhou', 'removido']),
  at: z.string().datetime(),
  detail: z.string().optional(),
});

/**
 * Contrato do registro na fronteira do upsert: um registro malformado (ex. sem
 * `events`, `sendAt` ilegível) derrubaria a derivação de status e o motor
 * (`deriveSchedulerCommandStatus` filtra `events`) — a validação zod na
 * FRONTEIRA garante que só formas completas são gravadas (fail-closed). Campos
 * operacionais com default sensível onde o contrato permite: `timingMode`
 * ('send', o modo do legado) e `paused` (false). `events` é obrigatório (pode
 * ser vetor vazio na edição) — ausência é rejeitada.
 */
const scheduledCommandRecordInputSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['attack', 'support', 'noble', 'fake']),
  sourceVillageId: z.string().min(1),
  sourceName: z.string().optional(),
  source: coordinateSchema.optional(),
  target: coordinateSchema,
  targetName: z.string().optional(),
  targetPoints: z.number().int().positive().optional(),
  // vendored-adapt: no zod 4 (versão do monorepo userscript) `z.record` com
  // chave enum exige registro EXAUSTIVO; `z.partialRecord` preserva a
  // semântica do `z.record(enum, valor)` do zod 3 da extensão (parcial,
  // chave desconhecida rejeitada).
  units: z.partialRecord(z.enum(SCHEDULER_UNIT_TYPES), z.number().int().positive()),
  timingMode: z.enum(['arrival', 'send']).default('send'),
  sendAt: z.string().datetime(),
  arrivalAt: z.string().datetime().optional(),
  paused: z.boolean().default(false),
  templateRef: z.object({ id: z.string().min(1), label: z.string(), builtin: z.boolean() }).optional(),
  createdAt: z.string().datetime(),
  events: z.array(commandEventSchema),
});

const COMMAND_FIELD_LABELS: Record<string, string> = {
  id: 'id',
  kind: 'tipo de comando',
  sourceVillageId: 'aldeia de origem',
  source: 'coordenada da origem',
  target: 'coordenada do alvo',
  targetPoints: 'pontos do alvo',
  units: 'unidades',
  timingMode: 'modo de horário',
  sendAt: 'horário de envio',
  arrivalAt: 'horário de chegada',
  paused: 'pausado',
  templateRef: 'template',
  createdAt: 'criado em',
  events: 'eventos',
};

/** Remove chaves opcionais ausentes (exactOptionalPropertyTypes no estado). */
function withoutUndefinedKeys<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}

/**
 * Valida um registro vindo da UI (`hub:scheduler-upsert-command`) e devolve a
 * forma canônica de `ScheduledCommandRecord`. Inválido → mensagem pt-BR com os
 * campos responsáveis (o handler responde SCHEDULER_COMMAND_INVALID sem gravar).
 */
export function parseSchedulerCommandRecord(
  raw: unknown,
): { ok: true; record: ScheduledCommandRecord } | { ok: false; message: string } {
  const parsed = scheduledCommandRecordInputSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues.map(
          (issue) => COMMAND_FIELD_LABELS[issue.path.join('.')] ?? issue.path.join('.') ?? 'registro',
        ),
      ),
    ];
    return { ok: false, message: `Registro de comando inválido — nada foi gravado. Revise: ${fields.join(', ')}.` };
  }
  return { ok: true, record: withoutUndefinedKeys(parsed.data) as ScheduledCommandRecord };
}

/** Status efetivo de um comando: último evento terminal vence; sem evento, deriva pelo relógio. */
export function deriveSchedulerCommandStatus(
  command: ScheduledCommandRecord,
  now: Date,
  window: { focusLeadMs: number; allowLateMs: number },
): ScheduledCommandViewStatus {
  if (command.paused) return 'pausado';
  const terminal = command.events.filter(
    (event) =>
      event.status === 'enviado' ||
      event.status === 'incerto' ||
      event.status === 'falhou' ||
      event.status === 'removido',
  );
  const last = terminal.at(-1);
  if (last) return last.status;
  const enviando = command.events.some((event) => event.status === 'enviando');
  if (enviando) return 'enviando';
  const sendAt = Date.parse(command.sendAt);
  if (Number.isFinite(sendAt)) {
    if (now.getTime() > sendAt + window.allowLateMs) return 'falhou';
    if (now.getTime() >= sendAt - window.focusLeadMs) return 'janela';
  }
  return 'agendado';
}

/** Janela padrão da derivação de status (mesmos defaults do schema do módulo). */
export const SCHEDULER_DEFAULT_WINDOW = { focusLeadMs: 15_000, allowLateMs: 250 } as const;

const TERMINAL_COMMAND_STATUSES: ReadonlySet<ScheduledCommandViewStatus> = new Set([
  'enviado',
  'incerto',
  'falhou',
  'removido',
]);

/**
 * Comandos do estado novo que o motor pode disparar: não pausados e sem
 * status terminal (um comando já enviado/incerto/falhou NUNCA volta ao
 * planejamento — fail-closed contra reenvio).
 */
export function activeSchedulerCommandRecords(
  scheduler: HubSchedulerState | undefined,
  now: Date,
  window: { focusLeadMs: number; allowLateMs: number } = SCHEDULER_DEFAULT_WINDOW,
): ScheduledCommandRecord[] {
  if (!scheduler) return [];
  return scheduler.commands.filter((command) => {
    if (command.paused) return false;
    const status = deriveSchedulerCommandStatus(command, now, window);
    return !TERMINAL_COMMAND_STATUSES.has(status);
  });
}

/** Registro do estado novo → forma de comando do motor (module-types ScheduledCommand). */
export function toMotorScheduledCommand(record: ScheduledCommandRecord): ScheduledCommand {
  return {
    id: record.id,
    kind: record.kind,
    sourceVillageId: record.sourceVillageId,
    target: record.target,
    sendAt: record.sendAt,
    units: record.units,
    ...(record.targetPoints !== undefined ? { targetPoints: record.targetPoints } : {}),
  };
}

/**
 * Comandos que o Agendador dispara (Onda 3): o estado novo
 * (`state.scheduler.commands`) é a FONTE ÚNICA — os `settings.commands` do
 * formulário legado deixaram de ser lidos (o formulário foi removido e a
 * migração única da Onda 1 já levou os legados; o schema aceita settings
 * velhos silenciosamente e os descarta). Os comandos do snapshot da página
 * (`ModuleContext.snapshot.scheduledCommands`, contrato do ciclo, hoje sempre
 * vazios) seguem aceitos como veículo de leitura futura, com dedupe contra
 * TODOS os ids do estado novo — um comando pausado ou terminal no estado novo
 * jamais é ressuscitado por fora dele. A janela de derivação de status é a dos
 * SETTINGS do módulo (focusLeadMs/allowLateMs) — um allowLateMs customizado
 * não pode ser ignorado ao classificar "falhou".
 */
export function schedulerMotorCommands(
  hubWorldState: HubWorldState | undefined,
  pageCommands: readonly ScheduledCommand[],
  now: Date,
  window: { focusLeadMs: number; allowLateMs: number } = SCHEDULER_DEFAULT_WINDOW,
): ScheduledCommand[] {
  const scheduler = hubWorldState?.scheduler;
  if (!scheduler) return [...pageCommands];
  const active = activeSchedulerCommandRecords(scheduler, now, window).map(toMotorScheduledCommand);
  const knownIds = new Set(scheduler.commands.map((command) => command.id));
  const page = pageCommands.filter((command) => !knownIds.has(command.id));
  return [...active, ...page];
}

function appendCommandEvent(command: ScheduledCommandRecord, event: ScheduledCommandEvent): ScheduledCommandRecord {
  return { ...command, events: [...command.events, event] };
}

/** Upsert (criação ou edição) de um comando; o autor (UI) define o registro completo. */
export function upsertSchedulerCommand(
  state: HubWorldState,
  command: ScheduledCommandRecord,
  now = new Date(),
): HubWorldState {
  const scheduler = state.scheduler ?? { commands: [], transit: [] };
  const existing = scheduler.commands.find((candidate) => candidate.id === command.id);
  const next: ScheduledCommandRecord = existing
    ? { ...command, createdAt: existing.createdAt, events: [...existing.events, ...command.events] }
    : command;
  const commands = existing
    ? scheduler.commands.map((candidate) => (candidate.id === command.id ? next : candidate))
    : [...scheduler.commands, next];
  return withScheduler(state, { ...scheduler, commands }, now);
}

/** Remoção real do vetor (spec §7.2: eventos vão para o histórico de atividades na Onda 2). */
export function removeSchedulerCommand(state: HubWorldState, commandId: string, now = new Date()): HubWorldState {
  const scheduler = state.scheduler ?? { commands: [], transit: [] };
  return withScheduler(
    state,
    { ...scheduler, commands: scheduler.commands.filter((command) => command.id !== commandId) },
    now,
  );
}

/** Pausar/retomar por comando: pausado nunca é disparado pelo motor. */
export function setSchedulerCommandPaused(
  state: HubWorldState,
  commandId: string,
  paused: boolean,
  now = new Date(),
): HubWorldState {
  const scheduler = state.scheduler ?? { commands: [], transit: [] };
  const commands = scheduler.commands.map((command) => (command.id === commandId ? { ...command, paused } : command));
  return withScheduler(state, { ...scheduler, commands }, now);
}

/**
 * Transição de status do motor (§7.2: `enviando`→`enviado`/`incerto`,
 * `falhou` por janela perdida). Comando ausente → estado intacto (o id pode
 * ser de outro módulo, ex. Apoio em Massa).
 */
export function recordSchedulerCommandEvent(
  state: HubWorldState,
  commandId: string,
  event: Omit<ScheduledCommandEvent, 'at'>,
  now = new Date(),
): HubWorldState {
  const scheduler = state.scheduler;
  if (!scheduler) return state;
  const command = scheduler.commands.find((candidate) => candidate.id === commandId);
  if (!command) return state;
  const commands = scheduler.commands.map((candidate) =>
    candidate.id === commandId ? appendCommandEvent(candidate, { ...event, at: now.toISOString() }) : candidate,
  );
  return withScheduler(state, { ...scheduler, commands }, now);
}

/**
 * Mescla a leitura dos comandos em trânsito da Praça: slot único por mundo,
 * a leitura fresca substitui a anterior (mesma convenção de
 * `mergeSupportsFacts`).
 */
export function mergeSchedulerTransit(
  state: HubWorldState,
  transit: TransitCommandRecord[],
  now = new Date(),
): HubWorldState {
  const scheduler = state.scheduler ?? { commands: [], transit: [] };
  return withScheduler(state, { ...scheduler, transit }, now);
}

function withScheduler(state: HubWorldState, scheduler: HubSchedulerState, now: Date): HubWorldState {
  return { ...state, scheduler, updatedAt: now.toISOString() };
}

interface LegacySettingsCommand {
  id: string;
  kind: 'attack' | 'support' | 'noble' | 'fake';
  sourceVillageId: string;
  target?: unknown;
  sendAt: string;
  units?: unknown;
  targetPoints?: unknown;
}

function isLegacyCommandShape(raw: unknown): raw is LegacySettingsCommand {
  if (typeof raw !== 'object' || raw === null) return false;
  const record = raw as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    record.id !== '' &&
    (record.kind === 'attack' || record.kind === 'support' || record.kind === 'noble' || record.kind === 'fake') &&
    typeof record.sourceVillageId === 'string' &&
    typeof record.sendAt === 'string' &&
    !Number.isNaN(Date.parse(record.sendAt))
  );
}

function coordinatesFromTarget(target: unknown): { x: number; y: number } | undefined {
  if (typeof target !== 'object' || target === null) return undefined;
  const record = target as { x?: unknown; y?: unknown };
  const x = Number(record.x);
  const y = Number(record.y);
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 ? { x, y } : undefined;
}

function unitsFromLegacy(raw: unknown): Partial<Record<UnitType, number>> {
  if (typeof raw !== 'object' || raw === null) return {};
  const unitTypes: readonly UnitType[] = [
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
  const units: Partial<Record<UnitType, number>> = {};
  for (const [unit, amount] of Object.entries(raw as Record<string, unknown>)) {
    if (!unitTypes.includes(unit as UnitType)) continue;
    const value = Number(amount);
    if (Number.isInteger(value) && value > 0) units[unit as UnitType] = value;
  }
  return units;
}

/**
 * Migração ÚNICA dos `settings.commands` do command-scheduler para o estado
 * novo (spec §7.1/D2): roda uma vez (flag `legacyMigratedAt`), não apaga os
 * settings legados (higiene de storage apenas — a fonte única do motor é o
 * `state.scheduler`, com dedupe por id contra tudo que já está lá) e é honesta
 * com o que o legado não tinha: coordenada da origem vem dos snapshots das
 * Visualizações quando conhecida, `timingMode` = 'send' (o legado digitava o
 * envio) e chegada derivada fica ausente quando inderivável. Comandos legado
 * inválidos são ignorados (fail-closed: o motor nunca os planejou de outra
 * forma — o schema zod os rejeitaria igual).
 */
export function migrateLegacySchedulerCommands(state: HubWorldState, now = new Date()): HubWorldState {
  const scheduler = state.scheduler ?? { commands: [], transit: [] };
  if (scheduler.legacyMigratedAt) return state;
  const legacy = state.modules['command-scheduler']?.settings?.commands;
  if (!Array.isArray(legacy) || legacy.length === 0) {
    // Marca mesmo sem comandos: mundos sem legado não reavaliam a cada carga.
    return withScheduler(state, { ...scheduler, legacyMigratedAt: now.toISOString() }, now);
  }
  const at = now.toISOString();
  const existing = new Set(scheduler.commands.map((command) => command.id));
  const migrated: ScheduledCommandRecord[] = [];
  for (const raw of legacy) {
    if (!isLegacyCommandShape(raw)) continue;
    if (existing.has(raw.id)) continue;
    const target = coordinatesFromTarget(raw.target);
    if (!target) continue;
    const snapshot = state.villageSnapshots?.[raw.sourceVillageId];
    const source =
      snapshot?.x !== undefined && snapshot?.y !== undefined ? { x: snapshot.x, y: snapshot.y } : undefined;
    const targetPoints = Number(raw.targetPoints);
    migrated.push({
      id: raw.id,
      kind: raw.kind,
      sourceVillageId: raw.sourceVillageId,
      ...(source ? { source } : {}),
      target,
      units: unitsFromLegacy(raw.units),
      timingMode: 'send',
      sendAt: new Date(raw.sendAt).toISOString(),
      paused: false,
      ...(Number.isInteger(targetPoints) && targetPoints > 0 ? { targetPoints } : {}),
      createdAt: at,
      events: [{ status: 'agendado', at, detail: 'Migrado do formulário legado do Agendador.' }],
    });
  }
  return withScheduler(
    state,
    { ...scheduler, commands: [...scheduler.commands, ...migrated], legacyMigratedAt: at },
    now,
  );
}
