// Aba "Automações" do painel (UX v3 — tema Nexus): grupos por categoria
// (Economia / Produção & Militar / Planejamento / Outros), LINHA por automação
// (ícone da categoria, badges mini, descrição, meta de agenda, status inline) e
// ações à direita (chip de status, pills fantasma, armar 30min para mutantes,
// engrenagem configurar, play circular rodar agora, switch Ativo).
//
// TIMERS — exatamente UM por seção aberta: setInterval de 1s criado pelo
// renderTshPanel e DEVOLVIDO como limpeza ao shell (Onda B — antes era um
// interval global eterno). A cada tick ele atualiza textContent de
// [data-tsh-next] / [data-tsh-armed] / [data-tsh-armed-btn] e, quando a
// ASSINATURA do estado muda (status/ligado/armado/próximo ciclo — um ciclo
// terminou no heartbeat, por exemplo), redesenha o painel: status ao vivo.
// Não redesenha com um diálogo aberto nem com o ponteiro pressionado.
//
// Segurança: zero innerHTML com dado dinâmico — mensagem de status, labels e
// JSON de prévia entram sempre por textContent/createTextNode.

import { aimIsHot } from '../../core/game-clock';
import { licenseState } from '../../core/license';
import { icon, type IconName } from '../../core/icons';
import { ensureHost } from '../../core/shell';
import { currentWorld } from '../../core/page';
import { gm } from '../../core/storage';
import { ensureTshPanelStyles } from './tsh-panel-styles';
import { loadSchedule } from './tsh-settings';
import { buildingIcon, unitIcon } from './tsh-units';
import { openTshPreviewModal, openTshSettingsModal, tshConfirm } from './tsh-settings-ui';
import {
  armTsh,
  disarmTsh,
  effectiveCooldownMs,
  isTshEnabled,
  runTshCycle,
  setTshEnabled,
  tshArmedUntil,
  tshAutomations,
  tshNextRunAt,
  tshStatus,
  type TshAutomation,
  type TshCategory,
} from './tsh-runtime';

// ── Formatação leve (sem Intl) ──

function fmtAgo(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'agora';
  if (s < 3600) return `${Math.floor(s / 60)}min atrás`;
  return `${Math.floor(s / 3600)}h atrás`;
}

function fmtMmSs(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function nextLabel(next: number, now: number): string {
  const rest = next - now;
  return rest <= 0 ? 'agora' : `em ${fmtMmSs(rest)}`;
}

// ── Countdown vivo (ver cabeçalho) ──

/** Chips/botões com ícone guardam o rótulo num span — atualiza só o texto. */
function labelOf(host: HTMLElement, selector: string): HTMLElement {
  return host.querySelector(selector) ?? host;
}

function tickCountdown(shadow: ShadowRoot): void {
  const now = Date.now();
  for (const el of shadow.querySelectorAll<HTMLElement>('[data-tsh-next]')) {
    const next = Number(el.dataset.tshNext);
    if (!Number.isFinite(next)) continue;
    el.textContent = nextLabel(next, now);
  }
  for (const badge of shadow.querySelectorAll<HTMLElement>('[data-tsh-armed]')) {
    const until = Number(badge.dataset.tshArmed);
    const min = Number.isFinite(until) ? Math.ceil((until - now) / 60_000) : 0;
    if (min > 0) {
      badge.hidden = false;
      // P3 (auditoria impeccable): sentence-case — os demais chips já são minúsculos.
      labelOf(badge, '.tsh-chip-txt').textContent = `Armado ${min}m`;
    } else {
      badge.hidden = true; // armação venceu — some sem re-render
    }
  }
  // P2 (revisão Onda 8): botão Armar travava em "Armado Xmin" após expirar —
  // o próprio tick destrava e devolve o label de re-armar.
  for (const btn of shadow.querySelectorAll<HTMLButtonElement>('[data-tsh-armed-btn]')) {
    const until = Number(btn.dataset.tshArmedBtn);
    if (!Number.isFinite(until)) continue;
    if (now >= until && btn.disabled) {
      btn.disabled = false;
      labelOf(btn, '.tsh-btn-txt').textContent = 'Armar 30min';
    }
  }
}

/**
 * Assinatura do que o painel mostra (Onda B): muda quando um ciclo publica
 * status, quando algo liga/desliga/arma, ou quando o próximo ciclo é
 * reagendado — só então o painel é redesenhado.
 */
export function tshPanelSignature(world: string): string {
  return tshAutomations()
    .map((a) => {
      const status = tshStatus(a.id, world);
      return [
        a.id,
        isTshEnabled(a.id) ? 1 : 0,
        tshArmedUntil(a.id) > Date.now() ? 1 : 0,
        tshNextRunAt(a.id, world) ?? '',
        // Mensagem+tipo (não o horário): o heartbeat regrava o MESMO aviso a
        // cada 30s e isso redesenhava à toa (revisão Onda C).
        status?.message ?? '',
        status?.kind ?? '',
      ].join(':');
    })
    .join('|');
}

// ── Filtro e grupos recolhidos (Onda C — preferências persistidas) ──

export type TshListFilter = 'todas' | 'ativas' | 'atencao';
const FILTER_KEY = 'tsh-ui:auto-filter';
const COLLAPSED_KEY = 'tsh-ui:auto-collapsed';

function currentFilter(): TshListFilter {
  const raw = gm.get<string>(FILTER_KEY, 'todas');
  return raw === 'ativas' || raw === 'atencao' ? raw : 'todas';
}

function collapsedGroups(): Set<string> {
  const raw = gm.get<unknown>(COLLAPSED_KEY, []);
  return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
}

/**
 * Busca rápida (revisão Onda C): garante que a linha da automação fique
 * VISÍVEL — filtro volta para "Todas" e o grupo dela é expandido.
 */
export function revealTshAutomation(id: string): void {
  gm.set(FILTER_KEY, 'todas');
  const automation = tshAutomations().find((a) => a.id === id);
  if (automation === undefined) return;
  const atual = collapsedGroups();
  atual.delete(automation.category ?? 'outros');
  gm.set(COLLAPSED_KEY, [...atual]);
}

/** A automação aparece com este filtro? (puro — status/ligado vêm por parâmetro) */
export function passesTshFilter(filter: TshListFilter, enabled: boolean, statusKind: string | null): boolean {
  if (filter === 'ativas') return enabled;
  if (filter === 'atencao') return enabled && statusKind === 'warn';
  return true;
}

// ── Grupos (ordem fixa; category ausente → último grupo) ──

interface TshGroup {
  category: TshCategory | undefined;
  label: string;
  iconName: IconName;
}

const GROUPS: readonly TshGroup[] = [
  { category: 'economia', label: 'Economia', iconName: 'crown' },
  { category: 'producao', label: 'Tropas e produção', iconName: 'sword' },
  { category: 'planejamento', label: 'Planejamento', iconName: 'target' },
  { category: undefined, label: 'Outros', iconName: 'list' },
];


// ── Ícone de cada automação (v3.2): prédio/unidade OFICIAL do jogo quando
//    existe um que a represente; senão um ícone de traço do painel. ──
type AutoIcon = { unit: string } | { building: string } | { stroke: IconName };
const AUTOMATION_ICONS: Record<string, AutoIcon> = {
  'command-scheduler': { stroke: 'crosshair' },
  'auto-farm': { unit: 'light' },
  'map-farm': { stroke: 'map' },
  'barbarian-cultivator': { unit: 'catapult' },
  'wall-demolition': { unit: 'ram' },
  'conquista-livres': { unit: 'snob' },
  'producao-nobres': { building: 'snob' },
  'coin-center': { stroke: 'coins' },
  'auto-mint-nativo': { stroke: 'coins' },
  collection: { stroke: 'package' },
  recruitment: { building: 'barracks' },
  'mega-builder': { building: 'main' },
  'premium-exchange': { building: 'market' },
  'resource-balancer': { stroke: 'swap' },
  'paladin-training': { unit: 'knight' },
  'paladino-skills': { building: 'statue' },
  'mass-support': { unit: 'spear' },
  'support-manager': { unit: 'sword' },
  'op-generator': { stroke: 'layers' },
  'abrir-pacotes': { stroke: 'package' },
  'ativador-itens': { stroke: 'gift' },
  'doador-prestigio': { stroke: 'crown' },
  'renomeador-aldeias': { stroke: 'edit' },
};

function automationIconBox(id: string): HTMLSpanElement {
  const box = document.createElement('span');
  box.className = 'tsh-autoic';
  const spec = AUTOMATION_ICONS[id] ?? { stroke: 'zap' as IconName };
  if ('unit' in spec) box.appendChild(unitIcon(spec.unit, 20));
  else if ('building' in spec) box.appendChild(buildingIcon(spec.building, 20));
  else box.appendChild(icon(spec.stroke, 17));
  return box;
}

// ── Prévia: dado publicado pelo plugin via ctx.storage ──

const PREVIEW_KEYS = ['last-plan', 'last-report', 'last-preview'] as const;

function previewData(world: string, id: string): unknown {
  for (const key of PREVIEW_KEYS) {
    const data = gm.get<unknown>(`tsh-auto:${world}:${id}:${key}`, null);
    if (data !== null) return data;
  }
  return null;
}

// ── Chip de status (direita da linha) ──

function statusChip(automation: TshAutomation, enabled: boolean, world: string): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = 'tsh-statuschip';
  const status = tshStatus(automation.id, world);
  if (!enabled) {
    chip.classList.add('tsh-statuschip--off');
    chip.title = 'Desligada — ative o switch para agendar ciclos.';
    chip.appendChild(icon('minus', 11));
    chip.appendChild(document.createTextNode('Desligada'));
  } else if (status === null) {
    chip.classList.add('tsh-statuschip--wait');
    chip.title = 'Sem ciclo ainda neste mundo.';
    chip.appendChild(icon('clock', 11));
    chip.appendChild(document.createTextNode('Aguardando'));
  } else if (status.kind === 'ok') {
    chip.classList.add('tsh-statuschip--ok');
    chip.appendChild(icon('check', 11));
    chip.appendChild(document.createTextNode('Ativa'));
  } else if (status.kind === 'warn') {
    chip.classList.add('tsh-statuschip--err');
    chip.appendChild(icon('alert', 11));
    chip.appendChild(document.createTextNode('Atenção'));
  } else {
    chip.classList.add('tsh-statuschip--wait');
    chip.appendChild(icon('clock', 11));
    chip.appendChild(document.createTextNode('Agendada'));
  }
  return chip;
}

// ── Linha de uma automação ──

function automationRow(automation: TshAutomation, shadow: ShadowRoot, world: string, rerender: () => void): HTMLDivElement {
  const enabled = isTshEnabled(automation.id);
  const rowEl = document.createElement('div');
  rowEl.className = enabled ? 'tsh-row' : 'tsh-row tsh-row--off';
  rowEl.dataset.searchId = `tsh:${automation.id}`; // alvo da busca rápida (Onda C)
  rowEl.appendChild(automationIconBox(automation.id));

  // ── coluna esquerda (Instrumento): nome (+ armado) e UMA linha de estado ──
  const main = document.createElement('div');
  main.className = 'tsh-row-main';

  const titleline = document.createElement('div');
  titleline.className = 'tsh-row-titleline';
  const name = document.createElement('span');
  name.className = 'tsh-row-name';
  name.textContent = automation.label;
  titleline.appendChild(name);
  if (automation.mutating && automation.armExempt !== true) {
    const until = tshArmedUntil(automation.id);
    const minLeft = Math.ceil((until - Date.now()) / 60_000);
    if (minLeft > 0) {
      const badgeArmed = document.createElement('span');
      badgeArmed.className = 'tsh-badge tsh-badge--armed';
      badgeArmed.dataset.tshArmed = String(until); // atualizado pelo countdown vivo
      const txt = document.createElement('span');
      txt.className = 'tsh-chip-txt';
      txt.textContent = `Armado ${minLeft}m`;
      badgeArmed.appendChild(txt);
      titleline.appendChild(badgeArmed);
    }
  }
  main.appendChild(titleline);

  // Linha de estado: a mensagem do último ciclo (ou a descrição, sem ciclo).
  // Descrição completa + agenda ficam na dica ao passar o mouse.
  const schedule = loadSchedule(world, automation.id);
  const cooldownMin = Math.max(1, Math.round(effectiveCooldownMs(automation, schedule) / 60_000));
  const from = schedule.activeFrom ?? '';
  const to = schedule.activeTo ?? '';
  const status = tshStatus(automation.id, world);
  const sub = document.createElement('div');
  sub.className = 'tsh-row-desc';
  sub.textContent = status !== null && enabled ? `${status.message} · ${fmtAgo(status.at)}` : automation.desc;
  main.title = `${automation.desc}\nCiclo a cada ${cooldownMin} min · ${from !== '' && to !== '' ? `ativa das ${from} às ${to}` : 'ativa o dia todo'}${
    automation.screen !== null ? ` · roda na tela "${automation.screen}"` : ''
  }`;
  main.appendChild(sub);

  rowEl.appendChild(main);

  // ── coluna direita: chip de status + ações + switch ──
  const side = document.createElement('div');
  side.className = 'tsh-row-side';
  side.appendChild(statusChip(automation, enabled, world));
  // Próximo ciclo em mono (contagem viva pelo tick de 1 s).
  const proxVal = document.createElement('span');
  proxVal.className = 'tsh-row-next';
  const next = tshNextRunAt(automation.id, world);
  const telaCerta =
    automation.screen === null || new URLSearchParams(window.location.search).get('screen') === automation.screen;
  if (!enabled) {
    proxVal.textContent = '—';
  } else if (next === null) {
    proxVal.textContent = telaCerta ? 'livre' : 'outra tela';
    if (!telaCerta) proxVal.title = `Roda quando você abrir a tela "${automation.screen}".`;
  } else {
    proxVal.dataset.tshNext = String(next);
    proxVal.textContent = nextLabel(next, Date.now());
  }
  side.appendChild(proxVal);

  // Ações extras declaradas pelo módulo (ex.: "Comandos" do agendador).
  for (const extra of automation.extraActions ?? []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tsh-btn tsh-btn--ghost';
    btn.appendChild(icon(extra.label.toLowerCase().includes('comand') ? 'send' : 'list', 12));
    const txt = document.createElement('span');
    txt.className = 'tsh-btn-txt';
    txt.textContent = extra.label;
    btn.appendChild(txt);
    btn.addEventListener('click', () => extra.open(shadow, world, rerender));
    side.appendChild(btn);
  }

  const previa = previewData(world, automation.id);
  if (previa !== null) {
    const ver = document.createElement('button');
    ver.type = 'button';
    ver.className = 'tsh-btn tsh-btn--ghost';
    ver.appendChild(icon('eye', 12));
    const txt = document.createElement('span');
    txt.className = 'tsh-btn-txt';
    txt.textContent = 'Ver prévia';
    ver.appendChild(txt);
    ver.addEventListener('click', () => openTshPreviewModal(shadow, automation, previa));
    side.appendChild(ver);
  }

  // Armar só faz sentido com a automação LIGADA (desligada, era ruído).
  if (automation.mutating && automation.armExempt !== true && enabled) {
    const until = tshArmedUntil(automation.id);
    const armed = Date.now() < until;
    const armar = document.createElement('button');
    armar.type = 'button';
    armar.className = 'tsh-btn tsh-btn--ghost tsh-btn--sm';
    const txt = document.createElement('span');
    txt.className = 'tsh-btn-txt';
    txt.textContent = armed ? `Armado ${Math.max(1, Math.ceil((until - Date.now()) / 60_000))} min` : 'Armar';
    armar.appendChild(txt);
    armar.disabled = armed;
    // P2 (revisão Onda 8): o tick de 1s destrava o botão quando a armação vence.
    armar.dataset.tshArmedBtn = String(until);
    // Onda B: só o tooltip do painel (title nativo duplicava).
    armar.classList.add('tsh-tip');
    armar.setAttribute('data-tip', 'Autorizar ações no jogo por 30 minutos');
    // P2 (auditoria impeccable): window.confirm → diálogo Nexus (tshConfirm).
    armar.addEventListener('click', async () => {
      const ok = await tshConfirm(
        shadow,
        'Armar automação',
        `Armar "${automation.label}" por 30 min? Os ciclos poderão EXECUTAR ações no jogo.`,
        { danger: true },
      );
      if (!ok) return;
      armTsh(automation.id);
      rerender();
    });
    side.appendChild(armar);
  }

  const configurar = document.createElement('button');
  configurar.type = 'button';
  configurar.className = 'tsh-icbtn';
  configurar.classList.add('tsh-tip');
  configurar.setAttribute('data-tip', 'Configurar');
  configurar.setAttribute('aria-label', 'Configurar');
  configurar.appendChild(icon('settings', 16));
  configurar.addEventListener('click', () => openTshSettingsModal(shadow, automation, world, rerender));
  side.appendChild(configurar);

  const rodar = document.createElement('button');
  rodar.type = 'button';
  rodar.className = 'tsh-runbtn';
  rodar.classList.add('tsh-tip');
  rodar.setAttribute('data-tip', 'Rodar agora — executa um ciclo agora (ignora o intervalo; armação e lock continuam valendo)');
  rodar.setAttribute('aria-label', 'Rodar agora');
  rodar.appendChild(icon('play', 12));
  rodar.disabled = !enabled;
  rodar.addEventListener('click', () => {
    // Desabilitado até a promise resolver — cliques repetidos nunca sobrepõem ciclos.
    rodar.disabled = true;
    void runTshCycle(automation.id, { ignoreCooldown: true })
      .catch(() => undefined)
      .finally(rerender);
  });
  side.appendChild(rodar);

  const toggle = document.createElement('label');
  toggle.className = 'tsh-switch';
  toggle.title = 'Ativo';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = enabled;
  check.setAttribute('aria-label', 'Ativo');
  const track = document.createElement('span');
  track.className = 'tsh-switch-track';
  toggle.append(check, track);
  // P2 (auditoria impeccable): window.confirm → diálogo Nexus (tshConfirm);
  // handler async — a recusa reverte o checkbox e mantém o estado atual.
  check.addEventListener('change', async () => {
    const ligar = check.checked;
    // armExempt (ex.: Agendador): agendar já é a autorização — o aviso muda.
    if (ligar && automation.mutating) {
      const aviso =
        automation.armExempt === true
          ? `Ativar "${automation.label}"? Ativo, ele EXECUTA automaticamente o que estiver agendado.`
          : `Ativar "${automation.label}"? Armado, os ciclos EXECUTAM ações no jogo.`;
      if (!(await tshConfirm(shadow, 'Ativar automação', aviso, { danger: true }))) {
        check.checked = false; // confirmação recusada — reverte o checkbox
        return;
      }
    }
    setTshEnabled(automation.id, ligar);
    rerender();
  });
  side.appendChild(toggle);

  rowEl.appendChild(side);
  return rowEl;
}

// ── Cabeçalho da aba: título + pills fantasma vivas ──

function panelHeader(all: readonly TshAutomation[]): HTMLElement {
  const ativas = all.filter((a) => isTshEnabled(a.id)).length;
  const now = Date.now();
  const armadas = all.filter((a) => a.mutating && a.armExempt !== true && now < tshArmedUntil(a.id)).length;
  const head = document.createElement('div');
  head.className = 'tsh-head';
  const title = document.createElement('h2');
  title.className = 'tsh-head-title';
  title.textContent = 'Automações';
  const sub = document.createElement('div');
  sub.className = 'tsh-head-desc';
  sub.textContent = `${ativas} de ${all.length} ligadas${armadas > 0 ? ` · ${armadas} armada(s)` : ''}${
    licenseState().kind === 'ausente' ? ' · licença inativa' : ''
  }. Nada roda até você ligar; as que agem no jogo pedem Armar (30 min).`;
  head.append(title, sub);
  return head;
}

/** Seção "Automações" do painel — devolve a limpeza do timer vivo (Onda B). */
export function renderTshPanel(container: HTMLElement): () => void {
  const shadow = ensureHost();
  const world = currentWorld();
  let signature = tshPanelSignature(world);
  let disposed = false;
  // Ponteiro pressionado (com teto de 3s: pointerup perdido não trava o ao vivo).
  let pointerDownAt = 0;
  const onDown = (): void => {
    pointerDownAt = Date.now();
  };
  const onUp = (): void => {
    pointerDownAt = 0;
  };
  container.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('blur', onUp);
  const redraw = (): void => {
    // Revisão Onda C: redesenho atrasado (Rodar agora/Salvar) depois de trocar
    // de seção NÃO pode pintar Automações por cima da seção nova.
    if (disposed || !container.isConnected || container.dataset.section !== 'tsh') return;
    const scroller = container.closest('.shs-body');
    const top = scroller?.scrollTop ?? 0;
    container.replaceChildren();
    drawTshPanel(container, redraw);
    if (scroller !== null) scroller.scrollTop = top;
    signature = tshPanelSignature(world);
  };
  drawTshPanel(container, redraw);
  const timer = window.setInterval(() => {
    if (aimIsHot()) return; // reta final de um cravado nesta página
    tickCountdown(shadow);
    const pressionado = pointerDownAt !== 0 && Date.now() - pointerDownAt < 3_000;
    if (pressionado || shadow.querySelector('.tsh-overlay') !== null) return;
    if (tshPanelSignature(world) !== signature) redraw();
  }, 1000);
  return () => {
    disposed = true;
    window.clearInterval(timer);
    container.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('blur', onUp);
  };
}

function drawTshPanel(container: HTMLElement, rerender: () => void): void {
  const shadow = ensureHost();
  ensureTshPanelStyles(shadow);

  const world = currentWorld();
  const all = tshAutomations();

  const cardEl = document.createElement('div');
  cardEl.className = 'tsh-page';

  cardEl.appendChild(panelHeader(all));

  if (all.length === 0) {
    // P3 (auditoria impeccable): empty state no padrão do shell (.shs-empty —
    // padding generoso, centralizado, muted; definido no <style> do core).
    const vazio = document.createElement('div');
    vazio.className = 'shs-empty';
    vazio.textContent = 'Nenhuma automação registrada.';
    cardEl.appendChild(vazio);
    container.appendChild(cardEl);
    return;
  }

  // ── Barra de ferramentas (Onda C): filtro + ações em massa ──
  const filter = currentFilter();
  const toolbar = document.createElement('div');
  toolbar.className = 'tsh-toolbar';
  const seg = document.createElement('div');
  seg.className = 'tsh-seg';
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', 'Filtrar automações');
  const filtros: { value: TshListFilter; label: string; ic: IconName }[] = [
    { value: 'todas', label: 'Todas', ic: 'list' },
    { value: 'ativas', label: 'Ativas', ic: 'zap' },
    { value: 'atencao', label: 'Com atenção', ic: 'alert' },
  ];
  for (const opt of filtros) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tsh-seg-btn';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(opt.value === filter));
    b.append(icon(opt.ic, 13), document.createTextNode(opt.label));
    b.addEventListener('click', () => {
      gm.set(FILTER_KEY, opt.value);
      rerender();
    });
    seg.appendChild(b);
  }
  toolbar.appendChild(seg);
  const massSpacer = document.createElement('span');
  massSpacer.style.flex = '1';
  toolbar.appendChild(massSpacer);
  const armadasAgora = all.filter((a) => a.mutating && a.armExempt !== true && Date.now() < tshArmedUntil(a.id));
  if (armadasAgora.length > 0) {
    const desarmar = document.createElement('button');
    desarmar.type = 'button';
    desarmar.className = 'tsh-btn tsh-btn--ghost tsh-btn--sm';
    desarmar.appendChild(icon('lock', 12));
    desarmar.appendChild(document.createTextNode(`Desarmar todas (${armadasAgora.length})`));
    desarmar.addEventListener('click', () => {
      for (const a of armadasAgora) disarmTsh(a.id);
      rerender();
    });
    toolbar.appendChild(desarmar);
  }
  const ligadasAgora = all.filter((a) => isTshEnabled(a.id));
  if (ligadasAgora.length > 0) {
    const desligar = document.createElement('button');
    desligar.type = 'button';
    desligar.className = 'tsh-btn tsh-btn--ghost tsh-btn--sm';
    desligar.appendChild(icon('pause', 12));
    desligar.appendChild(document.createTextNode(`Desligar todas (${ligadasAgora.length})`));
    desligar.addEventListener('click', async () => {
      const ok = await tshConfirm(
        shadow,
        'Desligar todas',
        `Desligar as ${ligadasAgora.length} automações ativas? Nada mais roda até você religar (comandos agendados ficam guardados, mas o Agendador desligado não os envia).`,
        { danger: true },
      );
      if (!ok) return;
      for (const a of ligadasAgora) {
        setTshEnabled(a.id, false);
        disarmTsh(a.id);
      }
      rerender();
    });
    toolbar.appendChild(desligar);
  }
  cardEl.appendChild(toolbar);

  const collapsed = collapsedGroups();
  let visiveis = 0;
  for (const group of GROUPS) {
    const items = all
      .filter((a) => a.category === group.category)
      .filter((a) => passesTshFilter(filter, isTshEnabled(a.id), tshStatus(a.id, world)?.kind ?? null));
    if (items.length === 0) continue;
    visiveis += items.length;
    const temAtivos = items.some((a) => isTshEnabled(a.id));
    const groupKey = group.category ?? 'outros';
    const fechado = collapsed.has(groupKey);

    const groupTitle = document.createElement('button');
    groupTitle.type = 'button';
    groupTitle.className = temAtivos ? 'tsh-group-title tsh-group-title--on' : 'tsh-group-title';
    groupTitle.setAttribute('aria-expanded', String(!fechado));
    groupTitle.appendChild(icon(fechado ? 'arrowRight' : 'chevronDown', 14));
    const gIcon = icon(group.iconName, 15);
    gIcon.classList.add('tsh-group-ic');
    groupTitle.appendChild(gIcon);
    groupTitle.appendChild(document.createTextNode(group.label));
    const count = document.createElement('span');
    count.className = temAtivos ? 'tsh-group-count tsh-group-count--on' : 'tsh-group-count';
    count.textContent = String(items.length);
    groupTitle.appendChild(count);
    groupTitle.addEventListener('click', () => {
      const atual = collapsedGroups();
      if (atual.has(groupKey)) atual.delete(groupKey);
      else atual.add(groupKey);
      gm.set(COLLAPSED_KEY, [...atual]);
      rerender();
    });
    const gcard = document.createElement('section');
    gcard.className = 'tsh-gcard';
    gcard.appendChild(groupTitle);
    cardEl.appendChild(gcard);
    if (fechado) continue;

    const rows = document.createElement('div');
    rows.className = 'tsh-rows';
    for (const automation of items) {
      rows.appendChild(automationRow(automation, shadow, world, rerender));
    }
    gcard.appendChild(rows);
  }
  if (visiveis === 0) {
    const vazio = document.createElement('div');
    vazio.className = 'shs-empty';
    vazio.textContent =
      filter === 'ativas'
        ? 'Nenhuma automação ativa — escolha "Todas" para ligar alguma.'
        : 'Nenhuma automação pedindo atenção agora.';
    cardEl.appendChild(vazio);
  }

  container.appendChild(cardEl);
}
