// Etiquetador (port do TW Vanta, linhas 5909-6019): na tela
// overview_villages > incomings > attacks, detecta comandos ainda sem etiqueta
// (quickedit-label começando com "Ataque"/"Apoio") e dispara o select_all +
// "Etiqueta" nativo do jogo, recarregando a página no intervalo configurado.
// Correções embutidas:
// - P2: o ramo hasNew (original 5986-5994) clicava Etiqueta mas NÃO agendava
//   reload — se o jogo não recarregasse sozinho, o loop morria. Agora TODOS os
//   ramos agendam o reload via scope.after (60s após o clique, pois a página
//   pode recarregar antes e o timer morre com o dispose — aceitável).
// - Confirmação ao LIGAR o automático (automação assumida pelo dono; sem
//   confirmação por ciclo).
// - P1-4: listeners/timers/node via ModuleScope (nada solto acumulando).

import { gm } from '../../core/storage';
import type { ModuleScope } from './vanta-lifecycle';
import { registerVanta } from './vanta-registry';
import { ensureVantaStyles } from './vanta-styles';
import { parsePtBrInt } from './vanta-utils';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

const INTERVAL_KEY = 'tsh-vanta:etiquetador:interval';
const ENABLED_KEY = 'tsh-vanta:etiquetador:enabled';

function isEnabled(): boolean {
  return gm.get<boolean>(ENABLED_KEY, false);
}

registerVanta({
  id: 'vanta-etiquetador',
  label: 'Etiquetador',
  desc: 'Etiqueta ataques novos automaticamente',
  group: 'utilidades',
  match: () =>
    params().get('screen') === 'overview_villages' &&
    params().get('mode') === 'incomings' &&
    params().get('subtype') === 'attacks',
  url: () => '/game.php?screen=overview_villages&mode=incomings&type=unignored&subtype=attacks&page=-1',
  mount(scope: ModuleScope): void {
    ensureVantaStyles();
    if (document.getElementById('vanta-etiquetador-ui') !== null) return;

    const contentEl =
      document.getElementById('paged_view_content') ??
      document.querySelector('#incomings_table')?.parentElement ??
      document.getElementById('contentContainer');
    if (contentEl === null) return;

    const savedInterval = gm.get<number>(INTERVAL_KEY, 10);
    const savedEnabled = gm.get<boolean>(ENABLED_KEY, false);

    const container = document.createElement('div');
    container.id = 'vanta-etiquetador-ui';
    container.innerHTML = `
            <div id="vanta-etiquetador-header">
                <span id="vanta-etiquetador-header-title">Etiquetador</span>
            </div>
            <div id="vanta-etiquetador-body">
                <label>
                    Intervalo (minutos):
                    <input type="number" id="vanta-etiquetador-interval" min="1" max="60" value="${savedInterval}">
                </label>
                <label>
                    Ativar etiquetador automático:
                    <input type="checkbox" id="vanta-etiquetador-toggle" ${savedEnabled ? 'checked' : ''}>
                </label>
                <div id="vanta-etiquetador-status"></div>
            </div>
        `;
    contentEl.insertBefore(container, contentEl.firstChild);
    scope.owns(container);

    const intervalInputEl = document.getElementById('vanta-etiquetador-interval');
    const toggleEl = document.getElementById('vanta-etiquetador-toggle');
    const statusEl = document.getElementById('vanta-etiquetador-status');
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
      const val = Math.max(1, Math.min(60, parsePtBrInt(intervalInput.value) || 10));
      intervalInput.value = String(val);
      gm.set(INTERVAL_KEY, val);
    });

    scope.on(toggle, 'change', () => {
      const on = toggle.checked;
      if (
        on &&
        !window.confirm(
          'Ativar o etiquetador automático?\n\n' +
            'Ele vai etiquetar ataques novos e RECARREGAR a página automaticamente no intervalo configurado. Confirma?',
        )
      ) {
        toggle.checked = false;
        return;
      }
      gm.set(ENABLED_KEY, on);
      if (on) {
        runEtiquetador();
      } else {
        setStatus('#5a3a16', 'Desativado.');
      }
    });

    function scheduleReload(ms: number, label: string): void {
      if (!toggle.checked) return;
      setStatus('#5a3a16', label);
      scope.after(() => {
        if (isEnabled()) window.location.reload();
      }, ms);
    }

    function scheduleIntervalReload(): void {
      const mins = gm.get<number>(INTERVAL_KEY, 10);
      scheduleReload(mins * 60_000, `Próxima verificação em ${mins} minuto${mins !== 1 ? 's' : ''}...`);
    }

    function runEtiquetador(): void {
      if (!toggle.checked) return;

      const table = document.getElementById('incomings_table');
      if (table === null) {
        setStatus('#c04038', 'Tabela de entradas não encontrada.');
        return;
      }

      let hasNew = false;
      table.querySelectorAll('tbody .quickedit-label').forEach((label) => {
        const text = label.textContent ?? '';
        if (text.includes('Ataque') || text.includes('Apoio')) hasNew = true;
      });

      if (hasNew) {
        setStatus('#3f8f43', 'Ataques não etiquetados encontrados! Etiquetando...');
        scope.after(() => {
          const selectAll = table.querySelector<HTMLInputElement>('tbody tr input#select_all');
          if (selectAll !== null) selectAll.click();
          const etiquetaBtn = table.querySelector<HTMLInputElement>('tbody input[value="Etiqueta"]');
          if (etiquetaBtn !== null) etiquetaBtn.click();
          // P2 (original 5986-5994): agendar o reload TAMBÉM neste ramo — sem
          // isso o loop morria se o jogo não recarregasse sozinho. Delay maior
          // (60s): o clique pode recarregar a página antes (o timer morre com
          // o dispose do escopo — comportamento aceitável).
          scheduleReload(60_000, 'Etiquetado. Próxima verificação em 60 segundos...');
        }, 2000);
      } else {
        setStatus('#5a3a16', 'Nenhum ataque novo para etiquetar.');
        scheduleIntervalReload();
      }
    }

    // Auto-executa no carregamento se ligado (como o original 6016-6018).
    if (savedEnabled) runEtiquetador();
  },
});
