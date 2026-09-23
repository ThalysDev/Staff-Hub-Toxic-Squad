// Partes PURAS do plugin Apoio em Massa (ambiente node, sem DOM): defaults do
// schema de configurações (porta do massSupportSettings da origem), o mapeio
// comando planejado → entradas do transporte (target + unidades completas) e o
// plano da defesa agendada → registros do Agendador (sendAt = chegada − viagem).
import { describe, expect, it } from 'vitest';
import type { PlannedSupportCommand } from '../../../ext/modules/features/mass-support/support-planner';
import { buildSupportSchedulerRecords, commandToTransport, massSupportSettingsSchema } from './mass-support';

const command = (
  targetCoordinate: string,
  overrides: Partial<PlannedSupportCommand> = {},
): PlannedSupportCommand => ({
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
  ...overrides,
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

describe('buildSupportSchedulerRecords', () => {
  /** 21/09/2026 10:00:00.000 UTC — relógio fixo dos testes. */
  const NOW = Date.UTC(2026, 8, 21, 10, 0, 0, 0);

  it('defesa agendada vira registro de apoio com sendAt = chegada − viagem', () => {
    const draft = buildSupportSchedulerRecords([command('500|500')], NOW);
    expect(draft.skipped).toEqual([]);
    expect(draft.records).toHaveLength(1);
    const record = draft.records[0]!;
    expect(record.kind).toBe('support');
    expect(record.sourceVillageId).toBe('238755');
    expect(record.source).toEqual({ x: 534, y: 551 });
    expect(record.target).toEqual({ x: 500, y: 500 });
    expect(record.timingMode).toBe('send');
    expect(record.sendAt).toBe('2026-09-21T11:00:00.000Z'); // 12:00 − 3600s
    expect(record.arrivalAt).toBe('2026-09-21T12:00:00.000Z');
    // Só unidades > 0 (o motor compara o payload 1:1 com a tela).
    expect(record.units).toEqual({ spear: 100, archer: 50, heavy: 10 });
    expect(record.paused).toBe(false);
    expect(record.id).toMatch(/^cid_[0-9a-f]{16}$/);
  });

  it('recusa partida impossível e comando sem unidades (nada é agendado)', () => {
    const late = buildSupportSchedulerRecords(
      [command('500|500', { arrivalAt: '2026-09-21T10:30:00.000Z', durationSeconds: 3600 })],
      NOW,
    );
    expect(late.records).toEqual([]);
    expect(late.skipped[0]!.reason).toMatch(/janela impossível/);
    const empty = buildSupportSchedulerRecords(
      [
        command('500|500', {
          units: { spear: 0, sword: 0, archer: 0, spy: 0, light: 0, marcher: 0, heavy: 0 },
        }),
      ],
      NOW,
    );
    expect(empty.records).toEqual([]);
    expect(empty.skipped[0]!.reason).toMatch(/sem unidades/);
  });
});
