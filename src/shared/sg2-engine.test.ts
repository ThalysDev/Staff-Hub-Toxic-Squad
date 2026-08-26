import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseMemberVillageDefense, parseMemberVillageTroops } from './parsers/ally-parsers';
import { filterTroops, playersSummary, type TroopEntry, type TroopSnapshot } from './sg2-engine';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../tests/fixtures/br142/${name}`, import.meta.url)), 'latin1');
}

function snapshot(entries: TroopEntry[]): TroopSnapshot {
  return { kind: 'troops', source: 'per-member', collectedAt: new Date().toISOString(), entries };
}

describe('parseMemberVillageTroops (fixture real reboucas/spartacus)', () => {
  it('parseia todas as aldeias com coordenada e unidades', () => {
    const reboucas = parseMemberVillageTroops(fixture('troops-reboucas-rows.html'));
    expect(reboucas.villages.length).toBe(22);
    const first = reboucas.villages[0]!;
    expect(first.villageId).toBe(24733);
    expect(first.name).toContain('REBOU');
    expect(first.coord).toEqual({ x: 675, y: 488 });
    expect(first.units.spear).toBe(119);
    expect(first.units.sword).toBe(114);
    expect(first.units.axe).toBe(2900);
    // colunas hidden do BR142 zeram (knight visível=1, snob hidden=0)
    expect(first.units.knight).toBe(1);
    expect(first.units.snob ?? 0).toBe(0);

    const spartacus = parseMemberVillageTroops(fixture('troops-spartacus-rows.html'));
    expect(spartacus.villages.length).toBe(191);
  });

  it('falha fechado sem tabela', () => {
    expect(() => parseMemberVillageTroops('<html>sem tabela</html>')).toThrow(/não encontrada/i);
  });
});

describe('parseMemberVillageDefense (fixture real)', () => {
  it('parseia pares Na Aldeia / a caminho', () => {
    const reboucas = parseMemberVillageDefense(fixture('defense-reboucas-rows.html'));
    expect(reboucas.villages.length).toBe(22);
    const first = reboucas.villages[0]!;
    expect(first.coord).toEqual({ x: 675, y: 488 });
    expect(first.unitsInVillage.spear).toBe(119);
    expect(first.unitsInVillage.axe).toBe(2900);
    // 1ª aldeia sem trânsito: tudo zero
    expect(first.unitsInTransit.spear ?? 0).toBe(0);

    const spartacus = parseMemberVillageDefense(fixture('defense-spartacus-rows.html'));
    expect(spartacus.villages.length).toBe(191);
  });
});

describe('filterTroops', () => {
  const entries: TroopEntry[] = [
    { playerId: 1, playerName: 'ana', coord: { x: 100, y: 100 }, villageName: 'a1', units: { spear: 9000, sword: 100 } },
    { playerId: 1, playerName: 'ana', coord: { x: 200, y: 200 }, villageName: 'a2', units: { spear: 100 } },
    { playerId: 2, playerName: 'bia', coord: { x: 300, y: 300 }, villageName: 'b1', units: { axe: 5000, light: 1000 } },
  ];

  it('escopo aldeia + possuem: TODOS os mínimos por aldeia', () => {
    const result = filterTroops(snapshot(entries), { mode: 'possuem', scope: 'aldeia', unitMinimums: { spear: 9000 } });
    expect(result.totalVillages).toBe(1);
    expect(result.players[0]?.playerName).toBe('ana');
    expect(result.players[0]?.coords).toEqual(['100|100']);
  });

  it('escopo jogador: soma antes de comparar (todas as aldeias entram)', () => {
    const result = filterTroops(snapshot(entries), { mode: 'possuem', scope: 'jogador', unitMinimums: { spear: 9100 } });
    expect(result.totalVillages).toBe(2);
    expect(result.players[0]?.playerName).toBe('ana');
  });

  it('modo nao-possuem: OR (falta um mínimo já entra)', () => {
    const result = filterTroops(snapshot(entries), { mode: 'nao-possuem', scope: 'aldeia', unitMinimums: { spear: 9000, sword: 5000 } });
    // a1 tem spear ok mas falta sword; a2 falta spear; b1 falta spear e sword → 3 aldeias
    expect(result.totalVillages).toBe(3);
  });

  it('coordsFilter restrige às coordenadas listadas', () => {
    const result = filterTroops(snapshot(entries), {
      mode: 'possuem',
      scope: 'aldeia',
      unitMinimums: { spear: 50 },
      coordsFilter: [{ x: 100, y: 100 }],
    });
    expect(result.totalVillages).toBe(1);
    expect(result.players[0]?.coords).toEqual(['100|100']);
  });

  it('axes filtra faixa de eixo', () => {
    const result = filterTroops(snapshot(entries), { mode: 'possuem', scope: 'aldeia', unitMinimums: { spear: 50 }, axesRange: { minX: 150, maxX: 350 } });
    // a2 (200|200, spear 100) entra; b1 (300|300) não tem lanceiros
    expect(result.totalVillages).toBe(1);
    expect(result.players[0]?.coords).toEqual(['200|200']);
  });

  it('sem mínimos → classificação ofensiva/defensiva', () => {
    const result = filterTroops(snapshot(entries), { mode: 'possuem', scope: 'aldeia' });
    // a1/a2 = defensivas (lanceiro/espadachim); b1 = ofensiva (bárbaro+cav. leve)
    expect(result.classification).toEqual({ offensive: 1, defensive: 2, empty: 0 });
    expect(result.totalVillages).toBe(0);
  });

  it('coordsFilter e axesRange são COMBINÁVEIS (aldeia precisa passar nos dois)', () => {
    const result = filterTroops(snapshot(entries), {
      mode: 'possuem',
      scope: 'aldeia',
      unitMinimums: { spear: 50 },
      coordsFilter: [{ x: 100, y: 100 }, { x: 200, y: 200 }],
      axesRange: { minX: 150, maxX: 250 },
    });
    // a1 (100|100) está na lista mas fora do eixo (x<150); a2 (200|200) passa nos dois
    expect(result.totalVillages).toBe(1);
    expect(result.players[0]?.coords).toEqual(['200|200']);
  });

  it('resumo (sem aldeias) fail-closed em escopo aldeia/classificação — nunca número errado', () => {
    const summary: TroopSnapshot = {
      kind: 'troops',
      source: 'summary',
      collectedAt: new Date().toISOString(),
      entries: [
        { playerId: 1, playerName: 'ana', coord: { x: -1, y: -1 }, villageName: '', units: { spear: 9000 } },
      ],
    };
    expect(() => filterTroops(summary, { mode: 'possuem', scope: 'aldeia', unitMinimums: { spear: 100 } })).toThrow(/Resumo/);
    expect(() => filterTroops(summary, { mode: 'possuem', scope: 'aldeia' })).toThrow(/Resumo/);
  });

  it('playersSummary gera nick;qtde;coords', () => {
    const result = filterTroops(snapshot(entries), { mode: 'possuem', scope: 'aldeia', unitMinimums: { spear: 9000 } });
    expect(playersSummary(result)).toBe('ana;1;100|100');
  });
});

describe('filterTroops — kFilter (continente K)', () => {
  // continentOf({555,555}) = 55 · continentOf({777,777}) = 77 · continentOf({111,111}) = 11
  const entries: TroopEntry[] = [
    { playerId: 1, playerName: 'ana', coord: { x: 555, y: 555 }, villageName: 'k55', units: { spear: 9000 } },
    { playerId: 1, playerName: 'ana', coord: { x: 777, y: 777 }, villageName: 'k77', units: { spear: 8000 } },
    { playerId: 2, playerName: 'bia', coord: { x: 111, y: 111 }, villageName: 'k11', units: { spear: 7000 } },
  ];

  it('incluir [55,77]: só passam K55 e K77', () => {
    const result = filterTroops(snapshot(entries), {
      mode: 'possuem', scope: 'aldeia', unitMinimums: { spear: 100 }, kFilter: { ks: [55, 77], mode: 'incluir' },
    });
    expect(result.totalVillages).toBe(2);
    const ana = result.players.find((p) => p.playerName === 'ana');
    expect(ana?.coords).toEqual(['555|555', '777|777']);
    expect(result.players.some((p) => p.playerName === 'bia')).toBe(false);
  });

  it('excluir [55,77]: inverso — só resta fora da lista', () => {
    const result = filterTroops(snapshot(entries), {
      mode: 'possuem', scope: 'aldeia', unitMinimums: { spear: 100 }, kFilter: { ks: [55, 77], mode: 'excluir' },
    });
    expect(result.totalVillages).toBe(1);
    expect(result.players[0]?.playerName).toBe('bia');
    expect(result.players[0]?.coords).toEqual(['111|111']);
  });

  it('ks vazio com incluir → NADA passa (fail-closed, nunca "tudo")', () => {
    const result = filterTroops(snapshot(entries), {
      mode: 'possuem', scope: 'aldeia', unitMinimums: { spear: 100 }, kFilter: { ks: [], mode: 'incluir' },
    });
    expect(result.totalVillages).toBe(0);
    expect(result.players).toEqual([]);
  });

  it('K fora de 0–99 → erro fail-closed', () => {
    expect(() =>
      filterTroops(snapshot(entries), {
        mode: 'possuem', scope: 'aldeia', unitMinimums: { spear: 100 }, kFilter: { ks: [55, 120], mode: 'incluir' },
      }),
    ).toThrow(/inválido/i);
  });

  it('kFilter é COMBINÁVEL com axesRange', () => {
    const result = filterTroops(snapshot(entries), {
      mode: 'possuem',
      scope: 'aldeia',
      unitMinimums: { spear: 100 },
      kFilter: { ks: [55, 77], mode: 'incluir' },
      axesRange: { minX: 600 },
    });
    // K55 (x<600) cai no eixo; só sobra a aldeia de K77
    expect(result.totalVillages).toBe(1);
    expect(result.players[0]?.coords).toEqual(['777|777']);
  });
});

describe('integração parser+engine (fixture real)', () => {
  it('filtra spear>=200 nas aldeias reais do Rebouças', () => {
    const parsed = parseMemberVillageTroops(fixture('troops-reboucas-rows.html'));
    const snap = snapshot(
      parsed.villages.map((v) => ({
        playerId: 7563992,
        playerName: 'reboucas',
        coord: v.coord,
        villageId: v.villageId,
        villageName: v.name,
        units: v.units,
      })),
    );
    const result = filterTroops(snap, { mode: 'possuem', scope: 'aldeia', unitMinimums: { spear: 200 } });
    // 1ª aldeia tem 119 → fora; validamos contagem contra o parser cru
    const expected = parsed.villages.filter((v) => (v.units.spear ?? 0) >= 200).length;
    expect(result.totalVillages).toBe(expected);
    expect(result.totalVillages).toBeGreaterThan(0);
  });
});
