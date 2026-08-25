import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMemberVillageTroops } from '../../src/shared/parsers/ally-parsers';

const dir = process.env.MEMBERS_DIR ?? 'C:/Users/USURIO~2/AppData/Local/Temp/members';

describe('diagnóstico: parser por membro em páginas REAIS capturadas agora', () => {
  it('parseia todas as páginas de membros sem erro', () => {
    if (!existsSync(dir)) return; // só roda com páginas capturadas em /tmp/members
    const files = readdirSync(dir).filter((name) => name.endsWith('.html'));
    expect(files.length).toBeGreaterThanOrEqual(5);
    const summary: string[] = [];
    for (const file of files) {
      const html = readFileSync(`${dir}/${file}`, 'latin1');
      let label = 'OK';
      let count = -1;
      try {
        count = parseMemberVillageTroops(html).villages.length;
      } catch (error) {
        label = `ERRO: ${error instanceof Error ? error.message : String(error)}`;
      }
      summary.push(`${file}: ${label}${count >= 0 ? ` (${count} aldeias)` : ''}`);
    }
    console.log(summary.join('\n'));
    expect(summary.every((line) => !line.includes('ERRO'))).toBe(true);
  });
});
