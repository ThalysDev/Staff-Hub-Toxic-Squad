// Faixa de PAUSA fixa no topo do jogo (revisão de produto da Onda 1): com o
// painel fechado, o disjuntor aberto não pode passar despercebido nem parecer
// o aviso dourado de "cravado chegando". A faixa diz o que parou, o que está
// em jogo e retoma ali mesmo — sem abrir o painel. Vive no Shadow DOM do hub.
// Todo texto entra por textContent.

import { ensureHost } from './shell';
import { clearHalt, haltLabel, pageShowsBotProtection, type HaltState } from './halt';

const BAR_CLASS = 'tsh-halt-bar';
const STYLE_ID = 'tsh-halt-bar-style';

const STYLES = `
  .${BAR_CLASS} { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 2147483001;
    max-width: min(760px, calc(100vw - 32px)); display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 10px 14px; border-radius: 10px; border: 2px solid var(--shs-danger, #c04038);
    background: var(--shs-danger-bg, #fceaea); color: var(--shs-ink-strong, #3c250a);
    font: 13px/1.35 var(--shs-font-body, system-ui, sans-serif); box-shadow: 0 6px 20px rgba(40,24,6,.35); }
  .${BAR_CLASS} strong { color: var(--shs-danger, #c04038); }
  .${BAR_CLASS} .tsh-halt-txt { flex: 1 1 320px; }
  .${BAR_CLASS} button { flex: none; padding: 7px 12px; border-radius: 8px; cursor: pointer; font-weight: 700;
    border: 1px solid var(--shs-action-dark, #4a2708); background: var(--shs-action, #6d3c14); color: var(--shs-on-dark, #f5ecd0); }
  .${BAR_CLASS} .tsh-halt-err { flex-basis: 100%; color: var(--shs-danger, #c04038); font-weight: 600; }
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
  if (state === null) {
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
    const txt = document.createElement('div');
    txt.className = 'tsh-halt-txt';
    const title = document.createElement('strong');
    const body = document.createElement('span');
    txt.append(title, document.createTextNode(' '), body);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Já resolvi — retomar';
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
    bar.append(txt, btn, err);
    shadow.appendChild(bar);
  }
  const title = bar.querySelector('strong');
  const body = bar.querySelector('.tsh-halt-txt span');
  const tituloTxt = `⚠ Toxic Squad Hub PAUSADO — ${haltLabel(state)}.`;
  if (title !== null && title.textContent !== tituloTxt) title.textContent = tituloTxt;
  if (body !== null && body.textContent !== texto) body.textContent = texto;
}
