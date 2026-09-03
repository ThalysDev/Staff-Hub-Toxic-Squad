/**
 * Testes da PAGINAÇÃO na coleta de tropas/defesa (TroopsService).
 *
 * O pager do jogo (links paged-nav-item) pagina membros com muitas aldeias
 * (ex.: líder com 1156 aldeias = página 1 com 1000 + página 2 com 156) e a
 * visão da própria conta (screen=overview_villages&mode=units&group=0).
 *
 * Estratégia: a mesma de sg6-service.test.ts — 'electron' mockado (helper
 * electron-mock.ts), TwSessionManager/Journal/JsonStore/RequestQueue REAIS e
 * só o fio de rede (session.fetch) fake. Os corpos das páginas são HTML
 * INLINE mínimo no formato que os parsers exigem (tabela "vis w100" com <th>
 * de unit_*.webp / units_table com quickedit-vn). O caso REAL do canário do
 * dono (pager ANTES da tabela — fixtures troops-own-paged-p1/p2-rows.html,
 * capturadas da conta com 1156 aldeias) é coberto no describe final.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { createElectronMock } = await import('./electron-mock');
  return createElectronMock();
});

import {
  disposeElectronMock,
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
import { TroopsService } from '../../src/main/services/troops-service';

const WORLD = 'br142';
const SID = `0:${'1f'.repeat(32)}`;

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/br142/${name}`, import.meta.url)), 'utf-8');
}

/** Corpo inválido (sem tabela): parser lança ParseError = falha da página. */
const GARBAGE_BODY = '<html><body><p>erro inesperado do jogo</p></body></html>';

interface Harness {
  service: TroopsService;
  journal: Journal;
  twSession: TwSessionManager;
}

async function buildHarness(routes: FetchRoute[], options: { skipLogin?: boolean } = {}): Promise<Harness> {
  const journal = new Journal();
  const settingsStore = new JsonStore<AppSettings>('settings', DEFAULT_SETTINGS);
  await settingsStore.save({ ...DEFAULT_SETTINGS, requestMinIntervalMs: 0, requestJitterMs: 0, requestCeiling: 400 });
  const twSession = new TwSessionManager();
  const queue = new RequestQueue((url) => twSession.fetchForQueue(url), vi.fn(), { minIntervalMs: 0, jitterMs: 0, ceiling: 400 });
  routeElectronFetch([
    ...routes,
    // sonda do login (loginWithSid) — tem que vir POR ÚLTIMO: "screen=overview"
    // também casa com "screen=overview_villages" das rotas específicas acima.
    { match: 'screen=overview', handler: () => html(fixture('overview.html')) },
  ]);
  // skipLogin: simula "sem sessão do jogo" (os testes de fail-open do cache
  // local precisam do serviço nunca logado, com dado só no disco).
  if (options.skipLogin !== true) {
    const login = await twSession.loginWithSid(WORLD, SID);
    expect(login.ok).toBe(true);
  }
  return { service: new TroopsService(twSession, queue, journal, settingsStore), journal, twSession };
}

beforeEach(() => {
  resetElectronMock();
});

afterAll(() => {
  disposeElectronMock();
});

// ---------------------------------------------------------------------------
// Construtores de HTML inline no formato dos parsers
// ---------------------------------------------------------------------------

const UNITS = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob', 'militia'] as const;

const MEMBER_UNITS_HEADER = UNITS.map(
  (unit) => `<th><img src="https://dsbr.innogamescdn.com/asset/db281c7a/graphic/unit/unit_${unit}.webp" alt="" class="tooltip" title="" /></th>`,
).join('');

interface InlineVillage {
  id: number;
  name: string;
}

/** Página de membro (members_troops&player_id=N): 1 linha por aldeia + pager. */
function memberTroopsPage(villages: InlineVillage[], pagerHtml: string): string {
  const rows = villages
    .map(
      (village, index) =>
        `<tr><td><a href="/game.php?village=238755&amp;screen=info_village&amp;id=${village.id}" >${village.name} (534|55${index % 10}) K55</a></td>` +
        `<td>10.532</td>${UNITS.map((_, i) => `<td>${index * 10 + i}</td>`).join('')}</tr>`,
    )
    .join('');
  return `<html><body><table class="vis w100"><tr><th class="column-name">Aldeia</th><th>Pontos</th>${MEMBER_UNITS_HEADER}</tr>${rows}</table>${pagerHtml}</body></html>`;
}

/** Link do pager no formato real do jogo (&amp; no href, class com aspas simples). */
function memberPagerLink(page: number): string {
  return `<a class='paged-nav-item' rel="next" href="/game.php?village=238755&amp;screen=ally&amp;mode=members_troops&amp;player_id=111&amp;page=${page}"> [${page}] </a>`;
}

function memberPagerTable(links: string): string {
  return `<table class="vis w100"><tr><td class="center">${links}</td></tr></table>`;
}

function selectorBody(playerId: number, name: string): string {
  return (
    `<html><body><select name="player_id" onchange="this.form.submit()" class="input-nicer">` +
    `<option hidden>Selecionar membro</option><option value="${playerId}" selected>${name}</option>` +
    `</select></body></html>`
  );
}

/**
 * Página da própria conta (units_table): header com unit_*.webp e, por aldeia,
 * linha quickedit-vn + sub-linhas "suas próprias"/"Na Aldeia"/"fora"/"em
 * trânsito"/"total" — mesmo shape de tests/fixtures/br142/own-units.html.
 */
function ownUnitsPage(villages: InlineVillage[], pagerHtml: string): string {
  const unitsRow = (label: string, values: readonly number[]): string =>
    `<td>${label}</td>${values.map((n) => `<td class='unit-item'>${n}</td>`).join('')}`;
  const rows = villages
    .map((village, index) => {
      const base = (i: number) => index * 100 + i;
      return (
        `<tr><td rowspan="5" valign="top">` +
        `<span class="quickedit-vn" data-id="${village.id}" data-length="32"><span class="quickedit-content">` +
        `<a href="/game.php?village=${village.id}&amp;screen=overview">` +
        `<span class="quickedit-label" data-text="${village.name}">${village.name} (54${index}|45${index}) K55</span>` +
        `</a></span></span></td>` +
        `${unitsRow('suas próprias', UNITS.map((_, i) => base(i) + 1))}</tr>` +
        `<tr>${unitsRow('Na Aldeia', UNITS.map((_, i) => base(i) + 2))}</tr>` +
        `<tr>${unitsRow('fora', UNITS.map(() => 0))}</tr>` +
        `<tr>${unitsRow('em trânsito', UNITS.map((_, i) => base(i) + 3))}</tr>` +
        `<tr style="font-weight: bold">${unitsRow('total', UNITS.map((_, i) => base(i) + 4))}</tr>`
      );
    })
    .join('');
  const header =
    `<tr><th>Aldeia (${villages.length})</th><th></th>` +
    UNITS.map((unit) => `<th width="35"><img src="https://dsbr.innogamescdn.com/asset/db281c7a/graphic/unit/unit_${unit}.webp" title="" alt="" /></th>`).join('') +
    `<th>Ação</th></tr>`;
  return `<html><body><table id="units_table" class="vis overview_table">${header}${rows}</table>${pagerHtml}</body></html>`;
}

function ownUnitsPagerLink(page: number): string {
  return `<a class='paged-nav-item' href="/game.php?village=238755&amp;screen=overview_villages&amp;mode=units&amp;group=0&amp;page=${page}"> [${page}] </a>`;
}

const P1_VILLAGES: InlineVillage[] = [1, 2, 3, 4, 5].map((id) => ({ id, name: `00${id} - Nobre, Toxic Squad!` }));
const P2_VILLAGES: InlineVillage[] = [6, 7, 8, 9].map((id) => ({ id, name: `00${id} - Nobre, Toxic Squad!` }));

// ---------------------------------------------------------------------------
// Paginação por membro (members_troops/members_defense)
// ---------------------------------------------------------------------------

describe('TroopsService — paginação por membro', () => {
  it('membro com 2 páginas: concatena as aldeias das duas páginas sem falhas', { timeout: 20_000 }, async () => {
    const { service, journal } = await buildHarness([
      { match: 'player_id=111&page=2', handler: () => html(memberTroopsPage(P2_VILLAGES, memberPagerTable(''))) },
      { match: 'player_id=111', handler: () => html(memberTroopsPage(P1_VILLAGES, memberPagerTable(`<strong> &gt;1&lt; </strong>${memberPagerLink(2)}`))) },
      { match: 'mode=members_troops', handler: () => html(selectorBody(111, 'Líder Pager')) },
    ]);

    const snapshot = await service.collectAllMembers('troops');

    expect(snapshot.source).toBe('per-member');
    expect(snapshot.entries).toHaveLength(9); // 5 da página 1 + 4 da página 2
    expect(new Set(snapshot.entries.map((entry) => entry.villageId)).size).toBe(9);
    expect(snapshot.entries.every((entry) => entry.playerId === 111)).toBe(true);
    expect(snapshot.failures).toBeUndefined();
    // página 2 buscada exatamente 1 vez (label com o nº da página no progresso)
    expect(fetchCallCount('player_id=111&page=2')).toBe(1);
    const journalLine = journal.list(20).find((entry) => entry.action === 'collect-members');
    expect(journalLine?.detail).toContain('Líder Pager: 2 páginas');
  });

  it('pager da página 2 só tem o link "prev": nenhuma requisição extra (sem loop)', { timeout: 20_000 }, async () => {
    const { service } = await buildHarness([
      // página 2 real do BR142: pager com rel="prev" apontando page=1 (fixture troops-own-paged-p2-rows.html)
      { match: 'player_id=111&page=2', handler: () => html(memberTroopsPage(P2_VILLAGES, memberPagerTable(`<a class='paged-nav-item' rel="prev" href="/game.php?village=238755&amp;screen=ally&amp;mode=members_troops&amp;player_id=111&amp;page=1"> [1] </a><strong> &gt;2&lt; </strong>`))) },
      { match: 'player_id=111', handler: () => html(memberTroopsPage(P1_VILLAGES, memberPagerTable(`<strong> &gt;1&lt; </strong>${memberPagerLink(2)}`))) },
      { match: 'mode=members_troops', handler: () => html(selectorBody(111, 'Líder Pager')) },
    ]);

    const snapshot = await service.collectAllMembers('troops');

    expect(snapshot.entries).toHaveLength(9);
    expect(snapshot.failures).toBeUndefined();
    // exatamente 2 fetches do membro: 1ª página EXPLÍCITA (page=1) + página 2;
    // o link "prev" (page=1) NÃO gera um refetch e não há page=3.
    expect(fetchCallCount('player_id=111')).toBe(2);
    expect(fetchCallCount('player_id=111&page=1')).toBe(1);
    expect(fetchCallCount('page=3')).toBe(0);
  });

  it('página 2 com corpo inválido: mantém as 5 aldeias da página 1 e registra falha citando a página', { timeout: 20_000 }, async () => {
    const { service, journal } = await buildHarness([
      { match: 'player_id=111&page=2', handler: () => html(GARBAGE_BODY) },
      { match: 'player_id=111', handler: () => html(memberTroopsPage(P1_VILLAGES, memberPagerTable(`<strong> &gt;1&lt; </strong>${memberPagerLink(2)}`))) },
      { match: 'mode=members_troops', handler: () => html(selectorBody(111, 'Líder Pager')) },
    ]);

    const snapshot = await service.collectAllMembers('troops');

    expect(snapshot.entries).toHaveLength(5);
    expect(new Set(snapshot.entries.map((entry) => entry.villageId))).toEqual(new Set(P1_VILLAGES.map((v) => v.id)));
    expect(snapshot.failures).toHaveLength(1);
    expect(snapshot.failures?.[0]?.playerName).toBe('Líder Pager');
    expect(snapshot.failures?.[0]?.reason).toMatch(/Página 2/);
    const journalLine = journal.list(20).find((entry) => entry.action === 'collect-members');
    expect(journalLine?.detail).toContain('1 membro(s) com erro');
  });

  it('página 2 repetindo as aldeias da página 1: dedupe mantém 5 entradas', { timeout: 20_000 }, async () => {
    const { service, journal } = await buildHarness([
      // jogo ignorando o page param: devolve as MESMAS aldeias da página 1
      { match: 'player_id=111&page=2', handler: () => html(memberTroopsPage(P1_VILLAGES, '')) },
      { match: 'player_id=111', handler: () => html(memberTroopsPage(P1_VILLAGES, memberPagerTable(`<strong> &gt;1&lt; </strong>${memberPagerLink(2)}`))) },
      { match: 'mode=members_troops', handler: () => html(selectorBody(111, 'Líder Pager')) },
    ]);

    const snapshot = await service.collectAllMembers('troops');

    expect(snapshot.entries).toHaveLength(5);
    expect(new Set(snapshot.entries.map((entry) => entry.villageId)).size).toBe(5);
    expect(snapshot.failures).toBeUndefined();
    const journalLine = journal.list(20).find((entry) => entry.action === 'collect-members');
    expect(journalLine?.detail).toContain('Líder Pager: 2 páginas');
  });
});

// ---------------------------------------------------------------------------
// Fallback da própria conta (overview_villages&mode=units&group=0, paginado)
// ---------------------------------------------------------------------------

describe('TroopsService — própria conta (overview_villages&mode=units)', () => {
  it('usa group=0 e concatena as aldeias das 2 páginas', { timeout: 20_000 }, async () => {
    const { service, journal } = await buildHarness([
      { match: 'group=0&page=2', handler: () => html(ownUnitsPage([{ id: 30, name: '851 - Nobre' }, { id: 31, name: '852 - Nobre' }, { id: 32, name: '853 - Nobre' }], '')) },
      { match: 'group=0', handler: () => html(ownUnitsPage([{ id: 10, name: '848 - Nobre' }, { id: 11, name: '849 - Nobre' }], ownUnitsPagerLink(2))) },
      { match: 'player_id=999', handler: () => html('<html><body><p>Resumo por jogador (sem tabela de unidades)</p></body></html>') },
      { match: 'mode=members_troops', handler: () => html(selectorBody(999, 'Dono da Conta')) },
    ]);

    const snapshot = await service.collectAllMembers('troops');

    expect(snapshot.entries).toHaveLength(5); // 2 da página 1 + 3 da página 2
    expect(new Set(snapshot.entries.map((entry) => entry.villageId)).size).toBe(5);
    expect(snapshot.entries.every((entry) => entry.playerId === 999)).toBe(true);
    expect(snapshot.failures).toBeUndefined();
    // TODAS as leituras da própria conta vão com group=0 (todos os grupos)
    expect(fetchCallCount('screen=overview_villages&mode=units&group=0')).toBe(2);
    expect(fetchCallCount('group=0&page=2')).toBe(1);
    const journalLine = journal.list(20).find((entry) => entry.action === 'collect-members');
    expect(journalLine?.detail).toContain('Dono da Conta: 2 páginas');
  });

  it('página 2 da própria conta falha: mantém as aldeias da página 1 e registra falha citando a página', { timeout: 20_000 }, async () => {
    const { service, journal } = await buildHarness([
      { match: 'group=0&page=2', handler: () => html(GARBAGE_BODY) },
      { match: 'group=0', handler: () => html(ownUnitsPage([{ id: 10, name: '848 - Nobre' }, { id: 11, name: '849 - Nobre' }], ownUnitsPagerLink(2))) },
      { match: 'player_id=999', handler: () => html('<html><body><p>Resumo por jogador</p></body></html>') },
      { match: 'mode=members_troops', handler: () => html(selectorBody(999, 'Dono da Conta')) },
    ]);

    const snapshot = await service.collectAllMembers('troops');

    expect(snapshot.entries).toHaveLength(2);
    expect(new Set(snapshot.entries.map((entry) => entry.villageId))).toEqual(new Set([10, 11]));
    expect(snapshot.failures).toHaveLength(1);
    expect(snapshot.failures?.[0]?.playerName).toBe('Dono da Conta');
    expect(snapshot.failures?.[0]?.reason).toMatch(/Página 2/);
    const journalLine = journal.list(20).find((entry) => entry.action === 'collect-members');
    expect(journalLine?.detail).toContain('1 membro(s) com erro');
  });

  it('cache por run: duas coletas seguidas leem a visão da conta 1x por coleta', { timeout: 20_000 }, async () => {
    const { service } = await buildHarness([
      { match: 'group=0', handler: () => html(ownUnitsPage([{ id: 10, name: '848 - Nobre' }], '')) },
      { match: 'player_id=999', handler: () => html('<html><body>resumo</body></html>') },
      { match: 'mode=members_troops', handler: () => html(selectorBody(999, 'Dono da Conta')) },
    ]);

    const first = await service.collectAllMembers('troops');
    const second = await service.collectAllMembers('troops');

    expect(first.entries).toHaveLength(1);
    expect(second.entries).toHaveLength(1);
    // cache é POR RUN de collectAllMembers: 1 leitura em cada coleta (sem
    // cache obsoleto entre runs, sem leitura duplicada dentro da run).
    expect(fetchCallCount('screen=overview_villages&mode=units&group=0')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// CANÁRIO REAL do dono (02/09): fixtures capturadas da conta dele (1156
// aldeias). A página 1 vem com o PAGER "vis w100" ANTES da tabela de dados —
// exatamente o HTML que produzia "cabeçalho (<th>) não encontrado" e deixava a
// própria conta de fora da coleta. Este teste prova o caso ponta a ponta com o
// HTML real, do dropdown às 2 páginas.
// ---------------------------------------------------------------------------

describe('TroopsService — canário real (pager ANTES da tabela, 2 páginas)', () => {
  it('coleta a própria conta gigante pelas 2 páginas do jogo sem falhas', { timeout: 20_000 }, async () => {
    const { service, journal } = await buildHarness([
      { match: 'player_id=1618709&page=2', handler: () => html(fixture('troops-own-paged-p2-rows.html')) },
      { match: 'player_id=1618709', handler: () => html(fixture('troops-own-paged-p1-rows.html')) },
      { match: 'mode=members_troops', handler: () => html(selectorBody(1618709, 'R O D R I G U E S')) },
    ]);

    const snapshot = await service.collectAllMembers('troops');

    // 5 aldeias da página 1 + 4 da página 2 (recortes fiéis do HTML real).
    expect(snapshot.entries).toHaveLength(9);
    expect(new Set(snapshot.entries.map((entry) => entry.villageId)).size).toBe(9);
    expect(snapshot.entries.every((entry) => entry.playerId === 1618709)).toBe(true);
    expect(snapshot.failures).toBeUndefined();
    // coordenadas reais da tabela de dados (parser achou a tabela certa, não o pager)
    expect(snapshot.entries.every((entry) => entry.coord.x >= 0 && entry.coord.y >= 0)).toBe(true);
    expect(fetchCallCount('player_id=1618709&page=2')).toBe(1);
    const journalLine = journal.list(20).find((entry) => entry.action === 'collect-members');
    expect(journalLine?.detail).toContain('R O D R I G U E S: 2 páginas');
  });

  it('a 1ª página de cada membro vai com page=1 EXPLÍCITO (o jogo memoriza a página na sessão)', { timeout: 20_000 }, async () => {
    const { service } = await buildHarness([
      { match: 'player_id=111', handler: () => html(memberTroopsPage(P1_VILLAGES, '')) },
      { match: 'mode=members_troops', handler: () => html(selectorBody(111, 'Líder Pager')) },
    ]);

    await service.collectAllMembers('troops');

    // Sem o page=1 explícito, a 2ª coleta herda a última página visitada na
    // sessão do jogo e vem TRUNCADA (provado no canário 02/09).
    expect(fetchCallCount('player_id=111&page=1')).toBe(1);
    expect(fetchCallCount(/player_id=111(?!&page=)/)).toBe(0);
  });

  it('página 2 devolve formulário de LOGIN: sentinela ABORTA a coleta (não vira falha de página)', { timeout: 20_000 }, async () => {
    const { service } = await buildHarness([
      { match: 'player_id=111&page=2', handler: () => html('<html><body><form id="login"><input name="password" /></form></body></html>') },
      { match: 'player_id=111', handler: () => html(memberTroopsPage(P1_VILLAGES, memberPagerTable(`<strong> &gt;1&lt; </strong>${memberPagerLink(2)}`))) },
      { match: 'mode=members_troops', handler: () => html(selectorBody(111, 'Líder Pager')) },
    ]);

    // A fila detecta a página de login e lança session-expired; o serviço
    // PROPAGA (fail-fast como no lote) em vez de seguir batendo no jogo.
    await expect(service.collectAllMembers('troops')).rejects.toThrow(/sess/i);
  });
});

// ---------------------------------------------------------------------------
// Fail-open da LEITURA do cache local: com a sessão caída (ou nunca iniciada),
// get/getDefenseVillages continuam devolvendo o snapshot salvo em disco — dado
// salvo não pode virar "Nunca coletado" só porque a sessão caiu. A COLETA
// continua exigindo sessão (world() fail-closed nos caminhos de escrita).
// ---------------------------------------------------------------------------

describe('TroopsService — leitura do cache sem sessão (fail-open)', () => {
  it('get sem sessão devolve o snapshot salvo AS-IS (não vira "nunca coletado")', { timeout: 20_000 }, async () => {
    const { service, twSession } = await buildHarness([
      { match: 'player_id=111', handler: () => html(memberTroopsPage(P1_VILLAGES, '')) },
      { match: 'mode=members_troops', handler: () => html(selectorBody(111, 'Líder Pager')) },
    ]);

    const collected = await service.collectAllMembers('troops'); // escrita: exige sessão (como hoje)
    twSession.markSessionLost('session-expired'); // sentinela da fila derrubou a sessão

    await expect(service.get('troops')).resolves.toEqual(collected);
  });

  it('getDefenseVillages sem sessão devolve a defesa por aldeia salva', { timeout: 20_000 }, async () => {
    const { service, twSession } = await buildHarness([
      { match: 'player_id=111', handler: () => html(fixture('ally-members-defense-player-reboucas.html')) },
      { match: 'mode=members_defense', handler: () => html(selectorBody(111, 'Reboucas')) },
    ]);

    await service.collectAllMembers('defense');
    twSession.markSessionLost('captcha-suspected');

    const villages = await service.getDefenseVillages();
    expect(villages).not.toBeNull();
    expect(villages?.entries.length).toBeGreaterThan(0);
  });

  it('sem sessão e loja vazia segue null ("nunca coletado" verdadeiro); status() não precisa de sessão', { timeout: 20_000 }, async () => {
    const { service } = await buildHarness([], { skipLogin: true });

    await expect(service.get('troops')).resolves.toBeNull();
    await expect(service.getDefenseVillages()).resolves.toBeNull();
    await expect(service.status()).resolves.toEqual({ troopsAt: null, defenseAt: null });
  });

  it('regressão: COM sessão ativa em outro mundo, dado do mundo antigo segue null', { timeout: 20_000 }, async () => {
    const { service, twSession } = await buildHarness([
      { match: 'player_id=111', handler: () => html(memberTroopsPage(P1_VILLAGES, '')) },
      { match: 'mode=members_troops', handler: () => html(selectorBody(111, 'Líder Pager')) },
    ]);

    await service.collectAllMembers('troops'); // world salvo no cache: br142
    await twSession.loginWithSid('br143', SID); // sessão agora valida em br143

    await expect(service.get('troops')).resolves.toBeNull();
  });

  it('sessão caiu mas o mundo fica (markSessionLost): dado de OUTRO mundo segue null', { timeout: 20_000 }, async () => {
    const { service, twSession } = await buildHarness([
      { match: 'player_id=111', handler: () => html(memberTroopsPage(P1_VILLAGES, '')) },
      { match: 'mode=members_troops', handler: () => html(selectorBody(111, 'Líder Pager')) },
    ]);

    await service.collectAllMembers('troops'); // cache salvo com world=br142
    await twSession.loginWithSid('br143', SID); // sessão troca para br143
    twSession.markSessionLost('session-expired'); // cai, mas o mundo (br143) fica conhecido

    // Fail-open NÃO vaza dado de outro mundo: o mundo conhecido (preservado
    // pelo markSessionLost) manda comparar mesmo sem sessão ativa.
    await expect(service.get('troops')).resolves.toBeNull();
  });

  it('logout limpa o mundo: sem mundo conhecido o snapshot salvo volta AS-IS (fail-open de exibição)', { timeout: 20_000 }, async () => {
    const { service, twSession } = await buildHarness([
      { match: 'player_id=111', handler: () => html(memberTroopsPage(P1_VILLAGES, '')) },
      { match: 'mode=members_troops', handler: () => html(selectorBody(111, 'Líder Pager')) },
    ]);

    const collected = await service.collectAllMembers('troops'); // cache de br142
    await twSession.loginWithSid('br143', SID);
    await twSession.logout(); // world = null — só então a checagem de mundo é pulada

    await expect(service.get('troops')).resolves.toEqual(collected);
  });
});
