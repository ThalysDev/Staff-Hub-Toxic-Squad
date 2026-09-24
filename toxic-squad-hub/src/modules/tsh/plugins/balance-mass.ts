// Super Balanceador (v3.11.0) — leitura e plano PUROS.
//
// Síntese de três fontes da comunidade + nossas ideias:
// - Costache (resBalancer): alvo = média × fator + necessidade de construção,
//   recursos A CAMINHO contam, teto de 95% do armazém, doadora mais perto
//   primeiro, reserva de mercadores, carga em múltiplos de 1000 (sem mercador
//   meio vazio), normalização quando falta recurso para todos;
// - Shinko to Kuma (WH Balancer): aldeia PEQUENA (poucos pontos) é prioridade
//   e recebe até X% do armazém; aldeia PRONTA (fazenda cheia) guarda só uma
//   fatia e doa o resto;
// - Resources Sender/Request (victorgare): modo ABASTECER — encher aldeias
//   escolhidas (ex.: a da cunhagem) a partir das vizinhas;
// - motor antigo (unified planner): fila PARADA primeiro, aldeias fora do
//   balanceamento (blacklist), proporção da moeda e presets;
// - nosso: foco Construção ↔ Armazém (quanto do alvo vem da fila do Construtor
//   e quanto da média), raio de vizinhança antes de ir longe.
//
// Envio verificado no BR142 (24/09/2026, ação real autorizada): o "Pedido" do
// Mercado posta market&ajaxaction=call a partir da aldeia-DESTINO com
// resource[<origem>][<recurso>] — várias origens num pedido só.

export type Res = { wood: number; stone: number; iron: number };
export const RES_KEYS = ['wood', 'stone', 'iron'] as const;
export type ResKey = (typeof RES_KEYS)[number];

const zero = (): Res => ({ wood: 0, stone: 0, iron: 0 });
const digits = (text: string | undefined): number => Number((text ?? '').replace(/<[^>]*>/g, '').replace(/[^\d]/g, '') || 0);

/** Recursos A CAMINHO por aldeia-destino (Visão Comerciantes → chegando). null = tela inesperada. */
export function parseTraderIncoming(html: string, page = 0): { byTarget: Map<string, Res>; rows: number; more: boolean } | null {
  const table = /<table id="trades_table"[\s\S]*?<\/table>/.exec(html)?.[0];
  if (table === undefined) return null;
  const byTarget = new Map<string, Res>();
  let rows = 0;
  for (const m of table.matchAll(/<tr class="row_[ab]">([\s\S]*?)<\/tr>/g)) {
    const row = m[1] ?? '';
    const ids = [...row.matchAll(/screen=info_village&amp;id=(\d+)/g)].map((x) => x[1] ?? '');
    const target = ids[1];
    if (target === undefined) continue;
    rows += 1;
    const cur = byTarget.get(target) ?? zero();
    for (const k of RES_KEYS) cur[k] += digits(new RegExp(`class="res ${k}">([\\s\\S]*?)</span>\\s*(?:<span class="res|</td>)`).exec(row)?.[1]);
    byTarget.set(target, cur);
  }
  const more = new RegExp(`class="paged-nav-item"[^>]*[?&;]page=${page + 1}\\b`).test(html);
  return { byTarget, rows, more };
}

export interface BalVillage {
  id: string;
  name: string;
  x: number;
  y: number;
  res: Res;
  storage: number;
  /** Mercadores livres agora. */
  merchants: number;
  points: number;
  farm: { used: number; max: number };
}

export interface BalanceOptions {
  mode: 'equilibrar' | 'abastecer';
  /** Abastecer: aldeias que recebem. */
  targets?: ReadonlySet<string>;
  /** Abastecer: encher as escolhidas até este % do armazém. */
  fillPct: number;
  /** 0 = só armazém (iguala à média) … 100 = só construção (só a fila do Construtor). */
  focus: number;
  /** Necessidade de construção por aldeia (custo do que a fila pede). */
  needs?: ReadonlyMap<string, Res>;
  /** Fila do Construtor PARADA por falta de recurso: vem antes de todos (motor antigo, camada 1). */
  stalled?: ReadonlySet<string>;
  /** Fora do balanceamento: nunca doam nem recebem (ex.: grupo sob ataque). */
  exclude?: ReadonlySet<string>;
  /** Abastecer na proporção do custo da moeda (28/30/25) em vez de igual. */
  coinRatio?: boolean;
  /** Pequenas: abaixo destes pontos têm prioridade e recebem até smallFillPct. 0 = desliga. */
  smallPoints: number;
  smallFillPct: number;
  /** Prontas (fazenda cheia) e doadoras do Abastecer guardam só este % do armazém. */
  keepPct: number;
  reserveMerchants: number;
  merchantCap: number;
  /** Nunca envia além disto (campos). */
  maxDistance: number;
  /** Tenta primeiro doadoras até este raio (campos). */
  radius: number;
  /** Teto de cada armazém depois de receber (%). */
  capPct: number;
  /** Envio mínimo (recursos); abaixo disto não sai (e não gasta mercador). */
  minLoad?: number;
}

export interface Launch {
  from: string;
  to: string;
  res: Res;
  distance: number;
  /** Prioridade da aldeia que recebe (3 = fila parada/alvo, 2 = pequena, 1 = normal). */
  priority: number;
}

export interface BalancePlan {
  launches: Launch[];
  moved: Res;
  /** Falta que ninguém conseguiu cobrir (por recurso). */
  unmet: Res;
  receivers: number;
  donors: number;
  /** Papel de cada aldeia (para a prévia). */
  roles: Map<string, 'pequena' | 'pronta' | 'normal' | 'alvo' | 'doadora'>;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
const sum = (r: Res): number => r.wood + r.stone + r.iron;

/**
 * O plano (PURO). Alvo de cada aldeia por recurso → sobra (doa) ou falta
 * (recebe) → quem mais precisa primeiro, da doadora mais perto (dentro do
 * raio antes de ir longe), em cargas de múltiplos da capacidade do mercador.
 */
export function planBalance(allVillages: readonly BalVillage[], incoming: ReadonlyMap<string, Res>, o: BalanceOptions): BalancePlan {
  const roles = new Map<string, 'pequena' | 'pronta' | 'normal' | 'alvo' | 'doadora'>();
  const eff = new Map<string, Res>();
  const villages = allVillages.filter((v) => !(o.exclude?.has(v.id) ?? false));
  for (const v of villages) {
    const inc = incoming.get(v.id) ?? zero();
    eff.set(v.id, { wood: Math.min(v.storage, v.res.wood + inc.wood), stone: Math.min(v.storage, v.res.stone + inc.stone), iron: Math.min(v.storage, v.res.iron + inc.iron) });
  }
  const n = Math.max(1, villages.length);
  const avg: Res = zero();
  for (const v of villages) for (const k of RES_KEYS) avg[k] += (eff.get(v.id)?.[k] ?? 0) / n;
  const eqFactor = 1 - Math.min(100, Math.max(0, o.focus)) / 100;

  const surplus = new Map<string, Res>();
  const deficit = new Map<string, Res>();
  const priority = new Map<string, number>();
  for (const v of villages) {
    const e = eff.get(v.id) ?? zero();
    const cap = Math.floor((v.storage * o.capPct) / 100);
    const farmFull = v.farm.max > 0 && v.farm.used >= v.farm.max;
    let target: Res;
    let pr = 1;
    if (o.mode === 'abastecer') {
      if (o.targets?.has(v.id) ?? false) {
        roles.set(v.id, 'alvo');
        const t = Math.floor((v.storage * o.fillPct) / 100);
        // Proporção da moeda: o recurso mais caro (argila 30) enche até o %, os outros na mesma razão.
        target = o.coinRatio === true ? { wood: Math.floor((t * 28) / 30), stone: t, iron: Math.floor((t * 25) / 30) } : { wood: t, stone: t, iron: t };
        pr = 3;
      } else {
        roles.set(v.id, 'doadora');
        const keep = Math.floor((v.storage * o.keepPct) / 100);
        target = { wood: keep, stone: keep, iron: keep };
        pr = 0;
      }
    } else if (o.smallPoints > 0 && v.points > 0 && v.points < o.smallPoints) {
      roles.set(v.id, 'pequena');
      const t = Math.floor((v.storage * o.smallFillPct) / 100);
      target = { wood: t, stone: t, iron: t };
      pr = 2;
    } else if (farmFull) {
      roles.set(v.id, 'pronta');
      const keep = Math.floor((v.storage * o.keepPct) / 100);
      target = { wood: Math.min(keep, avg.wood), stone: Math.min(keep, avg.stone), iron: Math.min(keep, avg.iron) };
      pr = 0;
    } else {
      roles.set(v.id, 'normal');
      if (o.stalled?.has(v.id) ?? false) pr = 3;
      const need = o.needs?.get(v.id);
      // Sem fila do Construtor, o lado "Construção" não se aplica: vale a média inteira.
      const f = need === undefined ? 1 : eqFactor;
      const nd = need ?? zero();
      target = { wood: avg.wood * f + nd.wood, stone: avg.stone * f + nd.stone, iron: avg.iron * f + nd.iron };
    }
    const s = zero();
    const d = zero();
    for (const k of RES_KEYS) {
      const t = Math.min(cap, Math.round(target[k]));
      // Doa só o que está EM CASA (o que vem a caminho ainda não pode sair).
      if (e[k] > t) s[k] = Math.max(0, Math.min(v.res[k], e[k] - t));
      else d[k] = Math.max(0, t - e[k]);
    }
    if (sum(s) > 0) surplus.set(v.id, s);
    if (sum(d) > 0) {
      deficit.set(v.id, d);
      priority.set(v.id, pr);
    }
  }

  // Falta mais do que sobra? Quem tem prioridade recebe primeiro (sem ratear em
  // migalhas que nunca enchem um mercador — ver revisão 3.11.0).
  const totS = zero();
  const totD = zero();
  for (const s of surplus.values()) for (const k of RES_KEYS) totS[k] += s[k];
  for (const d of deficit.values()) for (const k of RES_KEYS) totD[k] += d[k];
  const unmet = zero();
  for (const k of RES_KEYS) unmet[k] = Math.max(0, totD[k] - totS[k]);

  const byId = new Map(villages.map((v) => [v.id, v]));
  const capLeft = new Map(villages.map((v) => [v.id, Math.max(0, v.merchants - o.reserveMerchants) * o.merchantCap]));
  const receivers = [...deficit.entries()].sort((a, b) => (priority.get(b[0]) ?? 0) - (priority.get(a[0]) ?? 0) || sum(b[1]) - sum(a[1]));
  const launches: Launch[] = [];
  const moved = zero();
  const donorsUsed = new Set<string>();
  const unit = o.merchantCap;
  const minLoad = Math.max(unit, o.minLoad ?? unit);
  for (const [rid, need] of receivers) {
    const rv = byId.get(rid);
    if (rv === undefined) continue;
    const donors = [...surplus.entries()]
      .filter(([did, s]) => did !== rid && sum(s) > 0 && (capLeft.get(did) ?? 0) >= unit)
      .map(([did, s]) => ({ did, s, d: dist(byId.get(did) ?? rv, rv) }))
      .filter((x) => x.d <= o.maxDistance)
      .sort((a, b) => a.d - b.d);
    // Primeiro as vizinhas (raio), depois as mais longe até a distância máxima.
    const ordered = [...donors.filter((x) => x.d <= o.radius), ...donors.filter((x) => x.d > o.radius)];
    for (const { did, s, d } of ordered) {
      if (sum(need) < unit) break;
      const load = zero();
      for (const k of RES_KEYS) load[k] = Math.min(need[k], s[k]);
      let total = sum(load);
      const capD = capLeft.get(did) ?? 0;
      if (total > capD) {
        const f = capD / total;
        for (const k of RES_KEYS) load[k] = Math.floor(load[k] * f);
        total = sum(load);
      }
      // Múltiplo exato do mercador: tira a sobra do recurso mais carregado.
      let rest = total % unit;
      while (rest > 0) {
        const k = RES_KEYS.reduce((a, b) => (load[b] > load[a] ? b : a));
        const cut = Math.min(rest, load[k]);
        load[k] -= cut;
        rest -= cut;
      }
      total = sum(load);
      if (total < minLoad) continue;
      launches.push({ from: did, to: rid, res: load, distance: Math.round(d * 10) / 10, priority: priority.get(rid) ?? 1 });
      donorsUsed.add(did);
      capLeft.set(did, capD - total);
      for (const k of RES_KEYS) {
        need[k] -= load[k];
        s[k] -= load[k];
        moved[k] += load[k];
      }
    }
  }
  return { launches, moved, unmet, receivers: new Set(launches.map((l) => l.to)).size, donors: donorsUsed.size, roles };
}

/** Lançamentos agrupados por destino (um "Pedido" por aldeia que recebe). */
export function groupByReceiver(launches: readonly Launch[]): Map<string, Launch[]> {
  const out = new Map<string, Launch[]>();
  for (const l of launches) out.set(l.to, [...(out.get(l.to) ?? []), l]);
  return out;
}

/** Resposta do "Pedido": quanto cada origem confirmou (capacidade usada) — null = fora do contrato. */
export function readCallResponse(response: unknown): { success: string; confirmed: Map<string, number> } | null {
  if (typeof response !== 'object' || response === null) return null;
  const outer = response as { response?: unknown; success?: unknown; transport_info?: unknown };
  const r = (typeof outer.response === 'object' && outer.response !== null ? outer.response : outer) as { success?: unknown; transport_info?: unknown };
  if (typeof r.success !== 'string' || !Array.isArray(r.transport_info)) return null;
  const confirmed = new Map<string, number>();
  for (const t of r.transport_info as { village_id?: unknown; needed_trader_capacity?: unknown }[]) {
    const id = String(t.village_id ?? '');
    const cap = Number(t.needed_trader_capacity);
    if (id !== '' && Number.isFinite(cap)) confirmed.set(id, cap);
  }
  return { success: r.success, confirmed };
}
