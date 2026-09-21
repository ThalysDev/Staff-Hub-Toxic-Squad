// Núcleo PURO do sistema de atualização do app portable (sem rede, sem fs, sem
// DOM; node:crypto entra SÓ para a assinatura Ed25519 do manifesto — o canal é
// HTTP puro por decisão do dono, então a integridade vem da ASSINATURA).
// Fluxo real: baixa zip novo → valida manifesto → extrai em userData/updates/<ver>/
// → gera script .ps1 externo que espera o processo sair, troca as pastas e relança.
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/** Manifesto de atualização publicado pelo canal de releases. */
export interface UpdateManifest {
  version: string;
  notes: string;
  url: string;
  sha256: string;
  releasedAt: string;
  /** Assinatura Ed25519 (base64) da string canônica — publish-update.mjs assina. */
  sig: string;
}

/**
 * Chave PÚBLICA Ed25519 (SPKI DER em base64) que assina os manifests do canal.
 * Gerada por scripts/generate-update-keys.mjs; a privada fica em
 * dist/vps/update-keys/ (gitignored) com quem publica. Trocar de par de chaves
 * exige: --force no gerador, atualizar ESTA constante e publicar release nova
 * (clients antigos só aceitam manifest assinado pela chave que eles embutem).
 */
export const UPDATE_PUBKEY_B64 = 'MCowBQYDK2VwAyEAWyABU+pYpnMJlXvVduBckxejjwPl0R5Ex0nB6q/0ouo=';

/** String exata que é assinada/verificada: campos na ordem fixa, notes só pelo COMPRIMENTO. */
export function manifestCanonicalString(manifesto: Pick<UpdateManifest, 'version' | 'url' | 'sha256' | 'notes'>): string {
  return `${manifesto.version}\n${manifesto.url}\n${manifesto.sha256}\n${String(manifesto.notes.length)}`;
}

let chaveCacheada: ReturnType<typeof createPublicKey> | null = null;
function chavePublica(publicKeyB64: string): ReturnType<typeof createPublicKey> {
  if (chaveCacheada === null || chaveCacheadaB64 !== publicKeyB64) {
    chaveCacheada = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    chaveCacheadaB64 = publicKeyB64;
  }
  return chaveCacheada;
}
let chaveCacheadaB64 = '';

/**
 * Verifica a assinatura Ed25519 do manifesto. false para sig ausente/torta/
 * de outra chave ou para QUALQUER alteração dos campos assinados. Nunca lança.
 */
export function verifyManifestSignature(
  manifest: UpdateManifest,
  publicKeyB64: string = UPDATE_PUBKEY_B64,
): boolean {
  try {
    const assinatura = Buffer.from(manifest.sig, 'base64');
    // Assinatura Ed25519 tem exatamente 64 bytes.
    if (assinatura.length !== 64) return false;
    return cryptoVerify(
      null,
      Buffer.from(manifestCanonicalString(manifest), 'utf8'),
      chavePublica(publicKeyB64),
      assinatura,
    );
  } catch {
    return false;
  }
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;
// Host presente e não-vazio antes da primeira barra (localhost é aceito por decisão do dono).
const URL_RE = /^https?:\/\/[^\s/]+\/\S*$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
/** Teto de notas do canal — exportado para o publish-update.mjs rejeitar ANTES
 *  de subir um manifesto que TODO client rejeitaria. */
export const MAX_NOTES_LENGTH = 600;

/**
 * Validação fail-closed TOTAL do manifesto: qualquer campo ausente, mal tipado
 * ou fora do formato → null. O sha256 tem que ser 64-hex NÃO vazio e a
 * assinatura Ed25519 TEM que conferir com a chave pública embutida (o canal é
 * HTTP puro — sem assinatura válida não há atualização, sem exceção). Nunca lança.
 * O 2º parâmetro existe para TESTES (par gerado no teste); produção usa o default.
 */
export function isValidManifest(value: unknown, publicKeyB64: string = UPDATE_PUBKEY_B64): UpdateManifest | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const rec = value as Record<string, unknown>;
    const version = rec['version'];
    const notes = rec['notes'];
    const url = rec['url'];
    const sha256 = rec['sha256'];
    const releasedAt = rec['releasedAt'];
    const sig = rec['sig'];

    if (typeof version !== 'string' || !VERSION_RE.test(version)) return null;
    if (typeof notes !== 'string' || notes.length > MAX_NOTES_LENGTH) return null;
    if (typeof url !== 'string' || !URL_RE.test(url)) return null;
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) return null;
    if (typeof releasedAt !== 'string' || !Number.isFinite(Date.parse(releasedAt))) return null;
    if (typeof sig !== 'string' || sig.length === 0) return null;

    const manifesto: UpdateManifest = { version, notes, url, sha256, releasedAt, sig };
    if (!verifyManifestSignature(manifesto, publicKeyB64)) return null;
    return manifesto;
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
    '# Fases: 0) reparo  1) esperar o app sair  2) trocar pastas  3) relançar  4) limpeza (retenção de 7 dias).',
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
    // REPARO (brick de meio-troca): se uma execução anterior morreu ENTRE o
    // Rename e o Move da FASE 2, a pasta do app está AUSENTE e o backup existe.
    // Restaurar ANTES de qualquer fase — o usuário nunca fica com o app sumido.
    `$BackupPath = Join-Path (Split-Path $AppDir -Parent) $BackupName`,
    `if ((-not (Test-Path -LiteralPath $AppDir)) -and (Test-Path -LiteralPath $BackupPath)) {`,
    `    Log "REPARO: pasta do app ausente — restaurando de $BackupName"`,
    `    Rename-Item -LiteralPath $BackupPath -NewName (Split-Path $AppDir -Leaf)`,
    `    Log "REPARO-OK: pasta do app restaurada"`,
    `}`,
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
    `# FASE 4: limpeza best-effort com RETENÇÃO: backups shb-old-* com MAIS de`,
    `# 7 dias são removidos; o backup de hoje FICA 7 dias (rede de segurança caso`,
    `# o próximo swap morra no meio — o REPARO do próximo script depende dele).`,
    `try {`,
    `    $Corte = (Get-Date).AddDays(-7)`,
    `    Get-ChildItem -LiteralPath (Split-Path $AppDir -Parent) -Filter 'shb-old-*' -Directory -ErrorAction SilentlyContinue |`,
    `        Where-Object { $_.LastWriteTime -lt $Corte } |`,
    `        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }`,
    `} catch {}`,
    `# RECUPERACAO.txt ao lado do backup: o conserto manual de UMA linha em PT-BR,`,
    `# para o pior caso (o reparo automático do script não consegue rodar).`,
    `try {`,
    `    $Comando = 'Rename-Item -LiteralPath "{0}" -NewName "{1}"' -f $BackupPath, (Split-Path $AppDir -Leaf)`,
    `    Set-Content -LiteralPath (Join-Path (Split-Path $AppDir -Parent) 'RECUPERACAO.txt') -Value @('Se o Staff Hub nao abrir ou sumir, execute esta linha no PowerShell:', $Comando) -Encoding UTF8`,
    `} catch {}`,
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
