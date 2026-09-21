// staffhub-auth — lógica de LICENSE KEYS do userscript in-game.
// Pura (só node:crypto): SEM banco e SEM config — o servidor injeta o segredo.
// Assim a rota fica fina e a regra é testável sem efeito colateral
// (tests/main/keys-logic.test.ts importa este arquivo direto no vitest).
//
// AVISO DE REDE (documentado por exigência do contrato): hoje o userscript
// valida em http://74.0.5.75/staffhub/api/key/validate — SEM TLS. Um
// intermediário na rede do jogador pode LER a chave em claro e TROCAR a
// resposta (MITM). O ticket HMAC autentica o EMISSOR (quem tem KEY_SECRET),
// não dá confidencialidade. Migrar para https quando o certificado da VPS
// cobrir o host nu — a rota não muda.
import { createHash, createHmac, randomBytes } from 'node:crypto';

// Alfabeto legível — sem I O l i o 0 1 (mesmo critério da senhaTemporaria, auth.mjs).
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/** Chave nova no formato SHS-XXXX-XXXX-XXXX (12 chars legíveis + hífens). */
export function gerarChave() {
  const grupos = [];
  for (let grupo = 0; grupo < 3; grupo += 1) {
    const bytes = randomBytes(4);
    grupos.push([...bytes].map((b) => ALFABETO[b % ALFABETO.length]).join(''));
  }
  return `SHS-${grupos.join('-')}`;
}

/** No banco só entra o SHA-256 hex — a comparação é exata pela string como
 *  o usuário digita (apenas trim). */
export function hashChave(chave) {
  return createHash('sha256').update(String(chave).trim()).digest('hex');
}

/** Prefixo exibível (SHS-XXXX) para listagem e auditoria — nunca a chave toda. */
export function prefixoChave(chave) {
  return String(chave).trim().slice(0, 8);
}

/** Chave pronta para gravar: { chave, hash, prefixo }. A chave em claro volta
 *  UMA única vez (resposta da emissão) — depois só existe o hash. */
export function novaChave() {
  const chave = gerarChave();
  return { chave, hash: hashChave(chave), prefixo: prefixoChave(chave) };
}

/**
 * Decisão fail-closed da validação sobre a linha do banco (ou undefined).
 * Pura: o servidor faz get → decidir → gravar sem await no meio (single-thread,
 * sem janela de corrida na 1ª ativação).
 * Retorna { ok: true, vinculou } — vinculou=true quando ESTA chamada fez a
 * 1ª ativação (bound_player era vazio) — ou { ok: false, motivo } com motivo
 * em 'inexistente' | 'revogada' | 'expirada' | 'vinculada'.
 */
export function decidirValidacao(registro, player, agoraMs = Date.now()) {
  if (registro === undefined || registro === null) return { ok: false, motivo: 'inexistente' };
  if (registro.revoked === 1) return { ok: false, motivo: 'revogada' };
  // expires_at null/undefined = sem prazo; o limite é EXCLUSIVO (<= agora já expirou).
  const expira = registro.expires_at;
  if (typeof expira === 'number' && expira <= agoraMs) return { ok: false, motivo: 'expirada' };
  const dono = registro.bound_player;
  const vinculado = typeof dono === 'string' && dono !== '';
  // Vínculo é EXATO (case-sensitive) — o player da 1ª ativação é o dono da chave.
  if (vinculado && dono !== player) return { ok: false, motivo: 'vinculada' };
  return { ok: true, vinculou: !vinculado };
}

/** Ticket HMAC-SHA256 hex de `${player}|${expiresAt}` — prova de emissão do
 *  servidor; o userscript guarda. O segredo vem de config.keySecret (injetado). */
export function ticketDe(player, expiresAt, segredo) {
  return createHmac('sha256', String(segredo)).update(`${player}|${expiresAt}`).digest('hex');
}
