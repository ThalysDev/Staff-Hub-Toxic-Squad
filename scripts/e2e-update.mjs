// E2E do atualizador — o loop vermelho/verde definitivo do swap de versões.
//
// Valida a CADEIA COMPLETA em um app empacotado de verdade:
//   baixar do canal → SHA → extrair → script de troca → app sai → pastas trocam
//   → app RELANÇA sozinho na versão nova.
//
// Como usa o gancho SHS_E2E_* (env), roda sem cliques de UI. O app relançado
// grava marker/e2e-success.txt — só POSSÍVEL se troca + relançamento funcionaram.
//
// Uso: node scripts/e2e-update.mjs [--keep]
// Saída: exit 0 = VERDE (sucesso) · exit 1 = VERMELHO (falha) + evidências.

import { createServer } from 'node:http';
import { execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR_NAME = 'Staff Hub Toxic Squad-win32-x64';
const EXE = join(APP_DIR_NAME, 'Staff Hub Toxic Squad.exe');
const keep = process.argv.includes('--keep');

function run(cmd, label) {
  console.log(`▸ ${label}`);
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// ---------------------------------------------------------------------------
// 1. Build + package (sem bump de versão, sem publicar)
// ---------------------------------------------------------------------------
const pkgDir = join(root, 'dist', 'pkg-e2e');
run('pnpm build', 'Build');
const stageDir = join(root, 'dist', 'app-stage-e2e');
rmSync(stageDir, { recursive: true, force: true });
rmSync(pkgDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
execSync(`cp -r out ${stageDir}/ && cp -r build ${stageDir}/`, { cwd: root });
const pkgJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(join(stageDir, 'package.json'), JSON.stringify({
  name: 'staff-hub-toxic-squad',
  productName: 'Staff Hub Toxic Squad',
  version: pkgJson.version,
  main: 'out/main/index.js',
}, null, 2));
run(`pnpm dlx @electron/packager dist/app-stage-e2e "Staff Hub Toxic Squad" --platform=win32 --arch=x64 --electron-version=43.4.1 --out=dist/pkg-e2e --icon=build/icon.ico --overwrite`, 'Package E2E');

// O packager já entrega resources/app.asar (igual ao release) — NÃO reempacotar.

// ---------------------------------------------------------------------------
// 2. Sandbox: instalação + canal local + userData isolado + marcadores
// ---------------------------------------------------------------------------
const stamp = Date.now();
const sandbox = join(root, 'dist', `e2e-run-${stamp}`);
const installDir = join(sandbox, 'install', APP_DIR_NAME);
const channelDir = join(sandbox, 'channel');
const markerDir = join(sandbox, 'marker');
const userDataDir = join(sandbox, 'userdata');
mkdirSync(join(sandbox, 'install'), { recursive: true });
mkdirSync(channelDir, { recursive: true });
mkdirSync(markerDir, { recursive: true });
mkdirSync(join(userDataDir, 'stores'), { recursive: true });

console.log('▸ Instalando cópia do app (a "versão velha") em sandbox');
execSync(`cp -r "${join(pkgDir, APP_DIR_NAME)}" "${join(sandbox, 'install')}"`, { cwd: root });

console.log('▸ Zip do payload (conteúdo idêntico, manifesto mente 99.0.0)');
execSync(`cd "${pkgDir}" && C:/Windows/System32/tar.exe -a -c -f "${join(channelDir, 'app.zip')}" "${APP_DIR_NAME}"`);
const zipPath = join(channelDir, 'app.zip');

// Servidor do canal
const server = createServer((req, res) => {
  const file = req.url === '/latest.json' ? join(channelDir, 'latest.json') : zipPath;
  try {
    const data = readFileSync(file);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length });
    res.end(data);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
writeFileSync(join(channelDir, 'latest.json'), JSON.stringify({
  version: '99.0.0',
  notes: 'Versão de teste E2E do atualizador.',
  url: `${base}/app.zip`,
  sha256: sha256Of(zipPath),
  releasedAt: new Date().toISOString(),
}, null, 2));

// Settings pré-configurados apontando para o canal local
writeFileSync(join(userDataDir, 'stores', 'settings.json'), JSON.stringify({
  requestMinIntervalMs: 350,
  requestJitterMs: 250,
  requestCeiling: 400,
  dryRun: false,
  updateUrl: `${base}/latest.json`,
}, null, 2));

console.log(`▸ Canal local em ${base} · app instalado em ${installDir}`);

// ---------------------------------------------------------------------------
// 3. Lança o app com o gancho E2E e espera o veredito
// ---------------------------------------------------------------------------
const child = spawn(join(sandbox, 'install', EXE), [], {
  cwd: join(sandbox, 'install', APP_DIR_NAME),
  env: {
    ...process.env,
    SHS_E2E_USERDATA: userDataDir,
    SHS_E2E_UPDATE_URL: `${base}/latest.json`,
    SHS_E2E_MARKER_DIR: markerDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let consoleLog = '';
child.stdout.on('data', (d) => { consoleLog += d; });
child.stderr.on('data', (d) => { consoleLog += d; });

console.log('▸ App lançado — aguardando troca + relançamento (até 240s)…');
const deadline = Date.now() + 240_000;
let verdict = null;
await new Promise((resolve) => {
  const poll = setInterval(() => {
    if (existsSync(join(markerDir, 'e2e-success.txt'))) { verdict = 'GREEN'; clearInterval(poll); resolve(); return; }
    if (existsSync(join(markerDir, 'e2e-failure.txt'))) { verdict = 'RED'; clearInterval(poll); resolve(); return; }
    if (Date.now() > deadline) { verdict = 'TIMEOUT'; clearInterval(poll); resolve(); }
  }, 500);
});
// margem p/ o relançado fechar
await new Promise((r) => setTimeout(r, 3000));

// ---------------------------------------------------------------------------
// 4. Evidências + veredito
// ---------------------------------------------------------------------------
const swapLog = (() => { try { return readFileSync(join(userDataDir, 'updates', 'swap-debug.log'), 'utf8'); } catch { return '(sem swap-debug.log)'; } })();
const backups = (() => { try { return readdirSync(join(sandbox, 'install')).filter((n) => n.startsWith('shb-old-')); } catch { return []; } })();
console.log('\n================ EVIDÊNCIAS ================');
console.log('--- console do app ---');
console.log(consoleLog.trim() || '(vazio)');
console.log('--- swap-debug.log ---');
console.log(swapLog.trim() || '(vazio)');
console.log(`--- backups restantes: ${backups.length === 0 ? 'nenhum (limpo)' : backups.join(', ')} ---`);
console.log(`--- sucesso: ${existsSync(join(markerDir, 'e2e-success.txt')) ? 'marker presente' : 'AUSENTE'} ---`);

const green = verdict === 'GREEN';
console.log(`\n${green ? '✅ E2E VERDE' : '❌ E2E VERMELHO (' + verdict + ')'} — atualização ${green ? 'trocou as pastas E relançou o app' : 'NÃO completou o ciclo troca+relançamento'}`);

try { child.kill(); } catch {}
server.close();
if (!keep) {
  rmSync(sandbox, { recursive: true, force: true });
  console.log('(sandbox removido — use --keep para inspecionar)');
} else {
  console.log(`sandbox mantido: ${sandbox}`);
}
process.exit(green ? 0 : 1);
