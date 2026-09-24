// Recrutamento em massa — fixture REAL do BR142.
import { describe, expect, it } from 'vitest';
import html from '../__fixtures__/br142-train-mass.html?raw';
import { massRecruitBody, parseMassRecruit, planVillageRecruit } from './recruitment-mass';

const page = parseMassRecruit(html)!;

describe('Recrutamento em massa — leitura', () => {
  it('custos, formulário e as duas aldeias', () => {
    expect(page).not.toBeNull();
    expect(page.costs.light).toEqual({ wood: 125, stone: 100, iron: 250, pop: 4 });
    expect(page.action).toBe('/game.php?village=35454&screen=train&mode=success&action=train_mass&page=1&h=f5506e54');
    expect(page.villages.map((v) => v.id)).toEqual(['173095', '135944']);
    expect(page.full).toBe(false);
  });
  it('recursos, fazenda, tem, fila e máximo do jogo por tropa', () => {
    const [a, b] = page.villages;
    expect(a).toMatchObject({ name: '759 - Nobre, Toxic Squad!', x: 571, y: 436, res: { wood: 107867, stone: 35500, iron: 273121 }, farm: { used: 23998, max: 24000 } });
    expect(a!.units.spear).toEqual({ existing: 0, running: 0, max: 2 });
    expect(a!.units.axe).toEqual({ existing: 6200, running: 0, max: 2 });
    expect(b!.units.archer).toEqual({ existing: 3452, running: 9, max: 0 });
    expect(b!.units.catapult).toEqual({ existing: 37, running: 13, max: 0 });
  });
  it('sem a tabela (sem Premium ou outra tela): null', () => {
    expect(parseMassRecruit('<html>nada</html>')).toBeNull();
  });
});

describe('Recrutamento em massa — plano', () => {
  const base = page.villages[0]!;
  it('respeita o máximo do jogo (fazenda cheia = 2)', () => {
    expect(planVillageRecruit(base, page.costs, { goals: { spear: 500 }, keepResources: 0, batchMax: 0 })).toEqual({ spear: 2 });
  });
  it('fila conta como "tem": meta já coberta não recruta', () => {
    const b = page.villages[1]!;
    const withMax = { ...b, units: { ...b.units, archer: { ...b.units.archer!, max: 500 } }, farm: { used: 0, max: 24000 } };
    expect(planVillageRecruit(withMax, page.costs, { goals: { archer: 3461 }, keepResources: 0, batchMax: 0 })).toEqual({});
    expect(planVillageRecruit(withMax, page.costs, { goals: { archer: 3500 }, keepResources: 0, batchMax: 0 })).toEqual({ archer: 39 });
  });
  it('recursos com reserva, fazenda e lote máximo; mais carente primeiro', () => {
    const v = { ...base, farm: { used: 0, max: 24000 }, units: { spear: { existing: 0, running: 0, max: 99999 }, light: { existing: 900, running: 0, max: 99999 } } };
    const plan = planVillageRecruit(v, page.costs, { goals: { spear: 1000, light: 1000 }, keepResources: 100_000, batchMax: 0 });
    // Sobram 7.867 de madeira, 0 de argila (35.500 − 100.000): nada cabe.
    expect(plan).toEqual({});
    const plan2 = planVillageRecruit(v, page.costs, { goals: { spear: 1000, light: 1000 }, keepResources: 0, batchMax: 300 });
    expect(plan2.spear).toBe(300);
    expect(plan2.light).toBe(100);
  });
  it('corpo do formulário só com o que sai', () => {
    const body = massRecruitBody(new Map([['173095', { spear: 2 }], ['135944', {}]]));
    expect(body.toString()).toBe('units%5B173095%5D%5Bspear%5D=2');
  });
});

import screenHtml from '../__fixtures__/br142-train-screen.html?raw';
import { parseTrainScreen } from './recruitment-mass';

describe('Tela de recrutamento (Só na tela)', () => {
  const s = parseTrainScreen(screenHtml)!;
  it('recursos, população, total, fila (34+50 bárbaros) e máximo do jogo', () => {
    expect(s.village).toMatchObject({ id: '35454', res: { wood: 139402, stone: 61170, iron: 285691 }, farm: { used: 15598, max: 24000 } });
    expect(s.village.units.axe).toEqual({ existing: 3180, running: 84, max: 2039 });
    expect(s.village.units.light).toEqual({ existing: 1418, running: 0, max: 611 });
    expect(s.costs.catapult).toEqual({ wood: 320, stone: 400, iron: 100, pop: 8 });
  });
  it('mesmo planejador: fila conta como "tem"', () => {
    expect(planVillageRecruit(s.village, s.costs, { goals: { axe: 3300 }, keepResources: 0, batchMax: 0 })).toEqual({ axe: 36 });
  });
  it('outra tela: null', () => {
    expect(parseTrainScreen('<p>x</p>')).toBeNull();
  });
});
