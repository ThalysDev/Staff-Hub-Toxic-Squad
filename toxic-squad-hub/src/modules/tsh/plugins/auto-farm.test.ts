import { describe, expect, it, vi } from 'vitest';
import { planAutoFarmPreview } from '../../../ext/modules/features/auto-farm/auto-farm-planner';
import type { AutoFarmSnapshot, AutoFarmTarget } from '../../../ext/modules/features/auto-farm/auto-farm-contracts';
import { autoFarmSnapshotSchema } from '../../../ext/modules/features/auto-farm/auto-farm-contracts';
import { autoFarmSettingsSchema } from '../../../ext/modules/features/auto-farm/auto-farm-settings';
import { ownVillages } from '../tsh-game-data';
import {
  MAX_STORED_ACTIONS,
  autoFarmRecommendedAction,
  autoFarmStatusMessage,
  buildAutoFarmReport,
  resolveAutoFarmRotation,
  type AutoFarmRotation,
} from './auto-farm';

vi.mock('../tsh-game-data', () => ({
  ownVillages: vi.fn(),
}));

const CAPTURED_AT = '2026-09-21T12:00:00.000Z';
const ROTATION: AutoFarmRotation = { ids: ['238755', '238756', '238757'], source: 'configuradas' };

function target(overrides: Partial<AutoFarmTarget> = {}): AutoFarmTarget {
  return {
    id: 'target-1',
    x: 503,
    y: 504,
    points: 120,
    barbarian: true,
    evidenceSources: ['AM_REPORT'],
    templateIds: ['A', 'B'],
    availableTemplateIds: ['A', 'B'],
    lastResult: 'SUCCESS',
    ...overrides,
  };
}

function snapshot(overrides: Partial<AutoFarmSnapshot> = {}): AutoFarmSnapshot {
  return autoFarmSnapshotSchema.parse({
    capability: 'AVAILABLE',
    source: { villageId: '238755', x: 500, y: 500, troops: { light: 1000 } },
    templates: [{ id: 'A', gameTemplateId: '23', units: { light: 10 } }],
    plunderFilters: {
      onlyCurrentVillage: false,
      includeAttacked: true,
      includeFullLosses: true,
      includePartialLosses: true,
      onlyFullHauls: false,
    },
    targets: [target()],
    capturedAt: CAPTURED_AT,
    ...overrides,
  });
}

function planReport(targets?: AutoFarmTarget[]) {
  return buildAutoFarmReport(
    planAutoFarmPreview(targets === undefined ? snapshot() : snapshot({ targets }), autoFarmSettingsSchema.parse({})),
    '238755',
    '2026-09-21T12:05:00.000Z',
    ROTATION,
  );
}

describe('relatório do ciclo readonly do Auto Farm', () => {
  it('trunca as ações persistidas sem perder os totais da prévia', () => {
    const muitos = Array.from({ length: MAX_STORED_ACTIONS + 10 }, (_, index): AutoFarmTarget =>
      target({ id: `alvo-${index}`, x: 501, y: 504 }),
    );
    const report = planReport(muitos);

    expect(report.outcome).toBe('PLAN');
    if (report.outcome === 'PLAN') {
      expect(report.actionsTotal).toBe(MAX_STORED_ACTIONS + 10);
      expect(report.actions).toHaveLength(MAX_STORED_ACTIONS);
      expect(report.actionsTruncated).toBe(true);
      expect(report.executableActions).toBe(MAX_STORED_ACTIONS + 10);
      expect(report.villageId).toBe('238755');
    }
  });

  it('carrega o resumo da rotação (nº de aldeias e fonte) nas duas saídas', () => {
    const plano = planReport();
    expect(plano.rotation).toEqual({ total: 3, source: 'configuradas' });

    const semTrabalho = planReport([]);
    expect(semTrabalho.outcome).toBe('NO_WORK');
    expect(semTrabalho.rotation).toEqual({ total: 3, source: 'configuradas' });
  });

  it('prévia sem alvos vira relatório NO_WORK com código e motivo', () => {
    const report = planReport([]);

    expect(report.outcome).toBe('NO_WORK');
    if (report.outcome === 'NO_WORK') {
      expect(report.code).toBe('NO_ELIGIBLE_TARGET');
      expect(report.reason).toContain('Nenhum alvo');
    }
  });
});

describe('status do ciclo do Auto Farm (legibilidade)', () => {
  it('status resume a prévia, cita as aldeias da rodada e reforça que nenhum ataque é enviado', () => {
    const plano = autoFarmStatusMessage(planReport(), ROTATION);
    expect(plano.kind).toBe('ok');
    expect(plano.message).toContain('1 executáveis de 1 alvos');
    expect(plano.message).toContain('Aldeias na rodada: 3 (configuradas)');
    expect(plano.message).toContain('nenhum ataque enviado');

    const semTrabalho = autoFarmStatusMessage(planReport([]), ROTATION);
    expect(semTrabalho.kind).toBe('info');
    expect(semTrabalho.message).toContain('Aldeias na rodada: 3 (configuradas)');
    expect(semTrabalho.message).toContain('Somente leitura — nenhum ataque enviado');
  });

  it('ação recomendada: rodada executável aponta para o jogo (módulo não envia)', () => {
    const report = planReport();
    if (report.outcome !== 'PLAN') throw new Error('esperava PLAN');
    expect(autoFarmRecommendedAction(report)).toContain('não envia ataques');
  });

  it('ação recomendada: sem tropas e filtros incompletos têm orientações distintas', () => {
    const semTropas = planAutoFarmPreview(
      snapshot({ source: { villageId: '238755', x: 500, y: 500, troops: { light: 1 } } }),
      autoFarmSettingsSchema.parse({}),
    );
    const report = buildAutoFarmReport(semTropas, '238755', CAPTURED_AT, ROTATION);
    if (report.outcome !== 'PLAN') throw new Error('esperava PLAN');
    expect(report.executableActions).toBe(0);
    expect(autoFarmRecommendedAction(report)).toContain('aguarde tropas');

    const filtro = planAutoFarmPreview(
      snapshot({ plunderFilters: { onlyCurrentVillage: true, includeAttacked: true, includeFullLosses: true, includePartialLosses: true, onlyFullHauls: false } }),
      autoFarmSettingsSchema.parse({}),
    );
    const reportFiltro = buildAutoFarmReport(filtro, '238755', CAPTURED_AT, ROTATION);
    if (reportFiltro.outcome !== 'NO_WORK') throw new Error('esperava NO_WORK');
    expect(reportFiltro.code).toBe('FILTER_COVERAGE_INCOMPLETE');
    expect(autoFarmRecommendedAction(reportFiltro)).toContain('filtros');
  });
});

describe('rotação de aldeias do Auto Farm', () => {
  it('lista configurada vence (compatibilidade: usa exatamente os IDs gravados)', async () => {
    const rotation = await resolveAutoFarmRotation(['111', '222'], '333');

    expect(rotation).toEqual({ ids: ['111', '222'], source: 'configuradas' });
  });

  it('lista vazia usa as ALDEIAS PRÓPRIAS do jogador (auto-serviço)', async () => {
    vi.mocked(ownVillages).mockResolvedValue([
      { id: '444', name: 'Aldeia 01', x: 500, y: 500, points: 1000, playerId: '7' },
      { id: '555', name: 'Aldeia 02', x: 501, y: 501, points: 800, playerId: '7' },
    ]);
    const rotation = await resolveAutoFarmRotation([], '333');

    expect(rotation).toEqual({ ids: ['444', '555'], source: 'proprias' });
  });

  it('falha na leitura das próprias cai para a aldeia aberta no jogo (nunca derruba o ciclo)', async () => {
    vi.mocked(ownVillages).mockRejectedValue(new Error('village.txt indisponível'));
    const rotation = await resolveAutoFarmRotation([], '333');

    expect(rotation).toEqual({ ids: ['333'], source: 'aldeia atual' });
  });

  it('sem próprias e sem aldeia aberta, a rotação fica vazia com aviso do ciclo', async () => {
    vi.mocked(ownVillages).mockResolvedValue([]);
    const rotation = await resolveAutoFarmRotation([], '');

    expect(rotation).toEqual({ ids: [], source: 'aldeia atual' });
  });
});
