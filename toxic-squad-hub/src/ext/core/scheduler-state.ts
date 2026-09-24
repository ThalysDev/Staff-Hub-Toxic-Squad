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
 *
 * A Onda 1 acrescentou o vocabulário de cancelamento (Auto Cancel Snipe),
 * repetição sequencial, snipe/dodge, forçar, alvo de catapulta e tropas em
 * percentual — TUDO em campos opcionais, então registros antigos continuam
 * parseando exatamente como antes.
 */

/**
 * Tipos de comando do Agendador: os quatro de combate do jogo mais `cancel`
 * (Onda 1 — cancelamento cronometrado de N comandos do alvo, o "Auto Cancel
 * Snipe"). `cancel` percorre o MESMO ciclo de vida dos demais (agendado →
 * janela → envio → fato terminal); o transporte do cancelamento (Praça) vive
 * fora deste arquivo.
 */
export type ScheduledCommandKind = 'attack' | 'support' | 'noble' | 'fake' | 'cancel';

/** Quantidades canônicas de cancelamentos do Auto Cancel Snipe (qtd 1..20 da UI). */
export const SCHEDULER_CANCEL_COUNTS = [1, 2, 3, 4, 5, 10, 15, 20] as const;

/**
 * Alvos de catapulta do jogo, na ordem do select da UI (`''` = Padrão, o alvo
 * que o jogo usa quando nenhum foi escolhido). O `catapultTarget` do registro
 * é uma destas CHAVES; o valor é o label pt-BR exibido.
 */
export const CATAPULT_TARGETS = {
  '': 'Padrão',
  main: 'Edifício Principal',
  snob: 'Academia',
  storage: 'Armazém',
  wood: 'Bosque',
  stable: 'Estábulo',
  statue: 'Estátua',
  farm: 'Fazenda',
  smith: 'Ferreiro',
  market: 'Mercado',
  iron: 'Mina de Ferro',
  wall: 'Muralha',
  garbage: 'Lixeira',
} as const;

export type CatapultTarget = keyof typeof CATAPULT_TARGETS;

/** Estratégias de envio: `direto` (ms planejado), `snipe` e `dodge` (cruzamento com o ataque que chega). */
export const SCHEDULER_TIMING_STRATEGIES = ['direto', 'snipe', 'dodge'] as const;

export type SchedulerTimingStrategy = (typeof SCHEDULER_TIMING_STRATEGIES)[number];

/** Trem nativo do jogo: 5 ataques no total = #1 + até 4 adicionais. */
export const SCHEDULER_NATIVE_TRAIN_MAX_EXTRA = 4;

/** Espaço entre as chegadas do trem nativo (observado no jogo: 100 ms). */
export const NATIVE_TRAIN_ARRIVAL_STEP_MS = 100;

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
  /**
   * Estratégia de envio (Onda 1); ausente = `'direto'`.
   *
   * NOME: a spec da Onda 1 pedia este campo como `timingMode`, mas esse nome já
   * é do campo ACIMA (`'arrival' | 'send'` = QUAL horário o operador digitou,
   * contrato antigo, obrigatório e retrocompatível). O eixo aqui é OUTRO (COMO
   * o comando é executado), então o campo tem nome próprio em vez de
   * sobrecarregar o antigo.
   */
  timingStrategy?: SchedulerTimingStrategy;
  /** ISO 8601, hora do SERVIDOR, segundos. */
  sendAt: string;
  /** Chegada derivada (recalculada quando tropas/origem mudam). Ausente quando inderivável (migração sem coordenada). */
  arrivalAt?: string;
  // --- Onda 1: cancelamento, sequencial, forçar, catapulta e tropas em % ---
  /**
   * Quantidade de comandos a cancelar no alvo (SÓ com `kind: 'cancel'`, uma das
   * quantidades canônicas de `SCHEDULER_CANCEL_COUNTS`). Ausente = o formulário
   * não escolheu quantidade.
   */
  cancelCount?: number;
  /** Repetir o comando X vezes (1..20): envios em sequência no mesmo alvo. */
  sequentialCount?: number;
  /** Agendado mesmo com timing impossível (o operador assume o risco; sem ele o agendamento é recusado). */
  forced?: boolean;
  /** Alvo da catapulta: uma das chaves de `CATAPULT_TARGETS` (`''` = Padrão). */
  catapultTarget?: string;
  /** Tropas em PERCENTUAL (0..100) em vez de absolutas; `units` segue congelado para exibição/matcher. */
  percentMode?: boolean;
  /** Percentuais por tipo de tropa (0..100), lidos quando `percentMode` é true. */
  unitsPercent?: Partial<Record<string, number>>;
  /**
   * v3.3.0 — "Todas": unidades que saem com TUDO o que houver na aldeia no
   * disparo (caixa "Todas" de cada tropa, como na Praça do jogo). Convive com
   * as quantidades fixas de `units` (modo misto); lido na Praça no disparo.
   */
  allUnits?: ReadonlyArray<UnitType>;
  /**
   * Onda E — TREM NATIVO do jogo: ataques ADICIONAIS (#2..#5) da tela de
   * confirmação ("Adicionar ataque adicional"). `units` é o ataque #1; o jogo
   * envia todos num único clique, com chegadas espaçadas em 100 ms.
   */
  trainUnits?: ReadonlyArray<Partial<Record<UnitType, number>>>;
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

const SCHEDULER_CANCEL_COUNT_SET: ReadonlySet<number> = new Set(SCHEDULER_CANCEL_COUNTS);

const CATAPULT_TARGET_KEYS = Object.keys(CATAPULT_TARGETS) as [CatapultTarget, ...CatapultTarget[]];

/**
 * Contrato do registro na fronteira do upsert: um registro malformado (ex. sem
 * `events`, `sendAt` ilegível) derrubaria a derivação de status e o motor
 * (`deriveSchedulerCommandStatus` filtra `events`) — a validação zod na
 * FRONTEIRA garante que só formas completas são gravadas (fail-closed). Campos
 * operacionais com default sensível onde o contrato permite: `timingMode`
 * ('send', o modo do legado) e `paused` (false). `events` é obrigatório (pode
 * ser vetor vazio na edição) — ausência é rejeitada.
 *
 * Os campos da Onda 1 (cancelamento/sequencial/snipe-dodge/forçar/catapulta/%)
 * são TODOS opcionais: um registro antigo (pré-Onda 1) continua parseando
 * exatamente como antes, e a ausência de `timingStrategy` vale `'direto'`.
 */
const scheduledCommandRecordInputSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['attack', 'support', 'noble', 'fake', 'cancel']),
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
    timingStrategy: z.enum(SCHEDULER_TIMING_STRATEGIES).optional(),
    sendAt: z.string().datetime(),
    arrivalAt: z.string().datetime().optional(),
    cancelCount: z.number().int().min(1).max(20).optional(),
    sequentialCount: z.number().int().min(1).max(20).optional(),
    forced: z.boolean().optional(),
    catapultTarget: z.enum(CATAPULT_TARGET_KEYS).optional(),
    percentMode: z.boolean().optional(),
    // Mesmo elenco do jogo do `units` (typo de UI nunca é gravado), valores 0..100.
    unitsPercent: z.partialRecord(z.enum(SCHEDULER_UNIT_TYPES), z.number().min(0).max(100)).optional(),
    allUnits: z.array(z.enum(SCHEDULER_UNIT_TYPES)).min(1).max(12).optional(),
    // Onda E: trem nativo — até 4 ataques adicionais (o jogo aceita 5 no total).
    trainUnits: z
      .array(z.partialRecord(z.enum(SCHEDULER_UNIT_TYPES), z.number().int().positive()))
      .min(1)
      .max(SCHEDULER_NATIVE_TRAIN_MAX_EXTRA)
      .optional(),
    paused: z.boolean().default(false),
    templateRef: z.object({ id: z.string().min(1), label: z.string(), builtin: z.boolean() }).optional(),
    createdAt: z.string().datetime(),
    events: z.array(commandEventSchema),
  })
  .superRefine((value, ctx) => {
    if (value.allUnits !== undefined) {
      if (value.percentMode === true) {
        ctx.addIssue({ code: 'custom', path: ['allUnits'], message: '"Todas" não se mistura com tropas em percentual.' });
      }
      if (value.trainUnits !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['allUnits'], message: 'trem nativo não aceita "Todas".' });
      }
      if (value.allUnits.some((unit) => (value.units as Partial<Record<string, number>>)[unit] !== undefined)) {
        ctx.addIssue({ code: 'custom', path: ['allUnits'], message: 'a unidade em "Todas" não pode ter quantidade fixa.' });
      }
    }
    if (value.trainUnits !== undefined) {
      if (value.kind !== 'attack' && value.kind !== 'noble') {
        ctx.addIssue({ code: 'custom', path: ['trainUnits'], message: 'trem nativo só vale para ataque/nobre.' });
      }
      if (value.percentMode === true) {
        ctx.addIssue({ code: 'custom', path: ['trainUnits'], message: 'trem nativo não aceita tropas em percentual.' });
      }
      value.trainUnits.forEach((row, index) => {
        if (Object.keys(row).length === 0) {
          ctx.addIssue({ code: 'custom', path: ['trainUnits', index], message: 'ataque adicional sem tropas.' });
        }
      });
    }
    if (value.cancelCount === undefined) return;
    if (value.kind !== 'cancel') {
      ctx.addIssue({
        code: 'custom',
        path: ['cancelCount'],
        message: 'quantidade de cancelamentos só vale para comando do tipo cancelar.',
      });
      return;
    }
    if (!SCHEDULER_CANCEL_COUNT_SET.has(value.cancelCount)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cancelCount'],
        message: `quantidade de cancelamentos fora da lista canônica (${SCHEDULER_CANCEL_COUNTS.join(', ')}).`,
      });
    }
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
  timingStrategy: 'estratégia de envio',
  sendAt: 'horário de envio',
  arrivalAt: 'horário de chegada',
  cancelCount: 'quantidade de cancelamentos',
  sequentialCount: 'repetições do comando',
  forced: 'forçar envio',
  catapultTarget: 'alvo da catapulta',
  percentMode: 'modo percentual',
  allUnits: 'tropas em "Todas"',
  unitsPercent: 'percentual de tropas',
  trainUnits: 'ataques adicionais do trem',
  paused: 'pausado',
  templateRef: 'template',
  createdAt: 'criado em',
  events: 'eventos',
};

/**
 * Rótulo pt-BR de um issue do zod. Caminho aninhado (`unitsPercent.spy`) não
 * tem rótulo próprio e cai no rótulo da RAIZ — a mensagem nunca vaza um path
 * cru de JSON para o operador.
 */
function commandFieldLabel(path: string): string {
  const root = path.split('.')[0] ?? '';
  const label = COMMAND_FIELD_LABELS[path] ?? COMMAND_FIELD_LABELS[root];
  if (label) return label;
  return path === '' ? 'registro' : path;
}

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
      ...new Set(parsed.error.issues.map((issue) => commandFieldLabel(issue.path.join('.')))),
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

/** Registro do estado novo → forma de comando do motor (module-types ScheduledCommand, que já lista `cancel`). */
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
 *
 * Comandos `cancel` (Onda 1) percorrem este MESMO fluxo de janela/envio: o
 * transporte do cancelamento (Praça) vive fora deste arquivo.
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
