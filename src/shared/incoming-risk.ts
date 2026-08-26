// Detecção de ataques recebidos (P0-5), parte pura: triagem "esta aldeia vai
// cair?" para as aldeias PRÓPRIAS do líder. Entradas: linhas de comandos
// parseadas por village-parsers (IncomingCommandRow) e a população defensiva
// presente (parada + a caminho), que o CALLER soma a partir do DefenseSnapshot
// do SG_2/SG_3 usando o catálogo de unidades. Sem DOM, sem relógio — puro,
// determinístico; defesa desconhecida NUNCA vira veredito otimista (fail-closed).
import type { IncomingCommandRow } from './parsers/village-parsers';

export interface ThreatThresholds {
  /** População defensiva mínima para considerar a aldeia resistente. */
  minResistPop: number;
  /**
   * Defesa acima deste patamar segura mesmo com nobre chegando (nobre sozinho
   * não derruba defesa cheia).
   */
  nobleDangerPop: number;
}

/**
 * Defaults da triagem, parametrizáveis na chamada: 6.000 de população defensiva
 * é uma guarnição razoável (lanceiro/espadachim/arqueiro contam 1; pesada conta
 * como 4 no peso defensivo usual); acima de 12.000 a pilha aguenta o trainel de
 * um nobre sem abrir brecha imediata.
 */
export const DEFAULT_THREAT_THRESHOLDS: ThreatThresholds = {
  minResistPop: 6000,
  nobleDangerPop: 12000,
};

export type ThreatLevel = 'vai-cair' | 'pressionada' | 'resistente' | 'sem-dados';

export interface VillageThreat {
  coord: string;
  level: ThreatLevel;
  attackCount: number;
  nobleCount: number;
  bigCount: number;
  detail: string;
}

export interface VillageThreatInput {
  /** Coordenada "x|y" da aldeia própria vigiada. */
  coord: string;
  /** Linhas de comando chegando a essa aldeia (widget compartilhado). */
  commands: IncomingCommandRow[];
  /**
   * População defensiva presente (parada + a caminho) SOMADA PELO CALLER a
   * partir do DefenseSnapshot. Ausente (undefined) = defesa desconhecida.
   */
  defensePop?: number;
}

/** Contagens de ameaça de uma aldeia — só comandos type 'attack' contam. */
function threatCounts(commands: IncomingCommandRow[]): {
  attackCount: number;
  nobleCount: number;
  bigCount: number;
} {
  let attackCount = 0;
  let nobleCount = 0;
  let bigCount = 0;
  for (const command of commands) {
    if (command.type !== 'attack') continue;
    attackCount += 1;
    if (command.hasNoble) nobleCount += 1;
    if (command.sizeHint === 'grande') bigCount += 1;
  }
  return { attackCount, nobleCount, bigCount };
}

export function assessVillageThreat(
  input: VillageThreatInput,
  thresholds?: ThreatThresholds,
): VillageThreat {
  const limits = thresholds ?? DEFAULT_THREAT_THRESHOLDS;
  const { attackCount, nobleCount, bigCount } = threatCounts(input.commands);
  const base = { coord: input.coord, attackCount, nobleCount, bigCount };

  // Sem ataque nenhum não há o que avaliar: suporte/fake inbound não ameaça.
  if (attackCount === 0) {
    return { ...base, level: 'resistente', detail: 'sem ataques' };
  }
  // Fail-closed: defesa desconhecida nunca vira "resistente" silencioso.
  if (input.defensePop === undefined) {
    return {
      ...base,
      level: 'sem-dados',
      detail: `defesa desconhecida — rode a coleta do SG_3 (${attackCount} ataque(s), ${nobleCount} nobre(s))`,
    };
  }
  const def = input.defensePop;
  // Nobre contra defesa fraca é o fim da aldeia: maior prioridade.
  if (nobleCount > 0 && def < limits.nobleDangerPop) {
    return {
      ...base,
      level: 'vai-cair',
      detail: `${nobleCount} nobre(s) chegando e defesa ${def} abaixo de ${limits.nobleDangerPop}`,
    };
  }
  // Ataque grande contra defesa fraca também derruba.
  if (bigCount > 0 && def < limits.minResistPop) {
    return {
      ...base,
      level: 'vai-cair',
      detail: `${bigCount} ataque(s) grande(s) e defesa ${def} abaixo de ${limits.minResistPop}`,
    };
  }
  // Defesa abaixo do mínimo, mas sem nobre/grande iminente: pressão.
  if (def < limits.minResistPop) {
    return {
      ...base,
      level: 'pressionada',
      detail: `${attackCount} ataque(s) e defesa ${def} abaixo de ${limits.minResistPop}`,
    };
  }
  return {
    ...base,
    level: 'resistente',
    detail: `defesa ${def} resiste a ${attackCount} ataque(s)`,
  };
}

/** Ordem de gravidade do veredito (menor = mais urgente). */
const LEVEL_RANK: Record<ThreatLevel, number> = {
  'vai-cair': 0,
  pressionada: 1,
  resistente: 2,
  'sem-dados': 3,
};

/**
 * Avalia e ordena as aldeias por urgência: vai-cair > pressionada >
 * resistente > sem-dados; dentro do nível, mais nobres primeiro, depois mais
 * ataques, depois coordenada (empates determinísticos).
 */
export function rankVillagesByThreat(
  villages: VillageThreatInput[],
  thresholds?: ThreatThresholds,
): VillageThreat[] {
  const ranked = villages.map((village) => assessVillageThreat(village, thresholds));
  ranked.sort(
    (a, b) =>
      LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
      b.nobleCount - a.nobleCount ||
      b.attackCount - a.attackCount ||
      a.coord.localeCompare(b.coord),
  );
  return ranked;
}

/**
 * Resumo PT-BR para exibição, ex.: "2 aldeia(s) em risco de cair · 3
 * pressionadas · 5 resistentes · 1 sem dados". Sempre traz os quatro segmentos.
 */
export function threatSummary(list: VillageThreat[]): string {
  let vaiCair = 0;
  let pressionada = 0;
  let resistente = 0;
  let semDados = 0;
  for (const village of list) {
    if (village.level === 'vai-cair') vaiCair += 1;
    else if (village.level === 'pressionada') pressionada += 1;
    else if (village.level === 'resistente') resistente += 1;
    else semDados += 1;
  }
  return `${vaiCair} aldeia(s) em risco de cair · ${pressionada} pressionadas · ${resistente} resistentes · ${semDados} sem dados`;
}
