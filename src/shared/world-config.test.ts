import { describe, expect, it } from 'vitest';
import { NOBLE_MINUTES_PER_FIELD_DEFAULT, parseWorldConfigXml } from './world-config';

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

describe('parseWorldConfigXml', () => {
  it('extrai todos os campos do XML do get_config', () => {
    expect(parseWorldConfigXml('br142', SAMPLE_XML)).toEqual({
      world: 'br142',
      speed: 2,
      unitSpeed: 0.75,
      moralActive: true,
      nightBonusActive: false,
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
      hasArchers: false,
      hasPaladin: false,
      hasMilitia: false,
    });
  });
});

describe('NOBLE_MINUTES_PER_FIELD_DEFAULT', () => {
  it('é 35 (fallback de mundo clássico)', () => {
    expect(NOBLE_MINUTES_PER_FIELD_DEFAULT).toBe(35);
  });
});