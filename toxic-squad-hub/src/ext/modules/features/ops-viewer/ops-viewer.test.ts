import { describe, expect, it } from 'vitest';
import {
  applyBulkTimeEdit,
  classifyByPopulation,
  deserializeViewerSet,
  detectDepartureConflicts,
  filterViewerCommands,
  serializeViewerSet,
  sortViewerCommands,
  type ViewerCommand,
  type ViewerStatusFilter,
} from './ops-viewer';

// Fixtures no vocabulário do scheduler-state (ms de partida/chegada já
// resolvidos): o Mapa de Operações é pura filtragem sobre records parseados.

const T0 = 1_755_000_000_000;
const MINUTE = 60_000;
const at = (offsetMs: number): number => T0 + offsetMs;

function command(overrides: Partial<ViewerCommand> & { readonly id: string }): ViewerCommand {
  return {
    origin: { x: 500, y: 500 },
    target: { x: 555, y: 444 },
    kind: 'attack',
    departureMs: T0,
    arrivalMs: at(10 * MINUTE),
    status: 'agendado',
    order: 0,
    ...overrides,
  };
}

const BASE: readonly ViewerCommand[] = [
  command({ id: 'c1', departureMs: at(0), arrivalMs: at(10 * MINUTE), order: 0 }),
  command({
    id: 'c2',
    kind: 'support',
    origin: { x: 501, y: 501 },
    target: { x: 560, y: 460 },
    departureMs: at(2 * MINUTE),
    arrivalMs: at(11 * MINUTE),
    status: 'enviado',
    order: 1,
    groupId: 182622,
  }),
  command({
    id: 'c3',
    kind: 'noble',
    departureMs: at(4 * MINUTE),
    arrivalMs: at(15 * MINUTE),
    status: 'falhou',
    order: 2,
    groupId: 182608,
  }),
  command({
    id: 'c4',
    kind: 'fake',
    origin: { x: 502, y: 502 },
    target: { x: 561, y: 461 },
    departureMs: at(6 * MINUTE),
    arrivalMs: at(16 * MINUTE),
    status: 'incerto',
    order: 3,
    fakeFlagged: true,
  }),
  command({
    id: 'c5',
    kind: 'cancel',
    origin: { x: 503, y: 503 },
    target: { x: 562, y: 462 },
    departureMs: at(8 * MINUTE),
    arrivalMs: at(18 * MINUTE),
    status: 'pausado',
    order: 4,
  }),
  command({
    id: 'c6',
    origin: { x: 504, y: 504 },
    target: { x: 563, y: 463 },
    departureMs: at(12 * MINUTE),
    arrivalMs: at(22 * MINUTE),
    status: 'removido',
    order: 5,
  }),
];

const idsOf = (cmds: readonly ViewerCommand[]): string[] => cmds.map((entry) => entry.id);

describe('filterViewerCommands — recorte por data', () => {
  it('recorta pelo eixo da PARTIDA com as pontas inclusivas', () => {
    const filtered = filterViewerCommands(BASE, {
      dateField: 'partida',
      fromMs: at(4 * MINUTE),
      toMs: at(8 * MINUTE),
      status: 'todos',
    });
    expect(idsOf(filtered)).toEqual(['c3', 'c4', 'c5']);
  });

  it('recorta pelo eixo da CHEGADA (mesmo intervalo, resultado diferente)', () => {
    const filtered = filterViewerCommands(BASE, {
      dateField: 'chegada',
      fromMs: at(11 * MINUTE),
      toMs: at(16 * MINUTE),
      status: 'todos',
    });
    expect(idsOf(filtered)).toEqual(['c2', 'c3', 'c4']);
  });

  it('comando no limite exato entra, mas `removido` nunca lista em nenhum modo', () => {
    const onlyC6 = { dateField: 'partida' as const, fromMs: at(12 * MINUTE), toMs: at(12 * MINUTE), status: 'todos' as const };
    expect(idsOf(filterViewerCommands(BASE, onlyC6))).toEqual([]);
    expect(idsOf(filterViewerCommands(BASE, { dateField: 'partida', status: 'todos' }))).toEqual([
      'c1',
      'c2',
      'c3',
      'c4',
      'c5',
    ]);
  });
});

describe('filterViewerCommands — tipos, status, coordenada e grupo', () => {
  it('kinds múltiplos; vetor vazio = nenhum tipo selecionado', () => {
    const ataqueENobre = filterViewerCommands(BASE, {
      dateField: 'partida',
      status: 'todos',
      kinds: ['attack', 'noble'],
    });
    expect(idsOf(ataqueENobre)).toEqual(['c1', 'c3']);
    const fakes = filterViewerCommands(BASE, { dateField: 'partida', status: 'todos', kinds: ['fake', 'cancel'] });
    expect(idsOf(fakes)).toEqual(['c4', 'c5']);
    expect(filterViewerCommands(BASE, { dateField: 'partida', status: 'todos', kinds: [] })).toEqual([]);
  });

  it('status: pendentes = agendado/janela/enviando; enviados = enviado; falhas = falhou/incerto', () => {
    const statuses: readonly ViewerCommand[] = [
      command({ id: 'agendado', status: 'agendado' }),
      command({ id: 'janela', status: 'janela' }),
      command({ id: 'enviando', status: 'enviando' }),
      command({ id: 'enviado', status: 'enviado' }),
      command({ id: 'falhou', status: 'falhou' }),
      command({ id: 'incerto', status: 'incerto' }),
      command({ id: 'pausado', status: 'pausado' }),
      command({ id: 'removido', status: 'removido' }),
      command({ id: 'fora-do-vocabulario', status: 'quarentena' }),
    ];
    const byStatus = (status: ViewerStatusFilter): string[] =>
      idsOf(filterViewerCommands(statuses, { dateField: 'partida', status }));
    expect(byStatus('pendentes')).toEqual(['agendado', 'janela', 'enviando']);
    expect(byStatus('enviados')).toEqual(['enviado']);
    expect(byStatus('falhas')).toEqual(['falhou', 'incerto']);
    // "todos" é tudo menos removido; pausado e status desconhecido não casam
    // nenhum dos três filtros específicos (a engine não inventa classificação).
    expect(byStatus('todos')).toEqual([
      'agendado',
      'janela',
      'enviando',
      'enviado',
      'falhou',
      'incerto',
      'pausado',
      'fora-do-vocabulario',
    ]);
  });

  it('coordQuery exata ("555|444") casa origem OU alvo; texto solto casa por trecho nos dois', () => {
    const coords: readonly ViewerCommand[] = [
      command({ id: 'a', origin: { x: 555, y: 444 }, target: { x: 111, y: 222 } }),
      command({ id: 'b', origin: { x: 700, y: 700 }, target: { x: 555, y: 444 } }),
      command({ id: 'c', origin: { x: 999, y: 100 }, target: { x: 300, y: 300 } }),
    ];
    const byQuery = (coordQuery: string): string[] =>
      idsOf(filterViewerCommands(coords, { dateField: 'partida', status: 'todos', coordQuery }));
    expect(byQuery('555|444')).toEqual(['a', 'b']);
    expect(byQuery(' 555 | 444 ')).toEqual(['a', 'b']);
    expect(byQuery('555')).toEqual(['a', 'b']);
    expect(byQuery('444')).toEqual(['a', 'b']);
    expect(byQuery('99')).toEqual(['c']);
    expect(byQuery('123|456')).toEqual([]);
    expect(byQuery('   ')).toEqual(['a', 'b', 'c']);
  });

  it('groupId casa só quem está no grupo (comando sem grupo nunca casa)', () => {
    expect(
      idsOf(filterViewerCommands(BASE, { dateField: 'partida', status: 'todos', groupId: 182622 })),
    ).toEqual(['c2']);
    expect(
      idsOf(filterViewerCommands(BASE, { dateField: 'partida', status: 'todos', groupId: 182608 })),
    ).toEqual(['c3']);
    expect(idsOf(filterViewerCommands(BASE, { dateField: 'partida', status: 'todos', groupId: 555 }))).toEqual([]);
  });
});

describe('conflitos de precisão (ms)', () => {
  it('conflictsOnly mantém os DOIS lados do par e nada quando não há conflito', () => {
    const conflicted: readonly ViewerCommand[] = [
      command({ id: 'x1', origin: { x: 400, y: 400 }, departureMs: at(0), arrivalMs: at(MINUTE) }),
      command({ id: 'x2', origin: { x: 400, y: 400 }, departureMs: at(120), arrivalMs: at(MINUTE + 120) }),
      command({ id: 'x3', origin: { x: 401, y: 401 }, departureMs: at(120), arrivalMs: at(MINUTE + 120) }),
    ];
    const only = filterViewerCommands(conflicted, { dateField: 'partida', status: 'todos', conflictsOnly: true });
    expect(idsOf(only)).toEqual(['x1', 'x2']);
    // Sem a flag, o recorte devolve o conjunto inteiro.
    expect(idsOf(filterViewerCommands(conflicted, { dateField: 'partida', status: 'todos' }))).toHaveLength(3);
    // BASE não tem partidas próximas da mesma origem.
    expect(filterViewerCommands(BASE, { dateField: 'partida', status: 'todos', conflictsOnly: true })).toEqual([]);
  });

  it('mesma origem conflita abaixo de 5s; exatamente 5s ou mais nunca conflita', () => {
    const origin = { x: 1, y: 1 };
    const first = command({ id: 'a', origin, departureMs: at(0) });
    const below = detectDepartureConflicts([first, command({ id: 'b', origin, departureMs: at(4_999) })]);
    expect([...below.keys()]).toEqual(['a', 'b']);
    expect(below.get('a')).toEqual(['b']);
    expect(below.get('b')).toEqual(['a']);

    expect(detectDepartureConflicts([first, command({ id: 'b', origin, departureMs: at(5_000) })]).size).toBe(0);
    expect(detectDepartureConflicts([first, command({ id: 'b', origin, departureMs: at(6_000) })]).size).toBe(0);
    // Mesmo instante e mesma partida em ORIGEM diferente: não há conflito.
    expect(detectDepartureConflicts([first, command({ id: 'b', origin: { x: 2, y: 1 } })]).size).toBe(0);
  });

  it('lista todos os parceiros do grupo e respeita janela custom (0/negativa nunca conflita)', () => {
    const origin = { x: 10, y: 10 };
    const trio = [
      command({ id: 'a', origin, departureMs: at(0) }),
      command({ id: 'b', origin, departureMs: at(100) }),
      command({ id: 'c', origin, departureMs: at(200) }),
    ];
    const conflicts = detectDepartureConflicts(trio);
    expect(conflicts.get('a')).toEqual(['b', 'c']);
    expect(conflicts.get('b')).toEqual(['a', 'c']);
    expect(conflicts.get('c')).toEqual(['a', 'b']);

    const narrow = detectDepartureConflicts(trio, 150);
    expect(narrow.get('a')).toEqual(['b']);
    expect(narrow.get('c')).toEqual(['b']);
    expect(narrow.get('b')).toEqual(['a', 'c']);

    expect(detectDepartureConflicts(trio, 0).size).toBe(0);
    expect(detectDepartureConflicts(trio, Number.NaN).size).toBe(0);
  });
});

describe('sortViewerCommands — cinco modos com empates estáveis', () => {
  it('ordena por partida/chegada (asc e desc) e por cadastro, sem inverter empates', () => {
    const tied1 = command({ id: 'b', order: 2, departureMs: at(100), arrivalMs: at(900) });
    const tied2 = command({ id: 'a', order: 1, departureMs: at(100), arrivalMs: at(900) });
    const earlier = command({ id: 'c', order: 3, departureMs: at(50), arrivalMs: at(800) });
    const list = [tied1, tied2, earlier];

    // `b` vem antes de `a` na entrada mesmo com order maior: o empate preserva a
    // ordem recebida (estável), não desempata pelo cadastro.
    expect(idsOf(sortViewerCommands(list, 'partida_asc'))).toEqual(['c', 'b', 'a']);
    expect(idsOf(sortViewerCommands(list, 'partida_desc'))).toEqual(['b', 'a', 'c']);
    expect(idsOf(sortViewerCommands(list, 'chegada_asc'))).toEqual(['c', 'b', 'a']);
    expect(idsOf(sortViewerCommands(list, 'chegada_desc'))).toEqual(['b', 'a', 'c']);
    expect(idsOf(sortViewerCommands(list, 'cadastro'))).toEqual(['a', 'b', 'c']);
  });
});

describe('applyBulkTimeEdit — edição em massa de horários', () => {
  it('mover a PARTIDA leva a chegada junto (duração fixa preservada)', () => {
    const original = command({ id: 'c1', departureMs: at(0), arrivalMs: at(10 * MINUTE) });
    const other = command({ id: 'c2', departureMs: at(MINUTE), arrivalMs: at(11 * MINUTE) });
    const edited = applyBulkTimeEdit([original, other], ['c1'], 'partida', at(30 * MINUTE));
    expect(edited[0]).toMatchObject({ departureMs: at(30 * MINUTE), arrivalMs: at(40 * MINUTE) });
    expect(edited[1]).toBe(other);
    expect(edited[0]!.arrivalMs - edited[0]!.departureMs).toBe(10 * MINUTE);
  });

  it('mover a CHEGADA puxa a partida para trás pela mesma duração', () => {
    const original = command({ id: 'c1', departureMs: at(0), arrivalMs: at(10 * MINUTE) });
    const edited = applyBulkTimeEdit([original], ['c1'], 'chegada', at(5 * MINUTE));
    expect(edited[0]).toMatchObject({ departureMs: at(-5 * MINUTE), arrivalMs: at(5 * MINUTE) });
    // Ids ausentes, seleção vazia e instante inválido: entrada intacta (fail-closed).
    expect(applyBulkTimeEdit([original], ['nao-existe'], 'partida', at(60 * MINUTE))).toEqual([original]);
    expect(applyBulkTimeEdit([original], [], 'partida', at(60 * MINUTE))).toEqual([original]);
    expect(applyBulkTimeEdit([original], ['c1'], 'partida', Number.NaN)).toEqual([original]);
  });
});

describe('classifyByPopulation', () => {
  it('corta full/fake nas pontas, meio é neutro e corte sobreposto dá full', () => {
    const opts = { fullMinPop: 5_000, fakeMaxPop: 1_000 };
    expect(classifyByPopulation(9_999, opts)).toBe('full');
    expect(classifyByPopulation(5_000, opts)).toBe('full');
    expect(classifyByPopulation(1_000, opts)).toBe('fake');
    expect(classifyByPopulation(1_001, opts)).toBe('neutro');
    expect(classifyByPopulation(4_999, opts)).toBe('neutro');
    expect(classifyByPopulation(Number.NaN, opts)).toBe('neutro');
    // Cortes sobrepostos: o "cheio" vence (é o corte que não pode ser violado).
    expect(classifyByPopulation(2_000, { fullMinPop: 1_000, fakeMaxPop: 3_000 })).toBe('full');
  });
});

describe('IO JSON do conjunto', () => {
  it('roundtrip estável: mesmo texto para a mesma entrada e chaves ordenadas', () => {
    const raw = serializeViewerSet(BASE);
    expect(raw).toBe(serializeViewerSet(BASE));
    expect(raw.startsWith('{"cmds"')).toBe(true);
    expect(raw.indexOf('"arrivalMs"')).toBeLessThan(raw.indexOf('"departureMs"'));
    const imported = deserializeViewerSet(raw);
    expect('cmds' in imported).toBe(true);
    if (!('cmds' in imported)) return;
    expect(imported.cmds).toEqual(BASE);
  });

  it('exportação recusa comando inválido em vez de gerar arquivo ilegível', () => {
    expect(() => serializeViewerSet([command({ id: 'x', departureMs: Number.NaN })])).toThrow(
      /Comando "x" não pode ser exportado/,
    );
    expect(() => serializeViewerSet([command({ id: 'y', origin: { x: 1_200, y: 0 } })])).toThrow(/origem\.x/);
  });

  it('import fail-closed: JSON ilegível, versão desconhecida e registro malformado devolvem error pt-BR', () => {
    const broken = deserializeViewerSet('{não é json}');
    expect('error' in broken && broken.error).toMatch(/não é JSON válido/);

    const emptyRaw = deserializeViewerSet('');
    expect('error' in emptyRaw).toBe(true);

    const notAnEnvelope = deserializeViewerSet('[]');
    expect('error' in notAnEnvelope).toBe(true);

    const unknownVersion = deserializeViewerSet(JSON.stringify({ version: 99, cmds: [] }));
    expect('error' in unknownVersion && unknownVersion.error).toContain('versão 99');

    const halfCommand = deserializeViewerSet(JSON.stringify({ version: 1, cmds: [{ id: 'x' }] }));
    expect('error' in halfCommand).toBe(true);
    if ('error' in halfCommand) expect(halfCommand.error).toContain('horário de partida');

    const badKind = deserializeViewerSet(
      JSON.stringify({ version: 1, cmds: [{ ...command({ id: 'x' }), kind: 'siege' }] }),
    );
    expect('error' in badKind).toBe(true);
    if ('error' in badKind) expect(badKind.error).toContain('tipo de comando');
  });
});

describe('imutabilidade da entrada', () => {
  it('filtro, ordenação e edição em massa não mutam os comandos recebidos', () => {
    const input: readonly ViewerCommand[] = BASE.map((entry) => ({
      ...entry,
      origin: { ...entry.origin },
      target: { ...entry.target },
    }));
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;

    filterViewerCommands(input, {
      dateField: 'chegada',
      fromMs: T0,
      toMs: at(16 * MINUTE),
      status: 'pendentes',
      kinds: ['attack', 'noble'],
      coordQuery: '555|444',
      conflictsOnly: true,
    });
    sortViewerCommands(input, 'chegada_desc');
    applyBulkTimeEdit(input, ['c1', 'c3'], 'partida', at(99 * MINUTE));

    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
    // As saídas são vetores NOVOS, nunca a entrada.
    expect(sortViewerCommands(input, 'cadastro')).not.toBe(input);
    expect(filterViewerCommands(input, { dateField: 'partida', status: 'todos' })).not.toBe(input);
    expect(applyBulkTimeEdit(input, ['c1'], 'partida', T0)).not.toBe(input);
  });
});
