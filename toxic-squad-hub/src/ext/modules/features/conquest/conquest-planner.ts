import { z } from 'zod';

/**
 * Planejador PURO de conquista de aldeias LIVRES (bárbaras) — engine da onda
 * 5b do Hub: dado o que o mapa oferece (village.txt: owner = 0, pontos e
 * coordenada) e um ranking de prioridades declarativo, decide QUAL aldeia
 * noblar primeiro e QUANTOS nobres o pior caso exige. Função pura,
 * determinística e fail-closed: candidato sem dado suficiente para a decisão
 * (lealdade não estimável, distância sem origem) é EXCLUÍDO com contagem —
 * nunca entra no plano por chute.
 *
 * O "quando" fica com o chamador (o plugin agenda a chegada pelo Agendador de
 * Comandos); aqui só se calcula o alvo e o custo em nobres.
 */

export const CONQUEST_ALGORITHM_VERSION = 'conquest-1' as const;

/** Critérios de ranking aceitos (mesma ordem do seletor da UI). */
export const CONQUEST_RANKING_KEYS = Object.freeze(['distancia', 'pontos', 'farm', 'barracos'] as const);

export type ConquestRankingKey = (typeof CONQUEST_RANKING_KEYS)[number];

export const CONQUEST_RANKING_LABELS: Readonly<Record<ConquestRankingKey, string>> = {
  distancia: 'distância',
  pontos: 'pontos',
  farm: 'farm',
  barracos: 'barracos',
};

/**
 * Direção padrão por critério: distância e pontos crescem (mais perto/menor
 * primeiro); farm e barracos decrescem (maior primeiro). O usuário pode
 * inverter com o sufixo '-'.
 */
export const CONQUEST_RANKING_DEFAULT_DIRECTION: Readonly<Record<ConquestRankingKey, 'asc' | 'desc'>> = {
  distancia: 'asc',
  pontos: 'asc',
  farm: 'desc',
  barracos: 'desc',
};

/** Lealdade mínima derrubada por um nobre (pior caso do jogo) — base do custo. */
export const NOBLE_LOYALTY_WORST_CASE = 20;

/** Teto de nobres por alvo (o jogo não passa de 5 para lealdade 100). */
export const MAX_NOBLES_PER_TARGET = 5;

/** Lealdade estimada de uma aldeia bárbara sem dado melhor (nasce em 100). */
export const BARBARIAN_LOYALTY_ESTIMATE = 100;

export const conquestCandidateSchema = z.object({
  /** Id do jogo (string — o mesmo formato das outras engines). */
  id: z.string().min(1),
  name: z.string().default(''),
  x: z.number().int().min(0).max(999),
  y: z.number().int().min(0).max(999),
  points: z.number().int().nonnegative(),
  /** Dono no village.txt ('0' = bárbara/aldeia livre). */
  ownerId: z.string().default('0'),
  /** Lealdade conhecida/estimada (0..100); ausente = estimada pela engine. */
  loyalty: z.number().min(0).max(100).optional(),
  /** Nível/valor de farm conhecido (0 = não lido). */
  farm: z.number().int().nonnegative().default(0),
  /** Barracos (capacidade de população) conhecidos (0 = não lido). */
  barracos: z.number().int().nonnegative().default(0),
});

export type ConquestCandidate = z.infer<typeof conquestCandidateSchema>;

export type ConquestRankingDirection = 'asc' | 'desc';

export interface ConquestRankingCriterion {
  key: ConquestRankingKey;
  direction: ConquestRankingDirection;
}

/** Ranking padrão (sem texto configurado): mais perto e menor primeiro. */
export function defaultConquestRanking(): ConquestRankingCriterion[] {
  return [
    { key: 'distancia', direction: 'asc' },
    { key: 'pontos', direction: 'asc' },
  ];
}

/**
 * Parser PURO do ranking em texto: critérios separados por vírgula, na ordem
 * de prioridade, com o sufixo '-' para inverter a direção padrão do critério
 * (ex.: "pontos-,distancia"). Vazio = ranking padrão. Critério desconhecido ou
 * repetido derruba o parse INTEIRO com o motivo (fail-closed: ordem ambígua
 * produziria um alvo diferente do que o operador pediu).
 */
export function parseConquestRanking(
  text: string,
): { ok: true; criteria: ConquestRankingCriterion[] } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, criteria: defaultConquestRanking() };
  const criteria: ConquestRankingCriterion[] = [];
  const seen = new Set<string>();
  for (const rawToken of trimmed.split(',')) {
    const token = rawToken.trim().toLowerCase();
    if (token === '') {
      return { ok: false, reason: 'critério vazio na lista — separe os critérios por vírgula (ex.: distancia,pontos-).' };
    }
    const key = token.replace(/-$/, '') as ConquestRankingKey;
    if (!CONQUEST_RANKING_KEYS.includes(key)) {
      return {
        ok: false,
        reason: `critério "${token}" não é aceito — use ${CONQUEST_RANKING_KEYS.join(', ')} (sufixo '-' inverte a ordem).`,
      };
    }
    if (seen.has(key)) return { ok: false, reason: `critério "${key}" repetido no ranking.` };
    seen.add(key);
    criteria.push({
      key,
      direction: token.endsWith('-') ? flipDirection(CONQUEST_RANKING_DEFAULT_DIRECTION[key]) : CONQUEST_RANKING_DEFAULT_DIRECTION[key],
    });
  }
  return { ok: true, criteria };
}

function flipDirection(direction: ConquestRankingDirection): ConquestRankingDirection {
  return direction === 'asc' ? 'desc' : 'asc';
}

/** Texto canônico do ranking (round-trip do parser; usado no status). */
export function conquestRankingLabel(criteria: readonly ConquestRankingCriterion[]): string {
  return criteria
    .map((criterion) => `${criterion.key}${criterion.direction === CONQUEST_RANKING_DEFAULT_DIRECTION[criterion.key] ? '' : '-'}`)
    .join(', ');
}

export interface ConquestPlanInput {
  candidates: readonly ConquestCandidate[];
  /** Coordenada da aldeia de origem (null = desconhecida → distância indefinida). */
  origin: { x: number; y: number } | null;
  /** Pontos máximos do alvo (0 = sem teto). */
  maxPoints: number;
  /** Distância máxima em campos (0 = sem teto). */
  maxDistance: number;
  /** Lealdade mínima aceita (0 = sem filtro). */
  minLoyalty: number;
  ranking: readonly ConquestRankingCriterion[];
  /** Quantos candidatos o relatório ranqueado devolve (default 10). */
  maxCandidates?: number;
}

export interface ConquestTargetPlan {
  id: string;
  name: string;
  x: number;
  y: number;
  points: number;
  /** Distância em campos da origem (null = origem desconhecida). */
  distance: number | null;
  /** Lealdade usada na decisão (estimada quando o dado não veio). */
  loyalty: number;
  /** Nobres necessários no PIOR caso (lealdade / 20, teto 5). */
  noblesNeeded: number;
  /** Posição no ranking (1 = o alvo do plano). */
  priority: number;
  farm: number;
  barracos: number;
}

export interface ConquestPlanExclusions {
  points: number;
  distance: number;
  loyalty: number;
  /** Sem origem conhecida com teto de distância ativo (não dá para avaliar). */
  noOrigin: number;
  /** Lealdade não estimável (aldeia não-livre sem dado de lealdade). */
  unknownLoyalty: number;
}

export interface ConquestPlanResult {
  version: typeof CONQUEST_ALGORITHM_VERSION;
  /** Alvo do plano (null = nenhum candidato elegível). */
  target: ConquestTargetPlan | null;
  /** Candidatos elegíveis ranqueados (inclui o alvo na posição 1). */
  ranked: ConquestTargetPlan[];
  excluded: ConquestPlanExclusions;
  /** Mensagem pt-BR didática (prévia) — sempre preenchida. */
  message: string;
}

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

/** Distância euclidiana em campos (mesma convenção das outras engines). */
export function conquestDistance(
  origin: { x: number; y: number },
  target: { x: number; y: number },
): number {
  return Math.hypot(origin.x - target.x, origin.y - target.y);
}

/** Nobres no pior caso para derrubar a lealdade dada (1..5). */
export function noblesNeededFor(loyalty: number): number {
  const needed = Math.ceil(Math.max(0, loyalty) / NOBLE_LOYALTY_WORST_CASE);
  return Math.min(MAX_NOBLES_PER_TARGET, Math.max(1, needed));
}

/**
 * Lealdade usada na decisão (null = não estimável): a informada quando veio;
 * senão a estimativa conservadora para aldeia LIVRE (ownerId '0', nasce com
 * 100). Aldeia de jogador sem dado de lealdade não entra (fail-closed).
 */
export function estimateLoyalty(candidate: ConquestCandidate): number | null {
  if (candidate.loyalty !== undefined) return candidate.loyalty;
  return candidate.ownerId === '0' ? BARBARIAN_LOYALTY_ESTIMATE : null;
}

/** Valor comparável de um critério (distância desconhecida vai para o fim). */
function criterionValue(target: ConquestTargetPlan, key: ConquestRankingKey): number {
  switch (key) {
    case 'distancia':
      return target.distance ?? Number.POSITIVE_INFINITY;
    case 'pontos':
      return target.points;
    case 'farm':
      return target.farm;
    case 'barracos':
      return target.barracos;
  }
}

function compareTargets(
  left: ConquestTargetPlan,
  right: ConquestTargetPlan,
  criteria: readonly ConquestRankingCriterion[],
): number {
  for (const criterion of criteria) {
    const sign = criterion.direction === 'asc' ? 1 : -1;
    const delta = (criterionValue(left, criterion.key) - criterionValue(right, criterion.key)) * sign;
    if (delta !== 0) return delta;
  }
  return left.id.localeCompare(right.id);
}

function targetLabel(target: ConquestTargetPlan): string {
  const name = target.name !== '' ? target.name : 'aldeia livre';
  return `${name} (${target.x}|${target.y})`;
}

/**
 * Plano de conquista (PURO): filtra os candidatos pelos limites (pontos,
 * distância e lealdade mínima), ranqueia pelos critérios pedidos e devolve o
 * PRIMEIRO como alvo, com o custo em nobres do pior caso. Exclusões são
 * contadas por motivo — o status do plugin cita os números em vez de sumir
 * com candidatos em silêncio.
 */
export function planConquest(input: ConquestPlanInput): ConquestPlanResult {
  const candidates = input.candidates.map((candidate) => conquestCandidateSchema.parse(candidate));
  const ranking = input.ranking.length > 0 ? [...input.ranking] : defaultConquestRanking();
  const excluded: ConquestPlanExclusions = {
    points: 0,
    distance: 0,
    loyalty: 0,
    noOrigin: 0,
    unknownLoyalty: 0,
  };
  const eligible: ConquestTargetPlan[] = [];
  for (const candidate of candidates) {
    if (input.maxPoints > 0 && candidate.points > input.maxPoints) {
      excluded.points += 1;
      continue;
    }
    let distance: number | null = null;
    if (input.origin !== null) {
      distance = conquestDistance(input.origin, candidate);
      if (input.maxDistance > 0 && distance > input.maxDistance) {
        excluded.distance += 1;
        continue;
      }
    } else if (input.maxDistance > 0) {
      // Sem origem não há como avaliar o teto de distância: fail-closed.
      excluded.noOrigin += 1;
      continue;
    }
    const loyalty = estimateLoyalty(candidate);
    if (loyalty === null) {
      excluded.unknownLoyalty += 1;
      continue;
    }
    if (input.minLoyalty > 0 && loyalty < input.minLoyalty) {
      excluded.loyalty += 1;
      continue;
    }
    eligible.push({
      id: candidate.id,
      name: candidate.name,
      x: candidate.x,
      y: candidate.y,
      points: candidate.points,
      distance,
      loyalty,
      noblesNeeded: noblesNeededFor(loyalty),
      priority: 0,
      farm: candidate.farm,
      barracos: candidate.barracos,
    });
  }
  eligible.sort((left, right) => compareTargets(left, right, ranking));
  const limit = Math.max(1, Math.min(input.maxCandidates ?? 10, eligible.length));
  const ranked = eligible.slice(0, limit).map((target, index) => ({ ...target, priority: index + 1 }));
  const target = ranked[0] ?? null;
  const exclusionNote = [
    excluded.points > 0 ? `${excluded.points} por pontos acima do teto` : '',
    excluded.distance > 0 ? `${excluded.distance} por distância acima do teto` : '',
    excluded.loyalty > 0 ? `${excluded.loyalty} por lealdade abaixo do mínimo` : '',
    excluded.noOrigin > 0 ? `${excluded.noOrigin} sem origem para medir distância` : '',
    excluded.unknownLoyalty > 0 ? `${excluded.unknownLoyalty} sem lealdade estimável` : '',
  ].filter((part) => part !== '');
  const message =
    target === null
      ? `Nenhuma aldeia livre elegível entre ${candidates.length} candidata(s)${
          exclusionNote.length > 0 ? ` (excluídas: ${exclusionNote.join('; ')})` : ''
        }.`
      : `Alvo do plano: ${targetLabel(target)} — ${target.points} pontos${
          target.distance !== null ? `, ${target.distance.toFixed(1)} campos` : ''
        }, lealdade ${target.loyalty} (${target.noblesNeeded} nobre${target.noblesNeeded !== 1 ? 's' : ''} no pior caso). ${
          eligible.length
        } elegível(is) de ${candidates.length} lida(s)${exclusionNote.length > 0 ? ` — excluídas: ${exclusionNote.join('; ')}` : ''}. Ranking: ${conquestRankingLabel(ranking)}.`;
  return deepFreeze({
    version: CONQUEST_ALGORITHM_VERSION,
    target,
    ranked,
    excluded,
    message,
  });
}
