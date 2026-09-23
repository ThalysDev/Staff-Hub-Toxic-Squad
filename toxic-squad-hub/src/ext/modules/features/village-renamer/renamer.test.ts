// Testes da engine pura do Renomeador de Aldeias (Onda 5, Parte A): tokens,
// validação de template, continente K, numeração (por continente/geral),
// idempotência, truncamento e o parser do form canônico de renomeação.
import { describe, expect, it } from 'vitest';

import {
  buildVillageName,
  continentLabel,
  continentOf,
  planVillageRenames,
  RENAME_MAX_NAME_LENGTH,
  validateRenameTemplate,
  type RenameVillage,
} from './renamer';
import { parseVillageRenameRequest } from '../../../../modules/tsh/plugins/renomeador-aldeias';

function village(overrides: Partial<RenameVillage> = {}): RenameVillage {
  return { id: '1', name: 'Aldeia', x: 10, y: 20, points: 1000, ...overrides };
}

const OPTIONS = {
  template: '{numero} {coord}',
  texto: '',
  padding: 2,
  inicio: 1,
  numbering: 'continente' as const,
};

describe('buildVillageName (tokens)', () => {
  it('substitui todos os tokens com o padding do {numero}', () => {
    expect(
      buildVillageName(
        '{numero} {coord} {pontos} {texto}',
        { numero: 7, x: 534, y: 551, pontos: 12345, texto: 'Toxic' },
        3,
      ),
    ).toBe('007 534|551 12345 Toxic');
  });

  it('{k} usa o continente e padding fora da faixa é grampeado (1..6)', () => {
    expect(buildVillageName('{k}', { numero: 1, x: 312, y: 456, pontos: 0, texto: '' }, 2)).toBe('K45');
    expect(buildVillageName('{numero}', { numero: 4, x: 0, y: 0, pontos: 0, texto: '' }, 99)).toBe('000004');
  });

  it('continente segue a convenção coluna/linha e coordenada inválida vira K??', () => {
    expect(continentOf(0, 0)).toBe(11);
    expect(continentOf(150, 20)).toBe(21);
    expect(continentOf(999, 999)).toBe(110);
    expect(continentLabel(Number.NaN, 10)).toBe('K??');
    expect(continentLabel(300, 400)).toBe('K45');
  });
});

describe('validateRenameTemplate', () => {
  it('recusa template vazio', () => {
    expect(validateRenameTemplate('   ')).toContain('Informe um template');
  });

  it('recusa token desconhecido e chave aberta', () => {
    expect(validateRenameTemplate('{numero} {aldeia}')).toContain('Token desconhecido');
    expect(validateRenameTemplate('{numero} {coord')).toContain('chave aberta');
  });

  it('recusa template sem token que diferencie as aldeias', () => {
    expect(validateRenameTemplate('{texto}')).toContain('diferencie as aldeias');
  });

  it('aceita template com token de identidade', () => {
    expect(validateRenameTemplate('{numero} {coord}')).toBeNull();
    expect(validateRenameTemplate('K {k} — {texto}')).toBeNull();
  });
});

describe('planVillageRenames', () => {
  it('numera por continente na ordem determinística de coordenada', () => {
    const plano = planVillageRenames(
      [
        village({ id: '2', name: 'z', x: 150, y: 20 }),
        village({ id: '1', name: 'a', x: 10, y: 10 }),
        village({ id: '3', name: 'b', x: 10, y: 30 }),
      ],
      OPTIONS,
    );

    expect(plano.ok).toBe(true);
    expect(plano.entries.map((entry) => [entry.villageId, entry.seq, entry.target])).toEqual([
      ['1', 1, '01 10|10'],
      ['3', 2, '02 10|30'],
      ['2', 1, '01 150|20'],
    ]);
    expect(plano.counters).toEqual({ K11: 2, K21: 1 });
    expect(plano.pendingCount).toBe(3);
  });

  it('modo geral conta em sequência a partir do início configurado', () => {
    const plano = planVillageRenames(
      [village({ id: '1', x: 10, y: 10 }), village({ id: '2', x: 150, y: 20 })],
      { ...OPTIONS, numbering: 'geral', inicio: 5, padding: 1 },
    );

    expect(plano.entries.map((entry) => entry.seq)).toEqual([5, 6]);
    expect(plano.counters).toEqual({ K11: 1, K21: 1 });
  });

  it('é idempotente: aldeia cujo nome já é o alvo entra com changed=false', () => {
    const plano = planVillageRenames(
      [village({ id: '1', name: '01 10|20', x: 10, y: 20 })],
      OPTIONS,
    );

    expect(plano.entries[0]?.changed).toBe(false);
    expect(plano.pendingCount).toBe(0);
  });

  it('descarta aldeia com coordenada ilegível e reporta o motivo', () => {
    const plano = planVillageRenames(
      [village({ id: '1' }), village({ id: '9', x: Number.NaN, y: 20 })],
      OPTIONS,
    );

    expect(plano.entries.map((entry) => entry.villageId)).toEqual(['1']);
    expect(plano.ignored).toEqual([{ id: '9', reason: 'coordenada ilegível — sem {coord}/{k} confiáveis.' }]);
  });

  it('corta o nome no teto e marca truncated', () => {
    const plano = planVillageRenames([village({ id: '1' })], {
      ...OPTIONS,
      template: '{numero}-{texto}',
      texto: 'x'.repeat(100),
    });

    const entry = plano.entries[0];
    expect(entry?.truncated).toBe(true);
    expect(entry?.target.length).toBe(RENAME_MAX_NAME_LENGTH);
  });

  it('template inválido devolve plano recusado com erro em pt-BR', () => {
    const plano = planVillageRenames([village()], { ...OPTIONS, template: '{numero} {bairro}' });

    expect(plano.ok).toBe(false);
    expect(plano.error).toContain('Token desconhecido');
    expect(plano.entries).toEqual([]);
  });
});

describe('parseVillageRenameRequest (form canônico da tela da aldeia)', () => {
  it('lê action, campo de nome e hidden do form de renomeação', () => {
    const html = `
      <form action="game.php?village=42&amp;screen=main&amp;action=rename_village&amp;h=abc" method="post">
        <input type="hidden" name="h" value="abc">
        <input type="hidden" name="village" value="42">
        <input type="text" name="name" value="Aldeia velha">
        <input type="submit" value="Salvar">
      </form>`;

    expect(parseVillageRenameRequest(html)).toEqual({
      action: 'game.php?village=42&screen=main&action=rename_village&h=abc',
      nameField: 'name',
      hidden: { village: '42' },
    });
  });

  it('não aceita form sem action de renomeação nem campo de nome (fail-closed)', () => {
    const semRename = '<form action="game.php?action=upgrade_building"><input type="text" name="name"></form>';
    const semCampo = '<form action="game.php?action=rename_village"><input type="hidden" name="h" value="x"></form>';

    expect(parseVillageRenameRequest(semRename)).toBeNull();
    expect(parseVillageRenameRequest(semCampo)).toBeNull();
    expect(parseVillageRenameRequest('<p>sem form nenhum</p>')).toBeNull();
  });
});
