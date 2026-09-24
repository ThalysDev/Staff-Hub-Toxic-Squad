// Construtor em SEGUNDO PLANO (v3.9.0) — puro/testável. Fontes verificadas no
// BR142 em 24/09/2026 (fixtures reais):
//   /interface.php?func=get_building_info → base e fator de custo por edifício
//     (custo do nível N = base × fator^(N−1); ex.: Ed. principal 25 = 23.075)
//   overview_villages&mode=buildings      → níveis de cada aldeia + fila
//     (ícones buildings/<edifício>.webp, até 5 itens)
//   overview_villages&mode=prod           → recursos, armazém e fazenda
// Regras que vieram do construtor antigo do dono (TIKA 5.3): fazenda primeiro
// quando a população livre fica baixa; armazém primeiro quando ele é pequeno
// demais para o próximo custo.

export const BUILDINGS = [
  'main', 'barracks', 'stable', 'garage', 'watchtower', 'snob', 'smith', 'place', 'statue', 'market',
  'wood', 'stone', 'iron', 'farm', 'storage', 'hide', 'wall',
] as const;
export type BuildingId = (typeof BUILDINGS)[number];

export interface BuildingInfo {
  maxLevel: number;
  wood: number;
  stone: number;
  iron: number;
  pop: number;
  woodF: number;
  stoneF: number;
  ironF: number;
  popF: number;
}

/** get_building_info (XML) → base e fatores. null = formato inesperado. */
export function parseBuildingInfo(xml: string): Partial<Record<BuildingId, BuildingInfo>> | null {
  const out: Partial<Record<BuildingId, BuildingInfo>> = {};
  // Leitura SEQUENCIAL dos campos: o edifício "wood" (Bosque) tem o mesmo nome
  // da tag de custo <wood>, então não dá para recortar o bloco por </wood>.
  for (const b of BUILDINGS) {
    const m = new RegExp(
      `<${b}>\\s*<max_level>(\\d+)</max_level>\\s*<min_level>\\d+</min_level>\\s*<wood>([\\d.]+)</wood>\\s*<stone>([\\d.]+)</stone>\\s*<iron>([\\d.]+)</iron>\\s*<pop>([\\d.]+)</pop>\\s*<wood_factor>([\\d.]+)</wood_factor>\\s*<stone_factor>([\\d.]+)</stone_factor>\\s*<iron_factor>([\\d.]+)</iron_factor>\\s*<pop_factor>([\\d.]+)</pop_factor>`,
    ).exec(xml);
    if (m === null) continue;
    const [maxLevel, wood, stone, iron, pop, woodF, stoneF, ironF, popF] = m.slice(1).map(Number);
    const info = { maxLevel, wood, stone, iron, pop, woodF, stoneF, ironF, popF } as BuildingInfo;
    if (Object.values(info).some((v) => !Number.isFinite(v))) return null;
    out[b] = info;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Custo do nível `level` (o nível que será construído). */
export function costAt(info: BuildingInfo, level: number): { wood: number; stone: number; iron: number } {
  const k = Math.max(0, level - 1);
  return {
    wood: Math.round(info.wood * info.woodF ** k),
    stone: Math.round(info.stone * info.stoneF ** k),
    iron: Math.round(info.iron * info.ironF ** k),
  };
}

export interface BuildVillage {
  id: string;
  name: string;
  levels: Partial<Record<BuildingId, number>>;
  /** Edifícios na fila, em ordem. */
  queue: BuildingId[];
  /** Coordenadas (para as regras por coordenada). */
  x?: number;
  y?: number;
  /** Quando termina o ÚLTIMO item da fila (quadro do servidor, ms). null = sem fila/ilegível. */
  queueEndsAt?: number | null;
}

/**
 * "hoje às 15:56", "amanhã às 02:15", "em 26.09. às 09:32" (hora do servidor)
 * → ms no mesmo quadro de `nowFrameMs` (Date local sobre o relógio do servidor).
 */
export function parseQueueTime(text: string, nowFrameMs: number): number | null {
  const t = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (t === null) return null;
  const now = new Date(nowFrameMs);
  let [y, mo, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
  const low = text.toLowerCase();
  if (/amanh[ãa]/.test(low)) d += 1;
  else if (!low.includes('hoje')) {
    const dm = /(\d{1,2})\.(\d{1,2})\./.exec(low);
    if (dm === null) return null;
    d = Number(dm[1]);
    mo = Number(dm[2]) - 1;
    if (mo < now.getMonth() - 6) y += 1;
  }
  const ms = new Date(y, mo, d, Number(t[1]), Number(t[2]), Number(t[3] ?? 0)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

const num = (s: string | undefined): number => Number((s ?? '').replace(/<[^>]+>/g, '').replace(/\./g, '').trim());

/** Visão de Edifícios. null = tabela ausente/inesperada. */
export function parseBuildingsOverview(html: string, nowFrameMs = Date.now()): { villages: BuildVillage[]; full: boolean } | null {
  const table = /<table id="buildings_table"[\s\S]*?<\/table>/.exec(html)?.[0];
  if (table === undefined) return null;
  const villages: BuildVillage[] = [];
  for (const m of table.matchAll(/<tr id="v_(\d+)"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const row = m[2] ?? '';
    const name = /data-text="([^"]*)"/.exec(row)?.[1] ?? '';
    const levels: Partial<Record<BuildingId, number>> = {};
    for (const b of BUILDINGS) {
      const cell = new RegExp(`class="upgrade_building b_${b}">([\\s\\S]*?)</td>`).exec(row)?.[1];
      if (cell === undefined) {
        if (b === 'main') return null; // sem o Ed. principal a tabela não é a esperada
        continue; // edifício que não existe neste mundo (torre, estátua…)
      }
      levels[b] = num(cell);
    }
    const icons = [...row.matchAll(/class="queue_icon"><img src="[^"]*graphic\/buildings\/(\w+)\.(?:webp|png)" title="([^"]*)"/g)];
    const queue = icons.map((q) => q[1] as BuildingId).filter((b) => (BUILDINGS as readonly string[]).includes(b));
    const lastTitle = icons[icons.length - 1]?.[2];
    // A ÚLTIMA "(x|y)" antes do "K55": o nome da aldeia pode conter outra.
    const coords = /\((\d{1,3})\|(\d{1,3})\)\s*K\d+/.exec(row) ?? [...row.matchAll(/\((\d{1,3})\|(\d{1,3})\)/g)].at(-1) ?? null;
    villages.push({
      id: m[1] ?? '',
      name: name.replace(/&amp;/g, '&'),
      levels,
      queue,
      ...(coords !== null ? { x: Number(coords[1]), y: Number(coords[2]) } : {}),
      queueEndsAt: lastTitle === undefined ? null : parseQueueTime(lastTitle, nowFrameMs),
    });
  }
  return { villages, full: villages.length >= 1000 };
}

export interface ProdVillage {
  id: string;
  res: { wood: number; stone: number; iron: number };
  storage: number;
  farm: { used: number; max: number };
  /** v3.11.0 (Balanceador): nome, coordenada, pontos e mercadores livres/total. */
  name?: string;
  x?: number;
  y?: number;
  points?: number;
  merchants?: { free: number; total: number };
}

/** Visão de Produção. null = tabela ausente/inesperada. */
export function parseProdOverview(html: string): ProdVillage[] | null {
  const table = /<table id="production_table"[\s\S]*?<\/table>/.exec(html)?.[0];
  if (table === undefined) return null;
  const out: ProdVillage[] = [];
  for (const m of table.matchAll(/<tr class="nowrap row_[ab]">([\s\S]*?)<\/tr>/g)) {
    const row = m[1] ?? '';
    const id = /data-id="(\d+)"/.exec(row)?.[1];
    const wood = /class="res wood">([\s\S]*?)<\/span> <span/.exec(row)?.[1];
    const stone = /class="res stone">([\s\S]*?)<\/span> <span/.exec(row)?.[1];
    const iron = /class="res iron">([\s\S]*?)<\/span>\s*<\/td>/.exec(row)?.[1];
    const storage = /<\/td> <td>(\d+)<\/td> <td><a href="[^"]*screen=market">/.exec(row)?.[1];
    const farm = /<td class="[^"]*">(\d+)\/(\d+)<\/td>/.exec(row);
    if (id === undefined || wood === undefined || stone === undefined || iron === undefined || storage === undefined || farm === null) return null;
    const label = /data-text="([^"]*)"/.exec(row)?.[1] ?? '';
    const coords = /\((\d{1,3})\|(\d{1,3})\)\s*K\d+/.exec(row);
    const points = /<\/span>\s*<\/td>\s*<td>([\d<>\/="a-z .]+?)<\/td>\s*<td><span class="res wood">/.exec(row)?.[1];
    const merch = /screen=market">(\d+)\/(\d+)<\/a>/.exec(row);
    out.push({
      id,
      res: { wood: num(wood), stone: num(stone), iron: num(iron) },
      storage: Number(storage),
      farm: { used: Number(farm[1]), max: Number(farm[2]) },
      name: label.replace(/&amp;/g, '&'),
      ...(coords !== null ? { x: Number(coords[1]), y: Number(coords[2]) } : {}),
      ...(points !== undefined ? { points: num(points) } : {}),
      ...(merch !== null ? { merchants: { free: Number(merch[1]), total: Number(merch[2]) } } : {}),
    });
  }
  return out;
}

export interface BuildTarget {
  building: BuildingId;
  level: number;
}

export interface BuildPlanOptions {
  /** Itens máximos na fila do jogo (o script só completa até aqui). */
  maxQueue: number;
  /** Recursos que ficam SEMPRE na aldeia (por tipo). */
  keep: Partial<Record<'wood' | 'stone' | 'iron', number>>;
  /** Fazenda primeiro quando a população livre fica abaixo disto (%; 0 = desliga). */
  farmFreePct: number;
  /** Armazém primeiro quando o próximo custo não cabe nele. */
  storageGuard: boolean;
  /** Armazém primeiro quando algum recurso passa deste % do armazém (0 = desliga). */
  storageFullPct?: number;
  /** Construção −20% do jogo (custo × 0,8). */
  cheap?: boolean;
  /** Fila por horas: completa enquanto a fila cobre menos que isto (h). 0/ausente = por itens. */
  queueHours?: number;
  /** "Agora" no quadro do servidor (para o modo horas). */
  nowMs?: number;
  /** Seguir a ordem à risca (espera o 1º pendente) ou pular o que ainda não cabe. */
  strictOrder: boolean;
}

/** Pré-requisitos clássicos do jogo (nível mínimo de outros edifícios). */
export const PREREQS: Partial<Record<BuildingId, Partial<Record<BuildingId, number>>>> = {
  barracks: { main: 3 },
  stable: { main: 10, barracks: 5, smith: 5 },
  garage: { main: 10, smith: 10 },
  watchtower: { main: 5, farm: 5 },
  snob: { main: 20, smith: 20, market: 10 },
  smith: { main: 5, barracks: 1 },
  market: { main: 3, storage: 2 },
  wall: { barracks: 1 },
};

/** População extra que o nível `level` pede (0 para fazenda/armazém/praça). */
export function popIncrement(info: BuildingInfo, level: number): number {
  if (info.pop <= 0) return 0;
  const at = (n: number): number => (n <= 0 ? 0 : Math.round(info.pop * info.popF ** (n - 1)));
  return Math.max(0, at(level) - at(level - 1));
}

export type BuildDecision =
  | { kind: 'construir'; building: BuildingId; level: number; reason: 'fila' | 'fazenda' | 'armazem' }
  | { kind: 'esperar'; reason: 'fila-cheia' | 'concluido' | 'recursos' | 'maximo' | 'bloqueado' };

/** Chave da pausa após recusa do jogo (aldeia + edifício + nível). */
export const refusalKey = (vid: string, b: string, level: number): string => `${vid}|${b}|${level}`;

/** Nível efetivo = construído + o que já está na fila desse edifício. */
export function effectiveLevel(v: BuildVillage, b: BuildingId): number {
  return (v.levels[b] ?? 0) + v.queue.filter((q) => q === b).length;
}

/** O que construir agora numa aldeia (puro). */
export function planVillageBuild(
  village: BuildVillage,
  prod: ProdVillage | undefined,
  targets: readonly BuildTarget[],
  info: Partial<Record<BuildingId, BuildingInfo>>,
  opts: BuildPlanOptions,
): BuildDecision {
  if (village.queue.length >= opts.maxQueue) return { kind: 'esperar', reason: 'fila-cheia' };
  // Fila por HORAS: já cobre o tempo pedido? (sem horário legível, vale a regra de itens)
  if ((opts.queueHours ?? 0) > 0 && village.queue.length > 0 && village.queueEndsAt != null && opts.nowMs !== undefined) {
    if (village.queueEndsAt - opts.nowMs >= (opts.queueHours ?? 0) * 3_600_000) return { kind: 'esperar', reason: 'fila-cheia' };
  }
  const canPay = (b: BuildingId, level: number): boolean => {
    const i = info[b];
    if (i === undefined || prod === undefined) return false;
    const full = costAt(i, level);
    const f = opts.cheap === true ? 0.8 : 1;
    const c = { wood: Math.ceil(full.wood * f), stone: Math.ceil(full.stone * f), iron: Math.ceil(full.iron * f) };
    return (
      prod.res.wood - (opts.keep.wood ?? 0) >= c.wood &&
      prod.res.stone - (opts.keep.stone ?? 0) >= c.stone &&
      prod.res.iron - (opts.keep.iron ?? 0) >= c.iron
    );
  };
  const upTo = (b: BuildingId): number | null => {
    const i = info[b];
    const next = effectiveLevel(village, b) + 1;
    return i === undefined || next > i.maxLevel ? null : next;
  };
  // Fazenda primeiro (TIKA "percentFarm"): população livre abaixo do limite.
  if (opts.farmFreePct > 0 && prod !== undefined && prod.farm.max > 0 && !village.queue.includes('farm')) {
    const livre = ((prod.farm.max - prod.farm.used) / prod.farm.max) * 100;
    const next = upTo('farm');
    if (livre < opts.farmFreePct && next !== null && canPay('farm', next)) return { kind: 'construir', building: 'farm', level: next, reason: 'fazenda' };
  }
  // Armazém quase cheio (ideia do "Construtor & Redutor"): amplia antes de perder produção.
  if ((opts.storageFullPct ?? 0) > 0 && prod !== undefined && prod.storage > 0 && !village.queue.includes('storage')) {
    const cheio = (Math.max(prod.res.wood, prod.res.stone, prod.res.iron) / prod.storage) * 100;
    const next = upTo('storage');
    if (cheio >= (opts.storageFullPct ?? 0) && next !== null && canPay('storage', next)) return { kind: 'construir', building: 'storage', level: next, reason: 'armazem' };
  }
  const pending = targets.filter((t) => effectiveLevel(village, t.building) < t.level);
  if (pending.length === 0) return { kind: 'esperar', reason: 'concluido' };
  let waitingRes = false;
  for (const t of pending) {
    const next = upTo(t.building);
    if (next === null) continue; // já no máximo do jogo
    const i = info[t.building];
    // Armazém pequeno demais para o próximo custo: amplia o armazém antes.
    if (opts.storageGuard && i !== undefined && prod !== undefined && !village.queue.includes('storage')) {
      const c = costAt(i, next);
      const nextStorage = upTo('storage');
      if (Math.max(c.wood, c.stone, c.iron) > prod.storage && nextStorage !== null && canPay('storage', nextStorage)) {
        return { kind: 'construir', building: 'storage', level: nextStorage, reason: 'armazem' };
      }
    }
    // Pré-requisito ainda não cumprido (nem na fila): esse item não sai agora.
    const req = PREREQS[t.building] ?? {};
    const reqOk = Object.entries(req).every(([rb, rl]) => (village.levels[rb as BuildingId] ?? 0) >= (rl ?? 0));
    const popOk = i === undefined || prod === undefined || popIncrement(i, next) <= Math.max(0, prod.farm.max - prod.farm.used);
    if (reqOk && popOk && canPay(t.building, next)) return { kind: 'construir', building: t.building, level: next, reason: 'fila' };
    if (!reqOk || !popOk) continue;
    waitingRes = true;
    if (opts.strictOrder) return { kind: 'esperar', reason: 'recursos' };
  }
  if (pending.every((t) => upTo(t.building) === null)) return { kind: 'esperar', reason: 'maximo' };
  return { kind: 'esperar', reason: waitingRes ? 'recursos' : 'bloqueado' };
}

/**
 * Tela do Edifício principal (screen=main) de UMA aldeia no formato do plano
 * (modo "Só na tela"). Fonte: BuildingMain.buildings (JSON do jogo: nível),
 * fila pelas classes buildorder_<edifício>, recursos/armazém/fazenda da barra.
 * O id da aldeia vem de quem chama. null = tela inesperada.
 */
export function parseMainScreen(html: string, villageId: string): { village: BuildVillage; prod: ProdVillage } | null {
  const raw = /BuildingMain\.buildings\s*=\s*(\{[\s\S]*?\});/.exec(html)?.[1];
  if (raw === undefined) return null;
  let data: Record<string, { level?: string | number }>;
  try {
    data = JSON.parse(raw) as Record<string, { level?: string | number }>;
  } catch {
    return null;
  }
  const levels: Partial<Record<BuildingId, number>> = {};
  for (const b of BUILDINGS) {
    const l = data[b]?.level;
    if (l !== undefined) levels[b] = Number(l);
  }
  const queue = [...html.matchAll(/<tr class="[^"]*\bbuildorder_(\w+)\b[^"]*"/g)]
    .map((m) => m[1] as BuildingId)
    .filter((b) => (BUILDINGS as readonly string[]).includes(b));
  const span = (id: string): number => num(new RegExp(`<span id="${id}"[^>]*>([^<]*)<`).exec(html)?.[1]);
  const farmMax = span('pop_max_label');
  if (farmMax <= 0) return null;
  return {
    village: { id: villageId, name: '', levels, queue },
    prod: {
      id: villageId,
      res: { wood: span('wood'), stone: span('stone'), iron: span('iron') },
      storage: span('storage'),
      farm: { used: span('pop_current_label'), max: farmMax },
    },
  };
}

/**
 * Custo do PRÓXIMO passo da fila do Construtor nesta aldeia (v3.11.0, usado
 * pelo Balanceador no foco "Construção"): o primeiro alvo pendente cujo
 * pré-requisito já está construído e que não passou do máximo. null = nada a
 * pedir (fila concluída/bloqueada).
 */
export function nextStepCost(
  village: BuildVillage,
  targets: readonly BuildTarget[],
  info: Partial<Record<BuildingId, BuildingInfo>>,
): { wood: number; stone: number; iron: number } | null {
  for (const t of targets) {
    const i = info[t.building];
    if (i === undefined) continue;
    const next = effectiveLevel(village, t.building) + 1;
    if (next > t.level || next > i.maxLevel) continue;
    const req = PREREQS[t.building] ?? {};
    if (!Object.entries(req).every(([rb, rl]) => (village.levels[rb as BuildingId] ?? 0) >= (rl ?? 0))) continue;
    return costAt(i, next);
  }
  return null;
}
