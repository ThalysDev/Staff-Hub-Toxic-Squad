import { describe, expect, it } from 'vitest';
import type { TroopEntry, TroopSnapshot } from './sg2-engine';
import {
  formatSummaryPlayerTsv,
  formatSummaryVillageTsv,
  SUMMARY_UNIT_ORDER,
  summarizeSnapshot,
} from './sg2-summary';
import { UNITS } from './units';

function perMember(entries: TroopEntry[]): TroopSnapshot {
  return { kind: 'troops', source: 'per-member', collectedAt: '2026-01-01T00:00:00.000Z', entries };
}

function summarySnapshot(entries: TroopEntry[]): TroopSnapshot {
  return { kind: 'troops', source: 'summary', collectedAt: '2026-01-01T00:00:00.000Z', entries };
}

// Fixture por membro: 3 jogadores, aldeias ofensiva/defensiva/vazia, Ks 11/55/77/22 e eixos variados.
const entries: TroopEntry[] = [
  { playerId: 1, playerName: 'Ana', coord: { x: 100, y: 100 }, villageName: 'Ana Def', units: { spear: 100, sword: 50 } },
  { playerId: 1, playerName: 'Ana', coord: { x: 550, y: 550 }, villageName: 'Ana Off', units: { axe: 1000, light: 100 } },
  { playerId: 1, playerName: 'Ana', coord: { x: 150, y: 150 }, villageName: 'Ana Vazia', units: {} },
  { playerId: 2, playerName: 'Bruno', coord: { x: 777, y: 777 }, villageName: 'Bruno Def', units: { spear: 200 }, incomingAttacksCount: 3 },
  { playerId: 3, playerName: 'Carla', coord: { x: 200, y: 200 }, villageName: 'Carla Off', units: { axe: 50 } },
];

describe('SUMMARY_UNIT_ORDER', () => {
  it('tem todas as unidades na ordem de declaração, exceto milícia', () => {
    expect(SUMMARY_UNIT_ORDER).toEqual((Object.keys(UNITS) as (keyof typeof UNITS)[]).filter((id) => id !== 'militia'));
    expect(SUMMARY_UNIT_ORDER).toHaveLength(12);
    expect(SUMMARY_UNIT_ORDER[0]).toBe('spear');
    expect(SUMMARY_UNIT_ORDER[SUMMARY_UNIT_ORDER.length - 1]).toBe('snob');
    expect(SUMMARY_UNIT_ORDER).not.toContain('militia');
  });
});

describe('summarizeSnapshot — per-member sem filtros', () => {
  it('totais: jogadores, aldeias, classificação, unidades e populações', () => {
    const result = summarizeSnapshot(perMember(entries));
    expect(result.summaryOnly).toBe(false);
    expect(result.totals.players).toBe(3);
    expect(result.totals.villages).toBe(5);
    expect(result.totals.offensive).toBe(2);
    expect(result.totals.defensive).toBe(2);
    expect(result.totals.empty).toBe(1);
    expect(result.totals.units).toEqual({ spear: 300, sword: 50, axe: 1050, light: 100 });
    expect(result.totals.offPop).toBe(1450);
    expect(result.totals.defPop).toBe(350);
    expect(result.totals.avgOffPopPerVillage).toBe(290);
    expect(result.totals.avgDefPopPerVillage).toBe(70);
  });

  it('byPlayer agrega aldeias e unidades por jogador', () => {
    const { byPlayer } = summarizeSnapshot(perMember(entries));
    expect(byPlayer.map((p) => p.playerName)).toEqual(['Ana', 'Bruno', 'Carla']);
    const ana = byPlayer[0]!;
    expect(ana.playerId).toBe(1);
    expect(ana.villageCount).toBe(3);
    expect(ana.offensiveCount).toBe(1);
    expect(ana.defensiveCount).toBe(1);
    expect(ana.emptyCount).toBe(1);
    expect(ana.units).toEqual({ spear: 100, sword: 50, axe: 1000, light: 100 });
    expect(ana.offPop).toBe(1400);
    expect(ana.defPop).toBe(150);
  });

  it('byVillage traz klass, coordenada formatada e ataques quando existir', () => {
    const { byVillage } = summarizeSnapshot(perMember(entries));
    expect(byVillage.map((v) => v.coord)).toEqual(['100|100', '150|150', '550|550', '777|777', '200|200']);
    const a2 = byVillage.find((v) => v.coord === '550|550')!;
    expect(a2.klass).toBe('ofensiva');
    expect(a2.villageName).toBe('Ana Off');
    expect(a2.offPop).toBe(1400);
    expect(a2.defPop).toBe(0);
    expect(a2.units).toEqual({ axe: 1000, light: 100 });
    expect(a2.incomingAttacksCount).toBeUndefined();
    const b1 = byVillage.find((v) => v.coord === '777|777')!;
    expect(b1.klass).toBe('defensiva');
    expect(b1.incomingAttacksCount).toBe(3);
    expect(byVillage.find((v) => v.coord === '150|150')!.klass).toBe('vazia');
  });
});

describe('summarizeSnapshot — ordenações', () => {
  it('byPlayer: villageCount desc, depois playerName asc (localeCompare pt-BR, acento ignorado)', () => {
    const sorted: TroopEntry[] = [
      { playerId: 1, playerName: 'Zeca', coord: { x: 10, y: 10 }, villageName: 'z1', units: { axe: 1 } },
      { playerId: 1, playerName: 'Zeca', coord: { x: 20, y: 20 }, villageName: 'z2', units: { axe: 1 } },
      { playerId: 2, playerName: 'Ana', coord: { x: 30, y: 30 }, villageName: 'a1', units: { spear: 1 } },
      { playerId: 3, playerName: 'Álvaro', coord: { x: 40, y: 40 }, villageName: 'al1', units: { spear: 1 } },
    ];
    const { byPlayer } = summarizeSnapshot(perMember(sorted));
    expect(byPlayer.map((p) => p.playerName)).toEqual(['Zeca', 'Álvaro', 'Ana']);
  });

  it('byVillage: playerName asc, depois coord asc como string', () => {
    const samePlayer: TroopEntry[] = [
      { playerId: 1, playerName: 'Ana', coord: { x: 55, y: 5 }, villageName: 'v55', units: { spear: 1 } },
      { playerId: 1, playerName: 'Ana', coord: { x: 100, y: 45 }, villageName: 'v100', units: { spear: 1 } },
      { playerId: 1, playerName: 'Ana', coord: { x: 9, y: 9 }, villageName: 'v9', units: { spear: 1 } },
    ];
    const { byVillage } = summarizeSnapshot(perMember(samePlayer));
    // string: '100|45' < '55|5' < '9|9' (ordem lexicográfica, não numérica)
    expect(byVillage.map((v) => v.coord)).toEqual(['100|45', '55|5', '9|9']);
  });
});

describe('summarizeSnapshot — kFilter', () => {
  it('incluir [55,77]: só aldeias dos continentes listados', () => {
    const result = summarizeSnapshot(perMember(entries), { kFilter: { ks: [55, 77], mode: 'incluir' } });
    expect(result.totals.villages).toBe(2);
    expect(result.byVillage.map((v) => v.coord)).toEqual(['550|550', '777|777']);
    const ana = result.byPlayer[0]!;
    expect(ana.playerName).toBe('Ana');
    expect(ana.villageCount).toBe(1);
    expect(ana.units).toEqual({ axe: 1000, light: 100 });
  });

  it('excluir [55,77]: inverso — sobra K11 e K22', () => {
    const result = summarizeSnapshot(perMember(entries), { kFilter: { ks: [55, 77], mode: 'excluir' } });
    expect(result.byVillage.map((v) => v.coord)).toEqual(['100|100', '150|150', '200|200']);
    expect(result.byPlayer.map((p) => p.playerName)).toEqual(['Ana', 'Carla']);
  });

  it('incluir com ks vazio → NADA passa (fail-closed, nunca "tudo")', () => {
    const result = summarizeSnapshot(perMember(entries), { kFilter: { ks: [], mode: 'incluir' } });
    expect(result.totals.players).toBe(0);
    expect(result.totals.villages).toBe(0);
    expect(result.byPlayer).toEqual([]);
    expect(result.byVillage).toEqual([]);
  });

  it('K fora de 0–99 → erro PT-BR fail-closed (inclusive em modo resumo)', () => {
    expect(() => summarizeSnapshot(perMember(entries), { kFilter: { ks: [55, 120], mode: 'incluir' } })).toThrow(
      /inválido/i,
    );
    const resumo = summarySnapshot([
      { playerId: 1, playerName: 'ana', coord: { x: -1, y: -1 }, villageName: '', units: { spear: 10 } },
    ]);
    expect(() => summarizeSnapshot(resumo, { kFilter: { ks: [-1], mode: 'excluir' } })).toThrow(
      /use inteiros de 0 a 99/,
    );
  });
});

describe('summarizeSnapshot — filtros por aldeia', () => {
  it('axesRange restringe à faixa de eixos', () => {
    const result = summarizeSnapshot(perMember(entries), { axesRange: { minX: 100, maxX: 550, minY: 100, maxY: 500 } });
    expect(result.byVillage.map((v) => v.coord)).toEqual(['100|100', '150|150', '200|200']);
  });

  it('unitMinimums: a aldeia precisa ter >= mínimo em TODAS as unidades', () => {
    const apenasSpear = summarizeSnapshot(perMember(entries), { unitMinimums: { spear: 150 } });
    expect(apenasSpear.byVillage.map((v) => v.coord)).toEqual(['777|777']);
    // a1 tem spear 100 >= 100 E sword 50 >= 40; b1 (spear 200) falta sword → só a1
    const spearESword = summarizeSnapshot(perMember(entries), { unitMinimums: { spear: 100, sword: 40 } });
    expect(spearESword.byVillage.map((v) => v.coord)).toEqual(['100|100']);
    expect(spearESword.byPlayer.map((p) => p.playerName)).toEqual(['Ana']);
  });

  it('classification ofensivas: re-agrega por jogador só com as aldeias ofensivas', () => {
    const result = summarizeSnapshot(perMember(entries), { classification: 'ofensivas' });
    expect(result.totals.villages).toBe(2);
    expect(result.totals.offensive).toBe(2);
    expect(result.totals.defensive).toBe(0);
    expect(result.byVillage.map((v) => v.coord)).toEqual(['550|550', '200|200']);
    expect(result.byPlayer.map((p) => p.playerName)).toEqual(['Ana', 'Carla']);
    expect(result.byPlayer[0]!.villageCount).toBe(1);
    expect(result.byPlayer[0]!.units).toEqual({ axe: 1000, light: 100 });
  });

  it('classification vazias: só aldeias sem tropas pontuáveis', () => {
    const result = summarizeSnapshot(perMember(entries), { classification: 'vazias' });
    expect(result.byVillage.map((v) => v.coord)).toEqual(['150|150']);
    expect(result.totals.empty).toBe(1);
    expect(result.totals.offPop).toBe(0);
    expect(result.totals.avgOffPopPerVillage).toBe(0);
  });
});

describe('summarizeSnapshot — playerQuery', () => {
  it('contains case-insensitive com acento e trim', () => {
    const acentuados: TroopEntry[] = [
      { playerId: 1, playerName: 'José', coord: { x: 100, y: 100 }, villageName: 'j1', units: { axe: 1 } },
      { playerId: 2, playerName: 'João', coord: { x: 200, y: 200 }, villageName: 'j2', units: { spear: 1 } },
    ];
    const jose = summarizeSnapshot(perMember(acentuados), { playerQuery: '  JOSÉ  ' });
    expect(jose.byPlayer.map((p) => p.playerName)).toEqual(['José']);
    const joao = summarizeSnapshot(perMember(acentuados), { playerQuery: 'joÃo' });
    expect(joao.byPlayer.map((p) => p.playerName)).toEqual(['João']);
    const ambos = summarizeSnapshot(perMember(acentuados), { playerQuery: '  ' });
    expect(ambos.byPlayer).toHaveLength(2);
  });
});

describe('summarizeSnapshot — snapshot de resumo (source summary)', () => {
  const resumo = summarySnapshot([
    { playerId: 1, playerName: 'Ana', coord: { x: -1, y: -1 }, villageName: '', units: { spear: 5000, axe: 200 } },
    { playerId: 2, playerName: 'Bruno', coord: { x: -1, y: -1 }, villageName: '', units: { sword: 300 } },
  ]);

  it('summaryOnly=true, byVillage vazia, mas unidades contam por jogador e nos totais', () => {
    const result = summarizeSnapshot(resumo);
    expect(result.summaryOnly).toBe(true);
    expect(result.byVillage).toEqual([]);
    expect(result.totals.villages).toBe(0);
    expect(result.totals.players).toBe(2);
    expect(result.totals.units).toEqual({ spear: 5000, axe: 200, sword: 300 });
    expect(result.totals.offPop).toBe(200);
    expect(result.totals.defPop).toBe(5300);
    expect(result.totals.avgOffPopPerVillage).toBe(0);
    expect(result.totals.avgDefPopPerVillage).toBe(0);
    expect(result.byPlayer.map((p) => p.playerName)).toEqual(['Ana', 'Bruno']);
    expect(result.byPlayer[0]!.villageCount).toBe(0);
  });

  it('kFilter/axesRange/classification são no-ops em resumo (entradas passam)', () => {
    const result = summarizeSnapshot(resumo, {
      kFilter: { ks: [55], mode: 'incluir' },
      axesRange: { minX: 500 },
      classification: 'ofensivas',
    });
    expect(result.totals.players).toBe(2);
    expect(result.totals.units).toEqual({ spear: 5000, axe: 200, sword: 300 });
    expect(result.byPlayer).toHaveLength(2);
  });

  it('unitMinimums aplica sobre as unidades da própria entrada', () => {
    const result = summarizeSnapshot(resumo, { unitMinimums: { spear: 1000 } });
    expect(result.byPlayer.map((p) => p.playerName)).toEqual(['Ana']);
    expect(result.totals.units).toEqual({ spear: 5000, axe: 200 });
  });
});

describe('summarizeSnapshot — entrada sem coordenada em snapshot per-member', () => {
  const misto = perMember([
    { playerId: 1, playerName: 'Ana', coord: { x: 100, y: 100 }, villageName: 'a1', units: { spear: 100 } },
    { playerId: 1, playerName: 'Ana', coord: { x: -1, y: -1 }, villageName: '', units: { sword: 900 } },
  ]);

  it('não vira aldeia, mas soma em byPlayer/totais', () => {
    const result = summarizeSnapshot(misto);
    expect(result.summaryOnly).toBe(false);
    expect(result.totals.villages).toBe(1);
    expect(result.totals.defensive).toBe(1);
    expect(result.byVillage).toHaveLength(1);
    expect(result.byPlayer[0]!.villageCount).toBe(1);
    expect(result.byPlayer[0]!.units).toEqual({ spear: 100, sword: 900 });
    expect(result.totals.defPop).toBe(1000);
    // Média por aldeia conta SÓ a população das aldeias com coordenada
    // (100 da aldeia spear), nunca a da entrada sem coord (900 sword).
    expect(result.totals.avgDefPopPerVillage).toBe(100);
    expect(result.totals.avgOffPopPerVillage).toBe(0);
  });

  it('classification não derruba a entrada sem coordenada', () => {
    const result = summarizeSnapshot(misto, { classification: 'ofensivas' });
    expect(result.byVillage).toEqual([]);
    expect(result.byPlayer).toHaveLength(1);
    expect(result.byPlayer[0]!.villageCount).toBe(0);
    expect(result.byPlayer[0]!.units).toEqual({ sword: 900 });
  });
});

describe('summarizeSnapshot — médias', () => {
  it('médias com 1 casa decimal; sem aldeias = 0 (nunca NaN)', () => {
    const tres: TroopEntry[] = [
      { playerId: 1, playerName: 'a', coord: { x: 10, y: 10 }, villageName: 'v1', units: { axe: 10 } },
      { playerId: 2, playerName: 'b', coord: { x: 20, y: 20 }, villageName: 'v2', units: { axe: 10 } },
      { playerId: 3, playerName: 'c', coord: { x: 30, y: 30 }, villageName: 'v3', units: { axe: 11, spear: 6 } },
    ];
    const result = summarizeSnapshot(perMember(tres));
    // offPop 31/3 = 10,333… → 10,3 · defPop 6/3 = 2
    expect(result.totals.avgOffPopPerVillage).toBe(10.3);
    expect(result.totals.avgDefPopPerVillage).toBe(2);
    const vazio = summarizeSnapshot(perMember([]));
    expect(vazio.totals.players).toBe(0);
    expect(vazio.totals.avgOffPopPerVillage).toBe(0);
    expect(vazio.totals.avgDefPopPerVillage).toBe(0);
  });
});

describe('summarizeSnapshot — filtros combinados', () => {
  it('playerQuery + kFilter + unitMinimums + classification juntos', () => {
    const result = summarizeSnapshot(perMember(entries), {
      playerQuery: 'a',
      kFilter: { ks: [55, 77], mode: 'incluir' },
      unitMinimums: { axe: 100 },
      classification: 'ofensivas',
    });
    expect(result.byVillage.map((v) => v.coord)).toEqual(['550|550']);
    expect(result.byPlayer).toHaveLength(1);
    expect(result.byPlayer[0]!.playerName).toBe('Ana');
    expect(result.byPlayer[0]!.villageCount).toBe(1);
    expect(result.totals.offPop).toBe(1400);
  });
});

describe('formatSummaryPlayerTsv', () => {
  it('cabeçalho + linhas tab-separated com unidades, sem BOM', () => {
    const { byPlayer } = summarizeSnapshot(perMember(entries));
    const tsv = formatSummaryPlayerTsv([byPlayer[0]!]);
    expect(tsv.split('\n')).toEqual([
      'Jogador\tAldeias\tOfensivas\tDefensivas\tVazias\tPopOff\tPopDef\tLanceiro\tEspadachim\tBárbaro\tArqueiro\tExplorador\tCavalaria Leve\tArqueiro a Cavalo\tCavalaria Pesada\tAriete\tCatapulta\tPaladino\tNobre',
      'Ana\t3\t1\t1\t1\t1400\t150\t100\t50\t1000\t0\t0\t100\t0\t0\t0\t0\t0\t0',
    ]);
    expect(tsv.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('aceita ordem de unidades customizada e lista vazia gera só cabeçalho', () => {
    const { byPlayer } = summarizeSnapshot(perMember(entries));
    expect(formatSummaryPlayerTsv([byPlayer[0]!], ['spear', 'axe'])).toBe(
      'Jogador\tAldeias\tOfensivas\tDefensivas\tVazias\tPopOff\tPopDef\tLanceiro\tBárbaro\nAna\t3\t1\t1\t1\t1400\t150\t100\t1000',
    );
    expect(formatSummaryPlayerTsv([], ['spear'])).toBe('Jogador\tAldeias\tOfensivas\tDefensivas\tVazias\tPopOff\tPopDef\tLanceiro');
  });
});

describe('formatSummaryVillageTsv', () => {
  it('cabeçalho + linhas com classe e ataques (0 quando ausente)', () => {
    const { byVillage } = summarizeSnapshot(perMember(entries));
    const comAtaques = byVillage.find((v) => v.coord === '777|777')!;
    const semAtaques = byVillage.find((v) => v.coord === '550|550')!;
    const tsv = formatSummaryVillageTsv([semAtaques, comAtaques]);
    expect(tsv.split('\n')).toEqual([
      'Jogador\tAldeia\tCoordenada\tClasse\tPopOff\tPopDef\tAtaques\tLanceiro\tEspadachim\tBárbaro\tArqueiro\tExplorador\tCavalaria Leve\tArqueiro a Cavalo\tCavalaria Pesada\tAriete\tCatapulta\tPaladino\tNobre',
      'Ana\tAna Off\t550|550\tofensiva\t1400\t0\t0\t0\t0\t1000\t0\t0\t100\t0\t0\t0\t0\t0\t0',
      'Bruno\tBruno Def\t777|777\tdefensiva\t0\t200\t3\t200\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0',
    ]);
    expect(tsv.startsWith('Jogador')).toBe(true);
  });

  it('aceita ordem de unidades customizada', () => {
    const { byVillage } = summarizeSnapshot(perMember(entries));
    const b1 = byVillage.find((v) => v.coord === '777|777')!;
    expect(formatSummaryVillageTsv([b1], ['spear', 'snob'])).toBe(
      'Jogador\tAldeia\tCoordenada\tClasse\tPopOff\tPopDef\tAtaques\tLanceiro\tNobre\nBruno\tBruno Def\t777|777\tdefensiva\t0\t200\t3\t200\t0',
    );
  });
});
