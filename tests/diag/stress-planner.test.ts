// STRESS de escala real (relato da staff 01/09): grupo "full" com 2428 origens
// × 183 alvos. v0.32: o teto subiu para 1M de pares — a OP real GERA. Este
// suite fixa isso (regressão) e mede os tempos por modo (o aviso "OP pesada"
// dispara acima de 100k pares).
import { describe, expect, it } from 'vitest';
import { generateMassPlan } from '@shared/mass-planner-engine';
import type { MassGroupConfig, MassPlanContext } from '@shared/mass-planner-types';

function coords(n: number, startX: number, startY: number) {
  const list = [];
  for (let i = 0; i < n; i++) {
    const x = startX + (i % 60);
    const y = startY + Math.floor(i / 60);
    list.push({ coord: `${x}|${y}`, x, y });
  }
  return list;
}

const ORIGENS = 2428;
const ALVOS = 183;

function buildGroup(mode: MassGroupConfig['assignMode']): MassGroupConfig {
  return {
    id: 'g1',
    nome: 'full',
    origins: coords(ORIGENS, 100, 100),
    originQuotas: Array.from({ length: ORIGENS }, () => 1),
    targets: coords(ALVOS, 500, 500),
    targetQuotas: Array.from({ length: ALVOS }, () => 14),
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
  ownerByCoord: new Map(), // SEM dump: 1 bloco só nas exportações (pior caso)
  playerPoints: new Map(),
  villageIdByCoord: new Map(),
  moralActive: false,
};

describe('stress — escala real da staff (2428×183 = 444k pares)', () => {
  it.each([['otimizado'], ['por-jogador'], ['mais-perto']] as const)(
    'gera no modo %s com aviso de OP pesada',
    { timeout: 120_000 },
    (mode) => {
      const t0 = performance.now();
      const result = generateMassPlan([buildGroup(mode)], ctx);
      const elapsed = performance.now() - t0;
      console.log(`[stress] ${mode}: ${result.commands.length} comandos em ${elapsed.toFixed(0)}ms`);
      expect(result.commands.length).toBe(2428); // cotas alvo 14×183=2562 ≥ origens 2428
      expect(result.warnings.some((warning) => warning.includes('OP pesada'))).toBe(true);
    },
  );

  it('rascunho da escala real cabe no store dedicado (bem abaixo do teto de 2 MB)', () => {
    const json = JSON.stringify([buildGroup('otimizado')]);
    console.log(`[stress] rascunho JSON: ${(json.length / 1024).toFixed(1)} KB`);
    expect(json.length).toBeGreaterThan(19_000); // não caberia nas prefs (cap 20k)
    expect(json.length).toBeLessThan(2_000_000); // cabe no planner-draft
  });
});
