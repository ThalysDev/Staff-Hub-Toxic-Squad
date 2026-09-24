// Construtor em SEGUNDO PLANO (v3.9.0) — rede e pedido do jogo simulados,
// Visões de Edifícios/Produção e custos REAIS do BR142.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import infoXml from '../__fixtures__/br142-building-info.xml?raw';
import bldHtml from '../__fixtures__/br142-overview-buildings.html?raw';
import prodHtml from '../__fixtures__/br142-overview-prod.html?raw';

const store = new Map<string, unknown>();
vi.stubGlobal('GM_getValue', (k: string, d: unknown) => (store.has(k) ? store.get(k) : d));
vi.stubGlobal('GM_setValue', (k: string, v: unknown) => store.set(k, v));
vi.stubGlobal('GM_deleteValue', (k: string) => store.delete(k));
vi.stubGlobal('window', { location: { search: '?screen=overview', hostname: 'br142.tribalwars.com.br' } });

vi.mock('../../../core/net', async (orig) => ({
  ...(await orig<typeof import('../../../core/net')>()),
  // Fazenda de 238755 com 4.000 livres (a real está cheia) para o Ed. principal caber.
  pacedGet: vi.fn(async (path: string) =>
    path.includes('get_building_info') ? infoXml : path.includes('mode=buildings') ? bldHtml : prodHtml.replace('24000/24000', '20000/24000'),
  ),
}));
const ups: string[][] = [];
let refuse = false;
vi.mock('../tsh-transport', async (orig) => ({
  ...(await orig<typeof import('../tsh-transport')>()),
  upgradeBuildingApi: vi.fn(async (vid: string, b: string) => {
    ups.push([vid, b]);
    if (refuse) throw Object.assign(new Error('Não há recursos suficientes.'), { code: 'GAME_REFUSED' });
  }),
}));
vi.mock('../tsh-humanize', () => ({ awaitRoutineMutation: async () => true }));
vi.mock('../../../core/game-clock', () => ({ backgroundSleep: async () => undefined, serverNowMs: () => 0 }));

const { megaBuilderAutomation } = await import('./mega-builder');

function ctx(settings: Record<string, unknown>) {
  store.set('tsh-auto:br142:mega-builder:settings', JSON.stringify(settings));
  const kv = new Map<string, unknown>([['settings', { execMode: 'fundo', ...settings }]]);
  const out = { status: [] as [string, string][] };
  return {
    out,
    c: {
      world: 'br142',
      villageId: '35454',
      storage: { get: <T,>(k: string, d: T): T => (kv.has(k) ? (kv.get(k) as T) : d), set: <T,>(k: string, v: T): void => void kv.set(k, v) },
      status: (m: string, k = 'info') => out.status.push([m, k]),
      again: () => undefined,
    },
  };
}

beforeEach(() => {
  store.clear();
  ups.length = 0;
  refuse = false;
});

describe('Construtor em 2º plano', () => {
  it('amplia só a aldeia com fila livre (a outra está com 5 na fila)', async () => {
    const { c, out } = ctx({ execMode: 'fundo', prioritiesText: 'main:25\nhide:10', maxQueue: 2 });
    await megaBuilderAutomation.runCycle(c as never);
    expect(ups).toEqual([['238755', 'main']]);
    expect(out.status.at(-1)?.[0]).toContain('Construção enviada em 1 aldeia');
  });

  it('recusa do jogo: conta e avisa, sem repetir', async () => {
    refuse = true;
    const { c, out } = ctx({ execMode: 'fundo', prioritiesText: 'main:25', maxQueue: 2 });
    await megaBuilderAutomation.runCycle(c as never);
    expect(ups).toHaveLength(1);
    expect(out.status.at(-1)).toEqual([expect.stringContaining('O jogo recusou 1'), 'warn']);
  });

  it('sem fila configurada: pede para configurar e não chama o jogo', async () => {
    const { c, out } = ctx({ execMode: 'fundo' });
    await megaBuilderAutomation.runCycle(c as never);
    expect(ups).toHaveLength(0);
    expect(out.status.at(-1)?.[0]).toContain('Nenhuma fila de construção');
  });

  it('modelos: regra por coordenada vale só para aquela aldeia; sem padrão, o resto não constrói', async () => {
    const models = [
      { id: 'a', name: 'Principal', steps: [{ building: 'main', level: 25 }] },
      { id: 'b', name: 'Esconder', steps: [{ building: 'hide', level: 10 }] },
    ];
    const { c, out } = ctx({ execMode: 'fundo', maxQueue: 2, models, rules: [{ kind: 'coord', coords: ['534|551'], modelId: 'a' }], defaultModel: '' });
    await megaBuilderAutomation.runCycle(c as never);
    expect(ups).toEqual([['238755', 'main']]);
    expect(out.status.at(-1)?.[0]).toContain('Construção enviada em 1 aldeia');
  });

  it('modelos sem padrão e sem regra: avisa e não chama o jogo', async () => {
    const { c, out } = ctx({ execMode: 'fundo', models: [{ id: 'a', name: 'A', steps: [{ building: 'main', level: 25 }] }], defaultModel: '' });
    await megaBuilderAutomation.runCycle(c as never);
    expect(ups).toHaveLength(0);
    expect(out.status.at(-1)?.[0]).toContain('Nenhuma aldeia tem modelo');
  });

  it('quem já usava (settings sem execMode) fica em "Só na tela" com aviso', async () => {
    store.set('tsh-auto:br142:mega-builder:settings', JSON.stringify({ prioritiesText: 'main' }));
    const kv = new Map<string, unknown>([['settings', { prioritiesText: 'main' }]]);
    const out: [string, string][] = [];
    await megaBuilderAutomation.runCycle({
      world: 'br142',
      villageId: '35454',
      storage: { get: <T,>(k: string, d: T): T => (kv.has(k) ? (kv.get(k) as T) : d), set: () => undefined },
      status: (m: string, k = 'info') => out.push([m, k]),
    } as never);
    expect(ups).toHaveLength(0);
    expect(out.at(-1)?.[0]).toContain('Novo na 3.9');
  });
});
