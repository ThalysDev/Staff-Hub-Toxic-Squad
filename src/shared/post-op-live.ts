// Pós-OP ao vivo (Sala de Guerra) — variante da verificação de resultado que
// prescinde do dump PRÉ-OP. O motor canônico (post-op.ts) compara o mundo
// ANTES × DEPOIS da OP e continua sendo a fonte da verdade quando os dois
// dumps existem; como o Staff Hub não arquiva o dump pré-OP, montar um
// `PostOpInput.before` plausível seria inventar dado (o dono pré-OP de cada
// alvo é desconhecido e um sentinel faria "dono mudou" virar sempre verdade).
// Esta variante classifica cada alvo pelo DONO ATUAL no dump pós-OP:
//   - conquistado  : dono atual pertence à tribo própria (allyId igual);
//   - defendido    : dono atual é de inimiga DECLARADA — o alvo não caiu;
//   - desperdiçado : dono atual é terceiro ou bárbaro — alvo tomado por outro
//                    ("conquistada para terceiros");
//   - sem-dados    : coordenada não existe no dump pós-OP (fail-closed).
// Limitações honestas (a UI documenta):
//   - tribo própria e inimigas valem NO MOMENTO da verificação — se a
//     diplomacia mudou desde a OP, a fronteira defendido × terceiro acompanha;
//   - sem o pré-OP não dá para separar "o terceiro tomou na OP" de "já era
//     dele" — o painel mostra o retrato atual, não a linhagem completa.
// Nobres: o arquivo da OP guarda nobleAttacks POR JOGADOR (não por alvo), então
// a atribuição por alvo só acontece quando o designado tem EXATAMENTE 1 alvo;
// o restante fica em `noblesSemAlvo` em vez de ser dividido no chute.
// Puro, determinístico, fail-closed: sem dump ou sem alvos, lança erro claro.

export type PostOpLiveStatus = 'conquistado' | 'defendido' | 'desperdiçado' | 'sem-dados';

export interface PostOpLiveTarget {
  coord: string;
  /** Jogadores designados ao alvo na distribuição (ordem de aparição, sem repetir). */
  senders: string[];
  /** Nobres atribuíveis com honestidade; null = impossível atribuir a um alvo único. */
  nobleCount: number | null;
}

export interface PostOpLiveVillage {
  coord: string;
  playerId: number;
  allyId: number;
}

export interface PostOpLiveInput {
  /** Alvos da distribuição da OP (coords + designados + nobres atribuíveis). */
  targets: PostOpLiveTarget[];
  /** Dump pós-OP — aldeias do mundo no momento da verificação. */
  villages: PostOpLiveVillage[];
  /** allyId da própria tribo no momento da verificação. */
  ownAllyId: number;
  /** allyIds das inimigas DECLARADAS na diplomacia do momento da verificação. */
  enemyAllyIds: Set<number>;
  /**
   * Nobres do totalizador que não puderam ser atribuídos a um alvo único
   * (saída `unattributed` de attributeNoblesPerTarget) — entra em
   * totals.noblesSemAlvo. Sem isso, o relatório esconderia nobres gasto
   * em designados com 2+ alvos.
   */
  unattributedNobles?: number;
}

export interface PostOpLiveOutcome {
  coord: string;
  status: PostOpLiveStatus;
  /** Dono atual (playerId; 0 = bárbaro) — null quando a coord não existe no dump. */
  ownerPlayerId: number | null;
  /** Tribo do dono atual (0 = sem tribo) — null quando a coord não existe no dump. */
  ownerAllyId: number | null;
  senders: string[];
  nobleCount: number | null;
  detail: string;
}

export interface PostOpLiveTotals {
  conquistado: number;
  defendido: number;
  desperdiçado: number;
  'sem-dados': number;
  /** conquistado / alvos com dados (conquistado+defendido+desperdiçado), % inteira; 0 sem dados. */
  conquestRate: number;
  /** Nobres atribuídos a alvos que NÃO ficaram da tribo (defendido+desperdiçado). */
  wastedNobles: number;
  /** Nobres do snapshot sem alvo único para cair (designado com 0 ou 2+ alvos). */
  noblesSemAlvo: number;
}

export interface PostOpLiveResult {
  outcomes: PostOpLiveOutcome[];
  totals: PostOpLiveTotals;
}

/**
 * Classifica cada alvo da OP pelo dono ATUAL (ver cabeçalho do arquivo). Os
 * totais `wastedNobles` só somam nobres ATRIBUÍVEIS — nobre de alvo sem-dados
 * tem destino desconhecido e não entra (fail-closed). Ordenação por gravidade:
 * desperdiçado, defendido, conquistado, sem-dados; empate por nobres desc.
 */
export function verifyPostOpLive(input: PostOpLiveInput): PostOpLiveResult {
  if (input.villages.length === 0) {
    throw new Error('Dump PÓS-OP vazio — atualize os dados do mundo antes de verificar.');
  }
  if (input.targets.length === 0) {
    throw new Error('Nenhum alvo na distribuição — não há o que verificar.');
  }

  const villageByCoord = new Map(input.villages.map((village) => [village.coord, village]));

  const outcomes: PostOpLiveOutcome[] = [];
  const totals: PostOpLiveTotals = {
    conquistado: 0,
    defendido: 0,
    desperdiçado: 0,
    'sem-dados': 0,
    conquestRate: 0,
    wastedNobles: 0,
    noblesSemAlvo: 0,
  };

  for (const target of input.targets) {
    const village = villageByCoord.get(target.coord) ?? null;

    // Fail-closed: coord que não existe no dump não ganha classificação por dono.
    if (village === null) {
      outcomes.push({
        coord: target.coord,
        status: 'sem-dados',
        ownerPlayerId: null,
        ownerAllyId: null,
        senders: target.senders,
        nobleCount: target.nobleCount,
        detail: 'Alvo sem dados no dump pós-OP — verifique se a coordenada existe.',
      });
      totals['sem-dados'] += 1;
      continue;
    }

    if (village.allyId === input.ownAllyId) {
      outcomes.push({
        coord: target.coord,
        status: 'conquistado',
        ownerPlayerId: village.playerId,
        ownerAllyId: village.allyId,
        senders: target.senders,
        nobleCount: target.nobleCount,
        detail: 'Aldeia nas mãos da tribo — conquista confirmada.',
      });
      totals.conquistado += 1;
      continue;
    }

    if (input.enemyAllyIds.has(village.allyId)) {
      outcomes.push({
        coord: target.coord,
        status: 'defendido',
        ownerPlayerId: village.playerId,
        ownerAllyId: village.allyId,
        senders: target.senders,
        nobleCount: target.nobleCount,
        detail: 'Alvo segue com inimiga declarada — a conquista não aconteceu.',
      });
      totals.defendido += 1;
    } else {
      outcomes.push({
        coord: target.coord,
        status: 'desperdiçado',
        ownerPlayerId: village.playerId,
        ownerAllyId: village.allyId,
        senders: target.senders,
        nobleCount: target.nobleCount,
        detail:
          village.allyId === 0 || village.playerId === 0
            ? 'Aldeia sem dono (bárbara) — tomada por terceiros ou abandonada pelo inimigo.'
            : 'Dono atual é de fora da tribo e fora das inimigas declaradas — alvo perdido para terceiros.',
      });
      totals.desperdiçado += 1;
    }

    // Chegou aqui sem ser da tribo: nobre atribuído nesse alvo foi gasto à toa.
    if (target.nobleCount !== null) totals.wastedNobles += target.nobleCount;
  }

  const attempted = totals.conquistado + totals.defendido + totals.desperdiçado;
  totals.conquestRate = attempted > 0 ? Math.round((totals.conquistado / attempted) * 100) : 0;
  totals.noblesSemAlvo = input.unattributedNobles ?? 0;

  outcomes.sort((a, b) => {
    const rank: Record<PostOpLiveStatus, number> = {
      desperdiçado: 0,
      defendido: 1,
      conquistado: 2,
      'sem-dados': 3,
    };
    const noblesA = a.nobleCount ?? -1;
    const noblesB = b.nobleCount ?? -1;
    return rank[a.status] - rank[b.status] || noblesB - noblesA;
  });

  return { outcomes, totals };
}

/** Linha do totalizador arquivado por jogador (OpTotalsSnapshot reduzido). */
export interface PostOpLivePlayerTotals {
  playerName: string;
  /** Nobres reportados nos ataques do jogador nesta OP (snapshot arquivado). */
  nobleAttacks: number;
}

/**
 * Atribui nobres por alvo com honestidade: um nobre só cai num alvo quando o
 * designado tem EXATAMENTE 1 alvo na distribuição — com 2+ alvos não há como
 * dividir sem chute, e o total fica em `unattributed` (nunca some nem duplique).
 */
export function attributeNoblesPerTarget(
  entries: { playerName: string; coords: string[] }[],
  playerTotals: PostOpLivePlayerTotals[],
): { byCoord: Map<string, number>; unattributed: number } {
  const noblesByName = new Map<string, number>();
  for (const row of playerTotals) {
    noblesByName.set(row.playerName, (noblesByName.get(row.playerName) ?? 0) + row.nobleAttacks);
  }
  const coordCountByName = new Map<string, number>();
  for (const entry of entries) {
    coordCountByName.set(entry.playerName, (coordCountByName.get(entry.playerName) ?? 0) + entry.coords.length);
  }

  const byCoord = new Map<string, number>();
  let unattributed = 0;
  for (const [playerName, nobles] of noblesByName) {
    const soloCoord =
      coordCountByName.get(playerName) === 1
        ? entries.find((entry) => entry.playerName === playerName)?.coords[0]
        : undefined;
    if (soloCoord !== undefined) {
      byCoord.set(soloCoord, (byCoord.get(soloCoord) ?? 0) + nobles);
    } else {
      unattributed += nobles;
    }
  }
  return { byCoord, unattributed };
}
