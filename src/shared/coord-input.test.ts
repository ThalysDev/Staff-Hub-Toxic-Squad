import { describe, expect, it } from 'vitest';
import { coordCountLabel, normalizeCoordText } from './coord-input';

describe('normalizeCoordText', () => {
  it('divide massa bagunçada em \\r\\n, ;, vírgulas e descarta lixo entre coordenadas', () => {
    const result = normalizeCoordText('555|555\r\n444|444; 500|500\t666|666, ou isso aqui não é coord\n777|777');
    expect(result.coords).toEqual(['555|555', '444|444', '500|500', '666|666', '777|777']);
    expect(result.count).toBe(5);
    expect(result.invalidTokens).toBe(6); // "ou","isso","aqui","não","é","coord" → não-vazios inválidos
  });

  it('deduplica preservando a primeira ocorrência e conta as removidas', () => {
    const result = normalizeCoordText('100|100 200|200 100|100;300|300,100|100');
    expect(result.coords).toEqual(['100|100', '200|200', '300|300']);
    expect(result.duplicatesRemoved).toBe(2);
    expect(result.count).toBe(3);
  });

  it('display é a linha limpa única (join com espaço)', () => {
    const result = normalizeCoordText('10|20\n30|40\r50|60');
    expect(result.display).toBe('10|20 30|40 50|60');
  });

  it('vazio/sem coordenadas → count 0 sem lançar', () => {
    const empty = normalizeCoordText('');
    expect(empty).toMatchObject({ coords: [], display: '', count: 0, duplicatesRemoved: 0, invalidTokens: 0 });

    const onlyTrash = normalizeCoordText('   \t;;,\r\n nada aqui ,;');
    expect(onlyTrash.count).toBe(0);
    expect(onlyTrash.invalidTokens).toBeGreaterThan(0);
  });

  it('token quase válido não passa ("12|3456", "1234|5", "1-2")', () => {
    const result = normalizeCoordText('12|3456 1234|5 1-2 9|9');
    expect(result.coords).toEqual(['9|9']);
    expect(result.invalidTokens).toBe(3);
  });
});

describe('coordCountLabel', () => {
  it('base sem extras quando nada foi ignorado', () => {
    expect(coordCountLabel(normalizeCoordText('10|20 30|40'))).toBe('2 coordenadas reconhecidas');
  });

  it('singulariza quando há só 1', () => {
    expect(coordCountLabel(normalizeCoordText('10|20'))).toBe('1 coordenada reconhecida');
  });

  it('inclui extras de duplicadas e inválidos quando houver', () => {
    const n = normalizeCoordText('10|20 10|20 lixo 10|20 !!!');
    expect(coordCountLabel(n)).toBe(
      `1 coordenada reconhecida · ${n.duplicatesRemoved} duplicadas ignoradas · ${n.invalidTokens} trechos inválidos ignorados`,
    );
    expect(n.duplicatesRemoved).toBe(2);
    expect(n.invalidTokens).toBe(2);
  });
});
