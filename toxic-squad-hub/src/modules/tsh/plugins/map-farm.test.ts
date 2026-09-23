import { describe, expect, it } from 'vitest';
import { mapFarmSettingsSchema, parseBarbarianVillages, selectMapFarmTargets } from './map-farm';

const VILLAGE_TXT = [
  '101,Aldeia%20do%20Jogador,500,500,77,3000,0',
  '102,B%C3%A1rbara,502,503,0,72,0',
  '103,B%C3%A1rbara,505,506,0,96,0',
  '104,B%C3%A1rbara,999,999,0,72,0',
].join('\n');

describe('parser do /map/village.txt', () => {
  it('fica apenas com as bárbaras (playerId 0) mantendo id/coordenadas/pontos', () => {
    const barbarians = parseBarbarianVillages(VILLAGE_TXT);

    expect(barbarians).toEqual([
      { id: '102', x: 502, y: 503, points: 72 },
      { id: '103', x: 505, y: 506, points: 96 },
      { id: '104', x: 999, y: 999, points: 72 },
    ]);
  });

  it('texto vazio não lança nem inventa alvo', () => {
    expect(parseBarbarianVillages('')).toEqual([]);
    expect(parseBarbarianVillages('\n')).toEqual([]);
  });

  it('linha malformada é fail-closed com o número da linha', () => {
    expect(() => parseBarbarianVillages('102,Barbara,502,503\n')).toThrow(/Linha 1/);
    expect(() => parseBarbarianVillages('102,B%C3%A1rbara,x,y,0,72,0')).toThrow(/Linha 1/);
  });
});

describe('seleção de região do Map Farm', () => {
  const barbarians = parseBarbarianVillages(VILLAGE_TXT);

  it('filtra o retângulo configurado e limita por ciclo', () => {
    const selection = selectMapFarmTargets(
      barbarians,
      mapFarmSettingsSchema.parse({ xMin: 500, xMax: 505, yMin: 500, yMax: 506, maxTargetsPerCycle: 1 }),
    );

    expect(selection.totalInRegion).toBe(2);
    expect(selection.selected).toEqual([{ id: '102', x: 502, y: 503, points: 72 }]);
  });

  it('região sem bárbaras devolve lista vazia com total zero', () => {
    const selection = selectMapFarmTargets(barbarians, mapFarmSettingsSchema.parse({ xMin: 600, xMax: 700 }));

    expect(selection).toEqual({ selected: [], totalInRegion: 0 });
  });

  it('default cobre o mapa inteiro com teto de 20 por ciclo', () => {
    const selection = selectMapFarmTargets(barbarians, mapFarmSettingsSchema.parse({}));

    expect(selection.totalInRegion).toBe(3);
    expect(selection.selected).toHaveLength(3);
  });
});
