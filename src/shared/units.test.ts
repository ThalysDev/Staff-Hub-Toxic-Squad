import { describe, expect, it } from 'vitest';
import { UNITS, classifyVillage, defensivePopulation, offensivePopulation } from './units';

describe('catálogo BR', () => {
  it('tem as 13 unidades com id, nome, população e papel corretos', () => {
    expect(Object.keys(UNITS)).toHaveLength(13);
    expect(UNITS.spear).toEqual({ id: 'spear', name: 'Lanceiro', population: 1, role: 'defensive' });
    expect(UNITS.sword).toEqual({ id: 'sword', name: 'Espadachim', population: 1, role: 'defensive' });
    expect(UNITS.axe).toEqual({ id: 'axe', name: 'Bárbaro', population: 1, role: 'offensive' });
    expect(UNITS.archer).toEqual({ id: 'archer', name: 'Arqueiro', population: 1, role: 'defensive' });
    expect(UNITS.spy).toEqual({ id: 'spy', name: 'Explorador', population: 2, role: 'support' });
    expect(UNITS.light).toEqual({ id: 'light', name: 'Cavalaria Leve', population: 4, role: 'offensive' });
    expect(UNITS.marcher).toEqual({ id: 'marcher', name: 'Arqueiro a Cavalo', population: 5, role: 'offensive' });
    expect(UNITS.heavy).toEqual({ id: 'heavy', name: 'Cavalaria Pesada', population: 6, role: 'defensive' });
    expect(UNITS.ram).toEqual({ id: 'ram', name: 'Ariete', population: 5, role: 'offensive' });
    expect(UNITS.catapult).toEqual({ id: 'catapult', name: 'Catapulta', population: 8, role: 'offensive' });
    expect(UNITS.knight).toEqual({ id: 'knight', name: 'Paladino', population: 10, role: 'offensive' });
    expect(UNITS.snob).toEqual({ id: 'snob', name: 'Nobre', population: 100, role: 'offensive' });
    expect(UNITS.militia).toEqual({ id: 'militia', name: 'Milícia', population: 0, role: 'defensive' });
  });
});

describe('offensivePopulation', () => {
  it('soma axe, light, marcher, ram, snob e knight', () => {
    expect(
      offensivePopulation({ axe: 100, light: 50, marcher: 20, ram: 10, snob: 1, knight: 3 })
    ).toBe(580);
  });

  it('não conta catapult, explorador nem unidades defensivas', () => {
    expect(offensivePopulation({ catapult: 10, spy: 10, spear: 100, heavy: 10, militia: 100 })).toBe(0);
  });

  it('vazio = 0', () => {
    expect(offensivePopulation({})).toBe(0);
  });
});

describe('defensivePopulation', () => {
  it('soma spear + sword + archer + heavy*4', () => {
    expect(defensivePopulation({ spear: 100, sword: 50, archer: 25, heavy: 10 })).toBe(215);
  });

  it('pesa a pesada em 4, não na população 6 do jogo', () => {
    expect(defensivePopulation({ heavy: 1 })).toBe(4);
  });

  it('milícia não conta', () => {
    expect(defensivePopulation({ militia: 500 })).toBe(0);
  });
});

describe('classifyVillage', () => {
  it('vazio (inclusive só milícia) → empty', () => {
    expect(classifyVillage({})).toBe('empty');
    expect(classifyVillage({ militia: 100 })).toBe('empty');
  });

  it('ofensiva > defensiva → offensive', () => {
    expect(classifyVillage({ axe: 100, spear: 50 })).toBe('offensive');
  });

  it('defensiva > ofensiva → defensive', () => {
    expect(classifyVillage({ spear: 100, axe: 50 })).toBe('defensive');
  });

  it('empate não-zero conta como defensivo', () => {
    expect(classifyVillage({ axe: 100, spear: 100 })).toBe('defensive');
  });
});