// Acesso às globais da PÁGINA do jogo a partir do sandbox do Tampermonkey.
// Com @grant GM_* o TM roda o script num escopo isolado e o `window` do
// sandbox NÃO enxerga game_data/TribalWars. `unsafeWindow` atravessa esse muro
// (declaração em src/globals.d.ts).

export interface GameData {
  player?: { name?: string; id?: number };
  world?: string;
  village?: { id?: number | string };
  readonly [key: string]: unknown;
}

export interface TribalWarsGateway {
  post?: (screen: string, action: string, payload: URLSearchParams | FormData) => Promise<unknown>;
}

export interface PageWindow {
  readonly game_data?: GameData;
  readonly TribalWars?: TribalWarsGateway;
}

/** Janela da PÁGINA (unsafeWindow no sandbox; window como fallback seguro). */
export function pageWindow(): PageWindow {
  const pw: unknown = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  return pw as PageWindow;
}

/** Parte PURA (testável em node): game_data bruto → contexto do jogo. */
export function gameContextFrom(data: GameData | undefined): { player: string; world: string; villageId: string } {
  return {
    player: data?.player?.name || '—',
    world: data?.world ?? '—',
    villageId: String(data?.village?.id ?? '—'),
  };
}
