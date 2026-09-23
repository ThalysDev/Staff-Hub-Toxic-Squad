// Plugin TSH 'producao-nobres' — Produção de Nobres (Onda 5b):
// - CONSOME o planUnifiedBalance (engine de 5 camadas do ext, até agora órfã):
//   o ciclo lê a Visualização "Combinada" (mesmo parser do balanceador), monta
//   o snapshot no contrato da engine e roda o plano com o preset escolhido
//   (growth/balanced/war — default 'war', o mais conservador);
// - "onde o plano indica": a aldeia aberta entra como DOADORA do plano (tem
//   folga) e a cunhagem usa o excedente que SOBRA depois das transferências
//   planejadas e do alvo do preset (armazém × baseTargetRatio) — as
//   transferências saem primeiro, a moeda vem do que não vai viajar;
// - na tela da Academia (screen 'snob') cunha via mintCoins (1 mutação por
//   ciclo, F2), limitada pelo máximo da própria página e pelo teto do ciclo;
//   fora dela (ou sem folga na aldeia aberta) o status ORIENTA onde cunhar;
// - custo da moeda vem dos settings do módulo Cunhagem (mesmo storage), com o
//   default br142 quando ele nunca foi configurado;
// - settings: preset (growth|balanced|war) e maxPpPerCycle (teto de segurança
//   do ciclo: o transporte atual cunha com RECURSOS e não gasta PP, então o
//   teto vale como limite de moedas cunhadas por ciclo — 0 = sem teto).

import { z } from 'zod';
import { registerTsh, type TshAutomation, type TshCycleContext } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import { loadSettings } from '../tsh-settings';
import { mintCoins } from '../tsh-transport';
import { pacedDoc } from '../../vanta/vanta-net';
import { parsePtBrInt } from '../../vanta/vanta-utils';
import { parseOverviewVillages, type OverviewVillage } from './resource-balancer';
import { DEFAULT_SETTINGS as COIN_DEFAULTS, readMintMax, type CoinResource } from './coin-center';
import {
  UNIFIED_BALANCE_PRESETS,
  planUnifiedBalance,
  type UnifiedBalanceMode,
  type UnifiedBalancePlan,
  type UnifiedBalanceResourceBundle,
  type UnifiedBalanceVillage,
} from '../../../ext/modules/features/resource-balancer/unified-balancer-planner';

const RESOURCES: readonly CoinResource[] = ['wood', 'stone', 'iron'];

const nobleSettings = z.object({
  preset: z.enum(['growth', 'balanced', 'war']).default('war'),
  /** Teto de segurança do ciclo (0 = sem teto; ver cabeçalho). */
  maxPpPerCycle: z.number().int().min(0).default(0),
});

type NobleSettings = z.infer<typeof nobleSettings>;

export const DEFAULT_SETTINGS: NobleSettings = { preset: 'war', maxPpPerCycle: 0 };

const SETTINGS_FORM: SettingsField[] = [
  {
    key: 'preset',
    label: 'Preset do plano unificado',
    type: 'select',
    options: [
      { value: 'war', label: 'Guerra (conservador: 20 campos, 30% retido)' },
      { value: 'balanced', label: 'Equilibrado (30 campos, 50% retido)' },
      { value: 'growth', label: 'Crescimento (50 campos, 60% retido)' },
    ],
    help: 'Preset da engine de balanceamento unificado que decide a folga das aldeias. Guerra é o mais conservador (doa menos e mais perto).',
  },
  {
    key: 'maxPpPerCycle',
    label: 'Teto de PP por ciclo',
    type: 'number',
    min: 0,
    max: 100_000,
    step: 1,
    help: 'Teto de segurança do ciclo. O transporte atual cunha com RECURSOS (não gasta PP), então o teto vale como limite de moedas cunhadas por ciclo; 0 = sem teto (só o máximo da página e a folga do plano limitam).',
  },
];

/** Capacidade de transporte por mercador usada no snapshot (padrão do repo). */
const MERCHANT_CAPACITY = 1_000;

/** Id no contrato da engine (`village_<8+ chars>`): id numérico com zeros à esquerda. */
export function unifiedVillageId(villageId: string): string {
  return `village_${villageId.replace(/^n/, '').padStart(8, '0')}`;
}

/** Nome seguro para o contrato da engine (sem HTML/URL; vazio vira "Aldeia"). */
export function sanitizeVillageName(name: string): string {
  const clean = name.replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean === '' ? 'Aldeia' : clean;
}

/** Aldeia da Visualização no contrato do snapshot unificado. */
export function toUnifiedVillage(village: OverviewVillage): UnifiedBalanceVillage {
  const capacity = Math.max(
    village.storage ?? 0,
    Math.max(village.resources.wood, village.resources.stone, village.resources.iron),
    1,
  );
  const resources: UnifiedBalanceResourceBundle = {
    wood: Math.min(village.resources.wood, capacity),
    clay: Math.min(village.resources.stone, capacity),
    iron: Math.min(village.resources.iron, capacity),
  };
  return {
    villageId: unifiedVillageId(village.id),
    name: sanitizeVillageName(village.name),
    coordinate: { x: village.x ?? 0, y: village.y ?? 0 },
    points: 5_000,
    population: 0,
    storageCapacity: capacity,
    resources,
    availableMerchants: village.merchants?.available ?? 0,
    groupIds: [],
    regionId: 0,
    construction: {
      queueState: 'idle',
      horizonNeed: { wood: 0, clay: 0, iron: 0 },
      nextItemCost: { wood: 0, clay: 0, iron: 0 },
    },
    permissions: { canDonate: true, canReceive: true },
  };
}

/** Config da engine a partir do preset (preset + defaults seguros do Hub). */
export function unifiedConfigFor(preset: UnifiedBalanceMode): Parameters<typeof planUnifiedBalance>[0]['config'] {
  const chosen = UNIFIED_BALANCE_PRESETS[preset];
  return {
    scriptId: 'unified-balancer',
    version: 1,
    mode: preset,
    enabled: true,
    periodHours: chosen.periodHours,
    aggressiveness: chosen.aggressiveness,
    constructionHorizonHours: chosen.constructionHorizonHours,
    baseTargetRatio: chosen.baseTargetRatio,
    smallVillages: { enabled: false, pointsThreshold: 0, storageTargetRatio: 0 },
    builtVillages: { enabled: false, pointsThreshold: 0, populationThreshold: 0, storageReserveRatio: 0 },
    merchants: { reserve: 0, capacity: MERCHANT_CAPACITY },
    regions: { enabled: false, count: 1 },
    limits: { maxDistance: chosen.maxDistance, maxTransfersPerCycle: chosen.maxTransfersPerCycle },
    blacklist: [],
    marketOffersEnabled: false,
  };
}

export interface NobleMintHint {
  /** Moedas possíveis com a folga desta aldeia. */
  possible: number;
  /** Recursos que as transferências do plano vão levar desta aldeia. */
  outgoing: Record<CoinResource, number>;
  /** Piso que fica na aldeia (armazém × baseTargetRatio do preset). */
  keepFloor: number;
  /** Total de folga acima do piso, já descontadas as transferências. */
  surplusTotal: number;
}

/**
 * Folga da aldeia para cunhar (PURA): parte dos recursos VIVOS da aldeia,
 * desconta o que as transferências do plano levam dela (o plano indica a
 * folga, e as transferências saem primeiro) e o piso do preset (armazém ×
 * baseTargetRatio). `possible` = min por recurso de floor(folga / custo).
 */
export function nobleMintHint(
  villageId: string,
  resources: Record<CoinResource, number>,
  storage: number,
  plan: UnifiedBalancePlan,
  coinCost: Record<CoinResource, number>,
  baseTargetRatio: number,
): NobleMintHint {
  const unifiedId = unifiedVillageId(villageId);
  const outgoing: Record<CoinResource, number> = { wood: 0, stone: 0, iron: 0 };
  for (const transfer of plan.transfers) {
    if (transfer.sourceVillageId !== unifiedId) continue;
    outgoing.wood += transfer.resources.wood;
    outgoing.stone += transfer.resources.clay;
    outgoing.iron += transfer.resources.iron;
  }
  const keepFloor = Math.floor(Math.max(0, storage) * baseTargetRatio);
  let surplusTotal = 0;
  const perResource: number[] = [];
  for (const resource of RESOURCES) {
    const surplus = Math.max(0, resources[resource] - outgoing[resource] - keepFloor);
    surplusTotal += surplus;
    const cost = coinCost[resource] ?? 0;
    perResource.push(cost > 0 ? Math.floor(surplus / cost) : 0);
  }
  return { possible: Math.max(0, Math.min(...perResource)), outgoing, keepFloor, surplusTotal };
}

/** Maior doadora do plano (para orientar quando a folga não está aqui). */
export function biggestDonor(plan: UnifiedBalancePlan): string | undefined {
  const totals = new Map<string, number>();
  for (const transfer of plan.transfers) {
    const total = transfer.resources.wood + transfer.resources.clay + transfer.resources.iron;
    totals.set(transfer.sourceVillageId, (totals.get(transfer.sourceVillageId) ?? 0) + total);
  }
  let best: string | undefined;
  let bestTotal = 0;
  for (const [id, total] of totals) {
    if (total > bestTotal) {
      best = id;
      bestTotal = total;
    }
  }
  return best;
}

/** Recursos vivos da barra da página (mesma leitura do resto da suíte). */
function readLiveResources(doc: Document): Record<CoinResource, number> | undefined {
  if (doc.querySelector('#wood, [data-resource="wood"], .resource-wood') === null) return undefined;
  const read = (resource: CoinResource): number => {
    const element = doc.querySelector<HTMLElement>(`#${resource}, [data-resource="${resource}"], .resource-${resource}`);
    const text =
      element instanceof HTMLInputElement || element instanceof HTMLSelectElement
        ? element.value
        : (element?.textContent ?? '');
    return parsePtBrInt(text);
  };
  return { wood: read('wood'), stone: read('stone'), iron: read('iron') };
}

/** Formulário canônico de cunhagem presente na página? (screen snob) */
function hasCoinForm(doc: Document): boolean {
  return doc.querySelector('form[action*="screen=snob"][action*="action=coin"]') !== null;
}

async function runCycle(ctx: TshCycleContext): Promise<void> {
  const parsed = nobleSettings.safeParse(ctx.storage.get('settings', DEFAULT_SETTINGS));
  if (!parsed.success) {
    ctx.status('Configurações da Produção de Nobres inválidas — nada foi feito.', 'warn');
    return;
  }
  const settings: NobleSettings = parsed.data;
  const currentId = ctx.villageId.replace(/^n/, '');
  // Custo da moeda: o que o módulo Cunhagem usa (mesmo storage por módulo).
  const coinSettings = loadSettings(ctx.world, 'coin-center', COIN_DEFAULTS);
  const coinCost: Record<CoinResource, number> = {
    wood: coinSettings.coinCost?.wood ?? COIN_DEFAULTS.coinCost.wood,
    stone: coinSettings.coinCost?.stone ?? COIN_DEFAULTS.coinCost.stone,
    iron: coinSettings.coinCost?.iron ?? COIN_DEFAULTS.coinCost.iron,
  };

  let villages: OverviewVillage[] = [];
  try {
    villages = parseOverviewVillages(
      await pacedDoc(`/game.php?village=${encodeURIComponent(ctx.villageId)}&screen=overview_villages`),
    );
  } catch {
    ctx.status('Não foi possível ler a Visualização "Combinada" — o plano unificado precisa dela; nada foi cunhado.', 'warn');
    return;
  }
  const current = villages.find((village) => village.id === currentId);
  if (current === undefined) {
    ctx.status('A aldeia aberta não aparece na Visualização "Combinada" — nada foi cunhado (rode de novo no próximo ciclo).', 'info');
    return;
  }
  const liveResources = readLiveResources(document);
  const effective: OverviewVillage = {
    ...current,
    ...(liveResources !== undefined ? { resources: liveResources } : {}),
  };

  let plan: UnifiedBalancePlan;
  try {
    plan = planUnifiedBalance({
      snapshot: {
        snapshotId: `snapshot_${'0'.repeat(8)}`,
        accountId: `account_${'0'.repeat(8)}`,
        worldId: `world_${ctx.world.replace(/[^a-z0-9-]/gi, '').toLowerCase().padStart(8, '0')}`,
        revision: 1,
        capturedAt: new Date().toISOString(),
        villages: villages.map((village) => (village.id === currentId ? toUnifiedVillage(effective) : toUnifiedVillage(village))),
      },
      config: unifiedConfigFor(settings.preset),
    });
  } catch {
    ctx.status('O plano unificado não pôde ser montado com a leitura atual (dados fora do contrato) — nada foi cunhado.', 'warn');
    return;
  }

  const storage = effective.storage ?? Math.max(effective.resources.wood, effective.resources.stone, effective.resources.iron);
  const baseTargetRatio = UNIFIED_BALANCE_PRESETS[settings.preset].baseTargetRatio;
  const hint = nobleMintHint(currentId, effective.resources, storage, plan, coinCost, baseTargetRatio);
  const planNote = `Plano unificado (${settings.preset}): ${plan.transfers.length} transferência(s), ${plan.statistics.resourcesMoved} recursos a mover; esta aldeia doa ${hint.outgoing.wood + hint.outgoing.stone + hint.outgoing.iron} e mantém ${hint.keepFloor} de piso.`;

  if (hint.possible < 1) {
    const donor = biggestDonor(plan);
    const guidance =
      donor !== undefined && donor !== unifiedVillageId(currentId)
        ? ` O plano indica folga em ${donor.replace(/^village_0*/, 'aldeia ')} — abra a Academia de lá para cunhar.`
        : ' O plano não indica folga para cunhagem nesta rodada (recursos no piso ou reservados para transferências).';
    ctx.status(`Nenhuma moeda a cunhar agora.${guidance} ${planNote}`, 'info');
    return;
  }

  if (!hasCoinForm(document)) {
    ctx.status(
      `O plano indica cunhar até ${hint.possible} moeda(s) nesta aldeia, mas o formulário da Academia não está nesta tela — abra screen=snob para cunhar. ${planNote}`,
      'info',
    );
    return;
  }
  const pageMax = readMintMax(document);
  const cycleCap = settings.maxPpPerCycle > 0 ? settings.maxPpPerCycle : hint.possible;
  const count = Math.max(0, Math.min(hint.possible, cycleCap, pageMax));
  if (count < 1) {
    ctx.status(
      `Cunhagem bloqueada pela página agora (0 moedas disponíveis; o plano indicaria até ${hint.possible}). ${planNote}`,
      'info',
    );
    return;
  }
  ctx.status(`Prévia: cunhar ${count} moeda(s) com a folga do plano (até ${hint.possible} possíveis). ${planNote}`, 'info');
  // F2: UMA mutação por ciclo — mintCoins com o lote cabível.
  await mintCoins(count);
  ctx.status(
    `Cunhagem enviada: ${count} moeda(s) (cada nobre consome 1 moeda + recursos). ${planNote}`,
    'ok',
  );
}

export const producaoNobresAutomation: TshAutomation = {
  id: 'producao-nobres',
  label: 'Produção de Nobres',
  desc: 'Roda o plano unificado de recursos (preset growth/balanced/war) e cunha moedas na Academia com a folga que sobra das transferências planejadas (1 cunhagem por ciclo).',
  category: 'economia',
  screen: 'snob',
  mutating: true,
  cooldownMs: 5 * 60_000,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  runCycle,
};

registerTsh(producaoNobresAutomation);
