// Simulador de combate UNIFICADO (correção do P1-5 da auditoria: o Vanta
// tinha DUAS implementações divergentes — a do Dashboard ignorava bônus de
// defesa/def_flag e o caso "mais de 100", a da Saúde do Stack não; o mesmo
// stack podia receber OK num módulo e NOK no outro). Aqui há UMA fonte usada
// pelos dois módulos.

import { pacedDoc } from './vanta-net';
import { parsePtBrInt } from './vanta-utils';

/** Unidades defensivas consideradas no simulador (mesma lista do Vanta). */
export const DEF_UNITS = ['spear', 'sword', 'archer', 'spy', 'heavy', 'knight', 'snob'] as const;

export interface SimBoosts {
  /** Composição do clear atacante (ex.: { axe: 7000, spy: 50, ... }). */
  clear: Record<string, number>;
  /** Bônus ofensivos por unidade em % (ex.: { axe: 8 }). */
  offBoosts: Record<string, number>;
  /** Bandeira de ataque (índice 0-9; -1 = nenhuma). */
  attFlag: number;
}

export interface SimOptions extends SimBoosts {
  villageId: string;
  /** Tropas DEFENSORAS por unidade (somadas com suportes a chegar). */
  troops: Record<string, number>;
  wall: number;
  /** Benefícios de defesa lidos da página (parseDefenseEffects). */
  defBenefits: unknown[];
  /** Bandeira de defesa (índice; -1 = nenhuma). */
  defFlag: number;
  /** Unidades existentes no mundo (gd.units) — filtra boosts inválidos. */
  worldUnits: string[];
}

/**
 * Benefícios de defesa + bandeira da vila, lidos do #show_effects da página
 * overview (port fiel da versão COMPLETA do Vanta — a que a Saúde do Stack usava).
 */
export function parseDefenseEffects(root: Document | HTMLElement): { defBenefits: unknown[]; defFlag: number } {
  const defBenefits: unknown[] = [];
  let defFlag = -1;
  const boostMap: Record<string, { type: string; desc?: string }> = {
    wall: { type: 'b_walleffectiveness' },
    unit_sword: { type: 'b_unitstat', desc: 'defense_all' },
    unit_spear: { type: 'b_unitstat', desc: 'defense_all' },
    unit_archer: { type: 'b_unitstat', desc: 'defense_all' },
    unit_heavy: { type: 'b_unitstat', desc: 'defense_all' },
    benefit_resist_demolition: { type: 'b_resistdemolition' },
  };
  const showEffects = (root as Document).getElementById?.('show_effects') ?? (root as HTMLElement).querySelector?.('#show_effects');
  if (showEffects === null || showEffects === undefined) return { defBenefits, defFlag };
  showEffects.querySelectorAll('.effect_tooltip.village_overview_effect img').forEach((img) => {
    const src = img.getAttribute('src') ?? '';
    const name = src.split('/').pop()?.replace('.webp', '').replace('.png', '') ?? '';
    if (name === 'night') return;
    const mapping = boostMap[name];
    if (mapping === undefined) return;
    const amountMatch = (img.parentElement?.textContent ?? '').trim().match(/\d+/);
    const amount = amountMatch !== null ? parseInt(amountMatch[0], 10) : 0;
    const boost = { inputs: [amount], type: mapping.type } as { inputs: unknown[]; type: string };
    if (mapping.desc !== undefined) boost.inputs.push(name.replace('unit_', ''), mapping.desc);
    defBenefits.push(boost);
  });
  const flagImg = showEffects.querySelector('.village_overview_effect img[src*="flags"]');
  if (flagImg !== null) {
    const flagText = flagImg.closest('td')?.querySelector('a')?.textContent?.trim() ?? '';
    const flagMatch = flagText.match(/\d+/);
    if (flagMatch !== null) defFlag = parseInt(flagMatch[0], 10) - 1;
  }
  return { defBenefits, defFlag };
}

/** Monta a URL do simulador (place&mode=sim) com TODOS os parâmetros. */
export function buildSimUrl(opts: SimOptions): string {
  let q = `/game.php?village=${opts.villageId}&screen=place&mode=sim&simulate&def_wall=${opts.wall}`;
  DEF_UNITS.forEach((u) => {
    const n = opts.troops[u] ?? 0;
    if (n > 0) q += `&def_${u}=${n}`;
  });
  Object.entries(opts.clear).forEach(([u, n]) => {
    if (n > 0) q += `&att_${u}=${n}`;
  });
  q += `&def_benefits=${encodeURIComponent(JSON.stringify(opts.defBenefits))}`;
  const attBenefits: unknown[] = [];
  Object.entries(opts.offBoosts).forEach(([unit, pct]) => {
    if (pct > 0 && opts.worldUnits.includes(unit)) {
      attBenefits.push({ inputs: [String(pct), unit, 'attack'], type: 'b_unitstat' });
    }
  });
  q += `&att_benefits=${encodeURIComponent(JSON.stringify(attBenefits))}`;
  q += '&belief_def=on&belief_att=on';
  if (opts.defFlag >= 0) q += `&def_flag=${opts.defFlag}`;
  if (opts.attFlag >= 0) q += `&att_flag=${opts.attFlag}`;
  return q;
}

export interface SimResult {
  /** Quantos clears até quebrar o stack ("mais de 100" → 100 + over100=true). */
  clears: number;
  over100: boolean;
  postWall: number;
  totalPop: number;
}

/**
 * Roda o simulador (pacedGet + cache) e parseia o resultado. ÚNICA fonte de
 * verdade para os dois módulos (dashboard e saúde do stack).
 */
export async function runSimulator(opts: SimOptions): Promise<{ url: string; result: SimResult }> {
  const url = buildSimUrl(opts);
  const doc = await pacedDoc(url, { fresh: true });
  const result = parseSimResult(doc, opts.wall);
  return { url, result };
}

/** Parse do HTML do simulador (exportado p/ teste unitário com HTML fixture). */
export function parseSimResult(doc: Document, fallbackWall: number): SimResult {
  const result: SimResult = { clears: 0, over100: false, postWall: fallbackWall, totalPop: 0 };

  // Clears: "Serão necessários mais <b>N</b> ataques..." / "mais de 100".
  const italicP = doc.querySelector('#content_value p[style*="font-style"]');
  if (italicP !== null) {
    const b = italicP.querySelector('b');
    if (b !== null) {
      const text = b.textContent?.trim() ?? '';
      if (text.includes('mais de')) {
        result.clears = 100;
        result.over100 = true;
      } else {
        result.clears = parsePtBrInt(text);
      }
    }
  }

  // Dano de muralha: th "aríetes" → td seguinte → último <b>.
  const wallTh = [...doc.querySelectorAll('th')].find((th) => (th.textContent ?? '').includes('aríetes'));
  if (wallTh !== undefined) {
    const wallTd = wallTh.nextElementSibling;
    if (wallTd !== null) {
      const bolds = wallTd.querySelectorAll('b');
      const lastBold = bolds.length > 0 ? (bolds[bolds.length - 1] ?? null) : null;
      if (bolds.length >= 2 && lastBold !== null) {
        const parsed = parsePtBrInt(lastBold.textContent);
        result.postWall = parsed !== 0 ? parsed : fallbackWall;
      }
    }
  }

  // População total: linha "Defensor" → último td.
  const defTd = [...doc.querySelectorAll('#simulation_result td')].find((td) => (td.textContent ?? '').trim() === 'Defensor');
  if (defTd !== undefined) {
    const defRow = defTd.closest('tr');
    const lastTd = defRow?.querySelector('td:last-child');
    if (lastTd !== null && lastTd !== undefined) {
      result.totalPop = parsePtBrInt(lastTd.textContent);
    }
  }

  return result;
}
