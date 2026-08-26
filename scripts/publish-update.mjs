// Publica um release no canal oficial de atualizações do Staff Hub (VPS + nginx).
// Uso: node scripts/publish-update.mjs <caminho-do-zip> <versão> <notas>
// Autenticação: chave SSH ed25519 em STAFFHUB_VPS_KEY (default: dist/vps/id_staffhub,
// que fica FORA do git). A senha root nunca entra no repo.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';

const HOST = '74.0.5.75';
const REMOTE_DIR = '/var/www/staffhub-updates';
const [zipPath, version, notes] = process.argv.slice(2);
const keyPath = process.env.STAFFHUB_VPS_KEY ?? fileURLToPath(new URL('../dist/vps/id_staffhub', import.meta.url));

if (!zipPath || !version || !notes) {
  console.error('uso: node scripts/publish-update.mjs <zip> <versão> <notas>');
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Versão inválida: ${version} (use X.Y.Z)`);
  process.exit(2);
}
if (!existsSync(zipPath)) {
  console.error(`Zip não encontrado: ${zipPath}`);
  process.exit(2);
}
if (!existsSync(keyPath)) {
  console.error(`Chave SSH não encontrada: ${keyPath} (exporte STAFFHUB_VPS_KEY)`);
  process.exit(2);
}

const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
const zipName = basename(zipPath);
const manifest = {
  version,
  notes,
  url: `http://${HOST}/staffhub/${zipName}`,
  sha256,
  releasedAt: new Date().toISOString(),
};

const conn = new ssh2.Client();
conn
  .on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) throw err;
      console.log(`Enviando ${zipName} (${(readFileSync(zipPath).length / 1048576).toFixed(1)} MB)…`);
      sftp.fastPut(zipPath, `${REMOTE_DIR}/${zipName}`, (errZip) => {
        if (errZip) { console.error('UPLOAD_ZIP_ERR', errZip.message); conn.end(); process.exit(1); }
        sftp.writeFile(`${REMOTE_DIR}/latest.json`, `${JSON.stringify(manifest, null, 2)}\n`, (errJson) => {
          if (errJson) { console.error('UPLOAD_JSON_ERR', errJson.message); conn.end(); process.exit(1); }
          console.log(`✓ v${version} publicada — latest.json + zip no canal`);
          console.log(JSON.stringify(manifest, null, 2));
          conn.end();
        });
      });
    });
  })
  .on('error', (err) => { console.error('SSH_ERR', err.message); process.exit(1); })
  .connect({ host: HOST, port: 22, username: 'root', privateKey: readFileSync(keyPath), readyTimeout: 15000 });
