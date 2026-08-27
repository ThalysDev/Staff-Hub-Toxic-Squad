import { describe, expect, it } from 'vitest';
import {
  buildSwapScript,
  compareVersions,
  isValidManifest,
  isNewerVersion,
  updatePhases,
  type SwapScriptInput,
} from './updater-core';

const MANIFESTO_VALIDO = {
  version: '0.15.0',
  notes: 'Correções na sala de guerra e novo resumo de chegadas.',
  url: 'https://releases.exemplo.com.br/staff-hub/staff-hub-0.15.0.zip',
  sha256: 'a'.repeat(64),
  releasedAt: '2026-08-26T12:00:00.000Z',
};

const SWAP_BASE: SwapScriptInput = {
  pid: 4321,
  appDir: 'C:\\Apps\\Staff Hub Toxic Squad-win32-x64',
  stagedDir: 'C:\\Users\\dono\\AppData\\Roaming\\staff-hub\\updates\\0.15.0\\Staff Hub Toxic Squad-win32-x64',
  exeName: 'Staff Hub Toxic Squad.exe',
  stamp: '20260826-103000',
};

describe('isValidManifest', () => {
  it('aceita um manifesto completo e válido', () => {
    expect(isValidManifest(MANIFESTO_VALIDO)).toEqual(MANIFESTO_VALIDO);
  });

  it('version fora do formato X.Y.Z → null', () => {
    expect(isValidManifest({ ...MANIFESTO_VALIDO, version: '1.2' })).toBeNull();
    expect(isValidManifest({ ...MANIFESTO_VALIDO, version: 'v1.2.3' })).toBeNull();
    expect(isValidManifest({ ...MANIFESTO_VALIDO, version: '1.2.3.4' })).toBeNull();
  });

  it('notes acima de 600 caracteres → null', () => {
    expect(isValidManifest({ ...MANIFESTO_VALIDO, notes: 'x'.repeat(601) })).toBeNull();
  });

  it('url sem http(s), sem host ou sem caminho → null', () => {
    expect(isValidManifest({ ...MANIFESTO_VALIDO, url: 'ftp://host/app.zip' })).toBeNull();
    expect(isValidManifest({ ...MANIFESTO_VALIDO, url: 'http:///app.zip' })).toBeNull();
    expect(isValidManifest({ ...MANIFESTO_VALIDO, url: 'https://host' })).toBeNull();
    expect(isValidManifest({ ...MANIFESTO_VALIDO, url: 'apenas-texto' })).toBeNull();
  });

  it('url em host localhost é aceita (decisão do dono: qualquer host http(s))', () => {
    expect(
      isValidManifest({ ...MANIFESTO_VALIDO, url: 'http://localhost:8080/staff-hub-0.15.0.zip' })
    ).toEqual({ ...MANIFESTO_VALIDO, url: 'http://localhost:8080/staff-hub-0.15.0.zip' });
  });

  it('sha256 torto → null (com 64 hex maiúsculos continua válido)', () => {
    expect(isValidManifest({ ...MANIFESTO_VALIDO, sha256: 'xyz' })).toBeNull();
    expect(isValidManifest({ ...MANIFESTO_VALIDO, sha256: 'g'.repeat(64) })).toBeNull();
    expect(isValidManifest({ ...MANIFESTO_VALIDO, sha256: `${'A'.repeat(63)}0` })).toEqual({
      ...MANIFESTO_VALIDO,
      sha256: `${'A'.repeat(63)}0`,
    });
  });

  it('releasedAt não parseável como data finita → null', () => {
    expect(isValidManifest({ ...MANIFESTO_VALIDO, releasedAt: 'nao-e-data' })).toBeNull();
    expect(isValidManifest({ ...MANIFESTO_VALIDO, releasedAt: '' })).toBeNull();
    expect(isValidManifest({ ...MANIFESTO_VALIDO, releasedAt: '2026-13-45T99:00:00Z' })).toBeNull();
  });

  it('campo ausente ou com tipo errado → null', () => {
    const semVersion = { ...MANIFESTO_VALIDO };
    delete (semVersion as Partial<typeof semVersion>).version;
    expect(isValidManifest(semVersion)).toBeNull();
    expect(isValidManifest({ ...MANIFESTO_VALIDO, version: 150 })).toBeNull();
    expect(isValidManifest({ ...MANIFESTO_VALIDO, notes: null })).toBeNull();
  });

  it('fail-closed TOTAL: null, array, string e número → null (nunca lança)', () => {
    expect(isValidManifest(null)).toBeNull();
    expect(isValidManifest(undefined)).toBeNull();
    expect(isValidManifest([MANIFESTO_VALIDO])).toBeNull();
    expect(isValidManifest('manifesto')).toBeNull();
    expect(isValidManifest(42)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('igual → 0; maior → 1; menor → -1', () => {
    expect(compareVersions('0.15.0', '0.15.0')).toBe(0);
    expect(compareVersions('0.15.0', '0.14.1')).toBe(1);
    expect(compareVersions('0.14.1', '0.15.0')).toBe(-1);
  });

  it('compara patch, minor e major nessa ordem', () => {
    expect(compareVersions('0.14.2', '0.14.1')).toBe(1);
    expect(compareVersions('0.15.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.15.0', '1.0.0')).toBe(-1);
  });

  it('input inválido lança erro PT-BR', () => {
    expect(() => compareVersions('1.2', '1.0.0')).toThrow(Error);
    expect(() => compareVersions('1.0.0', 'abc')).toThrow(/X\.Y\.Z/);
  });
});

describe('isNewerVersion', () => {
  it('candidate estritamente maior que current → true', () => {
    expect(isNewerVersion('0.15.0', '0.14.1')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
  });

  it('igual ou menor → false', () => {
    expect(isNewerVersion('0.14.1', '0.14.1')).toBe(false);
    expect(isNewerVersion('0.14.1', '0.15.0')).toBe(false);
  });

  it('input inválido lança', () => {
    expect(() => isNewerVersion('x', '0.14.1')).toThrow(Error);
  });
});

describe('updatePhases', () => {
  it('expõe as fases do ciclo de atualização', () => {
    expect(updatePhases()).toEqual(['download', 'verify', 'extract', 'ready']);
  });
});

describe('buildSwapScript (PowerShell .ps1)', () => {
  it('começa com BOM UTF-8 e usa CRLF', () => {
    const script = buildSwapScript(SWAP_BASE);
    expect(script.charCodeAt(0)).toBe(0xFEFF); // BOM
    expect(script.includes('\r\n')).toBe(true);
    for (const trecho of script.split('\r\n')) {
      expect(trecho.includes('\n')).toBe(false);
    }
  });

  it('fase de espera usa o PID no Get-Process e o teto configurado', () => {
    const script = buildSwapScript(SWAP_BASE);
    expect(script).toContain('$TargetPid = 4321');
    expect(script).toContain('Get-Process -Id $TargetPid');
    expect(script).toContain('$MaxWait = 120');
    expect(buildSwapScript({ ...SWAP_BASE, maxWaitSeconds: 90 })).toContain('$MaxWait = 90');
    expect(script).toContain('Start-Sleep -Seconds 1');
  });

  it('a espera NUNCA usa timeout.exe nem ping (PowerShell Start-Sleep é confiável)', () => {
    const script = buildSwapScript(SWAP_BASE);
    expect(script).not.toMatch(/timeout\s+\//i);
    expect(script).not.toContain('ping -n');
  });

  it('caminho com ACENTO é aceito (PowerShell é Unicode nativo)', () => {
    // Diferente do .cmd (codepage OEM → mojibake), PowerShell lê UTF-8 BOM
    // corretamente — C:\Users\Usuário funciona sem caminho curto 8.3.
    const script = buildSwapScript({ ...SWAP_BASE, appDir: 'C:\\Users\\Usuário\\AppData\\staff-hub' });
    expect(script).toContain('C:\\Users\\Usuário\\AppData\\staff-hub');
  });

  it('caminhos aparecem em here-strings @\'...\'@ (imunes a espaços/aspas)', () => {
    const script = buildSwapScript(SWAP_BASE);
    expect(script).toContain(`$AppDir = @'`);
    expect(script).toContain(SWAP_BASE.appDir);
    expect(script).toContain(`$StagedDir = @'`);
    expect(script).toContain(SWAP_BASE.stagedDir);
    expect(script).toContain(`$ExeName = @'`);
    expect(script).toContain(SWAP_BASE.exeName);
  });

  it('troca via Rename-Item + Move-Item com -LiteralPath (sem wildcards)', () => {
    const script = buildSwapScript(SWAP_BASE);
    expect(script).toContain('Rename-Item -LiteralPath $AppDir');
    expect(script).toContain('Move-Item -LiteralPath $StagedDir');
    expect(script).toContain('Start-Process -FilePath $ExePath');
  });

  it('tem rollback best-effort se o move falhar após o rename', () => {
    const script = buildSwapScript(SWAP_BASE);
    expect(script).toMatch(/[Rr]ollback/);
    expect(script).toContain('Rename-Item -LiteralPath $BackupPath');
  });

  it('o script apaga a si mesmo com $MyInvocation.MyCommand.Path', () => {
    expect(buildSwapScript(SWAP_BASE)).toContain('$MyInvocation.MyCommand.Path');
  });

  it('é determinístico: mesma entrada → mesma saída', () => {
    expect(buildSwapScript(SWAP_BASE)).toBe(buildSwapScript(SWAP_BASE));
  });

  it('entrada inválida fail-closed: lança erro PT-BR', () => {
    expect(() => buildSwapScript({ ...SWAP_BASE, pid: 0 })).toThrow(Error);
    expect(() => buildSwapScript({ ...SWAP_BASE, appDir: '' })).toThrow(/appDir/);
    expect(() => buildSwapScript({ ...SWAP_BASE, stamp: 'a"b' })).toThrow(/proibido/);
    expect(() => buildSwapScript({ ...SWAP_BASE, maxWaitSeconds: -1 })).toThrow(/maxWaitSeconds/);
  });

  it('muda de pasta ANTES de tudo (Set-Location + SetCurrentDirectory): o Windows não renomeia a pasta que é CWD de um processo', () => {
    // Regressão do bug real: o powershell herda a pasta do app como CWD e o
    // Rename-Item da FASE 2 falhava com "está em uso" — app fechava sem trocar.
    // Set-Location sozinho NÃO libera o handle: precisa do SetCurrentDirectory
    // do .NET. Alvo = PAI da pasta do app (longo/Unicode; $env:TEMP pode vir
    // curto 8.3, que o -LiteralPath não resolve).
    const script = buildSwapScript(SWAP_BASE);
    expect(script).toContain('Set-Location -LiteralPath (Split-Path $AppDir -Parent)');
    expect(script).toContain('[System.Environment]::CurrentDirectory = (Split-Path $AppDir -Parent)');
    const posicaoSet = script.indexOf('[System.Environment]::CurrentDirectory');
    const posicaoRename = script.indexOf('Rename-Item -LiteralPath $AppDir');
    expect(posicaoRename).toBeGreaterThan(posicaoSet);
  });

  it('condições booleanas usam -not (nunca o minus unário acidental)', () => {
    expect(buildSwapScript(SWAP_BASE)).not.toContain('-(Test-Path');
    expect(buildSwapScript(SWAP_BASE)).toContain('-not (Test-Path');
  });

  it('registra o progresso em swap-debug.log (evidência quando stdio é ignore)', () => {
    const script = buildSwapScript(SWAP_BASE);
    expect(script).toContain("'swap-debug.log'");
    expect(script).toContain('Log "FASE 1-OK');
    expect(script).toContain('Log "FASE 2-OK');
  });

  it('falha de relançamento é logada e NÃO derruba a troca já feita (exit 3)', () => {
    const script = buildSwapScript(SWAP_BASE);
    expect(script).toContain('FALHA ao relancar');
    expect(script).toContain('exit 3');
  });

  it('falha na troca tenta reabrir a versão antiga (usuário nunca fica sem app)', () => {
    const script = buildSwapScript(SWAP_BASE);
    expect(script).toContain('Start-Process -FilePath (Join-Path $AppDir $ExeName)');
  });
});

describe.skipIf(process.platform !== 'win32')('buildSwapScript — funcional (executa o PowerShell de verdade)', () => {
  it('troca as pastas MESMO com cwd herdado da pasta do app, e loga as fases', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const execFileAsync = promisify(execFile);

    // Sandbox sob o cwd (caminho LONGO, como app.getPath('exe') na produção):
    // os.tmpdir() devolve forma curta 8.3 (C:\Users\USURIO~2) quando o nome do
    // usuário tem acento — Set-Location -LiteralPath não resolve short names.
    const raiz = fs.mkdtempSync(path.join(process.cwd(), '.shb-swap-test-'));
    try {
      // Sandbox: app "antigo" (com o marcador velho) + staging da "nova".
      const appDir = path.join(raiz, 'Staff Hub Toxic Squad-win32-x64');
      const updatesDir = path.join(raiz, 'updates');
      const stagedDir = path.join(updatesDir, '0.99.9', 'Staff Hub Toxic Squad-win32-x64');
      fs.mkdirSync(appDir, { recursive: true });
      fs.mkdirSync(stagedDir, { recursive: true });
      fs.writeFileSync(path.join(appDir, 'marker-old.txt'), 'velho');
      fs.writeFileSync(path.join(stagedDir, 'marker-new.txt'), 'novo');

      // PID de um processo JÁ MORTO (FASE 1 passa na hora).
      const dead = (await import('node:child_process')).spawn('cmd.exe', ['/c', 'exit'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const pid = dead.pid ?? 0;
      await new Promise<void>((resolve) => dead.on('exit', () => resolve()));
      expect(pid).toBeGreaterThan(0);

      // exe proposital INEXISTENTE no staging: FASE 3 falha controlada (exit 3)
      // sem abrir janela nenhuma — a troca em si precisa ter acontecido.
      const script = buildSwapScript({
        pid,
        appDir,
        stagedDir,
        exeName: 'exe-que-nao-existe.exe',
        stamp: 'functest',
      });
      const scriptPath = path.join(raiz, 'swap-test.ps1');
      fs.writeFileSync(scriptPath, script, 'utf8');

      // cwd = a PRÓPRIA pasta do app: condição exata do bug de produção.
      await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { cwd: appDir, windowsHide: true, timeout: 30_000 },
      ).catch((error: { code?: number | string; stderr?: string }) => {
        // exit 3 é o desfecho esperado (relançamento falha no exe inexistente).
        if (String(error.code) !== '3') console.error('powershell stderr:', error.stderr);
        expect(String(error.code)).toBe('3');
      });

      // A troca aconteceu: pasta do app agora tem o conteúdo do staging.
      expect(fs.existsSync(path.join(appDir, 'marker-new.txt'))).toBe(true);
      expect(fs.existsSync(path.join(appDir, 'marker-old.txt'))).toBe(false);
      // Backup preservado (FASE 4 não roda após falha de relançamento).
      expect(fs.existsSync(path.join(raiz, 'shb-old-functest'))).toBe(true);
      // Evidência no log.
      const log = fs.readFileSync(path.join(updatesDir, 'swap-debug.log'), 'utf8');
      expect(log).toContain('FASE 2-OK');
      expect(log).toContain('FALHA ao relancar');
    } finally {
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  });
});
