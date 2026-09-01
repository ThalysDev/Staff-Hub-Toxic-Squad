// Testes da fonte "Disponível na aldeia (agora)" (v0.31): conversão da defesa
// (com/sem "a caminho", apoio recebido incluso por definição da linha "Na
// Aldeia") e o filtro/agregação operando no snapshot convertido — mínimos por
// aldeia, SOMA POR JOGADOR (decisão confirmada), não-possuem, geo/K e
// classificação sem mínimos, tudo reusando filterTroops.

import { describe, expect, it } from 'vitest';
import { defenseToTroopSnapshot } from './sg2-defense-source';
import { filterTroops } from './sg2-engine';
import type { DefenseSnapshot, DefenseVillageEntry } from './sg2-engine';

function aldeia(overrides?: Partial<DefenseVillageEntry>): DefenseVillageEntry {
  return {
    playerId: 1,
    playerName: 'Fronteiro',
    villageId: 100,
    name: 'Aldeia Frontal (500|500)',
    coord: { x: 500, y: 500 },
    points: 9000,
    unitsInVillage: { spear: 1000, sword: 500, heavy: 50 },
    unitsInTransit: { spear: 200 },
    ...overrides,
  };
}

function snapshotDe(entries: DefenseVillageEntry[]): DefenseSnapshot {
  return { kind: 'defense', collectedAt: '2026-09-01T12:00:00.000Z', entries };
}

describe('defenseToTroopSnapshot — conversão', () => {
  it('sem trânsito: usa só "Na Aldeia" (paradas)', () => {
    const convertido = defenseToTroopSnapshot(snapshotDe([aldeia()]), false);
    expect(convertido.entries).toHaveLength(1);
    const entry = convertido.entries[0];
    expect(entry?.units).toEqual({ spear: 1000, sword: 500, heavy: 50 });
    expect(entry?.playerName).toBe('Fronteiro');
    expect(entry?.villageName).toBe('Aldeia Frontal (500|500)');
    expect(entry?.coord).toEqual({ x: 500, y: 500 });
  });

  it('com trânsito: soma "a caminho" (paradas + a caminho)', () => {
    const convertido = defenseToTroopSnapshot(snapshotDe([aldeia()]), true);
    expect(convertido.entries[0]?.units).toEqual({ spear: 1200, sword: 500, heavy: 50 });
  });

  it('não muta a defesa original (puro) e preserva a ordem/identidade', () => {
    const defesa = snapshotDe([
      aldeia(),
      aldeia({ playerId: 2, playerName: 'Back', villageId: 101, coord: { x: 300, y: 300 } }),
    ]);
    const convertido = defenseToTroopSnapshot(defesa, true);
    expect(convertido.entries.map((e) => e.playerName)).toEqual(['Fronteiro', 'Back']);
    // Original intacto (sem trânsito somado na fonte):
    expect(defesa.entries[0]?.unitsInVillage).toEqual({ spear: 1000, sword: 500, heavy: 50 });
    expect(convertido.kind).toBe('defense');
    expect(convertido.collectedAt).toBe(defesa.collectedAt);
  });
});

describe('filterTroops sobre a fonte convertida', () => {
  const defesa = snapshotDe([
    aldeia(), // Front: 1000 lanças paradas
    aldeia({
      playerId: 1,
      playerName: 'Fronteiro',
      villageId: 101,
      name: 'Back do Fronteiro (410|410)',
      coord: { x: 410, y: 410 },
      unitsInVillage: { spear: 30000, sword: 20000 },
      unitsInTransit: { spear: 500 },
    }),
    aldeia({
      playerId: 2,
      playerName: 'Backline',
      villageId: 200,
      name: 'Back Profunda (200|200)',
      coord: { x: 200, y: 200 },
      unitsInVillage: { spear: 15000, heavy: 200 },
      unitsInTransit: {},
    }),
  ]);

  it('mínimos por ALDEIA acham a defesa parada na back', () => {
    const resultado = filterTroops(defenseToTroopSnapshot(defesa, false), {
      mode: 'possuem',
      scope: 'aldeia',
      unitMinimums: { spear: 10000 },
    });
    expect(resultado.totalVillages).toBe(2);
    const back = resultado.players.find((p) => p.playerName === 'Backline');
    expect(back?.coords).toEqual(['200|200']);
  });

  it('SOMA POR JOGADOR (decisão confirmada): escopo jogador agrega as aldeias', () => {
    const resultado = filterTroops(defenseToTroopSnapshot(defesa, false), {
      mode: 'possuem',
      scope: 'jogador',
      unitMinimums: { spear: 20000 }, // front 1000 + back 30000 = 31000
    });
    const fronteiro = resultado.players.find((p) => p.playerName === 'Fronteiro');
    expect(fronteiro?.coords).toContain('500|500');
    expect(fronteiro?.coords).toContain('410|410');
  });

  it('toggle "a caminho" muda o resultado quando o trânsito decide', () => {
    const filtros = { mode: 'possuem' as const, scope: 'aldeia' as const, unitMinimums: { spear: 1100 } };
    const soParadas = filterTroops(defenseToTroopSnapshot(defesa, false), filtros);
    const comCaminho = filterTroops(defenseToTroopSnapshot(defesa, true), filtros);
    expect(soParadas.totalVillages).toBe(2); // 30000 e 15000
    expect(comCaminho.totalVillages).toBe(3); // agora 1000+200=1200 da frente entra
    expect(comCaminho.players.find((p) => p.playerName === 'Fronteiro')?.coords).toContain('500|500');
  });

  it('modalidade "não possuem" funciona na nova fonte (back sem defesa parada)', () => {
    const semDefesa = snapshotDe([
      aldeia(),
      aldeia({
        playerId: 2,
        playerName: 'Backline',
        villageId: 200,
        name: 'Back Vazia (200|200)',
        coord: { x: 200, y: 200 },
        unitsInVillage: { spear: 0, sword: 0 },
        unitsInTransit: {},
      }),
    ]);
    const resultado = filterTroops(defenseToTroopSnapshot(semDefesa, false), {
      mode: 'nao-possuem',
      scope: 'aldeia',
      unitMinimums: { spear: 500 },
    });
    expect(resultado.totalVillages).toBe(1);
    expect(resultado.players[0]?.coords).toEqual(['200|200']);
  });

  it('filtros de geo (coords e K) combinam com a nova fonte', () => {
    const resultado = filterTroops(defenseToTroopSnapshot(defesa, false), {
      mode: 'possuem',
      scope: 'aldeia',
      unitMinimums: { spear: 1000 },
      kFilter: { ks: [22], mode: 'incluir' }, // 200|200 → K22
    });
    expect(resultado.totalVillages).toBe(1);
    expect(resultado.players[0]?.coords).toEqual(['200|200']);
  });

  it('sem mínimos: classifica as aldeias pelas tropas PRESENTES', () => {
    const resultado = filterTroops(defenseToTroopSnapshot(defesa, false), {
      mode: 'possuem',
      scope: 'aldeia',
    });
    // 1000 lanças+500 espadas+50 pesada = defensiva; 30000/20000 = defensiva;
    // 15000 lanças + 200 pesada = defensiva.
    expect(resultado.classification).toEqual({ offensive: 0, defensive: 3, empty: 0 });
  });

  it('escopo jogador + geo respeita coordsFilter (só aldeias listadas entram na soma)', () => {
    const resultado = filterTroops(defenseToTroopSnapshot(defesa, false), {
      mode: 'possuem',
      scope: 'jogador',
      unitMinimums: { spear: 900 },
      coordsFilter: [{ x: 410, y: 410 }],
    });
    // Só a back do Fronteiro entra (30000); a frente fica fora da soma.
    expect(resultado.players.find((p) => p.playerName === 'Fronteiro')?.coords).toEqual(['410|410']);
    expect(resultado.players.find((p) => p.playerName === 'Backline')).toBeUndefined();
  });
});
