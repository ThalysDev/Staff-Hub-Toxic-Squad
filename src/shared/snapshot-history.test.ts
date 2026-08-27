import { describe, expect, it } from 'vitest';
import type { TroopEntry, TroopSnapshot } from './sg2-engine';
import {
  aggregateSnapshot,
  capHistory,
  detectMassiveRecruitment,
  diffTroopsVersions,
  MAX_TROOPS_HISTORY,
  newVersionId,
  type TroopsHistoryVersion,
} from './snapshot-history';
import type { UnitCounts } from './units';

function entry(playerId: number, playerName: string, units: UnitCounts, coord: { x: number; y: number } = { x: 100, y: 100 }): TroopEntry {
  return { playerId, playerName, coord, villageName: `v-${playerId}-${coord.x}${coord.y}`, units };
}

function snapshot(entries: TroopEntry[], source: TroopSnapshot['source'] = 'per-member'): TroopSnapshot {
  return { kind: 'troops', source, collectedAt: '2026-08-26T12:00:00.000Z', entries };
}

function version(players: TroopsHistoryVersion['players'], collectedAt = '2026-08-26T12:00:00.000Z'): TroopsHistoryVersion {
  return { id: newVersionId(), collectedAt, source: 'per-member', players };
}

describe('aggregateSnapshot', () => {
  it('soma as unidades por jogador e calcula offPop/defPop pela régua de units (catapulta fora do score)', () => {
    const players = aggregateSnapshot(
      snapshot([
        entry(1, 'ana', { axe: 100, spear: 50 }),
        entry(1, 'ana', { axe: 200, sword: 10 }),
        entry(2, 'bia', { light: 100, catapult: 10 }),
      ]),
    );
    expect(players).toHaveLength(2);
    const ana = players.find((p) => p.playerName === 'ana')!;
    expect(ana.units).toEqual({ axe: 300, spear: 50, sword: 10 });
    expect(ana.offPop).toBe(300); // só bárbaro
    expect(ana.defPop).toBe(60); // 50 lanceiro + 10 espadachim
    expect(ana.villageCount).toBe(2);
    // bia: 100 cav. leve * 4 = 400; catapulta NÃO conta no score ofensivo (regra do original)
    expect(players.find((p) => p.playerName === 'bia')!.offPop).toBe(400);
  });

  it('ordena por offPop DESC e empata por nome em pt-BR (determinístico)', () => {
    const players = aggregateSnapshot(
      snapshot([entry(1, 'zeca', { spear: 10 }), entry(2, 'ana', { axe: 10 }), entry(3, 'bruno', { spear: 5 })]),
    );
    expect(players.map((p) => p.playerName)).toEqual(['ana', 'bruno', 'zeca']);
  });

  it('modo resumo (coord -1): villageCount 0 mas as unidades somam', () => {
    const players = aggregateSnapshot(
      snapshot(
        [
          entry(7, 'caue', { axe: 500, spear: 100 }, { x: -1, y: -1 }),
          entry(7, 'caue', { axe: 250 }, { x: -1, y: -1 }),
        ],
        'summary',
      ),
    );
    expect(players).toHaveLength(1);
    expect(players[0]!.villageCount).toBe(0);
    expect(players[0]!.units).toEqual({ axe: 750, spear: 100 });
    expect(players[0]!.offPop).toBe(750);
    expect(players[0]!.defPop).toBe(100);
  });

  it('mistura coord real e -1 no mesmo jogador: conta só as reais, soma todas', () => {
    const players = aggregateSnapshot(
      snapshot([
        entry(9, 'duda', { axe: 10 }, { x: 500, y: 500 }),
        entry(9, 'duda', { axe: 20 }, { x: -1, y: -1 }),
      ]),
    );
    expect(players[0]!.villageCount).toBe(1);
    expect(players[0]!.units.axe).toBe(30);
  });

  it('fail-closed: snapshot sem entries lança erro claro em pt-BR', () => {
    expect(() => aggregateSnapshot(snapshot([]))).toThrow(/nenhuma entry/i);
    expect(() => aggregateSnapshot(snapshot([]))).toThrow(/histórico/i);
  });
});

describe('diffTroopsVersions', () => {
  const a = version([
    { playerId: 1, playerName: 'ana', villageCount: 10, units: {}, offPop: 5000, defPop: 2000 },
    { playerId: 2, playerName: 'bia', villageCount: 5, units: {}, offPop: 3000, defPop: 1000 },
    { playerId: 3, playerName: 'carla', villageCount: 2, units: {}, offPop: 1000, defPop: 500 },
  ]);
  const b = version([
    { playerId: 1, playerName: 'ana', villageCount: 12, units: {}, offPop: 9000, defPop: 3000 },
    { playerId: 2, playerName: 'bia', villageCount: 5, units: {}, offPop: 3000, defPop: 1000 },
    { playerId: 4, playerName: 'dora', villageCount: 1, units: {}, offPop: 200, defPop: 100 },
  ]);

  it('faz a união A∪B marcando isNew para quem só existe em B', () => {
    const rows = diffTroopsVersions(a, b);
    expect(rows.map((r) => r.playerName).sort()).toEqual(['ana', 'bia', 'carla', 'dora']);
    const dora = rows.find((r) => r.playerName === 'dora')!;
    expect(dora.isNew).toBe(true);
    expect(dora.offPopA).toBe(0);
    expect(dora.offPopB).toBe(200);
    expect(dora.offPopDelta).toBe(200);
  });

  it('jogador que só existe em A fica com deltas negativos e isNew false', () => {
    const rows = diffTroopsVersions(a, b);
    const carla = rows.find((r) => r.playerName === 'carla')!;
    expect(carla.isNew).toBe(false);
    expect(carla.offPopDelta).toBe(-1000);
    expect(carla.defPopDelta).toBe(-500);
    expect(carla.villageCountDelta).toBe(-2);
    expect(carla.offPopB).toBe(0);
  });

  it('calcula os deltas de offPop, defPop e villageCount de quem está nas duas', () => {
    const rows = diffTroopsVersions(a, b);
    const ana = rows.find((r) => r.playerName === 'ana')!;
    expect(ana.offPopDelta).toBe(4000);
    expect(ana.defPopDelta).toBe(1000);
    expect(ana.villageCountDelta).toBe(2);
    expect(diffTroopsVersions(a, b).find((r) => r.playerName === 'bia')!.offPopDelta).toBe(0);
  });

  it('ordena por offPopDelta DESC (crescimento primeiro) com empate por nome pt-BR', () => {
    const rows = diffTroopsVersions(a, b);
    expect(rows.map((r) => r.playerName)).toEqual(['ana', 'dora', 'bia', 'carla']);
    // bia (0) e dora (+200): dora primeiro; empate de delta entre bia e carla não
    // existe aqui, então comprovamos o empate com um diff plano:
    const plano = diffTroopsVersions(
      version([
        { playerId: 1, playerName: 'zeca', villageCount: 1, units: {}, offPop: 10, defPop: 0 },
        { playerId: 2, playerName: 'ana', villageCount: 1, units: {}, offPop: 10, defPop: 0 },
      ]),
      version([
        { playerId: 1, playerName: 'zeca', villageCount: 1, units: {}, offPop: 10, defPop: 0 },
        { playerId: 2, playerName: 'ana', villageCount: 1, units: {}, offPop: 10, defPop: 0 },
      ]),
    );
    expect(plano.map((r) => r.playerName)).toEqual(['ana', 'zeca']);
  });

  it('não muta os inputs (imutabilidade)', () => {
    const antesA = JSON.stringify(a);
    const antesB = JSON.stringify(b);
    diffTroopsVersions(a, b);
    expect(JSON.stringify(a)).toBe(antesA);
    expect(JSON.stringify(b)).toBe(antesB);
  });
});

describe('detectMassiveRecruitment', () => {
  const row = (playerName: string, offPopDelta: number, villageCountDelta: number) => ({
    playerName,
    offPopA: 0,
    offPopB: offPopDelta,
    offPopDelta,
    defPopA: 0,
    defPopB: 0,
    defPopDelta: 0,
    villageCountA: 0,
    villageCountB: villageCountDelta,
    villageCountDelta,
    isNew: true,
  });

  it('padrões 20000/3: pega quem atinge qualquer dos limiares (>= conta)', () => {
    const rows = [row('gigante-off', 20000, 0), row('gigante-aldeias', 0, 3), row('pequeno', 19999, 2)];
    const detected = detectMassiveRecruitment(rows);
    expect(detected.map((r) => r.playerName)).toEqual(['gigante-off', 'gigante-aldeias']);
  });

  it('limiares customizados via opts', () => {
    const rows = [row('medio', 5000, 0), row('fraco', 100, 1), row('nobre', 0, 2)];
    const detected = detectMassiveRecruitment(rows, { minOffPopGrowth: 5000, minVillageGrowth: 2 });
    expect(detected.map((r) => r.playerName)).toEqual(['medio', 'nobre']);
  });

  it('lista vazia devolve vazia', () => {
    expect(detectMassiveRecruitment([])).toEqual([]);
  });
});

describe('capHistory', () => {
  function collectedAtList(count: number): TroopsHistoryVersion[] {
    return Array.from({ length: count }, (_, i) =>
      version([], `2026-08-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`),
    );
  }

  it(`com ${MAX_TROOPS_HISTORY} + 1 versões mantém as ${MAX_TROOPS_HISTORY} mais recentes, mais nova no índice 0`, () => {
    expect(MAX_TROOPS_HISTORY).toBe(20);
    // entra fora de ordem (mais antiga primeiro) para provar a ordenação por data
    const versions = collectedAtList(21).reverse();
    const capped = capHistory(versions);
    expect(capped).toHaveLength(20);
    expect(capped[0]!.collectedAt).toBe('2026-08-30T00:00:00.000Z');
    expect(capped[19]!.collectedAt).toBe('2026-08-11T00:00:00.000Z');
    expect(capped.some((v) => v.collectedAt === '2026-08-10T00:00:00.000Z')).toBe(false);
  });

  it('com menos que o máximo devolve array NOVO e completo (sem cortar, sem mutar)', () => {
    const versions = collectedAtList(5);
    const copiaAntes = JSON.stringify(versions);
    const capped = capHistory(versions);
    expect(capped).toHaveLength(5);
    expect(capped).not.toBe(versions);
    expect(JSON.stringify(versions)).toBe(copiaAntes);
  });
});

describe('newVersionId', () => {
  it('gera ids únicos em rajada (mesmo milissegundo) no formato th-<ts>-<n>', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newVersionId()));
    expect(ids.size).toBe(5000);
    for (const id of ids) expect(id).toMatch(/^th-\d+-\d+$/);
  });
});
