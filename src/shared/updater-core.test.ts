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
});
