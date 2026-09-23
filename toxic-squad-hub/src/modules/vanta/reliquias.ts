// Remover Relíquias — port do injectReliquiasUI do TW Vanta (linhas 3964-4094
// do original). Em screen=relic_system&mode=overview detecta as relíquias
// equipadas (slots `div.relic-slot.used`) e remove todas em lote via
// ajaxaction=remove_relic.
//
// Correções embutidas (linha do original entre parênteses):
// - P2 confirmação destrutiva: o lote de POSTs rodava sem confirmação →
//   window.confirm('Remover N relíquias equipadas?') antes de qualquer POST.
// - Rede: fetch cru (4059) → vantaPostJson (fila global ≥200ms com refresh de
//   csrf pela resposta, como o original fazia em 4072-4073). O delay manual de
//   200ms entre remoções (4080-4082) foi absorvido pela fila global — não
//   duplicado.
// - P2 interval/observer: o card é injetado com retry via scope.after
//   (50×100ms) caso o #page_relic_overview ainda não exista no mount.

import { registerVanta } from './vanta-registry';
import { ensureVantaStyles } from './vanta-styles';
import { currentCsrf, vantaPostJson } from './vanta-net';
import type { ModuleScope } from './vanta-lifecycle';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

interface EquippedRelic {
  villageId: string;
  name: string;
  villageName: string;
}

/** Slots usados do overview → relíquias equipadas. */
function parseEquippedRelics(pageDiv: HTMLElement): EquippedRelic[] {
  const relics: EquippedRelic[] = [];
  pageDiv.querySelectorAll('div.relic-slot.used').forEach((slot) => {
    const loc = slot.querySelector('div.location');
    if (loc === null) return;
    const anchor = loc.querySelector('span.village_anchor[data-id]');
    if (anchor === null) return;
    const villageId = anchor.getAttribute('data-id');
    if (villageId === null || villageId === '') return;
    const strong = slot.querySelector('div.description-container > strong');
    relics.push({
      villageId,
      name: strong?.textContent?.trim() || '(desconhecida)',
      villageName: anchor.textContent?.trim() || '',
    });
  });
  return relics;
}

function buildCard(relics: EquippedRelic[]): { card: HTMLElement; removeBtn: HTMLButtonElement; progress: HTMLElement } {
  const card = document.createElement('div');
  card.id = 'vanta-reliquias-ui';
  card.style.cssText =
    'background:#fffdf3;border:1px solid #e0cda0;border-radius:10px;margin:12px 0;font-family:"Segoe UI",sans-serif;color:#5a3a16;max-width:600px;';

  const header = document.createElement('div');
  header.style.cssText =
    'background:#efe2ba;padding:8px 14px;border-radius:10px 10px 0 0;font-weight:700;text-transform:uppercase;color:#6d3c14;font-size:13px;letter-spacing:.5px;';
  header.textContent = 'REMOVER RELÍQUIAS';
  card.appendChild(header);

  const body = document.createElement('div');
  body.style.cssText = 'padding:12px 14px;';
  card.appendChild(body);

  const info = document.createElement('div');
  info.style.cssText = 'margin-bottom:10px;font-size:13px;';
  info.textContent =
    relics.length > 0
      ? `${relics.length} relíquia${relics.length > 1 ? 's' : ''} equipada${relics.length > 1 ? 's' : ''}`
      : 'Nenhuma relíquia equipada';
  body.appendChild(info);

  if (relics.length > 0) {
    const list = document.createElement('div');
    list.style.cssText = 'margin-bottom:10px;font-size:12px;color:#6f5e40;';
    relics.forEach((r) => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:2px 0;';
      row.textContent = `${r.name} — ${r.villageName}`;
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.textContent = 'Remover Todas Relíquias';
  removeBtn.disabled = relics.length === 0;
  removeBtn.style.cssText =
    'background:#6d3c14;color:#fff;border:none;padding:6px 16px;border-radius:8px;font-weight:600;font-size:13px;cursor:pointer;';
  if (relics.length === 0) removeBtn.style.opacity = '0.5';
  body.appendChild(removeBtn);

  const progress = document.createElement('div');
  progress.style.cssText = 'margin-top:10px;font-size:13px;display:none;';
  body.appendChild(progress);

  return { card, removeBtn, progress };
}

registerVanta({
  id: 'vanta-reliquias',
  label: 'Remover Relíquias',
  desc: 'Remove em lote as relíquias equipadas',
  group: 'utilidades',
  match: () => params().get('screen') === 'relic_system' && params().get('mode') === 'overview',
  url: () => '/game.php?screen=relic_system&mode=overview',
  mount(scope) {
    ensureVantaStyles();

    let attempts = 0;
    const tryInject = (): void => {
      if (document.getElementById('vanta-reliquias-ui')) return;
      const pageDiv = document.getElementById('page_relic_overview');
      const h2 = pageDiv?.querySelector('h2') ?? null;
      if (pageDiv === null || h2 === null) {
        if (++attempts < 50) scope.after(tryInject, 100);
        return;
      }
      inject(scope, pageDiv);
    };
    tryInject();
  },
});

function inject(scope: ModuleScope, pageDiv: HTMLElement): void {
  const relics = parseEquippedRelics(pageDiv);
  const { card, removeBtn, progress } = buildCard(relics);
  const h2 = pageDiv.querySelector('h2');
  if (h2 === null) return;
  h2.after(scope.owns(card));

  removeBtn.addEventListener('click', () => {
    void handleRemove(relics, removeBtn, progress);
  });
}

async function handleRemove(
  relics: EquippedRelic[],
  removeBtn: HTMLButtonElement,
  progress: HTMLElement,
): Promise<void> {
  if (relics.length === 0) return;
  // Confirmação destrutiva: sem ela o lote não executa.
  if (!window.confirm(`Remover ${relics.length} relíquias equipadas?`)) return;

  removeBtn.disabled = true;
  removeBtn.style.opacity = '0.5';
  progress.style.display = 'block';

  // currentCsrf() lança quando indisponível (vanta-net) — captura aqui para
  // mensagem clara E reabilitação do botão (P2 consenso revisão Onda 2/3).
  let csrf: string;
  try {
    csrf = currentCsrf();
  } catch {
    progress.style.color = '#c04038';
    progress.textContent = 'Erro: não foi possível obter CSRF — recarregue a página';
    removeBtn.disabled = false;
    removeBtn.style.opacity = '';
    return;
  }

  let removed = 0;
  let errors = 0;

  for (let i = 0; i < relics.length; i++) {
    const r = relics[i]!;
    progress.style.color = '#5a3a16';
    progress.textContent = `Removendo ${i + 1}/${relics.length}... (${r.name})`;

    try {
      const path = `/game.php?village=${encodeURIComponent(r.villageId)}&screen=relic_system&ajaxaction=remove_relic`;
      // A fila global (≥200ms entre chamadas) já pacinga o lote — sem delay extra.
      const result = await vantaPostJson(path, { h: csrf });
      if (result.csrf !== '') csrf = result.csrf;
      removed++;
    } catch {
      errors++;
    }
  }

  if (errors === 0) {
    progress.style.color = '#3f8f43';
    progress.textContent = `${removed} relíquia${removed > 1 ? 's' : ''} removida${removed > 1 ? 's' : ''} com sucesso`;
  } else {
    progress.style.color = '#c04038';
    progress.textContent = `${removed} removida${removed > 1 ? 's' : ''}, ${errors} erro${errors > 1 ? 's' : ''}`;
  }
}
