// Partes PURAS novas das Ondas 15a/16 (ambiente node, sem DOM): parse da
// barra de população e a decisão do modo "manter população" do recrutamento,
// e o parser da fila de construção em texto do Mega Construtor (whitelist de
// edifícios, fail-closed em linha inválida).
import { describe, expect, it } from 'vitest';
import { parsePopulationBar, recruitmentBlockedByPopulation } from './recruitment';
import { PRIORITY_UNTIL_MAX_LEVEL, parsePrioritiesText } from './mega-builder';

describe('parsePopulationBar (barra "12.345/24.000" da tela train)', () => {
  it('lê atual e teto com separador pt-BR', () => {
    expect(parsePopulationBar('12.345/24.000')).toEqual({ current: 12_345, max: 24_000 });
    expect(parsePopulationBar('160/240')).toEqual({ current: 160, max: 240 });
  });

  it('tolera espaços e decimais pt-BR', () => {
    expect(parsePopulationBar('12.345 / 24.000')).toEqual({ current: 12_345, max: 24_000 });
    expect(parsePopulationBar('1.234,5/2.000')).toEqual({ current: 1_234, max: 2_000 });
  });

  it('texto sem barra, vazio ou zerado = ilegível (null)', () => {
    expect(parsePopulationBar('Recrutamento — Quartel')).toBeNull();
    expect(parsePopulationBar('')).toBeNull();
    expect(parsePopulationBar(undefined)).toBeNull();
    expect(parsePopulationBar('0/240')).toBeNull();
    expect(parsePopulationBar('12.345/')).toBeNull();
  });
});

describe('recruitmentBlockedByPopulation (decisão do teto)', () => {
  it('0 = ilimitado: nunca bloqueia, mesmo com população alta ou ilegível', () => {
    expect(recruitmentBlockedByPopulation(0, { current: 999_999, max: 1_000_000 })).toBe(false);
    expect(recruitmentBlockedByPopulation(0, null)).toBe(false);
  });

  it('bloqueia quando a população atinge/ultrapassa o teto configurado', () => {
    expect(recruitmentBlockedByPopulation(20_000, { current: 20_000, max: 24_000 })).toBe(true);
    expect(recruitmentBlockedByPopulation(20_000, { current: 21_500, max: 24_000 })).toBe(true);
  });

  it('abaixo do teto deixa recrutar', () => {
    expect(recruitmentBlockedByPopulation(20_000, { current: 19_999, max: 24_000 })).toBe(false);
  });

  it('fail-closed: teto definido + barra ilegível = bloqueia', () => {
    expect(recruitmentBlockedByPopulation(20_000, null)).toBe(true);
  });
});

describe('parsePrioritiesText (fila em texto do Mega Construtor)', () => {
  it('lê "edifício:nível" na ordem, tolerando case e espaços', () => {
    expect(parsePrioritiesText('Main:20\nBARRACKS:5')).toEqual({
      ok: true,
      priorities: [
        { building: 'main', targetLevel: 20 },
        { building: 'barracks', targetLevel: 5 },
      ],
    });
    expect(parsePrioritiesText('  main : 10  ')).toEqual({
      ok: true,
      priorities: [{ building: 'main', targetLevel: 10 }],
    });
  });

  it('linha sem nível = até o máximo do edifício (sentinela 99)', () => {
    expect(PRIORITY_UNTIL_MAX_LEVEL).toBe(99);
    expect(parsePrioritiesText('main\nfarm')).toEqual({
      ok: true,
      priorities: [
        { building: 'main', targetLevel: 99 },
        { building: 'farm', targetLevel: 99 },
      ],
    });
  });

  it('linhas vazias são ignoradas e a ordem é preservada', () => {
    expect(parsePrioritiesText('\nwall\n\nmain:5\n')).toEqual({
      ok: true,
      priorities: [
        { building: 'wall', targetLevel: 99 },
        { building: 'main', targetLevel: 5 },
      ],
    });
  });

  it('aceita os 16 edifícios da whitelist', () => {
    const all =
      'main\nbarracks\nstable\ngarage\nsnob\nsmith\nplace\nstatue\nmarket\nwood\nstone\niron\nfarm\nstorage\nhide\nwall';
    const parsed = parsePrioritiesText(all);
    expect(parsed.ok && parsed.priorities).toHaveLength(16);
    expect(parsed.ok && parsed.priorities.every((item) => item.targetLevel === 99)).toBe(true);
  });

  it('texto só com linhas em branco = fila vazia válida', () => {
    expect(parsePrioritiesText('  \n\n')).toEqual({ ok: true, priorities: [] });
  });

  it('edifício fora da whitelist derruba o parse inteiro com a linha do erro', () => {
    const parsed = parsePrioritiesText('main:20\nchurch:1\nbarracks:10');
    expect(!parsed.ok && parsed.reason).toMatch(/linha 2/);
    expect(!parsed.ok && parsed.reason).toMatch(/church/);
  });

  it('nível inválido (0, negativo, não inteiro, não numérico) derruba o parse', () => {
    for (const bad of ['main:0', 'main:-3', 'main:2,5', 'main:zero']) {
      const parsed = parsePrioritiesText(bad);
      expect(!parsed.ok && parsed.reason).toMatch(/nível inválido/);
    }
  });

  it('dois-pontos sobrando ("main:20:30") é linha inválida', () => {
    const parsed = parsePrioritiesText('main:20:30');
    expect(!parsed.ok && parsed.reason).toMatch(/linha 1/);
  });
});
