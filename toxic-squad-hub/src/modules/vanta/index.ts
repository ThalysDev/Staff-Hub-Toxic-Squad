// Suite Vanta — bootstrap da suíte dentro do Toxic Squad Hub.
// Os módulos autorregistram launchers (import side-effect, padrão do projeto);
// aqui fica a seção do painel (linhas de launchers por grupo Defesa /
// Blindagem / Utilidades no padrão de linhas Nexus) e o auto-run das injeções
// de página (tela certa ou flag de navegação do launcher).

import { icon, type IconName } from '../../core/icons';
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
const GROUP_COLORS: Record<VantaGroup, string> = { defesa: '#6d3c14', blindagem: '#b8860b', utilidades: '#2f66c0' };

const VTS_STYLE_ID = 'vanta-suite-styles';
const VTS_STYLES = `
  .vts-wrap {
    background: #fffdf3;
    border: 1px solid #e0cda0;
    border-radius: 10px;
    padding: 12px 14px 10px;
  }
  .vts-head { display: flex; align-items: center; gap: 8px; }
  /* [5] Padrão compartilhado: título de seção 16px/700. */
  .vts-title { font-size: 16px; font-weight: 700; color: #3c250a; letter-spacing: .2px; }
  .vts-count {
    font-size: 11px; font-weight: 600; line-height: 1;
    padding: 4px 9px; border-radius: 999px;
    background: #fffdf3; border: 1px solid #cbb384; color: #5a3a16;
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
    background: #f4ead0; color: var(--shs-muted, #6f5e40);
  }
  .vts-row { display: flex; align-items: center; gap: 10px; padding: 10px 4px; }
  .vts-row + .vts-row { border-top: 1px dashed #d9c48f; }
  /* [7] Linha desligada por COR DE TEXTO dedicada — sem opacity (par com a
     esteira tsh, que bane opacity <0.7 para estado OFF). */
  .vts-row[data-off] .vts-ic { color: #b3a27d; }
  .vts-row[data-off] .vts-name { color: #b3a27d; }
  /* [5] Padrão compartilhado: caixa de ícone 30px. */
  .vts-ic {
    flex: none; width: 30px; height: 30px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    background: #f4ead0;
  }
  .vts-main { flex: 1; min-width: 0; }
  .vts-name { font-size: 13px; font-weight: 600; color: #3c250a; }
  .vts-desc { font-size: 11.5px; color: var(--shs-muted, #6f5e40); margin-top: 1px; }
  .vts-side { flex: none; display: flex; align-items: center; gap: 8px; }
  .vts-chip {
    font-size: 10px; font-weight: 600; line-height: 1; white-space: nowrap;
    padding: 3px 8px; border-radius: 999px;
  }
  .vts-chip--here { background: #e8f4e2; color: #3f8f43; }
  .vts-chip--away { background: #f4ead0; color: var(--shs-muted, #6f5e40); font-weight: 500; }
  /* [7] Estado OFF com chip dedicado (sem opacity na linha). */
  .vts-chip--off { background: #f4ead0; color: var(--shs-muted, #6f5e40); font-weight: 500; }
  /* [6] Feedback do "Montar": pill temporária verde/vermelha na linha. */
  .vts-chip--ok { background: #e8f4e2; color: #3f8f43; }
  .vts-chip--err { background: #fceaea; color: #c04038; }
  /* [5] Padrão compartilhado: switch 36×20 com knob de 14px. */
  .vts-switch {
    position: relative; flex: none; width: 36px; height: 20px;
    border: none; border-radius: 999px; padding: 0; cursor: pointer;
    background: #d8cbb0; transition: background .15s ease;
  }
  .vts-switch::after {
    content: ''; position: absolute; top: 3px; left: 3px;
    width: 14px; height: 14px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 2px rgba(60, 37, 10, .25);
    transition: left .15s ease;
  }
  .vts-switch[aria-checked='true'] { background: #6d3c14; }
  .vts-switch[aria-checked='true']::after { left: 19px; }
  /* [5] Padrão compartilhado: play circular 28px. */
  .vts-go, .vts-open {
    flex: none; width: 28px; height: 28px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    border: none; cursor: pointer;
  }
  .vts-go { border-radius: 50%; background: #3f8f43; color: #fff; }
  .vts-go:hover:not(:disabled) { background: #357a39; }
  .vts-go:disabled { background: #d8cbb0; cursor: not-allowed; }
  /* [6] Carregando: mantém o verde (o :disabled padrão é o cinza de OFF). */
  .vts-go--loading:disabled { background: #357a39; cursor: progress; }
  .vts-open { border-radius: 8px; background: transparent; color: #5a3a16; }
  .vts-open:hover:not(:disabled) { background: #f4ead0; }
  .vts-open:disabled { color: #b3a37f; cursor: not-allowed; }
  .vts-foot { margin-top: 10px; font-size: 10.5px; color: var(--shs-muted, #6f5e40); }
  .vts-empty { padding: 10px 2px; font-size: 12px; color: var(--shs-muted, #6f5e40); }
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
  // Gate visual: módulo desligado fica esmaecido e a ação fica inerte.
  if (!enabled) row.dataset.off = '1';

  const badge = document.createElement('span');
  badge.className = 'vts-ic';
  // [7] Cor do grupo só quando ligado — desligado usa a cor dedicada do CSS
  // (inline venceria a regra de .vts-row[data-off]).
  if (enabled) badge.style.color = GROUP_COLORS[launcher.group];
  badge.appendChild(icon(GROUP_ICONS[launcher.group], 15));
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
    chip.textContent = 'desligado';
  } else {
    chip.className = here ? 'vts-chip vts-chip--here' : 'vts-chip vts-chip--away';
    chip.textContent = here ? 'nesta página' : 'outra tela';
  }
  side.appendChild(chip);

  // Toggle iOS: liga/desliga o módulo (desligar já desmonta via setVantaEnabled).
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'vts-switch';
  toggle.role = 'switch';
  toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
  toggle.title = enabled ? 'Desativar módulo' : 'Ativar módulo';
  toggle.setAttribute('aria-label', toggle.title);
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
    mountVanta(launcher.id); // síncrono — o DOM já assentou na volta
    const montou = Array.from(document.querySelectorAll('[id^="vanta-"]')).some(
      (el) => antes.get(el.id) !== el,
    );
    go.classList.remove('vts-go--loading');
    go.disabled = false;
    go.replaceChildren(icon('play', 12));
    side.querySelector('.vts-result')?.remove();
    const resultado = document.createElement('span');
    resultado.className = montou ? 'vts-chip vts-chip--ok vts-result' : 'vts-chip vts-chip--err vts-result';
    resultado.textContent = montou ? 'montado' : 'não foi possível montar nesta tela';
    side.appendChild(resultado);
    window.setTimeout(() => resultado.remove(), montou ? 2000 : 3000);
  });
  if (here) {
    go.className = 'vts-go';
    go.appendChild(icon('play', 12));
    go.title = 'Montar — injetar na página atual';
  } else {
    go.className = 'vts-open';
    go.appendChild(icon('arrowRight', 13));
    go.title = 'Abrir — navegar até a tela do módulo';
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
  title.textContent = 'Suite Vanta';
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
    ghead.appendChild(icon(GROUP_ICONS[group], 12));
    const glabel = document.createElement('span');
    glabel.textContent = groupLabel(group);
    const gcount = document.createElement('span');
    gcount.className = 'vts-group-count';
    gcount.textContent = String(items.length);
    ghead.append(glabel, gcount);
    wrap.appendChild(ghead);
    items.forEach((launcher) => wrap.appendChild(launcherRow(launcher, rerender)));
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
