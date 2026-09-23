// Modais da aba Automações — vivem no Shadow DOM do shell (position:fixed
// dentro do shadow funciona; todas as classes tsh-* vêm de
// tsh-panel-styles, garantida idempotente aqui e no painel). Estilo Nexus:
// cabeçalho em gradiente com título UPPERCASE, seções-caixa, campo em linha
// (label + ⓘ help à esquerda, controle à direita) e rodapé Cancelar/Salvar.
// - Configurar: seção AGENDA (cooldown em MINUTOS — vazio = padrão do módulo —
//   + janela ativa HH:MM no relógio LOCAL, vazia = sempre, cruza meia-noite é
//   suportado) e seção PARÂMETROS (formulário declarativo de
//   automation.settingsForm; valores iniciais de loadSettings — tipo errado no
//   storage mostra o default do módulo).
// - Salvar valida a agenda com scheduleError, clampá números nos limites do
//   campo e cai para o default em select fora das opções. "Restaurar padrões"
//   limpa settings E agenda do mundo (com confirmação).
// - Prévia: o MESMO scaffold de modal em modo somente-leitura com o JSON
//   pretty do último plano/relatório + botão copiar (clipboard com fallback).
// Zero innerHTML com dado dinâmico: todo texto entra por textContent /
// createTextNode. Sem timers de UI aqui — o único setTimeout é o reset do
// rótulo "Copiado!" (2s, feedback efêmero do modal, ver copyToClipboard); o
// único timer permanente do painel é o countdown de tsh-panel.ts.

import { icon, type IconName } from '../../core/icons';
import { ensureTshPanelStyles } from './tsh-panel-styles';
import {
  loadSchedule,
  loadSettings,
  clearSettings,
  saveSchedule,
  saveSettings,
  scheduleError,
  type SettingsField,
  type TshSchedule,
} from './tsh-settings';
import { effectiveCooldownMs, type TshAutomation } from './tsh-runtime';
import { isUnitKey, unitIcon, unitLabelOrKey } from './tsh-units';

/** Campo do formulário já ligado ao input (para ler os valores no Salvar). */
interface FieldBinding {
  field: SettingsField;
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  /** Valor inicial efetivo (default do módulo quando o storage está estranho). */
  initial: unknown;
  /** Apenas type='record': inputs numéricos por chave do objeto. */
  recordInputs?: Record<string, HTMLInputElement>;
  /** Apenas type='record': valores iniciais por chave (defaults quando storage vazio). */
  recordInitial?: Record<string, number>;
}

interface TshModal {
  body: HTMLDivElement;
  foot: HTMLDivElement;
  /** Fecha JÁ (Salvar/Cancelar explícitos). */
  close: () => void;
  /**
   * Onda B: marca o conteúdo atual como "salvo" — a partir daí fechar pelo X,
   * Esc ou clique fora com alterações pede confirmação (antes perdia tudo).
   */
  markClean: (scope?: HTMLElement) => void;
  /** Fecha PERGUNTANDO se houver alterações não salvas (botão "Fechar"). */
  requestClose: () => void;
}

/** Pilha de diálogos abertos (Onda B: Esc fecha só o do TOPO, não todos). */
const modalStack: symbol[] = [];

/** Fotografia dos campos do diálogo (detecção de alterações não salvas). */
function formSnapshot(root: HTMLElement): string {
  const parts: string[] = [];
  for (const el of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    'input, select, textarea',
  )) {
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      parts.push(el.checked ? '1' : '0');
    } else {
      parts.push(el.value);
    }
  }
  return parts.join('\u0001');
}

// ── Helpers de construção (tudo textContent — nada de HTML dinâmico) ──

/** Seção-caixa Nexus: título UPPERCASE com ícone + corpo para os campos. */
function sectionBox(title: string, iconName: IconName): { box: HTMLDivElement; body: HTMLDivElement } {
  const box = document.createElement('div');
  box.className = 'tsh-section';
  const head = document.createElement('div');
  head.className = 'tsh-section-title';
  head.appendChild(icon(iconName, 12));
  head.appendChild(document.createTextNode(title));
  const body = document.createElement('div');
  box.append(head, body);
  return { box, body };
}

/** Banner de info Nexus no topo do corpo (help geral da tela). */
export function tshNoteBanner(text: string, iconName: IconName = 'info'): HTMLDivElement {
  const note = document.createElement('div');
  note.className = 'tsh-note';
  note.appendChild(icon(iconName, 13));
  const txt = document.createElement('span');
  txt.textContent = text;
  note.appendChild(txt);
  return note;
}

/** Label 12px semibold com ⓘ de help quando houver texto.
 *  O ⓘ usa tooltip CSS (data-tip, à direita para não cobrir o input) e mantém
 *  o title nativo como fallback. */
function fieldLabel(text: string, help?: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'tsh-field-label';
  el.appendChild(document.createTextNode(text));
  if (help !== undefined) {
    const tip = document.createElement('span');
    tip.className = 'tsh-field-info tsh-tip tsh-tip--right';
    tip.setAttribute('data-tip', help);
    tip.setAttribute('aria-label', help);
    tip.appendChild(icon('info', 11));
    el.appendChild(tip);
  }
  return el;
}

function appendHelp(wrap: HTMLElement, text: string): void {
  const el = document.createElement('div');
  el.className = 'tsh-field-help';
  el.textContent = text;
  wrap.appendChild(el);
}

/** Troca o rótulo preservando o ícone do botão (span .tsh-btn-txt quando há). */
function setBtnLabel(btn: HTMLButtonElement, text: string): void {
  const txt = btn.querySelector('.tsh-btn-txt');
  if (txt !== null) txt.textContent = text;
  else btn.textContent = text;
}

function buttonRow(...buttons: HTMLButtonElement[]): HTMLDivElement {
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '6px';
  for (const btn of buttons) row.appendChild(btn);
  return row;
}

/** Overlay + modal (head/body/foot) anexados ao shadow; Esc e clique fora fecham.
 *  Exportado para as outras telas do painel reutilizarem o MESMO scaffold (ex.: tela Comandos).
 *  opts.onClose dispara UMA vez em QUALQUER fechamento (botão, Esc, clique fora) —
 *  usado pelo tshConfirm para resolver "false" quando o usuário fecha sem confirmar. */
export function buildTshModal(
  shadow: ShadowRoot,
  title: string,
  iconName: IconName,
  opts?: { onClose?: () => void },
): TshModal {
  const token = Symbol('tsh-modal');
  // A11y (revisão Onda C): o foco volta para quem abriu o diálogo ao fechar.
  const opener = shadow.activeElement instanceof HTMLElement ? shadow.activeElement : null;
  let cleanSnapshot: string | null = null;
  let dirtyScope: HTMLElement | null = null;
  ensureTshPanelStyles(shadow);
  const overlay = document.createElement('div');
  overlay.className = 'tsh-overlay';
  const modal = document.createElement('div');
  modal.className = 'tsh-modal';
  const head = document.createElement('div');
  head.className = 'tsh-modal-head';
  const titleEl = document.createElement('div');
  titleEl.className = 'tsh-modal-title';
  titleEl.appendChild(icon(iconName, 16));
  titleEl.appendChild(document.createTextNode(title));
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'tsh-modal-close tsh-tip tsh-tip--below';
  closeBtn.setAttribute('data-tip', 'Fechar');
  closeBtn.setAttribute('aria-label', 'Fechar');
  closeBtn.appendChild(icon('x', 14));
  head.append(titleEl, closeBtn);
  const body = document.createElement('div');
  body.className = 'tsh-modal-body';
  const foot = document.createElement('div');
  foot.className = 'tsh-modal-foot';
  modal.append(head, body, foot);
  // A11y (P3 revisão Nexus): modal anunciado como diálogo e com foco inicial.
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  overlay.appendChild(modal);
  shadow.appendChild(overlay);

  let closed = false;
  let asking = false;
  const isTop = (): boolean => modalStack[modalStack.length - 1] === token;
  const onKey = (event: KeyboardEvent): void => {
    if (!isTop()) return; // Onda B: só o diálogo do topo reage
    if (event.key === 'Escape') {
      event.stopPropagation();
      void requestClose();
    } else if (event.key === 'Tab') {
      // Foco preso no diálogo (acessibilidade): Tab/Shift+Tab circulam nele.
      const focaveis = Array.from(
        modal.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]'),
      ).filter((el) => el.offsetParent !== null);
      const primeiro = focaveis[0];
      const ultimo = focaveis[focaveis.length - 1];
      if (primeiro === undefined || ultimo === undefined) return;
      const ativo = shadow.activeElement;
      if (event.shiftKey && (ativo === primeiro || !modal.contains(ativo))) {
        event.preventDefault();
        ultimo.focus();
      } else if (!event.shiftKey && (ativo === ultimo || !modal.contains(ativo))) {
        event.preventDefault();
        primeiro.focus();
      }
    }
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    const index = modalStack.indexOf(token);
    if (index >= 0) modalStack.splice(index, 1);
    overlay.remove();
    if (opener !== null && opener.isConnected) opener.focus();
    opts?.onClose?.();
  };
  /** X / Esc / clique fora: com alterações não salvas, pergunta antes. */
  const requestClose = async (): Promise<void> => {
    if (closed || asking) return;
    if (cleanSnapshot !== null && formSnapshot(dirtyScope ?? body) !== cleanSnapshot) {
      asking = true;
      const descartar = await tshConfirm(
        shadow,
        'Descartar alterações?',
        'Há alterações não salvas nesta janela. Fechar e perder o que foi digitado?',
        { danger: true },
      );
      asking = false;
      if (!descartar) return;
    }
    close();
  };
  modalStack.push(token);
  document.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', () => {
    void requestClose();
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) void requestClose(); // clique fora do modal fecha
  });
  closeBtn.focus();
  const markClean = (scope?: HTMLElement): void => {
    dirtyScope = scope ?? body;
    cleanSnapshot = formSnapshot(dirtyScope);
  };
  return {
    body,
    foot,
    close,
    markClean,
    requestClose: () => {
      void requestClose();
    },
  };
}

// ── Diálogo de confirmação (substitui window.confirm — P2 auditoria) ──

/** Confirmação Nexus no MESMO scaffold dos modais: mensagem 12.5px no corpo +
 *  rodapé Cancelar/Confirmar (danger=true → Confirmar em vermelho sob fundo
 *  tint). Resolve false em qualquer fechamento sem confirmar (Cancelar, Esc,
 *  clique fora ou X). pt-BR; texto entra sempre por textContent. */
export function tshConfirm(
  shadow: ShadowRoot,
  titulo: string,
  mensagem: string,
  opts?: { danger?: boolean },
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const decide = (valor: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(valor);
    };
    const { body, foot, close } = buildTshModal(shadow, titulo, 'alert', { onClose: () => decide(false) });
    const msg = document.createElement('div');
    msg.className = 'tsh-confirm-msg';
    msg.textContent = mensagem; // sempre textContent — nunca HTML
    body.appendChild(msg);
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'tsh-btn tsh-btn--cancel';
    cancelBtn.appendChild(icon('x', 12));
    cancelBtn.appendChild(document.createTextNode('Cancelar'));
    cancelBtn.addEventListener('click', close); // onClose resolve false
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = opts?.danger === true ? 'tsh-btn tsh-btn--danger' : 'tsh-btn tsh-btn--primary';
    okBtn.appendChild(icon('check', 12));
    okBtn.appendChild(document.createTextNode('Confirmar'));
    okBtn.addEventListener('click', () => {
      decide(true); // settle ANTES do close — o onClose(false) vira no-op
      close();
    });
    foot.append(cancelBtn, okBtn);
    // Ação perigosa: o foco fica em Cancelar (Enter não destrói por engano).
    if (opts?.danger === true) cancelBtn.focus();
    else okBtn.focus();
  });
}

// ── Valores iniciais (storage com tipo errado → default do módulo) ──

function initialValue(field: SettingsField, merged: Record<string, unknown>, defaults: Record<string, unknown>): unknown {
  const stored = merged[field.key];
  const def = defaults[field.key];
  switch (field.type) {
    case 'number':
      if (typeof stored === 'number' && Number.isFinite(stored)) return stored;
      return typeof def === 'number' && Number.isFinite(def) ? def : null;
    case 'boolean':
      if (typeof stored === 'boolean') return stored;
      return def === true;
    case 'select': {
      const opts = field.options ?? [];
      const valid = (value: unknown): value is string =>
        typeof value === 'string' && opts.some((opt) => opt.value === value);
      if (valid(stored)) return stored;
      if (valid(def)) return def;
      return opts[0]?.value ?? '';
    }
    case 'record': {
      // Objeto chave→número (ex.: metas por unidade, reservas por recurso):
      // uma caixa numérica por recordKey, valores de stored ?? default ?? 0.
      const storedRecord =
        typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
      const defaultRecord =
        typeof def === 'object' && def !== null ? (def as Record<string, unknown>) : {};
      const initial: Record<string, number> = {};
      for (const rk of field.recordKeys ?? []) {
        const s = storedRecord[rk.key];
        const d = defaultRecord[rk.key];
        initial[rk.key] =
          typeof s === 'number' && Number.isFinite(s)
            ? s
            : typeof d === 'number' && Number.isFinite(d)
              ? d
              : 0;
      }
      return initial;
    }
    default: // text | textarea
      if (typeof stored === 'string') return stored;
      return typeof def === 'string' ? def : '';
  }
}

// ── Render de um campo declarativo (linha Nexus: label à esquerda, controle
//    à direita; select/text/textarea/record ocupam a linha toda) ──

function renderField(
  field: SettingsField,
  merged: Record<string, unknown>,
  defaults: Record<string, unknown>,
  bindings: FieldBinding[],
): HTMLDivElement {
  const initial = initialValue(field, merged, defaults);
  const compact = field.type === 'number' || field.type === 'boolean';
  const wrap = document.createElement('div');
  wrap.className = compact ? 'tsh-field' : 'tsh-field tsh-field--block';
  const side = document.createElement('div');
  side.className = 'tsh-field-side';
  let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  switch (field.type) {
    case 'number': {
      const el = document.createElement('input');
      el.type = 'number';
      el.className = 'tsh-input tsh-input--num';
      if (field.min !== undefined) el.min = String(field.min);
      if (field.max !== undefined) el.max = String(field.max);
      if (field.step !== undefined) el.step = String(field.step);
      if (field.placeholder !== undefined) el.placeholder = field.placeholder;
      if (typeof initial === 'number') el.value = String(initial);
      input = el;
      side.appendChild(fieldLabel(field.label)); // ajuda vai em texto logo abaixo (Onda C: sem duplicar no ⓘ)
      wrap.append(side, el);
      break;
    }
    case 'boolean': {
      // Checkbox = switch iOS 36×20 (o binding continua lendo .checked).
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.checked = initial === true;
      el.setAttribute('aria-label', field.label);
      const sw = document.createElement('label');
      sw.className = 'tsh-switch';
      const track = document.createElement('span');
      track.className = 'tsh-switch-track';
      sw.append(el, track);
      input = el;
      side.appendChild(fieldLabel(field.label)); // ajuda vai em texto logo abaixo (Onda C: sem duplicar no ⓘ)
      wrap.append(side, sw);
      break;
    }
    case 'textarea': {
      const el = document.createElement('textarea');
      el.className = 'tsh-textarea';
      if (field.placeholder !== undefined) el.placeholder = field.placeholder;
      if (typeof initial === 'string') el.value = initial;
      input = el;
      side.appendChild(fieldLabel(field.label)); // ajuda vai em texto logo abaixo (Onda C: sem duplicar no ⓘ)
      wrap.append(side, el);
      break;
    }
    case 'select': {
      const el = document.createElement('select');
      el.className = 'tsh-select';
      for (const opt of field.options ?? []) {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        el.appendChild(option);
      }
      if (typeof initial === 'string') el.value = initial;
      input = el;
      side.appendChild(fieldLabel(field.label)); // ajuda vai em texto logo abaixo (Onda C: sem duplicar no ⓘ)
      wrap.append(side, el);
      break;
    }
    case 'record': {
      const grid = document.createElement('div');
      grid.className = 'tsh-record-grid';
      const values = (initial && typeof initial === 'object' ? (initial as Record<string, number>) : {});
      const recordInputs: Record<string, HTMLInputElement> = {};
      for (const rk of field.recordKeys ?? []) {
        const cell = document.createElement('div');
        cell.className = 'tsh-record-cell';
        const lab = document.createElement('span');
        lab.className = 'tsh-record-label';
        if (isUnitKey(rk.key)) {
          // Unidade: ícone do jogo + rótulo pt-BR; a key crua fica no title.
          cell.classList.add('tsh-unit-cell');
          lab.title = rk.key;
          lab.appendChild(unitIcon(rk.key, 18));
          const labTxt = document.createElement('span');
          labTxt.textContent = unitLabelOrKey(rk.key);
          lab.appendChild(labTxt);
        } else {
          lab.textContent = rk.label;
        }
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.className = 'tsh-input';
        inp.value = String(values[rk.key] ?? 0);
        if (rk.min !== undefined) inp.min = String(rk.min);
        if (rk.max !== undefined) inp.max = String(rk.max);
        inp.step = String(rk.step ?? 1);
        recordInputs[rk.key] = inp;
        cell.append(lab, inp);
        grid.appendChild(cell);
      }
      side.appendChild(fieldLabel(field.label)); // ajuda vai em texto logo abaixo (Onda C: sem duplicar no ⓘ)
      if (field.help !== undefined) appendHelp(side, field.help);
      wrap.append(side, grid);
      const hidden = document.createElement('input'); // compat: binding sempre tem um input
      hidden.type = 'hidden';
      wrap.appendChild(hidden);
      bindings.push({ field, input: hidden, initial, recordInputs, recordInitial: values });
      return wrap;
    }
    default: {
      // text
      const el = document.createElement('input');
      el.type = 'text';
      el.className = 'tsh-input';
      if (field.placeholder !== undefined) el.placeholder = field.placeholder;
      if (typeof initial === 'string') el.value = initial;
      input = el;
      side.appendChild(fieldLabel(field.label)); // ajuda vai em texto logo abaixo (Onda C: sem duplicar no ⓘ)
      wrap.append(side, el);
    }
  }
  if (field.help !== undefined) appendHelp(side, field.help);
  bindings.push({ field, input, initial });
  return wrap;
}

/**
 * Onda C — validação VISÍVEL de número (antes o Salvar corrigia em silêncio):
 * null = ok (vazio também é ok: cai no padrão); senão a mensagem pt-BR.
 */
export function numberFieldIssue(raw: string, limits: { min?: number; max?: number }): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(n)) return 'não é um número';
  if (limits.min !== undefined && n < limits.min) return `mínimo ${limits.min}`;
  if (limits.max !== undefined && n > limits.max) return `máximo ${limits.max}`;
  return null;
}

/** Marca/desmarca os campos numéricos fora da faixa; devolve as mensagens. */
function validateNumberBindings(bindings: readonly FieldBinding[]): string[] {
  const issues: string[] = [];
  const check = (input: HTMLInputElement, label: string, limits: { min?: number; max?: number }): void => {
    // "1e" num campo numérico lê como '' — o navegador sinaliza badInput.
    const issue = input.validity.badInput ? 'não é um número' : numberFieldIssue(input.value, limits);
    input.classList.toggle('tsh-input--invalid', issue !== null);
    input.setAttribute('aria-invalid', issue !== null ? 'true' : 'false');
    if (issue !== null) issues.push(`${label}: ${issue}`);
  };
  for (const binding of bindings) {
    const field = binding.field;
    if (field.type === 'number' && binding.input instanceof HTMLInputElement) {
      check(binding.input, field.label, { ...(field.min !== undefined ? { min: field.min } : {}), ...(field.max !== undefined ? { max: field.max } : {}) });
    } else if (field.type === 'record') {
      for (const rk of field.recordKeys ?? []) {
        const input = binding.recordInputs?.[rk.key];
        if (input === undefined) continue;
        check(input, `${field.label} (${rk.label})`, { ...(rk.min !== undefined ? { min: rk.min } : {}), ...(rk.max !== undefined ? { max: rk.max } : {}) });
      }
    }
  }
  return issues;
}

/** Lê o valor do input já convertido/clampado para gravar no settings. */
function collectFieldValue(binding: FieldBinding, values: Record<string, unknown>): void {
  const field = binding.field;
  if (field.type === 'record') {
    const record: Record<string, number> = {};
    const fallback = binding.recordInitial ?? {};
    for (const rk of field.recordKeys ?? []) {
      const input = binding.recordInputs?.[rk.key];
      const raw = input?.value.trim() ?? '';
      let n = raw === '' ? (fallback[rk.key] ?? 0) : Number(raw.replace(',', '.'));
      if (!Number.isFinite(n)) n = fallback[rk.key] ?? 0;
      if (rk.min !== undefined && n < rk.min) n = rk.min;
      if (rk.max !== undefined && n > rk.max) n = rk.max;
      // P2 (revisão Onda 8): step inteiro ⇒ valor inteiro — schemas z.number()
      // .int() rejeitam decimais digitados ("10,5") e derrubavam o ciclo.
      if (rk.step !== undefined && Number.isInteger(rk.step) && rk.step >= 1) n = Math.round(n);
      record[rk.key] = n;
    }
    values[field.key] = record;
    return;
  }
  if (field.type === 'number') {
    const fallback =
      typeof binding.initial === 'number' && Number.isFinite(binding.initial) ? binding.initial : 0;
    const raw = binding.input.value.trim();
    let n = raw === '' ? fallback : Number(raw.replace(',', '.'));
    if (!Number.isFinite(n)) n = fallback;
    if (field.min !== undefined && n < field.min) n = field.min;
    if (field.max !== undefined && n > field.max) n = field.max;
    // P2 (revisão Onda 8): idem — step inteiro grava inteiro.
    if (field.step !== undefined && Number.isInteger(field.step) && field.step >= 1) n = Math.round(n);
    values[field.key] = n;
    return;
  }
  if (field.type === 'boolean') {
    values[field.key] = binding.input instanceof HTMLInputElement ? binding.input.checked : false;
    return;
  }
  if (field.type === 'select') {
    const opts = field.options ?? [];
    const chosen = binding.input.value;
    const initial = binding.initial;
    values[field.key] = opts.some((opt) => opt.value === chosen)
      ? chosen
      : typeof initial === 'string' && opts.some((opt) => opt.value === initial)
        ? initial
        : (opts[0]?.value ?? '');
    return;
  }
  values[field.key] = binding.input.value; // text | textarea
}

// ── Clipboard (com fallback) ──

/** Copia com fallback; no sucesso o rótulo vira "Copiado!" e VOLTA ao original
 *  após 2s (setTimeout simples — feedback efêmero de modal: o modal não tem
 *  re-render, e se fechar antes o timeout só toca um nó desconectado). */
function copyToClipboard(text: string, btn: HTMLButtonElement, label: string): void {
  let resetTimer: number | undefined;
  const done = (): void => {
    setBtnLabel(btn, 'Copiado!');
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => setBtnLabel(btn, label), 2000);
  };
  const fail = (): void => {
    setBtnLabel(btn, 'Não foi possível copiar');
  };
  const fallback = (): void => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'true');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    if (ok) done();
    else fail();
  };
  if (typeof navigator.clipboard?.writeText === 'function') {
    navigator.clipboard.writeText(text).then(done, fallback);
  } else {
    fallback();
  }
}

// ── Modal de configurações ──

export function openTshSettingsModal(
  shadow: ShadowRoot,
  automation: TshAutomation,
  world: string,
  onSaved: () => void,
): void {
  const { body, foot, close, markClean } = buildTshModal(shadow, `Configurar — ${automation.label}`, 'settings');
  const form = automation.settingsForm ?? [];
  const defaults = automation.settingsDefaults ?? {};
  const merged = loadSettings(world, automation.id, defaults);
  const schedule = loadSchedule(world, automation.id);
  const bindings: FieldBinding[] = [];

  // ── Agenda (seção-caixa) ──
  const agenda = sectionBox('Agenda', 'calendar');
  body.appendChild(agenda.box);

  const cooldownField = document.createElement('div');
  cooldownField.className = 'tsh-field';
  const cooldownSide = document.createElement('div');
  cooldownSide.className = 'tsh-field-side';
  const cooldownInput = document.createElement('input');
  cooldownInput.type = 'number';
  cooldownInput.className = 'tsh-input tsh-input--num';
  cooldownInput.min = '1';
  cooldownInput.max = '1440';
  cooldownInput.placeholder = String(Math.max(1, Math.round(effectiveCooldownMs(automation, {}) / 60_000)));
  if (schedule.cooldownMinutes !== undefined) cooldownInput.value = String(schedule.cooldownMinutes);
  cooldownSide.appendChild(fieldLabel('Intervalo entre ciclos (minutos)'));
  appendHelp(cooldownSide, 'Vazio = padrão do módulo.');
  cooldownField.append(cooldownSide, cooldownInput);
  agenda.body.appendChild(cooldownField);

  const fromField = document.createElement('div');
  fromField.className = 'tsh-field';
  const fromSide = document.createElement('div');
  fromSide.className = 'tsh-field-side';
  const fromInput = document.createElement('input');
  fromInput.type = 'text';
  fromInput.className = 'tsh-input tsh-input--num';
  fromInput.placeholder = 'sempre';
  if (schedule.activeFrom !== undefined && schedule.activeFrom !== '') fromInput.value = schedule.activeFrom;
  fromSide.appendChild(fieldLabel('Ativa a partir de (HH:MM)'));
  fromField.append(fromSide, fromInput);
  agenda.body.appendChild(fromField);

  const toField = document.createElement('div');
  toField.className = 'tsh-field';
  const toSide = document.createElement('div');
  toSide.className = 'tsh-field-side';
  const toInput = document.createElement('input');
  toInput.type = 'text';
  toInput.className = 'tsh-input tsh-input--num';
  toInput.placeholder = 'sempre';
  if (schedule.activeTo !== undefined && schedule.activeTo !== '') toInput.value = schedule.activeTo;
  const janelaHelp =
    'Janela ativa no relógio LOCAL do seu computador; vazia = sempre. Janela que cruza a meia-noite (ex.: 22:00–06:00) é suportada.';
  toSide.appendChild(fieldLabel('Ativa até (HH:MM)'));
  appendHelp(toSide, janelaHelp);
  toField.append(toSide, toInput);
  agenda.body.appendChild(toField);

  // Parada programada universal: freio de mão com data e hora.
  const stopField = document.createElement('div');
  stopField.className = 'tsh-field';
  const stopSide = document.createElement('div');
  stopSide.className = 'tsh-field-side';
  const stopToggle = document.createElement('input');
  stopToggle.type = 'checkbox';
  stopToggle.className = 'tsh-check';
  stopToggle.checked = schedule.stopEnabled === true;
  const stopInput = document.createElement('input');
  stopInput.type = 'datetime-local';
  stopInput.className = 'tsh-input tsh-input--num';
  if (schedule.stopAt !== undefined && schedule.stopAt !== '') stopInput.value = schedule.stopAt;
  const stopHelp =
    'Quando ligada e o horário passar, esta automação para de rodar até você desligar a parada aqui.';
  stopSide.appendChild(fieldLabel('Parada programada'));
  appendHelp(stopSide, stopHelp);
  stopField.append(stopToggle, stopSide, stopInput);
  agenda.body.appendChild(stopField);

  // ── Parâmetros (seção-caixa) ──
  if (form.length > 0) {
    const params = sectionBox('Parâmetros', 'list');
    body.appendChild(params.box);
    for (const field of form) params.body.appendChild(renderField(field, merged, defaults, bindings));
  }

  let errorEl: HTMLDivElement | null = null;
  const showError = (message: string): void => {
    if (errorEl === null) {
      errorEl = document.createElement('div');
      errorEl.className = 'tsh-error';
      body.appendChild(errorEl);
    }
    errorEl.textContent = message; // sempre textContent — nunca HTML
  };

  // ── Rodapé Nexus: Restaurar à esquerda; Cancelar/Salvar à direita ──
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'tsh-btn tsh-btn--ghost tsh-foot-left';
  resetBtn.appendChild(icon('refresh', 12));
  resetBtn.appendChild(document.createTextNode('Restaurar padrões'));
  resetBtn.addEventListener('click', async () => {
    // P2 (auditoria impeccable): window.confirm → diálogo Nexus (tshConfirm).
    const ok = await tshConfirm(
      shadow,
      'Restaurar padrões',
      `Restaurar padrões de "${automation.label}"? A agenda e os parâmetros deste mundo voltam ao padrão do módulo.`,
      { danger: true },
    );
    if (!ok) return;
    clearSettings(world, automation.id); // zera mesmo (saveSettings agora faz merge)
    saveSchedule(world, automation.id, {});
    close();
    onSaved();
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'tsh-btn tsh-btn--cancel';
  cancelBtn.appendChild(icon('x', 12));
  cancelBtn.appendChild(document.createTextNode('Cancelar'));
  cancelBtn.addEventListener('click', close);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'tsh-btn tsh-btn--primary';
  saveBtn.appendChild(icon('check', 12));
  saveBtn.appendChild(document.createTextNode('Salvar'));
  saveBtn.addEventListener('click', () => {
    const nextSchedule: TshSchedule = {};
    const cooldownRaw = cooldownInput.value.trim();
    if (cooldownRaw !== '') nextSchedule.cooldownMinutes = Number(cooldownRaw); // NaN cai no scheduleError
    const fromRaw = fromInput.value.trim();
    const toRaw = toInput.value.trim();
    if (fromRaw !== '') nextSchedule.activeFrom = fromRaw;
    if (toRaw !== '') nextSchedule.activeTo = toRaw;
    const stopRaw = stopInput.value.trim();
    if (stopToggle.checked && stopRaw === '') {
      showError('Parada programada ligada exige data e hora.');
      return;
    }
    if (stopToggle.checked) nextSchedule.stopEnabled = true;
    if (stopRaw !== '') nextSchedule.stopAt = stopRaw;
    const erro = scheduleError(nextSchedule);
    if (erro !== null) {
      showError(erro);
      return;
    }
    const issues = validateNumberBindings(bindings);
    if (issues.length > 0) {
      showError(`Corrija os campos destacados — ${issues.join(' · ')}.`);
      return;
    }
    const values: Record<string, unknown> = {};
    for (const binding of bindings) collectFieldValue(binding, values);
    saveSchedule(world, automation.id, nextSchedule);
    saveSettings(world, automation.id, values);
    close();
    onSaved();
  });

  foot.append(resetBtn, buttonRow(cancelBtn, saveBtn));
  // Onda C: o destaque some assim que o valor volta para a faixa.
  body.addEventListener('input', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.classList.contains('tsh-input--invalid')) {
      validateNumberBindings(bindings);
    }
  });
  markClean(); // Onda B: fechar com alterações pede confirmação
}

// ── Modal de prévia (somente-leitura, mesmo scaffold) ──

/** Rótulos humanizados pt-BR para os campos conhecidos da prévia. */
const PREVIEW_FIELD_LABELS: Record<string, string> = {
  status: 'Status',
  message: 'Mensagem',
  msg: 'Mensagem',
};

/** "villagesFound"/"total_sent" → "Villages found"/"Total sent" (fallback). */
function humanizeKey(key: string): string {
  const known = PREVIEW_FIELD_LABELS[key] ?? PREVIEW_FIELD_LABELS[key.toLowerCase()];
  if (known !== undefined) return known;
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Chaves de contagem ("total", "villagesCount"…) sobem no resumo com status/mensagem. */
function isCountKey(lowerKey: string): boolean {
  return /(^|_)(count|total|quantity|qtd)$|count$|total$/.test(lowerKey);
}

/** Até 6 chaves ESCALARES de 1º nível, campos conhecidos (status/mensagem/
 *  contagens) primeiro; vazio = sem resumo (só o details com o JSON cru). */
function previewSummaryRows(data: unknown): [string, string][] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return [];
  const entries = Object.entries(data as Record<string, unknown>).filter(
    ([, value]) =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
  );
  const rank = ([key]: [string, unknown]): number => {
    const lower = key.toLowerCase();
    if (lower === 'status') return 0;
    if (lower === 'message' || lower === 'msg') return 1;
    if (isCountKey(lower)) return 2;
    return 3;
  };
  entries.sort((a, b) => rank(a) - rank(b));
  return entries.slice(0, 6).map(([key, value]) => [humanizeKey(key), String(value)]);
}

export function openTshPreviewModal(shadow: ShadowRoot, automation: TshAutomation, data: unknown): void {
  const { body, foot, close } = buildTshModal(shadow, `Prévia — ${automation.label}`, 'eye');

  // P3 (auditoria impeccable): RESUMO legível antes do JSON cru — linhas
  // "label: valor" com known fields primeiro; JSON completo fica num <details>.
  const rows = previewSummaryRows(data);
  if (rows.length > 0) {
    const resumo = document.createElement('div');
    resumo.className = 'tsh-preview-summary';
    for (const [label, value] of rows) {
      const line = document.createElement('div');
      const lab = document.createElement('span');
      lab.className = 'tsh-preview-label';
      lab.textContent = `${label}: `;
      line.appendChild(lab);
      line.appendChild(document.createTextNode(value)); // dado dinâmico — nunca HTML
      resumo.appendChild(line);
    }
    body.appendChild(resumo);
  }

  let texto: string;
  try {
    texto = JSON.stringify(data, null, 2);
  } catch {
    texto = String(data);
  }
  const details = document.createElement('details');
  details.className = 'tsh-preview-details';
  const summary = document.createElement('summary');
  summary.textContent = 'JSON completo';
  const wrap = document.createElement('div');
  wrap.className = 'tsh-preview';
  const pre = document.createElement('pre');
  pre.textContent = texto; // sempre textContent — nunca HTML
  wrap.appendChild(pre);
  details.append(summary, wrap);
  body.appendChild(details);

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'tsh-btn tsh-btn--ghost tsh-foot-left';
  copyBtn.appendChild(icon('copy', 12));
  const copyTxt = document.createElement('span');
  copyTxt.className = 'tsh-btn-txt';
  copyTxt.textContent = 'Copiar';
  copyBtn.appendChild(copyTxt);
  copyBtn.addEventListener('click', () => copyToClipboard(texto, copyBtn, 'Copiar'));

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'tsh-btn tsh-btn--primary';
  closeBtn.appendChild(icon('check', 12));
  closeBtn.appendChild(document.createTextNode('Fechar'));
  closeBtn.addEventListener('click', close);

  foot.append(copyBtn, buttonRow(closeBtn));
}
