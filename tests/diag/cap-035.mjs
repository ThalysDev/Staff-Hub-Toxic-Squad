// QA UX/UI v0.35 — AUDITORIA COMPLETA DO FRONT-END: captura TODAS as páginas
// (dashboard, sessao, config, journal, captures, admin, sg1..sg7, guerra) nos
// 2 temas (claro/escuro) em 1900px fullPage, com userData seeded (snapshot real
// do dono, histórico sintético, rascunho de guerra, journal populado, templates,
// usuário admin) para os designers avaliarem com critério de SaaS premium.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const NICK = 'e2e_visual';
const SENHA = 'e2eVisual#01';
const PORTA = 18802;
const APPDATA = process.env.APPDATA ?? '';

const PAGES = [
  { id: 'dashboard', delay: 1500 },
  { id: 'sessao', delay: 1800 },
  { id: 'config', delay: 1800 },
  { id: 'journal', delay: 1800 },
  { id: 'captures', delay: 1800 },
  { id: 'admin', delay: 2000 },
  { id: 'sg1', delay: 2200 },
  { id: 'sg2', delay: 2500 },
  { id: 'sg3', delay: 2200 },
  { id: 'sg4', delay: 3000 },
  { id: 'sg5', delay: 2500 },
  { id: 'sg6', delay: 2500 },
  { id: 'sg7', delay: 2500 },
  { id: 'guerra', delay: 9000 },
];
const THEMES = ['claro', 'escuro'];

// ---- seeds ----
const H12 = 12 * 60 * 60 * 1000;
const BASE = new Date('2026-08-28T12:00:00.000Z').getTime();
const PLAYERS = [
  ['Aurélio Massa', 210_000, 160_000, 42, 'massivo'],
  ['Bruno Queda', 260_000, 200_000, 51, 'queda'],
  ['Caio Novato', 0, 0, 0, 'entra'],
  ['Duda Saiu', 180_000, 150_000, 38, 'sai'],
  ['Ester Parada', 95_000, 120_000, 30, 'inativo'],
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
    if (perfil === 'entra' && v < 7) continue;
    if (perfil === 'sai' && v >= 7) continue;
    let off = Math.round(off0 * (1 + 0.04 * v));
    let def = Math.round(def0 * (1 + 0.03 * v));
    let vil = vil0 + Math.floor(v / 3);
    if (perfil === 'entra') { off = 60_000 + 8_000 * v; def = 40_000 + 6_000 * v; vil = 12 + v; }
    if (perfil === 'inativo') { off = off0; def = def0; vil = vil0; }
    if (perfil === 'massivo' && v >= 6) off += 12_500 * (v - 5);
    if (perfil === 'queda' && v >= 5) { off = off0 - 18_000 * (v - 4); def = def0 - 6_000 * (v - 4); vil = vil0 - (v - 4); }
    players.push({ playerId: 1000 + index, playerName: name, villageCount: vil, units: {}, offPop: off, defPop: def });
  }
  return { id: `th-syn-${v}`, collectedAt: new Date(BASE + v * H12).toISOString(), source: 'per-member', players };
}
const historyVersions = Array.from({ length: 8 }, (_, v) => versionAt(v)).reverse();

const JOURNAL_SEED = [
  { ts: '2026-09-03T14:02:11.000Z', kind: 'read', action: 'collect-members', detail: 'tropas por aldeia: 40 membros, 16099 aldeias, R O D R I G U E S: 2 páginas', dryRun: false },
  { ts: '2026-09-03T14:02:14.000Z', kind: 'read', action: 'troopshistory-archive', detail: 'jogadores=40', dryRun: false },
  { ts: '2026-09-02T21:40:03.000Z', kind: 'write', action: 'sg6-sendmps', detail: 'MP em massa: 38 destinatários, 38 enviadas, 0 falhas (OP Retomada K55)', dryRun: false },
  { ts: '2026-09-02T21:10:41.000Z', kind: 'write', action: 'op-archive', detail: 'OP "Retomada K55" arquivada com 2428 comandos', dryRun: false },
  { ts: '2026-09-02T20:55:19.000Z', kind: 'read', action: 'sg5-verify', detail: 'conferência: 1701 aldos verificadas, cobertura 87%', dryRun: false },
  { ts: '2026-09-01T09:12:00.000Z', kind: 'write', action: 'forum-post', detail: 'plano BBCode postado no tópico "Diretrizes 01/09" (1º post substituído)', dryRun: false },
  { ts: '2026-08-31T22:31:55.000Z', kind: 'system', action: 'settings-update', detail: 'requestCeiling: 60 → 80', dryRun: false },
  { ts: '2026-08-31T19:02:10.000Z', kind: 'write', action: 'sg6-charge', detail: 'cobrança de faltas: 5 devedores, 5 MPs enviadas', dryRun: false },
  { ts: '2026-08-30T11:47:32.000Z', kind: 'read', action: 'capture-fixture', detail: 'troops-own-paged-p1 ← members_troops&player_id=1618709', dryRun: false },
  { ts: '2026-08-29T16:20:08.000Z', kind: 'system', action: 'update-installed', detail: '0.33.0 instalada com sucesso', dryRun: false },
];

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

const dir = mkdtempSync(join(tmpdir(), 'shs-035-'));
const dbPath = join(dir, 'auth.db');
writeFileSync(join(dir, 'auth.env'), `JWT_SECRET=${'k'.repeat(64)}\nPORT=${PORTA}\n`);
const userData = join(dir, 'userdata');
mkdirSync(join(userData, 'stores'), { recursive: true });
const copiar = (nome) => {
  const origem = join(APPDATA, 'Staff Hub Toxic Squad', 'stores', nome);
  if (existsSync(origem)) copyFileSync(origem, join(userData, 'stores', nome));
};
copiar('troops-snapshots.json');
copiar('mp-templates.json');
copiar('world-config.json');
copiar('unit-info.json');
writeFileSync(join(userData, 'stores', 'troops-history.json'), JSON.stringify({ versions: historyVersions }), 'utf-8');
writeFileSync(join(userData, 'stores', 'journal.json'), JSON.stringify(JOURNAL_SEED, null, 2), 'utf-8');
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
  'utf-8',
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

const outDir = join(root, 'tests/diag/cap-035');
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
      `db.exec(\`UPDATE users SET status='active', role='admin', aprovado_em=datetime('now') WHERE nick='${NICK}'\`);\n`,
  );
  execSync(`${process.execPath} ${JSON.stringify(aprovar)}`, { stdio: 'pipe' });

  const resultadoA = join(dir, 'auth-a.json');
  rodarElectron(
    { SHS_E2E_USERDATA: userData, SHS_AUTH_URL: `http://127.0.0.1:${PORTA}`, SHS_AUTH_E2E: resultadoA, SHS_AUTH_NICK: NICK, SHS_AUTH_SENHA: SENHA },
    60_000,
  );
  const resultado = JSON.parse(readFileSync(resultadoA, 'utf-8'));
  if (resultado.login.ok !== true) throw new Error('login falhou: ' + JSON.stringify(resultado.login));
  console.log('✓ login local ok (admin)');

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
          SHS_WIDTH: '1900',
          SHS_HEIGHT: '1150',
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
  console.log(`AUDITORIA UX/UI: ${total} capturas em ${outDir}`);
} finally {
  server.kill();
  await dormir(300);
  rmSync(dir, { recursive: true, force: true });
}
