// Auto Cunhar (port do TW Vanta, linhas 6023-6131): na tela snob, preenche o
// MÁXIMO de moedas no input de cunhagem e clica em Cunhar, recarregando a
// página no intervalo configurado (segundos).
// Correções embutidas:
// - P1-2 (original 6092-6093): o máximo "(8.532)" era lido com parseInt depois
//   de tirar só os parênteses → "8.532" virava 8. Agora parsePtBrInt (remove o
//   ponto de milhar) e o input recebe String do NÚMERO parseado (não a string
//   com ponto).
// - P2 (original 6084): document.querySelector('.btn-default') pegava o
//   primeiro botão de QUALQUER lugar da página. Agora escopado ao form do
//   input de cunhagem (input/button[type=submit], fallback .btn-default DENTRO
//   do form); sem botão → status de erro claro e NENHUM clique.
// - Confirmação ao LIGAR o automático (automação assumida pelo dono; sem
//   confirmação por ciclo).
// - P1-4: listeners/timers/node via ModuleScope.

import { gm } from '../../core/storage';
import type { ModuleScope } from './vanta-lifecycle';
import { registerVanta } from './vanta-registry';
import { ensureVantaStyles } from './vanta-styles';
import { parsePtBrInt } from './vanta-utils';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

const INTERVAL_KEY = 'tsh-vanta:cunhar:interval';
const ENABLED_KEY = 'tsh-vanta:cunhar:enabled';

function isEnabled(): boolean {
  return gm.get<boolean>(ENABLED_KEY, false);
}

/** Botão de cunhagem escopado ao form do input (P2 do original 6084). */
function findMintButton(mintInput: HTMLInputElement): HTMLElement | null {
  const form = mintInput.closest('form');
  if (form === null) return null;
  return (
    form.querySelector<HTMLButtonElement>('button[type="submit"]') ??
    form.querySelector<HTMLInputElement>('input[type="submit"]') ??
    form.querySelector<HTMLElement>('.btn-default')
  );
}

registerVanta({
  id: 'vanta-autocunhar',
  label: 'Auto Cunhar',
  desc: 'Cunha o máximo de moedas e recarrega a página em intervalo',
  group: 'utilidades',
  match: () => params().get('screen') === 'snob',
  url: () => '/game.php?screen=snob',
  mount(scope: ModuleScope): void {
    ensureVantaStyles();
    if (document.getElementById('vanta-cunhar-ui') !== null) return;

    const contentEl = document.getElementById('contentContainer');
    if (contentEl === null) return;

    const savedInterval = gm.get<number>(INTERVAL_KEY, 30);
    const savedEnabled = gm.get<boolean>(ENABLED_KEY, false);

    const container = document.createElement('div');
    container.id = 'vanta-cunhar-ui';
    container.innerHTML = `
            <div id="vanta-cunhar-header">
                <span id="vanta-cunhar-header-title">Auto Cunhar</span>
            </div>
            <div id="vanta-cunhar-body">
                <label>
                    Intervalo (segundos):
                    <input type="number" id="vanta-cunhar-interval" min="5" max="300" value="${savedInterval}">
                </label>
                <label>
                    Ativar cunhagem automática:
                    <input type="checkbox" id="vanta-cunhar-toggle" ${savedEnabled ? 'checked' : ''}>
                </label>
                <div id="vanta-cunhar-status"></div>
            </div>
        `;
    contentEl.insertBefore(container, contentEl.firstChild);
    scope.owns(container);

    const intervalInputEl = document.getElementById('vanta-cunhar-interval');
    const toggleEl = document.getElementById('vanta-cunhar-toggle');
    const statusEl = document.getElementById('vanta-cunhar-status');
    if (
      !(intervalInputEl instanceof HTMLInputElement) ||
      !(toggleEl instanceof HTMLInputElement) ||
      statusEl === null
    ) {
      return;
    }
    // Consts já estreitadas — o narrowing precisa valer dentro das closures.
    const intervalInput: HTMLInputElement = intervalInputEl;
    const toggle: HTMLInputElement = toggleEl;
    const status: HTMLElement = statusEl;

    function setStatus(color: string, text: string): void {
      status.style.color = color;
      status.textContent = text;
    }

    scope.on(intervalInput, 'change', () => {
      const val = Math.max(5, Math.min(300, parsePtBrInt(intervalInput.value) || 30));
      intervalInput.value = String(val);
      gm.set(INTERVAL_KEY, val);
    });

    scope.on(toggle, 'change', () => {
      const on = toggle.checked;
      if (
        on &&
        !window.confirm(
          'Ativar a cunhagem automática?\n\n' +
            'Ela vai cunhar o MÁXIMO de moedas disponíveis e RECARREGAR a página automaticamente no intervalo configurado. Confirma?',
        )
      ) {
        toggle.checked = false;
        return;
      }
      gm.set(ENABLED_KEY, on);
      if (on) {
        runCunhar();
      } else {
        setStatus('#5a3a16', 'Desativado.');
      }
    });

    function scheduleReload(): void {
      if (!toggle.checked) return;
      const secs = gm.get<number>(INTERVAL_KEY, 30);
      setStatus('#5a3a16', `Próxima cunhagem em ${secs} segundo${secs !== 1 ? 's' : ''}...`);
      scope.after(() => {
        if (isEnabled()) window.location.reload();
      }, secs * 1000);
    }

    function runCunhar(): void {
      if (!toggle.checked) return;

      const maxEl = document.getElementById('coin_mint_fill_max');
      const mintInput = document.getElementById('coin_mint_count');
      if (maxEl === null || !(mintInput instanceof HTMLInputElement)) {
        setStatus('#c04038', 'Elementos de cunhagem não encontrados.');
        scheduleReload(); // mantém a automação viva (o original sempre re-agendava)
        return;
      }

      // P1-2 (original 6092-6093): "(8.532)" → parsePtBrInt (tira parênteses E
      // ponto de milhar); o input recebe String do número parseado.
      const maxNum = parsePtBrInt((maxEl.textContent ?? '').replace(/[()]/g, ''));
      if (maxNum <= 0) {
        setStatus('#5a3a16', 'Nenhuma moeda disponível para cunhar.');
        scheduleReload();
        return;
      }

      // P2 (original 6084): botão escopado ao form; sem botão → erro claro, sem clique.
      const mintBtn = findMintButton(mintInput);
      if (mintBtn === null) {
        setStatus('#c04038', 'Botão de cunhagem não encontrado no formulário — nada foi clicado.');
        scheduleReload(); // mantém a automação viva (o original sempre re-agendava)
        return;
      }

      mintInput.value = String(maxNum);
      mintInput.dispatchEvent(new Event('change', { bubbles: true }));

      setStatus('#3f8f43', `Cunhando ${maxNum} moeda${maxNum !== 1 ? 's' : ''}...`);

      scope.after(() => {
        mintBtn.click();
        scheduleReload();
      }, 1000);
    }

    // Auto-executa no carregamento se ligado (como o original 6127-6130).
    if (savedEnabled) runCunhar();
  },
});
