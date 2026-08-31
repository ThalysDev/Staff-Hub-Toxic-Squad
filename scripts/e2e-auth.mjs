// E2E do login do sistema (v0.30): app REAL + API REAL na VPS. Faz login com
// as credenciais da env, valida o resultado e (opcional) mede o gate.
// Uso: SHS_AUTH_NICK=... SHS_AUTH_SENHA=... node scripts/e2e-auth.mjs
// Sem credenciais: valida apenas o estado deslogado (app vivo, sem sessão).
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const arquivo = join(root, 'out', 'e2e-auth-resultado.json');
rmSync(arquivo, { force: true });

const nick = process.env.SHS_AUTH_NICK ?? '';
const senha = process.env.SHS_AUTH_SENHA ?? '';

console.log(`▸ E2E auth: ${nick === '' ? 'sem credenciais (espera deslogado)' : `login de "${nick}"`}`);
execSync('pnpm exec electron .', {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, SHS_AUTH_E2E: arquivo, SHS_AUTH_NICK: nick, SHS_AUTH_SENHA: senha },
  timeout: 60_000,
});

if (!existsSync(arquivo)) {
  console.error('✗ resultado do E2E não foi escrito.');
  process.exit(1);
}
const resultado = JSON.parse(readFileSync(arquivo, 'utf8'));
console.log(JSON.stringify(resultado, null, 2));

if (nick === '') {
  if (resultado.status.estado !== 'deslogado') {
    console.error('✗ esperava deslogado, veio: ' + resultado.status.estado);
    process.exit(1);
  }
  console.log('✓ app vivo e deslogado (gate fechado) — tela de login no lugar.');
  process.exit(0);
}

if (resultado.login.ok !== true) {
  console.error('✗ login falhou: ' + resultado.login.erro);
  process.exit(1);
}
if (resultado.status.estado !== 'logado') {
  console.error('✗ esperava logado, veio: ' + resultado.status.estado);
  process.exit(1);
}
console.log('✓ E2E auth VERDE: login real na VPS + sessão instalada.');
