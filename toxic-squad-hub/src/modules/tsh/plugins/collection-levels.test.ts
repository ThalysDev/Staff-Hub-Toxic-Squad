import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOT_FACTOR, readScavengeLevels, splitEquilibrada } from './collection-levels';

// Chaves reais do objeto `village` da tela de coleta (BR142, 24/09/2026).
const SCRIPT = `var village = {"village_id":35454,"player_id":1618709,"options":{"1":{"is_locked":false,"scavenging_squad":null},"2":{"is_locked":false,"scavenging_squad":{"unit_counts":{"spear":10},"return_time":1790000000}},"3":{"is_locked":false,"scavenging_squad":null},"4":{"is_locked":true,"scavenging_squad":null}}};
`;

describe('níveis da coleta', () => {
  it('lê bloqueado, em coleta (com a volta) e livre', () => {
    expect(readScavengeLevels(SCRIPT)).toEqual([
      { id: 1, locked: false, returnUnix: null },
      { id: 2, locked: false, returnUnix: 1790000000 },
      { id: 3, locked: false, returnUnix: null },
      { id: 4, locked: true, returnUnix: null },
    ]);
  });
  it('sem o objeto = null (cai no leitor antigo)', () => {
    expect(readScavengeLevels('<html></html>')).toBeNull();
  });
});

describe('coleta equilibrada', () => {
  const lf = (id: number): number => DEFAULT_LOOT_FACTOR[id] ?? 0.1;
  it('divide por 1/fator para voltarem juntas (4 níveis: 10 : 4 : 2 : 1,33)', () => {
    const squads = splitEquilibrada({ spear: 1733 }, [1, 2, 3, 4], lf, 10);
    expect(squads.map((s) => s.units.spear)).toEqual([1002, 399, 199, 133]);
    // capacidade × fator ≈ igual em todos (mesma duração)
    const produtos = squads.map((s) => (s.units.spear ?? 0) * lf(s.levelId));
    expect(Math.max(...produtos) - Math.min(...produtos)).toBeLessThan(2);
  });
  it('só usa os níveis livres e deixa de fora tropas que não carregam', () => {
    const squads = splitEquilibrada({ axe: 600, spy: 50, ram: 10 }, [1, 3], lf, 10);
    expect(squads.map((s) => s.levelId)).toEqual([1, 3]);
    expect(squads.every((s) => s.units.spy === undefined && s.units.ram === undefined)).toBe(true);
    expect(squads.reduce((a, s) => a + (s.units.axe ?? 0), 0)).toBe(600);
  });
  it('pouca tropa: tira os níveis longos até cada grupo ter o mínimo', () => {
    const squads = splitEquilibrada({ spear: 30 }, [1, 2, 3, 4], lf, 10);
    expect(squads.every((s) => Object.values(s.units).reduce((a, b) => a + (b ?? 0), 0) >= 10)).toBe(true);
    expect(squads[0]?.levelId).toBe(1);
  });
});
