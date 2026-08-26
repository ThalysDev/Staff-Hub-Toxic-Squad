import { describe, expect, it } from 'vitest';
import {
  GROUPS_LIMIT,
  type GroupEntry,
  type GroupSaveInput,
  capGroups,
  createGroupEntry,
  findGroupById,
  groupNotFoundError,
  groupPayloadForExport,
  groupToOriginsText,
  groupToTargetsText,
  normalizeGroupInput,
  parseGroupPayload,
  sortNewestFirst,
  updateGroupEntry,
  upsertGroup,
} from './groups-rules';

const VALID_INPUT: GroupSaveInput = {
  nome: 'Origens Norte',
  mundo: 'BR142',
  autor: ' Spartacus ',
  papel: 'origem',
  coords: ['402|303', '512|498', '555|444'],
  perPlayer: [
    { playerName: 'Joao', fulls: 2, semis: 0, coords: ['402|303', '512|498'] },
    { playerName: 'Maria', fulls: 1, semis: 1, coords: ['555|444'] },
  ],
  criterio: ' Fulls com >= 1 nobre no SG_2 ',
};

function entry(id: string, criadoEm: string): GroupEntry {
  return { ...normalizeGroupInput(VALID_INPUT), id, criadoEm };
}

describe('normalizeGroupInput (fail-closed)', () => {
  it('entrada válida completa é normalizada (trim, mundo minúsculo, cópia de arrays)', () => {
    const normalized = normalizeGroupInput(VALID_INPUT);
    expect(normalized).toEqual({
      nome: 'Origens Norte',
      mundo: 'br142',
      autor: 'Spartacus',
      papel: 'origem',
      coords: ['402|303', '512|498', '555|444'],
      perPlayer: [
        { playerName: 'Joao', fulls: 2, semis: 0, coords: ['402|303', '512|498'] },
        { playerName: 'Maria', fulls: 1, semis: 1, coords: ['555|444'] },
      ],
      criterio: 'Fulls com >= 1 nobre no SG_2',
    });
    // entrada original intocada
    expect(VALID_INPUT.mundo).toBe('BR142');
  });

  it('criterio vazio/só espaços é aceito como string vazia', () => {
    expect(normalizeGroupInput({ ...VALID_INPUT, criterio: '' }).criterio).toBe('');
    expect(normalizeGroupInput({ ...VALID_INPUT, criterio: '   ' }).criterio).toBe('');
  });

  it('nome inválido lança erro PT-BR', () => {
    expect(() => normalizeGroupInput({ ...VALID_INPUT, nome: '   ' })).toThrow(/Nome do grupo/);
    expect(() => normalizeGroupInput({ ...VALID_INPUT, nome: 'x'.repeat(61) })).toThrow(/Nome do grupo/);
  });

  it('mundo fora do formato br+número lança erro PT-BR (≥10 casos de campo inválido)', () => {
    expect(() => normalizeGroupInput({ ...VALID_INPUT, mundo: '' })).toThrow(/Mundo inválido/);
    expect(() => normalizeGroupInput({ ...VALID_INPUT, mundo: 'br' })).toThrow(/Mundo inválido/);
    expect(() => normalizeGroupInput({ ...VALID_INPUT, mundo: 'us142' })).toThrow(/Mundo inválido/);
    expect(() => normalizeGroupInput({ ...VALID_INPUT, mundo: 'br142x' })).toThrow(/Mundo inválido/);
    expect(() => normalizeGroupInput({ ...VALID_INPUT, mundo: 'br12345' })).toThrow(/Mundo inválido/);
  });

  it('autor vazio/longo demais lança erro PT-BR', () => {
    expect(() => normalizeGroupInput({ ...VALID_INPUT, autor: ' ' })).toThrow(/Autor/);
    expect(() => normalizeGroupInput({ ...VALID_INPUT, autor: 'x'.repeat(41) })).toThrow(/Autor/);
  });

  it('papel fora do enum lança erro PT-BR', () => {
    expect(() => normalizeGroupInput({ ...VALID_INPUT, papel: 'rebelde' as never })).toThrow(/Papel inválido/);
  });

  it('coords: vazio, formato ruim ou acima de 2000 distintas lança erro', () => {
    expect(() => normalizeGroupInput({ ...VALID_INPUT, coords: [] })).toThrow(/1 a 2000 coordenadas/);
    expect(() => normalizeGroupInput({ ...VALID_INPUT, coords: ['402|303 ', 'abc'] })).toThrow(/Coordenada fora do formato.*"abc"/);
    expect(() => normalizeGroupInput({ ...VALID_INPUT, coords: ['402|3033'] })).toThrow(/Coordenada fora do formato/);
    const demais: string[] = [];
    for (let i = 0; i < 2001; i++) demais.push(`${Math.floor(i / 1000)}|${i % 1000}`);
    expect(() => normalizeGroupInput({ ...VALID_INPUT, coords: demais })).toThrow(/1 a 2000 coordenadas.*2001/);
  });

  it('dedupe de coords preserva a ordem da primeira ocorrência', () => {
    const normalized = normalizeGroupInput({
      ...VALID_INPUT,
      coords: ['402|303', '512|498', '402|303', ' 555|444 ', '512|498'],
    });
    expect(normalized.coords).toEqual(['402|303', '512|498', '555|444']);
  });

  it('perPlayer: nick curto/longo lança erro citando o nick', () => {
    expect(() =>
      normalizeGroupInput({ ...VALID_INPUT, perPlayer: [{ playerName: 'A', fulls: 1, semis: 0, coords: ['402|303'] }] }),
    ).toThrow(/Nick do jogador/);
    expect(() =>
      normalizeGroupInput({ ...VALID_INPUT, perPlayer: [{ playerName: 'x'.repeat(41), fulls: 1, semis: 0, coords: ['402|303'] }] }),
    ).toThrow(/Nick do jogador/);
  });

  it('perPlayer: fulls/semis negativos ou não inteiros lançam erro citando o jogador', () => {
    expect(() =>
      normalizeGroupInput({ ...VALID_INPUT, perPlayer: [{ playerName: 'Joao', fulls: -1, semis: 0, coords: ['402|303'] }] }),
    ).toThrow(/fulls do jogador "Joao"/);
    expect(() =>
      normalizeGroupInput({ ...VALID_INPUT, perPlayer: [{ playerName: 'Maria', fulls: 1, semis: 1.5, coords: ['555|444'] }] }),
    ).toThrow(/semis do jogador "Maria"/);
  });

  it('perPlayer: coord fora das coords do grupo lança erro citando jogador e coord', () => {
    expect(() =>
      normalizeGroupInput({ ...VALID_INPUT, perPlayer: [{ playerName: 'Joao', fulls: 1, semis: 0, coords: ['700|500'] }] }),
    ).toThrow(/Coordenada 700\|500 do jogador "Joao" não pertence/);
    expect(() =>
      normalizeGroupInput({ ...VALID_INPUT, perPlayer: [{ playerName: 'Joao', fulls: 1, semis: 0, coords: ['alfinete'] }] }),
    ).toThrow(/fora do formato \(use x\|y\)/);
  });

  it('criterio acima de 200 caracteres lança erro PT-BR', () => {
    expect(() => normalizeGroupInput({ ...VALID_INPUT, criterio: 'c'.repeat(201) })).toThrow(/Critério longo demais/);
  });
});

describe('create/update/upsert/find/ordenação', () => {
  it('createGroupEntry monta a entrada com id/criadoEm dados e copia os arrays', () => {
    const data = normalizeGroupInput(VALID_INPUT);
    const created = createGroupEntry(data, 'id-1', '2026-01-01T10:00:00.000Z');
    expect(created.id).toBe('id-1');
    expect(created.criadoEm).toBe('2026-01-01T10:00:00.000Z');
    expect(created.nome).toBe('Origens Norte');
    data.coords.push('999|999'); // mutação do input NÃO vaza para a entrada
    expect(created.coords).toEqual(['402|303', '512|498', '555|444']);
  });

  it('updateGroupEntry substitui conteúdo e PRESERVA id/criadoEm', () => {
    const existing = entry('g-1', '2025-06-01T08:00:00.000Z');
    const updated = updateGroupEntry(existing, normalizeGroupInput({ ...VALID_INPUT, nome: ' Retomada ', papel: 'alvo' }));
    expect(updated.id).toBe('g-1');
    expect(updated.criadoEm).toBe('2025-06-01T08:00:00.000Z');
    expect(updated.nome).toBe('Retomada');
    expect(updated.papel).toBe('alvo');
    expect(existing.nome).toBe('Origens Norte'); // original não mutado
  });

  it('upsertGroup insere nova e substitui pelo id, sem mutar o array', () => {
    const a = entry('a', '2025-01-01T00:00:00.000Z');
    const b = entry('b', '2025-01-02T00:00:00.000Z');
    const inserted = upsertGroup([a], b);
    expect(inserted).toHaveLength(2);
    const renamed = { ...b, nome: 'Grupo B editado' };
    const replaced = upsertGroup(inserted, renamed);
    expect(replaced).toHaveLength(2);
    expect(replaced.find((group) => group.id === 'b')?.nome).toBe('Grupo B editado');
    expect(a).toEqual(entry('a', '2025-01-01T00:00:00.000Z'));
  });

  it('capGroups: acima do limite remove os mais antigos por criadoEm, mas NUNCA o salvo', () => {
    const groups: GroupEntry[] = [];
    for (let i = 0; i < GROUPS_LIMIT + 2; i++) {
      groups.push(entry(`g-${String(i).padStart(3, '0')}`, new Date(Date.UTC(2025, 0, 1 + i)).toISOString()));
    }
    const keptId = 'g-000'; // a mais ANTIGA é justamente a que está sendo salva agora
    const savedAgain = { ...entry(keptId, groups[0]!.criadoEm), nome: 'Grupo salvo agora' };
    const capped = capGroups([...groups, savedAgain], keptId);
    expect(capped).toHaveLength(GROUPS_LIMIT);
    expect(capped.some((group) => group.id === keptId)).toBe(true);
    // as 3 mais antigas restantes caem fora — o salvo é preservado mesmo sendo o mais antigo
    for (let i = 1; i <= 3; i++) {
      expect(capped.some((group) => group.id === `g-${String(i).padStart(3, '0')}`)).toBe(false);
    }
    expect(capped.some((group) => group.id === 'g-101')).toBe(true);
  });

  it('sortNewestFirst ordena criadoEm desc e findGroupById/localiza (ou não)', () => {
    const groups = [entry('a', '2025-03-01T00:00:00.000Z'), entry('b', '2025-01-01T00:00:00.000Z'), entry('c', '2025-06-01T00:00:00.000Z')];
    expect(sortNewestFirst(groups).map((group) => group.id)).toEqual(['c', 'a', 'b']);
    expect(groups.map((group) => group.id)).toEqual(['a', 'b', 'c']); // original intocado
    expect(findGroupById(groups, 'b')?.id).toBe('b');
    expect(findGroupById(groups, 'z')).toBeUndefined();
    expect(groupNotFoundError('z')).toBeInstanceOf(Error);
    expect(groupNotFoundError('z').message).toContain('(id=z)');
  });
});

describe('textos coláveis (formato SG_4)', () => {
  it('groupToOriginsText gera linhas "nick;nroFulls;coordenadas"', () => {
    const group = entry('g-9', '2026-01-01T00:00:00.000Z');
    expect(groupToOriginsText(group)).toBe(['Joao;2;402|303 512|498', 'Maria;1;555|444'].join('\n'));
  });

  it('groupToTargetsText devolve todas as coords, uma por linha', () => {
    const group = entry('g-9', '2026-01-01T00:00:00.000Z');
    expect(groupToTargetsText(group)).toBe(['402|303', '512|498', '555|444'].join('\n'));
  });
});

describe('payload export → import (ida-e-volta)', () => {
  it('export gera JSON boninho com app/kind e o import recupera a MESMA entrada', () => {
    const group = entry('g-1', '2026-03-04T05:06:07.000Z');
    const payload = groupPayloadForExport(group);
    expect(payload.split('\n')[0]).toBe('{');
    const parsedJson = JSON.parse(payload) as Record<string, unknown>;
    expect(parsedJson['app']).toBe('staff-hub');
    expect(parsedJson['kind']).toBe('group');
    expect(parseGroupPayload(parsedJson)).toEqual(group);
  });

  it('wrapper {groups:[um]} também importa (com payload exportado dentro)', () => {
    const group = entry('g-2', '2026-05-05T05:05:05.000Z');
    const imported = parseGroupPayload({ groups: [JSON.parse(groupPayloadForExport(group))] });
    expect(imported).toEqual(group);
  });

  it('sem id → id novo gerado; criadoEm ISO válido é preservado; inválido recebe agora', () => {
    const base = entry('g-3', '2026-02-02T02:02:02.000Z');
    const semId = parseGroupPayload({ ...base, id: '' });
    expect(semId.id).not.toBe('g-3');
    expect(semId.id).toMatch(/[0-9a-f-]{36}/);
    expect(semId.criadoEm).toBe('2026-02-02T02:02:02.000Z');

    const criadoEmInvalido = parseGroupPayload({ ...base, id: 'outro', criadoEm: 'ontem' });
    expect(criadoEmInvalido.criadoEm).not.toBe('ontem');
    expect(Number.isNaN(Date.parse(criadoEmInvalido.criadoEm))).toBe(false);
  });

  it('payload lixo lança erro PT-BR fail-closed (≥6 casos)', () => {
    expect(() => parseGroupPayload(null)).toThrow(/Arquivo de grupo inválido/);
    expect(() => parseGroupPayload('não sou json')).toThrow(/esperado um objeto JSON/);
    expect(() => parseGroupPayload([])).toThrow(/esperado um objeto JSON/);
    expect(() => parseGroupPayload({})).toThrow(/campo "nome do grupo"/);
    expect(() => parseGroupPayload({ ...entry('g-4', '2026-01-01T00:00:00.000Z'), papel: 'sem-papel' })).toThrow(/Papel inválido/);
    expect(() => parseGroupPayload({ groups: [] })).toThrow(/exatamente 1 grupo/);
    expect(() => parseGroupPayload({ groups: [entry('a', '2026-01-01T00:00:00.000Z'), entry('b', '2026-01-02T00:00:00.000Z')] })).toThrow(/exatamente 1 grupo/);
    expect(() => parseGroupPayload({ groups: ['lixo'] })).toThrow(/não é um objeto de grupo/);
    expect(() =>
      parseGroupPayload({ ...entry('g-5', '2026-01-01T00:00:00.000Z'), coords: [{ nao: 'sou coord' }] }),
    ).toThrow(/campo "coordenada"/);
  });
});
