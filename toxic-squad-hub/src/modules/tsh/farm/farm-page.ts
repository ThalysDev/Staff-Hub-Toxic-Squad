// Leitor PURO da página do Assistente de Saque (screen=am_farm) para a
// Central de Farm (v3.7.0). Regex sobre o HTML (sem DOMParser: roda igual
// no teste e na página). Verificado no BR142 em 24/09/2026 — fixture real em
// __fixtures__/br142-am-farm.html. Fail-closed: formato inesperado = null.
//
// O que a página dá, por linha (tr#village_<alvo>):
//   dots/<cor>.webp      → resultado do último ataque (green/yellow/red/blue/red_blue/red_yellow)
//   max_loot/<0|1>.webp  → 1 = saque completo (ainda sobrou recurso), 0 = parcial
//   (x|y) Kxx            → coordenadas do alvo
//   célula da muralha    → nível descoberto ("?" = desconhecido)
//   distância            → campos a partir da aldeia da página
//   sendUnits(this, alvo, idModelo) → botões A/B (modelos do jogo)
//   sendUnitsFromReport(this, alvo, idRelatório, …) → botão C (o jogo calcula
//     as tropas pelo último relatório de exploradores)

export type ReportColor = 'green' | 'yellow' | 'red' | 'blue' | 'red_blue' | 'red_yellow' | 'none';

export interface FarmRow {
  targetId: string;
  x: number;
  y: number;
  color: ReportColor;
  /** true = o último saque encheu a carga (deve ter sobrado recurso). */
  fullHaul: boolean | null;
  wall: number | null;
  distance: number;
  /** Relatório do botão C (null = C indisponível para este alvo). */
  cReportId: string | null;
  /** Tropas que o C mandaria (previsão do próprio jogo). */
  cForecast: Record<string, number> | null;
  /** Já há ataque a caminho (ícone do jogo na linha). */
  attacked: boolean;
  /** Bárbara = a linha só traz coordenadas (aldeia de jogador vem com nome). */
  barbarian: boolean;
}

export interface FarmTemplates {
  /** id numérico do modelo A/B no jogo e as tropas dele. */
  A: { id: string; units: Record<string, number> } | null;
  B: { id: string; units: Record<string, number> } | null;
}

export interface FarmPage {
  sourceId: string;
  source: { x: number; y: number } | null;
  templates: FarmTemplates;
  /** Tropas em casa ("Disponibilidade"). */
  home: Record<string, number>;
  /** Tropas que o botão C pode usar (caixas marcadas em "Disponibilidade"). */
  cUnits: string[];
  rows: FarmRow[];
  /** Última página (0-based) pela paginação. */
  lastPage: number;
}

const COLORS: readonly ReportColor[] = ['green', 'yellow', 'red', 'blue', 'red_blue', 'red_yellow'];

const unesc = (s: string): string => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');

function templatesFrom(html: string): FarmTemplates | null {
  const form = /<table[^>]*class="[^"]*loot_assistant_templates[^"]*"[\s\S]*?<\/table>/.exec(html)?.[0];
  if (form === undefined) return null;
  const ids = [...form.matchAll(/name="template\[(\d+)\]\[id\]"/g)].map((m) => m[1] ?? '');
  const tpl = (id: string | undefined): FarmTemplates['A'] => {
    if (id === undefined || id === '') return null;
    const units: Record<string, number> = {};
    for (const m of form.matchAll(new RegExp(`name="([a-z]+)\\[${id}\\]"[^>]*value="(\\d+)"`, 'g'))) {
      const n = Number(m[2]);
      if (n > 0) units[m[1] ?? ''] = n;
    }
    return { id, units };
  };
  return { A: tpl(ids[0]), B: tpl(ids[1]) };
}

function rowFrom(tr: string, targetId: string): FarmRow | null {
  const coords = /\((\d{1,3})\|(\d{1,3})\)\s*K\d+/.exec(tr);
  if (coords === null) return null;
  const label = (/screen=report[^>]*>([^<]*)<\/a>/.exec(tr)?.[1] ?? '').replace(/\(\d{1,3}\|\d{1,3}\)\s*K\d+/, '').trim().toLocaleLowerCase('pt-BR');
  const color = (/graphic\/dots\/([a-z_]+)\.(?:webp|png)/.exec(tr)?.[1] ?? 'none') as ReportColor;
  const loot = /graphic\/max_loot\/([01])\.(?:webp|png)/.exec(tr)?.[1];
  // Células simples depois do bloco de recursos: muralha e distância.
  const cells = [...tr.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => (m[1] ?? '').trim());
  const distIdx = cells.findIndex((c) => /^\d+(?:\.\d+)?$/.test(c) && c.includes('.'));
  const distance = distIdx >= 0 ? Number(cells[distIdx]) : NaN;
  const wallRaw = distIdx > 0 ? cells[distIdx - 1] : undefined;
  if (!Number.isFinite(distance)) return null;
  const c = new RegExp(`sendUnitsFromReport\\(this, ${targetId}, (\\d+)`).exec(tr);
  const cDisabled = /farm_icon_c[^"]*farm_icon_disabled/.test(tr);
  let cForecast: Record<string, number> | null = null;
  const fc = /data-units-forecast="([^"]*)"/.exec(tr)?.[1];
  if (fc !== undefined) {
    try {
      const raw = JSON.parse(unesc(fc)) as Record<string, unknown>;
      cForecast = {};
      for (const [u, v] of Object.entries(raw)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) cForecast[u] = n;
      }
    } catch {
      cForecast = null;
    }
  }
  return {
    targetId,
    x: Number(coords[1]),
    y: Number(coords[2]),
    color: COLORS.includes(color) ? color : 'none',
    fullHaul: loot === undefined ? null : loot === '1',
    wall: wallRaw !== undefined && /^\d+$/.test(wallRaw) ? Number(wallRaw) : null,
    distance,
    cReportId: c !== null && !cDisabled ? (c[1] ?? null) : null,
    cForecast,
    attacked: /graphic\/command\/attack/.test(tr),
    barbarian: label === '' || label === 'aldeia bárbara',
  };
}

/** Lê uma página do Assistente de Saque (null = formato inesperado). */
export function parseFarmPage(html: string): FarmPage | null {
  const sourceId = /screen=am_farm&amp;action=edit_all|screen=am_farm&action=edit_all/.test(html)
    ? (/village=(\d+)&(?:amp;)?screen=am_farm&(?:amp;)?action=edit_all/.exec(html)?.[1] ?? '')
    : '';
  const templates = templatesFrom(html);
  if (sourceId === '' || templates === null || !/id="plunder_list"/.test(html)) return null;
  const home: Record<string, number> = {};
  for (const m of html.matchAll(/data-unit-count="(\d+)"[^>]*class="[^"]*unit-item-([a-z]+)/g)) home[m[2] ?? ''] = Number(m[1]);
  const unitsBlock = /<table id="units_home"[\s\S]*?<\/table>/.exec(html)?.[0] ?? '';
  const cUnits = [...unitsBlock.matchAll(/<input type="checkbox" name="([a-z]+)"[^>]*checked/g)].map((m) => m[1] ?? '');
  const src = /<b class="nowrap">\((\d{1,3})\|(\d{1,3})\)/.exec(html);
  const rows: FarmRow[] = [];
  for (const m of html.matchAll(/<tr id="village_(\d+)"[\s\S]*?<\/tr>/g)) {
    const row = rowFrom(m[0], m[1] ?? '');
    if (row === null) return null; // linha em formato novo: não adivinha
    rows.push(row);
  }
  let lastPage = 0;
  for (const m of html.matchAll(/Farm_page=(\d+)/g)) lastPage = Math.max(lastPage, Number(m[1]));
  return {
    sourceId,
    source: src === null ? null : { x: Number(src[1]), y: Number(src[2]) },
    templates,
    home,
    cUnits,
    rows,
    lastPage,
  };
}
