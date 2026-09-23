// Visão Geral de Apoios (port do TW Vanta, linhas 4098-4382) —
// overview_villages&mode=units&type=away_detail: agrupamento por tribo/jogador
// dos apoios enviados e devolução por escopo. Correções da auditoria embutidas:
// - P1-2 (linha 4220): parseInt(uCells[u].textContent) truncava números pt-BR
//   ("8.532" → 8) → parsePtBrInt.
// - P1-1: nomes de tribo/jogador escapados (escapeHtml no texto, escAttr nos
//   atributos data-tribe/data-player).
// - P2 (linhas 4324-4345): marcação/desmarcação de checkboxes via .click()
//   quando o estado difere (o jogo pode ter handler); window.confirm com
//   resumo antes do submit_units_back.

import { registerVanta } from './vanta-registry';
import { ensureVantaStyles } from './vanta-styles';
import type { ModuleScope } from './vanta-lifecycle';
import { UNITS, UNIT_POP, escapeHtml, escAttr, parsePtBrInt } from './vanta-utils';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

const UNIT_SET = new Set<string>(UNITS);

interface ParsedRow {
  checkbox: HTMLInputElement | null;
  playerName: string;
  tribeName: string;
  units: number[];
  pop: number;
}

interface PlayerAgg {
  units: number[];
  pop: number;
}

interface TribeAgg {
  units: number[];
  pop: number;
  players: Record<string, PlayerAgg>;
}

interface DevolverScope {
  scope: string;
  tribe: string;
  player?: string;
}

registerVanta({
  id: 'vanta-apoiovisao',
  label: 'Visão Geral Apoios',
  desc: 'Resumo de apoios enviados por tribo',
  group: 'blindagem',
  match: () =>
    params().get('screen') === 'overview_villages' && params().get('mode') === 'units' && params().get('type') === 'away_detail',
  url: () => '/game.php?screen=overview_villages&mode=units&type=away_detail&group=0&page=-1&filter_villages=1',
  mount(scope: ModuleScope) {
    ensureVantaStyles();
    if (document.getElementById('vanta-apoio-overview') !== null) return;

    const unitsTableEl = document.getElementById('units_table');
    if (!(unitsTableEl instanceof HTMLTableElement)) return;
    // Aliases não-nulos: funções içadas (buildTable etc.) não herdam narrowing
    const unitsTable: HTMLTableElement = unitsTableEl;

    // Grupos da barra de grupos da página
    const currentGroup = params().get('group') ?? '0';
    const currentPage = params().get('page') ?? '0';
    const groups: Array<{ id: string; name: string; isCurrent: boolean }> = [];
    document.querySelectorAll('.group-menu-item').forEach((el) => {
      const gid = el.getAttribute('data-group-id');
      const name = (el.textContent ?? '').trim();
      if (gid !== null) groups.push({ id: gid, name, isCurrent: gid === currentGroup });
    });

    const groupOptions = groups
      .map((g) => `<option value="${escAttr(g.id)}"${g.isCurrent ? ' selected' : ''}>${escapeHtml(g.name)}</option>`)
      .join('');

    const card = document.createElement('div');
    card.id = 'vanta-apoio-overview';
    card.innerHTML = `
            <div id="vanta-ao-header"><span id="vanta-ao-header-title">Visão Geral de Apoios</span></div>
            <div id="vanta-ao-group-bar">
                <label for="vanta-ao-group-select">Grupo:</label>
                <select id="vanta-ao-group-select">${groupOptions}</select>
                <button id="vanta-ao-gerar-btn">Gerar Tabela</button>
            </div>
            <div id="vanta-ao-content"></div>`;

    // Insere na página (seletor de grupos visível de imediato)
    const visItem = document.querySelector('div.vis_item');
    if (visItem !== null && visItem.parentNode !== null) {
      visItem.parentNode.insertBefore(card, visItem);
    } else {
      const form = document.getElementById('overview_form');
      form?.parentNode?.insertBefore(card, form);
    }
    scope.owns(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Troca de grupo → navega (page=-1 para ver todas as aldeias)
    const groupSelect = card.querySelector<HTMLSelectElement>('#vanta-ao-group-select');
    if (groupSelect !== null) {
      scope.on(groupSelect, 'change', () => {
        const gid = groupSelect.value;
        if (gid === currentGroup) return;
        const u = new URL(window.location.href);
        u.searchParams.set('group', gid);
        u.searchParams.set('page', '-1');
        u.searchParams.set('filter_villages', '1');
        window.location.href = u.toString();
      });
    }

    const gerarBtnEl = card.querySelector<HTMLButtonElement>('#vanta-ao-gerar-btn');
    const contentEl = card.querySelector<HTMLElement>('#vanta-ao-content');
    if (gerarBtnEl === null || contentEl === null) return;
    const gerarBtn: HTMLButtonElement = gerarBtnEl;
    const content: HTMLElement = contentEl;

    scope.on(gerarBtn, 'click', () => {
      // Fora de page=-1 → redireciona primeiro
      if (currentPage !== '-1') {
        const u = new URL(window.location.href);
        u.searchParams.set('page', '-1');
        u.searchParams.set('filter_villages', '1');
        window.location.href = u.toString();
        return;
      }
      buildTable();
    });

    function buildTable(): void {
      gerarBtn.disabled = true;
      gerarBtn.textContent = 'Gerando...';
      content.innerHTML = '';
      // Adia o trabalho pesado para o próximo frame (UI atualiza primeiro)
      requestAnimationFrame(() => {
        const parsed = parseGameTable();
        content.innerHTML = renderTableHtml(parsed.tribeMap, parsed.grandTotal, parsed.grandPop, parsed.iconSrcs);
        wireTableEvents(content, parsed.parsedRows);
        gerarBtn.textContent = 'Gerar Tabela';
        gerarBtn.disabled = false;
      });
    }

    function parseGameTable(): {
      parsedRows: ParsedRow[];
      tribeMap: Record<string, TribeAgg>;
      grandTotal: number[];
      grandPop: number;
      iconSrcs: Record<string, string>;
    } {
      const iconSrcs: Record<string, string> = {};
      unitsTable.querySelectorAll<HTMLImageElement>('th img[src*="unit_"]').forEach((img) => {
        const m = /unit_(\w+)/.exec(img.src);
        if (m !== null && m[1] !== undefined && UNIT_SET.has(m[1])) iconSrcs[m[1]] = img.src;
      });

      const parsedRows: ParsedRow[] = [];
      const tribeMap: Record<string, TribeAgg> = {};
      const grandTotal = UNITS.map(() => 0);
      let grandPop = 0;

      const gameRows = unitsTable.querySelectorAll('tbody tr.row_a, tbody tr.row_b');
      gameRows.forEach((tr) => {
        if (tr.classList.contains('units_away')) return;

        const checkbox = tr.querySelector<HTMLInputElement>('input.village_checkbox');
        const playerLink = tr.querySelector('a[href*="info_player"]');
        const playerName = playerLink !== null ? (playerLink.textContent ?? '').trim() : 'Próprias';
        const tribeLink = tr.querySelector('a[href*="info_ally"]');
        const tribeName = tribeLink !== null ? (tribeLink.textContent ?? '').trim() : 'Próprias';

        const uCells = tr.querySelectorAll('td.unit-item');
        const units = UNITS.map(() => 0);
        let pop = 0;
        UNITS.forEach((u, i) => {
          const cell = uCells[i];
          // P1-2: números pt-BR ("8.532") via parsePtBrInt
          const c = cell !== undefined ? parsePtBrInt(cell.textContent) : 0;
          units[i] = c;
          pop += c * (UNIT_POP[u] ?? 0);
          grandTotal[i] = (grandTotal[i] ?? 0) + c;
        });
        grandPop += pop;

        parsedRows.push({ checkbox, playerName, tribeName, units, pop });

        const tribe: TribeAgg = tribeMap[tribeName] ?? { units: UNITS.map(() => 0), pop: 0, players: {} };
        tribeMap[tribeName] = tribe;
        UNITS.forEach((_, i) => {
          tribe.units[i] = (tribe.units[i] ?? 0) + (units[i] ?? 0);
        });
        tribe.pop += pop;

        const player: PlayerAgg = tribe.players[playerName] ?? { units: UNITS.map(() => 0), pop: 0 };
        tribe.players[playerName] = player;
        UNITS.forEach((_, i) => {
          player.units[i] = (player.units[i] ?? 0) + (units[i] ?? 0);
        });
        player.pop += pop;
      });

      return { parsedRows, tribeMap, grandTotal, grandPop, iconSrcs };
    }

    function renderTableHtml(
      tribeMap: Record<string, TribeAgg>,
      grandTotal: number[],
      grandPop: number,
      iconSrcs: Record<string, string>,
    ): string {
      const colgroup =
        '<colgroup><col class="vanta-ao-name-col">' +
        UNITS.map(() => '<col class="vanta-ao-unit">').join('') +
        '<col class="vanta-ao-pop"><col class="vanta-ao-acoes"></colgroup>';

      const iconHeaders = UNITS.map((u) => {
        const src = iconSrcs[u];
        return src !== undefined ? `<th><img src="${escAttr(src)}" style="width:18px;height:18px"></th>` : `<th>${u}</th>`;
      }).join('');

      const fmtCells = (unitArr: number[], pop: number): string => {
        const parts = UNITS.map((_, i) => {
          const v = unitArr[i] ?? 0;
          return v !== 0 ? `<td>${v.toLocaleString('pt-BR')}</td>` : '<td class="vanta-zero">–</td>';
        });
        parts.push(`<td>${pop.toLocaleString('pt-BR')}</td>`);
        return parts.join('');
      };

      const sortedTribes = Object.entries(tribeMap).sort((a, b) => b[1].pop - a[1].pop);
      const chunks: string[] = [];

      for (const [tribeName, tribeData] of sortedTribes) {
        const esc = escAttr(tribeName);
        const shown = escapeHtml(tribeName);
        chunks.push(
          `<tr class="vanta-ao-tribe-row" data-tribe="${esc}"><td class="vanta-ao-name"><span class="vanta-ao-toggle">▶</span>${shown}</td>${fmtCells(tribeData.units, tribeData.pop)}<td><button class="vanta-ao-devolver-btn" data-scope="tribe" data-tribe="${esc}">Devolver tudo</button></td></tr>`,
        );

        const sortedPlayers = Object.entries(tribeData.players).sort((a, b) => b[1].pop - a[1].pop);
        for (const [playerName, playerData] of sortedPlayers) {
          const escP = escAttr(playerName);
          const shownP = escapeHtml(playerName);
          chunks.push(
            `<tr class="vanta-ao-player-row vanta-ao-hidden" data-tribe="${esc}" data-player="${escP}"><td class="vanta-ao-name">${shownP}</td>${fmtCells(playerData.units, playerData.pop)}<td><button class="vanta-ao-devolver-btn" data-scope="player" data-tribe="${esc}" data-player="${escP}">Devolver tudo</button></td></tr>`,
          );
        }
      }

      // Linha de resumo
      const resumoCells = UNITS.map((u) => `<td id="vanta-ao-resumo-${u}" class="vanta-zero">–</td>`).join('');
      chunks.push(
        `<tr id="vanta-ao-resumo-row" style="display:none"><td class="vanta-ao-name" id="vanta-ao-resumo-label" style="font-weight:600;color:#7ddb82"></td>${resumoCells}<td id="vanta-ao-resumo-pop" style="font-weight:600;color:#7ddb82">–</td><td></td></tr>`,
      );

      // Total geral
      chunks.push(
        `<tr class="vanta-ao-total-row"><td class="vanta-ao-name" style="font-weight:bold">Total</td>${fmtCells(grandTotal, grandPop)}<td></td></tr>`,
      );

      return `<div id="vanta-ao-table-wrap"><table>${colgroup}<thead><tr><th class="vanta-ao-name">Destino</th>${iconHeaders}<th>Pop</th><th>Ações</th></tr></thead><tbody>${chunks.join('')}</tbody></table></div><div id="vanta-ao-actions"><button id="vanta-ao-enviar" disabled>Enviar de Volta</button></div>`;
    }

    function wireTableEvents(container: HTMLElement, parsedRows: ParsedRow[]): void {
      function getRowsForScope(sel: DevolverScope): ParsedRow[] {
        if (sel.scope === 'tribe') return parsedRows.filter((pr) => pr.tribeName === sel.tribe);
        return parsedRows.filter((pr) => pr.tribeName === sel.tribe && pr.playerName === sel.player);
      }

      function updateResumo(scopeRows: ParsedRow[]): void {
        const totals = UNITS.map(() => 0);
        let pop = 0;
        for (const pr of scopeRows) {
          UNITS.forEach((_, i) => {
            totals[i] = (totals[i] ?? 0) + (pr.units[i] ?? 0);
          });
          pop += pr.pop;
        }
        const resumoRow = document.getElementById('vanta-ao-resumo-row');
        if (resumoRow !== null) resumoRow.style.display = '';
        const label = document.getElementById('vanta-ao-resumo-label');
        if (label !== null) label.textContent = 'Devolver';
        UNITS.forEach((u, i) => {
          const cell = document.getElementById(`vanta-ao-resumo-${u}`);
          if (cell === null) return;
          const v = totals[i] ?? 0;
          cell.textContent = v > 0 ? v.toLocaleString('pt-BR') : '–';
          cell.className = v > 0 ? '' : 'vanta-zero';
        });
        const popCell = document.getElementById('vanta-ao-resumo-pop');
        if (popCell !== null) popCell.textContent = pop > 0 ? pop.toLocaleString('pt-BR') : '–';
      }

      function handleDevolver(sel: DevolverScope): void {
        // Desmarca tudo via .click() (o jogo pode ter handler no checkbox)
        unitsTable.querySelectorAll<HTMLInputElement>('input.village_checkbox:checked').forEach((cb) => cb.click());

        container.querySelectorAll<HTMLButtonElement>('.vanta-ao-devolver-btn').forEach((b) => {
          b.disabled = true;
        });
        const enviar = document.getElementById('vanta-ao-enviar') as HTMLButtonElement | null;
        if (enviar !== null) enviar.disabled = true;
        const resumoRow = document.getElementById('vanta-ao-resumo-row');
        if (resumoRow !== null) resumoRow.style.display = 'none';

        const targetRows = getRowsForScope(sel);
        if (targetRows.length === 0) return;

        // Marca os alvos via .click() quando o estado difere (P2)
        for (const pr of targetRows) {
          if (pr.checkbox !== null && !pr.checkbox.checked) pr.checkbox.click();
        }

        updateResumo(targetRows);
        if (enviar !== null) enviar.disabled = false;
      }

      // Delegação de eventos no tbody
      const tbody = container.querySelector('tbody');
      if (tbody !== null) {
        scope.on(tbody, 'click', (e) => {
          const target = e.target;
          if (!(target instanceof Element)) return;

          const devolverBtn = target.closest<HTMLButtonElement>('.vanta-ao-devolver-btn');
          if (devolverBtn !== null) {
            e.stopPropagation();
            const sel: DevolverScope = {
              scope: devolverBtn.dataset.scope ?? 'tribe',
              tribe: devolverBtn.dataset.tribe ?? '',
            };
            const playerAttr = devolverBtn.dataset.player;
            if (playerAttr !== undefined && playerAttr !== '') sel.player = playerAttr;
            handleDevolver(sel);
            return;
          }

          const tribeRow = target.closest('.vanta-ao-tribe-row');
          if (tribeRow === null) return;

          const toggle = tribeRow.querySelector('.vanta-ao-toggle');
          if (toggle === null) return;
          const isOpen = toggle.classList.toggle('open');
          const tribeName = tribeRow.getAttribute('data-tribe');

          const playerRows = tbody.querySelectorAll('.vanta-ao-player-row');
          playerRows.forEach((row) => {
            if (row.getAttribute('data-tribe') === tribeName) row.classList.toggle('vanta-ao-hidden', !isOpen);
          });
        });
      }

      // Enviar de Volta
      const enviar = container.querySelector<HTMLButtonElement>('#vanta-ao-enviar');
      if (enviar !== null) {
        scope.on(enviar, 'click', () => {
          // P2: resumo antes do submit destrutivo
          let villages = 0;
          let pop = 0;
          parsedRows.forEach((pr) => {
            if (pr.checkbox !== null && pr.checkbox.checked) {
              villages += 1;
              pop += pr.pop;
            }
          });
          if (villages === 0) return;
          if (!window.confirm(`Devolver tropas de ${villages} aldeia(s) — ${pop.toLocaleString('pt-BR')} pop?`)) return;
          const submitBtn = document.querySelector<HTMLInputElement>('input[name="submit_units_back"]');
          submitBtn?.click();
        });
      }
    }
  },
});
