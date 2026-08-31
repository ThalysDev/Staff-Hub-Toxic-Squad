// staffhub-auth — primitivas de senha e token (node:crypto puro).
// Senha: scrypt N=2^15 (OWASP) + salt aleatório + timingSafeEqual.
// Access: JWT HS256 curto. Refresh: token aleatório 256 bits; no banco só o SHA-256.
import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { config } from './config.mjs';

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

/** Gera salt+hash hexadecimais da senha (usado no cadastro/troca/reset). */
export function hashSenha(senha) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(senha), salt, 64, SCRYPT);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

/** Comparação em tempo constante; qualquer erro = false (nunca lança). */
export function verificarSenha(senha, saltHex, hashHex) {
  try {
    const calculado = scryptSync(String(senha), Buffer.from(saltHex, 'hex'), 64, SCRYPT);
    const esperado = Buffer.from(hashHex, 'hex');
    return calculado.length === esperado.length && timingSafeEqual(calculado, esperado);
  } catch {
    return false;
  }
}

// ---- JWT HS256 (implementação mínima, sem dependências) ----

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const deB64url = (text) => Buffer.from(text, 'base64url');

export function assinarAccess(user, agoraMs = Date.now()) {
  const exp = agoraMs + config.accessTtlMin * 60_000;
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ sub: user.id, nick: user.nick, role: user.role, iat: Math.floor(agoraMs / 1000), exp: Math.floor(exp / 1000) }),
  );
  const assinatura = createHmac('sha256', config.jwtSecret).update(`${header}.${payload}`).digest('base64url');
  return { token: `${header}.${payload}.${assinatura}`, expiraEm: exp };
}

/** Payload verificado (assinatura + expiração) ou null. */
export function verificarAccess(token) {
  if (typeof token !== 'string') return null;
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [header, payload, assinatura] = partes;
  const esperada = createHmac('sha256', config.jwtSecret).update(`${header}.${payload}`).digest('base64url');
  const a = Buffer.from(assinatura ?? '');
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const dados = JSON.parse(deB64url(payload ?? '').toString('utf8'));
    if (typeof dados.exp !== 'number' || dados.exp * 1000 <= Date.now()) return null;
    if (dados.sub === undefined || typeof dados.nick !== 'string') return null;
    return dados;
  } catch {
    return null;
  }
}

// ---- Refresh token (opaco; banco guarda só o hash) ----

/** Novo refresh; a FAMÍLIA é a sessão lógica — herdada na rotação (assim o
 *  reuso de um token antigo mata a cadeia inteira), nova só no login. */
export function novoRefresh(userId, familiaExistente) {
  const token = randomBytes(32).toString('base64url');
  const familia = familiaExistente ?? randomBytes(16).toString('hex');
  return {
    token,
    tokenHash: hashToken(token),
    familia,
    userId,
    expiraEm: Date.now() + config.refreshTtlDias * 24 * 60 * 60_000,
  };
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** Senha temporária legível para o admin repassar (reset). */
export function senhaTemporaria() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(12);
  return [...bytes].map((b) => alfabeto[b % alfabeto.length]).join('');
}
