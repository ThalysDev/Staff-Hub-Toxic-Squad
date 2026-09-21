// Licença do userscript: a chave é emitida pelo ADMIN no painel do Staff Hub
// (Electron) e validada no VPS do hub (POST /staffhub/api/key/validate —
// fail-closed no servidor: hash, revogação, expiração, binding ao jogador;
// devolve ticket HMAC {ok, player, expiresAt, tier}). Sem chave válida o
// painel não abre. Falha de REDE ≠ revogação: graça de 72h (mesmo espírito
// do modo guerra do app), fail-closed depois.

import { gm } from './storage';

const LICENSE_BASE = 'http://74.0.5.75/staffhub/api';
// MIGRAÇÃO (documentada): quando api.reidasmultistw.com.br ganhar as rotas de
// chave, basta trocar LICENSE_BASE (TLS válido lá; hoje o VPS do hub atende
// http por IP — fail-closed no servidor, ticket HMAC; risco MITM = reuso de
// chave, não injeção de código).
const GRACE_MS = 72 * 60 * 60 * 1000;
const CLOCK_MAX_KEY = 'shs-in-game:clock-max';

export interface LicenseSession {
  key: string;
  ticket: string;
  accountName: string;
  licenseExpiresAt: number | null;
  lastValidatedAt: number;
}

type GmXhrCallback = (response: { status: number; responseText: string }) => void;

declare const GM_xmlhttpRequest: undefined | ((details: {
  method: 'POST';
  url: string;
  headers?: Record<string, string>;
  data: string;
  timeout?: number;
  onload: GmXhrCallback;
  onerror: GmXhrCallback;
  ontimeout: GmXhrCallback;
  onabort: GmXhrCallback;
}) => void);

/** POST cross-origin (licenças) — GM_xmlhttpRequest bypassa CORS por ser
 *  privilégio do Tampermonkey; único uso de rede fora do origem do jogo. */
function postJson(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    if (typeof GM_xmlhttpRequest !== 'function') {
      reject(new Error('GM_xmlhttpRequest indisponível nesta versão do Tampermonkey.'));
      return;
    }
    GM_xmlhttpRequest({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(body),
      timeout: 15_000,
      onload: (response) => {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(response.responseText);
        } catch {
          parsed = null;
        }
        resolve({ status: response.status, body: parsed });
      },
      onerror: () => reject(new Error('Falha de rede ao contatar o servidor de licenças.')),
      ontimeout: () => reject(new Error('Servidor de licenças não respondeu (tempo esgotado).')),
      onabort: () => reject(new Error('Servidor de licenças não respondeu (tempo esgotado).')),
    });
  });
}

function loadSession(): LicenseSession | null {
  return gm.get<LicenseSession | null>('shs-in-game:license', null);
}

function saveSession(session: LicenseSession | null): void {
  // 'shs-in-game:key' é resíduo de versão antiga (a chave já vive dentro da
  // sessão); qualquer gravação/remoção de sessão aproveita para limpá-lo.
  gm.remove('shs-in-game:key');
  if (session === null) {
    gm.remove('shs-in-game:license');
  } else gm.set('shs-in-game:license', session);
}

/** Estado para a UI: válida / graça offline / ausente. */
export type LicenseState =
  | { kind: 'valida'; accountName: string; licenseExpiresAt: number | null }
  | { kind: 'graca'; accountName: string; offlineAte: number }
  | { kind: 'ausente' };

/** "Agora" anti-recuo de relógio (espelho do maxClockSeen do app Electron):
 *  persiste o maior timestamp já visto; se o relógio local voltar, as
 *  comparações de expiração/graça usam este teto em vez do Date.now() recuado. */
function clockNow(): number {
  const stored = gm.get<unknown>(CLOCK_MAX_KEY, 0);
  const seen = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
  const now = Math.max(seen, Date.now());
  gm.set(CLOCK_MAX_KEY, now);
  return now;
}

export function licenseState(): LicenseState {
  const session = loadSession();
  if (session === null) return { kind: 'ausente' };
  const now = clockNow();
  // Licença expirada no ticket: sessão vale zero (reativar revalida no
  // servidor, então não precisa limpar o storage aqui).
  if (session.licenseExpiresAt !== null && now > session.licenseExpiresAt) return { kind: 'ausente' };
  const recentlyValidated = now - session.lastValidatedAt < 24 * 60 * 60 * 1000;
  if (recentlyValidated) return { kind: 'valida', accountName: session.accountName, licenseExpiresAt: session.licenseExpiresAt };
  // Sem validação nas últimas 24h: graça de 72h desde a última validação
  // bem-sucedida (mesma régua do modo guerra do app). Revogação propaga na
  // próxima validação bem-sucedida; falha de rede mantém a graça.
  const offlineAte = session.lastValidatedAt + GRACE_MS;
  if (now < offlineAte) return { kind: 'graca', accountName: session.accountName, offlineAte };
  return { kind: 'ausente' };
}

/** Ativa/valida uma chave no VPS do hub: fail-closed no servidor (hash,
 *  revogação, expiração) + binding ao jogador no primeiro uso (anti-share
 *  casual). Recusas vêm com {erro} no corpo (inexistente/revogada/expirada/
 *  vinculada/rate-limit) — mostramos o motivo do servidor. */
export async function activate(code: string, accountName: string): Promise<void> {
  const response = await postJson(`${LICENSE_BASE}/key/validate`, {
    key: code.trim(),
    player: accountName.trim(),
  });
  if (response.status !== 200 && response.status !== 201) {
    // Qualquer recusa (400/403/429/500…) pode trazer o motivo em {erro} —
    // mostramos o motivo do servidor em vez de uma mensagem genérica.
    const erro = (response.body as { erro?: string } | null)?.erro;
    throw new Error(erro !== undefined && erro !== '' ? erro : 'Chave recusada pelo servidor de licenças.');
  }
  const payload = response.body as {
    ok?: boolean;
    expiresAt?: number | string;
    ticket?: string;
  } | null;
  if (payload === null || payload.ok !== true || payload.ticket === undefined) {
    throw new Error('Chave recusada pelo servidor de licenças.');
  }
  const raw = payload.expiresAt;
  const parsed = typeof raw === 'number' ? raw : Date.parse(String(raw));
  const licenseExpiresAt = Number.isFinite(parsed) ? parsed : null;
  saveSession({
    key: code.trim(),
    ticket: payload.ticket,
    accountName: accountName.trim(),
    licenseExpiresAt,
    lastValidatedAt: clockNow(),
  });
}

/** Revalida a chave no VPS (24h e antes de ciclo mutável). 401/403 = chave
 *  revogada/vinculada a outro jogador → desloga; erro de REDE mantém a graça. */
export async function revalidate(): Promise<void> {
  const session = loadSession();
  if (session === null) return;
  try {
    const response = await postJson(`${LICENSE_BASE}/key/validate`, {
      key: session.key,
      player: session.accountName,
    });
    if (response.status === 401 || response.status === 403) {
      saveSession(null);
      return;
    }
    const payload = response.body as { ok?: boolean; erro?: string; expiresAt?: number | string; ticket?: string } | null;
    if (payload === null || payload.ok !== true) return;
    const raw = payload.expiresAt;
    const parsed = typeof raw === 'number' ? raw : Date.parse(String(raw));
    saveSession({
      ...session,
      ticket: payload.ticket ?? session.ticket,
      licenseExpiresAt: Number.isFinite(parsed) ? parsed : session.licenseExpiresAt,
      lastValidatedAt: clockNow(),
    });
  } catch {
    // Rede fora: mantém a sessão — a graça cuida da janela.
  }
}

export function logout(): void {
  saveSession(null);
}

/** Gate: o painel só abre com licença válida/graça; dispara a revalidação
 *  quando passou das 24h (estado 'graça') — é assim que revogação/expiração
 *  propagam em até 24h em vez de só na reativação (P1 da revisão do script). */
export function gate(): LicenseState {
  const state = licenseState();
  if (state.kind === 'graca') {
    void revalidate();
  }
  return state;
}
