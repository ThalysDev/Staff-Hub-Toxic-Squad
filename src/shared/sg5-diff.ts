// SG_5 (P1-12): diff entre duas rodadas da Conferência de Comandos — o que
// aparece/ some entre a conferência anterior e a atual. Puro, determinístico
// e fail-closed: snapshot estruturalmente quebrado lança erro PT-BR claro,
// nunca diff silenciosamente errado. Identidade do comando = commandId
// (id global de ataque do TW): mudanças de nick/nobre NÃO geram novo/cancelado.

import { parseCoord } from './coords';

export interface ConferenceCommand {
  playerName: string;
  commandId: number;
  hasNoble: boolean;
  sizeHint: string | null;
}

export interface ConferenceVillage {
  /** Aldeia-alvo ("x|y"). */
  coord: string;
  commands: ConferenceCommand[];
}

export interface ConferenceSnapshot {
  villages: ConferenceVillage[];
  generatedAt: string;
}

export interface ConferenceDiff {
  /** Comandos presentes só na conferência ATUAL (por commandId). */
  newCommands: { coord: string; playerName: string; commandId: number; hasNoble: boolean }[];
  /** Comandos presentes só na conferência ANTERIOR (por commandId). */
  cancelledCommands: { coord: string; playerName: string; commandId: number }[];
  /** Alvos com ≥1 comando agora e nenhum antes (ordem alfabética da coord). */
  newTargets: string[];
  /** Alvos com ≥1 comando antes e nenhum agora (ordem alfabética da coord). */
  lostTargets: string[];
  /** Só os alvos cuja QUANTIDADE de comandos mudou (ordem alfabética da coord). */
  coverageDelta: { coord: string; before: number; after: number }[];
}

interface SnapshotIndex {
  commandsById: Map<number, { coord: string; playerName: string; hasNoble: boolean }>;
  countsByCoord: Map<string, number>;
}

/** Validação fail-closed + indexação por commandId (coord e contagem por alvo). */
function indexSnapshot(snapshot: ConferenceSnapshot, label: 'anterior' | 'atual'): SnapshotIndex {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new Error(`Conferência ${label} inválida — esperado um objeto snapshot da SG_5.`);
  }
  if (!Array.isArray(snapshot.villages)) {
    throw new Error(`Snapshot ${label} sem a lista de vilas ("villages") — captura de conferência inválida.`);
  }
  if (
    typeof snapshot.generatedAt !== 'string' ||
    snapshot.generatedAt.trim() === '' ||
    Number.isNaN(Date.parse(snapshot.generatedAt))
  ) {
    throw new Error(`Snapshot ${label} com "generatedAt" ausente ou fora do formato ISO.`);
  }

  const commandsById = new Map<number, { coord: string; playerName: string; hasNoble: boolean }>();
  const countsByCoord = new Map<string, number>();

  snapshot.villages.forEach((village, villageIndex) => {
    if (typeof village !== 'object' || village === null) {
      throw new Error(`Vila #${villageIndex + 1} do snapshot ${label} não é um objeto.`);
    }
    const parsedCoord = parseCoord(village.coord);
    if (parsedCoord === null) {
      throw new Error(
        `Vila #${villageIndex + 1} do snapshot ${label} com coordenada inválida (use x|y): "${String(village.coord).slice(0, 30)}".`,
      );
    }
    const coord = village.coord.trim();
    if (countsByCoord.has(coord)) {
      throw new Error(`Alvo "${coord}" repetido no snapshot ${label} — cada aldeia deve aparecer uma única vez.`);
    }
    countsByCoord.set(coord, 0);
    if (!Array.isArray(village.commands)) {
      throw new Error(`Vila "${coord}" do snapshot ${label} sem a lista de comandos ("commands").`);
    }

    for (const command of village.commands) {
      if (typeof command !== 'object' || command === null) {
        throw new Error(`Comando da vila "${coord}" no snapshot ${label} não é um objeto.`);
      }
      if (!Number.isInteger(command.commandId) || command.commandId <= 0) {
        throw new Error(
          `Comando da vila "${coord}" no snapshot ${label} com commandId inválido (${String(command.commandId)}) — esperado inteiro > 0.`,
        );
      }
      if (typeof command.playerName !== 'string') {
        throw new Error(`Comando ${command.commandId} da vila "${coord}" no snapshot ${label} sem nick textual.`);
      }
      if (typeof command.hasNoble !== 'boolean') {
        throw new Error(`Comando ${command.commandId} da vila "${coord}" no snapshot ${label} com hasNoble inválido — esperado booleano.`);
      }
      if (command.sizeHint !== null && typeof command.sizeHint !== 'string') {
        throw new Error(`Comando ${command.commandId} da vila "${coord}" no snapshot ${label} com sizeHint inválido — esperado texto ou null.`);
      }
      if (commandsById.has(command.commandId)) {
        throw new Error(
          `commandId ${command.commandId} duplicado no snapshot ${label} — a identidade por commandId precisa ser única.`,
        );
      }
      commandsById.set(command.commandId, { coord, playerName: command.playerName, hasNoble: command.hasNoble });
      countsByCoord.set(coord, (countsByCoord.get(coord) ?? 0) + 1);
    }
  });

  return { commandsById, countsByCoord };
}

/** Ordem exibida: coordenada ascendente, depois commandId — estável em ambas as rodadas. */
function byCoordThenCommandId(a: { coord: string }, b: { coord: string }): number {
  return a.coord.localeCompare(b.coord, 'pt-BR');
}

/**
 * Compara a conferência ANTERIOR com a ATUAL e devolve comandos novos/
 * cancelados (identidade = commandId), alvos que apareceram/ sumiram e a
 * variação de cobertura por alvo. Snapshots idênticos ⇒ todas as listas vazias.
 */
export function diffConferences(previous: ConferenceSnapshot, current: ConferenceSnapshot): ConferenceDiff {
  const prev = indexSnapshot(previous, 'anterior');
  const cur = indexSnapshot(current, 'atual');

  const newCommands: ConferenceDiff['newCommands'] = [];
  for (const [commandId, entry] of cur.commandsById) {
    // Identidade estável: commandId nas duas rodadas NÃO é novo/cancelado,
    // mesmo que nick ou marcação de nobre tenham mudado entre coletas.
    if (prev.commandsById.has(commandId)) continue;
    newCommands.push({ coord: entry.coord, playerName: entry.playerName, commandId, hasNoble: entry.hasNoble });
  }
  newCommands.sort(byCoordThenCommandId);

  const cancelledCommands: ConferenceDiff['cancelledCommands'] = [];
  for (const [commandId, entry] of prev.commandsById) {
    if (cur.commandsById.has(commandId)) continue;
    cancelledCommands.push({ coord: entry.coord, playerName: entry.playerName, commandId });
  }
  cancelledCommands.sort(byCoordThenCommandId);

  const coordsUnion = new Set<string>([...prev.countsByCoord.keys(), ...cur.countsByCoord.keys()]);
  const newTargets: string[] = [];
  const lostTargets: string[] = [];
  const coverageDelta: ConferenceDiff['coverageDelta'] = [];
  for (const coord of coordsUnion) {
    const before = prev.countsByCoord.get(coord) ?? 0;
    const after = cur.countsByCoord.get(coord) ?? 0;
    if (before === after) continue;
    coverageDelta.push({ coord, before, after });
    if (after > 0) newTargets.push(coord);
    else lostTargets.push(coord);
  }
  const byCoord = (a: string, b: string): number => a.localeCompare(b, 'pt-BR');
  newTargets.sort(byCoord);
  lostTargets.sort(byCoord);
  coverageDelta.sort((a, b) => a.coord.localeCompare(b.coord, 'pt-BR'));

  return { newCommands, cancelledCommands, newTargets, lostTargets, coverageDelta };
}
