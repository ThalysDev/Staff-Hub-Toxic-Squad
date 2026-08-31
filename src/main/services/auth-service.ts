// AuthService — sessão do SISTEMA (staffhub-auth na VPS, v0.30).
// Pontos de decisão:
// - Todo acesso à API sai DAQUI (main), com o cert pinado (STAFFHUB_CA_PEM);
//   o renderer JAMAIS vê tokens.
// - Refresh token em disco via safeStorage (DPAPI do Windows) — nunca plano.
// - Modo guerra 72h: falha de REDE no refresh mantém a sessão (estado
//   'offline', offlineAte = última validação + 72h); 401 encerra de verdade.
// - maxClockSeen: recuo de relógio do sistema mata a graça offline (avanço
//   ilimitado não é detectável — limite aceito e documentado).
// - Sessão única é do servidor: login em outro lugar revoga o refresh daqui;
//   o próximo refresh devolve 401 e o estado vira 'expirado'.

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { app, safeStorage } from 'electron';
import { STAFFHUB_CA_PEM } from '../auth-ca';
import { JsonStore } from '../stores/json-store';
import type { Journal } from '../journal';
import type {
  AdminUserRow,
  AuthAdminAudit,
  AuthLoginResultado,
  AuthStatus,
  AuthUser,
} from '@shared/ipc-types';

/** URL da API (const no boot quebraria testes/E2E: override via env a cada chamada). */
const baseUrl = (): string => process.env.SHS_AUTH_URL ?? 'https://74.0.5.75';
const MODO_GUERRA_MS = 72 * 60 * 60 * 1000;
const RENOVA_EVERY_MS = 10 * 60 * 1000;

interface SessaoPersistida {
  /** Refresh token cifrado pelo safeStorage (base64 do blob). */
  refreshBlob: string;
  user: AuthUser;
  accessExpiraEm: number;
  sessaoAte: number;
  ultimaValidacaoOk: number;
  maxClockSeen: number;
}

interface SessaoViva extends SessaoPersistida {
  refreshToken: string;
  accessToken: string;
}

function agoraSegura(maxClockSeen: number): number {
  const agora = Date.now();
  return agora >= maxClockSeen ? agora : Number.NaN; // relógio recuou
}

/** Versão do app para a auditoria de login (x-app-version). */
const APP_VERSION = (() => {
  try {
    return app.getVersion();
  } catch {
    return '';
  }
})();

function headersDe(corpo: Buffer, accessToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(corpo.length),
    'x-app-version': APP_VERSION,
  };
  if (accessToken !== undefined) headers.authorization = `Bearer ${accessToken}`;
  return headers;
}

/** POST JSON com CA pinada (https) ou direto (http — só testes/E2E). */
function postJson(baseUrl: string, caminho: string, corpo: unknown, accessToken?: string): Promise<{ status: number; dados: any }> {
  const url = new URL(caminho, baseUrl);
  const payload = Buffer.from(JSON.stringify(corpo ?? {}));
  const headers = headersDe(payload, accessToken);
  const usarHttps = url.protocol === 'https:';
  return new Promise((resolve, reject) => {
    const requisicao = (usarHttps ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (usarHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        ...(usarHttps ? { ca: STAFFHUB_CA_PEM, servername: '' } : {}),
        timeout: 12_000,
      },
      (resposta) => {
        let corpoTexto = '';
        resposta.on('data', (pedaco) => (corpoTexto += pedaco));
        resposta.on('end', () => {
          let dados: any = null;
          try {
            dados = JSON.parse(corpoTexto);
          } catch {
            /* corpo não-JSON vira null */
          }
          resolve({ status: resposta.statusCode ?? 0, dados });
        });
      },
    );
    requisicao.on('timeout', () => requisicao.destroy(new Error('Tempo esgotado falando com o servidor de login.')));
    requisicao.on('error', reject);
    requisicao.end(payload);
  });
}

export class AuthService {
  private readonly store = new JsonStore<SessaoPersistida | null>('auth-session', null);
  private sessao: SessaoViva | null = null;
  private expirado = false;
  /** true quando a última renovação falhou por REDE (VPS fora) — base do
   *  estado 'offline' (modo guerra 72h). Limpa no primeiro sucesso. */
  private redeFalhando = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onChange: (status: AuthStatus) => void;
  private readonly journal: Journal;
  private carregando: Promise<void> | null = null;

  constructor(deps: { journal: Journal; onChange: (status: AuthStatus) => void }) {
    this.journal = deps.journal;
    this.onChange = deps.onChange;
  }

  // ---- ciclo de vida ----

  async boot(): Promise<void> {
    if (this.carregando !== null) {
      await this.carregando;
      return;
    }    this.carregando = (async () => {
      const persistida = await this.store.load();
      if (persistida !== null && persistida.refreshBlob !== '' && safeStorage.isEncryptionAvailable()) {
        try {
          const refreshToken = safeStorage.decryptString(Buffer.from(persistida.refreshBlob, 'base64'));
          if (refreshToken !== '') {
            this.sessao = { ...persistida, refreshToken, accessToken: '' };
            // Valida com a API; se a rede estiver fora, entra na graça 72h.
            await this.renovar(true);
            return;
          }
        } catch {
          // Blob ilegível (outra máquina/outro usuário do Windows) = sem sessão.
        }
      }
      this.emitir();
    })();
    await this.carregando;
    if (this.timer === null) {
      this.timer = setInterval(() => {
        void this.renovar(true).catch(() => {});
      }, RENOVA_EVERY_MS);
    }
  }

  parar(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- estado ----

  status(): AuthStatus {
    if (this.sessao === null) {
      return { estado: this.expirado ? 'expirado' : 'deslogado', user: null, offlineAte: null };
    }
    const agora = agoraSegura(this.sessao.maxClockSeen);
    if (!Number.isFinite(agora)) {
      this.encerrarLocal();
      return { estado: 'expirado', user: null, offlineAte: null };
    }
    // Modo guerra: dentro de 72h desde a última validação com a API a sessão
    // segue USÁVEL; fora disso encerra (fail-closed). 'offline' = rede caiu.
    const graçaAte = this.sessao.ultimaValidacaoOk + MODO_GUERRA_MS;
    if (agora > graçaAte) {
      this.encerrarLocal();
      return { estado: 'expirado', user: null, offlineAte: null };
    }
    return this.redeFalhando
      ? { estado: 'offline', user: this.sessao.user, offlineAte: graçaAte }
      : { estado: 'logado', user: this.sessao.user, offlineAte: null };
  }

  /** Gate dos IPC de produto — LANÇA erro PT-BR quando não há sessão válida. */
  exigeSessao(): void {
    const status = this.status();
    if (status.estado === 'logado' || status.estado === 'offline') return;
    if (status.estado === 'expirado') {
      throw new Error('Sessão do sistema encerrada — faça login novamente para usar o Staff Hub.');
    }
    throw new Error('Faça login no Staff Hub para usar esta função.');
  }

  accessTokenValido(): string {
    if (this.sessao === null || this.sessao.accessToken === '') return '';
    if (Date.now() > this.sessao.accessExpiraEm) return '';
    return this.sessao.accessToken;
  }

  // ---- ações ----

  async login(nick: string, senha: string): Promise<AuthLoginResultado> {
    try {
      const resposta = await postJson(baseUrl(), '/staffhub/api/auth/login', { nick, senha });
      if (resposta.status === 200 && resposta.dados?.accessToken) {
        this.expirado = false;
        await this.instalar({
          refreshToken: String(resposta.dados.refreshToken ?? ''),
          accessToken: String(resposta.dados.accessToken ?? ''),
          accessExpiraEm: Number(resposta.dados.accessExpiraEm ?? 0),
          sessaoAte: Number(resposta.dados.sessaoAte ?? 0),
          user: resposta.dados.user,
        });
        await this.journal.append('session', 'auth-login', `nick=${nick}`, false);
        return { ok: true, user: this.sessao?.user ?? resposta.dados.user };
      }
      return {
        ok: false,
        erro: String(resposta.dados?.erro ?? 'Não foi possível entrar.'),
        code: resposta.dados?.code ?? undefined,
      };
    } catch (erro) {
      return { ok: false, erro: mensagemDeRede(erro), code: 'rede' };
    }
  }

  async register(nick: string, senha: string): Promise<{ ok: boolean; erro?: string }> {
    try {
      const resposta = await postJson(baseUrl(), '/staffhub/api/auth/register', { nick, senha });
      if (resposta.status === 201) return { ok: true };
      return { ok: false, erro: String(resposta.dados?.erro ?? 'Não foi possível criar a conta.') };
    } catch (erro) {
      return { ok: false, erro: mensagemDeRede(erro) };
    }
  }

  async logout(): Promise<void> {
    if (this.sessao !== null && this.sessao.refreshToken !== '') {
      await postJson(baseUrl(), '/staffhub/api/auth/logout', { refreshToken: this.sessao.refreshToken }).catch(() => {});
    }
    // Saída VOLUNTÁRIA: estado final é deslogado (sem aviso de expiração).
    this.sessao = null;
    this.expirado = false;
    await this.store.save(null).catch(() => {});
    this.emitir();
    await this.journal.append('session', 'auth-logout', '', false);
  }

  async refreshNow(): Promise<AuthStatus> {
    await this.renovar(true);
    return this.status();
  }

  async trocarSenha(senhaAtual: string, senhaNova: string): Promise<{ ok: boolean; erro?: string }> {
    const token = await this.garantirAccess();
    if (token === '') return { ok: false, erro: 'Sessão indisponível — faça login novamente.' };
    try {
      const resposta = await postJson(baseUrl(), '/staffhub/api/auth/trocar-senha', { senhaAtual, senhaNova }, token);
      if (resposta.status === 200) {
        this.encerrarLocal(); // troca revoga tudo — novo login com a senha nova
        return { ok: true };
      }
      return { ok: false, erro: String(resposta.dados?.erro ?? 'Não foi possível trocar a senha.') };
    } catch (erro) {
      return { ok: false, erro: mensagemDeRede(erro) };
    }
  }

  // ---- admin ----

  private async chamarAdmin(caminho: string, corpo: unknown): Promise<{ status: number; dados: any } | { erroRede: string }> {
    const token = await this.garantirAccess();
    if (token === '') return { erroRede: 'Sessão indisponível — faça login novamente.' };
    try {
      return await postJson(baseUrl(), caminho, corpo, token);
    } catch (erro) {
      return { erroRede: mensagemDeRede(erro) };
    }
  }

  async adminUsers(): Promise<{ users: AdminUserRow[] }> {
    const resposta = await this.chamarAdmin('/staffhub/api/admin/users', {});
    if ('erroRede' in resposta) throw new Error(resposta.erroRede);
    if (resposta.status !== 200) throw new Error(String(resposta.dados?.erro ?? 'Falha ao listar usuários.'));
    return { users: resposta.dados.users ?? [] };
  }

  async adminUsersAcao(id: string, acao: 'aprovar' | 'banir' | 'reabilitar'): Promise<{ ok: boolean; erro?: string }> {
    const resposta = await this.chamarAdmin(`/staffhub/api/admin/users/${encodeURIComponent(id)}/${acao}`, {});
    if ('erroRede' in resposta) return { ok: false, erro: resposta.erroRede };
    if (resposta.status !== 200) return { ok: false, erro: String(resposta.dados?.erro ?? 'Ação falhou.') };
    return { ok: true };
  }

  async adminResetarSenha(id: string): Promise<{ ok: boolean; senhaTemporaria?: string; erro?: string }> {
    const resposta = await this.chamarAdmin(`/staffhub/api/admin/users/${encodeURIComponent(id)}/resetar-senha`, {});
    if ('erroRede' in resposta) return { ok: false, erro: resposta.erroRede };
    if (resposta.status !== 200) return { ok: false, erro: String(resposta.dados?.erro ?? 'Ação falhou.') };
    return { ok: true, senhaTemporaria: resposta.dados.senhaTemporaria };
  }

  async adminAudit(): Promise<{ eventos: AuthAdminAudit[] }> {
    // GET via postJson vazio — a API aceita corpo ausente nos GET? Não: usa GET.
    const resposta = await this.chamarGet('/staffhub/api/admin/audit');
    if ('erroRede' in resposta) throw new Error(resposta.erroRede);
    if (resposta.status !== 200) throw new Error(String(resposta.dados?.erro ?? 'Falha ao ler auditoria.'));
    return { eventos: resposta.dados.eventos ?? [] };
  }

  // ---- internos ----

  private async chamarGet(caminho: string): Promise<{ status: number; dados: any } | { erroRede: string }> {
    const token = await this.garantirAccess();
    if (token === '') return { erroRede: 'Sessão indisponível — faça login novamente.' };
    const url = new URL(caminho, baseUrl());
    const usarHttps = url.protocol === 'https:';
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    return new Promise((resolve) => {
      const requisicao = (usarHttps ? httpsRequest : httpRequest)(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (usarHttps ? 443 : 80),
          path: url.pathname,
          method: 'GET',
          headers,
          ...(usarHttps ? { ca: STAFFHUB_CA_PEM, servername: '' } : {}),
          timeout: 12_000,
        },
        (resposta) => {
          let corpoTexto = '';
          resposta.on('data', (pedaco) => (corpoTexto += pedaco));
          resposta.on('end', () => {
            let dados: any = null;
            try {
              dados = JSON.parse(corpoTexto);
            } catch {}
            resolve({ status: resposta.statusCode ?? 0, dados });
          });
        },
      );
      requisicao.on('timeout', () => requisicao.destroy(new Error('Tempo esgotado falando com o servidor de login.')));
      requisicao.on('error', (erro) => resolve({ erroRede: mensagemDeRede(erro) }));
      requisicao.end();
    });
  }

  /** Renova access (e roda a rotação do refresh). Silenciosa em falha de rede. */
  private async renovar(primeira: boolean): Promise<void> {
    if (this.sessao === null || this.sessao.refreshToken === '') return;
    const agora = Date.now();
    if (!Number.isFinite(agoraSegura(this.sessao.maxClockSeen))) {
      this.encerrarLocal();
      return;
    }
    try {
      const resposta = await postJson(baseUrl(), '/staffhub/api/auth/refresh', { refreshToken: this.sessao.refreshToken });
      if (resposta.status === 200 && resposta.dados?.accessToken) {
        this.redeFalhando = false;
        this.sessao.accessToken = String(resposta.dados.accessToken);
        this.sessao.accessExpiraEm = Number(resposta.dados.accessExpiraEm ?? 0);
        this.sessao.refreshToken = String(resposta.dados.refreshToken ?? this.sessao.refreshToken);
        this.sessao.sessaoAte = Number(resposta.dados.sessaoAte ?? this.sessao.sessaoAte);
        this.sessao.user = resposta.dados.user ?? this.sessao.user;
        this.sessao.ultimaValidacaoOk = Math.max(this.sessao.ultimaValidacaoOk, agora);
        this.sessao.maxClockSeen = Math.max(this.sessao.maxClockSeen, agora);
        await this.persistir();
        if (!primeira) this.emitir();
        return;
      }
      if (resposta.status === 401) {
        await this.journal.append('session', 'auth-expirada', 'refresh 401', false);
        this.encerrarLocal();
        return;
      }
      // Outro status (5xx) — rede/servidor instável: mantém, graça segue.
    } catch {
      // Sem rede: modo guerra (a graça 72h é avaliada no status()).
      this.redeFalhando = true;
    }
    this.emitir();
  }

  private async garantirAccess(): Promise<string> {
    if (this.sessao === null) return '';
    if (this.accessTokenValido() !== '') return this.accessTokenValido();
    await this.renovar(true);
    return this.accessTokenValido();
  }

  private async instalar(dados: {
    refreshToken: string;
    accessToken: string;
    accessExpiraEm: number;
    sessaoAte: number;
    user: AuthUser;
  }): Promise<void> {
    const agora = Date.now();
    this.redeFalhando = false;
    this.sessao = {
      refreshToken: dados.refreshToken,
      accessToken: dados.accessToken,
      accessExpiraEm: dados.accessExpiraEm,
      sessaoAte: dados.sessaoAte,
      user: dados.user,
      ultimaValidacaoOk: agora,
      maxClockSeen: agora,
      refreshBlob: '',
    };
    await this.persistir();
    this.emitir();
  }

  private async persistir(): Promise<void> {
    if (this.sessao === null) return;
    if (!safeStorage.isEncryptionAvailable()) return; // sem DPAPI: só memória
    try {
      const blob = safeStorage.encryptString(this.sessao.refreshToken).toString('base64');
      const { refreshToken: _descartado, ...gravavel } = this.sessao;
      void _descartado;
      this.sessao.refreshBlob = blob;
      // Best-effort DE PROPÓSITO: disco travado não pode derrubar o login —
      // a sessão vive em memória e volta a persistir no próximo ciclo.
      await this.store.save({ ...gravavel, refreshBlob: blob }).catch((erro) => {
        console.warn('[auth] persistência da sessão falhou (sessão segue em memória):', erro);
      });
    } catch (erro) {
      console.warn('[auth] safeStorage indisponível ao persistir (sessão segue em memória):', erro);
    }
  }

  private encerrarLocal(): void {
    this.sessao = null;
    this.expirado = true;
    this.redeFalhando = false;
    this.store.save(null).catch(() => {});
    this.emitir();
  }

  private emitir(): void {
    this.onChange(this.status());
  }
}

function mensagemDeRede(erro: unknown): string {
  const texto = erro instanceof Error ? erro.message : String(erro);
  return `Sem contato com o servidor do Staff Hub (${texto}). Verifique sua internet e tente de novo.`;
}
