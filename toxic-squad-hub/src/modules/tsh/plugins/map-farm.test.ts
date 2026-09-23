import { describe, expect, it, vi } from 'vitest';
import { mapperTargetListSchema, normalizeMapperConfig } from '../../../ext/modules/features/auto-farm/barbarian-mapper';
import { ownVillages } from '../tsh-game-data';
import {
  autoFarmTargetsKey,
  buildMapFarmTargetList,
  mapFarmRegionCenter,
  mapFarmSettingsSchema,
  mapperConfigFromSettings,
  parseBarbarianVillages,
  resolveMapFarmOrigin,
  scoreMapFarmTargets,
  selectMapFarmTargets,
} from './map-farm';

vi.mock('../tsh-game-data', () => ({
  ownVillages: vi.fn(),
}));

const VILLAGE_TXT = [
  '101,Aldeia%20do%20Jogador,500,500,77,3000,0',
  '102,B%C3%A1rbara,502,503,0,72,0',
  '103,B%C3%A1rbara,505,506,0,96,0',
  '104,B%C3%A1rbara,999,999,0,72,0',
].join('\n');

const NOW = Date.parse('2026-09-23T12:00:00.000Z');

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

describe('configuração do Mapper nos settings do Map Farm', () => {
  it('defaults alinham com a engine do Mapper (janela ampla, 30 campos, 6h)', () => {
    const settings = mapFarmSettingsSchema.parse({});

    expect(mapperConfigFromSettings(settings)).toEqual(normalizeMapperConfig({}));
    expect(mapperConfigFromSettings(settings)).toEqual({
      groupId: '0',
      maxDistance: 30,
      minScore: 0,
      maxScore: 10_000,
      template: 'C',
      updateMode: 'horas',
      updateValue: 6,
    });
  });

  it('valor de campo inválido cai no default do campo (fail-soft, como a engine)', () => {
    const settings = mapFarmSettingsSchema.parse({ maxDistance: 0, template: 'D', updateMode: 'minutos', updateValue: 99_999 });

    expect(settings.maxDistance).toBe(30);
    expect(settings.template).toBe('C');
    expect(settings.updateMode).toBe('horas');
    expect(settings.updateValue).toBe(6);
  });

  it('janela de pontos invertida é corrigida pela engine (não filtra tudo)', () => {
    const config = mapperConfigFromSettings(mapFarmSettingsSchema.parse({ minScore: 800, maxScore: 100 }));

    expect(config.minScore).toBe(100);
    expect(config.maxScore).toBe(800);
  });

  it('a chave do contrato aponta para o namespace do plugin Auto Farm', () => {
    expect(autoFarmTargetsKey('br144')).toBe('tsh-auto:br144:auto-farm:targets');
  });
});

describe('pontuação e lista compartilhada do Mapper', () => {
  const origin = { x: 500, y: 500, source: 'aldeia aberta' as const };
  const config = normalizeMapperConfig({ maxDistance: 10, minScore: 100, maxScore: 1_000 });

  it('filtra pela janela de pontos e distância e ordena por proximidade', () => {
    const scored = scoreMapFarmTargets(
      [
        { id: '1', x: 500, y: 500, points: 500 },
        { id: '2', x: 500, y: 500, points: 50 }, // abaixo do mínimo
        { id: '3', x: 520, y: 500, points: 500 }, // 20 campos (acima do limite)
        { id: '4', x: 501, y: 500, points: 900 },
      ],
      origin,
      config,
      NOW,
      10,
    );

    expect(scored.map((target) => target.id)).toEqual([1, 4]);
    expect(scored[0]?.lastScoutedAt).toBeNull(); // sem fonte de exploração, nunca inventa frescor
  });

  it('respeita o teto do ciclo (lista guarda os N melhores, não o dump inteiro)', () => {
    const scored = scoreMapFarmTargets(
      [
        { id: '1', x: 500, y: 500, points: 500 },
        { id: '4', x: 501, y: 500, points: 900 },
      ],
      origin,
      config,
      NOW,
      1,
    );

    expect(scored.map((target) => target.id)).toEqual([1]);
  });

  it('lista montada passa no contrato zod do Auto Farm e remove coordenada repetida', () => {
    const targets = scoreMapFarmTargets(
      [
        { id: '1', x: 500, y: 500, points: 500 },
        { id: '2', x: 500, y: 500, points: 700 }, // mesma coordenada
      ],
      origin,
      config,
      NOW,
      10,
    );
    const list = buildMapFarmTargetList({
      generatedAt: new Date(NOW).toISOString(),
      origin,
      config,
      targets,
    });

    expect(list.targets).toHaveLength(1);
    expect(list.originSource).toBe('aldeia aberta');
    expect(mapperTargetListSchema.parse(JSON.parse(JSON.stringify(list)))).toEqual(list);
  });
});

describe('origem da pontuação', () => {
  it('centro do retângulo é preso ao contrato 0..999 do Mapper', () => {
    expect(mapFarmRegionCenter(mapFarmSettingsSchema.parse({ xMin: 0, xMax: 1000, yMin: 0, yMax: 1000 }))).toEqual({
      x: 500,
      y: 500,
    });
    expect(mapFarmRegionCenter(mapFarmSettingsSchema.parse({ xMin: 1000, xMax: 1000, yMin: 1000, yMax: 1000 }))).toEqual({
      x: 999,
      y: 999,
    });
  });

  it('sem aldeia aberta (node) usa a 1ª aldeia PRÓPRIA do jogador', async () => {
    vi.mocked(ownVillages).mockResolvedValue([
      { id: '9', name: 'Minha', x: 480, y: 490, points: 1000, playerId: '7' },
      { id: '10', name: 'Outra', x: 481, y: 491, points: 900, playerId: '7' },
    ]);

    await expect(resolveMapFarmOrigin(mapFarmSettingsSchema.parse({}))).resolves.toEqual({
      x: 480,
      y: 490,
      source: 'aldeia própria',
    });
  });

  it('sem próprias (falha de leitura) cai para o centro da região — nunca derruba o ciclo', async () => {
    vi.mocked(ownVillages).mockRejectedValue(new Error('/map/village.txt indisponível'));

    await expect(
      resolveMapFarmOrigin(mapFarmSettingsSchema.parse({ xMin: 400, xMax: 500, yMin: 600, yMax: 700 })),
    ).resolves.toEqual({ x: 450, y: 650, source: 'centro da região' });
  });
});
