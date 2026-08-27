// Release completo: gates → version bump → build → package → publish no canal → zip Desktop.
// Uso: node scripts/release.mjs <nova-versão> <notas>  (ex.: node scripts/release.mjs 0.19.0 "Notas da release")
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [, , version, notes] = process.argv;
if (!version || !notes) {
  console.error('uso: node scripts/release.mjs <versão> <notas>');
  console.error('ex.:  node scripts/release.mjs 0.19.0 "Fakes inteligentes + notificações T-minus"');
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Versão inválida: ${version} (use X.Y.Z)`);
  process.exit(2);
}

const root = resolve(import.meta.dirname, '..');
const run = (cmd, label) => {
  console.log(`\n▸ ${label}`);
  execSync(cmd, { cwd: root, stdio: 'inherit' });
};

console.log(`\n🚀 Release ${version} — ${notes}\n`);

// 1. Gates
run('pnpm typecheck', 'Typecheck');
run('pnpm test', 'Testes');
run('pnpm build', 'Build');

// 2. Version bump
const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`\n▸ Versão bumped para ${version}`);

// 3. Rebuild com a versão nova
run('pnpm build', 'Rebuild com versão nova');

// 4. Staging + Package
const stageDir = join(root, 'dist', 'app-stage');
const pkgDir = join(root, 'dist', `pkg-${version}`);
rmSync(stageDir, { recursive: true, force: true });
rmSync(pkgDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
execSync(`cp -r out ${stageDir}/ && cp -r build ${stageDir}/`, { cwd: root });
writeFileSync(join(stageDir, 'package.json'), JSON.stringify({
  name: 'staff-hub-toxic-squad',
  productName: 'Staff Hub Toxic Squad',
  version,
  main: 'out/main/index.js',
}, null, 2));
run(`pnpm dlx @electron/packager dist/app-stage "Staff Hub Toxic Squad" --platform=win32 --arch=x64 --electron-version=43.4.1 --out=dist/pkg-${version} --icon=build/icon.ico --overwrite`, `Package ${version}`);

// 5. Zip Desktop
const zipName = `StaffHubToxicSquad-${version}.zip`;
execSync(`cd "dist/pkg-${version}" && C:/Windows/System32/tar.exe -a -c -f "../../${zipName}" "Staff Hub Toxic Squad-win32-x64"`, { cwd: root });
console.log(`\n▸ Zip: ${zipName}`);

// 6. Publish no canal
run(`node scripts/publish-update.mjs "${zipName}" "${version}" "${notes}"`, 'Publish no canal');

// 7. Copiar zip para o Desktop
const desktop = join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Desktop');
const desktopZip = join(desktop, zipName);
if (existsSync(desktop)) {
  try { copyFileSync(join(root, zipName), desktopZip); console.log(`▸ Copiado para ${desktopZip}`); } catch { console.warn('⚠ Não consegui copiar para o Desktop'); }
}

console.log(`\n✅ Release ${version} completa!`);
console.log(`   Canal: http://74.0.5.75/staffhub/latest.json`);
console.log(`   Zip:   ${zipName}`);
