// Partes PURAS do plugin Gerador de OPs (ambiente node, sem DOM): parse do
// dump público /map (village.txt e player.txt) e origens explícitas do
// originsText — mesmas âncoras usadas pelo ciclo.
import { describe, expect, it } from 'vitest';
import {
  opGeneratorSettingsSchema,
  originsFromText,
  parsePlayerVillages,
  resolvePlayerIdFromPlayerTxt,
} from './op-generator';

const VILLAGE_TXT = [
  '238755,Aldeia do Líder,534,551,777,12054,0', // própria (player 777)
  '238756,Vila,Fronteira,535,551,777,9000,0', // própria com VÍRGULA no nome
  '238757,Bárbaro 001,536,552,0,26,0', // bárbara (player 0) — ignorada
  '238758,Aldeia Aliada,537,553,888,9726,0', // outro jogador — ignorada
  'linha-malformada',
  '',
].join('\n');

describe('parsePlayerVillages', () => {
  it('devolve só as aldeias do jogador com coordenadas normalizadas', () => {
    expect(parsePlayerVillages(VILLAGE_TXT, '777')).toEqual([
      { villageId: '238755', coordinate: '534|551' },
      { villageId: '238756', coordinate: '535|551' },
    ]);
  });

  it('tolera o prefixo n do id de jogador e recusa ids vazios/zero', () => {
    expect(parsePlayerVillages(VILLAGE_TXT, 'n777')).toEqual([
      { villageId: '238755', coordinate: '534|551' },
      { villageId: '238756', coordinate: '535|551' },
    ]);
    expect(parsePlayerVillages(VILLAGE_TXT, '')).toEqual([]);
    expect(parsePlayerVillages(VILLAGE_TXT, '0')).toEqual([]);
  });

  it('ignora linhas malformadas e coordenadas fora do domínio (0..999)', () => {
    const txt = ['1,Ok,1,2,777,100,0', '2,Ruim,1000,2,777,100,0', '3,Ruim,x|y,2,777,100,0'].join('\n');
    expect(parsePlayerVillages(txt, '777')).toEqual([{ villageId: '1', coordinate: '1|2' }]);
  });
});

describe('resolvePlayerIdFromPlayerTxt', () => {
  it('acha o id pelo nome exato (formato id,nome,tribo,pontos,cidades)', () => {
    const playerTxt = ['777,Líder,42,12054,25', '888,Outro,7,9726,40'].join('\n');
    expect(resolvePlayerIdFromPlayerTxt(playerTxt, 'Líder')).toBe('777');
    expect(resolvePlayerIdFromPlayerTxt(playerTxt, ' não existe ')).toBeUndefined();
    expect(resolvePlayerIdFromPlayerTxt(playerTxt, '')).toBeUndefined();
  });
});

describe('originsFromText', () => {
  it('parseia coordenadas por linha com ids estáveis (linhas ruins ignoradas)', () => {
    expect(originsFromText('500|500\nabc\n501|499\n500|500')).toEqual([
      { villageId: 'origem-1', coordinate: '500|500' },
      { villageId: 'origem-2', coordinate: '501|499' },
    ]);
    expect(originsFromText('sem coordenada aqui')).toEqual([]);
  });
});

describe('opGeneratorSettingsSchema', () => {
  it('nascimento por padrão: sem entradas e sem origens explícitas', () => {
    const settings = opGeneratorSettingsSchema.parse({});
    expect(settings.entries).toEqual([]);
    expect(settings.originsText).toBe('');
  });

  it('aplica defaults por entrada e normaliza groupId vazio só no ciclo (porta fiel)', () => {
    const settings = opGeneratorSettingsSchema.parse({ entries: [{ targetsText: '500|500' }] });
    expect(settings.entries[0]).toEqual({
      tag: 'OP',
      commandKind: 'attack',
      criterion: 'distribuir',
      targetsText: '500|500',
      maximumDistanceFields: null,
      groupId: null,
    });
  });
});
