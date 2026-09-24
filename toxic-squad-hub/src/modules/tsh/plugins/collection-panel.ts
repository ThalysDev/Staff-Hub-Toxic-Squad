// Tela "Configurar — Coleta" (v3.6.0). Substitui a lista genérica de campos
// por uma tela própria: ícones do JOGO onde existem (retratos dos 4 níveis,
// tropas, ataque/defesa, cadeado, Praça) e ícones NOSSOS para destacar o que
// importa (segundo plano, reserva do Agendador, tempo-alvo). Resumo vivo no
// topo diz, em uma frase, o que a coleta vai fazer. Tudo por textContent.

import { icon, type IconName } from '../../../core/icons';
import type { TshSettingsPanel } from '../tsh-runtime';
import { unitIcon, unitLabelOrKey } from '../tsh-units';
import { SCAVENGE_UNITS } from './collection-levels';
import { haulForHours } from './collection-mass';
import { profilesFromLegacy, readProfiles, savedExecMode } from './collection-groups';
import { buildGroupRules, GROUP_RULES_CSS } from './collection-panel-groups';

const LEVELS = [
  { id: 1, key: 'pequena', name: 'Pequena', lf: 0.1 },
  { id: 2, key: 'media', name: 'Média', lf: 0.25 },
  { id: 3, key: 'grande', name: 'Grande', lf: 0.5 },
  { id: 4, key: 'extrema', name: 'Extrema', lf: 0.75 },
] as const;

/** Fórmula padrão da tela de coleta (a real vem do mundo no ciclo; aqui é só a estimativa). */
const DEFAULT_DURATION_CFG = { duration_exponent: 0.45, duration_initial_seconds: 1800, duration_factor: 0.8001102010732514 };

const CSS = `
.col-hero { display: flex; gap: 12px; align-items: center; padding: 12px; margin: 0 0 14px; border-radius: 10px;
  background: var(--shs-bg-inset); border: 1px solid var(--shs-border); }
.col-hero-levels { display: flex; gap: 4px; flex: none; }
.col-portrait { width: 34px; height: 34px; border-radius: 7px; background-size: cover; background-position: center;
  border: 2px solid transparent; opacity: .35; filter: grayscale(.8); transition: opacity .15s, filter .15s, border-color .15s; }
.col-portrait.on { opacity: 1; filter: none; border-color: var(--shs-action); }
.col-hero-text { font-size: 12.5px; line-height: 1.45; color: var(--shs-ink-strong); }
.col-hero-text b { color: var(--shs-action); }
.col-note { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; margin: 0 0 14px; border-radius: 8px;
  background: var(--shs-ok-bg); color: var(--shs-ok-ink, var(--shs-ink-strong)); font-size: 12px; line-height: 1.4; }
.col-note .shs-ic { flex: none; margin-top: 1px; color: var(--shs-ok); }
.col-note--new { background: var(--shs-info-bg, var(--shs-bg-inset)); }
.col-note--new .shs-ic { color: var(--shs-action); }
.col-dim { opacity: .5; }
.col-lbl { font-size: 11px; font-weight: 600; color: var(--shs-muted); margin: 10px 0 4px; }
@media (max-width: 420px) { .col-hero { flex-direction: column; align-items: flex-start; } }
.col-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.col-card { position: relative; display: flex; gap: 10px; align-items: flex-start; padding: 10px; border-radius: 9px; cursor: pointer;
  border: 1px solid var(--shs-border-strong); background: var(--shs-bg-card); transition: border-color .12s, box-shadow .12s; }
.col-card:hover { border-color: var(--shs-action); }
.col-card input { position: absolute; opacity: 0; pointer-events: none; }
.col-card:has(input:checked) { border-color: var(--shs-action); box-shadow: inset 0 0 0 1px var(--shs-action); }
.col-card:has(input:focus-visible) { outline: 2px solid var(--shs-brass); outline-offset: 1px; }
.col-card-ic { flex: none; width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center;
  background: var(--shs-bg-inset); color: var(--shs-action); }
.col-card-ic img { width: 20px; height: 20px; }
.col-card-t { font-weight: 600; font-size: 12.5px; color: var(--shs-ink-strong); display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; }
.col-card > span:last-child { min-width: 0; }
.col-card-d { font-size: 11.5px; line-height: 1.35; color: var(--shs-muted); margin-top: 2px; }
.col-badge { font-size: 9.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 1px 6px; border-radius: 99px;
  background: var(--shs-action); color: var(--shs-on-action, #fff); }
.col-levels { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.col-level { position: relative; display: flex; flex-direction: column; align-items: center; gap: 3px; cursor: pointer;
  font-size: 11px; color: var(--shs-muted); }
.col-level input { position: absolute; opacity: 0; pointer-events: none; }
.col-level .col-portrait { width: 46px; height: 46px; opacity: .55; }
.col-level:has(input:checked) .col-portrait { opacity: 1; filter: none; border-color: var(--shs-action); }
.col-level:has(input:checked) { color: var(--shs-ink-strong); font-weight: 600; }
.col-level:has(input:focus-visible) .col-portrait { outline: 2px solid var(--shs-brass); }
.col-targets { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; }
.col-target { padding: 10px; border-radius: 9px; background: var(--shs-bg-inset); }
.col-target-h { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--shs-ink-strong); }
.col-target-row { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.col-target-row .tsh-input { width: 70px; }
.col-chips { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
.col-chip { border: 1px solid var(--shs-border-strong); background: var(--shs-bg-card); color: var(--shs-ink); border-radius: 99px;
  font-size: 11px; padding: 1px 8px; cursor: pointer; }
.col-chip:hover, .col-chip[aria-pressed='true'] { border-color: var(--shs-action); color: var(--shs-action); }
.col-hint { font-size: 11px; color: var(--shs-muted); margin-top: 6px; line-height: 1.35; }
.col-troops { width: 100%; border-collapse: collapse; font-size: 12px; }
.col-troops th { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--shs-muted);
  text-align: left; padding: 0 6px 6px; white-space: nowrap; }
.col-troops th .shs-ic { vertical-align: -2px; margin-right: 3px; }
.col-troops td { padding: 5px 6px; border-top: 1px solid var(--shs-border); }
.col-troops td:first-child { width: 30px; }
.col-troops tr.off td:first-child { opacity: .45; }
.col-troops .tsh-input { width: 84px; }
.col-unit { display: flex; align-items: center; gap: 7px; white-space: nowrap; }
.col-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0; }
.col-row-l { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--shs-ink-strong); }
.col-row-l small { display: block; font-size: 11px; color: var(--shs-muted); }
.col-hide { display: none !important; }
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

function portrait(levelId: number): HTMLDivElement {
  const p = el('div', 'col-portrait');
  p.style.backgroundImage = `url("graphic/scavenging/options/${levelId}.png")`;
  return p;
}

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

/** Cartão-rádio (ícone + título + descrição). */
function radioCard(
  name: string,
  value: string,
  checked: boolean,
  ic: HTMLElement | SVGSVGElement,
  title: string,
  desc: string,
  badge?: string,
): { card: HTMLLabelElement; input: HTMLInputElement } {
  const card = el('label', 'col-card');
  const input = el('input');
  input.type = 'radio';
  input.name = name;
  input.value = value;
  input.checked = checked;
  const icWrap = el('span', 'col-card-ic');
  icWrap.appendChild(ic);
  const txt = el('span');
  const t = el('span', 'col-card-t', title);
  if (badge !== undefined) t.appendChild(el('span', 'col-badge', badge));
  txt.append(t, el('span', 'col-card-d', desc));
  txt.querySelector('.col-card-d')?.setAttribute('style', 'display:block');
  card.append(input, icWrap, txt);
  return { card, input };
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const rec = (v: unknown): Record<string, number> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, number>) : {};

/** Capacidade de carga total por aldeia para `h` horas nos níveis dados (estimativa). */
function carryFor(hours: number, levels: readonly number[]): number {
  const haul = haulForHours(hours, DEFAULT_DURATION_CFG);
  return levels.reduce((s, id) => s + haul / (LEVELS.find((l) => l.id === id)?.lf ?? 0.1), 0);
}

export function buildCollectionPanel(settings: Record<string, unknown>, world: string): TshSettingsPanel {
  const root = el('div', 'col-root');
  const style = el('style');
  style.textContent = CSS + GROUP_RULES_CSS;
  root.appendChild(style);

  const uid = Math.random().toString(36).slice(2, 8);
  // Quem já usava a Coleta antes da 3.6 segue em "Só na tela" até escolher o segundo plano.
  const savedExec = savedExecMode(world);
  const execMode = savedExec.mode ?? (settings.execMode === 'tela' ? 'tela' : 'fundo');
  const lotRaw = rec(settings.units);
  // Legado: 'fixo' sem lote = todas as tropas num nível (= "Um nível").
  const lotMode =
    settings.lotMode === 'equilibrada' || settings.lotMode === 'tudo'
      ? settings.lotMode
      : Object.values(lotRaw).some((n) => n > 0)
        ? 'fixo'
        : 'tudo';
  const duration = LEVELS.some((l) => l.key === settings.duration) ? (settings.duration as string) : 'media';
  const skip = new Set(Array.isArray(settings.skipUnits) ? (settings.skipUnits as string[]) : []);
  const reserve = rec(settings.reserveByUnit);
  const lot = rec(settings.units);

  // ── Resumo vivo ──
  const hero = el('div', 'col-hero');
  const heroLevels = el('div', 'col-hero-levels');
  const heroPortraits = LEVELS.map((l) => portrait(l.id));
  heroLevels.append(...heroPortraits);
  const heroText = el('div', 'col-hero-text');
  hero.append(heroLevels, heroText);
  const top = el('div');
  top.appendChild(hero);

  const note = el('div', 'col-note');
  note.append(
    icon('shieldCheck', 14),
    el('span', undefined, 'Comandos do Agendador vêm primeiro: a coleta nunca leva a tropa que um comando agendado vai precisar antes de ela voltar.'),
  );
  top.appendChild(note);
  if (savedExec.legacy) {
    const novo = el('div', 'col-note col-note--new');
    novo.append(
      icon('zap', 14),
      el('span', undefined, 'Novo na 3.6: a Coleta pode rodar em TODAS as aldeias, sem abrir a tela. Escolha "Segundo plano" abaixo e salve. Enquanto isso, ela segue só na tela de Coleta, como antes.'),
    );
    top.appendChild(novo);
  }

  // ── Onde roda ──
  const where = section('Onde roda', 'globe');
  const whereCards = el('div', 'col-cards');
  const fundo = radioCard(`col-exec-${uid}`, 'fundo', execMode === 'fundo', icon('zap', 16), 'Segundo plano', 'Todas as aldeias, com uma aba do jogo aberta em qualquer tela. Manda até 50 coletas de uma vez.', 'Recomendado');
  const tela = radioCard(`col-exec-${uid}`, 'tela', execMode === 'tela', gameImg('graphic/buildings/place.png', 20, 'Praça'), 'Só na tela de Coleta', 'Só com Praça → Coletar recursos aberta, na aldeia atual. Nesse modo o "Voltar em até" não vale.');
  whereCards.append(fundo.card, tela.card);
  where.body.appendChild(whereCards);
  root.appendChild(where.box);

  // ── Divisão entre os níveis ──
  const split = section('Divisão entre os níveis', 'grid');
  const splitCards = el('div', 'col-cards');
  const eq = radioCard(`col-lot-${uid}`, 'equilibrada', lotMode === 'equilibrada', icon('layers', 16), 'Equilibrada', 'Todos os níveis livres, voltando juntos. Mais recursos por hora.', 'Recomendado');
  const oneIc = portraitIc(LEVELS.find((l) => l.key === duration)?.id ?? 2);
  const one = radioCard(`col-lot-${uid}`, 'tudo', lotMode === 'tudo', oneIc, 'Um nível', 'Todas as tropas num nível só, o que você escolher abaixo.');
  const fixed = radioCard(`col-lot-${uid}`, 'fixo', lotMode === 'fixo', icon('edit', 16), 'Lote fixo', 'Quantidade máxima por tropa (coluna "Lote"), num nível só.');
  splitCards.append(eq.card, one.card, fixed.card);
  const levelPick = el('div', 'col-levels');
  const levelInputs: HTMLInputElement[] = [];
  for (const l of LEVELS) {
    const lab = el('label', 'col-level');
    const input = el('input');
    input.type = 'radio';
    input.name = `col-level-${uid}`;
    input.value = l.key;
    input.checked = l.key === duration;
    input.setAttribute('aria-label', `${l.name} Coleta`);
    levelInputs.push(input);
    lab.append(input, portrait(l.id), el('span', undefined, l.name));
    levelPick.appendChild(lab);
  }
  const levelLbl = el('div', 'col-lbl', 'Qual nível:');
  split.body.append(splitCards, levelLbl, levelPick);
  root.appendChild(split.box);

  // ── Tempo-alvo ──
  const target = section('Voltar em até', 'clock');
  const targets = el('div', 'col-targets');
  const mkTarget = (
    img: string,
    title: string,
    value: number,
  ): { box: HTMLDivElement; input: HTMLInputElement; hint: HTMLDivElement; chips: HTMLButtonElement[] } => {
    const box = el('div', 'col-target');
    const h = el('div', 'col-target-h');
    h.append(gameImg(img, 16, title), document.createTextNode(title));
    const row = el('div', 'col-target-row');
    const input = numInput(value, 0, 48, 0.5, `${title} (horas)`);
    row.append(input, el('span', 'col-hint', 'horas'));
    const chipsWrap = el('div', 'col-chips');
    const chips = [0, 1, 2, 4, 8].map((hrs) => {
      const b = el('button', 'col-chip', hrs === 0 ? 'Sem limite' : `${hrs} h`);
      b.type = 'button';
      b.addEventListener('click', () => {
        input.value = String(hrs);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      b.dataset.h = String(hrs);
      return b;
    });
    chipsWrap.append(...chips);
    const hint = el('div', 'col-hint');
    box.append(h, row, chipsWrap, hint);
    return { box, input, hint, chips };
  };
  const off = mkTarget('graphic/unit/att.png', 'Aldeias ofensivas', num(settings.targetHoursOff, 0));
  const def = mkTarget('graphic/unit/def.png', 'Aldeias defensivas', num(settings.targetHoursDef, 0));
  targets.append(off.box, def.box);
  const targetHelp = el('div', 'col-hint', 'Diga em quantas horas a coleta deve voltar: vai só a tropa necessária e o resto fica em casa. Aldeia ofensiva = mais tropa de ataque em casa do que de defesa.');
  const targetTela = el('div', 'col-hint', 'No modo "Só na tela" o "Voltar em até" não vale: vão todas as tropas ligadas.');
  target.body.append(targets, targetHelp, targetTela);
  root.appendChild(target.box);

  // ── Tropas ──
  const troops = section('Tropas', 'users');
  const table = el('table', 'col-troops');
  const thead = el('thead');
  const hr = el('tr');
  const th = (text: string, ic?: IconName): HTMLTableCellElement => {
    const c = el('th');
    if (ic !== undefined) c.appendChild(icon(ic, 11));
    c.appendChild(document.createTextNode(text));
    return c;
  };
  const lotTh = th('Lote', 'edit');
  hr.append(th(''), th('Coleta', 'check'), th('Fica em casa', 'home'), lotTh);
  thead.appendChild(hr);
  const tbody = el('tbody');
  const rows: { unit: string; on: HTMLInputElement; keep: HTMLInputElement; lot: HTMLInputElement; lotTd: HTMLTableCellElement; tr: HTMLTableRowElement }[] = [];
  for (const unit of SCAVENGE_UNITS) {
    const tr = el('tr');
    const nameTd = el('td');
    const u = el('span', 'col-unit');
    u.title = unitLabelOrKey(unit);
    u.appendChild(unitIcon(unit, 22));
    nameTd.appendChild(u);
    const sw = switchInput(!skip.has(unit), `${unitLabelOrKey(unit)} coleta`);
    const swTd = el('td');
    swTd.appendChild(sw.wrap);
    const keep = numInput(num(reserve[unit], 0), 0, 1_000_000, 10, `${unitLabelOrKey(unit)}: fica em casa`);
    const keepTd = el('td');
    keepTd.appendChild(keep);
    const lotIn = numInput(num(lot[unit], 0), 0, 1_000_000, 10, `${unitLabelOrKey(unit)}: lote`);
    const lotTd = el('td');
    lotTd.appendChild(lotIn);
    tr.append(nameTd, swTd, keepTd, lotTd);
    tbody.appendChild(tr);
    rows.push({ unit, on: sw.input, keep, lot: lotIn, lotTd, tr });
  }
  table.append(thead, tbody);
  const troopsHint = el('div', 'col-hint');
  troops.body.append(table, troopsHint);
  root.appendChild(troops.box);

  // ── Extras ──
  const extras = section('Extras', 'settings');
  const unlockRow = el('div', 'col-row');
  const unlockL = el('div', 'col-row-l');
  const unlockTxt = el('span', undefined, 'Desbloquear níveis sozinho');
  unlockTxt.appendChild(el('small', undefined, 'Quando não há nada para coletar, gasta madeira, argila e ferro da aldeia para liberar o próximo nível (1 aldeia por rodada).'));
  unlockL.append(gameImg('graphic/scavenging/lock_mini.png', 16, 'Nível bloqueado'), unlockTxt);
  const unlockSw = switchInput(settings.autoUnlock === true, 'Desbloquear níveis sozinho');
  unlockRow.append(unlockL, unlockSw.wrap);
  const minRow = el('div', 'col-row');
  const minL = el('div', 'col-row-l');
  const minTxt = el('span', undefined, 'Mínimo de tropas por nível');
  minTxt.appendChild(el('small', undefined, 'Nível que receberia menos que isso não é usado (evita coletas minúsculas).'));
  minL.append(icon('filter', 14), minTxt);
  const minIn = numInput(num(settings.minUnits, 10), 1, 10_000, 1, 'Mínimo de tropas por nível');
  minRow.append(minL, minIn);
  extras.body.append(unlockRow, minRow);
  root.appendChild(extras.box);

  // ── Regras por grupo de aldeias (cartões, sem formato para decorar) ──
  const groups = section('Regras por grupo de aldeias', 'flag');
  const saved = readProfiles(settings.groupProfiles);
  const legacy = typeof settings.groupRules === 'string' ? settings.groupRules : '';
  const converted = saved.length > 0 ? [] : profilesFromLegacy(legacy);
  const initialProfiles = saved.length > 0 ? saved : converted;
  const legacyLost = saved.length === 0 && legacy.trim() !== '' && converted.length === 0;
  if (saved.length === 0 && legacy.trim() !== '') {
    const aviso = el('div', 'colg-warn');
    aviso.textContent = legacyLost
      ? 'Não consegui converter suas regras antigas (texto). Elas continuam valendo até você criar os cartões.'
      : 'Suas regras antigas (texto) viraram os cartões abaixo. Lote e mínimo por grupo não existem mais nos cartões: confira cada um antes de salvar.';
    groups.body.appendChild(aviso);
  }
  const groupRules = buildGroupRules(initialProfiles, () => new Set(rows.filter((r) => !r.on.checked).map((r) => r.unit)));
  groups.body.appendChild(groupRules.el);
  root.appendChild(groups.box);

  const groupRulesCount = (): number => root.querySelectorAll('.colg-card').length;
  // Tropas gerais mudaram: cartões que seguem as gerais acompanham.
  for (const r of rows) r.on.addEventListener('change', () => groupRules.refreshAll());

  // ── Vivo: resumo, nível, lote, dicas ──
  const current = (): { exec: string; lot: string; level: string } => ({
    exec: fundo.input.checked ? 'fundo' : 'tela',
    lot: eq.input.checked ? 'equilibrada' : one.input.checked ? 'tudo' : 'fixo',
    level: levelInputs.find((i) => i.checked)?.value ?? 'media',
  });
  const refresh = (): void => {
    const c = current();
    const levelId = LEVELS.find((l) => l.key === c.level)?.id ?? 2;
    const used: number[] = c.lot === 'equilibrada' ? LEVELS.map((l) => l.id) : [levelId];
    heroPortraits.forEach((p, k) => p.classList.toggle('on', used.includes(k + 1)));
    levelPick.classList.toggle('col-hide', c.lot === 'equilibrada');
    levelLbl.classList.toggle('col-hide', c.lot === 'equilibrada');
    oneIc.style.backgroundImage = `url("graphic/scavenging/options/${levelId}.png")`;
    targets.classList.toggle('col-dim', c.exec === 'tela');
    targetTela.classList.toggle('col-hide', c.exec !== 'tela');
    troopsHint.textContent =
      'Desligada = essa tropa nunca coleta. "Fica em casa" vale em todos os modos.' +
      (c.lot === 'fixo' ? ' Lote = no máximo quantas saem de cada tropa (0 = fora do lote).' : '');
    lotTh.classList.toggle('col-hide', c.lot !== 'fixo');
    for (const r of rows) {
      r.lotTd.classList.toggle('col-hide', c.lot !== 'fixo');
      r.tr.classList.toggle('off', !r.on.checked);
      r.keep.disabled = !r.on.checked;
      r.lot.disabled = !r.on.checked;
    }
    for (const t of [off, def]) {
      const h = Number(t.input.value);
      for (const chip of t.chips) chip.setAttribute('aria-pressed', String(Number(chip.dataset.h) === h));
      t.hint.textContent =
        !Number.isFinite(h) || h <= 0
          ? 'Sem limite: manda todas as tropas que podem coletar.'
          : (() => {
              const carga = carryFor(h, used);
              const fmt = (n: number): string => Math.round(n).toLocaleString('pt-BR');
              return `Estimativa: para voltar em até ${String(h).replace('.', ',')} h, cada aldeia manda no máximo ≈ ${fmt(carga / 25)} lanceiros (ou ${fmt(carga / 80)} cavalarias leves) ${used.length === 4 ? 'somando os níveis' : `na ${LEVELS[levelId - 1]?.name ?? ''} Coleta`}. O resto fica em casa.`;
            })();
    }
    const tropas = rows.filter((r) => r.on.checked).length;
    const emCasa = rows.filter((r) => r.on.checked && Number(r.keep.value) > 0).length;
    const nRegras = groupRulesCount();
    const alvo = (v: string): string => (Number(v) > 0 ? `${String(Number(v)).replace('.', ',')} h` : 'sem limite');
    heroText.textContent = '';
    const b = (t: string): HTMLElement => el('b', undefined, t);
    heroText.append(
      b(c.exec === 'fundo' ? 'Segundo plano, todas as aldeias' : 'Só na tela de Coleta'),
      document.createTextNode(' · '),
      b(c.lot === 'equilibrada' ? 'níveis livres voltando juntos' : `${LEVELS[levelId - 1]?.name ?? ''} Coleta${c.lot === 'fixo' ? ', lote fixo' : ''}`),
      document.createElement('br'),
      document.createTextNode(
        c.exec === 'tela'
          ? `${tropas} de ${SCAVENGE_UNITS.length} tropas coletando`
          : `Voltam em até: ofensivas ${alvo(off.input.value)} · defensivas ${alvo(def.input.value)} · ${tropas} de ${SCAVENGE_UNITS.length} tropas coletando`,
      ),
      document.createElement('br'),
      document.createTextNode(
        `${nRegras === 0 ? 'Sem regras por grupo' : `${nRegras} regra(s) por grupo`} · ${emCasa === 0 ? 'nenhuma tropa reservada em casa' : `${emCasa} tropa(s) com reserva em casa`}`,
      ),
    );
  };
  root.addEventListener('input', refresh);
  root.addEventListener('change', refresh);
  refresh();

  return {
    el: root,
    top,
    collect: () => {
      const c = current();
      const bad = (i: HTMLInputElement, msg: string): { ok: false; error: string } => {
        i.classList.add('tsh-input--invalid');
        i.scrollIntoView({ block: 'center' });
        i.focus({ preventScroll: true });
        return { ok: false, error: msg };
      };
      for (const i of root.querySelectorAll('.tsh-input--invalid')) i.classList.remove('tsh-input--invalid');
      const hOff = Number(off.input.value);
      const hDef = Number(def.input.value);
      if (!Number.isFinite(hOff) || hOff < 0 || hOff > 48) return bad(off.input, '"Voltar em até" das ofensivas: use de 0 a 48 horas (0 = sem limite).');
      if (!Number.isFinite(hDef) || hDef < 0 || hDef > 48) return bad(def.input, '"Voltar em até" das defensivas: use de 0 a 48 horas (0 = sem limite).');
      const min = Number(minIn.value);
      if (!Number.isInteger(min) || min < 1 || min > 10_000) return bad(minIn, 'Mínimo por nível: número inteiro de 1 a 10.000.');
      const nextReserve: Record<string, number> = { ...reserve };
      const nextLot: Record<string, number> = {};
      const skipUnits: string[] = [];
      for (const r of rows) {
        const k = Number(r.keep.value || '0');
        const l = Number(r.lot.value || '0');
        if (!Number.isInteger(k) || k < 0) return bad(r.keep, `"Fica em casa" de ${unitLabelOrKey(r.unit)}: use um número inteiro (0 ou mais).`);
        if (!Number.isInteger(l) || l < 0) return bad(r.lot, `Lote de ${unitLabelOrKey(r.unit)}: use um número inteiro (0 ou mais).`);
        nextReserve[r.unit] = k;
        if (l > 0) nextLot[r.unit] = l;
        if (!r.on.checked) skipUnits.push(r.unit);
      }
      if (skipUnits.length === SCAVENGE_UNITS.length) {
        rows[0]?.on.focus();
        return { ok: false, error: 'Ligue pelo menos uma tropa na coluna "Coleta".' };
      }
      if (c.lot === 'fixo' && Object.keys(nextLot).length === 0) {
        return { ok: false, error: 'Lote fixo: preencha a coluna "Lote" de pelo menos uma tropa (ou escolha Equilibrada / Um nível).' };
      }
      const gr = groupRules.collect();
      if (!gr.ok) return gr;
      return {
        ok: true,
        values: {
          execMode: c.exec,
          lotMode: c.lot,
          duration: c.level,
          targetHoursOff: hOff,
          targetHoursDef: hDef,
          skipUnits,
          reserveByUnit: nextReserve,
          units: nextLot,
          autoUnlock: unlockSw.input.checked,
          minUnits: min,
          groupProfiles: gr.profiles,
          // O formato antigo em texto vira cartões ao salvar (o que não converteu fica valendo).
          groupRules: legacyLost && gr.profiles.length === 0 ? legacy : '',
        },
      };
    },
  };
}

function portraitIc(levelId: number): HTMLDivElement {
  const p = portrait(levelId);
  p.classList.add('on');
  p.style.width = '22px';
  p.style.height = '22px';
  p.style.border = '0';
  return p;
}
