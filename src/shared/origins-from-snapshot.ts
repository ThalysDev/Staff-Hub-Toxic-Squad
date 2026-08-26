// Gera o texto "INFORMAÇÕES ORIGEM" do SG_4 ("nick;nroFulls;coordenadas") a partir
// de um snapshot de tropas do SG_2 (por membro). Puro, determinístico e testável.
//
// Regra "full": na ferramenta original, ORIGEM = aldeia onde o trem de nobres (NT)
// está estacionado — cada coordenada de origem = 1 alvo a receber. Uma aldeia do
// próprio membro é "full" quando tem nobre(s) nela: aqui, unidades "snob" do
// snapshot SG_2 >= minSnobs (default 1). "Nro Fulls" = quantas dessas aldeias o
// jogador tem.
//
// ROUND-TRIP GARANTIDO: parseOriginsInput(originsFromSnapshot(x)) recupera exatamente
// nick/fulls/coords — o texto gerado respeita o formato que o parser aceita
// (nick de 2–40 caracteres sem ";"; fulls inteiro = nº de coordenadas da linha;
// coordenadas "x|y" com até 3 dígitos separadas por espaço, uma linha por jogador,
// ordenada por nick alfabético).

import type { TroopSnapshot } from './sg2-engine';

export interface OriginsFromSnapshotOptions {
  /** Aldeia só conta como "full" com este mínimo de nobres (snob); default 1. */
  minSnobs?: number;
}

/** Formato de linha que o parseOriginsInput aceita para nick. */
const NICK_FORMAT = /^[^;]{2,40}$/;
/** Par "x|y" com até 3 dígitos por eixo (formato do parser do SG_4). */
const COORD_FORMAT = /^\d{1,3}\|\d{1,3}$/;

export function originsFromSnapshot(snapshot: TroopSnapshot, options?: OriginsFromSnapshotOptions): string {
  const minimumSnobs = options?.minSnobs ?? 1;

  // Snapshot em modo Resumo vem por JOGADOR, sem aldeias (coord {-1,-1}) — não dá
  // para gerar origens: fail-closed com mensagem clara (mesma detecção do filtro SG_2).
  const isSummary = snapshot.entries.some((entry) => entry.coord.x < 0);
  if (isSummary) {
    throw new Error(
      'O snapshot de tropas está em modo Resumo (sem aldeias) — use a coleta POR MEMBRO para gerar as INFORMAÇÕES ORIGEM.',
    );
  }

  // Agrupa as aldeias "full" por jogador, preservando a ordem delas no snapshot.
  const fullsByPlayer = new Map<number, { playerName: string; coords: string[] }>();
  for (const entry of snapshot.entries) {
    const coord = `${entry.coord.x}|${entry.coord.y}`;
    if (!COORD_FORMAT.test(coord)) {
      throw new Error(`Coordenada fora do formato aceito pelo SG_4 (até 3 dígitos por eixo): "${coord}".`);
    }
    if ((entry.units.snob ?? 0) < minimumSnobs) continue; // sem nobre suficiente: não é "full"
    const player = fullsByPlayer.get(entry.playerId) ?? { playerName: entry.playerName, coords: [] };
    player.coords.push(coord);
    fullsByPlayer.set(entry.playerId, player);
  }

  return [...fullsByPlayer.values()]
    .sort((a, b) => a.playerName.localeCompare(b.playerName, 'pt-BR'))
    .map((player) => {
      if (!NICK_FORMAT.test(player.playerName)) {
        throw new Error(`Nick fora do formato aceito pelo SG_4 (2–40 caracteres, sem ";"): "${player.playerName}".`);
      }
      return `${player.playerName};${player.coords.length};${player.coords.join(' ')}`;
    })
    .join('\n');
}
