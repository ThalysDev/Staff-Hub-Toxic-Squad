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
    expect(tokenForHex('#2E6B3E')).toBe('action');
    expect(tokenForHex('#123456')).toBeNull();
  });
  it('papéis de cor do "Instrumento": acento, mira e pausa são cores DISTINTAS', () => {
    // Tokens podem compartilhar valor (superfícies brancas, ok = acento), mas
    // os três significados que o jogador precisa distinguir nunca colidem.
    const roles = [THEME_TOKENS.action, THEME_TOKENS.brass, THEME_TOKENS.danger];
    expect(new Set(roles).size).toBe(3);
    expect(tokenForHex('#fbf0dc')).toBe('warn-bg');
  });
});
