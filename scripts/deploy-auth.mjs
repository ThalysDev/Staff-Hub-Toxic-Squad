// Deploy da API staffhub-auth na VPS (idempotente — pode rodar de novo à vontade).
// Faz: upload dos fontes → auth.env (JWT_SECRET persistente) → cert self-signed
// (SAN IP) → nginx :443 (NOVO server block, nada do :80 tocado) → PM2 do Thalys
// → cron de backup diário → seed do 1º admin (senha impressa UMA vez) → baixa o
// cert p/ src/main/assets/staffhub-ca.pem (pin do app) → smoke https.
// Uso: node scripts/deploy-auth.mjs [--reset-admin <nick>]
// Autenticação: chave SSH ed25519 em STAFFHUB_VPS_KEY (default dist/vps/id_staffhub) — root.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import ssh2 from 'ssh2';

const HOST = '74.0.5.75';
const keyPath = process.env.STAFFHUB_VPS_KEY ?? fileURLToPath(new URL('../dist/vps/id_staffhub', import.meta.url));
if (!existsSync(keyPath)) {
  console.error(`Chave SSH não encontrada: ${keyPath}`);
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const FONTES = ['server.mjs', 'db.mjs', 'auth.mjs', 'config.mjs', 'ratelimit.mjs', 'check-admin.mjs'];
const REMOTO = '/home/Thalys/staffhub-auth';

const resetIdx = process.argv.indexOf('--reset-admin');
const resetNick = resetIdx > -1 ? process.argv[resetIdx + 1] : null;

const NGINX_CONF = `# staffhub-auth — API do Staff Hub (TLS self-signed pinado no app).
server {
    listen 443 ssl;
    server_name 74.0.5.75;

    ssl_certificate     /etc/nginx/ssl/staffhub-api.crt;
    ssl_certificate_key /etc/nginx/ssl/staffhub-api.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    location /staffhub/api/ {
        proxy_pass http://127.0.0.1:8787/staffhub/api/;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Host $host;
        proxy_http_version 1.1;
    }
}
`;

const CRON_BACKUP = `# Backup diario do SQLite do staffhub-auth (retention 14 dias)
30 4 * * * Thalys bash -lc "node -e \\"const{DatabaseSync}=require('node:sqlite');new DatabaseSync('${REMOTO}/auth.db').exec(\\\\\\"VACUUM INTO '/var/backups/staffhub-auth/auth-'+new Date().toISOString().slice(0,10)+'.db'\\\\\\")\\" && find /var/backups/staffhub-auth -name 'auth-*.db' -mtime +14 -delete"
`;

const conn = new ssh2.Client();
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exec com 2 tentativas (sshd às vezes recusa canal em rajada: "open failed"). */
const run = async (cmd) => {
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await new Promise((res, rej) => {
        conn.exec(cmd, (err, stream) => {
          if (err) return rej(err);
          let out = '';
          let errOut = '';
          stream.on('data', (d) => (out += d));
          stream.stderr.on('data', (d) => (errOut += d));
          stream.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`${cmd}\n→ exit ${code}\n${errOut}`))));
        });
      });
    } catch (e) {
      if (tentativa >= 2 || !/open failed|Channel open/i.test(e.message)) throw e;
      await dormir(800);
    }
  }
};

/** Um ÚNICO canal SFTP para todo o deploy (limite de sessões do sshd). */
const sftpUna = () =>
  new Promise((res, rej) => conn.sftp((e, s) => (e ? rej(e) : res(s))));
const sftpPut = (sftp, localPath, remotePath) =>
  new Promise((res, rej) => {
    const data = readFileSync(localPath);
    sftp.writeFile(remotePath, data, { mode: 0o644 }, (err) => (err ? rej(err) : res()));
  });
const sftpWrite = (sftp, remotePath, conteudo) =>
  new Promise((res, rej) => sftp.writeFile(remotePath, conteudo, (err) => (err ? rej(err) : res())));

const senhaAdmin = randomBytes(6).toString('base64url').replace(/[-_]/g, 'x') + 'A1';

conn
  .on('ready', async () => {
    try {
      console.log('▸ Preparando diretórios');
      await run(`mkdir -p ${REMOTO} /etc/nginx/ssl /var/backups/staffhub-auth && chown Thalys:Thalys ${REMOTO} /var/backups/staffhub-auth`);

      console.log('▸ auth.env (JWT_SECRET preservado se já existir)');
      await run(
        `if [ ! -f ${REMOTO}/auth.env ]; then ` +
          `printf 'JWT_SECRET=%s\\nPORT=8787\\n' "$(openssl rand -hex 48)" > ${REMOTO}/auth.env; ` +
          `chown Thalys:Thalys ${REMOTO}/auth.env; chmod 600 ${REMOTO}/auth.env; echo NOVO; else echo EXISTENTE; fi`,
      );

      console.log('▸ Upload dos fontes');
      const sftp = await sftpUna();
      for (const f of FONTES) await sftpPut(sftp, join(root, 'vps/staffhub-auth', f), `${REMOTO}/${f}`);
      // seed-admin.mjs precisa existir também p/ reset/seed
      await sftpPut(sftp, join(root, 'vps/staffhub-auth/seed-admin.mjs'), `${REMOTO}/seed-admin.mjs`);
      await run(`chown Thalys:Thalys ${REMOTO}/*.mjs`);

      console.log('▸ Certificado self-signed (SAN IP, 825 dias)');
      await run(
        `if [ ! -f /etc/nginx/ssl/staffhub-api.crt ]; then openssl req -x509 -newkey rsa:2048 -nodes -days 825 ` +
          `-keyout /etc/nginx/ssl/staffhub-api.key -out /etc/nginx/ssl/staffhub-api.crt ` +
          `-subj "/CN=StaffHub Auth" -addext "subjectAltName=IP:${HOST}"; chmod 600 /etc/nginx/ssl/staffhub-api.key; fi`,
      );

      console.log('▸ nginx vhost :443 + reload');
      await sftpWrite(sftp, '/etc/nginx/conf.d/staffhub-api.conf', NGINX_CONF);
      await run('nginx -t && systemctl reload nginx');

      console.log('▸ UFW: liberar 443 se fechado');
      await run(`ufw status | grep -q "443/tcp" || ufw allow 443/tcp`);

      console.log('▸ PM2 (usuário Thalys)');
      await run(
        `runuser -u Thalys -- pm2 describe staffhub-auth >/dev/null 2>&1 ` +
          `&& runuser -u Thalys -- pm2 restart staffhub-auth --update-env ` +
          `|| runuser -u Thalys -- pm2 start ${REMOTO}/server.mjs --name staffhub-auth --cwd ${REMOTO}`,
      );
      await run(`runuser -u Thalys -- pm2 save`);

      console.log('▸ Cron de backup diário');
      await sftpWrite(sftp, '/etc/cron.d/staffhub-auth-backup', CRON_BACKUP);
      await run('chmod 644 /etc/cron.d/staffhub-auth-backup');

      console.log('▸ Seed do admin');
      const temAdmin = (
        await run(`cd ${REMOTO} && runuser -u Thalys -- bash -lc "AUTH_ENV=${REMOTO}/auth.env AUTH_DB_PATH=${REMOTO}/auth.db node check-admin.mjs"`)
      ).trim();
      if (temAdmin === '0' || resetNick) {
        const nick = resetNick ?? 'admin';
        await run(
          `runuser -u Thalys -- bash -lc "cd ${REMOTO} && AUTH_ENV=${REMOTO}/auth.env AUTH_DB_PATH=${REMOTO}/auth.db node seed-admin.mjs '${nick}' '${senhaAdmin}'"`,
        );
        console.log(`\n  ★ ADMIN: nick="${nick}" senha="${senhaAdmin}" (troque no 1º login; não guardamos em lugar algum)\n`);
      } else {
        console.log('  admin já existe (use --reset-admin <nick> para redefinir)');
      }

      console.log('▸ Baixando cert p/ pin do app (src/main/assets/staffhub-ca.pem)');
      const crt = await new Promise((res, rej) => sftp.readFile('/etc/nginx/ssl/staffhub-api.crt', (e2, buf) => (e2 ? rej(e2) : res(buf))));
      mkdirSync(join(root, 'src/main/assets'), { recursive: true });
      writeFileSync(join(root, 'src/main/assets/staffhub-ca.pem'), crt);
      console.log(`  ${basename(String(keyPath))} ok — cert salvo (${crt.length} bytes)`);

      console.log('▸ Smoke na VPS (https pelo nginx)');
      const smoke = await run(`curl -sS -m 8 --cacert /etc/nginx/ssl/staffhub-api.crt https://${HOST}/staffhub/api/healthz`);
      console.log('  ' + smoke.trim());

      conn.end();
      console.log('\n✅ Deploy staffhub-auth concluído.');
    } catch (e) {
      console.error('FALHA NO DEPLOY:', e.message);
      conn.end();
      process.exit(1);
    }
  })
  .on('error', (e) => {
    console.error('SSH:', e.message);
    process.exit(1);
  })
  .connect({ host: HOST, port: 22, username: 'root', privateKey: readFileSync(keyPath), readyTimeout: 15000 });
