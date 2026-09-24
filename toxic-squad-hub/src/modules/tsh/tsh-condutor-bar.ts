// Faixa do Condutor (v3.2.2): o aviso "esta aba vai à Praça em N s" precisa
// ser VISTO — a dica do escudo só aparece no hover. Mesmo lugar e forma da
// faixa de pausa (acima do escudo), cor por gravidade, botões "Ir agora" e
// "Não levar esta aba". Todo texto entra por textContent.

import { ensureHost } from '../../core/shell';
import { icon } from '../../core/icons';
import { cancelReturn, declineNav, goToPlaceOf, type ConductorBar } from './tsh-condutor';

const BAR_CLASS = 'tsh-cond-bar';
const STYLE_ID = 'tsh-cond-bar-style';

const STYLES = `
  .${BAR_CLASS} { position: fixed; bottom: 68px; left: 50%; transform: translateX(-50%); z-index: 2147483150;
    width: min(680px, calc(100vw - 32px)); box-sizing: border-box; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 10px 12px; border-radius: 12px; border: 1.5px solid var(--shs-action, #2e6b3e);
    background: #ffffff; color: var(--shs-ink-strong, #1b1a17);
    font: 13px/1.4 var(--shs-font, system-ui, sans-serif); box-shadow: 0 10px 28px rgba(20,18,14,.22); }
  .${BAR_CLASS}[data-kind='warn'] { border-color: var(--shs-warn, #b26a00); }
  .${BAR_CLASS}[data-kind='danger'] { border-color: var(--shs-danger, #b3261e); }
  .${BAR_CLASS} .tsh-cond-ic { width: 30px; height: 30px; border-radius: 9px; background: var(--shs-action, #2e6b3e); color: #fff;
    display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .${BAR_CLASS}[data-kind='warn'] .tsh-cond-ic { background: var(--shs-warn, #b26a00); }
  .${BAR_CLASS}[data-kind='danger'] .tsh-cond-ic { background: var(--shs-danger, #b3261e); }
  .${BAR_CLASS} .tsh-cond-txt { flex: 1 1 300px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .${BAR_CLASS} strong { font-size: 13.5px; font-weight: 600; }
  .${BAR_CLASS} .tsh-cond-body { font-size: 12.5px; color: var(--shs-ink, #34312c); }
  .${BAR_CLASS} .tsh-cond-btns { display: flex; gap: 8px; flex: none; }
  .${BAR_CLASS} button { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 0 12px;
    border-radius: 9px; cursor: pointer; font: 600 12.5px var(--shs-font, system-ui, sans-serif);
    border: 1px solid var(--shs-border-strong, #cfc9bd); background: #fff; color: var(--shs-ink-strong, #1b1a17); }
  .${BAR_CLASS} button.tsh-cond-go { border-color: transparent; background: var(--shs-action, #2e6b3e); color: #fff; }
  .${BAR_CLASS} button:focus-visible { outline: 2px solid var(--shs-action, #2e6b3e); outline-offset: 2px; }
`;

/** Estado mostrado agora (para só redesenhar quando muda). */
let shownSig = '';

/** Mostra/atualiza (bar) ou remove (null) a faixa do Condutor. */
export function renderConductorBar(bar: ConductorBar | null): void {
  const shadow = ensureHost();
  const current = shadow.querySelector<HTMLDivElement>(`.${BAR_CLASS}`);
  if (bar === null) {
    current?.remove();
    shownSig = '';
    return;
  }
  const sig = JSON.stringify([bar.kind, bar.title, bar.body, bar.record?.id ?? '', bar.canDecline === true]);
  if (current !== null && sig === shownSig) return;
  shownSig = sig;
  if (shadow.getElementById(STYLE_ID) === null) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLES;
    shadow.appendChild(style);
  }
  const el = current ?? document.createElement('div');
  el.className = BAR_CLASS;
  el.dataset.kind = bar.kind;
  el.setAttribute('role', bar.kind === 'danger' ? 'alert' : 'status');
  el.replaceChildren();
  const ic = document.createElement('span');
  ic.className = 'tsh-cond-ic';
  ic.appendChild(icon(bar.kind === 'danger' ? 'alert' : 'crosshair', 15));
  const txt = document.createElement('div');
  txt.className = 'tsh-cond-txt';
  const title = document.createElement('strong');
  title.textContent = bar.title;
  const body = document.createElement('span');
  body.className = 'tsh-cond-body';
  body.textContent = bar.body;
  txt.append(title, body);
  const btns = document.createElement('div');
  btns.className = 'tsh-cond-btns';
  const record = bar.record;
  if (bar.canDecline === true) {
    const no = document.createElement('button');
    no.type = 'button';
    no.textContent = 'Não levar esta aba';
    no.addEventListener('click', () => {
      if (record !== undefined) declineNav(record);
      else cancelReturn();
      el.remove();
      shownSig = '';
    });
    btns.appendChild(no);
  }
  if (record !== undefined) {
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'tsh-cond-go';
    go.append(icon('arrowRight', 14), document.createTextNode('Ir agora'));
    go.addEventListener('click', () => goToPlaceOf(record));
    btns.appendChild(go);
  }
  el.append(ic, txt, btns);
  if (current === null) shadow.appendChild(el);
}
