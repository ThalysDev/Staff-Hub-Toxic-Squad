// Cunhagem nativa + Cunhagem em massa em SEGUNDO PLANO (v3.10.0) — rede e
// jogo simulados, telas REAIS da Academia do BR142.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import coinHtml from '../__fixtures__/br142-snob-coin.html?raw';
import snobHtml from '../__fixtures__/br142-snob-train.html?raw';
import ativa from '../__fixtures__/br142-snob-train-ativa.html?raw';

const store = new Map<string, unknown>();
vi.stubGlobal('GM_getValue', (k: string, d: unknown) => (store.has(k) ? store.get(k) : d));
vi.stubGlobal('GM_setValue', (k: string, v: unknown) => store.set(k, v));
vi.stubGlobal('GM_deleteValue', (k: string) => store.delete(k));
vi.stubGlobal('window', { location: { search: '?screen=overview', hostname: 'br142.tribalwars.com.br' } });

let started = false;
const gets: string[] = [];
vi.mock('../../../core/net', async (orig) => ({
  ...(await orig<typeof import('../../../core/net')>()),
  pacedGet: vi.fn(async (path: string) => {
    gets.push(path);
    if (path.includes('mode=coin')) return coinHtml;
    return started ? ativa : snobHtml;
  }),
}));
const posts: string[] = [];
vi.mock('./onda5-form-post', () => ({
  postGameForm: vi.fn(async (action: string) => {
    posts.push(action);
    started = true;
    return { ok: true, message: '', afterMutation: false };
  }),
}));
const multi: Record<string, number>[] = [];
vi.mock('../tsh-transport', async (orig) => ({
  ...(await orig<typeof import('../tsh-transport')>()),
  mintCoinsMultiApi: vi.fn(async (v: Record<string, number>) => {
    multi.push(v);
    return { minted_coins: v, message: 'ok' };
  }),
}));
vi.mock('../tsh-humanize', () => ({ awaitRoutineMutation: async () => true }));
// Relógio do jogo = 24/09/2026 15:42 (hora da captura): a sessão termina hoje às 23:42:01.
const CAPTURA = new Date(2026, 8, 24, 15, 42, 0).getTime();
vi.mock('../../../core/game-clock', async (orig) => ({ ...(await orig<typeof import('../../../core/game-clock')>()), serverNowMs: () => CAPTURA }));

const { tshAutomations } = await import('../tsh-runtime');
await import('./auto-mint-nativo');
await import('./coin-center');
const native = tshAutomations().find((a) => a.id === 'auto-mint-nativo')!;
const mass = tshAutomations().find((a) => a.id === 'coin-center')!;

function ctx(id: string, settings: Record<string, unknown>) {
  store.set(`tsh-auto:br142:${id}:settings`, JSON.stringify(settings));
  const out: [string, string][] = [];
  return {
    out,
    c: {
      world: 'br142',
      villageId: '35454',
      storage: {
        get: <T,>(k: string, d: T): T => (store.has(`tsh-auto:br142:${id}:${k}`) ? (JSON.parse(store.get(`tsh-auto:br142:${id}:${k}`) as string) as T) : d),
        set: <T,>(k: string, v: T): void => void store.set(`tsh-auto:br142:${id}:${k}`, JSON.stringify(v)),
      },
      status: (m: string, k = 'info') => out.push([m, k]),
      again: () => undefined,
    },
  };
}

beforeEach(() => {
  store.clear();
  posts.length = 0;
  multi.length = 0;
  gets.length = 0;
  started = false;
});

describe('Cunhagem nativa', () => {
  it('liga a sessão pela coordenada, confirma relendo e só volta quando as 8h acabam', async () => {
    const { c, out } = ctx('auto-mint-nativo', { alvo: 'coords', coords: '534|551 534|551 999|999 591|451', checkHours: 1 });
    await native.runCycle(c as never);
    expect(posts).toEqual(['/game.php?village=35454&screen=snob&action=start_auto_minting_session&h=f5506e54']);
    expect(out.at(-1)?.[0]).toContain('1 sessão(ões) ligada(s) agora');
    expect(out.at(-1)?.[0]).toContain('1 coordenada não é aldeia sua');
    expect(out.at(-1)?.[0]).toContain('1 aldeia sem Academia fica de fora');
    // Segundo ciclo: sessão recém-ligada não é relida nem religada.
    gets.length = 0;
    await native.runCycle(c as never);
    expect(posts).toHaveLength(1);
    expect(gets.filter((g) => g.includes('screen=snob&') && !g.includes('mode=coin'))).toHaveLength(0);
    expect(out.at(-1)?.[0]).toContain('em dia');
  });

  it('sessão já ativa (ligada à mão): não posta nada', async () => {
    started = true;
    const { c, out } = ctx('auto-mint-nativo', { alvo: 'coords', coords: '534|551', checkHours: 1 });
    await native.runCycle(c as never);
    expect(posts).toHaveLength(0);
    expect(out.at(-1)?.[0]).toContain('1 já estava(m) ativa(s) (2 moeda(s) cunhada(s) pelo jogo');
    // Volta 1 min depois do "Fim: hoje às 23:42:01" que o jogo mostra (8h depois da captura).
    const next = JSON.parse(store.get('tsh-auto:br142:auto-mint-nativo:next') as string) as Record<string, number>;
    expect(Math.round(((next['238755'] ?? 0) - Date.now()) / 60_000)).toBe(8 * 60 + 1);
  });

  it('configuração antiga (grupo em texto) vira grupo; sem aldeias escolhidas avisa', async () => {
    const { c, out } = ctx('auto-mint-nativo', {});
    await native.runCycle(c as never);
    expect(out.at(-1)?.[0]).toContain('Nenhuma aldeia escolhida');
  });
});

describe('Cunhagem em massa', () => {
  it('cunha em todas as aldeias com o máximo do jogo e reporta o que o jogo confirmou', async () => {
    const { c, out } = ctx('coin-center', { execMode: 'fundo', reserveWood: 0, reserveStone: 0, reserveIron: 0, keepPercent: 0, perVillage: 0 });
    await mass.runCycle(c as never);
    expect(multi).toEqual([{ 238755: 2, 2095: 1, 20180: 2, 1184: 2, 177127: 1 }]);
    expect(out.at(-1)).toEqual([expect.stringContaining('Cunhadas 8 moeda(s) em 5 aldeia(s) — confirmado pelo jogo'), 'ok']);
  });

  it('pula aldeias com a cunhagem nativa ativa', async () => {
    store.set('tsh-auto:br142:auto-mint-nativo:active', JSON.stringify({ 238755: Date.now() + 3_600_000 }));
    const { c, out } = ctx('coin-center', { execMode: 'fundo', reserveWood: 0, reserveStone: 0, reserveIron: 0, keepPercent: 0, perVillage: 1, skipNative: true });
    await mass.runCycle(c as never);
    expect(multi[0]).toEqual({ 2095: 1, 20180: 1, 1184: 1, 177127: 1 });
    expect(out.at(-1)?.[0]).toContain('1 aldeia(s) com a cunhagem nativa ativa ficaram de fora');
  });

  it('quem já usava (sem execMode) segue só na tela, com aviso', async () => {
    const { c, out } = ctx('coin-center', { maxCoinsPerCycle: 3 });
    await mass.runCycle(c as never);
    expect(multi).toHaveLength(0);
    expect(out.at(-1)?.[0]).toContain('Novo na 3.10');
  });
});
