// Sala de Guerra · Planner de OP em Massa — MOTOR puro e determinístico.
// Cruza origens × alvos por grupo com capacidades ("Comandos por Origem/Alvo"),
// aplica filtros (distância mín/máx, Torre de Vigia inimiga por distância
// ponto→segmento, moral mínima por pontos), agenda chegadas (fixa / intervalo /
// fixa com intervalo por aldeia), protege bônus noturno (empurra a chegada para
// depois da janela), resolve conflito de ms por jogador e calcula a PARTIDA de
// cada comando com o solver inverso (viagem dentro da janela noturna custa 2×).
//
// Nada de relógio, rede ou DOM: o contexto do mundo entra pronto
// (MassPlanContext) e a âncora de data vem em cada grupo (arrivalBaseMs) —
// mesma disciplina das engines SG_4/SG_1. Descartes de pares NUNCA são
// silenciosos: voltam agregados por motivo em MassPlanResult.discards.

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

/** Teto defensivo do cruzamento: pares candidatos por grupo (origens × alvos). */
export const MASS_MAX_PAIRS = 250_000;

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
// Validação do grupo (campos do formulário — mensagem por campo)
// ---------------------------------------------------------------------------

/** Erros por campo; objeto vazio = grupo válido. Não avalia texto de textarea —
 *  o caller converte as coordenadas antes (parseMassCoordText). */
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
  const unitMinutes = ctx.unitMinutesPerField[group.slowestUnit];
  if (unitMinutes === undefined || !(unitMinutes > 0)) {
    errors.slowestUnit =
      'Velocidade da unidade indisponível — atualize os dados do mundo (unit-info) antes de gerar.';
  }
  if (!Number.isInteger(group.commandsPerOrigin) || group.commandsPerOrigin < 1) {
    errors.commandsPerOrigin = 'Comandos por origem deve ser um inteiro ≥ 1.';
  }
  if (!Number.isInteger(group.commandsPerTarget) || group.commandsPerTarget < 1) {
    errors.commandsPerTarget = 'Comandos por alvo deve ser um inteiro ≥ 1.';
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
  if (group.arrivalKind === 'intervalo' && !(group.windowMinutes >= 1)) {
    errors.windowMinutes = 'A janela de espalhamento deve ser de pelo menos 1 minuto.';
  }
  if (group.arrivalKind === 'fixa-por-aldeia' && !(group.perVillageSeconds >= 0)) {
    errors.perVillageSeconds = 'O intervalo por aldeia deve ser ≥ 0 segundos.';
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
// Texto de coordenadas → coordenadas canônicas (mesmo tratamento da blindagem)
// ---------------------------------------------------------------------------

/** Converte o texto colado em coordenadas canônicas: ordem da 1ª aparição,
 *  dedupe e CONTAGEM de inválidos/duplicadas — o caller decide avisar; nunca
 *  descarte silencioso (AGENTS.md). */
export function parseMassCoordText(
  raw: string,
): { entries: MassCoordEntry[]; invalidTokens: number; duplicatesRemoved: number } {
  const normalized = normalizeCoordText(raw);
  const entries: MassCoordEntry[] = [];
  for (const coord of normalized.coords) {
    const parsed = parseCoord(coord);
    if (parsed === null) continue; // inalcançável: normalizeCoordText só emite \d{1,3}\|\d{1,3}
    entries.push({ coord: parsed.x + '|' + parsed.y, x: parsed.x, y: parsed.y });
  }
  return {
    entries,
    invalidTokens: normalized.invalidTokens,
    duplicatesRemoved: normalized.duplicatesRemoved,
  };
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

/** Chegada por slot (k de n) conforme o modo do grupo — determinística. */
function arrivalForSlot(
  group: MassGroupConfig,
  slot: number,
  total: number,
  villageOffsetSec: number,
): number {
  switch (group.arrivalKind) {
    case 'fixa':
      return group.arrivalBaseMs;
    case 'intervalo': {
      if (total <= 1) return group.arrivalBaseMs;
      const windowMs = Math.round(group.windowMinutes * 60_000);
      return group.arrivalBaseMs + Math.floor((slot * windowMs) / total);
    }
    case 'fixa-por-aldeia':
      return group.arrivalBaseMs + villageOffsetSec * 1000;
  }
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

    // (1) Pares candidatos com os filtros DE PAR (distância, torre, moral).
    const candidates: CandidatePair[] = [];
    group.origins.forEach((origin, originIndex) => {
      group.targets.forEach((target, targetIndex) => {
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
        candidates.push({ originIndex, targetIndex, distanceFields });
      });
    });

    // (2) Cruzamento com capacidades + modo de cálculo (determinístico).
    const originRemaining = group.origins.map(() => group.commandsPerOrigin);
    const targetRemaining = group.targets.map(() => group.commandsPerTarget);
    // Repetição origem→mesmo jogador: bloqueia usar a MESMA origem contra ALVOS
    // DIFERENTES do mesmo jogador. Ondas no MESMO alvo são papel de "Comandos
    // por Alvo" e continuam valendo com a repetição desligada.
    const originVsPlayer = new Map<string, Set<string>>();
    const targetIdentity = (targetIndex: number): string => {
      const owner = ctx.ownerByCoord.get(group.targets[targetIndex]?.coord ?? '');
      // Alvo sem dono conhecido (bárbaro/dump ausente): a VILA é a identidade.
      return owner === undefined ? `vila:${group.targets[targetIndex]?.coord ?? '?'}` : `nick:${owner}`;
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
    if (group.assignMode === 'otimizado') {
      // Guloso global: o par mais curto disponível do CONJUNTO primeiro —
      // minimiza a distância total respeitando capacidades (empate: ordem digitada).
      // Um par pode virar VÁRIOS comandos (ondas): esgota min(capOrigem, capAlvo)
      // antes de avançar para o próximo par.
      const ordered = [...candidates].sort(
        (a, b) =>
          a.distanceFields - b.distanceFields ||
          a.originIndex - b.originIndex ||
          a.targetIndex - b.targetIndex,
      );
      for (const pair of ordered) {
        for (;;) {
          if ((originRemaining[pair.originIndex] ?? 0) <= 0) break;
          if ((targetRemaining[pair.targetIndex] ?? 0) <= 0) break;
          if (!repeatOk(pair.originIndex, pair.targetIndex)) break;
          assignSlot(pair.originIndex, pair.targetIndex);
          assignments.push(pair);
        }
      }
    } else {
      // Por alvo (ordem digitada): cada slot de demanda escolhe a origem elegível
      // mais PRÓXIMA ("mais-perto") ou mais DISTANTE ("mais-longe"); empate cai
      // na origem digitada primeiro. Sem candidato elegível: alvo fica carente.
      const wantFar = group.assignMode === 'mais-longe';
      for (let targetIndex = 0; targetIndex < group.targets.length; targetIndex++) {
        while ((targetRemaining[targetIndex] ?? 0) > 0) {
          let best: CandidatePair | null = null;
          for (const pair of candidates) {
            if (pair.targetIndex !== targetIndex) continue;
            if ((originRemaining[pair.originIndex] ?? 0) <= 0) continue;
            if (!repeatOk(pair.originIndex, pair.targetIndex)) continue;
            if (best === null) {
              best = pair;
              continue;
            }
            const better =
              wantFar
                ? pair.distanceFields > best.distanceFields
                : pair.distanceFields < best.distanceFields;
            if (better || (pair.distanceFields === best.distanceFields && pair.originIndex < best.originIndex)) {
              best = pair;
            }
          }
          if (best === null) break;
          assignSlot(best.originIndex, best.targetIndex);
          assignments.push(best);
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

    // (3) Chegadas e partidas. Ordem determinística: (alvo digitado, origem digitada).
    assignments.sort((a, b) => a.targetIndex - b.targetIndex || a.originIndex - b.originIndex);
    // Offset de aldeia ("fixa-por-aldeia"): índice do alvo entre os DISTINTOS, na ordem digitada.
    const villageOffsetByTarget = new Map<number, number>();
    if (group.arrivalKind === 'fixa-por-aldeia') {
      for (const assignment of assignments) {
        if (!villageOffsetByTarget.has(assignment.targetIndex)) {
          villageOffsetByTarget.set(assignment.targetIndex, villageOffsetByTarget.size);
        }
      }
    }

    let pushedByNight = 0;
    assignments.forEach((assignment, slot) => {
      const origin = group.origins[assignment.originIndex];
      const target = group.targets[assignment.targetIndex];
      if (origin === undefined || target === undefined) return; // inalcançável: índices vêm das listas
      let arrivalMs = arrivalForSlot(
        group,
        slot,
        assignments.length,
        (villageOffsetByTarget.get(assignment.targetIndex) ?? 0) * group.perVillageSeconds,
      );
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
          target: target.coord,
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
