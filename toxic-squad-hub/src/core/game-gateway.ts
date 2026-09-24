// Gateway de API do jogo (v3.6.0) — a ÚNICA forma correta de chamar
// `TribalWars.post`. Lido no BR142 em 24/09/2026 (código do próprio jogo):
//
//   TribalWars.post(screen, params, data, onSuccess, onError, noLoading)
//     params: OBJETO de URL — { ajaxaction: 'send_squads' } (buildURL faz
//             $.param; texto vira "&0=s&1=e…" e a ação NUNCA chega)
//     data:   corpo do POST (objeto; o csrf `h` é colocado pelo próprio jogo)
//     retorno: NENHUM (void) — o resultado vem pelos callbacks:
//       onSuccess(response)       → resposta do servidor
//       onError("mensagem")       → recusa do jogo (erro de regra) — nada aconteceu
//       onError()  (sem argumento) → desafio anti-bot exibido (BotProtect)
//       onError(xhr)              → falha de rede/HTTP — inconclusivo
//
// Antes, o script chamava post(screen, 'ação', URLSearchParams).then(...):
// a ação se perdia e o `.then` sobre `undefined` virava "inconclusivo" em
// TODA chamada (coleta, mercado).

import { tripHalt } from './halt';
import { pageWindow } from './page';

/** Por que não deu certo: só 'indisponivel' permite plano B pela tela (nada saiu). */
export type GatewayFailure = 'recusado' | 'anti-bot' | 'rede' | 'tempo' | 'indisponivel' | 'lancou';

export type GatewayResult =
  | { ok: true; response: unknown }
  | { ok: false; error: string; afterMutation: boolean; code: GatewayFailure; botProtect?: boolean };

/** Converte o que o onError recebe no nosso resultado (puro/testável). */
export function classifyGatewayError(reason: unknown): Extract<GatewayResult, { ok: false }> {
  if (reason === undefined) {
    return { ok: false, error: 'O jogo exibiu o desafio anti-bot — nada foi feito. Resolva na janela do jogo.', afterMutation: false, code: 'anti-bot', botProtect: true };
  }
  if (typeof reason === 'string') {
    const text = reason.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return { ok: false, error: text === '' ? 'O jogo recusou a operação.' : text, afterMutation: false, code: 'recusado' };
  }
  return { ok: false, error: 'Falha de rede ao falar com o jogo — o resultado é incerto.', afterMutation: true, code: 'rede' };
}

/**
 * Chama uma ação AJAX do jogo pelo gateway da página. Nunca lança: devolve
 * sucesso, recusa (com a mensagem do jogo) ou incerteza. Desafio anti-bot
 * abre o disjuntor. `timeoutMs` depois do envio = incerto (pode ter chegado).
 */
export function callGameAction(
  screen: string,
  action: string,
  data: Record<string, string>,
  timeoutMs = 8_000,
  opts?: { village?: string; params?: Record<string, string> },
): Promise<GatewayResult> {
  return new Promise<GatewayResult>((resolve) => {
    const gateway = pageWindow().TribalWars;
    const post = gateway?.post;
    if (typeof post !== 'function') {
      resolve({ ok: false, error: 'O gateway do jogo (TribalWars.post) não está disponível nesta página.', afterMutation: false, code: 'indisponivel' });
      return;
    }
    let settled = false;
    const settle = (result: GatewayResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!result.ok && result.botProtect === true) tripHalt('captcha', result.error);
      resolve(result);
    };
    const timer = setTimeout(
      () => settle({ ok: false, error: 'Tempo esgotado aguardando o jogo — o resultado é incerto.', afterMutation: true, code: 'tempo' }),
      timeoutMs,
    );
    // Aldeia da URL: o buildURL do jogo usa params.village (e o tira dos
    // params) — é assim que a própria tela do Mercado diz de onde sai o envio.
    const params: Record<string, string> = { ...(opts?.params ?? {}), ajaxaction: action };
    if (opts?.village !== undefined && opts.village !== '') params.village = opts.village;
    try {
      post.call(
        gateway,
        screen,
        params,
        data,
        (response) => settle({ ok: true, response }),
        (reason) => {
          // Desafio anti-bot que chega DEPOIS do tempo esgotado ainda pausa o script.
          if (reason === undefined && settled) tripHalt('captcha', classifyGatewayError(undefined).error);
          settle(classifyGatewayError(reason));
        },
        true,
      );
    } catch (error) {
      // Lançou ANTES de despachar (validação local do jogo): nada saiu.
      settle({ ok: false, error: error instanceof Error ? error.message : 'Falha ao chamar o jogo.', afterMutation: false, code: 'lancou' });
    }
  });
}
