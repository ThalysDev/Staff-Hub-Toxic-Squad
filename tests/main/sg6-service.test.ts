/**
 * Testes do Sg6Service (reservas em massa + MPs) com sessão MOCKADA.
 *
 * Estratégia: 'electron' trocado pelo helper tests/main/electron-mock.ts
 * (vi.mock com factory async — ver cabeçalho do helper). Todo o resto é REAL:
 * TwSessionManager (logado de verdade via loginWithSid contra o fetch mockado
 * com a fixture real de overview), Journal e JsonStore gravando em userData
 * temporário de verdade (tmp+rename atômicos) e RequestQueue real para o
 * single-flight (C4). Só o fio de rede (session.fromPartition().fetch) é fake.
 *
 * Fixtures HTML: tests/fixtures/br142 (páginas REAIS do BR142 — overview,
 * formulário de reservas e formulário de MP trazem os tokens
 * "csrf"/"village":{"id":N} que o service exige via pageTokens).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dialog } from 'electron';

vi.mock('electron', async () => {
  const { createElectronMock } = await import('./electron-mock');
  // O electron-mock base não expõe `dialog` (nenhum service tocava). O
  // chargeBatch abre o diálogo nativo DENTRO do service — mock default:
  // CONFIRMADO (response 1); os testes de cancelamento sobrescrevem o retorno.
  return {
    ...createElectronMock(),
    dialog: {
      showMessageBox: vi.fn(async () => ({ response: 1, checkboxChecked: false })),
    },
  };
});

import {
  disposeElectronMock,
  electronMockState,
  fetchCallCount,
  html,
  resetElectronMock,
  routeElectronFetch,
  type FetchRoute,
} from './electron-mock';
import { TwSessionManager } from '../../src/main/tw/session';
import { Journal } from '../../src/main/journal';
import { JsonStore } from '../../src/main/stores/json-store';
import { RequestQueue } from '../../src/main/tw/request-queue';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc-types';
import { Sg6Service, type MpEntry } from '../../src/main/mutations/sg6-service';

const WORLD = 'br142';
const SID = `0:${'1f'.repeat(32)}`; // formato "0:hex64" aceito por parseSidInput

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/br142/${name}`, import.meta.url)), 'utf-8');
}

/** POST 200 "neutro": sem sentinela, sem "já reservada", sem class="error". */
const POST_OK = '<html><body><div class="success">Reserva efetuada.</div></body></html>';

interface Harness {
  service: Sg6Service;
  journal: Journal;
  queue: RequestQueue;
}

/**
 * Monta o service como o index.ts monta (stores reais em temp + queue real) e
 * faz o login de verdade: loginWithSid → cookies.set (mock) → probe GET
 * overview → looksLikeGamePage. Depois disso getStatus() é logged-in/br142.
 */
async function buildHarness(options: { settings?: Partial<AppSettings>; login?: boolean; routes?: FetchRoute[] } = {}): Promise<Harness> {
  const journal = new Journal();
  const settingsStore = new JsonStore<AppSettings>('settings', DEFAULT_SETTINGS);
  await settingsStore.save({
    ...DEFAULT_SETTINGS,
    requestMinIntervalMs: 350, // piso humano imposto pelo service
    requestJitterMs: 0, // determinístico: sem jitter aleatório
    requestCeiling: 400,
    ...options.settings,
  });
  const queue = new RequestQueue(
    vi.fn(async (url: string) => ({ ok: true, status: 200, body: '', url })), // nunca chamado: services só usam begin/endOperation
    vi.fn(),
    { minIntervalMs: 0, jitterMs: 0, ceiling: 400 },
  );
  const twSession = new TwSessionManager();
  routeElectronFetch([
    ...(options.routes ?? []),
    { match: 'screen=overview', handler: () => html(fixture('overview.html')) },
  ]);
  if (options.login !== false) {
    const login = await twSession.loginWithSid(WORLD, SID);
    expect(login.ok).toBe(true);
  }
  return { service: new Sg6Service(twSession, journal, settingsStore, queue), journal, queue };
}

/** Acesso tipado ao stub do diálogo nativo instalado na factory do vi.mock. */
function showMessageBoxMock() {
  return vi.mocked(dialog.showMessageBox);
}

beforeEach(() => {
  resetElectronMock();
  // Diálogo nativo: default CONFIRMADO; mockReset limpa calls/overrides do teste anterior.
  showMessageBoxMock().mockReset();
  showMessageBoxMock().mockResolvedValue({ response: 1, checkboxChecked: false });
});

afterAll(() => {
  disposeElectronMock();
});

describe('Sg6Service.reserveMass (reservas no Planejador)', () => {
  it('reserva bem-sucedida: reconhece form+CSRF da página, POST 200 e journal "sucesso"', async () => {
    const posts: string[] = [];
    const routes: FetchRoute[] = [
      {
        match: 'action=new_reservation',
        handler: (init) => {
          posts.push(init.body ?? '');
          return html(POST_OK);
        },
      },
      // formulário REAL do BR142 (tem "csrf":"e817d0df" e "village":{"id":79788)
      { match: 'screen=ally&mode=reservations', handler: () => html(fixture('ally-reservations.html')) },
    ];
    const { service, journal, queue } = await buildHarness({ routes });

    const outcomes = await service.reserveMass(['500|500', '501|501'], true);

    expect(outcomes).toEqual([
      { coord: '500|500', ok: true, detail: 'Pedido enviado.' },
      { coord: '501|501', ok: true, detail: 'Pedido enviado.' },
    ]);
    // POST com o CSRF e a aldeia extraídos da página real
    expect(posts).toHaveLength(2);
    const postUrl = String(electronMockState.fetch.mock.calls.find(([url]) => String(url).includes('action=new_reservation'))?.[0]);
    expect(postUrl).toContain('https://br142.tribalwars.com.br/game.php?screen=ally&mode=reservations');
    expect(postUrl).toContain('village=79788');
    expect(postUrl).toContain('h=e817d0df');
    const params = new URLSearchParams(posts[0] ?? '');
    expect(params.get('target_type')).toBe('coord');
    expect(params.get('x[]')).toBe('500');
    expect(params.get('y[]')).toBe('500');
    expect(params.get('save_reservations')).toBe('Reservar esta aldeia');
    // journal obrigatório de cada envio
    const reserveEntries = journal.list(20).filter((entry) => entry.action === 'reserve');
    expect(reserveEntries.map((entry) => entry.detail)).toEqual([
      'reserva 501|501 → Pedido enviado.',
      'reserva 500|500 → Pedido enviado.',
    ]);
    // single-flight liberado no fim
    expect(queue.isRunning).toBe(false);
  }, 10_000);

  it('"já reservada" por outro membro é tolerada (não é erro)', async () => {
    const routes: FetchRoute[] = [
      {
        match: 'action=new_reservation',
        handler: () => html('<html><body><p>Aldeia já reservada por outro jogador.</p></body></html>'),
      },
      { match: 'screen=ally&mode=reservations', handler: () => html(fixture('ally-reservations.html')) },
    ];
    const { service } = await buildHarness({ routes });

    const outcomes = await service.reserveMass(['500|500'], true);

    expect(outcomes).toEqual([{ coord: '500|500', ok: true, detail: 'Já reservada por outro membro — tolerado.' }]);
  });

  it('recusa do jogo (aldeia inexistente) vira outcome com erro legível', async () => {
    const routes: FetchRoute[] = [
      { match: 'action=new_reservation', handler: () => html('<html><body><span>não existe tal aldeia</span></body></html>') },
      { match: 'screen=ally&mode=reservations', handler: () => html(fixture('ally-reservations.html')) },
    ];
    const { service } = await buildHarness({ routes });

    const outcomes = await service.reserveMass(['999|999'], true);

    expect(outcomes).toEqual([{ coord: '999|999', ok: false, detail: 'Recusado pelo jogo (aldeia inexistente ou erro).' }]);
  });

  it('falha de POST (HTTP 500) vira outcome com erro legível, sem lançar', async () => {
    const routes: FetchRoute[] = [
      { match: 'action=new_reservation', handler: () => ({ ok: false, status: 500, body: '' }) },
      { match: 'screen=ally&mode=reservations', handler: () => html(fixture('ally-reservations.html')) },
    ];
    const { service } = await buildHarness({ routes });

    const outcomes = await service.reserveMass(['500|500'], true);

    expect(outcomes).toEqual([{ coord: '500|500', ok: false, detail: 'HTTP 500' }]);
  });

  it('falha de rede vira "Falha de rede: …" e NÃO interrompe a cadeia', async () => {
    const routes: FetchRoute[] = [
      { match: 'action=new_reservation', handler: () => { throw new Error('socket hang up'); } },
      { match: 'screen=ally&mode=reservations', handler: () => html(fixture('ally-reservations.html')) },
    ];
    const { service } = await buildHarness({ routes });

    const outcomes = await service.reserveMass(['500|500', '501|501'], true);

    expect(outcomes.map((outcome) => [outcome.coord, outcome.ok, outcome.detail])).toEqual([
      ['500|500', false, 'Falha de rede: socket hang up'],
      ['501|501', false, 'Falha de rede: socket hang up'],
    ]);
  }, 10_000);

  it('sessão expirada no meio da cadeia interrompe (break) e journala reserve-halt', async () => {
    let postCount = 0;
    const routes: FetchRoute[] = [
      {
        match: 'action=new_reservation',
        handler: () => {
          postCount += 1;
          return postCount === 1
            ? html(POST_OK)
            : html('<html><form id="login"><input name="password"></form></html>'); // sentinela session-expired
        },
      },
      { match: 'screen=ally&mode=reservations', handler: () => html(fixture('ally-reservations.html')) },
    ];
    const { service, journal } = await buildHarness({ routes });

    const outcomes = await service.reserveMass(['500|500', '501|501', '502|502'], true);

    // 1 sucesso + sentinela; a 3ª coordenada NEM chega a receber POST
    expect(outcomes).toHaveLength(2);
    expect(outcomes[1]).toMatchObject({ coord: '501|501', ok: false, detail: 'SESSÃO EXPIRADA — operação interrompida. Faça login e recomece.' });
    expect(postCount).toBe(2);
    const halt = journal.list(20).find((entry) => entry.action === 'reserve-halt');
    expect(halt?.detail).toBe('Reserva interrompida na coordenada 501|501 (session-expired)');
  }, 10_000);

  it('confirmação false rejeita antes de qualquer fetch ao jogo', async () => {
    const { service } = await buildHarness({
      routes: [{ match: 'screen=ally&mode=reservations', handler: () => html(fixture('ally-reservations.html')) }],
    });

    await expect(service.reserveMass(['500|500'], false)).rejects.toThrow('Confirmação dupla necessária');
    expect(fetchCallCount('mode=reservations')).toBe(0);
  });

  it('coordenada inválida aborta antes de qualquer envio', async () => {
    const { service } = await buildHarness({
      routes: [{ match: 'screen=ally&mode=reservations', handler: () => html(fixture('ally-reservations.html')) }],
    });

    await expect(service.reserveMass(['alfa|beta'], true)).rejects.toThrow('Coordenada inválida na reserva em massa: "alfa|beta"');
    expect(fetchCallCount('mode=reservations')).toBe(0);
  });

  it('lote acima do teto das settings é rejeitado sem nenhum fetch', async () => {
    const { service } = await buildHarness({
      settings: { requestCeiling: 1 },
      routes: [{ match: 'screen=ally&mode=reservations', handler: () => html(fixture('ally-reservations.html')) }],
    });

    await expect(service.reserveMass(['500|500', '501|501'], true)).rejects.toThrow('maior que o teto das settings (1)');
    expect(fetchCallCount('mode=reservations')).toBe(0);
  });

  it('fila ocupada (coleta em andamento) rejeita a mutação — single-flight C4', async () => {
    const { service, queue } = await buildHarness({
      routes: [{ match: 'screen=ally&mode=reservations', handler: () => html(fixture('ally-reservations.html')) }],
    });
    queue.beginOperation();
    try {
      await expect(service.reserveMass(['500|500'], true)).rejects.toThrow('Uma operação está em andamento');
      expect(fetchCallCount('mode=reservations')).toBe(0);
    } finally {
      queue.endOperation();
    }
  });

  it('sem sessão ativa no jogo, aborta antes de qualquer fetch às reservas', async () => {
    const { service } = await buildHarness({
      login: false,
      routes: [{ match: 'screen=ally&mode=reservations', handler: () => html(fixture('ally-reservations.html')) }],
    });

    await expect(service.reserveMass(['500|500'], true)).rejects.toThrow('Nenhuma sessão ativa no jogo');
    expect(fetchCallCount('mode=reservations')).toBe(0);
  });
});

describe('Sg6Service.sendMps (MPs personalizadas)', () => {
  const MP_ENTRY: MpEntry = { playerName: 'Reboucas', coords: ['500|500', '501|501'], horarios: ['10:00:00', '11:00:00'] };

  function mpRoutes(postHandler: (init: { body?: string; method?: string }, call: number) => ReturnType<typeof html>): FetchRoute[] {
    let call = 0;
    return [
      { match: 'action=send', handler: (init) => { call += 1; return postHandler(init, call); } },
      // formulário REAL de nova MP do BR142 (tokens csrf/village)
      { match: 'screen=mail&mode=new', handler: () => html(fixture('mail-new.html')) },
    ];
  }

  it('MP enviada por destinatário: #alvos# e #horarios# substituídos por jogador no POST', async () => {
    const bodies: string[] = [];
    const { service, journal } = await buildHarness({
      routes: mpRoutes((init) => {
        bodies.push(init.body ?? '');
        return html('<html><body><div class="success">Mensagem enviada</div></body></html>');
      }),
    });

    const outcomes = await service.sendMps(
      'OP Barreira',
      'Ataque em #alvos#\nHorários:\n#horarios#',
      [MP_ENTRY, { playerName: 'Spartacus', coords: ['502|502'], horarios: ['12:00:00'] }],
      true,
    );

    expect(outcomes).toEqual([
      { playerName: 'Reboucas', ok: true, detail: 'MP enviada.' },
      { playerName: 'Spartacus', ok: true, detail: 'MP enviada.' },
    ]);
    expect(bodies).toHaveLength(2);
    const first = new URLSearchParams(bodies[0] ?? '');
    expect(first.get('to')).toBe('Reboucas');
    expect(first.get('subject')).toBe('OP Barreira');
    expect(first.get('send')).toBe('Enviar');
    expect(first.get('text')).toBe('Ataque em 500|500 501|501\nHorários:\n500|500 → 10:00:00\n501|501 → 11:00:00');
    // sem #horarios# no template, a MP do segundo jogador leva só os alvos
    const second = new URLSearchParams(bodies[1] ?? '');
    expect(second.get('to')).toBe('Spartacus');
    expect(second.get('text')).toBe('Ataque em 502|502\nHorários:\n502|502 → 12:00:00');
    const mpEntries = journal.list(20).filter((entry) => entry.action === 'mp-send');
    expect(mpEntries.map((entry) => entry.detail)).toEqual([
      'MP Spartacus (1 alvos) → MP enviada.',
      'MP Reboucas (2 alvos) → MP enviada.',
    ]);
  }, 10_000);

  it('nick não encontrado é detectado NA RESPOSTA do jogo (validação de destinatário)', async () => {
    const { service } = await buildHarness({
      routes: mpRoutes(() => html('<html><body><p>O jogador "Fantasma" não existe.</p></body></html>')),
    });

    const outcomes = await service.sendMps('OP', 'Ataque em #alvos#', [{ playerName: 'Fantasma', coords: ['500|500'] }], true);

    expect(outcomes).toEqual([{ playerName: 'Fantasma', ok: false, detail: 'Nick não encontrado — confira o nome exato no jogo.' }]);
  });

  it('sessão expirada interrompe a cadeia de MPs com journal mp-halt', async () => {
    const { service, journal } = await buildHarness({
      routes: mpRoutes((_init, call) =>
        call === 1
          ? html('<html><body><div class="success">Mensagem enviada</div></body></html>')
          : html('<html><form id="login"><input name="password"></form></html>'),
      ),
    });

    const outcomes = await service.sendMps('OP', 'Ataque em #alvos#', [
      { playerName: 'Reboucas', coords: ['500|500'] },
      { playerName: 'Spartacus', coords: ['501|501'] },
    ], true);

    expect(outcomes).toHaveLength(2);
    expect(outcomes[1]).toMatchObject({ playerName: 'Spartacus', ok: false, detail: 'SESSÃO EXPIRADA — operação interrompida. Faça login e recomece.' });
    const halt = journal.list(20).find((entry) => entry.action === 'mp-halt');
    expect(halt?.detail).toBe('MP interrompida em Spartacus (session-expired)');
  }, 10_000);

  it('corpo com #horarios# e entrada sem horários é rejeitado fail-closed antes de qualquer POST', async () => {
    const { service } = await buildHarness({ routes: mpRoutes(() => html('<ok/>')) });

    await expect(
      service.sendMps('OP', 'Horários:\n#horarios#', [{ playerName: 'Reboucas', coords: ['500|500'] }], true),
    ).rejects.toThrow('a entrada de "Reboucas" não trouxe horários');
    expect(fetchCallCount('screen=mail')).toBe(0);
  });

  it('horários dessincronizados com os alvos são rejeitados antes de qualquer POST', async () => {
    const { service } = await buildHarness({ routes: mpRoutes(() => html('<ok/>')) });

    await expect(
      service.sendMps('OP', 'Ataque em #alvos# às #horarios#', [{ playerName: 'Reboucas', coords: ['500|500', '501|501'], horarios: ['10:00:00'] }], true),
    ).rejects.toThrow('dessincronizados: 1 horário(s) × 2 alvo(s)');
    expect(fetchCallCount('screen=mail')).toBe(0);
  });

  it('assunto vazio e corpo sem placeholder são rejeitados antes de qualquer POST', async () => {
    const { service } = await buildHarness({ routes: mpRoutes(() => html('<ok/>')) });

    await expect(service.sendMps('   ', 'Ataque em #alvos#', [{ playerName: 'X', coords: ['500|500'] }], true)).rejects.toThrow('Assunto vazio');
    await expect(service.sendMps('OP', 'corpo genérico', [{ playerName: 'X', coords: ['500|500'] }], true)).rejects.toThrow('#alvos# e/ou #horarios#');
    expect(fetchCallCount('screen=mail')).toBe(0);
  });

  it('confirmação false rejeita antes de qualquer fetch ao correio', async () => {
    const { service } = await buildHarness({ routes: mpRoutes(() => html('<ok/>')) });

    await expect(service.sendMps('OP', 'Ataque em #alvos#', [{ playerName: 'X', coords: ['500|500'] }], false)).rejects.toThrow('Confirmação dupla necessária');
    expect(fetchCallCount('screen=mail')).toBe(0);
  });

  it('envio maior que o teto das settings é rejeitado sem POST', async () => {
    const { service } = await buildHarness({
      settings: { requestCeiling: 1 },
      routes: mpRoutes(() => html('<ok/>')),
    });

    await expect(
      service.sendMps('OP', 'Ataque em #alvos#', [
        { playerName: 'Reboucas', coords: ['500|500'] },
        { playerName: 'Spartacus', coords: ['501|501'] },
      ], true),
    ).rejects.toThrow('maior que o teto das settings (1)');
    expect(fetchCallCount('screen=mail')).toBe(0);
  });
});

describe('Sg6Service.chargeBatch (cobrança em lote — Sala de Guerra)', () => {
  const POST_SENT = '<html><body><div class="success">Mensagem enviada</div></body></html>';

  function chargeEntry(nick: string, body = 'Faltam 2 ataque(s) em 500|500 501|501'): { nick: string; subject: string; body: string } {
    return { nick, subject: '🔔 OP — faltam seus ataques', body };
  }

  function chargeRoutes(postHandler: (init: { body?: string; method?: string }, call: number) => ReturnType<typeof html>): FetchRoute[] {
    let call = 0;
    return [
      { match: 'action=send', handler: (init) => { call += 1; return postHandler(init, call); } },
      // mesmo formulário de nova MP do sendMps (tokens csrf/village)
      { match: 'screen=mail&mode=new', handler: () => html(fixture('mail-new.html')) },
    ];
  }

  it('lote aceito: UM diálogo nativo agregado, 2 MPs enviadas e journal com a linha do lote', async () => {
    const bodies: string[] = [];
    const { service, journal, queue } = await buildHarness({
      routes: chargeRoutes((init) => {
        bodies.push(init.body ?? '');
        return html(POST_SENT);
      }),
    });

    const { results } = await service.chargeBatch([chargeEntry('Reboucas'), chargeEntry('Spartacus', 'Falta 1 ataque(s) em 502|502')]);

    expect(results).toEqual([
      { nick: 'Reboucas', ok: true, detail: 'MP enviada.', cancelled: false },
      { nick: 'Spartacus', ok: true, detail: 'MP enviada.', cancelled: false },
    ]);
    expect(bodies).toHaveLength(2);
    expect(new URLSearchParams(bodies[0] ?? '').get('to')).toBe('Reboucas');
    expect(new URLSearchParams(bodies[1] ?? '').get('to')).toBe('Spartacus');
    // UM diálogo para o lote inteiro, com contagem + nicks agregados
    expect(showMessageBoxMock()).toHaveBeenCalledTimes(1);
    const options = showMessageBoxMock().mock.calls[0]?.[0] as { message: string; detail: string; buttons?: string[] };
    expect(options.message).toBe('Confirmar o envio de 2 MP(s) de cobrança? (uma por jogador — o envio é real)');
    expect(options.detail).toContain('Reboucas, Spartacus');
    // cancelar é o default (defesa em profundidade, C9)
    expect(options.buttons?.[0]).toBe('Cancelar');
    // journal do lote (todos ok → nenhuma falha por item)
    const batch = journal.list(20).find((entry) => entry.action === 'charge-batch');
    expect(batch?.detail).toBe('cobrança em lote: 2 MPs — 2 enviadas, 0 falhas');
    // single-flight liberado no fim
    expect(queue.isRunning).toBe(false);
  }, 10_000);

  it('diálogo cancelado: zero POSTs, resultado "Cancelado pelo usuário" por jogador e nada no journal', async () => {
    showMessageBoxMock().mockResolvedValue({ response: 0, checkboxChecked: false });
    const { service, journal, queue } = await buildHarness({
      routes: chargeRoutes(() => html(POST_SENT)),
    });

    const { results } = await service.chargeBatch([chargeEntry('Reboucas'), chargeEntry('Spartacus')]);

    expect(results).toEqual([
      { nick: 'Reboucas', ok: false, detail: 'Cancelado pelo usuário', cancelled: true },
      { nick: 'Spartacus', ok: false, detail: 'Cancelado pelo usuário', cancelled: true },
    ]);
    expect(fetchCallCount('action=send')).toBe(0);
    expect(journal.list(20).some((entry) => entry.action.startsWith('charge-'))).toBe(false);
    expect(queue.isRunning).toBe(false);
  });

  it('falha isolada por item: 2º nick não encontrado → 1º segue ok, lote NÃO aborta e a falha é journalada', async () => {
    const { service, journal } = await buildHarness({
      routes: chargeRoutes((_init, call) =>
        call === 1
          ? html(POST_SENT)
          : html('<html><body><p>O jogador "Fantasma" não existe.</p></body></html>'),
      ),
    });

    const { results } = await service.chargeBatch([chargeEntry('Reboucas'), chargeEntry('Fantasma')]);

    expect(results).toEqual([
      { nick: 'Reboucas', ok: true, detail: 'MP enviada.', cancelled: false },
      { nick: 'Fantasma', ok: false, detail: 'Nick não encontrado — confira o nome exato no jogo.', cancelled: false },
    ]);
    expect(fetchCallCount('action=send')).toBe(2);
    const batch = journal.list(20).find((entry) => entry.action === 'charge-batch');
    expect(batch?.detail).toBe('cobrança em lote: 2 MPs — 1 enviadas, 1 falhas');
    const failure = journal.list(20).find((entry) => entry.action === 'charge-fail');
    expect(failure?.detail).toBe('Cobrança Fantasma → Nick não encontrado — confira o nome exato no jogo.');
  }, 10_000);

  it('sentinela no MEIO do lote: interrompe, journala charge-halt e a linha do lote confessa as não tentadas', async () => {
    const { service, journal, queue } = await buildHarness({
      routes: chargeRoutes((_init, call) =>
        call === 1
          ? html(POST_SENT)
          : html('<html><form id="login"><input name="password"></form></html>'),
      ),
    });

    const { results } = await service.chargeBatch([
      chargeEntry('Reboucas'),
      chargeEntry('Spartacus'),
      chargeEntry('Fantasma'),
    ]);

    // 1ª MP ok; a 2ª bateu numa página de login → sentinela INTERROMPE; a 3ª
    // NEM chega a tentar e NÃO vira linha em results (comportamento atual —
    // só quem recebeu tentativa aparece).
    expect(results).toEqual([
      { nick: 'Reboucas', ok: true, detail: 'MP enviada.', cancelled: false },
      { nick: 'Spartacus', ok: false, detail: 'SESSÃO EXPIRADA — operação interrompida. Faça login e recomece.', cancelled: false },
    ]);
    expect(fetchCallCount('action=send')).toBe(2);
    const halt = journal.list(20).find((entry) => entry.action === 'charge-halt');
    expect(halt?.detail).toBe('Cobrança interrompida em Spartacus (session-expired)');
    // Contabilidade honesta: 3 MPs no lote, 1 enviada, 1 falha (o halt) e
    // 1 NÃO TENTADA (Fantasma) confessada na linha do lote.
    const batch = journal.list(20).find((entry) => entry.action === 'charge-batch');
    expect(batch?.detail).toBe('cobrança em lote: 3 MPs — 1 enviadas, 1 falhas, 1 não tentadas (sessão interrompida)');
    expect(queue.isRunning).toBe(false);
  }, 10_000);

  it('fila ocupada (coleta em andamento) rejeita ANTES do diálogo nativo e de qualquer POST', async () => {
    const { service, queue } = await buildHarness({
      routes: chargeRoutes(() => html(POST_SENT)),
    });
    queue.beginOperation();
    try {
      await expect(service.chargeBatch([chargeEntry('Reboucas')])).rejects.toThrow('Uma operação está em andamento');
      expect(showMessageBoxMock()).not.toHaveBeenCalled();
      expect(fetchCallCount('screen=mail')).toBe(0);
    } finally {
      queue.endOperation();
    }
  });

  it('sem sessão ativa no jogo, aborta ANTES do diálogo nativo e de qualquer POST', async () => {
    const { service } = await buildHarness({
      login: false,
      routes: chargeRoutes(() => html(POST_SENT)),
    });

    await expect(service.chargeBatch([chargeEntry('Reboucas')])).rejects.toThrow('Nenhuma sessão ativa no jogo');
    expect(showMessageBoxMock()).not.toHaveBeenCalled();
    expect(fetchCallCount('screen=mail')).toBe(0);
  });

  it('lote acima do teto das settings é rejeitado antes do diálogo e sem POST', async () => {
    const { service } = await buildHarness({
      settings: { requestCeiling: 1 },
      routes: chargeRoutes(() => html(POST_SENT)),
    });

    await expect(service.chargeBatch([chargeEntry('Reboucas'), chargeEntry('Spartacus')])).rejects.toThrow('maior que o teto das settings (1)');
    expect(showMessageBoxMock()).not.toHaveBeenCalled();
    expect(fetchCallCount('screen=mail')).toBe(0);
  });
});
