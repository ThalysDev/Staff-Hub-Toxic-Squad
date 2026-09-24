// Leitor da página do Assistente de Saque — fixture REAL do BR142.
import { describe, expect, it } from 'vitest';
import html from '../__fixtures__/br142-am-farm.html?raw';
import { parseFarmPage } from './farm-page';

describe('Assistente de Saque — leitura', () => {
  const page = parseFarmPage(html);
  it('aldeia, modelos A/B com id do jogo, tropas em casa e caixas do C', () => {
    expect(page).not.toBeNull();
    expect(page!.sourceId).toBe('35454');
    expect(page!.source).toEqual({ x: 719, y: 502 });
    expect(page!.templates.A).toEqual({ id: '23', units: { spy: 1, light: 60 } });
    expect(page!.templates.B).toEqual({ id: '101', units: { spy: 1, light: 80 } });
    expect(page!.home).toMatchObject({ axe: 3164, spy: 59, light: 1075 });
    expect(page!.cUnits).toContain('light');
    expect(page!.lastPage).toBe(36);
  });

  it('cada tipo de relatório, muralha, distância e o botão C', () => {
    const byId = Object.fromEntries(page!.rows.map((r) => [r.targetId, r]));
    expect(byId['212202']).toMatchObject({ x: 717, y: 504, color: 'green', fullHaul: false, wall: 0, distance: 2.8, cReportId: '556917810', attacked: false });
    expect(byId['212178']).toMatchObject({ color: 'green', fullHaul: true, distance: 7.2 });
    expect(byId['304530']).toMatchObject({ color: 'blue', fullHaul: null, wall: 6 });
    expect(byId['48890']).toMatchObject({ color: 'red_blue', wall: 3 });
    expect(byId['296329']).toMatchObject({ color: 'yellow', fullHaul: false, wall: 7 });
    expect(byId['296329']?.cForecast).toEqual({ spy: 1, light: 146 });
    expect(byId['304447']).toMatchObject({ color: 'yellow', fullHaul: true, wall: 14 });
    expect(byId['17138']).toMatchObject({ color: 'red', wall: null, cReportId: null, distance: 78.7 });
  });

  it('página sem o Assistente: null (não adivinha)', () => {
    expect(parseFarmPage('<html>outra tela</html>')).toBeNull();
  });
});
