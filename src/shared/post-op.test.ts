import { describe, expect, it } from 'vitest';
import { verifyPostOp, type PostOpInput } from './post-op';

function makeInput(overrides?: Partial<PostOpInput>): PostOpInput {
  const ownPlayerIds = new Set([100, 101, 102]);
  return {
    before: [
      { coord: '100|100', playerId: 1, allyId: 1 },
      { coord: '200|200', playerId: 2, allyId: 1 },
      { coord: '300|300', playerId: 3, allyId: 1 },
      { coord: '400|400', playerId: 4, allyId: 1 },
    ],
    after: [
      { coord: '100|100', playerId: 100, allyId: 50 }, // conquistado (ally)
      { coord: '200|200', playerId: 2, allyId: 1 },      // não mudou
      { coord: '300|300', playerId: 999, allyId: 99 },   // mudou para outro
      { coord: '400|400', playerId: 4, allyId: 1 },      // não mudou
    ],
    targets: [
      { coord: '100|100', senders: ['alice'], nobleCount: 2 },
      { coord: '200|200', senders: ['bob'], nobleCount: 3 },
      { coord: '300|300', senders: ['carol'], nobleCount: 1 },
      { coord: '400|400', senders: ['dave'], nobleCount: 0 },
    ],
    ownAllyId: 50,
    ownPlayerIds,
    ...overrides,
  };
}

describe('verifyPostOp', () => {
  it('classifica conquistado quando dono muda para jogador da tribo', () => {
    const result = verifyPostOp(makeInput());
    const c = result.outcomes.find((o) => o.coord === '100|100');
    expect(c?.status).toBe('conquistado');
    expect(c?.conqueredByAlly).toBe(true);
    expect(c?.detail).toContain('jogador da tribo');
  });

  it('classifica desperdiçado quando dono não muda e houve nobres', () => {
    const result = verifyPostOp(makeInput());
    const w = result.outcomes.find((o) => o.coord === '200|200');
    expect(w?.status).toBe('desperdiçado');
    expect(w?.detail).toContain('3 nobre(s) desperdiçado(s)');
  });

  it('classifica desperdiçado quando dono muda para FORA da tribo', () => {
    const result = verifyPostOp(makeInput());
    const o = result.outcomes.find((r) => r.coord === '300|300');
    expect(o?.status).toBe('desperdiçado');
    expect(o?.detail).toContain('FORA da tribo');
  });

  it('classifica defendido quando dono não muda e não houve nobres', () => {
    const result = verifyPostOp(makeInput());
    const d = result.outcomes.find((o) => o.coord === '400|400');
    expect(d?.status).toBe('defendido');
    expect(d?.detail).toContain('sem nobres');
  });

  it('classifica sem-dados quando alvo não existe no dump pós-OP', () => {
    const input = makeInput({
      targets: [{ coord: '999|999', senders: ['eve'], nobleCount: 1 }],
    });
    const result = verifyPostOp(input);
    expect(result.outcomes[0]?.status).toBe('sem-dados');
    expect(result.outcomes[0]?.detail).toContain('pré-OP');
  });

  it('totais batem e conquestRate é proporção correta', () => {
    const result = verifyPostOp(makeInput());
    expect(result.totals.conquistado).toBe(1);
    expect(result.totals.desperdiçado).toBe(2);
    expect(result.totals.defendido).toBe(1);
    expect(result.totals.wastedNobles).toBe(4); // 3+1 nobres desperdiçados
    // 1 conquistado / (1+2) tentativas = 33%
    expect(result.totals.conquestRate).toBe(33);
  });

  it('conquestRate = 0 quando nenhuma conquista', () => {
    const input = makeInput({
      after: [
        { coord: '100|100', playerId: 1, allyId: 1 },
        { coord: '200|200', playerId: 2, allyId: 1 },
        { coord: '300|300', playerId: 3, allyId: 1 },
        { coord: '400|400', playerId: 4, allyId: 1 },
      ],
    });
    const result = verifyPostOp(input);
    expect(result.totals.conquestRate).toBe(0);
  });

  it('ordena por gravidade: desperdiçado primeiro', () => {
    const result = verifyPostOp(makeInput());
    expect(result.outcomes[0]?.status).toBe('desperdiçado');
  });

  it('dump pré-OP vazio lança', () => {
    expect(() => verifyPostOp(makeInput({ before: [] }))).toThrow(/PRÉ-OP vazio/i);
  });

  it('dump pós-OP vazio lança', () => {
    expect(() => verifyPostOp(makeInput({ after: [] }))).toThrow(/PÓS-OP vazio/i);
  });

  it('nenhum alvo lança', () => {
    expect(() => verifyPostOp(makeInput({ targets: [] }))).toThrow(/Nenhum alvo/);
  });
});
