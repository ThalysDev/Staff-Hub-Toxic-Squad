import { describe, expect, it } from 'vitest';
import {
  auditSignals,
  AUDIT_SIGNAL_LABEL,
  DEFAULT_INACTIVE_ABS_DEF_POP,
  DEFAULT_INACTIVE_ABS_OFF_POP,
  DEFAULT_SHARP_DECLINE_OFF_POP,
  DEFAULT_SHARP_DECLINE_VILLAGES,
  formatAuditDiffTsv,
  formatPlayerTimelineTsv,
  playerTimeline,
  reconcileSelection,
  tribeTimeline,
} from './member-audit';
import type { TroopsDiffRow, TroopsHistoryVersion, TroopsPlayerAggregate } from './snapshot-history';
import { diffTroopsVersions } from './snapshot-history';

function player(
  playerId: number,
  playerName: string,
  villageCount: number,
  offPop: number,
  defPop: number,
): TroopsPlayerAggregate {
  return { playerId, playerName, villageCount, units: {}, offPop, defPop };
}

function version(id: string, collectedAt: string, players: TroopsPlayerAggregate[]): TroopsHistoryVersion {
  return { id, collectedAt, source: 'per-member', players };
}

function diffRow(playerName: string, overrides: Partial<TroopsDiffRow> = {}): TroopsDiffRow {
  return {
    playerName,
    offPopA: 0,
    offPopB: 0,
    offPopDelta: 0,
    defPopA: 0,
    defPopB: 0,
    defPopDelta: 0,
    villageCountA: 0,
    villageCountB: 0,
    villageCountDelta: 0,
    isNew: false,
    ...overrides,
  };
}

/**
 * Cenário canônico (v1→v4 ASC): ana cresce normal, bruno recruta maciço (+25000 off e
 * +3 aldeias em v3), carla despenca (-20000 off e -3 aldeias em v3), dora entra na v2,
 * eva fica plana (inativa) e fabi sai após a v2.
 */
function cenario(): TroopsHistoryVersion[] {
  return [
    version('v1', '2026-08-01T00:00:00.000Z', [
      player(1, 'ana', 10, 5000, 2000),
      player(2, 'bruno', 5, 10000, 3000),
      player(3, 'carla', 12, 30000, 10000),
      player(4, 'eva', 6, 4000, 1500),
      player(5, 'fabi', 7, 9000, 4000),
    ]),
    version('v2', '2026-08-08T00:00:00.000Z', [
      player(1, 'ana', 11, 6000, 2200),
      player(2, 'bruno', 5, 12000, 3000),
      player(3, 'carla', 12, 28000, 10000),
      player(6, 'dora', 1, 300, 100),
      player(4, 'eva', 6, 4000, 1500),
      player(5, 'fabi', 7, 9500, 4000),
    ]),
    version('v3', '2026-08-15T00:00:00.000Z', [
      player(1, 'ana', 12, 7000, 2400),
      player(2, 'bruno', 8, 37000, 3000),
      player(3, 'carla', 9, 8000, 10000),
      player(6, 'dora', 1, 300, 100),
      player(4, 'eva', 6, 4000, 1500),
    ]),
    version('v4', '2026-08-22T00:00:00.000Z', [
      player(1, 'ana', 13, 8000, 2600),
      player(2, 'bruno', 8, 40000, 3000),
      player(3, 'carla', 9, 8000, 10000),
      player(6, 'dora', 1, 300, 100),
      player(4, 'eva', 6, 4000, 1500),
    ]),
  ];
}

describe('tribeTimeline', () => {
  it('ordena por collectedAt ASC (primeira coleta primeiro) e soma os players da versão', () => {
    const [v1, v2, v3, v4] = cenario();
    const timeline = tribeTimeline([v3!, v1!, v4!, v2!]); // entra embaralhado de propósito
    expect(timeline.map((p) => p.versionId)).toEqual(['v1', 'v2', 'v3', 'v4']);
    expect(timeline[0]).toEqual({
      versionId: 'v1',
      collectedAt: '2026-08-01T00:00:00.000Z',
      players: 5,
      villages: 40,
      offPop: 58000,
      defPop: 20500,
    });
    expect(timeline[1]).toEqual({
      versionId: 'v2',
      collectedAt: '2026-08-08T00:00:00.000Z',
      players: 6,
      villages: 42,
      offPop: 59800,
      defPop: 20800,
    });
    expect(timeline[3]!.offPop).toBe(60300);
    expect(timeline[3]!.villages).toBe(37);
  });

  it('empate de collectedAt quebra por versionId (determinístico)', () => {
    const a = version('th-2', '2026-08-01T00:00:00.000Z', [player(1, 'ana', 1, 100, 50)]);
    const b = version('th-1', '2026-08-01T00:00:00.000Z', [player(2, 'bia', 2, 200, 60)]);
    expect(tribeTimeline([a, b]).map((p) => p.versionId)).toEqual(['th-1', 'th-2']);
  });

  it('fail-closed: lista vazia devolve linha do tempo vazia', () => {
    expect(tribeTimeline([])).toEqual([]);
  });

  it('não muta o array recebido (imutabilidade)', () => {
    const versions = cenario();
    const antes = JSON.stringify(versions);
    tribeTimeline([versions[2]!, versions[0]!]);
    expect(JSON.stringify(versions)).toBe(antes);
  });
});

describe('playerTimeline', () => {
  // Ciclo completo em 5 coletas: ausente → entrou → presente com deltas → saiu → saiu.
  const versions = [
    version('z1', '2026-08-01T00:00:00.000Z', [player(1, 'ana', 3, 1000, 500)]),
    version('z2', '2026-08-08T00:00:00.000Z', [
      player(1, 'ana', 3, 1000, 500),
      player(2, 'zeca', 1, 100, 50),
    ]),
    version('z3', '2026-08-15T00:00:00.000Z', [
      player(1, 'ana', 4, 1000, 500),
      player(2, 'zeca', 2, 300, 60),
    ]),
    version('z4', '2026-08-22T00:00:00.000Z', [player(1, 'ana', 4, 1000, 500)]),
    version('z5', '2026-08-29T00:00:00.000Z', [player(1, 'ana', 4, 1000, 500)]),
  ];

  it('cobre o ciclo completo: ausente → entrou → presente com deltas → saiu', () => {
    const timeline = playerTimeline(versions, 'zeca');
    expect(timeline.map((p) => p.situation)).toEqual(['ausente', 'entrou', 'presente', 'saiu', 'saiu']);
    expect(timeline.map((p) => p.versionId)).toEqual(['z1', 'z2', 'z3', 'z4', 'z5']);
  });

  it('ausente vale 0 e deltas nulos nas fronteiras (antes de entrar e depois de sair)', () => {
    const timeline = playerTimeline(versions, 'zeca');
    expect(timeline[0]).toMatchObject({ present: false, offPop: 0, defPop: 0, villageCount: 0 });
    expect(timeline[0]!.offPopDelta).toBeNull();
    expect(timeline[1]!.offPopDelta).toBeNull(); // anterior é ausente → sem delta
    expect(timeline[2]!.offPopDelta).toBe(200);
    expect(timeline[2]!.defPopDelta).toBe(10);
    expect(timeline[2]!.villageCountDelta).toBe(1);
    expect(timeline[3]!.offPopDelta).toBeNull(); // este ponto é ausente → sem delta
    expect(timeline[4]!.villageCountDelta).toBeNull();
    expect(timeline[3]!.present).toBe(false);
    expect(timeline[3]!.offPop).toBe(0);
  });

  it('matching por nome EXATO: variação de caixa não encontra o jogador', () => {
    const timeline = playerTimeline(versions, 'Zeca');
    expect(timeline.every((p) => !p.present && p.situation === 'ausente')).toBe(true);
  });

  it('jogador que nunca existiu devolve todos os pontos ausentes', () => {
    const timeline = playerTimeline(versions, 'fantasma');
    expect(timeline).toHaveLength(5);
    expect(timeline.every((p) => p.situation === 'ausente' && p.offPop === 0)).toBe(true);
  });

  it('crescimento constante no cenário canônico: bruno acumula +25000 off e +3 aldeias em v3', () => {
    const timeline = playerTimeline(cenario(), 'bruno');
    expect(timeline.map((p) => p.offPop)).toEqual([10000, 12000, 37000, 40000]);
    expect(timeline.map((p) => p.offPopDelta)).toEqual([null, 2000, 25000, 3000]);
    expect(timeline.map((p) => p.villageCountDelta)).toEqual([null, 0, 3, 0]);
  });

  it('fail-closed: lista vazia devolve ficha vazia', () => {
    expect(playerTimeline([], 'ana')).toEqual([]);
  });
});

describe('auditSignals', () => {
  it('cada sinal dispara para o jogador certo (cenário canônico via diff real)', () => {
    const [v1, , v3] = cenario();
    const rows = diffTroopsVersions(v1!, v3!);
    const signals = auditSignals(rows);
    const kindOf = (name: string) => signals.filter((s) => s.playerName === name).map((s) => s.kind);
    expect(kindOf('bruno')).toEqual(['massive-recruit']); // +25000 off e +3 aldeias
    expect(kindOf('carla')).toEqual(['sharp-decline']); // -22000 off e -3 aldeias
    expect(kindOf('dora')).toEqual(['joined']);
    expect(kindOf('fabi')).toEqual(['left']); // saiu da tribo — 'left' já explica; queda não duplica o sinal
    expect(kindOf('eva')).toEqual(['inactive']);
    expect(kindOf('ana')).toEqual([]); // crescimento normal não é sinal
  });

  it('joined acumula com massive-recruit; left NÃO duplica sharp-decline (anti-ruído)', () => {
    const rows = [
      diffRow('novo-gigante', { isNew: true, offPopB: 25000, offPopDelta: 25000, villageCountB: 1 }),
      diffRow('sumiu-queda', { offPopA: 20000, offPopDelta: -20000, villageCountA: 5, villageCountDelta: -5 }),
      diffRow('ficou-ferido', { offPopA: 40000, offPopB: 18000, offPopDelta: -22000, villageCountA: 9, villageCountB: 5, villageCountDelta: -4 }),
    ];
    expect(auditSignals(rows)).toEqual([
      { playerName: 'novo-gigante', kind: 'massive-recruit', offPopDelta: 25000, defPopDelta: 0, villageCountDelta: 0 },
      { playerName: 'ficou-ferido', kind: 'sharp-decline', offPopDelta: -22000, defPopDelta: 0, villageCountDelta: -4 },
      { playerName: 'novo-gigante', kind: 'joined', offPopDelta: 25000, defPopDelta: 0, villageCountDelta: 0 },
      { playerName: 'sumiu-queda', kind: 'left', offPopDelta: -20000, defPopDelta: 0, villageCountDelta: -5 },
    ]);
  });

  it('limiares inclusivos: exatamente no limite dispara (>= / <=)', () => {
    const rows = [
      diffRow('massa-off', { offPopB: 20000, offPopDelta: 20000 }),
      diffRow('massa-aldeias', { villageCountB: 3, villageCountDelta: 3 }),
      diffRow('queda-off', { offPopA: 30000, offPopB: 15000, offPopDelta: -15000 }),
      diffRow('queda-aldeias', { villageCountA: 4, villageCountB: 1, villageCountDelta: -3 }),
      diffRow('parado-500', { offPopB: 500, offPopDelta: 500 }),
      diffRow('parado-def-500', { offPopA: 1000, offPopB: 1000, defPopB: 500, defPopDelta: 500 }),
    ];
    const byName = (name: string) => auditSignals(rows).filter((s) => s.playerName === name).map((s) => s.kind);
    expect(byName('massa-off')).toEqual(['massive-recruit']);
    expect(byName('massa-aldeias')).toEqual(['massive-recruit']);
    expect(byName('queda-off')).toEqual(['sharp-decline']);
    expect(byName('queda-aldeias')).toEqual(['sharp-decline']);
    expect(byName('parado-500')).toEqual(['inactive']);
    expect(byName('parado-def-500')).toEqual(['inactive']);
    // Um abaixo do limite nada dispara:
    const fracos = auditSignals([
      diffRow('quase-massa', { offPopB: 19999, offPopDelta: 19999 }),
      diffRow('quase-queda', { offPopA: 15000, offPopB: 1, offPopDelta: -14999 }),
      diffRow('quase-inativo', { offPopB: 501, offPopDelta: 501 }),
    ]);
    expect(fracos).toEqual([]);
  });

  it('inactive NÃO dispara para joined/left; massive-recruit dispara para joined', () => {
    const rows = [
      diffRow('recem-chegado-parado', { isNew: true, offPopB: 100, offPopDelta: 100, villageCountB: 1 }),
      diffRow('saiu-parado', { offPopA: 100, offPopDelta: -100, villageCountA: 1, villageCountDelta: -1 }),
    ];
    const signals = auditSignals(rows);
    expect(signals.filter((s) => s.kind === 'inactive')).toEqual([]);
    expect(signals.map((s) => s.playerName + ':' + s.kind)).toEqual([
      'recem-chegado-parado:joined',
      'saiu-parado:left',
    ]);
  });

  it('ordena por kind na ordem do union type e depois por nome pt-BR', () => {
    const rows = [
      diffRow('zeda-inativa', { offPopA: 1000, offPopB: 1000, defPopB: 10, defPopDelta: 10 }),
      diffRow('bia-inativa', { offPopA: 1000, offPopB: 1000, defPopB: 10, defPopDelta: 10 }),
      diffRow('carla-saiu', { offPopA: 9000, offPopDelta: -9000, villageCountA: 2, villageCountDelta: -2 }),
      diffRow('ana-entrou', { isNew: true, offPopB: 300, offPopDelta: 300, villageCountB: 1, villageCountDelta: 1 }),
    ];
    const signals = auditSignals(rows);
    expect(signals.map((s) => s.kind + ':' + s.playerName)).toEqual([
      'joined:ana-entrou',
      'left:carla-saiu',
      'inactive:bia-inativa',
      'inactive:zeda-inativa',
    ]);
  });

  it('limiares customizados via opts (repassa minOffPopGrowth ao detectMassiveRecruitment)', () => {
    const rows = [diffRow('medio', { offPopB: 5000, offPopDelta: 5000 })];
    expect(auditSignals(rows)).toEqual([]);
    expect(auditSignals(rows, { minOffPopGrowth: 5000 }).map((s) => s.kind)).toEqual(['massive-recruit']);
    expect(
      auditSignals([diffRow('meia-queda', { offPopA: 4100, offPopB: 100, offPopDelta: -4000 })], { sharpDeclineOffPop: 4000 }).map(
        (s) => s.kind,
      ),
    ).toEqual(['sharp-decline']);
    expect(
      auditSignals([diffRow('meia-inativo', { offPopB: 900, offPopDelta: 900 })], { inactiveAbsOffPop: 900 }).map((s) => s.kind),
    ).toEqual(['inactive']);
  });

  it('fail-closed: diff vazio devolve vazio; defaults têm os valores documentados', () => {
    expect(auditSignals([])).toEqual([]);
    expect(DEFAULT_SHARP_DECLINE_OFF_POP).toBe(15000);
    expect(DEFAULT_SHARP_DECLINE_VILLAGES).toBe(3);
    expect(DEFAULT_INACTIVE_ABS_OFF_POP).toBe(500);
    expect(DEFAULT_INACTIVE_ABS_DEF_POP).toBe(500);
  });
});

describe('AUDIT_SIGNAL_LABEL', () => {
  it('rótulos PT-BR por tipo de sinal', () => {
    expect(AUDIT_SIGNAL_LABEL).toEqual({
      'massive-recruit': 'Recrutamento massivo',
      'sharp-decline': 'Queda acentuada',
      joined: 'Entrou na tribo',
      left: 'Saiu da tribo',
      inactive: 'Inativo no período',
    });
  });
});

describe('formatAuditDiffTsv', () => {
  it('header + linha exatamente como especificado (sem BOM, inteiros sem separador)', () => {
    const tsv = formatAuditDiffTsv([
      diffRow('ana', {
        offPopA: 5000,
        offPopB: 9000,
        offPopDelta: 4000,
        defPopA: 2000,
        defPopB: 3000,
        defPopDelta: 1000,
        villageCountA: 10,
        villageCountB: 12,
        villageCountDelta: 2,
      }),
    ]);
    expect(tsv).toBe(
      'Jogador\tPop Off A\tPop Off B\tΔ Pop Off\tPop Def A\tPop Def B\tΔ Pop Def\tAldeias A\tAldeias B\tΔ Aldeias\tNovo\n' +
        'ana\t5000\t9000\t4000\t2000\t3000\t1000\t10\t12\t2\tnão',
    );
    expect(tsv.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('novo jogador marca sim e diff vazio devolve só o header', () => {
    const tsv = formatAuditDiffTsv([diffRow('dora', { isNew: true, offPopB: 300, offPopDelta: 300, villageCountB: 1, villageCountDelta: 1 })]);
    expect(tsv.endsWith('dora\t0\t300\t300\t0\t0\t0\t0\t1\t1\tsim')).toBe(true);
    expect(formatAuditDiffTsv([])).toBe(
      'Jogador\tPop Off A\tPop Off B\tΔ Pop Off\tPop Def A\tPop Def B\tΔ Pop Def\tAldeias A\tAldeias B\tΔ Aldeias\tNovo',
    );
  });
});

describe('formatPlayerTimelineTsv', () => {
  it('header + linhas da ficha exatamente como especificado (delta nulo vira vazio, assinado +/−)', () => {
    const zeca = [
      version('z1', '2026-08-01T00:00:00.000Z', [player(1, 'ana', 3, 1000, 500)]),
      version('z2', '2026-08-08T00:00:00.000Z', [player(1, 'ana', 3, 1000, 500), player(2, 'zeca', 1, 100, 50)]),
      version('z3', '2026-08-15T00:00:00.000Z', [player(1, 'ana', 4, 1000, 500), player(2, 'zeca', 2, 300, 60)]),
    ];
    const tsv = formatPlayerTimelineTsv(playerTimeline(zeca, 'zeca'));
    expect(tsv).toBe(
      'Data\tSituação\tPop Off\tΔ Pop Off\tPop Def\tΔ Pop Def\tAldeias\tΔ Aldeias\n' +
        '2026-08-01T00:00:00.000Z\tausente\t0\t\t0\t\t0\t\n' +
        '2026-08-08T00:00:00.000Z\tentrou\t100\t\t50\t\t1\t\n' +
        '2026-08-15T00:00:00.000Z\tpresente\t300\t+200\t60\t+10\t2\t+1',
    );
  });

  it('ficha vazia devolve só o header', () => {
    expect(formatPlayerTimelineTsv([])).toBe('Data\tSituação\tPop Off\tΔ Pop Off\tPop Def\tΔ Pop Def\tAldeias\tΔ Aldeias');
  });
});

describe('reconcileSelection', () => {
  const vers = (id: string): TroopsHistoryVersion => ({ id, collectedAt: `2026-09-0${id.slice(-1)}T00:00:00Z`, source: 'per-member', players: [] });

  it('lista vazia: seleção vazia', () => {
    expect(reconcileSelection([], 'a', 'b')).toEqual({ aId: '', bId: '' });
  });

  it('primeira carga: B = mais recente (índice 0), A = penúltima (índice 1)', () => {
    expect(reconcileSelection([vers('v3'), vers('v2'), vers('v1')], '', '')).toEqual({ aId: 'v2', bId: 'v3' });
  });

  it('ids sobreviventes são mantidos (refresh não mexe na escolha do líder)', () => {
    expect(reconcileSelection([vers('v3'), vers('v1')], 'v1', 'v3')).toEqual({ aId: 'v1', bId: 'v3' });
  });

  it('id sumido (remoção/rotação do cap): default re-aplicado só para ele', () => {
    expect(reconcileSelection([vers('v2'), vers('v1')], 'v9', 'v2')).toEqual({ aId: 'v1', bId: 'v2' });
  });

  it('uma única versão: só B; A fica vazia (não há par para comparar)', () => {
    expect(reconcileSelection([vers('v1')], '', '')).toEqual({ aId: '', bId: 'v1' });
    expect(reconcileSelection([vers('v1')], 'v1', 'v1')).toEqual({ aId: '', bId: 'v1' });
  });
});

describe('formatAuditDiffTsv — delta negativo', () => {
  it('queda sai com sinal "-" ASCII (planilha-friendly), não ±0', () => {
    const row: TroopsDiffRow = {
      playerName: 'caiu', offPopA: 5000, offPopB: 3000, offPopDelta: -2000,
      defPopA: 100, defPopB: 100, defPopDelta: 0,
      villageCountA: 4, villageCountB: 2, villageCountDelta: -2, isNew: false,
    };
    const line = formatAuditDiffTsv([row]).split('\n')[1] ?? '';
    expect(line).toBe('caiu\t5000\t3000\t-2000\t100\t100\t0\t4\t2\t-2\tnão');
  });
});

describe('reconcileSelection — remoção da versão B (P3 revisão 2)', () => {
  const vers = (id: string): TroopsHistoryVersion => ({ id, collectedAt: `2026-09-0${id.slice(-1)}T00:00:00Z`, source: 'per-member', players: [] });

  it('B removido e antigo A promovido a mais recente: A cai para a outra versão (nunca fantasma)', () => {
    // load anterior: A=v2, B=v3; v3 removida → lista [v2, v1];
    // fallback de B = list[0] = v2 (o antigo A) → A deve recair em v1.
    expect(reconcileSelection([vers('v2'), vers('v1')], 'v2', 'v3')).toEqual({ aId: 'v1', bId: 'v2' });
  });

  it('lista com 1 versão: A continua vazia (não há par)', () => {
    expect(reconcileSelection([vers('v1')], 'v1', 'v1')).toEqual({ aId: '', bId: 'v1' });
  });
});
