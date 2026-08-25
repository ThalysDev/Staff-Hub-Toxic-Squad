import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isMemberSummaryPage, parseOwnUnitsTable } from './village-parsers';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/br142/${name}`, import.meta.url)), 'latin1');
}

describe('parseOwnUnitsTable (fixture real da conta do dono)', () => {
  it('reconhece a página de resumo (player_id ignorado pela própria conta)', () => {
    expect(isMemberSummaryPage(fixture('own-account-members-troops.html'))).toBe(true);
    expect(isMemberSummaryPage(fixture('ally-members-troops-player-spartacus.html'))).toBe(false);
  });

  it('extrai aldeias com próprias/na aldeia/em trânsito', () => {
    const { villages } = parseOwnUnitsTable(fixture('own-units.html'));
    expect(villages.length).toBe(15); // header "Aldeia (15)"
    const first = villages[0]!;
    expect(first.villageId).toBe(2196);
    expect(first.coord).toEqual({ x: 518, y: 523 });
    // "suas próprias" da 1ª aldeia: spear 2 (linha verificada no HTML)
    expect(first.own.spear).toBe(2);
    // toda aldeia precisa ter as três visões populadas
    for (const village of villages) {
      expect(Object.keys(village.own).length).toBeGreaterThanOrEqual(10);
      expect(Object.keys(village.inVillage).length).toBeGreaterThanOrEqual(10);
      expect(Object.keys(village.inTransit).length).toBeGreaterThanOrEqual(10);
    }
  });
});
