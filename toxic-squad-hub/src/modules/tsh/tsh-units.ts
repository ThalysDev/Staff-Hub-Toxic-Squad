// Ícones das unidades do Tribal Wars para as grades do painel (record do
// settings-ui e grade de unidades do commands-ui). O jogo serve os ícones em
// caminho relativo SAME-ORIGIN (`graphic/unit/unit_<key>.png`), que resolve
// contra a página game.php mesmo dentro do Shadow DOM do shell — os módulos
// Vanta já usam o mesmo caminho. Rótulos pt-BR únicos (mesmos textos da tela
// Comandos); chave desconhecida = fail-soft (mostra a própria key).

/** Chave de unidade do jogo → rótulo pt-BR. */
export const UNIT_LABELS: Record<string, string> = {
  spear: 'Lança',
  sword: 'Espada',
  axe: 'Machado',
  archer: 'Arqueiro',
  spy: 'Explorador',
  light: 'Cav. Leve',
  marcher: 'Arq. Cavalo',
  heavy: 'Cav. Pesada',
  ram: 'Aríete',
  catapult: 'Catapulta',
  knight: 'Paladino',
  snob: 'Nobre',
};

/** True quando a chave é uma unidade com ícone no jogo. */
export function isUnitKey(key: string): boolean {
  return UNIT_LABELS[key] !== undefined;
}

/** Rótulo pt-BR da unidade; fora da lista devolve a própria chave. */
export function unitLabelOrKey(key: string): string {
  return UNIT_LABELS[key] ?? key;
}

/** <img> do ícone da unidade (18px por padrão); alt/title com o rótulo pt-BR. */
export function unitIcon(key: string, size = 18): HTMLImageElement {
  const img = document.createElement('img');
  img.src = `graphic/unit/unit_${key}.png`;
  img.alt = unitLabelOrKey(key);
  img.title = unitLabelOrKey(key);
  img.draggable = false;
  img.width = size;
  img.height = size;
  img.style.verticalAlign = 'middle';
  return img;
}

/** Ordem canônica das unidades no jogo (fileiras sempre na mesma ordem). */
const UNIT_ORDER = Object.keys(UNIT_LABELS);

/**
 * Fileira de tropas (v3.2): ÍCONE oficial + quantidade em mono, no lugar de
 * "Machado ×200, Nobre ×1" — mais curto e reconhecível. O nome fica na dica
 * (title) e no texto acessível. Estilo inline: funciona no painel (Shadow
 * DOM) e nas injeções dentro da página do jogo.
 */
export function unitStrip(units: Partial<Record<string, number>>, opts?: { size?: number; max?: number; suffix?: string }): HTMLSpanElement {
  const size = opts?.size ?? 16;
  const max = opts?.max ?? 12;
  const strip = document.createElement('span');
  strip.className = 'tsh-unitstrip';
  strip.style.cssText = 'display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap;vertical-align:middle;';
  const entries = UNIT_ORDER.filter((key) => (units[key] ?? 0) > 0).map((key) => [key, units[key] ?? 0] as const);
  const fmt = (n: number): string => n.toLocaleString('pt-BR');
  const legenda = entries.map(([key, n]) => `${unitLabelOrKey(key)} ${fmt(n)}${opts?.suffix ?? ''}`).join(' · ');
  strip.title = legenda;
  strip.setAttribute('aria-label', legenda === '' ? 'sem tropas' : legenda);
  for (const [key, n] of entries.slice(0, max)) {
    const item = document.createElement('span');
    item.style.cssText = 'display:inline-flex;align-items:center;gap:3px;white-space:nowrap;';
    const img = unitIcon(key, size);
    img.setAttribute('aria-hidden', 'true');
    const count = document.createElement('span');
    count.style.cssText = "font-family:var(--shs-font-mono,Consolas,monospace);font-variant-numeric:tabular-nums;";
    count.textContent = `${fmt(n)}${opts?.suffix ?? ''}`;
    item.append(img, count);
    strip.appendChild(item);
  }
  if (entries.length > max) {
    const more = document.createElement('span');
    more.textContent = `+${entries.length - max}`;
    more.style.cssText = 'color:var(--shs-muted,#6b665d);';
    strip.appendChild(more);
  }
  if (entries.length === 0) strip.textContent = '—';
  return strip;
}

/**
 * Tropas de um comando para exibição: quantidades fixas + unidades em "Todas"
 * (ícone + "todas") — v3.3.0.
 */
export function commandUnitStrip(
  record: { units: Partial<Record<string, number>>; allUnits?: ReadonlyArray<string>; percentMode?: boolean; unitsPercent?: Partial<Record<string, number>> },
  opts?: { size?: number; max?: number },
): HTMLSpanElement {
  if (record.percentMode === true) return unitStrip(record.unitsPercent ?? {}, { ...opts, suffix: '%' });
  const strip = unitStrip(record.units, opts);
  const all = UNIT_ORDER.filter((key) => record.allUnits?.includes(key) === true);
  if (all.length === 0) return strip;
  if (strip.textContent === '—') strip.textContent = '';
  const size = opts?.size ?? 16;
  for (const key of all) {
    const item = document.createElement('span');
    item.style.cssText = 'display:inline-flex;align-items:center;gap:3px;white-space:nowrap;';
    const img = unitIcon(key, size);
    img.setAttribute('aria-hidden', 'true');
    const tag = document.createElement('span');
    tag.style.cssText = 'font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.02em;color:var(--shs-action,#2e6b3e);';
    tag.textContent = 'todas';
    item.append(img, tag);
    strip.appendChild(item);
  }
  const legenda = [strip.title, ...all.map((key) => `${unitLabelOrKey(key)}: todas`)].filter((t) => t !== '').join(' · ');
  strip.title = legenda;
  strip.setAttribute('aria-label', legenda);
  return strip;
}

/** <img> do ícone de um PRÉDIO do jogo (`graphic/buildings/<key>.png`). */
export function buildingIcon(key: string, size = 20): HTMLImageElement {
  const img = document.createElement('img');
  img.src = `graphic/buildings/${key}.png`;
  img.alt = '';
  img.draggable = false;
  img.width = size;
  img.height = size;
  img.style.verticalAlign = 'middle';
  img.setAttribute('aria-hidden', 'true');
  return img;
}

/** Tipo de comando → unidade que o representa no jogo (ícone didático). */
const KIND_UNIT: Record<string, string> = { attack: 'axe', support: 'spear', noble: 'snob', fake: 'ram' };

/** Ícone do TIPO de comando (nobre, ataque, apoio, fake); null = sem ícone de unidade (cancelar). */
export function kindIcon(kind: string, size = 16): HTMLImageElement | null {
  const unit = KIND_UNIT[kind];
  if (unit === undefined) return null;
  const img = unitIcon(unit, size);
  img.setAttribute('aria-hidden', 'true');
  img.title = '';
  return img;
}
