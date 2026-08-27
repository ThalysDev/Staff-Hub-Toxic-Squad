import { describe, expect, it } from 'vitest';
import { attributeNoblesPerTarget, verifyPostOpLive, type PostOpLiveInput } from './post-op-live';

function makeInput(overrides?: Partial<PostOpLiveInput>): PostOpLiveInput {
  return {
    targets: [
      { coord: '100|100', senders: ['alice'], nobleCount: 2 },
      { coord: '200|200', senders: ['bob'], nobleCount: 3 },
      { coord: '300|300', senders: ['carol'], nobleCount: 1 },
      { coord: '400|400', senders: ['dave'], nobleCount: 0 },
    ],
    villages: [
      { coord: '100|100', playerId: 100, allyId: 50 }, // tribo própria
      { coord: '200|200', playerId: 2, allyId: 1 }, // inimiga declarada
      { coord: '300|300', playerId: 999, allyId: 99 }, // terceiro
      { coord: '400|400', playerId: 4, allyId: 1 }, // inimiga declarada (sem nobres)
    ],
    ownAllyId: 50,
    enemyAllyIds: new Set([1, 7]),
    ...overrides,
  };
}

describe('verifyPostOpLive', () => {
  it('classifica conquistado quando o dono atual é da tribo própria', () => {
    const result = verifyPostOpLive(makeInput());
    const c = result.outcomes.find((o) => o.coord === '100|100');
    expect(c?.status).toBe('conquistado');
    expect(c?.ownerAllyId).toBe(50);
    expect(c?.detail).toContain('conquista confirmada');
  });

  it('classifica defendido quando o dono atual é de inimiga declarada', () => {
    const result = verifyPostOpLive(makeInput());
    const d = result.outcomes.find((o) => o.coord === '200|200');
    expect(d?.status).toBe('defendido');
    expect(d?.detail).toContain('inimiga declarada');
  });

  it('classifica desperdiçado quando o dono atual é um terceiro', () => {
    const result = verifyPostOpLive(makeInput());
    const w = result.outcomes.find((o) => o.coord === '300|300');
    expect(w?.status).toBe('desperdiçado');
    expect(w?.detail).toContain('terceiros');
  });

  it('classifica aldeia bárbara (sem dono) como desperdiçada', () => {
    const input = makeInput({
      villages: [
        { coord: '100|100', playerId: 0, allyId: 0 },
        { coord: '200|200', playerId: 2, allyId: 1 },
        { coord: '300|300', playerId: 999, allyId: 99 },
        { coord: '400|400', playerId: 4, allyId: 1 },
      ],
    });
    const result = verifyPostOpLive(input);
    const w = result.outcomes.find((o) => o.coord === '100|100');
    expect(w?.status).toBe('desperdiçado');
    expect(w?.detail).toContain('bárbara');
  });

  it('classifica sem-dados quando a coordenada não existe no dump pós-OP', () => {
    const input = makeInput({
      targets: [{ coord: '999|999', senders: ['eve'], nobleCount: 1 }],
    });
    const result = verifyPostOpLive(input);
    expect(result.outcomes[0]?.status).toBe('sem-dados');
    expect(result.outcomes[0]?.ownerPlayerId).toBeNull();
    expect(result.outcomes[0]?.detail).toContain('pós-OP');
  });

  it('totais batem e conquestRate considera só alvos com dados', () => {
    const result = verifyPostOpLive(makeInput());
    expect(result.totals.conquistado).toBe(1);
    expect(result.totals.defendido).toBe(2);
    expect(result.totals.desperdiçado).toBe(1);
    expect(result.totals['sem-dados']).toBe(0);
    // 1 conquistado / 4 alvos com dados = 25%
    expect(result.totals.conquestRate).toBe(25);
  });

  it('wastedNobles soma nobres de alvos que não ficaram da tribo e ignora sem-dados', () => {
    const result = verifyPostOpLive(makeInput());
    // 3 (defendido) + 1 (desperdiçado) = 4; sem-dados não existe aqui
    expect(result.totals.wastedNobles).toBe(4);
    const onlyMissing = makeInput({
      targets: [{ coord: '999|999', senders: ['eve'], nobleCount: 7 }],
    });
    expect(verifyPostOpLive(onlyMissing).totals.wastedNobles).toBe(0);
  });

  it('conquestRate = 0 quando nenhum alvo tem dados', () => {
    // Dump existe, mas nenhum alvo aparece nele — todos ficam sem-dados.
    const result = verifyPostOpLive(makeInput({ villages: [{ coord: '500|500', playerId: 9, allyId: 9 }] }));
    expect(result.totals['sem-dados']).toBe(4);
    expect(result.totals.conquestRate).toBe(0);
    expect(result.totals.wastedNobles).toBe(0);
  });

  it('dump pós-OP vazio lança', () => {
    expect(() => verifyPostOpLive(makeInput({ villages: [] }))).toThrow(/PÓS-OP vazio/i);
  });

  it('nenhum alvo lança', () => {
    expect(() => verifyPostOpLive(makeInput({ targets: [] }))).toThrow(/Nenhum alvo/);
  });

  it('ordena por gravidade: desperdiçado, defendido, conquistado, sem-dados', () => {
    const input = makeInput({
      targets: [
        { coord: '100|100', senders: ['alice'], nobleCount: 0 },
        { coord: '200|200', senders: ['bob'], nobleCount: 0 },
        { coord: '300|300', senders: ['carol'], nobleCount: 0 },
        { coord: '400|400', senders: ['dave'], nobleCount: 0 },
        { coord: '999|999', senders: ['eve'], nobleCount: 0 },
      ],
      villages: [
        { coord: '100|100', playerId: 100, allyId: 50 },
        { coord: '200|200', playerId: 2, allyId: 1 },
        { coord: '300|300', playerId: 999, allyId: 99 },
        { coord: '400|400', playerId: 4, allyId: 1 },
      ],
    });
    const statuses = verifyPostOpLive(input).outcomes.map((o) => o.status);
    expect(statuses).toEqual(['desperdiçado', 'defendido', 'defendido', 'conquistado', 'sem-dados']);
  });
});

describe('attributeNoblesPerTarget', () => {
  it('atribui nobres ao alvo único do designado e isola quem tem 2+ alvos', () => {
    const result = attributeNoblesPerTarget(
      [
        { playerName: 'alice', coords: ['100|100'] },
        { playerName: 'bob', coords: ['200|200', '300|300'] },
      ],
      [
        { playerName: 'alice', nobleAttacks: 2 },
        { playerName: 'bob', nobleAttacks: 5 },
      ],
    );
    expect(result.byCoord.get('100|100')).toBe(2);
    expect(result.byCoord.has('200|200')).toBe(false);
    expect(result.unattributed).toBe(5);
  });

  it('nobre de jogador fora da distribuição e linhas repetidas não somem nem duplicam alvo', () => {
    const result = attributeNoblesPerTarget(
      [{ playerName: 'alice', coords: ['100|100'] }],
      [
        { playerName: 'fantasma', nobleAttacks: 3 },
        { playerName: 'alice', nobleAttacks: 1 },
        { playerName: 'alice', nobleAttacks: 2 },
      ],
    );
    expect(result.byCoord.get('100|100')).toBe(3);
    expect(result.unattributed).toBe(3);
  });
});
