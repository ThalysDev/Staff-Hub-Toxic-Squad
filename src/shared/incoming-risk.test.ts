import { describe, expect, it } from 'vitest';
import type { IncomingCommandRow } from './parsers/village-parsers';
import {
  DEFAULT_THREAT_THRESHOLDS,
  assessVillageThreat,
  rankVillagesByThreat,
  threatSummary,
  type VillageThreatInput,
} from './incoming-risk';

let nextId = 700001; // faixa própria; ids só precisam ser únicos por teste
/** Linha de comando mínima coerente (mesmo formato da captura real). */
function row(overrides: Partial<IncomingCommandRow>): IncomingCommandRow {
  nextId += 1;
  return {
    commandId: nextId,
    name: 'Ataque',
    type: 'attack',
    hints: [],
    hasNoble: false,
    sizeHint: null,
    destination: { name: 'Minha Aldeia', coord: '543|551' },
    origin: { name: 'Alvo', coord: '612|606' },
    playerName: 'Inimigo',
    fieldsDistance: 96.8,
    arrivesAtText: 'hoje às 01:11:07:212',
    arrivesInText: '1:08:03',
    arrivalSecFromLoad: null,
    ...overrides,
  };
}

const attack = row.bind(null, {});
function support(): IncomingCommandRow {
  return row({ commandId: ++nextId, name: 'Suporte', type: 'support' });
}
function nobleAttack(): IncomingCommandRow {
  return row({ hasNoble: true, hints: ['Com nobre'] });
}
function bigAttack(): IncomingCommandRow {
  return row({ sizeHint: 'grande', hints: ['Ataque grande (5001-20000 tropas)'] });
}
function fakeAttack(): IncomingCommandRow {
  return row({ sizeHint: 'pequeno', hints: ['Ataque pequeno (1-1000 tropas)'] });
}

function village(coord: string, commands: IncomingCommandRow[], defensePop?: number): VillageThreatInput {
  return defensePop === undefined ? { coord, commands } : { coord, commands, defensePop };
}

describe('assessVillageThreat — contagens', () => {
  it('conta apenas attacks: nobres e grandes vêm de ataques, suporte é ignorado', () => {
    const result = assessVillageThreat(
      village('543|551', [attack(), nobleAttack(), bigAttack(), fakeAttack(), support(), support()], 12000),
    );
    expect(result.attackCount).toBe(4);
    expect(result.nobleCount).toBe(1);
    expect(result.bigCount).toBe(1);
  });

  it('suporte com nobre NÃO conta como nobre atacando (só type attack)', () => {
    const result = assessVillageThreat(
      village('543|551', [row({ name: 'Suporte', type: 'support', hasNoble: true, hints: ['Com nobre'] })], 100),
    );
    expect(result.attackCount).toBe(0);
    expect(result.nobleCount).toBe(0);
  });
});

describe('assessVillageThreat — regras na ordem', () => {
  it('sem nenhum ataque → resistente "sem ataques", mesmo sem defesa conhecida', () => {
    const result = assessVillageThreat(village('543|551', [support(), support()]));
    expect(result.level).toBe('resistente');
    expect(result.detail).toBe('sem ataques');
  });

  it('com ataques e defensePop undefined → sem-dados (fail-closed), nunca resistente', () => {
    const result = assessVillageThreat(village('543|551', [attack(), nobleAttack()]));
    expect(result.level).toBe('sem-dados');
    expect(result.detail).toContain('defesa desconhecida — rode a coleta do SG_3');
    expect(result.attackCount).toBe(2);
    expect(result.nobleCount).toBe(1);
  });

  it('defensePop 0 explícito NÃO é sem-dados: defesa vazia com nobre vai-cair', () => {
    const result = assessVillageThreat(village('543|551', [nobleAttack()], 0));
    expect(result.level).toBe('vai-cair');
    expect(result.detail).toBe(`1 nobre(s) chegando e defesa 0 abaixo de ${DEFAULT_THREAT_THRESHOLDS.nobleDangerPop}`);
  });

  it('nobre contra defesa abaixo do patamar → vai-cair; exatamente no patamar ainda segura o nobre', () => {
    const under = assessVillageThreat(village('543|551', [nobleAttack()], 11999));
    expect(under.level).toBe('vai-cair');

    const atLimit = assessVillageThreat(village('543|551', [nobleAttack()], 12000));
    expect(atLimit.level).toBe('resistente'); // < é estrito: 12.000 não é "abaixo"
  });

  it('ataque grande contra defesa fraca → vai-cair; no mínimo vira resistente', () => {
    const under = assessVillageThreat(village('543|551', [bigAttack(), fakeAttack()], 5999));
    expect(under.level).toBe('vai-cair');
    expect(under.detail).toBe('1 ataque(s) grande(s) e defesa 5999 abaixo de 6000');

    const atLimit = assessVillageThreat(village('543|551', [bigAttack()], 6000));
    expect(atLimit.level).toBe('resistente');
  });

  it('defesa fraca sem nobre nem grande → pressionada', () => {
    const result = assessVillageThreat(village('543|551', [fakeAttack(), fakeAttack()], 3000));
    expect(result.level).toBe('pressionada');
    expect(result.detail).toBe('2 ataque(s) e defesa 3000 abaixo de 6000');
  });

  it('defesa cheia com ataques → resistente e detail traz os números', () => {
    const result = assessVillageThreat(village('543|551', [bigAttack(), fakeAttack()], 18000));
    expect(result.level).toBe('resistente');
    expect(result.detail).toBe('defesa 18000 resiste a 2 ataque(s)');
  });
});

describe('assessVillageThreat — thresholds customizados', () => {
  it('defaults documentados são minResistPop 6000 / nobleDangerPop 12000', () => {
    expect(DEFAULT_THREAT_THRESHOLDS).toEqual({ minResistPop: 6000, nobleDangerPop: 12000 });
  });

  it('patamares mais altos reclassificam a mesma aldeia', () => {
    const input = village('543|551', [fakeAttack()], 8000);
    expect(assessVillageThreat(input).level).toBe('resistente');
    const stricter = { minResistPop: 10000, nobleDangerPop: 20000 };
    const result = assessVillageThreat(input, stricter);
    expect(result.level).toBe('pressionada');
    expect(result.detail).toBe('1 ataque(s) e defesa 8000 abaixo de 10000');
  });

  it('nobleDangerPop alto faz nobre contra pilha média cair para vai-cair', () => {
    const input = village('543|551', [nobleAttack()], 9000);
    expect(assessVillageThreat(input).level).toBe('vai-cair'); // default 12.000
    // Com patamar de nobre em 8.000, a pilha de 9.000 segura.
    expect(assessVillageThreat(input, { minResistPop: 6000, nobleDangerPop: 8000 }).level).toBe('resistente');
  });
});

describe('rankVillagesByThreat', () => {
  it('ordena por gravidade, depois nobres desc, ataques desc, coord — determinístico', () => {
    const ranked = rankVillagesByThreat([
      village('500|500', [attack()], 5000), // pressionada (sem nobre/grande)
      village('300|300', [attack()], undefined), // sem-dados
      village('100|100', [bigAttack()], 1000), // vai-cair por ataque grande
      village('400|400', [nobleAttack(), nobleAttack()], 11000), // vai-cair, 2 nobres (< 12000)
      village('200|200', [nobleAttack()], 9000), // vai-cair, 1 nobre
      village('350|350', [attack(), attack()], 3000), // pressionada, 2 ataques
      village('600|600', [], 12000), // resistente
    ]);

    expect(ranked.map((r) => `${r.coord}:${r.level}`)).toEqual([
      '400|400:vai-cair', // 2 nobres primeiro dentro do nível
      '200|200:vai-cair', // depois 1 nobre
      '100|100:vai-cair', // grande sem nobre por último no nível
      '350|350:pressionada', // mais ataques primeiro
      '500|500:pressionada',
      '600|600:resistente',
      '300|300:sem-dados',
    ]);
  });

  it('empate total dentro do nível resolve pela coordenada crescente', () => {
    const ranked = rankVillagesByThreat([
      village('999|999', [attack()], 9000),
      village('111|111', [row({ destination: { name: 'B', coord: '111|111' } })], 9000),
      village('555|555', [attack()], 9000),
    ]);
    expect(ranked.map((r) => r.coord)).toEqual(['111|111', '555|555', '999|999']);
  });

  it('ordena por nobleCount antes de attackCount dentro do mesmo nível', () => {
    const ranked = rankVillagesByThreat([
      village('444|444', [attack(), attack(), attack(), attack()], 9000), // 4 ataques, 0 nobre
      village('222|222', [nobleAttack()], 9000), // 1 ataque, 1 nobre
    ]);
    expect(ranked.map((r) => r.coord)).toEqual(['222|222', '444|444']);
  });
});

describe('threatSummary', () => {
  it('formato "X aldeia(s) em risco de cair · Y pressionadas · Z resistentes · W sem dados"', () => {
    const list = rankVillagesByThreat([
      village('100|100', [nobleAttack()], 1000),
      village('200|200', [bigAttack()], 1000),
      village('300|300', [attack()], 3000),
      village('400|400', [attack(), attack()], 3000),
      village('500|500', [attack()], 3000),
      village('600|600', [], 12000),
      village('700|700', [], 12000),
      village('800|800', [], 12000),
      village('900|900', [], 12000),
      village('650|650', [], 12000),
      village('110|110', [attack()]),
    ]);
    expect(threatSummary(list)).toBe(
      '2 aldeia(s) em risco de cair · 3 pressionadas · 5 resistentes · 1 sem dados',
    );
  });

  it('lista vazia: todos os segmentos zerados', () => {
    expect(threatSummary([])).toBe('0 aldeia(s) em risco de cair · 0 pressionadas · 0 resistentes · 0 sem dados');
  });
});
