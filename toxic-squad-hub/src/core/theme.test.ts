import { describe, expect, it } from 'vitest';
import { THEME_TOKENS, themeDeclarations, tokenForHex } from './theme';

describe('tema único (Onda D)', () => {
  it('declara todas as variáveis --shs-* (cores, fontes, raio, sombra)', () => {
    const css = themeDeclarations();
    for (const name of Object.keys(THEME_TOKENS)) expect(css).toContain(`--shs-${name}:`);
    expect(css).toContain('--shs-font-mono:');
    expect(css).toContain('--shs-radius:');
  });
  it('hex → token (sem diferenciar maiúsculas)', () => {
    expect(tokenForHex('#6D3C14')).toBe('action');
    expect(tokenForHex('#123456')).toBeNull();
  });
  it('não há duas variáveis com a mesma cor (mapeamento reverso sem ambiguidade)', () => {
    const values = Object.values(THEME_TOKENS);
    expect(new Set(values).size).toBe(values.length);
  });
});
