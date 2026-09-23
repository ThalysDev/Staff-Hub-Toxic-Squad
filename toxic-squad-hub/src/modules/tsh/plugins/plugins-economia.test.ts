// Partes PURAS dos plugins de economia (ambiente node, sem DOM): plano de
// cunhagem (reservas + máximo da página + contagem "possíveis"), parser de
// cotações da Troca Premium, decisão de compra/venda e rótulos da decisão,
// transferência do ramo fallback, escolha da maior carência do balanceador e
// a auto-recomendação de receptora abaixo da média.
import { describe, expect, it } from 'vitest';
import { planCoinMint, planCoinMintDetails, type CoinSettings } from './coin-center';
import {
  exchangeStatusLabel,
  formatarPtsMil,
  parseExchangeQuotes,
  planExchangeStep,
  ruleThresholdFor,
  type ExchangeDecision,
  type ExchangeSettings,
} from './premium-exchange';
import {
  pickLargestTransfer,
  planFallbackTransfer,
  recommendReceiverBelowAverage,
  receiverSuggestionLabel,
  transferTotal,
  type BalanceSettings,
  type OverviewVillage,
} from './resource-balancer';
import type { BalanceTransferCandidate } from '../../../ext/modules/features/resource-balancer/resource-planner';

const coinDefaults: CoinSettings = {
  maxCoinsPerCycle: 1,
  reserveWood: 0,
  reserveStone: 0,
  reserveIron: 0,
  coinCost: { wood: 28_000, stone: 30_000, iron: 25_000 },
};

describe('planCoinMint', () => {
  it('limita pelo teto por ciclo e pelo recurso mais escasso (reservas 0)', () => {
    const resources = { wood: 100_000, stone: 90_000, iron: 80_000 };
    expect(planCoinMint(resources, coinDefaults)).toBe(1);
    expect(planCoinMint(resources, { ...coinDefaults, maxCoinsPerCycle: 5 })).toBe(3);
  });

  it('respeita as reservas por recurso', () => {
    const resources = { wood: 100_000, stone: 90_000, iron: 80_000 };
    expect(planCoinMint(resources, { ...coinDefaults, maxCoinsPerCycle: 5, reserveWood: 50_000 })).toBe(1);
    expect(planCoinMint(resources, { ...coinDefaults, maxCoinsPerCycle: 5, reserveIron: 70_000 })).toBe(0);
  });

  it('gate affordable da origem: sem custo de 1 moeda → 0', () => {
    expect(planCoinMint({ wood: 28_000, stone: 30_000, iron: 24_999 }, coinDefaults)).toBe(0);
  });

  it('máximo da página entra como teto extra (fail-closed)', () => {
    const resources = { wood: 280_000, stone: 300_000, iron: 250_000 };
    expect(planCoinMint(resources, { ...coinDefaults, maxCoinsPerCycle: 10 }, 2)).toBe(2);
    expect(planCoinMint(resources, { ...coinDefaults, maxCoinsPerCycle: 10 }, 0)).toBe(0);
  });
});

describe('planCoinMintDetails (status didático "X de Y possíveis")', () => {
  it('possible ignora os tetos de ciclo/página; count respeita os dois', () => {
    const resources = { wood: 280_000 * 3, stone: 300_000 * 3, iron: 250_000 * 3 };
    const detalhes = planCoinMintDetails(resources, { ...coinDefaults, maxCoinsPerCycle: 2 });
    expect(detalhes).toEqual({ count: 2, possible: 30 });
    expect(planCoinMintDetails(resources, coinDefaults, 1)).toEqual({ count: 1, possible: 30 });
  });

  it('página com 0 moedas bloqueia o count, mas possible segue didático', () => {
    const resources = { wood: 280_000, stone: 300_000, iron: 250_000 };
    expect(planCoinMintDetails(resources, { ...coinDefaults, maxCoinsPerCycle: 10 }, 0)).toEqual({
      count: 0,
      possible: 10,
    });
  });

  it('gate affordable zera possible e count juntos', () => {
    const resources = { wood: 28_000, stone: 30_000, iron: 24_999 };
    expect(planCoinMintDetails(resources, coinDefaults)).toEqual({ count: 0, possible: 0 });
  });

  it('reservas contam no possible (excedente sobre a reserva)', () => {
    const resources = { wood: 100_000, stone: 90_000, iron: 80_000 };
    const detalhes = planCoinMintDetails(resources, {
      ...coinDefaults,
      maxCoinsPerCycle: 10,
      reserveIron: 70_000,
    });
    expect(detalhes.possible).toBe(0); // ferro: (80.000 − 70.000)/25.000 = 0
  });
});

describe('parseExchangeQuotes', () => {
  it('lê taxas na ordem madeira/argila/ferro, estoques e pontos premium', () => {
    const body = [
      'Troca Premium',
      '28.000 ⇄ 1',
      '30.000 ⇄ 1',
      '25.000 ⇄ 1',
      'Estoque 1.000 2.000 3.000',
    ].join('\n');
    const parsed = parseExchangeQuotes(body, '1.234');
    expect(parsed.quotes).toEqual({
      wood: { rate: 28_000, stock: 1_000 },
      stone: { rate: 30_000, stock: 2_000 },
      iron: { rate: 25_000, stock: 3_000 },
    });
    expect(parsed.premiumPoints).toBe(1234);
  });

  it('fora da tela de Troca Premium não produz cotações', () => {
    expect(parseExchangeQuotes('Mercado — enviar recursos', null).quotes).toEqual({});
    expect(parseExchangeQuotes('Mercado — enviar recursos', null).premiumPoints).toBe(0);
  });
});

const exchangeDefaults: ExchangeSettings = {
  minPremiumPoints: 0,
  maxPremiumPointsPerCycle: 0,
  batchSize: 1000,
  buyBelow: {},
  sellAbove: {},
};

describe('planExchangeStep', () => {
  const resources = { wood: 5_000, stone: 4_000, iron: 3_000 };
  const quotes = {
    wood: { rate: 28, stock: 500 },
    stone: { rate: 50, stock: 9_000 },
    iron: { rate: 40, stock: 9_000 },
  };

  it('compra quando o preço por mil fica abaixo do limiar (limitado por estoque)', () => {
    const { step } = planExchangeStep(quotes, 100, resources, { ...exchangeDefaults, buyBelow: { wood: 40 } });
    expect(step).toEqual({ direction: 'buy', resource: 'wood', amount: 500, pricePerThousand: 1000 / 28 });
  });

  it('limita a compra pelos pontos premium disponíveis', () => {
    const { step } = planExchangeStep(quotes, 10, resources, { ...exchangeDefaults, buyBelow: { wood: 40 } });
    expect(step?.amount).toBe(280); // floor(10 pontos × taxa 28)
  });

  it('limita a compra pelos pontos premium do ciclo', () => {
    const { step } = planExchangeStep(
      { wood: { rate: 100, stock: 9_000 } },
      10,
      resources,
      { ...exchangeDefaults, maxPremiumPointsPerCycle: 2, buyBelow: { wood: 20 } },
    );
    expect(step?.amount).toBe(200);
  });

  it('vende quando o preço por mil fica acima do limiar (limitado pelo saldo)', () => {
    const { step } = planExchangeStep(quotes, 10, resources, { ...exchangeDefaults, sellAbove: { stone: 15 } });
    expect(step).toEqual({ direction: 'sell', resource: 'stone', amount: 1000, pricePerThousand: 20 });
  });

  it('motivo pt-BR quando nada é atingido e gate de saldo premium', () => {
    expect(planExchangeStep(quotes, 10, resources, exchangeDefaults).reason).toBe(
      'Nenhuma regra de mercado foi atingida com as cotações atuais.',
    );
    expect(planExchangeStep(quotes, 5, resources, { ...exchangeDefaults, minPremiumPoints: 10 }).reason).toBe(
      'Saldo de Pontos Premium abaixo do mínimo configurado.',
    );
  });
});

const balanceDefaults: BalanceSettings = {
  reserve: { wood: 0, stone: 0, iron: 0 },
  minTransfer: 1000,
  maxDistance: 50,
  receiverX: 0,
  receiverY: 0,
  reserveMerchants: 0,
};

describe('planFallbackTransfer', () => {
  it('excedente sobre reservas limitado pela capacidade dos mercadores', () => {
    const transferable = planFallbackTransfer(
      { wood: 5_000, stone: 3_000, iron: 1_000 },
      2,
      1_000,
      { ...balanceDefaults, reserve: { wood: 1_000 } },
    );
    expect(transferable).toEqual({ wood: 2_000, stone: 2_000, iron: 1_000 });
  });
});

describe('pickLargestTransfer / transferTotal', () => {
  const transfers: BalanceTransferCandidate[] = [
    { donorId: '1', receiverId: '9', wood: 1_000, stone: 1_000, iron: 1_000, merchants: 3 },
    { donorId: '2', receiverId: '8', wood: 9_000, stone: 0, iron: 0, merchants: 9 },
    { donorId: '1', receiverId: '7', wood: 2_000, stone: 2_000, iron: 0, merchants: 4 },
  ];

  it('escolhe a maior carência que parte da aldeia atual', () => {
    expect(pickLargestTransfer(transfers, '1')?.receiverId).toBe('7');
    const biggest = transfers.find((transfer) => transfer.receiverId === '8');
    if (biggest === undefined) throw new Error('fixture ausente');
    expect(transferTotal(biggest)).toBe(9_000);
  });

  it('nada parte de uma doadora sem transferências', () => {
    expect(pickLargestTransfer(transfers, '3')).toBeUndefined();
  });
});

describe('recommendReceiverBelowAverage / receiverSuggestionLabel (auto-recomendação, sem autoenviar)', () => {
  const current: OverviewVillage = {
    id: '1',
    name: 'Rica',
    resources: { wood: 50_000, stone: 50_000, iron: 50_000 },
    x: 500,
    y: 500,
  };

  it('sugere a OUTRA aldeia com menos recursos, abaixo da média do conjunto', () => {
    const pobre: OverviewVillage = {
      id: '2',
      name: 'Pobreza',
      resources: { wood: 2_000, stone: 2_000, iron: 2_000 },
      x: 512,
      y: 478,
    };
    const media: OverviewVillage = { id: '3', name: 'Média', resources: { wood: 20_000, stone: 20_000, iron: 20_000 } };
    const suggestion = recommendReceiverBelowAverage([current, pobre, media], '1');
    expect(suggestion?.id).toBe('2');
    expect(suggestion?.total).toBe(6_000);
    expect(receiverSuggestionLabel(suggestion!)).toBe('Pobreza (512|478)');
  });

  it('sem outra aldeia abaixo da média não sugere ninguém', () => {
    const outra: OverviewVillage = { id: '2', name: 'Cheia', resources: { wood: 60_000, stone: 60_000, iron: 60_000 } };
    expect(recommendReceiverBelowAverage([current, outra], '1')).toBeUndefined();
  });

  it('só a aldeia atual lida = sem sugestão (nunca recomendaria enviar para si)', () => {
    expect(recommendReceiverBelowAverage([current], '1')).toBeUndefined();
  });

  it('empate absoluto (todas na média) não sugere', () => {
    const gemea: OverviewVillage = { id: '2', name: 'Gêmea', resources: { wood: 50_000, stone: 50_000, iron: 50_000 } };
    expect(recommendReceiverBelowAverage([current, gemea], '1')).toBeUndefined();
  });

  it('rótulo sem coordenada lida não inventa x|y', () => {
    const semCoords = recommendReceiverBelowAverage(
      [
        current,
        { id: '2', name: 'Só Recursos', resources: { wood: 1, stone: 1, iron: 1 } },
      ],
      '1',
    );
    expect(receiverSuggestionLabel(semCoords!)).toBe('Só Recursos (sem coordenada lida)');
  });
});

describe('formatarPtsMil / exchangeStatusLabel / ruleThresholdFor (status da Troca Premium)', () => {
  const settings: ExchangeSettings = {
    minPremiumPoints: 0,
    maxPremiumPointsPerCycle: 0,
    batchSize: 1000,
    buyBelow: { wood: 40 },
    sellAbove: { iron: 20.5 },
  };
  const compra: ExchangeDecision = { direction: 'buy', resource: 'wood', amount: 500, pricePerThousand: 1000 / 28 };
  const venda: ExchangeDecision = { direction: 'sell', resource: 'iron', amount: 1_000, pricePerThousand: 20 };

  it('preço com vírgula decimal (pt-BR)', () => {
    expect(formatarPtsMil(1000 / 28)).toBe('35,71');
    expect(formatarPtsMil(20)).toBe('20,00');
  });

  it('prévia cita verbo, quantia, recurso, preço e a regra que decidiu', () => {
    expect(exchangeStatusLabel(compra, 40, 'previa')).toBe(
      'Prévia: comprar 500 madeira a 35,71 pts/mil (regra: comprar abaixo de 40,00).',
    );
    expect(exchangeStatusLabel(venda, 20.5, 'previa')).toBe(
      'Prévia: vender 1000 ferro a 20,00 pts/mil (regra: vender acima de 20,50).',
    );
  });

  it('executada vai para o passado ("comprou N madeira a P pts/mil")', () => {
    expect(exchangeStatusLabel(compra, 40, 'executado')).toBe(
      'Troca Premium executada: comprou 500 madeira a 35,71 pts/mil.',
    );
  });

  it('limiar vem do mapa da direção certa (buyBelow/sellAbove)', () => {
    expect(ruleThresholdFor(compra, settings)).toBe(40);
    expect(ruleThresholdFor(venda, settings)).toBe(20.5);
    expect(
      ruleThresholdFor({ direction: 'sell', resource: 'stone', amount: 1, pricePerThousand: 1 }, settings),
    ).toBe(0);
  });
});
