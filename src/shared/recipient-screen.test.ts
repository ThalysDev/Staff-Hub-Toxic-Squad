import { describe, expect, it } from 'vitest';
import {
  blockedRecipientGroups,
  buildNickIndex,
  screenRecipients,
  type ScreenedRecipient,
} from '../../src/shared/recipient-screen';
import type { DiplomacyRelations, WorldPlayer } from '../../src/shared/types';

const RELATIONS: DiplomacyRelations = {
  ownAllyId: 100,
  ownTag: 'TSC',
  enemies: [{ allyId: 200, tag: 'ENM', name: 'Inimigos' }],
  allies: [{ allyId: 300, tag: 'ALD', name: 'Aliados' }],
  naps: [{ allyId: 400, tag: 'NAP', name: 'NAP' }],
};

function player(id: number, name: string, allyId: number, points = 5000): WorldPlayer {
  return { id, name, allyId, villages: 5, points, rank: id };
}

const PLAYERS = [
  player(1, 'Líder TSC', 100),
  player(2, 'Douglas TW', 100),
  player(3, 'Ex-Membro', 200), // saiu da tribo → virou inimigo
  player(4, 'Amigo Al', 300),
  player(5, 'Paz NAP', 400),
  player(6, 'Lobo Solitário', 0),
];

const INDEX = buildNickIndex(PLAYERS);

function nickify(screened: readonly ScreenedRecipient[]): string[] {
  return screened.map((recipient) => recipient.nick);
}

describe('screenRecipients', () => {
  it('classifica própria tribo, inimigo, aliado, NAP e sem tribo', () => {
    const out = screenRecipients(['Líder TSC', 'Ex-Membro', 'Amigo Al', 'Paz NAP', 'Lobo Solitário'], INDEX, RELATIONS);
    expect(out.map((r) => r.status)).toEqual(['propria-tribo', 'inimigo', 'aliado', 'nap', 'sem-tribo']);
    expect(out[1]?.tribeTag).toBe('ENM');
    expect(out[0]?.tribeTag).toBe('TSC');
  });

  it('fold: acento/caixa do nick bate com o dump do mundo', () => {
    const out = screenRecipients(['líder tsc'], INDEX, RELATIONS);
    expect(out[0]?.status).toBe('propria-tribo');
  });

  it('nick inexistente no mundo = desconhecido (fail-closed, nunca inventa tribo)', () => {
    const out = screenRecipients(['Nao Existe'], INDEX, RELATIONS);
    expect(out[0]?.status).toBe('desconhecido');
    expect(out[0]?.tribeTag).toBeNull();
  });

  it('relações indisponíveis (null): TODO MUNDO vira desconhecido', () => {
    const out = screenRecipients(['Líder TSC', 'Ex-Membro'], buildNickIndex(PLAYERS), null);
    expect(out.every((r) => r.status === 'desconhecido')).toBe(true);
  });

  it('nicks duplicados: uma linha só; vazio é ignorado', () => {
    const out = screenRecipients(['Líder TSC', 'líder tsc', ''], INDEX, RELATIONS);
    expect(nickify(out)).toEqual(['Líder TSC']);
  });

  it('colisão de fold entre dois jogadores: mantém o de maior pontos', () => {
    const twins = [player(7, 'Gêmeo', 200, 100), player(8, 'Gêmeo', 100, 9000)];
    const out = screenRecipients(['gêmeo'], buildNickIndex(twins), RELATIONS);
    expect(out[0]?.status).toBe('propria-tribo'); // pontos 9000 vence o inimigo de 100
  });
});

describe('blockedRecipientGroups', () => {
  it('tudo própria tribo → null (fluxo segue sem atrito)', () => {
    const screened = screenRecipients(['Líder TSC', 'Douglas TW'], INDEX, RELATIONS);
    expect(blockedRecipientGroups(screened)).toBeNull();
  });

  it('ordem de gravidade: inimigo > desconhecido > sem-tribo', () => {
    const screened = screenRecipients(['Lobo Solitário', 'Nao Existe', 'Ex-Membro'], INDEX, RELATIONS);
    expect(blockedRecipientGroups(screened)).toEqual([
      { status: 'inimigo', nicks: ['Ex-Membro'] },
      { status: 'desconhecido', nicks: ['Nao Existe'] },
      { status: 'sem-tribo', nicks: ['Lobo Solitário'] },
    ]);
  });
});
