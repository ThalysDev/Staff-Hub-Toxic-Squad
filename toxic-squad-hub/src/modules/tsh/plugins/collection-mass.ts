// Coleta em SEGUNDO PLANO (v3.6.0) — todas as aldeias, sem a tela aberta.
// Fonte: tela "Coleta em massa" (screen=place&mode=scavenge_mass&page=N),
// verificada no BR142 em 24/09/2026. `new ScavengeMassScreen(a, b, c, d, e)`:
//   a) níveis: loot_factor, duration_exponent/_initial_seconds/_factor, unlock_cost, prerequisite_option_ids
//   b) tropas que coletam: carry (lança 25, espada 15, bárbaro 10, arqueiro 10, leve 80, arq. cav. 50, pesada 50, paladino 100)
//   c) 10
//   d) aldeias da página (50): unit_counts_home, unit_carry_factor (bandeira de saque), has_rally_point, res,
//      options[n] {is_locked, unlock_time, scavenging_squad}
//   e) nota do jogo
// Inspirado no Mass Scavenging da comunidade (tempo-alvo + divisão por nível),
// com as regras da casa: reserva por tropa, reserva dos comandos agendados,
// 1 envio por ciclo. Puro/testável.

import type { UnitType } from '../../../ext/modules/shared/module-types';
import { SCAVENGE_UNITS, splitEquilibrada, type SplitSquad } from './collection-levels';

export interface MassLevelCfg {
  loot_factor: number;
  duration_exponent: number;
  duration_initial_seconds: number;
  duration_factor: number;
  unlock_cost?: { wood: number; stone: number; iron: number };
  prerequisite_option_ids?: number[];
}

export interface MassVillage {
  village_id: number;
  village_name: string;
  unit_counts_home: Partial<Record<string, number>>;
  unit_carry_factor: number;
  has_rally_point: boolean;
  res?: { wood: number; stone: number; iron: number };
  options: Record<string, { is_locked: boolean; unlock_time: number | null; scavenging_squad: { return_time?: number } | null }>;
}

export interface MassPage {
  levels: Record<string, MassLevelCfg>;
  carry: Partial<Record<UnitType, number>>;
  villages: MassVillage[];
  /** Última página (índice 0-based), pela paginação. */
  lastPage: number;
  /** Grupo de aldeias selecionado no jogo (0 = todos) — a tela só lista esse grupo. */
  groupId: number;
  /** Nome do grupo selecionado (vazio quando 'todos' ou ilegível). */
  groupName: string;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Formato mínimo que o planejador usa — qualquer desvio = página ilegível (fail-closed). */
function validShape(levels: Record<string, MassLevelCfg>, villages: MassVillage[]): boolean {
  const cfgs = Object.values(levels);
  if (cfgs.length === 0) return false;
  for (const c of cfgs) {
    if (!finite(c.loot_factor) || c.loot_factor <= 0) return false;
    if (!finite(c.duration_exponent) || c.duration_exponent <= 0) return false;
    if (!finite(c.duration_initial_seconds) || !finite(c.duration_factor) || c.duration_factor <= 0) return false;
  }
  for (const v of villages) {
    if (!finite(v.village_id) || typeof v.options !== 'object' || v.options === null) return false;
    if (typeof v.unit_counts_home !== 'object' || v.unit_counts_home === null) return false;
    if (!finite(v.unit_carry_factor)) return false;
  }
  return true;
}

/** Separa os argumentos de `new ScavengeMassScreen(...)` (JSON balanceado). */
function splitArgs(html: string): string[] | null {
  const marker = 'new ScavengeMassScreen(';
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const args: string[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let cur = '';
  for (let k = at + marker.length; k < html.length; k++) {
    const ch = html[k] as string;
    if (inStr) {
      cur += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      cur += ch;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    if (ch === ')' && depth === 0) {
      args.push(cur.trim());
      return args;
    }
    cur += ch;
  }
  return null;
}

/** Lê uma página da Coleta em massa (null = formato inesperado). */
export function parseScavengeMassPage(html: string): MassPage | null {
  const args = splitArgs(html);
  if (args === null || args.length < 4) return null;
  try {
    const levels = JSON.parse(args[0] as string) as Record<string, MassLevelCfg>;
    const unitData = JSON.parse(args[1] as string) as Record<string, { carry?: number }>;
    const villages = JSON.parse(args[3] as string) as MassVillage[];
    if (!Array.isArray(villages) || !validShape(levels, villages)) return null;
    const carry: Partial<Record<UnitType, number>> = {};
    for (const [u, d] of Object.entries(unitData)) if (typeof d.carry === 'number') carry[u as UnitType] = d.carry;
    let lastPage = 0;
    for (const m of html.matchAll(/mode=scavenge_mass(?:&amp;|&)page=(\d+)/g)) lastPage = Math.max(lastPage, Number(m[1]));
    const groupId = Number(/"group_id":"?(\d+)"?/.exec(html)?.[1] ?? 0);
    // Item do menu de grupos SEM link = o selecionado (">nome<").
    const sel = new RegExp(`data-group-id="${groupId}"[^>]*>&gt;([^&<]*)&lt;`).exec(html);
    return { levels, carry, villages, lastPage, groupId, groupName: (sel?.[1] ?? '').trim() };
  } catch {
    return null;
  }
}

/**
 * Capacidade (recursos) de UM nível para voltar em `hours` — inversa da
 * fórmula da tela: dur = ((cap²·100·fator²)^exp + inicial)·fatorDur.
 * Devolve cap·fator (igual para todos os níveis; divida pelo fator do nível).
 */
export function haulForHours(hours: number, cfg: Pick<MassLevelCfg, 'duration_exponent' | 'duration_initial_seconds' | 'duration_factor'>): number {
  const base = (hours * 3600) / cfg.duration_factor - cfg.duration_initial_seconds;
  if (base <= 0) return 0;
  return Math.sqrt(Math.pow(base, 1 / cfg.duration_exponent) / 100);
}

/** Tropas da aldeia que PODEM coletar: em casa − fica-em-casa − desligadas − teto do lote fixo. */
export function usableUnits(
  village: Pick<MassVillage, 'unit_counts_home'>,
  opts: { keepHome: Partial<Record<string, number>>; skipUnits: readonly string[]; fixedCaps?: Partial<Record<string, number>> | null },
): Partial<Record<UnitType, number>> {
  const out: Partial<Record<UnitType, number>> = {};
  for (const u of SCAVENGE_UNITS) {
    if (opts.skipUnits.includes(u)) continue;
    let n = Math.floor((village.unit_counts_home[u] ?? 0) - (opts.keepHome[u] ?? 0));
    const cap = opts.fixedCaps?.[u];
    if (opts.fixedCaps != null) n = Math.min(n, cap ?? 0);
    if (n > 0) out[u] = n;
  }
  return out;
}

/** Aldeia ofensiva? (população de ataque em casa > de defesa). Empate/nada = defensiva. */
export function isOffensive(home: Partial<Record<string, number>>): boolean {
  const n = (u: string): number => home[u] ?? 0;
  const off = n('axe') + 4 * n('light') + 5 * n('marcher') + 5 * n('ram') + 8 * n('catapult');
  const def = n('spear') + n('sword') + n('archer') + 6 * n('heavy');
  return off > def;
}

/** Duração (s) de um grupo — fórmula da tela, com a bandeira de saque da aldeia. */
export function squadSeconds(
  units: Partial<Record<string, number>>,
  carry: Partial<Record<UnitType, number>>,
  carryFactor: number,
  cfg: MassLevelCfg,
): number {
  let cap = 0;
  for (const [u, k] of Object.entries(units)) cap += (k ?? 0) * (carry[u as UnitType] ?? 0);
  cap *= carryFactor > 0 ? carryFactor : 1;
  if (cap <= 0) return 0;
  return (Math.pow(cap * cap * 100 * cfg.loot_factor * cfg.loot_factor, cfg.duration_exponent) + cfg.duration_initial_seconds) * cfg.duration_factor;
}

/** Níveis livres (desbloqueados, sem grupo fora, sem desbloqueio em curso). */
export function freeLevelIds(village: Pick<MassVillage, 'options'>): number[] {
  return Object.entries(village.options)
    .filter(([, o]) => !o.is_locked && o.scavenging_squad === null && o.unlock_time === null)
    .map(([id]) => Number(id))
    .sort((a, b) => a - b);
}

export interface MassPlanOptions {
  /** Horas que a coleta deve durar (0 = sem alvo: usa todas as tropas). */
  targetHours: number;
  /** Mínimo de tropas por grupo. */
  minUnits: number;
  /** 'equilibrada' = todos os níveis livres; número = só aquele nível. */
  level: 'equilibrada' | number;
}

export interface MassRequest {
  villageId: string;
  levelId: number;
  units: Partial<Record<UnitType, number>>;
}

/** Grupos de coleta de UMA aldeia a partir das tropas usáveis (vazio = nada a enviar). */
export function planVillage(
  village: MassVillage,
  page: Pick<MassPage, 'levels' | 'carry'>,
  usable: Partial<Record<UnitType, number>>,
  opts: MassPlanOptions,
): MassRequest[] {
  if (!village.has_rally_point) return [];
  const livres = freeLevelIds(village);
  const free = opts.level === 'equilibrada' ? livres : livres.filter((id) => id === opts.level);
  if (free.length === 0) return [];
  const lf = (id: number): number => page.levels[String(id)]?.loot_factor ?? 0.1;
  const first = splitFor(village, page, usable, free, opts, lf);
  // Nível descartado pelo mínimo: a tropa pensada para N níveis iria para
  // menos — refaz a conta nos níveis que sobraram (senão estoura o tempo-alvo).
  if (opts.targetHours > 0 && first.length > 0 && first.length < free.length) {
    return splitFor(village, page, usable, first.map((s) => s.levelId), opts, lf);
  }
  return first;
}

function splitFor(
  village: MassVillage,
  page: Pick<MassPage, 'levels' | 'carry'>,
  usable: Partial<Record<UnitType, number>>,
  free: readonly number[],
  opts: MassPlanOptions,
  lf: (id: number) => number,
): MassRequest[] {
  let scaled = usable;
  const cfg = page.levels[String(free[0])];
  if (opts.targetHours > 0 && cfg !== undefined) {
    const haul = haulForHours(opts.targetHours, cfg);
    const needed = free.reduce((s, id) => s + haul / lf(id), 0);
    const factor = village.unit_carry_factor > 0 ? village.unit_carry_factor : 1;
    const capacity = Object.entries(usable).reduce((s, [u, n]) => s + (n ?? 0) * (page.carry[u as UnitType] ?? 0) * factor, 0);
    if (capacity > needed && capacity > 0) {
      // Mais tropa que o necessário para o tempo-alvo: o resto fica em casa.
      const r = needed / capacity;
      scaled = {};
      for (const [u, n] of Object.entries(usable)) {
        const k = Math.floor((n ?? 0) * r);
        if (k > 0) scaled[u as UnitType] = k;
      }
    }
  }
  const squads: SplitSquad[] = splitEquilibrada(scaled, free, lf, opts.minUnits);
  return squads.map((s) => ({ villageId: String(village.village_id), levelId: s.levelId, units: s.units }));
}

/** Próximo nível a desbloquear numa aldeia (pré-requisito ok, recursos, nada desbloqueando). */
export function unlockCandidate(village: MassVillage, levels: Record<string, MassLevelCfg>): number | null {
  if (!village.has_rally_point) return null;
  if (Object.values(village.options).some((o) => o.unlock_time !== null)) return null; // já desbloqueando
  for (const [id, o] of Object.entries(village.options).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    if (!o.is_locked) continue;
    const cfg = levels[id];
    const prereqOk = (cfg?.prerequisite_option_ids ?? []).every((p) => village.options[String(p)]?.is_locked === false);
    const cost = cfg?.unlock_cost;
    const res = village.res;
    // Recursos ilegíveis = não paga (fail-closed: nada de gastar às cegas).
    const pays = cost !== undefined && res !== undefined && res.wood >= cost.wood && res.stone >= cost.stone && res.iron >= cost.iron;
    if (prereqOk && pays) return Number(id);
    return null; // só o PRÓXIMO da cadeia
  }
  return null;
}
