import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ParseError,
  parseAllyMembers,
  parseContracts,
  parseMembersDefense,
  parseMembersTroops,
  parseMemberSelector,
} from './ally-parsers';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/br142/${name}`, import.meta.url)), 'utf8');
}

describe('parseAllyMembers contra o fixture real BR142', () => {
  it('lê os 57 membros da tribo', () => {
    const { members } = parseAllyMembers(fixture('ally-members.html'));
    expect(members).toHaveLength(57);
  });

  it('primeiro membro (fundador) verificado à mão no HTML', () => {
    const { members } = parseAllyMembers(fixture('ally-members.html'));
    expect(members[0]).toEqual({
      playerId: 1618709,
      name: 'R O D R I G U E S',
      points: 10088381,
      villagesCount: 1002,
      inVacation: false,
    });
  });

  it('pontos com separador de milhar e aldeias de outros membros', () => {
    const { members } = parseAllyMembers(fixture('ally-members.html'));
    const evotikto = members.find((m) => m.playerId === 919417890);
    expect(evotikto).toMatchObject({ name: 'Evotikto', points: 9545278, villagesCount: 903 });
    const marezika = members.find((m) => m.playerId === 919876282);
    expect(marezika).toMatchObject({ points: 4772903, villagesCount: 441 });
  });

  it('modo de férias detectado (alexzera doidinho, no fixt. com ícone vacation.webp)', () => {
    const { members } = parseAllyMembers(fixture('ally-members.html'));
    const alexzera = members.find((m) => m.playerId === 919864891);
    expect(alexzera).toMatchObject({
      name: 'alexzera doidinho',
      points: 2989992,
      villagesCount: 298,
      inVacation: true,
    });
  });

  it('fail-closed: página sem a tabela de membros → ParseError', () => {
    expect(() => parseAllyMembers('<html><body></body></html>')).toThrow(ParseError);
    expect(() => parseAllyMembers(fixture('ally-contracts.html'))).toThrow(ParseError);
  });
});

describe('parseMemberSelector contra os fixtures reais BR142', () => {
  it('tropas: 57 opções, sem a placeholder "Selecionar membro"', () => {
    const { options } = parseMemberSelector(fixture('ally-members-troops.html'));
    expect(options).toHaveLength(57);
    expect(options[0]).toEqual({ playerId: 919045081, name: '- Spartacus' });
    expect(options[56]).toEqual({ playerId: 919478087, name: 'zulu19' });
    expect(options.some((o) => o.name === 'Selecionar membro')).toBe(false);
  });

  it('defesa: mesmas 57 opções', () => {
    const { options } = parseMemberSelector(fixture('ally-members-defense.html'));
    expect(options).toHaveLength(57);
    expect(options[0]).toEqual({ playerId: 919045081, name: '- Spartacus' });
  });

  it('fail-closed: sem o dropdown → ParseError', () => {
    expect(() => parseMemberSelector('<html></html>')).toThrow(ParseError);
  });
});

describe('parseMembersTroops contra o fixture real BR142', () => {
  it('lê a visão geral (linha = jogador) dos 57 membros', () => {
    const { players } = parseMembersTroops(fixture('ally-members-troops.html'));
    expect(players).toHaveLength(57);
  });

  it('linha do zulu19 verificada à mão no HTML', () => {
    const { players } = parseMembersTroops(fixture('ally-members-troops.html'));
    const zulu = players.find((p) => p.playerId === 919478087);
    expect(zulu).toEqual({
      playerId: 919478087,
      name: 'zulu19',
      points: 1507430,
      units: {
        spear: 299007,
        sword: 210406,
        axe: 353137,
        archer: 103507,
        spy: 103223,
        light: 171897,
        marcher: 29656,
        heavy: 51947,
        ram: 27065,
        catapult: 5052,
        knight: 10,
        snob: 11,
        militia: 0,
      },
      commandsCount: 91,
      incomingAttacksCount: 0,
    });
  });

  it('Zheiffadoor (2ª linha do fixture)', () => {
    const { players } = parseMembersTroops(fixture('ally-members-troops.html'));
    const zheiff = players.find((p) => p.playerId === 1823650);
    expect(zheiff).toMatchObject({ name: 'Zheiffadoor', points: 1084599 });
    expect(zheiff?.units.spear).toBe(330256);
    expect(zheiff?.units.sword).toBe(329924);
    expect(zheiff?.units.axe).toBe(208804);
  });

  it('todas as linhas trazem as 13 unidades na ordem canônica e comandos; "?" fica omitido', () => {
    const { players } = parseMembersTroops(fixture('ally-members-troops.html'));
    const unitKeys = [
      'spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher',
      'heavy', 'ram', 'catapult', 'knight', 'snob', 'militia',
    ];
    for (const player of players) {
      expect(Object.keys(player.units).sort()).toEqual([...unitKeys].sort());
      expect(typeof player.commandsCount).toBe('number');
    }
    // felipe.loku tem "?" (contagem oculta) na coluna "Ataques a chegar" no fixture
    const felipe = players.find((p) => p.playerId === 920018916);
    expect(felipe?.incomingAttacksCount).toBeUndefined();
    const zulu = players.find((p) => p.playerId === 919478087);
    expect(typeof zulu?.incomingAttacksCount).toBe('number');
  });

  it('fail-closed: sem a tabela de tropas → ParseError (fixture de defesa não tem tabela)', () => {
    expect(() => parseMembersTroops(fixture('ally-members-defense.html'))).toThrow(ParseError);
  });
});

describe('parseMembersDefense contra o fixture real BR142', () => {
  it('sem membro selecionado o BR142 não renderiza tabela → lista vazia (não é erro)', () => {
    const { players } = parseMembersDefense(fixture('ally-members-defense.html'));
    expect(players).toEqual([]);
  });
});

describe('parseContracts contra o fixture real BR142', () => {
  it('tribo própria: id 40 (game data) e "Toxic Squad Sul" no <h2>', () => {
    const contracts = parseContracts(fixture('ally-contracts.html'));
    expect(contracts.ownAllyId).toBe(40);
    expect(contracts.ownTag).toBe('Toxic Squad Sul');
  });

  it('7 aliados, 85 PNAs e 15 inimigos (contagens conferidas no HTML)', () => {
    const contracts = parseContracts(fixture('ally-contracts.html'));
    expect(contracts.allies).toHaveLength(7);
    expect(contracts.naps).toHaveLength(85);
    expect(contracts.enemies).toHaveLength(15);
  });

  it('primeiro/último de cada seção verificados à mão no HTML', () => {
    const contracts = parseContracts(fixture('ally-contracts.html'));
    expect(contracts.allies[0]).toEqual({ allyId: 1, tag: 'Winx', name: 'Winx' });
    expect(contracts.allies[6]).toEqual({ allyId: 699, tag: 'Cigane', name: 'Cigane' });
    expect(contracts.naps[0]).toEqual({ allyId: 136, tag: 'WHITE', name: 'WHITE' });
    expect(contracts.enemies[0]).toEqual({ allyId: 5, tag: 'TpS', name: 'TpS' });
    expect(contracts.enemies[14]).toEqual({ allyId: 1837, tag: 'Rebel', name: 'Rebel' });
  });

  it('fail-closed: sem a tabela de diplomacia → ParseError', () => {
    expect(() => parseContracts('<html></html>')).toThrow(ParseError);
    expect(() => parseContracts(fixture('ally-members.html'))).toThrow(ParseError);
  });
});