// Triagem de DESTINATÁRIOS de MP (v0.36.1): antes de enviar pela Sala de
// Guerra (Comunicação da OP / Cobrar faltas), classifica cada nick contra os
// dados do MUNDO (player.txt tem a tribo de cada jogador) e a DIPLOMACIA da
// tribo (relações own/inimigo/aliado/nap). Caso real relatado pela staff
// (20/09): MP saiu para um JOGADOR INIMIGO porque o roster vinha de dados
// persistidos de uma OP antiga (jogador saiu da tribo e virou inimigo) —
// nenhum fluxo validava o destinatário contra o cenário atual.
//
// Fail-closed na direção certa: sem dados do mundo ou sem relações, o status é
// 'desconhecido' — a UI bloqueia por padrão e deixa o líder decidir.

import { fold } from './fold';
import type { DiplomacyRelations, WorldPlayer } from './types';

export type RecipientRelation = 'propria-tribo' | 'aliado' | 'nap' | 'inimigo' | 'sem-tribo' | 'desconhecido';

export interface ScreenedRecipient {
  nick: string;
  status: RecipientRelation;
  /** Tag da tribo atual do nick no mundo (null = sem tribo / jogador não encontrado). */
  tribeTag: string | null;
}

/** Rótulo PT-BR para exibição/pills. */
export const RECIPIENT_RELATION_LABEL: Record<RecipientRelation, string> = {
  'propria-tribo': 'Própria tribo',
  aliado: 'Aliado',
  nap: 'NAP',
  inimigo: 'INIMIGO',
  'sem-tribo': 'Sem tribo',
  desconhecido: 'Desconhecido',
};

/** Índice fold(nick) → jogador. Construa 1× por triagem (players ~100k). */
export function buildNickIndex(players: readonly WorldPlayer[]): Map<string, WorldPlayer> {
  const index = new Map<string, WorldPlayer>();
  for (const player of players) {
    const key = fold(player.name);
    const existing = index.get(key);
    // Colisão de fold (nicks gêmeos raros): mantém o de MAIOR pontos — o
    // jogador "principal" daquele nome no mundo.
    if (existing === undefined || player.points > existing.points) index.set(key, player);
  }
  return index;
}

function tribeTagOf(allyId: number, relations: DiplomacyRelations | null): string | null {
  if (relations === null || allyId === 0) return null;
  if (allyId === relations.ownAllyId) return relations.ownTag || null;
  return (
    relations.enemies.find((relation) => relation.allyId === allyId)?.tag ??
    relations.allies.find((relation) => relation.allyId === allyId)?.tag ??
    relations.naps.find((relation) => relation.allyId === allyId)?.tag ??
    null
  );
}

/**
 * Classifica cada nick: 'propria-tribo' (allyId = ownAllyId), 'inimigo'
 * (tribo na lista de inimigos da diplomacia), 'aliado'/'nap', 'sem-tribo'
 * (allyId 0) ou 'desconhecido' (nick não existe no dump do mundo OU
 * relações indisponíveis — dados velhos não inventam classificação).
 * Nicks duplicados na entrada → uma linha só (mesma ordem da 1ª ocorrência).
 */
export function screenRecipients(
  nicks: readonly string[],
  playersIndex: Map<string, WorldPlayer>,
  relations: DiplomacyRelations | null,
): ScreenedRecipient[] {
  const seen = new Set<string>();
  const out: ScreenedRecipient[] = [];
  for (const nick of nicks) {
    const key = fold(nick);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    const player = playersIndex.get(key);
    if (player === undefined || relations === null) {
      out.push({ nick, status: 'desconhecido', tribeTag: null });
      continue;
    }
    const tribeTag = tribeTagOf(player.allyId, relations);
    let status: RecipientRelation;
    if (player.allyId === 0) status = 'sem-tribo';
    else if (player.allyId === relations.ownAllyId) status = 'propria-tribo';
    else if (relations.enemies.some((relation) => relation.allyId === player.allyId)) status = 'inimigo';
    else if (relations.allies.some((relation) => relation.allyId === player.allyId)) status = 'aliado';
    else if (relations.naps.some((relation) => relation.allyId === player.allyId)) status = 'nap';
    else status = 'desconhecido';
    out.push({ nick, status, tribeTag });
  }
  return out;
}

/**
 * Resumo para o confirm de bloqueio: os grupos que NÃO são segura-tribo,
 * na ordem de gravidade (inimigo > desconhecido > sem-tribo > nap/aliado).
 * Devolve null quando TODOS são da própria tribo (fluxo segue sem atrito).
 */
export function blockedRecipientGroups(
  screened: readonly ScreenedRecipient[],
): { status: RecipientRelation; nicks: string[] }[] | null {
  const order: RecipientRelation[] = ['inimigo', 'desconhecido', 'sem-tribo', 'nap', 'aliado'];
  const groups = order
    .map((status) => ({
      status,
      nicks: screened.filter((recipient) => recipient.status === status).map((recipient) => recipient.nick),
    }))
    .filter((group) => group.nicks.length > 0);
  return groups.length > 0 ? groups : null;
}
