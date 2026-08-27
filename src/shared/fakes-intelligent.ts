// Fakes inteligentes (SG_4, P1-16): após a distribuição principal de alvos,
// origens com comando SOBRANDO mandam fakes para os alvos que ficaram,
// espalhando a ilusão entre o máximo de vilas possível. Puro e determinístico;
// nada de relógio, rede ou DOM. A proximidade vem do caller via distanceTo —
// a engine não calcula geometria (o caller pode usar métrica própria).

import { parseCoord } from './coords';

/** Alvo que sobrou da distribuição principal, disponível para receber fake. */
export interface FakeTarget {
  /** Coordenada da vila alvo ("x|y"). */
  coord: string;
  /** Metadado do caller (ex.: campos até a coordenada central da OP), validado
   * como número finito ≥ 0. NÃO participa do pareamento: proximidade e corte
   * de maxFields usam sempre a distância real origem→alvo (distanceTo). */
  distanceFields: number;
}

/** Origem com comando sobrando, candidata a mandar fake. */
export interface FakeOrigin {
  /** Nick do dono da vila de origem. */
  playerName: string;
  /** Coordenada da vila de origem ("x|y"). */
  coord: string;
  /** Distância em CAMPOS até uma coordenada-alvo — fonte única de verdade
   * para a escolha do mais próximo E para o corte de maxFields. */
  distanceTo: (target: string) => number;
}

/** Fake pareado: origem → alvo, com a distância em campos do PAR. */
export interface FakeAssignment {
  playerName: string;
  origin: string;
  target: string;
  /** Campos reais origem→alvo (2 decimais) — o MESMO número usado no corte
   * de maxFields (a planilha nunca mostra distância além da aceita). */
  distanceFields: number;
}

export interface FakeDistributionResult {
  assignments: FakeAssignment[];
  /** Alvos que ficaram sem fake nenhum (ordem de entrada). */
  unassignedTargets: string[];
  /** Coordenadas das origens que não mandaram NENHUM fake (ordem de entrada;
   * coord repetida só se o caller listou a mesma vila duas vezes). */
  idleOrigins: string[];
}

export interface DistributeFakesOptions {
  /** Fakes que CADA entrada de origem pode pegar no máximo (default 1). */
  maxPerOrigin?: number;
  /** Distância máxima origem→alvo aceita, em campos (default 70). */
  maxFields?: number;
}

const DEFAULT_MAX_PER_ORIGIN = 1;
const DEFAULT_MAX_FIELDS = 70;

function roundFields(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseOptions(opts?: DistributeFakesOptions): { maxPerOrigin: number; maxFields: number } {
  const maxPerOrigin = opts?.maxPerOrigin ?? DEFAULT_MAX_PER_ORIGIN;
  if (!Number.isInteger(maxPerOrigin) || maxPerOrigin < 1) {
    throw new Error(`maxPerOrigin inválido (${String(opts?.maxPerOrigin)}) — use inteiro ≥ 1 (default 1).`);
  }
  const maxFields = opts?.maxFields ?? DEFAULT_MAX_FIELDS;
  if (typeof maxFields !== 'number' || !Number.isFinite(maxFields) || maxFields <= 0) {
    throw new Error(`maxFields inválido (${String(opts?.maxFields)}) — use número positivo em campos (default 70).`);
  }
  return { maxPerOrigin, maxFields };
}

/**
 * Distribuição GULOSA de fakes: a cada passo, a origem elegível com MENOS fakes
 * atribuídos pega o alvo ainda não usado MAIS PRÓXIMO dela (empates resolvidos
 * pela ordem de entrada). Determinístico; cada alvo recebe no máximo 1 fake.
 * Fail-closed: coordenada fora do formato "x|y", nick vazio, distanceTo que não
 * é função ou retorna valor negativo/não finito lançam erro PT-BR claro.
 */
export function distributeFakes(
  origins: FakeOrigin[],
  targets: FakeTarget[],
  opts?: DistributeFakesOptions,
): FakeDistributionResult {
  const options = parseOptions(opts);

  const parsedOrigins = origins.map((origin, index) => {
    if (typeof origin !== 'object' || origin === null || typeof origin.distanceTo !== 'function') {
      throw new Error(`Origem fake #${index + 1} inválida — esperado objeto com playerName, coord e distanceTo.`);
    }
    if (typeof origin.playerName !== 'string') {
      throw new Error(`Nick da origem fake #${index + 1} inválido — esperado texto.`);
    }
    const coord = parseCoord(origin.coord);
    if (coord === null) {
      throw new Error(`Coordenada da origem fake #${index + 1} inválida (use x|y): "${String(origin.coord).slice(0, 30)}".`);
    }
    const playerName = origin.playerName.trim();
    if (playerName === '') {
      throw new Error(`Nick ausente na origem fake "${origin.coord.trim()}".`);
    }
    return { index, playerName, coord: origin.coord.trim(), distanceTo: origin.distanceTo };
  });

  const parsedTargets = targets.map((fakeTarget, index) => {
    if (typeof fakeTarget !== 'object' || fakeTarget === null) {
      throw new Error(`Alvo fake #${index + 1} inválido — esperado objeto com coord e distanceFields.`);
    }
    const coord = parseCoord(fakeTarget.coord);
    if (coord === null) {
      throw new Error(`Coordenada do alvo fake #${index + 1} inválida (use x|y): "${String(fakeTarget.coord).slice(0, 30)}".`);
    }
    if (
      typeof fakeTarget.distanceFields !== 'number' ||
      !Number.isFinite(fakeTarget.distanceFields) ||
      fakeTarget.distanceFields < 0
    ) {
      throw new Error(
        `Alvo fake "${fakeTarget.coord.trim()}" com distanceFields inválido — esperado número finito ≥ 0.`,
      );
    }
    return { index, coord: fakeTarget.coord.trim() };
  });

  const assignedCount = new Array<number>(parsedOrigins.length).fill(0);
  const retired = new Array<boolean>(parsedOrigins.length).fill(false);
  const idleIndices = new Set<number>();
  const usedTargets = new Set<number>();
  const records: { originIndex: number; targetIndex: number; assignment: FakeAssignment }[] = [];

  // Cada iteração avança sempre (atribui um fake OU aposenta uma origem) —
  // no máximo parsedOrigins.length + usedTargets.size iterações.
  for (;;) {
    let nextIndex = -1;
    let nextCount = Number.POSITIVE_INFINITY;
    for (let i = 0; i < parsedOrigins.length; i++) {
      if (retired[i] === true) continue;
      const count = assignedCount[i] ?? 0;
      if (count >= options.maxPerOrigin) {
        retired[i] = true;
        continue;
      }
      if (count < nextCount) {
        nextCount = count;
        nextIndex = i;
      }
    }
    if (nextIndex < 0) break;

    const originEntry = parsedOrigins[nextIndex];
    if (originEntry === undefined) break; // inalcançável com nextIndex validado

    let bestTargetIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let j = 0; j < parsedTargets.length; j++) {
      if (usedTargets.has(j)) continue;
      const candidate = parsedTargets[j];
      if (candidate === undefined) continue;
      const raw = originEntry.distanceTo(candidate.coord);
      if (!Number.isFinite(raw) || raw < 0) {
        throw new Error(
          `distanceTo da origem "${originEntry.coord}" retornou valor inválido (${String(raw)}) para o alvo "${candidate.coord}" — esperado número de campos ≥ 0.`,
        );
      }
      const fields = roundFields(raw);
      if (fields > options.maxFields) continue;
      if (fields < bestDistance) {
        bestDistance = fields;
        bestTargetIndex = j;
      }
    }

    if (bestTargetIndex < 0) {
      // Sem candidato agora ⇒ nunca haverá (alvos só diminuem): origem aposentada.
      if ((assignedCount[nextIndex] ?? 0) === 0) idleIndices.add(nextIndex);
      retired[nextIndex] = true;
      continue;
    }

    const bestTarget = parsedTargets[bestTargetIndex];
    if (bestTarget === undefined) break; // inalcançável com bestTargetIndex validado

    usedTargets.add(bestTargetIndex);
    assignedCount[nextIndex] = (assignedCount[nextIndex] ?? 0) + 1;
    records.push({
      originIndex: nextIndex,
      targetIndex: bestTargetIndex,
      assignment: {
        playerName: originEntry.playerName,
        origin: originEntry.coord,
        target: bestTarget.coord,
        distanceFields: bestDistance,
      },
    });
  }

  const assignments = records
    .sort((a, b) => a.originIndex - b.originIndex || a.targetIndex - b.targetIndex)
    .map((record) => record.assignment);

  const unassignedTargets = parsedTargets
    .filter((target) => !usedTargets.has(target.index))
    .map((target) => target.coord);

  const idleOrigins = parsedOrigins
    .filter((origin) => idleIndices.has(origin.index))
    .map((origin) => origin.coord);

  return { assignments, unassignedTargets, idleOrigins };
}
