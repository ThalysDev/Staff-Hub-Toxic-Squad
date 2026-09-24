// PREVISÃO DE TROPAS no horário do envio (v3.5.0). Pergunta que o agendador
// precisa responder: "no horário T, quantas tropas estarão EM CASA nesta
// aldeia?" — e não só "quantas há agora". Fontes verificadas no BR142
// (24/09/2026, conta do dono, só leituras):
//  - em casa agora: Praça (input.unitsInput[data-all-count]) — tsh-templates;
//  - VOLTANDO: overview_villages&mode=commands&type=return — cada linha traz a
//    aldeia de casa (link info_village&id=…), a chegada ("hoje às 13:12:03:000")
//    e as tropas por coluna (td.unit-item na ordem do cabeçalho). Inclui
//    apoios retirados;
//  - INDO (ataques/farm): mesma tela, type=attack — chegada ao alvo; a volta é
//    chegada + a mesma duração (distância × mais lenta);
//  - COLETA: screen=place&mode=scavenge — `var village = {…}` com
//    options[n].scavenging_squad.{unit_counts, return_time};
//  - RECRUTAMENTO: screen=train — lotes (unit_sprite <tropa>, "29 Bárbaros",
//    duração, conclusão); as tropas saem uma a uma dentro do lote.
// Parsers por regex (puros/testáveis). Ilegível = fica de fora (a previsão
// fica mais CONSERVADORA, nunca inventa tropa).

import { parseArrivalText } from '../../ext/core/timing/arrival-feedback';
import { travelDurationMs } from '../../ext/core/timing/precise-fire';
import { pacedGet } from '../../core/net';
import { serverNowMs } from '../../core/game-clock';
import { loadPlaceData } from './tsh-templates';
import { unitSpeedsMinutesPerField, type OwnVillage } from './tsh-game-data';
import type { UnitType } from '../../ext/modules/shared/module-types';

export const FORECAST_UNITS: readonly UnitType[] = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob'];

export type Units = Partial<Record<UnitType, number>>;

export interface CommandRow {
  /** Aldeia de casa (id do jogo) — de onde saiu / para onde volta. */
  homeVillageId: string;
  /** Chegada mostrada pelo jogo (quadro do servidor, ms). */
  arrivalMs: number;
  /** Alvo (só em ataques/apoios de ida). */
  target?: { x: number; y: number };
  units: Units;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ordem das colunas de tropas pelo cabeçalho (mundos sem arqueiro/paladino têm menos). */
function headerUnits(html: string): UnitType[] {
  const tableAt = html.indexOf('id="commands_table"');
  const scope = tableAt >= 0 ? html.slice(tableAt, html.indexOf('</tr>', tableAt) + 5) : html;
  const out: UnitType[] = [];
  for (const m of scope.matchAll(/unit_(\w+)\.(?:webp|png)/g)) {
    const u = m[1] as UnitType;
    if (FORECAST_UNITS.includes(u) && !out.includes(u)) out.push(u);
  }
  return out;
}

/** Linhas da Visão de Comandos (type=return ou type=attack). */
export function parseCommandRows(html: string, nowFrameMs: number): CommandRow[] {
  const order = headerUnits(html);
  if (order.length === 0) return [];
  const rows: CommandRow[] = [];
  for (const m of html.matchAll(/<tr class="nowrap[^"]*">([\s\S]*?)<\/tr>/g)) {
    const row = m[1] ?? '';
    const cells = [...row.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)];
    const home = /screen=info_village&(?:amp;)?id=(\d+)/.exec(row)?.[1];
    const arrivalText = stripTags(cells[2]?.[2] ?? '');
    const arrivalMs = parseArrivalText(arrivalText, nowFrameMs);
    if (home === undefined || arrivalMs === null) continue;
    const unitCells = cells.filter((c) => /unit-item/.test(c[1] ?? ''));
    const units: Units = {};
    unitCells.forEach((c, i) => {
      const unit = order[i];
      const n = Number(stripTags(c[2] ?? '').replace(/\./g, ''));
      if (unit !== undefined && Number.isFinite(n) && n > 0) units[unit] = n;
    });
    const label = stripTags(cells[0]?.[2] ?? '');
    const coord = /\((\d{1,3})\|(\d{1,3})\)/.exec(label);
    rows.push({
      homeVillageId: home,
      arrivalMs,
      ...(coord !== null ? { target: { x: Number(coord[1]), y: Number(coord[2]) } } : {}),
      units,
    });
  }
  return rows;
}

export interface ScavengeReturn {
  /** Volta, em ms a partir de AGORA (o jogo dá epoch UTC; o relógio local só serve como referência de "agora"). */
  inMs: number;
  units: Units;
}

/** Grupos em coleta (tela de coleta). */
export function parseScavengeReturns(html: string, nowLocalMs: number): ScavengeReturn[] {
  const m = /var village\s*=\s*(\{[\s\S]*?\});\s*\n/.exec(html);
  if (m === null || m[1] === undefined) return [];
  let village: { options?: Record<string, { scavenging_squad?: { unit_counts?: Record<string, number>; return_time?: number } | null }> };
  try {
    village = JSON.parse(m[1]) as typeof village;
  } catch {
    return [];
  }
  const out: ScavengeReturn[] = [];
  for (const option of Object.values(village.options ?? {})) {
    const squad = option.scavenging_squad;
    if (squad === null || squad === undefined || typeof squad.return_time !== 'number') continue;
    const units: Units = {};
    for (const [k, v] of Object.entries(squad.unit_counts ?? {})) {
      if (FORECAST_UNITS.includes(k as UnitType) && Number(v) > 0) units[k as UnitType] = Number(v);
    }
    out.push({ inMs: squad.return_time * 1000 - nowLocalMs, units });
  }
  return out;
}

export interface TrainBatch {
  unit: UnitType;
  count: number;
  startMs: number;
  finishMs: number;
}

function hmsMs(text: string): number | null {
  const m = /(\d+):(\d{2}):(\d{2})/.exec(text);
  return m === null ? null : ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
}

/** Fila de recrutamento (quartel, estábulo, oficina). */
export function parseTrainQueue(html: string, nowFrameMs: number): TrainBatch[] {
  const out: TrainBatch[] = [];
  for (const m of html.matchAll(/<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/g)) {
    const row = m[1] ?? '';
    const sprite = /class="unit_sprite[^"]*?\s(\w+)"/.exec(row);
    if (sprite === null) continue;
    const unit = sprite[1] as UnitType;
    if (!FORECAST_UNITS.includes(unit)) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => stripTags(c[1] ?? ''));
    const count = Number(/^(\d[\d.]*)/.exec(cells[0] ?? '')?.[1]?.replace(/\./g, '') ?? NaN);
    const durationMs = hmsMs(cells[1] ?? '');
    const finishMs = parseArrivalText(cells[2] ?? '', nowFrameMs);
    if (!Number.isFinite(count) || count <= 0 || durationMs === null || finishMs === null) continue;
    out.push({ unit, count, startMs: finishMs - durationMs, finishMs });
  }
  return out;
}

export interface Arrival {
  atMs: number;
  units: Units;
}

/**
 * Tropas em casa no instante T: em casa agora + tudo que chega até T
 * (retornos, coleta) + recrutadas até T (proporcional dentro do lote) −
 * o que outros comandos agendados levam antes de T. Puro.
 */
export function unitsAt(
  T: number,
  home: Units,
  arrivals: readonly Arrival[],
  train: readonly TrainBatch[],
  leaving: readonly { atMs: number; units: Units; all?: readonly UnitType[] }[] = [],
): Units {
  const out: Units = { ...home };
  const add = (u: UnitType, n: number): void => {
    out[u] = (out[u] ?? 0) + n;
  };
  for (const a of arrivals) {
    if (a.atMs > T) continue;
    for (const [u, n] of Object.entries(a.units)) add(u as UnitType, n ?? 0);
  }
  for (const b of train) {
    if (T >= b.finishMs) add(b.unit, b.count);
    else if (T > b.startMs) add(b.unit, Math.floor((b.count * (T - b.startMs)) / (b.finishMs - b.startMs)));
  }
  for (const l of [...leaving].sort((a, b) => a.atMs - b.atMs)) {
    // Sai no MESMO instante também disputa as tropas (conservador).
    if (l.atMs > T) continue;
    for (const [u, n] of Object.entries(l.units)) out[u as UnitType] = Math.max(0, (out[u as UnitType] ?? 0) - (n ?? 0));
    for (const u of l.all ?? []) out[u] = 0;
  }
  return out;
}

// ── Carregador (rede) ──────────────────────────────────────────────────────

export interface VillageForecast {
  home: Units | null;
  arrivals: Arrival[];
  train: TrainBatch[];
  readAt: number;
  /** Fontes que não puderam ser lidas (a previsão fica sem elas). */
  missing: string[];
}

const TTL_MS = 60_000;
let overviewCache: { at: number; returns: CommandRow[]; attacks: CommandRow[] } | null = null;
const villageCache = new Map<string, VillageForecast>();

async function overviewRows(): Promise<{ returns: CommandRow[]; attacks: CommandRow[] }> {
  if (overviewCache !== null && Date.now() - overviewCache.at < TTL_MS) return overviewCache;
  const now = serverNowMs();
  const [ret, att] = await Promise.all([
    pacedGet('/game.php?screen=overview_villages&mode=commands&type=return&page=-1', { fresh: true }),
    pacedGet('/game.php?screen=overview_villages&mode=commands&type=attack&page=-1', { fresh: true }),
  ]);
  overviewCache = { at: Date.now(), returns: parseCommandRows(ret, now), attacks: parseCommandRows(att, now) };
  return overviewCache;
}

/**
 * Tudo o que muda as tropas de UMA aldeia até um horário: em casa agora,
 * voltando (retornos + volta dos ataques/farm), coleta e recrutamento.
 * Leituras com ritmo humano (fila da rede) e cache de 60 s.
 */
export async function loadVillageForecast(village: OwnVillage): Promise<VillageForecast> {
  const hit = villageCache.get(village.id);
  if (hit !== undefined && Date.now() - hit.readAt < TTL_MS) return hit;
  const missing: string[] = [];
  const vid = encodeURIComponent(village.id);
  const nowFrame = serverNowMs();
  const [place, overview, scav, trainHtml, speeds] = await Promise.all([
    loadPlaceData(village.id).catch(() => null),
    overviewRows().catch(() => null),
    pacedGet(`/game.php?village=${vid}&screen=place&mode=scavenge`, { fresh: true }).catch(() => null),
    pacedGet(`/game.php?village=${vid}&screen=train`, { fresh: true }).catch(() => null),
    unitSpeedsMinutesPerField().catch(() => null),
  ]);
  const arrivals: Arrival[] = [];
  if (overview === null) missing.push('comandos voltando');
  else {
    for (const r of overview.returns) if (r.homeVillageId === village.id) arrivals.push({ atMs: r.arrivalMs, units: r.units });
    // Ataques/farm de ida: voltam em chegada + mesma duração (pela mais lenta).
    for (const r of overview.attacks) {
      if (r.homeVillageId !== village.id || r.target === undefined || speeds === null) continue;
      let slowest = 0;
      for (const [u, n] of Object.entries(r.units)) if ((n ?? 0) > 0) slowest = Math.max(slowest, speeds[u] ?? 0);
      if (slowest <= 0) continue;
      const dist = Math.sqrt((r.target.x - village.x) ** 2 + (r.target.y - village.y) ** 2);
      arrivals.push({ atMs: r.arrivalMs + travelDurationMs(dist * slowest), units: r.units });
    }
  }
  if (scav === null) missing.push('coleta');
  else for (const s of parseScavengeReturns(scav, Date.now())) arrivals.push({ atMs: nowFrame + s.inMs, units: s.units });
  const train = trainHtml === null ? [] : parseTrainQueue(trainHtml, nowFrame);
  if (trainHtml === null) missing.push('recrutamento');
  if (place?.available === null || place === null) missing.push('tropas em casa');
  const data: VillageForecast = { home: place?.available ?? null, arrivals, train, readAt: Date.now(), missing };
  villageCache.set(village.id, data);
  return data;
}
