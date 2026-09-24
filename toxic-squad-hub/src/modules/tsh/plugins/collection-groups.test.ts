// Regras por grupo da Coleta (v3.6.0) — cartões para leigos.
import { describe, expect, it } from 'vitest';
import { levelForMode, profileByVillage, profilesFromLegacy, profileSummary, readProfiles } from './collection-groups';

describe('regras por grupo da Coleta', () => {
  it('modo → nível (Não coletar = null)', () => {
    expect(levelForMode('equilibrada')).toBe('equilibrada');
    expect(levelForMode('extrema')).toBe(4);
    expect(levelForMode('pular')).toBeNull();
    expect(levelForMode('geral')).toBeUndefined();
  });

  it('a primeira regra da lista vence para aldeia em dois grupos', () => {
    const a = { groupId: 1, groupName: 'Ataque', mode: 'pular' as const, hoursOff: null, hoursDef: null, skipUnits: null };
    const b = { groupId: 2, groupName: 'Todos', mode: 'grande' as const, hoursOff: 2, hoursDef: null, skipUnits: null };
    const map = profileByVillage([a, b], new Map([[1, [10]], [2, [10, 20]]]));
    expect(map.get('10')?.groupId).toBe(1);
    expect(map.get('20')?.groupId).toBe(2);
  });

  it('frase do cartão em português claro', () => {
    expect(profileSummary({ groupId: 2, groupName: 'Defesa', mode: 'extrema', hoursOff: null, hoursDef: 6 })).toBe(
      'Aldeias de "Defesa": só a Extrema Coleta, voltam em até: ofensivas como o geral, defensivas 6 h, tropas iguais às gerais.',
    );
    expect(profileSummary({ groupId: 3, groupName: '', mode: 'pular', hoursOff: null, hoursDef: null })).toBe('Aldeias de "grupo 3" NÃO coletam.');
  });

  it('formato antigo vira cartões; lista salva inválida é filtrada', () => {
    expect(profilesFromLegacy('182608:grande:200:50')).toEqual([
      { groupId: 182608, groupName: '', mode: 'grande', hoursOff: null, hoursDef: null, skipUnits: null },
    ]);
    expect(profilesFromLegacy('lixo')).toEqual([]);
    expect(readProfiles([{ groupId: 5, mode: 'media' }, { groupId: -1 }, { groupId: 5, mode: 'pular' }, 'x'])).toHaveLength(1);
  });
});
