// Seção "Início" (redesign "Instrumento", v3.2): o próximo cravado em
// destaque com contagem em ms, três números (comandos, automações, precisão
// real das chegadas conferidas), a atividade das automações ligadas e o
// suporte. Classes próprias (home-*) com <style> idempotente no shadow.

import { icon, type IconName } from '../core/icons';
import { gm } from '../core/storage';
import { haltLabel, haltState } from '../core/halt';
import { tryResume } from '../core/halt-bar';
import { currentWorld } from '../core/page';
import { openSection } from '../core/shell';
import { isVantaEnabled, vantaLaunchers } from './vanta/vanta-registry';
import { currentVillageId, isTshEnabled, tshArmedUntil, tshAutomations, tshNextRunAt, tshStatus } from './tsh/tsh-runtime';
import { loadSchedule, isScheduleStopped } from './tsh/tsh-settings';
import { tshPanelSignature } from './tsh/tsh-panel';
import { aimIsHot, clockInfo, serverNowMs } from '../core/game-clock';
import { clockLabelMs } from '../ext/core/timing/precise-fire';

export const SUPPORT_PHONE = '+55 81 99413-1872';
const SUPPORT_WA = 'https://wa.me/5581994131872';

const HOME_STYLE_ID = 'tsh-home-styles';
const HOME_CSS = `
  .home { display: flex; flex-direction: column; gap: 16px; }
  .home-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .home-title { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -.015em; color: var(--shs-ink-strong); }
  .home-sub { font-size: 13px; color: var(--shs-muted); margin-top: 4px; }
  .home-card { background: var(--shs-bg-card); border: 1px solid var(--shs-border); border-radius: 12px; padding: 16px 18px; }
  .home-card--halt { border: 1.5px solid var(--shs-danger); }
  .home-halt-title { display: flex; align-items: center; gap: 10px; margin: 0 0 8px; font-size: 15px; font-weight: 600; color: var(--shs-ink-strong); }
  .home-halt-ic { width: 30px; height: 30px; border-radius: 8px; background: var(--shs-danger); color: #fff; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .home-line { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: var(--shs-ink); margin-top: 6px; line-height: 1.45; }
  .home-line svg { color: var(--shs-muted); flex-shrink: 0; margin-top: 2px; }
  .home-resume { margin-top: 12px; }
  .home-resume-err { margin-top: 8px; color: var(--shs-danger); font-weight: 600; font-size: 13px; }
  .home-hero { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; padding: 20px 22px; }
  .home-hero--aim { border-color: #ebcf98; background: #fffcf6; }
  .home-hero-main { display: flex; flex-direction: column; gap: 10px; flex: 1 1 320px; min-width: 0; }
  .home-chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .home-count { font-family: var(--shs-font-mono); font-size: 42px; font-weight: 500; letter-spacing: -.02em; line-height: 1;
    color: var(--shs-ink-strong); font-variant-numeric: tabular-nums; }
  .home-count small { font-size: 42px; color: var(--shs-brass); }
  .home-route { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; color: var(--shs-ink); }
  .home-route .m { font-family: var(--shs-font-mono); font-variant-numeric: tabular-nums; }
  .home-route .sep { color: var(--shs-ink-disabled); }
  .home-hero-side { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
  .home-empty-title { font-size: 15px; font-weight: 600; color: var(--shs-ink-strong); }
  .home-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .home-stat { display: flex; flex-direction: column; gap: 6px; }
  .home-stat-lbl { font-size: 12px; color: var(--shs-muted); font-weight: 500; }
  .home-stat-val { font-family: var(--shs-font-mono); font-size: 24px; font-weight: 500; color: var(--shs-ink-strong); font-variant-numeric: tabular-nums; line-height: 1.1; }
  .home-stat-val small { font-size: 15px; color: var(--shs-muted); }
  .home-stat-hint { font-size: 12px; color: var(--shs-muted); line-height: 1.4; }
  .home-list { padding: 0; overflow: hidden; }
  .home-list-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--shs-border); }
  .home-list-head b { font-size: 14px; font-weight: 600; color: var(--shs-ink-strong); }
  .home-linkbtn { background: none; border: 0; padding: 4px 0; font: inherit; font-size: 12.5px; font-weight: 500; color: var(--shs-action); cursor: pointer; }
  .home-linkbtn:hover { color: var(--shs-action-hover); text-decoration: underline; }
  .home-act { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 6px 18px; border-bottom: 1px solid var(--shs-bg-inset); font-size: 13px; }
  .home-act:last-child { border-bottom: none; }
  .home-act-name { font-weight: 500; color: var(--shs-ink-strong); flex: 0 0 190px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .home-act-msg { flex: 1; min-width: 0; color: var(--shs-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .home-act-next { font-family: var(--shs-font-mono); font-size: 12.5px; color: var(--shs-ink); font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .home-act-empty { padding: 20px 18px; color: var(--shs-muted); font-size: 13px; }
  .home-support { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 12.5px; color: var(--shs-muted); }
  .home-phone { font-family: var(--shs-font-mono); color: var(--shs-ink-strong); font-variant-numeric: tabular-nums; }
  @media (max-width: 720px) { .home-stats { grid-template-columns: 1fr; } .home-act-name { flex-basis: 130px; } }
`;

function ensureHomeStyles(container: HTMLElement): void {
  const root = container.getRootNode() as ShadowRoot | Document;
  if (root instanceof ShadowRoot && root.getElementById?.(HOME_STYLE_ID) === null) {
    const style = document.createElement('style');
    style.id = HOME_STYLE_ID;
    style.textContent = HOME_CSS;
    root.appendChild(style);
  }
}

/** Cartão da home; título nulo = card sem heading (o conteúdo abre o card —
 *  ver card da conta, [8]). */

function line(iconName: IconName, text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'home-line';
  el.appendChild(icon(iconName, 13));
  el.appendChild(document.createTextNode(text));
  return el;
}


// [1] Status terminais do histórico do agendador (mesmo critério de
// vivos×histórico da tela Comandos — tsh-commands-ui.ts/scheduler-state):
// registro com o ÚLTIMO evento nesses estados é passado e não conta.
const EVENTOS_TERMINAIS: ReadonlySet<string> = new Set(['enviado', 'incerto', 'falhou', 'removido']);

interface CommandRecordLike {
  sendAt?: unknown;
  paused?: unknown;
  events?: unknown;
  sourceVillageId?: unknown;
  sourceName?: unknown;
  source?: unknown;
  kind?: unknown;
  target?: unknown;
  arrivalAt?: unknown;
}

/** Origem do próximo comando (para dizer QUAL aba precisa estar aberta). */
export interface NextSource {
  villageId: string;
  label: string;
}

/**
 * Próximo comando agendado do mundo (storage do agendador).
 * [1] Conta só registros VIVOS: `paused !== true` e o ÚLTIMO evento de
 * `events` sem status terminal — o histórico (enviado/incerto/falhou/removido)
 * e os pausados deixaram de inflar o número. nextAt = menor sendAt futuro
 * ENTRE os vivos. Onda 1: devolve também a ORIGEM do próximo (o lock é por
 * aldeia — cada origem precisa da própria aba) e quantos saem em 30 min.
 */
export function nextScheduled(world: string): {
  count: number;
  nextAt: number | null;
  nextSource: NextSource | null;
  soon30: number;
  nextKind: string | null;
  nextTarget: string | null;
  nextArrivalAt: number | null;
} {
  const state = gm.get<{ commands?: unknown[] }>(`tsh-auto:${world}:command-scheduler:scheduler`, {});
  const commands = Array.isArray(state.commands) ? state.commands : [];
  const vivos = commands.filter((raw): raw is CommandRecordLike => {
    if (typeof raw !== 'object' || raw === null) return false;
    const record = raw as CommandRecordLike;
    if (record.paused === true) return false;
    const events = Array.isArray(record.events) ? (record.events as { status?: unknown }[]) : [];
    const ultimo = events.at(-1);
    return !(ultimo !== undefined && typeof ultimo.status === 'string' && EVENTOS_TERMINAIS.has(ultimo.status));
  });
  // Onda C: sendAt está no relógio do SERVIDOR — compara com o "agora" dele.
  const agora = serverNowMs();
  const future = vivos
    .map((c) => ({ c, t: Date.parse(typeof c.sendAt === 'string' ? c.sendAt : '') }))
    .filter((x) => Number.isFinite(x.t) && x.t > agora)
    .sort((a, b) => a.t - b.t);
  const first = future[0];
  let nextSource: NextSource | null = null;
  if (first !== undefined && typeof first.c.sourceVillageId === 'string') {
    const src = first.c.source as { x?: unknown; y?: unknown } | undefined;
    const coord = src !== undefined && typeof src.x === 'number' && typeof src.y === 'number' ? `${src.x}|${src.y}` : '';
    const name = typeof first.c.sourceName === 'string' ? first.c.sourceName : '';
    nextSource = {
      villageId: first.c.sourceVillageId.replace(/^n/, ''),
      label: name !== '' && coord !== '' ? `${name} (${coord})` : name !== '' ? name : coord !== '' ? coord : `aldeia ${first.c.sourceVillageId}`,
    };
  }
  const soon30 = future.filter((x) => x.t - agora <= 30 * 60_000).length;
  const tgt = first?.c.target as { x?: unknown; y?: unknown } | undefined;
  const arrival = first !== undefined && typeof first.c.arrivalAt === 'string' ? Date.parse(first.c.arrivalAt) : NaN;
  return {
    count: vivos.length,
    nextAt: first?.t ?? null,
    nextSource,
    soon30,
    nextKind: first !== undefined && typeof first.c.kind === 'string' ? first.c.kind : null,
    nextTarget: tgt !== undefined && typeof tgt.x === 'number' && typeof tgt.y === 'number' ? `${tgt.x}|${tgt.y}` : null,
    nextArrivalAt: Number.isFinite(arrival) ? arrival : null,
  };
}

/** Assinatura do que a Início mostra (muda → redesenha; Onda B "ao vivo"). */
function homeSignature(world: string): string {
  const sched = nextScheduled(world);
  const vanta = vantaLaunchers()
    .map((l) => (isVantaEnabled(l.id) ? 1 : 0))
    .join('');
  const halt = haltState();
  return `${tshPanelSignature(world)}#${vanta}#${sched.count}:${sched.nextAt ?? ''}#${halt?.at ?? ''}`;
}

/**
 * Seção "Início" — registrada em main.ts como primeira entrada da sidebar.
 * Onda B: o Painel de Atividades é AO VIVO (verifica a cada 3s e redesenha
 * quando algo muda); devolve a limpeza do timer ao shell.
 */
export function renderHome(container: HTMLElement): () => void {
  const world = currentWorld();
  drawHome(container);
  let signature = homeSignature(world);
  const timer = window.setInterval(() => {
    if (aimIsHot()) return; // reta final de um cravado nesta página
    const now = homeSignature(world);
    if (now === signature) return;
    signature = now;
    const scroller = container.closest('.shs-body');
    const top = scroller?.scrollTop ?? 0;
    drawHome(container);
    if (scroller !== null) scroller.scrollTop = top;
  }, 3_000);
  // Contagem do próximo cravado em ms (só texto — o resto redesenha a cada 3 s).
  const live = window.setInterval(() => {
    if (aimIsHot()) return;
    const el = container.querySelector<HTMLElement>('[data-home-count]');
    if (el === null) return;
    paintCountdown(el, Number(el.dataset.homeCount) - serverNowMs());
  }, 100);
  return () => {
    window.clearInterval(timer);
    window.clearInterval(live);
  };
}

function paintCountdown(el: HTMLElement, ms: number): void {
  const left = Math.max(0, ms);
  const total = Math.floor(left / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const p = (n: number): string => String(n).padStart(2, '0');
  const main = h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
  const msPart = `.${String(Math.floor(left % 1000)).padStart(3, '0')}`;
  const small = document.createElement('small');
  small.textContent = msPart;
  el.replaceChildren(document.createTextNode(main), small);
}

const KIND_LABELS: Record<string, string> = { attack: 'Ataque', support: 'Apoio', noble: 'Nobre', fake: 'Fake', cancel: 'Cancelamento' };

function pill(text: string, cls: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = `shs-pill ${cls}`;
  el.textContent = text;
  return el;
}

function btn(label: string, iconName: IconName, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.append(icon(iconName, 15), document.createTextNode(label));
  b.addEventListener('click', onClick);
  return b;
}

function drawHome(container: HTMLElement): void {
  ensureHomeStyles(container);
  container.replaceChildren();
  const root = document.createElement('div');
  root.className = 'home';
  const world = currentWorld();

  // ── Cabeçalho ──
  const head = document.createElement('div');
  head.className = 'home-head';
  const titles = document.createElement('div');
  const h = document.createElement('h2');
  h.className = 'home-title';
  h.textContent = 'Início';
  const sub = document.createElement('div');
  sub.className = 'home-sub';
  sub.textContent = 'Tudo o que o script está fazendo neste mundo.';
  titles.append(h, sub);
  const info = clockInfo();
  const clockPill = pill(`Relógio do servidor ±${info.uncertaintyMs} ms`, info.uncertaintyMs <= 60 ? 'shs-pill--ok' : 'shs-pill--warn');
  clockPill.prepend(icon('clock', 13));
  head.append(titles, clockPill);
  root.appendChild(head);

  // ── Disjuntor (Onda 1): captcha/sessão pausaram TUDO — sempre o primeiro. ──
  const halt = haltState();
  if (halt !== null) {
    const aviso = document.createElement('section');
    aviso.className = 'home-card home-card--halt';
    aviso.setAttribute('role', 'alert');
    const title = document.createElement('h3');
    title.className = 'home-halt-title';
    const ic = document.createElement('span');
    ic.className = 'home-halt-ic';
    ic.appendChild(icon('pause', 15));
    title.append(ic, document.createTextNode(`Script pausado: ${haltLabel(halt)}`));
    aviso.appendChild(title);
    aviso.appendChild(line('clock', `Desde ${new Date(halt.at).toLocaleTimeString('pt-BR')}. ${halt.detail} Nenhuma automação roda e nenhum pedido sai para o jogo.`));
    const schedHalt = nextScheduled(world);
    if (schedHalt.soon30 > 0 && schedHalt.nextAt !== null) {
      aviso.appendChild(
        line('alert', `${schedHalt.soon30} comando(s) nos próximos 30 min (o próximo às ${clockLabelMs(schedHalt.nextAt)}) NÃO saem enquanto estiver pausado, e comando que passa da hora não é reenviado.`),
      );
    }
    aviso.appendChild(
      line('info', halt.reason === 'captcha' ? 'Aperte F5: o jogo vai mostrar o desafio. Resolva-o e depois clique abaixo.' : 'Faça login de novo no jogo e depois clique abaixo.'),
    );
    const recusa = document.createElement('div');
    recusa.className = 'home-resume-err';
    recusa.hidden = true;
    const retomar = btn('Já resolvi, retomar', 'check', 'shs-btn home-resume', () => {
      const motivo = tryResume();
      if (motivo === null) {
        drawHome(container);
        return;
      }
      recusa.textContent = motivo;
      recusa.hidden = false;
    });
    aviso.append(retomar, recusa);
    root.appendChild(aviso);
  }

  // ── Destaque: próximo cravado (contagem ao vivo em ms) ──
  const sched = nextScheduled(world);
  const hero = document.createElement('section');
  if (sched.nextAt !== null) {
    hero.className = 'home-card home-hero home-hero--aim';
    const main = document.createElement('div');
    main.className = 'home-hero-main';
    const chips = document.createElement('div');
    chips.className = 'home-chips';
    const nextChip = pill('Próximo cravado', 'shs-pill--warn');
    nextChip.prepend(icon('clock', 13));
    chips.appendChild(nextChip);
    const src = sched.nextSource;
    const daqui = src === null || src.villageId === currentVillageId();
    chips.appendChild(pill(daqui ? 'Esta aba envia' : `Sai de ${src.label}: abra a Praça dela`, daqui ? '' : 'shs-pill--warn'));
    if (!isTshEnabled('command-scheduler')) chips.appendChild(pill('Agendador desligado', 'shs-pill--error'));
    const count = document.createElement('div');
    count.className = 'home-count';
    count.dataset.homeCount = String(sched.nextAt);
    paintCountdown(count, sched.nextAt - serverNowMs());
    const route = document.createElement('div');
    route.className = 'home-route';
    const m = (t: string): HTMLSpanElement => {
      const el = document.createElement('span');
      el.className = 'm';
      el.textContent = t;
      return el;
    };
    const dot = (): HTMLSpanElement => {
      const el = document.createElement('span');
      el.className = 'sep';
      el.textContent = '·';
      return el;
    };
    route.append(document.createTextNode(KIND_LABELS[sched.nextKind ?? ''] ?? 'Comando'));
    if (src !== null && sched.nextTarget !== null) {
      route.append(m(src.label.replace(/^.*\(([^)]+)\)$/, '$1')), icon('arrowRight', 14), m(sched.nextTarget));
    }
    route.append(dot(), document.createTextNode('sai'), m(clockLabelMs(sched.nextAt)));
    if (sched.nextArrivalAt !== null) route.append(dot(), document.createTextNode('chega'), m(clockLabelMs(sched.nextArrivalAt)));
    main.append(chips, count, route);
    const side = document.createElement('div');
    side.className = 'home-hero-side';
    side.appendChild(btn('Abrir Comandos', 'crosshair', 'shs-btn shs-btn-ghost', () => openSection('comandos')));
    hero.append(main, side);
  } else {
    hero.className = 'home-card home-hero';
    const main = document.createElement('div');
    main.className = 'home-hero-main';
    const t = document.createElement('div');
    t.className = 'home-empty-title';
    t.textContent = 'Nenhum cravado agendado';
    const d = document.createElement('div');
    d.className = 'home-stat-hint';
    d.textContent = 'Agende ataques, apoios e nobres pela hora do servidor, com milissegundos.';
    main.append(t, d);
    hero.append(main, btn('Agendar comando', 'plus', 'shs-btn', () => openSection('comandos')));
  }
  root.appendChild(hero);

  // ── Três números ──
  const autos = tshAutomations();
  const ativos = autos.filter((a) => isTshEnabled(a.id));
  const precisaArmar = ativos.filter((a) => a.mutating && a.armExempt !== true && Date.now() >= tshArmedUntil(a.id));
  const stats = document.createElement('div');
  stats.className = 'home-stats';
  const tile = (label: string, value: string, suffix: string, hint: string): HTMLElement => {
    const box = document.createElement('div');
    box.className = 'home-card home-stat';
    const l = document.createElement('span');
    l.className = 'home-stat-lbl';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'home-stat-val';
    v.textContent = value;
    if (suffix !== '') {
      const small = document.createElement('small');
      small.textContent = suffix;
      v.appendChild(small);
    }
    const hEl = document.createElement('span');
    hEl.className = 'home-stat-hint';
    hEl.textContent = hint;
    box.append(l, v, hEl);
    return box;
  };
  stats.appendChild(tile('Comandos agendados', String(sched.count), '', sched.soon30 > 0 ? `${sched.soon30} nos próximos 30 min` : 'nenhum nos próximos 30 min'));
  stats.appendChild(
    tile('Automações ativas', String(ativos.length), ` / ${autos.length}`, precisaArmar.length > 0 ? `${precisaArmar.length} aguardando armar` : 'todas prontas'),
  );
  const erro = info.lastArrivalErrorMs;
  stats.appendChild(
    tile(
      'Precisão dos cravados',
      erro === null ? '—' : `${erro >= 0 ? '+' : ''}${erro} ms`,
      '',
      info.feedbackCount > 0 ? `última chegada conferida · ${info.feedbackCount} no total` : 'aparece após o 1º cravado conferido',
    ),
  );
  root.appendChild(stats);

  // ── Atividade (automações ligadas) ──
  const list = document.createElement('section');
  list.className = 'home-card home-list';
  const lh = document.createElement('div');
  lh.className = 'home-list-head';
  const lt = document.createElement('b');
  lt.textContent = 'Atividade';
  const ver = document.createElement('button');
  ver.type = 'button';
  ver.className = 'home-linkbtn';
  ver.textContent = 'Ver automações';
  ver.addEventListener('click', () => openSection('tsh'));
  lh.append(lt, ver);
  list.appendChild(lh);
  if (ativos.length === 0) {
    const e = document.createElement('div');
    e.className = 'home-act-empty';
    e.textContent = 'Nenhuma automação ligada. Ligue as que quiser em Automações.';
    list.appendChild(e);
  }
  for (const auto of ativos) {
    const row = document.createElement('div');
    row.className = 'home-act';
    const schedule = loadSchedule(world, auto.id);
    const status = tshStatus(auto.id, world);
    const needsArm = precisaArmar.includes(auto);
    const dotEl = document.createElement('span');
    dotEl.className = `shs-dot${
      isScheduleStopped(schedule) ? ' shs-dot--off' : needsArm || status?.kind === 'warn' ? ' shs-dot--err' : auto.id === 'command-scheduler' ? ' shs-dot--warn' : ''
    }`;
    const name = document.createElement('span');
    name.className = 'home-act-name';
    name.textContent = auto.label;
    const msg = document.createElement('span');
    msg.className = 'home-act-msg';
    msg.textContent = isScheduleStopped(schedule) ? 'Parada programada atingida' : needsArm ? 'Precisa armar para agir' : (status?.message ?? 'Aguardando o primeiro ciclo');
    if (status !== null) msg.title = status.message;
    row.append(dotEl, name, msg);
    const nextAt = tshNextRunAt(auto.id, world);
    if (nextAt !== null && nextAt > Date.now()) {
      const next = document.createElement('span');
      next.className = 'home-act-next';
      const d = new Date(nextAt);
      const p = (n: number): string => String(n).padStart(2, '0');
      next.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      next.title = 'Próximo ciclo';
      row.appendChild(next);
    }
    list.appendChild(row);
  }
  root.appendChild(list);

  // ── Suporte (discreto) ──
  const support = document.createElement('div');
  support.className = 'home-support';
  support.appendChild(icon('message', 14));
  support.appendChild(document.createTextNode('Suporte Toxic Squad:'));
  const phone = document.createElement('span');
  phone.className = 'home-phone';
  phone.textContent = SUPPORT_PHONE;
  const wa = document.createElement('a');
  wa.href = SUPPORT_WA;
  wa.target = '_blank';
  wa.rel = 'noopener';
  wa.textContent = 'WhatsApp';
  support.append(phone, wa);
  root.appendChild(support);

  container.appendChild(root);
}
