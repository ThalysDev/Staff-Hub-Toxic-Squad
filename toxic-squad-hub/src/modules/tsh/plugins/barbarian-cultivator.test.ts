import { describe, expect, it } from 'vitest';
import {
  buildMapperTargetList,
  normalizeMapperConfig,
  type ScoredTarget,
} from '../../../ext/modules/features/auto-farm/barbarian-mapper';
import {
  autoFarmTargetsKey,
  barbarianCultivationStatusMessage,
  barbarianCultivatorSettingsSchema,
  createBarbarianCultivatorLedger,
  cultivationAttempts,
  cultivatorMapperNote,
  isCultivationTargetCoolingDown,
  planBarbarianCultivation,
  readCultivatorMapperIndex,
  recordBarbarianCultivation,
  selectBarbarianCultivationExecution,
  type BarbarianCultivatorTarget,
} from './barbarian-cultivator';

const NOW = Date.parse('2026-09-23T12:00:00.000Z');

function target(overrides: Partial<BarbarianCultivatorTarget> = {}): BarbarianCultivatorTarget {
  return {
    id: 'alvo-1',
    x: 503,
    y: 504,
    points: 1200,
    barbarian: true,
    ...overrides,
  };
}

function mapperList(lastScoutedAt: number | null, overrides: Partial<ScoredTarget> = {}) {
  const scored: ScoredTarget = {
    id: 102,
    x: 503,
    y: 504,
    points: 500,
    ownerId: 0,
    score: 500,
    distanceFields: 3,
    lastScoutedAt,
    ...overrides,
  };
  return buildMapperTargetList({
    generatedAt: new Date(NOW).toISOString(),
    origin: { x: 500, y: 500 },
    originSource: 'aldeia aberta',
    config: normalizeMapperConfig({ updateMode: 'horas', updateValue: 6 }),
    targets: [scored],
  });
}

describe('planejador puro do Cultivador de Bárbaras', () => {
  it('escolhe o primeiro alvo bárbaro e o primeiro edifício não protegido', () => {
    const decision = planBarbarianCultivation(
      barbarianCultivatorSettingsSchema.parse({ catapultsPerWave: 25 }),
      [target({ id: 'alvo-1' }), target({ id: 'alvo-2' })],
      30,
    );

    expect(decision).toEqual({ kind: 'PLAN', targetId: 'alvo-1', building: 'main', catapult: 25 });
  });

  it('ignora alvos que não são bárbaros', () => {
    const decision = planBarbarianCultivation(
      barbarianCultivatorSettingsSchema.parse({}),
      [target({ id: 'de-jogador', barbarian: false })],
      100,
    );

    expect(decision).toEqual({ kind: 'NO_WORK', reason: 'Nenhuma construção bárbara está elegível para cultivo.' });
  });

  it('sem edifício elegível (tudo protegido) devolve NO_WORK da origem', () => {
    const protegidos = ['main', 'barracks', 'stable', 'market', 'wood', 'stone', 'iron', 'farm', 'storage'];
    const decision = planBarbarianCultivation(
      barbarianCultivatorSettingsSchema.parse({ protectedBuildings: protegidos }),
      [target()],
      100,
    );

    expect(decision).toEqual({ kind: 'NO_WORK', reason: 'Nenhuma construção bárbara está elegível para cultivo.' });
  });

  it('catapultas insuficientes bloqueiam a prévia', () => {
    const decision = planBarbarianCultivation(barbarianCultivatorSettingsSchema.parse({}), [target()], 10);

    expect(decision).toEqual({ kind: 'NO_WORK', reason: 'Nenhuma construção bárbara está elegível para cultivo.' });
  });
});

describe('modo e cooldown do Cultivador (Onda 4)', () => {
  it('default é prévia com cooldown de 60 min; valores estranhos caem no default', () => {
    const defaults = barbarianCultivatorSettingsSchema.parse({});

    expect(defaults.mode).toBe('preview');
    expect(defaults.cooldownMinutes).toBe(60);
    expect(barbarianCultivatorSettingsSchema.parse({ mode: 'atacar', cooldownMinutes: 0 }).mode).toBe('preview');
    expect(barbarianCultivatorSettingsSchema.parse({ cooldownMinutes: 0 }).cooldownMinutes).toBe(60);
    expect(barbarianCultivatorSettingsSchema.parse({ mode: 'executar', cooldownMinutes: 120 }).cooldownMinutes).toBe(120);
  });
});

describe('livro-razão do Cultivador', () => {
  it('acumula ondas por coordenada e é fail-closed com carimbo inválido', () => {
    const first = recordBarbarianCultivation(createBarbarianCultivatorLedger(), '503|504', NOW, 'a');
    const second = recordBarbarianCultivation(first, '503|504', NOW + 60_000, 'b');

    expect(cultivationAttempts(second, '503|504')).toBe(2);
    expect(cultivationAttempts(second, '1|1')).toBe(0);
    expect(isCultivationTargetCoolingDown(second, '503|504', NOW + 61_000, 60 * 60_000)).toBe(true);
    expect(isCultivationTargetCoolingDown(second, '503|504', NOW + 61 * 60_000, 60 * 60_000)).toBe(false);
    expect(isCultivationTargetCoolingDown(second, '1|1', NOW, 60 * 60_000)).toBe(false);

    const podre = { version: 1, targets: { '503|504': { lastSentAt: '', lastSentAtMs: Number.NaN, attempts: 1 } } };
    expect(isCultivationTargetCoolingDown(podre, '503|504', NOW, 60 * 60_000)).toBe(true);
  });
});

describe('frescor do Mapper (contrato de leitura com o Auto Farm)', () => {
  it('índice indexa por coordenada e traz a config de reexploração da lista', () => {
    const index = readCultivatorMapperIndex(mapperList(NOW - 60_000));

    expect(index).not.toBeNull();
    expect(index?.byCoordinate.get('503|504')?.points).toBe(500);
    expect(index?.config.updateValue).toBe(6);
    expect(index?.config.updateMode).toBe('horas');
    expect(cultivatorMapperNote(index)).toContain('1 alvo(s) indexados');
    expect(cultivatorMapperNote(index)).toContain('reexploração: 6 horas');
  });

  it('lista ausente ou inválida não cobre alvo nenhum (sem gate)', () => {
    expect(readCultivatorMapperIndex(null)).toBeNull();
    expect(readCultivatorMapperIndex('lixo')).toBeNull();
    expect(cultivatorMapperNote(null)).toContain('sem lista válida');
  });

  it('a chave do contrato aponta para o namespace do plugin Auto Farm', () => {
    expect(autoFarmTargetsKey('br144')).toBe('tsh-auto:br144:auto-farm:targets');
  });
});

describe('seleção pura da onda de cultivo (Onda 4)', () => {
  const settings = barbarianCultivatorSettingsSchema.parse({ mode: 'executar', catapultsPerWave: 20, cooldownMinutes: 60 });

  it('executa alvo coberto pelo Mapper com exploração comprovada dentro do horizonte', () => {
    const decision = selectBarbarianCultivationExecution({
      settings,
      targets: [target()],
      catapultsAvailable: 30,
      ledger: null,
      mapper: readCultivatorMapperIndex(mapperList(NOW - 60 * 60_000)),
      nowMs: NOW,
    });

    expect(decision).toEqual({
      kind: 'EXECUTE',
      targetId: 'alvo-1',
      coordinate: '503|504',
      building: 'main',
      catapult: 20,
      attempt: 1,
    });
  });

  it('alvo do Mapper sem exploração comprovada é pulado com o motivo do gate', () => {
    const decision = selectBarbarianCultivationExecution({
      settings,
      targets: [target()],
      catapultsAvailable: 30,
      ledger: null,
      mapper: readCultivatorMapperIndex(mapperList(null)),
      nowMs: NOW,
    });

    expect(decision).toEqual({
      kind: 'SKIP',
      reason: 'Nenhum alvo elegível livre: 1 exigem nova exploração (Mapper) e 0 estão no cooldown de 60 min do livro-razão.',
    });
  });

  it('alvo fora da cobertura do Mapper é a via explícita (sem gate de frescor)', () => {
    const decision = selectBarbarianCultivationExecution({
      settings,
      targets: [target({ id: 'local', x: 600, y: 600 })],
      catapultsAvailable: 30,
      ledger: null,
      mapper: readCultivatorMapperIndex(mapperList(NOW - 60 * 60_000)),
      nowMs: NOW,
    });

    expect(decision.kind).toBe('EXECUTE');
    if (decision.kind === 'EXECUTE') expect(decision.coordinate).toBe('600|600');
  });

  it('alvo em cooldown do livro-razão é pulado e conta no motivo', () => {
    const ledger = recordBarbarianCultivation(createBarbarianCultivatorLedger(), '503|504', NOW, 'a');
    const decision = selectBarbarianCultivationExecution({
      settings,
      targets: [target()],
      catapultsAvailable: 30,
      ledger,
      mapper: null,
      nowMs: NOW + 60_000,
    });

    expect(decision).toEqual({
      kind: 'SKIP',
      reason: 'Nenhum alvo elegível livre: 0 exigem nova exploração (Mapper) e 1 estão no cooldown de 60 min do livro-razão.',
    });
  });

  it('sem catapultas suficientes o motivo é o do planner (nada é inventado)', () => {
    const decision = selectBarbarianCultivationExecution({
      settings,
      targets: [target()],
      catapultsAvailable: 10,
      ledger: null,
      mapper: null,
      nowMs: NOW,
    });

    expect(decision).toEqual({ kind: 'SKIP', reason: 'Nenhuma construção bárbara está elegível para cultivo.' });
  });
});

describe('status do Cultivador (prévia e execução)', () => {
  it('prévia cita alvo, edifício, catapultas e o frescor do Mapper', () => {
    const plan = planBarbarianCultivation(barbarianCultivatorSettingsSchema.parse({}), [target()], 30);
    const status = barbarianCultivationStatusMessage({
      plan,
      mode: 'preview',
      note: '',
      mapperNote: cultivatorMapperNote(readCultivatorMapperIndex(mapperList(null))),
    });

    expect(status.kind).toBe('ok');
    expect(status.message).toContain('Prévia Cultivador de Bárbaras');
    expect(status.message).toContain('edifício main');
    expect(status.message).toContain('Prévia, sem execução.');
  });

  it('execução enviada é honesta sobre a escolha do edifício na tela do jogo', () => {
    const plan = planBarbarianCultivation(barbarianCultivatorSettingsSchema.parse({}), [target()], 30);
    const status = barbarianCultivationStatusMessage({
      plan,
      mode: 'executar',
      note: '',
      mapperNote: '',
      execution: { outcome: 'ENVIADO', coordinate: '503|504', building: 'main', catapult: 20, attempt: 2 },
    });

    expect(status.kind).toBe('ok');
    expect(status.message).toContain('tentativa 2');
    expect(status.message).toContain('faixa humanizada');
    expect(status.message).toContain('escolha do edifício é feita na tela de confirmação do jogo');
  });

  it('pulado/bloqueado explicam o motivo no status', () => {
    const plan = planBarbarianCultivation(barbarianCultivatorSettingsSchema.parse({}), [target()], 30);
    const pulado = barbarianCultivationStatusMessage({
      plan,
      mode: 'executar',
      note: '',
      mapperNote: '',
      execution: { outcome: 'PULADO', reason: 'sem alvo livre.' },
    });
    const bloqueado = barbarianCultivationStatusMessage({
      plan,
      mode: 'executar',
      note: '',
      mapperNote: '',
      execution: { outcome: 'BLOQUEADO', reason: 'abra a Praça de Reunião.' },
    });

    expect(pulado.kind).toBe('info');
    expect(pulado.message).toContain('Nada foi enviado');
    expect(bloqueado.kind).toBe('warn');
    expect(bloqueado.message).toContain('Execução bloqueada');
  });
});
