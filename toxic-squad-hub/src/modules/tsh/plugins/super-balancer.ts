// Super Balanceador (v3.11.0) — ciclo em SEGUNDO PLANO, em qualquer tela.
// Lê a Visão de Produção (todas as páginas), os transportes a caminho e, no
// foco "Construção", a fila do Construtor; monta o plano (balance-mass.ts) e
// envia pelo "Pedido" do Mercado: UM pedido por aldeia que recebe, com várias
// origens. Confirmação pela resposta do jogo (transport_info por origem).

import { z } from 'zod';
import type { TshCycleContext } from '../tsh-runtime';
import { pacedGet } from '../../../core/net';
import { serverNowMs } from '../../../core/game-clock';
import { requestResourcesApi } from '../tsh-transport';
import { getGroupVillages } from '../tsh-groups';
import { parseBuildingsOverview, parseProdOverview, nextStepCost, type ProdVillage } from './builder-mass';
import { buildingInfo, builderTargetsForWorld } from './mega-builder';
import { groupByReceiver, parseTraderIncoming, planBalance, readCallResponse, type BalancePlan, type BalVillage, type Res } from './balance-mass';
import { uniqueCoords } from './coin-mass';

export const balancerSchema = z.object({
  mode: z.enum(['equilibrar', 'abastecer']).default('equilibrar'),
  /** Abastecer: por coordenadas ou por grupo do jogo. */
  alvo: z.enum(['coords', 'grupo']).default('coords'),
  targetCoords: z.string().default(''),
  groupId: z.number().int().min(0).default(0),
  groupName: z.string().default(''),
  fillPct: z.number().int().min(10).max(95).default(90),
  /** Abastecer na proporção do custo da moeda (28/30/25). */
  coinRatio: z.boolean().default(false),
  /** Grupo fora do balanceamento (nunca doa nem recebe). 0 = nenhum. */
  excludeGroupId: z.number().int().min(0).default(0),
  excludeGroupName: z.string().default(''),
  focus: z.number().int().min(0).max(100).default(50),
  smallPoints: z.number().int().min(0).max(20_000).default(0),
  smallFillPct: z.number().int().min(10).max(95).default(85),
  keepPct: z.number().int().min(0).max(90).default(20),
  reserveMerchants: z.number().int().min(0).max(300).default(0),
  maxDistance: z.number().min(1).max(999).default(40),
  radius: z.number().min(1).max(999).default(15),
  capPct: z.number().int().min(50).max(100).default(95),
  /** Aldeias que recebem por ciclo (um Pedido cada, com pausa humana). */
  perCycle: z.number().int().min(1).max(100).default(25),
  /** Ignora lançamentos abaixo disto (recursos). */
  minTransfer: z.number().int().min(1000).max(100_000).default(1000),
});
export type BalancerSettings = z.infer<typeof balancerSchema>;
export const BALANCER_DEFAULTS: BalancerSettings = balancerSchema.parse({});

const MAX_PAGES = 20;

export interface BalanceSnapshot {
  villages: BalVillage[];
  incoming: Map<string, Res>;
  needs: Map<string, Res>;
  targets: Set<string>;
  groupId: number;
  notes: string[];
  plan: BalancePlan;
}

/** Lê tudo o que o plano precisa e monta o plano (sem enviar nada). */
export async function loadAndPlan(world: string, villageId: string, s: BalancerSettings): Promise<BalanceSnapshot | { error: string }> {
  const notes: string[] = [];
  const prod: ProdVillage[] = [];
  const seen = new Set<string>();
  let groupId = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const html = await pacedGet(`/game.php?village=${villageId}&screen=overview_villages&mode=prod&page=${page}`, { fresh: true });
    const got = parseProdOverview(html);
    if (got === null) {
      if (page === 0) return { error: 'Não consegui ler a Visão de Produção (exige Conta Premium) — nada foi enviado.' };
      break;
    }
    if (page === 0) groupId = Number(/"group_id":"?(\d+)"?/.exec(html)?.[1] ?? 0);
    const before = prod.length;
    for (const v of got) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      prod.push(v);
    }
    const hasNext = new RegExp(`class="paged-nav-item"[^>]*[?&;]page=${page + 1}\\b`).test(html);
    if (!hasNext || prod.length === before) break;
  }
  const villages: BalVillage[] = prod.flatMap((p) =>
    p.x === undefined || p.y === undefined
      ? []
      : [{ id: p.id, name: p.name ?? p.id, x: p.x, y: p.y, res: p.res, storage: p.storage, merchants: p.merchants?.free ?? 0, points: p.points ?? 0, farm: p.farm }],
  );
  if (villages.length < 2) return { error: 'É preciso ter pelo menos 2 aldeias para balancear.' };
  if (groupId !== 0) notes.push('O jogo está mostrando só um grupo de aldeias: o balanceamento cobre só essas (escolha "todos" no menu de grupos do jogo).');

  const incoming = new Map<string, Res>();
  let incDone = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = parseTraderIncoming(await pacedGet(`/game.php?village=${villageId}&screen=overview_villages&mode=trader&type=inc&page=${page}`, { fresh: true }), page);
    // Fail-closed: sem saber o que já está a caminho, o plano mandaria de novo.
    if (r === null) return { error: 'Não consegui ler os transportes a caminho — nada foi enviado (evita mandar em dobro).' };
    for (const [id, res] of r.byTarget) {
      const cur = incoming.get(id) ?? { wood: 0, stone: 0, iron: 0 };
      incoming.set(id, { wood: cur.wood + res.wood, stone: cur.stone + res.stone, iron: cur.iron + res.iron });
    }
    if (!r.more) {
      incDone = true;
      break;
    }
  }
  if (!incDone) return { error: `Há mais de ${MAX_PAGES} páginas de transportes a caminho — nada foi enviado nesta rodada (espere os comerciantes chegarem).` };

  const needs = new Map<string, Res>();
  const stalled = new Set<string>();
  if (s.mode === 'equilibrar' && s.focus > 0) {
    const bt = await builderTargetsForWorld(world, villageId);
    const info = bt === null ? null : await buildingInfo();
    if (bt === null || info === null) notes.push('Foco "Construção": o Construtor não tem fila configurada — valeu só o equilíbrio dos armazéns.');
    else {
      const prodById = new Map(prod.map((x) => [x.id, x]));
      for (let page = 0; page < MAX_PAGES; page++) {
        const bld = parseBuildingsOverview(await pacedGet(`/game.php?village=${villageId}&screen=overview_villages&mode=buildings&page=${page}`, { fresh: true }), serverNowMs());
        if (bld === null) {
          notes.push('Não consegui ler a Visão de Edifícios — valeu só o equilíbrio dos armazéns.');
          break;
        }
        for (const v of bld.villages) {
          const mine = bt.forVillage(v);
          const c = mine === null ? null : nextStepCost(v, mine.targets, info);
          if (c !== null) {
            // Fila vazia e o próximo passo não cabe (contando o que já vem): fila PARADA — vem primeiro e pede o custo cheio.
            const p = prodById.get(v.id);
            const inc = incoming.get(v.id) ?? { wood: 0, stone: 0, iron: 0 };
            const parada = v.queue.length === 0 && p !== undefined && (p.res.wood + inc.wood < c.wood || p.res.stone + inc.stone < c.stone || p.res.iron + inc.iron < c.iron);
            if (parada) stalled.add(v.id);
            const f = parada ? 1 : s.focus / 100;
            needs.set(v.id, { wood: c.wood * f, stone: c.stone * f, iron: c.iron * f });
          }
        }
        if (!bld.full) break;
      }
    }
  }

  const targets = new Set<string>();
  if (s.mode === 'abastecer') {
    if (s.alvo === 'grupo') {
      const vs = await getGroupVillages(s.groupId);
      if (vs.length === 0) return { error: `Não consegui ler as aldeias do grupo "${s.groupName || s.groupId}" — nada foi enviado.` };
      for (const v of vs) targets.add(String(v.villageId));
    } else {
      const byCoord = new Map(villages.map((v) => [`${v.x}|${v.y}`, v.id]));
      const unknown: string[] = [];
      for (const c of uniqueCoords(s.targetCoords)) {
        const id = byCoord.get(c);
        if (id === undefined) unknown.push(c);
        else targets.add(id);
      }
      if (unknown.length > 0) notes.push(`${unknown.length === 1 ? 'Coordenada que não é aldeia sua' : 'Coordenadas que não são aldeias suas'}: ${unknown.slice(0, 3).join(' ')}${unknown.length > 3 ? ' …' : ''}.`);
    }
    if (targets.size === 0) return { error: 'Abastecer: nenhuma aldeia-alvo reconhecida — abra Configurar e escolha quem recebe.' };
  }

  const exclude = new Set<string>();
  if (s.excludeGroupId > 0) {
    const vs = await getGroupVillages(s.excludeGroupId);
    if (vs.length === 0) return { error: `Não consegui ler as aldeias do grupo que fica de fora ("${s.excludeGroupName || s.excludeGroupId}") — nada foi enviado.` };
    for (const v of vs) exclude.add(String(v.villageId));
    const both = [...targets].filter((id) => exclude.has(id)).length;
    if (both > 0) notes.push(`${both} aldeia(s) escolhida(s) para receber estão no grupo "fora do balanceamento" e ficaram de fora.`);
  }

  const plan = planBalance(villages, incoming, {
    mode: s.mode,
    targets,
    stalled,
    exclude,
    coinRatio: s.coinRatio,
    fillPct: s.fillPct,
    focus: s.focus,
    needs,
    smallPoints: s.smallPoints,
    smallFillPct: s.smallFillPct,
    keepPct: s.keepPct,
    reserveMerchants: s.reserveMerchants,
    merchantCap: 1000,
    maxDistance: s.maxDistance,
    radius: s.radius,
    capPct: s.capPct,
    minLoad: s.minTransfer,
  });
  return { villages, incoming, needs, targets, groupId, notes, plan };
}

const fmt = (n: number): string => Math.round(n).toLocaleString('pt-BR');

export async function runSuperBalancer(ctx: TshCycleContext): Promise<void> {
  const parsed = balancerSchema.safeParse(ctx.storage.get<Record<string, unknown>>('settings', BALANCER_DEFAULTS));
  if (!parsed.success) {
    ctx.status('Configurações do Balanceador inválidas — nada foi feito. Abra Configurar e salve de novo.', 'warn');
    return;
  }
  const s = parsed.data;
  const snap = await loadAndPlan(ctx.world, ctx.villageId, s);
  if ('error' in snap) {
    ctx.status(snap.error, 'warn');
    return;
  }
  const total = (ls: readonly { res: Res }[]): number => ls.reduce((t, l) => t + l.res.wood + l.res.stone + l.res.iron, 0);
  const groups = [...groupByReceiver(snap.plan.launches).entries()].sort(
    (a, b) => (b[1][0]?.priority ?? 1) - (a[1][0]?.priority ?? 1) || total(b[1]) - total(a[1]),
  );
  const note = snap.notes.length > 0 ? ` ${snap.notes.join(' ')}` : '';
  if (groups.length === 0) {
    ctx.status(`Nada a balancear agora: as aldeias estão dentro do alvo (ou sem mercadores livres por perto).${note}`, 'info');
    return;
  }
  const byId = new Map(snap.villages.map((v) => [v.id, v]));
  let sentVillages = 0;
  let sentTotal = 0;
  let refused = 0;
  let refusedInRow = 0;
  let lastRefusal = '';
  let unconfirmed = 0;
  let paused = false;
  let handled = 0;
  for (const [to, launches] of groups.slice(0, s.perCycle)) {
    handled += 1;
    let response: unknown;
    try {
      response = await requestResourcesApi(to, launches);
    } catch (error) {
      const e = error as { code?: string; message?: string };
      if (e.code === 'GAME_REFUSED') {
        refused += 1;
        refusedInRow += 1;
        lastRefusal = e.message ?? '';
        // Recusa em série = algo do lado do jogo (mercado, sessão): para, não insiste.
        if (refusedInRow >= 3) break;
        continue;
      }
      if (e.code === 'HUMANIZE_PAUSE') {
        paused = true;
        handled -= 1;
        break;
      }
      const where = byId.get(to);
      ctx.status(
        `${e.message ?? String(error)} (pedido para ${where !== undefined ? `${where.x}|${where.y}` : to}) — parei este ciclo, sem repetir às cegas. ${sentVillages} aldeia(s) já tinham recebido o pedido.`,
        'warn',
      );
      return;
    }
    const ok = readCallResponse(response);
    if (ok === null) {
      ctx.status(`O jogo respondeu fora do esperado ao pedido de recursos — parei este ciclo (${sentVillages} pedido(s) antes deste). Confira no Mercado.`, 'warn');
      return;
    }
    refusedInRow = 0;
    const got = [...ok.confirmed.values()].reduce((a, b) => a + b, 0);
    if (got <= 0) {
      unconfirmed += 1;
      continue;
    }
    sentVillages += 1;
    sentTotal += got;
  }
  const left = groups.length - handled;
  const agains = ctx.storage.get<number>('agains', 0);
  const keepGoing = left > 0 && !paused && refused === 0 && sentVillages > 0 && agains < 10;
  ctx.storage.set('agains', keepGoing ? agains + 1 : 0);
  if (keepGoing) ctx.again?.(60_000);
  const m = snap.plan.moved;
  if (sentVillages === 0 && refused > 0) {
    ctx.status(`O jogo recusou os ${refused} pedido(s) deste ciclo — nada foi enviado${lastRefusal !== '' ? ` ("${lastRefusal}")` : ''}. Confira os mercadores no Mercado.${note}`, 'warn');
    return;
  }
  if (sentVillages === 0 && paused) {
    ctx.status(`Pausa de humanização ativa — nenhum pedido neste ciclo; sigo no próximo.${note}`, 'info');
    return;
  }
  ctx.status(
    `${sentVillages} aldeia(s) receberam pedidos — o jogo confirmou ${fmt(sentTotal)} recursos em trânsito (plano: madeira ${fmt(m.wood)}, argila ${fmt(m.stone)}, ferro ${fmt(m.iron)} de ${snap.plan.donors} doadora(s)).` +
      (refused > 0 ? ` O jogo recusou ${refused} pedido(s)${lastRefusal !== '' ? ` ("${lastRefusal}")` : ''}.` : '') +
      (unconfirmed > 0 ? ` ${unconfirmed} pedido(s) sem confirmação de nenhuma origem — confira no Mercado.` : '') +
      (left > 0 ? (paused ? ` Pausa de humanização ativa: parei aqui (${left} aldeia(s) para o próximo ciclo).` : keepGoing ? ` Faltam ${left} aldeia(s): sigo em 1 min.` : ` Faltam ${left} aldeia(s) para o próximo ciclo.`) : '') +
      note,
    sentVillages > 0 ? 'ok' : 'warn',
  );
}
