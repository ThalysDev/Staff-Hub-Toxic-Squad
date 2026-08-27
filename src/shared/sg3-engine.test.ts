import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseMemberVillageDefense } from './parsers/ally-parsers';
import type { DefenseSnapshot } from './sg2-engine';
import { blindBbcodeTable, checkBlind, type BlindCheckInput } from './sg3-engine';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../tests/fixtures/br142/${name}`, import.meta.url)), 'latin1');
}

function snapshot(entries: DefenseSnapshot['entries']): DefenseSnapshot {
  return { kind: 'defense', collectedAt: new Date().toISOString(), entries };
}

const ENTRIES: DefenseSnapshot['entries'] = [
  {
    playerId: 1, playerName: 'ana', villageId: 10, name: 'a1', coord: { x: 100, y: 100 }, points: 9000,
    unitsInVillage: { spear: 12000, sword: 10000 }, unitsInTransit: { spear: 500 },
  },
  {
    playerId: 1, playerName: 'ana', villageId: 11, name: 'a2', coord: { x: 101, y: 101 }, points: 8000,
    unitsInVillage: { spear: 9000, sword: 11000 }, unitsInTransit: { spear: 1500 },
  },
  {
    playerId: 2, playerName: 'bia', villageId: 20, name: 'b1', coord: { x: 200, y: 200 }, points: 7000,
    unitsInVillage: { spear: 1087 }, unitsInTransit: {},
  },
];

describe('checkBlind', () => {
  const base = { defense: snapshot(ENTRIES), desiredUnits: { spear: 10000, sword: 10000 } };

  it('modo paradas: falta qualquer unidade → entra (OR) com o quanto falta', () => {
    const input: BlindCheckInput = { ...base, countMode: 'paradas', coordsFilter: [] };
    const results = checkBlind(input);
    // a1 completa; a2 falta 1000 lanceiros; b1 falta lanceiros e TODOS espadachins
    expect(results).toHaveLength(2);
    const a2 = results.find((r) => r.villageName === 'a2');
    expect(a2?.missing).toEqual({ spear: 1000 });
    const b1 = results.find((r) => r.villageName === 'b1');
    expect(b1?.missing).toEqual({ spear: 8913, sword: 10000 });
  });

  it('modo paradas-e-transito soma o trânsito (a2 fecha com 1500 a caminho)', () => {
    const input: BlindCheckInput = { ...base, countMode: 'paradas-e-transito', coordsFilter: [] };
    const results = checkBlind(input);
    expect(results.map((r) => r.villageName)).toEqual(['b1']);
  });

  it('coordsFilter restrige ao front informado', () => {
    const input: BlindCheckInput = { ...base, countMode: 'paradas', coordsFilter: [{ x: 200, y: 200 }] };
    const results = checkBlind(input);
    expect(results).toHaveLength(1);
    expect(results[0]?.villageName).toBe('b1');
  });

  it('ordenado por jogador e coordenada', () => {
    const input: BlindCheckInput = { ...base, countMode: 'paradas', coordsFilter: [] };
    const results = checkBlind(input);
    expect(results[0]?.playerName).toBe('ana');
    expect(results[1]?.playerName).toBe('bia');
  });
});

describe('blindBbcodeTable', () => {
  it('gera tabela com Pedido | Aldeia | Falta', () => {
    const results = checkBlind({ defense: snapshot(ENTRIES), desiredUnits: { spear: 10000 }, countMode: 'paradas', coordsFilter: [] });
    const bbcode = blindBbcodeTable(results);
    expect(bbcode).toContain('[table]');
    expect(bbcode).toContain('[**]Pedido[||]Aldeia[||]Falta[/**]');
    expect(bbcode).toContain('Lanceiros');
  });
});

describe('integração com parser real (defense reboucas)', () => {
  it('blind sobre as 22 aldeias reais do fixture', () => {
    const parsed = parseMemberVillageDefense(fixture('defense-reboucas-rows.html'));
    const snap = snapshot(
      parsed.villages.map((v) => ({
        playerId: 7563992, playerName: 'reboucas', villageId: v.villageId, name: v.name,
        coord: v.coord, points: v.points, unitsInVillage: v.unitsInVillage, unitsInTransit: v.unitsInTransit,
      })),
    );
    const results = checkBlind({ defense: snap, desiredUnits: { spear: 200, sword: 200 }, countMode: 'paradas', coordsFilter: [] });
    const expected = parsed.villages.filter(
      (v) => (v.unitsInVillage.spear ?? 0) < 200 || (v.unitsInVillage.sword ?? 0) < 200,
    ).length;
    expect(results).toHaveLength(expected);
  });
});
describe("checkBlind — levelScaling (blind por nível de aldeia, roadmap 13)", () => {
  const base = { defense: snapshot(ENTRIES), desiredUnits: { spear: 12000 } };

  it("desejado escala pelos pontos com clamp nos fatores mínimo e máximo", () => {
    // a1: 9000 pts, ref 6000 → fator 1.5 → desejado 18000; tem 12000 → falta 6000.
    const results = checkBlind({ ...base, countMode: "paradas", coordsFilter: [], levelScaling: { referencePoints: 6000, minFactor: 0.5, maxFactor: 2 } });
    const a1 = results.find((r) => r.villageName === "a1");
    expect(a1?.missing.spear).toBe(6000);
    // b1: 7000 pts → fator 7/6 → ceil(12000×7/6)=14000; tem 1087 → falta 12913.
    const b1 = results.find((r) => r.villageName === "b1");
    expect(b1?.missing.spear).toBe(12913);
  });

  it("clamp: pontos acima do teto não passam do fator máximo", () => {
    // a1 9000 com ref 3000 seria 3× — teto 2× → desejado 24000 → falta 12000.
    const results = checkBlind({ ...base, countMode: "paradas", coordsFilter: [], levelScaling: { referencePoints: 3000, minFactor: 0.5, maxFactor: 2 } });
    const a1 = results.find((r) => r.villageName === "a1");
    expect(a1?.missing.spear).toBe(12000);
  });

  it("clamp no piso: aldeia pequena pede menos", () => {
    // b1 7000 com ref 28000 → fator bruto 0.25 → piso 0.5 → desejado 6000 → falta 4913.
    const results = checkBlind({ ...base, countMode: "paradas", coordsFilter: [], levelScaling: { referencePoints: 28000, minFactor: 0.5, maxFactor: 2 } });
    const b1 = results.find((r) => r.villageName === "b1");
    expect(b1?.missing.spear).toBe(4913);
  });

  it("sem levelScaling o comportamento é o original (desejado fixo)", () => {
    const results = checkBlind({ ...base, countMode: "paradas", coordsFilter: [] });
    const a1 = results.find((r) => r.villageName === "a1");
    expect(a1).toBeUndefined(); // 12000 desejados, 12000 paradas → completa
  });
});
