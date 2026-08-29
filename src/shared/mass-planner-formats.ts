// Sala de Guerra · Planner de OP em Massa — FORMATOS de exportação.
// v0.29.0: os formatos "Russian Planner" e "TW Mass Planner" são agora BYTE-
// FIÉIS à ferramenta real (twmassplanner.pro) — decifrados de ZIPs de operações
// geradas com chave válida: BBCode para colar no CADERNO DA CONTA PREMIUM,
// blocos por jogador de origem, horários em milissegundos "HH:MM:SS:mmm
// dd.mm.aaaa", dono do alvo e link direto da praça de reunião (com o ID da
// vila de ORIGEM). Mantido o formato colável DO APP ("nick;alvo;HH:MM:SS
// @dd/MM" — T-minus/comms/SG_6) como terceira saída.

import { formatSendSchedule } from './sg4-timing';
import { UNITS } from './units';
import type { MassPlanCommand } from './mass-planner-types';

/** "HH:MM:SS:mmm dd.mm.aaaa" no relógio local — formato dos tempos reais. */
function formatPlannerTime(ms: number): string {
  const at = new Date(ms);
  const part = (value: number): string => String(value).padStart(2, '0');
  return (
    `${part(at.getHours())}:${part(at.getMinutes())}:${part(at.getSeconds())}:` +
    `${String(at.getMilliseconds()).padStart(3, '0')} ` +
    `${part(at.getDate())}.${part(at.getMonth() + 1)}.${at.getFullYear()}`
  );
}

/** Limpa texto livre para célula BBCode (o jogo não parseia [, ], | e ; dentro). */
function bbSafe(text: string): string {
  return text.replace(/[[\]|;]/g, ' ').trim();
}

interface PlanBlock {
  nick: string;
  rows: MassPlanCommand[];
}

/**
 * Blocos POR JOGADOR DE ORIGEM (igual ao tool real): cada nick ganha o seu
 * "Mass plan". Blocos ordenados pela chegada mais cedo do bloco (empate: ordem
 * de aparição); linhas do bloco por HORÁRIO DE ENVIO ascendente.
 */
function buildBlocks(commands: readonly MassPlanCommand[]): PlanBlock[] {
  const byNick = new Map<string, MassPlanCommand[]>();
  for (const command of commands) {
    const nick = bbSafe(command.originOwner ?? `Grupo ${command.groupName}`) || 'Grupo';
    const list = byNick.get(nick) ?? [];
    list.push(command);
    byNick.set(nick, list);
  }
  const blocks: PlanBlock[] = [];
  for (const [nick, rows] of byNick) {
    rows.sort((a, b) => a.sendMs - b.sendMs);
    blocks.push({ nick, rows });
  }
  blocks.sort(
    (a, b) =>
      Math.min(...a.rows.map((row) => row.arrivalMs)) - Math.min(...b.rows.map((row) => row.arrivalMs)),
  );
  return blocks;
}

/** Link da praça de reunião com o ID da vila de ORIGEM (igual ao tool real). */
function rallyLink(command: MassPlanCommand, world: string): string {
  const server = (world || 'br').toLowerCase();
  const target = command.target.split('|');
  const tx = target[0] ?? '0';
  const ty = target[1] ?? '0';
  const village = command.originVillageId === null ? '' : `village=${command.originVillageId}&`;
  return `https://${server}.tribalwars.com.br/game.php?${village}screen=place&x=${tx}&y=${ty}&from=simulator`;
}

/** Edifício-alvo na exportação: primeira mira escolhida ou "farm" (default do tool real). */
function attackBuilding(command: MassPlanCommand): string {
  return bbSafe(command.catapultTargets[0] ?? '') || 'farm';
}

/**
 * Monta o texto completo de um formato: variant "russian" (4 colunas) ou
 * "twmp" (6 colunas, com Time arrival e Attack building). Estrutura copiada
 * dos arquivos reais russian_planner-planners.txt / tw_mass_planner-planners.txt.
 */
function buildPlannerText(commands: readonly MassPlanCommand[], world: string, variant: 'russian' | 'twmp'): string {
  const blocks = buildBlocks(commands);
  const parts: string[] = [];
  for (const block of blocks) {
    const headerTime = formatPlannerTime(Math.min(...block.rows.map((row) => row.arrivalMs)));
    const header =
      variant === 'russian'
        ? '[**]#. Time send-->Attack type[||]Your coords-->Target coords[||]Target[||]Rally point direct link[/**]'
        : '[**]#. Time send-->Attack type[||]Time arrival[||]Your coords-->Target coords[||]Target[||]Attack building[||]Rally point direct link[/**]';
    const rowsText = block.rows
      .map((row, index) => {
        const send = formatPlannerTime(row.sendMs);
        const template = bbSafe(row.groupName) || 'ataque';
        const owner = bbSafe(row.targetOwner ?? '') || '—';
        const link = rallyLink(row, world);
        const base = `[*]${index + 1}. ${send} --- ${template}`;
        if (variant === 'russian') {
          return `${base}[|] ${row.origin} --> ${row.target} [|]${owner}[|][url=${link}]Link[/url]`;
        }
        const arrival = formatPlannerTime(row.arrivalMs);
        return `${base}[|]${arrival}[|] ${row.origin} --> ${row.target} [|]${owner}[|]${attackBuilding(row)}[|][url=${link}]Link[/url]`;
      })
      .join('\n');
    // Recap "targets": uma linha por template do bloco, alvos na ordem das linhas.
    const targetsByTemplate = new Map<string, string[]>();
    for (const row of block.rows) {
      const template = bbSafe(row.groupName) || 'ataque';
      const list = targetsByTemplate.get(template) ?? [];
      list.push(row.target);
      targetsByTemplate.set(template, list);
    }
    const targetsText = [...targetsByTemplate.entries()]
      .map(([template, targets]) => `${template} targets: ${targets.join(' ')} `)
      .join('\n');
    parts.push(
      `[b]Mass plan for [player]${block.nick}[/player][/b]\n` +
        `[spoiler=For premium account notebook][code][b]Mass plan for [player]${block.nick}[/player][/b]\n` +
        `[b]Mass time arrival: ${headerTime}[/b]\n` +
        `[table]${header}\n` +
        `${rowsText}\n` +
        `[/table][/code][/spoiler]\n` +
        `\n` +
        `[spoiler=your targets for custom calculation]\n` +
        `[code]${targetsText}\n[/code][/spoiler]`,
    );
  }
  return parts.join('\n');
}

/**
 * Russian Planner (formato REAL do tool): BBCode por jogador para o caderno
 * premium, com horário de ENVIO e link da praça. `world` = id do mundo (ex. "br142").
 */
export function formatRussianPlanner(commands: readonly MassPlanCommand[], world: string): string {
  return buildPlannerText(commands, world, 'russian');
}

/**
 * TW Mass Planner (formato REAL do tool): igual ao Russian + colunas Time
 * arrival e Attack building (default "farm" sem mira de catapulta).
 */
export function formatTwMassPlanner(commands: readonly MassPlanCommand[], world: string): string {
  return buildPlannerText(commands, world, 'twmp');
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
