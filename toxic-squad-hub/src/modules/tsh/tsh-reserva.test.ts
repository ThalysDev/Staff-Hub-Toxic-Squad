// Reserva de tropas dos comandos agendados nas automações.
import { describe, expect, it } from 'vitest';
import type { ScheduledCommandRecord } from '../../ext/core/scheduler-state';
import { conflictReason, estimateScavengeSeconds, readScavengeOptionCfg, reservationFrom, subtractReservation } from './tsh-reserva';

function cmd(over: Partial<ScheduledCommandRecord>): ScheduledCommandRecord {
  return {
    id: 'c',
    kind: 'attack',
    sourceVillageId: '35454',
    target: { x: 1, y: 1 },
    units: { axe: 3000, ram: 300 },
    timingMode: 'send',
    sendAt: new Date(10_000_000).toISOString(),
    paused: false,
    createdAt: new Date(0).toISOString(),
    events: [],
    ...over,
  };
}

describe('reserva de tropas', () => {
  it('só comandos vivos da aldeia que saem antes da volta', () => {
    const res = reservationFrom(
      [cmd({}), cmd({ id: 'longe', sendAt: new Date(99_000_000).toISOString() }), cmd({ id: 'outra', sourceVillageId: '1' }), cmd({ id: 'pausado', paused: true }), cmd({ id: 'enviado', events: [{ status: 'enviado', at: '' }] })],
      '35454',
      0,
      20_000_000,
    );
    expect(res.commands.map((c) => c.id)).toEqual(['c']);
    expect(res.units).toEqual({ axe: 3000, ram: 300 });
  });
  it('"Todas" reserva o tipo inteiro; o resto fica livre para a automação', () => {
    const res = reservationFrom([cmd({ units: { snob: 1 }, allUnits: ['light'] })], '35454', 0, 20_000_000);
    expect(subtractReservation({ light: 1000, axe: 500, snob: 4 }, res)).toEqual({ light: 0, axe: 500, snob: 3 });
  });
  it('conflito: pedido maior que o livre', () => {
    const res = reservationFrom([cmd({})], '35454', 0, 20_000_000);
    expect(conflictReason({ ram: 10 }, { ram: 300 }, res)).toContain('reservado');
    expect(conflictReason({ ram: 10 }, { ram: 400 }, res)).toBeNull();
    expect(conflictReason({ spear: 10 }, { spear: 50 }, res)).toBeNull();
  });
});

describe('duração da coleta', () => {
  const html = 'new ScavengeScreen(\n {"1":{"id":1,"loot_factor":0.1,"duration_exponent":0.45,"duration_initial_seconds":1800,"duration_factor":0.8001102010732514}},\n village, {});';
  it('lê os parâmetros da tela e estima a duração', () => {
    const cfg = readScavengeOptionCfg(html);
    expect(cfg?.['1']?.loot_factor).toBe(0.1);
    const s = estimateScavengeSeconds({ spear: 100 }, cfg!['1']!);
    // cap 2500 → (2500²·100·0,01)^0,45 ≈ 1161; (1161+1800)·0,8 ≈ 2369 s
    expect(Math.round(s)).toBeGreaterThan(2300);
    expect(Math.round(s)).toBeLessThan(2450);
  });
});

describe('duração da coleta — tela REAL do BR142', async () => {
  const { default: screenHtml } = await import('./__fixtures__/br142-scavenge-screen.html?raw');
  it('lê os 4 níveis com os parâmetros do jogo', () => {
    const cfg = readScavengeOptionCfg(screenHtml);
    expect(Object.keys(cfg ?? {})).toEqual(['1', '2', '3', '4']);
    expect(cfg?.['3']).toMatchObject({ loot_factor: 0.5, duration_exponent: 0.45, duration_initial_seconds: 1800 });
  });
});
