// Kit das telas de configuração próprias (v3.10.0): os mesmos blocos que a
// Coleta e o Construtor usam — resumo no topo, cartões-rádio, linhas "ícone +
// título/explicação … controle", avisos. Tudo por textContent (nunca HTML).

import { icon, type IconName } from '../../../core/icons';

export const KIT_CSS = `
.pk-hero { display: flex; gap: 12px; align-items: center; padding: 12px; margin: 0 0 14px; border-radius: 10px;
  background: var(--shs-bg-inset); border: 1px solid var(--shs-border); }
.pk-hero-ic { flex: none; display: flex; gap: 2px; }
.pk-hero-text { font-size: 12.5px; line-height: 1.45; color: var(--shs-ink-strong); }
.pk-hero-text b { color: var(--shs-action); }
.pk-note { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; margin: 0 0 12px; border-radius: 8px;
  background: var(--shs-info-bg, var(--shs-bg-inset)); font-size: 12px; line-height: 1.4; color: var(--shs-ink-strong); }
.pk-note .shs-ic { flex: none; margin-top: 1px; color: var(--shs-action); }
.pk-note--warn { background: var(--shs-warn-soft, var(--shs-bg-inset)); }
.pk-note--warn .shs-ic { color: var(--shs-warn, #b8862b); }
.pk-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.pk-cards + * { margin-top: 10px; }
.pk-card { position: relative; display: flex; gap: 10px; align-items: flex-start; padding: 10px; border-radius: 9px; cursor: pointer;
  border: 1px solid var(--shs-border-strong); background: var(--shs-bg-card); }
.pk-card:hover { border-color: var(--shs-action); }
.pk-card input { position: absolute; opacity: 0; pointer-events: none; }
.pk-card:has(input:checked) { border-color: var(--shs-action); box-shadow: inset 0 0 0 1px var(--shs-action); }
.pk-card:has(input:focus-visible) { outline: 2px solid var(--shs-brass); outline-offset: 1px; }
.pk-card-ic { flex: none; width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center; background: var(--shs-bg-inset); color: var(--shs-action); }
.pk-card-t { display: block; font-weight: 600; font-size: 12.5px; color: var(--shs-ink-strong); }
.pk-card-d { display: block; font-size: 11.5px; line-height: 1.35; color: var(--shs-muted); margin-top: 2px; }
.pk-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 0; border-top: 1px solid var(--shs-border); }
.pk-row:first-child { border-top: 0; }
.pk-row-l { display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: var(--shs-ink-strong); }
.pk-row-l small { display: block; font-size: 11px; color: var(--shs-muted); line-height: 1.35; }
.pk-row-l img, .pk-row-l .shs-ic { flex: none; }
.pk-row .tsh-input--num { width: 84px; }
.pk-hint { font-size: 11px; color: var(--shs-muted); margin-top: 6px; line-height: 1.35; }
.pk-chip { display: inline-block; margin-top: 6px; font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 99px;
  background: var(--shs-bg-inset); border: 1px solid var(--shs-border-strong); color: var(--shs-ink-strong); }
.pk-chip--warn { border-color: var(--shs-warn, #b8862b); }
.pk-area { width: 100%; min-height: 90px; box-sizing: border-box; resize: vertical; font-family: inherit; }
.pk-hide { display: none !important; }
@media (max-width: 480px) { .pk-hero { flex-direction: column; align-items: flex-start; } .pk-row { flex-wrap: wrap; } }
`;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls !== undefined) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function gameImg(path: string, size: number, alt: string): HTMLImageElement {
  const img = el('img');
  img.src = path;
  img.alt = alt;
  img.title = alt;
  img.width = size;
  img.height = size;
  img.draggable = false;
  return img;
}

export function section(title: string, ic: IconName): { box: HTMLDivElement; body: HTMLDivElement } {
  const box = el('div', 'tsh-section');
  const head = el('div', 'tsh-section-title');
  head.append(icon(ic, 12), document.createTextNode(title));
  const body = el('div');
  box.append(head, body);
  return { box, body };
}

export function switchInput(checked: boolean, label: string): { wrap: HTMLLabelElement; input: HTMLInputElement } {
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('aria-label', label);
  const wrap = el('label', 'tsh-switch');
  wrap.append(input, el('span', 'tsh-switch-track'));
  return { wrap, input };
}

export function numInput(value: number, min: number, max: number, step: number, label: string): HTMLInputElement {
  const input = el('input', 'tsh-input tsh-input--num');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute('aria-label', label);
  return input;
}

export function row(ic: HTMLElement | SVGSVGElement, title: string, help: string, ctl: HTMLElement): HTMLDivElement {
  const r = el('div', 'pk-row');
  const l = el('div', 'pk-row-l');
  const t = el('span', undefined, title);
  t.appendChild(el('small', undefined, help));
  l.append(ic, t);
  r.append(l, ctl);
  return r;
}

export function radioCard(name: string, value: string, checked: boolean, ic: HTMLElement | SVGSVGElement, title: string, desc: string): { card: HTMLLabelElement; input: HTMLInputElement } {
  const card = el('label', 'pk-card');
  const input = el('input');
  input.type = 'radio';
  input.name = name;
  input.value = value;
  input.checked = checked;
  const icWrap = el('span', 'pk-card-ic');
  icWrap.appendChild(ic);
  const txt = el('span');
  txt.append(el('span', 'pk-card-t', title), el('span', 'pk-card-d', desc));
  card.append(input, icWrap, txt);
  return { card, input };
}

export function note(text: string, ic: IconName = 'info', warn = false): HTMLDivElement {
  const n = el('div', warn ? 'pk-note pk-note--warn' : 'pk-note');
  n.append(icon(ic, 13), el('span', undefined, text));
  return n;
}

/** Marca o campo, rola até ele e devolve o erro no formato do collect(). */
export function invalid(i: HTMLElement, msg: string): { ok: false; error: string } {
  i.classList.add('tsh-input--invalid');
  i.scrollIntoView({ block: 'center' });
  i.focus({ preventScroll: true });
  return { ok: false, error: msg };
}

export const RES_ICONS = [
  { key: 'wood', img: 'graphic/holz.webp', name: 'Madeira' },
  { key: 'stone', img: 'graphic/lehm.webp', name: 'Argila' },
  { key: 'iron', img: 'graphic/eisen.webp', name: 'Ferro' },
] as const;
