import { describe, expect, it } from 'vitest';
import {
  correctedAverage,
  defaultBalancePolicy,
  defaultBalancePolicyForWorldSpeed,
  planBalanceTransfers,
  type BalanceVillage,
} from './resource-planner';

function village(input: Partial<BalanceVillage> & { id: string }): BalanceVillage {
  return {
    resources: { wood: 100_000, stone: 100_000, iron: 100_000 },
    storage: 400_000,
    points: 5_000,
    merchantsAvailable: 10,
    ...input,
  };
}

describe('planejador híbrido de balanceamento', () => {
  it('média corrigida exclui armazéns pequenos do cálculo', () => {
    const villages = [
      village({ id: 'a', resources: { wood: 800_000, stone: 0, iron: 0 }, storage: 800_000 }),
      village({ id: 'b', resources: { wood: 800_000, stone: 0, iron: 0 }, storage: 800_000 }),
      village({ id: 'c', resources: { wood: 20_000, stone: 0, iron: 0 }, storage: 20_000 }),
    ];
    // média simples ~540k estouraria o armazém de 'c' (20k); a média corrigida
    // exclui 'c' do cálculo e fica no patamar das duas grandes (800k).
    const average = correctedAverage(villages, 'wood');
    expect(average).toBeGreaterThanOrEqual(790_000);
    expect(average).toBeLessThanOrEqual(810_000);
  });

  it('transfere da doadora mais próxima para a receptora com déficit', () => {
    const villages = [
      village({
        id: 'donor-near',
        resources: { wood: 300_000, stone: 300_000, iron: 300_000 },
        points: 9_000,
        x: 100,
        y: 100,
      }),
      village({
        id: 'donor-far',
        resources: { wood: 300_000, stone: 300_000, iron: 300_000 },
        points: 9_000,
        x: 900,
        y: 900,
      }),
      village({
        id: 'receiver',
        resources: { wood: 10_000, stone: 10_000, iron: 10_000 },
        points: 1_000,
        x: 105,
        y: 105,
      }),
    ];
    const transfers = planBalanceTransfers(villages, defaultBalancePolicy);
    expect(transfers.length).toBeGreaterThanOrEqual(1);
    // a doadora mais próxima atende primeiro
    expect(transfers[0]).toMatchObject({ donorId: 'donor-near', receiverId: 'receiver' });
    expect(transfers[0]?.wood).toBeGreaterThan(0);
    for (const transfer of transfers) {
      expect(transfer.merchants).toBeGreaterThan(0);
      expect(transfer.merchants).toBeLessThanOrEqual(10);
    }
  });

  it('respeita reserva de mercadores e teto de recebimento', () => {
    const policy = { ...defaultBalancePolicy, reserveMerchants: 8, receiveCapFactor: 0.5 };
    const villages = [
      village({ id: 'donor', resources: { wood: 400_000, stone: 400_000, iron: 400_000 }, points: 9_000, x: 0, y: 0 }),
      village({
        id: 'receiver',
        resources: { wood: 0, stone: 0, iron: 0 },
        points: 1_000,
        storage: 100_000,
        x: 5,
        y: 5,
      }),
    ];
    const transfers = planBalanceTransfers(villages, policy);
    expect(transfers).toHaveLength(1);
    const transfer = transfers[0]!;
    // 8 dos 10 mercadores reservados: capacidade 2×1000 por recurso.
    expect(transfer.wood).toBeLessThanOrEqual(2_000);
    // recebimento limitado a 50% do armazém de 100k — não é o gargalo aqui.
    expect(transfer.wood).toBeGreaterThan(0);
  });

  it('exclui do planejamento pares com coordenada ausente: a aldeia sem coords nunca doa nem recebe', () => {
    const villages = [
      // doadora sem coordenadas com excedente enorme — nunca deve ser usada.
      village({ id: 'phantom-donor', resources: { wood: 900_000, stone: 900_000, iron: 900_000 }, points: 9_000 }),
      // receptora sem coordenadas com déficit gigante — nunca deve ser atendida.
      village({ id: 'phantom-receiver', resources: { wood: 0, stone: 0, iron: 0 }, points: 500, storage: 1_000_000 }),
      // par com coordenadas legítimo.
      village({
        id: 'donor',
        resources: { wood: 300_000, stone: 300_000, iron: 300_000 },
        points: 9_000,
        x: 100,
        y: 100,
      }),
      village({
        id: 'receiver',
        resources: { wood: 10_000, stone: 10_000, iron: 10_000 },
        points: 1_000,
        x: 105,
        y: 105,
      }),
    ];
    const transfers = planBalanceTransfers(villages, defaultBalancePolicy);

    expect(transfers.length).toBeGreaterThanOrEqual(1);
    for (const transfer of transfers) {
      expect(transfer.donorId).not.toBe('phantom-donor');
      expect(transfer.receiverId).not.toBe('phantom-receiver');
    }
    // o par com coordenadas continua sendo planejado normalmente.
    expect(transfers.some((transfer) => transfer.donorId === 'donor' && transfer.receiverId === 'receiver')).toBe(true);
  });

  it('deriva a capacidade padrão do mercador da velocidade do mundo (1000×speed) mantendo o override por parâmetro', () => {
    expect(defaultBalancePolicy.merchantCapacity).toBe(1_000);
    expect(defaultBalancePolicyForWorldSpeed(1).merchantCapacity).toBe(1_000);
    // br142 (speed 1.5) → 1000×1.5 = 1500, como os mundos PT com mercador 1500.
    expect(defaultBalancePolicyForWorldSpeed(1.5).merchantCapacity).toBe(1_500);
    // override explícito continua vencendo a derivação.
    expect({ ...defaultBalancePolicyForWorldSpeed(1.5), merchantCapacity: 2_000 }.merchantCapacity).toBe(2_000);
    // a derivação não afeta os demais campos da política.
    expect(defaultBalancePolicyForWorldSpeed(2)).toMatchObject({ minLoadFactor: 0.7, maxDistance: 0 });
  });

  it('não planeja sem déficit ou sem doadoras', () => {
    expect(planBalanceTransfers([village({ id: 'only' })], defaultBalancePolicy)).toEqual([]);
    const equal = [
      village({ id: 'a', resources: { wood: 100_000, stone: 100_000, iron: 100_000 } }),
      village({ id: 'b', resources: { wood: 100_000, stone: 100_000, iron: 100_000 } }),
    ];
    expect(planBalanceTransfers(equal, defaultBalancePolicy)).toEqual([]);
  });
});
