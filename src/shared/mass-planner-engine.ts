// Sala de Guerra · Planner de OP em Massa — MOTOR puro e determinístico.
// v0.29.0 alinhado À FERRAMENTA REAL (twmassplanner.pro — semânticas provadas
// por gerações reais capturadas): cruzamento origens×alvos com cotas POR VILA
// resolvidas dos grupos "1;2" (textareas divididas por ";"), modos de cálculo
// Otimizado (guloso global, aproximação do matching do tool real) /
// Distribuído por players (justo entre jogadores de origem) / Mais perto /
// Mais longe, filtros por par (distância, Torre de Vigia ponto→segmento raio
// 15, moral por pontos), chegadas Fixa / Intervalo (início→fim) / Fixa com
// intervalo por aldeia (DELAY SEQUENCIAL entre ataques na ordem de distância),
// proteção de bônus noturno, conflito de ms por jogador e partida via solver
// inverso (viagem na janela noturna custa 2×).
//
// Nada de relógio, rede ou DOM: o contexto do mundo entra pronto
// (MassPlanContext) e as âncoras de data vêm em cada grupo — mesma disciplina
// das engines SG_4/SG_1. Descartes NUNCA silenciosos: voltam agregados.

import { fieldsBetween } from './distance';
import { normalizeCoordText } from './coord-input';
import { parseCoord } from './coords';
import { isNightBonusHour, solveDepartureForArrival, type NightBonusCfg } from './night-bonus';
import { moraleOf } from './sg4-engine';
import type {
  MassCoordEntry,
  MassDiscardEntry,
  MassGroupConfig,
  MassGroupErrors,
  MassPlanCommand,
  MassPlanContext,
  MassPlanResult,
} from './mass-planner-types';

// ---------------------------------------------------------------------------
// Motivos de descarte (strings estáveis — aparecem na UI e nos testes)
// ---------------------------------------------------------------------------

const D_MIN_DIST = 'Distância menor que o mínimo';
const D_MAX_DIST = 'Distância maior que o máximo';
const D_TOWER = 'Trajetória dentro do raio da Torre de Vigia';
const D_MORAL_LOW = 'Moral abaixo do mínimo';
const D_MORAL_NO_POINTS = 'Moral exigida sem pontos no dump (origem/alvo)';

/**
 * Teto sanitário do cruzamento: pares candidatos por grupo (origens × alvos).
 * 50.000.000 a pedido do dono (equipamentos robustos) — cobre a OP de mundo
 * inteiro da staff ("Full - Br142" de 7005×1701 = 11,9M) com folga de 4×.
 * Custo no CAP, modo Otimizado (medida da revisão v0.32.3): ~800 MB em typed
 * arrays (ArrayBuffer, fora do heap) + ~400-600 MB de heap JS normal (array
 * de ordenação + TimSort do V8) e sort síncrono da ordem de 1-4 minutos. Os
 * modos por-alvo são bem mais leves (sem ordenação global, sem candTarget).
 */
export const MASS_MAX_PAIRS = 50_000_000;

/** Acima disso a geração é avisada como pesada (segundos de espera normal). */
export const MASS_HEAVY_PAIRS = 100_000;

/** Escala de "mundo inteiro": a geração pode levar dezenas de segundos a minutos. */
export const MASS_WORLD_PAIRS = 5_000_000;

// ---------------------------------------------------------------------------
// Geometria: distância do ponto ao segmento (Torre de Vigia, raio 15 campos)
// ---------------------------------------------------------------------------

/**
 * Distância (em campos) do ponto P ao SEGMENTO A→B — a trajetória em linha
 * reta do comando. Projeção clampada a [0,1]: torre "antes da origem" mede
 * até a própria origem, não até a reta infinita.
 */
export function pointSegmentDistanceFields(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.round(Math.sqrt((px - cx) ** 2 + (py - cy) ** 2) * 100) / 100;
}

/** true quando a trajetória origem→alvo passa dentro do raio de alguma torre. */
function pathHitsTower(origin: MassCoordEntry, target: MassCoordEntry, group: MassGroupConfig): boolean {
  for (const tower of group.towers) {
    if (
      pointSegmentDistanceFields(tower.x, tower.y, origin.x, origin.y, target.x, target.y) <=
      group.towerRadius
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Bônus noturno: empurrar a CHEGADA para depois da janela
// ---------------------------------------------------------------------------

/** Instante (epoch ms) em que a janela noturna FECHA a partir do dia do instante dado. */
function windowEndMs(ms: number, cfg: NightBonusCfg): number {
  const at = new Date(ms);
  const start = cfg.nightStartHour;
  const end = cfg.nightEndHour;
  const h = at.getHours() + at.getMinutes() / 60 + at.getSeconds() / 3600 + at.getMilliseconds() / 3_600_000;
  // Janela que cruza a meia-noite (ex.: 23→7): caiu em h>=start → fecha AMANHÃ
  // às end; caiu em h<end → fecha HOJE às end. Janela normal: fecha hoje.
  const dayShift = start > end && h >= start ? 1 : 0;
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + dayShift, end, 0, 0, 0).getTime();
}

/**
 * Empurra a chegada que cai na janela do bônus noturno para o instante em que a
 * janela fecha (mesma semântica meio-aberta [start, end) de isNightBonusHour).
 * Chegada válida volta intacta (pushed false). Horas do get_config tratadas no
 * relógio local — mesma decisão documentada de night-bonus.ts.
 */
export function pushArrivalOutOfNightWindow(
  arrivalMs: number,
  cfg: NightBonusCfg,
): { arrivalMs: number; pushed: boolean } {
  if (!cfg.nightBonusActive) return { arrivalMs, pushed: false };
  const at = new Date(arrivalMs);
  const fractionalHour =
    at.getHours() + at.getMinutes() / 60 + at.getSeconds() / 3600 + at.getMilliseconds() / 3_600_000;
  if (!isNightBonusHour(fractionalHour, cfg)) return { arrivalMs, pushed: false };
  return { arrivalMs: windowEndMs(arrivalMs, cfg), pushed: true };
}

// ---------------------------------------------------------------------------
// Entrada de coordenadas EM GRUPOS ("A B; C D") com cotas ("1;2")
// ---------------------------------------------------------------------------

export interface ParsedCoordGroups {
  entries: MassCoordEntry[];
  /** Cota de usos de cada entrada (resolvida dos grupos; mesmo comprimento de entries). */
  quotas: number[];
  invalidTokens: number;
  duplicatesRemoved: number;
  /** Erro de cotas no formato do tool real (null = ok). */
  quotaError: string | null;
}

/**
 * Converte o texto colado ("A B; C D" — grupos separados por ";") + o campo de
 * cota ("1" ou "1;2" — um valor por GRUPO; 1 valor só aplica a todos) na lista
 * plana de coordenadas com a cota DE CADA VILA. Mesmo parsing da blindagem
 * (ordem da 1ª aparição, dedupe, contagem de inválidos — nunca descarte
 * silencioso). Cota inválida NÃO lança: volta em quotaError para o formulário.
 */
export function parseMassCoordGroups(raw: string, countsRaw: string): ParsedCoordGroups {
  const groups = raw.split(';');
  const countParts = countsRaw
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '');

  const entries: MassCoordEntry[] = [];
  const quotas: number[] = [];
  const seen = new Set<string>();
  let invalidTokens = 0;
  let duplicatesRemoved = 0;

  for (const group of groups) {
    const normalized = normalizeCoordText(group);
    invalidTokens += normalized.invalidTokens;
    duplicatesRemoved += normalized.duplicatesRemoved;
    for (const coord of normalized.coords) {
      const parsed = parseCoord(coord);
      if (parsed === null) continue; // inalcançável: normalizeCoordText só emite \d{1,3}\|\d{1,3}
      const key = `${parsed.x}|${parsed.y}`;
      if (seen.has(key)) {
        // Duplicata ENTRE grupos também é descarte: conta (nunca silencioso).
        duplicatesRemoved += 1;
        continue;
      }
      seen.add(key);
      entries.push({ coord: key, x: parsed.x, y: parsed.y });
      quotas.push(1); // default provisório; sobrescrito abaixo pelos grupos
    }
  }

  let quotaError: string | null = null;
  if (countParts.length > 0 || groups.length > 1) {
    // Um único valor aplica a todos os grupos (ex.: "1" para 3 grupos).
    const resolved: number[] = [];
    if (countParts.length === 1) {
      const value = Number(countParts[0]);
      if (!Number.isInteger(value) || value < 1) {
        quotaError = 'Valor de comando inválido.';
      } else {
        for (let i = 0; i < groups.length; i++) resolved.push(value);
      }
    } else {
      // Tantos valores quanto grupos: "O número de separadores (;) é diferente."
      if (countParts.length !== groups.length) {
        quotaError = 'O número de separadores (;) é diferente.';
      } else {
        for (const part of countParts) {
          const value = Number(part);
          if (!Number.isInteger(value) || value < 1) {
            quotaError = 'Valor de comando inválido.';
            break;
          }
          resolved.push(value);
        }
      }
    }
    if (quotaError === null) {
      // Aplica a cota do grupo a cada vila do grupo (mesma ordem de entrada).
      // Duplicatas ENTRE grupos não têm entrada própria: o cursor anda SÓ nas
      // coords únicas — senão a duplicata consumia o slot de cota da vila
      // seguinte (ex.: "A; A B; C" com cotas 5;1;9 dava [5,1,1] em vez de [5,1,9]).
      let cursor = 0;
      const counted = new Set<string>();
      groups.forEach((groupText, groupIndex) => {
        const normalized = normalizeCoordText(groupText);
        for (const coord of normalized.coords) {
          const parsed = parseCoord(coord);
          if (parsed === null) continue;
          const key = `${parsed.x}|${parsed.y}`;
          if (counted.has(key)) continue;
          counted.add(key);
          if (quotas[cursor] !== undefined) quotas[cursor] = resolved[groupIndex] ?? 1;
          cursor += 1;
        }
      });
    }
  }

  return { entries, quotas, invalidTokens, duplicatesRemoved, quotaError };
}

/** Conveniência: texto simples sem grupos (torres) — cota 1 para tudo. */
export function parseMassCoordText(raw: string): {
  entries: MassCoordEntry[];
  invalidTokens: number;
  duplicatesRemoved: number;
} {
  const parsed = parseMassCoordGroups(raw, '');
  return {
    entries: parsed.entries,
    invalidTokens: parsed.invalidTokens,
    duplicatesRemoved: parsed.duplicatesRemoved,
  };
}

// ---------------------------------------------------------------------------
// Validação do grupo (campos do formulário — mensagem por campo)
// ---------------------------------------------------------------------------

/** Cotas precisam cobrir as listas com inteiros ≥ 1. */
function validateQuotas(quotas: number[], listLength: number): string | undefined {
  if (quotas.length !== listLength) return 'Cotas divergentes das coordenadas — adicione o grupo de novo.';
  return quotas.some((quota) => !Number.isInteger(quota) || quota < 1)
    ? 'Comandos deve ser um inteiro ≥ 1 (listas "1;2" por grupo).'
    : undefined;
}

/** Erros por campo; objeto vazio = grupo válido. */
export function validateMassGroup(group: MassGroupConfig, ctx: MassPlanContext): MassGroupErrors {
  const errors: MassGroupErrors = {};
  const nome = group.nome.trim();
  if (nome === '') {
    errors.nome = 'Dê um nome ao modelo de tropa (ex.: nuke, fake, limpeza).';
  } else if (nome.length > 40) {
    // O nome vira NICK nas exportações ("Grupo <nome>" quando o executor é
    // desconhecido) e o nick aceito por T-minus/comms/Sala de Guerra tem teto 40.
    errors.nome = 'Nome do modelo longo demais — use até 40 caracteres.';
  }
  if (group.origins.length === 0) {
    errors.origins = 'Informe ao menos uma coordenada de origem.';
  }
  if (group.targets.length === 0) {
    errors.targets = 'Informe ao menos uma coordenada de destino.';
  }
  const quotaOriginError = validateQuotas(group.originQuotas, group.origins.length);
  if (quotaOriginError !== undefined) errors.commandsPerOrigin = quotaOriginError;
  const quotaTargetError = validateQuotas(group.targetQuotas, group.targets.length);
  if (quotaTargetError !== undefined) errors.commandsPerTarget = quotaTargetError;
  const unitMinutes = ctx.unitMinutesPerField[group.slowestUnit];
  if (unitMinutes === undefined || !(unitMinutes > 0)) {
    errors.slowestUnit =
      'Velocidade da unidade indisponível — atualize os dados do mundo (unit-info) antes de gerar.';
  }
  if (!(group.minDistance >= 0)) {
    errors.minDistance = 'Distância mínima deve ser ≥ 0.';
  }
  if (!(group.maxDistance > group.minDistance)) {
    errors.maxDistance = 'Distância máxima deve ser maior que a mínima.';
  }
  if (!Number.isFinite(group.arrivalBaseMs)) {
    errors.arrivalBaseMs = 'Informe a data e hora de chegada.';
  }
  if (group.arrivalKind === 'intervalo') {
    if (!Number.isFinite(group.windowStartMs)) {
      errors.windowStartMs = 'Defina o início do intervalo.';
    }
    if (!Number.isFinite(group.windowEndMs)) {
      errors.windowEndMs = 'Defina o fim do intervalo.';
    } else if (Number.isFinite(group.windowStartMs) && group.windowEndMs <= group.windowStartMs) {
      errors.windowEndMs = 'O fim do intervalo deve ser depois do início.';
    }
  }
  if (group.arrivalKind === 'sequencial' && !(group.attackDelaySeconds >= 0)) {
    errors.attackDelaySeconds = 'O delay entre ataques deve ser ≥ 0 segundos.';
  }
  if (!(group.minMorale >= 0 && group.minMorale <= 100)) {
    errors.minMorale = 'Moral mínima deve ficar entre 0 e 100 (0 = ignorar).';
  }
  if (group.towers.length > 0 && !(group.towerRadius > 0)) {
    errors.towers = 'O raio da torre deve ser maior que 0.';
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Geração da operação
// ---------------------------------------------------------------------------

interface CandidatePair {
  originIndex: number;
  targetIndex: number;
  distanceFields: number;
}

interface PlannedCommand {
  command: MassPlanCommand;
  groupOrder: number;
  targetIndex: number;
  originIndex: number;
}

/**
 * Gera a operação inteira a partir dos grupos NA ORDEM INFORMADA. Falha
 * (throw PT-BR) quando um grupo é estruturalmente inválido ou o mundo não tem
 * os dados que o grupo exige — o caller valida antes com validateMassGroup;
 * o throw aqui é a última linha de defesa (fail-closed, nunca parcial).
 */
export function generateMassPlan(groups: readonly MassGroupConfig[], ctx: MassPlanContext): MassPlanResult {
  const discards = new Map<string, number>();
  const countDiscard = (reason: string): void => {
    discards.set(reason, (discards.get(reason) ?? 0) + 1);
  };
  const warnings: string[] = [];
  const planned: PlannedCommand[] = [];

  groups.forEach((group, groupOrder) => {
    if (group.origins.length === 0 || group.targets.length === 0) {
      throw new Error(`Grupo "${group.nome}" sem origens ou sem destinos — valide o grupo antes de gerar.`);
    }
    if (group.origins.length * group.targets.length > MASS_MAX_PAIRS) {
      throw new Error(
        `Grupo "${group.nome}" cruza ${group.origins.length} origens × ${group.targets.length} destinos — acima do teto de ${MASS_MAX_PAIRS} pares. Reduza as listas.`,
      );
    }
    if (group.origins.length * group.targets.length > MASS_WORLD_PAIRS) {
      warnings.push(
        `Grupo "${group.nome}": OP de mundo inteiro (${group.origins.length}×${group.targets.length} = ${group.origins.length * group.targets.length} pares) — a geração pode levar dezenas de segundos a alguns minutos; aguarde sem fechar o app.`,
      );
    } else if (group.origins.length * group.targets.length > MASS_HEAVY_PAIRS) {
      warnings.push(
        `Grupo "${group.nome}": OP pesada (${group.origins.length}×${group.targets.length} = ${group.origins.length * group.targets.length} pares) — a geração pode levar alguns segundos.`,
      );
    }
    const unitMinutes = ctx.unitMinutesPerField[group.slowestUnit];
    if (unitMinutes === undefined || !(unitMinutes > 0)) {
      throw new Error(
        `Grupo "${group.nome}": unidade mais lenta sem velocidade no mundo carregado — atualize os dados do mundo (unit-info).`,
      );
    }

    // Moral fora de contextos com moral: o campo não atua (UI oculta; aqui força 0).
    const minMorale = ctx.moralActive ? group.minMorale : 0;
    if (!ctx.moralActive && group.minMorale > 0) {
      warnings.push(`Grupo "${group.nome}": mundo sem moral por pontos — a moral mínima informada foi ignorada.`);
    }

    // (1) Pares candidatos com os filtros DE PAR (distância, torre, moral) —
    // em ARRAYS TIPADOS PARALELOS: uma OP de mundo inteiro (7005×1701 = 11,9M
    // pares) como array de objetos custaria ~1 GB de heap e derrubaria o
    // renderer; aqui são ~16 bytes/par. O ALVO é o loop externo, então os pares
    // de cada alvo ficam CONTÍGUOS (slice por targetOffset) e, dentro do alvo,
    // em ordem de origem digitada — a MESMA ordem relativa (e os mesmos
    // critérios de empate) do array de objetos antigo.
    const pairCapacity = group.origins.length * group.targets.length;
    const candOrigin = new Int32Array(pairCapacity);
    // Só o modo 'otimizado' lê o índice do alvo (ordenar o conjunto inteiro);
    // nos modos por-alvo o alvo é o próprio slice — alocar 200 MB à toa no
    // cap de 50M seria desperdício puro.
    const candTarget = group.assignMode === 'otimizado' ? new Int32Array(pairCapacity) : new Int32Array(0);
    const candDist = new Float64Array(pairCapacity);
    /** Primeiro índice de cada alvo no array de candidatos (+1 slot final). */
    const targetOffset = new Int32Array(group.targets.length + 1);
    let candTotal = 0;
    group.targets.forEach((target, targetIndex) => {
      targetOffset[targetIndex] = candTotal;
      group.origins.forEach((origin, originIndex) => {
        const distanceFields = fieldsBetween(origin, target);
        if (distanceFields < group.minDistance) {
          countDiscard(D_MIN_DIST);
          return;
        }
        if (distanceFields > group.maxDistance) {
          countDiscard(D_MAX_DIST);
          return;
        }
        if (group.towers.length > 0 && pathHitsTower(origin, target, group)) {
          countDiscard(D_TOWER);
          return;
        }
        if (minMorale > 0) {
          const attackerNick = ctx.ownerByCoord.get(origin.coord);
          const attackerPoints = attackerNick === undefined ? undefined : ctx.playerPoints.get(attackerNick);
          const defenderPoints = ctx.villagePoints.get(target.coord);
          if (attackerNick === undefined || attackerPoints === undefined || defenderPoints === undefined) {
            countDiscard(D_MORAL_NO_POINTS);
            return;
          }
          if (moraleOf(attackerPoints, defenderPoints) < minMorale) {
            countDiscard(D_MORAL_LOW);
            return;
          }
        }
        candOrigin[candTotal] = originIndex;
        if (group.assignMode === 'otimizado') candTarget[candTotal] = targetIndex;
        candDist[candTotal] = distanceFields;
        candTotal += 1;
      });
    });
    targetOffset[group.targets.length] = candTotal;

    // (2) Cruzamento com capacidades POR VILA (cotas "1;2" resolvidas) + modo.
    const originRemaining = group.origins.map((_, index) => group.originQuotas[index] ?? 1);
    const targetRemaining = group.targets.map((_, index) => group.targetQuotas[index] ?? 1);
    // Repetição origem→mesmo jogador: bloqueia usar a MESMA origem contra ALVOS
    // DIFERENTES do mesmo jogador. Ondas no MESMO alvo são papel de "Comandos
    // por Alvo" e continuam valendo com a repetição desligada.
    const originVsPlayer = new Map<string, Set<string>>();
    // Cache da identidade do alvo (dono pela tribo do dump): OP de mundo
    // inteiro consulta milhões de vezes e a chave é concatenada a cada lookup.
    const identityByTarget: string[] = new Array<string>(group.targets.length).fill('');
    const targetIdentity = (targetIndex: number): string => {
      const cached = identityByTarget[targetIndex];
      if (cached !== undefined && cached !== '') return cached;
      const owner = ctx.ownerByCoord.get(group.targets[targetIndex]?.coord ?? '');
      // Alvo sem dono conhecido (bárbaro/dump ausente): a VILA é a identidade.
      const identity = owner === undefined ? `vila:${group.targets[targetIndex]?.coord ?? '?'}` : `nick:${owner}`;
      identityByTarget[targetIndex] = identity;
      return identity;
    };
    const repeatOk = (originIndex: number, targetIndex: number): boolean => {
      if (group.repeatOriginSamePlayer) return true;
      const coord = group.targets[targetIndex]?.coord ?? '?';
      const usedCoords = originVsPlayer.get(`${originIndex}→${targetIdentity(targetIndex)}`);
      if (usedCoords === undefined || usedCoords.size === 0) return true;
      // Só bloqueia quando já existe UMA OUTRA vila do mesmo jogador usando a origem.
      return usedCoords.size === 1 && usedCoords.has(coord);
    };
    const assignSlot = (originIndex: number, targetIndex: number): void => {
      const originLeft = originRemaining[originIndex];
      const targetLeft = targetRemaining[targetIndex];
      if (originLeft !== undefined) originRemaining[originIndex] = originLeft - 1;
      if (targetLeft !== undefined) targetRemaining[targetIndex] = targetLeft - 1;
      const key = `${originIndex}→${targetIdentity(targetIndex)}`;
      const usedCoords = originVsPlayer.get(key) ?? new Set<string>();
      usedCoords.add(group.targets[targetIndex]?.coord ?? '?');
      originVsPlayer.set(key, usedCoords);
    };

    const assignments: CandidatePair[] = [];
    if (group.assignMode === 'por-jogador') {
      // DISTRIBUÍDO POR PLAYERS (tool real): justo entre os JOGADORES de origem.
      // Alvos na ordem digitada; cada um vai para o jogador com MENOS comandos
      // até agora (empate: jogador do par mais curto; depois ordem digitada).
      // Os candidatos de cada alvo são o SLICE contíguo [targetOffset[t],
      // targetOffset[t+1]) — mesma ordem e empates do scan linear original.
      // Cache do jogador por origem: OP de mundo inteiro consulta o Map milhões
      // de vezes e a chave é concatenada a cada lookup — aqui monta uma vez.
      const playerByOrigin: string[] = new Array<string>(group.origins.length).fill('');
      const playerOfOrigin = (originIndex: number): string => {
        const cached = playerByOrigin[originIndex];
        if (cached !== undefined && cached !== '') return cached;
        const owner = ctx.ownerByCoord.get(group.origins[originIndex]?.coord ?? '');
        const player = owner === undefined ? `vila:${group.origins[originIndex]?.coord ?? '?'}` : `nick:${owner}`;
        playerByOrigin[originIndex] = player;
        return player;
      };
      const loadByPlayer = new Map<string, number>();
      for (let targetIndex = 0; targetIndex < group.targets.length; targetIndex++) {
        const sliceStart = targetOffset[targetIndex] ?? 0;
        const sliceEnd = targetOffset[targetIndex + 1] ?? 0;
        while ((targetRemaining[targetIndex] ?? 0) > 0) {
          let bestIdx = -1;
          for (let i = sliceStart; i < sliceEnd; i++) {
            const oi = candOrigin[i] ?? -1;
            if (oi < 0) continue;
            if ((originRemaining[oi] ?? 0) <= 0) continue;
            if (!repeatOk(oi, targetIndex)) continue;
            if (bestIdx < 0) {
              bestIdx = i;
              continue;
            }
            const loadA = loadByPlayer.get(playerOfOrigin(oi)) ?? 0;
            const bo = candOrigin[bestIdx] ?? -1;
            const loadB = loadByPlayer.get(playerOfOrigin(bo)) ?? 0;
            const distA = candDist[i] ?? Number.POSITIVE_INFINITY;
            const distB = candDist[bestIdx] ?? Number.POSITIVE_INFINITY;
            const loadDiff = loadA - loadB;
            if (
              loadDiff < 0 ||
              (loadDiff === 0 && (distA < distB || (distA === distB && oi < bo)))
            ) {
              bestIdx = i;
            }
          }
          if (bestIdx < 0) break;
          const winner = candOrigin[bestIdx] ?? -1;
          assignSlot(winner, targetIndex);
          const player = playerOfOrigin(winner);
          loadByPlayer.set(player, (loadByPlayer.get(player) ?? 0) + 1);
          assignments.push({ originIndex: winner, targetIndex, distanceFields: candDist[bestIdx] ?? 0 });
        }
      }
    } else if (group.assignMode === 'otimizado') {
      // Guloso global: o par mais curto disponível do CONJUNTO primeiro —
      // aproximação determinística do matching de custo mínimo do tool real
      // (empate: ordem digitada). Um par pode virar VÁRIOS comandos (ondas).
      // Ordem por índice (o array de índices number[] custa 8 bytes/par — o
      // sort do V8 é iterativo, sem risco de stack).
      const order: number[] = new Array<number>(candTotal);
      for (let i = 0; i < candTotal; i++) order[i] = i;
      order.sort(
        (a, b) =>
          (candDist[a] ?? 0) - (candDist[b] ?? 0) ||
          (candOrigin[a] ?? 0) - (candOrigin[b] ?? 0) ||
          (candTarget[a] ?? 0) - (candTarget[b] ?? 0),
      );
      for (const i of order) {
        const oi = candOrigin[i] ?? -1;
        const ti = candTarget[i] ?? -1;
        if (oi < 0 || ti < 0) continue;
        for (;;) {
          if ((originRemaining[oi] ?? 0) <= 0) break;
          if ((targetRemaining[ti] ?? 0) <= 0) break;
          if (!repeatOk(oi, ti)) break;
          assignSlot(oi, ti);
          assignments.push({ originIndex: oi, targetIndex: ti, distanceFields: candDist[i] ?? 0 });
        }
      }
    } else {
      // Por alvo (ordem digitada): cada slot de demanda escolhe a origem elegível
      // mais PRÓXIMA ("mais-perto") ou mais DISTANTE ("mais-longe"); empate cai
      // na origem digitada primeiro. Sem candidato elegível: alvo fica carente.
      const wantFar = group.assignMode === 'mais-longe';
      for (let targetIndex = 0; targetIndex < group.targets.length; targetIndex++) {
        const sliceStart = targetOffset[targetIndex] ?? 0;
        const sliceEnd = targetOffset[targetIndex + 1] ?? 0;
        while ((targetRemaining[targetIndex] ?? 0) > 0) {
          let bestIdx = -1;
          for (let i = sliceStart; i < sliceEnd; i++) {
            const oi = candOrigin[i] ?? -1;
            if (oi < 0) continue;
            if ((originRemaining[oi] ?? 0) <= 0) continue;
            if (!repeatOk(oi, targetIndex)) continue;
            if (bestIdx < 0) {
              bestIdx = i;
              continue;
            }
            const distA = candDist[i] ?? Number.POSITIVE_INFINITY;
            const distB = candDist[bestIdx] ?? Number.POSITIVE_INFINITY;
            const bo = candOrigin[bestIdx] ?? -1;
            const better = wantFar ? distA > distB : distA < distB;
            if (better || (distA === distB && oi < bo)) {
              bestIdx = i;
            }
          }
          if (bestIdx < 0) break;
          const winner = candOrigin[bestIdx] ?? -1;
          assignSlot(winner, targetIndex);
          assignments.push({ originIndex: winner, targetIndex, distanceFields: candDist[bestIdx] ?? 0 });
        }
      }
    }

    // Sobra de demanda e de capacidade — sempre visível, nunca silencioso.
    const unfilled = targetRemaining.reduce((sum, remaining) => sum + (remaining ?? 0), 0);
    if (unfilled > 0) {
      const starving = group.targets.filter((_, index) => (targetRemaining[index] ?? 0) > 0);
      const preview = starving.slice(0, 5).map((target) => target.coord).join(', ');
      warnings.push(
        `Grupo "${group.nome}": ${unfilled} comando(s) sem origem elegível (alvos: ${preview}${starving.length > 5 ? '…' : ''}).`,
      );
    }
    const idleCapacity = originRemaining.reduce((sum, remaining) => sum + (remaining ?? 0), 0);
    if (idleCapacity > 0 && unfilled === 0) {
      warnings.push(
        `Grupo "${group.nome}": ${idleCapacity} uso(s) de origem ocioso(s) — todos os alvos já foram cobertos.`,
      );
    }

    // (3) Chegadas e partidas.
    // Ordem base determinística: (alvo digitado, origem digitada).
    assignments.sort((a, b) => a.targetIndex - b.targetIndex || a.originIndex - b.originIndex);
    let slotFor: (index: number) => number;
    if (group.arrivalKind === 'sequencial') {
      // DELAY SEQUENCIAL ENTRE ATAQUES (provado no tool real): o k-ésimo ataque
      // NA ORDEM DE DISTÂNCIA crescente chega em base + k×delay (o mais perto
      // fica na base; cada seguinte atrasa). Empate: alvo/origem digitados.
      const byDistance = assignments
        .map((assignment, index) => ({ assignment, index }))
        .sort(
          (a, b) =>
            a.assignment.distanceFields - b.assignment.distanceFields ||
            a.assignment.targetIndex - b.assignment.targetIndex ||
            a.assignment.originIndex - b.assignment.originIndex,
        );
      const slotByIndex = new Map<number, number>();
      byDistance.forEach((entry, slot) => slotByIndex.set(entry.index, slot));
      slotFor = (index) => slotByIndex.get(index) ?? 0;
    } else {
      slotFor = (index) => index;
    }

    let pushedByNight = 0;
    assignments.forEach((assignment, index) => {
      const origin = group.origins[assignment.originIndex];
      const target = group.targets[assignment.targetIndex];
      if (origin === undefined || target === undefined) return; // inalcançável: índices vêm das listas
      const total = assignments.length;
      let arrivalMs: number;
      switch (group.arrivalKind) {
        case 'fixa':
          arrivalMs = group.arrivalBaseMs;
          break;
        case 'intervalo': {
          if (total <= 1) {
            arrivalMs = group.windowStartMs;
          } else {
            const span = group.windowEndMs - group.windowStartMs;
            arrivalMs = group.windowStartMs + Math.floor((slotFor(index) * span) / total);
          }
          break;
        }
        case 'sequencial': {
          const delayMs = Math.round(group.attackDelaySeconds * 1000);
          arrivalMs = group.arrivalBaseMs + slotFor(index) * delayMs;
          break;
        }
      }
      if (group.nightBonus === 'reagendar') {
        if (!ctx.nightBonus.nightBonusActive) {
          if (!warnings.some((warning) => warning.startsWith(`Grupo "${group.nome}": proteção de bônus noturno`))) {
            warnings.push(
              `Grupo "${group.nome}": proteção de bônus noturno pedida, mas o mundo não tem bônus noturno — proteção sem efeito.`,
            );
          }
        } else {
          const pushed = pushArrivalOutOfNightWindow(arrivalMs, ctx.nightBonus);
          arrivalMs = pushed.arrivalMs;
          if (pushed.pushed) pushedByNight += 1;
        }
      }
      const solve = solveDepartureForArrival({
        distanceFields: assignment.distanceFields,
        minutesPerField: unitMinutes,
        arrivalAt: arrivalMs,
        cfg: ctx.nightBonus,
      });
      planned.push({
        command: {
          groupId: group.id,
          groupName: group.nome,
          origin: origin.coord,
          originVillageId: ctx.villageIdByCoord.get(origin.coord) ?? null,
          target: target.coord,
          targetVillageId: ctx.villageIdByCoord.get(target.coord) ?? null,
          targetOwner: ctx.ownerByCoord.get(target.coord) ?? null,
          originOwner: ctx.ownerByCoord.get(origin.coord) ?? null,
          unit: group.slowestUnit,
          distanceFields: assignment.distanceFields,
          travelMinutes: Math.round((solve.travelMs / 60_000) * 100) / 100,
          arrivalMs,
          sendMs: solve.departureAt,
          // Miras de catapulta só fazem sentido quando provamos catapulta na
          // composição — pela unidade mais lenta ser catapulta (modelo é rótulo).
          catapultTargets:
            group.slowestUnit === 'catapult' ? [...group.catapultTargets] : [],
        },
        groupOrder,
        targetIndex: assignment.targetIndex,
        originIndex: assignment.originIndex,
      });
    });
    if (pushedByNight > 0) {
      warnings.push(
        `Grupo "${group.nome}": ${pushedByNight} chegada(s) empurrada(s) para depois da janela do bônus noturno.`,
      );
    }
  });

  // (4) Conflito de ms por jogador: nos grupos COM a marcação, chegadas do
  // mesmo jogador ficam estritamente crescentes (bump de +1ms em cascata) —
  // dois comandos no mesmo ms no mesmo jogador são indistinguíveis no jogo.
  const flagged = planned.filter((entry) => groups[entry.groupOrder]?.avoidMsConflict === true);
  const byPlayer = new Map<string, PlannedCommand[]>();
  for (const entry of flagged) {
    const identity = entry.command.targetOwner ?? `vila:${entry.command.target}`;
    const list = byPlayer.get(identity) ?? [];
    list.push(entry);
    byPlayer.set(identity, list);
  }
  for (const list of byPlayer.values()) {
    list.sort(
      (a, b) =>
        a.command.arrivalMs - b.command.arrivalMs ||
        a.groupOrder - b.groupOrder ||
        a.targetIndex - b.targetIndex ||
        a.originIndex - b.originIndex,
    );
    for (let i = 1; i < list.length; i++) {
      const previous = list[i - 1];
      const current = list[i];
      if (previous === undefined || current === undefined) continue;
      if (current.command.arrivalMs <= previous.command.arrivalMs) {
        current.command.arrivalMs = previous.command.arrivalMs + 1;
      }
    }
    // A partida depende da chegada: recomputa a lista inteira do jogador
    // (barato; sem BN é exato e com BN o solver converge em poucos passos).
    for (const entry of list) {
      const group = groups[entry.groupOrder];
      if (group === undefined) continue;
      const unitMinutes = ctx.unitMinutesPerField[group.slowestUnit];
      if (unitMinutes === undefined || !(unitMinutes > 0)) continue;
      const solve = solveDepartureForArrival({
        distanceFields: entry.command.distanceFields,
        minutesPerField: unitMinutes,
        arrivalAt: entry.command.arrivalMs,
        cfg: ctx.nightBonus,
      });
      entry.command.sendMs = solve.departureAt;
      entry.command.travelMinutes = Math.round((solve.travelMs / 60_000) * 100) / 100;
    }
  }

  // (5) Ordem final da OP: chegada crescente; empate mantém (grupo, alvo, origem) digitados.
  planned.sort(
    (a, b) =>
      a.command.arrivalMs - b.command.arrivalMs ||
      a.groupOrder - b.groupOrder ||
      a.targetIndex - b.targetIndex ||
      a.originIndex - b.originIndex,
  );

  const discardsList: MassDiscardEntry[] = [...discards.entries()].map(([reason, count]) => ({ reason, count }));
  return { commands: planned.map((entry) => entry.command), discards: discardsList, warnings };
}
