// STRESS de escala real (relatos da staff 01-02/09): OP "full" do colega
// (2428×183 = 444k) e OP "Full - Br142" do dono (7005×1701 = 11,9M pares —
// "mundo inteiro"). v0.32.2: candidatos em ARRAYS TIPADOS paralelos (objeto
// por par custaria ~1 GB aqui); teto 50M. Fixa a regressão e mede tempos.
import { describe, expect, it } from 'vitest';
import { generateMassPlan } from '@shared/mass-planner-engine';
import type { MassGroupConfig, MassPlanContext } from '@shared/mass-planner-types';

function coords(n: number, startX: number, startY: number) {
  const list = [];
  for (let i = 0; i < n; i++) {
    const x = startX + (i % 90);
    const y = startY + Math.floor(i / 90);
    list.push({ coord: `${x}|${y}`, x, y });
  }
  return list;
}

function buildGroup(
  origins: number,
  targets: number,
  targetQuota: number,
  mode: MassGroupConfig['assignMode'],
): MassGroupConfig {
  return {
    id: 'g1',
    nome: 'Full - Br142',
    origins: coords(origins, 100, 100),
    originQuotas: Array.from({ length: origins }, () => 1),
    targets: coords(targets, 600, 600),
    targetQuotas: Array.from({ length: targets }, () => targetQuota),
    towers: [],
    towerRadius: 15,
    slowestUnit: 'ram',
    assignMode: mode,
    repeatOriginSamePlayer: true,
    minDistance: 0,
    maxDistance: 2000,
    arrivalKind: 'fixa',
    arrivalBaseMs: new Date(2026, 8, 5, 7, 1, 0).getTime(),
    windowStartMs: 0,
    windowEndMs: 0,
    attackDelaySeconds: 0,
    nightBonus: 'reagendar',
    avoidMsConflict: true,
    minMorale: 0,
    catapultTargets: [],
  };
}

const ctx: MassPlanContext = {
  unitMinutesPerField: { ram: 26.67 },
  nightBonus: { nightBonusActive: true, nightStartHour: 23, nightEndHour: 7 },
  villagePoints: new Map(),
  ownerByCoord: new Map(),
  playerPoints: new Map(),
  villageIdByCoord: new Map(),
  moralActive: false,
};

describe('stress — OP do colega (2428×183 = 444k pares)', () => {
  it.each([['otimizado'], ['por-jogador'], ['mais-perto']] as const)(
    'gera no modo %s com aviso de OP pesada',
    { timeout: 120_000 },
    (mode) => {
      const t0 = performance.now();
      const result = generateMassPlan([buildGroup(2428, 183, 14, mode)], ctx);
      console.log(`[stress] 2428×183 ${mode}: ${result.commands.length} comandos em ${(performance.now() - t0).toFixed(0)}ms`);
      expect(result.commands.length).toBe(2428);
      expect(result.warnings.some((warning) => warning.includes('OP pesada'))).toBe(true);
    },
  );

  it('rascunho da escala real cabe no store dedicado (bem abaixo do teto de 2 MB)', () => {
    const json = JSON.stringify([buildGroup(2428, 183, 14, 'otimizado')]);
    expect(json.length).toBeGreaterThan(19_000);
    expect(json.length).toBeLessThan(2_000_000);
  });
});

describe('stress — OP do dono, mundo inteiro (7005×1701 = 11,9M pares)', () => {
  it.each([['mais-perto'], ['por-jogador'], ['otimizado']] as const)(
    'gera no modo %s com aviso de mundo inteiro',
    { timeout: 300_000 },
    (mode) => {
      const t0 = performance.now();
      const result = generateMassPlan([buildGroup(7005, 1701, 5, mode)], ctx);
      console.log(`[stress] 7005×1701 ${mode}: ${result.commands.length} comandos em ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      expect(result.commands.length).toBe(7005); // cotas alvo 5×1701=8505 ≥ origens
      expect(result.warnings.some((warning) => warning.includes('mundo inteiro'))).toBe(true);
    },
  );
});
