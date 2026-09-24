// Previsão de tropas no horário do envio — fixtures REAIS do BR142.
import { describe, expect, it } from 'vitest';
import returnHtml from './__fixtures__/br142-commands-return.html?raw';
import trainHtml from './__fixtures__/br142-train-queue.html?raw';
import { parseCommandRows, parseScavengeReturns, parseTrainQueue, unitsAt } from './tsh-troop-forecast';

const NOW = new Date(2026, 8, 24, 12, 0, 0).getTime();

describe('Visão de Comandos (retornos)', () => {
  it('lê a aldeia de casa, a chegada e as tropas por coluna', () => {
    const rows = parseCommandRows(returnHtml, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      homeVillageId: '1185',
      arrivalMs: new Date(2026, 8, 24, 13, 12, 3).getTime(),
      target: { x: 683, y: 593 },
      units: { sword: 63, archer: 63 },
    });
  });
  it('sem tabela = nada (nunca inventa)', () => {
    expect(parseCommandRows('<html></html>', NOW)).toEqual([]);
  });
});

describe('fila de recrutamento', () => {
  it('lê tropa, quantidade, início e conclusão de cada lote', () => {
    const batches = parseTrainQueue(trainHtml, NOW);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({ unit: 'axe', count: 29, finishMs: new Date(2026, 8, 24, 14, 2, 46).getTime() });
    expect(batches[0]!.finishMs - batches[0]!.startMs).toBe((3600 + 4 * 60 + 39) * 1000);
    expect(batches[1]).toMatchObject({ unit: 'axe', count: 50 });
  });
});

describe('coleta', () => {
  it('lê os grupos em coleta e quando voltam', () => {
    const html = 'var village = {"options":{"1":{"scavenging_squad":null},"2":{"scavenging_squad":{"unit_counts":{"spear":100,"axe":0},"return_time":1000}}}};\n';
    expect(parseScavengeReturns(html, 400_000)).toEqual([{ inMs: 600_000, units: { spear: 100 } }]);
  });
});

describe('tropas no horário', () => {
  const home = { spear: 200, axe: 100 };
  const arrivals = [{ atMs: 1_000, units: { spear: 50 } }, { atMs: 5_000, units: { spear: 70 } }];
  const train = [{ unit: 'axe' as const, count: 10, startMs: 0, finishMs: 10_000 }];
  it('soma o que volta antes e o que fica pronto (proporcional no lote)', () => {
    expect(unitsAt(3_000, home, arrivals, train)).toEqual({ spear: 250, axe: 103 });
    expect(unitsAt(20_000, home, arrivals, train)).toEqual({ spear: 320, axe: 110 });
  });
  it('desconta outros comandos agendados que saem antes (e "Todas" zera o tipo)', () => {
    expect(unitsAt(3_000, home, arrivals, train, [{ atMs: 2_000, units: { spear: 30 } }])).toMatchObject({ spear: 220 });
    expect(unitsAt(3_000, home, arrivals, train, [{ atMs: 2_000, units: {}, all: ['axe'] }])).toMatchObject({ axe: 0 });
  });
});
