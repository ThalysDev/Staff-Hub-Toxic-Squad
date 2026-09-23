/**
 * Decisões PURAS do disparo cravado (Onda A — regra de ouro).
 *
 * O envio real de um comando é o CLIQUE na tela de confirmação (passo 2). Para
 * que ele aconteça no ms planejado, o motor:
 *   1. PRÉ-ARMA: abre a tela de confirmação (passo 1, sem mutação) alguns
 *      segundos ANTES do horário — `decidePrearm`;
 *   2. MIRA: na tela de confirmação, espera até `sendAt − compensação de
 *      latência` e só então clica — `decideConfirmAction`.
 *
 * Faixa `precisao` (cravados) NUNCA clica antes da hora nem depois da
 * tolerância de atraso; a faixa `humanizado` (fakes) mantém a carência antiga.
 * Módulo puro (node-safe), sem relógio próprio: o "agora" chega por parâmetro,
 * sempre no relógio do SERVIDOR.
 */

export type FireLane = 'precisao' | 'humanizado';

/** Teto da compensação de latência (ms): acima disto a rede está ruim demais para "cravar". */
export const MAX_LATENCY_COMPENSATION_MS = 400;

/** Carência de atraso da faixa humanizada (a do original: 60s). */
export const HUMANIZED_LATE_GRACE_MS = 60_000;

/**
 * Tempo típico entre o clique no botão e o navegador COLOCAR o pedido na rede
 * (submissão do formulário/início da navegação) — medido no teste ponta a
 * ponta do agendador (7–17ms no Chromium). Somado na compensação automática.
 */
export const BROWSER_DISPATCH_MS = 8;

/** Compensação efetiva: manual (0..teto) ou automática (≈ metade do RTT medido + envio do navegador). */
export function latencyCompensationMs(opts: {
  mode: 'auto' | 'manual';
  manualMs: number;
  rttMedianMs: number | null;
  /** Onda E: compensação APRENDIDA pelas chegadas reais (null = ainda sem amostras). */
  learnedMs?: number | null;
}): number {
  const clamp = (value: number): number =>
    Math.round(Math.min(MAX_LATENCY_COMPENSATION_MS, Math.max(0, Number.isFinite(value) ? value : 0)));
  if (opts.mode === 'manual') return clamp(opts.manualMs);
  if (opts.learnedMs !== undefined && opts.learnedMs !== null && Number.isFinite(opts.learnedMs)) return clamp(opts.learnedMs);
  if (opts.rttMedianMs === null || !Number.isFinite(opts.rttMedianMs)) return BROWSER_DISPATCH_MS;
  return clamp(opts.rttMedianMs / 2 + BROWSER_DISPATCH_MS);
}

export type PrearmDecision =
  | { readonly kind: 'wait'; readonly inMs: number }
  | { readonly kind: 'prearm-now' };

/**
 * Quando abrir a tela de confirmação: `prearmLeadMs` antes do envio (ou já,
 * se o horário está mais perto que isso — inclusive vencido/forçado).
 */
export function decidePrearm(opts: { sendAtMs: number; nowServerMs: number; prearmLeadMs: number }): PrearmDecision {
  const opensAt = opts.sendAtMs - Math.max(0, opts.prearmLeadMs);
  const inMs = opensAt - opts.nowServerMs;
  return inMs > 0 ? { kind: 'wait', inMs } : { kind: 'prearm-now' };
}

export type ConfirmDecision =
  | { readonly kind: 'aim'; readonly waitMs: number; readonly fireAtMs: number }
  | { readonly kind: 'fire'; readonly lateMs: number }
  | { readonly kind: 'late'; readonly lateMs: number };

/**
 * Na tela de confirmação: mirar (esperar), clicar já, ou declarar a janela
 * perdida (cravado atrasado além da tolerância NUNCA sai — seria outro
 * comando). `forced` aceita qualquer atraso (risco assumido ao agendar).
 */
export function decideConfirmAction(opts: {
  sendAtMs: number;
  nowServerMs: number;
  compensationMs: number;
  allowLateMs: number;
  forced: boolean;
  lane: FireLane;
}): ConfirmDecision {
  const fireAtMs = opts.sendAtMs - Math.max(0, opts.compensationMs);
  if (opts.nowServerMs < fireAtMs) return { kind: 'aim', waitMs: fireAtMs - opts.nowServerMs, fireAtMs };
  const lateMs = opts.nowServerMs - opts.sendAtMs;
  if (opts.forced) return { kind: 'fire', lateMs };
  const tolerance = opts.lane === 'precisao' ? opts.allowLateMs : opts.allowLateMs + HUMANIZED_LATE_GRACE_MS;
  return lateMs <= tolerance ? { kind: 'fire', lateMs } : { kind: 'late', lateMs };
}

/**
 * Quanto do fim da espera é feito em "espera ativa" (laço no relógio
 * monotônico): o timer do navegador tem jitter de ms na aba visível e é
 * alinhado a ~1s numa aba em 2º plano.
 */
export function spinBudgetMs(hidden: boolean): number {
  return hidden ? 1_100 : 25;
}

/** Máximo de tentativas de pré-armar o mesmo comando (tela que não abre = tropas/alvo inválidos). */
export const MAX_PREARM_ATTEMPTS = 2;

/** Prefixo do evento 'janela' gravado ao pré-armar (reconhece tentativas anteriores). */
export const PREARM_EVENT_DETAIL = 'Tela de confirmação pré-aberta';

/** Tentativas de pré-arme já registradas nos eventos do comando. */
export function prearmAttempts(events: readonly { status: string; detail?: string }[]): number {
  return events.filter((event) => event.status === 'janela' && (event.detail ?? '').startsWith(PREARM_EVENT_DETAIL))
    .length;
}

/**
 * Duração da viagem arredondada ao SEGUNDO (o jogo trabalha com segundos
 * inteiros): sem isso um cravado por chegada erra até ±500ms.
 */
export function travelDurationMs(travelMinutes: number): number {
  if (!Number.isFinite(travelMinutes) || travelMinutes <= 0) return 0;
  return Math.round(travelMinutes * 60) * 1000;
}

/** "HH:MM:SS.mmm" de um epoch no relógio de parede do quadro (getters locais). */
export function clockLabelMs(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '?';
  const date = new Date(epochMs);
  const p = (n: number, size = 2): string => String(n).padStart(size, '0');
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.${p(date.getMilliseconds(), 3)}`;
}
