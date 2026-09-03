import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
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
import { SupportersService } from './services/supporters-service';
import { registerSupportersIpc } from './ipc-supporters';
import { Sg5Service } from './services/sg5-service';
import { Sg6Service } from './mutations/sg6-service';
import { registerSg6Ipc } from './ipc-sg6';
import { Sg7Service } from './mutations/sg7-service';
import { registerSg7Ipc } from './ipc-sg7';
import { OpArchiveService } from './services/op-archive-service';
import { registerOpIpc } from './ipc-op';
import { GroupsService } from './services/groups-service';
import { registerGroupsIpc } from './ipc-groups';
import { registerPreferencesIpc } from './ipc-preferences';
import { registerPlannerDraftIpc } from './ipc-planner-draft';
import { registerAuthIpc } from './ipc-auth';
import { AuthService } from './services/auth-service';
import { registerTemplatesIpc } from './ipc-templates';
import { registerHistoryIpc } from './ipc-history';
import { UpdaterService } from './updater-service';
import { registerSg5Ipc } from './ipc-sg5';
import { scheduleTMinusAlerts, validateAlertMinutes, parseScheduleLine } from './tminus';
import { DEFAULT_SETTINGS, type AppSettings, type QueueProgress } from '@shared/ipc-types';

// Gancho E2E do atualizador (scripts/e2e-update.mjs): isola o userData ANTES de
// QUALQUER instância — JsonStore/TwSessionManager resolvem caminhos no
// CONSTRUTOR; depois delas já seria tarde (e o teste tocaria os dados reais).
// Sem a variável no ambiente, este bloco é inerte — produção intacta.
const E2E_USERDATA = process.env.SHS_E2E_USERDATA;
if (E2E_USERDATA !== undefined && E2E_USERDATA !== '') {
  app.setPath('userData', E2E_USERDATA);
}

const twSession = new TwSessionManager();
const journal = new Journal();
const settingsStore = new JsonStore<AppSettings>('settings', DEFAULT_SETTINGS);
const worldData = new WorldDataService(twSession, journal);
const sg1Service = new Sg1Service(worldData);

let mainWindow: BrowserWindow | null = null;
let queue: RequestQueue | null = null;
let updaterService: UpdaterService | null = null;

/**
 * Gancho E2E do atualizador: com SHS_E2E_UPDATE_URL + SHS_E2E_MARKER_DIR no
 * ambiente, o app baixa + prepara + reinicia sozinho contra um canal local.
 * Antes de sair grava e2e-prepare.json no markerDir; o app RELANÇADO pela
 * troca vê o marcador (o env é herdado, não dá para diferenciar fase por var)
 * e grava e2e-success.txt — provar que TROCA + RELANÇAMENTO funcionaram.
 */
async function runUpdaterE2eHook(): Promise<void> {
  const url = process.env.SHS_E2E_UPDATE_URL;
  const markerDir = process.env.SHS_E2E_MARKER_DIR;
  if (url === undefined || markerDir === undefined || updaterService === null) return;
  const phase2 = existsSync(join(markerDir, 'e2e-prepare.json'));
  try {
    if (phase2) {
      writeFileSync(
        join(markerDir, 'e2e-success.txt'),
        `relancado em ${new Date().toISOString()} — versao ${app.getVersion()}\n`,
        'utf8',
      );
      console.log(`[SHS-E2E] PHASE2: app relancado pela troca — v${app.getVersion()}`);
      setTimeout(() => app.exit(0), 2000);
      return;
    }
    console.log(`[SHS-E2E] downloadAndPrepare de ${url}`);
    const resultado = await updaterService.downloadAndPrepare();
    console.log(`[SHS-E2E] preparo: ${resultado.ok ? 'OK' : 'FALHA'} — ${resultado.detail}`);
    writeFileSync(join(markerDir, 'e2e-prepare.json'), JSON.stringify(resultado, null, 1), 'utf8');
    if (!resultado.ok) {
      writeFileSync(join(markerDir, 'e2e-failure.txt'), resultado.detail, 'utf8');
      return;
    }
    console.log('[SHS-E2E] restartToUpdate — saindo para a troca');
    await updaterService.restartToUpdate();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[SHS-E2E] erro: ${message}`);
    try {
      writeFileSync(join(markerDir, 'e2e-failure.txt'), message, 'utf8');
    } catch {
      // best-effort
    }
  }
}

/**
 * Sanitiza settings na fronteira do main: valores inválidos (arquivo editado,
 * IPC malformado) voltam aos defaults SEGUROS — nunca a um pacing abaixo do
 * mínimo humano.
 */
function sanitizeSettings(value: Partial<AppSettings>): AppSettings {
  const safe = { ...DEFAULT_SETTINGS };
  const minInterval = Number(value.requestMinIntervalMs);
  if (Number.isFinite(minInterval) && minInterval >= 350) safe.requestMinIntervalMs = Math.round(minInterval); // piso da política: 350ms (AGENTS.md)
  const jitter = Number(value.requestJitterMs);
  if (Number.isFinite(jitter) && jitter >= 0) safe.requestJitterMs = Math.round(jitter);
  const ceiling = Number(value.requestCeiling);
  if (Number.isFinite(ceiling) && ceiling >= 1) safe.requestCeiling = Math.round(ceiling);
  const updateUrl = typeof value.updateUrl === 'string' ? value.updateUrl.trim() : '';
  if (/^https?:\/\/\S+$/.test(updateUrl)) safe.updateUrl = updateUrl;
  return safe;
}

/**
 * Ícone da janela/taskbar: APIs nativas do Windows exigem arquivo REAL em
 * disco — dentro do pacote o app roda de resources/app.asar, onde o .ico não
 * serve para essas APIs. Extraímos o ícone do asar para o userData no primeiro
 * uso e devolvemos esse caminho real. Em dev, o caminho do repo já é real.
 */
function iconPath(): string {
  const inPackage = join(__dirname, '../../build/icon.ico');
  if (existsSync(inPackage) && !inPackage.includes('app.asar')) return inPackage;
  try {
    const target = join(app.getPath('userData'), 'icon.ico');
    if (!existsSync(target)) copyFileSync(inPackage, target);
    return target;
  } catch {
    return inPackage;
  }
}

function createMainWindow(): void {
  // QA visual: SHS_WIDTH/SHS_HEIGHT sobrepõem o tamanho da janela nas capturas
  // (SHS_CAPTURE) — permite fotografar páginas inteiras, não só a dobra.
  const captureWidth = Number.parseInt(process.env.SHS_WIDTH ?? '', 10);
  const captureHeight = Number.parseInt(process.env.SHS_HEIGHT ?? '', 10);
  mainWindow = new BrowserWindow({
    width: Number.isFinite(captureWidth) && captureWidth > 0 ? captureWidth : 1360,
    height: Number.isFinite(captureHeight) && captureHeight > 0 ? captureHeight : 860,
    minWidth: 1080,
    minHeight: 680,
    title: 'Staff Hub Toxic Squad',
    backgroundColor: '#12100e',
    icon: iconPath(),
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Taskbar do Windows: agrupamento + ícone de relançamento pela própria janela
  // (docs: appId é obrigatório para as demais opções do setAppDetails).
  mainWindow.setAppDetails({
    appId: 'com.toxicsquad.staffhub',
    appIconPath: iconPath(),
    appIconIndex: 0,
  });
  const emitMaxState = (): void => {
    mainWindow?.webContents.send('win:max-changed', mainWindow.isMaximized());
  };
  mainWindow.on('maximize', emitMaxState);
  mainWindow.on('unmaximize', emitMaxState);
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
    // SHS_PAGE=<id> abre direto numa página (deep link ?page=) — usado com
    // SHS_CAPTURE para capturar telas específicas no QA visual.
    const page = process.env.SHS_PAGE;
    void mainWindow.loadFile(
      join(__dirname, '../renderer/index.html'),
      page !== undefined && page !== ''
        ? { query: { page, ...(process.env.SHS_THEME === 'escuro' || process.env.SHS_THEME === 'claro' ? { theme: process.env.SHS_THEME } : {}) } }
        : undefined,
    );
  }
  // Modo dev: SHS_CAPTURE=<caminho> tira um screenshot da janela e encerra
  // (usado para inspeção visual e futuros baselines de regressão).
  // SHS_CAPTURE_DELAY=<ms> espera ANTES da foto — páginas que hidratam dados
  // via IPC (ex.: rascunho do planner) precisam de um instante a mais.
  // SHS_CAPTURE_FULL=1 fotografa a PÁGINA INTEIRA via CDP (captureBeyondViewport)
  // — capturePage() só cobre o viewport e o Windows limita a janela à tela,
  // então páginas longas ficavam cortadas (lição do QA visual v0.33).
  const shotPath = process.env.SHS_CAPTURE;
  if (shotPath) {
    const shotDelay = Number.parseInt(process.env.SHS_CAPTURE_DELAY ?? '0', 10) || 0;
    const shotFull = process.env.SHS_CAPTURE_FULL === '1';
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        // UnknownVizError do compositor é INTERMITENTE (Chromium): 3 tentativas
        // com espera cobrem o flake sem mascarar falha real (erro vai ao .err).
        let lastError = 'capturePage devolveu imagem vazia';
        if (shotFull) {
          // FullPage via CDP: habilita o domínio Page e usa LAYOUT METRICS +
          // override de viewport (captureBeyondViewport sozinho não basta em
          // Electron headed). Falha ALTO: sem fallback para capturePage — uma
          // foto só do viewport quando se pediu a página inteira é evidência
          // mentirosa (lição do QA visual v0.33).
          try {
            const wcDebugger = mainWindow?.webContents.debugger;
            if (wcDebugger !== undefined) {
              wcDebugger.attach('1.3');
              try {
                await wcDebugger.sendCommand('Page.enable', {});
                // O app usa shell 100vh com scroll INTERNO (.content) — o
                // documento inteiro tem a altura do viewport. Para a foto da
                // página COMPLETA: desmonta o scroll (QA-only, app encerra em
                // seguida), espera um layout e só então mede/fotografa.
                // exceptionDetails é checado: CDP NÃO rejeita quando a
                // expressão lança na página (silêncio aqui = foto cortada
                // sem .err — evidência mentirosa, P3 da revisão integrada).
                const evaluation = (await wcDebugger.sendCommand('Runtime.evaluate', {
                  expression:
                    "(() => { const s = document.createElement('style'); s.id = 'shs-fullpage';" +
                    " s.textContent = '.app-shell{height:auto!important;overflow:visible!important}" +
                    ".content{overflow:visible!important;height:auto!important}';" +
                    " document.head.appendChild(s); return document.getElementById('shs-fullpage') !== null; })()",
                })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
                if (evaluation.exceptionDetails !== undefined || evaluation.result?.value !== true) {
                  throw new Error('a expansão do layout (style shs-fullpage) não aplicou na página');
                }
                await new Promise((resolve) => setTimeout(resolve, 200));
                const metrics = (await wcDebugger.sendCommand('Page.getLayoutMetrics', {})) as {
                  cssContentSize?: { width?: number; height?: number };
                };
                const width = Math.max(1, Math.round(metrics.cssContentSize?.width ?? 1600));
                const height = Math.max(1, Math.round(metrics.cssContentSize?.height ?? 1000));
                await wcDebugger.sendCommand('Emulation.setDeviceMetricsOverride', {
                  width,
                  height,
                  deviceScaleFactor: 1,
                  mobile: false,
                });
                try {
                  const shot = (await wcDebugger.sendCommand('Page.captureScreenshot', {
                    format: 'png',
                    fromSurface: true,
                  })) as { data?: string };
                  if (shot.data !== undefined && shot.data !== '') {
                    await fs.writeFile(shotPath, Buffer.from(shot.data, 'base64'));
                    lastError = '';
                  } else {
                    lastError = 'captura fullPage devolveu imagem vazia';
                  }
                } finally {
                  await wcDebugger.sendCommand('Emulation.clearDeviceMetricsOverride', {}).catch(() => undefined);
                }
              } finally {
                wcDebugger.detach();
              }
            }
          } catch (captureError) {
            lastError = `captura fullPage falhou: ${String(captureError)}`;
          }
        }
        for (let attempt = 0; !shotFull && lastError !== '' && attempt < 3; attempt++) {
          try {
            const image = await mainWindow?.webContents.capturePage();
            if (image && !image.isEmpty()) {
              await fs.writeFile(shotPath, image.toPNG());
              lastError = '';
              break;
            }
          } catch (captureError) {
            lastError = `capturePage falhou: ${String(captureError)}`;
          }
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        if (lastError !== '') {
          await fs.writeFile(`${shotPath}.err`, lastError).catch(() => {});
        }
        app.quit();
      }, shotDelay > 0 ? shotDelay : 2500);
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
      // Allowlist rígida: só páginas do Tribal Wars BR aceitas (mundos br142 e
      // clássicos brc2) — renderer comprometido não transforma o app em proxy
      // autenticado (SSRF).
      if (!/^https:\/\/br[a-z]?\d+\.tribalwars\.com\.br\//.test(url)) {
        return { ok: false as const, name, error: 'URL fora do allowlist — use https://br###.tribalwars.com.br/…' };
      }
      const response = await twSession.fetchForQueue(url);
      // Pós-fetch: se o servidor redirecionou para fora do domínio do jogo,
      // o corpo não vira fixture (defesa contra redirect cross-origin).
      if (!/^https:\/\/br[a-z]?\d+\.tribalwars\.com\.br\//.test(response.url)) {
        return { ok: false as const, name, error: `Redirecionou para fora do jogo (${response.url}) — fixture descartada.` };
      }
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

  // Notificações T-minus (bandeja do sistema) — marcas configuráveis (default 15/5/1).
  let tminusCleanup: (() => void) | null = null;
  ipcMain.handle('tminus:schedule', (_event, scheduleText: string, marksMinutes?: number[]) => {
    try {
      if (tminusCleanup !== null) tminusCleanup();
      const marks = marksMinutes !== undefined && marksMinutes.length > 0 ? validateAlertMinutes(marksMinutes) : undefined;
      const lines = scheduleText.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
      tminusCleanup = scheduleTMinusAlerts(
        scheduleText,
        (message) => {
          send('tminus:alert', message);
        },
        marks,
      );
      // Contagem REAL: só marca futura de envio futuro conta (mesmos cortes do
      // scheduler — marca/Envio no passado não gera notificação).
      const effectiveMarks = marks ?? [15, 5, 1];
      let alerts = 0;
      for (const line of scheduleText.split(/\r?\n/)) {
        const entry = parseScheduleLine(line);
        if (entry === null) continue;
        const msUntil = entry.sendAt.getTime() - Date.now();
        if (msUntil <= 0) continue;
        for (const minutes of effectiveMarks) {
          if (msUntil - minutes * 60_000 > 0) alerts += 1;
        }
      }
      return { alerts, detail: `Alertas T-minus agendados para ${lines.length} envio(s)` };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
  ipcMain.handle('tminus:cancel', () => {
    if (tminusCleanup !== null) tminusCleanup();
    tminusCleanup = null;
  });

  // Atualização pelo canal oficial (VPS): handlers finos sobre o UpdaterService.
  const updater = new UpdaterService(settingsStore, journal, (progress) => send('updater:progress', progress));
  updaterService = updater;
  ipcMain.handle('updater:check', async () => updater.check());
  ipcMain.handle('updater:download-prepare', async () => updater.downloadAndPrepare());
  ipcMain.handle('updater:list-versions', async () => updater.listAvailableVersions());
  ipcMain.handle('updater:prepare-version', async (_event, version: string, url: string, sha256: string) =>
    updater.prepareVersion(version, url, sha256));
  ipcMain.handle('updater:restart', async () => {
    await updater.restartToUpdate();
  });

  // Titlebar personalizada (frame:false): controles de janela via IPC.
  ipcMain.handle('win:min', () => mainWindow?.minimize());
  ipcMain.handle('win:max-toggle', () => {
    if (mainWindow === null) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('win:close', () => mainWindow?.close());
  ipcMain.handle('win:is-max', () => mainWindow?.isMaximized() ?? false);
}

function wireEvents(initialQueueSettings: { minIntervalMs: number; jitterMs: number; ceiling: number }): void {
  twSession.onStatusChanged((status) => send('session:changed', status));
  queue = new RequestQueue(
    (url) => twSession.fetchForQueue(url),
    (progress) => send('queue:progress', progress satisfies QueueProgress),
    initialQueueSettings,
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
      // Sentinela de login/captcha num corpo: espelha a queda no TwSessionManager
      // NA HORA — a UI para de mostrar "Ativa" e o agendador de coleta automática
      // (SG_2) para de bater numa sessão morta (sem spam de toast a cada 5 min).
      onSentinel: (kind) => twSession.markSessionLost(kind),
    },
  );
  twSession.onStatusChanged(async (status) => {
    if (status.state !== 'logged-in') return;
    await journal.append('session', 'login', `mundo=${status.world ?? '?'} jogador=${status.player ?? '?'}`, false);
  });
}

if (process.platform === 'win32') app.setAppUserModelId('com.toxicsquad.staffhub');
app.whenReady().then(async () => {
  await journal.load();
  // C1: pacing persistido aplica no BOOT — a fila já nasce com os valores do
  // usuário (nunca 350ms default sem ele saber).
  const persistedSettings = sanitizeSettings(await settingsStore.load());
  void twSession.restoreFromPartition();
  // registerIpc() fica PARA DEPOIS do gate central (abaixo): ele registra
  // session:open-login / session:login-sid / tminus:schedule /
  // dev:capture-fixture, que estão em CANAIS_PROTEGIDOS — chamá-lo antes do
  // wrapper deixaria os 4 canais UNGATED (P1 da revisão 2 da v0.35).
  wireEvents({
    minIntervalMs: persistedSettings.requestMinIntervalMs,
    jitterMs: persistedSettings.requestJitterMs,
    ceiling: persistedSettings.requestCeiling,
  });

  // v0.30 — sessão do SISTEMA (staffhub-auth na VPS), ANTES de qualquer
  // registro de IPC: o wrapper abaixo precisa existir primeiro.
  const authService = new AuthService({
    journal,
    onChange: (status) => send('auth:changed', status),
  });

  // GATE CENTRAL (defesa em profundidade): canais de PRODUTO exigem sessão
  // válida do sistema (logado/offline-72h). Updater/journal/prefs/settings
  // ficam LIVRES (diagnóstico e atualização continuam funcionando).
  const CANAIS_PROTEGIDOS = [
    'world:refresh', 'world:relations', 'world:villages', 'world:players', 'world:tribes',
    'world:noble-minutes', 'world:night-bonus', 'world:morale-info', 'world:unit-pops', 'world:unit-speeds',
    'sg1:analyze',
    'troops:collect-members', 'troops:collect-summary',
    'sg3:', 'sg5:', 'sg6:', 'sg7:',
    'oparchive:', 'opshare:', 'plannerDraft:',
    'tminus:schedule',
    'session:open-login', 'session:login-sid',
    'dev:capture-fixture',
  ];
  const canalProtegido = (canal: string): boolean => CANAIS_PROTEGIDOS.some((prefixo) => canal.startsWith(prefixo));
  const handleOriginal = ipcMain.handle.bind(ipcMain);
  (ipcMain as { handle: typeof ipcMain.handle }).handle = (canal, handler) =>
    handleOriginal(canal, (event, ...args) => {
      if (canalProtegido(canal)) authService.exigeSessao();
      return (handler as (ev: Electron.IpcMainInvokeEvent, ...a: unknown[]) => unknown)(event, ...args);
    });

  // DEPOIS do wrapper: tudo que registrar aqui passa pelo gate (só os
  // prefixos da lista são bloqueados — os demais seguem livres).
  registerIpc();
  registerAuthIpc({ auth: authService });
  registerWorldIpc({ twSession, queue: queue as RequestQueue, journal, worldData, sg1: sg1Service });
  const troopsService = new TroopsService(twSession, queue as RequestQueue, journal, settingsStore);
  registerTroopsIpc({ twSession, queue: queue as RequestQueue, journal, troops: troopsService });
  registerSg3Ipc({ troops: troopsService, journal });
  registerSupportersIpc(new SupportersService(twSession, queue as RequestQueue, journal, worldData, settingsStore));
  const sg5Service = new Sg5Service(twSession, queue as RequestQueue, journal, worldData, settingsStore);
  registerSg5Ipc({ sg5: sg5Service, journal });
  const sg6Service = new Sg6Service(twSession, journal, settingsStore, queue as RequestQueue);
  registerSg6Ipc({ sg6: sg6Service, journal });
  registerSg7Ipc(new Sg7Service(twSession, journal, queue as RequestQueue, settingsStore));
  registerOpIpc({ journal, opArchive: new OpArchiveService(journal), world: () => twSession.getStatus().world ?? 'desconhecido' });
  registerGroupsIpc({ journal, groups: new GroupsService(journal) });
  registerPreferencesIpc({ journal });
  registerPlannerDraftIpc({ journal });
  registerTemplatesIpc({ journal });
  registerHistoryIpc({ journal });

  // Restaura a sessão persistida (safeStorage) antes da janela: a UI já nasce
  // no estado certo (logado/offline/deslogado).
  await authService.boot();

  // E2E do auth (scripts/e2e-auth.mjs): SHS_AUTH_E2E=<arquivo> SHS_AUTH_NICK
  // SHS_AUTH_SENHA — faz login real contra a VPS e despeja o resultado (com
  // admin, inclui adminUsers — regressão do GET da revisão 0.30.1).
  const authE2ePath = process.env.SHS_AUTH_E2E;
  if (authE2ePath !== undefined && authE2ePath !== '') {
    const resultado = await authService.login(process.env.SHS_AUTH_NICK ?? '', process.env.SHS_AUTH_SENHA ?? '');
    let admin: unknown = null;
    if (resultado.ok && resultado.user.role === 'admin') {
      admin = await authService.adminUsers().catch((erro: unknown) => ({ erro: String(erro) }));
    }
    const fsPromises = await import('node:fs/promises');
    await fsPromises.writeFile(
      authE2ePath,
      JSON.stringify({ login: resultado, status: authService.status(), admin }, null, 2),
      'utf8',
    );
    console.log(`[e2e-auth] resultado escrito em ${authE2ePath}`);
    app.exit(0);
    return;
  }

  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
  void runUpdaterE2eHook();
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
