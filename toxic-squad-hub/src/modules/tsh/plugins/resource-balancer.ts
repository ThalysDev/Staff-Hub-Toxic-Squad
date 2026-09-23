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
import { villageAt } from '../tsh-game-data';
import type { SettingsField } from '../tsh-settings';
import { sendResources, type SendResourcesPayload } from '../tsh-transport';
import { pacedDoc } from '../../vanta/vanta-net';
import { parsePtBrInt } from '../../vanta/vanta-utils';
import { parseCoordinateLines } from './op-generator';
import {
  correctedAverage,
  defaultBalancePolicy,
  planBalanceTransfers,
  type BalanceTransferCandidate,
  type BalanceVillage,
} from '../../../ext/modules/features/resource-balancer/resource-planner';

export type BalanceResource = 'wood' | 'stone' | 'iron';
const RESOURCES: readonly BalanceResource[] = ['wood', 'stone', 'iron'];

const RESOURCE_LABEL: Record<BalanceResource, string> = { wood: 'madeira', stone: 'argila', iron: 'ferro' };

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

const SETTINGS_FORM: SettingsField[] = [
  {
    key: 'reserveMerchants',
    label: 'Mercadores reservados',
    type: 'number',
    min: 0,
    max: 999,
    step: 1,
    help: 'Mercadores que ficam em casa em cada aldeia antes de um envio ser planejado.',
  },
  {
    key: 'maxDistance',
    label: 'Distância máxima (campos)',
    type: 'number',
    min: 1,
    max: 500,
    step: 1,
    help: 'Distância máxima, em campos do mapa, entre a aldeia doadora e a receptora.',
  },
  {
    key: 'minTransfer',
    label: 'Transferência mínima',
    type: 'number',
    min: 1,
    max: 1_000_000,
    step: 100,
    help: 'Modo aldeia única: só envia quando o excedente total atinge este mínimo de recursos.',
  },
  {
    key: 'receiverX',
    label: 'Aldeia receptora — X',
    type: 'number',
    min: 0,
    max: 999,
    step: 1,
    help: 'Coordenada X da receptora do modo aldeia única (0|0 = não configurado).',
  },
  {
    key: 'receiverY',
    label: 'Aldeia receptora — Y',
    type: 'number',
    min: 0,
    max: 999,
    step: 1,
    help: 'Coordenada Y da receptora do modo aldeia única (0|0 = não configurado).',
  },
  {
    key: 'mode',
    label: 'Modo de pesos',
    type: 'select',
    options: [
      { value: 'media', label: 'Média (comportamento de sempre)' },
      { value: 'cunhagem', label: 'Cunhagem (28/30/25 por moeda)' },
      { value: 'igual', label: 'Igual (1/1/1)' },
    ],
    help: 'Proporção desejada de recursos nas receptoras: Média usa a média corrigida da engine; Cunhagem prepara o armazém na proporção do custo da moeda (28/30/25); Igual equilibra os três recursos. Vale principalmente com as coordenadas-alvo abaixo.',
  },
  {
    key: 'targetCoordsText',
    label: 'Coordenadas-alvo (x|y por linha)',
    type: 'textarea',
    placeholder: '512|478\n534|551',
    help: 'Preenchido, o ciclo balanceia EM DIREÇÃO a essas aldeias (têm de ser aldeias suas lidas na Visualização) em vez da média. Linha inválida é ignorada com nota no status; coordenada que não for aldeia sua não recebe nada.',
  },
  {
    key: 'reserve',
    label: 'Reserva por recurso (nas doadoras)',
    type: 'record',
    help: 'Quantidade de cada recurso que FICA na aldeia (vale no modo aldeia única com receptora configurada; o modo multi-aldeias usa a política padrão da engine). 0 = sem reserva.',
    recordKeys: [
      { key: 'wood', label: 'Madeira', min: 0, step: 1000 },
      { key: 'stone', label: 'Argila', min: 0, step: 1000 },
      { key: 'iron', label: 'Ferro', min: 0, step: 1000 },
    ],
  },
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

/** Recursos do header da página; undefined quando o header não é legível. */
function readLiveResources(doc: Document): Record<BalanceResource, number> | undefined {
  if (doc.querySelector('#wood, [data-resource="wood"], .resource-wood') === null) return undefined;
  return {
    wood: readResourceValue(doc, 'wood'),
    stone: readResourceValue(doc, 'stone'),
    iron: readResourceValue(doc, 'iron'),
  };
}

function readResourceValue(doc: Document, resource: BalanceResource): number {
  const element = doc.querySelector<HTMLElement>(`#${resource}, [data-resource="${resource}"], .resource-${resource}`);
  if (element === null) return 0;
  const text =
    element instanceof HTMLInputElement || element instanceof HTMLSelectElement
      ? element.value
      : (element.textContent ?? '');
  return parsePtBrInt(text);
}

/** Mercadores do Mercado (porta do readMerchants do page-adapter). */
function readPageMerchants(doc: Document): { available: number; capacity: number } | undefined {
  const available = parsePtBrInt(doc.querySelector('#market_merchant_available_count')?.textContent ?? null);
  const total = parsePtBrInt(doc.querySelector('#market_merchant_total_count')?.textContent ?? null);
  const maxTransport = parsePtBrInt(doc.querySelector('#market_merchant_max_transport')?.textContent ?? null);
  if (total <= 0) return undefined;
  return { available, capacity: maxTransport > 0 ? Math.floor(maxTransport / total) : 1000 };
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

function resourcesLabel(resources: Record<BalanceResource, number>): string {
  return RESOURCES.map((resource) => `${RESOURCE_LABEL[resource]} ${resources[resource]}`).join(', ');
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

registerTsh({
  id: 'resource-balancer',
  label: 'Balanceador',
  desc: 'Distribui recursos entre doadoras e receptoras respeitando reservas (prévia sempre; máx. 1 envio por ciclo).',
  category: 'economia',
  screen: 'market',
  mutating: true,
  cooldownMs: 5 * 60_000,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  async runCycle(ctx) {
    const settings = ctx.storage.get('settings', DEFAULT_SETTINGS);
    const currentId = ctx.villageId.replace(/^n/, '');
    const liveResources = readLiveResources(document);
    const pageMerchants = readPageMerchants(document);

    let villages: OverviewVillage[] = [];
    try {
      villages = parseOverviewVillages(
        await pacedDoc(`/game.php?village=${encodeURIComponent(ctx.villageId)}&screen=overview_villages`),
      );
    } catch {
      // Visualização ilegível: segue só com a aldeia atual (ramo fallback).
    }

    // Sobreposição da aldeia atual pelos valores vivos da página (mais frescos
    // que a Visualização em cache de 60s).
    const currentIndex = villages.findIndex((village) => village.id === currentId);
    if (currentIndex >= 0) {
      const stored = villages[currentIndex];
      if (stored !== undefined) {
        villages[currentIndex] = {
          ...stored,
          ...(liveResources !== undefined ? { resources: liveResources } : {}),
          ...(pageMerchants !== undefined ? { merchants: pageMerchants } : {}),
        };
      }
    } else if (liveResources !== undefined) {
      villages.push({ id: currentId, name: 'Aldeia atual', resources: liveResources });
    }
    const current = villages.find((village) => village.id === currentId);
    const currentVillageName = current?.name ?? 'aldeia atual';
    const currentResources = liveResources ?? current?.resources ?? { wood: 0, stone: 0, iron: 0 };
    const currentMerchants = current?.merchants;
    const merchantCapacity = (currentMerchants?.capacity ?? 0) >= 100 ? (currentMerchants?.capacity ?? 0) : 1_000;
    // Modo higienizado (storage sujo não pode virar peso indefinido).
    const mode: BalanceMode = BALANCE_MODES.includes(settings.mode as BalanceMode)
      ? (settings.mode as BalanceMode)
      : 'media';

    // Alvos por coordenada (Onda 5b): preenchido, balanceia EM DIREÇÃO a essas
    // aldeias em vez da média. Linha inválida é ignorada com nota (parser do
    // op-generator); coordenada que não é aldeia própria lida não recebe nada.
    const targetCoords = typeof settings.targetCoordsText === 'string' ? settings.targetCoordsText.trim() : '';
    if (targetCoords !== '') {
      const parsedTargets = parseCoordinateLines(targetCoords);
      const targeted = buildTargetedTransfers(villages, parsedTargets.targets, {
        mode,
        reserveMerchants: settings.reserveMerchants,
        merchantCapacity,
        maxDistance: settings.maxDistance,
        minTransfer: settings.minTransfer,
      });
      const notes: string[] = [];
      if (parsedTargets.invalidLines.length > 0) {
        notes.push(`linha(s) inválida(s) ignorada(s): ${parsedTargets.invalidLines.slice(0, 5).join(', ')}`);
      }
      if (targeted.unresolved.length > 0) {
        notes.push(`coordenada(s) que não são aldeias suas lidas: ${targeted.unresolved.join(', ')}`);
      }
      const note = notes.length > 0 ? ` (${notes.join('; ')})` : '';
      if (targeted.transfers.length === 0) {
        ctx.status(`Alvos por coordenada: nenhuma transferência planejada neste ciclo${note}.`, 'info');
        return;
      }
      const chosen = pickLargestTransfer(targeted.transfers, currentId);
      if (chosen === undefined) {
        ctx.status(
          `Alvos por coordenada: ${targeted.transfers.length} transferência(s) planejada(s), nenhuma partindo desta aldeia${note}.`,
          'info',
        );
        return;
      }
      const receiver = villages.find((village) => village.id === chosen.receiverId);
      const destino = receiverTargetLabel({
        x: receiver?.x ?? 0,
        y: receiver?.y ?? 0,
        ...(receiver?.name !== undefined && receiver.name !== '' ? { name: receiver.name } : {}),
      });
      const carga = { wood: chosen.wood, stone: chosen.stone, iron: chosen.iron };
      ctx.status(
        `Alvos por coordenada (modo ${mode}): ${currentVillageName} → ${destino}: ${resourcesLabel(carga)}${note}…`,
        'info',
      );
      const payload: SendResourcesPayload = {
        wood: chosen.wood,
        stone: chosen.stone,
        iron: chosen.iron,
        receiverId: chosen.receiverId,
        ...(receiver?.x !== undefined && receiver.y !== undefined ? { target: { x: receiver.x, y: receiver.y } } : {}),
      };
      await sendResources(currentId, payload);
      ctx.status(`Envio executado: ${currentVillageName} → ${destino}: ${resourcesLabel(carga)}${note}.`, 'ok');
      return;
    }

    // Ramo engine da origem: >= 2 aldeias com mercadores/armazém conhecidos.
    const known = villages.filter((village) => village.merchants !== undefined || village.storage !== undefined);
    if (known.length >= 2) {
      const balances: BalanceVillage[] = villages.map((village) => ({
        id: village.id,
        resources: village.resources,
        storage: village.storage ?? Math.max(village.resources.wood, village.resources.stone, village.resources.iron, 1_000),
        // Pontos por aldeia não vinham no snapshot deste ramo na origem →
        // default 5.000 do plan() (perfil médio: alvo = média corrigida).
        points: 5_000,
        merchantsAvailable: village.merchants?.available ?? 0,
        ...(village.x !== undefined && village.y !== undefined ? { x: village.x, y: village.y } : {}),
      }));
      const transfers = planBalanceTransfers(balances, {
        ...defaultBalancePolicy,
        reserveMerchants: settings.reserveMerchants,
        merchantCapacity,
        maxDistance: settings.maxDistance,
      });
      const totalPlanned = transfers.reduce((sum, transfer) => sum + transferTotal(transfer), 0);
      const preview =
        transfers.length === 0
          ? 'Prévia: aldeias equilibradas — nenhuma transferência necessária.'
          : `Prévia: ${transfers.length} transferência(s) planejada(s), ${totalPlanned} recursos no total.`;
      const chosen = pickLargestTransfer(transfers, currentId);
      if (chosen === undefined) {
        ctx.status(`${preview} Nenhuma transferência parte desta aldeia neste ciclo.`, 'info');
        return;
      }
      const donorName = currentVillageName; // no ramo engine, a doadora é sempre a aldeia atual
      const receiver = villages.find((village) => village.id === chosen.receiverId);
      const target = await resolveReceiverTarget(receiver, settings);
      if (!target.ok) {
        if (target.reason === 'nao-configurada') {
          const suggestion = recommendReceiverBelowAverage(villages, currentId);
          ctx.status(
            suggestion === undefined
              ? 'A aldeia receptora planejada não tem coordenadas conhecidas (Visualizações ainda não leram).'
              : `A aldeia receptora planejada não tem coordenadas conhecidas. Sugestão (nada é enviado): usar ${receiverSuggestionLabel(suggestion)} como receptora — é a aldeia própria com menos recursos (${suggestion.total.toLocaleString('pt-BR')}) abaixo da média.`,
            'info',
          );
        } else {
          ctx.status(target.message, 'warn');
        }
        return;
      }
      const destino = receiverTargetLabel(target);
      const carga = { wood: chosen.wood, stone: chosen.stone, iron: chosen.iron };
      ctx.status(
        `${preview} Maior défice: ${donorName} → ${destino}: ${resourcesLabel(carga)}…`,
        'info',
      );
      const payload: SendResourcesPayload = {
        wood: chosen.wood,
        stone: chosen.stone,
        iron: chosen.iron,
        receiverId: chosen.receiverId,
        target: { x: target.x, y: target.y },
      };
      await sendResources(currentId, payload);
      ctx.status(
        `Envio executado: ${donorName} → ${destino}: ${resourcesLabel(carga)}. ${preview}`,
        'ok',
      );
      return;
    }

    // Ramo fallback da origem: receptora única por coordenadas configuradas.
    if (settings.receiverX === 0 && settings.receiverY === 0) {
      // 0|0 = não configurado: sugere outra aldeia própria abaixo da média
      // (apenas recomendação no status — NUNCA envia sem coordenada configurada).
      const suggestion = recommendReceiverBelowAverage(villages, currentId);
      ctx.status(
        suggestion === undefined
          ? 'As coordenadas da aldeia receptora não estão configuradas.'
          : `As coordenadas da aldeia receptora não estão configuradas (0|0). Sugestão (nada é enviado): ${receiverSuggestionLabel(suggestion)} — aldeia própria com menos recursos (${suggestion.total.toLocaleString('pt-BR')}) abaixo da média.`,
        'info',
      );
      return;
    }
    const merchants = currentMerchants?.available ?? 0;
    if (merchants < 1) {
      ctx.status('Nenhum mercador disponível nesta aldeia.', 'info');
      return;
    }
    const transferable = planFallbackTransfer(currentResources, merchants, merchantCapacity, settings);
    const total = RESOURCES.reduce((sum, resource) => sum + transferable[resource], 0);
    if (total < settings.minTransfer) {
      ctx.status('Nenhum excedente atinge a transferência mínima.', 'info');
      return;
    }
    // Coordenada manual do usuário: validada no mapa antes de qualquer envio.
    const target = await resolveReceiverTarget(undefined, settings);
    if (!target.ok) {
      ctx.status(target.reason === 'nao-configurada' ? 'As coordenadas da aldeia receptora não estão configuradas.' : target.message, 'warn');
      return;
    }
    const destino = receiverTargetLabel(target);
    ctx.status(`Prévia: enviar ${resourcesLabel(transferable)} de ${currentVillageName} → ${destino}…`, 'info');
    await sendResources(currentId, {
      wood: transferable.wood,
      stone: transferable.stone,
      iron: transferable.iron,
      target: { x: target.x, y: target.y },
    });
    ctx.status(`Envio executado: ${currentVillageName} → ${destino}: ${resourcesLabel(transferable)}.`, 'ok');
  },
});
