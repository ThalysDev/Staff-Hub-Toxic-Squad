// Seção "Comandos" da barra lateral (redesign "Instrumento", v3.2): a visão
// do dia a dia do Agendador — relógio do servidor, aviso de quais aldeias de
// origem precisam de aba aberta e os próximos comandos com contagem ao vivo.
// A central completa (formulário, trem, bloco, mapa) continua sendo aberta
// pelo botão "Novo comando" — mesma lógica de envio, zero mudança no motor.
// Todo texto entra por textContent. Timer único (250 ms), limpo ao sair.

import { icon, type IconName } from '../../core/icons';
import { aimIsHot, calibrateClock, clockInfo, serverNowMs } from '../../core/game-clock';
import { currentWorld } from '../../core/page';
import { clockLabelMs } from '../../ext/core/timing/precise-fire';
import {
  deriveSchedulerCommandStatus,
  SCHEDULER_DEFAULT_WINDOW,
  type ScheduledCommandRecord,
  type ScheduledCommandViewStatus,
} from '../../ext/core/scheduler-state';
import { loadSchedulerState, openSchedulerCommands } from './tsh-commands-ui';
import { kindIcon, unitStrip } from './tsh-units';
import { currentVillageId, isTshEnabled } from './tsh-runtime';
import { openSection } from '../../core/shell';

const STYLE_ID = 'tsh-cmd-section-style';
const STYLES = `
  .tcs { display: flex; flex-direction: column; gap: 16px; }
  .tcs-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .tcs-title { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -.015em; color: var(--shs-ink-strong); }
  .tcs-sub { font-size: 13px; color: var(--shs-muted); margin-top: 4px; }
  .tcs-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .tcs-clock { display: flex; align-items: center; gap: 10px; padding: 4px 4px 4px 12px; border: 1px solid var(--shs-border);
    border-radius: 10px; background: var(--shs-bg-card); }
  .tcs-clock-lbl { font-size: 12px; color: var(--shs-muted); font-weight: 500; }
  .tcs-clock-time { font-family: var(--shs-font-mono); font-size: 16px; font-weight: 500; color: var(--shs-ink-strong); font-variant-numeric: tabular-nums; }
  .tcs-clock-time small { font-size: 16px; color: var(--shs-muted); }
  .tcs-banner { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 14px; border-radius: 10px;
    background: var(--shs-warn-bg); color: var(--shs-warn); font-size: 13px; }
  .tcs-banner--danger { background: var(--shs-danger-bg); color: #8f1d17; }
  .tcs-banner-txt { flex: 1 1 260px; }
  .tcs-banner a { text-decoration: none; }
  .tcs-card { background: var(--shs-bg-card); border: 1px solid var(--shs-border); border-radius: 12px; overflow: hidden; }
  .tcs-card table { margin: 0 !important; background: transparent; }
  .tcs-card th { padding: 12px 14px 8px !important; }
  .tcs-card td { padding: 0 14px !important; height: 44px; }
  .tcs-card tr:last-child td { border-bottom: 0; }
  .tcs-mono { font-family: var(--shs-font-mono); font-variant-numeric: tabular-nums; }
  .tcs-dim { color: var(--shs-muted); }
  .tcs-right { text-align: right !important; }
  .tcs-empty { padding: 32px 16px; text-align: center; color: var(--shs-muted); display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .tcs-kind { font-weight: 500; color: var(--shs-ink-strong); white-space: nowrap; }
  .tcs-kindwrap { display: inline-flex; align-items: center; gap: 8px; }
  .tcs-kindwrap .shs-ic { color: var(--shs-muted); }
`;

const KIND_LABEL: Record<ScheduledCommandRecord['kind'], string> = {
  attack: 'Ataque',
  support: 'Apoio',
  noble: 'Nobre',
  fake: 'Fake',
  cancel: 'Cancelamento',
};

const TERMINAL: ReadonlySet<ScheduledCommandViewStatus> = new Set(['enviado', 'incerto', 'falhou', 'removido']);

function ensureStyles(root: Node): void {
  const shadow = root instanceof ShadowRoot ? root : null;
  if (shadow === null || shadow.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  shadow.appendChild(style);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls !== undefined) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, iconName: IconName, variant: 'pri' | 'sec' | 'gho'): HTMLButtonElement {
  const btn = el('button', variant === 'pri' ? 'shs-btn' : variant === 'sec' ? 'shs-btn shs-btn-ghost' : 'shs-btn shs-btn-ghost shs-btn-sm');
  btn.type = 'button';
  btn.append(icon(iconName, 15), document.createTextNode(label));
  return btn;
}

function coord(point: { x: number; y: number } | undefined): string {
  return point === undefined ? '—' : `${point.x}|${point.y}`;
}

function kindLabel(record: ScheduledCommandRecord): string {
  const base = KIND_LABEL[record.kind];
  const train = record.trainUnits?.length ?? 0;
  return train > 0 ? `${base} ×${train + 1}` : base;
}

/** Chip de estado: âmbar só na mira; vermelho só em falha; verde enviado. */
function statusChip(status: ScheduledCommandViewStatus, otherVillage: boolean): HTMLSpanElement {
  const [label, cls] =
    status === 'janela'
      ? otherVillage
        ? ['Outra aldeia', 'shs-pill shs-pill--warn']
        : ['Na mira', 'shs-pill shs-pill--warn']
      : status === 'enviando'
        ? ['Enviando', 'shs-pill shs-pill--warn']
        : status === 'pausado'
          ? ['Pausado', 'shs-pill shs-pill--muted']
          : status === 'enviado'
            ? ['Enviado', 'shs-pill shs-pill--ok']
            : status === 'falhou'
              ? ['Falhou', 'shs-pill shs-pill--error']
              : status === 'incerto'
                ? ['Incerto', 'shs-pill shs-pill--error']
                : otherVillage
                  ? ['Outra aldeia', 'shs-pill']
                  : ['Agendado', 'shs-pill'];
  return el('span', cls, label);
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'agora';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

/** Contador da barra lateral: comandos vivos (agendados ou na janela). */
export function comandosBadge(): string | null {
  const now = new Date(serverNowMs());
  const vivos = loadSchedulerState(currentWorld()).commands.filter((record) => {
    const st = deriveSchedulerCommandStatus(record, now, SCHEDULER_DEFAULT_WINDOW);
    return !TERMINAL.has(st) && st !== 'pausado'; // mesmo critério da Início
  }).length;
  return vivos > 0 ? String(vivos) : null;
}

export function renderComandosSection(container: HTMLElement): () => void {
  ensureStyles(container.getRootNode());
  const world = currentWorld();
  const shadow = container.getRootNode() as ShadowRoot;
  let timer: number | undefined;
  let disposed = false;
  // Assinatura do estado (id + estado de cada comando): mudou → redesenha.
  const signature = (): string => {
    const t = new Date(serverNowMs());
    return loadSchedulerState(world)
      .commands.map((r) => `${r.id}:${deriveSchedulerCommandStatus(r, t, SCHEDULER_DEFAULT_WINDOW)}`)
      .join('|') + `#${isTshEnabled('command-scheduler') ? 1 : 0}`;
  };
  let lastSig = '';
  let lastSigAt = 0;

  const draw = (): void => {
    // Revisão de código (v3.2): o `draw` também é o rerender da Central — sem
    // esta guarda ele pintava Comandos por cima de outra seção e deixava um
    // timer órfão. Mesmo padrão de tsh-panel.ts.
    if (disposed || !container.isConnected || container.dataset.section !== 'comandos') return;
    lastSig = signature();
    lastSigAt = Date.now();
    container.replaceChildren();
    const root = el('div', 'tcs');

    // ── Cabeçalho: título + relógio + novo comando ──
    const head = el('div', 'tcs-head');
    const titles = el('div');
    titles.append(el('h2', 'tcs-title', 'Comandos'), el('div', 'tcs-sub', 'Agende pela hora do servidor, com milissegundos.'));
    const actions = el('div', 'tcs-actions');
    const clockBox = el('div', 'tcs-clock');
    const clockTime = el('span', 'tcs-clock-time');
    const clockPill = el('span', 'shs-pill');
    const calibrate = button('Calibrar', 'refresh', 'gho');
    calibrate.addEventListener('click', () => {
      calibrate.disabled = true;
      void calibrateClock().finally(() => {
        calibrate.disabled = false;
      });
    });
    clockBox.append(el('span', 'tcs-clock-lbl', 'Servidor'), clockTime, clockPill, calibrate);
    const novo = button('Novo comando', 'plus', 'pri');
    novo.addEventListener('click', () => {
      void openSchedulerCommands(shadow, world, draw, 'form');
    });
    actions.append(clockBox, novo);
    head.append(titles, actions);
    root.appendChild(head);

    const now = serverNowMs();
    const here = currentVillageId();
    const vivos = loadSchedulerState(world)
      .commands.map((record) => ({ record, status: deriveSchedulerCommandStatus(record, new Date(now), SCHEDULER_DEFAULT_WINDOW) }))
      .filter((item) => !TERMINAL.has(item.status))
      .sort((a, b) => Date.parse(a.record.sendAt) - Date.parse(b.record.sendAt));

    // ── Aviso: agendador desligado / origens que precisam de aba ──
    if (!isTshEnabled('command-scheduler')) {
      const banner = el('div', 'tcs-banner tcs-banner--danger');
      const irAuto = button('Ir para Automações', 'zap', 'gho');
      irAuto.addEventListener('click', () => openSection('tsh'));
      banner.append(
        icon('alert', 16),
        el('span', 'tcs-banner-txt', 'O Agendador está desligado: nenhum comando será enviado. Ligue-o em Automações.'),
        irAuto,
      );
      root.appendChild(banner);
    }
    const soon = vivos.filter((item) => Date.parse(item.record.sendAt) - now <= 30 * 60_000);
    const origens = new Map<string, ScheduledCommandRecord>();
    for (const item of soon) origens.set(item.record.sourceVillageId.replace(/^n/, ''), item.record);
    const outras = [...origens.entries()].filter(([id]) => id !== here);
    if (origens.size > 1 || outras.length > 0) {
      const banner = el('div', 'tcs-banner');
      banner.appendChild(icon('alert', 16));
      banner.appendChild(
        el(
          'span',
          'tcs-banner-txt',
          origens.size > 1
            ? `Os próximos 30 min saem de ${origens.size} aldeias. Deixe uma aba na Praça de cada uma.`
            : 'O próximo comando sai de outra aldeia. Deixe uma aba na Praça dela.',
        ),
      );
      for (const [id, record] of outras.slice(0, 3)) {
        const link = el('a', 'shs-btn shs-btn-ghost shs-btn-sm');
        link.href = `/game.php?village=${encodeURIComponent(id)}&screen=place`;
        link.target = '_blank';
        link.rel = 'noopener';
        link.append(icon('arrowRight', 13), document.createTextNode(`Abrir ${coord(record.source)}`));
        banner.appendChild(link);
      }
      root.appendChild(banner);
    }

    // ── Lista dos próximos ──
    const card = el('div', 'tcs-card');
    if (vivos.length === 0) {
      const empty = el('div', 'tcs-empty');
      empty.append(icon('crosshair', 22), el('span', undefined, 'Nenhum comando agendado.'));
      const start = button('Agendar o primeiro', 'plus', 'sec');
      start.addEventListener('click', () => {
        void openSchedulerCommands(shadow, world, draw, 'form');
      });
      empty.appendChild(start);
      card.appendChild(empty);
    } else {
      const table = el('table');
      const thead = el('thead');
      const hr = el('tr');
      for (const [label, right] of [['Envio', false], ['Tipo', false], ['Tropas', false], ['Origem → alvo', false], ['Estado', false], ['Falta', true]] as const) {
        const th = el('th', right ? 'tcs-right' : undefined, label);
        hr.appendChild(th);
      }
      thead.appendChild(hr);
      const tbody = el('tbody');
      for (const { record, status } of vivos.slice(0, 40)) {
        const sendAt = Date.parse(record.sendAt);
        const tr = el('tr');
        tr.appendChild(el('td', 'tcs-mono', clockLabelMs(sendAt)));
        const kindTd = el('td', 'tcs-kind');
        const kindWrap = el('span', 'tcs-kindwrap');
        const kIcon = kindIcon(record.kind, 18);
        kindWrap.append(kIcon ?? icon('x', 15), document.createTextNode(kindLabel(record)));
        kindTd.appendChild(kindWrap);
        tr.appendChild(kindTd);
        const troopsTd = el('td');
        troopsTd.appendChild(
          record.kind === 'cancel'
            ? el('span', 'tcs-dim', `até ${record.cancelCount ?? 1}`)
            : unitStrip(record.percentMode === true ? (record.unitsPercent ?? {}) : record.units, {
                max: 3,
                ...(record.percentMode === true ? { suffix: '%' } : {}),
              }),
        );
        tr.appendChild(troopsTd);
        const route = el('td', 'tcs-mono tcs-dim', `${coord(record.source)} → ${coord(record.target)}`);
        tr.appendChild(route);
        const stTd = el('td');
        stTd.appendChild(statusChip(status, record.sourceVillageId.replace(/^n/, '') !== here));
        tr.appendChild(stTd);
        const eta = el('td', 'tcs-mono tcs-dim tcs-right', formatCountdown(sendAt - now));
        eta.dataset.tcsEta = String(sendAt);
        tr.appendChild(eta);
        tbody.appendChild(tr);
      }
      table.append(thead, tbody);
      card.appendChild(table);
    }
    root.appendChild(card);

    const more = button('Central completa: histórico, bloco e mapa', 'layers', 'gho');
    more.style.alignSelf = 'flex-start';
    more.addEventListener('click', () => {
      void openSchedulerCommands(shadow, world, draw);
    });
    root.appendChild(more);
    container.appendChild(root);

    const tick = (): void => {
      if (aimIsHot()) return;
      const info = clockInfo();
      const t = serverNowMs();
      const label = clockLabelMs(t);
      const dot = label.lastIndexOf('.');
      clockTime.replaceChildren(document.createTextNode(label.slice(0, dot)), el('small', undefined, label.slice(dot)));
      clockPill.textContent = `±${info.uncertaintyMs} ms`;
      clockPill.className = info.uncertaintyMs <= 60 ? 'shs-pill' : 'shs-pill shs-pill--warn';
      // Lista ao vivo: comando enviado/falhou (nesta ou em outra aba) aparece na hora.
      if (Date.now() - lastSigAt >= 1_000) {
        lastSigAt = Date.now();
        if (signature() !== lastSig) {
          draw();
          return;
        }
      }
      for (const cell of root.querySelectorAll<HTMLElement>('[data-tcs-eta]')) {
        cell.textContent = formatCountdown(Number(cell.dataset.tcsEta) - t);
      }
    };
    tick();
    if (timer !== undefined) window.clearInterval(timer);
    timer = window.setInterval(tick, 250);
  };

  draw();
  return () => {
    disposed = true;
    if (timer !== undefined) window.clearInterval(timer);
  };
}
