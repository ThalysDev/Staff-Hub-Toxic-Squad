// Plano GLOBAL da Central de Farm (v3.7.0) — ideia do FarmGod da comunidade,
// feita do nosso jeito: a lista do Assistente de Saque é lida UMA vez por
// rodada; cada alvo vai para a aldeia própria MAIS PRÓXIMA que tem a tropa
// do lote; o mesmo alvo não recebe dois farms chegando com menos de X
// minutos de diferença (chegada = distância × velocidade da tropa mais
// lenta, contando os ataques que já estão a caminho). Puro/testável.

import type { FarmRow, FarmTemplates } from './farm-page';
import { fits, reportKind, spend, type FarmConfig, type FarmSkip } from './farm-plan';

export interface OwnFarmVillage {
  id: string;
  name: string;
  x: number;
  y: number;
  /** Tropas livres (em casa − fica em casa − reservadas pelo Agendador). */
  free: Record<string, number>;
}

/** Visão de Tropas "suas próprias em casa" (overview_villages&mode=units&type=own_home). */
export interface UnitsHomeRow {
  id: string;
  name: string;
  x: number;
  y: number;
  units: Record<string, number>;
}

export function parseUnitsHome(html: string): { rows: UnitsHomeRow[]; full: boolean } | null {
  const table = /<table id="units_table"[\s\S]*?<\/table>/.exec(html)?.[0];
  if (table === undefined) return null;
  const head = /<thead>[\s\S]*?<\/thead>/.exec(table)?.[0] ?? '';
  const order = [...head.matchAll(/unit_([a-z]+)\.(?:webp|png)/g)].map((m) => m[1] ?? '');
  if (order.length === 0) return null;
  const rows: UnitsHomeRow[] = [];
  for (const m of table.matchAll(/<tbody[^>]*>([\s\S]*?)<\/tbody>/g)) {
    const body = m[1] ?? '';
    const id = /data-id="(\d+)"/.exec(body)?.[1];
    const label = /data-text="([^"]*)"[^>]*>\s*[^<]*\((\d{1,3})\|(\d{1,3})\)/.exec(body);
    if (id === undefined || label === null) return null;
    const cells = [...body.matchAll(/<td class="unit-item[^"]*">(\d+)<\/td>/g)].map((c) => Number(c[1]));
    if (cells.length !== order.length) return null;
    const units: Record<string, number> = {};
    order.forEach((u, i) => {
      const n = cells[i] ?? 0;
      if (n > 0) units[u] = n;
    });
    const name = (label[1] ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    rows.push({ id, name, x: Number(label[2]), y: Number(label[3]), units });
  }
  // A página traz até 1000 aldeias: 1000 = pode haver a próxima página.
  return { rows, full: rows.length >= 1000 };
}

export const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Minutos de viagem do lote (tropa mais lenta; speeds em min/campo). */
export function travelMinutes(units: Record<string, number>, dist: number, speeds: Record<string, number>): number {
  let slowest = 0;
  for (const [u, n] of Object.entries(units)) if (n > 0) slowest = Math.max(slowest, speeds[u] ?? 0);
  return slowest * dist;
}

export interface FarmPlanItem {
  sourceId: string;
  sourceName: string;
  targetId: string;
  target: { x: number; y: number };
  kind: 'A' | 'B' | 'C';
  templateId?: string;
  reportId?: string;
  units: Record<string, number>;
  distance: number;
  arrivalMs: number;
}

export interface FarmPlanResult {
  items: FarmPlanItem[];
  skipped: Partial<Record<FarmSkip, number>>;
  /** Alvos com muralha acima do limite (para o card "muralhas para quebrar"). */
  walls: { targetId: string; x: number; y: number; wall: number }[];
}

/** Lote que a regra do relatório pede para a linha (sem olhar tropa nem origem). */
function lotFor(row: FarmRow, cfg: FarmConfig, templates: FarmTemplates): FarmPlanItem['kind'] | FarmSkip {
  const kind = reportKind(row);
  if (kind === null) return 'sem-relatorio';
  let action = cfg.actions[kind];
  if (action === 'C') {
    if (row.cReportId !== null && row.cForecast !== null && Object.keys(row.cForecast).length > 0) return 'C';
    action = cfg.cFallback;
  }
  if (action === 'ignorar') return 'ignorar';
  const tpl = templates[action];
  return tpl === null || Object.keys(tpl.units).length === 0 ? 'sem-modelo' : action;
}

/**
 * Monta a rodada. `arrivals` = chegadas já previstas por alvo "x|y" (ataques a
 * caminho + os que esta Central mandou). Cada aldeia gasta suas tropas livres
 * conforme recebe alvos (nunca promete a mesma tropa duas vezes).
 */
export function planFarmRound(input: {
  rows: readonly FarmRow[];
  villages: readonly OwnFarmVillage[];
  templates: FarmTemplates;
  cfg: FarmConfig;
  speeds: Record<string, number>;
  arrivals: ReadonlyMap<string, readonly number[]>;
  nowMs: number;
  /** Alvos "x|y" bloqueados (envio sem confirmação recente). */
  blocked?: ReadonlySet<string>;
}): FarmPlanResult {
  const { cfg } = input;
  const skipped: FarmPlanResult['skipped'] = {};
  const skip = (r: FarmSkip): void => {
    skipped[r] = (skipped[r] ?? 0) + 1;
  };
  const walls: FarmPlanResult['walls'] = [];
  const free = new Map(input.villages.map((v) => [v.id, { ...v.free }]));
  const arrivals = new Map<string, number[]>([...input.arrivals].map(([k, v]) => [k, [...v]]));
  const items: FarmPlanItem[] = [];
  const gapMs = cfg.targetIntervalMin * 60_000;
  for (const row of input.rows) {
    if (cfg.maxWall >= 0 && row.wall !== null && row.wall > cfg.maxWall) {
      walls.push({ targetId: row.targetId, x: row.x, y: row.y, wall: row.wall });
      skip('muralha');
      continue;
    }
    if (input.blocked?.has(`${row.x}|${row.y}`) === true) {
      skip('intervalo');
      continue;
    }
    if (!cfg.farmPlayers && !row.barbarian) {
      skip('jogador');
      continue;
    }
    if (cfg.skipAttacked && row.attacked) {
      skip('a-caminho');
      continue;
    }
    const lot = lotFor(row, cfg, input.templates);
    if (lot !== 'A' && lot !== 'B' && lot !== 'C') {
      skip(lot);
      continue;
    }
    const units = lot === 'C' ? (row.cForecast ?? {}) : (input.templates[lot]?.units ?? {});
    // Aldeia mais próxima dentro do alcance que tem o lote.
    let best: { v: OwnFarmVillage; d: number } | null = null;
    let inRange = false;
    for (const v of input.villages) {
      const d = distance(v, row);
      if (d > cfg.maxDistance) continue;
      inRange = true;
      if (best !== null && d >= best.d) continue;
      if (fits(units, free.get(v.id) ?? {})) best = { v, d };
    }
    if (best === null) {
      skip(inRange ? 'sem-tropa' : 'longe');
      continue;
    }
    const key = `${row.x}|${row.y}`;
    const arrivalMs = input.nowMs + travelMinutes(units, best.d, input.speeds) * 60_000;
    const near = (arrivals.get(key) ?? []).some((t) => Math.abs(t - arrivalMs) < gapMs);
    if (near) {
      skip('intervalo');
      continue;
    }
    free.set(best.v.id, spend(free.get(best.v.id) ?? {}, units));
    arrivals.set(key, [...(arrivals.get(key) ?? []), arrivalMs]);
    items.push({
      sourceId: best.v.id,
      sourceName: best.v.name,
      targetId: row.targetId,
      target: { x: row.x, y: row.y },
      kind: lot,
      ...(lot === 'C' ? { reportId: row.cReportId ?? '' } : { templateId: input.templates[lot]?.id ?? '' }),
      units,
      distance: Math.round(best.d * 10) / 10,
      arrivalMs,
    });
  }
  return { items, skipped, walls };
}
