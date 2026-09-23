// POST de formulário do jogo (Onda 5, Parte A) para telas cujo fluxo NÃO tem
// API interna confirmada (renomear aldeia, ligar a cunhagem automática do
// jogo, usar/abrir item do inventário, educar habilidade do Paladino).
//
// Por que existe: o tsh-transport cobre as ações canaradas (comando, mercado,
// coleta, recrutamento, cunhagem, paladino) e NÃO foi estendido nesta onda —
// as ações novas são postadas aqui, seguindo o mesmo padrão fail-closed:
// - o caminho e os campos vêm do FORM/URL que a PRÓPRIA página do jogo expôs
//   (o parser de cada plugin só aceita o marcador canônico); sem marcador,
//   NADA é postado;
// - TODA rede passa pelo `enqueue` do core (fila serial, ≥200ms entre
//   chamadas) e leva o csrf atual (`h`) — o do form quando houver, o fresco
//   da página quando não houver;
// - mutação = 1 tentativa, SEM retry. Exceção de rede/timeout APÓS o dispatch
//   é INCONCLUSIVA (afterMutation) — o chamador nunca repete às cegas;
// - resposta com captcha/login vira erro claro (detect-pause-notify).
//
// LACUNA REGISTRADA (Onda 5): nenhum destes endpoints foi confirmado contra
// fixture real do br142 — o que dá segurança é o contrato "posta somente o que
// a página expôs" + o status claro quando a página não expõe nada.

import { enqueue } from '../../../core/net';
import { currentCsrf } from '../../vanta/vanta-net';

export interface GameFormPostResult {
  readonly ok: boolean;
  /** Mensagem pt-BR do que aconteceu (sempre preenchida em falha). */
  readonly message: string;
  /** true = o POST pode ter chegado ao jogo; o chamador NUNCA repete às cegas. */
  readonly afterMutation: boolean;
}

/** Ação relativa da página ("game.php?...") vira caminho absoluto do host. */
export function rootedActionPath(action: string): string {
  const trimmed = action.trim();
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) return trimmed;
  return `/${trimmed}`;
}

/** HTML de resposta com sentinela de captcha/login (mesma régua do core/net). */
function challengeMessage(body: string): string | null {
  const head = body.slice(0, 4000).toLowerCase();
  if (head.includes('name="password"') || head.includes('id="login"')) {
    return 'A sessão do jogo precisa ser atualizada manualmente — a ação não foi confirmada.';
  }
  if (head.includes('captcha')) {
    return 'Captcha detectado na resposta do jogo — a automação foi pausada para intervenção manual.';
  }
  return null;
}

/**
 * Posta um form do jogo. `fields` são os campos EXATOS do form (hidden da
 * própria página + o campo da ação); `h` é injetado quando ausente.
 */
export async function postGameForm(
  action: string,
  fields: Record<string, string>,
): Promise<GameFormPostResult> {
  if (action.trim() === '') {
    return { ok: false, message: 'A página não expôs a ação canônica — nada foi enviado.', afterMutation: false };
  }
  let csrf = '';
  try {
    csrf = currentCsrf();
  } catch {
    return {
      ok: false,
      message: 'CSRF do jogo indisponível — recarregue a página antes de tentar de novo.',
      afterMutation: false,
    };
  }
  const payload = new URLSearchParams({ ...fields, h: fields['h'] ?? csrf });
  const path = rootedActionPath(action);
  return enqueue(async () => {
    let response: Response;
    try {
      response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: payload.toString(),
      });
    } catch (error) {
      // Sem resposta: o POST PODE ter chegado (rede caiu depois do envio).
      return {
        ok: false,
        message: `Falha de rede no envio: ${error instanceof Error ? error.message : String(error)} — resultado inconclusivo, releia o jogo antes de repetir.`,
        afterMutation: true,
      };
    }
    // HTTP ≥400 = o servidor respondeu e recusou: nada foi mutado (sem retry).
    if (!response.ok) {
      return {
        ok: false,
        message: `O jogo recusou o envio (HTTP ${response.status}) — nada foi alterado.`,
        afterMutation: false,
      };
    }
    const body = await response.text();
    const challenge = challengeMessage(body);
    if (challenge !== null) {
      return { ok: false, message: challenge, afterMutation: false };
    }
    return { ok: true, message: 'Envio aceito pelo jogo.', afterMutation: false };
  });
}
