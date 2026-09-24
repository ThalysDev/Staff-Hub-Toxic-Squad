// Decisão da Central de Farm contra as linhas REAIS do BR142.
import { describe, expect, it } from 'vitest';
import html from '../__fixtures__/br142-am-farm.html?raw';
import { parseFarmPage } from './farm-page';
import { DEFAULT_FARM_CONFIG, decideRow, freeUnits, jittered, outOfTroops, readFarmConfig, reportKind, spend } from './farm-plan';

const page = parseFarmPage(html)!;
const row = (id: string) => page.rows.find((r) => r.targetId === id)!;
const never = (): null => null;
const cfg = { ...DEFAULT_FARM_CONFIG, maxDistance: 100, maxWall: -1 };

describe('Central de Farm — ações por relatório', () => {
  it('tipos de relatório pelo jeito que o jogador vê', () => {
    expect(reportKind(row('212202'))).toBe('verde-parcial');
    expect(reportKind(row('212178'))).toBe('verde-cheio');
    expect(reportKind(row('304447'))).toBe('amarelo-cheio');
    expect(reportKind(row('304530'))).toBe('azul');
    expect(reportKind(row('48890'))).toBe('vermelho-azul');
    expect(reportKind(row('17138'))).toBe('vermelho');
  });

  it('padrão: verde parcial = A, verde cheio = C do jogo, vermelho = ignorar', () => {
    const free = freeUnits(page.home, {});
    expect(decideRow(row('212202'), cfg, page.templates, free, never, 0)).toEqual({ kind: 'A', templateId: '23', units: { spy: 1, light: 60 } });
    expect(decideRow(row('212178'), cfg, page.templates, free, never, 0)).toMatchObject({ kind: 'C', reportId: '556897016' });
    expect(decideRow(row('17138'), cfg, page.templates, free, never, 0)).toEqual({ kind: 'pular', reason: 'ignorar' });
  });

  it('distância, muralha, intervalo do mesmo alvo e tropa que não cabe', () => {
    const free = freeUnits(page.home, {});
    expect(decideRow(row('17138'), { ...cfg, maxDistance: 20 }, page.templates, free, never, 0)).toEqual({ kind: 'pular', reason: 'longe' });
    expect(decideRow(row('304447'), { ...cfg, maxWall: 2 }, page.templates, free, never, 0)).toEqual({ kind: 'pular', reason: 'muralha' });
    expect(decideRow(row('212202'), cfg, page.templates, free, () => 0, 5 * 60_000)).toEqual({ kind: 'pular', reason: 'intervalo' });
    const pouco = freeUnits(page.home, { light: 1030 }); // sobram 45 leves
    expect(decideRow(row('212202'), cfg, page.templates, pouco, never, 0)).toEqual({ kind: 'pular', reason: 'sem-tropa' });
    expect(outOfTroops(page.templates, pouco)).toBe(true);
  });

  it('C sem previsão cai no modelo reserva', () => {
    const semC = { ...row('212178'), cReportId: null, cForecast: null };
    expect(decideRow(semC, cfg, page.templates, freeUnits(page.home, {}), never, 0)).toMatchObject({ kind: 'A' });
    expect(decideRow(semC, { ...cfg, cFallback: 'ignorar' }, page.templates, freeUnits(page.home, {}), never, 0)).toEqual({ kind: 'pular', reason: 'ignorar' });
  });

  it('gasto, variação das pausas e configuração inválida = padrão', () => {
    expect(spend({ light: 100, spy: 2 }, { light: 60, spy: 1 })).toEqual({ light: 40, spy: 1 });
    expect(jittered(400, 25, () => 0)).toBe(300);
    expect(jittered(400, 25, () => 1)).toBe(500);
    expect(readFarmConfig({ pauseMs: 10 })).toEqual(DEFAULT_FARM_CONFIG);
  });
});
