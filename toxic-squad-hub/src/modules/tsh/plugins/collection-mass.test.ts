// Coleta em 2º plano — fixture REAL da Coleta em massa do BR142.
import { describe, expect, it } from 'vitest';
import massHtml from '../__fixtures__/br142-scavenge-mass.html?raw';
import { haulForHours, isOffensive, parseScavengeMassPage, planVillage, squadSeconds, unlockCandidate, usableUnits } from './collection-mass';

const all = { keepHome: {}, skipUnits: [] as string[] };

describe('Coleta em massa — leitura', () => {
  const page = parseScavengeMassPage(massHtml);
  it('lê níveis, carga das tropas, aldeias e a última página', () => {
    expect(page).not.toBeNull();
    expect(Object.keys(page!.levels)).toEqual(['1', '2', '3', '4']);
    expect(page!.carry).toMatchObject({ spear: 25, light: 80, knight: 100 });
    expect(page!.villages.map((v) => v.village_id)).toEqual([212005, 212056]);
    expect(page!.lastPage).toBe(24);
  });
});

describe('Coleta em massa — plano por aldeia', () => {
  const page = parseScavengeMassPage(massHtml)!;
  const v = page.villages[1]!; // 055: 467 lanças, 6068 bárbaros, 2757 leves, 200 arq. cav.
  it('sem tempo-alvo: todas as tropas que coletam, divididas pelos 4 níveis', () => {
    const reqs = planVillage(v, page, usableUnits(v, all), { targetHours: 0, minUnits: 10, level: 'equilibrada' });
    expect(reqs.map((r) => r.levelId)).toEqual([1, 2, 3, 4]);
    const total = (u: string): number => reqs.reduce((s, r) => s + ((r.units as Record<string, number>)[u] ?? 0), 0);
    expect(total('axe')).toBe(6068);
    expect(reqs.every((r) => (r.units as Record<string, number>).spy === undefined && (r.units as Record<string, number>).ram === undefined)).toBe(true);
  });
  it('tempo-alvo de 2 h: manda só o necessário, o resto fica em casa, e volta perto de 2 h', () => {
    const reqs = planVillage(v, page, usableUnits(v, all), { targetHours: 2, minUnits: 10, level: 'equilibrada' });
    const axe = reqs.reduce((s, r) => s + ((r.units as Record<string, number>).axe ?? 0), 0);
    expect(axe).toBeGreaterThan(0);
    expect(axe).toBeLessThan(6068);
    for (const r of reqs) {
      const h = squadSeconds(r.units, page.carry, 1, page.levels[String(r.levelId)]!) / 3600;
      expect(h).toBeGreaterThan(1.8);
      expect(h).toBeLessThanOrEqual(2.05);
    }
  });
  it('fica em casa, tropa desligada e teto do lote fixo', () => {
    const u = usableUnits(v, { keepHome: { axe: 6000 }, skipUnits: ['light'] });
    expect(u).toEqual({ spear: 467, axe: 68, marcher: 200 });
    expect(usableUnits(v, { keepHome: {}, skipUnits: [], fixedCaps: { axe: 100 } })).toEqual({ axe: 100 });
  });
  it('um nível só: grupo único naquele nível', () => {
    const reqs = planVillage(v, page, usableUnits(v, all), { targetHours: 0, minUnits: 10, level: 3 });
    expect(reqs.map((r) => r.levelId)).toEqual([3]);
  });
  it('ofensiva × defensiva e duração do grupo', () => {
    expect(isOffensive(v.unit_counts_home)).toBe(true);
    expect(isOffensive({ spear: 5000, sword: 3000, axe: 100 })).toBe(false);
    const s1 = squadSeconds({ spear: 100 }, page.carry, 1, page.levels['1']!);
    expect(squadSeconds({ spear: 100 }, page.carry, 1.5, page.levels['1']!)).toBeGreaterThan(s1);
  });
  it('aldeia com 3 tropas: abaixo do mínimo = nada', () => {
    expect(planVillage(page.villages[0]!, page, usableUnits(page.villages[0]!, all), { targetHours: 0, minUnits: 10, level: 'equilibrada' })).toEqual([]);
  });
  it('fórmula inversa: 2 h dá uma capacidade positiva, 0 h nenhuma', () => {
    const cfg = page.levels['1']!;
    expect(haulForHours(2, cfg)).toBeGreaterThan(0);
    expect(haulForHours(0, cfg)).toBe(0);
  });
});

describe('desbloqueio de nível', () => {
  const page = parseScavengeMassPage(massHtml)!;
  it('só o próximo da cadeia, com recursos e sem outro desbloqueando', () => {
    const v = structuredClone(page.villages[1]!);
    v.options['3']!.is_locked = true;
    v.options['4']!.is_locked = true;
    expect(unlockCandidate(v, page.levels)).toBe(3);
    v.options['2']!.unlock_time = 123;
    expect(unlockCandidate(v, page.levels)).toBeNull();
  });
});
