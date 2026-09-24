// Recrutamento em SEGUNDO PLANO (v3.8.0) — todas as aldeias pela tela
// "Recrutamento em massa" do jogo (screen=train&mode=mass&page=N, Conta
// Premium). Verificada no BR142 em 24/09/2026 (fixture real). Por aldeia a
// tela dá: recursos, fazenda ("usada/máx") e, por tropa, data-existing (quanto
// tem), data-running (quanto está na fila) e o máximo que o JOGO deixa
// recrutar agora — link "(N)", já contando recursos, fazenda e edifício.
// O envio é o próprio formulário: units[aldeia][tropa]=N (action=train_mass).
// Puro/testável (regex, sem DOMParser).

export const RECRUIT_UNITS = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult'] as const;
export type RecruitUnit = (typeof RECRUIT_UNITS)[number];

export interface UnitCostFull {
  wood: number;
  stone: number;
  iron: number;
  pop: number;
}

export interface MassRecruitUnit {
  existing: number;
  running: number;
  /** Máximo que o jogo deixa recrutar agora (null = campo desabilitado). */
  max: number | null;
}

export interface MassRecruitVillage {
  id: string;
  name: string;
  x: number;
  y: number;
  res: { wood: number; stone: number; iron: number };
  farm: { used: number; max: number };
  units: Partial<Record<RecruitUnit, MassRecruitUnit>>;
}

export interface MassRecruitPage {
  costs: Partial<Record<RecruitUnit, UnitCostFull>>;
  villages: MassRecruitVillage[];
  /** URL do formulário (com o h= do jogo). */
  action: string;
  /** Página cheia (1000 aldeias) = pode haver a próxima. */
  full: boolean;
  /** Maior página linkada na paginação (0 = só esta). */
  lastLinkedPage: number;
  /** Grupo de aldeias selecionado no jogo (0 = todos) — a tela só lista esse grupo. */
  groupId: number;
}

const num = (s: string | undefined): number => Number((s ?? '').replace(/<[^>]+>/g, '').replace(/\./g, '').trim());

/** Lê uma página do Recrutamento em massa (null = formato inesperado ou sem Premium). */
export function parseMassRecruit(html: string): MassRecruitPage | null {
  const table = /<table id="mass_train_table"[\s\S]*?<\/table>/.exec(html)?.[0];
  const action = /<form action="([^"]*action=train_mass[^"]*)"/.exec(html)?.[1];
  const costsRaw = /unit_managers\.units\s*=\s*(\{[\s\S]*?\});/.exec(html)?.[1];
  if (table === undefined || action === undefined || costsRaw === undefined) return null;
  let costs: Partial<Record<RecruitUnit, UnitCostFull>>;
  try {
    costs = JSON.parse(costsRaw) as Partial<Record<RecruitUnit, UnitCostFull>>;
  } catch {
    return null;
  }
  const villages: MassRecruitVillage[] = [];
  for (const m of table.matchAll(/<tr class="row_[ab]">([\s\S]*?)<\/tr>/g)) {
    const row = m[1] ?? '';
    const head = /village=(\d+)&(?:amp;)?screen=overview">([^<]*?)\s*\((\d{1,3})\|(\d{1,3})\)/.exec(row);
    const wood = /class="res wood">([\s\S]*?)<\/span><br>/.exec(row)?.[1];
    const stone = /class="res stone">([\s\S]*?)<\/span><br>/.exec(row)?.[1];
    const iron = /class="res iron">([\s\S]*?)<\/span>\s*<\/td>/.exec(row)?.[1];
    const farm = /<td>(\d+)\/(\d+)<\/td>/.exec(row);
    if (head === null || farm === null || wood === undefined || stone === undefined || iron === undefined) return null;
    const units: Partial<Record<RecruitUnit, MassRecruitUnit>> = {};
    for (const u of RECRUIT_UNITS) {
      const input = new RegExp(`<input data-existing="(\\d+)" data-running="(\\d+)" type="text"( disabled="disabled")? id="${u}_\\d+"`).exec(row);
      if (input === null) continue;
      const max = new RegExp(`set_max\\('${u}'\\)">\\((\\d+)\\)`).exec(row);
      units[u] = { existing: Number(input[1]), running: Number(input[2]), max: input[3] !== undefined || max === null ? null : Number(max[1]) };
    }
    villages.push({
      id: head[1] ?? '',
      name: (head[2] ?? '').trim().replace(/&amp;/g, '&'),
      x: Number(head[3]),
      y: Number(head[4]),
      res: { wood: num(wood), stone: num(stone), iron: num(iron) },
      farm: { used: Number(farm[1]), max: Number(farm[2]) },
      units,
    });
  }
  let lastLinkedPage = 0;
  for (const m of html.matchAll(/mode=mass&(?:amp;)?page=(\d+)/g)) lastLinkedPage = Math.max(lastLinkedPage, Number(m[1]));
  const groupId = Number(/"group_id":"?(\d+)"?/.exec(html)?.[1] ?? 0);
  return { costs, villages, action: action.replace(/&amp;/g, '&'), full: villages.length >= 1000, lastLinkedPage, groupId };
}

export interface RecruitPlanOptions {
  /** Metas por tropa (total que a aldeia deve ter; 0/ausente = não recruta). */
  goals: Partial<Record<string, number>>;
  /** Recursos que ficam SEMPRE na aldeia (para construções). */
  keepResources: number;
  /** No máximo quanto de cada tropa por envio (0 = sem limite). */
  batchMax: number;
  /** Teto de população da aldeia (0 = sem teto): o lote nunca passa dele. */
  popCeiling?: number;
}

/**
 * Quanto recrutar numa aldeia: a meta mais carente primeiro (tem+fila ÷ meta),
 * limitado pelo máximo do jogo, pelos recursos (menos a reserva) e pela
 * fazenda — gastando ao somar várias tropas na mesma aldeia.
 */
export function planVillageRecruit(
  village: MassRecruitVillage,
  costs: Partial<Record<RecruitUnit, UnitCostFull>>,
  opts: RecruitPlanOptions,
): Partial<Record<RecruitUnit, number>> {
  const res = {
    wood: Math.max(0, village.res.wood - opts.keepResources),
    stone: Math.max(0, village.res.stone - opts.keepResources),
    iron: Math.max(0, village.res.iron - opts.keepResources),
  };
  let pop = Math.max(0, village.farm.max - village.farm.used);
  if ((opts.popCeiling ?? 0) > 0) pop = Math.min(pop, Math.max(0, (opts.popCeiling ?? 0) - village.farm.used));
  const wanted = RECRUIT_UNITS.map((u) => {
    const goal = Math.max(0, Math.floor(opts.goals[u] ?? 0));
    const info = village.units[u];
    const have = info === undefined ? 0 : info.existing + info.running;
    return { u, goal, info, have };
  })
    .filter((w) => w.goal > 0 && w.info !== undefined && w.info.max !== null && w.have < w.goal)
    .sort((a, b) => a.have / a.goal - b.have / b.goal);
  const out: Partial<Record<RecruitUnit, number>> = {};
  for (const w of wanted) {
    const cost = costs[w.u];
    if (cost === undefined || w.info === undefined || w.info.max === null) continue;
    let n = Math.min(w.goal - w.have, w.info.max);
    if (opts.batchMax > 0) n = Math.min(n, opts.batchMax);
    if (cost.wood > 0) n = Math.min(n, Math.floor(res.wood / cost.wood));
    if (cost.stone > 0) n = Math.min(n, Math.floor(res.stone / cost.stone));
    if (cost.iron > 0) n = Math.min(n, Math.floor(res.iron / cost.iron));
    if (cost.pop > 0) n = Math.min(n, Math.floor(pop / cost.pop));
    if (n <= 0) continue;
    out[w.u] = n;
    res.wood -= n * cost.wood;
    res.stone -= n * cost.stone;
    res.iron -= n * cost.iron;
    pop -= n * cost.pop;
  }
  return out;
}

/** Corpo do formulário do jogo: units[aldeia][tropa]=N (só o que vai sair). */
export function massRecruitBody(plan: ReadonlyMap<string, Partial<Record<RecruitUnit, number>>>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [vid, units] of plan) {
    for (const [u, n] of Object.entries(units)) if ((n ?? 0) > 0) body.append(`units[${vid}][${u}]`, String(n));
  }
  return body;
}

/**
 * Tela de recrutamento de UMA aldeia (screen=train) no mesmo formato do
 * Recrutamento em massa — modo "Só na tela" (contas sem Premium). Verificada
 * no BR142 (fixture real): "na aldeia/total" em texto, custos em spans com id
 * (<tropa>_0_cost_<recurso>), máximo do jogo no link "(N)", fila pelos
 * sprites das filas (quartel/estábulo/oficina). null = tela inesperada.
 */
export function parseTrainScreen(html: string): { village: MassRecruitVillage; costs: Partial<Record<RecruitUnit, UnitCostFull>> } | null {
  const form = /<form id="train_form" action="([^"]*)"[\s\S]*?<\/form>/.exec(html);
  const vid = /village=(\d+)/.exec(form?.[1] ?? '')?.[1];
  const res = (id: string): number => num(new RegExp(`<span id="${id}"[^>]*>([^<]*)<`).exec(html)?.[1]);
  const popCur = /id="pop_current_label"[^>]*>(\d+)</.exec(html)?.[1];
  const popMax = /id="pop_max_label"[^>]*>(\d+)</.exec(html)?.[1];
  if (form === null || vid === undefined || popCur === undefined || popMax === undefined) return null;
  const body = form[0];
  const queued: Record<string, number> = {};
  for (const wrap of html.matchAll(/<div class="trainqueue_wrap"[\s\S]*?<\/table>\s*<\/div>/g)) {
    for (const m of wrap[0].matchAll(/unit_sprite_smaller (\w+)"><\/div>\s*([\d.]+)/g)) queued[m[1] ?? ''] = (queued[m[1] ?? ''] ?? 0) + num(m[2]);
  }
  const units: Partial<Record<RecruitUnit, MassRecruitUnit>> = {};
  const costs: Partial<Record<RecruitUnit, UnitCostFull>> = {};
  // Uma linha por tropa: corta o formulário em linhas e acha a da tropa.
  const rows = body.split('<tr class="row_').slice(1);
  for (const u of RECRUIT_UNITS) {
    const row = rows.find((r) => r.includes(`data-unit="${u}"`));
    if (row === undefined) continue;
    const count = /<td>(\d+)\/(\d+)<\/td>/.exec(row);
    const max = new RegExp(`id="${u}_0_a"[^>]*>\\((\\d+)\\)`).exec(row);
    const cost = (r: string): number => Number(new RegExp(`id="${u}_0_cost_${r}">(\\d+)<`).exec(row)?.[1] ?? NaN);
    if (count === null) return null;
    units[u] = { existing: Number(count[2]), running: queued[u] ?? 0, max: max === null ? null : Number(max[1]) };
    const c = { wood: cost('wood'), stone: cost('stone'), iron: cost('iron'), pop: cost('pop') };
    if (Object.values(c).every(Number.isFinite)) costs[u] = c;
  }
  return {
    village: {
      id: vid,
      name: '',
      x: 0,
      y: 0,
      res: { wood: res('wood'), stone: res('stone'), iron: res('iron') },
      farm: { used: Number(popCur), max: Number(popMax) },
      units,
    },
    costs,
  };
}
