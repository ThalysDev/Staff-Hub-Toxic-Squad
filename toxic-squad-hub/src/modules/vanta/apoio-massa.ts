// Distribuidor de Apoios — launcher `vanta-apoiomassa` (aba NATIVA "Apoio em
// massa", `place&mode=call`). REBUILD da Onda 2: o produto antigo (cálculo por
// tempo/aflição + water-fill) virou o launcher do fluxo novo do Hub, com as
// engines vendadas em `src/ext`:
//
// - `support-line-codec`: o TEXTO dos apoios é o contrato (linhas
//   `x|y u1..u10 [i]DD/MM-HH:MM:SS:mmm [DD/MM-HH:MM:SS:mmm]`);
// - `support-distributor`: quem manda o quê (modos minimo/maximo/pacotes,
//   preferência por distância, guardas, reserva e espaçamento de ms);
// - `modules/tsh/tsh-groups`: grupos do jogo (select + botão recarregar);
// - `modules/tsh/tsh-game-data`: velocidades do mundo/unidades (viagem);
// - Agendador do Hub (`tsh-auto:<mundo>:command-scheduler:scheduler`): leitura
//   dos apoios VIVOS para a conta de tropas comprometidas e escrita dos
//   registros do modo Cravado (`kind: 'support'`).
//
// Decisões que o código não explica sozinho:
// - O painel entra ANTES do "Apoio chegando" da aba; sem esse marcador, cai
//   para depois do h3 "Enviar apoio em massa" e, por fim, antes do formulário
//   que contém `#village_troup_list` (as três âncoras da mesma tela, porque o
//   jogo troca ids/textos entre versões).
// - Execução IMEDIATA é 1 comando por clique: preencher a tabela nativa, mirar
//   o alvo e clicar "Enviar apoio" — o formulário NAVEGA, então o plano é
//   persistido em GM antes do clique (progresso "2/7" sobrevive ao reload).
// - Execução CRAVADA não envia nada: cria os registros do Agendador (id
//   canônico `cid_<fnv1a64>`, dedupe por id) e o motor do Hub dispara.
// - `hasPaladin` é best-effort (coluna `knight > 0` da tabela nativa);
//   `underAttack` é SEMPRE false — esta tela não expõe aldeias atacadas, então
//   a flag "apoiar com aldeias atacadas" não filtra nada (documentado na UI).
// - Zero innerHTML com dado dinâmico: o casco do painel é estático e tudo que
//   vem do jogo/usuário entra por textContent (a única exceção é o texto das
//   linhas do textarea, valor de input — nunca HTML).

import { registerVanta } from './vanta-registry';
import { ensureVantaStyles } from './vanta-styles';
import type { ModuleScope } from './vanta-lifecycle';
import { gm } from '../../core/storage';
import { pageWindow } from '../../core/page';
import { currentVillageId } from './vanta-net';
import { vantaConfirm } from './cancelamento-bloco';
import { parsePtBrInt } from './vanta-utils';
import { unitIcon, UNIT_LABELS } from '../tsh/tsh-units';
import { getGroupOptions, getGroupVillages } from '../tsh/tsh-groups';
import { unitSpeedsMinutesPerField, worldSpeeds } from '../tsh/tsh-game-data';
import {
  SUPPORT_LINE_UNITS,
  formatSupportLine,
  parseSupportLines,
  type SupportLine,
} from '../../ext/modules/features/mass-support/support-line-codec';
import { distributeSupport, type DistributorInput } from '../../ext/modules/features/mass-support/support-distributor';
import {
  TROOP_UNITS,
  TROOP_UNIT_LABELS,
  SCHEDULE_MIN_LEAD_MS,
  buildDistributorInput,
  buildRun,
  buildSchedulerSupportRecords,
  buildForumTable,
  formatReferenceMs,
  formatUnitsSummary,
  fromDatetimeLocalValue,
  liveScheduledRecords,
  localReferenceMs,
  nextPendingIndex,
  normalizeDistributorSettings,
  parsePastedTimeMs,
  referenceMsFromServerClock,
  scheduledCommittedUnits,
  scheduledUnitsByVillage,
  sumLineUnits,
  sumNativeTroopRows,
  toDatetimeLocalValue,
  unmetToPreview,
  zeroTroops,
  type DistributorSettings,
  type SchedulerSupportDraft,
  type SupportRun,
} from './apoio-massa-logic';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

const MODULE_ID = 'vanta-apoiomassa';
const UI_ID = 'vanta-apoiomassa-ui';

/** Chaves de persistência (gm, JSON). */
const K = {
  settings: 'tsh-vanta:apoio-massa:settings',
  plan: 'tsh-vanta:apoio-massa:plan',
  group: 'tsh-vanta:apoio-massa:group',
  lines: 'tsh-vanta:apoio-massa:lines',
  collapsed: 'tsh-vanta:apoio-massa:collapsed',
};

/** Mundo do runtime (`game_data.world`; fallback do hostname) — chave do Agendador. */
function worldName(): string {
  const world = pageWindow().game_data?.world;
  if (typeof world === 'string' && world !== '') return world;
  return window.location.hostname.split('.')[0] ?? '';
}

const schedulerKey = (): string => `tsh-auto:${worldName()}:command-scheduler:scheduler`;

/** Velocidades clássicas (mundo velocidade 1) — fallback se o get_unit_info falhar. */
const FALLBACK_UNIT_SPEEDS: Readonly<Record<string, number>> = Object.freeze({
  spear: 18,
  sword: 22,
  axe: 18,
  archer: 18,
  spy: 9,
  light: 10,
  marcher: 10,
  heavy: 11,
  ram: 30,
  catapult: 30,
  knight: 10,
  snob: 35,
});

interface Coord {
  x: number;
  y: number;
}

type StatusKind = 'info' | 'ok' | 'warn';

/** Chaves booleanas do `DistributorSettings` (os 5 checkboxes do popup Avançado). */
type BooleanSettingKey =
  | 'includeSlowerUnits'
  | 'skipVillagesWithPaladin'
  | 'ignoreScheduled'
  | 'allowAttackedVillages'
  | 'avoidMsConflicts';

// ── Estado por mount (o painel é remontado inteiro: nada global) ───────────

interface NativeRow {
  tr: HTMLTableRowElement;
  villageId: number;
  coord: Coord | null;
  units: Record<string, number>;
  checkbox: HTMLInputElement | null;
}

/** Plano persistido: a fila sobrevive ao reload que cada envio provoca. */
interface StoredPlan {
  run: SupportRun;
  unmet: string[];
  warnings: string[];
  mode: 'imediato' | 'cravado';
}

const COORD_RE = /^(\d{1,3})\s*[|,;\s]\s*(\d{1,3})$/;
const COORD_TEXT_RE = /\((\d{1,3})\|(\d{1,3})\)/;

function parseCoordLine(raw: string): Coord | null {
  const match = COORD_RE.exec(raw.trim());
  if (match === null) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x > 999 || y > 999) return null;
  return { x, y };
}

const coordLabel = (coord: Coord): string => `${coord.x}|${coord.y}`;

/** setTimeout rastreado que não explode quando o escopo já foi descartado. */
function wait(scope: ModuleScope, ms: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      scope.after(resolve, ms);
    } catch {
      resolve();
    }
  });
}

function readSettings(): DistributorSettings {
  return normalizeDistributorSettings(gm.get<unknown>(K.settings, null));
}

function readPlan(): StoredPlan | null {
  const raw = gm.get<unknown>(K.plan, null);
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as { run?: unknown; unmet?: unknown; warnings?: unknown; mode?: unknown };
  const run = value.run as SupportRun | undefined;
  if (run === undefined || !Array.isArray(run.entries)) return null;
  const entries = run.entries.filter(
    (entry) => typeof entry === 'object' && entry !== null && typeof entry.originVillageId === 'number',
  );
  return {
    run: { createdAtMs: Number(run.createdAtMs) || 0, entries },
    unmet: Array.isArray(value.unmet) ? value.unmet.map(String) : [],
    warnings: Array.isArray(value.warnings) ? value.warnings.map(String) : [],
    mode: value.mode === 'cravado' ? 'cravado' : 'imediato',
  };
}

/** Leitura defensiva do estado cru do Agendador (mesma chave do motor). */
function readSchedulerState(): unknown {
  return gm.get<unknown>(schedulerKey(), {});
}

// ── Tabela NATIVA de tropas (place&mode=call) ───────────────────────────────

function nativeTable(): HTMLTableElement | null {
  const table = document.getElementById('village_troup_list');
  return table instanceof HTMLTableElement ? table : null;
}

/** Id de aldeia da linha: link `village=nNNN` (o jogo prefixa "n"). */
function rowVillageId(tr: HTMLTableRowElement): number {
  const link = tr.querySelector<HTMLAnchorElement>('a[href*="village="]');
  const match = /[?&]village=n?(\d+)/.exec(link?.getAttribute('href') ?? '');
  const id = match?.[1];
  return id === undefined ? 0 : Number(id);
}

/** Coordenada da linha pelo texto do link "(x|y)"; fallback: qualquer "(x|y)" da linha. */
function rowCoord(tr: HTMLTableRowElement): Coord | null {
  const link = tr.querySelector<HTMLAnchorElement>('td:first-child a') ?? tr.querySelector('a');
  const fromLink = COORD_TEXT_RE.exec(link?.textContent ?? '');
  const fromRow = fromLink ?? COORD_TEXT_RE.exec(tr.textContent ?? '');
  if (fromRow === null) return null;
  return { x: Number(fromRow[1]), y: Number(fromRow[2]) };
}

/**
 * Tropas da linha: células `td[data-unit]` com `data-count` (âncora canônica do
 * jogo). Sem nenhuma célula assim, cai para os inputs de unidade da própria
 * linha (`name="call[<id>][<unit>]"`) — valor (ou max) do input.
 */
function rowUnits(tr: HTMLTableRowElement): Record<string, number> {
  const units = zeroTroops();
  const cells = tr.querySelectorAll<HTMLElement>('td[data-unit]');
  if (cells.length > 0) {
    cells.forEach((cell) => {
      const unit = cell.getAttribute('data-unit') ?? '';
      if (!TROOP_UNITS.includes(unit)) return;
      units[unit] = parsePtBrInt(cell.getAttribute('data-count') ?? cell.textContent);
    });
    return units;
  }
  tr.querySelectorAll<HTMLInputElement>('input[name]').forEach((input) => {
    const match = /\[([a-z_]+)\]$/.exec(input.name);
    const unit = match?.[1] ?? '';
    if (!TROOP_UNITS.includes(unit)) return;
    units[unit] = parsePtBrInt(input.value === '' ? input.max : input.value);
  });
  return units;
}

function readNativeRows(): NativeRow[] {
  const table = nativeTable();
  if (table === null) return [];
  const rows: NativeRow[] = [];
  table.querySelectorAll<HTMLTableRowElement>('tr.call-village').forEach((tr) => {
    rows.push({
      tr,
      villageId: rowVillageId(tr),
      coord: rowCoord(tr),
      units: rowUnits(tr),
      checkbox: tr.querySelector<HTMLInputElement>('input[type="checkbox"]'),
    });
  });
  return rows;
}

/** Assinatura barata das linhas: o painel só redesenha os totais quando muda. */
function rowsSignature(rows: readonly NativeRow[]): string {
  return rows
    .map((row) => `${row.villageId}:${row.coord === null ? '' : coordLabel(row.coord)}:${TROOP_UNITS.map((unit) => row.units[unit] ?? 0).join(',')}`)
    .join(';');
}

function sumTroops(...lists: Readonly<Record<string, number>>[]): Record<string, number> {
  const totals = zeroTroops();
  for (const list of lists) {
    for (const unit of TROOP_UNITS) totals[unit] = (totals[unit] ?? 0) + (list[unit] ?? 0);
  }
  return totals;
}

// ── Modal Vanta (padrão da suíte: overlay + pergaminho, Promise-free) ───────

interface ModalOptions {
  title: string;
  body: HTMLElement;
  confirmLabel: string;
  /** Devolve false para manter o modal aberto (validação falhou). */
  onConfirm: () => boolean;
  danger?: boolean;
}

function openModal(scope: ModuleScope, opts: ModalOptions): void {
  const overlay = document.createElement('div');
  overlay.className = 'vanta-am-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const modal = document.createElement('div');
  modal.className = 'vanta-am-modal';

  const head = document.createElement('div');
  head.className = 'vanta-am-modal-head';
  const title = document.createElement('span');
  title.className = 'vanta-am-modal-title';
  title.textContent = opts.title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'vanta-am-modal-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Fechar');
  head.append(title, close);

  const body = document.createElement('div');
  body.className = 'vanta-am-modal-body';
  body.appendChild(opts.body);

  const foot = document.createElement('div');
  foot.className = 'vanta-am-modal-foot';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'vanta-am-btn';
  cancel.textContent = 'Cancelar';
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = opts.danger === true ? 'vanta-am-btn vanta-am-btn--danger' : 'vanta-am-btn vanta-am-btn--primary';
  confirm.textContent = opts.confirmLabel;
  foot.append(cancel, confirm);

  modal.append(head, body, foot);
  overlay.appendChild(modal);

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') dismiss();
  };
  const dismiss = (): void => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };

  close.addEventListener('click', dismiss);
  cancel.addEventListener('click', dismiss);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) dismiss();
  });
  confirm.addEventListener('click', () => {
    if (opts.onConfirm()) dismiss();
  });
  document.addEventListener('keydown', onKey);
  scope.owns(overlay);
  document.body.appendChild(overlay);
  confirm.focus();
}

/** Campo rotulado dos modais (label + controle + ajuda opcional). */
function field(label: string, control: HTMLElement, help?: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'vanta-am-field';
  const labelEl = document.createElement('span');
  labelEl.className = 'vanta-am-field-label';
  labelEl.textContent = label;
  wrap.append(labelEl, control);
  if (help !== undefined) {
    const helpEl = document.createElement('span');
    helpEl.className = 'vanta-am-field-help';
    helpEl.textContent = help;
    wrap.appendChild(helpEl);
  }
  return wrap;
}

function numberInput(unit: string, value: number): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = '1';
  input.value = String(value);
  input.dataset['unit'] = unit;
  input.className = 'vanta-am-unit-input';
  return input;
}

/**
 * Popup das 10 unidades (usado por "Selecionar unidades" e por "Reservar
 * tropas"): grids com ícone + rótulo + input, tudo por createElement.
 */
function openUnitsModal(
  scope: ModuleScope,
  title: string,
  initial: Readonly<Record<string, number>>,
  onSave: (units: Record<string, number>) => void,
): void {
  const body = document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'vanta-am-unit-grid';
  const inputs: HTMLInputElement[] = [];
  for (const unit of SUPPORT_LINE_UNITS) {
    const cell = document.createElement('div');
    cell.className = 'vanta-am-unit-cell';
    cell.appendChild(unitIcon(unit, 18));
    const name = document.createElement('span');
    name.className = 'vanta-am-unit-name';
    name.textContent = TROOP_UNIT_LABELS[unit] ?? UNIT_LABELS[unit] ?? unit;
    const input = numberInput(unit, Math.max(0, Math.floor(initial[unit] ?? 0)));
    inputs.push(input);
    cell.append(name, input);
    grid.appendChild(cell);
  }
  const total = document.createElement('div');
  total.className = 'vanta-am-field-help';
  const updateTotal = (): void => {
    const units: Record<string, number> = {};
    let sum = 0;
    for (const input of inputs) {
      const value = Math.max(0, Math.floor(Number(input.value) || 0));
      units[input.dataset['unit'] ?? ''] = value;
      sum += value;
    }
    total.textContent = `${sum} tropa(s) selecionada(s).`;
  };
  inputs.forEach((input) => {
    input.addEventListener('input', updateTotal);
  });
  updateTotal();
  body.append(grid, total);

  openModal(scope, {
    title,
    body,
    confirmLabel: 'Salvar',
    onConfirm: () => {
      const units: Record<string, number> = {};
      for (const input of inputs) {
        units[input.dataset['unit'] ?? ''] = Math.max(0, Math.floor(Number(input.value) || 0));
      }
      onSave(units);
      return true;
    },
  });
}

// ── Envio imediato pela tabela nativa ─────────────────────────────────────

/** Garante o alvo selecionado no formulário nativo (autocomplete do jogo). */
async function ensureNativeTarget(scope: ModuleScope, target: Coord): Promise<boolean> {
  const container = document.getElementById('place_target');
  if (container === null) return false;
  const label = coordLabel(target);
  const existing = container.querySelector<HTMLElement>('.village-item');
  if (existing !== null) {
    if ((existing.textContent ?? '').includes(`(${label})`)) return true;
    existing.remove();
  }
  const input = container.querySelector<HTMLInputElement>('input.target-input-field');
  if (input === null) return false;
  input.style.display = '';
  input.focus();
  input.value = label;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const keyInit = { key: 'Enter', keyCode: 13, bubbles: true } as KeyboardEventInit;
  input.dispatchEvent(new KeyboardEvent('keydown', keyInit));
  input.dispatchEvent(new KeyboardEvent('keypress', keyInit));
  input.dispatchEvent(new KeyboardEvent('keyup', keyInit));

  // O autocomplete é assíncrono: espera o .village-item nascer (6s no pior caso).
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(scope, 100);
    const item = container.querySelector<HTMLElement>('.village-item');
    if (item === null) continue;
    item.click();
    return true;
  }
  return false;
}

/** Botão "Enviar apoio" do formulário nativo (id canônico + fallback textual). */
function findNativeSubmit(): HTMLElement | null {
  const direct = document.getElementById('place_call_form_submit');
  if (direct instanceof HTMLElement) return direct;
  const form = nativeTable()?.closest('form') ?? null;
  if (form === null) return null;
  const candidates = form.querySelectorAll<HTMLElement>('input[type="submit"], button[type="submit"], button');
  for (const candidate of candidates) {
    const label = candidate instanceof HTMLInputElement ? candidate.value : (candidate.textContent ?? '');
    if (/enviar\s*apoio|enviar tropa/i.test(label)) return candidate;
  }
  return null;
}

/**
 * Preenche a tabela nativa com UM assignment e clica "Enviar apoio". Devolve a
 * mensagem de erro (string vazia = seguiu para o envio) — em erro NADA é
 * marcado como enviado, então o operador pode corrigir e repetir o clique.
 */
async function sendImmediateEntry(
  scope: ModuleScope,
  plan: StoredPlan,
  index: number,
  onBeforeSubmit: () => void,
): Promise<string> {
  const entry = plan.run.entries[index];
  if (entry === undefined) return 'Entrada inexistente no plano.';
  const targetOk = await ensureNativeTarget(scope, entry.target);
  if (!targetOk) {
    return `Não consegui selecionar o alvo ${coordLabel(entry.target)} no formulário do jogo — selecione o alvo e tente de novo.`;
  }
  const row = readNativeRows().find((candidate) => candidate.villageId === entry.originVillageId);
  if (row === undefined) {
    return `A aldeia ${entry.originVillageId} não está na tabela nativa (ajuste o grupo/página do jogo e recalcule).`;
  }
  if (row.checkbox === null) return 'A linha da aldeia de origem não expõe o checkbox do jogo.';
  if (!row.checkbox.checked) {
    row.checkbox.click();
    // Um tick para o jogo habilitar os inputs da linha.
    await wait(scope, 150);
  }
  let filled = 0;
  for (const unit of SUPPORT_LINE_UNITS) {
    const amount = Math.max(0, Math.floor(entry.units[unit] ?? 0));
    const input = row.tr.querySelector<HTMLInputElement>(`input[name$="][${unit}]"]`);
    if (input === null) continue;
    input.value = String(amount);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (amount > 0) filled += 1;
  }
  if (filled === 0) return 'Nenhuma unidade foi preenchida na linha nativa — nada foi enviado.';
  const submit = findNativeSubmit();
  if (submit === null) {
    return 'Botão "Enviar apoio" do jogo não encontrado — a tabela já está preenchida, envie manualmente.';
  }
  // Pausa pedida pela spec entre o preenchimento e o clique de envio.
  await wait(scope, 300);
  // Marca ANTES do clique: o submit navega e o remount não pode reenviar.
  onBeforeSubmit();
  submit.click();
  return '';
}

// ── Registros do Agendador (modo Cravado) ─────────────────────────────────

/** Anexa registros ao estado do motor, pulando ids já presentes (idempotente). */
function appendSchedulerRecords(drafts: readonly SchedulerSupportDraft[]): number {
  const raw = readSchedulerState();
  const state = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const commands = Array.isArray(state['commands']) ? (state['commands'] as unknown[]) : [];
  const known = new Set<string>();
  for (const command of commands) {
    if (typeof command === 'object' && command !== null) {
      const id = (command as { id?: unknown }).id;
      if (typeof id === 'string') known.add(id);
    }
  }
  const fresh = drafts.filter((draft) => !known.has(draft.id));
  if (fresh.length === 0) return 0;
  gm.set(schedulerKey(), {
    ...state,
    commands: [...commands, ...fresh],
    transit: Array.isArray(state['transit']) ? state['transit'] : [],
  });
  return fresh.length;
}

// ── Estilos do painel (locais: o launcher não mexe nos estilos da suíte) ───

const PANEL_STYLES = `
  #${UI_ID} {
    margin: 10px 0 16px; background: #fffdf3; border: 1px solid #e0cda0;
    border-radius: 10px; font-family: 'Segoe UI', Arial, sans-serif;
    font-size: 11.5px; color: #3c250a; overflow: hidden;
  }
  #${UI_ID} * { box-sizing: border-box; }
  #vanta-am-head {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 14px; background: #efe2ba; border-bottom: 1px solid #e0cda0;
  }
  #vanta-am-title {
    font-size: 12px; font-weight: 700; letter-spacing: 2px;
    color: #3c250a; text-transform: uppercase;
  }
  #vanta-am-status { margin-left: auto; color: #6f5e40; max-width: 60%; }
  #vanta-am-status.vanta-am-warn { color: #c04038; }
  #vanta-am-status.vanta-am-ok { color: #3f8f43; }
  #vanta-am-collapse {
    background: none; border: 1px solid #cbb384; border-radius: 8px;
    color: #6f5e40; cursor: pointer; font-size: 11px; padding: 2px 7px;
  }
  #vanta-am-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
  #vanta-am-body[hidden] { display: none; }
  .vanta-am-section {
    border: 1px solid #e0cda0; border-radius: 8px; background: #fdf8e6;
    padding: 8px 10px; display: flex; flex-direction: column; gap: 8px;
  }
  .vanta-am-section-title {
    font-size: 10px; font-weight: 700; letter-spacing: 1px;
    text-transform: uppercase; color: #8a5a1e;
  }
  .vanta-am-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .vanta-am-row label { display: flex; align-items: center; gap: 4px; color: #5a3a16; }
  .vanta-am-btn {
    padding: 5px 12px; border-radius: 8px; cursor: pointer;
    border: 1px solid #cbb384; background: #fbf4de; color: #5a3a16;
    font-size: 11.5px; font-weight: 600; font-family: inherit;
  }
  .vanta-am-btn:hover:not(:disabled) { background: #efe2ba; border-color: #834a1a; color: #834a1a; }
  .vanta-am-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .vanta-am-btn--primary { background: #6d3c14; border-color: #5a3110; color: #fff; }
  .vanta-am-btn--primary:hover:not(:disabled) { background: #834a1a; color: #fff; }
  .vanta-am-btn--danger { background: #fceaea; border-color: #c04038; color: #c04038; }
  .vanta-am-btn--ok { background: #e8f4e2; border-color: #3f8f43; color: #2e5b2a; }
  .vanta-am-btn--err { background: #fceaea; border-color: #c04038; color: #c04038; }
  #vanta-am-group {
    flex: 1; min-width: 0; max-width: 320px; padding: 4px 8px;
    border-radius: 8px; background: #fbf4de; border: 1px solid #cbb384;
    color: #3c250a; font-size: 12px; font-family: inherit;
  }
  #vanta-am-lines {
    width: 100%; min-height: 84px; resize: vertical; padding: 6px 8px;
    background: #fbf4de; border: 1px solid #cbb384; border-radius: 8px;
    color: #3c250a; font-family: Consolas, monospace; font-size: 11.5px;
  }
  #vanta-am-lines:focus { outline: none; border-color: #8a5a1e; }
  #vanta-am-lines-status { color: #6f5e40; }
  #vanta-am-lines-status.vanta-am-warn { color: #c04038; }
  #vanta-am-lines-errors { color: #c04038; display: flex; flex-direction: column; gap: 2px; }
  .vanta-am-troop-table { border-collapse: collapse; width: 100%; font-size: 11px; }
  .vanta-am-troop-table th, .vanta-am-troop-table td {
    padding: 3px 4px; text-align: center; border: 1px solid #e0cda0;
    color: #5a3a16; white-space: nowrap;
  }
  .vanta-am-troop-table thead th { background: #efe2ba; }
  .vanta-am-troop-table th.vanta-am-rowlabel, .vanta-am-troop-table td.vanta-am-rowlabel {
    text-align: left; color: #6f5e40; font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.6px; white-space: nowrap; min-width: 132px;
  }
  .vanta-am-troop-table td.vanta-am-zero { color: #b3a27d; }
  .vanta-am-troop-table tbody { background: #fffdf3; }
  .vanta-am-preview-table { border-collapse: collapse; width: 100%; font-size: 11px; }
  .vanta-am-preview-table th, .vanta-am-preview-table td {
    padding: 3px 6px; border: 1px solid #e0cda0; color: #5a3a16; text-align: left;
  }
  .vanta-am-preview-table thead th { background: #efe2ba; color: #6f5e40; }
  .vanta-am-preview-table tr.vanta-am-done td { color: #3f8f43; }
  .vanta-am-warn-list { color: #c04038; margin: 0; padding-left: 16px; }
  .vanta-am-note { color: #6f5e40; font-size: 10.5px; }
  .vanta-am-overlay {
    position: fixed; inset: 0; z-index: 100000;
    display: flex; align-items: center; justify-content: center;
    background: rgba(60, 37, 10, 0.45);
  }
  .vanta-am-modal {
    width: min(560px, calc(100vw - 32px)); max-height: 85vh;
    display: flex; flex-direction: column; background: #fffdf3;
    border: 1px solid #cbb384; border-radius: 12px; color: #5a3a16;
    box-shadow: 0 16px 48px rgba(60, 37, 10, 0.35);
    font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px;
  }
  .vanta-am-modal-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 9px 14px; background: #efe2ba; border-bottom: 1px solid #e0cda0;
    border-radius: 12px 12px 0 0;
  }
  .vanta-am-modal-title {
    font-size: 12px; font-weight: 700; letter-spacing: 1px;
    text-transform: uppercase; color: #8a5a1e;
  }
  .vanta-am-modal-close {
    background: none; border: none; color: #6f5e40; font-size: 15px;
    line-height: 1; cursor: pointer; padding: 0 2px;
  }
  .vanta-am-modal-close:hover { color: #c04038; }
  .vanta-am-modal-body { padding: 12px 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
  .vanta-am-modal-foot {
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 10px 14px; border-top: 1px solid #e0cda0;
  }
  .vanta-am-field { display: flex; flex-direction: column; gap: 4px; }
  .vanta-am-field-label {
    font-size: 10px; color: #6f5e40; text-transform: uppercase; letter-spacing: 0.8px;
  }
  .vanta-am-field-help { font-size: 10px; color: #6f5e40; }
  .vanta-am-field textarea, .vanta-am-field input[type="datetime-local"], .vanta-am-field input[type="number"], .vanta-am-field select {
    padding: 4px 8px; border-radius: 8px; background: #fbf4de;
    border: 1px solid #cbb384; color: #3c250a; font-size: 12px; font-family: inherit;
  }
  .vanta-am-field textarea { font-family: Consolas, monospace; min-height: 64px; resize: vertical; }
  .vanta-am-unit-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 6px;
  }
  .vanta-am-unit-cell { display: flex; align-items: center; gap: 5px; }
  .vanta-am-unit-name { flex: 1; color: #5a3a16; font-size: 11px; }
  .vanta-am-unit-input { width: 62px; text-align: center; background: #fbf4de; border: 1px solid #cbb384; border-radius: 8px; color: #3c250a; font-size: 11px; padding: 2px 4px; }
  .vanta-am-check { display: flex; align-items: center; gap: 6px; color: #5a3a16; }
  .vanta-am-check input { accent-color: #6d3c14; }
`;

// ── Registro do launcher ───────────────────────────────────────────────────

registerVanta({
  id: MODULE_ID,
  label: 'Distribuidor de Apoios',
  desc: 'Totais da conta, linhas de apoio em texto, distribuição por grupos e envio imediato/cravado na aba Apoio em massa',
  group: 'blindagem',
  match: () => params().get('screen') === 'place' && params().get('mode') === 'call',
  url: () => {
    const villageId = currentVillageId();
    return `/game.php?village=${villageId}&screen=place&mode=call`;
  },
  mount(scope: ModuleScope) {
    ensureVantaStyles();
    if (params().get('screen') !== 'place' || params().get('mode') !== 'call') return;
    if (document.getElementById(UI_ID) !== null) return; // guard de idempotência

    // ── Estado do painel ──
    let settings = readSettings();
    let groupVillageIds: Set<number> | null = null;
    let lastRowsSignature = '';
    let parsedLines: SupportLine[] = [];
    let parsedErrors: { raw: string; error: string }[] = [];
    let busy = false;

    const referenceNowMs = (): number =>
      referenceMsFromServerClock(
        document.getElementById('serverDate')?.textContent ?? '',
        document.getElementById('serverTime')?.textContent ?? '',
        localReferenceMs(),
      );

    // ── Casco (estático: nenhum dado dinâmico em innerHTML) ──
    const panel = document.createElement('div');
    panel.id = UI_ID;
    panel.innerHTML = `
        <style>${PANEL_STYLES}</style>
        <div id="vanta-am-head">
            <span id="vanta-am-title">⚔ Distribuidor de Apoios</span>
            <span id="vanta-am-status"></span>
            <button type="button" id="vanta-am-collapse" title="Recolher/expandir">▾</button>
        </div>
        <div id="vanta-am-body">
            <div class="vanta-am-section">
                <div class="vanta-am-section-title">Totais da conta</div>
                <div id="vanta-am-totals"></div>
                <div class="vanta-am-note" id="vanta-am-totals-note"></div>
            </div>
            <div class="vanta-am-row">
                <span class="vanta-am-field-label">Grupo de envio</span>
                <select id="vanta-am-group"><option value="0">Todas as aldeias</option></select>
                <button type="button" id="vanta-am-group-reload" class="vanta-am-btn" title="Reler grupos e aldeias do jogo">↻ Recarregar</button>
            </div>
            <div class="vanta-am-section">
                <div class="vanta-am-section-title">Apoios a enviar</div>
                <textarea id="vanta-am-lines" spellcheck="false"
                    placeholder="555|444 100/50/0/0/0/20/0/0/0/0&#10;555|445 0/0/0/0/0/0/0/0/0/0 i24/09-21:00:00:000 24/09-21:30:00:500"></textarea>
                <div id="vanta-am-lines-status"></div>
                <div id="vanta-am-lines-errors"></div>
                <div class="vanta-am-row">
                    <button type="button" id="vanta-am-forum" class="vanta-am-btn">Converter para fórum</button>
                    <button type="button" id="vanta-am-coords" class="vanta-am-btn">Inserir por coordenadas</button>
                </div>
            </div>
            <div class="vanta-am-row">
                <label><input type="radio" name="vanta-am-mode" value="imediato" checked> Imediato</label>
                <label><input type="radio" name="vanta-am-mode" value="cravado"> Cravado (agendar)</label>
                <button type="button" id="vanta-am-advanced" class="vanta-am-btn">Avançado</button>
                <span id="vanta-am-settings-summary" class="vanta-am-note"></span>
            </div>
            <div class="vanta-am-row">
                <button type="button" id="vanta-am-calc" class="vanta-am-btn vanta-am-btn--primary">Calcular distribuição</button>
                <button type="button" id="vanta-am-exec" class="vanta-am-btn">Executar</button>
                <button type="button" id="vanta-am-clear" class="vanta-am-btn">Limpar plano</button>
                <span id="vanta-am-progress" class="vanta-am-note"></span>
            </div>
            <div id="vanta-am-preview"></div>
        </div>
    `;
    scope.owns(panel);

    const $ = <T extends HTMLElement>(id: string): T | null => panel.querySelector<T>(`#${id}`);
    const statusEl = $<HTMLElement>('vanta-am-status');
    const bodyEl = $<HTMLElement>('vanta-am-body');
    const totalsEl = $<HTMLElement>('vanta-am-totals');
    const totalsNote = $<HTMLElement>('vanta-am-totals-note');
    const linesEl = $<HTMLTextAreaElement>('vanta-am-lines');
    const linesStatus = $<HTMLElement>('vanta-am-lines-status');
    const linesErrors = $<HTMLElement>('vanta-am-lines-errors');
    const groupSelect = $<HTMLSelectElement>('vanta-am-group');
    const previewEl = $<HTMLElement>('vanta-am-preview');
    const progressEl = $<HTMLElement>('vanta-am-progress');
    const settingsSummary = $<HTMLElement>('vanta-am-settings-summary');
    const execBtn = $<HTMLButtonElement>('vanta-am-exec');

    function setStatus(message: string, kind: StatusKind = 'info'): void {
      if (statusEl === null) return;
      statusEl.textContent = message;
      statusEl.classList.toggle('vanta-am-warn', kind === 'warn');
      statusEl.classList.toggle('vanta-am-ok', kind === 'ok');
    }

    // ── Totais ──
    function buildTroopTable(label: string, values: Readonly<Record<string, number>>): HTMLTableElement {
      const table = document.createElement('table');
      table.className = 'vanta-am-troop-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      const labelTh = document.createElement('th');
      labelTh.className = 'vanta-am-rowlabel';
      labelTh.textContent = 'Tropas';
      headRow.appendChild(labelTh);
      for (const unit of TROOP_UNITS) {
        const th = document.createElement('th');
        th.title = TROOP_UNIT_LABELS[unit] ?? unit;
        th.appendChild(unitIcon(unit, 16));
        headRow.appendChild(th);
      }
      const totalTh = document.createElement('th');
      totalTh.textContent = 'Σ';
      totalTh.title = 'Soma das unidades';
      headRow.appendChild(totalTh);
      thead.appendChild(headRow);

      const tbody = document.createElement('tbody');
      const row = document.createElement('tr');
      const labelTd = document.createElement('td');
      labelTd.className = 'vanta-am-rowlabel';
      labelTd.textContent = label;
      row.appendChild(labelTd);
      let sum = 0;
      for (const unit of TROOP_UNITS) {
        const value = Math.max(0, Math.floor(values[unit] ?? 0));
        sum += value;
        const td = document.createElement('td');
        if (value === 0) {
          td.className = 'vanta-am-zero';
          td.textContent = '–';
        } else {
          td.textContent = String(value);
        }
        td.title = `${TROOP_UNIT_LABELS[unit] ?? unit}: ${value}`;
        row.appendChild(td);
      }
      const sumTd = document.createElement('td');
      sumTd.textContent = String(sum);
      row.appendChild(sumTd);
      tbody.appendChild(row);

      table.append(thead, tbody);
      return table;
    }

    function refreshTotals(force = false): void {
      if (totalsEl === null) return;
      const rows = readNativeRows();
      const signature = `${rowsSignature(rows)}|${groupVillageIds === null ? 'all' : [...groupVillageIds].sort().join(',')}|${linesEl?.value ?? ''}`;
      if (!force && signature === lastRowsSignature) return;
      lastRowsSignature = signature;

      const eligible = rows.filter((row) => isOriginRow(row));
      const available = sumNativeTroopRows(eligible);
      // Recalcula o texto do textarea aqui: os totais mudam a cada tecla.
      const parsed = parseSupportLines(linesEl?.value ?? '', referenceNowMs());
      parsedLines = parsed.lines;
      parsedErrors = parsed.errors;
      const committedLines = sumLineUnits(parsed.lines);
      const committedScheduled = scheduledCommittedUnits(liveScheduledRecords(readSchedulerState()));
      const committed = sumTroops(committedLines, committedScheduled);

      totalsEl.replaceChildren(
        buildTroopTable('Disponíveis', available),
        buildTroopTable('Comprometidas', committed),
      );
      if (totalsNote !== null) {
        totalsNote.textContent =
          groupVillageIds === null
            ? `${eligible.length} aldeia(s) na tabela nativa · comprometidas = linhas válidas do texto + apoios vivos do Agendador.`
            : `${eligible.length} de ${rows.length} aldeia(s) do grupo selecionado · comprometidas = linhas válidas do texto + apoios vivos do Agendador.`;
      }
    }

    function isOriginRow(row: NativeRow): boolean {
      if (groupVillageIds === null) return true;
      // Sem id lido não dá para provar pertencimento: fica fora do grupo.
      return row.villageId !== 0 && groupVillageIds.has(row.villageId);
    }

    // ── Linhas do textarea ──
    function refreshLines(): void {
      const parsed = parseSupportLines(linesEl?.value ?? '', referenceNowMs());
      parsedLines = parsed.lines;
      parsedErrors = parsed.errors;
      if (linesStatus !== null) {
        linesStatus.textContent =
          `${parsed.lines.length} linha(s) válida(s)` +
          (parsed.errors.length > 0 ? ` · ${parsed.errors.length} com erro` : '') +
          (parsed.lines.length > 0 ? ` · ${formatUnitsSummary(sumLineUnits(parsed.lines))} em tropas` : '');
        linesStatus.classList.toggle('vanta-am-warn', parsed.errors.length > 0);
      }
      if (linesErrors !== null) {
        linesErrors.replaceChildren();
        parsed.errors.slice(0, 6).forEach((entry) => {
          const line = document.createElement('div');
          line.textContent = `"${entry.raw}": ${entry.error}`;
          linesErrors.appendChild(line);
        });
        if (parsed.errors.length > 6) {
          const more = document.createElement('div');
          more.textContent = `… e mais ${parsed.errors.length - 6} linha(s) com erro.`;
          linesErrors.appendChild(more);
        }
      }
    }

    // ── Grupo de envio ──
    function fillGroupOptions(
      groups: readonly { groupId: number; name: string }[],
      saved: string,
    ): void {
      if (groupSelect === null) return;
      groupSelect.replaceChildren();
      const all = document.createElement('option');
      all.value = '0';
      all.textContent = 'Todas as aldeias';
      groupSelect.appendChild(all);
      for (const group of groups) {
        const option = document.createElement('option');
        option.value = String(group.groupId);
        option.textContent = group.name;
        groupSelect.appendChild(option);
      }
      groupSelect.value = groups.some((group) => String(group.groupId) === saved) ? saved : '0';
    }

    async function loadGroups(force: boolean): Promise<void> {
      setStatus(force ? 'Relendo grupos do jogo...' : 'Carregando grupos do jogo...');
      try {
        const groups = await getGroupOptions(force);
        if (groups.length === 0) {
          fillGroupOptions([], '0');
          groupVillageIds = null;
          setStatus('Nenhum grupo lido do jogo — "Recarregar" tenta de novo.', 'warn');
          return;
        }
        fillGroupOptions(groups, gm.get<string>(K.group, '0'));
        setStatus(`${groups.length} grupo(s) do jogo lido(s).`, 'ok');
        await applyGroupFilter(force);
      } catch (error) {
        setStatus(`Falha ao ler os grupos: ${error instanceof Error ? error.message : String(error)}`, 'warn');
      }
    }

    async function applyGroupFilter(force: boolean): Promise<void> {
      const groupId = Number(groupSelect?.value ?? '0');
      if (!Number.isInteger(groupId) || groupId <= 0) {
        groupVillageIds = null;
        refreshTotals(true);
        return;
      }
      setStatus(`Lendo as aldeias do grupo ${groupId}...`);
      try {
        const villages = await getGroupVillages(groupId, force);
        // Leitura vazia pode ser "não lido": avisa e permite repetir em vez de
        // filtrar tudo fora (nenhuma origem sobraria).
        if (villages.length === 0) {
          groupVillageIds = null;
          setStatus(
            `Grupo ${groupId}: nenhuma aldeia lida (pode ser leitura vazia) — sem filtro de origem. Use "Recarregar" para tentar de novo.`,
            'warn',
          );
        } else {
          groupVillageIds = new Set(villages.map((village) => village.villageId));
          setStatus(`Grupo ${groupId}: ${villages.length} aldeia(s) consideradas como origem.`, 'ok');
        }
      } catch (error) {
        groupVillageIds = null;
        setStatus(`Falha ao ler o grupo: ${error instanceof Error ? error.message : String(error)}`, 'warn');
      }
      refreshTotals(true);
    }

    // ── Viagem (função síncrona exigida pela engine) ──
    async function buildTravel(): Promise<{ travel: DistributorInput['travelMinutes']; speeds: Record<string, number> }> {
      const world = await worldSpeeds();
      const raw = await unitSpeedsMinutesPerField();
      const speeds: Record<string, number> = {};
      for (const [unit, value] of Object.entries(raw ?? FALLBACK_UNIT_SPEEDS)) {
        if (Number.isFinite(value) && value > 0) speeds[unit] = value;
      }
      if (raw === null) setStatus('Velocidades das unidades indisponíveis — usando a tabela clássica do jogo.', 'warn');
      let reference = 0;
      for (const unit of TROOP_UNITS) reference = Math.max(reference, speeds[unit] ?? 0);
      // Mesma fórmula do tsh-game-data: dist × min/campo / (velocidade do mundo).
      const divisor = world.speed * world.unitSpeed;
      const travel = (from: Coord, to: Coord): number => {
        if (divisor <= 0 || reference <= 0) return 0;
        return (Math.hypot(to.x - from.x, to.y - from.y) * reference) / divisor;
      };
      return { travel, speeds };
    }

    // ── Plano e prévia ──
    function savePlan(plan: StoredPlan | null): void {
      if (plan === null) gm.remove(K.plan);
      else gm.set(K.plan, plan);
    }

    function refreshProgress(): void {
      const plan = readPlan();
      if (progressEl === null || execBtn === null) return;
      if (plan === null || plan.run.entries.length === 0) {
        progressEl.textContent = 'Sem plano calculado.';
        execBtn.disabled = true;
        execBtn.textContent = 'Executar';
        return;
      }
      const total = plan.run.entries.length;
      const pending = nextPendingIndex(plan.run);
      const done = pending === -1 ? total : pending;
      progressEl.textContent = `${done}/${total} envio(s) concluído(s) · ${plan.mode}`;
      execBtn.disabled = busy || pending === -1;
      execBtn.textContent = pending === -1 ? 'Executar' : `Executar (${pending + 1}/${total})`;
    }

    function renderPreview(): void {
      if (previewEl === null) return;
      previewEl.replaceChildren();
      const plan = readPlan();
      refreshProgress();
      if (plan === null) return;

      const section = document.createElement('div');
      section.className = 'vanta-am-section';
      const title = document.createElement('div');
      title.className = 'vanta-am-section-title';
      title.textContent = `Prévia (${plan.mode})`;
      section.appendChild(title);

      const table = document.createElement('table');
      table.className = 'vanta-am-preview-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const label of ['Origem', 'Destino', 'Unidades', 'Partida', 'Estado']) {
        const th = document.createElement('th');
        th.textContent = label;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      const tbody = document.createElement('tbody');
      plan.run.entries.forEach((entry) => {
        const tr = document.createElement('tr');
        if (entry.sentAtMs !== null) tr.className = 'vanta-am-done';
        const cells = [
          entry.origin === null ? `aldeia ${entry.originVillageId}` : coordLabel(entry.origin),
          coordLabel(entry.target),
          formatUnitsSummary(entry.units),
          entry.departAtMs === null ? 'agora' : formatReferenceMs(entry.departAtMs),
          entry.sentAtMs === null ? 'pendente' : `feito ${formatReferenceMs(entry.sentAtMs)}`,
        ];
        for (const text of cells) {
          const td = document.createElement('td');
          td.textContent = text;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      });
      table.append(thead, tbody);
      section.appendChild(table);

      if (plan.unmet.length > 0) {
        const list = document.createElement('ul');
        list.className = 'vanta-am-warn-list';
        plan.unmet.forEach((text) => {
          const item = document.createElement('li');
          item.textContent = text;
          list.appendChild(item);
        });
        section.appendChild(list);
      }
      if (plan.warnings.length > 0) {
        const list = document.createElement('ul');
        list.className = 'vanta-am-warn-list';
        plan.warnings.forEach((text) => {
          const item = document.createElement('li');
          item.textContent = text;
          list.appendChild(item);
        });
        section.appendChild(list);
      }
      const note = document.createElement('div');
      note.className = 'vanta-am-note';
      note.textContent =
        plan.mode === 'imediato'
          ? 'Imediato: cada clique em Executar envia UM apoio pela tabela nativa (o formulário do jogo navega a cada envio).'
          : `Cravado: os registros são criados no Agendador do Hub e o motor dispara na partida calculada (partidas a menos de ${Math.round(
              SCHEDULE_MIN_LEAD_MS / 1000,
            )}s do agora são recusadas).`;
      section.appendChild(note);
      previewEl.appendChild(section);
    }

    // ── Cálculo ──
    async function calculate(): Promise<void> {
      if (busy) return;
      busy = true;
      if (execBtn !== null) execBtn.disabled = true;
      try {
        refreshLines();
        const rows = readNativeRows().filter((row) => isOriginRow(row));
        if (rows.length === 0) {
          setStatus('Nenhuma aldeia na tabela nativa para usar como origem — ajuste o grupo do jogo.', 'warn');
          return;
        }
        if (parsedLines.length === 0) {
          setStatus('Digite ao menos uma linha de apoio válida (x|y + as 10 unidades).', 'warn');
          return;
        }
        const { travel, speeds } = await buildTravel();
        const referenceMs = referenceNowMs();
        const input = buildDistributorInput({
          rows: rows.map((row) => ({ villageId: row.villageId, coord: row.coord, units: row.units })),
          lines: parsedLines,
          settings,
          scheduledUnitsByVillage: scheduledUnitsByVillage(liveScheduledRecords(readSchedulerState())),
          travelMinutes: travel,
          unitSpeedsMinutesPerField: speeds,
        });
        const result = distributeSupport(input, referenceMs);
        if (result.assignments.length === 0) {
          savePlan(null);
          renderPreview();
          setStatus('Nenhum apoio pôde ser formado com as tropas disponíveis.', 'warn');
          return;
        }
        const plan: StoredPlan = {
          run: buildRun(result, parsedLines, rows, referenceMs),
          unmet: unmetToPreview(result.unmet, parsedLines),
          warnings: [],
          mode: currentMode(),
        };
        savePlan(plan);
        renderPreview();
        const units = Object.values(result.totalAssignedUnits).reduce((sum, value) => sum + value, 0);
        setStatus(
          `${result.assignments.length} apoio(s) planejado(s) · ${units} tropa(s)${result.unmet.length > 0 ? ` · ${result.unmet.length} linha(s) descoberta(s)` : ''}.` +
            (parsedErrors.length > 0 ? ` ${parsedErrors.length} linha(s) com erro foram ignoradas.` : ''),
          result.unmet.length > 0 ? 'warn' : 'ok',
        );
      } catch (error) {
        setStatus(`Falha ao calcular: ${error instanceof Error ? error.message : String(error)}`, 'warn');
      } finally {
        busy = false;
        refreshProgress();
      }
    }

    function currentMode(): 'imediato' | 'cravado' {
      const checked = panel.querySelector<HTMLInputElement>('input[name="vanta-am-mode"]:checked');
      return checked?.value === 'cravado' ? 'cravado' : 'imediato';
    }

    // ── Execução ──
    async function execute(): Promise<void> {
      if (busy) return;
      const plan = readPlan();
      if (plan === null) {
        setStatus('Calcule a distribuição antes de executar.', 'warn');
        return;
      }
      const index = nextPendingIndex(plan.run);
      if (index === -1) {
        setStatus('Todos os envios do plano já foram concluídos.', 'ok');
        return;
      }
      const total = plan.run.entries.length;
      // Um clique por vez: o confirm e o preenchimento nativo são exclusivos.
      busy = true;
      refreshProgress();
      try {
        if (plan.mode === 'cravado') {
          const referenceMs = referenceNowMs();
          const { records, skipped } = buildSchedulerSupportRecords(plan.run, referenceMs);
          if (records.length === 0) {
            const reasons = skipped.map((entry) => entry.reason).join(' ');
            savePlan({ ...plan, warnings: skipped.map((entry) => entry.reason) });
            renderPreview();
            setStatus(`Nada agendado: ${reasons}`, 'warn');
            return;
          }
          const ok = await vantaConfirm(scope, {
            title: 'Distribuidor de Apoios — Cravado',
            message: `Criar ${records.length} registro(s) de apoio no Agendador do Hub?`,
            details: [
              ...records.slice(0, 8).map(
                (record) =>
                  `${record.source.x}|${record.source.y} → ${record.target.x}|${record.target.y} · ${formatUnitsSummary(record.units)}`,
              ),
              ...skipped.slice(0, 6).map((entry) => `Ignorado: ${entry.reason}`),
            ],
            confirmLabel: 'Agendar',
          });
          if (!ok) return;
          const created = appendSchedulerRecords(records);
          const referenceIso = formatReferenceMs(referenceMs);
          const done: SupportRun = {
            ...plan.run,
            entries: plan.run.entries.map((entry) =>
              entry.sentAtMs === null ? { ...entry, sentAtMs: referenceMs } : entry,
            ),
          };
          savePlan({
            ...plan,
            run: done,
            warnings:
              skipped.length > 0
                ? skipped.map((entry) => `${coordLabel(entry.entry.target)}: ${entry.reason}`)
                : [],
          });
          renderPreview();
          setStatus(
            `${created} registro(s) criado(s) no Agendador (partidas a partir de ${referenceIso})` +
              `${records.length - created > 0 ? ` · ${records.length - created} já existia(m)` : ''}` +
              `${skipped.length > 0 ? ` · ${skipped.length} impossível(is), veja a prévia` : ''}.`,
            skipped.length > 0 ? 'warn' : 'ok',
          );
          return;
        }

        const entry = plan.run.entries[index];
        if (entry === undefined) return;
        const ok = await vantaConfirm(scope, {
          title: 'Distribuidor de Apoios — Imediato',
          message: `Enviar o apoio ${index + 1}/${total} agora?`,
          details: [
            `${entry.origin === null ? `aldeia ${entry.originVillageId}` : coordLabel(entry.origin)} → ${coordLabel(entry.target)}`,
            formatUnitsSummary(entry.units),
            'O formulário nativo será preenchido e "Enviar apoio" clicado.',
          ],
          confirmLabel: 'Enviar',
          danger: true,
        });
        if (!ok) return;

        setStatus(`Enviando ${index + 1}/${total}: preenchendo a tabela do jogo...`);
        const message = await sendImmediateEntry(scope, plan, index, () => {
          // Marca a entrada antes do submit (a página navega).
          const advanced: SupportRun = {
            ...plan.run,
            entries: plan.run.entries.map((item, position) =>
              position === index ? { ...item, sentAtMs: referenceNowMs() } : item,
            ),
          };
          savePlan({ ...plan, run: advanced });
        });
        if (message !== '') {
          setStatus(message, 'warn');
          renderPreview();
          return;
        }
        // O clique navega; se a página não saiu, o remount mostra o progresso.
        setStatus(`Apoio ${index + 1}/${total} enviado — o formulário do jogo está processando.`, 'ok');
        renderPreview();
      } catch (error) {
        setStatus(`Falha ao executar: ${error instanceof Error ? error.message : String(error)}`, 'warn');
      } finally {
        busy = false;
        refreshProgress();
      }
    }

    // ── Popup "Avançado" ──
    function openAdvancedModal(): void {
      const body = document.createElement('div');

      const modeSelect = document.createElement('select');
      for (const [value, label] of [
        ['minimo', 'Mínimo por linha (só o que fecha a cota)'],
        ['maximo', 'Máximo por origem (esvazia a aldeia)'],
        ['pacotes', 'Pacotes (a linha inteira sai de uma aldeia)'],
      ] as const) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        modeSelect.appendChild(option);
      }
      modeSelect.value = settings.mode;

      const preferenceSelect = document.createElement('select');
      for (const [value, label] of [
        ['mais_perto', 'Mais perto primeiro'],
        ['mais_longe', 'Mais longe primeiro'],
      ] as const) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        preferenceSelect.appendChild(option);
      }
      preferenceSelect.value = settings.preference;

      const checks: Array<{ key: BooleanSettingKey; label: string; help?: string }> = [
        { key: 'includeSlowerUnits', label: 'Incluir unidades mais lentas para fechar a cota' },
        { key: 'skipVillagesWithPaladin', label: 'Ignorar aldeias com paladino' },
        { key: 'ignoreScheduled', label: 'Ignorar comandos agendados (descontar do disponível)' },
        {
          key: 'allowAttackedVillages',
          label: 'Apoiar com aldeias atacadas',
          help: 'Sem fonte de "aldeia atacada" nesta tela: a flag fica registrada, mas não filtra nada.',
        },
        { key: 'avoidMsConflicts', label: 'Evitar conflitos de milissegundo (espaçar partidas)' },
      ];
      const checkInputs: Array<{ key: BooleanSettingKey; input: HTMLInputElement }> = [];
      const checkWrap = document.createElement('div');
      checkWrap.className = 'vanta-am-section';
      for (const check of checks) {
        const label = document.createElement('label');
        label.className = 'vanta-am-check';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = settings[check.key] === true;
        label.append(input, document.createTextNode(check.label));
        checkWrap.appendChild(label);
        if (check.help !== undefined) {
          const help = document.createElement('div');
          help.className = 'vanta-am-field-help';
          help.textContent = check.help;
          checkWrap.appendChild(help);
        }
        checkInputs.push({ key: check.key, input });
      }

      const reserve = document.createElement('div');
      reserve.className = 'vanta-am-row';
      const reserveSummary = document.createElement('span');
      reserveSummary.className = 'vanta-am-field-help';
      const renderReserve = (units: Readonly<Record<string, number>>): void => {
        reserveSummary.textContent = `Reserva: ${formatUnitsSummary(units)}`;
      };
      renderReserve(settings.reserveUnits);
      const reserveBtn = document.createElement('button');
      reserveBtn.type = 'button';
      reserveBtn.className = 'vanta-am-btn';
      reserveBtn.textContent = 'Reservar tropas';
      reserveBtn.addEventListener('click', () => {
        openUnitsModal(scope, 'Reservar tropas', settings.reserveUnits, (units) => {
          settings = { ...settings, reserveUnits: units };
          renderReserve(units);
        });
      });
      reserve.append(reserveBtn, reserveSummary);

      body.append(
        field('Tipo de distribuição', modeSelect),
        field('Preferência de origem', preferenceSelect),
        checkWrap,
        field('Reservar tropas', reserve, 'Tropas que ficam de fora em TODA aldeia de origem.'),
      );

      openModal(scope, {
        title: 'Distribuidor de Apoios — Avançado',
        body,
        confirmLabel: 'Salvar',
        onConfirm: () => {
          const next: DistributorSettings = normalizeDistributorSettings({
            ...settings,
            mode: modeSelect.value,
            preference: preferenceSelect.value,
            reserveUnits: settings.reserveUnits,
            ...Object.fromEntries(checkInputs.map(({ key, input }) => [key, input.checked])),
          });
          settings = next;
          gm.set(K.settings, next);
          refreshSettingsSummary();
          setStatus('Configuração avançada salva.', 'ok');
          return true;
        },
      });
    }

    function refreshSettingsSummary(): void {
      if (settingsSummary === null) return;
      const modeLabels: Record<string, string> = { minimo: 'mínimo', maximo: 'máximo', pacotes: 'pacotes' };
      const extras: string[] = [];
      if (settings.includeSlowerUnits) extras.push('+lentas');
      if (settings.skipVillagesWithPaladin) extras.push('sem paladino');
      if (settings.ignoreScheduled) extras.push('ignora agendados');
      if (settings.avoidMsConflicts) extras.push('espaça ms');
      settingsSummary.textContent =
        `${modeLabels[settings.mode] ?? settings.mode} · ${settings.preference === 'mais_perto' ? 'mais perto' : 'mais longe'}` +
        (extras.length > 0 ? ` · ${extras.join(' · ')}` : '');
    }

    // ── Popup "Inserir por coordenadas" ──
    function openCoordsModal(): void {
      const body = document.createElement('div');

      const coordsArea = document.createElement('textarea');
      coordsArea.placeholder = '555|444\n555|445';
      coordsArea.spellcheck = false;

      const afterInput = document.createElement('input');
      afterInput.type = 'datetime-local';
      afterInput.step = '1';

      const arrivalInput = document.createElement('input');
      arrivalInput.type = 'datetime-local';
      arrivalInput.step = '1';

      const statusLine = document.createElement('div');
      statusLine.className = 'vanta-am-field-help';

      const unitsSummary = document.createElement('span');
      unitsSummary.className = 'vanta-am-field-help';
      let pickedUnits: Record<string, number> = zeroTroops();
      const renderUnits = (): void => {
        unitsSummary.textContent = `Unidades: ${formatUnitsSummary(pickedUnits)}`;
      };
      renderUnits();

      const paste = (input: HTMLInputElement): void => {
        const read = navigator.clipboard?.readText;
        if (typeof read !== 'function') {
          statusLine.textContent = 'Área de transferência indisponível — cole no campo com Ctrl+V.';
          return;
        }
        void read
          .call(navigator.clipboard)
          .then((text) => {
            const parsed = parsePastedTimeMs(text, referenceNowMs());
            if (parsed === null) {
              statusLine.textContent = `Não entendi "${text.trim().slice(0, 40)}" — use algo como 24/09 21:30:00.`;
              return;
            }
            input.value = toDatetimeLocalValue(parsed);
            statusLine.textContent = `Horário colado: ${formatReferenceMs(parsed)}.`;
          })
          .catch(() => {
            statusLine.textContent = 'Não consegui ler a área de transferência — cole com Ctrl+V.';
          });
      };

      const afterRow = document.createElement('div');
      afterRow.className = 'vanta-am-row';
      const afterPaste = document.createElement('button');
      afterPaste.type = 'button';
      afterPaste.className = 'vanta-am-btn';
      afterPaste.textContent = 'Colar';
      afterPaste.addEventListener('click', () => {
        paste(afterInput);
      });
      afterRow.append(afterInput, afterPaste);

      const arrivalRow = document.createElement('div');
      arrivalRow.className = 'vanta-am-row';
      const arrivalPaste = document.createElement('button');
      arrivalPaste.type = 'button';
      arrivalPaste.className = 'vanta-am-btn';
      arrivalPaste.textContent = 'Colar';
      arrivalPaste.addEventListener('click', () => {
        paste(arrivalInput);
      });
      arrivalRow.append(arrivalInput, arrivalPaste);

      const unitsRow = document.createElement('div');
      unitsRow.className = 'vanta-am-row';
      const unitsBtn = document.createElement('button');
      unitsBtn.type = 'button';
      unitsBtn.className = 'vanta-am-btn';
      unitsBtn.textContent = 'Selecionar unidades';
      unitsBtn.addEventListener('click', () => {
        openUnitsModal(scope, 'Unidades do apoio', pickedUnits, (units) => {
          pickedUnits = units;
          renderUnits();
        });
      });
      unitsRow.append(unitsBtn, unitsSummary);

      const referenceMs = referenceNowMs();
      afterInput.value = toDatetimeLocalValue(referenceMs);

      body.append(
        field('Coordenadas (uma por linha)', coordsArea, 'Aceita x|y, x y, x,y ou x;y — uma coordenada por linha.'),
        field('Chegada após', afterRow, 'Sozinha, marca "chegar não antes de" (janela de instante).'),
        field('Data de chegada', arrivalRow, 'Com "Chegada após", vira a janela i<início> <fim> da linha.'),
        field('Unidades', unitsRow),
        statusLine,
      );

      openModal(scope, {
        title: 'Inserir por coordenadas',
        body,
        confirmLabel: 'Salvar',
        onConfirm: () => {
          const coords: Coord[] = [];
          for (const raw of coordsArea.value.split(/\r?\n/)) {
            const text = raw.trim();
            if (text === '') continue;
            const coord = parseCoordLine(text);
            if (coord === null) {
              statusLine.textContent = `Coordenada inválida: "${text}" — use x|y entre 0|0 e 999|999.`;
              return false;
            }
            coords.push(coord);
          }
          if (coords.length === 0) {
            statusLine.textContent = 'Informe ao menos uma coordenada.';
            return false;
          }
          if (formatUnitsSummary(pickedUnits) === '—') {
            statusLine.textContent = 'Selecione as unidades do apoio ("Selecionar unidades").';
            return false;
          }
          const after = afterInput.value === '' ? null : fromDatetimeLocalValue(afterInput.value);
          const arrival = arrivalInput.value === '' ? null : fromDatetimeLocalValue(arrivalInput.value);
          if (afterInput.value !== '' && after === null) {
            statusLine.textContent = 'A "Chegada após" está ilegível — reescreva no formato do campo.';
            return false;
          }
          if (arrivalInput.value !== '' && arrival === null) {
            statusLine.textContent = 'A "Data de chegada" está ilegível — reescreva no formato do campo.';
            return false;
          }
          if (after !== null && arrival !== null && arrival < after) {
            statusLine.textContent = 'A data de chegada não pode ser antes do início da janela.';
            return false;
          }
          const units = zeroTroops();
          for (const unit of SUPPORT_LINE_UNITS) units[unit] = Math.max(0, Math.floor(pickedUnits[unit] ?? 0));
          const newLines = coords.map((target) =>
            formatSupportLine({
              target,
              units,
              // "Chegada após" sozinha: janela de instante (chegar não antes de).
              earliestArrivalMs: after,
              exactArrivalMs: arrival ?? after,
            }),
          );
          const current = linesEl?.value ?? '';
          if (linesEl !== null) {
            const prefix = current.trim() === '' ? '' : `${current.replace(/\s*$/, '')}\n`;
            linesEl.value = `${prefix}${newLines.join('\n')}`;
            gm.set(K.lines, linesEl.value);
            refreshLines();
            refreshTotals(true);
          }
          setStatus(`${newLines.length} linha(s) inserida(s) no texto de apoios.`, 'ok');
          return true;
        },
      });
    }

    // ── Listeners ──
    const collapseBtn = $<HTMLButtonElement>('vanta-am-collapse');
    if (collapseBtn !== null && bodyEl !== null) {
      const applyCollapsed = (collapsed: boolean): void => {
        bodyEl.hidden = collapsed;
        collapseBtn.textContent = collapsed ? '▸' : '▾';
      };
      applyCollapsed(gm.get<boolean>(K.collapsed, false));
      scope.on(collapseBtn, 'click', () => {
        const next = !bodyEl.hidden;
        gm.set(K.collapsed, next);
        applyCollapsed(next);
      });
    }

    if (linesEl !== null) {
      linesEl.value = gm.get<string>(K.lines, '');
      scope.on(linesEl, 'input', () => {
        gm.set(K.lines, linesEl.value);
        refreshLines();
        refreshTotals(true);
      });
    }

    if (groupSelect !== null) {
      scope.on(groupSelect, 'change', () => {
        gm.set(K.group, groupSelect.value);
        void applyGroupFilter(false);
      });
    }
    const reloadBtn = $<HTMLButtonElement>('vanta-am-group-reload');
    if (reloadBtn !== null) {
      scope.on(reloadBtn, 'click', () => {
        void loadGroups(true);
      });
    }

    const forumBtn = $<HTMLButtonElement>('vanta-am-forum');
    if (forumBtn !== null) {
      scope.on(forumBtn, 'click', () => {
        const table = buildForumTable(parsedLines);
        if (table === '') {
          setStatus('Nenhuma linha válida para converter em tabela do fórum.', 'warn');
          return;
        }
        const done = (ok: boolean): void => {
          forumBtn.textContent = ok ? 'Copiado!' : 'Falha ao copiar';
          forumBtn.classList.toggle('vanta-am-btn--ok', ok);
          forumBtn.classList.toggle('vanta-am-btn--err', !ok);
          setStatus(ok ? 'Tabela BBCode copiada para a área de transferência.' : 'Não consegui copiar — selecione o texto manualmente.', ok ? 'ok' : 'warn');
          scope.after(() => {
            forumBtn.textContent = 'Converter para fórum';
            forumBtn.classList.remove('vanta-am-btn--ok', 'vanta-am-btn--err');
          }, 1800);
        };
        const clipboard = navigator.clipboard;
        if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
          void clipboard
            .writeText(table)
            .then(() => {
              done(true);
            })
            .catch(() => {
              done(copyFallback(table));
            });
          return;
        }
        done(copyFallback(table));
      });
    }

    const coordsBtn = $<HTMLButtonElement>('vanta-am-coords');
    if (coordsBtn !== null) {
      scope.on(coordsBtn, 'click', () => {
        openCoordsModal();
      });
    }

    const advancedBtn = $<HTMLButtonElement>('vanta-am-advanced');
    if (advancedBtn !== null) {
      scope.on(advancedBtn, 'click', () => {
        openAdvancedModal();
      });
    }

    const calcBtn = $<HTMLButtonElement>('vanta-am-calc');
    if (calcBtn !== null) {
      scope.on(calcBtn, 'click', () => {
        void calculate();
      });
    }

    if (execBtn !== null) {
      scope.on(execBtn, 'click', () => {
        void execute();
      });
    }

    const clearBtn = $<HTMLButtonElement>('vanta-am-clear');
    if (clearBtn !== null) {
      scope.on(clearBtn, 'click', () => {
        savePlan(null);
        renderPreview();
        setStatus('Plano descartado.', 'ok');
      });
    }

    panel.querySelectorAll<HTMLInputElement>('input[name="vanta-am-mode"]').forEach((radio) => {
      scope.on(radio, 'change', () => {
        const plan = readPlan();
        if (plan === null) return;
        savePlan({ ...plan, mode: currentMode() });
        renderPreview();
      });
    });

    // ── Injeção + primeira renderização ──
    const anchor = findAnchor();
    if (anchor === null) return;
    if (anchor.position === 'before') anchor.el.insertAdjacentElement('beforebegin', panel);
    else anchor.el.insertAdjacentElement('afterend', panel);

    refreshSettingsSummary();
    refreshLines();
    refreshTotals(true);
    renderPreview();
    void loadGroups(false);

    // Toques do jogo (ajax/edições) mudam a tabela: redesenha só quando muda.
    scope.every(() => {
      if (bodyEl?.hidden === true) return;
      refreshTotals(false);
    }, 4000);
  },
});

/**
 * Âncora do painel na aba nativa. Ordem: o "Apoio chegando" da própria aba
 * (insere ANTES), o h3/legend do "Apoio em massa" (insere DEPOIS) e, por fim,
 * o formulário que contém `#village_troup_list`. Devolve null só quando a
 * página não tem nem a tabela nem o container do jogo (aí não injeta).
 */
function findAnchor(): { el: Element; position: 'before' | 'after' } | null {
  const content =
    document.getElementById('content_value') ??
    document.getElementById('content_wrap') ??
    document.getElementById('content') ??
    document.body;
  const arriving = Array.from(
    content.querySelectorAll<HTMLElement>('h3, h4, legend, caption, label, td, th, span, div'),
  ).find((el) => el.children.length === 0 && /apoio chegando/i.test(el.textContent ?? ''));
  if (arriving !== undefined) {
    // `table`/`form` antes de `div`: o painel nunca entra no meio de uma grade.
    const block = arriving.closest('h3, h4, legend, table, form, div') ?? arriving;
    if (block !== document.body) return { el: block, position: 'before' };
  }
  const heading = Array.from(content.querySelectorAll<HTMLElement>('h3, h4, legend')).find((el) =>
    /apoio em massa|enviar apoio/i.test(el.textContent ?? ''),
  );
  if (heading !== undefined) return { el: heading, position: 'after' };
  const table = document.getElementById('village_troup_list');
  if (table !== null) {
    const block = table.closest('form') ?? table.parentElement ?? table;
    return { el: block, position: 'before' };
  }
  const container = document.getElementById('contentContainer');
  if (container !== null) return { el: container, position: 'before' };
  return null;
}

/** Cópia com fallback (mesma escolha do overview-agenda). */
function copyFallback(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
