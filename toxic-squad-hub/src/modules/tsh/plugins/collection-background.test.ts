// Ciclo da Coleta em SEGUNDO PLANO (v3.6.0) — rede e transporte simulados,
// página real da Coleta em massa do BR142 como entrada.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import massHtml from '../__fixtures__/br142-scavenge-mass.html?raw';

const gmStore = new Map<string, unknown>();
vi.stubGlobal('GM_getValue', (k: string, d: unknown) => (gmStore.has(k) ? gmStore.get(k) : d));
vi.stubGlobal('GM_setValue', (k: string, v: unknown) => gmStore.set(k, v));
vi.stubGlobal('GM_deleteValue', (k: string) => gmStore.delete(k));

const pages: string[] = [];
const gets: string[] = [];
vi.mock('../../../core/net', async (orig) => ({
  ...(await orig<typeof import('../../../core/net')>()),
  pacedGet: vi.fn(async (path: string) => {
    gets.push(path);
    const n = Number(/page=(\d+)/.exec(path)?.[1] ?? 0);
    return pages[n] ?? pages[0] ?? '';
  }),
}));
const sent: unknown[][] = [];
const unlocked: unknown[][] = [];
vi.mock('../tsh-transport', async (orig) => ({
  ...(await orig<typeof import('../tsh-transport')>()),
  sendScavengeBatch: vi.fn(async (reqs: unknown[]) => {
    sent.push(reqs);
    return { accepted: reqs.length, refused: [] };
  }),
  unlockScavengeLevel: vi.fn(async (...args: unknown[]) => {
    unlocked.push(args);
  }),
}));
vi.mock('../../../core/game-clock', () => ({ serverNowMs: () => Date.UTC(2026, 8, 24, 12) }));

const { collectionAutomation } = await import('./collection');

/** Página com `n` cópias da aldeia 055 (ids distintos) e paginação até `last`. */
function pageWith(n: number, last: number, patch?: (v: Record<string, unknown>) => void): string {
  const m = /new ScavengeMassScreen\(\s*([\s\S]*?)\n\s*\);/.exec(massHtml);
  const args = m?.[1] ?? '';
  const start = args.indexOf('[{"village_id"');
  const end = args.lastIndexOf('}]') + 2;
  const villages = JSON.parse(args.slice(start, end)) as Record<string, unknown>[];
  const base = villages[1]!;
  const list = Array.from({ length: n }, (_, k) => {
    const v = structuredClone(base);
    v.village_id = 300000 + k;
    patch?.(v);
    return v;
  });
  const nav = `<a href="/game.php?screen=place&amp;mode=scavenge_mass&amp;page=${last}">x</a>`;
  return nav + massHtml.replace(args.slice(start, end), JSON.stringify(list));
}

function ctx(settings: Record<string, unknown>) {
  const store = new Map<string, unknown>([['settings', { execMode: 'fundo', ...settings }]]);
  const out = { status: [] as [string, string][], again: [] as number[] };
  return {
    out,
    store,
    c: {
      world: 'br142',
      villageId: '35454',
      storage: {
        get: <T,>(k: string, d: T): T => (store.has(k) ? (store.get(k) as T) : d),
        set: <T,>(k: string, v: T): void => void store.set(k, v),
      },
      status: (m: string, k = 'info') => out.status.push([m, k]),
      again: (ms: number) => out.again.push(ms),
    },
  };
}

beforeEach(() => {
  pages.length = 0;
  gets.length = 0;
  sent.length = 0;
  unlocked.length = 0;
  gmStore.clear();
});

describe('Coleta em 2º plano', () => {
  it('uma aldeia, 4 níveis livres: 4 grupos num único envio e segue para a próxima página', async () => {
    pages.push(pageWith(1, 2));
    const { c, out, store } = ctx({});
    await collectionAutomation.runCycle(c as never);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(4);
    expect(store.get('massPage')).toBe(1);
    expect(out.again).toEqual([60_000]);
    expect(out.status.at(-1)?.[1]).toBe('ok');
    expect(gets[0]).toContain('mode=scavenge_mass&page=0');
  });

  it('teto de 50 grupos: 13 aldeias × 4 níveis = 12 aldeias agora, a página fica para o próximo ciclo', async () => {
    pages.push(pageWith(13, 0));
    const { c, out, store } = ctx({});
    await collectionAutomation.runCycle(c as never);
    expect(sent[0]).toHaveLength(48);
    expect(store.get('massPage')).toBe(0);
    expect(out.again).toEqual([60_000]);
  });

  it('nada livre: pula páginas e, com desbloqueio ligado, desbloqueia o próximo nível (1 mutação)', async () => {
    const busy = (v: Record<string, unknown>): void => {
      const o = v.options as Record<string, Record<string, unknown>>;
      o['1']!.scavenging_squad = { return_time: 1 };
      o['2']!.scavenging_squad = { return_time: 1 };
      o['3']!.is_locked = true;
      o['4']!.is_locked = true;
    };
    pages.push(pageWith(2, 1, busy), pageWith(2, 1, busy));
    const { c, out } = ctx({ autoUnlock: true });
    await collectionAutomation.runCycle(c as never);
    expect(sent).toHaveLength(0);
    expect(unlocked).toEqual([['300000', 3]]);
    expect(out.status.at(-1)?.[0]).toContain('desbloqueio');
  });

  it('tropa desligada e "fica em casa" nunca saem', async () => {
    pages.push(pageWith(1, 0));
    const { c } = ctx({ skipUnits: ['light'], reserveByUnit: { axe: 6068 } });
    await collectionAutomation.runCycle(c as never);
    const reqs = sent[0] as { units: Record<string, number> }[];
    expect(reqs.every((r) => r.units.light === undefined && r.units.axe === undefined)).toBe(true);
  });

  it('comando agendado da aldeia: as tropas dele ficam em casa', async () => {
    pages.push(pageWith(1, 0));
    gmStore.set('tsh-auto:br142:command-scheduler:scheduler', JSON.stringify({
      commands: [
        {
          id: 'c1',
          sourceVillageId: '300000',
          kind: 'attack',
          target: '500|500',
          units: { axe: 6068 },
          sendAt: new Date(Date.UTC(2026, 8, 24, 13)).toISOString(),
          arrivalAt: new Date(Date.UTC(2026, 8, 24, 14)).toISOString(),
          status: 'agendado',
          events: [],
        },
      ],
    }));
    const { c, out } = ctx({});
    await collectionAutomation.runCycle(c as never);
    const reqs = sent[0] as { units: Record<string, number> }[];
    expect(reqs.reduce((a, r) => a + (r.units.axe ?? 0), 0)).toBe(0);
    expect(out.status.at(-1)?.[0]).toContain('Agendador');
  });

  it('grupo selecionado no jogo ≠ todos: avisa que cobre só aquele grupo', async () => {
    pages.push(pageWith(1, 0).replace('<script>', '<script>var x={"group_id":"182607"};</script><a class="group-menu-item" data-group-id="182607" data-group-type="static">&gt;DEF&lt;</a><script>'));
    const { c, out } = ctx({});
    await collectionAutomation.runCycle(c as never);
    expect(out.status.at(-1)?.[0]).toContain('só o grupo "DEF"');
  });

  it('recusa total do jogo: avança para as próximas aldeias (não prende o cursor)', async () => {
    const t = await import('../tsh-transport');
    vi.mocked(t.sendScavengeBatch).mockRejectedValueOnce(Object.assign(new Error('O jogo recusou a coleta: x'), { code: 'GAME_REFUSED' }));
    pages.push(pageWith(1, 3));
    const { c, store, out } = ctx({});
    await expect(collectionAutomation.runCycle(c as never)).rejects.toThrow('recusou');
    expect(store.get('massPage')).toBe(1);
    expect(out.again).toEqual([60_000]);
  });

  it('regras antigas ilegíveis: não envia nada', async () => {
    pages.push(pageWith(1, 0));
    const { c } = ctx({ groupRules: 'isso não é regra' });
    await expect(collectionAutomation.runCycle(c as never)).rejects.toThrow('Regras por grupo antigas');
    expect(sent).toHaveLength(0);
  });

  it('página ilegível: não envia nada e avisa', async () => {
    pages.push('<html>sem coleta</html>');
    const { c, out } = ctx({});
    await collectionAutomation.runCycle(c as never);
    expect(sent).toHaveLength(0);
    expect(out.status.at(-1)?.[1]).toBe('warn');
  });
});
