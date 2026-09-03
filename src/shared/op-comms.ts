// Adaptador do PLANNER DE OP EM MASSA para o PACOTE DE COMUNICAÇÃO existente
// (v0.33): os comandos gerados na Sala de Guerra viram os mesmos insumos que
// o SG_4 produz (distribution "nick;coords" + agenda colável do
// formatSendSchedule) — assim a OP ganha MPs por executor com prévia e envio
// direto, sem copiar/colar manual. Puro e determinístico; fail-closed do
// comms-package preservado (executor sem horário na agenda aborta com erro).

import { buildPlayerComms, type PlayerComms } from './comms-package';
import { formatColavel } from './mass-planner-formats';
import type { MassPlanCommand } from './mass-planner-types';

/**
 * Executor do comando (mesmas regras do arquivamento v0.28+: dono da origem
 * pelo dump, fallback "Grupo <nome>", ";" saneado para não quebrar a gramática
 * "nick;coords", teto de 40 do SG_6).
 */
export function executorNick(command: MassPlanCommand): string {
  return (command.originOwner ?? `Grupo ${command.groupName}`).replace(/;/g, '−').slice(0, 40);
}

/**
 * Insumos do pacote de comunicação a partir dos comandos da OP:
 * - distribution: uma linha "nick;alvo alvo …" por executor (ordem da 1ª
 *   aparição, alvos na ordem dos comandos);
 * - sendSchedule: a agenda colável do app (formatColavel), com o cabeçalho
 *   "# Chegada desejada" e o sufixo "@dd/MM" nas partidas de outro dia.
 */
export function opCommsInputs(commands: readonly MassPlanCommand[]): {
  distribution: string;
  sendSchedule: string;
} {
  const byNick = new Map<string, string[]>();
  for (const command of commands) {
    const nick = executorNick(command);
    const list = byNick.get(nick) ?? [];
    list.push(command.target);
    byNick.set(nick, list);
  }
  const distribution = [...byNick.entries()]
    .map(([nick, targets]) => `${nick};${targets.join(' ')}`)
    .join('\n');
  return { distribution, sendSchedule: formatColavel(commands) };
}

/**
 * MPs por executor da OP: alvos dele + horário de envio de cada um (o
 * fail-closed do comms-package aplica: nick sem horário ou alvo sem par na
 * agenda aborta com erro claro — como ambos vêm da MESMA lista de comandos,
 * dessincronização é bug, não estado possível).
 */
export function buildOpComms(
  commands: readonly MassPlanCommand[],
  opTitle: string,
  template: string,
): PlayerComms[] {
  const { distribution, sendSchedule } = opCommsInputs(commands);
  return buildPlayerComms({ opTitle, template, distribution, sendSchedule });
}
