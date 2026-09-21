// staffhub-auth — banco SQLite (node:sqlite, WAL) + prepared statements.
// Toda query é PARAMETRIZADA (sem concatenação de string, nunca).
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.mjs';

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 3000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  nick TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','staff')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','banned')),
  criado_em TEXT NOT NULL,
  aprovado_em TEXT
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  familia TEXT NOT NULL,
  expira_em INTEGER NOT NULL,
  revogado INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  nick TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_ts ON login_attempts(ts);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  ator TEXT NOT NULL,
  evento TEXT NOT NULL,
  detalhe TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS license_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  owner_nick TEXT NOT NULL COLLATE NOCASE,
  bound_player TEXT,
  tier TEXT NOT NULL DEFAULT 'staff' CHECK (tier IN ('staff','lider')),
  expires_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  criado_em TEXT NOT NULL,
  last_used_at TEXT,
  last_ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_keys_owner ON license_keys(owner_nick);
`);

const nowIso = () => new Date().toISOString();

export const q = {
  userPorNick: db.prepare('SELECT * FROM users WHERE nick = ? COLLATE NOCASE'),
  userPorId: db.prepare('SELECT * FROM users WHERE id = ?'),
  inserirUser: db.prepare(
    'INSERT INTO users (id, nick, senha_hash, salt, role, status, criado_em) VALUES (?,?,?,?,?,?,?)',
  ),
  atualizarSenha: db.prepare('UPDATE users SET senha_hash = ?, salt = ? WHERE id = ?'),
  contarUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  listarUsers: db.prepare(
    'SELECT id, nick, role, status, criado_em, aprovado_em FROM users ORDER BY criado_em DESC',
  ),
  setStatus: db.prepare('UPDATE users SET status = ?, aprovado_em = ? WHERE id = ?'),
  promoverAdmin: db.prepare("UPDATE users SET role = 'admin', status = 'active', aprovado_em = ? WHERE id = ?"),

  refreshPorHash: db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?'),
  refreshAtivoDoUser: db.prepare(
    'SELECT * FROM refresh_tokens WHERE user_id = ? AND revogado = 0 AND expira_em > ? LIMIT 1',
  ),
  inserirRefresh: db.prepare(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, familia, expira_em, revogado, criado_em) VALUES (?,?,?,?,?,0,?)',
  ),
  revogarTodosDoUser: db.prepare('UPDATE refresh_tokens SET revogado = 1 WHERE user_id = ?'),
  revogarFamilia: db.prepare('UPDATE refresh_tokens SET revogado = 1 WHERE familia = ?'),

  registrarFalha: db.prepare('INSERT INTO login_attempts (ip, nick, ts) VALUES (?,?,?)'),
  falhasIp: db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ts > ?'),
  falhasNick: db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE nick = ? AND ts > ?'),
  // REVISÃO 0.30.1: housekeeping — a tabela só precisa da janela do rate-limit.
  podarAttempts: db.prepare('DELETE FROM login_attempts WHERE ts < ?'),
  expiraFamiliaPorUser: db.prepare(
    'SELECT MAX(expira_em) AS ate FROM refresh_tokens WHERE user_id = ? AND revogado = 0',
  ),

  audit: db.prepare('INSERT INTO audit (ts, ator, evento, detalhe) VALUES (?,?,?,?)'),
  listarAudit: db.prepare('SELECT ts, ator, evento, detalhe FROM audit ORDER BY id DESC LIMIT 200'),

  // Chaves in-game: a chave em claro NUNCA é gravada — só o hash (keys.mjs).
  // A listagem NUNCA devolve key_hash e já sai com alias camelCase (contrato
  // do Electron/AdminKeyRow — mesmo padrão de coluna do listarUsers seria
  // snake_case e já deixou o Admin lendo campo errado).
  chaveInserir: db.prepare(
    'INSERT INTO license_keys (id, key_hash, key_prefix, owner_nick, tier, expires_at, created_by, criado_em) VALUES (?,?,?,?,?,?,?,?)',
  ),
  chaveListar: db.prepare(
    `SELECT id, key_prefix AS keyPrefix, owner_nick AS ownerNick, bound_player AS boundPlayer,
            tier, expires_at AS expiresAt, revoked, criado_em AS criadoEm, last_used_at AS lastUsedAt
     FROM license_keys ORDER BY criado_em DESC`,
  ),
  chavePorId: db.prepare('SELECT * FROM license_keys WHERE id = ?'),
  chavePorHash: db.prepare('SELECT * FROM license_keys WHERE key_hash = ?'),
  chaveRevogar: db.prepare('UPDATE license_keys SET revoked = 1 WHERE id = ?'),
  chaveTouch: db.prepare('UPDATE license_keys SET last_used_at = ?, last_ip = ? WHERE id = ?'),
  chaveVincular: db.prepare('UPDATE license_keys SET bound_player = ? WHERE id = ?'),
};

export const audit = (ator, evento, detalhe = '') => {
  q.audit.run(nowIso(), ator, evento, detalhe);
};

export { nowIso };
