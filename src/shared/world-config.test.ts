import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NOBLE_MINUTES_PER_FIELD_DEFAULT, parseWorldConfigXml } from './world-config';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../tests/fixtures/br142/${name}`, import.meta.url)), 'utf8');
}

const SAMPLE_XML = `<?xml version="1.0"?>
<config>
  <speed>2</speed>
  <unit_speed>0.75</unit_speed>
  <moral>1</moral>
  <night>0</night>
  <archer>1</archer>
  <knight>0</knight>
  <militia>0</militia>
</config>`;

// Mesma estrutura do bloco <night> real do BR142 no get_config.
const NIGHT_BLOCK_BR142 = `<night>
  <active>1</active>
  <start_hour>23</start_hour>
  <end_hour>7</end_hour>
  <def_factor>2</def_factor>
  <duration>14</duration>
</night>`;

describe('parseWorldConfigXml', () => {
  it('extrai todos os campos do XML do get_config', () => {
    expect(parseWorldConfigXml('br142', SAMPLE_XML)).toEqual({
      world: 'br142',
      speed: 2,
      unitSpeed: 0.75,
      moralActive: true,
      nightBonusActive: false,
      nightStartHour: 0,
      nightEndHour: 0,
      hasArchers: true,
      hasPaladin: false,
      hasMilitia: false,
    });
  });

  it('aceita números com vírgula', () => {
    const xml = SAMPLE_XML.replace('<speed>2</speed>', '<speed>1,5</speed>');
    expect(parseWorldConfigXml('br142', xml).speed).toBe(1.5);
  });

  it('tolera espaços e quebras de linha em volta do conteúdo', () => {
    const xml = SAMPLE_XML.replace('<speed>2</speed>', '<speed>\n  2  \n</speed>');
    expect(parseWorldConfigXml('br142', xml).speed).toBe(2);
  });

  it('valores diferentes de 1 contam como flag false', () => {
    const xml = SAMPLE_XML.replace('<moral>1</moral>', '<moral>0</moral>');
    expect(parseWorldConfigXml('br142', xml).moralActive).toBe(false);
  });

  it('tags ausentes recebem fallback (speed 1, flags false)', () => {
    expect(parseWorldConfigXml('br142', '<config></config>')).toEqual({
      world: 'br142',
      speed: 1,
      unitSpeed: 1,
      moralActive: false,
      nightBonusActive: false,
      nightStartHour: 0,
      nightEndHour: 0,
      hasArchers: false,
      hasPaladin: false,
      hasMilitia: false,
    });
  });
});

describe('parseWorldConfigXml — bloco aninhado <night>', () => {
  it('lê active/start_hour/end_hour do bloco (janela 23→7)', () => {
    const xml = SAMPLE_XML.replace('<night>0</night>', NIGHT_BLOCK_BR142);
    const config = parseWorldConfigXml('br142', xml);
    expect(config.nightBonusActive).toBe(true);
    expect(config.nightStartHour).toBe(23);
    expect(config.nightEndHour).toBe(7);
  });

  it('bloco com active=0 mantém as horas parseadas mas desliga o bônus', () => {
    const xml = SAMPLE_XML.replace('<night>0</night>', NIGHT_BLOCK_BR142.replace('<active>1</active>', '<active>0</active>'));
    const config = parseWorldConfigXml('br142', xml);
    expect(config.nightBonusActive).toBe(false);
    expect(config.nightStartHour).toBe(23);
    expect(config.nightEndHour).toBe(7);
  });

  it('fail-closed: "ativo" sem horários válidos desliga o bônus em vez de inventar janela', () => {
    const semHoras = SAMPLE_XML.replace(
      '<night>0</night>',
      '<night><active>1</active><duration>14</duration></night>',
    );
    const config = parseWorldConfigXml('br142', semHoras);
    expect(config.nightBonusActive).toBe(false);
    expect(config.nightStartHour).toBe(0);
    expect(config.nightEndHour).toBe(0);
  });

  it('horário fora de 0-23 → fail-closed (bônus desligado)', () => {
    const xml = SAMPLE_XML.replace('<night>0</night>', NIGHT_BLOCK_BR142.replace('<end_hour>7</end_hour>', '<end_hour>25</end_hour>'));
    expect(parseWorldConfigXml('br142', xml).nightBonusActive).toBe(false);
  });
});

describe('parseWorldConfigXml contra o fixture real BR142', () => {
  it('lê o bloco <night> do get_config capturado: janela 23→7 ativa', () => {
    const config = parseWorldConfigXml('br142', fixture('world-config-xml.html'));
    expect(config.nightBonusActive).toBe(true);
    expect(config.nightStartHour).toBe(23);
    expect(config.nightEndHour).toBe(7);
  });
});

describe('NOBLE_MINUTES_PER_FIELD_DEFAULT', () => {
  it('é 35 (fallback de mundo clássico)', () => {
    expect(NOBLE_MINUTES_PER_FIELD_DEFAULT).toBe(35);
  });
});
