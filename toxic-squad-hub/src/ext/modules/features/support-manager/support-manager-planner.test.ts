import { describe, expect, it } from 'vitest';
import {
  planSupportWithdrawal,
  type SupportWithdrawalDraft,
  type SupportWithdrawalSnapshot,
  type SupportWithdrawalUnit,
} from './support-manager-planner';

const units = (overrides: Partial<Record<SupportWithdrawalUnit, number>> = {}) => ({
  spear: 0,
  sword: 0,
  axe: 0,
  archer: 0,
  spy: 0,
  light: 0,
  marcher: 0,
  heavy: 0,
  ram: 0,
  catapult: 0,
  knight: 0,
  snob: 0,
  ...overrides,
});

const record = (id: string, spear: number, destination = 'village_target001') => ({
  supportId: id,
  originVillageId: 'village_origin01',
  originName: 'Origem',
  originCoordinate: '500|500',
  destinationVillageId: destination,
  destinationName: 'Destino',
  destinationCoordinate: '501|500',
  destinationKind: 'player' as 'own' | 'player' | 'barbarian',
  ownerName: 'Jogador',
  playerName: 'Jogador',
  tribeName: 'Tribo',
  troops: units({ spear }),
});

const snapshot = (
  records: ReturnType<typeof record>[],
  overrides: Partial<SupportWithdrawalSnapshot> = {},
): SupportWithdrawalSnapshot => ({
  accountId: 'account_support01',
  worldId: 'world_support01',
  availability: 'available',
  coverage: 'complete',
  truncated: false,
  groups: [{ groupId: 'group_support01', name: 'Linha' }],
  memberships: [{ villageId: 'village_origin01', groupIds: ['group_support01'] }],
  outgoingSupports: [...records].sort((left, right) =>
    left.supportId < right.supportId ? -1 : left.supportId > right.supportId ? 1 : 0,
  ),
  garrisons: [],
  ...overrides,
});

const plan = (world: SupportWithdrawalSnapshot, draft: SupportWithdrawalDraft) =>
  planSupportWithdrawal({ snapshot: world, draft, evaluatedAt: '2026-08-14T10:01:00.000Z' });

const percentage = (
  percent: 10 | 25 | 50 | 100,
  unitIds: SupportWithdrawalDraft['unitIds'] = ['spear'],
): SupportWithdrawalDraft => ({
  scope: 'player',
  groupId: '0',
  unitIds,
  selection: { kind: 'percentage', percent },
});

describe('planejador de retirada de apoio (support-manager portado)', () => {
  it('reproduz a minimização gulosa L1 com o teto agregado de 125%', () => {
    const result = plan(
      snapshot([record('support_record0001', 6), record('support_record0002', 4), record('support_record0003', 2)]),
      percentage(50),
    );
    // total 12 → alvo 6 lanças, teto floor(12 * 0.50 * 1.25) = 7; o record de 6
    // zera a distância e os demais estouram o teto (6+4 > 7).
    expect(result.results.map(({ recordId, disposition }) => [recordId, disposition])).toEqual([
      ['support_record0001', 'selected'],
      ['support_record0002', 'retained'],
      ['support_record0003', 'retained'],
    ]);
    expect(result.metrics).toMatchObject({
      totalUnits: 12,
      selectedUnits: 6,
      effectivePercent: 50,
      notFractionableGroups: 0,
    });
  });

  it('seleciona todos a 100% e marca grupos positivos indivisíveis', () => {
    const world = snapshot([record('support_record0001', 10)]);
    expect(plan(world, percentage(100)).results[0]?.disposition).toBe('selected');
    expect(plan(snapshot([record('support_record0001', 0)]), percentage(100)).results[0]?.disposition).toBe('retained');
    const fractional = plan(world, percentage(10));
    expect(fractional.results[0]?.disposition).toBe('not-fractionable');
    expect(fractional.warnings).toEqual(['not-fractionable', 'withdrawal-semantics-unverified']);
  });

  it('minimiza L1 por unidade no vetor dourado multi-unidade', () => {
    const world = snapshot([
      { ...record('support_unitA', 0), troops: units({ spear: 3 }) },
      { ...record('support_unitB', 0), troops: units({ spear: 3 }) },
      { ...record('support_unitC', 0), troops: units({ sword: 3 }) },
      { ...record('support_unitD', 0), troops: units({ sword: 3 }) },
      { ...record('support_unitE', 0), troops: units({ spear: 1, sword: 1 }) },
    ]);
    // totais 7 lanças + 7 espadas → alvo 3.5/3.5, teto floor(14 * 0.50 * 1.25) = 8;
    // a dupla A+C (3/3) é o mínimo alcançável (distância 1; um terceiro
    // registro estoura o teto e E não melhora a distância).
    const result = plan(world, percentage(50, ['spear', 'sword']));
    expect(
      result.results.filter(({ disposition }) => disposition === 'selected').map(({ recordId }) => recordId),
    ).toEqual(['support_unitA', 'support_unitC']);
    expect(result.metrics).toMatchObject({ totalUnits: 14, selectedUnits: 6, effectivePercent: (6 / 14) * 100 });
  });

  it('nunca seleciona além do teto de 125% do percentual', () => {
    const records = Array.from({ length: 40 }, (_, index) => record(`support_cap${String(index).padStart(8, '0')}`, 3));
    const result = plan(snapshot(records), percentage(10));
    // total 120 → alvo 12 lanças, teto floor(120 * 0.10 * 1.25) = 15; o guloso
    // para em 4 registros (12 unidades), pois o 5º estoura o alvo.
    expect(result.metrics.totalUnits).toBe(120);
    expect(result.metrics.selectedUnits).toBeLessThanOrEqual(15);
    expect(
      result.results.filter(({ disposition }) => disposition === 'selected').map(({ recordId }) => recordId),
    ).toEqual(['support_cap00000000', 'support_cap00000001', 'support_cap00000002', 'support_cap00000003']);
    expect(result.metrics.effectivePercent).toBe(10);
  });

  it('usa ordem binária para empates e o ramo de primeira-melhoria acima de 150 registros', () => {
    const tied = snapshot([
      record('support_zrecord01', 2),
      record('support_Arecord01', 2),
      record('support_arecord01', 2),
    ]);
    expect(
      plan(tied, percentage(50))
        .results.filter(({ disposition }) => disposition === 'selected')
        .map(({ recordId }) => recordId),
    ).toEqual(['support_Arecord01']);
    const many = [
      { ...record('support_first0001', 0), troops: units({ spear: 8 }) },
      { ...record('support_better001', 0), troops: units({ spear: 3, sword: 3 }) },
      ...Array.from({ length: 39 }, (_, index) => ({
        ...record(`support_s${String(index).padStart(8, '0')}`, 0),
        troops: units({ spear: 1 }),
      })),
      ...Array.from({ length: 47 }, (_, index) => ({
        ...record(`support_w${String(index).padStart(8, '0')}`, 0),
        troops: units({ sword: 1 }),
      })),
      ...Array.from({ length: 63 }, (_, index) => record(`support_z${String(index).padStart(8, '0')}`, 0)),
    ];
    // 151 registros (> 150) → primeira-melhoria; o conjunto selecionado exato
    // prova que o ramo legacy converge deterministicamente sob o teto de 12.
    const large = plan(snapshot(many), percentage(10, ['spear', 'sword']));
    expect(large.results.find(({ recordId }) => recordId === 'support_first0001')?.disposition).toBe('selected');
    expect(large.results.find(({ recordId }) => recordId === 'support_better001')?.disposition).toBe('retained');
    expect(
      large.results.filter(({ disposition }) => disposition === 'selected').map(({ recordId }) => recordId),
    ).toEqual([
      'support_first0001',
      'support_w00000000',
      'support_w00000001',
      'support_w00000002',
      'support_w00000003',
    ]);
  });

  it('valida IDs manuais com falha fechada e devolve registros em ordem canônica', () => {
    const world = snapshot([record('support_record0002', 2), record('support_record0001', 1)]);
    const selected = plan(world, {
      ...percentage(25),
      selection: { kind: 'manual', recordIds: ['support_record0002'] },
    });
    expect(selected.results.map(({ recordId, disposition }) => [recordId, disposition])).toEqual([
      ['support_record0001', 'retained'],
      ['support_record0002', 'selected'],
    ]);
    const none = plan(world, { ...percentage(25), selection: { kind: 'manual', recordIds: [] } });
    expect(none.results.every(({ disposition }) => disposition === 'retained')).toBe(true);
    const all = plan(world, {
      ...percentage(25),
      selection: { kind: 'manual', recordIds: ['support_record0001', 'support_record0002'] },
    });
    expect(all.results.every(({ disposition }) => disposition === 'selected')).toBe(true);
    expect(() =>
      plan(world, { ...percentage(25), selection: { kind: 'manual', recordIds: ['support_missing001'] } }),
    ).toThrow(/missing or foreign/);
  });

  it('marca o grupo inteiro como não fracionável quando o teto bloqueia tudo', () => {
    const world = snapshot([
      record('support_big000001', 10, 'village_target001'),
      record('support_big000002', 12, 'village_target002'),
      record('support_big000003', 8, 'village_target002'),
      ...Array.from({ length: 10 }, (_, index) =>
        record(`support_small${String(index).padStart(8, '0')}`, 2, 'village_target003'),
      ),
    ]);
    const result = plan(world, percentage(10));
    // alvos de 10% com tetos 1 e 2 bloqueiam os grupos 1 e 2 por inteiro;
    // o grupo 3 (teto 2) fraciona em um único registro de 2 lanças.
    expect(
      result.results.filter(({ disposition }) => disposition === 'not-fractionable').map(({ recordId }) => recordId),
    ).toEqual(['support_big000001', 'support_big000002', 'support_big000003']);
    expect(
      result.results.filter(({ disposition }) => disposition === 'selected').map(({ recordId }) => recordId),
    ).toEqual(['support_small00000000']);
    expect(result.metrics).toMatchObject({ records: 13, groups: 3, notFractionableGroups: 2 });
    expect(result.warnings).toEqual(['not-fractionable', 'withdrawal-semantics-unverified']);
  });

  it('aplica filtros de escopo e grupo e agrupa guarnições pela aldeia anfitriã', () => {
    const world = snapshot(
      [record('support_player001', 4), { ...record('support_own00001', 5), destinationKind: 'own' as const }],
      {
        garrisons: [
          {
            awayId: 'away_garrison001',
            hostVillageId: 'village_origin01',
            hostName: 'Host',
            hostCoordinate: '500|500',
            originVillageId: 'village_target001',
            originName: 'Origem remota',
            originCoordinate: '501|500',
            ownerName: 'Jogador',
            troops: units({ spear: 7 }),
          },
        ],
      },
    );
    const groupDraft: SupportWithdrawalDraft = { ...percentage(100), groupId: 'group_support01' };
    expect(plan(world, groupDraft).results.map(({ recordId }) => recordId)).toEqual(['support_player001']);
    expect(plan(world, { ...groupDraft, scope: 'garrison' }).results.map(({ recordId }) => recordId)).toEqual([
      'away_garrison001',
    ]);
  });

  it('é determinístico e ordena os resultados em ordem canônica de recordId', () => {
    const world = snapshot([
      record('support_record0002', 2),
      record('support_record0001', 1),
      record('support_record0003', 1),
    ]);
    const first = plan(world, percentage(50));
    const second = plan(world, percentage(50));
    expect(second).toEqual(first);
    expect(first.results.map(({ recordId }) => recordId)).toEqual([
      'support_record0001',
      'support_record0002',
      'support_record0003',
    ]);
  });

  it('não muta nem congela a entrada', () => {
    const world = snapshot([record('support_record0002', 2), record('support_record0001', 1)]);
    const draft = percentage(25);
    const beforeSnapshot = structuredClone(world);
    const beforeDraft = structuredClone(draft);
    plan(world, draft);
    expect(world).toEqual(beforeSnapshot);
    expect(draft).toEqual(beforeDraft);
    expect(Object.isFrozen(world)).toBe(false);
    expect(Object.isFrozen(world.outgoingSupports[0])).toBe(false);
    expect(Object.isFrozen(world.outgoingSupports[0]!.troops)).toBe(false);
    expect(Object.isFrozen(draft)).toBe(false);
  });

  it('congela a saída em profundidade', () => {
    const result = plan(snapshot([record('support_record0001', 6), record('support_record0002', 4)]), percentage(50));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.results)).toBe(true);
    expect(Object.isFrozen(result.results[0])).toBe(true);
    expect(Object.isFrozen(result.results[0]!.troops)).toBe(true);
    expect(Object.isFrozen(result.metrics)).toBe(true);
    expect(Object.isFrozen(result.warnings)).toBe(true);
  });

  it('falha fechado para autoridade indisponível, parcial ou truncada, sem efeitos', () => {
    const blocked = [
      {
        world: snapshot([], { availability: 'unavailable', coverage: 'partial', groups: [], memberships: [] }),
        warnings: ['snapshot-unavailable', 'snapshot-incomplete'],
      },
      {
        world: snapshot([], { coverage: 'partial', groups: [], memberships: [] }),
        warnings: ['snapshot-incomplete'],
      },
      {
        world: snapshot([], { coverage: 'partial', truncated: true, groups: [], memberships: [] }),
        warnings: ['snapshot-incomplete', 'snapshot-truncated'],
      },
    ];
    for (const { world, warnings } of blocked) {
      const result = plan(world, percentage(25));
      expect(result.results).toEqual([]);
      expect(result).toMatchObject({
        state: 'blocked',
        effectsAllowed: false,
        sentToTribalWars: false,
        plannedWithdrawals: 0,
        effect: null,
      });
      expect(result.warnings).toEqual(warnings);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.metrics)).toBe(true);
    }
  });
});
