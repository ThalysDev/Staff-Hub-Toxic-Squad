// Build do userscript Staff Hub In-Game:
//   node userscript/build.mjs            → dist-userscript/staff-hub-in-game.user.js
//   node userscript/build.mjs --watch    → rebuild no save
// Reuse LITERAL de src/shared (alias @shared) — zero cópia de engine.
// updater-core NÃO entra (node:crypto; irrelevante na página).
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
const version = JSON.parse(readFileSync(join(root, 'userscript', 'version.json'), 'utf-8')).version;
const watch = process.argv.includes('--watch');

// Header Tampermonkey — a versão tem que bater com version.json (checado no build).
const header = `// ==UserScript==
// @name         Staff Hub In-Game — Toxic Squad
// @namespace    https://reidasmultistw.com.br/staff-hub
// @version      ${version}
// @description  Quartel-general da Toxic Squad dentro do jogo — conferência de comandos, análise de tropas/defesa, planner de OP, blindagem e OD (engines do Staff Hub)
// @author       Toxic Squad
// @match        *://*.tribalwars.com.br/game.php*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      api.reidasmultistw.com.br
// @connect      74.0.5.75
// @run-at       document-idle
// @noframes
// ==/UserScript==
`;

const options = {
  entryPoints: [join(here, 'src', 'main.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  alias: { '@shared': join(root, 'src', 'shared') },
  outfile: join(here, 'dist', 'staff-hub-in-game.user.js'),
  banner: { js: header },
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('userscript: watch ativo');
} else {
  await build(options);
  // Sanity: o bundle tem que nascer com o header TM (o Tampermonkey só instala .user.js com ==UserScript==)
  const out = join(here, 'dist', 'staff-hub-in-game.user.js');
  mkdirSync(dirname(out), { recursive: true });
  const body = readFileSync(out, 'utf-8');
  if (!body.startsWith('// ==UserScript==')) throw new Error('bundle sem header Tampermonkey');
  if (!body.includes(`@version      ${version}`)) throw new Error('versão do header != version.json');
  writeFileSync(out, body);
  console.log(`userscript: staff-hub-in-game.user.js v${version} gerado`);
}
