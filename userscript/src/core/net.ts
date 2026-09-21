// Rede do userscript — as regras de segurança do projeto irmão, adaptadas:
// - GET de jogo: MESMO ORIGEM, serialized (≥200ms entre chamadas), cache 60s
//   por URL, credentials same-origin (o cookie do jogo faz a autenticação).
// - Detect-pause: corpo de login/captcha NUNCA é processado — lança sentinela.
// - Mutações: SOMENTE via TribalWars.post (gateway do jogo, com csrf dele) e
//   nunca com retry automático.

import { pageWindow } from './page';

export class CaptchaDetectedError extends Error {
  constructor() {
    super('Captcha detectado — resolva na janela do jogo e tente de novo.');
    this.name = 'CaptchaDetectedError';
  }
}

export class SessionRequiredError extends Error {
  constructor() {
    super('Sessão do jogo expirada — faça login novamente.');
    this.name = 'SessionRequiredError';
  }
}

const MIN_GAP_MS = 200;
const CACHE_TTL_MS = 60_000;

let lastRequestAt = 0;
let chain: Promise<unknown> = Promise.resolve();

const cache = new Map<string, { at: number; body: string }>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serializa qualquer operação de rede: uma por vez, ≥200ms entre elas. */
export function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const next = chain.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastRequestAt));
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return operation();
  });
  chain = next.catch(() => undefined); // a cadeia nunca morre por erro de um elo
  return next as Promise<T>;
}

/** Detecta página de login/captcha no corpo (mesmos sentinelas do hub). */
function assertGameBody(body: string): void {
  const head = body.slice(0, 4000).toLowerCase();
  if (head.includes('name="password"') || head.includes('id="login"')) {
    throw new SessionRequiredError();
  }
  if (head.includes('captcha')) {
    throw new CaptchaDetectedError();
  }
}

/**
 * GET same-origin com pacing + cache. Devolve o corpo como texto.
 * `path` relativo ao host do mundo atual (ex.: '/game.php?screen=info_village&id=1').
 */
export async function pacedGet(path: string, opts?: { fresh?: boolean }): Promise<string> {
  const url = new URL(path, window.location.origin).toString();
  const hit = cache.get(url);
  if (hit !== undefined && !opts?.fresh && Date.now() - hit.at < CACHE_TTL_MS) return hit.body;
  return enqueue(async () => {
    const freshHit = cache.get(url);
    if (freshHit !== undefined && !opts?.fresh && Date.now() - freshHit.at < CACHE_TTL_MS) return freshHit.body;
    const response = await fetch(url, { credentials: 'same-origin' });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} em ${path}`);
    assertGameBody(body);
    cache.set(url, { at: Date.now(), body });
    return body;
  });
}

/** CSRF token do jogo (input h do documento). */
export function csrfToken(): string {
  const input = document.querySelector<HTMLInputElement>('input[name="h"]');
  const value = input?.value;
  if (!value) throw new Error('Token de segurança (h) não encontrado na página.');
  return value;
}

/**
 * MUTAÇÃO in-game via gateway canônico do jogo (TribalWars.post). 1 tentativa,
 * SEM retry cego. `payload` é FormData-campos; o jogo injeta o csrf.
 */
export async function gamePost(screen: string, action: string, fields: Record<string, string>): Promise<string> {
  const payload = new URLSearchParams({ ...fields, h: csrfToken() });
  return enqueue(async () => {
    const tribalWars = pageWindow().TribalWars;
    if (tribalWars?.post === undefined) {
      throw new Error('Gateway do jogo indisponível (TribalWars.post) — atualize a página.');
    }
    const result = (await tribalWars.post(screen, action, payload)) as { response?: unknown } | undefined;
    const text =
      typeof result === 'object' && result !== null && 'response' in result
        ? String((result as { response: unknown }).response ?? '')
        : '';
    assertGameBody(text);
    return text;
  });
}
