import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISTRIBUTOR_SETTINGS,
  TROOP_UNIT_LABELS,
  TROOP_UNITS,
  assignmentsToPreview,
  buildDistributorInput,
  buildForumTable,
  buildRun,
  buildSchedulerSupportRecords,
  formatArrivalLabel,
  formatReferenceMs,
  formatUnitsSummary,
  fromDatetimeLocalValue,
  liveScheduledRecords,
  localReferenceMs,
  nextPendingIndex,
  normalizeDistributorSettings,
  parsePastedTimeMs,
  referenceMsFromServerClock,
  schedulerIsoFromReferenceMs,
  scheduledCommittedUnits,
  scheduledUnitsByVillage,
  sumLineUnits,
  sumNativeTroopRows,
  toDatetimeLocalValue,
  unmetToPreview,
  type NativeTroopRow,
  type SupportRun,
} from './apoio-massa-logic';
import { parseSupportLines } from '../../ext/modules/features/mass-support/support-line-codec';
import { distributeSupport } from '../../ext/modules/features/mass-support/support-distributor';

/** 23/09/2026 12:00:00.000 — relógio fixo dos testes (referência do codec). */
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0, 0);

const row = (villageId: number, x: number, y: number, units: Partial<Record<string, number>>): NativeTroopRow => {
  const filled: Record<string, number> = {};
  for (const unit of TROOP_UNITS) filled[unit] = units[unit] ?? 0;
  return { villageId, coord: { x, y }, units: filled };
};

const unitsText = (values: Partial<Record<string, number>> = {}, tail = ''): string => {
  const list = TROOP_UNITS.slice(0, 10)
    .map((unit) => values[unit] ?? 0)
    .join('/');
  return `500|500 ${list}${tail === '' ? '' : ` ${tail}`}`;
};

const linesOf = (text: string) => {
  const parsed = parseSupportLines(text, NOW);
  if (parsed.errors.length > 0) throw new Error(parsed.errors.map((entry) => entry.error).join('; '));
  return parsed.lines;
};

/** Velocidades sintéticas: referência (mais lenta) = 22 min/campo. */
const SPEEDS = { spear: 18, sword: 22, light: 10 } as Record<string, number>;
/** Viagem injetada = distância em minutos. */
const TRAVEL = (from: { x: number; y: number }, to: { x: number; y: number }): number =>
  Math.hypot(to.x - from.x, to.y - from.y);

describe('sumNativeTroopRows', () => {
  it('soma as 12 colunas das linhas nativas e ignora valor inválido', () => {
    const totals = sumNativeTroopRows([
      row(1, 0, 0, { spear: 100, knight: 1 }),
      { villageId: 2, coord: { x: 1, y: 1 }, units: { spear: 50, snob: 3, sword: Number.NaN, axe: -5 } },
    ]);
    expect(TROOP_UNITS).toEqual([
      'spear',
      'sword',
      'axe',
      'archer',
      'spy',
      'light',
      'marcher',
      'heavy',
      'ram',
      'catapult',
      'knight',
      'snob',
    ]);
    expect(totals['spear']).toBe(150);
    expect(totals['sword']).toBe(0);
    expect(totals['axe']).toBe(0);
    expect(totals['knight']).toBe(1);
    expect(totals['snob']).toBe(3);
    expect(Object.keys(totals)).toHaveLength(12);
  });

  it('some só as 10 unidades do codec nas linhas válidas do textarea', () => {
    const lines = linesOf(`${unitsText({ spear: 100, catapult: 5 })}\n${unitsText({ light: 20 })}`);
    const totals = sumLineUnits(lines);
    expect(totals['spear']).toBe(100);
    expect(totals['light']).toBe(20);
    expect(totals['catapult']).toBe(5);
    expect(totals['knight']).toBe(0);
    expect(totals['snob']).toBe(0);
  });
});

describe('liveScheduledRecords', () => {
  const state = {
    commands: [
      { kind: 'support', sourceVillageId: 'n111', units: { spear: 100 }, paused: false, events: [{ status: 'agendado' }] },
      { kind: 'attack', sourceVillageId: '222', units: { axe: 50 }, paused: true, events: [] },
      { kind: 'support', sourceVillageId: '333', units: { sword: 10 }, paused: false, events: [{ status: 'enviado' }] },
      { kind: 'fake', sourceVillageId: '444', units: { light: 7, knight: 2 }, paused: false, events: [] },
      'lixo',
    ],
    transit: [],
  };

  it('descarta pausados, terminais e lixo; normaliza o id da aldeia', () => {
    const records = liveScheduledRecords(state);
    expect(records.map((record) => record.sourceVillageId)).toEqual(['111', '444']);
    expect(records[1]?.units['knight']).toBe(2);
    expect(liveScheduledRecords(null)).toEqual([]);
  });

  it('separa comprometido com APOIO do consumo de TODO comando por aldeia', () => {
    const records = liveScheduledRecords(state);
    const committed = scheduledCommittedUnits(records);
    expect(committed['spear']).toBe(100);
    expect(committed['light']).toBe(0);
    const byVillage = scheduledUnitsByVillage(records);
    expect(byVillage['444']?.['light']).toBe(7);
    expect(byVillage['222']).toBeUndefined();
  });
});

describe('buildDistributorInput', () => {
  it('monta origens com paladino, agendadas e reserva; descarta linha sem coordenada', () => {
    const input = buildDistributorInput({
      rows: [row(1, 10, 20, { spear: 100, knight: 1 }), { villageId: 2, coord: null, units: { spear: 9 } }],
      lines: linesOf(unitsText({ spear: 1 })),
      settings: normalizeDistributorSettings({ reserveUnits: { spear: 5 } }),
      scheduledUnitsByVillage: { '1': { spear: 40 } },
      travelMinutes: TRAVEL,
      unitSpeedsMinutesPerField: SPEEDS,
    });
    expect(input.origins).toHaveLength(1);
    expect(input.origins[0]).toMatchObject({ villageId: 1, x: 10, y: 20, hasPaladin: true, underAttack: false });
    expect(input.origins[0]?.scheduledUnits['spear']).toBe(40);
    expect(input.reserveUnits['spear']).toBe(5);
    expect(input.mode).toBe('minimo');
    expect(input.avoidMsConflicts).toBe(true);
  });

  it('distribui em modo minimo e crava a partida; avoidMsConflicts separa em 300ms', () => {
    const input = buildDistributorInput({
      rows: [row(1, 0, 0, { spear: 100 }), row(2, 5, 0, { spear: 100 })],
      lines: linesOf(`${unitsText({ spear: 30 }, '24/09-12:00:00:000')}\n${unitsText({ spear: 200 }, '24/09-12:00:00:000')}`),
      settings: DEFAULT_DISTRIBUTOR_SETTINGS,
      scheduledUnitsByVillage: {},
      travelMinutes: TRAVEL,
      unitSpeedsMinutesPerField: SPEEDS,
    });
    const arrival = Date.UTC(2026, 8, 24, 12, 0, 0, 0);
    const result = distributeSupport(input, NOW);
    expect(result.assignments).toHaveLength(3);
    // Origem mais perto (5|0) atende a 1ª linha e depois o que sobra da 2ª.
    expect(result.assignments[0]?.originVillageId).toBe(2);
    expect(result.assignments[0]?.units['spear']).toBe(30);
    expect(result.assignments[1]?.originVillageId).toBe(2);
    expect(result.assignments[1]?.units['spear']).toBe(70);
    // A 2ª origem só entra quando a 1ª esvazia (e ainda faltam 30).
    expect(result.assignments[2]?.originVillageId).toBe(1);
    expect(result.assignments[2]?.units['spear']).toBe(100);
    expect(result.unmet).toHaveLength(1);
    expect(result.unmet[0]?.lineIndex).toBe(1);
    expect(result.unmet[0]?.missing['spear']).toBe(30);
    // Partida = chegada − viagem escalada (spear 18/22 da viagem de referência).
    const nearDepart = Math.round(arrival - Math.round(Math.hypot(495, 500) * (18 / 22) * 60_000));
    expect(result.assignments[0]?.departAtMs).toBe(nearDepart);
    // Partidas seguintes empurradas pelo espaçamento mínimo de 300ms.
    expect(result.assignments[1]?.departAtMs).toBe(nearDepart + 300);
    expect(result.assignments[2]?.departAtMs).toBe(nearDepart + 600);
  });
});

describe('tempo de referência do relógio do servidor', () => {
  it('lê #serverDate/#serverTime como dígitos UTC (mesma convenção do codec)', () => {
    const reference = referenceMsFromServerClock('24/08/2026', '22:44:18', 0);
    const date = new Date(reference);
    expect(date.getUTCDate()).toBe(24);
    expect(date.getUTCMonth()).toBe(7);
    expect(date.getUTCFullYear()).toBe(2026);
    expect(date.getUTCHours()).toBe(22);
    expect(date.getUTCMinutes()).toBe(44);
    const parsed = parseSupportLines(unitsText({ spear: 1 }, '24/08-22:50:00:000'), reference);
    expect(parsed.lines[0]?.exactArrivalMs).toBe(Date.UTC(2026, 7, 24, 22, 50, 0, 0));
  });

  it('cai no relógio local quando a hora do servidor não é legível', () => {
    const now = new Date(2026, 8, 23, 9, 30, 15, 0);
    expect(referenceMsFromServerClock('', '', localReferenceMs(now))).toBe(localReferenceMs(now));
    expect(referenceMsFromServerClock('24/08/2026', '99:99', 1234)).toBe(1234);
  });

  it('faz a ponte para a convenção do Agendador preservando os dígitos locais', () => {
    const reference = Date.UTC(2026, 8, 24, 12, 0, 0, 0);
    const iso = schedulerIsoFromReferenceMs(reference);
    const asLocal = new Date(iso);
    expect(asLocal.getHours()).toBe(12);
    expect(asLocal.getDate()).toBe(24);
    expect(asLocal.getMinutes()).toBe(0);
  });
});

describe('datetime-local e colagem', () => {
  it('faz round-trip com os dígitos do jogo (não com o fuso da máquina)', () => {
    const reference = Date.UTC(2026, 8, 24, 21, 30, 0, 0);
    expect(toDatetimeLocalValue(reference)).toBe('2026-09-24T21:30:00');
    expect(fromDatetimeLocalValue('2026-09-24T21:30:00')).toBe(reference);
    expect(fromDatetimeLocalValue('24/09/2026 21:30')).toBeNull();
    expect(fromDatetimeLocalValue('2026-02-31T10:00:00')).toBeNull();
  });

  it('lê as formas que o jogo e o fórum publicam', () => {
    expect(parsePastedTimeMs('24/08/2026 22:44:18', NOW)).toBe(Date.UTC(2026, 7, 24, 22, 44, 18, 0));
    // Sem ano explícito e já no passado: rola para o ano seguinte (regra do codec).
    expect(parsePastedTimeMs('24/08-22:44:18.500', NOW)).toBe(Date.UTC(2027, 7, 24, 22, 44, 18, 500));
    expect(parsePastedTimeMs('2026-08-24T22:44:18', NOW)).toBe(Date.UTC(2026, 7, 24, 22, 44, 18, 0));
    // 23/09 é o dia da referência (NOW = 23/09 12:00) e 13:00 ainda não passou.
    expect(parsePastedTimeMs('13:00:00', NOW)).toBe(Date.UTC(2026, 8, 23, 13, 0, 0, 0));
    // Hora solta no passado (> 1h) rola para o dia seguinte.
    expect(parsePastedTimeMs('08:00', NOW)).toBe(Date.UTC(2026, 8, 24, 8, 0, 0, 0));
    // Data sem ano já passada rola para o ano seguinte (mesma regra do codec).
    expect(parsePastedTimeMs('01/02 10:00:00', NOW)).toBe(Date.UTC(2027, 1, 1, 10, 0, 0, 0));
    expect(parsePastedTimeMs('nada aqui', NOW)).toBeNull();
  });
});

describe('apresentação', () => {
  it('resume unidades e chegada nos três formatos de linha', () => {
    expect(TROOP_UNIT_LABELS['knight']).toBe('paladino');
    expect(formatUnitsSummary({ spear: 100, sword: 50, knight: 1 })).toBe('100 lança, 50 espada, 1 paladino');
    expect(formatUnitsSummary({})).toBe('—');
    const lines = linesOf(
      `${unitsText({ spear: 1 })}\n${unitsText({ spear: 1 }, '24/09-12:00:00:000')}\n${unitsText({ spear: 1 }, 'i24/09-11:00:00:000 24/09-12:00:00:000')}`,
    );
    expect(formatArrivalLabel(lines[0]!)).toBe('imediato');
    expect(formatArrivalLabel(lines[1]!)).toBe('24/09 12:00:00');
    expect(formatArrivalLabel(lines[2]!)).toBe('24/09 11:00:00 → 24/09 12:00:00');
    expect(formatReferenceMs(Date.UTC(2026, 8, 24, 12, 0, 0, 500))).toBe('24/09 12:00:00.500');
  });

  it('monta a tabela BBCode com [coord] e [unit] e nada quando não há linha', () => {
    const table = buildForumTable(linesOf(unitsText({ spear: 100, light: 20 }, '24/09-12:00:00:000')));
    const expected = [
      '[table]',
      '[**]Aldeia[**]Tropas[**]Chegada',
      '[*][coord]500|500[/coord][*][unit]spear[/unit] 100 [unit]light[/unit] 20[*]24/09 12:00:00',
      '[/table]',
    ].join('\n');
    expect(table).toBe(expected);
    expect(buildForumTable([])).toBe('');
  });

  it('gera a prévia dos assignments e o texto das linhas não atendidas', () => {
    const lines = linesOf(`${unitsText({ spear: 30 })}\n${unitsText({ light: 5 })}`);
    const result = distributeSupport(
      buildDistributorInput({
        rows: [row(7, 0, 0, { spear: 10, light: 5 })],
        lines,
        settings: DEFAULT_DISTRIBUTOR_SETTINGS,
        scheduledUnitsByVillage: {},
        travelMinutes: TRAVEL,
        unitSpeedsMinutesPerField: SPEEDS,
      }),
      NOW,
    );
    const preview = assignmentsToPreview(result.assignments, lines, (villageId) => `aldeia ${villageId}`);
    expect(preview).toEqual([
      { origin: 'aldeia 7', target: '500|500', units: '10 lança', departure: 'agora' },
      { origin: 'aldeia 7', target: '500|500', units: '5 cav. leve', departure: 'agora' },
    ]);
    // Só a 1ª linha fica descoberta: a 2ª recebe tudo o que pediu.
    expect(unmetToPreview(result.unmet, lines)).toEqual(['Linha 1 (500|500): faltou 20 lança.']);
  });
});

describe('fila de execução e registros do Agendador', () => {
  const lines = linesOf(`${unitsText({ spear: 30 }, '24/09-12:00:00:000')}\n${unitsText({ light: 5 })}`);
  const rows = [row(1, 10, 10, { spear: 100, light: 100 })];
  const result = distributeSupport(
    buildDistributorInput({
      rows,
      lines,
      settings: { ...DEFAULT_DISTRIBUTOR_SETTINGS, mode: 'maximo' },
      scheduledUnitsByVillage: {},
      travelMinutes: TRAVEL,
      unitSpeedsMinutesPerField: SPEEDS,
    }),
    NOW,
  );
  const run: SupportRun = buildRun(result, lines, rows, NOW);

  it('converte o resultado em fila persistível com progresso', () => {
    expect(run.entries).toHaveLength(2);
    expect(run.createdAtMs).toBe(NOW);
    expect(run.entries[0]?.origin).toEqual({ x: 10, y: 10 });
    expect(run.entries[0]?.target).toEqual({ x: 500, y: 500 });
    expect(run.entries[0]?.arrivalAtMs).toBe(Date.UTC(2026, 8, 24, 12, 0, 0, 0));
    expect(run.entries[1]?.departAtMs).toBeNull();
    expect(nextPendingIndex(run)).toBe(0);
    const advanced: SupportRun = {
      ...run,
      entries: run.entries.map((entry, index) => (index === 0 ? { ...entry, sentAtMs: NOW } : entry)),
    };
    expect(nextPendingIndex(advanced)).toBe(1);
    expect(nextPendingIndex({ ...run, entries: advanced.entries.map((entry) => ({ ...entry, sentAtMs: NOW })) })).toBe(-1);
  });

  it('cria registros de apoio e explica cada entrada impossível', () => {
    const futureRun: SupportRun = {
      createdAtMs: NOW,
      entries: [
        { ...run.entries[0]!, departAtMs: NOW + 60_000, arrivalAtMs: NOW + 200_000 },
        { ...run.entries[0]!, departAtMs: NOW + 1_000 },
        { ...run.entries[1]!, departAtMs: null },
        { ...run.entries[0]!, origin: null, departAtMs: NOW + 60_000 },
      ],
    };
    const { records, skipped } = buildSchedulerSupportRecords(futureRun, NOW);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.kind).toBe('support');
    expect(record.id.startsWith('cid_')).toBe(true);
    expect(record.sourceVillageId).toBe('1');
    expect(record.source).toEqual({ x: 10, y: 10 });
    expect(record.timingMode).toBe('send');
    expect(record.paused).toBe(false);
    // Modo maximo: a origem manda TUDO o que tem das unidades pedidas.
    expect(record.units).toEqual({ spear: 100 });
    expect(new Date(record.sendAt).getHours()).toBe(new Date(NOW + 60_000).getUTCHours());
    expect(record.arrivalAt).toBe(schedulerIsoFromReferenceMs(NOW + 200_000));
    expect(record.events[0]?.status).toBe('agendado');
    // Determinístico: replanejar a mesma entrada gera o MESMO id (dedupe).
    expect(buildSchedulerSupportRecords(futureRun, NOW).records[0]?.id).toBe(record.id);
    expect(skipped.map((entry) => entry.reason)).toEqual([
      expect.stringContaining('janela impossível'),
      expect.stringContaining('linha sem data'),
      expect.stringContaining('sem coordenada'),
    ]);
  });

  it('normaliza config salva e mantém os defaults do produto', () => {
    const settings = normalizeDistributorSettings({
      mode: 'pacotes',
      preference: 'mais_longe',
      avoidMsConflicts: false,
      reserveUnits: { spear: 250, snob: 'x' },
      lixo: true,
    });
    expect(settings).toMatchObject({
      mode: 'pacotes',
      preference: 'mais_longe',
      avoidMsConflicts: false,
      includeSlowerUnits: false,
      ignoreScheduled: true,
    });
    expect(settings.reserveUnits['spear']).toBe(250);
    expect(settings.reserveUnits['snob']).toBe(0);
    expect(normalizeDistributorSettings('lixo')).toBe(DEFAULT_DISTRIBUTOR_SETTINGS);
  });
});
