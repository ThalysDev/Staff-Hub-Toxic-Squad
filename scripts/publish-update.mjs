// Publica um release no canal oficial de atualizações do Staff Hub (VPS + nginx).
// Uso: node scripts/publish-update.mjs <caminho-do-zip> <versão> <notas>
// Autenticação SSH: chave ed25519 em STAFFHUB_VPS_KEY (default: dist/vps/id_staffhub,
// que fica FORA do git). A senha root nunca entra no repo.
//
// Hardening 0.36.0 (canal é HTTP puro — a integridade vem da ASSINATURA, não do
// transporte):
// - O manifest (latest.json) sai ASSINADO com a chave privada Ed25519 de
//   dist/vps/update-keys/update-private.key (gerada por
//   scripts/generate-update-keys.mjs). Sem chave → erro ANTES de conectar.
// - O comprimento das notas é VALIDADO contra MAX_NOTES_LENGTH (mesmo teto que
//   o client rejeita) — publicar notas gigantes era morte silenciosa do update.
// - O manifest pronto é validado pelo MESMO isValidManifest do client antes de
//   qualquer upload: publicar manifesto venenoso ficou impossível.
// - Novo versions.json: inventário de TODAS as versões publicadas
//   [{version, url, sha256, sig, releasedAt}] — alimenta o rollback. O `sig` da
//   entrada cobre a MESMA string canônica com notes VAZIO (canônico
//   `${version}\n${url}\n${sha256}\n0`), que é o que o prepareVersion verifica.
//   Escrita ATÔMICA (arquivo temporário + rename), preservando o que já existe.
import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import {
  isValidManifest,
  manifestCanonicalString,
  MAX_NOTES_LENGTH,
  verifyManifestSignature,
} from '../src/shared/updater-core.ts';

const HOST = '74.0.5.75';
const REMOTE_DIR = '/var/www/staffhub-updates';
const [zipPath, version, notes] = process.argv.slice(2);
const sshKeyPath = process.env.STAFFHUB_VPS_KEY ?? fileURLToPath(new URL('../dist/vps/id_staffhub', import.meta.url));
const updatePrivKeyPath = fileURLToPath(new URL('../dist/vps/update-keys/update-private.key', import.meta.url));

// ---- Guardas LOCAIS (todas antes de abrir conexão) ------------------------

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
if (!existsSync(sshKeyPath)) {
  console.error(`Chave SSH não encontrada: ${sshKeyPath} (exporte STAFFHUB_VPS_KEY)`);
  process.exit(2);
}
if (!existsSync(updatePrivKeyPath)) {
  console.error(`Chave de assinatura NÃO encontrada: ${updatePrivKeyPath}`);
  console.error('Gere o par de chaves do canal com: node scripts/generate-update-keys.mjs');
  console.error('(a pública impressa precisa estar em UPDATE_PUBKEY_B64, em src/shared/updater-core.ts)');
  process.exit(2);
}
// Mesmo teto que o client (isValidManifest) — notas maiores viram manifesto que
// TODO client rejeita (morte silenciosa do update). Falha ANTES do upload.
if (notes.length > MAX_NOTES_LENGTH) {
  console.error(`Notas com ${notes.length} caracteres — o teto do canal é ${MAX_NOTES_LENGTH} (MAX_NOTES_LENGTH em src/shared/updater-core.ts).`);
  console.error('Encurte as notas e rode de novo — nada foi publicado.');
  process.exit(2);
}

let chavePrivada;
try {
  chavePrivada = createPrivateKey(readFileSync(updatePrivKeyPath));
} catch (error) {
  console.error(`Chave de assinatura ilegível em ${updatePrivKeyPath}: ${error.message}`);
  console.error('Gere outro par com: node scripts/generate-update-keys.mjs --force');
  process.exit(2);
}
const assinar = (canonico) => cryptoSign(null, Buffer.from(canonico, 'utf8'), chavePrivada).toString('base64');

const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
const zipName = basename(zipPath);
const url = `http://${HOST}/staffhub/${zipName}`;
const releasedAt = new Date().toISOString();
const manifest = {
  version,
  notes,
  url,
  sha256,
  releasedAt,
  // Assinatura sobre a MESMA string canônica que o client verifica.
  sig: assinar(manifestCanonicalString({ version, notes, url, sha256 })),
};

// Espelho do isValidManifest do client — se o client rejeitaria, aqui NEM sobe.
if (isValidManifest(manifest) === null) {
  console.error('Manifest gerado foi REJEITADO pela validação do próprio client (isValidManifest) — nada foi publicado.');
  console.error('Confira: versão X.Y.Z, url http(s) com caminho, sha256 64-hex, releasedAt parseável, notas <= teto e assinatura.');
  process.exit(2);
}
console.log(`✓ Manifest assinado e validado pelo mesmo isValidManifest do client (notas: ${notes.length}/${MAX_NOTES_LENGTH}).`);

// Escrita atômica no VPS: grava em <arquivo>.tmp e renomeia por cima (o client
// nunca lê um JSON pela metade). posix-rename do OpenSSH; fallback unlink+rename.
function escreverAtomico(sftp, remoto, texto, cb) {
  const tmp = `${remoto}.tmp`;
  sftp.writeFile(tmp, texto, (errWrite) => {
    if (errWrite) { cb(errWrite); return; }
    const concluir = (errRename) => { cb(errRename ?? null); };
    if (typeof sftp.ext_openssh_rename === 'function') {
      sftp.ext_openssh_rename(tmp, remoto, concluir);
    } else {
      sftp.unlink(remoto, () => sftp.rename(tmp, remoto, concluir));
    }
  });
}

const conn = new ssh2.Client();
conn
  .on('ready', () => {
    conn.sftp((errSftp, sftp) => {
      if (errSftp) { console.error('SFTP_ERR', errSftp.message); conn.end(); process.exit(1); }

      console.log(`Enviando ${zipName} (${(readFileSync(zipPath).length / 1048576).toFixed(1)} MB)…`);
      sftp.fastPut(zipPath, `${REMOTE_DIR}/${zipName}`, (errZip) => {
        if (errZip) { console.error('UPLOAD_ZIP_ERR', errZip.message); conn.end(); process.exit(1); }

        // Inventário: baixa o versions.json atual, valida cada entrada antiga
        // (mesma assinatura de canônico com notes vazio) e faz upsert da nova.
        sftp.readFile(`${REMOTE_DIR}/versions.json`, (errRead, bruto) => {
          let inventario = [];
          if (errRead) {
            if (errRead.code !== 2) { console.error('READ_VERSIONS_ERR', errRead.message); conn.end(); process.exit(1); }
            // 404: primeiro publish com inventário — começa do zero.
          } else {
            try {
              const lista = JSON.parse(bruto.toString('utf8'));
              if (!Array.isArray(lista)) throw new Error('versions.json remoto não é um array');
              for (const item of lista) {
                const entrada = (item ?? {});
                const integridade =
                  typeof entrada.version === 'string' && /^\d+\.\d+\.\d+$/.test(entrada.version) &&
                  typeof entrada.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entrada.sha256) &&
                  typeof entrada.releasedAt === 'string' && !Number.isNaN(Date.parse(entrada.releasedAt)) &&
                  // O canônico da entrada é com notes VAZIO — mesma verificação do client.
                  verifyManifestSignature({ ...entrada, notes: '' });
                if (!integridade) { console.warn(`⚠ Entrada ${entrada.version ?? '?'} inválida no inventário — descartada.`); continue; }
                inventario.push(entrada);
              }
            } catch (error) {
              // Não sobrescreve inventário ilegível por cima do silêncio: falha alto.
              console.error(`versions.json remoto corrompido: ${error.message} — resolva manualmente em ${REMOTE_DIR}/versions.json antes de publicar.`);
              conn.end();
              process.exit(1);
            }
          }

          const entradaNova = { version, url, sha256, sig: assinar(manifestCanonicalString({ version, notes: '', url, sha256 })), releasedAt };
          inventario = inventario.filter((e) => e.version !== version);
          inventario.push(entradaNova);
          inventario.sort((a, b) => {
            const [ma, mi, pa] = a.version.split('.').map(Number);
            const [mb, mim, pb] = b.version.split('.').map(Number);
            return (ma - mb) || (mi - mim) || (pa - pb);
          });

          escreverAtomico(sftp, `${REMOTE_DIR}/versions.json`, `${JSON.stringify(inventario, null, 2)}\n`, (errVers) => {
            if (errVers) { console.error('UPLOAD_VERSIONS_ERR', errVers.message); conn.end(); process.exit(1); }
            console.log(`✓ Inventário versions.json atualizado (${inventario.length} versões).`);

            // latest.json por ÚLTIMO: é o ponteiro que os clients consomem —
            // só vira depois que zip + inventário já estão no ar.
            escreverAtomico(sftp, `${REMOTE_DIR}/latest.json`, `${JSON.stringify(manifest, null, 2)}\n`, (errJson) => {
              if (errJson) { console.error('UPLOAD_JSON_ERR', errJson.message); conn.end(); process.exit(1); }
              console.log(`✓ v${version} publicada — latest.json (assinado) + versions.json + zip no canal`);
              console.log(JSON.stringify(manifest, null, 2));
              conn.end();
            });
          });
        });
      });
    })
  })
  .on('error', (err) => { console.error('SSH_ERR', err.message); process.exit(1); })
  .connect({ host: HOST, port: 22, username: 'root', privateKey: readFileSync(sshKeyPath), readyTimeout: 15000 });
