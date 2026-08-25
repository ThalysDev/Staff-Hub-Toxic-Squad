import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { forumTokens, parseEditForm, parseForumThread } from './parsers/forum-parsers';
import { applyBlindUpdate, parseBlindTable, recognizeComments, recognizedSummary, sumByPedido } from './sg7-engine';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../tests/fixtures/br142/${name}`, import.meta.url)), 'latin1');
}

describe('parsers do fórum (fixtures reais BR142)', () => {
  it('forumTokens extrai csrf e village do JSON real ("village":{"id":N})', () => {
    for (const name of ['forum-thread-real.html', 'ally-reservations.html', 'mail-new.html']) {
      const tokens = forumTokens(fixture(name));
      expect(tokens.csrf).toMatch(/^[a-f0-9]+$/);
      expect(tokens.villageId).toMatch(/^\d+$/);
    }
  });

  it('parseForumThread extrai thread e posts', () => {
    const thread = parseForumThread(fixture('forum-thread-real.html'));
    expect(thread.threadId).toBe(2115);
    expect(thread.posts.length).toBeGreaterThan(0);
  });

  it('parseEditForm devolve message + action exata com do/current_page', () => {
    const form = parseEditForm(fixture('forum-edit-post.html'));
    expect(form.message.length).toBeGreaterThan(0);
    expect(form.action).toContain('action=edit_post');
    expect(form.action).toContain('edit_post_id=12677');
    expect(form.action).toContain('post_id=12677');
    expect(form.action).toContain('forum_id=597');
    expect(form.action).toContain('h=');
    expect(form.doValue).toBe('send');
    expect(form.currentPage).toBe('1');
  });
});

describe('recognizeComments + sumByPedido', () => {
  const posts = [
    { postId: 2, author: 'Eiras', text: '243/100/0/0' },
    { postId: 3, author: 'zulu19', text: 'comentário qualquer sem formato' },
    { postId: 4, author: 'ana', text: 'prévia 243/50/0/0 e depois 243/25/0/0' },
    { postId: 5, author: 'bia', text: '12/0/300/40' },
  ];

  it('reconhece TODAS as ocorrências por post (4 campos = formato SG_3)', () => {
    const comments = recognizeComments(posts);
    expect(comments.map((c) => `${c.pedido}/${c.values.join('/')}`)).toEqual([
      '243/100/0/0',
      '243/50/0/0',
      '243/25/0/0',
      '12/0/300/40',
    ]);
  });

  it('soma por pedido (colunas) e registra autores', () => {
    const sums = sumByPedido(recognizeComments(posts));
    expect(sums).toHaveLength(2);
    expect(sums[0]?.pedido).toBe(12);
    expect(sums[1]).toMatchObject({ pedido: 243, values: [175, 0, 0] });
    expect(sums[1]?.authors).toEqual(['Eiras', 'ana', 'ana']); // 2 linhas no mesmo post
  });

  it('FORMATO REAL DA TRIBO (fixture): 7 campos, várias linhas por post', () => {
    const thread = parseForumThread(fixture('forum-thread-real.html'));
    const comments = recognizeComments(thread.posts.slice(1));
    // o post real traz pedidos 45..58, todos com 6 valores
    expect(comments.length).toBeGreaterThanOrEqual(14);
    expect(comments.filter((c) => c.values.length === 6)).toHaveLength(comments.length);
    const first = comments[0]!;
    expect(first.pedido).toBe(45);
    expect(first.values).toEqual([0, 10000, 3000, 1000, 0, 0]);
  });

  it('recognizedSummary no formato original', () => {
    const sums = sumByPedido(recognizeComments(posts));
    expect(recognizedSummary(sums)).toContain('243/175/0/0');
  });
});

describe('parseBlindTable + applyBlindUpdate (BBCode do SG_3)', () => {
  const bbcode = [
    '[table]',
    '[**]Pedido[||]Aldeia[||]Falta[/**]',
    '[**]1[|]001 - X (100|100)[|]Lanceiros 10.000, Espadachins 8.913[/**]',
    '[**]2[|]002 - Y (101|101)[|]Lanceiros 3.000[/**]',
    '[**]12[|]003 - Z (102|102)[|]Espadachins 300[/**]',
    '[/table]',
  ].join('\n');

  it('lê pedidos/aldeias/faltas', () => {
    const rows = parseBlindTable(bbcode);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ pedido: 1, villageLabel: '001 - X (100|100)' });
    expect(rows[0]?.missing).toEqual({ spear: 10000, sword: 8913 });
    expect(rows[2]?.missing).toEqual({ sword: 300 });
  });

  it('subtrai envios (4 campos) e marca completo', () => {
    const sums = sumByPedido(recognizeComments([
      { postId: 9, author: 'Eiras', text: '1/2000/913/0' },
      { postId: 10, author: 'ana', text: '12/0/300/0' },
    ]));
    const updated = applyBlindUpdate(bbcode, sums);
    expect(updated).toContain('Lanceiros 8.000, Espadachins 8.000');
    expect(updated).toContain('Completo ✔');
    expect(updated).toContain('Lanceiros 3.000'); // pedido 2 intocado
  });

  it('comentário estendido (7 campos) NÃO altera a tabela (só conferência)', () => {
    const sums = sumByPedido(recognizeComments([{ postId: 9, author: 'x', text: '1/0/10000/3000/1000/0/0' }]));
    const updated = applyBlindUpdate(bbcode, sums);
    expect(updated).toBe(bbcode);
  });

  it('linha fora do formato permanece intacta (fail-closed)', () => {
    const custom = '[table]\n[**]7[|]aldeia[|]texto livre qualquer[/**]\n[/table]';
    const sums = sumByPedido(recognizeComments([{ postId: 9, author: 'x', text: '7/100/0/0' }]));
    expect(applyBlindUpdate(custom, sums)).toBe(custom);
  });
});
