// Pós-OP (P1-17): verificação de resultado — compara o dump do mundo ANTES da
// OP com o dump DEPOIS para classificar cada alvo: conquistado / defendido /
// desperdiçado. Puro, determinístico, fail-closed.
//
// A identidade do dono muda via playerId (não nome — nomes podem mudar).

export interface PreOpVillage {
  coord: string;
  playerId: number;
  allyId: number;
}

export interface PostOpVillage {
  coord: string;
  playerId: number;
  allyId: number;
}

export interface PostOpTarget {
  coord: string;
  /** Jogador(s) da nossa tribo que enviaram comandos para este alvo. */
  senders: string[];
  /** Nº de comandos com nobre reportados na conferência (para desperdício). */
  nobleCount: number;
}

export interface PostOpOutcome {
  coord: string;
  status: 'conquistado' | 'defendido' | 'desperdiçado' | 'sem-dados';
  /** Dono ANTES da OP (playerId). */
  beforePlayerId: number | null;
  /** Dono DEPOIS da OP (playerId). */
  afterPlayerId: number | null;
  /** true se o novo dono pertence à própria tribo (allyId igual). */
  conqueredByAlly: boolean;
  senders: string[];
  nobleCount: number;
  detail: string;
}

export interface PostOpInput {
  /** Dump do mundo ANTES da OP (pré-OP). */
  before: PreOpVillage[];
  /** Dump do mundo DEPOIS da OP (pós-OP). */
  after: PostOpVillage[];
  /** Alvos da OP com dados da conferência. */
  targets: PostOpTarget[];
  /** allyId da própria tribo (para identificar conquista própria). */
  ownAllyId: number;
  /** IDs de jogadores da própria tribo no pós-OP (para detectar conquista). */
  ownPlayerIds: Set<number>;
}

export interface PostOpResult {
  outcomes: PostOpOutcome[];
  totals: {
    conquistado: number;
    defendido: number;
    desperdiçado: number;
    'sem-dados': number;
    /** Taxa de acerto: conquistados / (conquistados + desperdiçados). */
    conquestRate: number;
    /** Nobres desperdiçados em alvos defendidos. */
    wastedNobles: number;
  };
}

/**
 * Classifica cada alvo da OP comparando dono antes × depois:
 * - conquistado: dono mudou para jogador da própria tribo
 * - desperdiçado: dono NÃO mudou e houve nobres enviados
 * - defendido: dono NÃO mudou e não houve nobres (só ataques limpos)
 * - sem-dados: alvo não encontrado no dump pós-OP (coord mudou de dono nome? fail-closed com aviso)
 */
export function verifyPostOp(input: PostOpInput): PostOpResult {
  if (input.before.length === 0) {
    throw new Error('Dump PRÉ-OP vazio — atualize os dados do mundo antes da OP para comparar.');
  }
  if (input.after.length === 0) {
    throw new Error('Dump PÓS-OP vazio — atualize os dados do mundo depois da OP para verificar.');
  }
  if (input.targets.length === 0) {
    throw new Error('Nenhum alvo da OP informado — informe os alvos da distribuição.');
  }

  const beforeByCoord = new Map(input.before.map((v) => [v.coord, v]));
  const afterByCoord = new Map(input.after.map((v) => [v.coord, v]));

  const outcomes: PostOpOutcome[] = [];
  const totals = { conquistado: 0, defendido: 0, desperdiçado: 0, 'sem-dados': 0, conquestRate: 0, wastedNobles: 0 };

  for (const target of input.targets) {
    const before = beforeByCoord.get(target.coord) ?? null;
    const after = afterByCoord.get(target.coord) ?? null;

    // Fail-closed: alvo sem dados em um dos dumps é classificado sem-dados.
    if (before === null || after === null) {
      const missing = before === null ? 'pré-OP' : 'pós-OP';
      const outcome: PostOpOutcome = {
        coord: target.coord,
        status: 'sem-dados',
        beforePlayerId: before?.playerId ?? null,
        afterPlayerId: after?.playerId ?? null,
        conqueredByAlly: false,
        senders: target.senders,
        nobleCount: target.nobleCount,
        detail: `Alvo sem dados no dump ${missing} — verifique se a coordenada existe.`,
      };
      outcomes.push(outcome);
      totals['sem-dados'] += 1;
      continue;
    }

    const ownerChanged = before.playerId !== after.playerId;
    const conqueredByAlly = ownerChanged && input.ownPlayerIds.has(after.playerId);

    if (ownerChanged && conqueredByAlly) {
      outcomes.push({
        coord: target.coord,
        status: 'conquistado',
        beforePlayerId: before.playerId,
        afterPlayerId: after.playerId,
        conqueredByAlly: true,
        senders: target.senders,
        nobleCount: target.nobleCount,
        detail: `Conquistado por jogador da tribo (dono ${before.playerId} → ${after.playerId}).`,
      });
      totals.conquistado += 1;
    } else if (ownerChanged && !conqueredByAlly) {
      // Dono mudou mas não é da nossa tribo — outro tomou primeiro.
      outcomes.push({
        coord: target.coord,
        status: 'desperdiçado',
        beforePlayerId: before.playerId,
        afterPlayerId: after.playerId,
        conqueredByAlly: false,
        senders: target.senders,
        nobleCount: target.nobleCount,
        detail: `Dono mudou para jogador de FORA da tribo (${after.playerId}) — alvo perdido para outro.`,
      });
      totals.desperdiçado += 1;
      totals.wastedNobles += target.nobleCount;
    } else if (!ownerChanged && target.nobleCount > 0) {
      // Dono não mudou e houve nobres — nobres desperdiçados.
      outcomes.push({
        coord: target.coord,
        status: 'desperdiçado',
        beforePlayerId: before.playerId,
        afterPlayerId: after.playerId,
        conqueredByAlly: false,
        senders: target.senders,
        nobleCount: target.nobleCount,
        detail: `${target.nobleCount} nobre(s) desperdiçado(s) — alvo defendeu com sucesso.`,
      });
      totals.desperdiçado += 1;
      totals.wastedNobles += target.nobleCount;
    } else {
      // Dono não mudou, sem nobres — ataque foi repelido (fake/limpeza).
      outcomes.push({
        coord: target.coord,
        status: 'defendido',
        beforePlayerId: before.playerId,
        afterPlayerId: after.playerId,
        conqueredByAlly: false,
        senders: target.senders,
        nobleCount: target.nobleCount,
        detail: 'Alvo defendeu o ataque (sem nobres relatados).',
      });
      totals.defendido += 1;
    }
  }

  const attempted = totals.conquistado + totals.desperdiçado;
  totals.conquestRate = attempted > 0 ? Math.round((totals.conquistado / attempted) * 100) : 0;

  // Ordenar por gravidade: desperdiçado primeiro (o que dói mais).
  outcomes.sort((a, b) => {
    const rank: Record<PostOpOutcome['status'], number> = { desperdiçado: 0, conquistado: 1, defendido: 2, 'sem-dados': 3 };
    return rank[a.status] - rank[b.status] || b.nobleCount - a.nobleCount;
  });

  return { outcomes, totals };
}
