// Publica o userscript Staff Hub In-Game no canal oficial (VPS + nginx):
//   node scripts/publish-userscript.mjs
// Sobe userscript/dist/{staff-hub-in-game.user.js, staff-hub-in-game.meta.js}
// para /var/www/staffhub-updates/scripts/ e imprime as URLs públicas.
// Autenticação SSH: mesma chave ed25519 do publish-update (dist/vps/id_staffhub).
// O .user.js já sai OFUSCADO do build (userscript/build.mjs) — nunca publicar
// o bundle puro do esbuild.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';

const here = dirname(fileURLToPath(import.meta.url));
const HOST = '74.0.5.75';
const REMOTE_DIR = '/var/www/staffhub-updates/scripts';
const dist = join(here, '..', 'userscript', 'dist');
const userJsPath = join(dist, 'staff-hub-in-game.user.js');
const metaPath = join(dist, 'staff-hub-in-game.meta.js');
const sshKeyPath = process.env.STAFFHUB_VPS_KEY ?? fileURLToPath(new URL('../dist/vps/id_staffhub', import.meta.url));

for (const path of [userJsPath, metaPath, sshKeyPath]) {
  if (!existsSync(path)) {
    console.error(`Arquivo não encontrado: ${path}`);
    console.error('Rode antes: node userscript/build.mjs');
    process.exit(2);
  }
}

const userJs = readFileSync(userJsPath);
const version = /@version\s+(\S+)/.exec(userJs.toString())?.[1];
if (version === undefined) {
  console.error('Versão não encontrada no header do .user.js');
  process.exit(2);
}
const sha256 = createHash('sha256').update(userJs).digest('hex');

const conn = new ssh2.Client();
conn
  .on('ready', () => {
    conn.sftp((errSftp, sftp) => {
      if (errSftp) { console.error('SFTP_ERR', errSftp.message); conn.end(); process.exit(1); }
      sftp.mkdir(REMOTE_DIR, () => {
        // mkdir falha se já existe — segue.
        sftp.fastPut(userJsPath, `${REMOTE_DIR}/staff-hub-in-game-${version}.user.js`, (errUser) => {
          if (errUser) { console.error('UPLOAD_USER_JS_ERR', errUser.message); conn.end(); process.exit(1); }
          sftp.fastPut(userJsPath, `${REMOTE_DIR}/staff-hub-in-game.user.js`, (errLatest) => {
            if (errLatest) { console.error('UPLOAD_LATEST_ERR', errLatest.message); conn.end(); process.exit(1); }
            sftp.fastPut(metaPath, `${REMOTE_DIR}/staff-hub-in-game.meta.js`, (errMeta) => {
              if (errMeta) { console.error('UPLOAD_META_ERR', errMeta.message); conn.end(); process.exit(1); }
              console.log(`✓ Userscript v${version} publicado (ofuscado)`);
              console.log(`  sha256: ${sha256}`);
              console.log(`  Instalar:   http://${HOST}/staffhub/scripts/staff-hub-in-game.user.js`);
              console.log(`  @updateURL: http://${HOST}/staffhub/scripts/staff-hub-in-game.meta.js`);
              conn.end();
            });
          });
        });
      });
    });
  })
  .on('error', (error) => { console.error('SSH_ERR', error.message); process.exit(1); })
  .connect({
    host: HOST,
    port: 22,
    username: 'root',
    privateKey: readFileSync(sshKeyPath),
  });
