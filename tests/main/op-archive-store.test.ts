import { describe, expect, it } from 'vitest';
import type { OpArchiveEntry } from '../../src/shared/ipc-types';
import {
  OP_ARCHIVE_LIMIT,
  capOps,
  createOpEntry,
  hasDistributionRow,
  normalizeOpInput,
  sortNewestFirst,
  updateOpEntry,
  upsertOp,
  withConference,
} from '../../src/shared/op-archive-rules';

const VALID_INPUT = {
  title: 'OP Barreira Norte',
  targets: ['500|500', '501|501'],
  distribution: 'Joao;500|500\nMaria;501|501',
};

function entry(id: string, createdAt: string): OpArchiveEntry {
  return {
    id,
    title: `OP ${id}`,
    createdAt,
    targets: ['500|500'],
    distribution: 'Joao;500|500',
  };
}

describe('normalizeOpInput (fail-closed)', () => {
  it('normaliza título e descarta alvos em branco', () => {
    expect(normalizeOpInput({ ...VALID_INPUT, targets: [' 500|500 ', '', '   '] })).toEqual({
      title: 'OP Barreira Norte',
      targets: ['500|500'],
    });
  });

  it('rejeita título vazio/só espaços', () => {
    expect(() => normalizeOpInput({ ...VALID_INPUT, title: '   ' })).toThrow('Título da OP vazio');
  });

  it('rejeita entrada sem nenhum alvo', () => {
    expect(() => normalizeOpInput({ ...VALID_INPUT, targets: [] })).toThrow('Nenhum alvo informado');
    expect(() => normalizeOpInput({ ...VALID_INPUT, targets: ['  ', ''] })).toThrow('Nenhum alvo informado');
  });

  it('rejeita distribuição sem linha útil "nick;coords"', () => {
    expect(() => normalizeOpInput({ ...VALID_INPUT, distribution: '' })).toThrow('Distribuição sem nenhuma linha');
    expect(() => normalizeOpInput({ ...VALID_INPUT, distribution: '\n \n;' })).toThrow('Distribuição sem nenhuma linha');
    expect(() => normalizeOpInput({ ...VALID_INPUT, distribution: 'sem ponto e vírgula' })).toThrow('Distribuição sem nenhuma linha');
    expect(() => normalizeOpInput({ ...VALID_INPUT, distribution: ';500|500' })).toThrow('Distribuição sem nenhuma linha');
    expect(() => normalizeOpInput({ ...VALID_INPUT, distribution: 'Joao;   ' })).toThrow('Distribuição sem nenhuma linha');
  });

  it('aceita linhas válidas com espaços extras e tolera linhas vazias no meio', () => {
    expect(hasDistributionRow('\n  Joao ; 500|500  \n')).toBe(true);
    expect(hasDistributionRow(VALID_INPUT.distribution)).toBe(true);
  });
});

describe('create/update-merge', () => {
  it('createOpEntry gera nova OP com id/createdAt dados e agenda quando presente', () => {
    const data = normalizeOpInput(VALID_INPUT);
    const semAgenda = createOpEntry(data, VALID_INPUT.distribution, undefined, 'id-1', '2026-01-01T10:00:00.000Z');
    expect(semAgenda).toEqual({
      id: 'id-1',
      title: 'OP Barreira Norte',
      createdAt: '2026-01-01T10:00:00.000Z',
      targets: ['500|500', '501|501'],
      distribution: VALID_INPUT.distribution,
    });
    const comAgenda = createOpEntry(data, VALID_INPUT.distribution, 'Joao;500|500;12:00:00', 'id-2', '2026-01-02T10:00:00.000Z');
    expect(comAgenda.sendSchedule).toBe('Joao;500|500;12:00:00');
  });

  it('updateOpEntry substitui campos de edição e PRESERVA id/createdAt/conference/totals', () => {
    const existing: OpArchiveEntry = {
      ...entry('op-1', '2025-06-01T08:00:00.000Z'),
      sendSchedule: 'antigo;500|500;09:00:00',
      conference: { verifiedAt: '2025-06-02T02:00:00.000Z', coveragePct: 95, perPlayer: [], targetsWithoutCommand: [] },
      totals: [{ playerName: 'Joao', attacks: 3, fakes: 1, nobleAttacks: 0, supports: 0, total: 4 }],
    };
    const data = normalizeOpInput({ ...VALID_INPUT, title: ' OP Retomada ' });
    const updated = updateOpEntry(existing, data, 'Nova;502|502', 'Nova;502|502;23:30:00');
    expect(updated.id).toBe('op-1');
    expect(updated.createdAt).toBe('2025-06-01T08:00:00.000Z');
    expect(updated.title).toBe('OP Retomada');
    expect(updated.targets).toEqual(['500|500', '501|501']);
    expect(updated.distribution).toBe('Nova;502|502');
    expect(updated.sendSchedule).toBe('Nova;502|502;23:30:00');
    expect(updated.conference?.coveragePct).toBe(95);
    expect(updated.totals).toHaveLength(1);
    // original não mutado
    expect(existing.title).toBe('OP op-1');
    expect(existing.targets).toEqual(['500|500']);
  });

  it('updateOpEntry sem agenda REMOVE a agenda anterior (exactOptionalPropertyTypes)', () => {
    const updated = updateOpEntry({ ...entry('op-1', '2025-06-01T08:00:00.000Z'), sendSchedule: 'x;1|1;00:00:00' }, normalizeOpInput(VALID_INPUT), VALID_INPUT.distribution, undefined);
    expect('sendSchedule' in updated).toBe(false);
  });
});

describe('upsert + cap-200 + ordenação', () => {
  it('upsertOp insere nova e substitui existente pelo id, sem mutar o array', () => {
    const a = entry('a', '2025-01-01T00:00:00.000Z');
    const b = entry('b', '2025-01-02T00:00:00.000Z');
    const inserted = upsertOp([a], b);
    expect(inserted).toHaveLength(2);
    expect(a).toEqual(entry('a', '2025-01-01T00:00:00.000Z'));
    const replacedTitle = { ...b, title: 'OP B editada' };
    const replaced = upsertOp(inserted, replacedTitle);
    expect(replaced).toHaveLength(2);
    expect(replaced.find((op) => op.id === 'b')?.title).toBe('OP B editada');
  });

  it('cap-200: acima do limite remove as mais antigas, mas NUNCA a OP salva', () => {
    const ops: OpArchiveEntry[] = [];
    for (let i = 0; i < 205; i++) {
      // mais antigo primeiro; ids "op-000".."op-204"
      ops.push(entry(`op-${String(i).padStart(3, '0')}`, new Date(Date.UTC(2025, 0, 1 + i)).toISOString()));
    }
    const keptId = 'op-000'; // a mais ANTIGA é justamente a que está sendo salva
    const capped = capOps([...ops, { ...entry(keptId, ops[0]!.createdAt), title: 'OP salva agora' }], keptId);
    expect(capped).toHaveLength(OP_ARCHIVE_LIMIT);
    expect(capped.some((op) => op.id === keptId)).toBe(true);
    // as 5 mais antigas restantes (op-001..op-005) caem fora — op-000 é preservada
    for (let i = 1; i <= 5; i++) {
      expect(capped.some((op) => op.id === `op-${String(i).padStart(3, '0')}`)).toBe(false);
    }
    expect(capped.some((op) => op.id === 'op-204')).toBe(true);
  });

  it('capOps não altera nada quando dentro do limite e ordena por createdAt desc', () => {
    const ops = [entry('a', '2025-03-01T00:00:00.000Z'), entry('b', '2025-01-01T00:00:00.000Z'), entry('c', '2025-06-01T00:00:00.000Z')];
    expect(capOps(ops, 'a', 200)).toHaveLength(3);
    expect(sortNewestFirst(ops).map((op) => op.id)).toEqual(['c', 'a', 'b']);
    expect(ops.map((op) => op.id)).toEqual(['a', 'b', 'c']); // original intocado
  });
});

describe('withConference (attach)', () => {
  const base = entry('op-9', '2025-05-05T00:00:00.000Z');
  const conference = {
    verifiedAt: '2025-05-06T02:00:00.000Z',
    coveragePct: 80,
    perPlayer: [{ playerName: 'Joao', assigned: 2, sent: 2 }],
    targetsWithoutCommand: [],
  };

  it('substitui a conferência; totals substitui o totalizador quando informado', () => {
    const withTotals = withConference(base, conference, [
      { playerName: 'Joao', attacks: 1, fakes: 1, nobleAttacks: 1, supports: 1, total: 4 },
    ]);
    expect(withTotals.conference?.coveragePct).toBe(80);
    expect(withTotals.totals).toHaveLength(1);
    const again = withConference(withTotals, { ...conference, coveragePct: 100 }, []);
    expect(again.conference?.coveragePct).toBe(100);
    expect(again.totals).toEqual([]);
  });

  it('sem totals informado, PRESERVA totalizador já arquivado e o resto da OP', () => {
    const previous = { ...base, conference: { ...conference, coveragePct: 50 }, totals: [{ playerName: 'Maria', attacks: 0, fakes: 2, nobleAttacks: 0, supports: 0, total: 2 }] };
    const attached = withConference(previous, conference);
    expect(attached.conference?.coveragePct).toBe(80);
    expect(attached.totals).toHaveLength(1);
    expect(attached.id).toBe(base.id);
    expect(attached.createdAt).toBe(base.createdAt);
    expect('conference' in base).toBe(false); // original não mutado
  });
});
