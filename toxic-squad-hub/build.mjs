// Build do userscript TOXIC SQUAD HUB (fusão Staff Hub In-Game + TW Vanta):
//   node toxic-squad-hub/build.mjs            → toxic-squad-hub/dist/toxic-squad-hub.user.js (ofuscado)
//   node toxic-squad-hub/build.mjs --watch    → rebuild no save
// Reuse LITERAL de src/shared (alias @shared) — zero cópia de engine.
// updater-core NÃO entra (node:crypto; irrelevante na página).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
// esbuild é transitivo (pnpm não hoista no root): resolve de dentro do
// diretório .pnpm do próprio esbuild (versão pinada pela lockfile).
const esbuildPkg = join(root, 'node_modules', '.pnpm', 'esbuild@0.25.12', 'node_modules', 'esbuild', 'package.json');
const requireEsbuild = createRequire(esbuildPkg);
const { build, context } = requireEsbuild('esbuild');
// zod: transitivo no store pnpm (sem link no node_modules da raiz). O alias
// blinda o build caso a junction node_modules/zod não exista na máquina.
const zodPkgPath = join(root, 'node_modules', '.pnpm', 'zod@4.1.11', 'node_modules', 'zod');
const requireFromRoot = createRequire(join(root, 'package.json'));
// CJS transpilado de ESM: a função vive no default (resolve pelo caminho real).
const obfModule = requireFromRoot(requireFromRoot.resolve('javascript-obfuscator'));
const JavaScriptObfuscator = obfModule.default ?? obfModule;
const version = JSON.parse(readFileSync(join(here, 'version.json'), 'utf-8')).version;
const watch = process.argv.includes('--watch');

// Header Tampermonkey — a versão tem que bater com version.json (checado no build).
const header = `// ==UserScript==
// @name         Toxic Squad Hub
// @namespace    https://reidasmultistw.com.br/toxic-squad-hub
// @version      ${version}
// @description  Arsenal da Toxic Squad dentro do jogo — Central de Agendamentos (precisão de ms, sequência de nobres, cancelamento cronometrado, agendamento em bloco, mapa de operações), Distribuidor de Apoios na aba nativa, suite Vanta (dashboard, mapa, etiquetador com alarme, notas de campo e mais), automações com humanização, Modo Sentinela e busca rápida Ctrl+K
// @author       Toxic Squad
// @match        *://*.tribalwars.com.br/game.php*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.reidasmultistw.com.br
// @connect      74.0.5.75
// @homepageURL  http://74.0.5.75/staffhub/scripts/toxic-squad-hub.user.js
// @updateURL    http://74.0.5.75/staffhub/scripts/toxic-squad-hub.meta.js
// @downloadURL  http://74.0.5.75/staffhub/scripts/toxic-squad-hub.user.js
// @license      Proprietary - Toxic Squad personal use
// @run-at       document-idle
// @noframes
// ==/UserScript==
`;

const options = {
  entryPoints: [join(here, 'src', 'main.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  alias: { '@shared': join(root, 'src', 'shared'), zod: zodPkgPath },
  outfile: join(here, 'dist', 'toxic-squad-hub.user.js'),
  banner: { js: header },
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
    // Versão de compile-time (mesma do header/version.json): o planner usa no
    // JSON da OP — nada de hardcoded divergente entre módulo e canal.
    '__SHS_VERSION__': JSON.stringify(version),
  },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('toxic-squad-hub: watch ativo');
} else {
  await build(options);
  // Sanity: o bundle tem que nascer com o header TM (o Tampermonkey só instala .user.js com ==UserScript==)
  const out = join(here, 'dist', 'toxic-squad-hub.user.js');
  mkdirSync(dirname(out), { recursive: true });
  let body = readFileSync(out, 'utf-8');
  if (!body.startsWith('// ==UserScript==')) throw new Error('bundle sem header Tampermonkey');
  if (!body.includes(`@version      ${version}`)) throw new Error('versão do header != version.json');
  body = body.slice(body.indexOf('// ==/UserScript==') + '// ==/UserScript=='.length);

  // OBFUSCAÇÃO do artefato distribuído (pedido do dono: ninguém copia o
  // sistema). Configuração moderada determinística (mesma família do canal
  // irmão): NÃO usa controlFlowFlattening/selfDefending de propósito — o
  // planner e o dashboard são pesados em CPU e o script roda na aba do jogo.
  const obfuscated = JavaScriptObfuscator.obfuscate(body, {
    compact: true,
    simplify: true,
    seed: 20260921,
    identifierNamesGenerator: 'hexadecimal',
    stringArray: true,
    stringArrayThreshold: 0.75,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    splitStrings: true,
    splitStringsChunkLength: 8,
    transformObjectKeys: false,
    // LOAD-BEARING: renameGlobals:false — ligar isso renomearia globals do
    // sandbox do Tampermonkey (unsafeWindow, GM_*) e quebraria TODOS os grants.
    renameGlobals: false,
    selfDefending: false,
    debugProtection: false,
    disableConsoleOutput: false,
  }).getObfuscatedCode();
  writeFileSync(out, `${header}\n${obfuscated}\n`);

  // Validação do ARTEFATO FINAL (o header é re-anexado só aqui, depois da
  // obfuscação): header TM no início (senão o Tampermonkey nem instala) e
  // sintaxe válida — o ofuscador não pode corromper o bundle.
  if (!readFileSync(out, 'utf-8').startsWith('// ==UserScript==')) {
    throw new Error('artefato ofuscado final sem header Tampermonkey');
  }
  try {
    execFileSync(process.execPath, ['--check', out], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(
      `artefato ofuscado falhou no node --check (${out}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // meta.js para o canal (mesmo header — o Tampermonkey só lê o bloco).
  writeFileSync(join(here, 'dist', 'toxic-squad-hub.meta.js'), header);
  console.log(`toxic-squad-hub: toxic-squad-hub.user.js v${version} gerado (ofuscado) + meta.js`);
}
