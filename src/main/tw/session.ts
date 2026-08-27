import { BrowserWindow, session, type Session as ElectronSession } from 'electron';
import { join } from 'node:path';
import type { SessionStatus } from '@shared/ipc-types';

export const TW_PARTITION = 'persist:tw';
const PORTAL_URL = 'https://www.tribalwars.com.br/';
// Mundos regulares (br142), CLÁSSICOS (brc2) e CASUAIS (brp8) — br + letra opcional + número.
const GAME_URL_PATTERN = /^https:\/\/(br[a-z]?\d+)\.tribalwars\.com\.br\/game\.php/;

interface ImportedCookie {
  name: string;
  value: string;
  domain: string;
}

/**
 * Interpreta o que o usuário colou no campo SID:
 * 1. Export completo/parcial do EditThisCookie (JSON array de cookies) — extrai
 *    o cookie "sid" (preferindo o domínio do mundo) + cookies da sessão;
 * 2. Cookie único em JSON ({"name":"sid","value":...});
 * 3. Valor puro do sid (com ou sem URL-encoding, ex.: "0%3Aabc" ou "0:abc").
 */
export function parseSidInput(input: string, world: string): { sid: string; extraCookies: ImportedCookie[] } | null {
  const trimmed = input.trim();
  const decode = (value: string): string => {
    if (!value.includes('%')) return value;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  let entries: ImportedCookie[] | null = null;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      entries = list
        .filter((item): item is ImportedCookie => {
          if (typeof item !== 'object' || item === null) return false;
          const candidate = item as Partial<ImportedCookie>;
          return typeof candidate.name === 'string' && typeof candidate.value === 'string' && typeof candidate.domain === 'string';
        })
        .map((item) => ({ name: item.name, value: item.value, domain: item.domain }));
    } catch {
      entries = null;
    }
  }
    if (entries) {
    const worldHost = `${world}.tribalwars.com.br`;
    const sidEntry =
      entries.find((c) => c.name === 'sid' && c.domain.includes(worldHost)) ??
      entries.find((c) => c.name === 'sid');
    if (!sidEntry) return null;
    const extraCookies = entries.filter(
      (c) => c !== sidEntry && c.name !== 'sid' && c.domain.includes('tribalwars.com.br'),
    );
    // O cookie é gravado EXATAMENTE como colado (o navegador envia o valor
    // cruo; decodificar %3A mudaria o que vai ao servidor). O decode é só
    // para validar o formato.
    return { sid: sidEntry.value, extraCookies };
  }
  const raw = trimmed.replace(/^["']|["']$/g, '');
  const decoded = decode(raw);
  const looksLikeSid = /^\d+:[a-f0-9]{32,}$/i.test(decoded) || /^[a-f0-9]{32,}$/i.test(decoded);
  if (!looksLikeSid) return null;
  return { sid: raw, extraCookies: [] };
}

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

  /**
   * Restaura a sessão persistida na partição (login por SID ou janela de login
   * anteriores): os cookies sobrevivem ao reinício do app — só falta redescobrir
   * o mundo (domínio br### do cookie sid) e validar com um probe. Assim o app
   * NÃO pede login de novo para quem já entrou.
   */
  async restoreFromPartition(): Promise<void> {
    if (this.status.state === 'logged-in' || this.status.world !== null) {
      await this.refreshStatus();
      return;
    }
    // Retry com backoff: rede instável no boot não deve deixar o app
    // "Desconectado" sem tentar de novo (o usuário teria que ir em Sessão).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const cookies = await this.ses.cookies.get({});
        const sidCookie = cookies.find(
          (cookie) => cookie.name === 'sid' && cookie.domain !== undefined && /(br[a-z]?\d{1,4}\.)?tribalwars\.com\.br$/.test(cookie.domain),
        );
        if (sidCookie === undefined) return; // nada persistido: segue logged-out
        const world = /br[a-z]?\d{1,4}/.exec(sidCookie.domain ?? '')?.[0] ?? null;
        if (world === null) return;
        this.status = { state: 'unknown', world, player: this.status.player, checkedAt: null };
        await this.refreshStatus();
        return; // sucesso — sai do retry
      } catch {
        if (attempt < 2) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        }
        // última tentativa falhou: mantém estado atual (Desconectado visível)
      }
    }
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
      icon: join(__dirname, '../../../build/icon.ico'),
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
      if (looksLikeGamePage(html)) {
        const player = extractPlayerName(html);
        this.status = { state: 'logged-in', world, player: player ?? this.status.player, checkedAt: new Date().toISOString() };
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
   * autorizado pelo dono — ver AGENTS.md). Aceita o export completo da extensão
   * ou o valor puro. Grava os cookies na partição e valida com um probe real;
   * sid inválido/expirado volta como erro limpo. O app nunca gera, renova ou
   * rotaciona sid.
   */
  async loginWithSid(world: string, sid: string): Promise<{ ok: true; status: SessionStatus } | { ok: false; error: string }> {
    const normalizedWorld = world.trim().toLowerCase();
    if (!/^br[a-z]?\d{1,4}$/i.test(normalizedWorld)) {
      return { ok: false, error: 'Mundo inválido — use br142 (regular), brc2 (clássico) ou brp8 (casual).' };
    }
    const parsed = parseSidInput(sid, normalizedWorld);
    if (!parsed) {
      return { ok: false, error: 'Não encontrei um cookie "sid" válido aí — cole o export completo do EditThisCookie ou o valor puro do sid (0%3Aabc… ou 0:abc…).' };
    }
    await this.ses.cookies.set({
      url: `https://${normalizedWorld}.tribalwars.com.br/`,
      name: 'sid',
      value: parsed.sid,
      path: '/',
      secure: true,
      httpOnly: true,
    });
    // Cookies companhia do próprio export (ex.: br_auth/cid do portal, global_village_id
    // do mundo) — só os de tribalwars.com.br, extraídos do que o usuário colou.
    for (const cookie of parsed.extraCookies) {
      const host = cookie.domain.replace(/^\./, '');
      try {
        await this.ses.cookies.set({
          url: `https://${host}/`,
          name: cookie.name,
          value: cookie.value,
          path: '/',
          secure: host.includes('tribalwars.com.br'),
        });
      } catch {
        // cookie opcional — ignora se o Chromium recusar
      }
    }
    try {
      const html = await this.fetchText(`https://${normalizedWorld}.tribalwars.com.br/game.php?screen=overview`);
      if (!looksLikeGamePage(html)) {
        return { ok: false, error: 'SID não validado — pode estar expirado. Faça login no navegador, copie o export atual do EditThisCookie e tente de novo.' };
      }
      this.status = {
        state: 'logged-in',
        world: normalizedWorld,
        player: extractPlayerName(html),
        checkedAt: new Date().toISOString(),
      };
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

/** Extrai o nick do jogador do cabeçalho do jogo (topo/visão geral) — best-effort. */
export function extractPlayerName(html: string): string | null {
  const byGameData = /"player":\{"id":\d+,"name":"([^"]{2,40})"/.exec(html);
  if (byGameData?.[1]) return byGameData[1].trim();
  const byInfoPlayer = /screen=info_player&[^"]*"[^>]*>([^<]{2,30})<\/a>/.exec(html);
  if (byInfoPlayer?.[1]) return byInfoPlayer[1].trim();
  return null;
}

export function looksLikeLoginForm(html: string): boolean {
  const head = html.slice(0, 4000).toLowerCase();
  return head.includes('name="password"') || head.includes('id="login"') || head.includes('login_button');
}

/**
 * Marcador estrutural de página de jogo autenticada (validado contra o HTML
 * real do BR142): o corpo do jogo tem id="ds_body". O nick nem sempre é
 * extraível da visão geral — por isso NÃO faz parte do critério de sessão.
 */
export function looksLikeGamePage(html: string): boolean {
  return html.includes('id="ds_body"') && !looksLikeLoginForm(html);
}
