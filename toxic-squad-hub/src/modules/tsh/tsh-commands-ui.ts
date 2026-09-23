// Tela "Comandos" do Agendador — abre pelo botão "Comandos" do cartão
// command-scheduler no painel (extraActions → openSchedulerCommands).
// Reutiliza o MESMO scaffold de modal das configurações (buildTshModal) e a
// MESMA storage do motor (tsh-auto:<world>:command-scheduler:scheduler), então
// o que é agendado aqui dispara sozinho no ciclo do plugin — nada de formulário
// paralelo pedindo ao usuário o que o script lê do jogo:
// - Origem: select com as ALDEIAS PRÓPRIAS (ownVillages — village.txt), default
//   = aldeia atual da URL (village=);
// - Alvo: "x|y" com lookup no mapa (villageAt → nome/pontos, com debounce);
// - Momento: "Enviar às" ou "Chegar às" — a conversão chegada→envio usa
//   travelMinutes (a MAIS LENTA unidade do conjunto; null = indisponível e o
//   modo chegada é desabilitado);
// - Lista: status derivado por deriveSchedulerCommandStatus (pausado nunca
//   dispara; terminais são fatos) — Remover grava o evento 'removido' ANTES de
//   tirar o comando da lista (se algo interromper no meio, o motor vê o
//   terminal e não dispara).
// Regras da casa: zero innerHTML com dado dinâmico (tudo textContent), pt-BR,
// horários interpretados no relógio do SEU COMPUTADOR (nota de ajuda; o motor
// mira o sendAt pelo relógio do servidor lido na tela) e nenhum timer além do
// debounce do lookup do alvo. Partes puras exportadas para testes em
// tsh-commands-ui.test.ts.

import { icon, type IconName } from '../../core/icons';
import { gm } from '../../core/storage';
import {
  deriveSchedulerCommandStatus,
  SCHEDULER_DEFAULT_WINDOW,
  type HubSchedulerState,
  type ScheduledCommandRecord,
  type ScheduledCommandViewStatus,
} from '../../ext/core/scheduler-state';
import type { UnitType } from '../../ext/modules/shared/module-types';
import { serverClockOffset } from '../../ext/core/execution/server-clock';
import { createScheduledCommand, UNIT_POPULATION } from './plugins/command-scheduler';
import { ownVillages, travelMinutes, villageAt, type OwnVillage } from './tsh-game-data';
import { buildTshModal, tshConfirm, tshNoteBanner } from './tsh-settings-ui';
import { unitIcon, UNIT_LABELS as UNIT_LABELS_SHARED } from './tsh-units';

// ── Partes puras (testadas em tsh-commands-ui.test.ts) ──

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Alvo digitado "x|y" (também aceita vírgula/ponto-e-vírgula/espaço como
 * separador) → coordenada 0–999; null = inválido (fail-closed).
 */
export function parseTargetInput(text: string): { x: number; y: number } | null {
  const match = /^\s*(\d{1,3})\s*[|,;\s]\s*(\d{1,3})\s*$/.exec(text);
  if (match === null) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x > 999 || y > 999) return null;
  return { x, y };
}

/** Distância euclidiana em campos do mapa. */
export function fieldsDistance(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

/** Conversão do modo "Chegar às": envio = chegada − tempo de viagem (min). */
export function arrivalToSendAt(arrival: Date, travelMinutesValue: number): Date {
  return new Date(arrival.getTime() - Math.max(0, travelMinutesValue) * 60_000);
}

/** Chegada derivada do modo "Enviar às" (simétrico — só exibição). */
export function sendToArrival(send: Date, travelMinutesValue: number): Date {
  return new Date(send.getTime() + Math.max(0, travelMinutesValue) * 60_000);
}

/** "dd/mm HH:MM:SS" no relógio local. */
export function formatTimestamp(date: Date): string {
  return (
    `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

/** Valor para <input type="datetime-local" step="1"> no relógio local. */
export function toDatetimeLocalValue(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

/** Parse de datetime-local ("yyyy-MM-ddTHH:mm[:ss]") no relógio local; null = inválido. */
export function parseDatetimeLocal(value: string): Date | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(trimmed)) return null;
  const parsed = new Date(trimmed); // sem Z → hora LOCAL do computador
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ── Relógio do servidor × relógio local (Onda 9) ─────────────────────────────
// O usuário digita no relógio DO PC; o motor mira pelo relógio DO SERVIDOR
// (serverNow = local + offset). Para disparar quando o PC marcar T, o sendAt
// (em hora de servidor) precisa ser T + offset — P1 da revisão: o sinal era
// o inverso e o disparo saía 2×offset fora da hora.

/** Offset atual (ms) lido da página; 0 quando indisponível. */
export function currentServerOffsetMs(): number {
  const timeText = document.getElementById('serverTime')?.textContent ?? null;
  const dateText = document.getElementById('serverDate')?.textContent ?? null;
  const offset = serverClockOffset(`${dateText ?? ''} ${timeText ?? ''}`.trim() || null);
  return offset ?? 0;
}

/** Horário LOCAL escolhido → epoch no RELÓGIO DO SERVIDOR (gravação do sendAt). */
export function localToServerEpoch(local: Date, offsetMs: number): number {
  return local.getTime() + offsetMs;
}

/** sendAt do registro (servidor) → Date no relógio LOCAL (exibição). */
export function serverToLocal(serverIso: string, offsetMs: number): Date {
  return new Date(Date.parse(serverIso) - offsetMs);
}

/** Inteiro com separador de milhar pt-BR (1.234) — sem Intl (determinístico). */
export function formatInt(n: number): string {
  const sign = n < 0 ? '-' : '';
  const digits = Math.abs(Math.round(n)).toString();
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += '.';
    out += digits.charAt(i);
  }
  return sign + out;
}

/** Decimal pt-BR com 1 casa quando fracionário ("12,3"; inteiro sem vírgula). */
export function formatDecimalPtBr(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  const whole = Math.floor(rounded);
  const frac = Math.round((rounded - whole) * 10);
  return frac === 0 ? formatInt(whole) : `${formatInt(whole)},${frac}`;
}

/** Leitura defensiva de caixa numérica de tropas: inteiro ≥ 1 (vazio/lixo = 0). */
export function parseUnitCount(raw: string): number {
  const n = Number(raw.trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1_000_000, Math.floor(n));
}

// P3 (revisão Onda 21): mapa único em tsh-units — sem cópia divergente.
const UNIT_LABELS: Record<UnitType, string> = UNIT_LABELS_SHARED as Record<UnitType, string>;

/** Ordem da grade de unidades + passo das setinhas (elite a passo 1). */
const UNIT_ROWS: readonly { key: UnitType; step: number }[] = [
  { key: 'spear', step: 10 },
  { key: 'sword', step: 10 },
  { key: 'axe', step: 10 },
  { key: 'archer', step: 10 },
  { key: 'spy', step: 1 },
  { key: 'light', step: 5 },
  { key: 'marcher', step: 5 },
  { key: 'heavy', step: 5 },
  { key: 'ram', step: 5 },
  { key: 'catapult', step: 5 },
  { key: 'knight', step: 1 },
  { key: 'snob', step: 1 },
];

export function unitLabel(unit: UnitType): string {
  return UNIT_LABELS[unit];
}

/** Resumo curto das tropas: "2.350 pop · Machado ×2.000, Aríete ×50, Nobre ×1" (— se vazio). */
export function summarizeUnits(units: Partial<Record<UnitType, number>>): string {
  const entries: [UnitType, number][] = [];
  for (const row of UNIT_ROWS) {
    const n = units[row.key];
    if (n !== undefined && n > 0) entries.push([row.key, n]);
  }
  if (entries.length === 0) return '—';
  const pop = entries.reduce((total, [unit, n]) => total + (UNIT_POPULATION[unit] ?? 0) * n, 0);
  const top3 = [...entries]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([unit, n]) => `${UNIT_LABELS[unit]} ×${formatInt(n)}`);
  return `${formatInt(pop)} pop · ${top3.join(', ')}`;
}

type CommandKind = ScheduledCommandRecord['kind'];

const KIND_ROWS: readonly { kind: CommandKind; label: string; badge: string }[] = [
  { kind: 'attack', label: 'Ataque', badge: 'tsh-badge tsh-badge--muta' },
  { kind: 'fake', label: 'Fake', badge: 'tsh-badge' },
  { kind: 'support', label: 'Apoio', badge: 'tsh-badge' },
  { kind: 'noble', label: 'Nobre', badge: 'tsh-badge tsh-badge--previa' },
];

export function commandKindLabel(kind: CommandKind): string {
  return KIND_ROWS.find((row) => row.kind === kind)?.label ?? kind;
}

export function commandKindBadgeClass(kind: CommandKind): string {
  return KIND_ROWS.find((row) => row.kind === kind)?.badge ?? 'tsh-badge';
}

export function commandStatusLabel(status: ScheduledCommandViewStatus): string {
  switch (status) {
    case 'agendado':
      return 'Agendado';
    case 'janela':
      return 'Na janela';
    case 'enviando':
      return 'Enviando';
    case 'enviado':
      return 'Enviado';
    case 'incerto':
      return 'Incerto';
    case 'falhou':
      return 'Falhou';
    case 'removido':
      return 'Removido';
    case 'pausado':
      return 'Pausado';
  }
}

export function commandStatusBadgeClass(status: ScheduledCommandViewStatus): string {
  switch (status) {
    case 'agendado':
      return 'tsh-badge tsh-badge--previa';
    case 'janela':
    case 'enviando':
      return 'tsh-badge tsh-badge--armed';
    case 'enviado':
      return 'tsh-badge tsh-badge--on';
    case 'falhou':
    case 'incerto':
      return 'tsh-badge tsh-badge--muta';
    default:
      return 'tsh-badge'; // pausado | removido
  }
}

const TERMINAL_VIEW_STATUSES: ReadonlySet<ScheduledCommandViewStatus> = new Set([
  'enviado',
  'incerto',
  'falhou',
  'removido',
]);

export interface CommandRow {
  record: ScheduledCommandRecord;
  status: ScheduledCommandViewStatus;
}

/**
 * Ordem da lista: vivos (agendados/janela/enviando/pausados) por sendAt
 * crescente (o próximo a disparar primeiro), depois o histórico por sendAt
 * decrescente (mais recente primeiro).
 */
export function orderCommandRows(
  records: readonly ScheduledCommandRecord[],
  now: Date,
  window: { focusLeadMs: number; allowLateMs: number } = SCHEDULER_DEFAULT_WINDOW,
): CommandRow[] {
  const rows = records.map((record) => ({ record, status: deriveSchedulerCommandStatus(record, now, window) }));
  const bySendAsc = (a: CommandRow, b: CommandRow): number => Date.parse(a.record.sendAt) - Date.parse(b.record.sendAt);
  const alive = rows.filter((row) => !TERMINAL_VIEW_STATUSES.has(row.status)).sort(bySendAsc);
  const history = rows.filter((row) => TERMINAL_VIEW_STATUSES.has(row.status)).sort((a, b) => bySendAsc(b, a));
  return [...alive, ...history];
}

// ── Storage do motor (MESMA chave do command-scheduler) ──

const schedulerKey = (world: string): string => `tsh-auto:${world}:command-scheduler:scheduler`;

function loadSchedulerState(world: string): HubSchedulerState {
  const stored = gm.get<Partial<HubSchedulerState>>(schedulerKey(world), {});
  return {
    commands: Array.isArray(stored.commands) ? stored.commands : [],
    transit: Array.isArray(stored.transit) ? stored.transit : [],
  };
}

function saveSchedulerState(world: string, state: HubSchedulerState): void {
  gm.set(schedulerKey(world), state);
}

function setCommandPaused(world: string, id: string, paused: boolean): void {
  const state = loadSchedulerState(world);
  saveSchedulerState(world, {
    ...state,
    commands: state.commands.map((command) => (command.id === id ? { ...command, paused } : command)),
  });
}

/** Aldeia da URL sem prefixo "n" (mesma normalização do transporte). */
const normalizeVillageId = (id: string): string => id.replace(/^n/, '');

// ── Blocos de UI (tudo textContent — nada de HTML dinâmico) ──

/** Seção-caixa Nexus: título UPPERCASE com ícone + corpo (mesmo padrão das
 *  configurações — cópia local para não exportar a mais do settings-ui). */
function sectionBoxEl(title: string, iconName: IconName): { box: HTMLDivElement; body: HTMLDivElement } {
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

function labelEl(text: string, help?: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'tsh-field-label';
  el.appendChild(document.createTextNode(text));
  if (help !== undefined) {
    // ⓘ com tooltip CSS (data-tip, à direita) + title nativo de fallback.
    const tip = document.createElement('span');
    tip.className = 'tsh-field-info tsh-tip tsh-tip--right';
    tip.title = help;
    tip.setAttribute('data-tip', help);
    tip.setAttribute('aria-label', help);
    tip.appendChild(icon('info', 11));
    el.appendChild(tip);
  }
  return el;
}

function badgeEl(cls: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

function helpEl(text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'tsh-field-help';
  el.textContent = text;
  return el;
}

function statusRowEl(text: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'tsh-status-row';
  const msg = document.createElement('span');
  msg.className = 'tsh-status-msg';
  msg.textContent = text;
  row.appendChild(msg);
  return row;
}

function statusMsgOf(row: HTMLDivElement): HTMLSpanElement {
  const msg = row.querySelector('.tsh-status-msg');
  return msg instanceof HTMLSpanElement ? msg : row;
}

// ── Lista de comandos ──

function renderCommandList(
  wrap: HTMLElement,
  shadow: ShadowRoot,
  world: string,
  rerender: () => void,
  refresh: () => void,
): void {
  wrap.replaceChildren();
  const rows = orderCommandRows(loadSchedulerState(world).commands, new Date());
  if (rows.length === 0) {
    // P3 (auditoria impeccable): empty state no padrão do shell (.shs-empty —
    // padding generoso, centralizado, muted; definido no <style> do core).
    const empty = document.createElement('div');
    empty.className = 'shs-empty';
    empty.textContent = 'Nenhum comando agendado — crie o primeiro abaixo.';
    wrap.appendChild(empty);
    return;
  }
  const alive = rows.filter((row) => !TERMINAL_VIEW_STATUSES.has(row.status));
  const paused = alive.filter((row) => row.status === 'pausado');
  const meta = document.createElement('div');
  meta.className = 'tsh-meta-row';
  meta.textContent = `${alive.length} ativo(s) · ${paused.length} pausado(s) · ${rows.length - alive.length} no histórico`;
  wrap.appendChild(meta);
  for (const row of rows) wrap.appendChild(commandCard(row, shadow, world, rerender, refresh));
}

function commandCard(
  row: CommandRow,
  shadow: ShadowRoot,
  world: string,
  rerender: () => void,
  refresh: () => void,
): HTMLDivElement {
  const { record, status } = row;
  const card = document.createElement('div');
  card.className = 'tsh-card';
  if (status === 'pausado') card.classList.add('tsh-card--off');

  const head = document.createElement('div');
  head.className = 'tsh-card-head';
  const title = document.createElement('div');
  title.className = 'tsh-card-title';
  title.style.flex = '1';
  title.textContent =
    record.targetName !== undefined ? `${record.targetName} (${record.target.x}|${record.target.y})` : `${record.target.x}|${record.target.y}`;
  head.append(
    badgeEl(commandKindBadgeClass(record.kind), commandKindLabel(record.kind)),
    title,
    badgeEl(commandStatusBadgeClass(status), commandStatusLabel(status)),
  );
  card.appendChild(head);

  const originText =
    record.sourceName !== undefined ? record.sourceName : `aldeia ${record.sourceVillageId}`;
  const originCoord =
    record.source !== undefined ? ` (${record.source.x}|${record.source.y})` : '';
  const targetDetail = [
    record.targetPoints !== undefined ? `${formatInt(record.targetPoints)} pts` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
  const line1 = document.createElement('div');
  line1.className = 'tsh-card-desc';
  line1.textContent = `De ${originText}${originCoord} → ${record.target.x}|${record.target.y}${targetDetail !== '' ? ` · ${targetDetail}` : ''}`;
  card.appendChild(line1);

  // Exibição no relógio LOCAL (o sendAt gravado é hora do SERVIDOR).
  const offset = currentServerOffsetMs();
  const sendDate = serverToLocal(record.sendAt, offset);
  const timing =
    Number.isFinite(sendDate.getTime())
      ? `Envio ${formatTimestamp(sendDate)}` +
        (record.arrivalAt !== undefined ? ` · Chegada ${formatTimestamp(serverToLocal(record.arrivalAt, offset))}` : '')
      : `Envio: ${record.sendAt} (horário ilegível)`;
  const line2 = document.createElement('div');
  line2.className = 'tsh-card-desc';
  line2.textContent = `${timing} · Tropas: ${summarizeUnits(record.units)}`;
  card.appendChild(line2);

  const actions = document.createElement('div');
  actions.className = 'tsh-actions';
  const pauseBtn = document.createElement('button');
  pauseBtn.type = 'button';
  pauseBtn.className = 'tsh-btn';
  if (record.paused) {
    pauseBtn.appendChild(icon('play', 12));
    pauseBtn.appendChild(document.createTextNode('Retomar'));
  } else {
    pauseBtn.appendChild(icon('pause', 12));
    pauseBtn.appendChild(document.createTextNode('Pausar'));
  }
  pauseBtn.addEventListener('click', () => {
    setCommandPaused(world, record.id, !record.paused);
    rerender();
    refresh();
  });
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'tsh-btn tsh-btn--danger';
  removeBtn.appendChild(icon('trash', 12));
  removeBtn.appendChild(document.createTextNode('Remover'));
  removeBtn.addEventListener('click', () => {
    void removeCommandWithConfirm(record, shadow, world, rerender, refresh);
  });
  actions.append(pauseBtn, removeBtn);
  card.appendChild(actions);
  return card;
}

/**
 * Remoção com confirmação: grava o evento terminal 'removido' ANTES de tirar o
 * comando da lista — se algo interromper entre as duas gravações, o motor vê o
 * status terminal e nunca dispara. 'Incerto' pede confirmação mais forte
 * (o envio pode ter acontecido). P2 (auditoria impeccable): window.confirm →
 * diálogo Nexus (tshConfirm) — handler async; o rerender/refresh só rodam
 * depois do "Confirmar".
 */
async function removeCommandWithConfirm(
  record: ScheduledCommandRecord,
  shadow: ShadowRoot,
  world: string,
  rerender: () => void,
  refresh: () => void,
): Promise<void> {
  const status = deriveSchedulerCommandStatus(record, new Date(), SCHEDULER_DEFAULT_WINDOW);
  const label = `${commandKindLabel(record.kind)} → ${record.target.x}|${record.target.y}`;
  const message =
    status === 'incerto'
      ? `O envio de "${label}" está INCERTO — pode ter acontecido ou não. Remover o registro mesmo assim?`
      : status === 'enviado' || status === 'removido'
        ? `Remover "${label}" do histórico? (não afeta o jogo — o comando já não dispara mais)`
        : `Remover o comando "${label}"? Ele NÃO será enviado.`;
  const ok = await tshConfirm(shadow, 'Remover comando', message, { danger: true });
  if (!ok) return;
  const state = loadSchedulerState(world);
  saveSchedulerState(world, {
    ...state,
    commands: state.commands.map((command) =>
      command.id === record.id
        ? {
            ...command,
            events: [
              ...command.events,
              { status: 'removido', at: new Date().toISOString(), detail: 'Removido na tela Comandos.' },
            ],
          }
        : command,
    ),
  });
  const after = loadSchedulerState(world);
  saveSchedulerState(world, { ...after, commands: after.commands.filter((command) => command.id !== record.id) });
  rerender();
  refresh();
}

// ── Tela principal ──

export async function openSchedulerCommands(shadow: ShadowRoot, world: string, rerender: () => void): Promise<void> {
  const { body, foot, close } = buildTshModal(shadow, 'Comandos — Agendador', 'clock');
  const modalEl = body.parentElement; // modal é o pai do body no scaffold
  if (modalEl !== null) {
    // Modal grande (lista + grade de 12 unidades) — o scaffold padrão é 720px.
    modalEl.style.width = 'min(780px, calc(100vw - 32px))';
    modalEl.style.maxHeight = 'min(88vh, 860px)';
  }

  // ── Help geral vira banner de info Nexus no topo ──
  body.appendChild(
    tshNoteBanner('Comandos disparam sozinhos pela Praça da aldeia de origem, no horário marcado.'),
  );

  // ── Lista (estado atual do motor) ──
  const listSection = sectionBoxEl('Comandos agendados', 'send');
  body.appendChild(listSection.box);
  const listWrap = document.createElement('div');
  listSection.body.appendChild(listWrap);
  const refreshList = (): void => {
    renderCommandList(listWrap, shadow, world, rerender, refreshList);
  };
  refreshList();

  // ── Formulário "Agendar comando" ──
  const formSection = sectionBoxEl('Agendar comando', 'plus');
  body.appendChild(formSection.box);
  const form = document.createElement('div');
  formSection.body.appendChild(form);

  // Carregamento inicial: village.txt pode levar 1–2s (cache ajuda nas próximas).
  const loadingRow = statusRowEl('Carregando aldeias do mapa… (a primeira leitura pode levar 1–2s)');
  form.appendChild(loadingRow);
  let villages: OwnVillage[] = [];
  try {
    villages = await ownVillages();
  } catch {
    villages = [];
  }
  loadingRow.remove();

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'tsh-btn tsh-btn--ghost';
  closeBtn.appendChild(icon('x', 12));
  closeBtn.appendChild(document.createTextNode('Fechar'));
  closeBtn.addEventListener('click', close);
  foot.appendChild(closeBtn);

  const firstVillage = villages[0];
  if (firstVillage === undefined) {
    const err = document.createElement('div');
    err.className = 'tsh-error';
    err.textContent = 'Não foi possível carregar suas aldeias do mapa — feche e reabra a tela "Comandos" para tentar de novo.';
    form.appendChild(err);
    return;
  }

  // Estado do formulário.
  const urlVillageId = normalizeVillageId(new URLSearchParams(window.location.search).get('village') ?? '');
  let origin: OwnVillage = villages.find((v) => normalizeVillageId(v.id) === urlVillageId) ?? firstVillage;
  let target: { x: number; y: number } | null = null;
  let targetName: string | undefined;
  let targetPoints: number | undefined;
  let travelMin: number | null = null; // último travelMinutes válido do conjunto atual

  let errorEl: HTMLDivElement | null = null;
  const showError = (message: string): void => {
    if (errorEl === null) {
      errorEl = document.createElement('div');
      errorEl.className = 'tsh-error';
      form.appendChild(errorEl);
    }
    errorEl.textContent = message; // sempre textContent — nunca HTML
  };
  const clearError = (): void => {
    if (errorEl !== null) {
      errorEl.remove();
      errorEl = null;
    }
  };

  // ── Origem ──
  const originField = document.createElement('div');
  originField.className = 'tsh-field tsh-field--block';
  const originLabel = labelEl(
    'Origem',
    'Suas aldeias, lidas do próprio jogo. A coordenada da origem é usada para converter chegada→envio.',
  );
  const originSelect = document.createElement('select');
  originSelect.className = 'tsh-select';
  for (const village of villages) {
    const option = document.createElement('option');
    option.value = village.id;
    option.textContent = `${village.name} (${village.x}|${village.y})`;
    originSelect.appendChild(option);
  }
  originSelect.value = origin.id;
  originSelect.addEventListener('change', () => {
    const found = villages.find((v) => v.id === originSelect.value);
    if (found !== undefined) {
      origin = found;
      clearError();
      void recomputeTravel();
      updateSummary();
    }
  });
  originField.append(originLabel, originSelect);
  originField.appendChild(helpEl('Suas aldeias, lidas do próprio jogo. A coordenada da origem é usada para converter chegada→envio.'));
  form.appendChild(originField);

  // ── Alvo ──
  const targetField = document.createElement('div');
  targetField.className = 'tsh-field tsh-field--block';
  const targetLabel = labelEl('Alvo (x|y)', 'Coordenadas de 0 a 999. O nome e os pontos são buscados no mapa automaticamente.');
  const targetInput = document.createElement('input');
  targetInput.type = 'text';
  targetInput.className = 'tsh-input';
  targetInput.placeholder = '534|551';
  targetInput.setAttribute('autocomplete', 'off');
  const targetInfo = helpEl('Coordenadas de 0 a 999. O nome e os pontos são buscados no mapa automaticamente.');
  targetField.append(targetLabel, targetInput, targetInfo);
  form.appendChild(targetField);

  // ── Tipo ──
  const kindField = document.createElement('div');
  kindField.className = 'tsh-field tsh-field--block';
  const kindLabel = labelEl(
    'Tipo',
    'Ataque/Fake/Nobre saem como ataque na Praça; Apoio como apoio. Fake com pontos do alvo respeita o limite do mundo.',
  );
  const kindSelect = document.createElement('select');
  kindSelect.className = 'tsh-select';
  for (const row of KIND_ROWS) {
    const option = document.createElement('option');
    option.value = row.kind;
    option.textContent = row.label;
    kindSelect.appendChild(option);
  }
  kindField.append(kindLabel, kindSelect);
  kindField.appendChild(helpEl('Ataque/Fake/Nobre saem como ataque na Praça; Apoio como apoio. Fake com pontos do alvo respeita o limite do mundo.'));
  form.appendChild(kindField);

  // ── Unidades (grade de 12) ──
  const unitsField = document.createElement('div');
  unitsField.className = 'tsh-field tsh-field--block';
  const unitsLabel = labelEl('Unidades', 'A soma das tropas deve ser maior que zero. A viagem vale a MAIS LENTA unidade do conjunto.');
  const unitsGrid = document.createElement('div');
  unitsGrid.className = 'tsh-record-grid';
  const unitInputs: { key: UnitType; input: HTMLInputElement }[] = [];
  for (const row of UNIT_ROWS) {
    const cell = document.createElement('div');
    cell.className = 'tsh-record-cell tsh-unit-cell';
    // Ícone do jogo + rótulo pequeno (a key crua fica no title do rótulo).
    const lab = document.createElement('span');
    lab.className = 'tsh-record-label';
    lab.title = row.key;
    lab.appendChild(unitIcon(row.key, 18));
    const labTxt = document.createElement('span');
    labTxt.textContent = unitLabel(row.key);
    lab.appendChild(labTxt);
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'tsh-input';
    inp.min = '0';
    inp.step = String(row.step);
    inp.value = '0';
    inp.addEventListener('input', () => {
      clearError();
      void recomputeTravel();
      updateSummary();
    });
    unitInputs.push({ key: row.key, input: inp });
    cell.append(lab, inp);
    unitsGrid.appendChild(cell);
  }
  unitsField.append(unitsLabel, unitsGrid);
  unitsField.appendChild(helpEl('A soma das tropas deve ser maior que zero. A viagem vale a MAIS LENTA unidade do conjunto.'));
  form.appendChild(unitsField);

  const readUnits = (): Partial<Record<UnitType, number>> => {
    const units: Partial<Record<UnitType, number>> = {};
    for (const { key, input } of unitInputs) {
      const n = parseUnitCount(input.value);
      if (n > 0) units[key] = n;
    }
    return units;
  };

  // ── Momento (Enviar às / Chegar às + datetime-local) ──
  const timingField = document.createElement('div');
  timingField.className = 'tsh-field tsh-field--block';
  const timingLabel = labelEl('Momento');
  const sendRadio = document.createElement('input');
  sendRadio.type = 'radio';
  sendRadio.name = 'tsh-cmd-timing';
  sendRadio.value = 'send';
  sendRadio.checked = true;
  const arrivalRadio = document.createElement('input');
  arrivalRadio.type = 'radio';
  arrivalRadio.name = 'tsh-cmd-timing';
  arrivalRadio.value = 'arrival';
  const sendRow = document.createElement('div');
  sendRow.className = 'tsh-check-row';
  const sendText = document.createElement('span');
  sendText.textContent = 'Enviar às';
  sendRow.append(sendRadio, sendText);
  const arrivalRow = document.createElement('div');
  arrivalRow.className = 'tsh-check-row';
  const arrivalText = document.createElement('span');
  arrivalText.textContent = 'Chegar às';
  arrivalRow.append(arrivalRadio, arrivalText);
  const timeInput = document.createElement('input');
  timeInput.type = 'datetime-local';
  timeInput.step = '1';
  timeInput.className = 'tsh-input';
  // Conforto: pré-preenchido com daqui a 10 minutos (relógio local).
  timeInput.value = toDatetimeLocalValue(new Date(Date.now() + 10 * 60_000));
  const timingHelp = helpEl('');
  timingField.append(timingLabel, sendRow, arrivalRow, timeInput, timingHelp);
  form.appendChild(timingField);

  const applyTravelAvailability = (): void => {
    const unavailable = travelMin === null;
    arrivalRadio.disabled = unavailable;
    timingHelp.textContent = unavailable
      ? 'Velocidades do mundo indisponíveis — use "Enviar às".'
      : 'Horário no relógio do SEU COMPUTADOR — confira com a "Hora do servidor" do jogo antes de agendar (o motor dispara pelo relógio do servidor).';
    if (unavailable && arrivalRadio.checked) sendRadio.checked = true;
  };

  // ── Resumo vivo ──
  const summaryRow = statusRowEl('Preencha alvo, tropas e horário — o resumo aparece aqui.');
  form.appendChild(summaryRow);
  const summaryMsg = statusMsgOf(summaryRow);

  const updateSummary = (): void => {
    const parts: string[] = [];
    const when = parseDatetimeLocal(timeInput.value);
    const mode: 'arrival' | 'send' = arrivalRadio.checked ? 'arrival' : 'send';
    if (when !== null && travelMin !== null) {
      if (mode === 'arrival') {
        parts.push(`Enviar ${formatTimestamp(arrivalToSendAt(when, travelMin))}`, `Chegar ${formatTimestamp(when)}`);
      } else {
        parts.push(`Enviar ${formatTimestamp(when)}`, `Chegar ${formatTimestamp(sendToArrival(when, travelMin))}`);
      }
    } else if (when !== null) {
      parts.push(`${mode === 'arrival' ? 'Chegar' : 'Enviar'} ${formatTimestamp(when)}`);
    }
    if (target !== null) parts.push(`dist ${formatDecimalPtBr(fieldsDistance(origin, target))} campos`);
    const units = readUnits();
    const total = Object.values(units).reduce((sum, n) => sum + (n ?? 0), 0);
    if (total > 0) parts.push(`${formatInt(total)} tropa(s)`);
    summaryMsg.textContent = parts.length > 0 ? parts.join(' · ') : 'Preencha alvo, tropas e horário — o resumo aparece aqui.';
  };

  // ── Conversão chegada→envio (travelMinutes da unidade mais lenta) ──
  let travelSeq = 0;
  const recomputeTravel = async (): Promise<void> => {
    const seq = ++travelSeq;
    const to = target;
    const units = readUnits();
    const hasUnits = Object.values(units).some((n) => (n ?? 0) > 0);
    if (to === null || !hasUnits) {
      travelMin = null;
      applyTravelAvailability();
      updateSummary();
      return;
    }
    const minutes = await travelMinutes(origin, to, units);
    if (seq !== travelSeq) return; // input mais novo venceu — descarta
    travelMin = minutes;
    applyTravelAvailability();
    updateSummary();
  };

  // ── Eventos do alvo (validação + lookup com debounce) e do momento ──
  let lookupTimer: number | undefined;
  let lookupSeq = 0;
  targetInput.addEventListener('input', () => {
    clearError();
    const parsed = parseTargetInput(targetInput.value);
    if (parsed === null) {
      target = null;
      targetName = undefined;
      targetPoints = undefined;
      targetInfo.textContent = 'Formato: x|y (coordenadas 0–999).';
      targetInfo.style.color = '';
      updateSummary();
      void recomputeTravel();
      return;
    }
    target = parsed;
    updateSummary();
    void recomputeTravel();
    if (lookupTimer !== undefined) window.clearTimeout(lookupTimer);
    const seq = ++lookupSeq;
    lookupTimer = window.setTimeout(() => {
      void villageAt(parsed.x, parsed.y).then((found) => {
        if (seq !== lookupSeq) return; // usuário digitou outra coisa enquanto isso
        if (found !== null) {
          targetName = found.name;
          targetPoints = found.points;
          targetInfo.textContent = `${found.name} · ${formatInt(found.points)} pontos`;
          targetInfo.style.color = '';
        } else {
          targetName = undefined;
          targetPoints = undefined;
          targetInfo.textContent = 'Coordenada válida, mas não encontrada no mapa — confira antes de agendar.';
          targetInfo.style.color = 'var(--shs-danger)';
        }
        updateSummary();
      });
    }, 350);
  });
  for (const radio of [sendRadio, arrivalRadio]) {
    radio.addEventListener('change', () => {
      clearError();
      void recomputeTravel();
      updateSummary();
    });
  }
  timeInput.addEventListener('input', () => {
    clearError();
    updateSummary();
  });

  applyTravelAvailability();
  updateSummary();

  // ── Botão Adicionar + validações ──
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'tsh-btn tsh-btn--primary';
  addBtn.appendChild(icon('plus', 13));
  addBtn.appendChild(document.createTextNode('Adicionar comando'));
  addBtn.addEventListener('click', () => {
    clearError();
    const kindRow = KIND_ROWS.find((row) => row.kind === kindSelect.value);
    if (kindRow === undefined) {
      showError('Selecione o tipo do comando (Ataque, Fake, Apoio ou Nobre).');
      return;
    }
    const to = target;
    if (to === null) {
      showError('Alvo inválido — use o formato x|y (coordenadas de 0 a 999).');
      return;
    }
    const units = readUnits();
    if (Object.values(units).every((n) => (n ?? 0) <= 0)) {
      showError('Informe ao menos uma unidade — a soma das tropas deve ser maior que zero.');
      return;
    }
    const when = parseDatetimeLocal(timeInput.value);
    if (when === null) {
      showError('Informe o horário (data e hora, com segundos).');
      return;
    }
    const mode: 'arrival' | 'send' = arrivalRadio.checked ? 'arrival' : 'send';
    let sendDate: Date;
    let arrivalDate: Date | null = null;
    if (mode === 'arrival') {
      if (travelMin === null) {
        showError('Conversão de chegada indisponível (velocidades do mundo desconhecidas) — use o modo "Enviar às".');
        return;
      }
      arrivalDate = when;
      sendDate = arrivalToSendAt(when, travelMin);
    } else {
      sendDate = when;
      if (travelMin !== null) arrivalDate = sendToArrival(when, travelMin);
    }
    if (sendDate.getTime() <= Date.now() + 5_000) {
      showError('O horário de envio precisa ser no FUTURO (pelo menos 5 segundos a partir de agora).');
      return;
    }
    const record = createScheduledCommand({
      kind: kindRow.kind,
      sourceVillageId: origin.id,
      sourceName: origin.name,
      source: { x: origin.x, y: origin.y },
      target: to,
      ...(targetName !== undefined ? { targetName } : {}),
      ...(targetPoints !== undefined ? { targetPoints } : {}),
      units,
      timingMode: mode,
      // Grava no RELÓGIO DO SERVIDOR (o motor mira por ele): local − offset.
      sendAt: new Date(localToServerEpoch(sendDate, currentServerOffsetMs())).toISOString(),
      ...(arrivalDate !== null
        ? { arrivalAt: new Date(localToServerEpoch(arrivalDate, currentServerOffsetMs())).toISOString() }
        : {}),
    });
    const state = loadSchedulerState(world);
    // Id canônico idêntico (mesmo aldeia/alvo/horário/tropas) nunca duplica:
    // a engine marcava os dois como enviados silenciosamente — sufixa (P3 rev.).
    let toSave = record;
    if (state.commands.some((c) => c.id === record.id)) {
      let n = 2;
      while (state.commands.some((c) => c.id === `${record.id}-${n}`)) n++;
      toSave = { ...record, id: `${record.id}-${n}` };
    }
    saveSchedulerState(world, { ...state, commands: [...state.commands, toSave] });
    rerender();
    refreshList();

    // Limpa o form (mantém origem e tipo — agendar em sequência fica mais rápido).
    target = null;
    targetName = undefined;
    targetPoints = undefined;
    targetInput.value = '';
    targetInfo.textContent = 'Coordenadas de 0 a 999. O nome e os pontos são buscados no mapa automaticamente.';
    targetInfo.style.color = '';
    for (const { input } of unitInputs) input.value = '0';
    timeInput.value = toDatetimeLocalValue(new Date(Date.now() + 10 * 60_000));
    travelMin = null;
    applyTravelAvailability();
    updateSummary();
  });
  form.appendChild(addBtn);
}
