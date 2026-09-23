// Gerenciar Blindagem (port do TW Vanta, linhas 3178-3960 + resetDevolverState
// linhas 199-217) — info_village "Defesas": tabela por jogador, devolver
// tudo/parcial e análise por grupo. Correções da auditoria embutidas:
// - P1-1 (linhas 3334/3338): nomes de jogadores interpolados em innerHTML com
//   escape só de aspas → escapeHtml no texto e escAttr nos atributos
//   (inclui nome de grupo da análise).
// - P2: window.confirm com resumo (pop/aldeias) antes do submit "Enviar de
//   Volta" (submit_units_back do form).
// - Rede: grupos via pacedGet/vantaPostJson (fila global, sem fetch cru).
// - P1-2: leituras numéricas do DOM via parsePtBrInt.

import { registerVanta } from './vanta-registry';
import { ensureVantaStyles } from './vanta-styles';
import type { ModuleScope } from './vanta-lifecycle';
import { UNITS, UNIT_POP, escapeHtml, escAttr, parsePtBrInt } from './vanta-utils';
import { waterFill, fillRowMax, fillRowAllocated, staggerFill, populateResumo } from './vanta-forms';
import { pacedGet, vantaPostJson, currentVillageId, currentCsrf } from './vanta-net';
import { gm } from '../../core/storage';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

const UNIT_SET = new Set<string>(UNITS);

/** Toast de erro ancorado num elemento (port local, linhas 3178-3200). */
export function showModuleError(scope: ModuleScope, anchorEl: HTMLElement, msg: string): void {
  byId('vanta-module-error')?.remove();

  const el = document.createElement('div');
  el.id = 'vanta-module-error';
  el.textContent = msg;
  el.style.cssText = `
            position: fixed; z-index: 100001;
            background: #fceaea; border: 1px solid #c04038; border-radius: 8px;
            color: #c04038; font-size: 11px; font-family: 'Segoe UI', Arial, sans-serif;
            padding: 7px 12px; pointer-events: none;
            box-shadow: 0 4px 16px rgba(60,37,10,0.25);
        `;

  document.body.appendChild(el);

  const rect = anchorEl.getBoundingClientRect();
  el.style.top = `${rect.bottom + 6}px`;
  el.style.left = `${Math.max(8, rect.left - el.offsetWidth + rect.width)}px`;

  scope.owns(el);
  scope.after(() => {
    el.remove();
  }, 3000);
}

/** Zera o estado de devolução (port local, linhas 199-217). */
function resetDevolverState(form: HTMLFormElement, ui: HTMLElement, opts?: { ag?: boolean }): void {
  form.querySelectorAll<HTMLInputElement>('input.troop-request-selector:checked').forEach((cb) => cb.click());
  const enviar = byId<HTMLButtonElement>('vanta-enviar-de-volta');
  if (enviar !== null) enviar.disabled = true;
  const parcial = byId('vanta-parcial-tr');
  if (parcial !== null) parcial.style.display = 'none';
  const mainResumo = byId('vanta-blindagem-resumo-row');
  if (mainResumo !== null) mainResumo.style.display = 'none';
  ui.querySelectorAll<HTMLButtonElement>('.vanta-b-acoes-trigger').forEach((b) => {
    b.disabled = true;
  });
  ui.querySelectorAll<HTMLElement>('.vanta-b-dropdown-menu').forEach((m) => {
    m.hidden = true;
  });
  if (opts?.ag === true) {
    const agParcial = byId('vanta-ag-parcial-tr');
    if (agParcial !== null) agParcial.style.display = 'none';
    const agResumo = byId('vanta-ag-resumo-row');
    if (agResumo !== null) agResumo.style.display = 'none';
    const results = byId('vanta-ag-results');
    if (results !== null) {
      results.querySelectorAll<HTMLButtonElement>('.vanta-ag-trigger').forEach((b) => {
        b.disabled = true;
      });
      results.querySelectorAll<HTMLElement>('.vanta-b-dropdown-menu').forEach((m) => {
        m.hidden = true;
      });
    }
  }
}

/** Extrai o campo html de uma resposta ajax do jogo. */
function extractAjaxHtml(json: Record<string, unknown>): string {
  const resp = json.response;
  if (resp !== null && typeof resp === 'object') {
    const h = (resp as { html?: unknown }).html;
    if (typeof h === 'string') return h;
  }
  const h = json.html;
  return typeof h === 'string' ? h : '';
}

registerVanta({
  id: 'vanta-blindagem',
  label: 'Gerenciar Blindagem',
  desc: 'Visualize blindagem de aldeias',
  group: 'blindagem',
  match: () => params().get('screen') === 'info_village',
  url: () => {
    const vid = currentVillageId();
    return `/game.php?village=${vid}&screen=info_village&id=${vid}`;
  },
  mount(scope: ModuleScope) {
    ensureVantaStyles();
    if (document.getElementById('vanta-blindagem-ui') !== null) return;

    const h3 = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent?.trim() === 'Defesas');
    if (h3 === undefined) return;
    const form = document.getElementById('withdraw_selected_units_village_info');
    if (!(form instanceof HTMLFormElement)) return;
    const table = form.querySelector('table.vis');
    if (!(table instanceof HTMLTableElement)) return;

    interface PlayerAgg {
      units: Record<string, number>;
      pop: number;
    }
    interface VillageInfo {
      tr: HTMLTableRowElement;
      playerName: string;
      units: Record<string, number>;
      villageId: string | null;
    }
    type PropRow = VillageInfo & { villageId: string };

    // Estado compartilhado da distribuição por pop (parcial principal e AG)
    let _distributingPop = false;
    function distributePop(targetPop: number, inputPrefix: string, popCalcId: string): void {
      const maxes: Record<string, number> = {};
      UNITS.forEach((u) => {
        const inp = byId<HTMLInputElement>(`${inputPrefix}${u}`);
        maxes[u] = inp !== null ? parsePtBrInt(inp.max) : 0;
      });
      const eligible = UNITS.filter((u) => (UNIT_POP[u] ?? 0) > 0 && (maxes[u] ?? 0) > 0);
      const totalAvailPop = eligible.reduce((s, u) => s + (maxes[u] ?? 0) * (UNIT_POP[u] ?? 0), 0);
      const result: Record<string, number> = Object.fromEntries(UNITS.map((u) => [u, 0]));

      if (totalAvailPop > 0 && targetPop >= totalAvailPop) {
        eligible.forEach((u) => {
          result[u] = maxes[u] ?? 0;
        });
      } else if (totalAvailPop > 0) {
        // Distribuição proporcional + sobra gulosa (maior pop primeiro)
        eligible.forEach((u) => {
          result[u] = Math.floor((targetPop * ((maxes[u] ?? 0) * (UNIT_POP[u] ?? 0))) / totalAvailPop / (UNIT_POP[u] ?? 1));
        });
        let usedPop = eligible.reduce((s, u) => s + (result[u] ?? 0) * (UNIT_POP[u] ?? 0), 0);
        const sorted = eligible.slice().sort((a, b) => (UNIT_POP[b] ?? 0) - (UNIT_POP[a] ?? 0));
        for (const u of sorted) {
          while (usedPop + (UNIT_POP[u] ?? 0) <= targetPop && (result[u] ?? 0) < (maxes[u] ?? 0)) {
            result[u] = (result[u] ?? 0) + 1;
            usedPop += UNIT_POP[u] ?? 0;
          }
        }
      }

      _distributingPop = true;
      let actualPop = 0;
      UNITS.forEach((u) => {
        const inp = byId<HTMLInputElement>(`${inputPrefix}${u}`);
        if (inp === null) return;
        inp.value = String(result[u] ?? 0);
        const max = parsePtBrInt(inp.max);
        inp.classList.toggle('vanta-parcial-over', max > 0 && (result[u] ?? 0) > max);
        actualPop += (result[u] ?? 0) * (UNIT_POP[u] ?? 0);
      });
      _distributingPop = false;
      const popCalc = byId(popCalcId);
      if (popCalc !== null) popCalc.textContent = actualPop > 0 ? String(actualPop) : '–';
    }

    // ── Sub-funções ─────────────────────────────────────────────────────

    function parseDefenseTable(tbl: HTMLTableElement): {
      playerMap: Record<string, PlayerAgg>;
      villageRows: VillageInfo[];
      iconSrcs: Record<string, string>;
    } {
      // Reusa as URLs de ícone do cabeçalho do próprio jogo
      const iconSrcs: Record<string, string> = {};
      tbl.querySelectorAll<HTMLAnchorElement>('th a.unit_link').forEach((a) => {
        const unit = a.dataset.unit;
        const img = a.querySelector('img');
        if (unit !== undefined && img !== null && UNIT_SET.has(unit)) iconSrcs[unit] = img.src;
      });

      // Linhas de aldeias apoiadoras; ignora "Desta aldeia" (sem village_row)
      const playerMap: Record<string, PlayerAgg> = {};
      const villageRows: VillageInfo[] = [];
      tbl.querySelectorAll<HTMLTableRowElement>('tr[class*="village_row_"]').forEach((tr) => {
        const anchor = tr.querySelector('td.village-anchor');
        if (anchor === null) return;

        const playerLink = anchor.querySelector('a[href*="screen=info_player"]');
        const playerName = playerLink !== null ? (playerLink.textContent ?? '').trim() : 'Próprias';

        const agg: PlayerAgg = playerMap[playerName] ?? { units: Object.fromEntries(UNITS.map((u) => [u, 0])), pop: 0 };
        playerMap[playerName] = agg;

        const rowUnits: Record<string, number> = {};
        UNITS.forEach((unit) => {
          const cell = tr.querySelector(`td.unit-item-${unit}`);
          const count = cell !== null ? parsePtBrInt(cell.getAttribute('data-unit-count')) : 0;
          rowUnits[unit] = count;
          agg.units[unit] = (agg.units[unit] ?? 0) + count;
          agg.pop += count * (UNIT_POP[unit] ?? 0);
        });
        const vidMatch = /village_row_(\d+)/.exec(tr.className);
        const villageId = vidMatch !== null && vidMatch[1] !== undefined ? vidMatch[1] : null;
        villageRows.push({ tr, playerName, units: rowUnits, villageId });
      });

      return { playerMap, villageRows, iconSrcs };
    }

    function buildBlindagemTable(playerMap: Record<string, PlayerAgg>, iconSrcs: Record<string, string>): HTMLElement {
      const sortedRows = Object.entries(playerMap).sort(([, a], [, b]) => b.pop - a.pop);

      const totals: PlayerAgg = { units: Object.fromEntries(UNITS.map((u) => [u, 0])), pop: 0 };
      sortedRows.forEach(([, d]) => {
        UNITS.forEach((u) => {
          totals.units[u] = (totals.units[u] ?? 0) + (d.units[u] ?? 0);
        });
        totals.pop += d.pop;
      });

      const headerCells = UNITS.map((u) => {
        const src = iconSrcs[u];
        return src !== undefined
          ? `<th><img src="${escAttr(src)}" style="width:20px;height:20px;display:block;margin:0 auto" title="${escAttr(u)}"></th>`
          : `<th>${u}</th>`;
      }).join('');

      // P1-1: nome escapado no texto E no atributo data-player
      const playerRows = sortedRows
        .map(([name, d]) => {
          const cells = UNITS.map((u) => {
            const v = d.units[u] ?? 0;
            return v === 0 ? '<td class="vanta-zero">–</td>' : `<td>${v}</td>`;
          }).join('');
          const escapedName = escAttr(name);
          const shownName = escapeHtml(name);
          const actionCell =
            name === 'Próprias'
              ? `<td class="vanta-b-acoes"><div class="vanta-b-dropdown"><button type="button" class="vanta-b-acoes-trigger">Ações ▾</button><div class="vanta-b-dropdown-menu" hidden><button type="button" class="vanta-b-devolver-btn" data-player="${escapedName}">↩ Devolver tudo</button><button type="button" class="vanta-b-devolver-parcial-btn">✂ Devolver parcial</button><button type="button" class="vanta-b-analise-grupo-btn">📊 Análise por Grupo</button></div></div></td>`
              : `<td class="vanta-b-acoes"><div class="vanta-b-dropdown"><button type="button" class="vanta-b-acoes-trigger">Ações ▾</button><div class="vanta-b-dropdown-menu" hidden><button type="button" class="vanta-b-devolver-btn" data-player="${escapedName}">↩ Devolver tudo</button></div></div></td>`;
          return `<tr${name === 'Próprias' ? ' class="vanta-proprias-row"' : ''}><td class="vanta-b-player">${shownName}</td>${cells}<td>${d.pop}</td>${actionCell}</tr>`;
        })
        .join('');

      const totalCells = UNITS.map((u) => {
        const v = totals.units[u] ?? 0;
        return v === 0 ? '<td class="vanta-zero">–</td>' : `<td>${v}</td>`;
      }).join('');

      const unitCols = UNITS.map(() => '<col class="vanta-b-unit">').join('');

      const ui = document.createElement('div');
      ui.id = 'vanta-blindagem-ui';
      ui.innerHTML = `
            <div id="vanta-blindagem-header">
                <span id="vanta-blindagem-header-title">Blindagem</span>
            </div>
            <div id="vanta-blindagem-table-wrap">
                <table>
                    <colgroup>
                        <col>
                        ${unitCols}
                        <col class="vanta-b-pop">
                        <col class="vanta-b-acoes">
                    </colgroup>
                    <thead>
                        <tr>
                            <th class="vanta-b-player">Jogador</th>
                            ${headerCells}
                            <th>Pop</th>
                            <th class="vanta-b-acoes">Ações</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${playerRows}
                        <tr class="vanta-blindagem-total">
                            <td class="vanta-b-player">Total</td>
                            ${totalCells}
                            <td>${totals.pop}</td>
                            <td></td>
                        </tr>
                        <tr id="vanta-parcial-tr" style="display:none">
                            <td class="vanta-b-player" style="color:#888;font-size:10px;white-space:normal;line-height:1.3">Tropas a serem devolvidas</td>
                            ${UNITS.map((u) => `<td class="vanta-parcial-cell"><input id="vanta-parcial-input-${u}" type="number" min="0" value="0"><span class="vanta-parcial-max" id="vanta-parcial-max-${u}">–</span></td>`).join('')}
                            <td id="vanta-parcial-pop" class="vanta-parcial-pop-cell"><input id="vanta-parcial-pop-input" type="number" min="0" value="" placeholder="Pop"><span id="vanta-parcial-pop-calc">–</span></td>
                            <td class="vanta-b-acoes" id="vanta-parcial-btns">
                                <button type="button" id="vanta-preencher-parcial">Preencher</button>
                                <button type="button" id="vanta-parcial-cancel">✕</button>
                            </td>
                        </tr>
                        <tr id="vanta-blindagem-resumo-row" style="display:none">
                            <td class="vanta-b-player" id="vanta-resumo-label"></td>
                            ${UNITS.map((u) => `<td id="vanta-resumo-${u}">–</td>`).join('')}
                            <td id="vanta-resumo-pop"></td>
                            <td></td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div id="vanta-analise-section" style="display:none">
                <div id="vanta-analise-header">Análise por Grupo</div>
                <div id="vanta-ag-summary"></div>
                <div id="vanta-ag-picker" style="display:none"></div>
                <div id="vanta-ag-status"></div>
                <div id="vanta-ag-actions"><button type="button" id="vanta-ag-analisar" disabled>Analisar</button></div>
                <div id="vanta-ag-results"></div>
            </div>
            <div id="vanta-blindagem-actions">
                <button type="button" id="vanta-enviar-de-volta" disabled>Enviar de Volta</button>
            </div>
        `;

      return ui;
    }

    function setupDropdownMenus(sc: ModuleScope, ui: HTMLElement): void {
      ui.querySelectorAll<HTMLButtonElement>('.vanta-b-acoes-trigger').forEach((trigger) => {
        sc.on(trigger, 'click', (e) => {
          e.stopPropagation();
          const menu = trigger.nextElementSibling;
          if (!(menu instanceof HTMLElement)) return;
          const isOpen = !menu.hidden;
          ui.querySelectorAll<HTMLElement>('.vanta-b-dropdown-menu').forEach((m) => {
            m.hidden = true;
          });
          if (!isOpen) {
            menu.hidden = false;
            const rect = trigger.getBoundingClientRect();
            menu.style.top = `${rect.bottom}px`;
            menu.style.left = `${rect.right - menu.offsetWidth}px`;
          }
        });
      });
      sc.on(
        document,
        'mousedown',
        (e) => {
          const target = e.target;
          if (target instanceof Element && target.closest('.vanta-b-dropdown') === null) {
            ui.querySelectorAll<HTMLElement>('.vanta-b-dropdown-menu').forEach((m) => {
              m.hidden = true;
            });
          }
        },
        { capture: true },
      );
    }

    function setupDevolverTudo(sc: ModuleScope, form: HTMLFormElement, ui: HTMLElement, playerMap: Record<string, PlayerAgg>): void {
      function handleDevolverTudo(playerName: string): void {
        resetDevolverState(form, ui);

        const isProprias = playerName === 'Próprias';
        const rows = Array.from(form.querySelectorAll<HTMLTableRowElement>('tr[class*="village_row_"]')).filter((tr) => {
          const link = tr.querySelector('a[href*="screen=info_player"]');
          if (isProprias) return link === null;
          return link !== null && (link.textContent ?? '').trim() === playerName;
        });

        if (rows.length === 0) return;

        staggerFill(rows, {
          getCheckbox: (tr) => tr.querySelector<HTMLInputElement>('input.troop-request-selector'),
          fillFn: isProprias ? (_tr, cb) => fillRowMax(cb.dataset.awayId ?? '', UNITS) : null,
          onAllDone: () => {
            const enviar = byId<HTMLButtonElement>('vanta-enviar-de-volta');
            if (enviar !== null) enviar.disabled = false;
            const pData = playerMap[playerName];
            if (pData !== undefined) {
              populateResumo('vanta-blindagem-resumo-row', 'vanta-resumo-', playerName, pData.units, pData.pop);
            }
          },
        });
      }

      ui.querySelectorAll<HTMLButtonElement>('.vanta-b-devolver-btn').forEach((btn) => {
        sc.on(btn, 'click', () => {
          handleDevolverTudo(btn.dataset.player ?? '');
        });
      });
    }

    function setupDevolverParcial(
      sc: ModuleScope,
      form: HTMLFormElement,
      ui: HTMLElement,
      playerMap: Record<string, PlayerAgg>,
      villageRows: VillageInfo[],
    ): void {
      const parcialBtn = ui.querySelector<HTMLButtonElement>('.vanta-b-devolver-parcial-btn');
      if (parcialBtn !== null) {
        sc.on(parcialBtn, 'click', () => {
          resetDevolverState(form, ui);

          const pData = playerMap['Próprias'];
          UNITS.forEach((u) => {
            const inp = byId<HTMLInputElement>(`vanta-parcial-input-${u}`);
            const maxVal = pData !== undefined ? (pData.units[u] ?? 0) : 0;
            if (inp !== null) {
              inp.max = String(maxVal);
              inp.value = '0';
              inp.classList.remove('vanta-parcial-over');
            }
            const maxSpan = byId(`vanta-parcial-max-${u}`);
            if (maxSpan !== null) maxSpan.textContent = maxVal > 0 ? String(maxVal) : '–';
          });
          const popCalc = byId('vanta-parcial-pop-calc');
          if (popCalc !== null) popCalc.textContent = '–';
          const popInput = byId<HTMLInputElement>('vanta-parcial-pop-input');
          if (popInput !== null) popInput.value = '';
          const tr = byId('vanta-parcial-tr');
          if (tr !== null) tr.style.display = '';
        });
      }

      const cancelBtn = byId<HTMLButtonElement>('vanta-parcial-cancel');
      if (cancelBtn !== null) {
        sc.on(cancelBtn, 'click', () => {
          const tr = byId('vanta-parcial-tr');
          if (tr !== null) tr.style.display = 'none';
          ui.querySelectorAll<HTMLButtonElement>('.vanta-b-acoes-trigger').forEach((b) => {
            b.disabled = false;
          });
        });
      }

      UNITS.forEach((u) => {
        const inp = byId<HTMLInputElement>(`vanta-parcial-input-${u}`);
        if (inp === null) return;
        sc.on(inp, 'input', () => {
          const val = parsePtBrInt(inp.value);
          const max = parsePtBrInt(inp.max);
          inp.classList.toggle('vanta-parcial-over', max > 0 && val > max);
          let pop = 0;
          UNITS.forEach((uu) => {
            pop += parsePtBrInt(byId<HTMLInputElement>(`vanta-parcial-input-${uu}`)?.value) * (UNIT_POP[uu] ?? 0);
          });
          const popCalc = byId('vanta-parcial-pop-calc');
          if (popCalc !== null) popCalc.textContent = pop > 0 ? String(pop) : '–';
          // Limpa o input de pop quando o usuário edita uma unidade manualmente
          const popInp = byId<HTMLInputElement>('vanta-parcial-pop-input');
          if (popInp !== null && !_distributingPop) popInp.value = '';
        });
      });

      // Distribuição por pop do parcial principal
      const popIn = byId<HTMLInputElement>('vanta-parcial-pop-input');
      if (popIn !== null) {
        sc.on(popIn, 'input', () => {
          const targetPop = Math.max(0, parsePtBrInt(popIn.value));
          if (targetPop === 0) return;
          distributePop(targetPop, 'vanta-parcial-input-', 'vanta-parcial-pop-calc');
        });
      }

      const preencher = byId<HTMLButtonElement>('vanta-preencher-parcial');
      if (preencher !== null) {
        sc.on(preencher, 'click', () => {
          const requested: Record<string, number> = Object.fromEntries(
            UNITS.map((u) => {
              const inp = byId<HTMLInputElement>(`vanta-parcial-input-${u}`);
              return [u, inp !== null ? Math.max(0, parsePtBrInt(inp.value)) : 0];
            }),
          );

          const propRows = villageRows.filter((r): r is PropRow => r.playerName === 'Próprias' && r.villageId !== null);
          if (propRows.length === 0) return;

          const allocation = waterFill(UNITS, requested, propRows);

          const tr = byId('vanta-parcial-tr');
          if (tr !== null) tr.style.display = 'none';

          const rowEls: HTMLElement[] = propRows.map((r) => r.tr);
          staggerFill(rowEls, {
            getCheckbox: (row) => row.querySelector<HTMLInputElement>('input.troop-request-selector'),
            fillFn: (row, cb) => {
              const alloc = allocation[rowEls.indexOf(row)];
              if (alloc !== undefined) fillRowAllocated(cb.dataset.awayId ?? '', UNITS, alloc);
            },
            onAllDone: () => {
              const enviar = byId<HTMLButtonElement>('vanta-enviar-de-volta');
              if (enviar !== null) enviar.disabled = false;
              const allocTotals: Record<string, number> = Object.fromEntries(
                UNITS.map((u) => [u, allocation.reduce((s, a) => s + (a[u] ?? 0), 0)]),
              );
              const allocPop = UNITS.reduce((s, u) => s + (allocTotals[u] ?? 0) * (UNIT_POP[u] ?? 0), 0);
              populateResumo('vanta-blindagem-resumo-row', 'vanta-resumo-', 'Alocado', allocTotals, allocPop, {
                alocado: true,
                requested,
              });
            },
          });
        });
      }
    }

    function setupAnaliseGrupo(
      sc: ModuleScope,
      form: HTMLFormElement,
      ui: HTMLElement,
      playerMap: Record<string, PlayerAgg>,
      villageRows: VillageInfo[],
      iconSrcs: Record<string, string>,
    ): void {
      interface GroupEntry {
        groupId: string;
        groupName: string;
        villageIds: Set<string>;
      }
      interface AggData {
        units: Record<string, number>;
        pop: number;
        count: number;
      }
      interface AnaliseData {
        groupEntries: GroupEntry[];
        groupAgg: AggData[];
        propRows: PropRow[];
        outrasVillageIds: Set<string>;
      }

      let lastAnaliseData: AnaliseData | null = null;
      let agParcialTargetIdx: string | null = null;

      function getAgVillageIdsForIdx(idx: string): Set<string> {
        if (lastAnaliseData === null) return new Set<string>();
        if (idx === 'outras') return lastAnaliseData.outrasVillageIds;
        const entry = lastAnaliseData.groupEntries[parseInt(idx, 10)];
        return entry?.villageIds ?? new Set<string>();
      }

      function getAgAggForIdx(idx: string): AggData | null {
        if (lastAnaliseData === null) return null;
        if (idx === 'outras') {
          // Agg de "Outras" calculado na hora
          const agg: AggData = { units: Object.fromEntries(UNITS.map((u) => [u, 0])), pop: 0, count: 0 };
          const data = lastAnaliseData;
          data.propRows.forEach((r) => {
            if (data.outrasVillageIds.has(r.villageId)) {
              UNITS.forEach((u) => {
                agg.units[u] = (agg.units[u] ?? 0) + (r.units[u] ?? 0);
              });
              agg.pop += UNITS.reduce((s, u) => s + (r.units[u] ?? 0) * (UNIT_POP[u] ?? 0), 0);
            }
          });
          return agg;
        }
        const found = lastAnaliseData.groupAgg[parseInt(idx, 10)];
        return found ?? null;
      }

      function handleAgDevolverTudo(idx: string): void {
        const targetIds = getAgVillageIdsForIdx(idx);
        if (targetIds.size === 0) return;

        resetDevolverState(form, ui, { ag: true });

        if (lastAnaliseData === null) return;
        const rows = lastAnaliseData.propRows.filter((r) => targetIds.has(r.villageId)).map((r) => r.tr);
        if (rows.length === 0) return;

        const aggData = getAgAggForIdx(idx);

        staggerFill(rows, {
          getCheckbox: (tr) => tr.querySelector<HTMLInputElement>('input.troop-request-selector'),
          fillFn: (_tr, cb) => fillRowMax(cb.dataset.awayId ?? '', UNITS),
          onAllDone: () => {
            const enviar = byId<HTMLButtonElement>('vanta-enviar-de-volta');
            if (enviar !== null) enviar.disabled = false;
            if (aggData !== null) {
              const entry = lastAnaliseData?.groupEntries[parseInt(idx, 10)];
              const label = idx === 'outras' ? 'Outras' : (entry?.groupName ?? '');
              populateResumo('vanta-ag-resumo-row', 'vanta-ag-resumo-', label, aggData.units, aggData.pop);
            }
          },
        });
      }

      function handleAgDevolverParcial(idx: string): void {
        const targetIds = getAgVillageIdsForIdx(idx);
        if (targetIds.size === 0) return;

        resetDevolverState(form, ui, { ag: true });

        agParcialTargetIdx = idx;
        const aggData = getAgAggForIdx(idx);

        UNITS.forEach((u) => {
          const inp = byId<HTMLInputElement>(`vanta-ag-parcial-input-${u}`);
          const maxVal = aggData !== null ? (aggData.units[u] ?? 0) : 0;
          if (inp !== null) {
            inp.max = String(maxVal);
            inp.value = '0';
            inp.classList.remove('vanta-parcial-over');
          }
          const maxSpan = byId(`vanta-ag-parcial-max-${u}`);
          if (maxSpan !== null) maxSpan.textContent = maxVal > 0 ? String(maxVal) : '–';
        });
        const agPopCalc = byId('vanta-ag-parcial-pop-calc');
        if (agPopCalc !== null) agPopCalc.textContent = '–';
        const agPopInput = byId<HTMLInputElement>('vanta-ag-parcial-pop-input');
        if (agPopInput !== null) agPopInput.value = '';
        const tr = byId('vanta-ag-parcial-tr');
        if (tr !== null) tr.style.display = '';
      }

      function handleAgPreencherParcial(): void {
        const idx = agParcialTargetIdx;
        if (idx === null || lastAnaliseData === null) return;
        const targetIds = getAgVillageIdsForIdx(idx);

        const requested: Record<string, number> = Object.fromEntries(
          UNITS.map((u) => {
            const inp = byId<HTMLInputElement>(`vanta-ag-parcial-input-${u}`);
            return [u, inp !== null ? Math.max(0, parsePtBrInt(inp.value)) : 0];
          }),
        );

        const targetRows = lastAnaliseData.propRows.filter((r) => targetIds.has(r.villageId));
        if (targetRows.length === 0) return;

        const allocation = waterFill(UNITS, requested, targetRows);

        const tr = byId('vanta-ag-parcial-tr');
        if (tr !== null) tr.style.display = 'none';

        const rowEls: HTMLElement[] = targetRows.map((r) => r.tr);
        staggerFill(rowEls, {
          getCheckbox: (row) => row.querySelector<HTMLInputElement>('input.troop-request-selector'),
          fillFn: (row, cb) => {
            const alloc = allocation[rowEls.indexOf(row)];
            if (alloc !== undefined) fillRowAllocated(cb.dataset.awayId ?? '', UNITS, alloc);
          },
          onAllDone: () => {
            const enviar = byId<HTMLButtonElement>('vanta-enviar-de-volta');
            if (enviar !== null) enviar.disabled = false;
            const allocTotals: Record<string, number> = Object.fromEntries(
              UNITS.map((u) => [u, allocation.reduce((s, a) => s + (a[u] ?? 0), 0)]),
            );
            const allocPop = UNITS.reduce((s, u) => s + (allocTotals[u] ?? 0) * (UNIT_POP[u] ?? 0), 0);
            populateResumo('vanta-ag-resumo-row', 'vanta-ag-resumo-', 'Alocado', allocTotals, allocPop, {
              alocado: true,
              requested,
            });
          },
        });
      }

      const analiseBtn = ui.querySelector<HTMLButtonElement>('.vanta-b-analise-grupo-btn');
      if (analiseBtn === null) return;
      let analiseGroupsCache: Array<{ groupId: string; name: string }> | null = null;

      sc.on(analiseBtn, 'click', async () => {
        ui.querySelectorAll<HTMLElement>('.vanta-b-dropdown-menu').forEach((m) => {
          m.hidden = true;
        });
        const section = byId('vanta-analise-section');
        if (section === null) return;
        if (section.style.display !== 'none') {
          section.style.display = 'none';
          return;
        }
        section.style.display = '';
        section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        const picker = byId('vanta-ag-picker');
        const status = byId('vanta-ag-status');
        const analisarBtn = byId<HTMLButtonElement>('vanta-ag-analisar');
        if (picker === null || status === null || analisarBtn === null) return;

        if (analiseGroupsCache !== null) return; // já carregado

        picker.innerHTML = '';
        status.textContent = 'Carregando grupos...';
        analisarBtn.disabled = true;

        try {
          const vid = currentVillageId();
          if (vid === '') throw new Error('game_data indisponível');
          const url = `/game.php?village=${vid}&screen=groups&mode=overview&ajax=load_group_menu`;
          const body = await pacedGet(url);
          const json = JSON.parse(body) as { response?: { result?: unknown }; result?: unknown };
          const rawResult = json.response?.result ?? json.result;
          const list = Array.isArray(rawResult) ? rawResult : [];
          const groups = list.flatMap((g): Array<{ groupId: string; name: string }> => {
            const obj = g as { group_id?: unknown; name?: unknown; type?: unknown };
            const type = typeof obj.type === 'string' ? obj.type : '';
            if (type !== 'group_static' && type !== 'group_dynamic') return [];
            return [{ groupId: String(obj.group_id ?? ''), name: typeof obj.name === 'string' ? obj.name : '' }];
          });
          if (groups.length === 0) {
            status.textContent = 'Nenhum grupo encontrado.';
            return;
          }
          analiseGroupsCache = groups;
          status.textContent = '';

          const savedIds = gm.get<string[]>('tsh-vanta:blindagem:analise-groups', []);
          const savedSet = new Set(savedIds.map(String));
          picker.innerHTML = groups
            .map((g) => {
              const checked = savedSet.has(g.groupId) ? ' checked' : '';
              return `<label><input type="checkbox" value="${escAttr(g.groupId)}"${checked}> ${escapeHtml(g.name)}</label>`;
            })
            .join('');

          const summary = byId('vanta-ag-summary');
          if (summary === null) return;
          const updateSummary = (): void => {
            const cache = analiseGroupsCache;
            const selected = Array.from(picker.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'));
            const count = selected.length;
            const names = selected
              .map((c) => {
                const g = cache?.find((gr) => gr.groupId === c.value);
                return g !== undefined ? g.name : c.value;
              })
              .join(', ');
            summary.innerHTML = `<span class="vanta-ag-arrow">▶</span> <span>${
              count > 0
                ? `<span class="vanta-ag-selected-names">${count} grupo${count > 1 ? 's' : ''}: ${escapeHtml(names)}</span>`
                : 'Nenhum grupo selecionado'
            }</span>`;
            if (summary.classList.contains('vanta-ag-expanded')) summary.classList.add('vanta-ag-expanded');
          };
          updateSummary();

          sc.on(summary, 'click', () => {
            const expanded = picker.style.display !== 'none';
            picker.style.display = expanded ? 'none' : '';
            summary.classList.toggle('vanta-ag-expanded', !expanded);
          });

          analisarBtn.disabled = picker.querySelector<HTMLInputElement>('input[type="checkbox"]:checked') === null;
          picker.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
            sc.on(cb, 'change', () => {
              analisarBtn.disabled = picker.querySelector<HTMLInputElement>('input[type="checkbox"]:checked') === null;
              const sel = Array.from(picker.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map(
                (c) => c.value,
              );
              gm.set('tsh-vanta:blindagem:analise-groups', sel);
              updateSummary();
            });
          });
        } catch (err) {
          status.textContent = 'Erro ao carregar grupos: ' + (err instanceof Error ? err.message : String(err));
        }
      });

      const analisarBtn = byId<HTMLButtonElement>('vanta-ag-analisar');
      if (analisarBtn === null) return;
      sc.on(analisarBtn, 'click', async () => {
        const picker = byId('vanta-ag-picker');
        const status = byId('vanta-ag-status');
        const results = byId('vanta-ag-results');
        if (picker === null || status === null || results === null) return;

        const checked = Array.from(picker.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'));
        if (checked.length === 0) return;

        analisarBtn.disabled = true;
        status.textContent = 'Buscando aldeias dos grupos...';
        results.innerHTML = '';

        try {
          const vid = currentVillageId();
          const csrf = currentCsrf();
          const cache = analiseGroupsCache ?? [];

          // Aldeias de cada grupo selecionado (fila global serializa os POSTs)
          const groupEntries = await Promise.all(
            checked.map(async (cb): Promise<GroupEntry> => {
              const groupId = cb.value;
              const groupName = cache.find((g) => g.groupId === groupId)?.name ?? groupId;
              const url = `/game.php?village=${vid}&screen=groups&ajax=load_villages_from_group`;
              const { json } = await vantaPostJson(url, { group_id: groupId, h: csrf });
              const tmp = new DOMParser().parseFromString(extractAjaxHtml(json), 'text/html');
              const ids = new Set<string>();
              tmp.querySelectorAll<HTMLAnchorElement>('a.select-village[data-village-id]').forEach((a) => {
                const v = a.dataset.villageId;
                if (v !== undefined) ids.add(v);
              });
              return { groupId, groupName, villageIds: ids };
            }),
          );

          // Agrega unidades por grupo (só linhas "Próprias")
          const propRows = villageRows.filter((r): r is PropRow => r.playerName === 'Próprias' && r.villageId !== null);

          const groupAgg: AggData[] = groupEntries.map((g) => {
            const agg: AggData = { units: Object.fromEntries(UNITS.map((u) => [u, 0])), pop: 0, count: 0 };
            propRows.forEach((r) => {
              if (g.villageIds.has(r.villageId)) {
                UNITS.forEach((u) => {
                  agg.units[u] = (agg.units[u] ?? 0) + (r.units[u] ?? 0);
                });
                agg.pop += UNITS.reduce((s, u) => s + (r.units[u] ?? 0) * (UNIT_POP[u] ?? 0), 0);
                agg.count += 1;
              }
            });
            return agg;
          });

          // "Outras" — aldeias fora de qualquer grupo selecionado
          const allGroupIds = new Set<string>();
          groupEntries.forEach((g) => g.villageIds.forEach((id) => allGroupIds.add(id)));
          const outrasAgg: AggData = { units: Object.fromEntries(UNITS.map((u) => [u, 0])), pop: 0, count: 0 };
          propRows.forEach((r) => {
            if (!allGroupIds.has(r.villageId)) {
              UNITS.forEach((u) => {
                outrasAgg.units[u] = (outrasAgg.units[u] ?? 0) + (r.units[u] ?? 0);
              });
              outrasAgg.pop += UNITS.reduce((s, u) => s + (r.units[u] ?? 0) * (UNIT_POP[u] ?? 0), 0);
              outrasAgg.count += 1;
            }
          });

          // Total do playerMap (evita contagem dupla)
          const propriasData = playerMap['Próprias'];
          const totalPop = propriasData !== undefined ? propriasData.pop : 0;

          const agHeaderCells = UNITS.map((u) => {
            const src = iconSrcs[u];
            return src !== undefined
              ? `<th><img src="${escAttr(src)}" style="width:18px;height:18px;display:block;margin:0 auto" title="${escAttr(u)}"></th>`
              : `<th>${u}</th>`;
          }).join('');

          const buildRow = (label: string, agg: AggData, cssClass: string | null, actionHtml: string): string => {
            const cells = UNITS.map((u) => {
              const v = agg.units[u] ?? 0;
              return v === 0 ? '<td class="vanta-zero">–</td>' : `<td>${v}</td>`;
            }).join('');
            return `<tr${cssClass !== null ? ` class="${cssClass}"` : ''}><td class="vanta-ag-group-name">${escapeHtml(label)}</td>${cells}<td>${agg.pop}</td>${actionHtml}</tr>`;
          };

          const analiseData: AnaliseData = { groupEntries, groupAgg, propRows, outrasVillageIds: new Set<string>() };
          propRows.forEach((r) => {
            if (!allGroupIds.has(r.villageId)) analiseData.outrasVillageIds.add(r.villageId);
          });
          lastAnaliseData = analiseData;

          const buildActionCell = (dataAttr: string): string =>
            `<td class="vanta-ag-acoes"><div class="vanta-b-dropdown"><button type="button" class="vanta-b-acoes-trigger vanta-ag-trigger">Ações ▾</button><div class="vanta-b-dropdown-menu" hidden><button type="button" class="vanta-ag-devolver-btn" ${dataAttr}>↩ Devolver tudo</button><button type="button" class="vanta-ag-parcial-btn" ${dataAttr}>✂ Devolver parcial</button></div></div></td>`;

          const groupRows = groupEntries
            .map((g, i) => {
              const agg = groupAgg[i];
              if (agg === undefined) return '';
              return buildRow(`${g.groupName} (${agg.count})`, agg, null, buildActionCell(`data-ag-idx="${i}"`));
            })
            .join('');

          const outrasRow =
            outrasAgg.count > 0
              ? buildRow(`Outras (${outrasAgg.count})`, outrasAgg, 'vanta-ag-outras', buildActionCell('data-ag-idx="outras"'))
              : buildRow('Outras (0)', outrasAgg, 'vanta-ag-outras', '<td></td>');

          const totalCells2 = UNITS.map((u) => {
            const v = propriasData !== undefined ? (propriasData.units[u] ?? 0) : 0;
            return v === 0 ? '<td class="vanta-zero">–</td>' : `<td>${v}</td>`;
          }).join('');
          const totalRow = `<tr class="vanta-ag-total"><td class="vanta-ag-group-name">Total</td>${totalCells2}<td>${totalPop}</td><td></td></tr>`;

          const parcialRow = `<tr id="vanta-ag-parcial-tr" style="display:none"><td class="vanta-ag-group-name" style="color:#888;font-size:10px;white-space:normal;line-height:1.3">Tropas a devolver</td>${UNITS.map((u) => `<td class="vanta-ag-parcial-cell"><input id="vanta-ag-parcial-input-${u}" type="number" min="0" value="0"><span class="vanta-ag-parcial-max" id="vanta-ag-parcial-max-${u}">–</span></td>`).join('')}<td id="vanta-ag-parcial-pop" class="vanta-parcial-pop-cell"><input id="vanta-ag-parcial-pop-input" type="number" min="0" value="" placeholder="Pop"><span id="vanta-ag-parcial-pop-calc">–</span></td><td class="vanta-ag-acoes" id="vanta-ag-parcial-btns"><button type="button" id="vanta-ag-preencher-parcial">Preencher</button><button type="button" id="vanta-ag-parcial-cancel">✕</button></td></tr>`;

          const resumoRow = `<tr id="vanta-ag-resumo-row" style="display:none"><td class="vanta-ag-group-name" id="vanta-ag-resumo-label"></td>${UNITS.map((u) => `<td id="vanta-ag-resumo-${u}">–</td>`).join('')}<td id="vanta-ag-resumo-pop"></td><td></td></tr>`;

          const agUnitCols = UNITS.map(() => '<col class="vanta-ag-unit">').join('');
          results.innerHTML = `<table><colgroup><col>${agUnitCols}<col class="vanta-ag-pop"><col class="vanta-ag-acoes-col"></colgroup><thead><tr><th class="vanta-ag-group-header">Grupo</th>${agHeaderCells}<th>Pop</th><th class="vanta-ag-acoes">Ações</th></tr></thead><tbody>${groupRows}${outrasRow}${totalRow}${parcialRow}${resumoRow}</tbody></table>`;

          // Triggers dos dropdowns da tabela de análise
          results.querySelectorAll<HTMLButtonElement>('.vanta-ag-trigger').forEach((trigger) => {
            sc.on(trigger, 'click', (e) => {
              e.stopPropagation();
              const menu = trigger.nextElementSibling;
              if (!(menu instanceof HTMLElement)) return;
              const isOpen = !menu.hidden;
              results.querySelectorAll<HTMLElement>('.vanta-b-dropdown-menu').forEach((m) => {
                m.hidden = true;
              });
              if (!isOpen) {
                menu.hidden = false;
                const rect = trigger.getBoundingClientRect();
                menu.style.top = `${rect.bottom}px`;
                menu.style.left = `${rect.right - menu.offsetWidth}px`;
              }
            });
          });

          // Fecha dropdowns da análise ao clicar fora
          sc.on(
            document,
            'mousedown',
            (e) => {
              const target = e.target;
              if (target instanceof Element && target.closest('.vanta-b-dropdown') === null) {
                results.querySelectorAll<HTMLElement>('.vanta-b-dropdown-menu').forEach((m) => {
                  m.hidden = true;
                });
              }
            },
            { capture: true },
          );

          // Devolver tudo por grupo
          results.querySelectorAll<HTMLButtonElement>('.vanta-ag-devolver-btn').forEach((btn) => {
            sc.on(btn, 'click', () => {
              handleAgDevolverTudo(btn.dataset.agIdx ?? '');
            });
          });

          // Devolver parcial por grupo
          results.querySelectorAll<HTMLButtonElement>('.vanta-ag-parcial-btn').forEach((btn) => {
            sc.on(btn, 'click', () => {
              handleAgDevolverParcial(btn.dataset.agIdx ?? '');
            });
          });

          // Pop ao vivo dos inputs do parcial AG
          UNITS.forEach((u) => {
            const inp = byId<HTMLInputElement>(`vanta-ag-parcial-input-${u}`);
            if (inp === null) return;
            sc.on(inp, 'input', () => {
              const val = parsePtBrInt(inp.value);
              const max = parsePtBrInt(inp.max);
              inp.classList.toggle('vanta-parcial-over', max > 0 && val > max);
              let pop = 0;
              UNITS.forEach((uu) => {
                pop += parsePtBrInt(byId<HTMLInputElement>(`vanta-ag-parcial-input-${uu}`)?.value) * (UNIT_POP[uu] ?? 0);
              });
              const popCalc = byId('vanta-ag-parcial-pop-calc');
              if (popCalc !== null) popCalc.textContent = pop > 0 ? String(pop) : '–';
              const popInp = byId<HTMLInputElement>('vanta-ag-parcial-pop-input');
              if (popInp !== null && !_distributingPop) popInp.value = '';
            });
          });

          // Distribuição por pop do parcial AG
          const agPopIn = byId<HTMLInputElement>('vanta-ag-parcial-pop-input');
          if (agPopIn !== null) {
            sc.on(agPopIn, 'input', () => {
              const targetPop = Math.max(0, parsePtBrInt(agPopIn.value));
              if (targetPop === 0) return;
              distributePop(targetPop, 'vanta-ag-parcial-input-', 'vanta-ag-parcial-pop-calc');
            });
          }

          const agCancel = byId<HTMLButtonElement>('vanta-ag-parcial-cancel');
          if (agCancel !== null) {
            sc.on(agCancel, 'click', () => {
              const tr = byId('vanta-ag-parcial-tr');
              if (tr !== null) tr.style.display = 'none';
              results.querySelectorAll<HTMLButtonElement>('.vanta-ag-trigger').forEach((b) => {
                b.disabled = false;
              });
              ui.querySelectorAll<HTMLButtonElement>('.vanta-b-acoes-trigger').forEach((b) => {
                b.disabled = false;
              });
            });
          }

          const agPreencher = byId<HTMLButtonElement>('vanta-ag-preencher-parcial');
          if (agPreencher !== null) {
            sc.on(agPreencher, 'click', () => {
              handleAgPreencherParcial();
            });
          }

          status.textContent = '';
          analisarBtn.disabled = false;
        } catch (err) {
          status.textContent = 'Erro: ' + (err instanceof Error ? err.message : String(err));
          analisarBtn.disabled = false;
        }
      });
    }

    // ── Orquestração ────────────────────────────────────────────────────

    const { playerMap, villageRows, iconSrcs } = parseDefenseTable(table);
    const ui = buildBlindagemTable(playerMap, iconSrcs);
    h3.insertAdjacentElement('afterend', scope.owns(ui));
    ui.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    setupDropdownMenus(scope, ui);
    setupDevolverTudo(scope, form, ui, playerMap);
    setupDevolverParcial(scope, form, ui, playerMap, villageRows);
    setupAnaliseGrupo(scope, form, ui, playerMap, villageRows, iconSrcs);

    const enviarBtn = byId<HTMLButtonElement>('vanta-enviar-de-volta');
    if (enviarBtn !== null) {
      scope.on(enviarBtn, 'click', () => {
        // P2: resumo do que será devolvido antes do submit destrutivo
        let villages = 0;
        let pop = 0;
        form.querySelectorAll<HTMLInputElement>('input.troop-request-selector:checked').forEach((cb) => {
          villages += 1;
          const awayId = cb.dataset.awayId ?? '';
          UNITS.forEach((u) => {
            const inp = byId<HTMLInputElement>(`${awayId}_${u}`);
            if (inp !== null) pop += parsePtBrInt(inp.value) * (UNIT_POP[u] ?? 0);
          });
        });
        if (villages === 0) return;
        // "Devolver tudo" não preenche inputs (pop lê 0) — mensagem adaptada
        // para não prometer "0 pop" (P3 da revisão da Onda 2).
        const msg =
          pop > 0
            ? `Devolver tropas de ${villages} aldeia(s) — ${pop} pop?`
            : `Devolver TODAS as tropas marcadas em ${villages} aldeia(s)?`;
        if (!window.confirm(msg)) return;
        const submitBtn = form.querySelector<HTMLInputElement>('input.btn[type="submit"]');
        submitBtn?.click();
      });
    }
  },
});
