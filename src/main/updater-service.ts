// Atualizador do app portable pelo canal oficial (VPS + nginx + latest.json).
// Fail-closed em todas as etapas: manifest inválido, hash divergente, zip sem
// o executável ou pasta de staging corrompida ABORTEM sem tocar na instalação
// atual. A troca de pasta só acontece pelo script .cmd externo (buildSwapScript
// do @shared/updater-core) depois que o app sai — o .exe rodando fica travado.
//
// REGRAS DE ROBUSTEZ (aprendidas com o E2E real):
// - NUNCA usar execSync: bloqueia o event loop do main (journal, IPC, tudo
//   congela — o usuário vê a UI morrendo sem erro em lugar nenhum).
// - emit() NUNCA lança (webContents destruído não pode derrubar o catch).
// - No catch: journal PRIMEIRO, emit depois — o journal é a fonte de verdade
//   para diagnóstico póstumo.
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { Journal } from './journal';
import type { JsonStore } from './stores/json-store';
import type {
  AppSettings,
  UpdateCheckResult,
  UpdateManifest,
  UpdateProgress,
  UpdateVersionEntry,
} from '@shared/ipc-types';
import { buildSwapScript, compareVersions, isNewerVersion, isValidManifest, verifyManifestSignature } from '@shared/updater-core';

const EXE_NAME = 'Staff Hub Toxic Squad.exe';
const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * Valida UMA entrada do inventário versions.json: fail-closed em qualquer campo
 * torto + pin de host (o zip tem que vir do MESMO host do canal). O `sig` da
 * entrada cobre o canônico com notes VAZIO (ver publish-update.mjs).
 */
function entradaValida(value: unknown, channelHost: string): UpdateVersionEntry | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const rec = value as Record<string, unknown>;
    const version = rec['version'];
    const url = rec['url'];
    const sha256 = rec['sha256'];
    const sig = rec['sig'];
    const releasedAt = rec['releasedAt'];
    if (typeof version !== 'string' || !VERSION_RE.test(version)) return null;
    if (typeof url !== 'string' || !/^https?:\/\/\S+$/.test(url)) return null;
    if (new URL(url).host !== channelHost) return null;
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) return null;
    if (typeof sig !== 'string' || sig.length === 0) return null;
    if (typeof releasedAt !== 'string' || !Number.isFinite(Date.parse(releasedAt))) return null;
    return { version, url, sha256, sig, releasedAt };
  } catch {
    return null;
  }
}

/**
 * Extração de zip via tar.exe NATIVO do Windows (10+ inclui bsdtar com
 * suporte a zip). O extract-zip (npm) tem bug no Electron empacotado: a
 * promise nunca resolve mesmo com a extração completa — o await trava para
 * sempre (confirmado por debug-log: "ETAPA 6" gravada, arquivos extraídos,
 * mas "ETAPA 6-OK" jamais escrita).
 */
function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(destDir, { recursive: true });
    execFile('C:\\Windows\\System32\\tar.exe', ['-xf', zipPath, '-C', destDir], {
      windowsHide: true,
      timeout: 120_000,
    }, (error) => {
      if (error !== null) {
        reject(new Error(`Falha ao extrair o pacote: ${error.message}`));
        return;
      }
      resolve();
    });
  });
}

/** Log de diagnóstico do atualizador (fora do journal — sobrevive a travamentos
 *  do event loop e da cadeia de persistência). Uma linha por etapa. */
function debugLog(message: string): void {
  try {
    const dir = join(app.getPath('userData'), 'updates');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'updater-debug.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // best-effort — nunca derrubar o fluxo por causa do log
  }
}

export class UpdaterService {
  /** staging preparado pela última downloadAndPrepare bem-sucedida. */
  private prepared: { version: string; scriptPath: string } | null = null;
  /** Mutex: um download por vez (defesa em profundidade contra remount da UI). */
  private running = false;
  /** Última versão anunciada no journal (evita linha duplicada a cada visita ao Início). */
  private lastAnnouncedVersion: string | null = null;
  /** Último progresso emitido — o check() devolve para o card nascer no estágio
   *  certo ao remontar (o Início desmonta ao navegar; o download continua). */
  private lastProgress: UpdateProgress | null = null;

  constructor(
    private readonly settingsStore: JsonStore<AppSettings>,
    private readonly journal: Journal,
    private readonly sendProgress: (progress: UpdateProgress) => void,
  ) {}

  private async endpoint(): Promise<string> {
    const settings = await this.settingsStore.load();
    const url = settings.updateUrl.trim();
    return /^https?:\/\/\S+$/.test(url) ? url : 'http://74.0.5.75/staffhub/latest.json';
  }

  /** NUNCA lança: webContents destruída não pode derrubar o fluxo de update. */
  private emit(progress: UpdateProgress): void {
    this.lastProgress = progress;
    try {
      this.sendProgress(progress);
    } catch {
      // janela fechada/destruída — o fluxo continua mesmo sem UI ouvindo
    }
  }

  /** Verifica o canal (fail-soft): nunca lança — problemas voltam em `error`. */
  async check(): Promise<UpdateCheckResult> {
    const currentVersion = app.getVersion();
    try {
      const endpoint = await this.endpoint();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let manifest: UpdateManifest | null = null;
      try {
        // redirect: 'error' — o manifest não pode vir de redirecionamento
        // (o pin de host compara a URL do canal, não a destino final).
        const response = await fetch(endpoint, { signal: controller.signal, cache: 'no-store', redirect: 'error' });
        if (!response.ok) throw new Error(`canal respondeu HTTP ${response.status}`);
        const body: unknown = await response.json();
        manifest = isValidManifest(body);
        if (manifest === null) throw new Error('latest.json com formato inesperado no canal de atualização.');
      } finally {
        clearTimeout(timer);
      }
      // Hardening: o zip vem do MESMO host do canal configurado — manifest
      // trocado apontando para outro servidor não é aceito.
      const channelHost = new URL(endpoint).host;
      const zipHost = new URL(manifest.url).host;
      if (zipHost !== channelHost) throw new Error('URL do download em host diferente do canal — manifest recusado.');
      const updateAvailable = isNewerVersion(manifest.version, currentVersion);
      if (updateAvailable && manifest.version !== this.lastAnnouncedVersion) {
        this.lastAnnouncedVersion = manifest.version;
        await this.journal.append('system', 'update-available', `versão ${manifest.version} (atual ${currentVersion})`, false);
      }
      return {
        currentVersion,
        latestVersion: manifest.version,
        updateAvailable,
        ...(updateAvailable ? { manifest } : {}),
        // Estado vivo do atualizador: o card do Início desmonta ao navegar —
        // com isso ele RENASCE no estágio certo (download em curso ou já pronta).
        ...(this.running
          ? { downloadInProgress: true, ...(this.lastProgress !== null ? { lastProgress: this.lastProgress } : {}) }
          : {}),
        ...(this.prepared !== null ? { preparedVersion: this.prepared.version } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { currentVersion, latestVersion: currentVersion, updateAvailable: false, error: message };
    }
  }

  /** Baixa + confere SHA-256 + extrai em staging + gera o script de troca. */
  async downloadAndPrepare(): Promise<{ ok: boolean; detail: string }> {
    if (this.running) {
      // Remonta do card (Início desmonta ao navegar) ou clique duplo: NÃO é
      // falha — re-emite o último progresso para qualquer ouvinte novo e devolve
      // o aviso informativo (a UI trata como informação, não como erro).
      debugLog('MUTEX: download já em andamento');
      if (this.lastProgress !== null) this.emit(this.lastProgress);
      return { ok: false, detail: 'O download já está em andamento — acompanhe o progresso abaixo.' };
    }
    if (!app.isPackaged) {
      return { ok: false, detail: 'Atualização disponível apenas na versão instalada (portable) — em modo dev use o build novo.' };
    }
    this.running = true;
    try {
      return await this.doDownloadAndPrepare();
    } finally {
      this.running = false;
    }
  }

  /**
   * Inventário de versões anteriores do canal (versions.json) para rollback.
   * Fail-soft: canal sem inventário (404 — zips pré-0.36.0), rede fora ou JSON
   * torto → lista vazia. Cada entrada é validada fail-closed e PINADA ao host
   * do canal; só entram versões ESTRITAMENTE mais antigas que a instalada.
   */
  async listAvailableVersions(): Promise<{ versions: UpdateVersionEntry[] }> {
    const current = app.getVersion();
    try {
      const endpoint = await this.endpoint();
      const versionsUrl = new URL('versions.json', new URL('.', new URL(endpoint))).href;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let body: unknown;
      try {
        const response = await fetch(versionsUrl, { signal: controller.signal, cache: 'no-store', redirect: 'error' });
        if (!response.ok) return { versions: [] };
        body = await response.json();
      } finally {
        clearTimeout(timer);
      }
      if (!Array.isArray(body)) return { versions: [] };
      const channelHost = new URL(versionsUrl).host;
      const vistas = new Set<string>();
      const versions: UpdateVersionEntry[] = [];
      for (const item of body) {
        const entry = entradaValida(item, channelHost);
        if (entry === null || vistas.has(entry.version)) continue;
        vistas.add(entry.version);
        if (compareVersions(entry.version, current) < 0) versions.push(entry);
      }
      versions.sort((a, b) => compareVersions(b.version, a.version));
      return { versions };
    } catch {
      return { versions: [] };
    }
  }

  /**
   * Baixa e prepara uma versão ESPECÍFICA (rollback). Mesmo pipeline do
   * downloadAndPrepare mas com URL/version/sha256/sig fornecidos pelo
   * inventário assinado do canal. Hardening 0.36.0: sha256 tem que ser 64-hex
   * NÃO vazio (o antigo bypass "sha vazio = pular verificação" era um caminho
   * de RCE sem autenticação — canais ficam UNGATED de propósito) e a
   * assinatura Ed25519 da entrada TEM que conferir antes de qualquer download.
   */
  async prepareVersion(version: string, url: string, sha256: string, sig?: string): Promise<{ ok: boolean; detail: string }> {
    if (this.running) {
      return { ok: false, detail: 'Download já em andamento — aguarde.' };
    }
    if (!app.isPackaged) {
      return { ok: false, detail: 'Rollback disponível apenas na versão instalada.' };
    }
    if (!VERSION_RE.test(version)) {
      return { ok: false, detail: `Versão inválida para rollback: ${version} (use o formato X.Y.Z).` };
    }
    if (!/^https?:\/\/\S+$/.test(url)) {
      return { ok: false, detail: `URL inválida para rollback: ${url}` };
    }
    // Mesmo host-pin do check(): o zip do rollback vem do MESMO host do canal
    // configurado — entrada apontando para outro servidor é recusada.
    const endpoint = await this.endpoint();
    if (new URL(url).host !== new URL(endpoint).host) {
      return { ok: false, detail: 'URL do rollback em host diferente do canal — recusada.' };
    }
    if (!SHA256_RE.test(sha256)) {
      return { ok: false, detail: 'Rollback sem SHA-256 válido — recusado (a entrada precisa vir do inventário assinado do canal).' };
    }
    // O sig da entrada cobre o canônico com notes VAZIO (mesma regra do
    // publish-update.mjs ao publicar versions.json).
    const manifest: UpdateManifest = {
      version,
      notes: '',
      url,
      sha256: sha256.toLowerCase(),
      releasedAt: new Date().toISOString(),
      sig: sig ?? '',
    };
    if (!verifyManifestSignature(manifest)) {
      return { ok: false, detail: 'Assinatura do rollback inválida ou ausente — recusado. Atualize o app pelo canal e tente de novo.' };
    }
    debugLog(`ROLLBACK: preparar v${version} de ${url}`);
    this.running = true;
    try {
      return await this.doDownloadAndPrepareWithManifest(manifest);
    } finally {
      this.running = false;
    }
  }

  private async doDownloadAndPrepare(): Promise<{ ok: boolean; detail: string }> {
    debugLog('ETAPA 1: iniciar downloadAndPrepare');
    try {
      await this.journal.append('system', 'update-download-start', 'downloadAndPrepare iniciado', false);
      debugLog('ETAPA 2: check do canal');
      const check = await this.check();
      const manifest = check.manifest;
      if (manifest === undefined) {
        const detail = check.error ?? `Você já está na versão mais recente (${check.currentVersion}).`;
        debugLog(`ETAPA 2-FALHA: sem manifest (${detail})`);
        await this.journal.append('system', 'update-error', `check sem manifest: ${detail}`, false);
        return { ok: false, detail };
      }
      return await this.doDownloadAndPrepareWithManifest(manifest);
    } catch (error) {
      return this.handlePrepareError(error);
    }
  }

  /** Pipeline compartilhado entre update normal e rollback. */
  private async doDownloadAndPrepareWithManifest(manifest: UpdateManifest): Promise<{ ok: boolean; detail: string }> {
    try {
      // Idempotência: staging já preparado para ESTA versão.
      if (this.prepared !== null && this.prepared.version === manifest.version && existsSync(this.prepared.scriptPath)) {
        debugLog(`ETAPA 2-IDEMPOTENTE: v${manifest.version} já preparada`);
        this.emit({ phase: 'ready', version: manifest.version });
        return { ok: true, detail: `Versão ${manifest.version} pronta — clique em Reiniciar e atualizar.` };
      }
      this.prepared = null;

      const updatesDir = join(app.getPath('userData'), 'updates');
      debugLog('ETAPA 3: limpar staging anterior');
      rmSync(updatesDir, { recursive: true, force: true });
      mkdirSync(updatesDir, { recursive: true });
      const zipPath = join(updatesDir, `staffhub-${manifest.version}.zip`);

      // 1. Download com progresso (stream → arquivo). Idle-timeout por chunk:
      // 60s sem nada chegando = conexão travada → aborta limpo.
      debugLog('ETAPA 4: baixar zip');
      this.emit({ phase: 'download', receivedBytes: 0, totalBytes: 0 });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      let response: Response;
      try {
        response = await fetch(manifest.url, { signal: controller.signal, redirect: 'error' });
        if (!response.ok || response.body === null) throw new Error(`download falhou (HTTP ${response.status}).`);
      } finally {
        clearTimeout(timer);
      }
      debugLog(`ETAPA 4-OK: HTTP ${response.status}, content-length=${response.headers.get('content-length') ?? '?'}`);
      const totalBytes = Number(response.headers.get('content-length') ?? 0);
      let received = 0;
      const hash = createHash('sha256');
      const fileStream = createWriteStream(zipPath);
      const reader = response.body.getReader();
      let lastEmitAt = 0;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const clearIdle = (): void => {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
      };
      try {
        for (;;) {
          clearIdle();
          const idle = new Promise<never>((_, reject) => {
            idleTimer = setTimeout(() => reject(new Error('download demorou demais — conexão travou.')), 60_000);
          });
          idle.catch(() => undefined); // perdedor da race nunca vira unhandled
          const { done, value } = await Promise.race([reader.read(), idle]);
          if (done === true) break;
          if (value !== undefined) {
            received += value.byteLength;
            hash.update(value);
            fileStream.write(value);
            const now = Date.now();
            if (now - lastEmitAt > 250) {
              lastEmitAt = now;
              this.emit({ phase: 'download', receivedBytes: received, totalBytes });
            }
          }
        }
      } finally {
        clearIdle();
        await new Promise<void>((resolve) => fileStream.end(resolve));
      }
      debugLog(`ETAPA 4-FIM: ${received} bytes recebidos`);
      if (totalBytes > 0 && received !== totalBytes) {
        throw new Error(`download incompleto (${received} de ${totalBytes} bytes).`);
      }
      this.emit({ phase: 'download', receivedBytes: received, totalBytes: received || totalBytes });

      // 2. Integridade: SHA-256 do arquivo baixado × manifest — OBRIGATÓRIO.
      // O bypass "sha vazio = pular verificação" foi extinto no hardening
      // 0.36.0 (rollback sem sha era RCE sem autenticação pelo renderer).
      debugLog('ETAPA 5: verificar SHA-256');
      this.emit({ phase: 'verify' });
      if (!SHA256_RE.test(manifest.sha256)) {
        throw new Error('manifest sem SHA-256 válido — recusado, nada foi alterado.');
      }
      const sha256 = hash.digest('hex');
      if (sha256 !== manifest.sha256.toLowerCase()) {
        rmSync(zipPath, { force: true });
        throw new Error('integridade conferida e REPROVADA (SHA-256 divergente) — arquivo descartado, nada foi alterado.');
      }
      debugLog('ETAPA 5-OK: sha confere');

      // 3. Extração para staging.
      debugLog('ETAPA 6: extrair zip (tar.exe nativo)');
      this.emit({ phase: 'extract' });
      const stagedDir = join(updatesDir, manifest.version);
      await extractZip(zipPath, stagedDir);
      debugLog('ETAPA 6-OK: extraído');
      // O zip do packager contém "Staff Hub Toxic Squad-win32-x64/…": achamos o
      // diretório que contém o .exe (fail-closed se não existir).
      let appDir: string | null = null;
      if (existsSync(join(stagedDir, EXE_NAME))) {
        appDir = stagedDir;
      } else {
        const inner = join(stagedDir, 'Staff Hub Toxic Squad-win32-x64');
        if (existsSync(join(inner, EXE_NAME))) appDir = inner;
      }
      if (appDir === null || !statSync(appDir).isDirectory()) {
        throw new Error('pacote extraído sem o executável do app — atualização abortada.');
      }
      debugLog(`ETAPA 6-OK: exe encontrado em ${appDir}`);

      // 4. Script PowerShell de troca (em %TEMP%): espera este processo sair,
      // troca as pastas, relança e limpa. PowerShell lê Unicode nativamente —
      // ZERO problema de codepage, ZERO dependência de caminho curto 8.3.
      debugLog('ETAPA 7: gerar script PowerShell de troca');
      const stamp = `${Date.now()}`;
      // Script em userData/updates (caminho LONGO Unicode): app.getPath('temp')
      // devolve forma curta 8.3 (C:\Users\USURIO~2\...) que o Set-Location
      // -LiteralPath do PowerShell não resolve.
      const scriptPath = join(updatesDir, `staffhub-update-${stamp}.ps1`);
      const currentAppDir = join(process.execPath, '..');
      const script = buildSwapScript({
        pid: process.pid,
        appDir: currentAppDir,
        stagedDir: appDir,
        exeName: EXE_NAME,
        stamp,
      });
      writeFileSync(scriptPath, script, 'utf8');
      debugLog(`ETAPA 7-OK: script .ps1 em ${scriptPath}`);

      this.prepared = { version: manifest.version, scriptPath };
      debugLog(`ETAPA 8: PRONTO — v${manifest.version}`);
      this.emit({ phase: 'ready', version: manifest.version });
      await this.journal.append('system', 'update-ready', `versão ${manifest.version} preparada — aguardando reinício`, false);
      return { ok: true, detail: `Versão ${manifest.version} pronta — clique em Reiniciar e atualizar.` };
    } catch (error) {
      return this.handlePrepareError(error);
    }
  }

  /** Tratamento de erro compartilhado entre update normal e rollback. */
  private async handlePrepareError(error: unknown): Promise<{ ok: boolean; detail: string }> {
    const message = error instanceof Error ? error.message : String(error);
    const location = error instanceof Error && error.stack !== undefined ? (error.stack.split('\n')[1] ?? '').trim() : '';
    debugLog(`ERRO: ${message} @ ${location}`);
    try {
      await this.journal.append('system', 'update-error', `${message} @ ${location}`, false);
    } catch {
      // best-effort
    }
    this.emit({ phase: 'error', detail: message });
    return { ok: false, detail: message };
  }

  /** Sai do app executando o script de troca (só depois de downloadAndPrepare ok). */
  async restartToUpdate(): Promise<void> {
    if (this.prepared === null) {
      throw new Error('Nenhuma atualização preparada — baixe primeiro (Atualizar agora).');
    }
    const { scriptPath, version } = this.prepared;
    if (!existsSync(scriptPath)) {
      throw new Error('Script de atualização sumiu da pasta temporária — baixe de novo.');
    }
    debugLog(`REINICIAR: spawn cmd /c start powershell -File "${scriptPath}" e sair`);
    // CRÍTICO: powershell spawnado como filho detached DIRETO morre quando o
    // app sai (comprovado por harness — spawn-kill: filho não roda NADA, sem
    // nem erro de spawn). O `start` do cmd.exe cria o processo num contexto
    // independente que sobrevive à morte do pai — único caminho que funciona.
    // /min + -WindowStyle Hidden: o console novo não pisca na tela do usuário.
    const updatesDir = join(app.getPath('userData'), 'updates');
    let child: ChildProcess;
    try {
      child = spawn('cmd.exe', [
        '/c', 'start', '', '/min', 'powershell.exe',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', scriptPath,
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        // cwd FORA da pasta do app: o Windows não renomeia a pasta que é CWD de
        // um processo — herdar a pasta do app travava o Rename da FASE 2.
        cwd: updatesDir,
      });
    } catch (error) {
      const message = `Falha ao iniciar o script de troca: ${error instanceof Error ? error.message : String(error)}`;
      debugLog(`REINICIAR-ERRO: ${message}`);
      await this.journal.append('system', 'update-error', message, false).catch(() => undefined);
      throw new Error(message);
    }
    // Quit-on-spawn-fail: se o spawn falhar, o app NÃO fecha (destruir as
    // janelas sem a troca marcada deixaria o usuário sem hub). Confirma o
    // spawn ANTES de sair; falhou → devolve o erro (renderer mostra no estado
    // de erro) e o app continua aberto para tentar de novo.
    const spawnOk = await new Promise<boolean>((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    if (!spawnOk) {
      const message = 'Falha ao iniciar o script de troca — o hub NÃO foi fechado. Tente de novo.';
      debugLog(`REINICIAR-ERRO: ${message}`);
      await this.journal.append('system', 'update-error', message, false).catch(() => undefined);
      throw new Error(message);
    }
    await this.journal.append('system', 'update-apply', `saindo para aplicar a versão ${version}`, false);
    child.unref();
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    app.quit();
  }
}
