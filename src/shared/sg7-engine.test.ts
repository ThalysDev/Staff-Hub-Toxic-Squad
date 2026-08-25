import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseForumThread } from './parsers/forum-parsers';
import { applyBlindUpdate, parseBlindTable, recognizeComments, recognizedSummary, sumByPedido } from './sg7-engine';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../tests/fixtures/br142/${name}`, import.meta.url)), 'latin1');
}

describe('parseForumThread (fixture real)', () => {
  it('extrai thread e posts com autor/texto', () => {
    const thread = parseForumThread(fixture('forum-thread-real.html'));
    expect(thread.threadId).toBe(2115);
    expect(thread.posts.length).toBeGreaterThan(0);
    for (const post of thread.posts) {
      expect(post.postId).toBeGreaterThan(0);
    }
  });
});

describe('recognizeComments + sumByPedido', () => {
  const posts = [
    { postId: 2, author: 'Eiras', text: '243/100/0/0' },
    { postId: 3, author: 'zulu19', text: 'comentário qualquer sem formato' },
    { postId: 4, author: 'ana', text: 'prévia 243/50/0/0 e depois 243/25/0/0' },
    { postId: 5, author: 'bia', text: '12/0/300/40' },
  ];

  it('reconhece o formato rígido (primeira ocorrência por post)', () => {
    const comments = recognizeComments(posts);
    expect(comments.map((c) => `${c.pedido}/${c.spear}/${c.sword}/${c.archer}`)).toEqual([
      '243/100/0/0',
      '243/50/0/0',
      '12/0/300/40',
    ]);
  });

  it('soma por pedido e registra autores', () => {
    const sums = sumByPedido(recognizeComments(posts));
    expect(sums).toHaveLength(2);
    expect(sums[0]?.pedido).toBe(12);
    expect(sums[1]).toMatchObject({ pedido: 243, spear: 150, sword: 0, archer: 0 });
    expect(sums[1]?.authors).toEqual(['Eiras', 'ana']);
  });

  it('recognizedSummary no formato original', () => {
    const sums = sumByPedido(recognizeComments(posts));
    expect(recognizedSummary(sums)).toContain('243/150/0/0');
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

  it('subtrai envios e marca completo', () => {
    const sums = sumByPedido(recognizeComments([
      { postId: 9, author: 'Eiras', text: '1/2000/913/0' },
      { postId: 10, author: 'ana', text: '12/0/300/0' },
    ]));
    const updated = applyBlindUpdate(bbcode, sums);
    expect(updated).toContain('Lanceiros 8.000, Espadachins 8.000');
    expect(updated).toContain('Completo ✔');
    expect(updated).toContain('Lanceiros 3.000'); // pedido 2 intocado
  });
});
