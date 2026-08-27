// Núcleo PURO do sistema de atualização do app portable (sem rede, sem fs, sem DOM).
// Fluxo real: baixa zip novo → valida manifesto → extrai em userData/updates/<ver>/
// → gera script .ps1 externo que espera o processo sair, troca as pastas e relança.

/** Manifesto de atualização publicado pelo canal de releases. */
export interface UpdateManifest {
  version: string;
  notes: string;
  url: string;
  sha256: string;
  releasedAt: string;
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;
// Host presente e não-vazio antes da primeira barra (localhost é aceito por decisão do dono).
const URL_RE = /^https?:\/\/[^\s/]+\/\S*$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const MAX_NOTES_LENGTH = 600;

/**
 * Validação fail-closed TOTAL do manifesto: qualquer campo ausente, mal tipado
 * ou fora do formato → null. Nunca lança.
 */
export function isValidManifest(value: unknown): UpdateManifest | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const rec = value as Record<string, unknown>;
    const version = rec['version'];
    const notes = rec['notes'];
    const url = rec['url'];
    const sha256 = rec['sha256'];
    const releasedAt = rec['releasedAt'];

    if (typeof version !== 'string' || !VERSION_RE.test(version)) return null;
    if (typeof notes !== 'string' || notes.length > MAX_NOTES_LENGTH) return null;
    if (typeof url !== 'string' || !URL_RE.test(url)) return null;
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) return null;
    if (typeof releasedAt !== 'string' || !Number.isFinite(Date.parse(releasedAt))) return null;

    return { version, notes, url, sha256, releasedAt };
  } catch {
    return null;
  }
}

function parseSemver(v: string, rotulo: string): [number, number, number] {
  if (!VERSION_RE.test(v)) {
    throw new Error(`${rotulo} inválida: "${v}" — esperado o formato X.Y.Z (ex.: 0.15.0).`);
  }
  const partes = v.split('.').map((p) => Number(p));
  return [partes[0] ?? 0, partes[1] ?? 0, partes[2] ?? 0];
}

function comparar(x: number, y: number): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Compara duas versões X.Y.Z: -1 se a < b, 0 se iguais, 1 se a > b. Lança em input inválido. */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a, 'Versão "a"');
  const pb = parseSemver(b, 'Versão "b"');
  return comparar(pa[0], pb[0]) || comparar(pa[1], pb[1]) || comparar(pa[2], pb[2]);
}

/** true somente se candidate for ESTRITAMENTE maior que current. Lança em input inválido. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

export interface SwapScriptInput {
  pid: number;
  appDir: string;
  stagedDir: string;
  exeName: string;
  /** Sufixo do backup (.old-<stamp>). Gerado pelo CHAMADOR para o teste ser determinístico. */
  stamp: string;
  maxWaitSeconds?: number;
}

const DEFAULT_MAX_WAIT_SECONDS = 120;
// Caracteres proibidos em caminhos embutidos no script: quebrariam as linhas/
// here-strings do .ps1. Acentos são OK (PowerShell lê Unicode com o BOM UTF-8).
const CARACTERES_PROIBIDOS_RE = /["\r\n\0]/;

function exigir(condicao: boolean, mensagem: string): void {
  if (!condicao) throw new Error(mensagem);
}

function validarString(valor: string, campo: string): void {
  exigir(typeof valor === 'string' && valor.trim().length > 0, `Campo ${campo} não pode ser vazio.`);
  exigir(!CARACTERES_PROIBIDOS_RE.test(valor), `Campo ${campo} contém caractere proibido no script de troca.`);
}

/**
 * Gera o script PowerShell (.ps1) de troca de versão. PowerShell é ESCOLHIDO
 * em vez de .cmd porque: (1) lê caminhos UNICODE nativamente (cmd.exe lê no
 * codepage OEM e acentos como "Usuário" viram mojibake); (2) Start-Sleep
 * funciona em qualquer contexto, inclusive detached (diferente de timeout.exe
 * que exige console interativo); (3) Rename-Item/Move-Item com -LiteralPath
 * não interpretam wildcards. O script usa here-strings (@'...'@) para os
 * caminhos, imunes a espaços e caracteres especiais.
 */
export function buildSwapScript(input: SwapScriptInput): string {
  const { pid, appDir, stagedDir, exeName, stamp } = input;
  const maxWait = input.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS;

  exigir(Number.isInteger(pid) && pid >= 1, 'PID inválido.');
  validarString(appDir, 'appDir');
  validarString(stagedDir, 'stagedDir');
  validarString(exeName, 'exeName');
  validarString(stamp, 'stamp');
  exigir(
    Number.isInteger(maxWait) && maxWait >= 1,
    'maxWaitSeconds inválido — esperado inteiro >= 1.'
  );
  exigir(!/[\\/]$/.test(appDir), 'Campo appDir não pode terminar com separador.');

  const backupName = `shb-old-${stamp}`;
  const linhas = [
    '# Staff Hub Toxic Squad — script de troca de versão (PowerShell/Unicode)',
    '# Fases: 1) esperar o app sair  2) trocar pastas  3) relançar  4) limpeza.',
    '# Falha = NÃO toca nas pastas (fail-closed) e tenta reabrir a versão antiga.',
    "$ErrorActionPreference = 'Stop'",
    // here-strings: caminhos literais, sem interpolação, aceitam acentos/espaços
    `$AppDir = @'`,
    appDir,
    `'@`,
    `$StagedDir = @'`,
    stagedDir,
    `'@`,
    `$ExeName = @'`,
    exeName,
    `'@`,
    `$BackupName = @'`,
    backupName,
    `'@`,
    // Log da troca junto do staging (…\updates\swap-debug.log): a próxima
    // falha deixa evidência (stdio é ignore — Write-Host não chega a ninguém).
    `$LogPath = Join-Path (Split-Path (Split-Path $StagedDir -Parent) -Parent) 'swap-debug.log'`,
    `function Log([string]$msg) { try { Add-Content -LiteralPath $LogPath -Value ("{0} {1}" -f (Get-Date -Format o), $msg) -Encoding UTF8 } catch {} }`,
    `$TargetPid = ${pid}`,
    `$MaxWait = ${maxWait}`,
    // CRÍTICO: o Windows NÃO renomeia a pasta que é CWD de um processo. O
    // powershell spawner pelo app herda a pasta do app como CWD → o Rename da
    // FASE 2 falhava com "está em uso". Set-Location NÃO resolve sozinho (não
    // altera o CWD do processo Win32!) — é preciso o SetCurrentDirectory do
    // .NET para liberar o handle. Alvo = PAI da pasta do app (ex.: Desktop):
    // caminho longo Unicode confiável — NÃO usar $env:TEMP, que pode vir na
    // forma curta 8.3 e o -LiteralPath não resolve short names.
    'Set-Location -LiteralPath (Split-Path $AppDir -Parent)',
    '[System.Environment]::CurrentDirectory = (Split-Path $AppDir -Parent)',
    ``,
    `Log "INICIO pid=$TargetPid app=$AppDir staged=$StagedDir"`,
    `# FASE 1: aguardar o processo sair (o .exe fica travado enquanto roda).`,
    `$Waited = 0`,
    `while ((Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) -and ($Waited -lt $MaxWait)) {`,
    `    Start-Sleep -Seconds 1`,
    `    $Waited++`,
    `}`,
    `if ($Waited -ge $MaxWait) {`,
    `    Log "FALHA: processo $TargetPid nao saiu em $MaxWait segundos — pastas intocadas"`,
    `    exit 1`,
    `}`,
    `Log "FASE 1-OK: processo saiu apos $Waited s"`,
    ``,
    `# FASE 2: renomear a pasta atual para backup e mover a nova no lugar.`,
    `$BackupPath = Join-Path (Split-Path $AppDir -Parent) $BackupName`,
    `try {`,
    `    if (Test-Path -LiteralPath $BackupPath) { Remove-Item -LiteralPath $BackupPath -Recurse -Force }`,
    `    Rename-Item -LiteralPath $AppDir -NewName $BackupName`,
    `    Move-Item -LiteralPath $StagedDir -Destination $AppDir`,
    `} catch {`,
    `    Log ("FALHA na troca: " + $_.Exception.Message)`,
    `    # best-effort de rollback se o rename já aconteceu mas o move falhou`,
    `    if ((Test-Path -LiteralPath $BackupPath) -and -not (Test-Path -LiteralPath $AppDir)) {`,
    `        Rename-Item -LiteralPath $BackupPath -NewName (Split-Path $AppDir -Leaf)`,
    `    }`,
    `    # Reabrir a versão antiga: falhar a troca não pode deixar o usuário sem app.`,
    `    try { Start-Process -FilePath (Join-Path $AppDir $ExeName) } catch {}`,
    `    exit 2`,
    `}`,
    `Log "FASE 2-OK: pastas trocadas (backup: $BackupName)"`,
    ``,
    `# FASE 3: relançar o aplicativo já atualizado (best-effort: a troca já está`,
    `# feita — falha aqui é registrada, não desfaz nada).`,
    `$ExePath = Join-Path $AppDir $ExeName`,
    `try {`,
    `    Start-Process -FilePath $ExePath`,
    `    Log "FASE 3-OK: relancado $ExePath"`,
    `} catch {`,
    `    Log ("FALHA ao relancar: " + $_.Exception.Message)`,
    `    exit 3`,
    `}`,
    ``,
    `# FASE 4: limpeza best-effort (backup + este script).`,
    `try { Remove-Item -LiteralPath $BackupPath -Recurse -Force -ErrorAction SilentlyContinue } catch {}`,
    `try { Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue } catch {}`,
    `Log "FASE 4-OK: concluido"`,
    `exit 0`,
  ];

  // PowerShell exige BOM para ler UTF-8 com acentos corretamente.
  return `\uFEFF${linhas.join('\r\n')}\r\n`;
}

/** Fases informativas do ciclo de atualização (helper p/ UI/logs). */
export function updatePhases(): readonly string[] {
  return ['download', 'verify', 'extract', 'ready'] as const;
}
