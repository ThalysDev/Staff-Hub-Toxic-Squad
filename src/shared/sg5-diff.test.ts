import { describe, expect, it } from 'vitest';
import { diffConferences, type ConferenceSnapshot, type ConferenceVillage } from './sg5-diff';

function command(commandId: number, playerName: string, hasNoble = false, sizeHint: string | null = null) {
  return { playerName, commandId, hasNoble, sizeHint };
}

function village(coord: string, commands: ConferenceSnapshot['villages'][number]['commands']): ConferenceVillage {
  return { coord, commands };
}

const AT = '2026-08-26T10:00:00.000Z';

function snapshot(villages: ConferenceVillage[], generatedAt = AT): ConferenceSnapshot {
  return { villages, generatedAt };
}

describe('diffConferences', () => {
  it('comando novo e cancelado por commandId', () => {
    const previous = snapshot([
      village('450|450', [command(101, 'alfa'), command(102, 'bravo')]),
    ]);
    const current = snapshot([
      village('450|450', [command(101, 'alfa'), command(103, 'carol')]),
    ]);
    const diff = diffConferences(previous, current);
    expect(diff.newCommands).toEqual([
      { coord: '450|450', playerName: 'carol', commandId: 103, hasNoble: false },
    ]);
    expect(diff.cancelledCommands).toEqual([{ coord: '450|450', playerName: 'bravo', commandId: 102 }]);
    expect(diff.coverageDelta).toEqual([]); // saiu um e entrou outro: cobertura igual
  });

  it('identidade estável: mudar nobre/nick no MESMO commandId não gera diff de comandos', () => {
    const previous = snapshot([village('450|450', [command(101, 'alfa', false)])]);
    const current = snapshot([village('450|450', [command(101, 'alfa', true, null)])]);
    const diff = diffConferences(previous, current);
    expect(diff.newCommands).toEqual([]);
    expect(diff.cancelledCommands).toEqual([]);
    expect(diff.newTargets).toEqual([]);
    expect(diff.lostTargets).toEqual([]);
    expect(diff.coverageDelta).toEqual([]);
  });

  it('alvo que apareceu e alvo que sumiu', () => {
    const previous = snapshot([
      village('400|400', [command(201, 'alfa')]),
      village('420|420', []), // vila capturada sem comandos não conta como alvo
    ]);
    const current = snapshot([
      village('420|420', []),
      village('410|410', [command(301, 'bravo')]),
    ]);
    const diff = diffConferences(previous, current);
    expect(diff.newTargets).toEqual(['410|410']);
    expect(diff.lostTargets).toEqual(['400|400']);
    expect(diff.cancelledCommands).toEqual([{ coord: '400|400', playerName: 'alfa', commandId: 201 }]);
    expect(diff.newCommands).toEqual([{ coord: '410|410', playerName: 'bravo', commandId: 301, hasNoble: false }]);
  });

  it('coverageDelta positivo e negativo (só onde mudou)', () => {
    const previous = snapshot([
      village('410|410', [command(1, 'alfa')]),
      village('430|430', [command(2, 'bravo'), command(3, 'bravo')]),
      village('450|450', [command(4, 'carol')]), // inalterado
    ]);
    const current = snapshot([
      village('410|410', [command(5, 'alfa'), command(6, 'alfa'), command(7, 'alfa')]),
      village('430|430', [command(8, 'bravo')]),
      village('450|450', [command(4, 'carol')]),
    ]);
    expect(diffConferences(previous, current).coverageDelta).toEqual([
      { coord: '410|410', before: 1, after: 3 },
      { coord: '430|430', before: 2, after: 1 },
    ]);
  });

  it('snapshots idênticos → diff totalmente vazio', () => {
    const snap = snapshot([
      village('450|450', [command(101, 'alfa', true, 'grande'), command(102, 'bravo', false, 'pequeno')]),
      village('451|449', []),
    ]);
    expect(diffConferences(snap, snap)).toEqual({
      newCommands: [],
      cancelledCommands: [],
      newTargets: [],
      lostTargets: [],
      coverageDelta: [],
    });
  });

  it('saída ordenada por coord, independente da ordem das vilas nos snapshots', () => {
    const previous = snapshot([
      village('500|500', [command(11, 'alfa')]),
      village('300|300', [command(12, 'bravo')]),
    ]);
    const current = snapshot([village('300|300', []), village('500|500', [])]);
    const diff = diffConferences(previous, current);
    expect(diff.cancelledCommands.map((c) => c.coord)).toEqual(['300|300', '500|500']);
    expect(diff.lostTargets).toEqual(['300|300', '500|500']);
  });

  it('fail-closed: villages ausentes/malformados em QUALQUER rodada lançam PT-BR', () => {
    const ok = snapshot([village('450|450', [command(101, 'alfa')])]);
    const semVillages = { generatedAt: AT } as unknown as ConferenceSnapshot;
    expect(() => diffConferences(semVillages, ok)).toThrow(/anterior/);
    expect(() => diffConferences(ok, semVillages)).toThrow(/atual/);
    expect(() => diffConferences(null as unknown as ConferenceSnapshot, ok)).toThrow(/anterior/i);
    expect(() =>
      diffConferences(snapshot([village('abc', [])]) , ok),
    ).toThrow(/coordenada inválida/i);
    expect(() =>
      diffConferences(
        snapshot([village('450|450', [command(0, 'alfa')])]),
        ok,
      ),
    ).toThrow(/commandId inválido/i);
    expect(() =>
      diffConferences(ok, snapshot([village('450|450', [{} as never])])),
    ).toThrow(/commandId inválido/i);
    expect(() => diffConferences({ ...ok, generatedAt: 'ontem' }, ok)).toThrow(/generatedAt/i);
  });

  it('fail-closed: coord ou commandId repetidos dentro do mesmo snapshot lançam', () => {
    const ok = snapshot([]);
    const dupCoord = snapshot([
      village('450|450', [command(101, 'alfa')]),
      village('450|450', [command(102, 'bravo')]),
    ]);
    expect(() => diffConferences(dupCoord, ok)).toThrow(/repetido/i);
    const dupCommand = snapshot([
      village('450|450', [command(101, 'alfa')]),
      village('451|449', [command(101, 'bravo')]),
    ]);
    expect(() => diffConferences(dupCommand, ok)).toThrow(/duplicado/i);
  });
});
