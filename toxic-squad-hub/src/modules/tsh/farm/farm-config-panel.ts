// Tela "Configurar — Auto Farm" (v3.7.0): a mesma abre pela Central de Farm
// (engrenagem do Farmar) e pelo painel de Automações. Ícones do JOGO para cada
// tipo de relatório (bolinhas e saque cheio/parcial) e tropas; ícones nossos
// para as seções. Tudo por textContent.

import { icon, type IconName } from '../../../core/icons';
import { getGroupOptions } from '../tsh-groups';
import type { TshSettingsPanel } from '../tsh-runtime';
import { unitIcon, unitLabelOrKey } from '../tsh-units';
import { DEFAULT_FARM_CONFIG, FARM_ACTIONS, readFarmConfig, REPORT_KINDS, type FarmAction, type FarmConfig, type ReportKind } from './farm-plan';

const KIND_INFO: Record<ReportKind, { dot: string; loot?: '0' | '1'; label: string; tip: string }> = {
  'verde-cheio': { dot: 'green', loot: '1', label: 'Vitória — voltou cheio', tip: 'Sobrou recurso lá.' },
  'verde-parcial': { dot: 'green', loot: '0', label: 'Vitória — esvaziou a aldeia', tip: 'Levou tudo o que havia.' },
  'amarelo-cheio': { dot: 'yellow', loot: '1', label: 'Com perdas — voltou cheio', tip: 'Houve perdas; sobrou recurso.' },
  'amarelo-parcial': { dot: 'yellow', loot: '0', label: 'Com perdas — esvaziou', tip: 'Houve perdas; a aldeia ficou vazia.' },
  azul: { dot: 'blue', label: 'Só explorado', tip: 'Exploradores viram a aldeia; ainda sem saque.' },
  'vermelho-azul': { dot: 'red_blue', label: 'Derrota, mas explorou', tip: 'Tem defesa; os exploradores viram.' },
  vermelho: { dot: 'red', label: 'Derrota', tip: 'Tem defesa: perdeu tudo.' },
};

const ACTION_LABEL: Record<FarmAction, string> = { A: 'Modelo A', B: 'Modelo B', C: 'C (o jogo calcula)', ignorar: 'Não atacar' };
const KEEP_UNITS = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'knight'] as const;

const CSS = `
.fc-note { display: flex; gap: 8px; padding: 8px 10px; margin: 0 0 14px; border-radius: 8px; background: var(--shs-ok-bg); font-size: 12px; line-height: 1.4; color: var(--shs-ink-strong); }
.fc-note .shs-ic { flex: none; margin-top: 1px; color: var(--shs-ok); }
.fc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 6px; }
.fc-rep { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--shs-border); border-radius: 8px; background: var(--shs-bg-card); }
.fc-rep-ic { display: flex; gap: 3px; flex: none; width: 38px; align-items: center; }
.fc-rep-l { flex: 1; min-width: 0; font-size: 12px; color: var(--shs-ink-strong); }
.fc-rep-l small { display: block; font-size: 10.5px; color: var(--shs-muted); }
.fc-rec { font-size: 11.5px; color: var(--shs-ink); margin: 0 0 8px; line-height: 1.4; }
.fc-secs { font-size: 11px; color: var(--shs-muted); margin-left: 6px; white-space: nowrap; }
@media (max-width: 420px) { .fc-rep { flex-wrap: wrap; } .fc-rep select { width: 100%; } }
.fc-rep select { width: 150px; }
.fc-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0; }
.fc-row-l { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--shs-ink-strong); }
.fc-row-l small { display: block; font-size: 11px; color: var(--shs-muted); }
.fc-row .tsh-input { width: 96px; }
.fc-row select.tsh-input { width: 170px; }
.fc-units { display: flex; flex-wrap: wrap; gap: 6px; }
.fc-unit { display: flex; align-items: center; gap: 4px; }
.fc-unit .tsh-input { width: 70px; }
.fc-hint { font-size: 11px; color: var(--shs-muted); margin-top: 6px; line-height: 1.35; }
.fc-cunits { display: inline-flex; gap: 2px; vertical-align: middle; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function gameImg(path: string, size: number, alt: string): HTMLImageElement {
  const img = el('img');
  img.src = path;
  img.alt = img.title = alt;
  img.width = img.height = size;
  return img;
}

function section(title: string, ic: IconName): { box: HTMLDivElement; body: HTMLDivElement } {
  const box = el('div', 'tsh-section');
  const head = el('div', 'tsh-section-title');
  head.append(icon(ic, 12), document.createTextNode(title));
  const body = el('div');
  box.append(head, body);
  return { box, body };
}

function num(value: number, min: number, max: number, step: number, label: string): HTMLInputElement {
  const i = el('input', 'tsh-input tsh-input--num');
  i.type = 'number';
  i.min = String(min);
  i.max = String(max);
  i.step = String(step);
  i.value = String(value);
  i.setAttribute('aria-label', label);
  return i;
}

function row(left: HTMLElement | SVGSVGElement, title: string, hint: string, control: HTMLElement): HTMLDivElement {
  const r = el('div', 'fc-row');
  const l = el('div', 'fc-row-l');
  const t = el('span', undefined, title);
  if (hint !== '') t.appendChild(el('small', undefined, hint));
  l.append(left, t);
  r.append(l, control);
  return r;
}

function toggle(checked: boolean, label: string): { wrap: HTMLLabelElement; input: HTMLInputElement } {
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('aria-label', label);
  const wrap = el('label', 'tsh-switch');
  wrap.append(input, el('span', 'tsh-switch-track'));
  return { wrap, input };
}

/** Tropas que o botão C do jogo pode usar (caixas de "Disponibilidade" nesta página). */
function cUnitsOnPage(): string[] {
  return [...document.querySelectorAll<HTMLInputElement>('#units_home input[type="checkbox"]')].filter((i) => i.checked).map((i) => i.name);
}

export function buildFarmConfigPanel(settings: Record<string, unknown>): TshSettingsPanel {
  const cfg = readFarmConfig(settings.farm);
  const root = el('div');
  const style = el('style');
  style.textContent = CSS;
  root.appendChild(style);

  const top = el('div');
  const note = el('div', 'fc-note');
  note.append(
    icon('shieldCheck', 14),
    el('span', undefined, 'A Central de Farm roda na página do Assistente de Saque, com o botão Iniciar. Comandos do Agendador vêm primeiro: as tropas deles ficam em casa.'),
  );
  top.appendChild(note);

  // ── Ações por relatório ──
  const acts = section('O que fazer com cada relatório', 'note');
  const grid = el('div', 'fc-grid');
  const selects = new Map<ReportKind, HTMLSelectElement>();
  for (const kind of REPORT_KINDS) {
    const info = KIND_INFO[kind];
    const box = el('div', 'fc-rep');
    box.title = info.tip;
    const ic = el('span', 'fc-rep-ic');
    ic.appendChild(gameImg(`graphic/dots/${info.dot}.webp`, 16, info.label));
    if (info.loot !== undefined) ic.appendChild(gameImg(`graphic/max_loot/${info.loot}.webp`, 16, info.loot === '1' ? 'Saque cheio' : 'Saque parcial'));
    const sel = el('select', 'tsh-input');
    sel.setAttribute('aria-label', info.label);
    for (const a of FARM_ACTIONS) {
      const o = el('option', undefined, ACTION_LABEL[a]);
      o.value = a;
      sel.appendChild(o);
    }
    sel.value = cfg.actions[kind];
    selects.set(kind, sel);
    const lab = el('span', 'fc-rep-l', info.label);
    lab.appendChild(el('small', undefined, info.tip));
    box.append(ic, lab, sel);
    grid.appendChild(box);
  }
  const fb = el('select', 'tsh-input');
  for (const [v, t] of [['A', 'Usar o modelo A'], ['B', 'Usar o modelo B'], ['ignorar', 'Não atacar']] as const) {
    const o = el('option', undefined, t);
    o.value = v;
    fb.appendChild(o);
  }
  fb.value = cfg.cFallback;
  const cNote = el('div', 'fc-hint');
  const cu = cUnitsOnPage();
  cNote.append(document.createTextNode('O C do jogo calcula as tropas pelo último relatório de exploradores e só usa as tropas marcadas em "Disponibilidade" no Assistente'));
  if (cu.length > 0) {
    cNote.append(document.createTextNode(' (agora: '));
    const icons = el('span', 'fc-cunits');
    for (const u of cu) icons.appendChild(unitIcon(u, 14));
    cNote.append(icons, document.createTextNode(')'));
  }
  cNote.append(document.createTextNode('. Desmarque lá as tropas que não devem farmar (ex.: bárbaros de full).'));
  const rec = el('div', 'fc-rec', 'Recomendado: voltou cheio → C (o jogo calcula o necessário) · esvaziou → A (tropa pequena) · com perdas → B (mais forte) · derrota → não atacar.');
  acts.body.append(rec, grid, row(icon('swap', 14), 'Se o C não tiver relatório', 'Alvo sem exploração recente.', fb), cNote);
  root.appendChild(acts.box);

  // ── Alcance e alvos ──
  const reach = section('Alvos', 'target');
  const dist = num(cfg.maxDistance, 1, 200, 1, 'Distância máxima');
  const wall = el('select', 'tsh-input');
  wall.setAttribute('aria-label', 'Muralha máxima');
  const wo = el('option', undefined, 'Não olhar a muralha');
  wo.value = '-1';
  wall.appendChild(wo);
  for (let n = 0; n <= 20; n++) {
    const o = el('option', undefined, n === 0 ? 'Só sem muralha (0)' : `Até nível ${n}`);
    o.value = String(n);
    wall.appendChild(o);
  }
  wall.value = String(cfg.maxWall);
  const attacked = toggle(cfg.skipAttacked, 'Pular alvo com ataque a caminho');
  const players = toggle(cfg.farmPlayers, 'Farmar aldeias de jogadores');
  const gap = num(cfg.targetIntervalMin, 0, 1440, 1, 'Intervalo entre chegadas no mesmo alvo');
  reach.body.append(
    row(gameImg('graphic/rechts.webp', 14, 'Distância'), 'Distância máxima (campos)', 'Cada alvo vai para a SUA aldeia mais próxima com tropa.', dist),
    row(gameImg('graphic/buildings/wall.webp', 16, 'Muralha'), 'Muralha máxima do alvo', 'Acima disso o alvo não é farmado e aparece em "Muralhas para quebrar".', wall),
    row(gameImg('graphic/command/attack.png', 14, 'Ataque a caminho'), 'Pular alvo com ataque a caminho', 'O jogo marca na lista quando você já tem ataque indo.', attacked.wrap),
    row(icon('clock', 14), 'Espaço mínimo entre farms no mesmo alvo (min)', 'Dois farms não chegam no mesmo alvo com menos que isso de diferença (conta os ataques já a caminho).', gap),
    row(icon('user', 14), 'Farmar aldeias de jogadores', 'Desligado = só bárbaras. Aldeia de jogador na lista do Assistente só é farmada com isto ligado.', players.wrap),
  );
  root.appendChild(reach.box);

  // ── Origem e tropas ──
  const origin = section('De onde sai', 'home');
  const group = el('select', 'tsh-input');
  group.setAttribute('aria-label', 'Grupo de aldeias');
  const all = el('option', undefined, 'Todas as aldeias');
  all.value = '0';
  group.appendChild(all);
  if (cfg.groupId > 0) {
    const cur = el('option', undefined, `Grupo ${cfg.groupId}`);
    cur.value = String(cfg.groupId);
    group.appendChild(cur);
  }
  group.value = String(cfg.groupId);
  const groupErr = el('div', 'fc-hint');
  void getGroupOptions()
    .then((gs) => {
      if (gs.length === 0) groupErr.textContent = 'Você ainda não tem grupos de aldeias (Visualizações → Grupos).';
      const chosen = group.value;
      for (const g of gs) {
        if (group.querySelector(`option[value="${g.groupId}"]`) !== null) {
          const o = group.querySelector<HTMLOptionElement>(`option[value="${g.groupId}"]`);
          if (o !== null) o.textContent = g.name;
          continue;
        }
        const o = el('option', undefined, g.name);
        o.value = String(g.groupId);
        group.appendChild(o);
      }
      group.value = chosen;
    })
    .catch(() => {
      groupErr.textContent = 'Não consegui carregar seus grupos agora.';
    });
  const sched = toggle(cfg.respectScheduler, 'Respeitar comandos agendados');
  const keepWrap = el('div', 'fc-units');
  const keeps = KEEP_UNITS.map((u) => {
    const w = el('label', 'fc-unit');
    w.title = `${unitLabelOrKey(u)}: fica em casa`;
    const i = num(cfg.keepHome[u] ?? 0, 0, 1_000_000, 10, `${unitLabelOrKey(u)}: fica em casa`);
    w.append(unitIcon(u, 18), i);
    keepWrap.appendChild(w);
    return { u, i };
  });
  origin.body.append(
    row(icon('users', 14), 'Aldeias que farmam', 'Um grupo seu ou todas.', group),
    groupErr,
    row(icon('calendar', 14), 'Respeitar comandos agendados', 'Tropas de comandos do Agendador nas próximas 6 h ficam em casa.', sched.wrap),
    el('div', 'fc-hint', 'Deixar em casa, em cada aldeia (0 = pode usar tudo) — use para proteger seu full:'),
    keepWrap,
  );
  root.appendChild(origin.box);

  // ── Ritmo ──
  const pace = section('Ritmo', 'activity');
  const pause = num(cfg.pauseMs, 250, 10_000, 50, 'Pausa entre ataques');
  const vpause = num(cfg.villagePauseMs, 250, 60_000, 100, 'Pausa ao trocar de aldeia');
  const jit = num(cfg.jitterPct, 0, 100, 5, 'Variação das pausas');
  const roundP = num(cfg.roundPauseMin, 1, 240, 1, 'Intervalo entre rodadas');
  const secs = (i: HTMLInputElement): HTMLSpanElement => {
    const s = el('span', 'fc-secs');
    const upd = (): void => {
      s.textContent = `= ${(Number(i.value) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} s`;
    };
    i.addEventListener('input', upd);
    upd();
    return s;
  };
  const withSecs = (i: HTMLInputElement): HTMLSpanElement => {
    const w = el('span');
    w.append(i, secs(i));
    return w;
  };
  pace.body.append(
    row(icon('zap', 14), 'Pausa entre ataques (ms)', 'O jogo aceita no mínimo 200 ms.', withSecs(pause)),
    row(icon('swap', 14), 'Pausa ao trocar de aldeia (ms)', '', withSecs(vpause)),
    row(icon('activity', 14), 'Variação das pausas (%)', 'Deixa o ritmo menos robótico.', jit),
    row(icon('refresh', 14), 'Intervalo entre rodadas (min)', 'Rodada = uma passada por todos os alvos. Depois dela, espera isso e recomeça.', roundP),
  );
  root.appendChild(pace.box);

  return {
    el: root,
    top,
    hideCooldown: true,
    collect: () => {
      const actions = { ...DEFAULT_FARM_CONFIG.actions };
      for (const [k, s] of selects) actions[k] = s.value as FarmAction;
      const keepHome: Record<string, number> = {};
      for (const { u, i } of keeps) {
        const n = Number(i.value || '0');
        if (!Number.isInteger(n) || n < 0) {
          i.focus();
          return { ok: false, error: `"Fica em casa" de ${unitLabelOrKey(u)}: use um número inteiro (0 ou mais).` };
        }
        if (n > 0) keepHome[u] = n;
      }
      const next: FarmConfig = {
        actions,
        cFallback: fb.value as FarmConfig['cFallback'],
        maxDistance: Number(dist.value),
        maxWall: Number(wall.value),
        skipAttacked: attacked.input.checked,
        targetIntervalMin: Number(gap.value),
        keepHome,
        pauseMs: Number(pause.value),
        villagePauseMs: Number(vpause.value),
        jitterPct: Number(jit.value),
        roundPauseMin: Number(roundP.value),
        groupId: Number(group.value),
        respectScheduler: sched.input.checked,
        farmPlayers: players.input.checked,
      };
      const checks: [HTMLInputElement, boolean, string][] = [
        [dist, next.maxDistance >= 1 && next.maxDistance <= 200, 'Distância máxima: de 1 a 200 campos.'],
        [gap, next.targetIntervalMin >= 0 && next.targetIntervalMin <= 1440, 'Chegadas no mesmo alvo: de 0 a 1440 minutos.'],
        [pause, Number.isInteger(next.pauseMs) && next.pauseMs >= 250 && next.pauseMs <= 10_000, 'Pausa entre ataques: de 250 a 10.000 ms.'],
        [vpause, Number.isInteger(next.villagePauseMs) && next.villagePauseMs >= 250 && next.villagePauseMs <= 60_000, 'Pausa ao trocar de aldeia: de 250 a 60.000 ms.'],
        [jit, Number.isInteger(next.jitterPct) && next.jitterPct >= 0 && next.jitterPct <= 100, 'Variação: de 0 a 100%.'],
        [roundP, next.roundPauseMin >= 1 && next.roundPauseMin <= 240, 'Intervalo entre rodadas: de 1 a 240 minutos.'],
      ];
      for (const [input, ok, msg] of checks) {
        if (!ok) {
          input.classList.add('tsh-input--invalid');
          input.focus();
          return { ok: false, error: msg };
        }
      }
      return { ok: true, values: { farm: next } };
    },
  };
}
