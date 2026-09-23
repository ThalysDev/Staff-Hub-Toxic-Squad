// Partes PURAS novas da Onda 5b (ambiente node, sem DOM): modo percentual da
// cunhagem, regras por grupo e reservas por unidade da coleta, estratégia da
// Troca Premium, modelos por grupo e auto-pesquisa do recrutamento, alvos por
// coordenada do balanceador, visão Horas/PP/quests do construtor, agendamento
// do nobre da conquista, dedupe da agenda do Agendador de Itens, snapshot do
// plano unificado (Produção de Nobres) e a tela de doação do Doador de
// Prestígio.
import { describe, expect, it } from 'vitest';
import { decideMintWithPercent, normalizeKeepPercent, type CoinSettings } from './coin-center';
import { applyUnitReserves, parseGroupRules, ruleForGroup } from './collection';
import {
  allowedPremiumPoints,
  decideExchangeStrategy,
  exchangeStrategyStatusLabel,
  formatarPercent,
  normalizeExchangeStrategy,
  storageFillRatio,
  type ExchangeSettings,
} from './premium-exchange';
import { goalsFromModel, modelForGroup, parseGroupModels, parseResearchOptions, planResearch } from './recruitment';
import { buildTargetedTransfers, type OverviewVillage } from './resource-balancer';
import {
  buildBuilderQueueReport,
  estimateHoursUntilAffordable,
  estimatePpCost,
  formatHours,
  isQuestRewardLabel,
  normalizeQuestLabel,
} from './mega-builder';
import { candidateFromVillage, conquestTargetLabel, hasActiveNobleFor } from './conquista-livres';
import { syncScheduledActivation, type AtivadorItensSettings } from './ativador-itens';
import {
  biggestDonor,
  nobleMintHint,
  sanitizeVillageName,
  toUnifiedVillage,
  unifiedConfigFor,
  unifiedVillageId,
} from './producao-nobres';
import { DONATION_UNCONFIRMED, isAllyLevelScreen } from './doador-prestigio';
import { normalizeTroopModelStore, troopModelById } from '../../../ext/core/troop-models/troop-models';
import { planUnifiedBalance } from '../../../ext/modules/features/resource-balancer/unified-balancer-planner';
import type { HubSchedulerState, ScheduledCommandRecord } from '../../../ext/core/scheduler-state';

const coinDefaults: CoinSettings = {
  maxCoinsPerCycle: 1,
  reserveWood: 0,
  reserveStone: 0,
  reserveIron: 0,
  keepPercent: 0,
  coinCost: { wood: 28_000, stone: 30_000, iron: 25_000 },
};

describe('decideMintWithPercent (modo percentual da cunhagem)', () => {
  const resources = { wood: 280_000, stone: 300_000, iron: 250_000 };

  it('keepPercent 0 = comportamento de sempre (reservas fixas), sem mudar nada', () => {
    expect(decideMintWithPercent(resources, coinDefaults)).toEqual({ count: 1, possible: 10, keepPercent: 0 });
    expect(decideMintWithPercent(resources, { ...coinDefaults, keepPercent: 0, reserveWood: 100_000 })).toEqual({
      count: 1,
      possible: 6,
      keepPercent: 0,
    });
  });

  it('keepPercent > 0 mantém o percentual e cunha com o restante', () => {
    // 30% retido: madeira 196.000 → 7; argila 210.000 → 7; ferro 175.000 → 7.
    const plan = decideMintWithPercent(resources, { ...coinDefaults, keepPercent: 30, maxCoinsPerCycle: 10 });
    expect(plan).toEqual({ count: 7, possible: 7, keepPercent: 30 });
  });

  it('o máximo da página e o teto por ciclo continuam mandando', () => {
    expect(decideMintWithPercent(resources, { ...coinDefaults, keepPercent: 30, maxCoinsPerCycle: 3 })).toEqual({
      count: 3,
      possible: 7,
      keepPercent: 30,
    });
    expect(decideMintWithPercent(resources, { ...coinDefaults, keepPercent: 30, maxCoinsPerCycle: 10 }, 2)).toEqual({
      count: 2,
      possible: 7,
      keepPercent: 30,
    });
  });

  it('gate affordable vale nos dois modos (sem 1 moeda completa = 0)', () => {
    const poor = { wood: 27_999, stone: 300_000, iron: 250_000 };
    expect(decideMintWithPercent(poor, { ...coinDefaults, keepPercent: 30 })).toEqual({
      count: 0,
      possible: 0,
      keepPercent: 30,
    });
  });

  it('normalizeKeepPercent higieniza fora da faixa (0..90)', () => {
    expect(normalizeKeepPercent(undefined)).toBe(0);
    expect(normalizeKeepPercent(-10)).toBe(0);
    expect(normalizeKeepPercent(95)).toBe(90);
    expect(normalizeKeepPercent(33.9)).toBe(33);
  });
});

describe('parseGroupRules (regras de coleta por grupo)', () => {
  it('lê grupo:duração:lote:min com acento opcional e lote "tudo"', () => {
    expect(parseGroupRules('182608:grande:200:50')).toEqual({
      ok: true,
      rules: [{ groupId: 182608, duration: 'grande', lot: 200, minUnits: 50 }],
    });
    expect(parseGroupRules('182622:média:tudo:10')).toEqual({
      ok: true,
      rules: [{ groupId: 182622, duration: 'media', lot: 'tudo', minUnits: 10 }],
    });
    expect(parseGroupRules('182622:MEDIA:TUDO:10').ok).toBe(true);
  });

  it('linhas vazias são ruído; texto vazio = nenhuma regra', () => {
    expect(parseGroupRules('\n  \n')).toEqual({ ok: true, rules: [] });
  });

  it('linha inválida derruba o parse inteiro com a linha do erro (fail-closed)', () => {
    for (const bad of [
      '182608:grande:200', // 3 campos
      'zero:grande:200:50', // grupo inválido
      '182608:enorme:200:50', // duração inválida
      '182608:grande:0:50', // lote inválido
      '182608:grande:-5:50',
      '182608:grande:200:0', // mínimo inválido
      '182608:grande:200:50:extra', // 5 campos
    ]) {
      const parsed = parseGroupRules(bad);
      expect(parsed.ok).toBe(false);
      expect(!parsed.ok && parsed.reason).toMatch(/linha 1/);
    }
    const duplicated = parseGroupRules('182608:grande:200:50\n182608:media:10:5');
    expect(!duplicated.ok && duplicated.reason).toMatch(/repete o grupo 182608/);
  });

  it('ruleForGroup acha a regra do grupo e devolve null sem grupo/regra', () => {
    const parsed = parseGroupRules('182608:grande:200:50');
    if (!parsed.ok) throw new Error('fixture inválida');
    expect(ruleForGroup(parsed.rules, 182608)?.duration).toBe('grande');
    expect(ruleForGroup(parsed.rules, 999)).toBeNull();
    expect(ruleForGroup(parsed.rules, null)).toBeNull();
  });
});

describe('applyUnitReserves (reservas por unidade da coleta)', () => {
  it('desconta a reserva e mantém em 0 a unidade consumida por inteiro', () => {
    expect(applyUnitReserves({ spear: 300, sword: 100, spy: 5 }, { spear: 100, spy: 10 })).toEqual({
      spear: 200,
      sword: 100,
      spy: 0,
    });
  });

  it('reserva maior que o disponível zera (nunca negativo) e sem reservas nada muda', () => {
    expect(applyUnitReserves({ spear: 50 }, { spear: 500 })).toEqual({ spear: 0 });
    expect(applyUnitReserves({ spear: 50 }, {})).toEqual({ spear: 50 });
  });
});

const exchangeDefaults: ExchangeSettings = {
  minPremiumPoints: 0,
  maxPremiumPointsPerCycle: 0,
  batchSize: 1000,
  buyBelow: {},
  sellAbove: {},
  strategy: 'auto_taxa',
  ppLimit: 0,
  minTradeValue: 0,
};

const quotes = {
  wood: { rate: 28, stock: 9_000 },
  stone: { rate: 50, stock: 9_000 },
  iron: { rate: 40, stock: 9_000 },
};

describe('decideExchangeStrategy (estratégia da Troca Premium)', () => {
  it('auto_taxa (default) mantém as regras de preço e o rótulo antigo', () => {
    const decision = decideExchangeStrategy({
      quotes,
      premiumPoints: 100,
      resources: { wood: 5_000, stone: 4_000, iron: 3_000 },
      storage: {},
      settings: { ...exchangeDefaults, buyBelow: { wood: 40 } },
    });
    expect(decision.step).toMatchObject({ direction: 'buy', resource: 'wood', amount: 1000 });
    expect(decision.ruleLabel).toBe('regra: comprar abaixo de 40,00');
    expect(exchangeStrategyStatusLabel(decision.step!, decision.ruleLabel, 'previa')).toBe(
      'Prévia: comprar 1000 madeira a 35,71 pts/mil (regra: comprar abaixo de 40,00).',
    );
  });

  it('auto_necessidade compra o recurso com o MENOR % do armazém', () => {
    const decision = decideExchangeStrategy({
      quotes,
      premiumPoints: 100,
      resources: { wood: 90_000, stone: 10_000, iron: 60_000 },
      storage: { wood: 100_000, stone: 100_000, iron: 100_000 },
      settings: { ...exchangeDefaults, strategy: 'auto_necessidade' },
    });
    expect(decision.step).toMatchObject({ direction: 'buy', resource: 'stone', amount: 1000 });
    expect(decision.ruleLabel).toContain('maior necessidade');
    expect(decision.ruleLabel).toContain('argila em 10%');
  });

  it('auto_necessidade vende o recurso com a MAIOR sobra quando a compra não cabe', () => {
    const decision = decideExchangeStrategy({
      quotes: { wood: { rate: 28, stock: 9_000 }, stone: { rate: 50, stock: 9_000 }, iron: { rate: 40, stock: 0 } },
      premiumPoints: 0,
      resources: { wood: 90_000, stone: 20_000, iron: 95_000 },
      storage: { wood: 100_000, stone: 100_000, iron: 100_000 },
      settings: { ...exchangeDefaults, strategy: 'auto_necessidade' },
    });
    expect(decision.step).toMatchObject({ direction: 'sell', resource: 'iron', amount: 1000 });
    expect(decision.ruleLabel).toContain('maior sobra');
  });

  it('sem armazém legível a estratégia não decide (fail-closed)', () => {
    const decision = decideExchangeStrategy({
      quotes,
      premiumPoints: 100,
      resources: { wood: 1, stone: 2, iron: 3 },
      storage: {},
      settings: { ...exchangeDefaults, strategy: 'auto_necessidade' },
    });
    expect(decision.step).toBeNull();
    expect(decision.reason).toMatch(/armazém/);
  });

  it('ppLimit e minTradeValue limitam as duas estratégias', () => {
    const limited = decideExchangeStrategy({
      quotes,
      premiumPoints: 100,
      resources: { wood: 5_000, stone: 4_000, iron: 3_000 },
      storage: {},
      settings: { ...exchangeDefaults, buyBelow: { wood: 40 }, ppLimit: 2 },
    });
    expect(limited.step?.amount).toBe(56); // floor(2 × 28)
    const belowMinimum = decideExchangeStrategy({
      quotes,
      premiumPoints: 100,
      resources: { wood: 5_000, stone: 4_000, iron: 3_000 },
      storage: {},
      settings: { ...exchangeDefaults, buyBelow: { wood: 40 }, ppLimit: 2, minTradeValue: 100 },
    });
    expect(belowMinimum.step).toBeNull();
    expect(belowMinimum.reason).toMatch(/valor mínimo de troca/);
  });

  it('gate de pontos premium mínimo vale antes de qualquer estratégia', () => {
    const decision = decideExchangeStrategy({
      quotes,
      premiumPoints: 5,
      resources: { wood: 5_000, stone: 4_000, iron: 3_000 },
      storage: { wood: 100_000, stone: 100_000, iron: 100_000 },
      settings: { ...exchangeDefaults, strategy: 'auto_necessidade', minPremiumPoints: 10 },
    });
    expect(decision.reason).toBe('Saldo de Pontos Premium abaixo do mínimo configurado.');
  });

  it('helpers: estratégia normalizada, PP permitido, % do armazém e rótulo', () => {
    expect(normalizeExchangeStrategy(undefined)).toBe('auto_taxa');
    expect(normalizeExchangeStrategy('auto_necessidade')).toBe('auto_necessidade');
    expect(allowedPremiumPoints({ ...exchangeDefaults, ppLimit: 5, maxPremiumPointsPerCycle: 3 }, 100)).toBe(3);
    expect(allowedPremiumPoints({ ...exchangeDefaults, minPremiumPoints: 10 }, 4)).toBe(0);
    expect(storageFillRatio('wood', { wood: 25_000, stone: 0, iron: 0 }, { wood: 100_000 })).toBe(0.25);
    expect(storageFillRatio('wood', { wood: 25_000, stone: 0, iron: 0 }, {})).toBeNull();
    expect(formatarPercent(0.025)).toBe('2,5%');
    expect(formatarPercent(0.1)).toBe('10%');
    expect(formatarPercent(0.5)).toBe('50%');
    expect(formatarPercent(Number.POSITIVE_INFINITY)).toBe('?%');
  });
});

describe('parseGroupModels / modelForGroup (recrutamento por grupo)', () => {
  it('lê grupoId:modeloId (preset e custom)', () => {
    expect(parseGroupModels('182608:preset:ataque\n182622:custom:defesa-5k')).toEqual({
      ok: true,
      entries: [
        { groupId: 182608, modelId: 'preset:ataque' },
        { groupId: 182622, modelId: 'custom:defesa-5k' },
      ],
    });
  });

  it('linha ruim derruba o parse inteiro; grupo repetido também', () => {
    expect(parseGroupModels('182608').ok).toBe(false);
    expect(parseGroupModels('182608:modelo').ok).toBe(false);
    expect(parseGroupModels('zero:preset:ataque').ok).toBe(false);
    const duplicated = parseGroupModels('182608:preset:ataque\n182608:preset:defesa');
    expect(!duplicated.ok && duplicated.reason).toMatch(/repete o grupo/);
  });

  it('modelForGroup devolve o modelo do grupo (null sem grupo/regra)', () => {
    const parsed = parseGroupModels('182608:preset:ataque');
    if (!parsed.ok) throw new Error('fixture inválida');
    expect(modelForGroup(parsed.entries, 182608)).toBe('preset:ataque');
    expect(modelForGroup(parsed.entries, 1)).toBeNull();
    expect(modelForGroup(parsed.entries, null)).toBeNull();
  });
});

describe('goalsFromModel (metas do modelo do grupo)', () => {
  const store = normalizeTroopModelStore({});

  it('valor numérico vira meta absoluta; unidades fora do modelo não entram', () => {
    const model = troopModelById(store, 'preset:ataque')!;
    const custom = { ...model, units: { axe: 500, light: 200 } };
    expect(goalsFromModel(custom, { axe: 10, light: 1_000 })).toEqual({ axe: 500, light: 200 });
  });

  it("'max' mantém o efetivo atual (não gera déficit) e zero não entra", () => {
    const model = troopModelById(store, 'preset:ataque')!;
    expect(goalsFromModel(model, { axe: 100, light: 50 })).toEqual({ axe: 100, light: 50 });
    expect(goalsFromModel({ ...model, units: { axe: 0, light: 10 } }, { axe: 5, light: 5 })).toEqual({ light: 10 });
  });
});

describe('parseResearchOptions / planResearch (auto-pesquisa)', () => {
  it('só o link canônico action=research conta (fail-closed)', () => {
    const html = [
      '<a href="game.php?village=1&screen=smith&action=research&id=axe&h=abc">Pesquisar</a>',
      '<a href="game.php?village=1&screen=smith&action=research&type=light&h=abc">Pesquisar</a>',
      '<a href="game.php?village=1&screen=main&action=upgrade_building&id=smith">Ampliar</a>',
      '<a href="game.php?village=1&screen=smith&action=research&id=axe&h=abc">duplicado</a>',
      '<a href="game.php?village=1&screen=smith&action=research&id=catapulta">unidade desconhecida</a>',
    ].join('\n');
    expect(parseResearchOptions(html)).toEqual(['axe', 'light']);
  });

  it('página sem link de pesquisa devolve vazio (nunca afirma disponibilidade)', () => {
    expect(parseResearchOptions('<html><body>Ferreiro</body></html>')).toEqual([]);
  });

  it('planResearch cruza metas não pesquisadas com o que o Ferreiro oferece', () => {
    expect(planResearch(['axe', 'light', 'ram'], ['spear'], ['axe', 'ram', 'sword'])).toEqual(['axe', 'ram']);
    expect(planResearch(['axe'], ['axe'], ['axe'])).toEqual([]);
    expect(planResearch(['axe'], [], [])).toEqual([]);
  });
});

describe('buildTargetedTransfers (balanceador por coordenadas-alvo)', () => {
  const target: OverviewVillage = {
    id: '2',
    name: 'Alvo',
    resources: { wood: 1_000, stone: 1_000, iron: 1_000 },
    storage: 100_000,
    merchants: { available: 0, capacity: 1_000 },
    x: 500,
    y: 500,
  };
  const donor: OverviewVillage = {
    id: '1',
    name: 'Doadora',
    resources: { wood: 90_000, stone: 90_000, iron: 90_000 },
    storage: 100_000,
    merchants: { available: 100, capacity: 1_000 },
    x: 510,
    y: 500,
  };
  const options = { mode: 'igual' as const, reserveMerchants: 0, merchantCapacity: 1_000, maxDistance: 50, minTransfer: 1_000 };

  it('modo igual preenche a receptora na proporção 1/1/1 (teto de 95%)', () => {
    const result = buildTargetedTransfers([donor, target], [{ x: 500, y: 500 }], options);
    expect(result.unresolved).toEqual([]);
    expect(result.transfers).toHaveLength(1);
    const transfer = result.transfers[0]!;
    expect(transfer.donorId).toBe('1');
    expect(transfer.receiverId).toBe('2');
    // 95.000/3 = 31.666 por recurso, menos o que a receptora já tem (1.000).
    expect(transfer.wood).toBe(30_666);
    expect(transfer.stone).toBe(30_666);
    expect(transfer.iron).toBe(30_666);
    expect(transfer.merchants).toBe(92);
  });

  it('modo cunhagem usa a proporção do custo da moeda (28/30/25)', () => {
    const result = buildTargetedTransfers([donor, target], [{ x: 500, y: 500 }], { ...options, mode: 'cunhagem' });
    const transfer = result.transfers[0]!;
    // 95.000 × 28/83 = 32.048 (−1.000) e × 30/83 = 34.337 (−1.000).
    expect(transfer.wood).toBe(31_048);
    expect(transfer.stone).toBe(33_337);
    expect(transfer.iron).toBe(27_614);
  });

  it('coordenada que não é aldeia própria sai em unresolved (nada é inventado)', () => {
    const result = buildTargetedTransfers([donor, target], [{ x: 500, y: 500 }, { x: 999, y: 999 }], options);
    expect(result.unresolved).toEqual(['999|999']);
    expect(result.transfers).toHaveLength(1);
  });

  it('reserva de mercadores e transferência mínima limitam o plano', () => {
    const reserved = buildTargetedTransfers([donor, target], [{ x: 500, y: 500 }], { ...options, reserveMerchants: 100 });
    expect(reserved.transfers).toEqual([]);
    const highMinimum = buildTargetedTransfers([donor, target], [{ x: 500, y: 500 }], { ...options, minTransfer: 500_000 });
    expect(highMinimum.transfers).toEqual([]);
  });

  it('capacidade de mercadores limita a carga (enchimento guloso, como a engine)', () => {
    const few = buildTargetedTransfers(
      [{ ...donor, merchants: { available: 3, capacity: 1_000 } }, target],
      [{ x: 500, y: 500 }],
      options,
    );
    expect(few.transfers).toEqual([
      { donorId: '1', receiverId: '2', wood: 3_000, stone: 0, iron: 0, merchants: 3 },
    ]);
  });

  it('modo media usa a média corrigida das aldeias lidas como alvo', () => {
    const result = buildTargetedTransfers([donor, target], [{ x: 500, y: 500 }], { ...options, mode: 'media' });
    // média corrigida = (90.000 + 1.000)/2 = 45.500 por recurso.
    expect(result.transfers[0]?.wood).toBe(44_500);
  });
});

describe('relatório do construtor (visão Horas / PP)', () => {
  const pending = [
    { building: 'farm', targetLevel: 99 },
    { building: 'main', targetLevel: 20 },
  ];
  const costs = new Map<string, Partial<Record<'wood' | 'stone' | 'iron', number>>>([
    ['farm', { wood: 10_000 }],
    ['main', { wood: 5_000, stone: 5_000 }],
  ]);
  const resources = { wood: 5_000, stone: 0, iron: 0 };
  const production = { wood: 1_000, stone: 500, iron: 500 };

  it('visão fila sem comparação em PP não produz relatório (comportamento de sempre)', () => {
    expect(
      buildBuilderQueueReport({ pending, resources, production, costs, viewMode: 'fila', comparePp: false, ppFactor: 30 }),
    ).toBe('');
  });

  it('visão horas ordena pelo tempo estimado com o farm atual', () => {
    expect(
      buildBuilderQueueReport({ pending, resources, production, costs, viewMode: 'horas', comparePp: false, ppFactor: 30 }),
    ).toBe('Visão Horas (farm atual): 1) farm:99 ~5,0h; 2) main:20 ~10h.');
  });

  it('sem produção legível a fila sai na ordem, sem estimativa', () => {
    expect(
      buildBuilderQueueReport({ pending, resources, production: null, costs, viewMode: 'horas', comparePp: false, ppFactor: 30 }),
    ).toBe('Visão Horas: produção por hora não legível — fila na ordem: farm:99, main:20.');
  });

  it('item sem custo legível entra como "sem estimativa"', () => {
    const partial = new Map([['main', { wood: 5_000, stone: 5_000 }]]);
    expect(
      buildBuilderQueueReport({ pending, resources, production, costs: partial, viewMode: 'horas', comparePp: false, ppFactor: 30 }),
    ).toBe('Visão Horas (farm atual): 1) main:20 ~10h; sem estimativa: farm:99.');
  });

  it('comparação em PP usa o fator fixo e avisa quando o custo não foi lido', () => {
    expect(
      buildBuilderQueueReport({ pending, resources, production, costs, viewMode: 'fila', comparePp: true, ppFactor: 30 }),
    ).toBe('Custo em PP estimado (fator 30): farm:99 ~300 PP; main:20 ~300 PP.');
    const partial = new Map([['main', { wood: 5_000, stone: 5_000 }]]);
    expect(
      buildBuilderQueueReport({ pending, resources, production, costs: partial, viewMode: 'fila', comparePp: true, ppFactor: 30 }),
    ).toBe('Custo em PP estimado (fator 30): farm:99 (custo não lido); main:20 ~300 PP.');
  });

  it('estimativas puras: horas, PP e formato', () => {
    expect(estimateHoursUntilAffordable({ wood: 10_000 }, { wood: 5_000, stone: 0, iron: 0 }, production)).toBe(5);
    expect(estimateHoursUntilAffordable({ wood: 10_000 }, { wood: 5_000, stone: 0, iron: 0 }, null)).toBeNull();
    expect(estimateHoursUntilAffordable({}, { wood: 0, stone: 0, iron: 0 }, production)).toBeNull();
    expect(estimateHoursUntilAffordable({ wood: 1_000 }, { wood: 5_000, stone: 0, iron: 0 }, production)).toBe(0);
    expect(estimatePpCost({ wood: 10_000, stone: 10_000 }, 30)).toBe(600);
    expect(formatHours(0.5)).toBe('~30min');
    expect(formatHours(2.25)).toBe('~2,3h');
    expect(formatHours(12)).toBe('~12h');
  });

  it('rótulo de recompensa de quest é exato (nunca clica em dúvida)', () => {
    expect(normalizeQuestLabel('  Receber   Recompensa ')).toBe('receber recompensa');
    expect(isQuestRewardLabel('Receber recompensa')).toBe(true);
    expect(isQuestRewardLabel('Coletar recompensa')).toBe(true);
    expect(isQuestRewardLabel('Concluir')).toBe(false);
    expect(isQuestRewardLabel('Aceitar')).toBe(false);
    expect(isQuestRewardLabel(null)).toBe(false);
  });
});

describe('conquista-livres (helpers do agendamento do nobre)', () => {
  const barbara = { id: '123', name: 'Bárbara', x: 512, y: 478, points: 850 };

  it('candidato sai com owner 0 (aldeia livre) e coordenadas do village.txt', () => {
    expect(candidateFromVillage(barbara)).toEqual({
      id: '123',
      name: 'Bárbara',
      x: 512,
      y: 478,
      points: 850,
      ownerId: '0',
      farm: 0,
      barracos: 0,
    });
  });

  it('rótulo do alvo não inventa nome', () => {
    expect(
      conquestTargetLabel({
        id: '1',
        name: '',
        x: 1,
        y: 2,
        points: 0,
        distance: 0,
        loyalty: 100,
        noblesNeeded: 5,
        priority: 1,
        farm: 0,
        barracos: 0,
      }),
    ).toBe('aldeia livre (1|2)');
  });

  it('nobre ativo para o alvo é detectado; terminal libera o alvo', () => {
    const base: ScheduledCommandRecord = {
      id: 'cid_1',
      kind: 'noble',
      sourceVillageId: '1',
      target: { x: 512, y: 478 },
      units: { snob: 1 },
      timingMode: 'arrival',
      sendAt: '2026-09-23T10:00:00.000Z',
      paused: false,
      createdAt: '2026-09-23T09:00:00.000Z',
      events: [{ status: 'agendado', at: '2026-09-23T09:00:00.000Z' }],
    };
    const state: HubSchedulerState = { commands: [base], transit: [] };
    expect(hasActiveNobleFor(state, { x: 512, y: 478 })?.id).toBe('cid_1');
    expect(hasActiveNobleFor(state, { x: 1, y: 1 })).toBeUndefined();
    const sent: HubSchedulerState = {
      ...state,
      commands: [{ ...base, events: [...base.events, { status: 'enviado', at: '2026-09-23T10:00:01.000Z' }] }],
    };
    expect(hasActiveNobleFor(sent, { x: 512, y: 478 })).toBeUndefined();
  });
});

describe('ativador-itens (ordem do dedupe no sync da agenda)', () => {
  const settings: AtivadorItensSettings = { itemId: '4711', itemNome: 'Pacote', quando: '2026-09-23T20:30' };

  it('registro já criado é dedupe silencioso mesmo com o horário já vencido', () => {
    const primeiro = syncScheduledActivation([], settings, '42', Date.parse('2026-09-23T10:00'));
    expect(primeiro.criado).not.toBeNull();

    // Relógio depois do horário agendado: o par (item, horário) já existe, então
    // o ciclo não pode devolver "já passou" (mascararia o agendamento real).
    const depois = syncScheduledActivation(primeiro.agenda, settings, '42', Date.parse('2026-09-23T21:00'));

    expect(depois.criado).toBeNull();
    expect(depois.erro).toBeNull();
    expect(depois.agenda).toEqual(primeiro.agenda);
  });

  it('horário passado SEM registro criado continua recusado', () => {
    const recusado = syncScheduledActivation(
      [],
      { itemId: '1', itemNome: '', quando: '2026-09-23T09:00' },
      '42',
      Date.parse('2026-09-23T10:00'),
    );

    expect(recusado.criado).toBeNull();
    expect(recusado.erro).toContain('já passou');
  });
});

describe('producao-nobres (snapshot e folga do plano unificado)', () => {
  const current: OverviewVillage = {
    id: '79788',
    name: 'Capital',
    resources: { wood: 300_000, stone: 300_000, iron: 300_000 },
    storage: 300_000,
    merchants: { available: 10, capacity: 1_000 },
    x: 500,
    y: 500,
  };
  const needy: OverviewVillage = {
    id: '79789',
    name: 'Novata',
    resources: { wood: 5_000, stone: 5_000, iron: 5_000 },
    storage: 20_000,
    merchants: { available: 0, capacity: 1_000 },
    x: 510,
    y: 510,
  };

  it('id e nome entram no contrato da engine', () => {
    expect(unifiedVillageId('79788')).toBe('village_00079788');
    expect(unifiedVillageId('n79788')).toBe('village_00079788');
    expect(sanitizeVillageName('  <b>Rocha</b>  ')).toBe('b Rocha /b');
    expect(sanitizeVillageName('   ')).toBe('Aldeia');
    expect(toUnifiedVillage(needy).coordinate).toEqual({ x: 510, y: 510 });
    expect(toUnifiedVillage(needy).storageCapacity).toBe(20_000);
  });

  it('o snapshot montado é aceito pelo plano unificado (contrato strict)', () => {
    const plan = planUnifiedBalance({
      snapshot: {
        snapshotId: 'snapshot_00000000',
        accountId: 'account_00000000',
        worldId: 'world_000br142',
        revision: 1,
        capturedAt: new Date('2026-09-23T10:00:00.000Z').toISOString(),
        villages: [current, needy].map(toUnifiedVillage),
      },
      config: unifiedConfigFor('war'),
    });
    expect(plan.transfers.length).toBeGreaterThan(0);
    expect(plan.transfers[0]?.sourceVillageId).toBe('village_00079788');
  });

  it('a folga desconta as transferências do plano e o piso do preset', () => {
    const plan = planUnifiedBalance({
      snapshot: {
        snapshotId: 'snapshot_00000000',
        accountId: 'account_00000000',
        worldId: 'world_000br142',
        revision: 1,
        capturedAt: new Date('2026-09-23T10:00:00.000Z').toISOString(),
        villages: [current, needy].map(toUnifiedVillage),
      },
      config: unifiedConfigFor('war'),
    });
    const hint = nobleMintHint(
      '79788',
      { wood: 300_000, stone: 300_000, iron: 300_000 },
      300_000,
      plan,
      { wood: 28_000, stone: 30_000, iron: 25_000 },
      0.3,
    );
    // Piso 90.000; a novata (armazém 20.000, alvo 30% = 6.000) pede 1.000 de
    // cada recurso — o plano move 3 transferências de 1.000.
    expect(hint.keepFloor).toBe(90_000);
    expect(hint.outgoing.wood).toBe(1_000);
    expect(hint.outgoing.stone).toBe(1_000);
    expect(hint.outgoing.iron).toBe(1_000);
    expect(hint.surplusTotal).toBe(209_000 * 3);
    expect(hint.possible).toBe(6); // 209.000 / 30.000
    expect(biggestDonor(plan)).toBe('village_00079788');
  });

  it('sem transferências a folga é só o excedente sobre o piso', () => {
    const plan = planUnifiedBalance({
      snapshot: {
        snapshotId: 'snapshot_00000000',
        accountId: 'account_00000000',
        worldId: 'world_000br142',
        revision: 1,
        capturedAt: new Date('2026-09-23T10:00:00.000Z').toISOString(),
        villages: [toUnifiedVillage({ ...current, merchants: { available: 0, capacity: 1_000 } })],
      },
      config: unifiedConfigFor('war'),
    });
    const hint = nobleMintHint(
      '79788',
      { wood: 300_000, stone: 300_000, iron: 300_000 },
      300_000,
      plan,
      { wood: 28_000, stone: 30_000, iron: 25_000 },
      0.3,
    );
    expect(hint.outgoing.wood).toBe(0);
    expect(hint.possible).toBe(7); // (300.000 − 90.000)/30.000
  });

  it('preset war é o default do config (proporções e limites do preset)', () => {
    const config = unifiedConfigFor('war');
    expect(config.mode).toBe('war');
    expect(config.baseTargetRatio).toBe(0.3);
    expect(config.limits.maxDistance).toBe(20);
    expect(unifiedConfigFor('growth').baseTargetRatio).toBe(0.6);
  });
});

describe('doador-prestigio (detecção da tela)', () => {
  it('só a tela ally&mode=level é aceita', () => {
    expect(isAllyLevelScreen('?village=1&screen=ally&mode=level')).toBe(true);
    expect(isAllyLevelScreen('?screen=ally')).toBe(false);
    expect(isAllyLevelScreen('?screen=ally&mode=members')).toBe(false);
    expect(isAllyLevelScreen('?screen=snob')).toBe(false);
  });

  it('mensagem canônica da prévia sem confirmação', () => {
    expect(DONATION_UNCONFIRMED).toBe('ação de doação não confirmada — nada enviado');
  });
});
