// Super Balanceador — leitura REAL (BR142) e o plano.
import { describe, expect, it } from 'vitest';
import incHtml from '../__fixtures__/br142-trader-inc.html?raw';
import prodHtml from '../__fixtures__/br142-overview-prod.html?raw';
import { parseProdOverview } from './builder-mass';
import { groupByReceiver, parseTraderIncoming, planBalance, readCallResponse, type BalanceOptions, type BalVillage } from './balance-mass';

const base: BalanceOptions = { mode: 'equilibrar', fillPct: 90, focus: 0, smallPoints: 0, smallFillPct: 85, keepPct: 20, reserveMerchants: 0, merchantCap: 1000, maxDistance: 999, radius: 15, capPct: 95 };
const V = (id: string, x: number, wood: number, extra: Partial<BalVillage> = {}): BalVillage => ({
  id, name: id, x, y: 500, res: { wood, stone: wood, iron: wood }, storage: 100_000, merchants: 50, points: 10_000, farm: { used: 100, max: 200 }, ...extra,
});

describe('leitura real', () => {
  it('Visão de Produção traz nome, coordenada, pontos e mercadores', () => {
    const p = parseProdOverview(prodHtml)!;
    expect(p.find((v) => v.id === '238755')).toMatchObject({ name: '001 - Nobre, Toxic Squad!', x: 534, y: 551, points: 10532, merchants: { free: 13, total: 235 } });
  });
  it('transportes a caminho somados por aldeia-destino', () => {
    const r = parseTraderIncoming(incHtml)!;
    expect(r.rows).toBe(6);
    expect(r.byTarget.get('172617')).toEqual({ wood: 1964, stone: 2000, iron: 1673 });
    expect(r.byTarget.get('177304')).toEqual({ wood: 2000, stone: 2646, iron: 0 });
    expect(parseTraderIncoming('<html></html>')).toBeNull();
  });
  it('resposta REAL do Pedido', () => {
    const real = { response: { success: 'Os recursos foram enviados', transport_info: [{ village_id: 35755, needed_trader_capacity: 1000, traders_free: 100 }] } };
    expect(readCallResponse(real)).toEqual({ success: 'Os recursos foram enviados', confirmed: new Map([['35755', 1000]]) });
    expect(readCallResponse({ error: 'x' })).toBeNull();
  });
});

describe('plano', () => {
  it('equilibra pela média, em cargas de 1000, da doadora mais perto', () => {
    const p = planBalance([V('rica', 0, 90_000), V('perto', 5, 10_000), V('longe', 40, 10_000)], new Map(), base);
    // média 36.666: cada pobre precisa ~26.666 de cada → total 80.000 → cabe em 50 mercadores (50.000)
    expect(p.launches[0]?.from).toBe('rica');
    for (const l of p.launches) expect((l.res.wood + l.res.stone + l.res.iron) % 1000).toBe(0);
    expect(p.launches.reduce((s, l) => s + l.res.wood + l.res.stone + l.res.iron, 0)).toBeLessThanOrEqual(50_000);
  });
  it('recursos a caminho contam (quem já vai receber não pede de novo)', () => {
    const inc = new Map([['pobre', { wood: 80_000, stone: 80_000, iron: 80_000 }]]);
    const p = planBalance([V('rica', 0, 90_000), V('pobre', 5, 10_000)], inc, base);
    expect(p.launches).toHaveLength(0);
  });
  it('pequena tem prioridade; pronta (fazenda cheia) doa e guarda só a fatia', () => {
    const vs = [V('pronta', 0, 80_000, { farm: { used: 200, max: 200 } }), V('media', 3, 30_000), V('peq', 6, 5_000, { points: 800 })];
    const p = planBalance(vs, new Map(), { ...base, smallPoints: 3000 });
    expect(p.roles.get('pronta')).toBe('pronta');
    expect(p.roles.get('peq')).toBe('pequena');
    expect(p.launches[0]?.to).toBe('peq');
  });
  it('abastecer: enche a escolhida a partir das vizinhas, que guardam a fatia', () => {
    const vs = [V('a', 0, 60_000), V('b', 2, 60_000), V('alvo', 1, 0)];
    const p = planBalance(vs, new Map(), { ...base, mode: 'abastecer', targets: new Set(['alvo']), fillPct: 90 });
    expect(groupByReceiver(p.launches).get('alvo')?.length).toBeGreaterThan(0);
    for (const l of p.launches) expect(l.to).toBe('alvo');
    expect(p.moved.wood).toBeLessThanOrEqual(2 * (60_000 - 20_000));
  });
  it('respeita reserva de mercadores e distância máxima', () => {
    const p1 = planBalance([V('rica', 0, 90_000, { merchants: 5 }), V('pobre', 5, 0)], new Map(), { ...base, reserveMerchants: 5 });
    expect(p1.launches).toHaveLength(0);
    const p2 = planBalance([V('rica', 0, 90_000), V('pobre', 50, 0)], new Map(), { ...base, maxDistance: 30 });
    expect(p2.launches).toHaveLength(0);
  });
  it('motor antigo: fila parada primeiro, grupo de fora não mexe, proporção da moeda', () => {
    const vs = [V('rica', 0, 90_000), V('peq', 3, 5_000, { points: 800 }), V('parada', 6, 20_000), V('fora', 1, 0)];
    const p = planBalance(vs, new Map(), { ...base, smallPoints: 3000, stalled: new Set(['parada']), needs: new Map([['parada', { wood: 30_000, stone: 30_000, iron: 30_000 }]]), exclude: new Set(['fora']) });
    expect(p.launches[0]?.to).toBe('parada');
    expect(p.launches.some((l) => l.to === 'fora' || l.from === 'fora')).toBe(false);
    const c = planBalance([V('a', 0, 90_000), V('alvo', 1, 0)], new Map(), { ...base, mode: 'abastecer', targets: new Set(['alvo']), fillPct: 30, coinRatio: true, keepPct: 0 });
    const got = c.launches.reduce((t, l) => ({ wood: t.wood + l.res.wood, stone: t.stone + l.res.stone, iron: t.iron + l.res.iron }), { wood: 0, stone: 0, iron: 0 });
    expect(got.stone).toBeGreaterThan(got.wood);
    expect(got.wood).toBeGreaterThan(got.iron);
  });
  it('escassez: não rateia em migalhas — quem tem prioridade recebe cargas cheias', () => {
    // média alta, duas pobres; a sobra só cobre uma parte.
    const vs = [V('rica', 0, 3_000, { res: { wood: 3_000, stone: 0, iron: 0 } }), V('a', 1, 0, { points: 800 }), V('b', 2, 0)];
    const p = planBalance(vs, new Map(), { ...base, smallPoints: 3000 });
    expect(p.launches.length).toBeGreaterThan(0);
    expect(p.launches[0]?.to).toBe('a');
    expect(p.unmet.wood + p.unmet.stone + p.unmet.iron).toBeGreaterThan(0);
  });
  it('envio mínimo vale dentro do plano (não gasta mercador à toa)', () => {
    const p = planBalance([V('rica', 0, 90_000), V('pobre', 5, 80_000)], new Map(), { ...base, minLoad: 20_000 });
    expect(p.launches).toHaveLength(0);
  });
});

describe('paginação', () => {
  it('transportes: "tem mais" pela navegação da página seguinte', () => {
    expect(parseTraderIncoming(incHtml, 0)?.more).toBe(true);
    expect(parseTraderIncoming(incHtml, 3)?.more).toBe(false);
  });
});
