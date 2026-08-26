import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { IncomingCommandRow } from './parsers/village-parsers';
import { parseIncomingCommandRows } from './parsers/village-parsers';
import { buildArrivalTimeline, formatCountdown, ganttLayout, type ArrivalEntry } from './sg5-arrivals';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL('../../tests/fixtures/br142/${name}'.replace('${name}', name), import.meta.url)), 'latin1');
}

let nextId = 492622028; // id real de comando da captura incomings-own.html
function row(overrides: Partial<IncomingCommandRow> & { arrivalSecFromLoad?: number | null }): IncomingCommandRow {
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
    // Por padrão SEM atributo máquina (cenário da captura incomings-own.html).
    arrivalSecFromLoad: null,
    ...overrides,
  };
}

describe('buildArrivalTimeline', () => {
  it('captura real incomings-own.html: TODAS as 701 linhas sem atributo máquina viram unresolved, zero entrada inventada', () => {
    const commands = parseIncomingCommandRows(fixture('incomings-own.html'));
    const timeline = buildArrivalTimeline([{ coord: '543|551', commands, loadedAt: 1787622258000 }]);
    expect(timeline.unresolved).toBe(701);
    expect(timeline.entries).toEqual([]);
  });

  it('converte arrivalSecFromLoad em chegada absoluta com o loadedAt do alvo e propaga dados da linha', () => {
    // 4083 s é exatamente o "1:08:03" do texto real da captura incomings-own.html.
    const timeline = buildArrivalTimeline([
      { coord: '543|551', commands: [row({ commandId: 1, arrivalSecFromLoad: 4083, name: 'Ataque', type: 'attack', hasNoble: true, sizeHint: 'grande' })], loadedAt: 1787622258000 },
      { coord: '460|480', commands: [row({ commandId: 2, arrivalSecFromLoad: 100 })], loadedAt: 1787622259000 },
    ]);
    expect(timeline.unresolved).toBe(0);
    expect(timeline.entries).toHaveLength(2);
    expect(timeline.entries[0]).toMatchObject({ coord: '460|480', commandId: 2, arrivalAt: 1787622359000 });
    expect(timeline.entries[1]).toMatchObject({
      coord: '543|551',
      commandId: 1,
      arrivalAt: 1787622258000 + 4083 * 1000,
      name: 'Ataque',
      hasNoble: true,
      sizeHint: 'grande',
      playerName: 'R O D R I G U E S',
    });
  });

  it('empate de horário quebra por commandId (determinístico)', () => {
    const timeline = buildArrivalTimeline([
      { coord: '543|551', commands: [row({ commandId: 9, arrivalSecFromLoad: 500 }), row({ commandId: 3, arrivalSecFromLoad: 500 })], loadedAt: 1787622258000 },
    ]);
    expect(timeline.entries.map((e) => e.commandId)).toEqual([3, 9]);
  });
});

describe('ganttLayout', () => {
  const base = { coord: '543|551', playerName: 'R O D R I G U E S', name: 'Suporte', hasNoble: false, sizeHint: null };
  function entry(commandId: number, arrivalAt: number): ArrivalEntry {
    return { ...base, commandId, arrivalAt };
  }

  it('posiciona dentro da janela em % e manda fora da janela para outsideWindow', () => {
    const inside = [entry(1, 6000), entry(2, 1000)];
    const outside = [entry(3, 999), entry(4, 11001)];
    const layout = ganttLayout([...inside, ...outside], { from: 1000, to: 11000 });
    expect(layout.outsideWindow.map((e) => e.commandId)).toEqual([3, 4]);
    expect(layout.rows.map((r) => r.entry.commandId)).toEqual([2, 1]); // ordenado por offset
    expect(layout.rows.find((r) => r.entry.commandId === 2)?.offsetPct).toBeCloseTo(0, 5);
    expect(layout.rows.find((r) => r.entry.commandId === 1)?.offsetPct).toBeCloseTo(50, 5);
    expect(layout.rows.every((r) => r.widthPct === 1)).toBe(true);
  });

  it('limites inclusivos e traço sempre dentro da régua (fim da janela vira 99%)', () => {
    const layout = ganttLayout([entry(1, 1000), entry(2, 11000)], { from: 1000, to: 11000 });
    expect(layout.rows[0]?.offsetPct).toBe(0);
    expect(layout.rows[1]?.offsetPct).toBe(99);
    expect(layout.outsideWindow).toEqual([]);
  });

  it('janela degenerada (to <= from) fail-closed: nada posicionado, tudo fora', () => {
    const entries = [entry(1, 5000)];
    for (const win of [{ from: 5000, to: 5000 }, { from: 6000, to: 4000 }]) {
      const layout = ganttLayout(entries, win);
      expect(layout.rows).toEqual([]);
      expect(layout.outsideWindow).toEqual(entries);
    }
  });
});

describe('formatCountdown', () => {
  it('todos os ramos PT-BR, determinístico', () => {
    expect(formatCountdown(720000)).toBe('faltam 12 min'); // 12 min
    expect(formatCountdown(7500000)).toBe('faltam 2 h 05 min'); // 2 h 05 min, minuto com zero à esquerda
    expect(formatCountdown(45000)).toBe('faltam 45 s'); // menos de 1 min
    expect(formatCountdown(-180000)).toBe('atrasado 3 min'); // negativo
    expect(formatCountdown(-45000)).toBe('atrasado 45 s');
    expect(formatCountdown(-(3600000 + 300000))).toBe('atrasado 1 h 05 min');
  });
});
