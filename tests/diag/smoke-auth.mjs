// Smoke local completo da API staffhub-auth: sobe server.mjs com DB/env em
// tmp, exercita TODOS os fluxos e afirma os contratos. Roda com node >= 22.
//   node tests/diag/smoke-auth.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const aqui = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'shs-auth-'));
const envPath = join(dir, 'auth.env');
// Porta FIXA: listen(0) pode cair em range reservado do Windows (EADDRNOTAVAIL).
writeFileSync(
  envPath,
  'JWT_SECRET=' + 'k'.repeat(64) + '\nPORT=18799\nLOGIN_MAX_FALHAS_IP=3\nLOGIN_MAX_FALHAS_NICK=2\n',
);

const server = spawn(process.execPath, [join(aqui, 'vps/staffhub-auth/server.mjs')], {
  env: { ...process.env, AUTH_ENV: envPath, AUTH_DB_PATH: join(dir, 'auth.db') },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let saida = '';
server.stdout.on('data', (d) => (saida += d));
server.stderr.on('data', (d) => (saida += d));

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let porta = 0;

async function esperarPorta() {
  for (let i = 0; i < 50; i++) {
    const m = /ouvindo em 127\.0\.0\.1:(\d+)/.exec(saida);
    if (m) {
      porta = Number(m[1]);
      return;
    }
    await dormir(100);
  }
  throw new Error('servidor não subiu:\n' + saida);
}

let falhas = 0;
function checar(nome, cond, extra) {
  if (cond) {
    console.log(`ok   ${nome}`);
  } else {
    falhas += 1;
    console.error(`FALHOU ${nome}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
  }
}

async function chamar(metodo, caminho, corpo, token, ip = '10.9.9.9') {
  const res = await fetch(`http://127.0.0.1:${porta}${caminho}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      'x-real-ip': ip,
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  let dados = null;
  try {
    dados = await res.json();
  } catch {}
  return { status: res.status, dados };
}

await esperarPorta();

// healthz
const h = await chamar('GET', '/staffhub/api/healthz');
checar('healthz ok', h.status === 200 && h.dados.ok === true, h);

// register + validações
checar('register nick inválido rejeitado', (await chamar('POST', '/staffhub/api/auth/register', { nick: 'a;b', senha: '12345678' })).status === 400);
checar('register senha curta rejeitada', (await chamar('POST', '/staffhub/api/auth/register', { nick: 'Testador', senha: '123' })).status === 400);
const r1 = await chamar('POST', '/staffhub/api/auth/register', { nick: 'Testador', senha: 'senha-forte-1' });
checar('register cria pendente', r1.status === 201, r1);
checar('register nick duplicado 409', (await chamar('POST', '/staffhub/api/auth/register', { nick: 'testador', senha: 'senha-forte-1' })).status === 409);

// login pendente
const lp = await chamar('POST', '/staffhub/api/auth/login', { nick: 'Testador', senha: 'senha-forte-1' });
checar('login pendente 403 code=pending', lp.status === 403 && lp.dados.code === 'pending', lp);

// seed admin + login admin
const seed = spawn(process.execPath, [join(aqui, 'vps/staffhub-auth/seed-admin.mjs'), 'Chefe', 'senha-admin-1'], {
  env: { ...process.env, AUTH_ENV: envPath, AUTH_DB_PATH: join(dir, 'auth.db') },
  stdio: 'inherit',
});
await new Promise((r) => seed.on('exit', r));
const la = await chamar('POST', '/staffhub/api/auth/login', { nick: 'Chefe', senha: 'senha-admin-1' });
checar('login admin ok', la.status === 200 && la.dados.user.role === 'admin', la);
const tokAdmin = la.dados.accessToken;
const refreshAdmin1 = la.dados.refreshToken;

// login errado (mensagem uniforme)
const le = await chamar('POST', '/staffhub/api/auth/login', { nick: 'Chefe', senha: 'errada123' });
checar('login errado 401 uniforme', le.status === 401 && le.dados.erro === 'Nick ou senha incorretos.', le);

// admin lista + aprova
const lu = await chamar('GET', '/staffhub/api/admin/users', undefined, tokAdmin);
checar('admin users lista', lu.status === 200 && lu.dados.users.length === 2, lu);
const pendente = lu.dados.users.find((u) => u.nick === 'Testador');
const idAdmin = lu.dados.users.find((u) => u.nick === 'Chefe').id;
checar('sem hash na listagem', !('senha_hash' in (lu.dados.users[0] ?? {})));
const ap = await chamar('POST', `/staffhub/api/admin/users/${pendente.id}/aprovar`, {}, tokAdmin);
checar('aprovar ok', ap.status === 200, ap);
checar('aprovar de novo 409', (await chamar('POST', `/staffhub/api/admin/users/${pendente.id}/aprovar`, {}, tokAdmin)).status === 409);

// não-admin barrado
const lt = await chamar('POST', '/staffhub/api/auth/login', { nick: 'Testador', senha: 'senha-forte-1' });
checar('login aprovado ok', lt.status === 200, lt);
checar('staff não acessa admin', (await chamar('GET', '/staffhub/api/admin/users', undefined, lt.dados.accessToken)).status === 403);

// me + trocar senha
const me = await chamar('GET', '/staffhub/api/auth/me', undefined, lt.dados.accessToken);
checar('me ok', me.status === 200 && me.dados.user.nick === 'Testador', me);
checar('me sem token 401', (await chamar('GET', '/staffhub/api/auth/me')).status === 401);
const ts = await chamar('POST', '/staffhub/api/auth/trocar-senha', { senhaAtual: 'senha-forte-1', senhaNova: 'senha-nova-9' }, lt.dados.accessToken);
checar('trocar senha ok e revoga sessão', ts.status === 200, ts);
checar('refresh pós-troca 401', (await chamar('POST', '/staffhub/api/auth/refresh', { refreshToken: lt.dados.refreshToken })).status === 401);
const lt2 = await chamar('POST', '/staffhub/api/auth/login', { nick: 'Testador', senha: 'senha-nova-9' });
checar('login com senha nova ok', lt2.status === 200, lt2);

// refresh rotativo + reuso
const rf1 = await chamar('POST', '/staffhub/api/auth/refresh', { refreshToken: lt2.dados.refreshToken });
checar('refresh rotativo ok', rf1.status === 200 && rf1.dados.refreshToken !== lt2.dados.refreshToken, rf1);
const reuso = await chamar('POST', '/staffhub/api/auth/refresh', { refreshToken: lt2.dados.refreshToken });
checar('reuso do refresh antigo 401', reuso.status === 401, reuso);
const rf2 = await chamar('POST', '/staffhub/api/auth/refresh', { refreshToken: rf1.dados.refreshToken });
checar('família morta pelo reuso → novo também 401', rf2.status === 401, rf2);

// sessão dupla: login novo expulsa o antigo
const s1 = await chamar('POST', '/staffhub/api/auth/login', { nick: 'Testador', senha: 'senha-nova-9' });
const s2 = await chamar('POST', '/staffhub/api/auth/login', { nick: 'Testador', senha: 'senha-nova-9' });
checar('dois logins ok', s1.status === 200 && s2.status === 200);
checar('refresh do 1º login expulso', (await chamar('POST', '/staffhub/api/auth/refresh', { refreshToken: s1.dados.refreshToken })).status === 401);

// banir + expulsão + reset (ANTES do rate-limit, que suja o nick do Testador)
const ban = await chamar('POST', `/staffhub/api/admin/users/${pendente.id}/banir`, {}, tokAdmin);
checar('banir ok', ban.status === 200, ban);
checar('refresh do banido 401', (await chamar('POST', '/staffhub/api/auth/refresh', { refreshToken: s2.dados.refreshToken })).status === 401);
const lb = await chamar('POST', '/staffhub/api/auth/login', { nick: 'Testador', senha: 'senha-nova-9' }, undefined, '10.1.1.1');
checar('login banido 403 code=banned', lb.status === 403 && lb.dados.code === 'banned', lb);
const reab = await chamar('POST', `/staffhub/api/admin/users/${pendente.id}/reabilitar`, {}, tokAdmin);
checar('reabilitar ok', reab.status === 200, reab);
const rs = await chamar('POST', `/staffhub/api/admin/users/${pendente.id}/resetar-senha`, {}, tokAdmin);
checar('resetar senha devolve temporária', rs.status === 200 && typeof rs.dados.senhaTemporaria === 'string' && rs.dados.senhaTemporaria.length === 12, rs);
const lr = await chamar('POST', '/staffhub/api/auth/login', { nick: 'Testador', senha: rs.dados.senhaTemporaria }, undefined, '10.1.1.2');
checar('login com temporária ok', lr.status === 200, lr);

// proteção do último admin
checar('banir único admin 409', (await chamar('POST', `/staffhub/api/admin/users/${idAdmin}/banir`, {}, tokAdmin)).status === 409);

// rate-limit por nick (config de teste: 2 falhas) — por ÚLTIMO, suja o nick
await chamar('POST', '/staffhub/api/auth/login', { nick: 'Testador', senha: 'x1' });
await chamar('POST', '/staffhub/api/auth/login', { nick: 'Testador', senha: 'x2' });
const rl = await chamar('POST', '/staffhub/api/auth/login', { nick: 'Testador', senha: rs.dados.senhaTemporaria });
checar('lockout por tentativas 429', rl.status === 429, rl);

// audit + logout
const au = await chamar('GET', '/staffhub/api/admin/audit', undefined, tokAdmin);
checar('audit lista eventos', au.status === 200 && au.dados.eventos.length > 0, au);
checar('logout ok', (await chamar('POST', '/staffhub/api/auth/logout', { refreshToken: refreshAdmin1 })).status === 200);

server.kill();
await dormir(300);
// No Windows o filho pode sobreviver ao kill do pai: kill forçado por PID.
if (process.platform === 'win32' && server.pid) {
  try {
    spawn('taskkill', ['/PID', String(server.pid), '/F', '/T'], { stdio: 'ignore' });
  } catch {}
  await dormir(300);
}
rmSync(dir, { recursive: true, force: true });
console.log(falhas === 0 ? '\nSMOKE 100% VERDE' : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
