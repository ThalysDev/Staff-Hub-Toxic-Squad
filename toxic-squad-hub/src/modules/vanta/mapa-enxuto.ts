// Mapa Enxuto — reduz a poluição visual do mapa do jogo (screen=map) injetando
// um <style id="tsh-mapa-enxuto"> que suaviza somente overlays DECORATIVOS:
// selos de hobby/conquista/medalha empilhados sobre a aldeia e ornamentos do
// hexágono. Nada mais é tocado (aldeias, coordenadas, bandeiras, ícones de
// ataque/apoio continuam intactos).
//
// Decisões (e o porquê):
// - Seletores CONSERVADORES por substring de classe: se o jogo não usar um
//   desses nomes, a regra simplesmente não casa (zero efeito, nada quebra). Só
//   opacity/escala são alteradas — sem display:none e sem pointer-events em
//   nada que carregue informação; os selos decorativos ficam inertes ao clique,
//   então o aldeão por baixo continua clicável.
// - Preferência em GM storage (`tsh-vanta:mapa-enxuto:enabled`): o estilo é
//   aplicado no mount quando ligado, e o toggle apenas cria/remove o <style>
//   inteiro — desfazer é remover 1 nó, sem resíduo no DOM.
// - Widget flutuante (position: fixed) em vez de card no contentContainer: a
//   tela do mapa usa a página inteira e um card no fluxo empurraria o mapa.
// - P1-4 (padrão da suite): timers/listeners/nós via ModuleScope. O <style>
//   injetado também entra no escopo — desligar o módulo limpa a tela.

import { gm } from '../../core/storage';
import type { ModuleScope } from './vanta-lifecycle';
import { registerVanta } from './vanta-registry';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

const ENABLED_KEY = 'tsh-vanta:mapa-enxuto:enabled';
const WIDGET_ID = 'vanta-mapa-enxuto-ui';
/** Id do <style> injetado no documento (remover o nó = desfazer completo). */
export const MAPA_ENXUTO_STYLE_ID = 'tsh-mapa-enxuto';
/** Recontagem do que foi reduzido (o jogo re-renderiza setores do mapa). */
const RECOUNT_MS = 10_000;

/** Selos decorativos empilhados sobre o hexágono da aldeia. */
const DECO_ICON_TOKENS = [
  'map_hex_deco',
  'map_hex_hobby',
  'map_hex_achievement',
  'map_hex_conquest',
  'map_hex_medal',
];
/** Ornamentos de terreno (padrões/brilhos do hexágono) — não são informação. */
const ORNAMENT_TOKENS = ['map_hex_pattern', 'map_hex_ornament', 'map_hex_glow', 'map_hex_grid_deco'];

function selectorFor(tokens: string[]): string {
  return tokens.map((token) => `[class*="${token}"]`).join(', ');
}

export const MAPA_ENXUTO_ICON_SELECTOR = selectorFor(DECO_ICON_TOKENS);
export const MAPA_ENXUTO_ORNAMENT_SELECTOR = selectorFor(ORNAMENT_TOKENS);
/** Tudo que o modo enxuto alcança (usado no CSS e na contagem da UI). */
export const MAPA_ENXUTO_SELECTOR = `${MAPA_ENXUTO_ICON_SELECTOR}, ${MAPA_ENXUTO_ORNAMENT_SELECTOR}`;

export const MAPA_ENXUTO_CSS = `
  /* Selos decorativos (hobby/conquista/medalha): quase invisíveis, menores e
     inertes ao clique (o aldeão por baixo segue clicável). */
  ${MAPA_ENXUTO_ICON_SELECTOR} {
    opacity: .12 !important;
    transform: scale(.7) !important;
    pointer-events: none !important;
  }
  /* Ornamentos de terreno: só suavizados — continuam existindo, sem competir
     com aldeias e comandos. */
  ${MAPA_ENXUTO_ORNAMENT_SELECTOR} {
    opacity: .08 !important;
  }
`;

export function isMapaEnxutoActive(): boolean {
  return document.getElementById(MAPA_ENXUTO_STYLE_ID) !== null;
}

/**
 * Injeta o <style> do modo enxuto (idempotente por id). Com `scope`, o nó
 * entra no ciclo de vida do módulo — desligar o módulo remove o estilo junto.
 */
export function ensureMapaEnxutoStyle(scope?: ModuleScope): void {
  const existing = document.getElementById(MAPA_ENXUTO_STYLE_ID);
  if (existing !== null) {
    if (scope !== undefined) scope.owns(existing);
    return;
  }
  const style = document.createElement('style');
  style.id = MAPA_ENXUTO_STYLE_ID;
  style.textContent = MAPA_ENXUTO_CSS;
  (document.head ?? document.documentElement).appendChild(style);
  if (scope !== undefined) scope.owns(style);
}

/** Remove o estilo injetado: o mapa volta ao visual original na hora. */
export function removeMapaEnxuto(): void {
  document.getElementById(MAPA_ENXUTO_STYLE_ID)?.remove();
}

/** Quantos elementos decorativos as regras alcançam AGORA. */
export function countMapaEnxutoTargets(): number {
  return document.querySelectorAll(MAPA_ENXUTO_SELECTOR).length;
}

const WIDGET_STYLES = `
  #vanta-mapa-enxuto-ui {
    position: fixed; left: 10px; bottom: 10px; z-index: 9999;
    width: 210px; background: #fffdf3; border: 1px solid #e0cda0;
    border-radius: 10px; overflow: hidden;
    box-shadow: 0 2px 8px rgba(60, 37, 10, .25);
    font-family: 'Segoe UI', Arial, sans-serif; font-size: 11.5px; color: #3c250a;
  }
  #vanta-mapa-enxuto-ui * { box-sizing: border-box; }
  #vanta-mapa-enxuto-header {
    padding: 6px 10px; background: #efe2ba; border-bottom: 1px solid #e0cda0;
    font-size: 10.5px; font-weight: 700; letter-spacing: 1.5px;
    text-transform: uppercase; color: #3c250a;
  }
  #vanta-mapa-enxuto-body { padding: 8px 10px 9px; }
  #vanta-mapa-enxuto-row { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  #vanta-mapa-enxuto-status { margin-top: 6px; line-height: 1.35; color: #5a3a16; }
`;

registerVanta({
  id: 'vanta-mapa-enxuto',
  label: 'Mapa Enxuto',
  desc: 'Reduz ícones decorativos do mapa',
  group: 'utilidades',
  match: () => params().get('screen') === 'map',
  url: () => '/game.php?screen=map',
  mount(scope: ModuleScope): void {
    if (document.getElementById(WIDGET_ID) !== null) return;
    if (document.body === null) return;

    const saved = gm.get<boolean>(ENABLED_KEY, false);

    const container = document.createElement('div');
    container.id = WIDGET_ID;
    container.innerHTML = `
            <style>${WIDGET_STYLES}</style>
            <div id="vanta-mapa-enxuto-header"><span>Mapa Enxuto</span></div>
            <div id="vanta-mapa-enxuto-body">
                <label id="vanta-mapa-enxuto-row">
                    <input type="checkbox" id="vanta-mapa-enxuto-toggle" ${saved ? 'checked' : ''}>
                    <span>Reduzir ícones decorativos</span>
                </label>
                <div id="vanta-mapa-enxuto-status"></div>
            </div>
        `;
    document.body.appendChild(container);
    scope.owns(container);

    const toggleEl = document.getElementById('vanta-mapa-enxuto-toggle');
    const statusEl = document.getElementById('vanta-mapa-enxuto-status');

    function setStatus(color: string, text: string): void {
      if (statusEl === null) return;
      statusEl.style.color = color;
      statusEl.textContent = text;
    }

    function updateStatus(): void {
      if (!isMapaEnxutoActive()) {
        setStatus('#5a3a16', 'Desligado — o mapa está no visual original.');
        return;
      }
      const count = countMapaEnxutoTargets();
      if (count === 0) {
        setStatus(
          '#5a3a16',
          'Aplicado — nenhum elemento decorativo encontrado nesta tela (o jogo pode usar outros nomes; nada quebrou).',
        );
        return;
      }
      setStatus('#3f8f43', `Aplicado — ${count} elemento${count === 1 ? '' : 's'} decorativo${count === 1 ? '' : 's'} reduzido${count === 1 ? '' : 's'}.`);
    }

    if (toggleEl instanceof HTMLInputElement) {
      const toggle: HTMLInputElement = toggleEl;
      scope.on(toggle, 'change', () => {
        const on = toggle.checked;
        gm.set(ENABLED_KEY, on);
        if (on) {
          ensureMapaEnxutoStyle(scope);
        } else {
          removeMapaEnxuto();
        }
        updateStatus();
      });
    }

    // Preferência salva: aplica já no carregamento do mapa.
    if (saved) ensureMapaEnxutoStyle(scope);
    updateStatus();
    scope.every(updateStatus, RECOUNT_MS);
  },
});
