// Faixa de PAUSA fixa no topo do jogo (revisão de produto da Onda 1): com o
// painel fechado, o disjuntor aberto não pode passar despercebido nem parecer
// o aviso dourado de "cravado chegando". A faixa diz o que parou, o que está
// em jogo e retoma ali mesmo — sem abrir o painel. Vive no Shadow DOM do hub.
// Todo texto entra por textContent.

import { ensureHost } from './shell';
import { icon } from './icons';
import { clearHalt, haltLabel, pageShowsBotProtection, type HaltState } from './halt';

const BAR_CLASS = 'tsh-halt-bar';
const STYLE_ID = 'tsh-halt-bar-style';

const STYLES = `
  .${BAR_CLASS} { position: fixed; bottom: 68px; left: 50%; transform: translateX(-50%); z-index: 2147483200;
    width: min(760px, calc(100vw - 32px)); box-sizing: border-box; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 12px 14px; border-radius: 12px; border: 1.5px solid var(--shs-danger, #b3261e);
    background: #ffffff; color: var(--shs-ink-strong, #1b1a17);
    font: 13px/1.4 var(--shs-font, system-ui, sans-serif); box-shadow: 0 10px 28px rgba(20,18,14,.22); }
  .${BAR_CLASS} .tsh-halt-ic { width: 32px; height: 32px; border-radius: 9px; background: var(--shs-danger, #b3261e); color: #fff;
    display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .${BAR_CLASS} .tsh-halt-txt { flex: 1 1 320px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .${BAR_CLASS} strong { font-size: 13.5px; font-weight: 600; color: var(--shs-ink-strong, #1b1a17); }
  .${BAR_CLASS} .tsh-halt-body { font-size: 12.5px; color: var(--shs-ink, #34312c); }
  .${BAR_CLASS} button { flex: none; display: inline-flex; align-items: center; gap: 7px; min-height: 36px; padding: 0 14px;
    border-radius: 9px; cursor: pointer; font: 600 13px var(--shs-font, system-ui, sans-serif);
    border: 0; background: var(--shs-action, #2e6b3e); color: #ffffff; }
  .${BAR_CLASS} button:hover { background: var(--shs-action-hover, #255833); }
  .${BAR_CLASS} button:focus-visible { outline: 2px solid var(--shs-action, #2e6b3e); outline-offset: 2px; }
  .${BAR_CLASS} .tsh-halt-err { flex-basis: 100%; color: var(--shs-danger, #b3261e); font-weight: 600; font-size: 12.5px; }
`;

/**
 * Tenta retomar: recusa se o desafio ainda está VISÍVEL nesta página
 * (retomar ali só reabriria o disjuntor no próximo pedido). Devolve a
 * mensagem de recusa, ou null quando retomou.
 */
export function tryResume(): string | null {
  if (pageShowsBotProtection()) return 'O desafio ainda está aberto nesta página — resolva primeiro e depois retome.';
  clearHalt();
  return null;
}

/** Mostra/atualiza (state) ou remove (null) a faixa. `pending` descreve o que está em jogo. */
export function renderHaltBar(state: HaltState | null, pending: string | null): void {
  const shadow = ensureHost();
  let bar = shadow.querySelector<HTMLDivElement>(`.${BAR_CLASS}`);
  // v3.2.1: com o painel ABERTO o card da Início já mostra a pausa — a faixa
  // some para não cobrir o cabeçalho do painel nem o menu do jogo.
  const panel = shadow.querySelector<HTMLElement>('.shs-panel');
  const inicioVisivel =
    panel !== null &&
    panel.style.display !== 'none' &&
    !panel.classList.contains('shs-panel--min') &&
    shadow.querySelector<HTMLElement>('.shs-body')?.dataset.section === 'inicio';
  if (state === null || inicioVisivel) {
    bar?.remove();
    return;
  }
  if (shadow.getElementById(STYLE_ID) === null) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLES;
    shadow.appendChild(style);
  }
  const texto = `${pending ?? 'Nenhuma automação roda e nenhum pedido sai para o jogo.'} ${
    state.reason === 'captcha' ? 'Aperte F5 se o desafio não aparecer, resolva-o e clique em retomar.' : 'Faça login de novo e clique em retomar.'
  }`;
  if (bar === null) {
    bar = document.createElement('div');
    bar.className = BAR_CLASS;
    bar.setAttribute('role', 'alert');
    const ic = document.createElement('span');
    ic.className = 'tsh-halt-ic';
    ic.appendChild(icon('pause', 16));
    const txt = document.createElement('div');
    txt.className = 'tsh-halt-txt';
    const title = document.createElement('strong');
    const body = document.createElement('span');
    body.className = 'tsh-halt-body';
    txt.append(title, body);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.append(icon('check', 15), document.createTextNode('Já resolvi, retomar'));
    const err = document.createElement('div');
    err.className = 'tsh-halt-err';
    err.hidden = true;
    btn.addEventListener('click', () => {
      const recusa = tryResume();
      if (recusa === null) {
        bar?.remove();
        return;
      }
      err.textContent = recusa;
      err.hidden = false;
    });
    bar.append(ic, txt, btn, err);
    shadow.appendChild(bar);
  }
  const title = bar.querySelector('strong');
  const body = bar.querySelector('.tsh-halt-body');
  const tituloTxt = `Script pausado: ${haltLabel(state)}`;
  if (title !== null && title.textContent !== tituloTxt) title.textContent = tituloTxt;
  if (body !== null && body.textContent !== texto) body.textContent = texto;
}
