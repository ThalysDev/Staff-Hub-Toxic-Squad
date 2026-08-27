import { describe, expect, it } from 'vitest';
import type { JournalEntry } from './ipc-types';
import {
  distinctActions,
  filterJournalEntries,
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

describe('filterJournalEntries / período', () => {
  const entries = [
    entry({ id: 'ante', ts: '2026-08-25T23:59:59.999Z' }),
    entry({ id: 'meia-noite', ts: '2026-08-26T00:00:00.000Z' }),
    entry({ id: 'meio-dia', ts: '2026-08-26T12:00:00.000Z' }),
    entry({ id: 'fim-do-dia', ts: '2026-08-26T23:59:59.999Z' }),
    entry({ id: 'depois', ts: '2026-08-27T00:00:00.000Z' }),
  ];

  it('from é inclusivo: entra o dia inteiro do from em diante', () => {
    const kept = filterJournalEntries(entries, state({ from: '2026-08-26' }));
    expect(kept.map((e) => e.id)).toEqual(['meia-noite', 'meio-dia', 'fim-do-dia', 'depois']);
  });

  it('to é inclusivo no próprio dia e exclusivo no dia seguinte', () => {
    const kept = filterJournalEntries(entries, state({ to: '2026-08-26' }));
    expect(kept.map((e) => e.id)).toEqual(['ante', 'meia-noite', 'meio-dia', 'fim-do-dia']);
  });

  it('from + to fecham a janela', () => {
    const kept = filterJournalEntries(entries, state({ from: '2026-08-26', to: '2026-08-26' }));
    expect(kept.map((e) => e.id)).toEqual(['meia-noite', 'meio-dia', 'fim-do-dia']);
  });

  it('período que não cobre nenhuma entrada devolve lista vazia', () => {
    expect(filterJournalEntries(entries, state({ from: '2027-01-01', to: '2027-01-02' }))).toEqual([]);
  });

  it('to no futuro deixa tudo passar', () => {
    expect(filterJournalEntries(entries, state({ to: '2999-12-31' }))).toHaveLength(5);
  });

  it('to+1 dia atravessa virada de mês e de ano', () => {
    const virada = [
      entry({ id: 'fim', ts: '2026-12-31T23:59:59.999Z' }),
      entry({ id: 'ano-novo', ts: '2027-01-01T00:00:00.000Z' }),
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
