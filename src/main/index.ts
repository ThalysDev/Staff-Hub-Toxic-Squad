import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { TwSessionManager } from './tw/session';
import { RequestQueue, detectPageSentinels } from './tw/request-queue';
import { JsonStore } from './stores/json-store';
import { Journal } from './journal';
import { WorldDataService } from './services/world-data-service';
import { Sg1Service } from './services/sg1-service';
import { registerWorldIpc } from './ipc-world';
import { TroopsService } from './services/troops-service';
import { registerTroopsIpc } from './ipc-troops';
import { registerSg3Ipc } from './ipc-sg3';
import { Sg5Service } from './services/sg5-service';
import { registerSg5Ipc } from './ipc-sg5';
import { DEFAULT_SETTINGS, type AppSettings, type QueueProgress } from '@shared/ipc-types';

const twSession = new TwSessionManager();
const journal = new Journal();
const settingsStore = new JsonStore<AppSettings>('settings', DEFAULT_SETTINGS);
const worldData = new WorldDataService(twSession);
const sg1Service = new Sg1Service(worldData);

let mainWindow: BrowserWindow | null = null;
let queue: RequestQueue | null = null;

/**
 * Sanitiza settings na fronteira do main: valores inválidos (arquivo editado,
 * IPC malformado) voltam aos defaults SEGUROS — nunca a um pacing abaixo do
 * mínimo humano. Fail-closed: dryRun duvidoso volta a true.
 */
function sanitizeSettings(value: Partial<AppSettings>): AppSettings {
  const safe = { ...DEFAULT_SETTINGS };
  const minInterval = Number(value.requestMinIntervalMs);
  if (Number.isFinite(minInterval) && minInterval >= 350) safe.requestMinIntervalMs = Math.round(minInterval); // piso da política: 350ms (AGENTS.md)
  const jitter = Number(value.requestJitterMs);
  if (Number.isFinite(jitter) && jitter >= 0) safe.requestJitterMs = Math.round(jitter);
  const ceiling = Number(value.requestCeiling);
  if (Number.isFinite(ceiling) && ceiling >= 1) safe.requestCeiling = Math.round(ceiling);
  safe.dryRun = value.dryRun === false ? false : true;
  return safe;
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    title: 'Staff Hub Toxic Squad',
    backgroundColor: '#12100e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
  // Modo dev: SHS_CAPTURE=<caminho> tira um screenshot da janela e encerra
  // (usado para inspeção visual e futuros baselines de regressão).
  const shotPath = process.env.SHS_CAPTURE;
  if (shotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await mainWindow?.webContents.capturePage();
          if (image) await fs.writeFile(shotPath, image.toPNG());
        } catch {
          // best-effort
        }
        app.quit();
      }, 2500);
    });
  }
}

function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload);
}

function registerIpc(): void {
  ipcMain.handle('app:get-version', () => app.getVersion());

  ipcMain.handle('session:open-login', () => {
    if (mainWindow) twSession.openLogin(mainWindow);
  });
  ipcMain.handle('session:logout', () => twSession.logout());
  ipcMain.handle('session:status', () => twSession.getStatus());
  ipcMain.handle('session:login-sid', async (_event, world: string, sid: string) => {
    const result = await twSession.loginWithSid(world, sid);
    if (result.ok) {
      await journal.append('session', 'login-sid', `mundo=${result.status.world ?? '?'} jogador=${result.status.player ?? '?'}`, false);
    } else {
      await journal.append('session', 'login-sid-falhou', result.error, false);
    }
    return result;
  });

  ipcMain.handle('settings:get', async () => {
    const raw = await settingsStore.load();
    const safe = sanitizeSettings(raw);
    return safe;
  });
  ipcMain.handle('settings:update', async (_event, patch: Record<string, unknown>) => {
    const current = await settingsStore.load();
    const next = sanitizeSettings({ ...current, ...patch });
    await settingsStore.save(next);
    queue?.updateSettings({
      minIntervalMs: next.requestMinIntervalMs,
      jitterMs: next.requestJitterMs,
      ceiling: next.requestCeiling,
    });
    await journal.append('system', 'settings-update', JSON.stringify(next), false);
    return next;
  });

  ipcMain.handle('journal:list', (_event, limit: number) => journal.list(limit));
  ipcMain.handle('journal:clear', () => journal.clear());

  ipcMain.handle('dev:capture-fixture', async (_event, name: string, url: string) => {
    try {
      const response = await twSession.fetchForQueue(url);
      // Fail-closed: página de erro HTTP ou formulário de login/captcha NÃO é
      // fixture válida — nunca envenenar os testes dos parsers.
      if (!response.ok) {
        return { ok: false as const, name, error: `HTTP ${response.status}` };
      }
      const sentinel = detectPageSentinels(response.body);
      if (sentinel) {
        return { ok: false as const, name, error: `Página de ${sentinel === 'captcha-suspected' ? 'captcha' : 'login'} capturada — sessão inválida para este alvo.` };
      }
      const html = response.body;
      const fixturesDir = join(app.getPath('userData'), 'fixtures');
      await fs.mkdir(fixturesDir, { recursive: true });
      const safeName = name.replace(/[^a-z0-9_-]/gi, '_');
      const path = join(fixturesDir, `${safeName}.html`);
      await fs.writeFile(path, html, 'utf-8');
      await journal.append('read', 'capture-fixture', `${safeName} ← ${url}`, false);
      return { ok: true as const, name: safeName, bytes: Buffer.byteLength(html), path };
    } catch (error) {
      return { ok: false as const, name, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('queue:cancel', () => queue?.cancel());
}

function wireEvents(): void {
  twSession.onStatusChanged((status) => send('session:changed', status));
  queue = new RequestQueue(
    (url) => twSession.fetchForQueue(url),
    (progress) => send('queue:progress', progress satisfies QueueProgress),
    { minIntervalMs: DEFAULT_SETTINGS.requestMinIntervalMs, jitterMs: DEFAULT_SETTINGS.requestJitterMs, ceiling: DEFAULT_SETTINGS.requestCeiling },
    {
      onStarted: (info) => {
        void journal.append('read', 'queue-started', `${info.label} (${info.total} requisições)`, true);
      },
      onFinished: (info) => {
        void journal.append('read', 'queue-finished', `${info.label} concluída (${info.total} requisições)`, true);
      },
      onFailed: (info) => {
        void journal.append('read', 'queue-failed', `${info.label}: ${info.error.kind} — ${info.error.message}`, true);
      },
    },
  );
  twSession.onStatusChanged(async (status) => {
    if (status.state !== 'logged-in') return;
    await journal.append('session', 'login', `mundo=${status.world ?? '?'} jogador=${status.player ?? '?'}`, false);
  });
}

app.whenReady().then(() => {
  void journal.load();
  registerIpc();
  wireEvents();
  registerWorldIpc({ twSession, queue: queue as RequestQueue, journal, worldData, sg1: sg1Service });
  const troopsService = new TroopsService(twSession, queue as RequestQueue, journal);
  registerTroopsIpc({ twSession, queue: queue as RequestQueue, journal, troops: troopsService });
  registerSg3Ipc({ troops: troopsService, journal });
  const sg5Service = new Sg5Service(twSession, queue as RequestQueue, journal, worldData);
  registerSg5Ipc({ sg5: sg5Service, journal });
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// Fail-closed: exceção não tratada no main encerra o app — nunca seguir rodando
// com pacing/sentinela potencialmente mortos.
process.on('uncaughtException', (error) => {
  try {
    void journal.append('system', 'uncaught-exception', error.message, false);
  } catch {
    // best-effort
  }
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

export { queue as requestQueue, twSession };
