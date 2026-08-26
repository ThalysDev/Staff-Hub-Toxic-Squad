// Atualizador do app portable pelo canal oficial (VPS + nginx + latest.json).
// Fail-closed em todas as etapas: manifest inválido, hash divergente, zip sem
// o executável ou pasta de staging corrompida ABORTEM sem tocar na instalação
// atual. A troca de pasta só acontece pelo script .cmd externo (buildSwapScript
// do @shared/updater-core) depois que o app sai — o .exe rodando fica travado.
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import extract from 'extract-zip';
import type { Journal } from './journal';
import type { JsonStore } from './stores/json-store';
import type { AppSettings, UpdateCheckResult, UpdateManifest, UpdateProgress } from '@shared/ipc-types';
import { buildSwapScript, isNewerVersion, isValidManifest } from '@shared/updater-core';

const EXE_NAME = 'Staff Hub Toxic Squad.exe';

/** Caminho curto 8.3 (ASCII puro) de um caminho Windows — o cmd.exe lê o .cmd
 *  no codepage OEM e acentos do perfil (Usuário) corromperiam o ren/move.
 *  Fail-closed: se o volume não gerar path curto, erro claro (sem adivinhar). */
function shortPathOf(absolutePath: string): string {
  const result = execSync(`for %I in ("${absolutePath.replace(/"/g, '')}") do @echo %~sI`, {
    shell: 'cmd.exe',
    encoding: 'buffer',
    windowsHide: true,
    timeout: 10_000,
  })
    .toString('latin1')
    .trim();
  if (result === '' || /[^\x20-\x7E]/.test(result) || !existsSync(result)) {
    throw new Error(`Não consegui o caminho curto (8.3) de ${absolutePath} — verifique se nomes curtos estão habilitados no disco (fsutil 8dot3name).`);
  }
  return result;
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

  private emit(progress: UpdateProgress): void {
    this.lastProgress = progress;
    this.sendProgress(progress);
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

  private async doDownloadAndPrepare(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.journal.append('system', 'update-download-start', 'downloadAndPrepare iniciado', false);
      const check = await this.check();
      const manifest = check.manifest;
      if (manifest === undefined) {
        const detail = check.error ?? `Você já está na versão mais recente (${check.currentVersion}).`;
        await this.journal.append('system', 'update-error', `check sem manifest: ${detail}`, false);
        return { ok: false, detail };
      }
      // Idempotência: staging já preparado para ESTA versão (ex.: usuário
      // navegou para outra página e voltou ao Início, que remonta o card) —
      // não baixa de novo, só re-emite o estado pronto para a UI.
      if (this.prepared !== null && this.prepared.version === manifest.version && existsSync(this.prepared.scriptPath)) {
        this.emit({ phase: 'ready', version: manifest.version });
        return { ok: true, detail: `Versão ${manifest.version} pronta — clique em Reiniciar e atualizar.` };
      }
      this.prepared = null;

      const updatesDir = join(app.getPath('userData'), 'updates');
      rmSync(updatesDir, { recursive: true, force: true });
      mkdirSync(updatesDir, { recursive: true });
      const zipPath = join(updatesDir, `staffhub-${manifest.version}.zip`);

      // 1. Download com progresso (stream → arquivo). Deadline TOTAL (não só
      // a abertura): corpo travado no meio aborta em vez de pendurar a UI.
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
      const totalBytes = Number(response.headers.get('content-length') ?? 0);
      let received = 0;
      const hash = createHash('sha256');
      const fileStream = createWriteStream(zipPath);
      const reader = response.body.getReader();
      let lastEmitAt = 0;
      // Idle-timeout por chunk: 60s sem nada chegando = conexão travada →
      // aborta limpo (conexões lentas legítimas não são punidas por tempo total).
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
      if (totalBytes > 0 && received !== totalBytes) {
        throw new Error(`download incompleto (${received} de ${totalBytes} bytes).`);
      }
      this.emit({ phase: 'download', receivedBytes: received, totalBytes: received || totalBytes });

      // 2. Integridade: SHA-256 do arquivo baixado × manifest.
      this.emit({ phase: 'verify' });
      const sha256 = hash.digest('hex');
      if (sha256 !== manifest.sha256.toLowerCase()) {
        rmSync(zipPath, { force: true });
        throw new Error('integridade conferida e REPROVADA (SHA-256 divergente) — arquivo descartado, nada foi alterado.');
      }

      // 3. Extração para staging.
      this.emit({ phase: 'extract' });
      const stagedDir = join(updatesDir, manifest.version);
      mkdirSync(stagedDir, { recursive: true });
      await extract(zipPath, { dir: stagedDir });
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

      // 4. Script de troca (em %TEMP%): espera este processo sair, troca as
      // pastas, relança a nova versão e apaga o resto de si. O cmd.exe lê o
      // .cmd no codepage OEM — caminhos com ACENTO (ex.: C:\Users\Usuário)
      // viram mojibake e o ren falha. Caminhos curtos 8.3 são ASCII puro.
      const stamp = `${Date.now()}`;
      const scriptPath = join(app.getPath('temp'), `staffhub-update-${stamp}.cmd`);
      const currentAppDir = join(process.execPath, '..');
      const script = buildSwapScript({
        pid: process.pid,
        appDir: shortPathOf(currentAppDir),
        stagedDir: shortPathOf(appDir),
        exeName: EXE_NAME,
        stamp,
      });
      writeFileSync(scriptPath, script, 'ascii');

      this.prepared = { version: manifest.version, scriptPath };
      this.emit({ phase: 'ready', version: manifest.version });
      await this.journal.append('system', 'update-ready', `versão ${manifest.version} preparada — aguardando reinício`, false);
      return { ok: true, detail: `Versão ${manifest.version} pronta — clique em Reiniciar e atualizar.` };
    } catch (error) {
      const stack = error instanceof Error ? `${error.message} @ ${(error.stack ?? '').split('\n')[1]?.trim()}` : String(error);
      this.emit({ phase: 'error', detail: error instanceof Error ? error.message : String(error) });
      await this.journal.append('system', 'update-error', stack, false);
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
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
    // Detached: o .cmd sobrevive à saída do app (é ele quem troca as pastas).
    spawn('cmd.exe', ['/c', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    app.quit();
  }
}
