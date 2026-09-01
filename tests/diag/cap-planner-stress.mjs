// E2E DE CAPTURA com o ESTADO REAL do relato da staff (01/09): Sala de Guerra
// → Planner com o grupo "full" de 2428 origens × 183 alvos hidratado do store
// dedicado. Fluxo: API staffhub-auth LOCAL (DB temporário) + FASE A login
// (persiste a sessão no userData isolado via safeStorage) + FASE B app normal
// na página "guerra" com SHS_CAPTURE. Prova que a tela MONTA na escala real —
// o "Maximum call stack size exceeded" dos prints derrubava o renderer.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const NICK = 'e2e_planner';
const SENHA = 'e2ePlanner#01';
const PORTA = 18799;

const dir = mkdtempSync(join(tmpdir(), 'shs-cap-'));
const dbPath = join(dir, 'auth.db');
const envPath = join(dir, 'auth.env');
writeFileSync(envPath, `JWT_SECRET=${'k'.repeat(64)}\nPORT=${PORTA}\n`);

// userData isolado com o RASCUNHO REAL no formato do store planner-draft.
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
const grupo = {
  id: 'g1', nome: 'full', origins: origens, originQuotas: origens.map(() => 1),
  targets: alvos, targetQuotas: alvos.map(() => 14), towers: [], towerRadius: 15,
  slowestUnit: 'ram', assignMode: 'otimizado', repeatOriginSamePlayer: true,
  minDistance: 0, maxDistance: 2000, arrivalKind: 'fixa',
  arrivalBaseMs: new Date(2026, 8, 5, 7, 1, 0).getTime(),
  windowStartMs: 0, windowEndMs: 0, attackDelaySeconds: 0,
  nightBonus: 'reagendar', avoidMsConflict: true, minMorale: 0, catapultTargets: [],
};
writeFileSync(join(userData, 'stores', 'planner-draft.json'), JSON.stringify({ groups: [grupo] }, null, 2));

// ---- API auth LOCAL (mesmo servidor da VPS, DB/env em tmp) ----
const server = spawn(process.execPath, [join(root, 'vps/staffhub-auth/server.mjs')], {
  env: { ...process.env, AUTH_ENV: envPath, AUTH_DB_PATH: dbPath },
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

async function api(caminho, corpo, metodo = 'POST') {
  const resposta = await fetch(`http://127.0.0.1:${PORTA}${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: corpo === null ? undefined : JSON.stringify(corpo),
  });
  return { status: resposta.status, dados: await resposta.json().catch(() => null) };
}

function rodarElectron(envExtras, timeoutMs) {
  execSync('pnpm exec electron .', {
    cwd: root,
    stdio: 'inherit',
    timeout: timeoutMs,
    env: { ...process.env, ...envExtras },
  });
}

try {
  await esperarPorta();
  const registro = await api('/staffhub/api/auth/register', { nick: NICK, senha: SENHA });
  if (registro.status !== 201) throw new Error('registro falhou: ' + JSON.stringify(registro));
  // Aprovação direta no DB (o admin de verdade aprova pelo app; aqui é E2E).
  const aprovar = join(dir, 'aprovar.mjs');
  writeFileSync(
    aprovar,
    "import { DatabaseSync } from 'node:sqlite';\n" +
      `const db = new DatabaseSync(${JSON.stringify(dbPath)});\n` +
      `db.exec(\`UPDATE users SET status='active', aprovado_em=datetime('now') WHERE nick='${NICK}'\`);\n` +
      "console.log('aprovado');\n",
  );
  try {
    execSync(`${process.execPath} ${JSON.stringify(aprovar)}`, { stdio: 'pipe', encoding: 'utf8' });
  } catch (erro) {
    throw new Error(`aprovação falhou: ${erro.stderr ?? erro.message}`);
  }

  // FASE A — login pela API local; a sessão fica persistida no userData isolado.
  const resultadoA = join(dir, 'auth-a.json');
  rodarElectron(
    {
      SHS_E2E_USERDATA: userData,
      SHS_AUTH_URL: `http://127.0.0.1:${PORTA}`,
      SHS_AUTH_E2E: resultadoA,
      SHS_AUTH_NICK: NICK,
      SHS_AUTH_SENHA: SENHA,
    },
    60_000,
  );
  const resultado = JSON.parse(readFileSync(resultadoA, 'utf8'));
  if (resultado.login.ok !== true) throw new Error('login E2E falhou: ' + JSON.stringify(resultado.login));
  console.log(`✓ FASE A: login local ok (estado ${resultado.status.estado}) — sessão persistida no userData`);

  // FASE B — app normal na Sala de Guerra; o boot revalida a sessão na API
  // local e o planner hidrata o rascunho de 2428×183 do disco.
  const shot = join(dir, 'guerra-planner.png');
  rodarElectron(
    {
      SHS_E2E_USERDATA: userData,
      SHS_AUTH_URL: `http://127.0.0.1:${PORTA}`,
      SHS_PAGE: 'guerra',
      SHS_WIDTH: '1440',
      SHS_HEIGHT: '4400',
      SHS_CAPTURE_DELAY: '3500',
      SHS_CAPTURE: shot,
    },
    120_000,
  );
  if (!existsSync(shot)) {
    const motivo = existsSync(`${shot}.err`) ? readFileSync(`${shot}.err`, 'utf8') : 'sem .err';
    throw new Error(`captura não gerada — ${motivo}`);
  }
  const png = readFileSync(shot);
  mkdirSync(join(root, 'tests/diag/cap-planner'), { recursive: true });
  writeFileSync(join(root, 'tests/diag/cap-planner/guerra-planner-2428x183.png'), png);
  console.log(`✓ FASE B: captura da Sala de Guerra com rascunho 2428×183 (${png.length} bytes) → tests/diag/cap-planner/`);
  console.log('E2E CAPTURA PLANNER VERDE');
} finally {
  server.kill();
  await dormir(300);
  rmSync(dir, { recursive: true, force: true });
}
