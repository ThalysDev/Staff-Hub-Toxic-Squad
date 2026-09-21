// staffhub-auth — configuração. Segredos vivem em auth.env (0600, gerado no
// deploy); NUNCA no código. Valores: JWT_SECRET (obrigatório), KEY_SECRET
// (opcional — tickets de license key; cai p/ JWT_SECRET), PORT (8787),
// DB_PATH, ACCESS_TTL_MIN (15), REFRESH_TTL_DIAS (30).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const envPath = process.env.AUTH_ENV ?? join(HERE, 'auth.env');

const env = new Map();
if (existsSync(envPath)) {
  for (const linha of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = linha.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    env.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
}

export const config = {
  // Prioridade: variável de processo > auth.env > default (o smoke/deploy
  // injetam DB_PATH/PORT por env; segredos ficam só no arquivo 0600).
  port: Number(process.env.AUTH_PORT ?? env.get('PORT') ?? 8787),
  dbPath: process.env.AUTH_DB_PATH ?? env.get('DB_PATH') ?? join(HERE, 'auth.db'),
  jwtSecret: env.get('JWT_SECRET') ?? '',
  // Segredo dos TICKETS de license key in-game (HMAC sobre "player|expiresAt").
  // OPCIONAL: sem KEY_SECRET no auth.env cai para JWT_SECRET (mesmo cofre 0600,
  // mesmo nível de sigilo). Separável depois sem invalidar sessões — só muda a
  // assinatura dos tickets novos.
  keySecret: env.get('KEY_SECRET') ?? env.get('JWT_SECRET') ?? '',
  accessTtlMin: Number(env.get('ACCESS_TTL_MIN') ?? 15),
  refreshTtlDias: Number(env.get('REFRESH_TTL_DIAS') ?? 30),
  // Rate-limit de login: máx de falhas por IP e por nick numa janela deslizante.
  loginMaxFalhasIp: Number(env.get('LOGIN_MAX_FALHAS_IP') ?? 10),
  loginMaxFalhasNick: Number(env.get('LOGIN_MAX_FALHAS_NICK') ?? 5),
  loginJanelaMs: Number(env.get('LOGIN_JANELA_MS') ?? 10 * 60_000),
  lockoutNickMs: Number(env.get('LOCKOUT_NICK_MS') ?? 15 * 60_000),
};

if (config.jwtSecret.length < 32) {
  console.error('[staffhub-auth] FATAL: JWT_SECRET ausente ou curto (<32) em ' + envPath);
  process.exit(1);
}
