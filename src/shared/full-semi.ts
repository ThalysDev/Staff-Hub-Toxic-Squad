// Contador FULL/SEMI por jogador a partir de um snapshot de tropas (SG_2).
//
// Classificação por POPULAÇÃO OFENSIVA da aldeia (= Σ unidades × população da
// unidade): "full" quando ≥ fullPop; "semi" quando ≥ semiPop e < fullPop.
// A população POR UNIDADE é INJETADA pelo caller (vem do unit-info do mundo) —
// aqui NUNCA se hardcoda população, porque varia entre mundos/eras do jogo.
//
// Puro e determinístico; abaixo dos dois limiares a aldeia não conta como
// nem full nem semi (e jogador sem nenhuma delas não aparece no resultado).

export interface FullSemiEntry {
  playerName: string;
  coord: { x: number; y: number };
  units: Record<string, number>;
}

export interface FullSemiInput {
  entries: FullSemiEntry[];
  /** População mínima para a aldeia contar como FULL (do unit-info do mundo). */
  fullPop: number;
  /** População mínima para contar como SEMI (deve ser < fullPop). */
  semiPop: number;
  /** População por unidade — injetada pelo caller; unidade ausente = não somada. */
  popByUnit: Record<string, number>;
}

export interface PlayerFullSemi {
  playerName: string;
  fulls: number;
  semis: number;
  /** Coordenadas "x|y": aldeias FULL primeiro, depois as SEMI (ordem do snapshot). */
  coords: string[];
}

export interface FullSemiResult {
  players: PlayerFullSemi[];
  /** Unidades presentes nas tropas mas sem população em popByUnit (contam 0) — avisar o caller. */
  unknownUnits: string[];
}

/** População ofensiva de uma aldeia pela tabela injetada; desconhecida = 0. */
function offensivePop(units: Record<string, number>, popByUnit: Record<string, number>): number {
  let total = 0;
  for (const [unit, count] of Object.entries(units)) {
    const unitPop = popByUnit[unit];
    if (unitPop === undefined) continue;
    total += (count ?? 0) * unitPop;
  }
  return total;
}

export function fullSemiByPlayer(input: FullSemiInput): FullSemiResult {
  const { fullPop, semiPop, popByUnit } = input;
  if (!Number.isInteger(fullPop) || fullPop <= 0) {
    throw new Error(`População de FULL inválida (use um inteiro maior que 0): ${String(fullPop)}.`);
  }
  if (!Number.isInteger(semiPop) || semiPop <= 0) {
    throw new Error(`População de SEMI inválida (use um inteiro maior que 0): ${String(semiPop)}.`);
  }
  if (semiPop >= fullPop) {
    throw new Error(`População de SEMI (${semiPop}) deve ser MENOR que a de FULL (${fullPop}).`);
  }

  const unknown = new Set<string>();
  const byPlayer = new Map<string, { fulls: string[]; semis: string[] }>();
  for (const entry of input.entries) {
    for (const unit of Object.keys(entry.units)) {
      if (popByUnit[unit] === undefined) unknown.add(unit);
    }
    const pop = offensivePop(entry.units, popByUnit);
    if (pop < semiPop) continue; // abaixo de ambos os limiares: não é nem full nem semi
    const player = byPlayer.get(entry.playerName) ?? { fulls: [], semis: [] };
    const coord = `${entry.coord.x}|${entry.coord.y}`;
    if (pop >= fullPop) player.fulls.push(coord);
    else player.semis.push(coord);
    byPlayer.set(entry.playerName, player);
  }

  // Ordena por nº de fulls desc, depois semis desc, depois nick (PT-BR).
  const players = [...byPlayer.entries()]
    .map(([playerName, tally]) => ({
      playerName,
      fulls: tally.fulls.length,
      semis: tally.semis.length,
      coords: [...tally.fulls, ...tally.semis],
    }))
    .sort(
      (a, b) => b.fulls - a.fulls || b.semis - a.semis || a.playerName.localeCompare(b.playerName, 'pt-BR'),
    );

  return { players, unknownUnits: [...unknown].sort((a, b) => a.localeCompare(b, 'pt-BR')) };
}

/** Resumo amigável ao copia-e-cola: uma linha por jogador — "nick;fulls;semis;coords". */
export function formatFullSemi(players: PlayerFullSemi[]): string {
  return players.map((p) => `${p.playerName};${p.fulls};${p.semis};${p.coords.join(' ')}`).join('\n');
}
