// Onda E — trem nativo do jogo (1 clique, chegadas a cada 100 ms).
import { describe, expect, it } from 'vitest';
import { buildNativeNobleTrainRecord } from './tsh-commands-ui';
import { parseSchedulerCommandRecord } from '../../ext/core/scheduler-state';

const base = {
  sourceVillageId: '35454',
  target: { x: 720, y: 502 },
  firstArrivalMs: Date.parse('2026-09-23T14:56:00.100Z'),
  escort: { axe: 500 },
  travelMinutes: 31 + 7 / 60,
};

describe('buildNativeNobleTrainRecord', () => {
  it('um registro: #1 = escolta + nobre, adicionais com nobre cada; extras nos últimos', () => {
    const r = buildNativeNobleTrainRecord({ ...base, trainSize: 4, noblesAvailable: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.records).toHaveLength(1);
    const rec = r.records[0]!;
    expect(rec.units).toEqual({ axe: 500, snob: 1 });
    expect(rec.trainUnits).toEqual([
      { axe: 500, snob: 1 },
      { axe: 500, snob: 1 },
      { axe: 500, snob: 2 },
    ]);
    expect(rec.arrivalAt).toBe('2026-09-23T14:56:00.100Z');
    // viagem 0:31:07 arredondada ao segundo
    expect(Date.parse(rec.arrivalAt!) - Date.parse(rec.sendAt)).toBe((31 * 60 + 7) * 1000);
    expect(parseSchedulerCommandRecord(rec).ok).toBe(true);
  });
  it('recusa nobres insuficientes, tamanho fora de 2..5 e viagem indisponível', () => {
    expect(buildNativeNobleTrainRecord({ ...base, trainSize: 4, noblesAvailable: 3 }).ok).toBe(false);
    expect(buildNativeNobleTrainRecord({ ...base, trainSize: 6, noblesAvailable: 9 }).ok).toBe(false);
    expect(buildNativeNobleTrainRecord({ ...base, trainSize: 2, noblesAvailable: 2, travelMinutes: null }).ok).toBe(false);
  });
});

describe('schema trainUnits', () => {
  const rec = {
    id: 'x',
    kind: 'noble',
    sourceVillageId: '1',
    target: { x: 1, y: 1 },
    units: { snob: 1 },
    sendAt: '2026-09-23T12:00:00.000Z',
    createdAt: '2026-09-23T11:00:00.000Z',
    events: [],
  };
  it('aceita até 4 adicionais e recusa 5, linha vazia, apoio e percentual', () => {
    expect(parseSchedulerCommandRecord({ ...rec, trainUnits: [{ snob: 1 }] }).ok).toBe(true);
    expect(parseSchedulerCommandRecord({ ...rec, trainUnits: Array(5).fill({ snob: 1 }) }).ok).toBe(false);
    expect(parseSchedulerCommandRecord({ ...rec, trainUnits: [{}] }).ok).toBe(false);
    expect(parseSchedulerCommandRecord({ ...rec, kind: 'support', trainUnits: [{ snob: 1 }] }).ok).toBe(false);
    expect(parseSchedulerCommandRecord({ ...rec, percentMode: true, trainUnits: [{ snob: 1 }] }).ok).toBe(false);
  });
});

import { parseDurationText } from '../vanta/cravar-confirmacao';
describe('parseDurationText', () => {
  it('lê H:MM:SS da tela de confirmação', () => {
    expect(parseDurationText('0:31:07')).toBe((31 * 60 + 7) * 1000);
    expect(parseDurationText('12:05:09')).toBe(((12 * 60 + 5) * 60 + 9) * 1000);
    expect(parseDurationText('—')).toBeNull();
  });
});
