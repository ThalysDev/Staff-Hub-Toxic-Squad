// QA visual da v0.33: captura as páginas tocadas pela mega atualização nos 2
// temas (guerra com rascunho real 2428×183, sg2, sg6, sessao). API auth LOCAL
// + login persistido no userData isolado (mesmo padrão do cap-planner-stress).
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const NICK = 'e2e_visual';
const SENHA = 'e2eVisual#01';
const PORTA = 18799;

const PAGES = [
  { id: 'guerra', h: 1000, delay: 3500 },
  { id: 'sg2', h: 1000, delay: 1500 },
  { id: 'sg6', h: 1000, delay: 1200 },
  { id: 'sessao', h: 1000, delay: 1200 },
];
const THEMES = ['claro'];

const dir = mkdtempSync(join(tmpdir(), 'shs-v033-'));
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

const outDir = join(root, 'tests/diag/cap-v033');
mkdirSync(outDir, { recursive: true });

function rodarElectron(envExtras, timeoutMs) {
  execSync('pnpm exec electron .', { cwd: root, stdio: 'inherit', timeout: timeoutMs, env: { ...process.env, ...envExtras } });
}

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

  const resultadoA = join(dir, 'auth-a.json');
  rodarElectron(
    { SHS_E2E_USERDATA: userData, SHS_AUTH_URL: `http://127.0.0.1:${PORTA}`, SHS_AUTH_E2E: resultadoA, SHS_AUTH_NICK: NICK, SHS_AUTH_SENHA: SENHA },
    60_000,
  );
  const resultado = JSON.parse(readFileSync(resultadoA, 'utf8'));
  if (resultado.login.ok !== true) throw new Error('login falhou: ' + JSON.stringify(resultado.login));
  console.log('✓ login local ok');

  let total = 0;
  for (const theme of THEMES) {
    for (const page of PAGES) {
      const shot = join(dir, `${page.id}-${theme}.png`);
      rodarElectron(
        {
          SHS_E2E_USERDATA: userData,
          SHS_AUTH_URL: `http://127.0.0.1:${PORTA}`,
          SHS_PAGE: page.id,
          SHS_THEME: theme,
          SHS_WIDTH: '1600',
          SHS_HEIGHT: String(page.h),
          SHS_CAPTURE_DELAY: String(page.delay),
          SHS_CAPTURE_FULL: '1',
          SHS_CAPTURE: shot,
        },
        120_000,
      );
      if (!existsSync(shot)) throw new Error(`captura ${page.id}-${theme} não gerada`);
      writeFileSync(join(outDir, `${page.id}-${theme}.png`), readFileSync(shot));
      total += 1;
      console.log(`✓ ${page.id}-${theme}`);
    }
  }
  console.log(`QA VISUAL v0.33: ${total} capturas em ${outDir}`);
} finally {
  server.kill();
  await dormir(300);
  rmSync(dir, { recursive: true, force: true });
}
