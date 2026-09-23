// Helpers de UI do userscript: construção de elementos sem innerHTML com
// dados dinâmicos (doutrina anti-XSS — game data entra por textContent).
// Complementa o design system .shs-* do shell e o catálogo de ícones.

import { icon, type IconName } from './icons';

type Child = string | Node;

/** Cria um elemento com children; strings viram textNode (seguro). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Partial<{ className: string; text: string; title: string; id: string }>,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs?.className !== undefined) node.className = attrs.className;
  if (attrs?.title !== undefined) node.title = attrs.title;
  if (attrs?.id !== undefined) node.id = attrs.id;
  // P1 da revisão UX (v1.1): text estava no tipo mas nunca era aplicado —
  // table()/pill() nasciam vazios. Aplicar SEMPRE antes dos children.
  if (attrs?.text !== undefined) node.textContent = attrs.text;
  for (const child of children) {
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else node.appendChild(child);
  }
  return node;
}

/** Cartão padrão com título ◆ (gramática visual do hub). Aceita string OU um
 *  título pronto (use cardTitle() para título com ícone). */
export function card(title: string | HTMLElement, ...children: Child[]): HTMLDivElement {
  const titleEl =
    typeof title === 'string' ? el('h3', { className: 'shs-card-title' }, title) : title;
  return el('div', { className: 'shs-card' }, titleEl, ...children);
}

/** Título de cartão com ícone (o ícone herda o latão do tema; sem ◆). */
export function cardTitle(name: IconName, text: string): HTMLHeadingElement {
  return el('h3', { className: 'shs-card-title shs-card-title--icon' }, icon(name), document.createTextNode(text));
}

/** Tabela com thead + linhas (dados via textContent; 1ª coluna pode ter HTML? NÃO — tudo texto). */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): HTMLTableElement {
  const table = el('table');
  const thead = el('thead');
  const headTr = el('tr');
  for (const header of headers) headTr.appendChild(el('th', { text: header }));
  thead.appendChild(headTr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const cell of row) tr.appendChild(el('td', { text: cell }));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

/** Estado vazio padrão. */
export function empty(text: string): HTMLParagraphElement {
  const p = el('p', { className: 'shs-empty' });
  p.textContent = text;
  return p;
}

/** Linha de progresso textual + barra fina. */
export function progressBar(label: string, ratio: number): HTMLDivElement {
  const wrap = el('div', { className: 'shs-progress' });
  const text = el('div', { className: 'shs-muted', text: label });
  const track = el('div', { className: 'shs-progress-bar' });
  const fill = el('div', { className: 'shs-progress-fill' });
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  fill.style.width = `${pct}%`;
  track.appendChild(fill);
  wrap.append(text, track);
  return wrap;
}

/** Pill colorida. */
export function pill(text: string, variant: 'ok' | 'error' | 'warn' | 'info' | 'muted' = 'muted'): HTMLElement {
  return el('span', { className: `shs-pill shs-pill--${variant}`, text });
}

/** Notificação inline dentro do módulo (ok/error) com auto-limpeza pelo dono. */
export function notification(kind: 'ok' | 'error', text: string): HTMLDivElement {
  const div = el('div', { className: `shs-notification shs-notification--${kind}` });
  div.textContent = text;
  return div;
}

/** Anexa tooltip (hover/focus) a qualquer elemento: CSS puro via data-tip. */
export function withTip<T extends HTMLElement>(node: T, tip: string): T {
  node.setAttribute('data-tip', tip);
  return node;
}

/** Botão com ícone + rótulo (+ tooltip opcional). Variant: primary (default),
 *  ghost, danger. */
export function iconButton(
  label: string,
  iconName: IconName,
  opts?: { variant?: 'primary' | 'ghost' | 'danger'; tip?: string; small?: boolean },
): HTMLButtonElement {
  const variant = opts?.variant ?? 'primary';
  const classes = ['shs-btn'];
  if (variant !== 'primary') classes.push(`shs-btn-${variant}`);
  if (opts?.small === true) classes.push('shs-btn-sm');
  const btn = el('button', { className: classes.join(' ') }, icon(iconName), document.createTextNode(label));
  if (opts?.tip !== undefined) withTip(btn, opts.tip);
  return btn;
}

/** Spinner de carregamento (uso: substituir o ícone do botão em ação longa). */
export function spinner(): HTMLSpanElement {
  const span = el('span', { className: 'shs-spinner' });
  return span;
}
