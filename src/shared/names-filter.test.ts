import { describe, expect, it } from 'vitest';
import { matchesName, nameSet, parsePlayerNames } from './names-filter';

describe('parsePlayerNames', () => {
  it('separa apenas por ponto e vírgula, preservando espaços internos dos nicks', () => {
    const { names, duplicatesRemoved } = parsePlayerNames('Jogador Um; Zé; outro');
    expect(names).toEqual(['Jogador Um', 'Zé', 'outro']);
    expect(duplicatesRemoved).toBe(0);
  });

  it('conta duplicatas removidas em vez de descartar silenciosamente', () => {
    const { names, duplicatesRemoved } = parsePlayerNames('Zé; Jogador Um; Zé; Zé');
    expect(names).toEqual(['Zé', 'Jogador Um']);
    expect(duplicatesRemoved).toBe(2);
  });

  it('retorna 0 nomes para entrada vazia ou lixo (só separadores/espaços)', () => {
    expect(parsePlayerNames('')).toEqual({ names: [], duplicatesRemoved: 0 });
    expect(parsePlayerNames(';;;')).toEqual({ names: [], duplicatesRemoved: 0 });
    expect(parsePlayerNames('   \t  ')).toEqual({ names: [], duplicatesRemoved: 0 });
  });

  it('não trata espaço, tab nem vírgula como separador interno do nick', () => {
    expect(parsePlayerNames('a,b;c').names).toEqual(['a,b', 'c']);
    expect(parsePlayerNames('Jogador Um\tDois; x').names).toEqual(['Jogador Um\tDois', 'x']);
  });

  it('dedupe ignora caixa e acentos, mantendo a primeira aparição', () => {
    const { names, duplicatesRemoved } = parsePlayerNames('João;joao');
    expect(names).toEqual(['João']);
    expect(duplicatesRemoved).toBe(1);
  });
});

describe('nameSet + matchesName', () => {
  it('faz matching fold: acento/caixa não separam ("JOÃO" bate com "Joao")', () => {
    const set = nameSet(['João']);
    expect(matchesName(set, 'JOÃO')).toBe(true);
    expect(matchesName(set, 'Joao')).toBe(true);
  });

  it('não dá match falso por prefixo ("zé" não bate com "zebra")', () => {
    const set = nameSet(['zé']);
    expect(matchesName(set, 'zebra')).toBe(false);
    expect(matchesName(set, 'Zé')).toBe(true);
  });

  it('set vazio nunca dá match', () => {
    expect(matchesName(nameSet([]), 'qualquer')).toBe(false);
  });
});
