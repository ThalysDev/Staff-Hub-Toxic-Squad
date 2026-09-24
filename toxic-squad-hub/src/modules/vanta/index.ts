// Suite Vanta — bootstrap da suíte dentro do Toxic Squad Hub.
// Os módulos autorregistram launchers (import side-effect, padrão do projeto);
// aqui fica a seção do painel (linhas de launchers por grupo Defesa /
// Blindagem / Utilidades no padrão de linhas Nexus) e o auto-run das injeções
// de página (tela certa ou flag de navegação do launcher).

import { icon, type IconName } from '../../core/icons';
import { closePanel } from '../../core/shell';
import { spinner } from '../../core/ui';
import {
  groupLabel,
  isVantaEnabled,
  launchVanta,
  mountVanta,
  setVantaEnabled,
  unmountVanta,
  vantaLaunchers,
  type VantaGroup,
  type VantaLauncher,
} from './vanta-registry';

import './apoio-massa';
import './autocunhar';
import './blindagem';
import './bonus-diario';
import './cancelamento-bloco';
import './coletor';
import './cravar-confirmacao';
import './dashboard';
import './etiquetador';
import './grupos-io';
import './inspecao-mapa';
import './mapa-enxuto';
import './notas-campo';
import './overview-agenda';
import './previa-aldeia';
import './reliquias';
import './renomeador';
import './stack-health';
import './visao-apoios';

export { runVantaOnLoad } from './vanta-registry';

const GROUP_ORDER: VantaGroup[] = ['defesa', 'blindagem', 'utilidades'];
const GROUP_ICONS: Record<VantaGroup, IconName> = { defesa: 'sword', blindagem: 'shieldCheck', utilidades: 'list' };
/** Cor do ícone do launcher por grupo (Nexus: ação / latão / info). */
const GROUP_COLORS: Record<VantaGroup, string> = {
  defesa: 'var(--shs-action, #6d3c14)',
  blindagem: 'var(--shs-brass, #b8860b)',
  utilidades: 'var(--shs-info, #2f66c0)',
};

const VTS_STYLE_ID = 'vanta-suite-styles';
const VTS_STYLES = `
  .vts-wrap {
    background: var(--shs-bg-card, #fffdf3);
    border: 1px solid var(--shs-border, #e0cda0);
    border-radius: 10px;
    padding: 12px 14px 10px;
  }
  .vts-head { display: flex; align-items: center; gap: 8px; }
  /* [5] Padrão compartilhado: título de seção 16px/700. */
  .vts-title { font-size: 16px; font-weight: 700; color: var(--shs-ink-strong, #3c250a); letter-spacing: .2px; }
  .vts-count {
    font-size: 11px; font-weight: 600; line-height: 1;
    padding: 4px 9px; border-radius: 999px;
    background: var(--shs-bg-card, #fffdf3); border: 1px solid var(--shs-border-strong, #cbb384); color: var(--shs-ink, #5a3a16);
  }
  .vts-group {
    display: flex; align-items: center; gap: 6px;
    margin: 14px 0 0;
    font-size: 10.5px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;
    color: var(--shs-muted, #6f5e40);
  }
  .vts-group-count {
    font-size: 10px; font-weight: 700; letter-spacing: 0; line-height: 1;
    padding: 2px 7px; border-radius: 999px;
    background: var(--shs-bg-inset, #f4ead0); color: var(--shs-muted, #6f5e40);
  }
  .vts-row { display: flex; align-items: center; gap: 10px; padding: 10px 4px; }
  .vts-row + .vts-row { border-top: 1px dashed var(--shs-border-head, #d9c48f); }
  /* [7] Linha desligada por COR DE TEXTO dedicada — sem opacity (par com a
     esteira tsh, que bane opacity <0.7 para estado OFF). */
  .vts-row[data-off] .vts-ic { color: var(--shs-ink-disabled, #b3a27d); }
  .vts-row[data-off] .vts-name { color: var(--shs-ink-disabled, #b3a27d); }
  /* [5] Padrão compartilhado: caixa de ícone 30px. */
  .vts-ic {
    flex: none; width: 30px; height: 30px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    background: var(--shs-bg-inset, #f4ead0);
  }
  .vts-main { flex: 1; min-width: 0; }
  .vts-name { font-size: 13px; font-weight: 600; color: var(--shs-ink-strong, #3c250a); }
  .vts-desc { font-size: 11.5px; color: var(--shs-muted, #6f5e40); margin-top: 1px; }
  .vts-side { flex: none; display: flex; align-items: center; gap: 8px; }
  .vts-chip {
    font-size: 10px; font-weight: 600; line-height: 1; white-space: nowrap;
    padding: 3px 8px; border-radius: 999px;
  }
  .vts-chip--here { background: var(--shs-ok-bg, #e8f4e2); color: var(--shs-ok, #3f8f43); }
  .vts-chip--away { background: var(--shs-bg-inset, #f4ead0); color: var(--shs-muted, #6f5e40); font-weight: 500; }
  /* [7] Estado OFF com chip dedicado (sem opacity na linha). */
  .vts-chip--off { background: var(--shs-bg-inset, #f4ead0); color: var(--shs-muted, #6f5e40); font-weight: 500; }
  /* [6] Feedback do "Montar": pill temporária verde/vermelha na linha. */
  .vts-chip--ok { background: var(--shs-ok-bg, #e8f4e2); color: var(--shs-ok, #3f8f43); }
  .vts-chip--err { background: var(--shs-danger-bg, #fceaea); color: var(--shs-danger, #c04038); }
  /* [5] Padrão compartilhado: switch 36×20 com knob de 14px. */
  .vts-switch {
    position: relative; flex: none; width: 36px; height: 20px;
    border: none; border-radius: 999px; padding: 0; cursor: pointer;
    background: var(--shs-switch-off, #d8cbb0); transition: background .15s ease;
  }
  .vts-switch::after {
    content: ''; position: absolute; top: 3px; left: 3px;
    width: 14px; height: 14px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 2px rgba(60, 37, 10, .25);
    transition: left .15s ease;
  }
  .vts-switch[aria-checked='true'] { background: var(--shs-action, #6d3c14); }
  .vts-switch[aria-checked='true']::after { left: 19px; }
  /* [5] Padrão compartilhado: play circular 28px. */
  .vts-go, .vts-open {
    flex: none; width: 28px; height: 28px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    border: none; cursor: pointer;
  }
  .vts-go { border-radius: 50%; background: var(--shs-ok, #3f8f43); color: #fff; }
  .vts-go:hover:not(:disabled) { background: var(--shs-ok-hover, #357a39); }
  .vts-go:disabled { background: var(--shs-switch-off, #d8cbb0); cursor: not-allowed; }
  /* [6] Carregando: mantém o verde (o :disabled padrão é o cinza de OFF). */
  .vts-go--loading:disabled { background: var(--shs-ok-hover, #357a39); cursor: progress; }
  .vts-open { border-radius: 8px; background: transparent; color: var(--shs-ink, #5a3a16); }
  .vts-open:hover:not(:disabled) { background: var(--shs-bg-inset, #f4ead0); }
  .vts-open:disabled { color: #b3a37f; cursor: not-allowed; }
  .vts-foot { margin-top: 10px; font-size: 10.5px; color: var(--shs-muted, #6f5e40); }
  .vts-empty { padding: 10px 2px; font-size: 12px; color: var(--shs-muted, #6f5e40); }

  /* ---- Instrumento (redesign v3.2): mesma linguagem de Automações ---- */
  .vts-wrap { background: transparent; border: 0; border-radius: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
  .vts-head { gap: 10px; }
  .vts-title { font-size: 20px; font-weight: 600; letter-spacing: -.015em; color: var(--shs-ink-strong); }
  .vts-count { height: 24px; padding: 0 9px; display: inline-flex; align-items: center; border: 0; border-radius: 999px;
    background: var(--shs-bg-inset); color: var(--shs-ink); font-size: 12px; font-weight: 500; font-family: var(--shs-font-mono); }
  .vts-group { margin: 6px 0 0; font-size: 13px; font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--shs-ink-strong); }
  .vts-group .shs-ic { color: var(--shs-muted); }
  .vts-group-count { background: none; padding: 0; font-family: var(--shs-font-mono); font-size: 12px; font-weight: 400; color: var(--shs-muted); }
  .vts-rows { background: var(--shs-bg-card); border: 1px solid var(--shs-border); border-radius: 12px; overflow: hidden; }
  .vts-row { min-height: 56px; box-sizing: border-box; padding: 8px 12px 8px 16px; gap: 12px; background: var(--shs-bg-card); }
  .vts-row + .vts-row { border-top: 1px solid var(--shs-bg-inset); }
  .vts-row:hover { background: var(--shs-bg-side); }
  .vts-ic { width: 32px; height: 32px; border-radius: 8px; background: var(--shs-bg-inset); color: var(--shs-ink) !important; }
  .vts-name { font-size: 13.5px; font-weight: 500; color: var(--shs-ink-strong); }
  .vts-desc { font-size: 12px; color: var(--shs-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vts-chip { height: 24px; padding: 0 9px; display: inline-flex; align-items: center; font-size: 12px; font-weight: 500; }
  .vts-chip--here { background: var(--shs-ok-bg); color: var(--shs-ok-ink); }
  .vts-go { width: 32px; height: 32px; background: transparent; color: var(--shs-ink); border-radius: 9px; }
  .vts-go:hover:not(:disabled) { background: var(--shs-bg-inset); color: var(--shs-ink-strong); }
  .vts-go:disabled, .vts-open:disabled { background: transparent; color: var(--shs-ink-disabled); opacity: .6; }
  .vts-go--loading:disabled { background: transparent; color: var(--shs-ink); opacity: 1; }
  .vts-row[data-off] .vts-name, .vts-row[data-off] .vts-desc { color: var(--shs-muted); }
  .vts-chip--here { background: var(--shs-bg-inset); color: var(--shs-ink); }
  .vts-open { width: 32px; height: 32px; border-radius: 9px; }
  .vts-foot { font-size: 12px; }
`;

/** Injeta (1×, idempotente por id) o <style> da seção no root do container. */
function ensureVantaStyles(container: HTMLElement): void {
  const root = container.getRootNode();
  const scope: Document | ShadowRoot | HTMLElement =
    root instanceof Document || root instanceof ShadowRoot ? root : container;
  if (scope.querySelector(`#${VTS_STYLE_ID}`) !== null) return;
  const style = document.createElement('style');
  style.id = VTS_STYLE_ID;
  style.textContent = VTS_STYLES;
  scope.appendChild(style);
}

/** Linha de um launcher: ícone do grupo, nome+desc, chip de tela, toggle e ação. */
function launcherRow(launcher: VantaLauncher, rerender: () => void): HTMLElement {
  const here = launcher.match();
  const enabled = isVantaEnabled(launcher.id);

  const row = document.createElement('div');
  row.className = 'vts-row';
  row.dataset.searchId = `vanta:${launcher.id}`; // alvo da busca rápida (Onda C)
  // Gate visual: módulo desligado fica esmaecido e a ação fica inerte.
  if (!enabled) row.dataset.off = '1';

  const badge = document.createElement('span');
  badge.className = 'vts-ic';
  // [7] Cor do grupo só quando ligado — desligado usa a cor dedicada do CSS
  // (inline venceria a regra de .vts-row[data-off]).
  if (enabled) badge.style.color = GROUP_COLORS[launcher.group];
  badge.appendChild(icon(launcher.icon ?? GROUP_ICONS[launcher.group], 15));
  row.appendChild(badge);

  const main = document.createElement('div');
  main.className = 'vts-main';
  const name = document.createElement('div');
  name.className = 'vts-name';
  name.textContent = launcher.label;
  const desc = document.createElement('div');
  desc.className = 'vts-desc';
  desc.textContent = launcher.desc;
  main.append(name, desc);
  row.appendChild(main);

  const side = document.createElement('div');
  side.className = 'vts-side';

  // [7] Chip de estado: desligado tem chip próprio (sem opacity na linha).
  const chip = document.createElement('span');
  if (!enabled) {
    chip.className = 'vts-chip vts-chip--off';
    chip.textContent = 'Desligada';
  } else {
    chip.className = here ? 'vts-chip vts-chip--here' : 'vts-chip vts-chip--away';
    chip.textContent = here ? 'Nesta tela' : 'Outra tela';
  }
  side.appendChild(chip);

  // Toggle iOS: liga/desliga o módulo (desligar já desmonta via setVantaEnabled).
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'vts-switch';
  toggle.role = 'switch';
  toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
  toggle.title = enabled ? `Desligar ${launcher.label}` : `Ligar ${launcher.label}`;
  toggle.setAttribute('aria-label', toggle.title);
  toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
  toggle.addEventListener('click', () => {
    setVantaEnabled(launcher.id, !isVantaEnabled(launcher.id));
    rerender();
  });
  side.appendChild(toggle);

  // Ação única: na tela certa é "Montar" (play verde); fora, "Abrir" (seta ghost).
  const go = document.createElement('button');
  go.type = 'button';
  go.disabled = !enabled;
  go.addEventListener('click', () => {
    if (!here) {
      launchVanta(launcher.id);
      rerender();
      return;
    }
    // [6] Feedback do "Montar": botão em carregando → mountVanta → pill
    // temporária (verde "montado" 2s / vermelha 3s se a UI não apareceu).
    const antes = new Map<string, Element>();
    for (const el of document.querySelectorAll('[id^="vanta-"]')) antes.set(el.id, el);
    go.disabled = true;
    go.classList.add('vts-go--loading');
    go.replaceChildren(spinner());
    const resultadoMount = mountVanta(launcher.id); // síncrono — o DOM já assentou na volta
    const montou =
      resultadoMount.ok &&
      Array.from(document.querySelectorAll('[id^="vanta-"]')).some((el) => antes.get(el.id) !== el);
    go.classList.remove('vts-go--loading');
    go.disabled = false;
    go.replaceChildren(icon('play', 12));
    side.querySelector('.vts-result')?.remove();
    // v3.2.1: a ferramenta abre NA PÁGINA — fecha o painel para ela não nascer
    // atrás dele, leva a página até ela e dá um contorno verde breve.
    if (montou) {
      closePanel();
      const novo = Array.from(document.querySelectorAll<HTMLElement>('[id^="vanta-"]')).find((el) => antes.get(el.id) !== el);
      if (novo !== undefined) {
        if (getComputedStyle(novo).position !== 'fixed') novo.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const antigo = novo.style.outline;
        novo.style.outline = '2px solid var(--shs-action, #2e6b3e)';
        novo.style.outlineOffset = '2px';
        window.setTimeout(() => {
          novo.style.outline = antigo;
        }, 1_600);
      }
      return;
    }
    const resultado = document.createElement('span');
    resultado.className = montou ? 'vts-chip vts-chip--ok vts-result' : 'vts-chip vts-chip--err vts-result';
    resultado.textContent = montou
      ? 'Pronto'
      : resultadoMount.error !== undefined
        ? `Falhou: ${resultadoMount.error}`
        : 'Esta tela do jogo não tem onde abrir a ferramenta';
    side.appendChild(resultado);
    window.setTimeout(() => resultado.remove(), montou ? 2000 : 5000);
  });
  if (here) {
    go.className = 'vts-go';
    go.appendChild(icon('play', 12));
    go.title = 'Abrir nesta tela';
  } else {
    go.className = 'vts-open';
    go.appendChild(icon('arrowRight', 13));
    go.title = 'Ir para a tela da ferramenta';
  }
  go.setAttribute('aria-label', go.title);
  side.appendChild(go);

  row.appendChild(side);
  return row;
}

/** Seção "Suite Vanta" do painel: launchers por grupo + estado da página. */
export function renderVantaSuite(container: HTMLElement): void {
  ensureVantaStyles(container);
  const wrap = document.createElement('div');
  wrap.className = 'vts-wrap';
  const all = vantaLaunchers();

  if (all.length === 0) {
    const vazio = document.createElement('div');
    vazio.className = 'vts-empty';
    vazio.textContent = 'Nenhum módulo registrado.';
    wrap.appendChild(vazio);
    container.appendChild(wrap);
    return;
  }

  const rerender = (): void => {
    container.replaceChildren();
    renderVantaSuite(container);
  };

  // Cabeçalho: título + pill fantasma com nº de módulos ativos.
  const head = document.createElement('div');
  head.className = 'vts-head';
  const title = document.createElement('div');
  title.className = 'vts-title';
  title.textContent = 'Ferramentas';
  const ativos = all.filter((launcher) => isVantaEnabled(launcher.id)).length;
  const count = document.createElement('span');
  count.className = 'vts-count';
  count.textContent = `${ativos} ativos`;
  head.append(title, count);
  wrap.appendChild(head);

  GROUP_ORDER.forEach((group) => {
    const items = all.filter((launcher) => launcher.group === group);
    if (items.length === 0) return;
    const ghead = document.createElement('div');
    ghead.className = 'vts-group';
    ghead.appendChild(icon(GROUP_ICONS[group], 14));
    const glabel = document.createElement('span');
    glabel.textContent = groupLabel(group);
    const gcount = document.createElement('span');
    gcount.className = 'vts-group-count';
    gcount.textContent = String(items.length);
    ghead.append(glabel, gcount);
    wrap.appendChild(ghead);
    // Onda C: as ferramentas desta página primeiro (o resto mantém a ordem).
    const ordenados = [...items].sort((a, b) => Number(b.match()) - Number(a.match()));
    const rows = document.createElement('div');
    rows.className = 'vts-rows'; // cartão do grupo (Instrumento)
    ordenados.forEach((launcher) => rows.appendChild(launcherRow(launcher, rerender)));
    wrap.appendChild(rows);
  });

  const foot = document.createElement('div');
  foot.className = 'vts-foot';
  foot.textContent =
    'Módulos habilitados injetam sozinhos ao abrir a tela certa. "Montar" injeta agora; "Abrir" navega até a tela.';
  wrap.appendChild(foot);

  container.appendChild(wrap);
}

/** Remonta um módulo já montado (re-render manual após mudanças na página). */
export function refreshVanta(id: string): void {
  unmountVanta(id);
  mountVanta(id);
}
