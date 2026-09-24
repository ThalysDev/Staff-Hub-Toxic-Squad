// Recrutamento em SEGUNDO PLANO (v3.8.0) — rede simulada, página REAL do
// Recrutamento em massa do BR142.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import massHtml from '../__fixtures__/br142-train-mass.html?raw';

const store = new Map<string, unknown>();
vi.stubGlobal('GM_getValue', (k: string, d: unknown) => (store.has(k) ? store.get(k) : d));
vi.stubGlobal('GM_setValue', (k: string, v: unknown) => store.set(k, v));
vi.stubGlobal('GM_deleteValue', (k: string) => store.delete(k));
vi.stubGlobal('window', { location: { search: '?screen=overview', hostname: 'br142.tribalwars.com.br' } });

let page = massHtml;
/** Página depois do envio (null = igual à de antes). */
let after: string | null = null;
let reads = 0;
vi.mock('../../../core/net', async (orig) => ({
  ...(await orig<typeof import('../../../core/net')>()),
  pacedGet: vi.fn(async () => {
    reads += 1;
    return reads > 1 && after !== null ? after : page;
  }),
}));
vi.mock('../tsh-humanize', () => ({ awaitRoutineMutation: async () => true }));
const posts: { action: string; fields: Record<string, string> }[] = [];
vi.mock('./onda5-form-post', () => ({
  postGameForm: vi.fn(async (action: string, fields: Record<string, string>) => {
    posts.push({ action, fields });
    return { ok: true, message: 'ok', afterMutation: false };
  }),
}));

const { recruitmentAutomation } = await import('./recruitment');

function ctx(settings: Record<string, unknown>, persisted = true) {
  if (persisted) store.set('tsh-auto:br142:recruitment:settings', JSON.stringify(settings));
  const kv = new Map<string, unknown>([['settings', settings]]);
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
  posts.length = 0;
  page = massHtml;
  after = null;
  reads = 0;
});

describe('Recrutamento em 2º plano', () => {
  it('um envio para a página toda, só com o que cabe (máximo do jogo), confirmado pela fila', async () => {
    after = massHtml.replace('data-running="0" type="text" id="spear_173095"', 'data-running="2" type="text" id="spear_173095"');
    const { c, out } = ctx({ execMode: 'fundo', goals: { spear: 500, archer: 5000 } });
    await recruitmentAutomation.runCycle(c as never);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.action).toContain('action=train_mass');
    // 173095: fazenda com 2 livres → 2 lanças; 135944: máximo do jogo 0 → nada.
    expect(posts[0]!.fields).toEqual({ 'units[173095][spear]': '2' });
    expect(out.status.at(-1)?.[1]).toBe('ok');
  });

  it('o jogo recusou (a fila não mudou): avisa, não diz "enviado"', async () => {
    const { c, out } = ctx({ execMode: 'fundo', goals: { spear: 500 } });
    await recruitmentAutomation.runCycle(c as never);
    expect(posts).toHaveLength(1);
    expect(out.status.at(-1)).toEqual([expect.stringContaining('não aceitou'), 'warn']);
  });

  it('metas atendidas contando a fila: não envia', async () => {
    const { c, out } = ctx({ execMode: 'fundo', goals: { axe: 6200 } });
    await recruitmentAutomation.runCycle(c as never);
    expect(posts).toHaveLength(0);
    expect(out.status.at(-1)?.[0]).toContain('Nada a recrutar');
  });

  it('sem Premium (sem a tabela): não envia e explica', async () => {
    page = '<html>sem premium</html>';
    const { c, out } = ctx({ execMode: 'fundo', goals: { spear: 10 } });
    await recruitmentAutomation.runCycle(c as never);
    expect(posts).toHaveLength(0);
    expect(out.status.at(-1)?.[0]).toContain('Conta Premium');
  });

  it('quem já usava (settings antigos sem execMode) segue "Só na tela" com aviso', async () => {
    const { c, out } = ctx({ goals: { spear: 10 } });
    await recruitmentAutomation.runCycle(c as never);
    expect(posts).toHaveLength(0);
    expect(out.status.at(-1)?.[0]).toContain('Novo na 3.8');
  });
});
