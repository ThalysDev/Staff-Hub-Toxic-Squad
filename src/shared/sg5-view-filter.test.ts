// Testes do filtro de visualização do SG_5 — fixtures sintéticas fiéis ao
// IncomingCommandRow real (valores da captura br142: Timing.init 1787622258,
// "1:08:03" = 4083 s, jogador "R O D R I G U E S", coords 543|551/612|606).
import { describe, expect, it } from 'vitest';
import type { IncomingCommandRow } from './parsers/village-parsers';
import type { Sg5VerifyResult } from './ipc-types';
import { distinctCommandTypes, EMPTY_SG5_VIEW_FILTER, filterSg5Result } from './sg5-view-filter';

/** Timing.init da captura br142 em epoch ms (âncora da página do alvo A). */
const LOAD_A = 1_787_622_258_000;
const LOAD_B = LOAD_A + 9_000;
/** 4083 s é exatamente o "1:08:03" do texto real da captura. */
const ARRIVAL_A = LOAD_A + 4083 * 1000;

let nextId = 492622028; // id real de comando da captura incomings-own.html
function row(overrides: Partial<IncomingCommandRow> & { arrivalSecFromLoad?: number | null } = {}): IncomingCommandRow {
  nextId += 1;
  return {
    commandId: overrides.commandId ?? nextId,
    name: 'Suporte',
    type: 'support',
    hints: [],
    hasNoble: false,
    sizeHint: null,
    destination: { name: 'Alvo', coord: '543|551' },
    origin: { name: 'Origem', coord: '612|606' },
    playerName: 'R O D R I G U E S',
    fieldsDistance: 96.8,
    arrivesAtText: 'hoje às 01:11:07:212',
    arrivesInText: '1:08:03',
    // Por padrão SEM atributo máquina (cenário atual das capturas do BR142).
    arrivalSecFromLoad: null,
    ...overrides,
  };
}

function village(coord: string, commands: IncomingCommandRow[], loadedAt = LOAD_A): Sg5VerifyResult['villages'][number] {
  return { coord, loadedAt, commands };
}

describe('EMPTY_SG5_VIEW_FILTER', () => {
  it('é o filtro neutro congelado (tudo passa)', () => {
    expect(EMPTY_SG5_VIEW_FILTER).toEqual({ query: '', types: [], noble: 'todos', status: 'todos' });
    expect(Object.isFrozen(EMPTY_SG5_VIEW_FILTER)).toBe(true);
  });
});

describe('filterSg5Result', () => {
  it('filtro vazio = identidade: mesma estrutura de villages, unknown e generatedAt', () => {
    const input: Sg5VerifyResult = {
      generatedAt: '2026-08-26T00:00:00.000Z',
      villages: [village('543|551', [row({ commandId: 1 }), row({ commandId: 2 })]), village('460|480', [row({ commandId: 3 })], LOAD_B)],
      unknown: [row({ commandId: 4 })],
    };
    expect(filterSg5Result(input, EMPTY_SG5_VIEW_FILTER, new Date(LOAD_A))).toEqual(input);
  });

  it('query é contains acento/case-insensitive sobre playerName ("João" ≃ "joao" ≃ "JOAO")', () => {
    const input: Sg5VerifyResult = {
      generatedAt: 'x',
      villages: [village('543|551', [row({ commandId: 1, playerName: 'João' }), row({ commandId: 2, playerName: 'Rodrigues' }), row({ commandId: 3, playerName: 'Jão' })])],
      unknown: [],
    };
    const ids = (result: Sg5VerifyResult): number[] => result.villages.flatMap((v) => v.commands.map((c) => c.commandId));
    // "joao" (sem acento) acha "João"; "Jão" vinca só "jao", então fica de fora.
    expect(ids(filterSg5Result(input, { ...EMPTY_SG5_VIEW_FILTER, query: 'joao' }, new Date()))).toEqual([1]);
    // Com acento no filtro acha dado SEM acento (dobramento nos dois lados).
    expect(ids(filterSg5Result(input, { ...EMPTY_SG5_VIEW_FILTER, query: 'JOÃO' }, new Date()))).toEqual([1]);
    // "JAO" só casa "Jão" ("João" vira "joao", que não contém "jao").
    expect(ids(filterSg5Result(input, { ...EMPTY_SG5_VIEW_FILTER, query: 'JAO' }, new Date()))).toEqual([3]);
    // "ÃO" dobra p/ "ao" e acha os dois ("joao" e "jao").
    expect(ids(filterSg5Result(input, { ...EMPTY_SG5_VIEW_FILTER, query: 'ÃO' }, new Date()))).toEqual([1, 3]);
  });

  it('query também busca em destination.name (com acento) e destination.coord', () => {
    const input: Sg5VerifyResult = {
      generatedAt: 'x',
      villages: [village('543|551', [row({ commandId: 1, destination: { name: 'São Rafael', coord: '543|551' } }), row({ commandId: 2, destination: { name: 'Alvo', coord: '460|480' } })])],
      unknown: [],
    };
    const ids = (result: Sg5VerifyResult): number[] => result.villages.flatMap((v) => v.commands.map((c) => c.commandId));
    expect(ids(filterSg5Result(input, { ...EMPTY_SG5_VIEW_FILTER, query: 'sao rafael' }, new Date()))).toEqual([1]);
    expect(ids(filterSg5Result(input, { ...EMPTY_SG5_VIEW_FILTER, query: '460' }, new Date()))).toEqual([2]);
    // "rafael543" não existe: contains não vaza de um campo para outro.
    expect(ids(filterSg5Result(input, { ...EMPTY_SG5_VIEW_FILTER, query: 'rafael543' }, new Date()))).toEqual([]);
  });

  it('types filtra por tipo exato: só "attack" sobrevive; vazio mantém todos', () => {
    const input: Sg5VerifyResult = {
      generatedAt: 'x',
      villages: [village('543|551', [row({ commandId: 1, type: 'attack' }), row({ commandId: 2, type: 'support' }), row({ commandId: 3, type: 'attack' })])],
      unknown: [],
    };
    const ids = (result: Sg5VerifyResult): number[] => result.villages.flatMap((v) => v.commands.map((c) => c.commandId));
    expect(ids(filterSg5Result(input, { ...EMPTY_SG5_VIEW_FILTER, types: ['attack'] }, new Date()))).toEqual([1, 3]);
    expect(ids(filterSg5Result(input, EMPTY_SG5_VIEW_FILTER, new Date()))).toEqual([1, 2, 3]);
  });

  it('types aceita múltiplos valores e descarta o resto', () => {
    const input: Sg5VerifyResult = {
      generatedAt: 'x',
      villages: [village('543|551', [row({ commandId: 1, type: 'attack' }), row({ commandId: 2, type: 'support' }), row({ commandId: 3, type: 'unknown' })])],
      unknown: [],
    };
    const out = filterSg5Result(input, { ...EMPTY_SG5_VIEW_FILTER, types: ['attack', 'support'] }, new Date());
    expect(out.villages[0]?.commands.map((c) => c.commandId)).toEqual([1, 2]);
  });

  it('noble "com" mantém só hasNoble e "sem" só o contrário', () => {
    const input: Sg5VerifyResult = {
      generatedAt: 'x',
      villages: [village('543|551', [row({ commandId: 1, hasNoble: true }), row({ commandId: 2, hasNoble: false })])],
      unknown: [],
    };
    const ids = (noble: 'com' | 'sem' | 'todos'): number[] =>
      filterSg5Result(input, { ...EMPTY_SG5_VIEW_FILTER, noble }, new Date()).villages[0]?.commands.map((c) => c.commandId) ?? [];
    expect(ids('com')).toEqual([1]);
    expect(ids('sem')).toEqual([2]);
    expect(ids('todos')).toEqual([1, 2]);
  });

  it('status "chegados": usa chegada real (loadedAt + arrivalSecFromLoad) contra now injetado; fronteira conta como chegados', () => {
    const input: Sg5VerifyResult = {
      generatedAt: 'x',
      villages: [village('543|551', [row({ commandId: 1, arrivalSecFromLoad: 4083 })]), village('460|480', [row({ commandId: 2, arrivalSecFromLoad: 100 })], LOAD_B)],
      unknown: [],
    };
    // Linha do tempo: comando 1 chega em ARRIVAL_A (LOAD_A + 4083 s ≈ 68 min);
    // comando 2 chega em LOAD_B + 100 s = LOAD_A + 109 s (bem antes do 1).
    const ARRIVAL_B = LOAD_B + 100 * 1000;
    const ids = (now: Date): number[] =>
      filterSg5Result(input, { ...EMPTY_SG5_VIEW_FILTER, status: 'chegados' }, now).villages.flatMap((v) => v.commands.map((c) => c.commandId));
    expect(ids(new Date(LOAD_A))).toEqual([]); // nada chegou ainda
    expect(ids(new Date(ARRIVAL_B))).toEqual([2]); // exatamente na chegada → chegados (<=); âncora é a loadedAt da PRÓPRIA aldeia
    expect(ids(new Date(ARRIVAL_A))).toEqual([1, 2]); // 1 na fronteira, 2 já chegou antes
  });

  it('status "pendentes": mantém só chegadas estritamente futuras', () => {
    const input: Sg5VerifyResult = {
      generatedAt: 'x',
      villages: [village('543|551', [row({ commandId: 1, arrivalSecFromLoad: 4083 })]), village('460|480', [row({ commandId: 2, arrivalSecFromLoad: 100 })], LOAD_B)],
      unknown: [],
    };
    const ids = (now: Date): number[] =>
      filterSg5Result(input, { ...EMPTY_SG5_VIEW_FILTER, status: 'pendentes' }, now).villages.flatMap((v) => v.commands.map((c) => c.commandId));
    expect(ids(new Date(LOAD_A))).toEqual([1, 2]); // tudo no futuro
    expect(ids(new Date(LOAD_B + 100 * 1000))).toEqual([1]); // 2 na fronteira → conta como chegados
    expect(ids(new Date(ARRIVAL_A))).toEqual([]); // na fronteira do 1 nada mais está pendente
  });

  it('linha SEM atributo de máquina (arrivalSecFromLoad null) passa em chegados E pendentes — texto visível nunca é parseado', () => {
    const input: Sg5VerifyResult = {
      generatedAt: 'x',
      villages: [village('543|551', [row({ commandId: 1, arrivalSecFromLoad: null, arrivesAtText: 'ontem às 23:59:59:999' })])],
      unknown: [],
    };
    for (const status of ['chegados', 'pendentes'] as const) {
      const out = filterSg5Result(input, { ...EMPTY_SG5_VIEW_FILTER, status }, new Date(LOAD_A));
      expect(out.villages[0]?.commands.map((c) => c.commandId)).toEqual([1]);
    }
  });

  it('village que fica sem comandos após o filtro é descartada; sobreviventes mantêm coord e loadedAt', () => {
    const input: Sg5VerifyResult = {
      generatedAt: 'x',
      villages: [village('543|551', [row({ commandId: 1, type: 'attack' })]), village('460|480', [row({ commandId: 2, type: 'support' })], LOAD_B)],
      unknown: [],
    };
    const out = filterSg5Result(input, { ...EMPTY_SG5_VIEW_FILTER, types: ['attack'] }, new Date());
    expect(out.villages).toHaveLength(1);
    expect(out.villages[0]).toMatchObject({ coord: '543|551', loadedAt: LOAD_A });
  });

  it('village já vazia no input é descartada mesmo com filtro vazio', () => {
    const input: Sg5VerifyResult = {
      generatedAt: 'x',
      villages: [village('543|551', [row({ commandId: 1 })]), village('460|480', [])],
      unknown: [],
    };
    const out = filterSg5Result(input, EMPTY_SG5_VIEW_FILTER, new Date());
    expect(out.villages.map((v) => v.coord)).toEqual(['543|551']);
  });

  it('unknown é filtrado igual (query + nobre) e generatedAt é preservado', () => {
    const input: Sg5VerifyResult = {
      generatedAt: '2026-08-26T12:00:00.000Z',
      villages: [village('543|551', [row({ commandId: 1, playerName: 'João', type: 'attack', hasNoble: true })])],
      unknown: [row({ commandId: 50, playerName: 'Joãozão', type: 'attack', hasNoble: true }), row({ commandId: 51, playerName: 'Misterioso', type: 'support', hasNoble: false })],
    };
    const out = filterSg5Result(input, { ...EMPTY_SG5_VIEW_FILTER, query: 'joao', types: ['attack'], noble: 'com' }, new Date());
    expect(out.unknown.map((c) => c.commandId)).toEqual([50]);
    expect(out.villages[0]?.commands.map((c) => c.commandId)).toEqual([1]);
    expect(out.generatedAt).toBe('2026-08-26T12:00:00.000Z');
  });

  it('unknown com commandId âncora em villages usa o loadedAt da aldeia para status; sem âncora o status não corta', () => {
    const input: Sg5VerifyResult = {
      generatedAt: 'x',
      villages: [village('543|551', [row({ commandId: 77, arrivalSecFromLoad: 100 })])], // chega em LOAD_A + 100 s
      unknown: [row({ commandId: 77, arrivalSecFromLoad: 100 }), row({ commandId: 88, arrivalSecFromLoad: 100 })],
    };
    const ids = (status: 'chegados' | 'pendentes'): number[] =>
      filterSg5Result(input, { ...EMPTY_SG5_VIEW_FILTER, status }, new Date(LOAD_A + 50 * 1000)).unknown.map((c) => c.commandId);
    expect(ids('chegados')).toEqual([88]); // 77 é futuro (âncora recuperada); 88 sem âncora passa
    expect(ids('pendentes')).toEqual([77, 88]);
  });

  it('imutabilidade: input intacto (deep) e arrays de commands do output são cópias com as mesmas linhas', () => {
    const input: Sg5VerifyResult = {
      generatedAt: 'x',
      villages: [village('543|551', [row({ commandId: 1, type: 'attack' }), row({ commandId: 2, type: 'support' })])],
      unknown: [row({ commandId: 3, type: 'attack' })],
    };
    const snapshot = structuredClone(input);
    const out = filterSg5Result(input, { ...EMPTY_SG5_VIEW_FILTER, types: ['attack'] }, new Date());
    expect(input).toEqual(snapshot); // nada foi mutado no original
    expect(out.villages[0]?.commands).not.toBe(input.villages[0]?.commands); // array novo
    expect(out.villages[0]?.commands[0]).toBe(input.villages[0]?.commands[0]); // linha original reutilizada sem cópia
    expect(out.unknown).not.toBe(input.unknown);
    // Identidade também não reaproveita os arrays do input.
    const identity = filterSg5Result(input, EMPTY_SG5_VIEW_FILTER, new Date());
    expect(identity).toEqual(input);
    expect(identity.villages[0]?.commands).not.toBe(input.villages[0]?.commands);
  });
});

describe('distinctCommandTypes', () => {
  it('tipos distintos de villages + unknown, ordenados e sem duplicatas', () => {
    const input: Sg5VerifyResult = {
      generatedAt: 'x',
      villages: [village('543|551', [row({ type: 'support' }), row({ type: 'attack' })]), village('460|480', [row({ type: 'support' })])],
      unknown: [row({ type: 'attack' }), row({ type: 'unknown' }), row({ type: '' })],
    };
    expect(distinctCommandTypes(input)).toEqual(['attack', 'support', 'unknown']);
  });

  it('sem comandos (e aldeias vazias) → lista vazia, nunca lança', () => {
    expect(distinctCommandTypes({ generatedAt: 'x', villages: [], unknown: [] })).toEqual([]);
    expect(distinctCommandTypes({ generatedAt: 'x', villages: [village('543|551', [])], unknown: [] })).toEqual([]);
  });
});
