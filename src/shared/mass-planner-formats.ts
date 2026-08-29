// Sala de Guerra · Planner de OP em Massa — FORMATOS de exportação.
// Funções PURAS que convertem a lista de comandos gerada nos textos que a staff
// consome: Russian Planner e TW Mass Planner (ferramentas externas de referência)
// e o formato colável DO APP ("nick;alvo;HH:MM:SS[ @dd/MM]", reusado pelo
// T-minus, pacote de comunicação e SG_6 — mesma gramática dos 4 consumidores).
//
// Os dois formatos externos seguem a convenção das ferramentas de origem:
// UMA linha por comando com origem, alvo, unidade mais lenta e horário de ENVIO
// (partida) — o horário que os jogadores executam. Russian Planner usa data ISO
// "aaaa-mm-dd hh:mm:ss"; TW Mass Planner usa "dd.mm.aaaa hh:mm:ss".

import { formatSendSchedule } from './sg4-timing';
import { UNITS } from './units';
import type { MassPlanCommand } from './mass-planner-types';

/** "aaaa-mm-dd hh:mm:ss" no relógio local (ordenável, sem ambiguidade de barra). */
function formatIsoLocal(ms: number): string {
  const at = new Date(ms);
  const part = (value: number): string => String(value).padStart(2, '0');
  return (
    `${at.getFullYear()}-${part(at.getMonth() + 1)}-${part(at.getDate())} ` +
    `${part(at.getHours())}:${part(at.getMinutes())}:${part(at.getSeconds())}`
  );
}

/** "dd.mm.aaaa hh:mm:ss" no relógio local (convenção do TW Mass Planner). */
function formatDotLocal(ms: number): string {
  const at = new Date(ms);
  const part = (value: number): string => String(value).padStart(2, '0');
  return (
    `${part(at.getDate())}.${part(at.getMonth() + 1)}.${at.getFullYear()} ` +
    `${part(at.getHours())}:${part(at.getMinutes())}:${part(at.getSeconds())}`
  );
}

/** Linhas "origem alvo unidade envio" — base dos dois formatos externos. */
function toolLines(commands: readonly MassPlanCommand[], formatMs: (ms: number) => string): string[] {
  return commands.map((command) => {
    const unitName = UNITS[command.unit]?.name ?? command.unit;
    return `${command.origin} ${command.target} ${unitName} ${formatMs(command.sendMs)}`;
  });
}

/**
 * Russian Planner: `x1|y1 x2|y2 Unidade aaaa-mm-dd hh:mm:ss` (horário de ENVIO,
 * uma linha por comando). Ordem = a lista recebida (recomenda-se chegada crescente).
 */
export function formatRussianPlanner(commands: readonly MassPlanCommand[]): string {
  return toolLines(commands, formatIsoLocal).join('\n');
}

/**
 * TW Mass Planner: `x1|y1 x2|y2 Unidade dd.mm.aaaa hh:mm:ss` (horário de ENVIO,
 * uma linha por comando). Ordem = a lista recebida.
 */
export function formatTwMassPlanner(commands: readonly MassPlanCommand[]): string {
  return toolLines(commands, formatDotLocal).join('\n');
}

/** Rótulo pt-BR da unidade para cabeçalhos/colunas. */
export function unitLabel(unit: MassPlanCommand['unit']): string {
  return UNITS[unit]?.name ?? unit;
}

/**
 * Formato colável DO APP: "nick;alvo;HH:MM:SS[ @dd/MM]" — nick é o DONO DA
 * ORIGEM (executor do comando pelo dump); sem dono conhecido, cai para o nome
 * do grupo (";" saneado para "−"). Reusa formatSendSchedule (fonte única da
 * gramática consumida por T-minus/comms/SG_6), incluindo o cabeçalho "# Chegada
 * desejada" e o sufixo "@dd/MM" nas partidas fora do dia da chegada.
 */
export function formatColavel(commands: readonly MassPlanCommand[]): string {
  const rows = commands.map((command) => {
    // Nick (executor) com teto de 40: a gramática "nick;alvo;HH:MM:SS" é lida
    // pelo T-minus/comms/SG_6, que validam nick em até 40 caracteres.
    const nick = (command.originOwner ?? `Grupo ${command.groupName}`).replace(/;/g, '−').slice(0, 40);
    return {
      nick,
      originCoord: command.origin,
      targetCoord: command.target,
      sendAt: new Date(command.sendMs),
      // Minutos EXATOS (chegada − partida): formatSendSchedule reconstrói a
      // chegada de referência a partir deles — valor arredondado truncaria o
      // horário em 1s (21:59:59 em vez de 22:00:00).
      travelMinutes: (command.arrivalMs - command.sendMs) / 60_000,
    };
  });
  return formatSendSchedule(rows);
}
