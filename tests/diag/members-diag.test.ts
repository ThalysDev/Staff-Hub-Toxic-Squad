import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractPagedNavPages, parseMemberVillageTroops } from '../../src/shared/parsers/ally-parsers';
import { parseOwnUnitsTable } from '../../src/shared/parsers/village-parsers';

const dir = process.env.MEMBERS_DIR ?? 'C:/Users/USURIO~2/AppData/Local/Temp/members';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/br142/${name}`, import.meta.url)), 'latin1');
}

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

describe('pager de paginação (membro com 1000+ aldeias, fixture real BR142)', () => {
  it('página 1: parser ignora o pager e usa a tabela de dados DEPOIS dele (5 aldeias)', () => {
    const result = parseMemberVillageTroops(fixture('troops-own-paged-p1-rows.html'));
    expect(result.villages.length).toBe(5);
    const first = result.villages[0]!;
    expect(first.coord).toEqual({ x: 534, y: 551 }); // "(534|551)" no nome da aldeia
    expect(Number.isInteger(first.points)).toBe(true);
    expect(first.points).toBeGreaterThan(0);
  });

  it('página 2: parser ignora o pager (prev page=1) e parseia 4 aldeias', () => {
    const result = parseMemberVillageTroops(fixture('troops-own-paged-p2-rows.html'));
    expect(result.villages.length).toBe(4);
  });

  it('extractPagedNavPages: p1 → [2]; p2 → [] (só prev page=1 e página atual)', () => {
    expect(extractPagedNavPages(fixture('troops-own-paged-p1-rows.html'))).toEqual([2]);
    expect(extractPagedNavPages(fixture('troops-own-paged-p2-rows.html'))).toEqual([]);
  });

  it('extractPagedNavPages: ignora page=-1 ("todos") e page=0/1; dedupe e ordem', () => {
    const html = [
      "<a class='paged-nav-item' href=\"/game.php?screen=ally&amp;page=1\"> [1] </a>",
      '<a class="paged-nav-item" href="/game.php?screen=ally&amp;page=3"> [3] </a>',
      "<a class='paged-nav-item' rel=\"next\" href=\"/game.php?screen=ally&amp;page=4\"> [4] </a>",
      "<a class='paged-nav-item' href=\"/game.php?screen=ally&amp;page=3\"> [3] </a>",
      "<a class='paged-nav-item' href=\"/game.php?screen=ally&amp;page=-1\"> [todos] </a>",
    ].join('');
    expect(extractPagedNavPages(html)).toEqual([3, 4]);
  });
});

describe('visão de unidades da própria conta (fixture real do canário BR142)', () => {
  it('parseia a units_table real: 3 aldeias com próprias/na aldeia/em trânsito', () => {
    const result = parseOwnUnitsTable(fixture('own-units-paged-p1-rows.html'));
    expect(result.villages.length).toBe(3);
    for (const village of result.villages) {
      expect(village.villageId).toBeGreaterThan(0);
      expect(village.coord.x).toBeGreaterThanOrEqual(0);
      expect(village.coord.y).toBeGreaterThanOrEqual(0);
      // sub-linhas numéricas do HTML real: tropas próprias e na aldeia > 0,
      // trânsito presente como objeto (pode ser 0 em aldeia parada).
      expect(Object.values(village.own).some((count) => count > 0)).toBe(true);
      expect(Object.keys(village.inVillage).length).toBeGreaterThan(0);
      expect(village.inTransit).toBeDefined();
    }
  });
});
