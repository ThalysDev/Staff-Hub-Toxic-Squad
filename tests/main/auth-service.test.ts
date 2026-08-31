// AuthService (v0.30) — testes contra uma API fake HTTP LOCAL (node:http
// efêmero): login/pending/banido, rotação de refresh, 401 expulsa, modo
// guerra 72h com falha de rede, relógio recuado, gate exigeSessao e
// persistência via safeStorage (mock round-trip).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('electron', async () => {
  const { createElectronMock } = await import('./electron-mock');
  return createElectronMock();
});

import { resetElectronMock, disposeElectronMock } from './electron-mock';
import { AuthService } from '../../src/main/services/auth-service';
import { Journal } from '../../src/main/journal';

// ---- API fake (mesmos contratos da staffhub-auth real) ----

type Requisicao = { metodo: string; caminho: string; corpo: any; auth?: string };

let servidor: Server;
let baseUrl = '';
let requisicoes: Requisicao[] = [];
let respostas: Array<{ casa: (r: Requisicao) => boolean; status: number; corpo: any }> = [];

const atender = (req: Requisicao, res: any): void => {
  for (const regra of respostas) {
    if (regra.casa(req)) {
      res.writeHead(regra.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(regra.corpo));
      return;
    }
  }
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ erro: 'API fake sem rota' }));
};

beforeAll(async () => {
  servidor = createServer((req, res) => {
    let corpoTexto = '';
    req.on('data', (p) => (corpoTexto += p));
    req.on('end', () => {
      let corpo: any = {};
      try {
        corpo = corpoTexto === '' ? {} : JSON.parse(corpoTexto);
      } catch {}
      const requisicao: Requisicao = {
        metodo: req.method ?? 'GET',
        caminho: req.url ?? '/',
        corpo,
        auth: req.headers.authorization,
      };
      requisicoes.push(requisicao);
      atender(requisicao, res);
    });
  });
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const porta = (servidor.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${porta}`;
  process.env.SHS_AUTH_URL = baseUrl;
});

afterEach(() => {
  requisicoes = [];
  respostas = [];
  for (const servico of servicosCriados) servico.parar();
  servicosCriados.length = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => servidor.close(() => resolve()));
  delete process.env.SHS_AUTH_URL;
});

// ---- helpers ----

const ok200 = (corpo: any) => ({ status: 200, corpo });

function cenarioLoginOk(nick = 'Testador', role = 'staff') {
  respostas.push({
    casa: (r) => r.metodo === 'POST' && r.caminho.endsWith('/auth/login'),
    ...ok200({
      accessToken: `access-${nick}`,
      accessExpiraEm: Date.now() + 15 * 60_000,
      refreshToken: `refresh-${nick}-1`,
      sessaoAte: Date.now() + 30 * 24 * 3600_000,
      user: { nick, role, status: 'active' },
    }),
  });
}

async function novoServico() {
  const journal = new Journal();
  await journal.load();
  const eventos: any[] = [];
  const auth = new AuthService({ journal, onChange: (s) => eventos.push(s) });
  servicosCriados.push(auth);
  return { auth, eventos };
}

/** afterEach: mata os timers de renovação (senão gravam em userData já apagado). */
const servicosCriados: AuthService[] = [];

// ---- testes ----

describe('AuthService — login e estado', () => {
  beforeEach(() => resetElectronMock());

  it('boot sem sessão persistida → deslogado', async () => {
    const { auth } = await novoServico();
    await auth.boot();
    expect(auth.status()).toEqual({ estado: 'deslogado', user: null, offlineAte: null });
  });

  it('login ok → logado com user; erro vira PT-BR com code', async () => {
    const { auth } = await novoServico();
    cenarioLoginOk();
    const resultado = await auth.login('Testador', 'senha-forte');
    expect(resultado.ok).toBe(true);
    if (resultado.ok) expect(resultado.user.nick).toBe('Testador');
    expect(auth.status().estado).toBe('logado');
    expect(auth.status().user?.nick).toBe('Testador');

    // Novas regras: LIMPAM as antigas (a primeira que casa atende); o 403 só
    // vale para o nick Pendente, o 401 para o Errado.
    respostas.length = 0;
    respostas.push({
      casa: (r) => r.metodo === 'POST' && r.caminho.endsWith('/auth/login') && r.corpo?.nick === 'Pendente',
      status: 403,
      corpo: { erro: 'Conta aguardando aprovação do administrador.', code: 'pending' },
    });
    respostas.push({
      casa: (r) => r.metodo === 'POST' && r.caminho.endsWith('/auth/login') && r.corpo?.nick === 'Errado',
      status: 401,
      corpo: { erro: 'Nick ou senha incorretos.' },
    });
    const pendente = await auth.login('Pendente', 'x');
    expect(pendente).toEqual({ ok: false, erro: 'Conta aguardando aprovação do administrador.', code: 'pending' });
    const errado = await auth.login('Errado', 'y');
    expect(errado.ok).toBe(false);
    if (!errado.ok) expect(errado.code).toBeUndefined();
  });

  it('login com rede fora → erro code=rede', async () => {
    const { auth } = await novoServico();
    respostas.push({
      casa: () => false, // nenhuma rota: servidor "caído"? não — fetch local sempre conecta
    });
    // Sem rota casada = 500; para rede REALMENTE fora usamos URL inalcançável:
    process.env.SHS_AUTH_URL = 'http://127.0.0.1:1';
    const resultado = await auth.login('a', 'b');
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.code).toBe('rede');
    process.env.SHS_AUTH_URL = baseUrl;
  });
});

describe('AuthService — refresh, sessão única e expiração', () => {
  beforeEach(() => resetElectronMock());

  it('refresh 401 encerra a sessão (estado expirado + exigeSessao lança)', async () => {
    const { auth } = await novoServico();
    cenarioLoginOk();
    await auth.login('Testador', 'x');
    respostas.push({
      casa: (r) => r.metodo === 'POST' && r.caminho.endsWith('/auth/refresh'),
      status: 401,
      corpo: { erro: 'Sessão encerrada — faça login novamente.', code: 'sessao' },
    });
    await auth.refreshNow();
    expect(auth.status().estado).toBe('expirado');
    expect(() => auth.exigeSessao()).toThrow(/faça login novamente/i);
  });

  it('renovação silenciosa troca o refresh (rotação) e mantém logado', async () => {
    const { auth } = await novoServico();
    cenarioLoginOk();
    await auth.login('Testador', 'x');
    respostas.push({
      casa: (r) => r.metodo === 'POST' && r.caminho.endsWith('/auth/refresh'),
      status: 200,
      corpo: {
        accessToken: 'access-2',
        accessExpiraEm: Date.now() + 15 * 60_000,
        refreshToken: 'refresh-Testador-2',
        sessaoAte: Date.now() + 30 * 24 * 3600_000,
        user: { nick: 'Testador', role: 'staff', status: 'active' },
      },
    });
    const status = await auth.refreshNow();
    expect(status.estado).toBe('logado');
    const corpo = requisicoes.find((r) => r.caminho.endsWith('/auth/refresh'))?.corpo;
    expect(corpo?.refreshToken).toBe('refresh-Testador-1');
    expect(auth.accessTokenValido()).toBe('access-2');
  });

  it('modo guerra: falha de REDE no boot mantém a sessão offline (72h)', async () => {
    // 1ª fase: login ok em userData; 2ª: "VPS fora" (URL inalcançável).
    const { auth } = await novoServico();
    cenarioLoginOk('Guerra');
    await auth.login('Guerra', 'x');
    process.env.SHS_AUTH_URL = 'http://127.0.0.1:1';
    const { auth: auth2 } = await novoServico();
    await auth2.boot(); // refresh falha por rede → graça
    const status = auth2.status();
    expect(status.estado).toBe('offline');
    expect(status.user?.nick).toBe('Guerra');
    expect(status.offlineAte).toBeGreaterThan(Date.now() + 71 * 3600_000);
    // Offline é USÁVEL (a OP continua):
    expect(() => auth2.exigeSessao()).not.toThrow();
    process.env.SHS_AUTH_URL = baseUrl;
  });

  it('relógio recuado mata a graça offline (fail-closed)', async () => {
    const { auth } = await novoServico();
    cenarioLoginOk();
    await auth.login('Guerra', 'x');
    // Simula sessão persistida ontem com maxClockSeen futuro relativo ao agora.
    const store = (auth as unknown as { store: { save: (v: unknown) => Promise<void>; load: () => Promise<unknown> } }).store;
    const persistida = (await store.load()) as { maxClockSeen: number; ultimaValidacaoOk: number };
    await store.save({ ...persistida, maxClockSeen: Date.now() + 3600_000, ultimaValidacaoOk: Date.now() - 1000 });
    process.env.SHS_AUTH_URL = 'http://127.0.0.1:1';
    const { auth: auth2 } = await novoServico();
    await auth2.boot();
    expect(auth2.status().estado).toBe('expirado');
    process.env.SHS_AUTH_URL = baseUrl;
  });

  it('logout limpa estado e persistência', async () => {
    const { auth } = await novoServico();
    cenarioLoginOk();
    respostas.push({ casa: (r) => r.metodo === 'POST' && r.caminho.endsWith('/auth/logout'), ...ok200({ ok: true }) });
    await auth.login('Testador', 'x');
    await auth.logout();
    expect(auth.status().estado).toBe('deslogado');
    const { auth: auth2 } = await novoServico();
    await auth2.boot();
    expect(auth2.status().estado).toBe('deslogado');
  });
});

describe('AuthService — gate de produto', () => {
  beforeEach(() => resetElectronMock());

  it('exigeSessao lança PT-BR quando deslogado; libera quando logado', async () => {
    const { auth } = await novoServico();
    await auth.boot();
    expect(() => auth.exigeSessao()).toThrow(/faça login no staff hub/i);
    cenarioLoginOk();
    await auth.login('Testador', 'x');
    expect(() => auth.exigeSessao()).not.toThrow();
  });

  it('adminUsers usa GET (revisão 0.30.1: POST acertava 404 e quebrava o Admin)', async () => {
    const { auth } = await novoServico();
    cenarioLoginOk('Chefe', 'admin');
    await auth.login('Chefe', 'x');
    respostas.push({
      casa: (r) => r.metodo === 'GET' && r.caminho.endsWith('/admin/users'),
      status: 200,
      corpo: { users: [{ id: 'u1', nick: 'Testador', role: 'staff', status: 'pending', criadoEm: new Date().toISOString(), aprovadoEm: null }] },
    });
    respostas.push({
      casa: (r) => r.metodo === 'POST' && r.caminho.endsWith('/admin/users'),
      status: 404,
      corpo: { erro: 'Rota não encontrada.' },
    });
    const { users } = await auth.adminUsers();
    expect(users).toHaveLength(1);
    expect(users[0]?.nick).toBe('Testador');
    const chamada = requisicoes.find((r) => r.caminho.endsWith('/admin/users'));
    expect(chamada?.metodo).toBe('GET');
  });
});
