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
import { registerTsh, renewTshLock, type TshAutomation, type TshCycleContext } from '../tsh-runtime';
import { isUncertainMutationError, normalizeVillageId, submitCommand2Step } from '../tsh-transport';
import { pacedGet } from '../../../core/net';
import {
  activeSchedulerCommandRecords,
  deriveSchedulerCommandStatus,
  toMotorScheduledCommand,
  type HubSchedulerState,
  type ScheduledCommandRecord,
  type ScheduledCommandStatus,
} from '../../../ext/core/scheduler-state';
import { parseServerTimeText, serverNow } from '../../../ext/core/execution/server-clock';
import type { ScheduledCommand, UnitType } from '../../../ext/modules/shared/module-types';
import { fnv1a64 } from '../../../ext/modules/shared/canonical-ids';
import { openSchedulerCommands } from '../tsh-commands-ui';

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
  /** ISO 8601, hora do SERVIDOR, segundos. */
  sendAt: string;
  arrivalAt?: string;
}

/** Cria um ScheduledCommandRecord (id canônico cid_<fnv1a64>, pausado=false). */
export function createScheduledCommand(input: NewScheduledCommandInput): ScheduledCommandRecord {
  const canonical = `${input.kind}|${input.sourceVillageId}|${input.target.x}|${input.target.y}|${input.sendAt}|${JSON.stringify(input.units)}`;
  return {
    ...input,
    id: `cid_${fnv1a64(canonical)}`,
    paused: false,
    createdAt: new Date().toISOString(),
    events: [{ status: 'agendado', at: new Date().toISOString() }],
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

function readSchedulerState(ctx: TshCycleContext): HubSchedulerState {
  return ctx.storage.get<HubSchedulerState>(SCHEDULER_STORAGE_KEY, { commands: [], transit: [] });
}

function commandUnitsRecord(command: ScheduledCommand): Record<string, number> {
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

/** Comando ainda disparável depois da mira (não pausado, sem status terminal). */
function stillFirable(
  record: ScheduledCommandRecord | undefined,
  window: { focusLeadMs: number; allowLateMs: number },
  now: Date,
): boolean {
  if (record === undefined || record.paused) return false;
  return !TERMINAL_COMMAND_STATUSES.has(deriveSchedulerCommandStatus(record, now, window));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Guarda de re-entrância: com a mira (sleep), o heartbeat seguinte tentaria
// rodar um 2º ciclo concorrente do mesmo módulo na MESMA aba — o lock de aba
// não protege contra isso (mesma tab id).
let cycleInFlight = false;

async function fireCommand(ctx: TshCycleContext, command: ScheduledCommand): Promise<void> {
  const target = `${command.target.x}|${command.target.y}`;
  const units = commandUnitsRecord(command);
  ctx.storage.set(
    SCHEDULER_STORAGE_KEY,
    appendSchedulerEvent(readSchedulerState(ctx), command.id, 'enviando', new Date().toISOString(), `Envio iniciado para ${target}.`),
  );
  try {
    await submitCommand2Step(target, units, { attack: command.kind !== 'support' });
    ctx.storage.set(
      SCHEDULER_STORAGE_KEY,
      appendSchedulerEvent(
        readSchedulerState(ctx),
        command.id,
        'enviado',
        new Date().toISOString(),
        `Comando ${command.kind} para ${target} enviado pela Praça.`,
      ),
    );
    ctx.status(`Comando ${command.id} enviado para ${target} (${command.kind}).`, 'ok');
  } catch (error) {
    if (isUncertainMutationError(error)) {
      // Mutação inconclusiva: registra o fato terminal — NUNCA reenvia às cegas.
      ctx.storage.set(
        SCHEDULER_STORAGE_KEY,
        appendSchedulerEvent(
          readSchedulerState(ctx),
          command.id,
          'incerto',
          new Date().toISOString(),
          error instanceof Error ? error.message : String(error),
        ),
      );
      ctx.status(
        `Comando ${command.id} INCERTO: ${error instanceof Error ? error.message : String(error)} — releia o jogo antes de qualquer nova tentativa.`,
        'warn',
      );
      return;
    }
    // Falha PRÉ-mutação (formulário/tela errada): nenhum evento terminal — a
    // janela segue aberta para o próximo ciclo (fail-closed, sem retry cego).
    throw error;
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
  const own = records
    .filter((record) => normalizeVillageId(record.sourceVillageId) === normalizeVillageId(ctx.villageId))
    .map(toMotorScheduledCommand);

  // Passo 2: confirmação pendente na tela só é fechada quando CASA com um
  // comando agendado desta aldeia (janela + carência do original).
  const pending = readPendingCommandConfirmation(document);
  if (pending !== undefined) {
    if (!settings.autoSend) {
      ctx.status('Envio automático desativado: confirme o comando manualmente na tela aberta.', 'info');
      return;
    }
    const nowMs = now.getTime();
    const hasDue = own.some((command) => {
      const sendAt = Date.parse(command.sendAt);
      return (
        Number.isFinite(sendAt) &&
        sendAt <= nowMs + settings.focusLeadMs &&
        sendAt >= nowMs - settings.allowLateMs - CONFIRM_LATE_GRACE_MS
      );
    });
    const matching = own.find((command) =>
      matchesPendingCommandConfirmation(pending, {
        kind: transportCommandKind(command.kind),
        target: command.target,
        units: command.units,
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
  let due = own
    .filter((command) => commandInSendWindow(command, now.getTime(), windowCfg))
    .sort((left, right) => Date.parse(left.sendAt) - Date.parse(right.sendAt))[0];
  if (due === undefined) {
    const nextSendAt = own
      .map((command) => Date.parse(command.sendAt))
      .filter((sendAt) => Number.isFinite(sendAt))
      .sort((left, right) => left - right)[0];
    const anyVillageDue = records
      .map(toMotorScheduledCommand)
      .some((command) => commandInSendWindow(command, now.getTime(), windowCfg));
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
        await sleep(Math.min(waitMs, 90_000));
        // P2 (revisão Onda 9): renova o lock após o sono longo — a mira final
        // (≤60s) some ao early-aim e podia estourar o TTL de 2min do lock.
        renewTshLock('command-scheduler', ctx.world);
        const stateAfterWait = readSchedulerState(ctx);
        const nowAfter = readServerNow(document);
        due = activeSchedulerCommandRecords(stateAfterWait, nowAfter, windowCfg)
          .filter((record) => normalizeVillageId(record.sourceVillageId) === normalizeVillageId(ctx.villageId))
          .map(toMotorScheduledCommand)
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

  // FAKE protection: ataque/fake com pontos do alvo precisa de população
  // mínima (fração do mundo via get_config; mundo sem limite = sem checagem).
  if ((due.kind === 'attack' || due.kind === 'fake') && due.targetPoints !== undefined) {
    const fraction = await worldFakeLimitFraction();
    if (fraction > 0) {
      const minimum = minimumAttackPopulation(due.targetPoints, fraction);
      const population = commandPopulation(due.units);
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
  await fireCommand(ctx, due);
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
      help: 'Desligado: nada é enviado; a confirmação aberta fica para você confirmar à mão.',
    },
  ],
  runCycle,
};

registerTsh(commandSchedulerAutomation);
