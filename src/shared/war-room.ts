// Sala de Guerra e scorecard do arquivo de OPs: engines puras que derivam a
// conferência de alvos (mesma semântica do verify SG_5) e o desempenho
// agregado por jogador a partir das OPs arquivadas. Sem DOM, sem relógio —
// determinístico por construção.
import type { OpArchiveEntry, OpPlayerConference } from './ipc-types';

/** Linha válida da distribuição "nick;coord coord" (mesma regex de SG_5/SG_6). */
const DISTRIBUTION_LINE = /^([^;]{2,40});((?:\d{1,3}\|\d{1,3}\s*)+)$/;

/**
 * Faz o parse da distribuição "nick;coords" (saída do SG_4): uma linha por
 * jogador, várias coordenadas separadas por espaço. Linhas vazias são
 * ignoradas; linha malformada interrompe tudo com erro claro (fail-closed,
 * nunca dado parcial silencioso).
 */
export function parseDistribution(text: string): { playerName: string; coords: string[] }[] {
  const entries: { playerName: string; coords: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = DISTRIBUTION_LINE.exec(trimmed);
    if (match === null) {
      throw new Error(`Linha inválida (use "nick;coord coord"): "${trimmed.slice(0, 60)}"`);
    }
    entries.push({ playerName: match[1] ?? '', coords: (match[2] ?? '').trim().split(/\s+/) });
  }
  return entries;
}

/** Aldeia vigiada na Sala de Guerra (aceita subconjunto do verify SG_5 real). */
export interface WarRoomVillage {
  /** Coordenada "x|y" do alvo. */
  coord: string;
  /** Comandos chegando; para cobertura basta o nick de quem enviou. */
  commands: { playerName: string }[];
}

/**
 * Conferência da Sala de Guerra: para cada linha da distribuição, uma coord é
 * "enviada" quando existe ≥1 comando COM O PRÓPRIO NICK do dono na aldeia
 * daquela coord — comando de outro jogador cobre o alvo dele, nunca a divida
 * do dono. coveragePct = soma(enviadas)/soma(atribuídas) em %, 1 decimal (0 se
 * nada foi atribuído — nunca NaN). Aldeias em `villages` que ninguém atacou
 * são ignoradas. targetsWithoutCommand lista cada coord atribuída (a qualquer
 * jogador, sem repetir) cuja aldeia não existe na lista OU não tem comando
 * nenhum (de ninguém), na ordem em que aparecem.
 */
export function warRoomStatus(
  entries: { playerName: string; coords: string[] }[],
  villages: WarRoomVillage[],
): { coveragePct: number; perPlayer: OpPlayerConference[]; targetsWithoutCommand: string[] } {
  // coord → nicks com comando naquela aldeia (coleta gradual: coordenada
  // repetida entre villages soma os remetentes, nunca substitui).
  const sendersByCoord = new Map<string, string[]>();
  for (const village of villages) {
    const senders = sendersByCoord.get(village.coord) ?? [];
    for (const command of village.commands) senders.push(command.playerName);
    sendersByCoord.set(village.coord, senders);
  }

  let totalAssigned = 0;
  let totalSent = 0;
  const perPlayer: OpPlayerConference[] = [];
  const accounted = new Set<string>();
  const targetsWithoutCommand: string[] = [];

  for (const entry of entries) {
    let sent = 0;
    for (const coord of entry.coords) {
      totalAssigned += 1;
      const mine = (sendersByCoord.get(coord) ?? []).some((nick) => nick === entry.playerName);
      if (mine) sent += 1;
      // Sem comando NENHUM na aldeia (ou aldeia nem vigiada) → alvo carente.
      // Comando só de OUTRO jogador entra como sent dele, não aqui.
      if (!accounted.has(coord)) {
        accounted.add(coord);
        const senders = sendersByCoord.get(coord);
        if (senders === undefined || senders.length === 0) targetsWithoutCommand.push(coord);
      }
    }
    totalSent += sent;
    perPlayer.push({ playerName: entry.playerName, assigned: entry.coords.length, sent });
  }

  const coveragePct =
    totalAssigned === 0 ? 0 : Math.round((totalSent / totalAssigned) * 100 * 10) / 10;
  return { coveragePct, perPlayer, targetsWithoutCommand };
}

/** Linha do scorecard histórico por jogador (todas as OPs arquivadas juntas). */
export interface ScorecardRow {
  playerName: string;
  /** OPs cuja distribution cita o jogador (presente ≠ executou). */
  opsParticipated: number;
  /** Soma dos alvos atribuídos nos snapshots de conferência das OPs. */
  expected: number;
  /** Soma dos alvos efetivamente enviados conforme o snapshot. */
  sent: number;
  /** esperado − enviado (pode ser negativo se o snapshot inflar o envio). */
  missed: number;
}

/**
 * Scorecard agregado de todas as OPs, do mais antigo ao mais recente. Os
 * números (esperado/enviado) vêm SEMPRE do snapshot conference.perPlayer
 * quando existe — a distribuição é reparseada só para medir PARTICIPAÇÃO
 * (quem aparece citado nas linhas "nick;coords"). OP sem conference conta
 * apenas participação. Jogadores que aparecem só no perPlayer (sem linha na
 * distribution) entram no scorecard também: nunca descartar número arquivado.
 * Ordenação: missed decrescente, empate pelo nome em pt-BR.
 */
export function buildScorecard(ops: OpArchiveEntry[]): ScorecardRow[] {
  const aggregate = new Map<string, { participated: number; expected: number; sent: number }>();
  const touch = (playerName: string): { participated: number; expected: number; sent: number } => {
    const current = aggregate.get(playerName) ?? { participated: 0, expected: 0, sent: 0 };
    aggregate.set(playerName, current);
    return current;
  };

  // Ordem cronológica estável (mais antiga primeiro; empate mantém a ordem original).
  const ordered = ops
    .map((op, index) => ({ op, index }))
    .sort((a, b) => a.op.createdAt.localeCompare(b.op.createdAt) || a.index - b.index);

  for (const { op } of ordered) {
    for (const row of parseDistribution(op.distribution)) {
      touch(row.playerName).participated += 1;
    }
    const perPlayer = op.conference?.perPlayer ?? [];
    for (const cell of perPlayer) {
      const row = touch(cell.playerName);
      row.expected += cell.assigned;
      row.sent += cell.sent;
    }
  }

  const scorecard: ScorecardRow[] = [...aggregate].map(([playerName, row]) => ({
    playerName,
    opsParticipated: row.participated,
    expected: row.expected,
    sent: row.sent,
    missed: row.expected - row.sent,
  }));
  scorecard.sort((a, b) => b.missed - a.missed || a.playerName.localeCompare(b.playerName, 'pt-BR'));
  return scorecard;
}
