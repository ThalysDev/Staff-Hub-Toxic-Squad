import { describe, expect, it } from 'vitest';
import type { JournalEntry } from './ipc-types';
import {
  coalesceRepeated,
  distinctActions,
  filterJournalEntries,
  groupByDay,
  journalToCsv,
  journalToJson,
  type JournalFilterState,
} from './journal-filter';

/** Entrada mínima válida (mesma forma do JournalEntry do journal.ts). */
function entry(partial: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: 'id-1',
    ts: '2026-08-26T12:00:00.000Z',
    kind: 'read',
    action: 'world-relations',
    detail: 'Diplomacia lida',
    dryRun: false,
    ...partial,
  };
}

/** Filtro com padrão "tudo passa"; o teste sobrescreve só o que interessa. */
function state(partial: Partial<JournalFilterState> = {}): JournalFilterState {
  return { query: '', kinds: [], actions: [], ...partial };
}

describe('filterJournalEntries / query', () => {
  const entries = [
    entry({ id: 'a', action: 'sg5-verify', detail: 'Verificação de comandos concluída' }),
    entry({ id: 'b', action: 'sg2-tropa', detail: 'Análise de tropas do jogador Gandalf' }),
    entry({ id: 'c', action: 'mp-send', detail: 'MP enviada para Saruman' }),
  ];

  it('busca sem acento acha texto acentuado ("verificaçao" → "Verificação")', () => {
    const kept = filterJournalEntries(entries, state({ query: 'verificaçao' }));
    expect(kept.map((e) => e.id)).toEqual(['a']);
  });

  it('busca é case e acento-insensitive nos dois sentidos ("ANALISE" → "Análise")', () => {
    const kept = filterJournalEntries(entries, state({ query: 'ANALISE' }));
    expect(kept.map((e) => e.id)).toEqual(['b']);
  });

  it('busca vale para action e para detail', () => {
    expect(filterJournalEntries(entries, state({ query: 'mp-send' })).map((e) => e.id)).toEqual(['c']);
    expect(filterJournalEntries(entries, state({ query: 'saruman' })).map((e) => e.id)).toEqual(['c']);
  });

  it('query vazia ou só espaços deixa tudo passar', () => {
    expect(filterJournalEntries(entries, state({ query: '' }))).toHaveLength(3);
    expect(filterJournalEntries(entries, state({ query: '   ' }))).toHaveLength(3);
  });
});

describe('filterJournalEntries / kinds e actions', () => {
  const entries = [
    entry({ id: 'a', kind: 'read', action: 'collect-members' }),
    entry({ id: 'b', kind: 'mutation', action: 'mp-send', dryRun: true }),
    entry({ id: 'c', kind: 'session', action: 'login' }),
    entry({ id: 'd', kind: 'system', action: 'settings-boot' }),
  ];

  it('kinds múltiplos incluem só os tipos pedidos, na ordem original', () => {
    const kept = filterJournalEntries(entries, state({ kinds: ['read', 'session'] }));
    expect(kept.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('kinds vazio inclui todos', () => {
    expect(filterJournalEntries(entries, state({ kinds: [] }))).toHaveLength(4);
  });

  it('actions filtra pelo valor cru do campo action', () => {
    const kept = filterJournalEntries(entries, state({ actions: ['mp-send', 'settings-boot'] }));
    expect(kept.map((e) => e.id)).toEqual(['b', 'd']);
  });

  it('actions vazio inclui todos', () => {
    expect(filterJournalEntries(entries, state({ actions: [] }))).toHaveLength(4);
  });
});

/** ts ISO construído em hora LOCAL (testes independentes do fuso da máquina). */
function localTs(month: number, day: number, hour: number, minute = 0): string {
  return new Date(2026, month - 1, day, hour, minute).toISOString();
}

describe('filterJournalEntries / período (dias LOCAIS)', () => {
  // Entradas em horas LOCAIS de 25–27/08/2026 (new Date(y, m, d, h) — sem UTC).
  const entries = [
    entry({ id: 'ante-23h', ts: localTs(8, 25, 23) }),
    entry({ id: 'meia-noite', ts: localTs(8, 26, 0) }),
    entry({ id: 'meio-dia', ts: localTs(8, 26, 12) }),
    entry({ id: 'noite-22h', ts: localTs(8, 26, 22) }),
    entry({ id: 'depois', ts: localTs(8, 27, 0) }),
  ];

  it('from é inclusivo na meia-noite LOCAL: 23h local do dia anterior fica de fora', () => {
    const kept = filterJournalEntries(entries, state({ from: '2026-08-26' }));
    expect(kept.map((e) => e.id)).toEqual(['meia-noite', 'meio-dia', 'noite-22h', 'depois']);
  });

  it('to é inclusivo até o fim do dia LOCAL: 22h local do próprio dia entra (em UTC-3 antes ficava de fora)', () => {
    const kept = filterJournalEntries(entries, state({ to: '2026-08-26' }));
    expect(kept.map((e) => e.id)).toEqual(['ante-23h', 'meia-noite', 'meio-dia', 'noite-22h']);
  });

  it('to no dia anterior EXCLUI a entrada de 22h local do dia X', () => {
    const kept = filterJournalEntries(entries, state({ to: '2026-08-25' }));
    expect(kept.map((e) => e.id)).toEqual(['ante-23h']);
  });

  it('from + to fecham o dia LOCAL inteiro', () => {
    const kept = filterJournalEntries(entries, state({ from: '2026-08-26', to: '2026-08-26' }));
    expect(kept.map((e) => e.id)).toEqual(['meia-noite', 'meio-dia', 'noite-22h']);
  });

  it('período que não cobre nenhuma entrada devolve lista vazia', () => {
    expect(filterJournalEntries(entries, state({ from: '2027-01-01', to: '2027-01-02' }))).toEqual([]);
  });

  it('to no futuro deixa tudo passar', () => {
    expect(filterJournalEntries(entries, state({ to: '2999-12-31' }))).toHaveLength(5);
  });

  it('to atravessa virada de mês e de ano (fim do dia LOCAL)', () => {
    const virada = [
      entry({ id: 'fim', ts: new Date(2026, 11, 31, 22).toISOString() }),
      entry({ id: 'ano-novo', ts: new Date(2027, 0, 1, 0, 1).toISOString() }),
    ];
    const kept = filterJournalEntries(virada, state({ to: '2026-12-31' }));
    expect(kept.map((e) => e.id)).toEqual(['fim']);
  });

  it('bounds inválidos são ignorados em vez de sumir com o histórico', () => {
    expect(filterJournalEntries(entries, state({ from: '26/08/2026' }))).toHaveLength(5);
    expect(filterJournalEntries(entries, state({ to: '2026-02-30' }))).toHaveLength(5);
  });
});

describe('filterJournalEntries / contrato genérico', () => {
  interface RichEntry extends JournalEntry {
    opName: string;
  }

  it('preserva o tipo T (campos extras) e as referências originais', () => {
    const rich: RichEntry[] = [
      { ...entry({ id: 'a', action: 'reserve', detail: 'Reserva da aldeia 500|123' }), opName: 'OP Aurora' },
      { ...entry({ id: 'b', action: 'mp-send' }), opName: 'OP Aurora' },
    ];
    const kept = filterJournalEntries<RichEntry>(rich, state({ query: 'reserva' }));
    expect(kept.map((e) => e.opName)).toEqual(['OP Aurora']);
    expect(kept[0]).toBe(rich[0]);
  });

  it('filtro totalmente vazio deixa tudo passar', () => {
    const entries = [entry({ id: 'a' }), entry({ id: 'b' })];
    expect(filterJournalEntries(entries, state())).toHaveLength(2);
  });
});

describe('distinctActions', () => {
  it('devolve ações distintas, sem duplicatas e ordenadas', () => {
    const entries = [
      entry({ action: 'reserve' }),
      entry({ action: 'mp-send' }),
      entry({ action: 'sg1-analyze' }),
      entry({ action: 'session' }),
      entry({ action: 'reserve' }),
      entry({ action: 'mp-send' }),
    ];
    expect(distinctActions(entries)).toEqual(['mp-send', 'reserve', 'session', 'sg1-analyze']);
  });

  it('lista vazia devolve lista vazia', () => {
    expect(distinctActions([])).toEqual([]);
  });
});

describe('journalToCsv', () => {
  it('emite o cabeçalho pt-BR e uma linha por entrada', () => {
    const csv = journalToCsv([
      entry({
        ts: '2026-08-26T12:00:00.000Z',
        kind: 'mutation',
        action: 'reserve',
        detail: 'Reserva de Cavalaria',
        dryRun: true,
      }),
    ]);
    expect(csv).toBe('Data;Tipo;Ação;Detalhe;Teste\n2026-08-26T12:00:00.000Z;mutation;reserve;Reserva de Cavalaria;Sim');
  });

  it('escapa ponto-e-vírgula, aspas e quebra de linha no detail', () => {
    const csv = journalToCsv([
      entry({
        ts: '2026-08-26T12:00:00.000Z',
        kind: 'read',
        action: 'collect-members',
        detail: 'Cavalaria "A"; 12 aldeias\nsegunda linha',
      }),
    ]);
    expect(csv).toBe(
      'Data;Tipo;Ação;Detalhe;Teste\n' +
        '2026-08-26T12:00:00.000Z;read;collect-members;"Cavalaria ""A""; 12 aldeias\nsegunda linha";Não',
    );
  });

  it('lista vazia devolve só o cabeçalho', () => {
    expect(journalToCsv([])).toBe('Data;Tipo;Ação;Detalhe;Teste');
  });
});

describe('journalToJson', () => {
  const entries = [
    entry({ id: 'a', kind: 'mutation', action: 'reserve', detail: 'Reserva da aldeia 123|456', dryRun: false }),
    entry({ id: 'b', kind: 'session', action: 'login', detail: 'Login do líder', dryRun: false }),
  ];

  it('produz array JSON puro, parseável e sem BOM', () => {
    const json = journalToJson(entries);
    expect(json.charCodeAt(0)).toBe('['.charCodeAt(0));
    expect(JSON.parse(json)).toEqual(entries.map((e) => ({ ...e })));
  });

  it('usa indent 2 e só os campos públicos (extras descartados)', () => {
    const rich: (JournalEntry & { opName: string })[] = [{ ...entries[0]!, opName: 'OP Aurora' }];
    const json = journalToJson(rich);
    expect(json).toContain('\n    "id"');
    expect(JSON.parse(json)).toEqual([{ ...entries[0]! }]);
  });

  it('lista vazia devolve "[]"', () => {
    expect(journalToJson([])).toBe('[]');
  });
});

// ---- WAVE 1-B: agrupamento por dia + coalescência de repetições ----

/** "Agora" fixo: quarta-feira, 2 de setembro de 2026, meio-dia local. */
const AGORA = new Date(2026, 8, 2, 12, 0);

describe('groupByDay', () => {
  it('MESMO dia em horas diferentes cai em UM grupo único (relativo não divide o dia)', () => {
    const entries = [
      entry({ id: 'hoje-09', ts: localTs(9, 2, 9) }),
      entry({ id: 'ontem-22', ts: localTs(9, 1, 22) }),
      entry({ id: 'hoje-11', ts: localTs(9, 2, 11, 30) }),
      entry({ id: 'hoje-08', ts: localTs(9, 2, 8) }),
    ];
    const groups = groupByDay(entries, AGORA);
    expect(groups.map((g) => g.key)).toEqual(['2026-09-02', '2026-09-01']);
    expect(groups[0]?.entries.map((e) => e.id)).toEqual(['hoje-11', 'hoje-09', 'hoje-08']);
    expect(groups[1]?.entries.map((e) => e.id)).toEqual(['ontem-22']);
  });

  it('chave é a data LOCAL "YYYY-MM-DD" (não a data UTC do toISOString)', () => {
    const groups = groupByDay([entry({ id: 'madrugada', ts: localTs(9, 2, 0, 30) })], AGORA);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('2026-09-02');
    expect(groups[0]?.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('grupos e entradas ficam ordenados desc mesmo com entrada fora de ordem (defensivo)', () => {
    const entries = [
      entry({ id: 'dia-31', ts: localTs(8, 31, 10) }),
      entry({ id: 'hoje', ts: localTs(9, 2, 10) }),
      entry({ id: 'ontem', ts: localTs(9, 1, 10) }),
      entry({ id: 'hoje-cedo', ts: localTs(9, 2, 7) }),
    ];
    const groups = groupByDay(entries, AGORA);
    expect(groups.map((g) => g.key)).toEqual(['2026-09-02', '2026-09-01', '2026-08-31']);
    expect(groups[0]?.entries.map((e) => e.id)).toEqual(['hoje', 'hoje-cedo']);
  });

  it('rótulo de hoje tem a forma "Hoje · <data por extenso pt-BR>"', () => {
    const groups = groupByDay([entry({ ts: localTs(9, 2, 9) })], AGORA);
    const label = groups[0]?.label ?? '';
    expect(label.startsWith('Hoje · ')).toBe(true);
    expect(label).toContain('2 de setembro de 2026');
  });

  it('ontem usa prefixo "Ontem · " e dia mais antigo só a data por extenso', () => {
    const groups = groupByDay(
      [entry({ id: 'o', ts: localTs(9, 1, 9) }), entry({ id: 'v', ts: localTs(8, 31, 9) })],
      AGORA,
    );
    expect(groups[0]?.label.startsWith('Ontem · ')).toBe(true);
    expect(groups[0]?.label).toContain('1 de setembro de 2026');
    expect(groups[1]?.label).toBe('Segunda-feira, 31 de agosto de 2026');
    expect(groups[1]?.label).not.toContain('·');
  });

  it('ts inválido vira grupo "Data indisponível" isolado e por último', () => {
    const groups = groupByDay(
      [entry({ id: 'lixo', ts: 'não é data' }), entry({ id: 'hoje', ts: localTs(9, 2, 9) })],
      AGORA,
    );
    expect(groups.map((g) => g.key)).toEqual(['2026-09-02', 'data-indisponivel']);
    expect(groups[1]?.label).toBe('Data indisponível');
    expect(groups[1]?.entries.map((e) => e.id)).toEqual(['lixo']);
  });

  it('lista vazia devolve lista vazia', () => {
    expect(groupByDay([], AGORA)).toEqual([]);
  });
});

describe('coalesceRepeated', () => {
  const runs = (
    id: string,
    ts: string,
    kind: JournalEntry['kind'] = 'system',
    action = 'settings-boot',
    detail = 'pacing boot: 350ms',
  ) => entry({ id, ts, kind, action, detail });

  it('colapsa trecho CONSECUTIVO idêntico em uma linha com contagem e intervalo de ts', () => {
    const out = coalesceRepeated([
      runs('novo', '2026-09-02T12:00:00.000Z'),
      runs('meio', '2026-09-01T12:00:00.000Z'),
      runs('velho', '2026-08-31T12:00:00.000Z'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.count).toBe(3);
    expect(out[0]?.entry.id).toBe('novo');
    expect(out[0]?.firstTs).toBe('2026-09-02T12:00:00.000Z');
    expect(out[0]?.lastTs).toBe('2026-08-31T12:00:00.000Z');
  });

  it('repetição NÃO adjacente continua separada', () => {
    const out = coalesceRepeated([
      runs('a', '2026-09-02T12:00:00.000Z'),
      entry({ id: 'b', ts: '2026-09-02T11:00:00.000Z', action: 'mp-send', detail: 'MP' }),
      runs('a2', '2026-09-02T10:00:00.000Z'),
    ]);
    expect(out.map((r) => r.entry.id)).toEqual(['a', 'b', 'a2']);
    expect(out.every((r) => r.count === 1)).toBe(true);
  });

  it('diferença em kind, action ou detail quebra o trecho', () => {
    const out = coalesceRepeated([
      runs('a', '2026-09-02T12:00:00.000Z'),
      runs('kind', '2026-09-02T11:00:00.000Z', 'read'),
      runs('action', '2026-09-02T10:00:00.000Z', 'system', 'settings-update'),
      runs('detail', '2026-09-02T09:00:00.000Z', 'system', 'settings-boot', 'outro detalhe'),
    ]);
    expect(out).toHaveLength(4);
    expect(out.every((r) => r.count === 1)).toBe(true);
  });

  it('entrada única fica com count 1 e lista vazia devolve []', () => {
    const single = coalesceRepeated([runs('só', '2026-09-02T12:00:00.000Z')]);
    expect(single).toHaveLength(1);
    expect(single[0]?.count).toBe(1);
    expect(single[0]?.firstTs).toBe(single[0]?.lastTs);
    expect(coalesceRepeated([])).toEqual([]);
  });
});

describe('filtro por tipo — alias legado write (P2 revisão 2 v0.35)', () => {
  const linhas = [
    { ts: '2026-09-03T10:00:00', kind: 'write' as const, action: 'sg6-sendmps', detail: 'legado' },
    { ts: '2026-09-03T11:00:00', kind: 'mutation' as const, action: 'sg6-sendmps', detail: 'novo' },
    { ts: '2026-09-03T12:00:00', kind: 'read' as const, action: 'collect-members', detail: 'leitura' },
  ];

  it('chip Mutação pega mutation E o legado write', () => {
    const out = filterJournalEntries(linhas, { query: '', actions: [], kinds: ['mutation'] });
    expect(out.map((e) => e.detail)).toEqual(['legado', 'novo']);
  });

  it('chip Leitura continua sem pegar write', () => {
    expect(filterJournalEntries(linhas, { query: '', actions: [], kinds: ['read'] }).map((e) => e.detail)).toEqual(['leitura']);
  });
});
