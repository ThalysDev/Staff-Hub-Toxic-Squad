// Motor de operações (SG_4) — (a) OP por coordenada central com camadas de horas
// e separação alvos/fakes; (b) distribuição de alvos com planilha e prioridade.
// Puro e testável; tempos sempre em HORAS DE NOBRE (min/campo efetivo do mundo).

import { fieldsBetween } from './distance';


export interface EnemyVillageRef {
  playerId: number;
  playerName: string;
  coord: { x: number; y: number };
  points?: number;
}

function hoursBetween(a: { x: number; y: number }, b: { x: number; y: number }, nobleMinutesPerField: number): number {
  return (fieldsBetween(a, b) * nobleMinutesPerField) / 60;
}

// ---------------------------------------------------------------------------
// (a) Criação de OP com Coordenada Central
// ---------------------------------------------------------------------------

/** Tabela Jogador | 1 Hora | … | 8 Horas | Outras — colunas fixas da ferramenta original. */
export interface CentralOpRow {
  playerId: number;
  playerName: string;
  /** Contagem por coluna de hora (índices 1..8 = buckets [h, h+1)). */
  hourCounts: number[];
  /** Aldeias além de 8 horas. */
  others: number;
  /** Marcação por jogador — 'alvo' | 'fake' (original: dropdown Ação). */
  action: 'alvo' | 'fake';
}

export interface CentralOpResult {
  rows: CentralOpRow[];
  /** Aldeias dos jogadores marcados 'alvo' até a coluna de corte (coords "123|456"). */
  targets: string[];
  /** Aldeias dos jogadores marcados 'fake' até a coluna de corte. */
  fakes: string[];
}

export function centralOpAnalysis(
  enemies: EnemyVillageRef[],
  central: { x: number; y: number },
  nobleMinutesPerField: number,
): CentralOpResult {
  const byPlayer = new Map<number, CentralOpRow>();
  for (const enemy of enemies) {
    const row = byPlayer.get(enemy.playerId) ?? {
      playerId: enemy.playerId,
      playerName: enemy.playerName,
      hourCounts: [0, 0, 0, 0, 0, 0, 0, 0],
      others: 0,
      action: 'fake',
    };
    const hours = hoursBetween(enemy.coord, central, nobleMinutesPerField);
    if (hours < 8) {
      const bucket = Math.floor(hours);
      row.hourCounts[bucket] = (row.hourCounts[bucket] ?? 0) + 1;
    } else {
      row.others += 1;
    }
    byPlayer.set(enemy.playerId, row);
  }
  const rows = [...byPlayer.values()].sort((a, b) => a.playerName.localeCompare(b.playerName, 'pt-BR'));
  return { rows, targets: [], fakes: [] };
}

/** "Obter Alvos e Fakes": separa coords conforme a marcação e a coluna de corte. */
export function splitTargetsFakes(
  enemies: EnemyVillageRef[],
  central: { x: number; y: number },
  nobleMinutesPerField: number,
  actions: Map<number, 'alvo' | 'fake'>,
  cutoffHours: number,
): { targets: string[]; fakes: string[] } {
  const targets: string[] = [];
  const fakes: string[] = [];
  for (const enemy of enemies) {
    const action = actions.get(enemy.playerId);
    if (action !== 'alvo' && action !== 'fake') continue;
    const hours = hoursBetween(enemy.coord, central, nobleMinutesPerField);
    if (hours >= cutoffHours) continue;
    (action === 'alvo' ? targets : fakes).push(`${enemy.coord.x}|${enemy.coord.y}`);
  }
  return { targets, fakes };
}

// ---------------------------------------------------------------------------
// (b) Distribuição de Alvos de OP
// ---------------------------------------------------------------------------

/** Linha "nick;nroFulls;coord coord" do formulário INFORMAÇÕES ORIGEM. */
export interface OriginPlayer {
  playerName: string;
  fulls: number;
  /** Cada coordenada de origem = um NT estacionado (1 alvo a receber). */
  origins: { x: number; y: number }[];
}

export function parseOriginsInput(text: string): OriginPlayer[] {
  const players: OriginPlayer[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = /^([^;]{2,40});(\d+);((?:\d{1,3}\|\d{1,3}\s*)+)$/.exec(trimmed);
    if (match === null) {
      throw new Error(`Linha de origem inválida (use "nick;fulls;coord coord"): "${trimmed.slice(0, 60)}"`);
    }
    const origins = (match[3] ?? '')
      .trim()
      .split(/\s+/)
      .map((pair) => {
        const [x, y] = pair.split('|');
        return { x: Number(x), y: Number(y) };
      });
    players.push({ playerName: match[1] ?? '', fulls: Number(match[2] ?? 0), origins });
  }
  if (players.length === 0) {
    throw new Error('Nenhuma origem informada — cole as linhas "nick;fulls;coords de origem".');
  }
  return players;
}

export interface TargetLine {
  /** Faixa de fulls da linha (0–200 = todos). */
  fullsFrom: number;
  fullsTo: number;
  targets: { x: number; y: number; points?: number }[];
}

/** Moral TW: quem ataca alvo MENOR é penalizado — moral = (def/att)^0.75, teto
 * 100. (Sentido confirmado na revisão; calibração fina contra o jogo pendente.) */
export function moraleOf(attackerPoints: number, defenderPoints: number): number {
  // Sem pontos (bárbaros/dados ausentes) não há penalidade de moral.
  if (attackerPoints <= 0 || defenderPoints <= 0) return 100;
  return Math.min(100, Math.round((defenderPoints / attackerPoints) ** 0.75 * 100));
}

export interface DistributionInput {
  origins: OriginPlayer[];
  lines: TargetLine[];
  nobleMinutesPerField: number;
  /** Prioridade de pareamento. */
  priority: 'nearest' | 'farthest';
  /** Moral mínimo aceito (0–100; 0 = ignorar). */
  minMorale: number;
  /** Distância máxima aceita em CAMPOS (ex.: 70 no mundo clássico). */
  maxFields: number;
  /** Pontos por jogador de origem/alvo para moral (opcional; sem pontos = moral 100). */
  originPoints?: Map<string, number>;
  targetPoints?: Map<string, number>;
}

export interface PlanCell {
  hours: number;
  fields: number;
  morale: number | null;
}

export interface DistributionResult {
  /** Matriz planilha: uma linha por origem (coord), uma coluna por alvo. */
  matrix: { origin: string; player: string; cells: PlanCell[] }[];
  lineTargets: { x: number; y: number }[];
  assignments: { playerName: string; origin: string; target: string }[];
  orphanOrigins: { playerName: string; origin: string }[];
  orphanTargets: string[];
}

/**
 * Distribui cada ORIGEM (NT estacionado) a um ALVO elegível: faixa de fulls da
 * linha do alvo, moral mínimo, distância máxima; alvo consumido por 1 atacante.
 * "Obter Planificação" = matrix; "Realizar Distribuição" = assignments.
 */
export function distributeTargets(input: DistributionInput): DistributionResult {
  const lineTargets: { x: number; y: number; fullsFrom: number; fullsTo: number; points?: number }[] = [];
  for (const line of input.lines) {
    for (const target of line.targets) {
      lineTargets.push({ ...target, fullsFrom: line.fullsFrom, fullsTo: line.fullsTo });
    }
  }

  const flatOrigins = input.origins.flatMap((player) =>
    player.origins.map((origin) => ({ playerName: player.playerName, fulls: player.fulls, origin })),
  );

  // Moral exigida sem pontos de origem/alvo → fail-closed com erro claro.
  if (input.minMorale > 0) {
    const missingOrigins = flatOrigins.filter((entry) => input.originPoints?.get(entry.playerName) === undefined);
    const missingTargets = lineTargets.filter(
      (target) => (target.points ?? input.targetPoints?.get(`${target.x}|${target.y}`)) === undefined,
    );
    if (missingOrigins.length > 0 || missingTargets.length > 0) {
      throw new Error(
        `Moral mínima exigida, mas ${missingOrigins.length} origem(ns) e ${missingTargets.length} alvo(s) sem pontos — carregue as tribos na seção "Criação de OP com Coordenada Central" antes de distribuir com moral.`,
      );
    }
  }

  // Planilha: horas/moral de cada origem×alvo (para o heatmap).
  const matrix = flatOrigins.map((entry) => ({
    origin: `${entry.origin.x}|${entry.origin.y}`,
    player: entry.playerName,
    cells: lineTargets.map((target) => {
      const fields = fieldsBetween(entry.origin, target);
      const attPoints = input.originPoints?.get(entry.playerName);
      const defPoints = target.points ?? input.targetPoints?.get(`${target.x}|${target.y}`);
      const morale = attPoints !== undefined && defPoints !== undefined ? moraleOf(attPoints, defPoints) : null;
      return { hours: (fields * input.nobleMinutesPerField) / 60, fields, morale };
    }),
  }));

  // Distribuição gulosa: candidatos elegíveis ordenados por prioridade.
  const usedTargets = new Set<number>();
  const assignments: DistributionResult['assignments'] = [];
  const orphanOrigins: DistributionResult['orphanOrigins'] = [];
  for (const entry of flatOrigins) {
    const candidates = lineTargets
      .map((target, index) => ({ target, index, fields: fieldsBetween(entry.origin, target) }))
      .filter(({ target, fields, index }) => {
        if (usedTargets.has(index)) return false;
        if (fields > input.maxFields) return false;
        if (entry.fulls < target.fullsFrom || entry.fulls > target.fullsTo) return false;
        if (input.minMorale > 0) {
          const attPoints = input.originPoints?.get(entry.playerName);
          const defPoints = target.points ?? input.targetPoints?.get(`${target.x}|${target.y}`);
          if (attPoints !== undefined && defPoints !== undefined) {
            if (moraleOf(attPoints, defPoints) < input.minMorale) return false;
          }
        }
        return true;
      })
      .sort((a, b) => (input.priority === 'nearest' ? a.fields - b.fields : b.fields - a.fields));
    const best = candidates[0];
    if (best === undefined) {
      orphanOrigins.push({ playerName: entry.playerName, origin: `${entry.origin.x}|${entry.origin.y}` });
      continue;
    }
    usedTargets.add(best.index);
    assignments.push({
      playerName: entry.playerName,
      origin: `${entry.origin.x}|${entry.origin.y}`,
      target: `${best.target.x}|${best.target.y}`,
    });
  }
  const orphanTargets = lineTargets
    .filter((_, index) => !usedTargets.has(index))
    .map((target) => `${target.x}|${target.y}`);

  return {
    matrix,
    lineTargets: lineTargets.map((t) => ({ x: t.x, y: t.y })),
    assignments,
    orphanOrigins,
    orphanTargets,
  };
}

/** Resumo copiável da distribuição: "Nick;coords distribuídas" (formato original). */
export function distributionSummary(result: DistributionResult): string {
  const byPlayer = new Map<string, string[]>();
  for (const assignment of result.assignments) {
    const list = byPlayer.get(assignment.playerName) ?? [];
    list.push(assignment.target);
    byPlayer.set(assignment.playerName, list);
  }
  return [...byPlayer.entries()].map(([name, targets]) => `${name};${targets.join(' ')}`).join('\n');
}
