// Rede do userscript — as regras de segurança do projeto irmão, adaptadas:
// - GET de jogo: MESMO ORIGEM, serialized (≥200ms entre chamadas), cache 60s
//   por URL, credentials same-origin (o cookie do jogo faz a autenticação).
// - Detect-pause: corpo de login/captcha NUNCA é processado — lança sentinela.
// - Mutações: SOMENTE via TribalWars.post (gateway do jogo, com csrf dele) e
//   nunca com retry automático.
// - DUAS cadeias seriais (P1-3 da revisão): a NORMAL (leituras/rotina) e a
//   URGENTE (precisão: submit de comando e cancelamento cronometrado). A
//   urgente NUNCA espera a normal — um GET pendurado não pode atrasar um
//   cravado em segundos; cada cadeia mantém o gap de ≥200ms dentro de si.

import { assertNotHalted, tripHalt } from './halt';

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

const cache = new Map<string, { at: number; body: string }>();
/**
 * Teto do cache (Onda 1): sem limite, cada URL única (info_village&id=N,
 * info_command&id=N, overview com page=-1 de vários MB) ficava para sempre —
 * na Sentinela, que não recarrega, a memória crescia por dias.
 */
const CACHE_MAX_ENTRIES = 40;

function cachePut(url: string, body: string): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
  }
  cache.delete(url); // reinsere no fim (mais recente)
  cache.set(url, { at: now, body });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fila serial pura: uma operação por vez, ≥`gapMs` entre os INÍCIOS. */
export interface SerialQueue {
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Cria uma cadeia serial independente (P1-3 da revisão): cada elo espera o
 * anterior e o gap é medido do INÍCIO da chamada anterior (operação longa já
 * cobre o intervalo; a primeira de um contexto novo não espera). Um erro em um
 * elo nunca derruba a cadeia. Pura de propósito: testável sem DOM/rede.
 */
export function createSerialQueue(gapMs: number): SerialQueue {
  let lastRequestAt = 0;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(operation: () => Promise<T>): Promise<T> {
      const next = chain.then(async () => {
        const wait = Math.max(0, gapMs - (Date.now() - lastRequestAt));
        if (wait > 0) await sleep(wait);
        lastRequestAt = Date.now();
        return operation();
      });
      chain = next.catch(() => undefined); // a cadeia nunca morre por erro de um elo
      return next as Promise<T>;
    },
  };
}

const normalQueue = createSerialQueue(MIN_GAP_MS);
const urgentQueue = createSerialQueue(MIN_GAP_MS);

/**
 * Fila NORMAL: leituras (pacedGet) e mutações de rotina — uma por vez, ≥200ms
 * entre elas. Pode ficar pendurada num GET lento sem afetar a urgente.
 */
export function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  // Disjuntor (Onda 1): conferido na HORA de rodar — pedidos já na fila
  // também param quando o captcha aparece no meio.
  return normalQueue.enqueue(() => {
    assertNotHalted();
    return operation();
  });
}

/**
 * Fila URGENTE (P1-3): faixa de PRECISÃO — submit de comando (os 2 passos) e
 * POSTs do cancelamento cronometrado. Cadeia PRÓPRIA: nunca espera a normal
 * (um GET pendurado não atrasa um cravado), mas é serializada com o MESMO gap
 * de 200ms entre urgentes — dois cravados não colidem entre si.
 * Trade-off documentado: um POST urgente pode rodar em paralelo a uma LEITURA
 * normal lenta; as mutações seguem uma por vez dentro da urgente (a leitura
 * não muta nada — a alternativa, fila única, é o atraso em segundos que esta
 * fila corrige).
 */
export function enqueueUrgent<T>(operation: () => Promise<T>): Promise<T> {
  return urgentQueue.enqueue(() => {
    assertNotHalted();
    return operation();
  });
}

/** Detecta página de login/captcha no corpo (mesmos sentinelas do hub). */
function assertGameBody(body: string): void {
  const head = body.slice(0, 4000).toLowerCase();
  if (head.includes('name="password"') || head.includes('id="login"')) {
    tripHalt('sessao', 'Uma leitura do jogo devolveu a tela de login.');
    throw new SessionRequiredError();
  }
  // Só MARCA estrutural (id/classe/src com captcha): a palavra solta no
  // topo da página pode ser o nome da aldeia no <title> (revisão Onda 1).
  if (/\b(?:id|class|src)\s*=\s*["'][^"']*(?:captcha|bot_check|botprotection)/.test(head)) {
    tripHalt('captcha', 'Uma leitura do jogo devolveu o desafio anti-bot.');
    throw new CaptchaDetectedError();
  }
}

/**
 * GET same-origin com pacing + cache. Devolve o corpo como texto.
 * `path` relativo ao host do mundo atual (ex.: '/game.php?screen=info_village&id=1').
 * Timeout de 30s por requisição (P3 revisão Onda 6): um GET pendurado não
 * pode travar a fila serializada inteira.
 */
const GET_TIMEOUT_MS = 30_000;

export async function pacedGet(path: string, opts?: { fresh?: boolean }): Promise<string> {
  const url = new URL(path, window.location.origin).toString();
  const hit = cache.get(url);
  if (hit !== undefined && !opts?.fresh && Date.now() - hit.at < CACHE_TTL_MS) return hit.body;
  return enqueue(async () => {
    const freshHit = cache.get(url);
    if (freshHit !== undefined && !opts?.fresh && Date.now() - freshHit.at < CACHE_TTL_MS) return freshHit.body;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), GET_TIMEOUT_MS);
    let body: string;
    try {
      const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
      body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status} em ${path}`);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Tempo esgotado (30s) em ${path} — a fila de rede segue com a próxima chamada.`);
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
    assertGameBody(body);
    cachePut(url, body);
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

