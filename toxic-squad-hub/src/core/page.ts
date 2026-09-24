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
  /**
   * Assinatura REAL (lida no BR142, 24/09/2026): params é OBJETO
   * ({ ajaxaction }), o resultado vem pelos callbacks e o retorno é void.
   * Use core/game-gateway (callGameAction) — nunca chame direto.
   */
  post?: (
    screen: string,
    params: Record<string, string>,
    data: Record<string, string>,
    onSuccess: (response: unknown) => void,
    onError: (reason?: unknown) => void,
    noLoading?: boolean,
  ) => void;
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

/**
 * Mundo atual para CHAVES de storage — a MESMA regra do motor de automações
 * (subdomínio do hostname: br142.tribalwars.com.br → br142; fallback
 * game_data.world). Onda C: a Início usava game_data.world e o motor o
 * hostname — em mundos com nomes divergentes os números não batiam.
 */
export function currentWorld(): string {
  const sub = window.location.hostname.split('.')[0];
  if (sub !== undefined && sub !== '') return sub;
  return pageWindow().game_data?.world ?? 'mundo';
}
