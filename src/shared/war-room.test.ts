import { describe, expect, it } from 'vitest';
import type { OpArchiveEntry } from './ipc-types';
import { buildScorecard, parseDistribution, warRoomStatus } from './war-room';

describe('parseDistribution', () => {
  it('faz o parse de "nick;coord coord" com várias coordenadas por linha', () => {
    expect(parseDistribution('ana;100|100 200|200\nbruno;300|300')).toEqual([
      { playerName: 'ana', coords: ['100|100', '200|200'] },
      { playerName: 'bruno', coords: ['300|300'] },
    ]);
  });

  it('ignora linhas vazias (inclusive com espaço) e espaços sobrando nas coords', () => {
    expect(parseDistribution('  \n\nana;100|100   200|200  \n')).toEqual([
      { playerName: 'ana', coords: ['100|100', '200|200'] },
    ]);
  });

  it('linha inválida lança erro PT-BR citando a linha (fail-closed)', () => {
    for (const bad of ['só um nick sem ponto e vírgula', 'a;sem-coord', 'x;1|1']) {
      expect(() => parseDistribution(`ana;100|100\n${bad}`)).toThrowError(/Linha inválida/);
    }
    expect(() => parseDistribution('nick;abc|def')).toThrowError(/nick;abc\|def/);
  });

  it('texto vazio devolve lista vazia', () => {
    expect(parseDistribution('')).toEqual([]);
    expect(parseDistribution('\n   \n')).toEqual([]);
  });
});

describe('warRoomStatus', () => {
  const entries = [
    { playerName: 'ana', coords: ['100|100', '200|200', '300|300'] },
    { playerName: 'bruno', coords: ['400|400', '500|500', '600|600'] },
  ];

  it('caso completo: coveragePct exato e targetsWithoutCommand sem duplicar', () => {
    // ana enviou nos dois primeiros alvos dela; bruno não enviou nada;
    // 600|600 só recebeu comando de OUTRO jogador (carla);
    // bruno repete 300|300 (coord compartilhada) para provar deduplicação.
    const status = warRoomStatus(
      [
        ...entries,
        { playerName: 'bruno', coords: ['300|300'] },
        { playerName: 'carla', coords: ['700|700'] }, // alvo atribuído sem aldeia vigiada
      ],
      [
        { coord: '100|100', commands: [{ playerName: 'ana' }] },
        { coord: '200|200', commands: [{ playerName: 'ana' }, { playerName: 'carla' }] },
        { coord: '600|600', commands: [{ playerName: 'carla' }] },
        { coord: '900|900', commands: [{ playerName: 'zeca' }] }, // fora da distribuição
      ],
    );
    expect(status.perPlayer).toEqual([
      { playerName: 'ana', assigned: 3, sent: 2 },
      { playerName: 'bruno', assigned: 3, sent: 0 },
      { playerName: 'bruno', assigned: 1, sent: 0 },
      { playerName: 'carla', assigned: 1, sent: 0 }, // 700|700 nem existe em villages
    ]);
    // sent total = 2 de 8 atribuídos = 25%.
    expect(status.coveragePct).toBe(25);
    // Sem comando NENHUM: 300|300 (duplicada entra UMA vez), 400|400, 500|500
    // (aldeias ausentes) e 700|700 (alvo da carla sem aldeia vigiada).
    // 600|600 tem comando (de carla) → NÃO é carente. 900|900 não é alvo de
    // ninguém → ignorada (nunca aparece na saída).
    expect(status.targetsWithoutCommand).toEqual(['300|300', '400|400', '500|500', '700|700']);
  });

  it('alvo coberto apenas por OUTRO jogador NÃO conta como sent do dono', () => {
    const status = warRoomStatus(
      [{ playerName: 'dono', coords: ['10|10'] }],
      [{ coord: '10|10', commands: [{ playerName: 'outro' }] }],
    );
    expect(status.perPlayer).toEqual([{ playerName: 'dono', assigned: 1, sent: 0 }]);
    expect(status.coveragePct).toBe(0);
    // Tem comando na aldeia → não entra em targetsWithoutCommand.
    expect(status.targetsWithoutCommand).toEqual([]);
  });

  it('entries vazios → coveragePct 0, nunca NaN', () => {
    expect(warRoomStatus([], [])).toEqual({ coveragePct: 0, perPlayer: [], targetsWithoutCommand: [] });
    const status = warRoomStatus([{ playerName: 'ana', coords: [] }], []);
    expect(status.coveragePct).toBe(0);
    expect(Number.isNaN(status.coveragePct)).toBe(false);
    expect(status.perPlayer).toEqual([{ playerName: 'ana', assigned: 0, sent: 0 }]);
  });
});

describe('buildScorecard', () => {
  const opAntiga: OpArchiveEntry = {
    id: 'op-1',
    title: 'OP de janeiro',
    createdAt: '2026-01-10T20:00:00.000Z',
    targets: ['100|100', '200|200', '300|300'],
    distribution: 'ana;100|100 200|200\nbruno;300|300',
    // sem conference: conta só participação.
  };
  const opRecente: OpArchiveEntry = {
    id: 'op-2',
    title: 'OP de fevereiro',
    createdAt: '2026-02-15T20:00:00.000Z',
    targets: ['400|400'],
    distribution: 'ana;999|999', // distribution cita menos do que o snapshot arquivado…
    conference: {
      verifiedAt: '2026-02-16T02:00:00.000Z',
      coveragePct: 62.5,
      perPlayer: [
        { playerName: 'ana', assigned: 4, sent: 3 },
        { playerName: 'bruno', assigned: 2, sent: 2 },
        { playerName: 'álvaro', assigned: 1, sent: 1 },
      ],
      targetsWithoutCommand: ['400|400'],
    },
  };

  it('agrega participação + snapshot das duas OPs (snapshot vence a distribution)', () => {
    const scorecard = buildScorecard([opAntiga, opRecente]);
    const byName = new Map(scorecard.map((row) => [row.playerName, row]));
    // ana: participou das 2 OPs; números SOMA dos snapshots (4/3), não os 1 coord da distribution.
    expect(byName.get('ana')).toEqual({
      playerName: 'ana',
      opsParticipated: 2,
      expected: 4,
      sent: 3,
      missed: 1,
    });
    // bruno: só a distribution da OP antiga cita ele (participação), snapshot da recente soma números.
    expect(byName.get('bruno')).toMatchObject({ opsParticipated: 1, expected: 2, sent: 2, missed: 0 });
    // álvaro aparece só no perPlayer (sem linha na distribution) — número arquivado não se descarta.
    expect(byName.get('álvaro')).toMatchObject({ opsParticipated: 0, expected: 1, sent: 1, missed: 0 });
  });

  it('ordena por missed desc e, no empate, pelo nome em pt-BR', () => {
    const scorecard = buildScorecard([opRecente, opAntiga]); // fora de ordem cronológica
    expect(scorecard.map((row) => row.playerName)).toEqual(['ana', 'álvaro', 'bruno']);
  });

  it('nenhuma OP → scorecard vazio', () => {
    expect(buildScorecard([])).toEqual([]);
  });
});
