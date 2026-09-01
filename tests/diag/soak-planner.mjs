// SOAK de 60s (lição da v0.29.1): app REAL na Sala de Guerra, logado na API
// auth LOCAL, com o rascunho de 2428×183 hidratado — o processo precisa seguir
// VIVO depois de um minuto inteiro (capturas de ~4s não expõem loops/OOM).
// Mata a árvore do Electron por PID no fim (nunca taskkill /IM — pode haver
// outros electrons abertos do usuário).
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const NICK = 'e2e_soak';
const SENHA = 'e2eSoak#01';
const PORTA = 18799;
const SOAK_MS = 60_000;

const dir = mkdtempSync(join(tmpdir(), 'shs-soak-'));
const dbPath = join(dir, 'auth.db');
writeFileSync(join(dir, 'auth.env'), `JWT_SECRET=${'k'.repeat(64)}\nPORT=${PORTA}\n`);

const userData = join(dir, 'userdata');
mkdirSync(join(userData, 'stores'), { recursive: true });
const origens = Array.from({ length: 2428 }, (_, i) => {
  const x = 100 + (i % 60);
  const y = 100 + Math.floor(i / 60);
  return { coord: `${x}|${y}`, x, y };
});
const alvos = Array.from({ length: 183 }, (_, i) => {
  const x = 500 + (i % 20);
  const y = 500 + Math.floor(i / 20);
  return { coord: `${x}|${y}`, x, y };
});
writeFileSync(
  join(userData, 'stores', 'planner-draft.json'),
  JSON.stringify({
    groups: [
      {
        id: 'g1', nome: 'full', origins: origens, originQuotas: origens.map(() => 1),
        targets: alvos, targetQuotas: alvos.map(() => 14), towers: [], towerRadius: 15,
        slowestUnit: 'ram', assignMode: 'otimizado', repeatOriginSamePlayer: true,
        minDistance: 0, maxDistance: 2000, arrivalKind: 'fixa',
        arrivalBaseMs: new Date(2026, 8, 5, 7, 1, 0).getTime(),
        windowStartMs: 0, windowEndMs: 0, attackDelaySeconds: 0,
        nightBonus: 'reagendar', avoidMsConflict: true, minMorale: 0, catapultTargets: [],
      },
    ],
  }, null, 2),
);

const server = spawn(process.execPath, [join(root, 'vps/staffhub-auth/server.mjs')], {
  env: { ...process.env, AUTH_ENV: join(dir, 'auth.env'), AUTH_DB_PATH: dbPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let saida = '';
server.stdout.on('data', (d) => (saida += d));
server.stderr.on('data', (d) => (saida += d));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function esperarPorta() {
  for (let i = 0; i < 50; i++) {
    if (/ouvindo em 127\.0\.0\.1:\d+/.test(saida)) return;
    await dormir(100);
  }
  throw new Error('API local não subiu:\n' + saida);
}

function rodarElectron(envExtras, timeoutMs) {
  execSync('pnpm exec electron .', { cwd: root, stdio: 'inherit', timeout: timeoutMs, env: { ...process.env, ...envExtras } });
}

let electronProcess = null;
let electronExited = false;
let electronCode = null;

try {
  await esperarPorta();
  const registro = await fetch(`http://127.0.0.1:${PORTA}/staffhub/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nick: NICK, senha: SENHA }),
  });
  if (registro.status !== 201) throw new Error('registro falhou: ' + await registro.text());
  const aprovar = join(dir, 'aprovar.mjs');
  writeFileSync(
    aprovar,
    "import { DatabaseSync } from 'node:sqlite';\n" +
      `const db = new DatabaseSync(${JSON.stringify(dbPath)});\n` +
      `db.exec(\`UPDATE users SET status='active', aprovado_em=datetime('now') WHERE nick='${NICK}'\`);\n`,
  );
  execSync(`${process.execPath} ${JSON.stringify(aprovar)}`, { stdio: 'pipe' });

  // FASE A — login persistido no userData isolado.
  const resultadoA = join(dir, 'auth-a.json');
  rodarElectron(
    { SHS_E2E_USERDATA: userData, SHS_AUTH_URL: `http://127.0.0.1:${PORTA}`, SHS_AUTH_E2E: resultadoA, SHS_AUTH_NICK: NICK, SHS_AUTH_SENHA: SENHA },
    60_000,
  );
  const resultado = JSON.parse(readFileSync(resultadoA, 'utf8'));
  if (resultado.login.ok !== true) throw new Error('login falhou: ' + JSON.stringify(resultado.login));

  // FASE B — soak: app ABERTO 60s na Sala de Guerra com o rascunho grande.
  console.log(`▸ soak de ${SOAK_MS / 1000}s iniciado (página guerra, rascunho 2428×183)…`);
  // Windows: pnpm é .cmd — spawn direto dá ENOENT; shell:true resolve (e o
  // taskkill /T abaixo derruba a árvore inteira, cmd incluso).
  electronProcess = spawn('pnpm', ['exec', 'electron', '.'], {
    cwd: root,
    stdio: 'ignore',
    shell: true,
    env: {
      ...process.env,
      SHS_E2E_USERDATA: userData,
      SHS_AUTH_URL: `http://127.0.0.1:${PORTA}`,
      SHS_PAGE: 'guerra',
      SHS_WIDTH: '1440',
      SHS_HEIGHT: '900',
    },
    detached: false,
  });
  electronProcess.on('exit', (code) => {
    electronExited = true;
    electronCode = code;
  });
  await dormir(SOAK_MS);
  if (electronExited) {
    throw new Error(`APP MORREU SOZINHO durante o soak (exit ${electronCode}) — loop/crash real.`);
  }
  const vivo = (() => {
    try {
      process.kill(electronProcess.pid, 0);
      return true;
    } catch {
      return false;
    }
  })();
  if (!vivo) throw new Error('processo do electron não responde ao sinal de vida.');
  console.log('✓ SOAK VERDE: processo vivo após 60s com a escala real.');
} finally {
  if (electronProcess !== null && !electronExited) {
    try {
      execSync(`taskkill /PID ${electronProcess.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      /* já morto */
    }
  }
  server.kill();
  await dormir(300);
  rmSync(dir, { recursive: true, force: true });
}
