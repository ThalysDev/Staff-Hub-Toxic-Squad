import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseWorldConfigXml } from '../world-config';
import {
  ParseError,
  parseMapAllyTxt,
  parseMapPlayerTxt,
  parseMapVillageTxt,
  parseUnitInfoXml,
} from './world-parsers';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/br142/${name}`, import.meta.url)), 'utf8');
}

describe('parseMapVillageTxt', () => {
  it('parseia registros com nome URL-encoded (exemplo canônico do dump)', () => {
    const villages = parseMapVillageTxt('1,Aldeia+de+b%C3%A1rbaros,506,473,919335416,10327,0');
    expect(villages).toEqual([
      { id: 1, name: 'Aldeia de bárbaros', x: 506, y: 473, playerId: 919335416, allyId: 0, points: 10327, bonus: 0 },
    ]);
  });

  it('aceita CRLF e ignora linhas em branco', () => {
    const text = '1,A,0,0,0,100,0\r\n\r\n2,B,1,1,7,200,1\r\n';
    expect(parseMapVillageTxt(text)).toHaveLength(2);
    expect(parseMapVillageTxt(text)[1]).toMatchObject({ id: 2, x: 1, y: 1, points: 200, bonus: 1 });
  });

  it('texto vazio → lista vazia', () => {
    expect(parseMapVillageTxt('')).toEqual([]);
  });

  it('número de campos errado → ParseError com a linha', () => {
    expect(() => parseMapVillageTxt('1,A,0,0,0,100')).toThrow(ParseError);
    expect(() => parseMapVillageTxt('1,A,0,0,0,100')).toThrow(/ao menos 7 campos/);
    expect(() => parseMapVillageTxt('1,A,0,0,0,100')).toThrow(/Linha 1/);
  });

  it('campo não numérico → ParseError apontando o campo', () => {
    expect(() => parseMapVillageTxt('1,A,abc,0,0,100,0')).toThrow(/campo "x" não é um inteiro válido \("abc"\)/);
  });

  it('nome com percent-encoding quebrado → ParseError (fail-closed)', () => {
    expect(() => parseMapVillageTxt('1,100%zz,0,0,0,100,0')).toThrow(ParseError);
    expect(() => parseMapVillageTxt('1,100%zz,0,0,0,100,0')).toThrow(/percent-encoding inválido/);
  });
});

describe('parseMapPlayerTxt', () => {
  it('parseia id,nome,allyId,aldeias,pontos,rank', () => {
    const players = parseMapPlayerTxt('1,Jogador+A,5,3,1200,42');
    expect(players).toEqual([{ id: 1, name: 'Jogador A', allyId: 5, villages: 3, points: 1200, rank: 42 }]);
  });

  it('número de campos errado → ParseError com a linha', () => {
    expect(() => parseMapPlayerTxt('1,Jogador+A,5,3,1200')).toThrow(/ao menos 6 campos/);
  });
});

describe('parseMapAllyTxt', () => {
  it('parseia id,nome,tag,membros,aldeias,pontos,rank', () => {
    const allies = parseMapAllyTxt('2,Tribo+B,Toxic,15,80,25000,3');
    expect(allies).toEqual([
      { id: 2, name: 'Tribo B', tag: 'Toxic', members: 15, villages: 80, points: 25000, rank: 3 },
    ]);
  });

  it('poucos campos → ParseError; 8 campos reais (com total) → rank no fim', () => {
    expect(() => parseMapAllyTxt('2,Tribo+B,Toxic,15,80')).toThrow(/ao menos 7 campos/);
    const real = parseMapAllyTxt('40,Toxic+Squad+Sul,Toxic%21,57,15747,128211225,151059406,3');
    expect(real[0]).toMatchObject({ id: 40, tag: 'Toxic!', rank: 3 });
  });
});

describe('parseUnitInfoXml', () => {
  it('parseia o fixture real BR142 com as 13 unidades', () => {
    const units = parseUnitInfoXml(fixture('unit-info.xml'));
    expect(Object.keys(units)).toHaveLength(13);
    expect(units.snob).toEqual({
      speed: 31.111111111111,
      pop: 100,
      attack: 30,
      defense: 100,
      carry: 0,
    });
    expect(units.spear).toEqual({ speed: 16, pop: 1, attack: 10, defense: 15, carry: 25 });
    expect(units.archer).toMatchObject({ speed: 16, pop: 1, defense: 50 });
    expect(units.militia).toMatchObject({ speed: 0.016666666666667, pop: 0, carry: 0 });
  });

  it('unidade ausente → ParseError', () => {
    const xml = fixture('unit-info.xml').replace(/<snob>[\s\S]*?<\/snob>/, '');
    expect(() => parseUnitInfoXml(xml)).toThrow(/Unidade "snob": bloco <snob> ausente/);
  });

  it('campo ausente dentro de uma unidade → ParseError', () => {
    const xml = fixture('unit-info.xml').replace(/<speed>31\.111111111111<\/speed>/, '');
    expect(() => parseUnitInfoXml(xml)).toThrow(/Unidade "snob": campo <speed> ausente/);
  });

  it('campo não numérico → ParseError', () => {
    const xml = fixture('unit-info.xml').replace(/<attack>30<\/attack>/, '<attack>abc</attack>');
    expect(() => parseUnitInfoXml(xml)).toThrow(/Unidade "snob": campo <attack> não é um número válido/);
  });
});

describe('parseWorldConfigXml contra o fixture real BR142', () => {
  it('lê speed 1.5, unitSpeed 0.75 e moral ativo (fixture: <moral>2</moral>)', () => {
    const config = parseWorldConfigXml('br142', fixture('world-config-xml.html'));
    expect(config.speed).toBe(1.5);
    expect(config.unitSpeed).toBe(0.75);
    expect(config.moralActive).toBe(true);
  });
});