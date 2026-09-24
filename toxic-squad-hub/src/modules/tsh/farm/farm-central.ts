// Central de Farm (v3.7.0) — SCRIPT DE PÁGINA do Auto Farm. Aparece no topo
// do Assistente de Saque (screen=am_farm) quando o Auto Farm está ligado no
// painel: faixa de status com Iniciar/Parar, as tarefas de farm (Farmar,
// Mapear bárbaras, Quebrar muralha, Cultivar bárbaras) com chave e
// engrenagem, e o Monitoramento (progresso, ação atual, contadores do dia,
// muralhas para quebrar e o diário). Inspirado no que a comunidade usa, com
// desenho nosso. Tudo por textContent; ícones do jogo + nossos.

import { icon, type IconName } from '../../../core/icons';
import { ensureDocumentTheme } from '../../../core/theme';
import { ensureTshPanelStyles } from '../tsh-panel-styles';
import { isTshEnabled, setTshEnabled, tshAutomations, tshStatus } from '../tsh-runtime';
import { openTshSettingsModal, tshConfirm } from '../tsh-settings-ui';
import { unitIcon, unitLabelOrKey } from '../tsh-units';
import { FARM_ID, FarmEngine, farmConfig, requestFarmStop, type FarmState } from './farm-engine';
import type { FarmSkip } from './farm-plan';
import type { ModuleScope } from '../../vanta/vanta-lifecycle';

const HOST_ID = 'tsh-farm-central';

const SKIP_LABEL: Record<FarmSkip, string> = {
  longe: 'longe demais',
  muralha: 'muralha alta',
  'a-caminho': 'ataque a caminho',
  intervalo: 'chegada recente',
  ignorar: 'relatório ignorado',
  'sem-tropa': 'sem tropa',
  'sem-modelo': 'modelo vazio',
  jogador: 'aldeia de jogador',
  'sem-relatorio': 'sem relatório',
};

/** Tropas de ATAQUE que o C do jogo pode levar (caixas marcadas em "Disponibilidade"). */
const OFFENSIVE = ['axe', 'light', 'marcher', 'heavy', 'knight'];
function cOffensiveUnits(): string[] {
  return [...document.querySelectorAll<HTMLInputElement>('#units_home input[type="checkbox"]')]
    .filter((i) => i.checked && OFFENSIVE.includes(i.name))
    .map((i) => i.name);
}

const TASKS: { id: string; label: string; desc: string; icon: IconName; img?: string }[] = [
  { id: FARM_ID, label: 'Farmar', desc: 'Envia A, B ou C pelo Assistente conforme o último relatório de cada alvo.', icon: 'sword' },
  { id: 'map-farm', label: 'Mapear bárbaras', desc: 'Monta a lista de bárbaras por região, distância e pontos.', icon: 'map' },
  { id: 'wall-demolition', label: 'Quebrar muralha', desc: 'Manda aríetes nas bárbaras com muralha.', icon: 'shield', img: 'graphic/buildings/wall.webp' },
  { id: 'barbarian-cultivator', label: 'Cultivar bárbaras', desc: 'Mantém bárbaras pequenas produzindo para você.', icon: 'refresh' },
];

const CSS = `
:host { all: initial; font-family: var(--shs-font); color: var(--shs-ink); font-size: 13px; }
.fc { font-family: var(--shs-font); color: var(--shs-ink); margin: 0 0 10px; }
.fc-bar { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 12px; background: var(--shs-bg-card);
  border: 1px solid var(--shs-border-strong); box-shadow: var(--shs-shadow-sm); flex-wrap: wrap; }
.fc-brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; color: var(--shs-ink-strong); }
.fc-brand .shs-ic { color: var(--shs-action); }
.fc-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--shs-muted); flex: none; }
.fc-dot.on { background: var(--shs-ok); box-shadow: 0 0 0 4px var(--shs-ok-bg); animation: fcpulse 1.6s infinite; }
.fc-dot.wait { background: var(--shs-warn); }
.fc-dot.block { background: var(--shs-danger); }
@keyframes fcpulse { 50% { box-shadow: 0 0 0 7px transparent; } }
.fc-state { font-weight: 600; font-size: 13px; color: var(--shs-ink-strong); }
.fc-detail { flex: 1; min-width: 180px; font-size: 12.5px; color: var(--shs-muted); font-style: italic; }
.fc-warn { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; padding: 8px 12px; border-radius: 10px; background: var(--shs-warn-soft, var(--shs-bg-inset)); border: 1px solid var(--shs-warn); font-size: 12px; color: var(--shs-ink-strong); }
.fc-warn .shs-ic { color: var(--shs-warn); flex: none; }
.fc-grid { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(300px, 1.3fr); gap: 10px; margin-top: 10px; }
@media (max-width: 820px) { .fc-grid { grid-template-columns: 1fr; } }
.fc-card { border-radius: 12px; background: var(--shs-bg-card); border: 1px solid var(--shs-border); padding: 12px; }
.fc-card h3 { margin: 0 0 8px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--shs-muted); display: flex; gap: 6px; align-items: center; }
.fc-task { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--shs-border); }
.fc-task:first-of-type { border-top: 0; }
.fc-task-ic { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; background: var(--shs-bg-inset); color: var(--shs-action); flex: none; }
.fc-task-t { flex: 1; min-width: 0; }
.fc-task-t b { display: block; font-size: 13px; color: var(--shs-ink-strong); }
.fc-task-t small { display: block; font-size: 11px; color: var(--shs-muted); line-height: 1.35; }
.fc-task-t em { display: block; font-size: 11px; font-style: normal; color: var(--shs-action); margin-top: 2px; }
.fc-gear { border: 1px solid var(--shs-border-strong); background: var(--shs-bg-card); border-radius: 8px; width: 30px; height: 30px; display: grid; place-items: center; cursor: pointer; color: var(--shs-ink); }
.fc-gear:hover { border-color: var(--shs-action); color: var(--shs-action); }
.fc-prog { height: 10px; border-radius: 99px; background: var(--shs-bg-inset); overflow: hidden; margin: 6px 0 4px; }
.fc-prog > div { height: 100%; background: var(--shs-action); transition: width .3s; }
.fc-prog-t { display: flex; justify-content: space-between; font-size: 11px; color: var(--shs-muted); }
.fc-now { margin-top: 10px; padding: 8px 10px; border-radius: 8px; background: var(--shs-bg-inset); font-size: 12.5px; color: var(--shs-ink-strong); display: flex; gap: 8px; align-items: flex-start; }
.fc-now .shs-ic { flex: none; margin-top: 2px; color: var(--shs-action); }
.fc-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 10px; }
.fc-stat { border: 1px solid var(--shs-border); border-radius: 8px; padding: 6px; text-align: center; }
.fc-stat b { display: block; font-size: 17px; font-family: var(--shs-font-mono); color: var(--shs-ink-strong); }
.fc-stat span { font-size: 10.5px; color: var(--shs-muted); display: inline-flex; gap: 4px; align-items: center; }
.fc-abc { display: inline-block; width: 24px; height: 24px; background: url("graphic/map/icons_context.webp") no-repeat; vertical-align: middle; }
.fc-abc.a { background-position: -264px 0; } .fc-abc.b { background-position: -288px 0; } .fc-abc.c { background-position: -312px 0; }
.fc-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.fc-chip { font-size: 11px; padding: 1px 8px; border-radius: 99px; background: var(--shs-bg-inset); color: var(--shs-ink); }
.fc-sub { margin-top: 10px; }
.fc-sub summary { cursor: pointer; font-size: 12px; color: var(--shs-action); }
.fc-log { list-style: none; margin: 6px 0 0; padding: 0; max-height: 180px; overflow: auto; font-size: 11.5px; }
.fc-log li { display: flex; gap: 6px; padding: 2px 0; border-bottom: 1px dashed var(--shs-border); }
.fc-log time { font-family: var(--shs-font-mono); color: var(--shs-muted); flex: none; }
.fc-log .ok { color: var(--shs-ok); } .fc-log .recusa { color: var(--shs-danger); } .fc-log .duvida { color: var(--shs-warn); }
.fc-walls { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.fc-walls a { font-size: 11px; padding: 1px 6px; border-radius: 6px; border: 1px solid var(--shs-border); color: var(--shs-ink); text-decoration: none; font-family: var(--shs-font-mono); }
.fc-off { padding: 12px 14px; border-radius: 12px; background: var(--shs-bg-card); border: 1px dashed var(--shs-border-strong); font-size: 12.5px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function btn(label: string, ic: IconName, cls: string): HTMLButtonElement {
  const b = el('button', `tsh-btn ${cls}`);
  b.type = 'button';
  b.append(icon(ic, 12), el('span', 'tsh-btn-txt', label));
  return b;
}

const hhmm = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);
const hhmmss = (ms: number): string => new Date(ms).toTimeString().slice(0, 8);

function stateLabel(s: FarmState): { text: string; dot: string } {
  if (s.phase === 'bloqueado') return { text: 'Bloqueado', dot: 'block' };
  if (!s.running) return { text: 'Parado', dot: '' };
  if (s.phase === 'aguardando') return { text: 'Aguardando a próxima rodada', dot: 'wait' };
  if (s.phase === 'lendo') return { text: 'Lendo o jogo', dot: 'on' };
  return { text: 'Farmando', dot: 'on' };
}

/** Monta a Central na página do Assistente de Saque (idempotente). */
export function mountFarmCentral(scope: ModuleScope, world: string): void {
  const content = document.querySelector('#content_value');
  if (content === null || document.getElementById(HOST_ID) !== null) return;
  ensureDocumentTheme(document);
  const host = scope.owns(el('div'));
  host.id = HOST_ID;
  content.prepend(host);
  const shadow = host.attachShadow({ mode: 'open' });
  ensureTshPanelStyles(shadow);
  const style = el('style');
  style.textContent = CSS;
  shadow.appendChild(style);
  const root = el('div', 'fc');
  shadow.appendChild(root);

  const engine = new FarmEngine(world, (fn, ms) => void scope.after(fn, ms));
  // O que o jogador deixou aberto sobrevive aos redesenhos.
  const open = { log: true, walls: false };
  window.addEventListener('pagehide', () => engine.releaseLock());

  const openConfig = (id: string): void => {
    const automation = tshAutomations().find((a) => a.id === id);
    if (automation !== undefined) openTshSettingsModal(shadow, automation, world, () => render(engine.snapshot));
  };

  /** Começar exige confirmação (uma vez por aba): o que vai sair e de onde. */
  let confirmed = false;
  const askStart = async (): Promise<void> => {
    if (!confirmed) {
      const cfg = farmConfig(world);
      const ofensivas = cOffensiveUnits();
      const usaC = Object.values(cfg.actions).includes('C');
      const nomes = ofensivas.map((u) => unitLabelOrKey(u)).join(', ');
      const ok = await tshConfirm(
        shadow,
        'Começar a farmar?',
        `A Central vai enviar farms de ${cfg.groupId > 0 ? 'um grupo de aldeias' : 'TODAS as suas aldeias'} para alvos até ${cfg.maxDistance} campos, sem parar, enquanto esta aba estiver aberta. ` +
          (usaC && ofensivas.length > 0 ? `Atenção: o C do jogo pode levar ${nomes} (estão marcadas em "Disponibilidade"). ` : '') +
          'O que estiver em "Fica em casa" e as tropas de comandos agendados nunca saem.',
      );
      if (!ok) return;
      confirmed = true;
    }
    engine.start();
  };

  // Redesenhar sem perder o foco de quem usa teclado.
  const focusKey = (): string | null => {
    const a = shadow.activeElement;
    return a instanceof HTMLElement ? (a.dataset.k ?? null) : null;
  };

  const render = (s: FarmState): void => {
    const keep = focusKey();
    root.textContent = '';
    if (!isTshEnabled(FARM_ID)) {
      const off = el('div', 'fc-off');
      const on = btn('Ligar o Auto Farm', 'zap', 'tsh-btn--primary');
      on.addEventListener('click', () => {
        setTshEnabled(FARM_ID, true);
        render(engine.snapshot);
      });
      off.append(icon('sword', 16), el('span', undefined, 'Central de Farm do Toxic Squad Hub: o Auto Farm está desligado.'), on);
      root.appendChild(off);
      return;
    }

    // ── Faixa de status ──
    const bar = el('div', 'fc-bar');
    const brand = el('div', 'fc-brand');
    brand.append(icon('sword', 16), document.createTextNode('Central de Farm'));
    const st = stateLabel(s);
    const dot = el('span', `fc-dot ${st.dot}`);
    const state = el('span', 'fc-state', st.text);
    const detail = el(
      'span',
      'fc-detail',
      s.running && s.nextRoundAt !== null
        ? `Próxima rodada às ${hhmm(s.nextRoundAt)}.`
        : !s.running && s.round === 0 && s.detail === 'Aperte Iniciar para começar.'
          ? 'Aperte Iniciar: a Central farma de todas as aldeias enquanto esta aba estiver aberta.'
          : s.detail,
    );
    detail.setAttribute('role', 'status');
    detail.setAttribute('aria-live', 'polite');
    const go = s.running ? btn('Parar', 'pause', 'tsh-btn--cancel') : btn('Iniciar', 'play', 'tsh-btn--primary');
    go.dataset.k = 'go';
    go.addEventListener('click', () => {
      if (s.running) {
        requestFarmStop(world);
        engine.stop();
      } else if (engine.otherTabRunning()) {
        // Parar a Central que está rodando em OUTRA aba.
        requestFarmStop(world);
      } else void askStart();
    });
    if (!s.running && engine.otherTabRunning()) {
      const t = go.querySelector('.tsh-btn-txt');
      if (t !== null) t.textContent = 'Parar a outra aba';
    }
    bar.append(brand, dot, state, detail, go);
    root.appendChild(bar);

    // Alerta: o C do jogo pode levar tropa de ataque.
    const ofensivas = cOffensiveUnits();
    if (ofensivas.length > 0 && Object.values(farmConfig(world).actions).includes('C')) {
      const warn = el('div', 'fc-warn');
      warn.appendChild(icon('alert', 14));
      warn.appendChild(el('span', undefined, 'O C do jogo pode mandar tropa de ataque:'));
      for (const u of ofensivas) warn.appendChild(unitIcon(u, 18));
      warn.appendChild(el('span', undefined, 'Desmarque em "Disponibilidade" (logo abaixo) ou use "Fica em casa" nas configurações.'));
      root.appendChild(warn);
    }

    const grid = el('div', 'fc-grid');
    // ── Tarefas ──
    const tasks = el('div', 'fc-card');
    const th = el('h3');
    th.append(icon('settings', 11), document.createTextNode('Tarefas de farm'));
    tasks.appendChild(th);
    for (const t of TASKS) {
      const auto = tshAutomations().find((a) => a.id === t.id);
      if (auto === undefined) continue;
      const row = el('div', 'fc-task');
      const ic = el('span', 'fc-task-ic');
      if (t.img !== undefined) {
        const img = el('img');
        img.src = t.img;
        img.width = img.height = 18;
        img.alt = '';
        ic.appendChild(img);
      } else ic.appendChild(icon(t.icon, 16));
      const txt = el('div', 'fc-task-t');
      txt.append(el('b', undefined, t.label), el('small', undefined, t.desc));
      const status = t.id === FARM_ID ? null : tshStatus(t.id, world);
      if (status !== null) txt.appendChild(el('em', undefined, status.message.slice(0, 110)));
      const sw = el('label', 'tsh-switch');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = isTshEnabled(t.id);
      input.setAttribute('aria-label', `${t.label} ligado`);
      input.dataset.k = `sw-${t.id}`;
      input.addEventListener('change', () => {
        setTshEnabled(t.id, input.checked);
        if (t.id === FARM_ID && !input.checked) engine.stop('O Auto Farm foi desligado.');
        render(engine.snapshot);
      });
      sw.append(input, el('span', 'tsh-switch-track'));
      const gear = el('button', 'fc-gear');
      gear.type = 'button';
      gear.title = `Configurar — ${t.label}`;
      gear.setAttribute('aria-label', `Configurar ${t.label}`);
      gear.appendChild(icon('settings', 14));
      gear.dataset.k = `gear-${t.id}`;
      gear.addEventListener('click', () => openConfig(t.id));
      row.append(ic, txt, sw, gear);
      tasks.appendChild(row);
    }
    grid.appendChild(tasks);

    // ── Monitoramento ──
    const mon = el('div', 'fc-card');
    const mh = el('h3');
    mh.append(icon('activity', 11), document.createTextNode(`Monitoramento${s.round > 0 ? ` — rodada ${s.round}` : ''}`));
    mon.appendChild(mh);
    const pct = s.progress.total > 0 ? Math.round((s.progress.done / s.progress.total) * 100) : 0;
    const prog = el('div', 'fc-prog');
    const fill = el('div');
    fill.style.width = `${pct}%`;
    prog.appendChild(fill);
    const pt = el('div', 'fc-prog-t');
    pt.append(
      el('span', undefined, s.progress.total > 0 ? `${s.progress.done} de ${s.progress.total} farms` : s.running && s.phase === 'lendo' ? 'Lendo o jogo…' : 'Sem rodada em andamento'),
      el('span', undefined, `${pct}%`),
    );
    const now = el('div', 'fc-now');
    now.append(icon('info', 13), el('span', undefined, s.detail));
    mon.append(prog, pt, now);

    const stats = el('div', 'fc-stats');
    const stat = (n: number, label: string, abc?: 'a' | 'b' | 'c'): HTMLDivElement => {
      const d = el('div', 'fc-stat');
      const l = el('span');
      if (abc !== undefined) {
        const i = el('i', `fc-abc ${abc}`);
        i.setAttribute('role', 'img');
        i.setAttribute('aria-label', `Enviados com ${abc.toUpperCase()}`);
        l.appendChild(i);
      }
      l.appendChild(document.createTextNode(label));
      d.append(el('b', undefined, n.toLocaleString('pt-BR')), l);
      return d;
    };
    stats.append(stat(s.sent.A, 'hoje', 'a'), stat(s.sent.B, 'hoje', 'b'), stat(s.sent.C, 'hoje', 'c'), stat(s.refused, 'recusas hoje'));
    mon.appendChild(stats);

    if (s.lastRound !== null) {
      const chips = el('div', 'fc-chips');
      chips.appendChild(el('span', 'fc-chip', `${s.lastRound.targets} alvos · ${s.lastRound.villages} aldeias`));
      for (const [k, n] of Object.entries(s.lastRound.skipped)) {
        if ((n ?? 0) > 0) chips.appendChild(el('span', 'fc-chip', `${SKIP_LABEL[k as FarmSkip] ?? k} · ${n}`));
      }
      mon.appendChild(chips);
    }
    if (s.walls.length > 0) {
      const walls = el('details', 'fc-sub');
      walls.open = open.walls;
      walls.addEventListener('toggle', () => {
        open.walls = walls.open;
      });
      walls.appendChild(el('summary', undefined, `Muralhas para quebrar (${s.walls.length})`));
      const list = el('div', 'fc-walls');
      for (const w of s.walls) {
        const a = el('a', undefined, `${w.x}|${w.y} · ${w.wall}`);
        a.href = `/game.php?screen=place&target=${encodeURIComponent(w.targetId)}`;
        a.title = `Muralha nível ${w.wall} — abrir na Praça`;
        list.appendChild(a);
      }
      walls.appendChild(list);
      mon.appendChild(walls);
    }
    const logBox = el('details', 'fc-sub');
    logBox.open = open.log;
    logBox.addEventListener('toggle', () => {
      open.log = logBox.open;
    });
    logBox.appendChild(el('summary', undefined, 'Diário da Central'));
    const ul = el('ul', 'fc-log');
    for (const e of s.log.slice(0, 40)) {
      const li = el('li');
      li.append(el('time', undefined, hhmmss(e.at)), el('span', e.kind, e.text));
      ul.appendChild(li);
    }
    if (s.log.length === 0) ul.appendChild(el('li', undefined, 'Nada ainda.'));
    logBox.appendChild(ul);
    mon.appendChild(logBox);
    grid.appendChild(mon);
    root.appendChild(grid);
    if (keep !== null) root.querySelector<HTMLElement>(`[data-k="${keep}"]`)?.focus();
  };

  engine.onChange(render);
  // Script de página: ligado e "rodando" antes de a página recarregar = continua sozinho.
  if (isTshEnabled(FARM_ID) && engine.shouldResume()) {
    confirmed = true; // já tinha sido confirmado antes de a página recarregar
    scope.after(() => engine.start(), 1500);
  }
  // O status das outras tarefas muda fora daqui: refresca de tempos em tempos.
  scope.every(() => {
    if (!engine.snapshot.running) render(engine.snapshot);
  }, 15_000);
}
