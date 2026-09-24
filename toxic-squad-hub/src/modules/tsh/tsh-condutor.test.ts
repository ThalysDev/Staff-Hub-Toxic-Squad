// Condutor do Agendador (v3.2.2). Regressão do caso real: comando agendado com
// a aba na Visão geral ficou "Na mira" e virou "Falhou" sem motivo, porque só
// a aba NA PRAÇA da origem envia. GM storage e página simulados em memória.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
vi.stubGlobal('GM_getValue', (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback));
vi.stubGlobal('GM_setValue', (key: string, value: unknown) => store.set(key, value));
vi.stubGlobal('GM_deleteValue', (key: string) => store.delete(key));
const session = new Map<string, string>();
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => session.get(k) ?? null,
  setItem: (k: string, v: string) => session.set(k, v),
  removeItem: (k: string) => session.delete(k),
});
const page = {
  location: { hostname: 'br142.tribalwars.com.br', origin: 'https://br142.tribalwars.com.br', search: '?village=9&screen=overview', href: 'https://br142.tribalwars.com.br/game.php?village=9&screen=overview' },
  game_data: { village: { id: 9 } },
  setTimeout,
  clearTimeout,
  addEventListener: () => undefined,
};
vi.stubGlobal('window', page);
vi.mock('../../core/game-clock', () => ({ serverNowMs: () => Date.now() }));
vi.mock('../../core/license', () => ({ licenseState: () => ({ kind: 'valida' }) }));
interface FakeFrame {
  name: string;
  src: string;
  removed: boolean;
  style: { cssText: string };
  tabIndex: number;
  title: string;
  setAttribute: () => void;
  remove: () => void;
  contentWindow: unknown;
  contentDocument: unknown;
}
const createdFrames: FakeFrame[] = [];
const doc = {
  hidden: true,
  activeElement: null as unknown,
  body: { appendChild: (el: FakeFrame) => createdFrames.push(el) },
  querySelectorAll: (sel: string) => (sel === 'textarea' ? textareas : []),
  createElement: (): FakeFrame => {
    const f: FakeFrame = { name: '', src: '', removed: false, style: { cssText: '' }, tabIndex: 0, title: '', setAttribute: () => undefined, remove: () => { f.removed = true; }, contentWindow: null, contentDocument: null };
    return f;
  },
};
let textareas: { value: string; defaultValue: string }[] = [];
vi.stubGlobal('document', doc);

const { gm } = await import('../../core/storage');
const { setTshEnabled } = await import('./tsh-runtime');
const { conductorTick, readinessOf, tabReadyFor } = await import('./tsh-condutor');
const { closeAllFrames } = await import('./tsh-envio-quadro');

const KEY = 'tsh-auto:br142:command-scheduler:scheduler';

function command(id: string, sendInMs: number, source = '1171'): Record<string, unknown> {
  return {
    id,
    sourceVillageId: source,
    sourceName: 'Nobre',
    source: { x: 719, y: 502 },
    target: { x: 716, y: 503 },
    kind: 'support',
    units: { spear: 200 },
    sendAt: new Date(Date.now() + sendInMs).toISOString(),
    arrivalAt: new Date(Date.now() + sendInMs + 600_000).toISOString(),
    events: [{ status: 'agendado', at: new Date().toISOString() }],
  };
}

function setCommands(...cmds: Record<string, unknown>[]): void {
  gm.set(KEY, { commands: cmds });
}

function onScreen(screen: string, village: number): void {
  page.game_data.village.id = village;
  page.location.search = `?village=${village}&screen=${screen}`;
  page.location.href = `https://br142.tribalwars.com.br/game.php${page.location.search}`;
}

const SETTINGS = 'tsh-auto:br142:command-scheduler:settings';

describe('Envio em 2º plano (quadro invisível)', () => {
  beforeEach(() => {
    store.clear();
    session.clear();
    closeAllFrames('br142');
    createdFrames.length = 0;
    onScreen('overview', 9);
    setTshEnabled('command-scheduler', true);
  });

  it('origens coladas: TODAS ficam cobertas pelo 2º plano (um quadro por origem)', () => {
    setCommands(command('a', 60_000), command('b', 61_000, '2222'));
    const cmds = gm.get<{ commands: never[] }>(KEY, { commands: [] }).commands;
    expect(readinessOf(cmds[0]!, 'br142')).toBe('fundo');
    expect(readinessOf(cmds[1]!, 'br142')).toBe('fundo');
    conductorTick();
    expect(createdFrames.map((f) => f.name).sort()).toEqual(['tsh-envio:1171', 'tsh-envio:2222']);
    expect(createdFrames[0]!.src).toContain('screen=place');
    // Nunca navega a aba do jogador.
    expect(page.location.href).toContain('screen=overview');
  });

  it('não abre quadro cedo demais nem em cima da hora', () => {
    setCommands(command('a', 10 * 60_000), command('b', 5_000, '2222'));
    conductorTick();
    expect(createdFrames.length).toBe(0);
  });

  it('não duplica: outra aba já hospeda o quadro dessa origem', () => {
    setCommands(command('a', 60_000));
    gm.set('tsh:br142:envio-host:1171', { tab: 'outra', at: Date.now() });
    conductorTick();
    expect(createdFrames.length).toBe(0);
  });

  it('quadro que acusa problema cai no plano B (e o motivo aparece)', () => {
    setCommands(command('a', 60_000));
    conductorTick();
    expect(createdFrames.length).toBe(1);
    // O jogo mandou o quadro para a tela de sessão expirada.
    createdFrames[0]!.contentWindow = { location: { href: 'https://br142.tribalwars.com.br/page/session-expired', pathname: '/page/session-expired', search: '' } };
    createdFrames[0]!.contentDocument = { readyState: 'complete', querySelector: () => null };
    conductorTick();
    expect(createdFrames[0]!.removed).toBe(true);
    const rec = gm.get<{ commands: never[] }>(KEY, { commands: [] }).commands[0]!;
    expect(readinessOf(rec, 'br142')).toBe('automatico');
  });

  it('quadro já pronto NÃO fecha enquanto a confirmação do envio carrega (regressão P0)', () => {
    setCommands(command('a', 110_000));
    conductorTick();
    const f = createdFrames[0]!;
    f.contentWindow = { location: { href: 'https://br142.tribalwars.com.br/game.php?village=1171&screen=place', pathname: '/game.php', search: '?village=1171&screen=place' }, game_data: { village: { id: 1171 } } };
    f.contentDocument = { readyState: 'complete', querySelector: () => null };
    conductorTick(); // fica pronto (everOk)
    // 60 s depois (bem além do prazo de carga), o POST do pré-arme está carregando.
    vi.setSystemTime(Date.now() + 60_000);
    f.contentDocument = { readyState: 'loading', querySelector: () => null };
    conductorTick();
    expect(f.removed).toBe(false);
    vi.useRealTimers();
  });

  it('com o 2º plano desligado, volta ao plano B', () => {
    gm.set(SETTINGS, { backgroundSend: false });
    setCommands(command('a', 60_000));
    const rec = gm.get<{ commands: never[] }>(KEY, { commands: [] }).commands[0]!;
    expect(readinessOf(rec, 'br142')).toBe('automatico');
  });
});

describe('Condutor do Agendador (plano B: levar a aba)', () => {
  beforeEach(() => {
    store.clear();
    session.clear();
    onScreen('overview', 9);
    setTshEnabled('command-scheduler', true);
    gm.set(SETTINGS, { backgroundSend: false });
    doc.hidden = true;
    textareas = [];
  });

  it('diz a verdade: fora da Praça da origem o comando NÃO está na mira', () => {
    setCommands(command('a', 120_000));
    const rec = (gm.get<{ commands: never[] }>(KEY, { commands: [] }).commands)[0]!;
    expect(readinessOf(rec, 'br142')).toBe('automatico');
    onScreen('place', 1171);
    expect(readinessOf(rec, 'br142')).toBe('aqui');
  });

  it('avisa antes e leva a aba até a Praça da origem 60 s antes, guardando a volta', () => {
    setCommands(command('a', 70_000));
    const aviso = conductorTick();
    expect(aviso.fabText).toContain('Praça de Nobre');
    expect(aviso.bar?.canDecline).toBe(true);
    expect(page.location.href).toContain('screen=overview');

    setCommands(command('a', 55_000));
    conductorTick();
    expect(page.location.href).toBe('/game.php?village=1171&screen=place');
    expect(session.get('tsh-nav-return')).toContain('screen=overview');
  });

  it('não navega se outra aba já está pronta na Praça (lock fresco) nem perto demais do envio', () => {
    setCommands(command('a', 30_000));
    gm.set('tsh-auto:br142:command-scheduler:v1171:lock', { tab: 'outra', at: Date.now() });
    expect(tabReadyFor('br142', '1171')).toBe(true);
    conductorTick();
    expect(page.location.href).toContain('screen=overview');

    store.clear();
    setTshEnabled('command-scheduler', true);
    setCommands(command('a', 8_000));
    conductorTick();
    expect(page.location.href).toContain('screen=overview');
  });

  it('respeita a reivindicação de outra aba', () => {
    setCommands(command('a', 30_000));
    gm.set('tsh:br142:nav-claim', { cmd: 'a', tab: 'outra', at: Date.now() });
    expect(conductorTick().fabText).toContain('Outra aba');
    expect(page.location.href).toContain('screen=overview');
  });

  it('com a opção desligada não navega', () => {
    setCommands(command('a', 30_000));
    gm.set(SETTINGS, { backgroundSend: false, autoNavigate: false });
    conductorTick();
    expect(page.location.href).toContain('screen=overview');
  });

  it('comando que passou da hora sem aba na Praça ganha MOTIVO gravado', () => {
    setCommands(command('a', -10_000));
    conductorTick();
    const rec = gm.get<{ commands: { events: { status: string; detail?: string }[] }[] }>(KEY, { commands: [] }).commands[0]!;
    const last = rec.events[rec.events.length - 1]!;
    expect(last.status).toBe('falhou');
    expect(last.detail).toContain('Nenhuma aba estava na Praça de Nobre');
    // Não duplica no tique seguinte.
    conductorTick();
    const again = gm.get<{ commands: { events: unknown[] }[] }>(KEY, { commands: [] }).commands[0]!;
    expect(again.events.length).toBe(rec.events.length);
  });

  it('Agendador desligado: o motivo diz isso', () => {
    setTshEnabled('command-scheduler', false);
    setCommands(command('a', -10_000));
    conductorTick();
    const rec = gm.get<{ commands: { events: { detail?: string }[] }[] }>(KEY, { commands: [] }).commands[0]!;
    expect(rec.events[rec.events.length - 1]!.detail).toContain('o Agendador está desligado');
  });

  it('aba em uso (texto não enviado) nunca é levada embora', () => {
    textareas = [{ value: 'MP pela metade', defaultValue: '' }];
    setCommands(command('a', 30_000));
    const st = conductorTick();
    expect(page.location.href).toContain('screen=overview');
    expect(st.bar?.kind).toBe('warn');
  });

  it('aba À VISTA espera mais (a de 2º plano tem preferência)', () => {
    doc.hidden = false;
    setCommands(command('a', 55_000));
    conductorTick();
    expect(page.location.href).toContain('screen=overview');
    setCommands(command('a', 40_000));
    conductorTick();
    expect(page.location.href).toBe('/game.php?village=1171&screen=place');
  });

  it('"Não levar esta aba" é respeitado', async () => {
    const { declineNav } = await import('./tsh-condutor');
    setCommands(command('a', 30_000));
    const rec = gm.get<{ commands: never[] }>(KEY, { commands: [] }).commands[0]!;
    declineNav(rec);
    const st = conductorTick();
    expect(page.location.href).toContain('screen=overview');
    expect(st.bar?.body).toContain('não sai');
  });

  it('duas origens coladas: só a primeira é coberta; a segunda fica "manual"', () => {
    setCommands(command('a', 120_000), command('b', 130_000, '2222'));
    const cmds = gm.get<{ commands: never[] }>(KEY, { commands: [] }).commands;
    expect(readinessOf(cmds[0]!, 'br142')).toBe('automatico');
    expect(readinessOf(cmds[1]!, 'br142')).toBe('manual');
  });

  it('fake humanizado atrasado ainda não é dado como perdido', () => {
    setCommands({ ...command('f', -10_000), kind: 'fake' });
    conductorTick();
    const rec = gm.get<{ commands: { events: { status: string }[] }[] }>(KEY, { commands: [] }).commands[0]!;
    expect(rec.events.some((e) => e.status === 'falhou')).toBe(false);
  });
});
