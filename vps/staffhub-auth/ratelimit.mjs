// staffhub-auth — rate-limit de login (janela deslizante sobre login_attempts).
// Falhas por IP (visão de rede) e por nick (lockout direcionado). Não usa
// memória: a tabela é a fonte de verdade (sobrevive a restart).
import { q } from './db.mjs';
import { config } from './config.mjs';

export function podeTentar(ip, nick) {
  const janela = Date.now() - config.loginJanelaMs;
  const porIp = q.falhasIp.get(ip ?? '?', janela);
  const porNick = q.falhasNick.get(String(nick ?? '').toLowerCase(), janela);
  if ((porIp?.n ?? 0) >= config.loginMaxFalhasIp) {
    return { ok: false, motivo: 'Muitas tentativas deste endereço — aguarde alguns minutos e tente de novo.' };
  }
  if ((porNick?.n ?? 0) >= config.loginMaxFalhasNick) {
    return { ok: false, motivo: 'Conta temporariamente bloqueada por tentativas erradas — aguarde alguns minutos.' };
  }
  return { ok: true };
}

export function registrarFalha(ip, nick) {
  q.registrarFalha.run(ip ?? '?', String(nick ?? '').toLowerCase(), Date.now());
}
