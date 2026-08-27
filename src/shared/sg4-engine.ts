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
  // Guard: noble<=0 colapsaria todas as aldeias em "1 Hora" silenciosamente.
  if (!(nobleMinutesPerField > 0)) {
    throw new Error('Minutos de nobre por campo inválidos — carregue os dados do mundo antes de analisar.');
  }
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
  // Contrato do motor: o corte é 1–5 horas (a UI limita; aqui fail-closed).
  if (!Number.isInteger(cutoffHours) || cutoffHours < 1 || cutoffHours > 5) {
    throw new Error(`Corte de horas inválido: ${cutoffHours} — use um inteiro de 1 a 5.`);
  }
  if (!(nobleMinutesPerField > 0)) {
    throw new Error('Minutos de nobre por campo inválidos — carregue os dados do mundo antes de separar.');
  }
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

/** Linha "nick;nroFulls;coord coord" (LEGADO) ou "nick;nroFulls;nroSemis;coord
 * coord" (FULL/SEMI, contagem do SG_2) do formulário INFORMAÇÕES ORIGEM. */
export interface OriginPlayer {
  playerName: string;
  fulls: number;
  /** Aldeias semi (ofensiva parcial) do jogador. Formato legado não traz a chave
   * — leitura usa default 0. */
  semis?: number;
  /** Cada coordenada de origem = um NT estacionado (1 alvo a receber). No formato
   * FULL/SEMI: fulls primeiro, semis depois (ordem digitada). */
  origins: { x: number; y: number }[];
  /** Coordenadas de tier 'semi' (subset de origins). Legado: vazio (chave ausente). */
  semiOrigins?: { x: number; y: number }[];
}

/** Pares "x|y" separados por espaço → coordenadas numéricas (ordem preservada).
 *  Coord DUPLICADA na mesma linha lança: um NT não ataca dois alvos — aceitar
 *  duplicata criava 2 linhas idênticas na matrix e 2 alvos consumidos pela
 *  mesma vila (resultado mentiroso, sem aviso). */
function parseCoordPairs(text: string): { x: number; y: number }[] {
  const seen = new Set<string>();
  return text
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split('|');
      return { x: Number(x), y: Number(y) };
    })
    .map((coord) => {
      const key = coord.x + "|" + coord.y;
      if (seen.has(key)) {
        throw new Error("Coordenada de origem repetida na mesma linha: " + key + " — um NT não ataca dois alvos.");
      }
      seen.add(key);
      return coord;
    });
}

const ORIGIN_COORDS = '(?:\\d{1,3}\\|\\d{1,3})(?:\\s+\\d{1,3}\\|\\d{1,3})*\\s*';
/** Novo FULL/SEMI: nick;fulls;semis;coords. */
const LINE_WITH_SEMIS = new RegExp(`^([^;]{2,40});(\\d+);(\\d+);(${ORIGIN_COORDS})$`);
/** Legado: nick;fulls;coords (fulls pode divergir do nº de coords — tolerância mantida). */
const LINE_LEGACY = new RegExp(`^([^;]{2,40});(\\d+);(${ORIGIN_COORDS})$`);

export function parseOriginsInput(text: string): OriginPlayer[] {
  const players: OriginPlayer[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const semisMatch = LINE_WITH_SEMIS.exec(trimmed);
    if (semisMatch !== null) {
      const playerName = semisMatch[1] ?? '';
      const fulls = Number(semisMatch[2] ?? 0);
      const semis = Number(semisMatch[3] ?? 0);
      const coords = parseCoordPairs(semisMatch[4] ?? '');
      if (fulls + semis !== coords.length) {
        throw new Error(
          `Linha de origem divergente para "${playerName}": ${playerName};${fulls} fulls;${semis} semis;${coords.length} coords — a soma ${fulls}+${semis} deve bater com ${coords.length}.`,
        );
      }
      // FULL/SEMI: as PRIMEIRAS `fulls` coords são tier 'full'; as seguintes, 'semi'.
      const semiOrigins = coords.slice(fulls);
      players.push({ playerName, fulls, semis, origins: coords, semiOrigins });
      continue;
    }
    const legacyMatch = LINE_LEGACY.exec(trimmed);
    if (legacyMatch === null) {
      throw new Error(
        `Linha de origem inválida (use "nick;fulls;coord coord" ou "nick;fulls;semis;coord coord"): "${trimmed.slice(0, 60)}"`,
      );
    }
    // Legado: SEM as chaves novas — default semis=0 / semiOrigins=[] na leitura e
    // round-trip exato com originsFromSnapshot ("nick;fulls;coords").
    players.push({
      playerName: legacyMatch[1] ?? '',
      fulls: Number(legacyMatch[2] ?? 0),
      origins: parseCoordPairs(legacyMatch[3] ?? ''),
    });
  }
  if (players.length === 0) {
    throw new Error('Nenhuma origem informada — cole as linhas "nick;fulls;coords de origem".');
  }
  return players;
}

/** Contadores agregados das INFORMAÇÕES ORIGEM (espelha o contador FULL/SEMI do SG_2). */
export function originsSummary(origins: OriginPlayer[]): { players: number; fulls: number; semis: number; villages: number } {
  let fulls = 0;
  let semis = 0;
  let villages = 0;
  for (const player of origins) {
    fulls += player.fulls;
    semis += player.semis ?? 0;
    villages += player.origins.length;
  }
  return { players: origins.length, fulls, semis, villages };
}

export interface TargetLine {
  /** Faixa de fulls da linha (0–200 = todos). */
  fullsFrom: number;
  fullsTo: number;
  /** Faixa de semis do JOGADOR (ausentes = 0–200 = todos). */
  semisFrom?: number;
  semisTo?: number;
  targets: { x: number; y: number; points?: number }[];
}

/** Moral TW do jogo (POR PONTOS): moral = (def/att × 3 + 0,3) × 100, teto 100.
 * Confirmada por membro da staff contra o jogo (1M atacando 100k → 60%).
 * A constante 0,3 dá o piso implícito de ~30 — a própria fórmula nunca desce abaixo disso. */
export function moraleOf(attackerPoints: number, defenderPoints: number): number {
  // Sem pontos (bárbaros/dados ausentes) não há penalidade de moral.
  if (attackerPoints <= 0 || defenderPoints <= 0) return 100;
  return Math.min(100, Math.round((defenderPoints / attackerPoints * 3 + 0.3) * 100));
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
  matrix: { origin: string; player: string; tier: 'full' | 'semi'; cells: PlanCell[] }[];
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
/**
 * Distribui cada ORIGEM (NT estacionado) a um ALVO elegível: faixa de fulls e de
 * semis do JOGADOR na linha do alvo, moral mínimo, distância máxima; alvo consumido
 * por 1 atacante. "Obter Planificação" = matrix; "Realizar Distribuição" = assignments.
 */
export function distributeTargets(input: DistributionInput): DistributionResult {
  const lineTargets: { x: number; y: number; fullsFrom: number; fullsTo: number; semisFrom: number; semisTo: number; points?: number }[] =
    [];
  // Alvo em DUAS linhas diferentes = 2 atacantes no mesmo alvo (usedTargets é
  // por índice) — NT desperdiçado e órfão inexplicável. Fail-closed citando
  // a coordenada e as faixas das linhas conflitantes.
  const seenTargets = new Map<string, string>();
  for (const line of input.lines) {
    for (const target of line.targets) {
      const key = target.x + "|" + target.y;
      const previousLine = seenTargets.get(key);
      if (previousLine !== undefined) {
        throw new Error(
          "Alvo repetido em duas linhas: " + key + " (linhas com fulls " + previousLine + " e " + line.fullsFrom + "-" + line.fullsTo + "). Mantenha cada alvo em UMA linha apenas."
        );
      }
      seenTargets.set(key, line.fullsFrom + "-" + line.fullsTo);
      // Faixas de semis ausentes = 0–200 (todos).
      lineTargets.push({
        ...target,
        fullsFrom: line.fullsFrom,
        fullsTo: line.fullsTo,
        semisFrom: line.semisFrom ?? 0,
        semisTo: line.semisTo ?? 200,
      });
    }
  }

  const flatOrigins: { playerName: string; fulls: number; semis: number; origin: { x: number; y: number }; tier: 'full' | 'semi' }[] = [];
  for (const player of input.origins) {
    const semis = player.semis ?? 0;
    const semiCount = player.semiOrigins?.length ?? 0;
    if (semis !== semiCount) {
      throw new Error(
        `Origens inconsistentes para "${player.playerName}": ${semis} semis declarados, mas ${semiCount} coordenadas semi — corrija as INFORMAÇÕES ORIGEM.`,
      );
    }
    const semiSet = new Set((player.semiOrigins ?? []).map((coord) => `${coord.x}|${coord.y}`));
    const seenOrigins = new Set<string>();
    for (const origin of player.origins) {
      // Mesma coord repetida para o MESMO jogador = 2 NTs na mesma vila (o
      // input estruturado vem da UI/SG2, que pode duplicar num refetch).
      const key = `${origin.x}|${origin.y}`;
      if (seenOrigins.has(key)) {
        throw new Error(`Coordenada de origem repetida para "${player.playerName}": ${key} — um NT não ataca dois alvos.`);
      }
      seenOrigins.add(key);
      flatOrigins.push({
        playerName: player.playerName,
        fulls: player.fulls,
        semis,
        origin,
        tier: semiSet.has(`${origin.x}|${origin.y}`) ? 'semi' : 'full',
      });
    }
  }

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

  // Planilha: horas/moral de cada origem×alvo (para o heatmap). Tier da linha de
  // origem = 'semi' quando a coord ∈ semiOrigins do jogador; senão 'full'.
  const matrix = flatOrigins.map((entry) => ({
    origin: `${entry.origin.x}|${entry.origin.y}`,
    player: entry.playerName,
    tier: entry.tier,
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
        // Semis do JOGADOR fora da faixa da linha → inelegível (0–200 quando ausente).
        if (entry.semis < target.semisFrom || entry.semis > target.semisTo) return false;
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
