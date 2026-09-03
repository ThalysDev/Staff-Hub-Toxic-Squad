// QA visual v0.34 (aba Auditoria de Membros): gera histórico SINTÉTICO
// determinístico (8 versões, 12 jogadores com perfis de auditoria: recruta
// massivo, queda, entra, sai, inativo, crescimento normal) + snapshot REAL do
// dono (aba análise) e captura o SG_2 nas DUAS abas (pref sg2.abaAudit).
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const NICK = 'e2e_visual';
const SENHA = 'e2eVisual#01';
const PORTA = 18801;
const APPDATA = process.env.APPDATA ?? '';

// ---- Histórico sintético (determinístico) ----
const BASE = new Date('2026-08-28T12:00:00.000Z').getTime();
const H12 = 12 * 60 * 60 * 1000;
/** [nome, offPop0, defPop0, villages0, perfil] */
const PLAYERS = [
  ['Aurélio Massa', 210_000, 160_000, 42, 'massivo'],   // Δ +20.9k na janela padrão (v6→v7)
  ['Bruno Queda', 260_000, 200_000, 51, 'queda'],       // −20k off no fim
  ['Caio Novato', 0, 0, 0, 'entra'],                    // entra exatamente na última (v7)
  ['Duda Saiu', 180_000, 150_000, 38, 'sai'],           // presente até v6
  ['Ester Parada', 95_000, 120_000, 30, 'inativo'],     // flat
  ['Fábio Comum', 150_000, 130_000, 33, 'normal'],
  ['Guga Comum', 230_000, 175_000, 46, 'normal'],
  ['Heitor Nobre', 320_000, 90_000, 57, 'normal'],
  ['Íris Defensora', 70_000, 290_000, 44, 'normal'],
  ['Joãozinho', 110_000, 95_000, 25, 'normal'],
  ['Kelly Rural', 55_000, 88_000, 21, 'normal'],
  ['Léo Aldeotas', 190_000, 165_000, 49, 'normal'],
];

function versionAt(v) {
  const players = [];
  for (const [index, [name, off0, def0, vil0, perfil]] of PLAYERS.entries()) {
    if (perfil === 'entra' && v < 7) continue; // entra exatamente na última → isNew no diff padrão
    if (perfil === 'sai' && v >= 7) continue;  // presente até v6, some na última → left no diff padrão
    let off = Math.round(off0 * (1 + 0.04 * v));
    let def = Math.round(def0 * (1 + 0.03 * v));
    let vil = vil0 + Math.floor(v / 3);
    if (perfil === 'entra') { off = 60_000 + 8_000 * v; def = 40_000 + 6_000 * v; vil = 12 + v; }
    if (perfil === 'inativo') { off = off0; def = def0; vil = vil0; }
    if (perfil === 'massivo' && v >= 6) off += 12_500 * (v - 5); // Δ +20.9k na janela padrão
    // queda: SEM crescimento (senão ele se compensa); Δ −18k e −1 aldeia na janela padrão
    if (perfil === 'queda' && v >= 5) { off = off0 - 18_000 * (v - 4); def = def0 - 6_000 * (v - 4); vil = vil0 - (v - 4); }
    players.push({ playerId: 1000 + index, playerName: name, villageCount: vil, units: {}, offPop: off, defPop: def });
  }
  return { id: `th-syn-${v}`, collectedAt: new Date(BASE + v * H12).toISOString(), source: 'per-member', players };
}

const versions = Array.from({ length: 8 }, (_, v) => versionAt(v));

// ---- userData base (snapshot real do dono + histórico sintético) ----
const dir = mkdtempSync(join(tmpdir(), 'shs-v034-'));
const dbPath = join(dir, 'auth.db');
writeFileSync(join(dir, 'auth.env'), `JWT_SECRET=${'k'.repeat(64)}\nPORT=${PORTA}\n`);

function makeUserData(abaAudit) {
  const ud = join(dir, `userdata-${abaAudit}`);
  mkdirSync(join(ud, 'stores'), { recursive: true });
  const snapOrigem = join(APPDATA, 'Staff Hub Toxic Squad', 'stores', 'troops-snapshots.json');
  if (existsSync(snapOrigem)) copyFileSync(snapOrigem, join(ud, 'stores', 'troops-snapshots.json'));
  writeFileSync(join(ud, 'stores', 'troops-history.json'), JSON.stringify({ versions: [...versions].reverse() }), 'utf-8');
  writeFileSync(join(ud, 'stores', 'preferences.json'), JSON.stringify({ sg2: { abaAudit } }), 'utf-8');
  return ud;
}

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

const outDir = join(root, 'tests/diag/cap-v034');
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

  // login E2E uma vez (persiste a sessão no ÚNICO userdata — capturas seguintes
  // só trocam a pref da aba; sem cópia de sessão entre userDatas)
  const userData = makeUserData('analise');
  const resultadoA = join(dir, 'auth-a.json');
  rodarElectron(
    { SHS_E2E_USERDATA: userData, SHS_AUTH_URL: `http://127.0.0.1:${PORTA}`, SHS_AUTH_E2E: resultadoA, SHS_AUTH_NICK: NICK, SHS_AUTH_SENHA: SENHA },
    60_000,
  );
  const resultado = JSON.parse(readFileSync(resultadoA, 'utf-8'));
  if (resultado.login.ok !== true) throw new Error('login falhou: ' + JSON.stringify(resultado.login));
  console.log('✓ login local ok');

  for (const aba of ['analise', 'auditoria']) {
    if (aba === 'auditoria') {
      // app fechado entre capturas: reescreve a pref da aba no MESMO userdata
      writeFileSync(join(userData, 'stores', 'preferences.json'), JSON.stringify({ sg2: { abaAudit: 'auditoria' } }), 'utf-8');
    }
    const shot = join(dir, `sg2-${aba}.png`);
    rodarElectron(
      {
        SHS_E2E_USERDATA: userData,
        SHS_AUTH_URL: `http://127.0.0.1:${PORTA}`,
        SHS_PAGE: 'sg2',
        SHS_THEME: 'claro',
        SHS_WIDTH: '1900',
        SHS_HEIGHT: '1150',
        SHS_CAPTURE_DELAY: '2200',
        SHS_CAPTURE_FULL: '1',
        SHS_CAPTURE: shot,
      },
      120_000,
    );
    if (!existsSync(shot)) throw new Error(`captura sg2-${aba} não gerada`);
    writeFileSync(join(outDir, `sg2-${aba}.png`), readFileSync(shot));
    console.log(`✓ sg2-${aba}`);
  }
  console.log(`QA VISUAL v0.34: capturas em ${outDir}`);
} finally {
  server.kill();
  await dormir(300);
  rmSync(dir, { recursive: true, force: true });
}
