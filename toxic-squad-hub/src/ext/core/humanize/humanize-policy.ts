import { z } from 'zod';
import type { ScheduledCommandKind } from '../scheduler-state';

/**
 * Humanização de Envios — política PURA de tempo de envio (Onda 0).
 *
 * O Hub tem DUAS faixas de envio, e a faixa é decidida por comando:
 * - `precisao` (comando cravado): NT/nobres, snipe, dodge, cancelamento
 *   cronometrado e apoio cravado. ZERO humanização — o envio acontece no
 *   milissegundo planejado, sem delay somado nem espera de intervalo/pausa;
 * - `humanizado` (fakes, farm e rotinas de coleta/recrutamento/envio): delay
 *   com variação aleatória, intervalo mínimo entre comandos e pausa diária.
 *
 * Este módulo não fala com o jogo nem com o DOM: só classifica a faixa e
 * calcula o PRÓXIMO INSTANTE permitido do envio. O transporte do TSH consulta
 * a política na porta e a persistência passa por `humanizePolicySchema`.
 *
 * O master switch (`enabled`) é fail-safe por construção: desligado (default),
 * NADA muda — as duas faixas passam direto.
 */

export type TimingLane = 'precisao' | 'humanizado';

/**
 * Vocabulário de comando da política: tipos de combate do Agendador (nomes
 * pt-BR da UI) mais os comandos sem combate e as rotinas. O mapeamento para o
 * vocabulário do estado do Agendador (`ScheduledCommandKind`) é
 * `SCHEDULER_KIND_TO_LANE_KIND`/`laneForSchedulerCommandKind`.
 */
export type CommandKindForLane =
  | 'ataque'
  | 'fake'
  | 'apoio'
  | 'nobre'
  | 'snipe'
  | 'dodge'
  | 'cancelamento'
  | 'coleta'
  | 'recrutamento'
  | 'construcao'
  | 'mercado'
  | 'cunhagem';

/**
 * Comandos intrinsecamente cronometrados: fora do milissegundo planejado eles
 * PERDEM a função (nobre fora do combo, snipe/dodge que não cruzam o ataque,
 * cancelamento fora da janela do jogo), então nunca entram na faixa
 * humanizada — cravados ou não.
 */
const ALWAYS_PRECISE_KINDS: ReadonlySet<CommandKindForLane> = new Set([
  'nobre',
  'snipe',
  'dodge',
  'cancelamento',
]);

/**
 * Comandos de combate que só são cravados quando o operador agenda o horário
 * exato: cravados vão para `precisao` (atrasar um ataque real desalinha a OP),
 * imediatos vão para `humanizado` (o envio "solto" não tem contrato de tempo).
 */
const PRECISE_WHEN_CRAVADO: ReadonlySet<CommandKindForLane> = new Set(['ataque', 'apoio']);

/** Faixa do comando: cravado nunca atrasa; fake e rotinas sempre humanizam. */
export function laneForCommand(kind: CommandKindForLane, scheduledExact: boolean): TimingLane {
  if (ALWAYS_PRECISE_KINDS.has(kind)) return 'precisao';
  if (scheduledExact && PRECISE_WHEN_CRAVADO.has(kind)) return 'precisao';
  return 'humanizado';
}

/** Ponte entre o vocabulário do estado do Agendador (`kind` do registro) e a faixa. */
export const SCHEDULER_KIND_TO_LANE_KIND: Readonly<Record<ScheduledCommandKind, CommandKindForLane>> =
  Object.freeze({
    attack: 'ataque',
    support: 'apoio',
    noble: 'nobre',
    fake: 'fake',
  });

/** `kind` do estado do Agendador (attack/support/noble/fake) → faixa de envio. */
export function laneForSchedulerCommandKind(kind: ScheduledCommandKind, scheduledExact: boolean): TimingLane {
  return laneForCommand(SCHEDULER_KIND_TO_LANE_KIND[kind], scheduledExact);
}

/** Pausa diária em hora LOCAL, com janela que pode cruzar a meia-noite (ex.: 23→7). */
export interface ScheduledPauseWindow {
  readonly startHour: number;
  readonly endHour: number;
}

export interface HumanizePolicy {
  readonly enabled: boolean; // master switch (default false — nada muda se off)
  readonly commandIntervalMs: number; // gap mínimo entre comandos humanizados (default 300)
  readonly actionDelayMs: number; // delay entre ações humanizadas (default 750)
  readonly variationPct: number; // 0..100 de randomização (default 20)
  readonly scheduledPause: ScheduledPauseWindow | null; // pausa diária (cruza meia-noite)
  readonly enforceFakeLimit: boolean; // default true
}

export const DEFAULT_HUMANIZE_POLICY: HumanizePolicy = Object.freeze({
  enabled: false,
  commandIntervalMs: 300,
  actionDelayMs: 750,
  variationPct: 20,
  scheduledPause: null,
  enforceFakeLimit: true,
});

/** Teto sanitizante das durações persistidas (10 min): valor maior é clamp, nunca erro. */
const MAX_HUMANIZE_MS = 600_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Delay humanizado: `actionDelayMs * (1 ± variationPct/100)` — `rand01` mapeia
 * a variação de forma linear em [-variação, +variação] (0 = piso, 0.5 = valor
 * nominal, 1 = teto). Fora de [0,1] o rand é clampado; o resultado nunca é
 * negativo (variação de 100% no piso zera o delay). O master switch é
 * aplicado na PORTA (`nextCommandAt`), não aqui: a função é só a conta.
 */
export function humanizedActionDelayMs(policy: HumanizePolicy, rand01: number): number {
  const rand = clamp(Number.isFinite(rand01) ? rand01 : 0, 0, 1);
  const variation = clamp(policy.variationPct, 0, 100) / 100;
  const factor = 1 + (rand * 2 - 1) * variation;
  return Math.max(0, Math.round(policy.actionDelayMs * factor));
}

/**
 * `hourLocal` está dentro da pausa diária? Sem pausa configurada → nunca.
 * Janela normal (1→7) é [start, end); janela que cruza a meia-noite (23→7) é
 * [start, 24) ∪ [0, end). Janela degenerada (start === end) é tratada como
 * "sem pausa": bloquear o dia inteiro por um valor degenerado impediria todo
 * envio humanizado (fail-closed do lado certo).
 */
export function isPauseActive(policy: HumanizePolicy, hourLocal: number): boolean {
  const window = policy.scheduledPause;
  if (!window || !Number.isFinite(hourLocal)) return false;
  const start = window.startHour;
  const end = window.endHour;
  if (start === end) return false;
  if (start < end) return hourLocal >= start && hourLocal < end;
  return hourLocal >= start || hourLocal < end;
}

/** Próxima ocorrência local de `hour:00:00.000` estritamente depois de `ms`. */
function startOfNextLocalHour(ms: number, hour: number): number {
  const reference = new Date(ms);
  const base = new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate(),
    hour,
    0,
    0,
    0,
  ).getTime();
  if (base > ms) return base;
  return new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() + 1, hour, 0, 0, 0).getTime();
}

/**
 * Próximo instante permitido para um comando HUMANIZADO: no mínimo
 * `commandIntervalMs` depois do último envio e nunca dentro da pausa diária
 * (quando o instante cai na janela, o envio escorrega para o fim dela).
 * Política desligada → passa direto (nada muda se off). O laço é limitado: a
 * janela válida termina na primeira hora fora dela.
 */
export function nextHumanizedCommandAt(policy: HumanizePolicy, lastCommandAtMs: number, nowMs: number): number {
  if (!policy.enabled) return nowMs;
  const last = Number.isFinite(lastCommandAtMs) ? lastCommandAtMs : nowMs;
  let candidate = Math.max(nowMs, last + Math.max(0, policy.commandIntervalMs));
  const window = policy.scheduledPause;
  if (!window || window.startHour === window.endHour) return candidate;
  for (let attempt = 0; attempt < 4 && isPauseActive(policy, new Date(candidate).getHours()); attempt += 1) {
    candidate = startOfNextLocalHour(candidate, window.endHour);
  }
  return candidate;
}

/**
 * Porta única do envio: faixa `precisao` devolve `nowMs` SEMPRE (cravado nunca
 * atrasa — nem por intervalo, nem por pausa, nem por política ligada).
 */
export function nextCommandAt(
  policy: HumanizePolicy,
  lane: TimingLane,
  lastCommandAtMs: number,
  nowMs: number,
): number {
  if (lane === 'precisao') return nowMs;
  return nextHumanizedCommandAt(policy, lastCommandAtMs, nowMs);
}

/**
 * Contrato de persistência da política. Cada campo cai no default quando o
 * TIPO é lixo (string/objeto no lugar de número etc.) e números fora da faixa
 * são clampados — nunca gravamos um valor que o motor não saiba interpretar.
 * Campo ausente usa o default do campo, então o merge é sempre "sobre os
 * defaults". `scheduledPause` inválido vira `null` (sem pausa).
 */
const clampedMsSchema = (fallback: number) =>
  z
    .number()
    .catch(fallback)
    .transform((value) => clamp(Math.round(value), 0, MAX_HUMANIZE_MS));

const clampedVariationSchema = z
  .number()
  .catch(DEFAULT_HUMANIZE_POLICY.variationPct)
  .transform((value) => clamp(value, 0, 100));

const scheduledPauseSchema = z
  .object({
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(0).max(23),
  })
  .nullable()
  .catch(null);

export const humanizePolicySchema = z.object({
  enabled: z.boolean().catch(DEFAULT_HUMANIZE_POLICY.enabled),
  commandIntervalMs: clampedMsSchema(DEFAULT_HUMANIZE_POLICY.commandIntervalMs),
  actionDelayMs: clampedMsSchema(DEFAULT_HUMANIZE_POLICY.actionDelayMs),
  variationPct: clampedVariationSchema,
  scheduledPause: scheduledPauseSchema,
  enforceFakeLimit: z.boolean().catch(DEFAULT_HUMANIZE_POLICY.enforceFakeLimit),
});

/**
 * Normaliza a política vinda da persistência: merge sobre os defaults,
 * fail-closed campo a campo (tipo errado nunca contamina o motor; entrada que
 * nem é objeto devolve os defaults puros). O resultado é congelado.
 */
export function normalizeHumanizePolicy(input: unknown): HumanizePolicy {
  const parsed = humanizePolicySchema.safeParse(input);
  const policy: HumanizePolicy = parsed.success ? parsed.data : DEFAULT_HUMANIZE_POLICY;
  return Object.freeze({
    ...policy,
    scheduledPause: policy.scheduledPause
      ? Object.freeze({ startHour: policy.scheduledPause.startHour, endHour: policy.scheduledPause.endHour })
      : null,
  });
}
