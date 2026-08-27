// Regras PURAS do débito de blind por jogador (roadmap item 14, SG_3):
// acumula, entre as rodadas reconhecidas nos tópicos, quanto cada jogador
// PEDIU de blind e quanto foi ENVIADO/aprovado. A identidade do jogador é o
// playerName com trim (tópico e conferência podem digitar com espaços a mais);
// saldo positivo = deve blind, negativo = credor. Nada de electron nem
// persistência aqui — ipc-history (src/main/ipc-history.ts) aplica estas
// funções sobre o JsonStore 'blind-debt' e journala cada evento.

/** Teto da lista: mesclar um jogador NOVO além de 200 lança erro PT-BR. */
export const MAX_BLIND_DEBT_PLAYERS = 200;

export interface BlindDebtEntry {
  /** 1–40 caracteres após trim; é a identidade do jogador no débito. */
  playerName: string;
  /** Somatório de blind PEDIDO nos tópicos (>= 0). */
  requested: number;
  /** Somatório ENVIADO/aprovado (>= 0). */
  sent: number;
  /** ISO da última mesclagem que tocou este jogador. */
  updatedAt: string;
}

/** Entrada de uma rodada reconhecida (mesma forma da IPC blinddebt:apply). */
export interface BlindDebtRoundEntry {
  playerName: string;
  requested: number;
  sent: number;
}

/** Saldo do jogador: positivo = deve blind; negativo = credor (enviou além do pedido). */
export function blindBalance(entry: BlindDebtEntry): number {
  return entry.requested - entry.sent;
}

/**
 * Validação fail-closed de UMA entrada da rodada: nome 1–40 após trim e
 * requested/sent finitos >= 0. Inválido lança erro PT-BR citando o jogador
 * (nome válido) ou a posição na rodada (nome inutilizável) — nunca dado
 * errado silencioso. Devolve a entrada sanitizada (nome com trim).
 */
function validateRoundEntry(item: BlindDebtRoundEntry, position: number): BlindDebtRoundEntry {
  const playerName = typeof item.playerName === 'string' ? item.playerName.trim() : '';
  if (playerName.length < 1 || playerName.length > 40) {
    throw new Error(
      `Nome do jogador inválido na rodada de blind (posição ${position + 1}) — informe entre 1 e 40 caracteres.`,
    );
  }
  if (!Number.isFinite(item.requested) || !Number.isFinite(item.sent) || item.requested < 0 || item.sent < 0) {
    throw new Error(
      `Valores inválidos na rodada de blind para o jogador "${playerName}" — pedido e enviado devem ser números maiores ou iguais a zero.`,
    );
  }
  return { playerName, requested: item.requested, sent: item.sent };
}

/**
 * Mescla UMA rodada reconhecida no débito acumulado, por playerName com trim:
 * - a rodada inteira é validada ANTES de qualquer mesclagem (uma entrada
 *   inválida não altera o débito acumulado);
 * - o mesmo jogador pode aparecer mais de uma vez na rodada (colisão de trim
 *   de propósito): os valores somam em uma única entrada;
 * - cap de MAX_BLIND_DEBT_PLAYERS: mesclar jogador NOVO além do teto lança
 *   erro PT-BR citando o limite e o jogador; ATUALIZAR um existente com a
 *   lista cheia passa;
 * - updatedAt dos jogadores tocados vira o `now` injetado; os não tocados
 *   preservam a data antiga;
 * - nunca muta os inputs: devolve lista nova de objetos novos, ordenada por
 *   saldo (requested - sent) DESC, empate por nome em pt-BR.
 */
export function mergeBlindDebtRound(
  current: readonly BlindDebtEntry[],
  round: readonly BlindDebtRoundEntry[],
  now: Date,
): BlindDebtEntry[] {
  const updatedAt = now.toISOString();
  const validated = round.map((item, position) => validateRoundEntry(item, position));

  // Cap: só JOGADORES NOVOS contam contra o teto (atualizar existente passa).
  const known = new Set(current.map((entry) => entry.playerName.trim()));
  const newcomers = new Set(validated.filter((item) => !known.has(item.playerName)).map((item) => item.playerName));
  if (newcomers.size > 0 && known.size + newcomers.size > MAX_BLIND_DEBT_PLAYERS) {
    const overflow = validated.find((item) => newcomers.has(item.playerName))!;
    throw new Error(
      `Lista de débito de blind cheia — limite de ${MAX_BLIND_DEBT_PLAYERS} jogadores alcançado; remova jogadores antes de adicionar "${overflow.playerName}".`,
    );
  }

  // Mesclagem sem mutação: mapa nome(trim)→entrada preserva a identidade e
  // reaproveita objetos NOVOS (cópias) dos não tocados.
  const merged = new Map<string, BlindDebtEntry>();
  for (const entry of current) {
    const name = entry.playerName.trim();
    if (!merged.has(name)) merged.set(name, { ...entry, playerName: name });
  }
  for (const item of validated) {
    const existing = merged.get(item.playerName);
    merged.set(item.playerName, {
      playerName: item.playerName,
      requested: (existing?.requested ?? 0) + item.requested,
      sent: (existing?.sent ?? 0) + item.sent,
      updatedAt,
    });
  }

  // Ordem de exibição: maior devedor primeiro (saldo DESC); empate por nome pt-BR.
  return [...merged.values()].sort((a, b) => {
    const byBalance = blindBalance(b) - blindBalance(a);
    return byBalance !== 0 ? byBalance : a.playerName.localeCompare(b.playerName, 'pt-BR');
  });
}
