// Balanceamento de recursos — porta do plugin resource-balancer da extensão
// Toxic Squad Hub (toxic-squad-hub-ext/.../modules/features/resource-balancer/
// plugin.ts) sobre a ENGINE vendida em src/ext (resource-planner):
// - ramo engine (>= 2 aldeias conhecidas): aldeias lidas da Visualização
//   "Combinada" via pacedDoc (porta do readOverviewVillages do page-adapter),
//   com a aldeia atual sobreposta pelos valores vivos da página (header de
//   recursos + mercadores do Mercado); planBalanceTransfers com a MESMA
//   política da origem (defaultBalancePolicy + reserveMerchants +
//   merchantCapacity + maxDistance);
// - ramo fallback (aldeia única): excedente sobre as reservas limitado pela
//   capacidade dos mercadores, enviado para receiverX/receiverY — porta fiel
//   do ramo final do plan() da origem;
// - desvio documentado: o modo "advanced" (planUnifiedBalance) dependia do
//   registro multi-aldeia do Hub (hubWorldState), que não existe no
//   userscript — só o motor planBalanceTransfers é portado aqui;
// - receptora MANUAL (receiverX/receiverY): validada NO CICLO contra o mapa
//   (villageAt de ../tsh-game-data) — coordenada que não resolve para aldeia
//   existente rejeita o envio ("Receptora x|y não encontrada no mapa");
//   0|0 = não configurada → o status SUGERE outra aldeia própria com menos
//   recursos que a média (auto-recomendação, sem autoenviar);
// - PRÉVIA sempre (ctx.status cita doadora→receptora e quantias por recurso)
//   e F2: no máximo 1 sendResources por ciclo — o da MAIOR carência atendida.
// - Onda 5b: ALVOS POR COORDENADA (settings.targetCoordsText, "x|y" por linha,
//   parser compartilhado do op-generator) — preenchido, o ciclo balanceia EM
//   DIREÇÃO a essas aldeias (buildTargetedTransfers, puro) em vez da média; e
//   MODOS de peso (settings.mode): 'media' (média corrigida de sempre),
//   'cunhagem' (proporção do custo da moeda 28/30/25) e 'igual' (1/1/1). O
//   modo define a proporção desejada de recursos nas receptoras.

import { registerTsh } from '../tsh-runtime';
import { gm } from '../../../core/storage';
import { BALANCER_DEFAULTS, runSuperBalancer } from './super-balancer';
import { buildBalancerPanel } from './balancer-panel';
import { villageAt } from '../tsh-game-data';
import type { SettingsField } from '../tsh-settings';
import { parsePtBrInt } from '../../vanta/vanta-utils';
import {
  correctedAverage,
  type BalanceTransferCandidate,
  type BalanceVillage,
} from '../../../ext/modules/features/resource-balancer/resource-planner';

export type BalanceResource = 'wood' | 'stone' | 'iron';
const RESOURCES: readonly BalanceResource[] = ['wood', 'stone', 'iron'];


/** Modos do balanceador (Onda 5b): pesos da proporção desejada por recurso. */
export const BALANCE_MODES = Object.freeze(['media', 'cunhagem', 'igual'] as const);
export type BalanceMode = (typeof BALANCE_MODES)[number];

/**
 * Pesos por modo: 'media' = comportamento de sempre (peso 1 nos três, o alvo
 * por recurso vem da média corrigida); 'cunhagem' = proporção do custo da
 * moeda br142 (28/30/25 — armazém preparado para cunhar); 'igual' = 1/1/1
 * (armazém equilibrado entre os três recursos).
 */
export const BALANCE_MODE_WEIGHTS: Record<BalanceMode, Record<BalanceResource, number>> = {
  media: { wood: 1, stone: 1, iron: 1 },
  cunhagem: { wood: 28, stone: 30, iron: 25 },
  igual: { wood: 1, stone: 1, iron: 1 },
};

/** Fração do armazém usada como teto de preenchimento das receptoras. */
const RECEIVE_CAP_FACTOR = 0.95;

// Type alias (não interface) para continuar atribuível a Record<string, unknown>
// em settingsDefaults.
export type BalanceSettings = {
  reserve: Partial<Record<BalanceResource, number>>;
  minTransfer: number;
  maxDistance: number;
  receiverX: number;
  receiverY: number;
  reserveMerchants: number;
  /** Coordenadas-alvo "x|y" por linha (Onda 5b; vazio = média). */
  targetCoordsText?: string;
  /** Modo de pesos (Onda 5b; ausente = 'media'). */
  mode?: BalanceMode;
};

export const DEFAULT_SETTINGS: BalanceSettings = {
  reserve: { wood: 0, stone: 0, iron: 0 },
  minTransfer: 1000,
  maxDistance: 50,
  receiverX: 0,
  receiverY: 0,
  reserveMerchants: 0,
  targetCoordsText: '',
  mode: 'media',
};

const SUPER_FORM: SettingsField[] = [
  { key: 'focus', label: 'Foco: construção (%)', type: 'number', min: 0, max: 100, step: 5, help: '100 = só a fila do Construtor; 0 = só igualar os armazéns.' },
  { key: 'maxDistance', label: 'Distância máxima (campos)', type: 'number', min: 1, max: 999, step: 1, help: 'Nunca envia de mais longe que isto.' },
];


export interface OverviewVillage {
  id: string;
  name: string;
  resources: Record<BalanceResource, number>;
  storage?: number;
  merchants?: { available: number; capacity: number };
  x?: number;
  y?: number;
}

/** Id canônico do link de aldeia da Visualização (prefixo n removido). */
function villageIdFromLink(link: HTMLAnchorElement): string | undefined {
  const id = link.getAttribute('href')?.match(/[?&]village=n?(\d+)/)?.[1];
  return id ?? undefined;
}

/**
 * Visualização "Combinada" (porta do readOverviewVillages do page-adapter):
 * uma linha por aldeia com nome, coordenada "(x|y) K", recursos, armazém e
 * mercadores (colunas numéricas fora da célula do nome).
 */
export function parseOverviewVillages(doc: Document): OverviewVillage[] {
  const villages: OverviewVillage[] = [];
  for (const row of Array.from(doc.querySelectorAll<HTMLTableRowElement>('table.vis tr'))) {
    const link = row.querySelector<HTMLAnchorElement>('a[href*="village=n"]');
    if (link === null) continue;
    const id = villageIdFromLink(link);
    const rowText = row.textContent ?? '';
    const coord = rowText.match(/\((\d{1,3})\|(\d{1,3})\)\s*K\d+/);
    const name = (link.textContent ?? '').trim();
    if (id === undefined || name === '' || coord === null) continue;
    const cells = Array.from(row.querySelectorAll('td'))
      .filter((cell) => cell.querySelector('a[href*="village=n"]') === null)
      .map((cell) => (cell.textContent ?? '').trim());
    const numbers = cells.filter((value) => /^[\d.]+$/.test(value)).map((value) => parsePtBrInt(value));
    if (numbers.length < 4) continue;
    const [wood, stone, iron] = numbers;
    if (wood === undefined || stone === undefined || iron === undefined) continue;
    const village: OverviewVillage = {
      id,
      name,
      resources: { wood, stone, iron },
    };
    // 4º número = armazém; 5º = mercadores disponíveis.
    const storage = numbers[3];
    if (storage !== undefined && storage > 0) village.storage = storage;
    const merchants = numbers[4];
    if (merchants !== undefined && merchants > 0) village.merchants = { available: merchants, capacity: 1000 };
    const coordX = Number(coord[1]);
    const coordY = Number(coord[2]);
    if (Number.isFinite(coordX) && Number.isFinite(coordY)) {
      village.x = coordX;
      village.y = coordY;
    }
    villages.push(village);
  }
  return villages;
}




/** Total de recursos de uma transferência (carência atendida). */
export function transferTotal(transfer: BalanceTransferCandidate): number {
  return transfer.wood + transfer.stone + transfer.iron;
}

/** A maior transferência (maior défice atendido) que parte da aldeia atual. */
export function pickLargestTransfer(
  transfers: BalanceTransferCandidate[],
  donorId: string,
): BalanceTransferCandidate | undefined {
  const fromHere = transfers.filter((transfer) => transfer.donorId === donorId);
  if (fromHere.length === 0) return undefined;
  return fromHere.reduce((best, transfer) => (transferTotal(transfer) > transferTotal(best) ? transfer : best));
}

/**
 * Ramo fallback da origem: excedente sobre as reservas, limitado pela
 * capacidade de transporte dos mercadores disponíveis.
 */
export function planFallbackTransfer(
  resources: Record<BalanceResource, number>,
  merchantsAvailable: number,
  merchantCapacity: number,
  settings: BalanceSettings,
): Record<BalanceResource, number> {
  const capacity = merchantsAvailable * merchantCapacity;
  return Object.fromEntries(
    RESOURCES.map((resource) => {
      const surplus = Math.max(0, resources[resource] - (settings.reserve[resource] ?? 0));
      return [resource, Math.min(surplus, capacity)];
    }),
  ) as Record<BalanceResource, number>;
}


/** Aldeia própria recomendada como receptora (abaixo da média de recursos). */
export interface ReceiverSuggestion {
  id: string;
  name: string;
  /** Total de recursos (madeira+argila+ferro) lidos na Visualização. */
  total: number;
  x?: number;
  y?: number;
}

/**
 * Auto-recomendação de receptora (SEM autoenviar): entre as aldeias lidas na
 * Visualização "Combinada" (que são as próprias do jogador), a OUTRA aldeia
 * com menos recursos no total, desde que fique abaixo da média do conjunto
 * (média calculada incluindo a aldeia atual). undefined = ninguém abaixo da
 * média (ou nenhuma outra aldeia lida).
 */
export function recommendReceiverBelowAverage(
  villages: OverviewVillage[],
  currentId: string,
): ReceiverSuggestion | undefined {
  const others = villages.filter((village) => village.id !== currentId);
  if (others.length === 0) return undefined;
  const totalOf = (village: OverviewVillage): number =>
    village.resources.wood + village.resources.stone + village.resources.iron;
  const average = villages.reduce((sum, village) => sum + totalOf(village), 0) / villages.length;
  const poorest = others.reduce((best, village) => (totalOf(village) < totalOf(best) ? village : best));
  if (totalOf(poorest) >= average) return undefined;
  return {
    id: poorest.id,
    name: poorest.name,
    total: totalOf(poorest),
    ...(poorest.x !== undefined ? { x: poorest.x } : {}),
    ...(poorest.y !== undefined ? { y: poorest.y } : {}),
  };
}

/** Rótulo da recomendação: "Kalaria (512|478)" ou "Kalaria (sem coordenada)". */
export function receiverSuggestionLabel(suggestion: ReceiverSuggestion): string {
  if (suggestion.x !== undefined && suggestion.y !== undefined)
    return `${suggestion.name} (${suggestion.x}|${suggestion.y})`;
  return `${suggestion.name} (sem coordenada lida)`;
}

/** Receptora resolvida para o envio do ciclo. */
export type ResolvedReceiver =
  | { ok: true; x: number; y: number; name?: string }
  /** receiverX/receiverY em 0|0 (não configurado). */
  | { ok: false; reason: 'nao-configurada' }
  /** Coordenada manual não validada no mapa — envio rejeitado (fail-closed). */
  | { ok: false; reason: 'rejeitada'; message: string };

/**
 * Receptora do plano: coordenada lida da Visualização é do próprio jogo e
 * segue direto; a MANUAL (receiverX/receiverY) passa por villageAt — se não
 * resolver para aldeia existente no mapa, o envio é rejeitado com status
 * claro (mercadores não podem ir parar em coordenada errada).
 */
export async function resolveReceiverTarget(
  receiver: OverviewVillage | undefined,
  settings: BalanceSettings,
): Promise<ResolvedReceiver> {
  const overviewX = receiver?.x;
  const overviewY = receiver?.y;
  if (overviewX !== undefined && overviewY !== undefined) {
    const name = receiver?.name;
    return { ok: true, x: overviewX, y: overviewY, ...(name !== undefined && name !== '' ? { name } : {}) };
  }
  // P3 (revisão Onda 11-19): só o PAR 0|0 é "não configurada" — coordenada 0
  // em um eixo (aldeia válida em 0|500) precisa funcionar como receptora.
  if (settings.receiverX === 0 && settings.receiverY === 0) return { ok: false, reason: 'nao-configurada' };
  const manualX = settings.receiverX;
  const manualY = settings.receiverY;
  try {
    const found = await villageAt(manualX, manualY);
    if (found === null)
      return {
        ok: false,
        reason: 'rejeitada',
        message: `Receptora ${manualX}|${manualY} não encontrada no mapa — revise as coordenadas; nada foi enviado.`,
      };
    return { ok: true, x: manualX, y: manualY, ...(found.name !== '' ? { name: found.name } : {}) };
  } catch {
    return {
      ok: false,
      reason: 'rejeitada',
      message: `Não foi possível conferir o mapa para validar a receptora ${manualX}|${manualY} — nada foi enviado.`,
    };
  }
}

/** Rótulo do destino: "Nome (512|478)" ou "(512|478)". */
export function receiverTargetLabel(target: { x: number; y: number; name?: string }): string {
  return target.name !== undefined ? `${target.name} (${target.x}|${target.y})` : `(${target.x}|${target.y})`;
}

// ── Balanceamento por coordenadas-alvo (Onda 5b — puro e testável) ──────────

export interface TargetedTransferOptions {
  mode: BalanceMode;
  reserveMerchants: number;
  merchantCapacity: number;
  maxDistance: number;
  /** Só transferências com este total (ou mais) entram no plano. */
  minTransfer: number;
}

export interface TargetedTransferResult {
  transfers: BalanceTransferCandidate[];
  /** Coordenadas-alvo que não são aldeias próprias lidas (fail-closed). */
  unresolved: string[];
}

/** Total de recursos de uma aldeia (madeira+argila+ferro). */
function villageTotal(resources: Record<BalanceResource, number>): number {
  return resources.wood + resources.stone + resources.iron;
}

/** Aldeia da Visualização na forma que a engine de média corrigida consome. */
function asBalanceVillage(village: OverviewVillage): BalanceVillage {
  return {
    id: village.id,
    resources: village.resources,
    storage: Math.max(
      village.storage ?? 0,
      Math.max(village.resources.wood, village.resources.stone, village.resources.iron),
      1,
    ),
    points: 5_000, // perfil médio (mesmo default do ramo engine deste plugin)
    merchantsAvailable: village.merchants?.available ?? 0,
    ...(village.x !== undefined && village.y !== undefined ? { x: village.x, y: village.y } : {}),
  };
}

/** Médias corrigidas por recurso (só no modo 'media', como a engine de sempre). */
function correctedAverages(villages: OverviewVillage[]): Record<BalanceResource, number> {
  const balances = villages.map(asBalanceVillage);
  return {
    wood: correctedAverage(balances, 'wood'),
    stone: correctedAverage(balances, 'stone'),
    iron: correctedAverage(balances, 'iron'),
  };
}

/**
 * Nível desejado de UM recurso: no modo 'media' é a média corrigida das
 * aldeias lidas (o alvo da engine de sempre); nos modos de peso é a fração do
 * teto de preenchimento na proporção do modo (cunhagem 28/30/25, igual 1/1/1).
 */
function desiredLevel(
  resource: BalanceResource,
  capacity: number,
  mode: BalanceMode,
  averages: Record<BalanceResource, number> | null,
): number {
  if (mode === 'media' && averages !== null) return Math.floor(averages[resource]);
  const weights = BALANCE_MODE_WEIGHTS[mode];
  const total = RESOURCES.reduce((sum, entry) => sum + weights[entry], 0);
  return Math.floor((capacity * RECEIVE_CAP_FACTOR * weights[resource]) / total);
}

/**
 * Transferências EM DIREÇÃO às coordenadas-alvo (PURA, Onda 5b): as aldeias
 * próprias lidas na Visualização que estão nas coordenadas pedidas são as
 * receptoras; as DEMAIS aldeias próprias são doadoras do que exceder o nível
 * desejado do modo (média corrigida em 'media'; proporção 28/30/25 em
 * 'cunhagem'; 1/1/1 em 'igual'). Guloso: receptoras mais vazias primeiro,
 * doadora mais próxima primeiro, respeitando mercadores reservados,
 * capacidade de transporte, distância máxima e o teto de 95% do armazém da
 * receptora. Coordenada que não casa com aldeia própria lida sai em
 * `unresolved` (o ciclo avisa e não envia — nunca inventa destino).
 */
export function buildTargetedTransfers(
  villages: OverviewVillage[],
  targetCoords: ReadonlyArray<{ x: number; y: number }>,
  options: TargetedTransferOptions,
): TargetedTransferResult {
  const unresolved: string[] = [];
  const targets: OverviewVillage[] = [];
  for (const coordinate of targetCoords) {
    const match = villages.find((village) => village.x === coordinate.x && village.y === coordinate.y);
    if (match === undefined) {
      unresolved.push(`${coordinate.x}|${coordinate.y}`);
      continue;
    }
    if (!targets.some((target) => target.id === match.id)) targets.push(match);
  }
  const averages = options.mode === 'media' ? correctedAverages(villages) : null;
  const targetIds = new Set(targets.map((target) => target.id));
  const donors = villages.filter((village) => !targetIds.has(village.id));
  const transfers = new Map<string, BalanceTransferCandidate & { remainingMerchants: number }>();
  const remainingNeed = new Map<string, Record<BalanceResource, number>>();
  for (const target of targets) {
    const capacity = Math.max(
      target.storage ?? 0,
      Math.max(target.resources.wood, target.resources.stone, target.resources.iron),
    );
    const ceiling = target.storage !== undefined && target.storage > 0 ? target.storage : capacity;
    const need: Record<BalanceResource, number> = { wood: 0, stone: 0, iron: 0 };
    for (const resource of RESOURCES) {
      const desired = Math.min(
        desiredLevel(resource, capacity, options.mode, averages),
        Math.floor(ceiling * RECEIVE_CAP_FACTOR),
      );
      need[resource] = Math.max(0, desired - target.resources[resource]);
    }
    if (villageTotal(need) > 0) remainingNeed.set(target.id, need);
  }
  const ordered = [...remainingNeed.entries()].sort((left, right) => {
    const byNeed = villageTotal(right[1]) - villageTotal(left[1]);
    return byNeed !== 0 ? byNeed : left[0].localeCompare(right[0]);
  });
  for (const [targetId, need] of ordered) {
    const target = targets.find((candidate) => candidate.id === targetId);
    if (target === undefined || target.x === undefined || target.y === undefined) continue;
    const targetX = target.x;
    const targetY = target.y;
    const candidates = donors
      .filter((donor) => donor.x !== undefined && donor.y !== undefined)
      .map((donor) => ({ donor, distance: Math.hypot((donor.x ?? 0) - targetX, (donor.y ?? 0) - targetY) }))
      .filter(({ distance }) => options.maxDistance <= 0 || distance <= options.maxDistance)
      .sort((left, right) => left.distance - right.distance || left.donor.id.localeCompare(right.donor.id));
    for (const { donor } of candidates) {
      const key = `${donor.id}->${targetId}`;
      const current = transfers.get(key) ?? {
        donorId: donor.id,
        receiverId: targetId,
        wood: 0,
        stone: 0,
        iron: 0,
        merchants: 0,
        remainingMerchants: Math.max(0, (donor.merchants?.available ?? 0) - options.reserveMerchants),
      };
      if (current.remainingMerchants <= 0) continue;
      const donorCapacity = Math.max(
        donor.storage ?? 0,
        Math.max(donor.resources.wood, donor.resources.stone, donor.resources.iron),
      );
      for (const resource of RESOURCES) {
        const wanted = need[resource] ?? 0;
        if (wanted <= 0) continue;
        const keep = Math.min(
          desiredLevel(resource, donorCapacity, options.mode, averages),
          Math.floor(donorCapacity * RECEIVE_CAP_FACTOR),
        );
        const surplus = Math.max(0, donor.resources[resource] - keep);
        if (surplus <= 0) continue;
        const room = current.remainingMerchants * options.merchantCapacity;
        const send = Math.min(wanted, surplus, room);
        if (send <= 0) continue;
        current[resource] += send;
        need[resource] = wanted - send;
        const used = Math.ceil((current.wood + current.stone + current.iron) / options.merchantCapacity);
        current.remainingMerchants = Math.max(
          0,
          (donor.merchants?.available ?? 0) - options.reserveMerchants - used,
        );
        current.merchants = used;
      }
      if (current.wood + current.stone + current.iron > 0) transfers.set(key, current);
    }
  }
  const planned = Array.from(transfers.values())
    .filter((transfer) => transfer.wood + transfer.stone + transfer.iron >= Math.max(1, options.minTransfer))
    .map(({ remainingMerchants: _ignored, ...transfer }) => transfer);
  return { transfers: planned, unresolved };
}

// v3.11.0: o módulo passa a ser o SUPER BALANCEADOR (super-balancer.ts). As
// funções acima seguem exportadas (Mercado Premium, Produção de Nobres, testes).
registerTsh({
  id: 'resource-balancer',
  label: 'Balanceador',
  desc: 'Equilibra os recursos entre todas as aldeias (ou abastece as escolhidas), em segundo plano, pelo "Pedido" do Mercado: vizinhas primeiro, recursos a caminho descontados, pequenas com prioridade.',
  category: 'economia',
  screen: null,
  mutating: true,
  cooldownMs: 30 * 60_000,
  settingsForm: SUPER_FORM,
  settingsDefaults: BALANCER_DEFAULTS,
  settingsPanel: (settings) => buildBalancerPanel(settings),
  async runCycle(ctx) {
    // Envio em massa: só depois de o dono abrir Configurar e salvar (opt-in explícito).
    const raw = gm.get<Record<string, unknown> | null>(`tsh-auto:${ctx.world}:resource-balancer:settings`, null);
    if (raw === null || raw.v311 !== true) {
      ctx.status('O Balanceador ainda não está ativo. Abra Configurar, escolha o que ele deve fazer e clique em Salvar — até lá nenhum recurso é enviado.', 'info');
      return;
    }
    await runSuperBalancer(ctx);
  },
});
