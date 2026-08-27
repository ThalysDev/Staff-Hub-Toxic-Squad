import { describe, expect, it } from 'vitest';
import {
  MAX_BLIND_DEBT_PLAYERS,
  type BlindDebtEntry,
  type BlindDebtRoundEntry,
  blindBalance,
  mergeBlindDebtRound,
} from './blind-debt';

const NOW = new Date('2026-08-26T12:00:00.000Z');
const OLD_TS = '2026-08-01T00:00:00.000Z';

function entry(playerName: string, requested: number, sent: number, updatedAt: string = OLD_TS): BlindDebtEntry {
  return { playerName, requested, sent, updatedAt };
}

function fullList(size: number): BlindDebtEntry[] {
  const list: BlindDebtEntry[] = [];
  for (let i = 0; i < size; i++) list.push(entry(`jogador-${i}`, i, 0));
  return list;
}

describe('mergeBlindDebtRound (mesclagem por playerName trim)', () => {
  it('rodada em lista vazia cria a entrada acumulada com updatedAt injetado', () => {
    const next = mergeBlindDebtRound([], [{ playerName: 'Ana', requested: 10, sent: 4 }], NOW);
    expect(next).toEqual([{ playerName: 'Ana', requested: 10, sent: 4, updatedAt: NOW.toISOString() }]);
  });

  it('mesclagens sucessivas ACUMULAM pedido e enviado do mesmo jogador', () => {
    const first = mergeBlindDebtRound([], [{ playerName: 'Ana', requested: 10, sent: 4 }], NOW);
    const second = mergeBlindDebtRound(first, [{ playerName: 'Ana', requested: 3, sent: 2 }], NOW);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ playerName: 'Ana', requested: 13, sent: 6 });
  });

  it('trim colide DE PROPÓSITO: " Ana " e "Ana" na MESMA rodada somam em uma entrada única', () => {
    const round: BlindDebtRoundEntry[] = [
      { playerName: ' Ana ', requested: 10, sent: 4 },
      { playerName: 'Ana', requested: 3, sent: 1 },
    ];
    const next = mergeBlindDebtRound([], round, NOW);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ playerName: 'Ana', requested: 13, sent: 5 });
  });

  it('trim colide com o acumulado: "  Ana " atualiza a entrada "Ana" já existente', () => {
    const current = [entry('Ana', 5, 5)];
    const next = mergeBlindDebtRound(current, [{ playerName: '  Ana ', requested: 2, sent: 0 }], NOW);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ playerName: 'Ana', requested: 7, sent: 5 });
  });

  it('maiúsculas/minúsculas são SIGNIFICATIVAS: "ana" e "Ana" são jogadores distintos', () => {
    const next = mergeBlindDebtRound(
      [entry('Ana', 5, 5)],
      [{ playerName: 'ana', requested: 1, sent: 0 }],
      NOW,
    );
    expect(next).toHaveLength(2);
    expect(next.map((item) => item.playerName).sort()).toEqual(['Ana', 'ana']);
  });

  it('jogadores não tocados preservam requested/sent e o updatedAt antigo', () => {
    const current = [entry('Ana', 10, 4), entry('Beto', 8, 8)];
    const next = mergeBlindDebtRound(current, [{ playerName: 'Ana', requested: 1, sent: 0 }], NOW);
    const beto = next.find((item) => item.playerName === 'Beto');
    expect(beto).toEqual({ playerName: 'Beto', requested: 8, sent: 8, updatedAt: OLD_TS });
    expect(next.find((item) => item.playerName === 'Ana')?.updatedAt).toBe(NOW.toISOString());
  });

  it('rodada vazia é no-op válido: devolve cópia ordenada sem tocar ninguém', () => {
    const current = [entry('Beto', 9, 0), entry('Ana', 9, 0)];
    const next = mergeBlindDebtRound(current, [], NOW);
    expect(next.map((item) => item.playerName)).toEqual(['Ana', 'Beto']);
    expect(next.every((item) => item.updatedAt === OLD_TS)).toBe(true);
    expect(next).not.toBe(current);
  });

  it('não muta os inputs: lista atual, objetos antigos e rodada seguem iguais', () => {
    const current = [entry('Ana', 10, 4)];
    const round: BlindDebtRoundEntry[] = [{ playerName: ' Ana ', requested: 3, sent: 1 }];
    mergeBlindDebtRound(current, round, NOW);
    expect(current).toEqual([{ playerName: 'Ana', requested: 10, sent: 4, updatedAt: OLD_TS }]);
    expect(round).toEqual([{ playerName: ' Ana ', requested: 3, sent: 1 }]);
  });
});

describe('mergeBlindDebtRound (ordenação por saldo)', () => {
  it('ordena por saldo DESC: maior devedor primeiro, credor no fim', () => {
    const round: BlindDebtRoundEntry[] = [
      { playerName: 'Credor', requested: 2, sent: 9 },
      { playerName: 'Devedor', requested: 10, sent: 2 },
      { playerName: 'Quite', requested: 5, sent: 5 },
    ];
    const next = mergeBlindDebtRound([], round, NOW);
    expect(next.map((item) => item.playerName)).toEqual(['Devedor', 'Quite', 'Credor']);
  });

  it('empate de saldo ordena por nome em pt-BR (Ana antes de Beto)', () => {
    const round: BlindDebtRoundEntry[] = [
      { playerName: 'Beto', requested: 10, sent: 5 },
      { playerName: 'Ana', requested: 5, sent: 0 },
    ];
    const next = mergeBlindDebtRound([], round, NOW);
    expect(next.map((item) => item.playerName)).toEqual(['Ana', 'Beto']);
    expect(next.map(blindBalance)).toEqual([5, 5]);
  });
});

describe('mergeBlindDebtRound (cap de jogadores)', () => {
  it('cap 200: mesclar o 201º jogador NOVO lança erro PT-BR citando o limite e o jogador', () => {
    const current = fullList(MAX_BLIND_DEBT_PLAYERS);
    expect(() => mergeBlindDebtRound(current, [{ playerName: 'Novato', requested: 1, sent: 0 }], NOW)).toThrow(
      new RegExp(`Lista de débito de blind cheia — limite de ${MAX_BLIND_DEBT_PLAYERS} jogadores.*"Novato"`),
    );
  });

  it('cap 200: ATUALIZAR jogador existente com a lista cheia passa sem erro', () => {
    const current = fullList(MAX_BLIND_DEBT_PLAYERS);
    const next = mergeBlindDebtRound(current, [{ playerName: 'jogador-100', requested: 4, sent: 1 }], NOW);
    expect(next).toHaveLength(MAX_BLIND_DEBT_PLAYERS);
    expect(next.find((item) => item.playerName === 'jogador-100')).toMatchObject({ requested: 104, sent: 1 });
  });

  it('cap 200: preencher até o teto exato com o último jogador novo passa', () => {
    const current = fullList(MAX_BLIND_DEBT_PLAYERS - 1);
    const next = mergeBlindDebtRound(current, [{ playerName: 'Ultimo', requested: 1, sent: 0 }], NOW);
    expect(next).toHaveLength(MAX_BLIND_DEBT_PLAYERS);
  });
});

describe('mergeBlindDebtRound (validação fail-closed)', () => {
  it('nome vazio ou só espaços lança erro PT-BR citando a posição na rodada', () => {
    const round: BlindDebtRoundEntry[] = [
      { playerName: 'Ana', requested: 1, sent: 0 },
      { playerName: '   ', requested: 1, sent: 0 },
    ];
    expect(() => mergeBlindDebtRound([], round, NOW)).toThrow(
      /Nome do jogador inválido na rodada de blind \(posição 2\) — informe entre 1 e 40 caracteres/,
    );
  });

  it('nome acima de 40 caracteres lança; o limite exato de 40 passa', () => {
    const longo = 'n'.repeat(41);
    expect(() => mergeBlindDebtRound([], [{ playerName: longo, requested: 1, sent: 0 }], NOW)).toThrow(
      /informe entre 1 e 40 caracteres/,
    );
    const exato = mergeBlindDebtRound([], [{ playerName: 'n'.repeat(40), requested: 1, sent: 0 }], NOW);
    expect(exato[0]!.playerName).toHaveLength(40);
  });

  it('requested negativo lança erro PT-BR citando o jogador', () => {
    expect(() => mergeBlindDebtRound([], [{ playerName: 'Ana', requested: -1, sent: 0 }], NOW)).toThrow(
      /Valores inválidos na rodada de blind para o jogador "Ana"/,
    );
  });

  it('sent NaN ou infinito lança erro PT-BR citando o jogador', () => {
    expect(() => mergeBlindDebtRound([], [{ playerName: 'Beto', requested: 1, sent: Number.NaN }], NOW)).toThrow(
      /para o jogador "Beto".*maiores ou iguais a zero/,
    );
    expect(() =>
      mergeBlindDebtRound([], [{ playerName: 'Beto', requested: Number.POSITIVE_INFINITY, sent: 0 }], NOW),
    ).toThrow(/para o jogador "Beto"/);
  });

  it('validação acontece ANTES da mesclagem: entrada inválida no fim não grava as anteriores', () => {
    const current = [entry('Ana', 10, 4)];
    const round: BlindDebtRoundEntry[] = [
      { playerName: 'Ana', requested: 5, sent: 5 },
      { playerName: 'Quebrado', requested: 1, sent: -7 },
    ];
    expect(() => mergeBlindDebtRound(current, round, NOW)).toThrow(/"Quebrado"/);
    expect(current[0]).toMatchObject({ requested: 10, sent: 4 }); // base intacta
  });
});

describe('blindBalance', () => {
  it('saldo positivo = deve blind; negativo = credor; zero = quite', () => {
    expect(blindBalance(entry('Devedor', 10, 4))).toBe(6);
    expect(blindBalance(entry('Credor', 2, 9))).toBe(-7);
    expect(blindBalance(entry('Quite', 5, 5))).toBe(0);
  });

  it('constante do teto documentada em 200 jogadores', () => {
    expect(MAX_BLIND_DEBT_PLAYERS).toBe(200);
  });
});
