// Porta de humanização em runtime (Onda 1): carrega a política persistida e
// decide QUANTO esperar antes de uma mutação — sem nunca dormir dentro das
// filas de rede (`enqueue` normal / `enqueueUrgent` de precisão).
//
// REGRA DE OURO (decisão do dono): faixa 'precisao' (cravados — nobre, snipe,
// dodge, cancelamento, ataque/apoio agendados) NUNCA espera; 'humanizado'
// (fakes, coleta, recrutamento, construção, mercado, cunhagem) respeita
// intervalo entre comandos + atraso com variação + pausa programada.

import { gm } from '../../core/storage';
import {
  DEFAULT_HUMANIZE_POLICY,
  laneForCommand,
  normalizeHumanizePolicy,
  routineWaitMs,
  type CommandKindForLane,
  type HumanizePolicy,
  type TimingLane,
} from '../../ext/core/humanize/humanize-policy';

const POLICY_KEY = 'tsh-humanize:policy';
const LAST_COMMAND_KEY = 'tsh-humanize:last-command-at';

/** Política vigente (defaults fail-closed quando o storage está sujo). */
export function getHumanizePolicy(): HumanizePolicy {
  return normalizeHumanizePolicy(gm.get<unknown>(POLICY_KEY, DEFAULT_HUMANIZE_POLICY));
}

export function saveHumanizePolicy(raw: unknown): HumanizePolicy {
  const policy = normalizeHumanizePolicy(raw);
  gm.set(POLICY_KEY, policy);
  return policy;
}

export function lastHumanizedCommandAt(): number {
  return gm.get<number>(LAST_COMMAND_KEY, 0);
}

/**
 * Quanto esperar antes de uma mutação na faixa pedida.
 * - 0 = pode ir agora (precisão SEMPRE; política desligada; sem pendências)
 * - >0 = ms de espera (intervalo entre comandos OU atraso humanizado)
 * - -1 = pausa programada ativa: PULE a ação neste ciclo (não durma segurando
 *   a fila — o ciclo seguinte reavalia)
 */
export function humanizeWaitMs(lane: TimingLane, nowMs: number = Date.now()): number {
  return routineWaitMs(getHumanizePolicy(), lane, lastHumanizedCommandAt(), nowMs, new Date(nowMs).getHours(), Math.random());
}

/** Registra o instante de um envio humanizado ( espaçamento dos próximos). */
export function markHumanizedCommand(nowMs: number = Date.now()): void {
  gm.set(LAST_COMMAND_KEY, nowMs);
}

/**
 * Espera a vez de uma mutação NÃO-precisa (rotina). Retorna false quando a
 * pausa programada está ativa (o chamador deve pular a ação neste ciclo) ou
 * quando a espera estouraria o teto razoável de um ciclo (5 min).
 * A fila `enqueue` NÃO é segurada durante a espera.
 */
export async function awaitRoutineMutation(kind: CommandKindForLane, sleepFn: (ms: number) => Promise<void> = defaultSleep): Promise<boolean> {
  const lane = laneForCommand(kind, false); // rotinas nunca são 'precisao'
  const wait = humanizeWaitMs(lane);
  if (wait < 0) return false;
  if (wait > 0) {
    if (wait > 5 * 60_000) return false; // esperas absurdas = pular ciclo
    await sleepFn(wait);
  }
  markHumanizedCommand();
  return true;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
