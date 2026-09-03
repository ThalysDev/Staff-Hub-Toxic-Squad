import { describe, expect, it } from 'vitest';
import { fold } from './fold';

describe('fold', () => {
  it('remove acento e reduz a caixa ("João" → "joao")', () => {
    expect(fold('João')).toBe('joao');
  });

  it('normaliza acento, caixa e espaço juntos ("ZÉ com ESPAÇO" → "ze com espaco")', () => {
    expect(fold('ZÉ com ESPAÇO')).toBe('ze com espaco');
  });

  it('string vazia devolve string vazia', () => {
    expect(fold('')).toBe('');
  });

  it('cedilha vira "c" nos dois cases ("ç Ç" → "c c")', () => {
    expect(fold('ç Ç')).toBe('c c');
  });

  it('é idempotente: fold(fold(texto)) === fold(texto)', () => {
    const samples = ['João', 'ZÉ com ESPAÇO', 'ç Ç', '  Ação  ', 'Top 10'];
    for (const sample of samples) expect(fold(fold(sample))).toBe(fold(sample));
  });

  it('ASCII sem acento só muda a caixa', () => {
    expect(fold('AbC XyZ')).toBe('abc xyz');
    expect(fold('sem-acentos')).toBe('sem-acentos');
  });

  it('preserva números ("Top 10 em 2026" → "top 10 em 2026")', () => {
    expect(fold('Top 10 em 2026')).toBe('top 10 em 2026');
  });

  it('apara espaços das bordas ("  João  " → "joao")', () => {
    expect(fold('  João  ')).toBe('joao');
  });
});
