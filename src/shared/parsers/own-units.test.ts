import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isMemberSummaryPage, parseOwnUnitsTable } from './village-parsers';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/br142/${name}`, import.meta.url)), 'latin1');
}

// Esqueleto mínimo da units_table: cabeçalho com 13 ícones de unidade (o parser
// exige ≥ 10) + uma linha de aldeia. Trechos reais do own-units.html (nomes de
// classe/estrutura), conteúdo encurtado.
const UNITS_HEADER = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob', 'militia']
  .map((unit) => `<img src="unit_${unit}.webp">`)
  .join('');

function ownUnitsPage(villageCellHtml: string): string {
  return `<html><body><table id="units_table">
<tr><th>Aldeia</th><th></th>${UNITS_HEADER}</tr>
<tr><td>${villageCellHtml}</td><td>suas próprias</td>${UNITS_HEADER}</tr>
</table></body></html>`;
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

  it('fail-closed: nome de aldeia sem coordenada "(x|y)" lança ParseError citando o nome (nunca 0|0)', () => {
    const semCoord = ownUnitsPage('<span class="quickedit-vn" data-id="42"><span class="quickedit-label">Aldeia Sem Coordenada</span></span>');
    expect(() => parseOwnUnitsTable(semCoord)).toThrowError(/nome da aldeia sem coordenada "\(x\|y\)" \("Aldeia Sem Coordenada"\)/);
  });
});
