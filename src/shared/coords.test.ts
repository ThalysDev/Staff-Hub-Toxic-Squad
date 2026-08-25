import { describe, expect, it } from 'vitest';
import {
  continentOf,
  formatCoord,
  formatCoordList,
  inAxesRange,
  parseCoord,
  parseCoordList,
} from './coords';

describe('parseCoord', () => {
  it('aceita "123|456"', () => {
    expect(parseCoord('123|456')).toEqual({ x: 123, y: 456 });
  });

  it('aceita espaços à volta', () => {
    expect(parseCoord('  123 | 456  ')).toEqual({ x: 123, y: 456 });
  });

  it('aceita 0|0', () => {
    expect(parseCoord('0|0')).toEqual({ x: 0, y: 0 });
  });

  it('rejeita eixo acima de 999', () => {
    expect(parseCoord('1000|5')).toBeNull();
    expect(parseCoord('5|1000')).toBeNull();
  });

  it('rejeita mais de 3 dígitos por eixo', () => {
    expect(parseCoord('123|4567')).toBeNull();
    expect(parseCoord('0999|5')).toBeNull();
  });

  it('rejeita tokens inválidos', () => {
    expect(parseCoord('')).toBeNull();
    expect(parseCoord('abc')).toBeNull();
    expect(parseCoord('123x456')).toBeNull();
    expect(parseCoord('123|456|789')).toBeNull();
    expect(parseCoord('-5|3')).toBeNull();
  });
});

describe('parseCoordList', () => {
  it('separa por espaço', () => {
    expect(parseCoordList('123|456 124|456')).toEqual([
      { x: 123, y: 456 },
      { x: 124, y: 456 },
    ]);
  });

  it('separa por quebra de linha', () => {
    expect(parseCoordList('123|456\n124|456')).toEqual([
      { x: 123, y: 456 },
      { x: 124, y: 456 },
    ]);
  });

  it('separa por vírgula ou ponto-e-vírgula', () => {
    expect(parseCoordList('123|456,124|456;125|456')).toEqual([
      { x: 123, y: 456 },
      { x: 124, y: 456 },
      { x: 125, y: 456 },
    ]);
  });

  it('ignora tokens inválidos', () => {
    expect(parseCoordList('abc 123|456 junk 999|999')).toEqual([
      { x: 123, y: 456 },
      { x: 999, y: 999 },
    ]);
  });

  it('remove duplicatas mantendo a primeira ocorrência e a ordem', () => {
    expect(parseCoordList('124|456 123|456 124|456 125|456')).toEqual([
      { x: 124, y: 456 },
      { x: 123, y: 456 },
      { x: 125, y: 456 },
    ]);
  });

  it('texto vazio ou só separadores resulta em lista vazia', () => {
    expect(parseCoordList('')).toEqual([]);
    expect(parseCoordList('   \n ,; ')).toEqual([]);
  });
});

describe('formatCoordList', () => {
  const coords = [
    { x: 123, y: 456 },
    { x: 124, y: 456 },
  ];

  it('formata single coord sem pad de zeros', () => {
    expect(formatCoord({ x: 123, y: 5 })).toBe('123|5');
  });

  it('formata lista com espaço', () => {
    expect(formatCoordList(coords, 'space')).toBe('123|456 124|456');
  });

  it('formata lista com quebra de linha', () => {
    expect(formatCoordList(coords, 'newline')).toBe('123|456\n124|456');
  });

  it('lista vazia resulta em string vazia', () => {
    expect(formatCoordList([], 'space')).toBe('');
  });
});

describe('continentOf', () => {
  it('calcula o continente TW', () => {
    expect(continentOf({ x: 535, y: 268 })).toBe(25);
    expect(continentOf({ x: 614, y: 379 })).toBe(36);
    expect(continentOf({ x: 0, y: 0 })).toBe(0);
    expect(continentOf({ x: 999, y: 999 })).toBe(99);
  });
});

describe('inAxesRange', () => {
  it('aceita coordenada dentro da faixa', () => {
    expect(inAxesRange({ x: 5, y: 5 }, { minX: 0, maxX: 10, minY: 0, maxY: 10 })).toBe(true);
  });

  it('rejeita quando um eixo fica fora', () => {
    expect(inAxesRange({ x: 15, y: 5 }, { maxX: 10 })).toBe(false);
    expect(inAxesRange({ x: 5, y: 15 }, { maxY: 10 })).toBe(false);
    expect(inAxesRange({ x: -1, y: 5 }, { minX: 0 })).toBe(false);
    expect(inAxesRange({ x: 5, y: -1 }, { minY: 0 })).toBe(false);
  });

  it('faixa vazia aceita tudo', () => {
    expect(inAxesRange({ x: 500, y: 500 }, {})).toBe(true);
  });
});