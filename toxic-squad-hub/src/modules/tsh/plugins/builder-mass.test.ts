// Construtor em 2º plano — fixtures REAIS do BR142.
import { describe, expect, it } from 'vitest';
import infoXml from '../__fixtures__/br142-building-info.xml?raw';
import bldHtml from '../__fixtures__/br142-overview-buildings.html?raw';
import prodHtml from '../__fixtures__/br142-overview-prod.html?raw';
import { costAt, effectiveLevel, parseBuildingInfo, parseBuildingsOverview, parseProdOverview, planVillageBuild } from './builder-mass';

const info = parseBuildingInfo(infoXml)!;
const bld = parseBuildingsOverview(bldHtml)!;
const prod = parseProdOverview(prodHtml)!;
const opts = { maxQueue: 2, keep: {}, farmFreePct: 0, storageGuard: true, strictOrder: true };

describe('leitura', () => {
  it('custos: base × fator^(nível−1) — Ed. principal 25 bate com o jogo (23.075/27.248/17.947)', () => {
    expect(info.main).toMatchObject({ maxLevel: 30, wood: 90, woodF: 1.26 });
    const c = costAt(info.main!, 25);
    expect(Math.abs(c.wood - 23075)).toBeLessThanOrEqual(2);
    expect(Math.abs(c.stone - 27248)).toBeLessThanOrEqual(2);
    expect(Math.abs(c.iron - 17947)).toBeLessThanOrEqual(2);
  });
  it('Visão de Edifícios: níveis e fila (5 itens)', () => {
    const [a, b] = bld.villages;
    expect(a).toMatchObject({ id: '23030', name: '1108 - Nobre, Toxic Squad!' });
    expect(a!.levels).toMatchObject({ main: 24, stable: 17, snob: 0, wall: 5 });
    expect(a!.queue).toEqual(['stable', 'stable', 'stable', 'smith', 'smith']);
    expect(effectiveLevel(a!, 'stable')).toBe(20);
    expect(b!.queue).toEqual([]);
  });
  it('Visão de Produção: recursos, armazém e fazenda', () => {
    expect(prod[0]).toMatchObject({ id: '238755', res: { wood: 143506, stone: 68906, iron: 357000 }, storage: 400000, farm: { used: 24000, max: 24000 } });
  });
  it('telas inesperadas: null', () => {
    expect(parseBuildingInfo('<x/>')).toBeNull();
    expect(parseBuildingsOverview('<p/>')).toBeNull();
    expect(parseProdOverview('<p/>')).toBeNull();
  });
});

describe('plano por aldeia', () => {
  const v = bld.villages[1]!; // 238755: sem fila
  // Fazenda real está cheia (24000/24000): para os testes de fila, 4.000 livres.
  const p = { ...prod.find((x) => x.id === '238755')!, farm: { used: 20_000, max: 24_000 } };
  it('fazenda cheia: o Ed. principal (pede população) não sai', () => {
    const cheia = prod.find((x) => x.id === '238755');
    expect(planVillageBuild(v, cheia, [{ building: 'main', level: 25 }], info, opts)).toEqual({ kind: 'esperar', reason: 'bloqueado' });
  });
  it('pré-requisito só na fila não vale (o jogo exige construído)', () => {
    const naFila = { ...v, levels: { ...v.levels, smith: 4, stable: 0 }, queue: ['smith' as const] };
    expect(planVillageBuild(naFila, p, [{ building: 'stable', level: 1 }], info, { ...opts, maxQueue: 5 })).toEqual({ kind: 'esperar', reason: 'bloqueado' });
  });
  it('coordenada: nome com "(x|y)" não engana — vale a antes do continente', () => {
    const html = bldHtml.replace('001 - Nobre, Toxic Squad! (534|551)', 'Alvo (500|500) - Nobre (534|551)');
    expect(parseBuildingsOverview(html, 0)?.villages.find((x) => x.id === '238755')).toMatchObject({ x: 534, y: 551 });
  });
  it('pré-requisito não cumprido: pula (Academia pede Mercado 10)', () => {
    const semMercado = { ...v, levels: { ...v.levels, market: 5, snob: 0 } };
    expect(planVillageBuild(semMercado, p, [{ building: 'snob', level: 1 }, { building: 'hide', level: 6 }], info, { ...opts, strictOrder: false })).toMatchObject({ kind: 'construir', building: 'hide' });
  });
  it('fila cheia: espera', () => {
    expect(planVillageBuild(bld.villages[0]!, undefined, [{ building: 'main', level: 30 }], info, opts)).toEqual({ kind: 'esperar', reason: 'fila-cheia' });
  });
  it('primeiro pendente que cabe nos recursos', () => {
    expect(planVillageBuild(v, p, [{ building: 'main', level: 25 }], info, opts)).toEqual({ kind: 'construir', building: 'main', level: 25, reason: 'fila' });
  });
  it('meta atendida: concluído; nível máximo do jogo: pula', () => {
    expect(planVillageBuild(v, p, [{ building: 'main', level: 24 }], info, opts)).toEqual({ kind: 'esperar', reason: 'concluido' });
    expect(planVillageBuild(v, p, [{ building: 'farm', level: 31 }], info, opts)).toEqual({ kind: 'esperar', reason: 'maximo' });
  });
  it('recursos que ficam em casa bloqueiam; ordem à risca espera, senão pula', () => {
    const keep = { ...opts, keep: { wood: 60_000, stone: 60_000, iron: 60_000 } };
    // Ed. principal 25 pede 27.248 de argila; sobram 8.906.
    expect(planVillageBuild(v, p, [{ building: 'main', level: 25 }, { building: 'hide', level: 6 }], info, keep)).toEqual({ kind: 'esperar', reason: 'recursos' });
    expect(planVillageBuild(v, p, [{ building: 'main', level: 25 }, { building: 'hide', level: 6 }], info, { ...keep, strictOrder: false })).toMatchObject({ kind: 'construir', building: 'hide', level: 6 });
  });
  it('fazenda primeiro quando a população livre fica abaixo do limite (TIKA)', () => {
    const q = { ...p!, farm: { used: 23_000, max: 24_000 } };
    const fazendaNoMax = planVillageBuild(v, q, [{ building: 'main', level: 25 }], info, { ...opts, farmFreePct: 10 });
    // Fazenda já no nível 30 (máximo): não há o que ampliar, segue a fila.
    expect(fazendaNoMax).toMatchObject({ kind: 'construir', building: 'main' });
    const baixa = { ...v, levels: { ...v.levels, farm: 20 } };
    expect(planVillageBuild(baixa, q, [{ building: 'main', level: 25 }], info, { ...opts, farmFreePct: 10 })).toEqual({ kind: 'construir', building: 'farm', level: 21, reason: 'fazenda' });
  });
  it('armazém pequeno demais para o próximo custo: amplia o armazém antes', () => {
    const pouco = { ...p!, storage: 20_000 };
    const baixo = { ...v, levels: { ...v.levels, storage: 20 } };
    expect(planVillageBuild(baixo, pouco, [{ building: 'main', level: 25 }], info, opts)).toEqual({ kind: 'construir', building: 'storage', level: 21, reason: 'armazem' });
  });
});

import mainHtml from '../__fixtures__/br142-main-screen.html?raw';
import { parseMainScreen } from './builder-mass';

describe('Só na tela (Edifício principal)', () => {
  const s = parseMainScreen(mainHtml, '23030')!;
  it('níveis do JSON do jogo, fila pelas classes e a barra de recursos', () => {
    expect(s.village.levels).toMatchObject({ main: 24, stable: 17, smith: 17, farm: 30 });
    expect(s.village.queue).toEqual(['stable', 'stable', 'stable', 'smith', 'smith']);
    expect(s.prod).toEqual({ id: '23030', res: { wood: 151635, stone: 80708, iron: 309686 }, storage: 400000, farm: { used: 22870, max: 24000 } });
  });
  it('mesmo planejador: fila de 5 cheia espera', () => {
    expect(planVillageBuild(s.village, s.prod, [{ building: 'main', level: 25 }], info, { ...opts, maxQueue: 5 })).toEqual({ kind: 'esperar', reason: 'fila-cheia' });
  });
  it('outra tela: null', () => {
    expect(parseMainScreen('<p/>', '1')).toBeNull();
  });
});

describe('ideias do "Construtor & Redutor"', () => {
  const v = bld.villages[1]!;
  const p = { ...prod.find((x) => x.id === '238755')!, farm: { used: 20_000, max: 24_000 } };
  it('armazém quase cheio sobe antes da fila', () => {
    const baixo = { ...v, levels: { ...v.levels, storage: 20 } };
    expect(planVillageBuild(baixo, p, [{ building: 'main', level: 25 }], info, { ...opts, storageFullPct: 85 })).toEqual({ kind: 'construir', building: 'storage', level: 21, reason: 'armazem' });
  });
  it('−20%: cabe com 80% do custo', () => {
    // Ed. principal 25: 27.248 de argila; com −20% ≈ 21.799. Sobram 25.000 → só cabe com −20%.
    const q = { ...p, res: { ...p.res, stone: 25_000 } };
    expect(planVillageBuild(v, q, [{ building: 'main', level: 25 }], info, opts)).toEqual({ kind: 'esperar', reason: 'recursos' });
    expect(planVillageBuild(v, q, [{ building: 'main', level: 25 }], info, { ...opts, cheap: true })).toMatchObject({ kind: 'construir', building: 'main' });
  });
});

import { parseQueueTime } from './builder-mass';

describe('fila por horas', () => {
  const now = new Date(2026, 8, 24, 14, 0, 0).getTime();
  it('lê hoje/amanhã/data da fila do jogo', () => {
    expect(parseQueueTime('Estábulo - hoje às 15:56', now)).toBe(new Date(2026, 8, 24, 15, 56).getTime());
    expect(parseQueueTime('Estábulo - amanhã às 02:15', now)).toBe(new Date(2026, 8, 25, 2, 15).getTime());
    expect(parseQueueTime('Ferreiro - em 26.09. às 09:32', now)).toBe(new Date(2026, 8, 26, 9, 32).getTime());
  });
  it('fila que já cobre as horas pedidas espera; se cobre menos, completa (até o teto de itens)', () => {
    const v = { ...bld.villages[1]!, queue: ['wall' as const], queueEndsAt: now + 2 * 3_600_000 };
    const p = { ...prod.find((x) => x.id === '238755')!, farm: { used: 20_000, max: 24_000 } };
    const o = { ...opts, maxQueue: 5, nowMs: now };
    expect(planVillageBuild(v, p, [{ building: 'main', level: 25 }], info, { ...o, queueHours: 1 })).toEqual({ kind: 'esperar', reason: 'fila-cheia' });
    expect(planVillageBuild(v, p, [{ building: 'main', level: 25 }], info, { ...o, queueHours: 5 })).toMatchObject({ kind: 'construir', building: 'main' });
  });
  it('lê o fim da fila e as coordenadas na Visão de Edifícios', () => {
    const r = parseBuildingsOverview(bldHtml, new Date(2026, 8, 24, 14, 0).getTime())!;
    expect(r.villages[0]).toMatchObject({ x: 659, y: 469, queueEndsAt: new Date(2026, 8, 26, 9, 32).getTime() });
    expect(r.villages[1]).toMatchObject({ queueEndsAt: null });
  });
});
