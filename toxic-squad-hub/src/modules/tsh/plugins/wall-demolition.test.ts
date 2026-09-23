import { describe, expect, it } from 'vitest';
import {
  createWallDemolitionLedger,
  loadWallDemolitionLedger,
  planWallDemolition,
  recordWallDemolitionAttempt,
  selectWallDemolitionExecution,
  wallDemolitionAttempts,
  wallDemolitionProgress,
  wallDemolitionProgressNote,
  wallDemolitionSettingsSchema,
  wallDemolitionStatusMessage,
  type WallDemolitionTarget,
} from './wall-demolition';

function target(overrides: Partial<WallDemolitionTarget> = {}): WallDemolitionTarget {
  return {
    id: 'alvo-1',
    x: 503,
    y: 504,
    points: 1200,
    wallLevel: 6,
    barbarian: true,
    ...overrides,
  };
}

describe('planejador puro do Demolidor de Muralhas', () => {
  it('planeja a primeira muralha elegível com aríetes suficientes', () => {
    const decision = planWallDemolition(
      wallDemolitionSettingsSchema.parse({ minRams: 15, maxAttempts: 2, minWallLevel: 3 }),
      [target({ id: 'baixa', wallLevel: 1 }), target({ id: 'alvo-1', wallLevel: 6 })],
      20,
    );

    expect(decision).toEqual({ kind: 'PLAN', targetId: 'alvo-1', ram: 15, attempts: 2 });
  });

  it('lista vazia devolve NO_WORK explícito de prévia', () => {
    const decision = planWallDemolition(wallDemolitionSettingsSchema.parse({}), [], 100);

    expect(decision.kind).toBe('NO_WORK');
    if (decision.kind === 'NO_WORK') {
      expect(decision.reason).toContain('Nenhum alvo cadastrado');
    }
  });

  it('sem aríetes suficientes devolve o motivo da origem', () => {
    const decision = planWallDemolition(wallDemolitionSettingsSchema.parse({ minRams: 10 }), [target()], 5);

    expect(decision).toEqual({ kind: 'NO_WORK', reason: 'Nenhuma muralha elegível possui aríetes suficientes.' });
  });

  it('muralha abaixo do mínimo não é elegível', () => {
    const decision = planWallDemolition(wallDemolitionSettingsSchema.parse({ minWallLevel: 5 }), [target({ wallLevel: 4 })], 50);

    expect(decision).toEqual({ kind: 'NO_WORK', reason: 'Nenhuma muralha elegível possui aríetes suficientes.' });
  });
});

describe('modo de execução do Demolidor (Onda 4)', () => {
  it('default é prévia; valor estranho no storage também cai em prévia (fail-closed)', () => {
    expect(wallDemolitionSettingsSchema.parse({}).mode).toBe('preview');
    expect(wallDemolitionSettingsSchema.parse({ mode: 'atacar' }).mode).toBe('preview');
    expect(wallDemolitionSettingsSchema.parse({ mode: 'executar' }).mode).toBe('executar');
  });
});

describe('livro-razão do Demolidor', () => {
  const SENT_AT = Date.parse('2026-09-23T12:00:00.000Z');

  it('registra envio por coordenada e acumula tentativas sem tocar nos outros alvos', () => {
    const first = recordWallDemolitionAttempt(createWallDemolitionLedger(), '503|504', SENT_AT, 'a');
    const second = recordWallDemolitionAttempt(first, '503|504', SENT_AT + 60_000, 'b');
    const other = recordWallDemolitionAttempt(second, '505|510', SENT_AT + 120_000, 'c');

    expect(wallDemolitionAttempts(other, '503|504')).toBe(2);
    expect(wallDemolitionAttempts(other, '505|510')).toBe(1);
    expect(wallDemolitionAttempts(other, '1|1')).toBe(0);
    expect(other.targets['503|504']?.lastSentAt).toBe('b');
  });

  it('ledger corrompido reinicia vazio; entrada podre não volta', () => {
    expect(loadWallDemolitionLedger({ version: 2, targets: {} })).toEqual(createWallDemolitionLedger());
    expect(loadWallDemolitionLedger('lixo')).toEqual(createWallDemolitionLedger());

    const podre = { version: 1, targets: { '503|504': { lastSentAt: '', lastSentAtMs: Number.NaN, attempts: 3 } } };
    const limpo = recordWallDemolitionAttempt(podre, '505|510', SENT_AT, 'agora');

    expect(Object.keys(limpo.targets)).toEqual(['505|510']);
  });

  it('entrada presente com contagem inválida é fail-closed (null = esgotado)', () => {
    const podre = { version: 1, targets: { '503|504': { lastSentAt: '', lastSentAtMs: 1, attempts: Number.NaN } } };

    expect(wallDemolitionAttempts(podre, '503|504')).toBeNull();
    expect(selectWallDemolitionExecution(wallDemolitionSettingsSchema.parse({ minRams: 10 }), [target()], 20, podre)).toEqual({
      kind: 'SKIP',
      reason: 'Todos os 1 alvo(s) elegíveis já esgotaram as 1 tentativa(s) no livro-razão.',
    });
  });

  it('progresso lista tentativas usadas/restantes dos alvos com muralha mínima', () => {
    const settings = wallDemolitionSettingsSchema.parse({ maxAttempts: 2, minWallLevel: 5 });
    const ledger = recordWallDemolitionAttempt(createWallDemolitionLedger(), '503|504', SENT_AT, 'a');
    const progress = wallDemolitionProgress(settings, [target(), target({ id: 'baixa', x: 1, y: 1, wallLevel: 1 })], ledger);

    expect(progress).toEqual([{ coordinate: '503|504', attempts: 1, remaining: 1 }]);
    expect(wallDemolitionProgressNote(progress)).toBe(' Progresso do livro-razão: 503|504 1 usada(s)/1 restante(s).');
    expect(wallDemolitionProgressNote([])).toBe('');
  });
});

describe('seleção pura da onda (Onda 4)', () => {
  const settings = wallDemolitionSettingsSchema.parse({ minRams: 10, maxAttempts: 1, minWallLevel: 5 });

  it('escolhe o 1º alvo elegível e informa a tentativa', () => {
    const decision = selectWallDemolitionExecution(settings, [target({ id: 'baixa', wallLevel: 1 }), target()], 20, null);

    expect(decision).toEqual({
      kind: 'EXECUTE',
      execution: { targetId: 'alvo-1', coordinate: '503|504', ram: 10, attempts: 1, attempt: 1 },
    });
  });

  it('alvo esgotado é pulado em favor do próximo elegível', () => {
    const ledger = recordWallDemolitionAttempt(createWallDemolitionLedger(), '503|504', 1, 'a');
    const decision = selectWallDemolitionExecution(
      settings,
      [target(), target({ id: 'alvo-2', x: 505, y: 510 })],
      20,
      ledger,
    );

    expect(decision).toEqual({
      kind: 'EXECUTE',
      execution: { targetId: 'alvo-2', coordinate: '505|510', ram: 10, attempts: 1, attempt: 1 },
    });
  });

  it('com todos esgotados explica o livro-razão (sem "nada foi enviado" seco)', () => {
    const ledger = recordWallDemolitionAttempt(createWallDemolitionLedger(), '503|504', 1, 'a');
    const decision = selectWallDemolitionExecution(settings, [target()], 20, ledger);

    expect(decision).toEqual({
      kind: 'SKIP',
      reason: 'Todos os 1 alvo(s) elegíveis já esgotaram as 1 tentativa(s) no livro-razão.',
    });
  });

  it('máximo de tentativas maior permite repetir o mesmo alvo', () => {
    const repetivel = wallDemolitionSettingsSchema.parse({ minRams: 10, maxAttempts: 2 });
    const ledger = recordWallDemolitionAttempt(createWallDemolitionLedger(), '503|504', 1, 'a');
    const decision = selectWallDemolitionExecution(repetivel, [target()], 20, ledger);

    expect(decision.kind).toBe('EXECUTE');
    if (decision.kind === 'EXECUTE') {
      expect(decision.execution.attempt).toBe(2);
      expect(decision.execution.attempts).toBe(2);
    }
  });

  it('sem aríetes em casa ou sem alvo, o motivo é honesto e nada é executado', () => {
    expect(selectWallDemolitionExecution(settings, [target()], 5, null)).toEqual({
      kind: 'SKIP',
      reason: 'Nenhuma muralha elegível possui aríetes suficientes.',
    });
    expect(selectWallDemolitionExecution(settings, [], 20, null)).toEqual({
      kind: 'SKIP',
      reason: 'Nenhum alvo cadastrado na lista local — não há onda para executar.',
    });
  });
});

describe('status do Demolidor (prévia e execução)', () => {
  it('prévia sempre legível, com progresso e reforço de que nada é enviado', () => {
    const plan = planWallDemolition(wallDemolitionSettingsSchema.parse({}), [target()], 20);
    const status = wallDemolitionStatusMessage({
      plan,
      mode: 'preview',
      progress: wallDemolitionProgress(wallDemolitionSettingsSchema.parse({}), [target()], null),
      note: '',
      levelHint: '',
    });

    expect(status.kind).toBe('ok');
    expect(status.message).toContain('Prévia Demolidor de Muralhas');
    expect(status.message).toContain('Progresso do livro-razão');
    expect(status.message).toContain('Prévia, sem execução.');
  });

  it('execução enviada cita tentativa, faixa humanizada e progresso', () => {
    const plan = planWallDemolition(wallDemolitionSettingsSchema.parse({}), [target()], 20);
    const status = wallDemolitionStatusMessage({
      plan,
      mode: 'executar',
      progress: [{ coordinate: '503|504', attempts: 1, remaining: 0 }],
      note: '',
      levelHint: '',
      execution: { outcome: 'ENVIADO', coordinate: '503|504', ram: 10, attempt: 1, attempts: 1 },
    });

    expect(status.kind).toBe('ok');
    expect(status.message).toContain('tentativa 1/1');
    expect(status.message).toContain('faixa humanizada');
    expect(status.message).toContain('503|504 1 usada(s)/0 restante(s)');
  });

  it('bloqueio e falha viram aviso com o motivo', () => {
    const plan = planWallDemolition(wallDemolitionSettingsSchema.parse({}), [target()], 20);
    const bloqueado = wallDemolitionStatusMessage({
      plan,
      mode: 'executar',
      progress: [],
      note: '',
      levelHint: '',
      execution: { outcome: 'BLOQUEADO', reason: 'abra a Praça de Reunião.' },
    });
    const falha = wallDemolitionStatusMessage({
      plan,
      mode: 'executar',
      progress: [],
      note: '',
      levelHint: '',
      execution: { outcome: 'FALHA', reason: 'sem formulário.' },
    });

    expect(bloqueado.kind).toBe('warn');
    expect(bloqueado.message).toContain('Execução bloqueada');
    expect(falha.kind).toBe('warn');
    expect(falha.message).toContain('Envio falhou');
  });
});
