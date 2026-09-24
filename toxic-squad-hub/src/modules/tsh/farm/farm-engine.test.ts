// Motor da Central de Farm — uma rodada completa com rede simulada e as
// páginas REAIS do BR142 (Assistente + Visão de Tropas).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import farmHtml from '../__fixtures__/br142-am-farm.html?raw';
import unitsHtml from '../__fixtures__/br142-units-home.html?raw';

const store = new Map<string, unknown>();
vi.stubGlobal('GM_getValue', (k: string, d: unknown) => (store.has(k) ? store.get(k) : d));
vi.stubGlobal('GM_setValue', (k: string, v: unknown) => store.set(k, v));
vi.stubGlobal('GM_deleteValue', (k: string) => store.delete(k));

// Aldeia própria colada nos alvos verdes (717|504 e 715|508), com cav. leve.
const units = unitsHtml.replace('(552|431)', '(716|505)');
vi.mock('../../../core/net', async (orig) => ({
  ...(await orig<typeof import('../../../core/net')>()),
  pacedGet: vi.fn(async (path: string) => {
    if (path.includes('screen=am_farm')) return farmHtml.replace(/Farm_page=36/, 'Farm_page=0');
    if (path.includes('mode=units')) return units;
    return '<table></table>';
  }),
}));
const sends: unknown[][] = [];
let refuse = false;
vi.mock('../tsh-transport', async (orig) => ({
  ...(await orig<typeof import('../tsh-transport')>()),
  sendFarmAttack: vi.fn(async (...args: unknown[]) => {
    sends.push(args);
    if (refuse) throw Object.assign(new Error('Não há tropas suficientes.'), { code: 'GAME_REFUSED' });
    return { currentUnits: null };
  }),
}));
let block: { kind: string; text: string } | null = null;
vi.mock('../tsh-runtime', async (orig) => ({
  ...(await orig<typeof import('../tsh-runtime')>()),
  tshRunBlock: () => block,
  currentVillageId: () => '35454',
}));
vi.mock('../../../core/game-clock', () => ({ serverNowMs: () => 1_000_000, backgroundSleep: () => new Promise<void>((r) => setTimeout(r, 0)) }));
vi.mock('../tsh-game-data', () => ({ unitSpeedsMinutesPerField: async () => ({ spy: 9, light: 10, axe: 18 }) }));

const { FarmEngine } = await import('./farm-engine');

beforeEach(() => {
  store.clear();
  sends.length = 0;
  refuse = false;
  block = null;
});

/** Roda UMA rodada (para o motor no começo da espera entre rodadas). */
async function oneRound(engine: InstanceType<typeof FarmEngine>): Promise<void> {
  await new Promise<void>((resolve) => {
    let done = false;
    engine.onChange((s) => {
      if (done) return;
      if (s.phase === 'aguardando' || (!s.running && s.round > 0)) {
        done = true;
        engine.stop();
        resolve();
      }
    });
    engine.start();
  });
}

describe('Central de Farm — rodada', () => {
  it('farma o verde parcial com A pela aldeia mais próxima e registra no diário', async () => {
    const engine = new FarmEngine('br142', (fn) => fn());
    await oneRound(engine);
    expect(sends.length).toBeGreaterThanOrEqual(1);
    expect(sends[0]).toEqual(['171940', { kind: 'template', targetId: '212202', templateId: '23' }]);
    expect(engine.snapshot.sent.A).toBeGreaterThanOrEqual(1);
    expect(engine.snapshot.walls.length).toBeGreaterThan(0);
    expect(engine.snapshot.log.some((l) => l.kind === 'ok')).toBe(true);
  });

  it('recusa do jogo por falta de tropa: registra e não insiste com a mesma aldeia', async () => {
    refuse = true;
    const engine = new FarmEngine('br142', (fn) => fn());
    await oneRound(engine);
    expect(sends).toHaveLength(1);
    expect(engine.snapshot.refused).toBe(1);
  });

  it('bloqueio (captcha, desligado, parada programada) para antes de enviar', async () => {
    block = { kind: 'desligado', text: 'Parou: a automação foi desligada no painel.' };
    const engine = new FarmEngine('br142', (fn) => fn());
    engine.start();
    await Promise.resolve();
    expect(sends).toHaveLength(0);
    expect(engine.snapshot.running).toBe(false);
    expect(engine.snapshot.detail).toContain('desligada');
  });

  it('fora do horário ativo: espera (não para) e não envia', async () => {
    block = { kind: 'janela', text: 'Fora do horário ativo (22:00–06:00) — volta sozinho quando o horário abrir.' };
    const engine = new FarmEngine('br142', (fn) => fn());
    await new Promise<void>((resolve) => {
      let done = false;
      engine.onChange((s) => {
        if (!done && s.phase === 'aguardando') {
          done = true;
          resolve();
        }
      });
      engine.start();
    });
    expect(engine.snapshot.running).toBe(true);
    expect(engine.snapshot.detail).toContain('Fora do horário');
    expect(sends).toHaveLength(0);
    engine.stop();
  });

  it('Parar de outra aba (pedido gravado) para o motor dono', async () => {
    const { requestFarmStop } = await import('./farm-engine');
    block = { kind: 'janela', text: 'Fora do horário.' };
    const engine = new FarmEngine('br142', (fn) => fn());
    engine.start();
    await new Promise((r) => setTimeout(r, 5));
    requestFarmStop('br142');
    await new Promise((r) => setTimeout(r, 30));
    expect(engine.snapshot.running).toBe(false);
  });

  it('outra aba com o lock fresco: não inicia', () => {
    store.set('tsh-farm:br142:lock', JSON.stringify({ tab: 'outra', at: Date.now() }));
    const engine = new FarmEngine('br142', (fn) => fn());
    engine.start();
    expect(engine.snapshot.running).toBe(false);
    expect(engine.snapshot.phase).toBe('bloqueado');
  });
});
