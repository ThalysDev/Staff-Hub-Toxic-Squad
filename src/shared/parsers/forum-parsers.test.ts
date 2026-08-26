import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities, parseEditForm } from './forum-parsers';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/br142/${name}`, import.meta.url)), 'utf-8');
}

describe('decodeHtmlEntities', () => {
  it('decodifica entidades nomeadas usadas pelo jogo ao reabrir o formulário', () => {
    expect(decodeHtmlEntities('OP &amp; Guerra &lt;plano&gt; &#39;hoje&#39; &quot;22:00&quot;')).toBe(
      "OP & Guerra <plano> 'hoje' \"22:00\"",
    );
  });

  it('decodifica entidades numéricas decimais e hexadecimais', () => {
    expect(decodeHtmlEntities('&#65;&#x42;&#x43;')).toBe('ABC');
  });

  it('nbsp vira espaço; entidades desconhecidas ficam intactas (nunca corromper)', () => {
    expect(decodeHtmlEntities('a&nbsp;b &desconhecida;')).toBe('a b &desconhecida;');
  });

  it('round-trip da verificação real: texto escapado no textarea decodifica para o original', () => {
    const original = '[b]OP Teste & Companhia[/b]\nChegada <22:00> & confirmação';
    const escaped = original.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    expect(decodeHtmlEntities(escaped).trim()).toBe(original.trim());
  });
});

describe('parseEditForm (fixture real forum-edit-post.html)', () => {
  it('extrai message/action/do/current_page do formulário real do BR142', () => {
    const form = parseEditForm(fixture('forum-edit-post.html'));
    expect(form.action).toMatch(/action=edit_post/);
    expect(form.action).not.toMatch(/&amp;/);
    expect(form.message.length).toBeGreaterThan(0);
    expect(['send', 'preview']).toContain(form.doValue);
    expect(form.currentPage).toMatch(/^\d+$/);
  });

  it('fail-closed: HTML sem formulário de edição lança ParseError', () => {
    expect(() => parseEditForm('<html><body>sem form</body></html>')).toThrow(/Formulário de edição/);
  });
});
