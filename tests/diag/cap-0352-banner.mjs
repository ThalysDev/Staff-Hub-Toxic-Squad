// QA visual do BANNER GLOBAL de atualização (v0.35.2): captura o dashboard
// com ?update-banner=demo (estado "pronto" fake, sem rede) nos 2 temas.
import { execSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const PORTA = 18803;
const dir = mkdtempSync(join(tmpdir(), 'shs-banner-'));
const dbPath = join(dir, 'auth.db');
writeFileSync(join(dir, 'auth.env'), `JWT_SECRET=${'k'.repeat(64)}\nPORT=${PORTA}\n`);
const userData = join(dir, 'userdata');
mkdirSync(join(userData, 'stores'), { recursive: true });

const server = spawn(process.execPath, [join(root, 'vps/staffhub-auth/server.mjs')], {
  env: { ...process.env, AUTH_ENV: join(dir, 'auth.env'), AUTH_DB_PATH: dbPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let saida = '';
server.stdout.on('data', (d) => (saida += d));
server.stderr.on('data', (d) => (saida += d));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const outDir = join(root, 'tests/diag/cap-0352');
mkdirSync(outDir, { recursive: true });

try {
  for (let i = 0; i < 50 && !/ouvindo em/.test(saida); i += 1) await dormir(100);
  const registro = await fetch(`http://127.0.0.1:${PORTA}/staffhub/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nick: 'e2e_visual', senha: 'e2eVisual#01' }),
  });
  if (registro.status !== 201) throw new Error('registro falhou: ' + (await registro.text()));
  const aprovar = join(dir, 'a.mjs');
  writeFileSync(
    aprovar,
    "import { DatabaseSync } from 'node:sqlite';\n" +
      `const db = new DatabaseSync(${JSON.stringify(dbPath)});\n` +
      `db.exec(\`UPDATE users SET status='active', role='admin', aprovado_em=datetime('now') WHERE nick='e2e_visual'\`);\n`,
  );
  execSync(`${process.execPath} ${JSON.stringify(aprovar)}`, { stdio: 'pipe' });

  const resA = join(dir, 'auth.json');
  const env = {
    SHS_E2E_USERDATA: userData,
    SHS_AUTH_URL: `http://127.0.0.1:${PORTA}`,
    SHS_AUTH_E2E: resA,
    SHS_AUTH_NICK: 'e2e_visual',
    SHS_AUTH_SENHA: 'e2eVisual#01',
  };
  execSync('pnpm exec electron .', { cwd: root, stdio: 'inherit', timeout: 60_000, env: { ...process.env, ...env } });
  const login = JSON.parse(readFileSync(resA, 'utf8'));
  if (login.login.ok !== true) throw new Error('login falhou');
  console.log('✓ login local ok');

  for (const theme of ['claro', 'escuro']) {
    const shot = join(dir, `banner-${theme}.png`);
    // SHS_AUTH_E2E fica FORA da captura: com ele o main repetiria o fluxo de
    // login (e sairia) em vez de tirar a foto — a sessão já persistiu no userData.
    const { SHS_AUTH_E2E: _a, SHS_AUTH_NICK: _b, SHS_AUTH_SENHA: _c, ...envSessao } = env;
    execSync('pnpm exec electron .', {
      cwd: root, stdio: 'inherit', timeout: 120_000,
      env: {
        ...process.env, ...envSessao,
        SHS_PAGE: 'dashboard', SHS_THEME: theme, SHS_QUERY: 'update-banner=demo',
        SHS_WIDTH: '1900', SHS_HEIGHT: '1100', SHS_CAPTURE_DELAY: '2500',
        SHS_CAPTURE_FULL: '1', SHS_CAPTURE: shot,
      },
    });
    if (!existsSync(shot)) throw new Error(`captura banner-${theme} não gerada`);
    copyFileSync(shot, join(outDir, `banner-${theme}.png`));
    console.log(`✓ banner-${theme}`);
  }
  console.log(`QA banner: capturas em ${outDir}`);
} finally {
  server.kill();
  await dormir(300);
  rmSync(dir, { recursive: true, force: true });
}
