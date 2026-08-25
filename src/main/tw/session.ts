import { BrowserWindow, session, type Session as ElectronSession } from 'electron';
import type { SessionStatus } from '@shared/ipc-types';

export const TW_PARTITION = 'persist:tw';
const PORTAL_URL = 'https://www.tribalwars.com.br/';
const GAME_URL_PATTERN = /^https:\/\/(br\d+)\.tribalwars\.com\.br\/game\.php/;

/**
 * Sessão do Tribal Wars em partição dedicada do Chromium: o usuário faz login
 * real (captcha, 2FA, o que o jogo pedir) numa janela própria e TODAS as
 * requisições do app usam o cookie jar dessa partição via session.fetch.
 * Sem manipulação de fingerprint, sem rotação de sid — a sessão é do usuário,
 * resolvida por ele mesmo (política permanente do projeto).
 */
export class TwSessionManager {
  private status: SessionStatus = { state: 'unknown', world: null, player: null, checkedAt: null };
  private loginWindow: BrowserWindow | null = null;
  private readonly listeners = new Set<(status: SessionStatus) => void>();

  private get ses(): ElectronSession {
    return session.fromPartition(TW_PARTITION);
  }

  onStatusChanged(cb: (status: SessionStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.status);
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  /** Janela de login: carrega o portal do jogo e observa a entrada num mundo. */
  openLogin(parent: BrowserWindow): void {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.focus();
      return;
    }
    this.status = { ...this.status, state: 'logging-in' };
    this.emit();
    const win = new BrowserWindow({
      width: 520,
      height: 760,
      parent,
      modal: false,
      title: 'Login — Tribal Wars',
      webPreferences: {
        partition: TW_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.loginWindow = win;
    win.on('closed', () => {
      this.loginWindow = null;
      if (this.status.state === 'logging-in') {
        this.status = { state: this.status.world ? 'logged-in' : 'logged-out', world: this.status.world, player: this.status.player, checkedAt: this.status.checkedAt };
        this.emit();
      }
    });
    win.webContents.on('did-navigate', (_event, url) => {
      void this.absorbGameUrl(url, win);
    });
    win.webContents.on('did-navigate-in-page', (_event, url) => {
      void this.absorbGameUrl(url, win);
    });
    void win.loadURL(PORTAL_URL);
  }

  /** Detecta URL de jogo (br###…game.php), extrai mundo/jogador e fecha a janela. */
  private async absorbGameUrl(url: string, win: BrowserWindow): Promise<void> {
    const match = GAME_URL_PATTERN.exec(url);
    if (!match) return;
    const world = match[1] ?? null;
    if (!world) return;
    try {
      const player = await this.probePlayer(world);
      this.status = { state: 'logged-in', world, player, checkedAt: new Date().toISOString() };
      this.emit();
      if (!win.isDestroyed()) win.close();
    } catch {
      // Entrou na URL do jogo mas o probe falhou: mantém janela aberta p/ usuário tentar de novo.
    }
  }

  /** Busca o nick do jogador na página inicial do jogo via partição. */
  private async probePlayer(world: string): Promise<string | null> {
    const html = await this.fetchText(`https://${world}.tribalwars.com.br/game.php?screen=overview`);
    return extractPlayerName(html);
  }

  async refreshStatus(): Promise<SessionStatus> {
    const world = this.status.world;
    if (!world) {
      this.status = { state: 'logged-out', world: null, player: null, checkedAt: null };
      this.emit();
      return this.status;
    }
    try {
      const html = await this.fetchText(`https://${world}.tribalwars.com.br/game.php?screen=overview`);
      const player = extractPlayerName(html);
      if (player) {
        this.status = { state: 'logged-in', world, player, checkedAt: new Date().toISOString() };
      } else if (looksLikeLoginForm(html)) {
        this.status = { state: 'logged-out', world, player: null, checkedAt: new Date().toISOString() };
      }
    } catch {
      this.status = { ...this.status, state: 'unknown' };
    }
    this.emit();
    return this.status;
  }

  async logout(): Promise<void> {
    await this.ses.clearStorageData({ storages: ['cookies'] });
    this.status = { state: 'logged-out', world: null, player: null, checkedAt: null };
    this.emit();
  }

  /**
   * Import de sessão via sid colado pelo próprio usuário (fluxo EditThisCookie,
   * autorizado pelo dono — ver AGENTS.md). Grava o cookie na partição e valida
   * com um probe real; sid inválido/expirado volta como erro limpo. O app nunca
   * gera, renova ou rotaciona sid.
   */
  async loginWithSid(world: string, sid: string): Promise<{ ok: true; status: SessionStatus } | { ok: false; error: string }> {
    const normalizedWorld = world.trim().toLowerCase();
    const normalizedSid = sid.trim();
    if (!/^br\d{1,4}$/.test(normalizedWorld)) {
      return { ok: false, error: 'Mundo inválido — use o formato br142.' };
    }
    if (normalizedSid.length < 8 || !/^[a-f0-9]+$/i.test(normalizedSid)) {
      return { ok: false, error: 'SID inválido — copie o valor completo do cookie "sid" no navegador.' };
    }
    await this.ses.clearStorageData({ storages: ['cookies'] });
    await this.ses.cookies.set({
      url: `https://${normalizedWorld}.tribalwars.com.br/`,
      name: 'sid',
      value: normalizedSid,
      path: '/',
      secure: true,
      httpOnly: true,
    });
    try {
      const html = await this.fetchText(`https://${normalizedWorld}.tribalwars.com.br/game.php?screen=overview`);
      const player = extractPlayerName(html);
      if (!player || looksLikeLoginForm(html)) {
        return { ok: false, error: 'SID não validado — pode estar expirado. Faça login no navegador, copie o sid atual e tente de novo.' };
      }
      this.status = { state: 'logged-in', world: normalizedWorld, player, checkedAt: new Date().toISOString() };
      this.emit();
      return { ok: true, status: this.status };
    } catch (error) {
      return { ok: false, error: `Falha ao validar o sid: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** Fetch autenticado pelo cookie jar da partição. */
  async fetchText(url: string): Promise<string> {
    const response = await this.ses.fetch(url, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    return await response.text();
  }

  /** Fetch com metadados para a RequestQueue. */
  async fetchForQueue(url: string): Promise<{ ok: boolean; status: number; body: string; url: string }> {
    const response = await this.ses.fetch(url, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    return { ok: response.ok, status: response.status, body: await response.text(), url };
  }

}

/** Extrai o nick do jogador do cabeçalho do jogo (topo/visão geral). */
export function extractPlayerName(html: string): string | null {
  const byTopbar = /class="topbar[^"]*"[^>]*>\s*<a[^>]*>([^<]{2,30})<\/a>/.exec(html);
  if (byTopbar?.[1]) return byTopbar[1].trim();
  const byMenu = /screen=profile[^"]*"[^>]*>([^<]{2,30})<\/a>/.exec(html);
  if (byMenu?.[1]) return byMenu[1].trim();
  return null;
}

export function looksLikeLoginForm(html: string): boolean {
  const head = html.slice(0, 4000).toLowerCase();
  return head.includes('name="password"') || head.includes('id="login"') || head.includes('login_button');
}
