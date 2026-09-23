// Renomeador da screen=overview — port do TW Vanta (linhas 5831-5905 do
// original). Injeta a linha de botões de tag em cada comando dos incomings
// da visão geral da aldeia (DOM via createElement — sem innerHTML, então não
// há escape a fazer; rótulos só passam por textContent). Timeout de erro via
// scope.after (P1-4); renomeação via renameCommand do contrato.

import { registerVanta } from './vanta-registry';
import type { ModuleScope } from './vanta-lifecycle';
import { ensureVantaStyles } from './vanta-styles';
import { renameCommand } from './vanta-net';
import { RENOMEADOR_TAGS, buildTaggedText } from './renomeador-tags';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/** setTimeout rastreado pelo escopo (dispose cancela; escopo morto resolve já). */
function waitTracked(scope: ModuleScope, ms: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      scope.after(resolve, ms);
    } catch {
      resolve();
    }
  });
}

function mountRenomeador(scope: ModuleScope): void {
  ensureVantaStyles();
  if (document.getElementById('vanta-renomeador-injected') !== null) return; // idempotente

  const incomingsTable = document.getElementById('commands_incomings');
  if (incomingsTable === null) return;

  const rows = incomingsTable.querySelectorAll('.command-row');
  if (rows.length === 0) return;

  // Marca como injetado
  const marker = document.createElement('span');
  marker.id = 'vanta-renomeador-injected';
  marker.style.display = 'none';
  incomingsTable.appendChild(marker);
  scope.owns(marker);

  // Lazy: csrf resolvido no 1º clique (renameCommand) — mount sem csrf não
  // pode derrubar o módulo (P3 consenso revisão Onda 2/3).
  let csrf: string | undefined;

  rows.forEach((row) => {
    // Pula comandos de apoio
    const firstImg = row.querySelector('span img');
    if (firstImg !== null && (firstImg.getAttribute('src') ?? '').includes('support')) return;

    const qeSpan = row.querySelector('span.quickedit[data-id]');
    if (qeSpan === null) return;
    const commandId = qeSpan.getAttribute('data-id');
    if (commandId === null || commandId === '') return;
    const labelSpan = qeSpan.querySelector('.quickedit-label');
    if (labelSpan === null) return;

    const qeContent = row.querySelector('.quickedit-content');
    if (qeContent === null) return;

    // Linha de botões de tag
    const tagRow = document.createElement('span');
    tagRow.className = 'vanta-tag-row';

    RENOMEADOR_TAGS.forEach((tag) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn vanta-tag-btn';
      btn.textContent = tag.abbrev;
      btn.title = tag.label;
      btn.style.cssText = `color: ${tag.textColor}; font-size: 8px !important; background: linear-gradient(to bottom, ${tag.topGrad} 30%, ${tag.botGrad} 10%);`;

      scope.on(btn, 'click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (btn.classList.contains('vanta-tag-pending')) return;

        void (async () => {
          const currentText = (labelSpan.textContent ?? '').trim();
          const newText = buildTaggedText(currentText, tag);

          btn.classList.add('vanta-tag-pending');
          try {
            const result = await renameCommand(commandId, newText, csrf);
            csrf = result.csrf;
            labelSpan.textContent = newText;
          } catch {
            btn.classList.add('vanta-tag-error');
            waitTracked(scope, 1500).then(() => {
              btn.classList.remove('vanta-tag-error');
            });
          } finally {
            btn.classList.remove('vanta-tag-pending');
          }
        })();
      });

      tagRow.appendChild(btn);
    });

    qeContent.appendChild(tagRow);
  });
}

registerVanta({
  id: 'vanta-renomeador',
  label: 'Renomeador (Overview)',
  icon: 'edit',
  desc: 'Botões de tag em cada comando de ataque da visão geral da aldeia',
  group: 'defesa',
  match: () => params().get('screen') === 'overview',
  url: () => '/game.php?screen=overview',
  mount: mountRenomeador,
});
