// Testes do parser de habilidades do Paladino (Onda 5, Parte A): lista de
// prioridades, leitura das linhas da Estátua (contrato data-skill) e a escolha
// fail-closed da habilidade a educar.
import { describe, expect, it } from 'vitest';

import {
  normalizeSkillKey,
  parsePaladinSkills,
  parseSkillPriorityList,
  pickSkillToEducate,
  type PaladinSkill,
} from './paladino-skills';

function skill(overrides: Partial<PaladinSkill> = {}): PaladinSkill {
  return { key: 'cavalry', label: 'Cavalaria', level: 1, maxLevel: 5, known: true, ...overrides };
}

const ESTATUA = `
<table>
  <tr data-skill="cavalaria" data-skill-level="2" data-skill-max="5">
    <td>Nível 2</td>
    <td><a href="game.php?village=1&amp;screen=statue&amp;action=educate&amp;skill=cavalry&amp;h=abc">Educar</a></td>
  </tr>
  <tr data-skill="medicina" data-skill-level="5" data-skill-max="5">
    <td>Nível 5</td>
    <td><a href="game.php?village=1&amp;screen=statue&amp;action=educate&amp;skill=medicine&amp;h=abc">Educar</a></td>
  </tr>
</table>`;

describe('parseSkillPriorityList', () => {
  it('normaliza a lista pt-BR para as chaves canônicas, na ordem e sem repetição', () => {
    expect(parseSkillPriorityList('cavalaria, medicina; cavalaria').keys).toEqual(['cavalry', 'medicine']);
    expect(parseSkillPriorityList('fortificação\nCerco').keys).toEqual(['fortification', 'siege']);
  });

  it('separa tokens desconhecidos em vez de adivinhar a habilidade', () => {
    const prioridade = parseSkillPriorityList('cavalaria, força bruta, medicina');

    expect(prioridade.keys).toEqual(['cavalry', 'medicine']);
    expect(prioridade.invalid).toEqual(['força bruta']);
  });

  it('lista vazia devolve nada', () => {
    expect(parseSkillPriorityList('  ,  ')).toEqual({ keys: [], invalid: [] });
  });
});

describe('normalizeSkillKey', () => {
  it('aceita rótulo pt-BR (com/sem acento), alias e a própria chave', () => {
    expect(normalizeSkillKey('Cavalaria')).toBe('cavalry');
    expect(normalizeSkillKey('fortificacao')).toBe('fortification');
    expect(normalizeSkillKey('fortification')).toBe('fortification');
    expect(normalizeSkillKey('cavalry')).toBe('cavalry');
  });

  it('devolve null para o que não está no catálogo', () => {
    expect(normalizeSkillKey('liderança')).toBeNull();
    expect(normalizeSkillKey('   ')).toBeNull();
  });
});

describe('parsePaladinSkills', () => {
  it('lê linha marcada: nível, teto e caminho canônico de educar', () => {
    const skills = parsePaladinSkills(ESTATUA);

    expect(skills).toHaveLength(2);
    expect(skills[0]).toMatchObject({ key: 'cavalry', label: 'cavalaria', level: 2, maxLevel: 5, known: true });
    expect(skills[0]?.educatePath).toBe('game.php?village=1&screen=statue&action=educate&skill=cavalry&h=abc');
    expect(skills[1]).toMatchObject({ key: 'medicine', level: 5, maxLevel: 5 });
  });

  it('rótulo fora do catálogo entra como desconhecida (chave em slug), nível lido do texto', () => {
    const skills = parsePaladinSkills('<tr data-skill="Liderança de tropas"><td>Nível 3</td></tr>');

    expect(skills).toEqual([
      {
        key: 'lideranca-de-tropas',
        label: 'Liderança de tropas',
        level: 3,
        maxLevel: 0,
        known: false,
      },
    ]);
  });

  it('ignora a página sem o marcador data-skill (fail-closed)', () => {
    expect(parsePaladinSkills('<div><span>Cavalaria nível 2</span></div>')).toEqual([]);
  });
});

describe('pickSkillToEducate', () => {
  it('escolhe a primeira habilidade educável da ordem de prioridade', () => {
    const skills = parsePaladinSkills(ESTATUA);

    expect(pickSkillToEducate(skills, ['cavalry', 'medicine'])).toMatchObject({
      kind: 'educar',
      skill: { key: 'cavalry' },
    });
    expect(pickSkillToEducate(skills, ['medicine'])).toMatchObject({ kind: 'nada' });
  });

  it('pula habilidade no teto e habilidade sem ação de educar exposta', () => {
    const skills = [skill({ key: 'cavalry', level: 5, maxLevel: 5 }), skill({ key: 'medicine' })];

    expect(pickSkillToEducate(skills, ['cavalry', 'medicine']).kind).toBe('nada');
    expect(pickSkillToEducate([skill({ educatePath: 'game.php?action=educate' })], ['cavalry'])).toMatchObject({
      kind: 'educar',
    });
  });

  it('explica o motivo quando não há nada a educar', () => {
    const semHabilidades = pickSkillToEducate([], ['cavalry']);
    const semPrioridade = pickSkillToEducate([skill()], []);
    const nadaEducavel = pickSkillToEducate([skill()], ['cavalry']);

    expect(semHabilidades).toMatchObject({ kind: 'nada' });
    expect(semHabilidades.kind === 'nada' ? semHabilidades.reason : '').toContain('Nenhuma habilidade reconhecida');
    expect(semPrioridade.kind === 'nada' ? semPrioridade.reason : '').toContain('lista de prioridades');
    expect(nadaEducavel.kind === 'nada' ? nadaEducavel.reason : '').toContain('educável');
  });
});
