// Lock POR ALDEIA (Onda 1): lock, cooldown e status do Agendador andam por
// aldeia. Regressão da revisão de código: só o lock era por aldeia e o
// cooldown por mundo — com duas abas de origem, uma nunca rodava.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
vi.stubGlobal('GM_getValue', (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback));
vi.stubGlobal('GM_setValue', (key: string, value: unknown) => store.set(key, value));
vi.stubGlobal('GM_deleteValue', (key: string) => store.delete(key));
const page = { location: { hostname: 'br142.tribalwars.com.br', search: '' }, game_data: { village: { id: 1 } } };
vi.stubGlobal('window', page);

const { registerTsh, applyScheduleChange, tshNextRunAt, currentVillageId } = await import('./tsh-runtime');
const { saveSchedule } = await import('./tsh-settings');

registerTsh({
  id: 'agendador-teste',
  label: 'teste',
  desc: '',
  screen: 'place',
  mutating: true,
  lockPerVillage: true,
  cooldownMs: 20_000,
  runCycle: async () => undefined,
});
registerTsh({ id: 'mundo-teste', label: 'teste', desc: '', screen: null, mutating: false, runCycle: async () => undefined });

describe('escopo por aldeia do runtime', () => {
  beforeEach(() => store.clear());

  it('aldeia vem do game_data (sem prefixo n); URL é reserva', () => {
    page.game_data.village.id = 1;
    expect(currentVillageId()).toBe('1');
  });

  it('cooldown de UMA aldeia não bloqueia a outra (lockPerVillage)', () => {
    page.game_data.village.id = 1;
    store.set('tsh-auto:br142:agendador-teste:v1:state', JSON.stringify({ lastRunAt: 1_000, nextRunAt: 21_000 }));
    saveSchedule('br142', 'agendador-teste', {});
    applyScheduleChange('agendador-teste', 'br142');
    expect(tshNextRunAt('agendador-teste', 'br142')).toBe(21_000);
    page.game_data.village.id = 2; // outra aba, outra aldeia de origem
    expect(tshNextRunAt('agendador-teste', 'br142')).toBeNull();
  });

  it('módulo sem lockPerVillage segue por MUNDO', () => {
    page.game_data.village.id = 1;
    store.set('tsh-auto:br142:mundo-teste:state', JSON.stringify({ lastRunAt: 1_000, nextRunAt: 301_000 }));
    page.game_data.village.id = 2;
    expect(tshNextRunAt('mundo-teste', 'br142')).toBe(301_000);
  });
});
