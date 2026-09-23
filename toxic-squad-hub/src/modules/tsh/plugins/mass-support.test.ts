// Partes PURAS do plugin Apoio em Massa (ambiente node, sem DOM): defaults do
// schema de configurações (porta do massSupportSettings da origem) e o mapeio
// comando planejado → entradas do transporte (target + unidades completas).
import { describe, expect, it } from 'vitest';
import type { PlannedSupportCommand } from '../../../ext/modules/features/mass-support/support-planner';
import { commandToTransport, massSupportSettingsSchema } from './mass-support';

const command = (targetCoordinate: string): PlannedSupportCommand => ({
  id: 'command_0123456789abcdef',
  accountId: 'conta-do-hub',
  worldId: 'br142',
  sourceVillageId: '238755',
  sourceCoordinate: '534|551',
  targetCoordinate,
  units: { spear: 100, sword: 0, archer: 50, spy: 0, light: 0, marcher: 0, heavy: 10 },
  distance: 10.5,
  durationSeconds: 3600,
  arrivalAt: '2026-09-21T12:00:00.000Z',
  population: 1450,
});

describe('massSupportSettingsSchema', () => {
  it('nascimento por padrão: modo imediato, prévia (armed ausente)', () => {
    const settings = massSupportSettingsSchema.parse({});
    expect(settings.mode).toBe('immediate');
    expect(settings.armed).toBeUndefined();
    expect(settings.allocationStrategy).toBe('max_available');
    expect(settings.destinations).toEqual([]);
    expect(settings.targets).toEqual([]);
    expect(settings.hasArchers).toBe(true);
  });

  it('valida coordenadas canônicas e rejeita formato estranho (fail-closed)', () => {
    const ok = massSupportSettingsSchema.parse({ destinations: [{ coordinate: '534|551' }] });
    expect(ok.destinations[0]?.coordinate).toBe('534|551');
    expect(() => massSupportSettingsSchema.parse({ destinations: [{ coordinate: '1000|1' }] })).toThrow();
    expect(() => massSupportSettingsSchema.parse({ destinations: [{ coordinate: 'abc|1' }] })).toThrow();
  });
});

describe('commandToTransport', () => {
  it('mapeia alvo "x|y" e unidades SEMPRE completas (sem campo vivo do form)', () => {
    expect(commandToTransport(command('500|500'))).toEqual({
      target: '500|500',
      units: { spear: 100, sword: 0, archer: 50, spy: 0, light: 0, marcher: 0, heavy: 10 },
    });
  });

  it('coordenada corrompida nunca vira ação (fail-closed do planner)', () => {
    expect(() => commandToTransport(command('1000|5'))).toThrow(/Invalid coordinate/);
    expect(() => commandToTransport(command('x|y'))).toThrow(/Invalid coordinate/);
  });
});
