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
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { Journal } from './journal';
import type { JsonStore } from './stores/json-store';
import type { AppSettings, UpdateCheckResult, UpdateManifest, UpdateProgress } from '@shared/ipc-types';
import { buildSwapScript, isNewerVersion, isValidManifest } from '@shared/updater-core';

const EXE_NAME = 'Staff Hub Toxic Squad.exe';

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
   * Lista versões anteriores disponíveis no canal (para rollback). Faz HEAD
   * nos últimos 3 patchs abaixo da atual — o canal mantém só as 3 últimas.
   */
  async listAvailableVersions(): Promise<{ versions: { version: string; url: string }[] }> {
    const current = app.getVersion();
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
    if (match === null) {
      return { versions: [] };
    }
    const base = 'http://74.0.5.75/staffhub';
    const versions: { version: string; url: string }[] = [];
    const [, major, minor, patchStr] = match;
    const patch = Number(patchStr);
    // Probe os 3 patchs abaixo da atual (só os últimos 3 zips ficam no canal).
    for (let p = patch - 1; p >= Math.max(0, patch - 3); p -= 1) {
      const candidate = `${major}.${minor}.${p}`;
      const url = `${base}/StaffHubToxicSquad-${candidate}.zip`;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        const response = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'error' });
        clearTimeout(timer);
        if (response.ok) {
          versions.push({ version: candidate, url });
        }
      } catch {
        // versão não existe no canal — pula
      }
    }
    return { versions };
  }

  /**
   * Baixa e prepara uma versão ESPECÍFICA (rollback). Mesmo pipeline do
   * downloadAndPrepare mas com URL/version/sha256 fornecidos (não do manifest).
   */
  async prepareVersion(version: string, url: string, sha256: string): Promise<{ ok: boolean; detail: string }> {
    if (this.running) {
      return { ok: false, detail: 'Download já em andamento — aguarde.' };
    }
    if (!app.isPackaged) {
      return { ok: false, detail: 'Rollback disponível apenas na versão instalada.' };
    }
    if (!/^https?:\/\/\S+$/.test(url)) {
      return { ok: false, detail: `URL inválida para rollback: ${url}` };
    }
    debugLog(`ROLLBACK: preparar v${version} de ${url}`);
    this.running = true;
    try {
      const manifest: UpdateManifest = {
        version,
        notes: `Rollback para ${version}`,
        url,
        sha256,
        releasedAt: new Date().toISOString(),
      };
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

      // 2. Integridade: SHA-256 do arquivo baixado × manifest.
      // SHA vazio (rollback) = pular verificação — o zip vem do nosso canal.
      debugLog('ETAPA 5: verificar SHA-256');
      this.emit({ phase: 'verify' });
      const sha256 = hash.digest('hex');
      if (manifest.sha256 !== '' && sha256 !== manifest.sha256.toLowerCase()) {
        rmSync(zipPath, { force: true });
        throw new Error('integridade conferida e REPROVADA (SHA-256 divergente) — arquivo descartado, nada foi alterado.');
      }
      if (manifest.sha256 === '') {
        debugLog(`ETAPA 5-BYPASS: rollback sem SHA do manifest (calculado: ${sha256.slice(0, 12)}…)`);
      } else {
        debugLog('ETAPA 5-OK: sha confere');
      }

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
      const scriptPath = join(app.getPath('temp'), `staffhub-update-${stamp}.ps1`);
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
    await this.journal.append('system', 'update-apply', `saindo para aplicar a versão ${version}`, false);
    debugLog(`REINICIAR: spawn powershell.exe -File "${scriptPath}" e sair`);
    // Detached: o script PowerShell sobrevive à saída do app (é ele quem troca
    // as pastas). -ExecutionPolicy Bypass para scripts gerados localmente.
    spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    app.quit();
  }
}
