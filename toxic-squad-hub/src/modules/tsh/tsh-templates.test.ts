// Fixtures ESTRUTURAIS derivadas da Praça real do BR142 (24/09/2026): o
// <script> com `TroopTemplates.current` e o <night> do get_config.
import { describe, expect, it } from 'vitest';
import { inNightBonus, parseGameTemplates, parseNightBonus } from './tsh-templates';
import { resolveAllUnits } from './plugins/command-scheduler';

const PLACE_SCRIPT = `<html><body><script>
TroopTemplates.current = {"250":{"archer":"0","axe":"0","catapult":"0","heavy":"0","id":"250","knight":"0","light":"0","marcher":"0","name":"1 Explorador","player_id":"1618709","ram":"0","snob":"0","spear":"0","spy":"1","sword":"0","use_all":[],"used":"23"},"1917":{"axe":"0","id":"1917","name":"FULL ATK","spy":"0","use_all":["axe","spy","light","marcher","ram","catapult","knight"],"used":"31"},"2437":{"id":"2437","name":"nobre padrao ","light":"100","snob":"1","use_all":[]},"all":{"id":"all","name":"Todas as tropas","spear":0,"use_all":["spear","sword","axe","archer","spy","light","marcher","heavy","ram","catapult","knight","snob"],"used":0},"fake":{"id":"fake","name":"Fake","catapult":26,"spy":1,"use_all":[]},"snob":{"id":"snob","name":"Nobre","snob":1,"use_all":["axe","light","marcher"]}};
</script></body></html>`;

describe('modelos de tropas do jogo', () => {
  const list = parseGameTemplates(PLACE_SCRIPT);
  it('lê os modelos do jogador primeiro e os do jogo por último', () => {
    expect(list.map((t) => t.name)).toEqual(['1 Explorador', 'FULL ATK', 'nobre padrao', 'Todas as tropas', 'Fake', 'Nobre']);
  });
  it('quantidades em texto viram número; use_all vira "Todas"', () => {
    expect(list[0]).toMatchObject({ units: { spy: 1 }, useAll: [] });
    expect(list[2]).toMatchObject({ units: { light: 100, snob: 1 } });
    expect(list[1]?.useAll).toContain('ram');
    expect(list.find((t) => t.id === 'snob')).toMatchObject({ units: { snob: 1 }, useAll: ['axe', 'light', 'marcher'] });
  });
  it('HTML sem modelos (ou quebrado) = lista vazia, nunca chute', () => {
    expect(parseGameTemplates('<html></html>')).toEqual([]);
    expect(parseGameTemplates('TroopTemplates.current = {quebrado};\n')).toEqual([]);
  });
});

describe('bônus noturno', () => {
  const nb = parseNightBonus('<config><night><active>1</active><start_hour>23</start_hour><end_hour>7</end_hour></night></config>');
  it('lê o get_config', () => {
    expect(nb).toEqual({ active: true, startHour: 23, endHour: 7 });
  });
  it('janela que vira a meia-noite', () => {
    expect(inNightBonus(new Date(2026, 8, 24, 23, 30).getTime(), nb)).toBe(true);
    expect(inNightBonus(new Date(2026, 8, 25, 6, 59).getTime(), nb)).toBe(true);
    expect(inNightBonus(new Date(2026, 8, 25, 7, 0).getTime(), nb)).toBe(false);
    expect(inNightBonus(new Date(2026, 8, 25, 12, 0).getTime(), nb)).toBe(false);
  });
  it('desligado ou desconhecido nunca avisa', () => {
    expect(inNightBonus(new Date(2026, 8, 24, 23, 30).getTime(), { active: false, startHour: 23, endHour: 7 })).toBe(false);
    expect(inNightBonus(Date.now(), null)).toBe(false);
  });
});

describe('"Todas" no disparo', () => {
  const speeds = { axe: 16, light: 8.89, ram: 26.67, snob: 31.11 };
  it('fixas + todas as disponíveis', () => {
    expect(resolveAllUnits({ snob: 1 }, ['axe', 'light'], { axe: 3063, light: 1025, snob: 4 }, { speeds })).toEqual({
      ok: true,
      units: { snob: 1, axe: 3063, light: 1025 },
      slowerMissing: [],
    });
  });
  it('por chegada: aborta só se a "Todas" vazia era a MAIS LENTA', () => {
    expect(resolveAllUnits({}, ['axe', 'ram'], { axe: 100, ram: 0 }, { arrivalLocked: true, speeds }).ok).toBe(false);
    // Aríete fixo, CL em "Todas" zerada: a chegada não muda — sai.
    expect(resolveAllUnits({ ram: 10 }, ['light'], {}, { arrivalLocked: true, speeds })).toEqual({ ok: true, units: { ram: 10 }, slowerMissing: [] });
    // Sem velocidades: qualquer vazia conta como mais lenta.
    expect(resolveAllUnits({ ram: 10 }, ['light'], {}, { arrivalLocked: true, speeds: null }).ok).toBe(false);
  });
  it('por envio: sai sem a vazia e acusa que a chegada muda; nada disponível aborta', () => {
    expect(resolveAllUnits({}, ['axe', 'ram'], { axe: 100 }, { speeds })).toEqual({ ok: true, units: { axe: 100 }, slowerMissing: ['ram'] });
    expect(resolveAllUnits({}, ['ram'], {}).ok).toBe(false);
  });
});
