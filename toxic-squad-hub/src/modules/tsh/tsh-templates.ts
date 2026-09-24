// Dados do jogo para o formulário de comando (v3.3.0), verificados no BR142
// em 24/09/2026 com a conta do dono:
//  - MODELOS DE TROPAS do jogo: a Praça traz `TroopTemplates.current = {…};`
//    num <script> (id, name, quantidades em TEXTO, `use_all` = unidades que
//    vão "todas"). Os modelos do jogador ("FULL ATK", "nobre padrao"…) e os
//    do jogo ("Todas as tropas", "Fake", "Nobre").
//  - BÔNUS NOTURNO: interface.php?func=get_config → <night><active/>
//    <start_hour/><end_hour/> (BR142: ativo, 23h–7h).
// Parsers puros (fail-closed: formato estranho = lista vazia/null, nunca chute).

import { pacedGet } from '../../core/net';
import type { UnitType } from '../../ext/modules/shared/module-types';

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

const templatesCache = new Map<string, GameTemplate[]>();

/** Modelos de tropas da conta (lidos da Praça da aldeia; cache da sessão). */
export async function loadGameTemplates(villageId: string): Promise<GameTemplate[]> {
  const key = villageId.replace(/^n/, '');
  const hit = templatesCache.get(key);
  if (hit !== undefined) return hit;
  const html = await pacedGet(`/game.php?village=${encodeURIComponent(key)}&screen=place`);
  const list = parseGameTemplates(html);
  if (list.length > 0) templatesCache.set(key, list);
  return list;
}

export interface NightBonus {
  active: boolean;
  startHour: number;
  endHour: number;
}

/** <night> do get_config (null = não dá para saber). */
export function parseNightBonus(xml: string): NightBonus | null {
  const block = /<night>([\s\S]*?)<\/night>/.exec(xml)?.[1];
  if (block === undefined) return null;
  const num = (tag: string): number => {
    const v = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(block)?.[1];
    return v === undefined || v === '' ? Number.NaN : Number(v);
  };
  const active = num('active');
  const startHour = num('start_hour');
  const endHour = num('end_hour');
  if (![active, startHour, endHour].every(Number.isFinite)) return null;
  return { active: active === 1, startHour, endHour };
}

let nightCache: NightBonus | null | undefined;

export async function worldNightBonus(): Promise<NightBonus | null> {
  if (nightCache !== undefined) return nightCache;
  try {
    nightCache = parseNightBonus(await pacedGet('/interface.php?func=get_config'));
  } catch {
    nightCache = null;
  }
  return nightCache;
}

/** A hora (relógio do servidor) cai no bônus noturno? Janela pode virar a meia-noite (23h–7h). */
export function inNightBonus(serverMs: number, nb: NightBonus | null): boolean {
  if (nb === null || !nb.active) return false;
  const h = new Date(serverMs).getHours();
  return nb.startHour > nb.endHour ? h >= nb.startHour || h < nb.endHour : h >= nb.startHour && h < nb.endHour;
}
