// Plano global da Central de Farm — Visão de Tropas e linhas REAIS do BR142.
import { describe, expect, it } from 'vitest';
import farmHtml from '../__fixtures__/br142-am-farm.html?raw';
import unitsHtml from '../__fixtures__/br142-units-home.html?raw';
import { parseFarmPage } from './farm-page';
import { DEFAULT_FARM_CONFIG } from './farm-plan';
import { parseUnitsHome, planFarmRound, travelMinutes, type OwnFarmVillage } from './farm-global';

const page = parseFarmPage(farmHtml)!;
const speeds = { spy: 9, light: 10, axe: 18 };

describe('Visão de Tropas (em casa)', () => {
  it('lê aldeia, coordenadas e tropas na ordem do cabeçalho', () => {
    const r = parseUnitsHome(unitsHtml)!;
    expect(r.rows).toHaveLength(3);
    expect(r.rows[1]).toEqual({ id: '171940', name: '763 - Nobre, Toxic Squad!', x: 552, y: 431, units: { axe: 6200, spy: 100, light: 3200, ram: 178, catapult: 30 } });
    expect(r.full).toBe(false);
    expect(parseUnitsHome('<p>nada</p>')).toBeNull();
  });
});

describe('rodada global', () => {
  const perto: OwnFarmVillage = { id: '1', name: 'Perto', x: 716, y: 504, free: { spy: 5, light: 200 } };
  const longe: OwnFarmVillage = { id: '2', name: 'Longe', x: 719, y: 502, free: { spy: 5, light: 200 } };
  const cfg = { ...DEFAULT_FARM_CONFIG, maxDistance: 10, maxWall: 2 };

  it('cada alvo vai para a aldeia MAIS PRÓXIMA com tropa; tropa não é prometida duas vezes', () => {
    const rows = page.rows.filter((r) => r.targetId === '212202');
    const r = planFarmRound({ rows, villages: [longe, perto], templates: page.templates, cfg, speeds, arrivals: new Map(), nowMs: 0 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ sourceId: '1', kind: 'A', templateId: '23', targetId: '212202' });
  });

  it('muralha alta vai para a lista de muralhas; vermelho é ignorado; C grande demais para a aldeia é pulado', () => {
    const r = planFarmRound({ rows: page.rows, villages: [perto], templates: page.templates, cfg, speeds, arrivals: new Map(), nowMs: 0 });
    expect(r.walls.map((w) => w.targetId).sort()).toEqual(['296329', '304447', '304530', '48890']);
    expect(r.skipped.ignorar).toBe(1); // vermelho = ignorar
    expect(r.items.map((i) => i.kind)).toEqual(['A']);
    expect(r.skipped['sem-tropa']).toBe(1); // o C do 212178 pede 3164 bárbaros + 1075 leves
  });

  it('não repete chegada no mesmo alvo dentro do intervalo (inclui ataques a caminho)', () => {
    const rows = page.rows.filter((r) => r.targetId === '212202');
    const min = travelMinutes({ spy: 1, light: 60 }, Math.hypot(1, 0), speeds);
    const arrivals = new Map([['717|504', [min * 60_000 + 60_000]]]);
    const r = planFarmRound({ rows, villages: [perto], templates: page.templates, cfg, speeds, arrivals, nowMs: 0 });
    expect(r.items).toHaveLength(0);
    expect(r.skipped.intervalo).toBe(1);
  });

  it('sem tropa suficiente em nenhuma aldeia do alcance: pula', () => {
    const pobre = { ...perto, free: { light: 10 } };
    const rows = page.rows.filter((r) => r.targetId === '212202');
    const r = planFarmRound({ rows, villages: [pobre], templates: page.templates, cfg, speeds, arrivals: new Map(), nowMs: 0 });
    expect(r.skipped['sem-tropa']).toBe(1);
  });
});
