/**
 * Testes do Sg7Service (conferência/ajuste/exclusão no fórum de tribo) com
 * sessão MOCKADA.
 *
 * Estratégia: idem tests/main/sg6-service.test.ts — 'electron' trocado pelo
 * helper tests/main/electron-mock.ts (vi.mock com factory async importando o
 * helper; ver cabeçalho dele). TwSessionManager real (login via loginWithSid
 * contra a fixture real de overview), Journal/JsonStore reais em userData
 * temporário e RequestQueue real (single-flight C4). Só o fio de rede é fake.
 *
 * Fixtures:
 *  - REAIS do BR142: forum-thread-real.html (tópico 2115, posts 12677/12678
 *    com comentários estendidos de 6 campos) e forum-edit-post.html (formulário
 *    de edição real, com action=edit_post + do/current_page ocultos).
 *  - SINTÉTICAS fiéis ao formato que os parsers reais leem (parseForumThread:
 *    blocos separados por quote_id=, edit_post_id=, autor info_player antes do
 *    div.text; parseEditForm: textarea name="message" + action=edit_post;
 *    forumTokens: "csrf"/"village":{"id":N): comentário "243/100/0/0"
 *    (formato SG_3 de 4 campos — o que a blindagem SUBTRAI da tabela) e tabela
 *    BBCode [**]pedido[|]aldeia[|]faltas[/**] no primeiro post.
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
  electronMockState,
  fetchCallCount,
  html,
  resetElectronMock,
  routeElectronFetch,
  type FetchRoute,
  type MockFetchInit,
} from './electron-mock';
import { TwSessionManager } from '../../src/main/tw/session';
import { Journal } from '../../src/main/journal';
import { JsonStore } from '../../src/main/stores/json-store';
import { RequestQueue } from '../../src/main/tw/request-queue';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc-types';
import { Sg7Service } from '../../src/main/mutations/sg7-service';

const WORLD = 'br142';
const SID = `0:${'2e'.repeat(32)}`;
const CSRF = 'ab12cd34';
const THREAD_URL = `https://${WORLD}.tribalwars.com.br/game.php?screen=forum&screenmode=view_thread&thread_id=2115&forum_id=597`;

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/br142/${name}`, import.meta.url)), 'utf-8');
}

// ---------------------------------------------------------------------------
// Fixtures sintéticas (formato herdado dos parsers + das fixtures reais)
// ---------------------------------------------------------------------------

interface SynthPost {
  postId: number;
  author: string;
  text: string;
}

/** Página de tópico no formato lido por parseForumThread + forumTokens. */
function synthThreadHtml(posts: SynthPost[]): string {
  const blocks = posts
    .map(
      (post) => `<tr><td>
<a href="/game.php?screen=forum&amp;screenmode=view_thread&amp;thread_id=2115&amp;answer=true&amp;quote_id=${post.postId}&amp;page=1&amp;forum_id=597#${post.postId}">Citar</a>
<a href="/game.php?screen=info_player&amp;id=${100_000 + post.postId}">${post.author}</a>
<a href="/game.php?screen=forum&amp;screenmode=view_thread&amp;thread_id=2115&amp;edit_post_id=${post.postId}&amp;page=1&amp;forum_id=597#${post.postId}">Editar</a>
<div class="text">${post.text}</div>
</td></tr>`,
    )
    .join('\n');
  return `<html><body id="ds_body">
<script>var TribalWars={"csrf":"${CSRF}","village":{"id":79788,"name":"Aldeia da staff"}};</script>
<a href="/game.php?screen=forum&amp;screenmode=view_thread&amp;thread_id=2115&amp;page=1&amp;forum_id=597">Blindagem da OP</a>
${blocks}
</body></html>`;
}

/** Formulário de edição no formato lido por parseEditForm (action com h=csrf). */
function synthEditFormHtml(message: string): string {
  return `<html><body id="ds_body">
<form method="post" action="/game.php?village=79788&amp;screen=forum&amp;screenmode=view_thread&amp;thread_id=2115&amp;action=edit_post&amp;edit_post_id=12677&amp;post_id=12677&amp;page=0&amp;forum_id=597&amp;h=${CSRF}#12677">
<textarea id="message" name="message" cols="80" rows="12">${message}</textarea>
<input type="hidden" name="do" id="forum_do" value="send" />
<input type="hidden" name="current_page" value="1" />
<input type="submit" name="send" value="Enviar" />
</form></body></html>`;
}

const FIRST_POST: SynthPost = { postId: 12677, author: 'Staff', text: 'Tabela de blindagem (ver post acima)' };
const COMMENT_243: SynthPost = { postId: 12678, author: 'Reboucas', text: 'Enviados: 243/100/0/0' };
const COMMENT_244: SynthPost = { postId: 12679, author: 'Spartacus', text: 'Enviados: 244/1/1/1' };

const ORIGINAL_TABLE = [
  '[size=14][b]TABELA DE BLINDAGEM[/b][/size]',
  '[**]243[|]Aldeia Alpha[|]Lanceiros 10.000, Espadachins 8.913[/**]',
  '[**]244[|]Aldeia Beta[|]Lanceiros 5.000, Arqueiros 2.000[/**]',
].join('\n');

/** 243/100/0/0 subtrai 100 lanceiros do pedido 243; pedido 244 sem envio fica igual. */
const UPDATED_TABLE = [
  '[size=14][b]TABELA DE BLINDAGEM[/b][/size]',
  '[**]243[|]Aldeia Alpha[|]Lanceiros 9.900, Espadachins 8.913[/**]',
  '[**]244[|]Aldeia Beta[|]Lanceiros 5.000, Arqueiros 2.000[/**]',
].join('\n');

const PLAN_BBCODE = '[b]PLANO DA OP BARREIRA[/b]\nReboucas 500|500 as 12:00:00\nSpartacus 501|501 as 12:00:00';

interface Harness {
  service: Sg7Service;
  journal: Journal;
  queue: RequestQueue;
}

async function buildHarness(routes: FetchRoute[]): Promise<Harness> {
  const journal = new Journal();
  const settingsStore = new JsonStore<AppSettings>('settings', DEFAULT_SETTINGS);
  await settingsStore.save({ ...DEFAULT_SETTINGS, requestMinIntervalMs: 350, requestJitterMs: 0, requestCeiling: 400 });
  const queue = new RequestQueue(
    vi.fn(async (url: string) => ({ ok: true, status: 200, body: '', url })),
    vi.fn(),
    { minIntervalMs: 0, jitterMs: 0, ceiling: 400 },
  );
  const twSession = new TwSessionManager();
  routeElectronFetch([...routes, { match: 'screen=overview', handler: () => html(fixture('overview.html')) }]);
  const login = await twSession.loginWithSid(WORLD, SID);
  expect(login.ok).toBe(true);
  return { service: new Sg7Service(twSession, journal, queue, settingsStore), journal, queue };
}

beforeEach(() => {
  resetElectronMock();
});

afterAll(() => {
  disposeElectronMock();
});

describe('Sg7Service.conference (conferência dos posts)', () => {
  it('reconhece comentários da fixture REAL do BR142 (6 pedidos estendidos, nada a subtrair)', async () => {
    const { service, journal } = await buildHarness([
      { match: 'page=last', handler: () => html(fixture('forum-thread-real.html')) },
      { match: 'edit_post_id=', handler: () => html(fixture('forum-edit-post.html')) },
    ]);

    const result = await service.conference(THREAD_URL + '&page=1');

    expect(result.threadId).toBe(2115);
    // BBCode fonte do primeiro post vem do formulário de edição real
    expect(result.firstPostMessage).toContain('PROTOCOLO DE BLINDAGEM');
    // posts 45..58 no formato estendido (6 valores) — só conferem, não subtraem
    expect(result.recognized.split('\n')).toEqual(
      Array.from({ length: 58 - 45 + 1 }, (_, index) => `${45 + index}/0/10000/3000/1000/0/0`),
    );
    expect(result.changed).toBe(false);
    expect(result.updatedMessage).toBe(result.firstPostMessage);
    expect(result.recognizedPostIds).toEqual([12678]);
    const entry = journal.list(10).find((e) => e.action === 'sg7-conference');
    expect(entry).toMatchObject({ kind: 'read', detail: 'thread=2115 reconhecidos=14', dryRun: true });
  });

  it('reconhece pedido 243/100/0/0 e produz a tabela atualizada (changed=true)', async () => {
    const { service } = await buildHarness([
      { match: 'page=last', handler: () => html(synthThreadHtml([FIRST_POST, COMMENT_243])) },
      { match: 'edit_post_id=', handler: () => html(synthEditFormHtml(ORIGINAL_TABLE)) },
    ]);

    const result = await service.conference(THREAD_URL);

    expect(result.recognized).toBe('243/100/0/0');
    expect(result.changed).toBe(true);
    expect(result.updatedMessage).toBe(UPDATED_TABLE);
    expect(result.recognizedPostIds).toEqual([12678]);
  });

  it('rejeita URL de tópico de outro mundo que não o da sessão', async () => {
    const { service } = await buildHarness([
      { match: 'page=last', handler: () => html(synthThreadHtml([FIRST_POST, COMMENT_243])) },
      { match: 'edit_post_id=', handler: () => html(synthEditFormHtml(ORIGINAL_TABLE)) },
    ]);

    await expect(
      service.conference('https://br130.tribalwars.com.br/game.php?screen=forum&screenmode=view_thread&thread_id=2115&forum_id=597'),
    ).rejects.toThrow('A URL do tópico deve apontar para br142.tribalwars.com.br');
    expect(fetchCallCount('screenmode=view_thread')).toBe(0);
  });

  it('sentinela de sessão expirada na leitura aborta com erro claro', async () => {
    const { service } = await buildHarness([
      { match: 'page=last', handler: () => html('<html><form id="login"><input name="password"></form></html>') },
    ]);

    await expect(service.conference(THREAD_URL)).rejects.toThrow('Sessão expirada — faça login novamente.');
  });

  it('página sem posts (estrutura inesperada) é fail-closed', async () => {
    const { service } = await buildHarness([
      { match: 'page=last', handler: () => html(synthThreadHtml([])) },
    ]);

    await expect(service.conference(THREAD_URL)).rejects.toThrow('Nenhum post encontrado no tópico');
  });

  it('fila ocupada rejeita a conferência antes de qualquer GET (single-flight C4)', async () => {
    const { service, queue } = await buildHarness([
      { match: 'page=last', handler: () => html(synthThreadHtml([FIRST_POST, COMMENT_243])) },
    ]);
    queue.beginOperation();
    try {
      await expect(service.conference(THREAD_URL)).rejects.toThrow('Uma operação está em andamento');
      expect(fetchCallCount('screenmode=view_thread')).toBe(0);
    } finally {
      queue.endOperation();
    }
  });
});

describe('Sg7Service.adjust (ajusta o post da tabela)', () => {
  /** Rotas do fluxo completo: ler tópico → formulário → POST → verificação. */
  function adjustRoutes(afterPostForm: () => string): FetchRoute[] {
    let posted = false;
    return [
      {
        match: 'action=edit_post',
        handler: () => {
          posted = true;
          return html('<html><body>ok</body></html>');
        },
      },
      { match: 'edit_post_id=', handler: () => html(posted ? afterPostForm() : synthEditFormHtml(ORIGINAL_TABLE)) },
      { match: 'page=last', handler: () => html(synthThreadHtml([FIRST_POST, COMMENT_243])) },
      { match: 'screenmode=view_thread', handler: () => html(synthThreadHtml([FIRST_POST, COMMENT_243])) },
    ];
  }

  it('monta POST com CSRF/action do formulário e journal de mutação após verificação real', async () => {
    const posts: MockFetchInit[] = [];
    const { service, journal, queue } = await buildHarness(
      adjustRoutes(() => synthEditFormHtml(UPDATED_TABLE)).map((route) =>
        route.match === 'action=edit_post'
          ? {
              ...route,
              // espião DELEGA no handler original (ele marca o POST como feito,
              // o que faz a rota do formulário servir o conteúdo atualizado)
              handler: (init: MockFetchInit, url: string) => {
                posts.push(init);
                return route.handler(init, url);
              },
            }
          : route,
      ),
    );

    const result = await service.adjust(THREAD_URL, true);

    expect(result).toEqual({ ok: true, detail: 'Post da tabela atualizado (verificado).' });
    // POST único, para a action exata do formulário, com o CSRF da página
    // (a action real do jogo começa com "/game.php" → o service concatena com
    // a barra do host; a barra dupla é o comportamento de produção)
    expect(posts).toHaveLength(1);
    expect(posts[0]?.method).toBe('POST');
    const postUrl = fetchUrl('action=edit_post');
    expect(postUrl).toBe(
      `https://br142.tribalwars.com.br/game.php?village=79788&screen=forum&screenmode=view_thread&thread_id=2115&action=edit_post&edit_post_id=12677&post_id=12677&page=0&forum_id=597&h=${CSRF}`,
    );
    const params = new URLSearchParams(posts[0]?.body ?? '');
    expect(params.get('message')).toBe(UPDATED_TABLE);
    expect(params.get('do')).toBe('send');
    expect(params.get('current_page')).toBe('1');
    expect(params.get('send')).toBe('Enviar');
    const entry = journal.list(10).find((e) => e.action === 'forum-adjust');
    expect(entry).toMatchObject({ kind: 'mutation', detail: 'thread=2115 → Post da tabela atualizado (verificado).', dryRun: false });
    expect(queue.isRunning).toBe(false);
  }, 15_000);

  it('nada a ajustar (envio não altera a tabela) → sem POST nenhum', async () => {
    const { service } = await buildHarness([
      { match: 'edit_post_id=', handler: () => html(synthEditFormHtml(ORIGINAL_TABLE)) },
      // comentário do pedido 999: reconhecido, mas sem linha correspondente na tabela
      { match: 'page=last', handler: () => html(synthThreadHtml([FIRST_POST, { postId: 12690, author: 'Zé', text: '999/5/5/5' }])) },
      { match: 'screenmode=view_thread', handler: () => html(synthThreadHtml([FIRST_POST])) },
    ]);

    const result = await service.adjust(THREAD_URL, true);

    expect(result).toEqual({ ok: true, detail: 'Nada a ajustar — nenhum envio reconhecido altera a tabela.' });
    expect(fetchCallCount('action=edit_post')).toBe(0);
  }, 15_000);

  it('verificação que falha após o POST vira "resultado incerto" no journal e repropaga o erro', async () => {
    let posted = false;
    const { service, journal } = await buildHarness([
      {
        match: 'action=edit_post',
        handler: () => {
          posted = true;
          return html('<html><body>ok</body></html>');
        },
      },
      {
        match: 'edit_post_id=',
        handler: () => {
          if (posted) throw new Error('conexão caiu na verificação');
          return html(synthEditFormHtml(ORIGINAL_TABLE));
        },
      },
      { match: 'page=last', handler: () => html(synthThreadHtml([FIRST_POST, COMMENT_243])) },
      { match: 'screenmode=view_thread', handler: () => html(synthThreadHtml([FIRST_POST, COMMENT_243])) },
    ]);

    await expect(service.adjust(THREAD_URL, true)).rejects.toThrow('conexão caiu na verificação');
    const entry = journal.list(10).find((e) => e.action === 'forum-adjust-erro');
    expect(entry).toMatchObject({ kind: 'mutation', dryRun: false });
    expect(entry?.detail).toContain('POST disparado (thread=2115) — resultado incerto: conexão caiu na verificação');
  }, 15_000);

  it('confirmação false rejeita antes de qualquer GET ao fórum', async () => {
    const { service } = await buildHarness(adjustRoutes(() => synthEditFormHtml(UPDATED_TABLE)));

    await expect(service.adjust(THREAD_URL, false)).rejects.toThrow('Confirmação dupla necessária');
    expect(fetchCallCount('screen=forum')).toBe(0);
  });
});

describe('Sg7Service.deletePosts (apagar mensagens)', () => {

  it('rejeita URL de OUTRO mundo antes de qualquer fetch (guard de mutação destrutiva)', async () => {
    // Sem rotas: o guard deve rejeitar ANTES de qualquer fetch (rota sem
    // casamento no mock rejeita alto — prova que nada saiu do app).
    const { service } = await buildHarness([]);
    await expect(
      service.deletePosts('https://br128.tribalwars.com.br/game.php?screen=forum&screenmode=view_thread&thread_id=1', [1], true),
    ).rejects.toThrow(/mundo br142/i);
  });
  function deleteRoutes(threadAfterDelete: SynthPost[]): { routes: FetchRoute[]; deletedFlag: { value: boolean } } {
    const deletedFlag = { value: false };
    return {
      deletedFlag,
      routes: [
        {
          match: 'action=del_posts',
          handler: () => {
            deletedFlag.value = true;
            return html('<html><body>ok</body></html>');
          },
        },
        {
          match: 'page=last',
          handler: () => html(deletedFlag.value ? synthThreadHtml(threadAfterDelete) : synthThreadHtml([FIRST_POST, COMMENT_243, COMMENT_244])),
        },
        { match: 'screenmode=view_thread', handler: () => html(synthThreadHtml([FIRST_POST, COMMENT_243, COMMENT_244])) },
      ],
    };
  }

  it('apaga os posts selecionados com CSRF no POST, verifica que sumiram e journala', async () => {
    const { routes } = deleteRoutes([FIRST_POST, COMMENT_244]);
    const posts: MockFetchInit[] = [];
    const withSpy = routes.map((route) =>
      route.match === 'action=del_posts'
        ? {
            ...route,
            // espião delega no original (marca a exclusão p/ verificação)
            handler: (init: MockFetchInit, url: string) => {
              posts.push(init);
              return route.handler(init, url);
            },
          }
        : route,
    );
    const { service, journal } = await buildHarness(withSpy);

    const result = await service.deletePosts(THREAD_URL, [12678], true);

    expect(result).toEqual({ ok: true, detail: 'Posts apagados (verificado).' });
    expect(posts).toHaveLength(1);
    const postUrl = fetchUrl('action=del_posts');
    expect(postUrl).toContain('action=del_posts&thread_id=2115&page=0&forum_id=597');
    expect(postUrl).toContain(`h=${CSRF}`);
    const params = new URLSearchParams(posts[0]?.body ?? '');
    expect(params.getAll('chk_del_posts[]')).toEqual(['12678']);
    expect(params.get('submit_del_posts')).toBe('Apagar mensagens');
    const entry = journal.list(10).find((e) => e.action === 'forum-delete-posts');
    expect(entry).toMatchObject({ kind: 'mutation', detail: 'thread=2115 posts=1 → Posts apagados (verificado).', dryRun: false });
  }, 15_000);

  it('posts que continuam presentes após o POST viram falha "confira manualmente"', async () => {
    // o tópico pós-POST continua com o post 12678 → verificação reprova
    const { routes } = deleteRoutes([FIRST_POST, COMMENT_243, COMMENT_244]);
    const { service } = await buildHarness(routes);

    const result = await service.deletePosts(THREAD_URL, [12678], true);

    expect(result).toEqual({ ok: false, detail: '1 post(s) ainda presentes — confira manualmente.' });
  }, 15_000);

  it('confirmação false ou lista vazia rejeita antes de qualquer fetch', async () => {
    const { routes } = deleteRoutes([FIRST_POST]);
    const { service } = await buildHarness(routes);

    await expect(service.deletePosts(THREAD_URL, [12678], false)).rejects.toThrow('Confirmação dupla necessária');
    await expect(service.deletePosts(THREAD_URL, [], true)).rejects.toThrow('Nenhum post selecionado');
    expect(fetchCallCount('screen=forum')).toBe(0);
  });

  it('fila ocupada rejeita a exclusão antes de qualquer GET (single-flight C4)', async () => {
    const { routes } = deleteRoutes([FIRST_POST]);
    const { service, queue } = await buildHarness(routes);
    queue.beginOperation();
    try {
      await expect(service.deletePosts(THREAD_URL, [12678], true)).rejects.toThrow('Uma operação está em andamento');
      expect(fetchCallCount('screen=forum')).toBe(0);
    } finally {
      queue.endOperation();
    }
  });
});

describe('Sg7Service.postPlanToThread (plano da OP no primeiro post)', () => {
  function planRoutes(afterPostForm: () => string): FetchRoute[] {
    let posted = false;
    return [
      {
        match: 'action=edit_post',
        handler: () => {
          posted = true;
          return html('<html><body>ok</body></html>');
        },
      },
      { match: 'edit_post_id=', handler: () => html(posted ? afterPostForm() : synthEditFormHtml(ORIGINAL_TABLE)) },
      { match: 'screenmode=view_thread', handler: () => html(synthThreadHtml([FIRST_POST, COMMENT_243])) },
    ];
  }

  it('posta o plano BBCode no primeiro post e verifica o conteúdo gravado', async () => {
    const posts: MockFetchInit[] = [];
    const { service, journal } = await buildHarness(
      planRoutes(() => synthEditFormHtml(PLAN_BBCODE)).map((route) =>
        route.match === 'action=edit_post'
          ? {
              ...route,
              // espião delega no original (marca o POST p/ verificação)
              handler: (init: MockFetchInit, url: string) => {
                posts.push(init);
                return route.handler(init, url);
              },
            }
          : route,
      ),
    );

    const result = await service.postPlanToThread(THREAD_URL, PLAN_BBCODE, true);

    expect(result).toEqual({ ok: true, detail: 'Plano postado no primeiro post do tópico (verificado).' });
    expect(posts).toHaveLength(1);
    const postUrl = fetchUrl('action=edit_post');
    expect(postUrl).toContain(`h=${CSRF}`);
    const params = new URLSearchParams(posts[0]?.body ?? '');
    expect(params.get('message')).toBe(PLAN_BBCODE);
    expect(params.get('send')).toBe('Enviar');
    const entry = journal.list(10).find((e) => e.action === 'forum-post-plan');
    expect(entry).toMatchObject({ kind: 'mutation', dryRun: false });
    expect(entry?.detail).toContain(`thread=2115 (${PLAN_BBCODE.length} chars BBCode) → Plano postado`);
  }, 15_000);

  it('envio aceito mas conteúdo NÃO refletido reprova na verificação real', async () => {
    // formulário pós-POST continua com a tabela antiga → verificação pega
    const { service, journal } = await buildHarness(planRoutes(() => synthEditFormHtml(ORIGINAL_TABLE)));

    const result = await service.postPlanToThread(THREAD_URL, PLAN_BBCODE, true);

    expect(result).toEqual({ ok: false, detail: 'Envio aceito, mas o post NÃO refletiu o plano — confira manualmente.' });
    const entry = journal.list(10).find((e) => e.action === 'forum-post-plan');
    expect(entry?.detail).toContain('NÃO refletiu o plano');
  }, 15_000);

  it('plano vazio é rejeitado antes de qualquer fetch', async () => {
    const { service } = await buildHarness(planRoutes(() => synthEditFormHtml(PLAN_BBCODE)));

    await expect(service.postPlanToThread(THREAD_URL, '   ', true)).rejects.toThrow('Plano vazio');
    expect(fetchCallCount('screen=forum')).toBe(0);
  });

  it('URL de tópico de outro mundo é rejeitada antes de qualquer fetch', async () => {
    const { service } = await buildHarness(planRoutes(() => synthEditFormHtml(PLAN_BBCODE)));

    await expect(
      service.postPlanToThread('https://br130.tribalwars.com.br/game.php?screen=forum&screenmode=view_thread&thread_id=1&forum_id=2', PLAN_BBCODE, true),
    ).rejects.toThrow('A URL do tópico deve apontar para br142.tribalwars.com.br');
    expect(fetchCallCount('screen=forum')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Acesso direto às chamadas do fetch mockado (URL + init) para asserts de POST
// ---------------------------------------------------------------------------

function fetchUrl(fragment: string): string {
  return String(electronMockState.fetch.mock.calls.find(([url]) => String(url).includes(fragment))?.[0] ?? '');
}
