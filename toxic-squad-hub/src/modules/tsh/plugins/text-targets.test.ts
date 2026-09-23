// Editores de TEXTO "x|y por linha" da onda 18/19 (ambiente node, sem DOM):
// parser compartilhado (parseCoordinateLines), conversões para as listas que
// cada engine/planner lê e as notas honestas de linha ignorada no status.
import { describe, expect, it } from 'vitest';
import {
  coordinateLinesNote,
  defaultOpEntry,
  opGeneratorSettingsSchema,
  parseCoordinateLines,
} from './op-generator';
import { DEFAULT_SETTINGS as MASS_SUPPORT_DEFAULTS, massSupportSettingsSchema, resolveMassSupportLists } from './mass-support';
import { planWallDemolition, wallDemolitionSettingsSchema, wallTargetsFromText } from './wall-demolition';
import {
  barbarianTargetsFromText,
  barbarianCultivatorSettingsSchema,
  planBarbarianCultivation,
} from './barbarian-cultivator';

describe('parseCoordinateLines (x|y por linha)', () => {
  it('devolve coordenadas normalizadas com o número da linha de origem', () => {
    expect(parseCoordinateLines('500|500\n501|503').targets).toEqual([
      { line: 1, coordinate: '500|500', x: 500, y: 500, extras: [] },
      { line: 2, coordinate: '501|503', x: 501, y: 503, extras: [] },
    ]);
  });

  it('normaliza zeros à esquerda para o formato canônico da engine', () => {
    expect(parseCoordinateLines('007|008').targets[0]?.coordinate).toBe('7|8');
  });

  it('linha inválida é reportada (1-based) e NUNCA vira alvo', () => {
    const parsed = parseCoordinateLines(['500|500', 'abc', '1000|5', '5|1000', '1|2|3|4', '1|2|x', ''].join('\n'));
    expect(parsed.targets).toEqual([{ line: 1, coordinate: '500|500', x: 500, y: 500, extras: [] }]);
    expect(parsed.invalidLines).toEqual([2, 3, 4, 5, 6]);
    expect(parsed.duplicates).toBe(0);
  });

  it('duplicata mantém a primeira ocorrência e é contada', () => {
    const parsed = parseCoordinateLines('500|500\n500|500\n501|501');
    expect(parsed.targets.map((target) => target.coordinate)).toEqual(['500|500', '501|501']);
    expect(parsed.duplicates).toBe(1);
  });

  it('linha em branco é ruído, não erro; texto vazio não inventa alvo', () => {
    expect(parseCoordinateLines('\n  \n')).toEqual({ targets: [], duplicates: 0, invalidLines: [] });
  });

  it('preserva o segmento extra (ex.: nível de muralha) para o consumidor validar', () => {
    const parsed = parseCoordinateLines('501|504|6');
    expect(parsed.targets[0]?.extras).toEqual(['6']);
    expect(parsed.invalidLines).toEqual([]);
  });
});

describe('coordinateLinesNote (nota honesta para o status)', () => {
  it('parse limpo não tem nota', () => {
    expect(coordinateLinesNote('targetsText', parseCoordinateLines('500|500'))).toBe('');
  });

  it('cita linhas inválidas (até 5) e duplicatas', () => {
    const parsed = parseCoordinateLines(['a', 'b', '500|500', '500|500', 'c'].join('\n'));
    expect(coordinateLinesNote('targetsText', parsed)).toBe(
      'targetsText: 3 linha(s) inválida(s) ignorada(s) (1, 2, 5); 1 duplicata(s) ignorada(s).',
    );
  });

  it('mais de 5 linhas inválidas são resumidas', () => {
    const parsed = parseCoordinateLines(['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n'));
    expect(coordinateLinesNote('destinationsText', parsed)).toBe(
      'destinationsText: 7 linha(s) inválida(s) ignorada(s) (1, 2, 3, 4, 5 +2).',
    );
  });
});

describe('resolveMassSupportLists (destinos/alvos do Apoio em Massa)', () => {
  it('texto vazio mantém as listas salvas (compat, sem nota)', () => {
    const settings = massSupportSettingsSchema.parse({
      destinations: [{ coordinate: '510|520' }],
      targets: [{ coordinate: '530|540' }],
    });
    const lists = resolveMassSupportLists(settings);
    expect(lists.destinations).toEqual([{ coordinate: '510|520', troopMode: 'all' }]);
    expect(lists.targets).toEqual([{ coordinate: '530|540' }]);
    expect(lists.notes).toEqual([]);
  });

  it('destinationsText vira destino da engine (tropa inteira, troopMode all)', () => {
    const settings = massSupportSettingsSchema.parse({ destinationsText: '500|500\n501|503' });
    const lists = resolveMassSupportLists(settings);
    expect(lists.destinations).toEqual([
      { coordinate: '500|500', troopMode: 'all' },
      { coordinate: '501|503', troopMode: 'all' },
    ]);
    expect(lists.notes).toEqual([]);
  });

  it('targetsText vira alvo de defesa (só coordenada, sem meta por alvo)', () => {
    const settings = massSupportSettingsSchema.parse({ targetsText: '530|540' });
    const lists = resolveMassSupportLists(settings);
    expect(lists.targets).toEqual([{ coordinate: '530|540' }]);
  });

  it('texto preenchido prevalece sobre a lista salva e avisa; linha ruim é ignorada com nota', () => {
    const settings = massSupportSettingsSchema.parse({
      destinations: [{ coordinate: '510|520' }],
      destinationsText: '500|500\nlinha ruim',
    });
    const lists = resolveMassSupportLists(settings);
    expect(lists.destinations).toEqual([{ coordinate: '500|500', troopMode: 'all' }]);
    expect(lists.notes).toEqual([
      'destinationsText: 1 linha(s) inválida(s) ignorada(s) (2).',
      'destinationsText prevalece sobre a lista "destinations" salva.',
    ]);
  });

  it('texto todo inválido deixa a lista vazia (o ciclo cai no motivo "Nenhum destino")', () => {
    const settings = massSupportSettingsSchema.parse({ destinationsText: 'abc\n1000|1' });
    expect(resolveMassSupportLists(settings).destinations).toEqual([]);
  });

  it('teto de 500 itens da engine é respeitado com nota', () => {
    const text = Array.from({ length: 501 }, (_, index) => `${index}|${index}`).join('\n');
    const lists = resolveMassSupportLists(massSupportSettingsSchema.parse({ targetsText: text }));
    expect(lists.targets).toHaveLength(500);
    expect(lists.notes[0]).toContain('teto de 500');
  });

  it('defaults nascem com os textareas vazios', () => {
    expect(massSupportSettingsSchema.parse({}).destinationsText).toBe('');
    expect(massSupportSettingsSchema.parse({}).targetsText).toBe('');
    expect(MASS_SUPPORT_DEFAULTS.destinationsText).toBe('');
  });
});

describe('targetsText do Gerador de OPs (entrada padrão)', () => {
  it('default vazio e aceito no schema strict', () => {
    const settings = opGeneratorSettingsSchema.parse({ targetsText: '500|500' });
    expect(settings.targetsText).toBe('500|500');
    expect(opGeneratorSettingsSchema.parse({}).targetsText).toBe('');
  });

  it('entrada padrão segue os defaults da origem (OP, ataque, distribuir)', () => {
    expect(defaultOpEntry('500|500\n501|503')).toEqual({
      tag: 'OP',
      commandKind: 'attack',
      criterion: 'distribuir',
      targetsText: '500|500\n501|503',
      maximumDistanceFields: null,
      groupId: null,
    });
  });
});

describe('targetsText do Demolidor de Muralhas', () => {
  it('x|y|nível define a muralha; x|y puro conta como 0; linha ruim é reportada', () => {
    const parsed = wallTargetsFromText('501|504|6\n505|510\nruim\n501|504|6');
    expect(parsed.targets).toEqual([
      { id: '501|504', x: 501, y: 504, points: 0, wallLevel: 6, barbarian: false },
      { id: '505|510', x: 505, y: 510, points: 0, wallLevel: 0, barbarian: false },
    ]);
    expect(parsed.invalidLines).toEqual([3]);
    expect(parsed.duplicates).toBe(1);
  });

  it('alvo do texto com nível elegível forma a onda prevista pelo planner da origem', () => {
    const { targets } = wallTargetsFromText('501|504|6');
    const decision = planWallDemolition(wallDemolitionSettingsSchema.parse({ minRams: 10, minWallLevel: 5 }), targets, 20);
    expect(decision).toEqual({ kind: 'PLAN', targetId: '501|504', ram: 10, attempts: 1 });
  });

  it('sem nível nenhum, nenhum alvo é elegível (muralha 0 < mínimo do schema)', () => {
    const { targets } = wallTargetsFromText('501|504\n505|510');
    const decision = planWallDemolition(wallDemolitionSettingsSchema.parse({}), targets, 100);
    expect(decision.kind).toBe('NO_WORK');
  });

  it('targetsText é campo do settings (texto vazio = lista do storage)', () => {
    expect(wallDemolitionSettingsSchema.parse({}).targetsText).toBe('');
  });
});

describe('targetsText do Cultivador de Bárbaras', () => {
  it('x|y vira alvo bárbaro (id = coordenada); linha com nível extra é inválida aqui', () => {
    const parsed = barbarianTargetsFromText('500|500\n501|501|3\nruim');
    expect(parsed.targets).toEqual([{ id: '500|500', x: 500, y: 500, points: 0, barbarian: true }]);
    expect(parsed.invalidLines).toEqual([2, 3]);
  });

  it('alvo do texto alimenta o planner da origem (barbarian true + catapultas)', () => {
    const { targets } = barbarianTargetsFromText('500|500');
    const decision = planBarbarianCultivation(barbarianCultivatorSettingsSchema.parse({}), targets, 20);
    expect(decision).toEqual({ kind: 'PLAN', targetId: '500|500', building: 'main', catapult: 20 });
  });

  it('targetsText é campo do settings (texto vazio = lista do storage)', () => {
    expect(barbarianCultivatorSettingsSchema.parse({}).targetsText).toBe('');
  });
});
