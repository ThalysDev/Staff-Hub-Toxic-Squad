// Super Balanceador em SEGUNDO PLANO (v3.11.0) — rede e jogo simulados,
// Visão de Produção e transportes a caminho REAIS do BR142.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import incHtml from '../__fixtures__/br142-trader-inc.html?raw';
import prodHtml from '../__fixtures__/br142-overview-prod.html?raw';

const store = new Map<string, unknown>();
vi.stubGlobal('GM_getValue', (k: string, d: unknown) => (store.has(k) ? store.get(k) : d));
vi.stubGlobal('GM_setValue', (k: string, v: unknown) => store.set(k, v));
vi.stubGlobal('GM_deleteValue', (k: string) => store.delete(k));
vi.stubGlobal('window', { location: { search: '?screen=overview', hostname: 'br142.tribalwars.com.br' } });

vi.mock('../../../core/net', async (orig) => ({
  ...(await orig<typeof import('../../../core/net')>()),
  pacedGet: vi.fn(async (path: string) => (path.includes('mode=trader') ? incHtml : prodHtml)),
}));
const calls: { to: string; n: number }[] = [];
vi.mock('../tsh-transport', async (orig) => ({
  ...(await orig<typeof import('../tsh-transport')>()),
  requestResourcesApi: vi.fn(async (to: string, origins: { from: string; res: { wood: number; stone: number; iron: number } }[]) => {
    calls.push({ to, n: origins.length });
    return { response: { success: 'Os recursos foram enviados', transport_info: origins.map((o) => ({ village_id: Number(o.from), needed_trader_capacity: o.res.wood + o.res.stone + o.res.iron })) } };
  }),
}));
vi.mock('../tsh-humanize', () => ({ awaitRoutineMutation: async () => true }));

const { tshAutomations } = await import('../tsh-runtime');
await import('./resource-balancer');
const bal = tshAutomations().find((a) => a.id === 'resource-balancer')!;

function ctx(settings: Record<string, unknown> | null) {
  if (settings !== null) store.set('tsh-auto:br142:resource-balancer:settings', JSON.stringify(settings));
  const out: [string, string][] = [];
  return {
    out,
    c: {
      world: 'br142',
      villageId: '35454',
      storage: {
        get: <T,>(k: string, d: T): T => (store.has(`tsh-auto:br142:resource-balancer:${k}`) ? (JSON.parse(store.get(`tsh-auto:br142:resource-balancer:${k}`) as string) as T) : d),
        set: () => undefined,
      },
      status: (m: string, k = 'info') => out.push([m, k]),
      again: () => undefined,
    },
  };
}

beforeEach(() => {
  store.clear();
  calls.length = 0;
});

describe('Super Balanceador', () => {
  it('sem salvar a tela nova, não envia nada (opt-in explícito)', async () => {
    const { c, out } = ctx({ mode: 'media', targetCoordsText: '' });
    await bal.runCycle(c as never);
    expect(calls).toHaveLength(0);
    expect(out.at(-1)?.[0]).toContain('ainda não está ativo');
  });

  it('equilibrar: um Pedido por aldeia que recebe, confirmado pelo jogo', async () => {
    const { c, out } = ctx({ v311: true, mode: 'equilibrar', focus: 0, maxDistance: 999, radius: 15, perCycle: 50 });
    await bal.runCycle(c as never);
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map((x) => x.to)).size).toBe(calls.length);
    expect(out.at(-1)).toEqual([expect.stringContaining('receberam pedidos — o jogo confirmou'), 'ok']);
  });

  it('abastecer por coordenada: só a escolhida recebe', async () => {
    const { c } = ctx({ v311: true, mode: 'abastecer', alvo: 'coords', targetCoords: '534|551', fillPct: 95, keepPct: 0, maxDistance: 999, perCycle: 50 });
    await bal.runCycle(c as never);
    expect(calls.map((x) => x.to)).toEqual(['238755']);
  });
});
