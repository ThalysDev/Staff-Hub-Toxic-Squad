// Tela "Configurar — Mega Construtor" (v3.9.0). Ideia das telas "Construtor &
// Redutor" (Modelos / Aldeias por Grupo e Coordenada), feita do nosso jeito:
// modelos são filas com nome montadas CLICANDO nos ícones dos edifícios do
// jogo; cada aldeia pega o modelo pela coordenada, pelo grupo ou pelo padrão.
// A fila em texto e o template GC ficam em "Avançado". Tudo por textContent.

import { icon, type IconName } from '../../../core/icons';
import { getGroupOptions } from '../tsh-groups';
import type { TshSettingsPanel } from '../tsh-runtime';
import { BUILDINGS, type BuildingId } from './builder-mass';
import {
  BUILDING_NAME,
  MAX_LEVEL,
  parseCoordList,
  PRESETS,
  prereqWarnings,
  readModels,
  readRules,
  type BuilderModel,
  type BuilderRule,
} from './builder-models';

/** Conversores da fila antiga (vêm do mega-builder para não criar import circular). */
export interface BuilderLegacy {
  parseText(text: string): { ok: true; priorities: { building: string; targetLevel: number }[] } | { ok: false; reason: string };
  decodeGc(text: string): { ok: true; steps: ReadonlyArray<{ buildingId: string; targetLevel: number }>; name: string; threshold: number } | { ok: false; reason: string };
}

const CSS = `
.bm-hero { display: flex; gap: 12px; align-items: center; padding: 12px; margin: 0 0 14px; border-radius: 10px;
  background: var(--shs-bg-inset); border: 1px solid var(--shs-border); }
.bm-hero-strip { display: flex; gap: 2px; flex: none; max-width: 190px; flex-wrap: wrap; }
.bm-hero-strip img { width: 22px; height: 22px; }
.bm-hero-text { font-size: 12.5px; line-height: 1.45; color: var(--shs-ink-strong); }
.bm-hero-text b { color: var(--shs-action); }
.bm-note { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; margin: 0 0 12px; border-radius: 8px;
  background: var(--shs-info-bg, var(--shs-bg-inset)); font-size: 12px; line-height: 1.4; color: var(--shs-ink-strong); }
.bm-note .shs-ic { flex: none; margin-top: 1px; color: var(--shs-action); }
.bm-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.bm-card { position: relative; display: flex; gap: 10px; align-items: flex-start; padding: 10px; border-radius: 9px; cursor: pointer;
  border: 1px solid var(--shs-border-strong); background: var(--shs-bg-card); }
.bm-card:hover { border-color: var(--shs-action); }
.bm-card input { position: absolute; opacity: 0; pointer-events: none; }
.bm-card:has(input:checked) { border-color: var(--shs-action); box-shadow: inset 0 0 0 1px var(--shs-action); }
.bm-card:has(input:focus-visible) { outline: 2px solid var(--shs-brass); outline-offset: 1px; }
.bm-card-ic { flex: none; width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center; background: var(--shs-bg-inset); color: var(--shs-action); }
.bm-card-t { display: block; font-weight: 600; font-size: 12.5px; color: var(--shs-ink-strong); }
.bm-card-d { display: block; font-size: 11.5px; line-height: 1.35; color: var(--shs-muted); margin-top: 2px; }
.bm-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.bm-tab { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--shs-border-strong); background: var(--shs-bg-card);
  color: var(--shs-ink); border-radius: 99px; font-size: 12px; padding: 3px 10px; cursor: pointer; }
.bm-tab small { color: var(--shs-muted); }
.bm-tab[aria-pressed='true'] { border-color: var(--shs-action); color: var(--shs-action); font-weight: 600; box-shadow: inset 0 0 0 1px var(--shs-action); }
.bm-tab--add { border-style: dashed; }
.bm-star { color: var(--shs-brass, #b8862b); }
.bm-editor { border: 1px solid var(--shs-border-strong); border-radius: 10px; padding: 10px; background: var(--shs-bg-card); }
.bm-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.bm-toolbar .bm-name { flex: 1; min-width: 140px; }
.bm-icbtn { border: 0; background: transparent; color: var(--shs-muted); cursor: pointer; padding: 4px; border-radius: 6px; display: inline-grid; place-items: center; }
.bm-icbtn:hover:not(:disabled) { color: var(--shs-action); background: var(--shs-bg-inset); }
.bm-icbtn:disabled { opacity: .3; cursor: default; }
.bm-icbtn.del:hover { color: var(--shs-danger); background: var(--shs-danger-bg); }
.bm-default { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--shs-ink); margin-top: 8px; }
.bm-steps { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 320px; overflow: auto; }
.bm-step { display: grid; grid-template-columns: 22px 26px 1fr auto auto; gap: 6px; align-items: center; padding: 4px 6px; border-radius: 7px; background: var(--shs-bg-inset); }
.bm-step-n { font-size: 11px; color: var(--shs-muted); text-align: right; font-variant-numeric: tabular-nums; }
.bm-step-name { font-size: 12.5px; color: var(--shs-ink-strong); min-width: 0; }
.bm-step-warn { display: flex; gap: 4px; align-items: center; font-size: 11px; color: var(--shs-warn-ink, var(--shs-muted)); }
.bm-step-warn .shs-ic { color: var(--shs-warn, #b8862b); flex: none; }
.bm-step-lv { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--shs-muted); }
.bm-step-lv .tsh-input { width: 58px; }
.bm-step-act { display: flex; }
.bm-empty { font-size: 12px; color: var(--shs-muted); padding: 10px 4px; }
.bm-lbl { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--shs-muted); margin: 12px 0 6px; }
.bm-palette { display: grid; grid-template-columns: repeat(auto-fill, minmax(38px, 1fr)); gap: 4px; }
.bm-pal { border: 1px solid var(--shs-border-strong); background: var(--shs-bg-card); border-radius: 7px; height: 38px; cursor: pointer; display: grid; place-items: center; }
.bm-pal:hover { border-color: var(--shs-action); background: var(--shs-bg-inset); }
.bm-pal:focus-visible { outline: 2px solid var(--shs-brass); }
.bm-presets { display: flex; gap: 6px; flex-wrap: wrap; }
.bm-hint { font-size: 11px; color: var(--shs-muted); margin-top: 6px; line-height: 1.35; }
.bm-rules { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.bm-rule { display: grid; grid-template-columns: 24px 1fr auto 1fr auto auto; gap: 8px; align-items: center; padding: 8px; border-radius: 9px;
  border: 1px solid var(--shs-border-strong); background: var(--shs-bg-card); }
.bm-rule > .shs-ic { color: var(--shs-action); }
.bm-rule textarea { min-height: 34px; resize: vertical; font-family: inherit; }
.bm-arrow { color: var(--shs-muted); }
.bm-rule:first-child > .bm-icbtn:not(.del) { visibility: hidden; }
@media (max-width: 480px) {
  .bm-rule { grid-template-columns: 24px 1fr auto auto; }
  .bm-rule .bm-arrow { display: none; }
  .bm-rule .bm-rule-model { grid-column: 2 / -1; order: 5; }
  .bm-step { grid-template-columns: 22px 26px 1fr auto; }
  .bm-step-act { grid-column: 3 / -1; justify-self: end; }
  .bm-hero { flex-direction: column; align-items: flex-start; }
}
.bm-addrow { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.bm-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 0; border-top: 1px solid var(--shs-border); }
.bm-row:first-child { border-top: 0; }
.bm-row-l { display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: var(--shs-ink-strong); }
.bm-row-l small { display: block; font-size: 11px; color: var(--shs-muted); line-height: 1.35; }
.bm-row-l img { flex: none; }
.bm-row .tsh-input--num { width: 84px; }
.bm-seg { display: inline-flex; border: 1px solid var(--shs-border-strong); border-radius: 8px; overflow: hidden; }
.bm-seg label { position: relative; padding: 4px 12px; font-size: 12px; cursor: pointer; color: var(--shs-ink); }
.bm-seg input { position: absolute; opacity: 0; pointer-events: none; }
.bm-seg label:has(input:checked) { background: var(--shs-action); color: var(--shs-on-action, #fff); font-weight: 600; }
.bm-seg label:has(input:focus-visible) { outline: 2px solid var(--shs-brass); outline-offset: -2px; }
.bm-adv summary { cursor: pointer; font-size: 12px; font-weight: 600; color: var(--shs-muted); padding: 4px 0; }
.bm-adv textarea { width: 100%; min-height: 70px; margin-top: 4px; box-sizing: border-box; }
.bm-hide { display: none !important; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls !== undefined) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function gameImg(path: string, size: number, alt: string): HTMLImageElement {
  const img = el('img');
  img.src = path;
  img.alt = alt;
  img.title = alt;
  img.width = size;
  img.height = size;
  img.draggable = false;
  return img;
}

const bImg = (b: BuildingId, size = 22): HTMLImageElement => gameImg(`graphic/buildings/${b}.png`, size, BUILDING_NAME[b]);

function section(title: string, ic: IconName): { box: HTMLDivElement; body: HTMLDivElement } {
  const box = el('div', 'tsh-section');
  const head = el('div', 'tsh-section-title');
  head.append(icon(ic, 12), document.createTextNode(title));
  const body = el('div');
  box.append(head, body);
  return { box, body };
}

function switchInput(checked: boolean, label: string): { wrap: HTMLLabelElement; input: HTMLInputElement } {
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('aria-label', label);
  const wrap = el('label', 'tsh-switch');
  wrap.append(input, el('span', 'tsh-switch-track'));
  return { wrap, input };
}

function numInput(value: number, min: number, max: number, step: number, label: string): HTMLInputElement {
  const input = el('input', 'tsh-input tsh-input--num');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute('aria-label', label);
  return input;
}

function iconBtn(ic: IconName, title: string, cls = 'bm-icbtn'): HTMLButtonElement {
  const b = el('button', cls);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.appendChild(icon(ic, 13));
  return b;
}

function textBtn(ic: IconName, text: string, cls = 'tsh-btn tsh-btn--ghost'): HTMLButtonElement {
  const b = el('button', cls);
  b.type = 'button';
  b.append(icon(ic, 12), document.createTextNode(text));
  return b;
}

/** Linha "ícone + título/explicação … controle". */
function row(ic: HTMLElement | SVGSVGElement, title: string, help: string, ctl: HTMLElement): HTMLDivElement {
  const r = el('div', 'bm-row');
  const l = el('div', 'bm-row-l');
  const t = el('span', undefined, title);
  t.appendChild(el('small', undefined, help));
  l.append(ic, t);
  r.append(l, ctl);
  return r;
}

function radioCard(name: string, value: string, checked: boolean, ic: HTMLElement | SVGSVGElement, title: string, desc: string): { card: HTMLLabelElement; input: HTMLInputElement } {
  const card = el('label', 'bm-card');
  const input = el('input');
  input.type = 'radio';
  input.name = name;
  input.value = value;
  input.checked = checked;
  const icWrap = el('span', 'bm-card-ic');
  icWrap.appendChild(ic);
  const txt = el('span');
  txt.append(el('span', 'bm-card-t', title), el('span', 'bm-card-d', desc));
  card.append(input, icWrap, txt);
  return { card, input };
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const newId = (): string => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const isBuilding = (b: string): b is BuildingId => (BUILDINGS as readonly string[]).includes(b);

/** Fila antiga (texto > template GC > prioridades) → um modelo, para quem já usava. */
function legacyModel(settings: Record<string, unknown>, legacy: BuilderLegacy): { model: BuilderModel; farm?: number; from: string } | null {
  const toSteps = (list: readonly { building: string; level: number }[]): BuilderModel['steps'] =>
    list.flatMap((p) => (isBuilding(p.building) ? [{ building: p.building, level: Math.min(p.level, MAX_LEVEL[p.building]) }] : []));
  const text = typeof settings.prioritiesText === 'string' ? settings.prioritiesText : '';
  if (text.trim() !== '') {
    const r = legacy.parseText(text);
    if (!r.ok) return null;
    const steps = toSteps(r.priorities.map((p) => ({ building: p.building, level: p.targetLevel })));
    return steps.length > 0 ? { model: { id: newId(), name: 'Minha fila', steps }, from: 'a sua fila em texto' } : null;
  }
  const gc = typeof settings.gcTemplateImport === 'string' ? settings.gcTemplateImport : '';
  if (gc.trim() !== '') {
    const r = legacy.decodeGc(gc);
    if (!r.ok) return null;
    const steps = toSteps(r.steps.map((s) => ({ building: s.buildingId, level: s.targetLevel })));
    return steps.length > 0
      ? { model: { id: newId(), name: (r.name || 'Template GC').slice(0, 40), steps }, ...(r.threshold > 0 ? { farm: r.threshold } : {}), from: 'o seu template GC' }
      : null;
  }
  const pr = Array.isArray(settings.priorities) ? (settings.priorities as { building?: unknown; targetLevel?: unknown }[]) : [];
  const steps = toSteps(
    pr.flatMap((p) => (typeof p.building === 'string' && typeof p.targetLevel === 'number' ? [{ building: p.building, level: p.targetLevel }] : [])),
  );
  return steps.length > 0 ? { model: { id: newId(), name: 'Minha fila', steps }, from: 'a sua fila salva' } : null;
}

export function buildBuilderPanel(settings: Record<string, unknown>, legacy: BuilderLegacy, legacyNoMode = false): TshSettingsPanel {
  const root = el('div', 'bm-root');
  const style = el('style');
  style.textContent = CSS;
  root.appendChild(style);
  const uid = Math.random().toString(36).slice(2, 8);

  // ── Estado ──
  const models: BuilderModel[] = readModels(settings.models).map((m) => ({ ...m, steps: m.steps.map((s) => ({ ...s })) }));
  let defaultModel = typeof settings.defaultModel === 'string' && models.some((m) => m.id === settings.defaultModel) ? settings.defaultModel : '';
  let converted: { from: string } | null = null;
  let farmPct = num(settings.farmPriorityThreshold, 0);
  if (models.length === 0) {
    const old = legacyModel(settings, legacy);
    if (old !== null) {
      models.push(old.model);
      defaultModel = old.model.id;
      converted = { from: old.from };
      if (farmPct === 0 && old.farm !== undefined) farmPct = old.farm;
    }
  }
  let selected = models[0]?.id ?? '';
  /** Passos com nível digitado inválido (em QUALQUER modelo, não só no aberto). */
  const invalidSteps = new Set<object>();
  // Quem já usava (settings sem execMode) segue em "Só na tela" até escolher aqui.
  const execMode = legacyNoMode || settings.execMode === 'tela' ? 'tela' : 'fundo';

  // ── Resumo (topo) ──
  const top = el('div', 'bm-hero');
  const heroStrip = el('div', 'bm-hero-strip');
  const heroText = el('div', 'bm-hero-text');
  top.append(heroStrip, heroText);

  if (legacyNoMode) {
    const n = el('div', 'bm-note');
    n.append(icon('info', 13), el('span', undefined, 'Você segue em "Só no Edifício principal", como antes. Para construir em todas as aldeias sem abrir a tela, escolha "Segundo plano" abaixo.'));
    root.appendChild(n);
  }
  if (converted !== null) {
    const n = el('div', 'bm-note');
    n.append(icon('info', 13), el('span', undefined, `Novo na 3.9: ${converted.from} virou o modelo "${models[0]?.name ?? ''}", já marcado como padrão de todas as aldeias. Confira abaixo e salve para confirmar.`));
    root.appendChild(n);
  }

  // ── Onde roda ──
  const where = section('Onde roda', 'layers');
  const cards = el('div', 'bm-cards');
  const fundo = radioCard(`bm-exec-${uid}`, 'fundo', execMode === 'fundo', icon('layers', 16), 'Segundo plano', 'Todas as aldeias, em qualquer tela, pelas Visões de Edifícios e Produção (Conta Premium).');
  const tela = radioCard(`bm-exec-${uid}`, 'tela', execMode === 'tela', bImg('main', 20), 'Só no Edifício principal', 'Só a aldeia aberta, com o Edifício principal na tela. Funciona sem Premium.');
  cards.append(fundo.card, tela.card);
  where.body.appendChild(cards);
  root.appendChild(where.box);

  // ── Modelos ──
  const mSec = section('Modelos de construção', 'list');
  const tabs = el('div', 'bm-tabs');
  const editor = el('div', 'bm-editor');
  const noModels = el('div', 'bm-empty', 'Nenhum modelo ainda. Comece por um modelo pronto (abaixo) ou crie um do zero em "+ Novo modelo".');
  const presetsLbl = el('div', 'bm-lbl', 'Começar de um modelo pronto');
  const presets = el('div', 'bm-presets');
  mSec.body.append(tabs, noModels, editor, presetsLbl, presets);
  root.appendChild(mSec.box);

  const nameIn = el('input', 'tsh-input bm-name');
  nameIn.type = 'text';
  nameIn.maxLength = 40;
  nameIn.setAttribute('aria-label', 'Nome do modelo');
  const dupBtn = iconBtn('copy', 'Duplicar este modelo');
  const delBtn = iconBtn('trash', 'Excluir este modelo', 'bm-icbtn del');
  const toolbar = el('div', 'bm-toolbar');
  toolbar.append(nameIn, dupBtn, delBtn);
  const defSw = switchInput(false, 'Modelo padrão das aldeias sem regra');
  const defRow = el('label', 'bm-default');
  defRow.append(defSw.wrap, el('span', undefined, 'Padrão: vale para toda aldeia sem regra de grupo ou coordenada'));
  const steps = el('ol', 'bm-steps');
  const palLbl = el('div', 'bm-lbl', 'Clique num edifício para pôr no fim do modelo');
  const palette = el('div', 'bm-palette');
  const palHint = el('div', 'bm-hint bm-hide');
  palHint.setAttribute('role', 'status');
  editor.append(toolbar, defRow, steps, palLbl, palette, palHint);

  const current = (): BuilderModel | undefined => models.find((m) => m.id === selected);

  const renderTabs = (): void => {
    tabs.textContent = '';
    for (const m of models) {
      const t = el('button', 'bm-tab');
      t.type = 'button';
      t.setAttribute('aria-pressed', String(m.id === selected));
      if (m.id === defaultModel) {
        const star = el('span', 'bm-star', '★');
        star.title = 'Modelo padrão';
        star.setAttribute('aria-hidden', 'true');
        t.appendChild(star);
      }
      const count = el('small', undefined, String(m.steps.length));
      count.title = `${m.steps.length} passo(s)`;
      t.append(document.createTextNode(m.name || 'Sem nome'), count);
      t.setAttribute('aria-label', `${m.name || 'Sem nome'}, ${m.steps.length} passo(s)${m.id === defaultModel ? ', padrão' : ''}`);
      t.dataset.id = m.id;
      t.addEventListener('click', () => {
        selected = m.id;
        renderAll();
        tabs.querySelector<HTMLElement>(`[data-id="${m.id}"]`)?.focus();
      });
      tabs.appendChild(t);
    }
    const add = textBtn('plus', 'Novo modelo', 'bm-tab bm-tab--add');
    add.addEventListener('click', () => {
      const m: BuilderModel = { id: newId(), name: `Modelo ${models.length + 1}`, steps: [] };
      models.push(m);
      if (defaultModel === '' && models.length === 1) defaultModel = m.id;
      selected = m.id;
      renderAll();
      nameIn.focus();
      nameIn.select();
    });
    tabs.appendChild(add);
  };

  const updateWarnings = (): void => {
    const m = current();
    if (m === undefined) return;
    const warns = prereqWarnings(m.steps);
    steps.querySelectorAll<HTMLElement>('.bm-step').forEach((li, k) => {
      const w = li.querySelector<HTMLElement>('.bm-step-warn');
      const msg = warns[k] ?? null;
      if (w === null) return;
      w.classList.toggle('bm-hide', msg === null);
      const span = w.querySelector('span');
      if (span !== null) span.textContent = msg ?? '';
    });
  };

  const renderSteps = (): void => {
    steps.textContent = '';
    const m = current();
    if (m === undefined) return;
    if (m.steps.length === 0) {
      steps.appendChild(el('li', 'bm-empty', 'Modelo vazio: clique nos edifícios abaixo, na ordem em que devem subir.'));
      return;
    }
    m.steps.forEach((s, k) => {
      const li = el('li', 'bm-step');
      const name = el('div', 'bm-step-name', BUILDING_NAME[s.building]);
      const warn = el('div', 'bm-step-warn bm-hide');
      warn.append(icon('alert', 11), el('span'));
      name.appendChild(warn);
      const lvWrap = el('label', 'bm-step-lv');
      const lv = numInput(s.level, 1, MAX_LEVEL[s.building], 1, `Nível de ${BUILDING_NAME[s.building]}`);
      if (invalidSteps.has(s)) lv.classList.add('tsh-input--invalid');
      lv.addEventListener('input', () => {
        const v = Number(lv.value);
        if (Number.isInteger(v) && v >= 1 && v <= MAX_LEVEL[s.building]) {
          s.level = v;
          invalidSteps.delete(s);
          lv.classList.remove('tsh-input--invalid');
          updateWarnings();
          refresh();
        } else {
          invalidSteps.add(s);
          lv.classList.add('tsh-input--invalid');
        }
      });
      lvWrap.append(document.createTextNode('até'), lv);
      const act = el('div', 'bm-step-act');
      const up = iconBtn('arrowRight', `Subir ${BUILDING_NAME[s.building]} no modelo`);
      (up.firstChild as SVGElement).style.transform = 'rotate(-90deg)';
      up.disabled = k === 0;
      const down = iconBtn('arrowRight', `Descer ${BUILDING_NAME[s.building]} no modelo`);
      (down.firstChild as SVGElement).style.transform = 'rotate(90deg)';
      down.disabled = k === m.steps.length - 1;
      const del = iconBtn('x', `Tirar ${BUILDING_NAME[s.building]} do modelo`, 'bm-icbtn del');
      const move = (to: number): void => {
        const [it] = m.steps.splice(k, 1);
        if (it !== undefined) m.steps.splice(to, 0, it);
        renderSteps();
        refresh();
        const btns = steps.querySelectorAll<HTMLElement>('.bm-step')[to]?.querySelectorAll<HTMLButtonElement>('.bm-step-act button');
        const again = btns?.[to < k ? 0 : 1];
        (again !== undefined && !again.disabled ? again : btns?.[to < k ? 1 : 0])?.focus();
      };
      up.addEventListener('click', () => move(k - 1));
      down.addEventListener('click', () => move(k + 1));
      del.addEventListener('click', () => {
        m.steps.splice(k, 1);
        renderSteps();
        renderTabs();
        refresh();
        const rows = steps.querySelectorAll<HTMLElement>('.bm-step');
        (rows[Math.min(k, rows.length - 1)]?.querySelector<HTMLElement>('input') ?? palette.querySelector<HTMLElement>('button'))?.focus();
      });
      act.append(up, down, del);
      li.append(el('span', 'bm-step-n', String(k + 1)), bImg(s.building, 24), name, lvWrap, act);
      steps.appendChild(li);
    });
    updateWarnings();
  };

  for (const b of BUILDINGS) {
    const p = el('button', 'bm-pal');
    p.type = 'button';
    p.title = `${BUILDING_NAME[b]} — pôr no fim do modelo`;
    p.setAttribute('aria-label', p.title);
    p.appendChild(bImg(b, 26));
    p.addEventListener('click', () => {
      const m = current();
      if (m === undefined) return;
      const last = Math.max(0, ...m.steps.filter((s) => s.building === b).map((s) => s.level));
      if (last >= MAX_LEVEL[b]) {
        palHint.textContent = `${BUILDING_NAME[b]} já sobe até o nível máximo (${MAX_LEVEL[b]}) neste modelo.`;
        palHint.classList.remove('bm-hide');
        return;
      }
      palHint.classList.add('bm-hide');
      const level = Math.min(MAX_LEVEL[b], last === 0 ? Math.min(MAX_LEVEL[b], 5) : last + 5);
      m.steps.push({ building: b, level });
      renderSteps();
      renderTabs();
      refresh();
      steps.scrollTop = steps.scrollHeight;
      steps.lastElementChild?.querySelector<HTMLInputElement>('input')?.focus();
    });
    palette.appendChild(p);
  }

  for (const pr of PRESETS) {
    const b = el('button', 'bm-tab');
    b.type = 'button';
    const first = pr.steps[0];
    if (first !== undefined) b.appendChild(bImg(first.building, 16));
    b.append(document.createTextNode(pr.name), el('small', undefined, String(pr.steps.length)));
    b.title = `Cria um modelo novo "${pr.name}" (você pode editar depois)`;
    b.addEventListener('click', () => {
      const m: BuilderModel = { id: newId(), name: pr.name, steps: pr.steps.map((s) => ({ ...s })) };
      models.push(m);
      if (defaultModel === '' && models.length === 1) defaultModel = m.id;
      selected = m.id;
      renderAll();
    });
    presets.appendChild(b);
  }

  nameIn.addEventListener('input', () => {
    const m = current();
    if (m === undefined) return;
    m.name = nameIn.value;
    renderTabs();
    refreshRuleSelects();
    refresh();
  });
  dupBtn.addEventListener('click', () => {
    const m = current();
    if (m === undefined) return;
    const copy: BuilderModel = { id: newId(), name: `${m.name} (cópia)`.slice(0, 40), steps: m.steps.map((s) => ({ ...s })) };
    models.push(copy);
    selected = copy.id;
    renderAll();
    nameIn.focus();
  });
  delBtn.addEventListener('click', () => {
    const m = current();
    if (m === undefined) return;
    // Excluir só vale ao salvar (Cancelar desfaz). Regras que usavam o modelo
    // ficam sem modelo e o Salvar pede para escolher outro — nada some calado.
    models.splice(models.indexOf(m), 1);
    if (defaultModel === m.id) defaultModel = '';
    selected = models[0]?.id ?? '';
    renderAll();
    tabs.querySelector<HTMLElement>('button')?.focus();
  });
  defSw.input.addEventListener('change', () => {
    defaultModel = defSw.input.checked ? selected : '';
    renderTabs();
    syncDefaultSelect();
    refresh();
  });

  // ── Aldeias ──
  const aSec = section('Aldeias — qual modelo cada uma segue', 'map');
  const defLine = el('div', 'bm-row');
  const defSelect = el('select', 'tsh-input');
  defSelect.setAttribute('aria-label', 'Modelo padrão');
  defLine.append(
    (() => {
      const l = el('div', 'bm-row-l');
      const t = el('span', undefined, 'Aldeias sem regra');
      t.appendChild(el('small', undefined, 'Toda aldeia que não cair em nenhuma regra abaixo.'));
      l.append(icon('home', 16), t);
      return l;
    })(),
    defSelect,
  );
  const rulesHint = el('div', 'bm-hint', 'Quer que um grupo de aldeias (ex.: "Defesa") ou aldeias específicas sigam outro modelo? Adicione uma regra. Coordenada vence grupo; aldeia em mais de um grupo segue a regra mais acima (use ↑ para mudar a ordem).');
  const rulesBox = el('div', 'bm-rules');
  const addRow = el('div', 'bm-addrow');
  const addGroup = textBtn('users', '+ Grupo');
  const addCoord = textBtn('crosshair', '+ Coordenada');
  addRow.append(addGroup, addCoord);
  aSec.body.append(defLine, rulesHint, rulesBox, addRow);
  root.appendChild(aSec.box);

  const fillModelSelect = (select: HTMLSelectElement, chosen: string, none: string): void => {
    select.textContent = '';
    const o0 = el('option', undefined, none);
    o0.value = '';
    select.appendChild(o0);
    for (const m of models) {
      const o = el('option', undefined, m.name || 'Sem nome');
      o.value = m.id;
      select.appendChild(o);
    }
    select.value = models.some((m) => m.id === chosen) ? chosen : '';
  };
  const syncDefaultSelect = (): void => fillModelSelect(defSelect, defaultModel, 'Nenhum — só as aldeias com regra constroem');
  defSelect.addEventListener('change', () => {
    defaultModel = defSelect.value;
    renderTabs();
    defSw.input.checked = defaultModel !== '' && defaultModel === selected;
    refresh();
  });

  interface RuleRefs {
    kind: 'grupo' | 'coord';
    card: HTMLDivElement;
    group?: HTMLSelectElement;
    coords?: HTMLTextAreaElement;
    model: HTMLSelectElement;
    remove(): void;
  }
  const rules: RuleRefs[] = [];
  let groupNames: { groupId: number; name: string }[] = [];
  let groupsState: 'carregando' | 'ok' | 'erro' = 'carregando';
  const fillGroupSelect = (select: HTMLSelectElement, chosen: number | null): void => {
    select.textContent = '';
    const ph = el('option', undefined, groupsState === 'carregando' ? 'Carregando grupos do jogo…' : groupsState === 'erro' ? 'Não consegui ler os grupos' : 'Escolha um grupo…');
    ph.value = '';
    select.appendChild(ph);
    for (const g of groupNames) {
      const o = el('option', undefined, g.name);
      o.value = String(g.groupId);
      select.appendChild(o);
    }
    select.value = chosen === null ? '' : String(chosen);
  };
  const refreshRuleSelects = (): void => {
    for (const r of rules) fillModelSelect(r.model, r.model.value, 'Escolha o modelo…');
    syncDefaultSelect();
  };

  const addRule = (r: Partial<BuilderRule> & { kind: 'grupo' | 'coord' }): void => {
    const card = el('div', 'bm-rule');
    const model = el('select', 'tsh-input');
    model.setAttribute('aria-label', 'Modelo desta regra');
    fillModelSelect(model, r.modelId ?? selected, 'Escolha o modelo…');
    model.classList.add('bm-rule-model');
    const del = iconBtn('trash', 'Remover esta regra', 'bm-icbtn del');
    const upBtn = iconBtn('arrowRight', 'Subir esta regra (vale antes das de baixo)');
    (upBtn.firstChild as SVGElement).style.transform = 'rotate(-90deg)';
    const refs: RuleRefs = {
      kind: r.kind,
      card,
      model,
      remove: () => {
        card.remove();
        rules.splice(rules.indexOf(refs), 1);
        refresh();
      },
    };
    if (r.kind === 'grupo') {
      const g = el('select', 'tsh-input');
      g.setAttribute('aria-label', 'Grupo de aldeias');
      const chosen = r.kind === 'grupo' && 'groupId' in r && typeof r.groupId === 'number' ? r.groupId : null;
      if (chosen !== null && !groupNames.some((x) => x.groupId === chosen)) {
        groupNames.push({ groupId: chosen, name: ('groupName' in r && typeof r.groupName === 'string' && r.groupName) || `Grupo ${chosen}` });
      }
      fillGroupSelect(g, chosen);
      refs.group = g;
      card.append(icon('users', 16), g);
    } else {
      const t = el('textarea', 'tsh-input');
      t.placeholder = 'Cole coordenadas: 500|500 501|502 …';
      t.value = 'coords' in r && Array.isArray(r.coords) ? r.coords.join(' ') : '';
      t.setAttribute('aria-label', 'Coordenadas das aldeias');
      const count = el('div', 'bm-hint');
      count.setAttribute('aria-live', 'polite');
      const sync = (): void => {
        const n = parseCoordList(t.value).length;
        count.textContent = n === 0 ? 'Nenhuma coordenada reconhecida ainda.' : `${n} aldeia(s) reconhecida(s).`;
      };
      t.addEventListener('input', sync);
      sync();
      const wrap = el('div');
      wrap.append(t, count);
      refs.coords = t;
      card.append(icon('crosshair', 16), wrap);
    }
    card.append(el('span', 'bm-arrow', '→'), model, upBtn, del);
    del.addEventListener('click', () => refs.remove());
    upBtn.addEventListener('click', () => {
      const i = rules.indexOf(refs);
      const prev = rules[i - 1];
      if (i <= 0 || prev === undefined) return;
      rules.splice(i, 1);
      rules.splice(i - 1, 0, refs);
      rulesBox.insertBefore(card, prev.card);
      upBtn.focus();
    });
    rules.push(refs);
    rulesBox.appendChild(card);
  };
  for (const r of readRules(settings.rules)) addRule(r);
  addGroup.addEventListener('click', () => {
    addRule({ kind: 'grupo' });
    rules.at(-1)?.group?.focus();
    refresh();
  });
  addCoord.addEventListener('click', () => {
    addRule({ kind: 'coord' });
    rules.at(-1)?.coords?.focus();
    refresh();
  });
  void getGroupOptions()
    .then((gs) => {
      const known = new Map(groupNames.map((g) => [g.groupId, g.name]));
      groupNames = gs.filter((g) => g.groupId > 0).map((g) => ({ groupId: g.groupId, name: g.name }));
      for (const [id, name] of known) if (!groupNames.some((g) => g.groupId === id)) groupNames.push({ groupId: id, name: `${name} (não existe mais?)` });
      groupsState = 'ok';
    })
    .catch(() => {
      groupsState = 'erro';
    })
    .finally(() => {
      for (const r of rules) if (r.group !== undefined) fillGroupSelect(r.group, r.group.value === '' ? null : Number(r.group.value));
    });

  // ── Prioridades ──
  const pSec = section('Prioridades automáticas', 'zap');
  const farmIn = numInput(farmPct, 0, 100, 1, 'Fazenda primeiro abaixo de % livre');
  const storIn = numInput(num(settings.storageFullPct, 0), 0, 100, 5, 'Armazém primeiro acima de % cheio');
  const guard = switchInput(settings.storageGuard !== false, 'Armazém pequeno demais');
  const strict = switchInput(settings.strictOrder !== false, 'Seguir a ordem à risca');
  pSec.body.append(
    row(bImg('farm', 24), 'Fazenda primeiro', 'Quando a população livre fica abaixo deste % (0 = desliga). Sugestão: 10.', farmIn),
    row(bImg('storage', 24), 'Armazém primeiro (cheio)', 'Quando algum recurso passa deste % do armazém (0 = desliga). Sugestão: 90.', storIn),
    row(bImg('storage', 24), 'Armazém primeiro (pequeno)', 'Se o próximo edifício custa mais do que o armazém comporta.', guard.wrap),
    row(icon('list', 18), 'Seguir a ordem à risca', 'Ligado: se faltar recurso para o próximo passo, espera juntar. Desligado: constrói o próximo passo que já dá para pagar. Passo sem pré-requisito é sempre pulado.', strict.wrap),
  );
  root.appendChild(pSec.box);

  // ── Fila do jogo ──
  const qSec = section('Fila do jogo', 'clock');
  const seg = el('div', 'bm-seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', 'Completar a fila do jogo por');
  const qItens = el('input');
  qItens.type = 'radio';
  qItens.name = `bm-q-${uid}`;
  qItens.checked = settings.queueMode !== 'horas';
  const qHoras = el('input');
  qHoras.type = 'radio';
  qHoras.name = `bm-q-${uid}`;
  qHoras.checked = settings.queueMode === 'horas';
  const l1 = el('label');
  l1.append(qItens, document.createTextNode('Itens'));
  const l2 = el('label');
  l2.append(qHoras, document.createTextNode('Horas'));
  seg.append(l1, l2);
  const maxQ = numInput(num(settings.maxQueue, 2), 1, 5, 1, 'Itens na fila do jogo');
  const hoursIn = numInput(num(settings.queueHours, 5), 0.5, 72, 0.5, 'Horas de construção na fila');
  const hoursRow = row(icon('clock', 18), 'Horas na fila', 'Mantém pelo menos isto de construção enfileirada em cada aldeia (sem passar do nº de itens).', hoursIn);
  qSec.body.append(
    row(icon('layers', 18), 'Completar a fila por', 'Itens: até N na fila. Horas: enquanto a fila cobrir menos que X horas.', seg),
    row(bImg('main', 24), 'Itens na fila do jogo', 'Com Conta Premium o jogo aceita até 5; sem Premium, 2.', maxQ),
    hoursRow,
  );
  root.appendChild(qSec.box);

  // ── Recursos ──
  const rSec = section('Recursos', 'coins');
  const reserve = typeof settings.reserve === 'object' && settings.reserve !== null ? (settings.reserve as Record<string, number>) : {};
  const RES = [
    { key: 'wood', img: 'graphic/holz.webp', name: 'Madeira' },
    { key: 'stone', img: 'graphic/lehm.webp', name: 'Argila' },
    { key: 'iron', img: 'graphic/eisen.webp', name: 'Ferro' },
  ] as const;
  const resIns = RES.map((r) => ({ key: r.key, name: r.name, input: numInput(num(reserve[r.key], 0), 0, 10_000_000, 1000, `Deixar em casa: ${r.name}`) }));
  RES.forEach((r, k) => {
    const inp = resIns[k]?.input;
    if (inp !== undefined) rSec.body.appendChild(row(gameImg(r.img, 18, r.name), `Deixar em casa: ${r.name}`, 'O construtor nunca usa esta quantia (ex.: para recrutar). 0 = pode usar tudo.', inp));
  });
  root.appendChild(rSec.box);

  // ── Ritmo ──
  const tSec = section('Ritmo e extras', 'activity');
  const perCycle = numInput(num(settings.perCycle, 5), 1, 20, 1, 'Ampliações por ciclo');
  const quests = switchInput(settings.collectQuests === true, 'Coletar recompensas de quest');
  const perRow = row(icon('send', 18), 'Ampliações por ciclo', 'Segundo plano: quantas aldeias recebem uma ampliação por ciclo, com pausa humana entre elas. Sobrou? Continua em 1 min.', perCycle);
  const questRow = row(icon('gift', 18), 'Coletar recompensas de quest', 'Só no Edifício principal: clica em "Receber recompensa" quando aparecer (nesse ciclo não amplia).', quests.wrap);
  tSec.body.append(perRow, questRow);
  root.appendChild(tSec.box);

  // ── Avançado ──
  const adv = el('details', 'bm-adv tsh-section');
  const sum = el('summary', undefined, 'Avançado — fila em texto e template GC');
  const advHint = el('div', 'bm-hint', 'Só valem quando não existe NENHUM modelo acima. Texto: um edifício por linha, "fazenda:20" para parar num nível. O template GC (Base64) vale se o texto estiver vazio.');
  const textIn = el('textarea', 'tsh-input');
  textIn.placeholder = 'fazenda:20\nquartel:10\nbosque\narmazém:25';
  textIn.value = converted !== null ? '' : typeof settings.prioritiesText === 'string' ? settings.prioritiesText : '';
  textIn.setAttribute('aria-label', 'Fila em texto');
  const gcIn = el('textarea', 'tsh-input');
  gcIn.placeholder = 'Cole aqui o template GC exportado (Base64)…';
  gcIn.value = converted !== null ? '' : typeof settings.gcTemplateImport === 'string' ? settings.gcTemplateImport : '';
  gcIn.setAttribute('aria-label', 'Template GC');
  adv.append(sum, advHint, textIn, gcIn);
  if (textIn.value.trim() !== '' || gcIn.value.trim() !== '') adv.open = true;
  root.appendChild(adv);

  // ── Render/estado vivo ──
  function renderAll(): void {
    renderTabs();
    const m = current();
    noModels.classList.toggle('bm-hide', m !== undefined);
    editor.classList.toggle('bm-hide', m === undefined);
    if (m !== undefined) {
      nameIn.value = m.name;
      defSw.input.checked = defaultModel === m.id;
    }
    renderSteps();
    refreshRuleSelects();
    refresh();
  }

  function refresh(): void {
    const isFundo = fundo.input.checked;
    hoursRow.classList.toggle('bm-hide', !qHoras.checked);
    perRow.classList.toggle('bm-hide', !isFundo);
    questRow.classList.toggle('bm-hide', isFundo);
    const def = models.find((m) => m.id === defaultModel);
    heroStrip.textContent = '';
    const shown = def ?? current();
    for (const s of (shown?.steps ?? []).slice(0, 8)) heroStrip.appendChild(bImg(s.building, 22));
    if (heroStrip.childElementCount === 0) heroStrip.appendChild(icon('home', 22));
    const b = (t: string): HTMLElement => el('b', undefined, t);
    heroText.textContent = '';
    heroText.append(
      b(isFundo ? 'Segundo plano, todas as aldeias' : 'Só no Edifício principal'),
      document.createTextNode(' · '),
      b(qHoras.checked ? `fila de ${String(Number(hoursIn.value) || 0).replace('.', ',')} h` : `até ${maxQ.value} na fila`),
      document.createElement('br'),
      document.createTextNode(
        models.length === 0
          ? textIn.value.trim() !== '' || gcIn.value.trim() !== ''
            ? 'Sem modelos: vale a fila do Avançado para todas as aldeias.'
            : 'Nenhum modelo ainda — monte um abaixo.'
          : `${models.length} modelo(s) · padrão: ${def !== undefined ? `"${def.name}" (${def.steps.length} passos)` : 'nenhum (só aldeias com regra)'} · ${rules.length === 0 ? 'sem regras por aldeia' : `${rules.length} regra(s) por grupo/coordenada`}`,
      ),
    );
  }
  root.addEventListener('change', refresh);
  root.addEventListener('input', (e) => {
    if (e.target !== nameIn) refresh();
  });
  renderAll();

  return {
    el: root,
    top,
    collect: () => {
      const badModel = models.find((m) => m.steps.some((s) => invalidSteps.has(s)));
      for (const i of root.querySelectorAll('.tsh-input--invalid')) i.classList.remove('tsh-input--invalid');
      const bad = (i: HTMLElement, msg: string): { ok: false; error: string } => {
        i.classList.add('tsh-input--invalid');
        i.scrollIntoView({ block: 'center' });
        i.focus({ preventScroll: true });
        return { ok: false, error: msg };
      };
      const int = (i: HTMLInputElement, min: number, max: number): number | null => {
        const v = Number(i.value);
        return Number.isInteger(v) && v >= min && v <= max ? v : null;
      };
      for (const m of models) {
        if (m.name.trim() === '') {
          selected = m.id;
          renderAll();
          return bad(nameIn, 'Dê um nome ao modelo.');
        }
        if (m.steps.length === 0) {
          selected = m.id;
          renderAll();
          return bad(palette.querySelector<HTMLElement>('button') ?? palette, `O modelo "${m.name}" está vazio — clique nos edifícios para montar a fila (ou exclua o modelo).`);
        }
      }
      if (badModel !== undefined) {
        selected = badModel.id;
        renderAll();
        const k = badModel.steps.findIndex((s) => invalidSteps.has(s));
        const input = steps.querySelectorAll<HTMLElement>('.bm-step')[k]?.querySelector<HTMLInputElement>('input');
        const s = badModel.steps[k];
        if (input !== undefined && input !== null && s !== undefined) {
          return bad(input, `Modelo "${badModel.name}": o nível de ${BUILDING_NAME[s.building]} vai de 1 a ${MAX_LEVEL[s.building]}.`);
        }
      }
      const outRules: BuilderRule[] = [];
      for (const r of rules) {
        if (r.model.value === '') return bad(r.model, 'Escolha o modelo da regra (ou remova a regra).');
        if (r.kind === 'grupo' && r.group !== undefined) {
          const gid = Number(r.group.value);
          if (!Number.isInteger(gid) || gid <= 0) return bad(r.group, 'Escolha o grupo da regra (ou remova a regra).');
          const gName = (groupNames.find((g) => g.groupId === gid)?.name ?? '').replace(/ \(não existe mais\?\)$/, '');
          outRules.push({ kind: 'grupo', groupId: gid, groupName: gName, modelId: r.model.value });
        } else if (r.coords !== undefined) {
          const coords = parseCoordList(r.coords.value);
          if (coords.length === 0) return bad(r.coords, 'Cole pelo menos uma coordenada no formato 500|500 (ou remova a regra).');
          outRules.push({ kind: 'coord', coords, modelId: r.model.value });
        }
      }
      if (models.length > 0 && defaultModel === '' && outRules.length === 0) {
        return bad(defSelect, 'Nenhuma aldeia vai construir: escolha o modelo das "Aldeias sem regra" ou adicione uma regra.');
      }
      const farm = int(farmIn, 0, 100);
      if (farm === null) return bad(farmIn, 'Fazenda primeiro: use de 0 a 100 (%).');
      const stor = int(storIn, 0, 100);
      if (stor === null) return bad(storIn, 'Armazém cheio: use de 0 a 100 (%).');
      const mq = int(maxQ, 1, 5);
      if (mq === null) return bad(maxQ, 'Itens na fila: use de 1 a 5.');
      const qh = Number(hoursIn.value);
      if (!Number.isFinite(qh) || qh < 0.5 || qh > 72) return bad(hoursIn, 'Horas na fila: use de 0,5 a 72.');
      const pc = int(perCycle, 1, 20);
      if (pc === null) return bad(perCycle, 'Ampliações por ciclo: use de 1 a 20.');
      const nextReserve: Record<string, number> = {};
      for (const r of resIns) {
        const v = int(r.input, 0, 10_000_000);
        if (v === null) return bad(r.input, `Deixar em casa (${r.name}): número inteiro, 0 ou mais.`);
        nextReserve[r.key] = v;
      }
      if (textIn.value.trim() !== '') {
        const t = legacy.parseText(textIn.value);
        if (!t.ok) {
          adv.open = true;
          return bad(textIn, `Fila em texto: ${t.reason}`);
        }
      }
      if (gcIn.value.trim() !== '') {
        const g = legacy.decodeGc(gcIn.value);
        if (!g.ok) {
          adv.open = true;
          return bad(gcIn, g.reason);
        }
      }
      return {
        ok: true,
        values: {
          execMode: fundo.input.checked ? 'fundo' : 'tela',
          models: models.map((m) => ({ id: m.id, name: m.name.trim(), steps: m.steps.map((s) => ({ building: s.building, level: s.level })) })),
          rules: outRules,
          defaultModel,
          farmPriorityThreshold: farm,
          storageFullPct: stor,
          storageGuard: guard.input.checked,
          strictOrder: strict.input.checked,
          queueMode: qHoras.checked ? 'horas' : 'itens',
          maxQueue: mq,
          queueHours: qh,
          reserve: nextReserve,
          useCheap: false,
          perCycle: pc,
          collectQuests: quests.input.checked,
          prioritiesText: textIn.value,
          gcTemplateImport: gcIn.value,
        },
      };
    },
  };
}
