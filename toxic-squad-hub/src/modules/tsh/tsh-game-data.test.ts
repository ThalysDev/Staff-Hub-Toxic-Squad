// Viagem com a velocidade REAL do BR142: o get_unit_info já serve o valor com
// a velocidade do mundo aplicada — não pode ser dividido de novo.
import { describe, expect, it } from 'vitest';
import { travelMinutesFromEffective } from './tsh-game-data';

// Copiados de tests/fixtures/br142/unit-info.xml (get_config: speed 1.5,
// unit_speed 0.75 → fator 1,125; nobre base 35, lanceiro base 18).
const BR142_SNOB = 31.111111111111;
const BR142_SPEAR = 16;

describe('travelMinutesFromEffective (BR142 real)', () => {
  it('nobre a 10 campos = 311,1 min (35 base ÷ 1,125), não 276,5', () => {
    const minutes = travelMinutesFromEffective({ x: 500, y: 500 }, { x: 506, y: 508 }, BR142_SNOB);
    expect(minutes).toBeCloseTo(311.11, 1);
  });

  it('lanceiro 16 min/campo × 5 campos = 80 min', () => {
    expect(travelMinutesFromEffective({ x: 0, y: 0 }, { x: 3, y: 4 }, BR142_SPEAR)).toBe(80);
  });
});
