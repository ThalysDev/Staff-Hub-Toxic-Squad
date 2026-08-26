// Núcleo PURO do sistema de atualização do app portable (sem rede, sem fs, sem DOM).
// Fluxo real: baixa zip novo → valida manifesto → extrai em userData/updates/<ver>/
// → gera script .cmd externo que espera o processo sair, troca as pastas e relança.

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
// Caracteres proibidos em caminhos embutidos no .cmd: quebrariam as linhas/aspas do script.
const CARACTERES_PROIBIDOS_RE = /["\r\n\0]/;
// O cmd.exe lê o .cmd no CODEPAGE OEM, não em UTF-8 — acentos no caminho
// (ex.: C:\Users\Usuário) viram mojibake e o ren/move procuram pasta
// inexistente. Caminhos no script devem ser ASCII (use o path curto 8.3).
const CARACTERE_NAO_ASCII_RE = /[^\x20-\x7E]/;

function exigir(condicao: boolean, mensagem: string): void {
  if (!condicao) throw new Error(mensagem);
}

function validarString(valor: string, campo: string): void {
  exigir(typeof valor === 'string' && valor.trim().length > 0, `Campo ${campo} não pode ser vazio.`);
  exigir(!CARACTERES_PROIBIDOS_RE.test(valor), `Campo ${campo} contém caractere proibido no .cmd.`);
  exigir(!CARACTERE_NAO_ASCII_RE.test(valor), `Campo ${campo} contém caractere não-ASCII (acento?) — o cmd.exe leria errado; converta para caminho curto 8.3 antes.`);
}

// Último segmento do caminho Windows (aceita "\\" ou "/" como separador).
function basename(dir: string): string {
  const idx = Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/'));
  return idx === -1 ? dir : dir.slice(idx + 1);
}

// Em arquivo .cmd, "%" literal deve ser escrito como "%%".
function escaparPercent(raw: string): string {
  return raw.replace(/%/g, '%%');
}

/**
 * Gera o CONTEÚDO do .cmd externo (salvo em %TEMP%) que troca as pastas do app portable:
 * espera o PID sair → renomeia appDir para .old-<stamp> → move a pasta staged (extraída
 * do zip) para o lugar → relança o exe → limpa backup e apaga a si mesmo. Determinístico:
 * nenhum timestamp é capturado aqui, o stamp vem do input.
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
  const nomePasta = basename(appDir);
  exigir(nomePasta.length > 0, 'Campo appDir não pode terminar com separador.');

  const app = escaparPercent(appDir);
  const staged = escaparPercent(stagedDir);
  const exe = escaparPercent(exeName);
  const selo = escaparPercent(stamp);
  const pastaVelhaNome = `${escaparPercent(nomePasta)}.old-${selo}`;
  const pastaVelhaCaminho = `${app}.old-${selo}`;

  const linhas = [
    '@echo off',
    'rem ================================================================',
    'rem Staff Hub Toxic Squad — script de troca gerado pelo updater.',
    `rem App: "${app}"`,
    `rem Nova pasta (extraída do zip): "${staged}"`,
    'rem Fases: 1) esperar o processo sair  2) renomear pasta antiga',
    'rem        3) mover pasta nova (fallback robocopy)  4) relançar o app',
    'rem        5) limpeza (backup .old + o próprio script)',
    'rem ================================================================',
    'setlocal enableextensions',
    `rem FASE 1: aguardar o processo atual (PID ${pid}) encerrar — o exe fica travado enquanto roda.`,
    'set SH_ESPERA=0',
    ':sh_aguarda_pid',
    `tasklist /FI "PID eq ${pid}" 2>nul | find /I "${pid}" >nul`,
    'if errorlevel 1 goto sh_pid_encerrado',
    `if %SH_ESPERA% GEQ ${maxWait} goto sh_tempo_esgotado`,
    // NUNCA usar `timeout /t 1` aqui: o script roda DETACHED (sem console),
    // e o timeout.exe exige stdin de console — falha na hora e o laço giraria
    // milhares de vezes por segundo até o tempo esgotar. O ping de loopback
    // dorme ~1s sem depender de console (idiom clássico de batch).
    'ping -n 2 127.0.0.1 >nul',
    'set /a SH_ESPERA+=1',
    'goto sh_aguarda_pid',
    ':sh_tempo_esgotado',
    `rem FASE 1 falhou: o processo não saiu em ${maxWait}s — abortar sem alterar pastas.`,
    'endlocal',
    'exit /b 1',
    ':sh_pid_encerrado',
    `rem FASE 2: renomear a pasta atual para "${pastaVelhaNome}" (só possível com o processo parado).`,
    `ren "${app}" "${pastaVelhaNome}"`,
    'if errorlevel 1 goto sh_limpeza',
    'rem FASE 3: mover a pasta extraída do zip para o lugar da antiga.',
    `move /Y "${staged}" "${app}" >nul`,
    'if errorlevel 1 goto sh_fallback_robocopy',
    'goto sh_iniciar_app',
    ':sh_fallback_robocopy',
    'rem Fallback da FASE 3: `move` falhou — mover a árvore completa com robocopy.',
    `robocopy "${staged}" "${app}" /E /MOVE >nul`,
    'if errorlevel 8 goto sh_limpeza',
    ':sh_iniciar_app',
    'rem FASE 4: relançar o aplicativo já atualizado.',
    `start "" "${app}\\${exe}"`,
    ':sh_limpeza',
    `rem FASE 5: limpeza best-effort — remover o backup "${pastaVelhaCaminho}" e apagar este script.`,
    `rd /s /q "${pastaVelhaCaminho}" >nul 2>&1`,
    'del "%~f0" >nul 2>&1',
    'endlocal',
    'exit /b 0',
  ];

  return `${linhas.join('\r\n')}\r\n`;
}

/** Fases informativas do ciclo de atualização (helper p/ UI/logs). */
export function updatePhases(): readonly string[] {
  return ['download', 'verify', 'extract', 'ready'] as const;
}
