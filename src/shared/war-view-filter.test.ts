// Testes dos filtros de busca das tabelas da Sala de Guerra (monitoramento):
// contains acento/case-insensitive (fold) nos dois lados, sem query = tudo,
// sem match = lista vazia — e fail-soft (filtro/rows nulos nunca lançam).
import { describe, expect, it } from 'vitest';
import type { WarOutcomeRow, WarPerPlayerRow, WarScorecardRow } from './war-view-filter';
import { EMPTY_WAR_VIEW_FILTER, filterOutcomes, filterPerPlayer, filterScorecard, hasWarFilter } from './war-view-filter';

function perPlayerRow(overrides: Partial<WarPerPlayerRow> = {}): WarPerPlayerRow {
  return { playerName: 'Rodrigues', assigned: 3, sent: 3, ...overrides };
}

function scorecardRow(overrides: Partial<WarScorecardRow> = {}): WarScorecardRow {
  return { playerName: 'Rodrigues', opsParticipated: 4, expected: 12, sent: 11, missed: 1, ...overrides };
}

function outcomeRow(overrides: Partial<WarOutcomeRow> = {}): WarOutcomeRow {
  return { coord: '543|551', ...overrides };
}

describe('EMPTY_WAR_VIEW_FILTER', () => {
  it('é o filtro neutro congelado (tudo passa)', () => {
    expect(EMPTY_WAR_VIEW_FILTER).toEqual({ query: '' });
    expect(Object.isFrozen(EMPTY_WAR_VIEW_FILTER)).toBe(true);
  });
});

describe('hasWarFilter', () => {
  it('verdadeiro só com query não vazia após trim', () => {
    expect(hasWarFilter({ query: 'joao' })).toBe(true);
    expect(hasWarFilter({ query: '   ' })).toBe(false);
    expect(hasWarFilter({ query: '' })).toBe(false);
  });

  it('filtro nulo/ausente = sem busca (fail-soft, não lança)', () => {
    expect(hasWarFilter(null)).toBe(false);
    expect(hasWarFilter(undefined)).toBe(false);
    // Filtro torto (query não-string) é tratado como vazio.
    expect(hasWarFilter({ query: undefined as unknown as string })).toBe(false);
  });
});

describe('filterPerPlayer', () => {
  const rows: WarPerPlayerRow[] = [
    perPlayerRow({ playerName: 'João', assigned: 5, sent: 4 }),
    perPlayerRow({ playerName: 'Rodrigues', assigned: 3, sent: 3 }),
    perPlayerRow({ playerName: 'Jão', assigned: 2, sent: 0 }),
  ];

  it('query é contains acento/case-insensitive sobre playerName ("joao" acha "João")', () => {
    // "joao" (sem acento) acha "João"; "Jão" vinca só "jao", então fica de fora.
    expect(filterPerPlayer(rows, { query: 'joao' }).map((row) => row.playerName)).toEqual(['João']);
    // Com acento/maiúscula no filtro acha dado SEM acento (dobramento nos dois lados).
    expect(filterPerPlayer(rows, { query: 'JOÃO' }).map((row) => row.playerName)).toEqual(['João']);
    // "ÃO" dobra p/ "ao" e acha os dois ("joao" e "jao"), na ordem recebida.
    expect(filterPerPlayer(rows, { query: 'ÃO' }).map((row) => row.playerName)).toEqual(['João', 'Jão']);
  });

  it('query é contains parcial (substring), não igualdade', () => {
    expect(filterPerPlayer(rows, { query: 'drig' }).map((row) => row.playerName)).toEqual(['Rodrigues']);
  });

  it('sem query devolve tudo; sem match devolve lista vazia', () => {
    expect(filterPerPlayer(rows, EMPTY_WAR_VIEW_FILTER)).toHaveLength(3);
    expect(filterPerPlayer(rows, { query: '   ' })).toHaveLength(3);
    expect(filterPerPlayer(rows, { query: 'xandão' })).toEqual([]);
  });

  it('preserva as referências que passaram e não muta o input', () => {
    const result = filterPerPlayer(rows, { query: 'João' });
    expect(result[0]).toBe(rows[0]);
    expect(rows).toHaveLength(3);
  });

  it('fail-soft: rows nulo = [] e filtro nulo = tudo; linha torta não lança', () => {
    expect(filterPerPlayer(null, { query: 'joao' })).toEqual([]);
    expect(filterPerPlayer(undefined, EMPTY_WAR_VIEW_FILTER)).toEqual([]);
    expect(filterPerPlayer(rows, null)).toHaveLength(3);
    expect(filterPerPlayer(rows, undefined)).toHaveLength(3);
    const torta = [{ playerName: null, assigned: 1, sent: 0 }] as unknown as WarPerPlayerRow[];
    expect(filterPerPlayer(torta, { query: 'joao' })).toEqual([]);
    expect(filterPerPlayer(torta, EMPTY_WAR_VIEW_FILTER)).toHaveLength(1);
  });
});

describe('filterScorecard', () => {
  const rows: WarScorecardRow[] = [
    scorecardRow({ playerName: 'José', opsParticipated: 4, expected: 12, sent: 11, missed: 1 }),
    scorecardRow({ playerName: 'Maria de Fátima', opsParticipated: 2, expected: 6, sent: 6, missed: 0 }),
  ];

  it('mesma semântica do per-player: acento/case-insensitive sobre playerName', () => {
    expect(filterScorecard(rows, { query: 'jose' }).map((row) => row.playerName)).toEqual(['José']);
    expect(filterScorecard(rows, { query: 'FÁTIMA' }).map((row) => row.playerName)).toEqual(['Maria de Fátima']);
    // Números do row não entram na busca (só o nome).
    expect(filterScorecard(rows, { query: '12' })).toEqual([]);
  });

  it('sem query devolve tudo; sem match devolve lista vazia', () => {
    expect(filterScorecard(rows, EMPTY_WAR_VIEW_FILTER)).toHaveLength(2);
    expect(filterScorecard(rows, { query: 'xandão' })).toEqual([]);
  });

  it('fail-soft: rows/filtro nulos nunca lançam', () => {
    expect(filterScorecard(null, { query: 'jose' })).toEqual([]);
    expect(filterScorecard(rows, null)).toHaveLength(2);
  });
});

describe('filterOutcomes', () => {
  const rows: WarOutcomeRow[] = [outcomeRow({ coord: '543|551' }), outcomeRow({ coord: '460|480' }), outcomeRow({ coord: '544|551' })];

  it('busca por fold(coord): contains parcial acha os alvos certos, na ordem', () => {
    expect(filterOutcomes(rows, { query: '543|551' }).map((row) => row.coord)).toEqual(['543|551']);
    expect(filterOutcomes(rows, { query: '551' }).map((row) => row.coord)).toEqual(['543|551', '544|551']);
    expect(filterOutcomes(rows, { query: '460' }).map((row) => row.coord)).toEqual(['460|480']);
  });

  it('sem query devolve tudo; sem match devolve lista vazia', () => {
    expect(filterOutcomes(rows, EMPTY_WAR_VIEW_FILTER)).toHaveLength(3);
    expect(filterOutcomes(rows, { query: '999|999' })).toEqual([]);
  });

  it('fail-soft: rows/filtro nulos nunca lançam', () => {
    expect(filterOutcomes(null, { query: '543' })).toEqual([]);
    expect(filterOutcomes(rows, null)).toHaveLength(3);
  });
});
