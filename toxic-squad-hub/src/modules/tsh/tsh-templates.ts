// Dados do jogo para o formulário de comando (v3.3.0), verificados no BR142
// em 24/09/2026 com a conta do dono:
//  - MODELOS DE TROPAS do jogo: a Praça traz `TroopTemplates.current = {…};`
//    num <script> (id, name, quantidades em TEXTO, `use_all` = unidades que
//    vão "todas"). Os modelos do jogador ("FULL ATK", "nobre padrao"…) e os
//    do jogo ("Todas as tropas", "Fake", "Nobre").
//  - BÔNUS NOTURNO: vem das regras do mundo (tsh-world-rules) — fixo no
//    BR142 (23h–7h), escolhido por jogador no BR143/BR144.
// Parsers puros (fail-closed: formato estranho = lista vazia/null, nunca chute).

import { pacedGet } from '../../core/net';
import type { UnitType } from '../../ext/modules/shared/module-types';
import { cachedWorldRules, worldRules, type NightBonus } from './tsh-world-rules';

const UNITS: readonly UnitType[] = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob'];

export interface GameTemplate {
  id: string;
  name: string;
  /** Quantidades fixas (> 0). */
  units: Partial<Record<UnitType, number>>;
  /** Unidades que vão "todas". */
  useAll: UnitType[];
}

/** Lê `TroopTemplates.current = {...};` do HTML da Praça. */
export function parseGameTemplates(html: string): GameTemplate[] {
  const m = /TroopTemplates\.current\s*=\s*(\{[\s\S]*?\});\s*(?:\n|$)/.exec(html);
  if (m === null || m[1] === undefined) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch {
    return [];
  }
  if (raw === null || typeof raw !== 'object') return [];
  const out: GameTemplate[] = [];
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const t = value as Record<string, unknown>;
    const id = typeof t.id === 'string' || typeof t.id === 'number' ? String(t.id) : '';
    const name = typeof t.name === 'string' ? t.name.trim() : '';
    if (id === '' || name === '') continue;
    const units: Partial<Record<UnitType, number>> = {};
    for (const unit of UNITS) {
      const n = Math.floor(Number(t[unit] ?? 0));
      if (Number.isFinite(n) && n > 0) units[unit] = n;
    }
    const useAll = Array.isArray(t.use_all) ? (t.use_all.filter((u) => UNITS.includes(u as UnitType)) as UnitType[]) : [];
    // "Todas" vence a quantidade fixa da mesma unidade (como no jogo).
    for (const unit of useAll) delete units[unit];
    out.push({ id, name, units, useAll });
  }
  // Os do jogo ("all", "fake", "snob") por último; os do jogador na ordem do jogo.
  const builtin = new Set(['all', 'fake', 'snob']);
  return [...out.filter((t) => !builtin.has(t.id)), ...out.filter((t) => builtin.has(t.id))];
}

/**
 * Tropas disponíveis na Praça: `input.unitsInput[name][data-all-count]`
 * (ordem dos atributos livre). Nada legível = null (fail-closed).
 */
export function parseAvailableUnits(html: string): Partial<Record<UnitType, number>> | null {
  const out: Partial<Record<UnitType, number>> = {};
  let found = 0;
  for (const tag of html.match(/<input\b[^>]*>/g) ?? []) {
    if (!/\bunitsInput\b/.test(tag)) continue;
    // (?:^|\s): "name=" de verdade, nunca "data-name=".
    const name = /(?:^|\s)name="(\w+)"/.exec(tag)?.[1];
    const count = /(?:^|\s)data-all-count="(\d+)"/.exec(tag)?.[1];
    if (name === undefined || count === undefined || !UNITS.includes(name as UnitType)) continue;
    out[name as UnitType] = Number(count);
    found += 1;
  }
  return found > 0 ? out : null;
}

export interface PlaceData {
  templates: GameTemplate[];
  /** Tropas na aldeia no momento da leitura (null = ilegível). */
  available: Partial<Record<UnitType, number>> | null;
  readAt: number;
}

const placeCache = new Map<string, PlaceData>();
/** As tropas mudam: a leitura vale 60 s (os modelos, a sessão toda). */
const PLACE_TTL_MS = 60_000;

/** Modelos de tropas + tropas disponíveis da aldeia (uma leitura da Praça). */
export async function loadPlaceData(villageId: string): Promise<PlaceData> {
  const key = villageId.replace(/^n/, '');
  const hit = placeCache.get(key);
  if (hit !== undefined && Date.now() - hit.readAt < PLACE_TTL_MS) return hit;
  const html = await pacedGet(`/game.php?village=${encodeURIComponent(key)}&screen=place`, { fresh: true });
  const data: PlaceData = { templates: parseGameTemplates(html), available: parseAvailableUnits(html), readAt: Date.now() };
  if (data.templates.length === 0 && hit !== undefined) data.templates = hit.templates;
  placeCache.set(key, data);
  return data;
}

/** Modelos de tropas da conta (lidos da Praça da aldeia). */
export async function loadGameTemplates(villageId: string): Promise<GameTemplate[]> {
  return (await loadPlaceData(villageId)).templates;
}

// Bônus noturno: regras do mundo (modo fixo OU por jogador) — ver tsh-world-rules.
export { inNightBonus, parseNightBonus, type NightBonus } from './tsh-world-rules';

/** Bônus noturno do mundo atual (null = desconhecido). */
export async function worldNightBonus(): Promise<NightBonus | null> {
  return (await worldRules())?.night ?? null;
}

/** Bônus noturno já lido (sem rede) — para marcar cartões da Fila. */
export function cachedNightBonus(): NightBonus | null {
  return cachedWorldRules()?.night ?? null;
}
