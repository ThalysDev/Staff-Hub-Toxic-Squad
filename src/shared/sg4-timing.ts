// Motor de TEMPO DE ENVIO (SG_4): converte a distribuição de alvos em agenda de
// envio ("a que hora o comando precisa SAIR para bater À HORA MARCADA") e monta
// TREM DE NOBRES (mesmo par origem×alvo com espaçamento fixo em segundos).
// Puro e determinístico: nada de relógio nem rede — a âncora do dia chega pronta
// (baseDate) e o tempo de viagem vem do caller (que depois integra bônus noturno).

import type { DistributionResult, OriginPlayer } from './sg4-engine';

/** Par origem×alvo resolvido pela distribuição, pronto para virar linha de agenda. */
export interface SendPair {
  /** Jogador de origem completo (nick/fulls); `origins` vem reduzido à vila DESTE
   * par (índice 0) — assim travelMinutesPerPair não tem ambiguidade de vila. */
  originPlayer: OriginPlayer;
  /** Coordenada do NT estacionado ("x|y") que ataca este alvo. */
  originCoord: string;
  /** Alvo atribuído a este par ("x|y"). */
  targetCoord: string;
}

/** DistributionResult + INFORMACOES ORIGEM: de onde saem nick/fulls/vila por par. */
export interface DistributionPlan {
  distribution: DistributionResult;
  origins: readonly OriginPlayer[];
}

/** Formas aceitas por computeSendTimes: lista de pares do resultado OU DistributionResult
 * + INFORMACOES ORIGEM (recupera nick/fulls SEM inventar dados — zerar fulls
 * silenciosamente violaria a política fail-closed). */
export type SendPlan = readonly SendPair[] | DistributionPlan;

export interface SendTimeInput {
  /** Chegada desejada no dia da âncora (ex.: OP às 22:00 → { hour: 22, minute: 0 }). */
  desiredArrival: { hour: number; minute: number };
  /** Âncora do dia da CHEGADA. O default (new Date()) é responsabilidade DO CALLER —
   * ausente aqui é erro: a engine pura nunca consulta o relógio. */
  baseDate?: Date;
  /** Minutos de viagem do par (futuro: bônus noturno aplicado dentro desta função). */
  travelMinutesPerPair: (origin: OriginPlayer, targetCoord: string) => number;
}

export interface SendScheduleRow {
  nick: string;
  originCoord: string;
  targetCoord: string;
  /** Momento em que o comando deve SAIR (horário local; pode cair no dia anterior). */
  sendAt: Date;
  travelMinutes: number;
  /** true somente nas linhas geradas pelo trem de nobres. */
  isNoble?: boolean;
}

// ---------------------------------------------------------------------------
// Agenda de envio
// ---------------------------------------------------------------------------

// Predicate próprio: Array.isArray não afina arranjos readonly na união.
function isDistributionPlan(plan: SendPlan): plan is DistributionPlan {
  return !Array.isArray(plan);
}

/** Achata o plano em pares; na forma "distribution + origins" valida que cada
 * assignment enxerga o jogador e a vila de origem informados (fail-closed). */
function flattenPlan(plan: SendPlan): SendPair[] {
  if (!isDistributionPlan(plan)) return [...plan];
  const byName = new Map<string, OriginPlayer>();
  for (const origin of plan.origins) {
    if (!byName.has(origin.playerName)) byName.set(origin.playerName, origin);
  }
  const pairs: SendPair[] = [];
  for (const assignment of plan.distribution.assignments) {
    const player = byName.get(assignment.playerName);
    if (player === undefined) {
      throw new Error(
        `Jogador de origem "${assignment.playerName}" da distribuição não está na lista INFORMACOES ORIGEM.`,
      );
    }
    const origin = player.origins.find((coord) => `${coord.x}|${coord.y}` === assignment.origin);
    if (origin === undefined) {
      throw new Error(
        `Aldeia de origem "${assignment.origin}" de "${assignment.playerName}" não está na lista INFORMACOES ORIGEM.`,
      );
    }
    pairs.push({
      originPlayer: { playerName: player.playerName, fulls: player.fulls, origins: [origin] },
      originCoord: assignment.origin,
      targetCoord: assignment.target,
    });
  }
  return pairs;
}

function requireBaseDate(baseDate: Date | undefined): Date {
  if (baseDate === undefined) {
    throw new Error(
      'Data âncora (baseDate) obrigatória: a engine pura não consulta o relógio — o caller passa "new Date()" quando o usuário não escolhe dia.',
    );
  }
  return baseDate;
}

function requireDesiredArrival(arrival: { hour: number; minute: number }): void {
  const { hour, minute } = arrival;
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error(
      `Chegada desejada inválida: ${hour}:${String(minute).padStart(2, '0')} — use hora 0–23 e minuto 0–59.`,
    );
  }
}

function requireTravelMinutes(minutes: number, nick: string, targetCoord: string): void {
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(
      `Tempo de viagem inválido (${minutes} min) para "${nick}" → ${targetCoord}: deve ser número finito maior ou igual a 0.`,
    );
  }
}

/**
 * Linha "saída = chegada desejada − tempo de viagem" para cada par da distribuição.
 * Viagem que ultrapassa as horas restantes do dia faz sendAt cair no dia anterior —
 * o Date fica CORRETO (16:30 de D-1 para chegar 00:30 de D); NADA é arredondado para
 * "caber no dia". A formatação (formatSendSchedule) mostra só HH:MM:SS por ser o
 * formato colado aos jogadores; a verdade absoluta fica no Date.
 */
export function computeSendTimes(plan: SendPlan, input: SendTimeInput): SendScheduleRow[] {
  requireDesiredArrival(input.desiredArrival);
  const base = requireBaseDate(input.baseDate);
  // Meia-noite do dia da âncora até a chegada desejada, no horário local.
  const arrival = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    input.desiredArrival.hour,
    input.desiredArrival.minute,
    0,
    0,
  );
  const rows: SendScheduleRow[] = [];
  for (const pair of flattenPlan(plan)) {
    const travelMinutes = input.travelMinutesPerPair(pair.originPlayer, pair.targetCoord);
    requireTravelMinutes(travelMinutes, pair.originPlayer.playerName, pair.targetCoord);
    // Arredonda ao ms: minutos podem ser fracionários (27.654 min/campo × campos).
    const sendAt = new Date(arrival.getTime() - Math.round(travelMinutes * 60_000));
    rows.push({
      nick: pair.originPlayer.playerName,
      originCoord: pair.originCoord,
      targetCoord: pair.targetCoord,
      sendAt,
      travelMinutes,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Trem de nobres
// ---------------------------------------------------------------------------

/** Opções do trem: N nobres por alvo, espaçamento fixo em segundos entre eles. */
export interface NobleTrainOptions {
  noblesPerTarget: number;
  spacingSec: number;
}

/**
 * Para cada linha de agenda gera N linhas do mesmo par origem×alvo: a primeira com
 * o sendAt original e as demais +k×spacingSec segundos — todas marcadas isNoble.
 * A Agenda de conferência do líder mostra os N horários de lançamento por alvo.
 */
export function nobleTrain(rows: readonly SendScheduleRow[], opts: NobleTrainOptions): SendScheduleRow[] {
  const { noblesPerTarget, spacingSec } = opts;
  if (!Number.isInteger(noblesPerTarget) || noblesPerTarget < 1) {
    throw new Error(
      `Quantidade de nobres por alvo inválida: ${noblesPerTarget} — informe um número inteiro maior ou igual a 1.`,
    );
  }
  if (!Number.isFinite(spacingSec) || spacingSec < 0) {
    throw new Error(
      `Espaçamento entre nobres inválido: ${spacingSec}s — informe um número de segundos maior ou igual a 0.`,
    );
  }
  const trained: SendScheduleRow[] = [];
  for (const row of rows) {
    const spacingMs = Math.round(spacingSec * 1000);
    for (let k = 0; k < noblesPerTarget; k++) {
      trained.push({
        nick: row.nick,
        originCoord: row.originCoord,
        targetCoord: row.targetCoord,
        sendAt: new Date(row.sendAt.getTime() + k * spacingMs),
        travelMinutes: row.travelMinutes,
        isNoble: true,
      });
    }
  }
  return trained;
}

// ---------------------------------------------------------------------------
// Formatação (texto que o líder cola para os jogadores)
// ---------------------------------------------------------------------------

/** HH:MM:SS local com pad de 2 — formato dos horários nos textos copiáveis. */
export function formatHms(date: Date): string {
  const part = (value: number) => String(value).padStart(2, '0');
  return `${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

/**
 * Texto copiável no formato ORIGINAL "nick;alvo;HH:MM:SS", uma linha por envio,
 * agrupado por nick (ordem da 1ª aparição preservada). Cabeçalho-comentário com a
 * chegada desejada: como as linhas carregam apenas o sendAt, ela é reconstruída
 * (sendAt + viagem) da PRIMEIRA linha — a referência da OP. Nos trens, os nobres
 * seguintes chegam depois POR DESIGN (espaçamento); o rótulo segue a 1ª chegada.
 * Quando um envio cai fora do dia da chegada (viagens longas, D-1/D-2), a linha
 * ganha sufixo "@dd/MM" — sem isso o líder cola "enviar às 14:20" sem saber
 * de qual dia (o HH:MM:SS puro também é o formato que o T-minus relê).
 */
export function formatSendSchedule(rows: readonly SendScheduleRow[]): string {
  if (rows.length === 0) return '';
  const reference = rows[0];
  const referenceArrival = new Date(
    (reference?.sendAt.getTime() ?? 0) + Math.round((reference?.travelMinutes ?? 0) * 60_000),
  );
  const arrivalDay = referenceArrival.toDateString();
  const daySuffix = (date: Date): string => (date.toDateString() === arrivalDay ? '' : ` @${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`);
  const byNick = new Map<string, SendScheduleRow[]>();
  for (const row of rows) {
    const list = byNick.get(row.nick) ?? [];
    list.push(row);
    byNick.set(row.nick, list);
  }
  const lines: string[] = [`# Chegada desejada: ${formatHms(referenceArrival)} (${String(referenceArrival.getDate()).padStart(2, '0')}/${String(referenceArrival.getMonth() + 1).padStart(2, '0')})`];
  for (const [nick, nickRows] of byNick) {
    for (const row of nickRows) {
      lines.push(`${nick};${row.targetCoord};${formatHms(row.sendAt)}${daySuffix(row.sendAt)}`);
    }
  }
  return lines.join('\n');
}
