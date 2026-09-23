// Seção "Início" do Toxic Squad Hub: o resumo que o jogador precisa ao abrir
// — conta/mundo/aldeia, estado da licença, panorama das ferramentas (o que
// está ativo/armado/agendado) e o contato oficial da squad. Cartões no estilo
// Nexus, classes próprias (home-*) com <style> idempotente no shadow.

import { icon, type IconName } from '../core/icons';
import { gm } from '../core/storage';
import { licenseState } from '../core/license';
import { currentWorld, pageWindow } from '../core/page';
import { gameContext } from '../core/shell';
import { isVantaEnabled, vantaLaunchers } from './vanta/vanta-registry';
import { isTshEnabled, tshArmedUntil, tshAutomations, tshNextRunAt, tshStatus } from './tsh/tsh-runtime';
import { loadSchedule, isScheduleStopped } from './tsh/tsh-settings';
import { tshPanelSignature } from './tsh/tsh-panel';
import { serverNowMs } from '../core/game-clock';
import { clockLabelMs } from '../ext/core/timing/precise-fire';

export const SUPPORT_PHONE = '+55 81 99413-1872';
const SUPPORT_WA = 'https://wa.me/5581994131872';

const HOME_STYLE_ID = 'tsh-home-styles';
const HOME_CSS = `
  .home-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
  .home-card { background: var(--shs-bg-card, #fffdf3); border: 1px solid var(--shs-border, #e0cda0); border-radius: 10px; padding: 14px 16px; }
  .home-card--full { grid-column: 1 / -1; }
  /* [8] O kicker virou TÍTULO do card: heading legítimo (h3) 16px/700, sem
     estilo de eyebrow (nada de uppercase minúsculo sobre um heading). */
  .home-kicker { display: flex; align-items: center; gap: 7px; margin: 0 0 10px;
    font-family: var(--shs-font-display, Georgia, 'Times New Roman', serif);
    font-size: 16px; font-weight: 700; letter-spacing: .2px; color: var(--shs-ink-strong, #3c250a); }
  .home-player { margin: 0; font-size: 22px; font-weight: 800; color: var(--shs-ink-strong, #3c250a); font-family: var(--shs-font-display); letter-spacing: 0.5px; line-height: 1.2; }
  .home-line { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--shs-ink, #5a3a16); margin-top: 6px; }
  .home-line svg { color: var(--shs-muted, #6f5e40); flex-shrink: 0; }
  .home-pill { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; border: 1px solid var(--shs-border-strong, #cbb384); background: var(--shs-bg-inset, #f4ead0); color: var(--shs-ink, #5a3a16); }
  .home-pill--ok { background: var(--shs-ok-bg, #e8f4e2); border-color: #b5d4a8; color: #2e5b2a; }
  .home-pill--warn { background: #fdf6d8; border-color: #e8d588; color: #6b5518; }
  .home-pill--err { background: var(--shs-danger-bg, #fceaea); border-color: var(--shs-danger, #c04038); color: var(--shs-danger, #c04038); }
  .home-stat { display: flex; align-items: baseline; justify-content: space-between; padding: 7px 0; border-bottom: 1px dashed var(--shs-border, #e0cda0); font-size: 12.5px; color: var(--shs-ink, #5a3a16); }
  .home-stat:last-child { border-bottom: none; }
  .home-stat strong { font-size: 15px; color: var(--shs-ink-strong, #3c250a); font-variant-numeric: tabular-nums; }
  .home-contact { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
  .home-wa { display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: 8px; background: #6d3c14; color: #fff !important; font-size: 12.5px; font-weight: 600; text-decoration: none; border: none; cursor: pointer; }
  .home-wa:hover { background: #834a1a; }
  .home-phone { font-family: var(--shs-font-mono, monospace); font-size: 14px; color: var(--shs-ink-strong, #3c250a); font-weight: 600; font-variant-numeric: tabular-nums; }
  .home-note { font-size: 11px; color: var(--shs-muted, #6f5e40); line-height: 1.5; margin-top: 8px; }
  .home-tip { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; font-size: 12px; color: var(--shs-ink, #5a3a16); }
  .home-tip svg { flex-shrink: 0; margin-top: 1px; color: var(--shs-brass, #b8860b); }
  .home-act { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px dashed var(--shs-border, #e0cda0); font-size: 12px; }
  .home-act:last-child { border-bottom: none; }
  .home-act-name { font-weight: 600; color: var(--shs-ink-strong, #3c250a); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .home-act-msg { font-size: 11px; color: var(--shs-muted, #6f5e40); max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .home-act-next { font-size: 11px; color: var(--shs-ink, #5a3a16); font-variant-numeric: tabular-nums; }
  .home-pill--run { background: #eaf3fb; border-color: #a9c9e6; color: #24537f; }
  .home-pill--idle { background: var(--shs-bg-inset, #f4ead0); color: var(--shs-muted, #6f5e40); }
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
function card(titulo: string | null, iconName: IconName, full = false): { box: HTMLDivElement; body: HTMLDivElement } {
  const box = document.createElement('div');
  box.className = full ? 'home-card home-card--full' : 'home-card';
  const body = document.createElement('div');
  if (titulo !== null) {
    // [8] Título do card é heading legítimo (h3 16px/700), não eyebrow.
    const head = document.createElement('h3');
    head.className = 'home-kicker';
    head.appendChild(icon(iconName, 15));
    head.appendChild(document.createTextNode(titulo));
    box.appendChild(head);
  }
  box.appendChild(body);
  return { box, body };
}

function line(iconName: IconName, text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'home-line';
  el.appendChild(icon(iconName, 13));
  el.appendChild(document.createTextNode(text));
  return el;
}

function fmtDate(epoch: number): string {
  const d = new Date(epoch);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// [1] Status terminais do histórico do agendador (mesmo critério de
// vivos×histórico da tela Comandos — tsh-commands-ui.ts/scheduler-state):
// registro com o ÚLTIMO evento nesses estados é passado e não conta.
const EVENTOS_TERMINAIS: ReadonlySet<string> = new Set(['enviado', 'incerto', 'falhou', 'removido']);

interface CommandRecordLike {
  sendAt?: unknown;
  paused?: unknown;
  events?: unknown;
}

/**
 * Próximo comando agendado do mundo (storage do agendador).
 * [1] Conta só registros VIVOS: `paused !== true` e o ÚLTIMO evento de
 * `events` sem status terminal — o histórico (enviado/incerto/falhou/removido)
 * e os pausados deixaram de inflar o número. nextAt = menor sendAt futuro
 * ENTRE os vivos.
 */
export function nextScheduled(world: string): { count: number; nextAt: number | null } {
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
    .map((c) => Date.parse(typeof c.sendAt === 'string' ? c.sendAt : ''))
    .filter((t) => Number.isFinite(t) && t > agora)
    .sort((a, b) => a - b);
  return { count: vivos.length, nextAt: future[0] ?? null };
}

/** Assinatura do que a Início mostra (muda → redesenha; Onda B "ao vivo"). */
function homeSignature(world: string): string {
  const sched = nextScheduled(world);
  const vanta = vantaLaunchers()
    .map((l) => (isVantaEnabled(l.id) ? 1 : 0))
    .join('');
  return `${tshPanelSignature(world)}#${vanta}#${sched.count}:${sched.nextAt ?? ''}`;
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
    const now = homeSignature(world);
    if (now === signature) return;
    signature = now;
    const scroller = container.closest('.shs-body');
    const top = scroller?.scrollTop ?? 0;
    drawHome(container);
    if (scroller !== null) scroller.scrollTop = top;
  }, 3_000);
  return () => window.clearInterval(timer);
}

function drawHome(container: HTMLElement): void {
  ensureHomeStyles(container);
  container.replaceChildren();
  const grid = document.createElement('div');
  grid.className = 'home-grid';

  const license = licenseState();
  const gctx = gameContext();
  const ctx = {
    player: gctx.player,
    world: gctx.world,
    coord: (() => {
      const gd = pageWindow().game_data as { village?: { x?: number; y?: number; name?: string } } | undefined;
      const v = gd?.village;
      return v !== undefined && typeof v.x === 'number' && typeof v.y === 'number'
        ? { coord: `${v.x}|${v.y}`, name: v.name ?? null }
        : null;
    })(),
  };

  // ── Conta & licença ──
  // [8] Kicker ban: sem eyebrow "SUA CONTA" sobre o heading — o NOME do
  // jogador é o título do card e as linhas seguem direto.
  const conta = card(null, 'user');
  const player = document.createElement('h3');
  player.className = 'home-player';
  player.textContent = ctx.player !== '' ? ctx.player : '—';
  conta.body.appendChild(player);
  conta.body.appendChild(line('globe', `Mundo ${ctx.world}`));
  if (ctx.coord !== null) {
    const nome = ctx.coord.name !== null && ctx.coord.name !== '' ? `${ctx.coord.name} (${ctx.coord.coord})` : ctx.coord.coord;
    conta.body.appendChild(line('target', `Aldeia atual: ${nome}`));
  }
  const licPill = document.createElement('span');
  if (license.kind === 'valida') {
    licPill.className = 'home-pill home-pill--ok';
    licPill.appendChild(icon('check', 11));
    licPill.appendChild(
      document.createTextNode(
        license.licenseExpiresAt !== null ? `Licença válida até ${fmtDate(license.licenseExpiresAt)}` : 'Licença válida',
      ),
    );
  } else if (license.kind === 'graca') {
    licPill.className = 'home-pill home-pill--warn';
    licPill.appendChild(icon('clock', 11));
    licPill.appendChild(document.createTextNode('Licença em modo offline (revalida ao recarregar)'));
  } else {
    licPill.className = 'home-pill home-pill--err';
    licPill.appendChild(icon('alert', 11));
    licPill.appendChild(document.createTextNode('Sem licença ativa'));
  }
  const licRow = document.createElement('div');
  licRow.style.marginTop = '10px';
  licRow.appendChild(licPill);
  conta.body.appendChild(licRow);
  grid.appendChild(conta.box);

  // ── Panorama das ferramentas ──
  const panorama = card('Panorama', 'zap');
  const vantaOn = vantaLaunchers().filter((l) => isVantaEnabled(l.id)).length;
  const autos = tshAutomations();
  const autoOn = autos.filter((a) => isTshEnabled(a.id));
  const armados = autos.filter((a) => a.mutating && a.armExempt !== true && Date.now() < tshArmedUntil(a.id)).length;
  const sched = nextScheduled(currentWorld());
  const stat = (label: string, value: string): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'home-stat';
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('strong');
    v.textContent = value;
    row.append(l, v);
    return row;
  };
  panorama.body.appendChild(stat('Ferramentas Vanta ativas', `${vantaOn}/${vantaLaunchers().length}`));
  panorama.body.appendChild(stat('Automações ativas', `${autoOn.length}/${autos.length}`));
  panorama.body.appendChild(stat('Automações armadas', String(armados)));
  panorama.body.appendChild(
    stat(
      'Comandos agendados',
      sched.count === 0
        ? '0'
        : sched.nextAt !== null
          ? `${sched.count} · próximo ${fmtDate(sched.nextAt)} ${clockLabelMs(sched.nextAt)}`
          : String(sched.count),
    ),
  );
  grid.appendChild(panorama.box);

  // ── Painel de Atividades (status ao vivo das automações) ──
  const atividades = card('Painel de Atividades', 'activity', true);
  const ativos = autos.filter((a) => isTshEnabled(a.id));
  const resumo = document.createElement('div');
  resumo.className = 'home-note';
  resumo.style.marginBottom = '6px';
  resumo.textContent =
    ativos.length === 0
      ? 'Nenhuma automação ativa — ative módulos na aba Automações para acompanhá-los aqui.'
      : `${ativos.length} de ${autos.length} automações ativas neste mundo. Mensagens do último ciclo aparecem ao lado de cada uma.`;
  atividades.body.appendChild(resumo);
  const fmtHora = (epoch: number): string => {
    const d = new Date(epoch);
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  for (const auto of ativos) {
    const row = document.createElement('div');
    row.className = 'home-act';
    const name = document.createElement('span');
    name.className = 'home-act-name';
    name.textContent = auto.label;
    row.appendChild(name);
    const schedule = loadSchedule(currentWorld(), auto.id);
    const status = tshStatus(auto.id, currentWorld());
    const pill = document.createElement('span');
    if (isScheduleStopped(schedule)) {
      pill.className = 'home-pill home-pill--warn';
      pill.textContent = 'Parada';
    } else if (status !== null && status.kind === 'warn') {
      pill.className = 'home-pill home-pill--err';
      pill.textContent = 'Atenção';
    } else if (status !== null && status.kind === 'ok') {
      pill.className = 'home-pill home-pill--ok';
      pill.textContent = 'OK';
    } else {
      pill.className = 'home-pill home-pill--run';
      pill.textContent = 'Em giro';
    }
    row.appendChild(pill);
    if (status !== null && status.message !== '') {
      const msg = document.createElement('span');
      msg.className = 'home-act-msg';
      msg.title = `${fmtHora(status.at)} — ${status.message}`;
      msg.textContent = status.message;
      row.appendChild(msg);
    }
    const nextAt = tshNextRunAt(auto.id, currentWorld());
    if (nextAt !== null && nextAt > Date.now()) {
      const next = document.createElement('span');
      next.className = 'home-act-next';
      next.textContent = `próx. ${fmtHora(nextAt)}`;
      row.appendChild(next);
    }
    atividades.body.appendChild(row);
  }
  grid.appendChild(atividades.box);

  // ── Contato / suporte ──
  const contato = card('Contato & suporte', 'phone');
  const contactRow = document.createElement('div');
  contactRow.className = 'home-contact';
  const phone = document.createElement('span');
  phone.className = 'home-phone';
  phone.textContent = SUPPORT_PHONE;
  const wa = document.createElement('a');
  wa.className = 'home-wa';
  wa.href = SUPPORT_WA;
  wa.target = '_blank';
  wa.rel = 'noopener';
  wa.appendChild(icon('message', 14));
  wa.appendChild(document.createTextNode('Falar no WhatsApp'));
  contactRow.append(phone, wa);
  contato.body.appendChild(contactRow);
  const note = document.createElement('div');
  note.className = 'home-note';
  note.textContent = 'Dúvidas, problemas ou sugestões: chame no WhatsApp da Toxic Squad. A chave de ativação é pessoal — não compartilhe.';
  contato.body.appendChild(note);
  grid.appendChild(contato.box);

  // ── Dicas rápidas ──
  const dicas = card('Dicas rápidas', 'info', true);
  const tip = (iconName: IconName, text: string): void => {
    const row = document.createElement('div');
    row.className = 'home-tip';
    row.appendChild(icon(iconName, 13));
    row.appendChild(document.createTextNode(text));
    dicas.body.appendChild(row);
  };
  tip('search', 'Ctrl+K abre a busca rápida de qualquer tela do jogo — digite o nome da ferramenta e tecle Enter.');
  tip('maximize', 'A janela do painel pode ser arrastada pelo cabeçalho — e duplo clique nele maximiza/restaura. Esc fecha.');
  tip('check', 'Na aba Automações, cada módulo nasce desligado: ative, configure o intervalo em minutos e "arme" os que agem no jogo.');
  tip('info', 'As ferramentas da Suite Vanta aparecem sozinhas na tela certa do jogo (incomings, mapa, praça…). Use "Abrir" para ir até ela.');
  grid.appendChild(dicas.box);

  container.appendChild(grid);
}
