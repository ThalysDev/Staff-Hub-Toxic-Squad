// staffhub-auth — servidor HTTP (loopback; o nginx faz TLS :443 na frente).
// Sem framework: roteamento manual, JSON puro, respostas PT-BR padronizadas.
// Regra de sessão: 1 refresh ativo por usuário (login novo revoga o anterior).
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { audit, nowIso, q } from './db.mjs';
import {
  assinarAccess,
  hashSenha,
  hashToken,
  novoRefresh,
  senhaTemporaria,
  verificarAccess,
  verificarSenha,
} from './auth.mjs';
import { podeTentar, registrarFalha } from './ratelimit.mjs';

const VERSAO = '1.0.0';
const PREFIXO = '/staffhub/api';
const NICK_RE = /^[\p{L}\p{N}_.\- ]{2,40}$/u;

const json = (res, status, corpo) => {
  const corpoTexto = JSON.stringify(corpo);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(corpoTexto);
};
const erro = (res, status, mensagem, code) => json(res, status, code === undefined ? { erro: mensagem } : { erro: mensagem, code });

/** Lê corpo JSON até 10 KB. */
function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let tamanho = 0;
    const pedacos = [];
    req.on('data', (pedaco) => {
      tamanho += pedaco.length;
      if (tamanho > 10_240) {
        reject(new Error('corpo grande'));
        req.destroy();
        return;
      }
      pedacos.push(pedaco);
    });
    req.on('end', () => {
      if (pedacos.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(pedacos).toString('utf8')));
      } catch {
        reject(new Error('json'));
      }
    });
    req.on('error', reject);
  });
}

const ipDe = (req) => {
  const viaProxy = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1';
  const real = req.headers['x-real-ip'];
  // Só confiamos no header quando a conexão veio do nginx local (bind loopback).
  return viaProxy && typeof real === 'string' && real !== '' ? real : req.socket.remoteAddress ?? '?';
};

function exigirAccess(req) {
  const authz = req.headers.authorization;
  if (typeof authz !== 'string' || !authz.startsWith('Bearer ')) return null;
  return verificarAccess(authz.slice('Bearer '.length));
}

function emitirSessao(user, req, motivoEvento) {
  // Sessão única: qualquer refresh anterior morre AGORA (login novo expulsa).
  q.revogarTodosDoUser.run(user.id);
  const refresh = novoRefresh(user.id);
  q.inserirRefresh.run(randomUUID(), user.id, refresh.tokenHash, refresh.familia, refresh.expiraEm, nowIso());
  const access = assinarAccess(user);
  const versao = String(req.headers['x-app-version'] ?? '?');
  audit(user.nick, motivoEvento, `ip=${ipDe(req)} versao=${versao}`);
  return {
    accessToken: access.token,
    accessExpiraEm: access.expiraEm,
    refreshToken: refresh.token,
    sessaoAte: refresh.expiraEm,
    user: { nick: user.nick, role: user.role, status: user.status },
  };
}

const rotas = [];

const rota = (metodo, caminho, handler) => rotas.push({ metodo, caminho, handler });

// ---- healthz ----
rota('GET', `${PREFIXO}/healthz`, async (_req, res) => {
  json(res, 200, { ok: true, versao: VERSAO, uptimeS: Math.floor(process.uptime()), usuarios: q.contarUsers.get()?.n ?? 0 });
});

// ---- registro (aberto; nasce pendente) ----
rota('POST', `${PREFIXO}/auth/register`, async (req, res, corpo) => {
  const nick = String(corpo.nick ?? '').trim();
  const senha = String(corpo.senha ?? '');
  if (!NICK_RE.test(nick)) {
    return erro(res, 400, 'Nick inválido — use 2 a 40 caracteres (letras, números, espaço, . _ -).');
  }
  if (senha.length < 8 || senha.length > 128) {
    return erro(res, 400, 'A senha precisa ter entre 8 e 128 caracteres.');
  }
  if (q.userPorNick.get(nick) !== undefined) {
    return erro(res, 409, 'Este nick já está cadastrado.');
  }
  const { salt, hash } = hashSenha(senha);
  const id = randomUUID();
  q.inserirUser.run(id, nick, hash, salt, 'staff', 'pending', nowIso());
  audit(nick, 'register', `ip=${ipDe(req)}`);
  json(res, 201, { ok: true, mensagem: 'Conta criada! Aguardando aprovação do administrador.' });
});

// ---- login ----
rota('POST', `${PREFIXO}/auth/login`, async (req, res, corpo) => {
  const nick = String(corpo.nick ?? '').trim();
  const senha = String(corpo.senha ?? '');
  const ip = ipDe(req);
  const limite = podeTentar(ip, nick);
  if (!limite.ok) return erro(res, 429, limite.motivo, 'rate');

  const user = q.userPorNick.get(nick);
  if (user === undefined || !verificarSenha(senha, user.salt, user.senha_hash)) {
    registrarFalha(ip, nick);
    // Mensagem uniforme: não vaza se o nick existe.
    return erro(res, 401, 'Nick ou senha incorretos.');
  }
  if (user.status === 'pending') return erro(res, 403, 'Conta aguardando aprovação do administrador.', 'pending');
  if (user.status === 'banned') return erro(res, 403, 'Conta banida — fale com o administrador.', 'banned');

  json(res, 200, emitirSessao(user, req, 'login'));
});

// ---- refresh (rotativo; reuso revoga família) ----
rota('POST', `${PREFIXO}/auth/refresh`, async (req, res, corpo) => {
  const token = String(corpo.refreshToken ?? '');
  if (token === '') return erro(res, 400, 'Requisição inválida.');
  const registro = q.refreshPorHash.get(hashToken(token));
  if (registro === undefined) return erro(res, 401, 'Sessão encerrada — faça login novamente.', 'sessao');
  if (registro.revogado === 1 && registro.expira_em > Date.now()) {
    q.revogarFamilia.run(registro.familia);
    audit('sistema', 'refresh-reuso', `familia=${registro.familia.slice(0, 8)} user=${registro.user_id}`);
    return erro(res, 401, 'Sessão encerrada — faça login novamente.', 'sessao');
  }
  if (registro.revogado === 1 || registro.expira_em <= Date.now()) {
    return erro(res, 401, 'Sessão encerrada — faça login novamente.', 'sessao');
  }
  const user = q.userPorId.get(registro.user_id);
  if (user === undefined || user.status !== 'active') {
    q.revogarFamilia.run(registro.familia);
    return erro(res, 401, 'Sessão encerrada — faça login novamente.', 'sessao');
  }
  // Rotação: o token usado morre, nasce um novo da MESMA família (renovação
  // silenciosa não expulsa a sessão — só login novo em outro lugar expulsa;
  // e o reuso de um token já rotacionado mata a família inteira).
  q.revogarFamilia.run(registro.familia);
  const novo = novoRefresh(user.id, registro.familia);
  q.inserirRefresh.run(randomUUID(), user.id, novo.tokenHash, novo.familia, novo.expiraEm, nowIso());
  const access = assinarAccess(user);
  json(res, 200, {
    accessToken: access.token,
    accessExpiraEm: access.expiraEm,
    refreshToken: novo.token,
    sessaoAte: novo.expiraEm,
    user: { nick: user.nick, role: user.role, status: user.status },
  });
});

// ---- logout ----
rota('POST', `${PREFIXO}/auth/logout`, async (req, res, corpo) => {
  const token = String(corpo.refreshToken ?? '');
  if (token !== '') {
    const registro = q.refreshPorHash.get(hashToken(token));
    if (registro !== undefined) q.revogarFamilia.run(registro.familia);
  }
  json(res, 200, { ok: true });
});

// ---- me (autenticado) ----
rota('GET', `${PREFIXO}/auth/me`, async (req, res) => {
  const payload = exigirAccess(req);
  if (payload === null) return erro(res, 401, 'Sessão do sistema expirada — faça login novamente.', 'sessao');
  const user = q.userPorId.get(payload.sub);
  if (user === undefined || user.status !== 'active') return erro(res, 401, 'Sessão encerrada — faça login novamente.', 'sessao');
  const ate = q.expiraFamiliaPorUser.get(user.id)?.ate ?? 0;
  json(res, 200, { user: { nick: user.nick, role: user.role, status: user.status }, sessaoAte: ate });
});

// ---- trocar senha (autenticado) ----
rota('POST', `${PREFIXO}/auth/trocar-senha`, async (req, res, corpo) => {
  const payload = exigirAccess(req);
  if (payload === null) return erro(res, 401, 'Sessão do sistema expirada — faça login novamente.', 'sessao');
  const user = q.userPorId.get(payload.sub);
  if (user === undefined) return erro(res, 401, 'Sessão encerrada — faça login novamente.', 'sessao');
  const atual = String(corpo.senhaAtual ?? '');
  const nova = String(corpo.senhaNova ?? '');
  if (!verificarSenha(atual, user.salt, user.senha_hash)) return erro(res, 403, 'Senha atual incorreta.');
  if (nova.length < 8 || nova.length > 128) return erro(res, 400, 'A nova senha precisa ter entre 8 e 128 caracteres.');
  const { salt, hash } = hashSenha(nova);
  q.atualizarSenha.run(hash, salt, user.id);
  q.revogarTodosDoUser.run(user.id);
  audit(user.nick, 'trocar-senha', `ip=${ipDe(req)}`);
  json(res, 200, { ok: true, mensagem: 'Senha alterada — entre novamente com a nova senha.' });
});

// ---- admin ----
const exigirAdmin = (req, res) => {
  const payload = exigirAccess(req);
  if (payload === null) {
    erro(res, 401, 'Sessão do sistema expirada — faça login novamente.', 'sessao');
    return null;
  }
  if (payload.role !== 'admin') {
    erro(res, 403, 'Apenas administradores.');
    return null;
  }
  return payload;
};

rota('GET', `${PREFIXO}/admin/users`, async (req, res) => {
  if (exigirAdmin(req, res) === null) return;
  json(res, 200, { users: q.listarUsers.all() });
});

rota('GET', `${PREFIXO}/admin/audit`, async (req, res) => {
  if (exigirAdmin(req, res) === null) return;
  json(res, 200, { eventos: q.listarAudit.all() });
});

const ACOES = {
  aprovar: { de: 'pending', para: 'active' },
  banir: { de: null, para: 'banned' },
  reabilitar: { de: 'banned', para: 'active' },
};

rota('POST', `${PREFIXO}/admin/users/:id/:acao`, async (req, res, corpo, params) => {
  const admin = exigirAdmin(req, res);
  if (admin === null) return;
  const alvo = q.userPorId.get(params.id);
  if (alvo === undefined) return erro(res, 404, 'Usuário não encontrado.');
  // resetar-senha é ação própria (fora do mapa de status) — checar ANTES dele.
  if (params.acao === 'resetar-senha') {
    const temp = senhaTemporaria();
    const { salt, hash } = hashSenha(temp);
    q.atualizarSenha.run(hash, salt, alvo.id);
    q.revogarTodosDoUser.run(alvo.id);
    audit(admin.nick, 'admin-resetar-senha', `alvo=${alvo.nick}`);
    return json(res, 200, { ok: true, senhaTemporaria: temp, mensagem: 'Senha temporária gerada — repasse ao jogador e oriente a trocar no 1º login.' });
  }
  const acao = ACOES[params.acao];
  if (acao === undefined) return erro(res, 404, 'Ação desconhecida.');
  if (acao.de !== null && alvo.status !== acao.de) {
    return erro(res, 409, `Ação inválida para o status atual (${alvo.status}).`);
  }
  if (params.acao === 'banir' && alvo.role === 'admin' && (q.contarUsers.get()?.n ?? 0) > 1) {
    const admins = q.listarUsers.all().filter((u) => u.role === 'admin' && u.status === 'active');
    if (admins.length <= 1) return erro(res, 409, 'Não é possível banir o único administrador ativo.');
  }
  q.setStatus.run(acao.para, acao.para === 'active' ? nowIso() : alvo.aprovado_em, alvo.id);
  if (params.acao === 'banir') q.revogarTodosDoUser.run(alvo.id);
  audit(admin.nick, `admin-${params.acao}`, `alvo=${alvo.nick}`);
  json(res, 200, { ok: true });
});

// ---- despacho ----
/** "/prefixo/:id/:acao" → regex nomeada; segmentos fixos escapados. */
const rotaParaRegex = (caminho) =>
  new RegExp(
    '^' +
      caminho
        .split('/')
        .map((p) =>
          p.startsWith(':') ? `(?<${p.slice(1)}>[^/]+)` : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('/') +
      '$',
  );

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    for (const r of rotas) {
      const casou = rotaParaRegex(r.caminho).exec(url.pathname);
      if (casou !== null && (r.metodo === req.method || (r.metodo === 'GET' && req.method === 'HEAD'))) {
        const corpo = req.method === 'GET' || req.method === 'HEAD' ? {} : await lerCorpo(req);
        await r.handler(req, res, corpo, casou.groups ?? {});
        return;
      }
    }
    erro(res, 404, 'Rota não encontrada.');
  } catch (e) {
    if (e instanceof Error && (e.message === 'json' || e.message === 'corpo grande')) {
      return erro(res, 400, 'Requisição inválida.');
    }
    console.error('[staffhub-auth] erro não tratado:', e);
    erro(res, 500, 'Erro interno do servidor.');
  }
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[staffhub-auth] v${VERSAO} ouvindo em 127.0.0.1:${config.port}`);
});

for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => {
    console.log(`[staffhub-auth] ${sinal} recebido, encerrando.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
