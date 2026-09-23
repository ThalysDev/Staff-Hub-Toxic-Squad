// Apoio em Massa (port do TW Vanta, linhas 1641-2219) — place&mode=call:
// UI de cálculo por tempo/aflição, tabela de tropas, water-fill, preencher e
// enviar. Correções da auditoria embutidas:
// - P1-3 (linha 1788): default do datetime-local em UTC → toLocalDatetimeValue
//   (fuso local); "agora" do servidor via parseServerNow (linhas 1875-1880) com
//   fallback Date.now().
// - P2 (linha 2094): window.confirm com resumo (pop/aldeias) antes de clicar
//   no submit "Enviar Tropas".
// - P1-2: leituras numéricas do DOM do jogo via parsePtBrInt.

import { registerVanta } from './vanta-registry';
import { ensureVantaStyles } from './vanta-styles';
import type { ModuleScope } from './vanta-lifecycle';
import { parsePtBrInt, parseNumLoose, toLocalDatetimeValue, parseServerNow, UNIT_POP, escAttr } from './vanta-utils';
import { waterFill } from './vanta-forms';
import { gameData } from './vanta-net';
import { gm } from '../../core/storage';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/** Chaves de persistência (gm, JSON). */
const K = {
  group: 'tsh-vanta:apoio:group',
  target: 'tsh-vanta:apoio:target',
  datetime: 'tsh-vanta:apoio:datetime',
  aflic: 'tsh-vanta:apoio:aflic',
  mode: 'tsh-vanta:apoio:mode',
  minEnviarEnabled: 'tsh-vanta:apoio:minenviar:enabled',
  minEnviar(unit: string): string {
    return `tsh-vanta:apoio:minenviar:${unit}`;
  },
  amount(row: string, unit: string): string {
    return `tsh-vanta:apoio:${row}:${unit}`;
  },
};

/** Velocidade das unidades defensivas (minutos/campo) — constante do Vanta. */
const UNIT_SPEED: Record<string, number> = { spear: 18, sword: 22, archer: 18, spy: 9, light: 10, heavy: 11 };

/** Unidades manipuladas pelo módulo (o resto é ignorado). */
const ALLOWED_UNITS = new Set(['spear', 'sword', 'archer', 'spy', 'light', 'heavy']);

const COORD_RE = /^\d{1,3}\|\d{1,3}$/;

interface UnitCol {
  unit: string;
  src: string;
  title: string;
}

interface VillageRow {
  tr: HTMLTableRowElement;
  units: Record<string, number>;
}

const fmtK = (n: number): string => (n / 1000).toFixed(2);

registerVanta({
  id: 'vanta-apoiomassa',
  label: 'Apoio em Massa',
  desc: 'Envio em massa de tropas de apoio',
  group: 'blindagem',
  match: () => params().get('screen') === 'place' && params().get('mode') === 'call',
  url: () => '/game.php?screen=place&mode=call&target=0',
  mount(scope: ModuleScope) {
    ensureVantaStyles();
    if (params().get('screen') !== 'place' || params().get('mode') !== 'call') return;

    const h3 = Array.from(document.querySelectorAll('h3')).find(
      (el) => el.textContent?.trim() === 'Enviar apoio em massa',
    );
    if (h3 === undefined || document.getElementById('vanta-apoio-ui') !== null) return;

    // Estado compartilhado (refs populadas por setupApoioControls)
    let villageData: VillageRow[] = [];
    let toggle: HTMLInputElement | null = null;
    let coordInput: HTMLInputElement | null = null;
    let dtInput: HTMLInputElement | null = null;
    let aflicInput: HTMLInputElement | null = null;
    let groupSelect: HTMLSelectElement | null = null;

    function buildApoioUI(): HTMLElement {
      const el = document.createElement('div');
      el.id = 'vanta-apoio-ui';
      el.innerHTML = `
                <div id="vanta-apoio-header">
                    <span id="vanta-apoio-header-title">⚔ Vanta — Apoio em Massa</span>
                </div>
                <div id="vanta-apoio-body">
                    <div class="vanta-apoio-row">
                        <span class="vanta-apoio-label bright">Modo de utilização:</span>
                        <label class="vanta-apoio-switch">
                            <input type="checkbox" id="vanta-apoio-mode-toggle">
                            <span class="vanta-apoio-slider"></span>
                        </label>
                        <span class="vanta-apoio-label" id="vanta-apoio-mode-label">Sem limite de horário</span>
                    </div>

                    <div id="vanta-apoio-time-section">
                        <div class="vanta-apoio-inputs">
                            <div class="vanta-apoio-input-group">
                                <span>Até o horário</span>
                                <input class="vanta-apoio-datetime" id="vanta-apoio-datetime"
                                    type="datetime-local" step="1">
                            </div>
                            <div class="vanta-apoio-divider-v"></div>
                            <div class="vanta-apoio-input-group">
                                <span>Aflição (%)</span>
                                <input class="vanta-apoio-num" id="vanta-apoio-aflic"
                                    type="number" min="0" max="100" step="1" value="0">
                            </div>
                        </div>
                    </div>

                    <div style="display:flex;gap:8px;align-items:flex-end">
                        <div class="vanta-apoio-select-wrap" style="flex:1;min-width:0">
                            <span class="vanta-apoio-select-label">Grupo de aldeias</span>
                            <select id="vanta-apoio-group" class="vanta-apoio-select" style="width:100%">
                                <option value="">Carregando grupos...</option>
                            </select>
                        </div>
                        <div class="vanta-apoio-input-group" style="flex:1;min-width:0">
                            <span>Alvo (XXX|YYY)</span>
                            <div style="display:flex;gap:4px;align-items:center">
                                <input class="vanta-apoio-coord" id="vanta-apoio-target"
                                    type="text" placeholder="500|500" maxlength="7" style="flex:1;min-width:0">
                                <button id="vanta-apoio-use-current" type="button" title="Usar aldeia atual">Aldeia Atual</button>
                            </div>
                        </div>
                    </div>

                    <div id="vanta-minenviar-toggle-row" style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
                        <input type="checkbox" id="vanta-minenviar-enabled">
                        <label for="vanta-minenviar-enabled" style="color:#aaa;font-size:11px">Min Enviar por aldeia</label>
                    </div>

                    <button id="vanta-apoio-calc-btn">Calcular Tropas Disponíveis</button>
                </div>
            `;
      return el;
    }

    function setupApoioControls(sc: ModuleScope, ui: HTMLElement): void {
      const gs = ui.querySelector<HTMLSelectElement>('#vanta-apoio-group');
      groupSelect = gs;
      if (gs === null) return;

      // Dropdown de grupos a partir do .group-menu-item da página
      const groupItems = document.querySelectorAll<HTMLElement>('.group-menu-item');
      if (groupItems.length > 0) {
        gs.innerHTML = '';
        groupItems.forEach((el) => {
          const opt = document.createElement('option');
          opt.value = el.dataset.groupId ?? '0';
          opt.textContent = (el.textContent ?? '').trim();
          gs.appendChild(opt);
        });
      } else {
        gs.innerHTML = '<option value="">Nenhum grupo encontrado</option>';
      }

      const savedGroup = gm.get<string>(K.group, '');
      if (savedGroup !== '') gs.value = savedGroup;

      sc.on(gs, 'change', () => {
        gm.set(K.group, gs.value);
        const p = new URLSearchParams(window.location.search);
        if (p.get('group') !== gs.value || p.get('page') !== '-1') {
          p.set('group', gs.value);
          p.set('page', '-1');
          window.location.replace('?' + p.toString());
        }
      });

      const ci = ui.querySelector<HTMLInputElement>('#vanta-apoio-target');
      coordInput = ci;
      if (ci === null) return;

      const savedCoord = gm.get<string>(K.target, '');
      if (savedCoord !== '') {
        ci.value = savedCoord;
        ci.classList.toggle('valid', COORD_RE.test(savedCoord));
      }

      sc.on(ci, 'input', () => {
        const val = ci.value.trim();
        const ok = COORD_RE.test(val);
        ci.classList.toggle('valid', ok);
        if (ok) gm.set(K.target, val);
      });

      // "Aldeia Atual" — preenche a coordenada da aldeia do game_data
      const useCurrent = ui.querySelector<HTMLButtonElement>('#vanta-apoio-use-current');
      if (useCurrent !== null) {
        sc.on(useCurrent, 'click', () => {
          const village = gameData()['village'] as { coord?: unknown } | undefined;
          const coord = typeof village?.coord === 'string' ? village.coord : '';
          if (coord !== '' && coordInput !== null) {
            coordInput.value = coord;
            coordInput.classList.toggle('valid', COORD_RE.test(coord));
            gm.set(K.target, coord);
          }
        });
      }

      // Datetime: restaura salvo ou usa a hora LOCAL atual (P1-3)
      const dt = ui.querySelector<HTMLInputElement>('#vanta-apoio-datetime');
      dtInput = dt;
      if (dt !== null) {
        const savedDatetime = gm.get<string>(K.datetime, '');
        if (savedDatetime !== '') {
          dt.value = savedDatetime;
        } else {
          const now = new Date();
          now.setSeconds(0, 0);
          dt.value = toLocalDatetimeValue(now);
        }
      }

      const tg = ui.querySelector<HTMLInputElement>('#vanta-apoio-mode-toggle');
      toggle = tg;
      const modeLabel = ui.querySelector('#vanta-apoio-mode-label');
      const section = ui.querySelector('#vanta-apoio-time-section');

      const af = ui.querySelector<HTMLInputElement>('#vanta-apoio-aflic');
      aflicInput = af;
      if (af !== null) {
        const savedAflic = gm.get<string>(K.aflic, '');
        if (savedAflic !== '') af.value = savedAflic;
      }

      const rebuildIfVisible = (): void => {
        if (document.getElementById('vanta-apoio-results') !== null) buildTroopTable(sc, ui);
      };

      const savedMode = gm.get<boolean>(K.mode, false);
      if (tg !== null && modeLabel !== null && section !== null) {
        if (savedMode) {
          tg.checked = true;
          modeLabel.textContent = 'Até o horário';
          section.classList.add('visible');
        }
        sc.on(tg, 'change', () => {
          const on = tg.checked;
          modeLabel.textContent = on ? 'Até o horário' : 'Sem limite de horário';
          section.classList.toggle('visible', on);
          gm.set(K.mode, on);
          rebuildIfVisible();
        });
      }

      if (dt !== null) {
        sc.on(dt, 'change', () => {
          gm.set(K.datetime, dt.value);
          rebuildIfVisible();
        });
      }
      if (af !== null) {
        sc.on(af, 'change', () => {
          gm.set(K.aflic, af.value);
          rebuildIfVisible();
        });
      }

      const cbMinEnviar = ui.querySelector<HTMLInputElement>('#vanta-minenviar-enabled');
      if (cbMinEnviar !== null) {
        cbMinEnviar.checked = gm.get<boolean>(K.minEnviarEnabled, false);
        sc.on(cbMinEnviar, 'change', () => {
          gm.set(K.minEnviarEnabled, cbMinEnviar.checked);
          rebuildIfVisible();
        });
      }
    }

    function buildTroopTable(sc: ModuleScope, ui: HTMLElement): void {
      const troupList = document.getElementById('village_troup_list');
      if (!(troupList instanceof HTMLTableElement)) return;

      villageData = [];

      // Tipos de unidade do cabeçalho da tabela do jogo
      const unitTypes: UnitCol[] = [];
      troupList.querySelectorAll('thead th').forEach((th) => {
        const img = th.querySelector<HTMLImageElement>('img');
        const checkbox = th.querySelector<HTMLInputElement>('input[id^="checkbox_"]');
        if (img === null || checkbox === null) return;
        unitTypes.push({
          unit: checkbox.id.replace('checkbox_', ''),
          src: img.src,
          title: img.dataset.title ?? '',
        });
      });

      // Min Enviar — mínimo por unidade/aldeia (tudo-ou-nada)
      const minEnviarEnabled = gm.get<boolean>(K.minEnviarEnabled, false);
      const minEnviarThresholds: Record<string, number> = {};
      if (minEnviarEnabled) {
        unitTypes.forEach(({ unit }) => {
          minEnviarThresholds[unit] = gm.get<number>(K.minEnviar(unit), 0);
        });
      }

      const totals: Record<string, number> = {};
      unitTypes.forEach((u) => {
        totals[u.unit] = 0;
      });

      const isTimeMode = toggle?.checked === true;
      const coordM = /^(\d+)\|(\d+)$/.exec((coordInput?.value ?? '').trim());
      const targetX = coordM !== null && coordM[1] !== undefined ? parseInt(coordM[1], 10) : null;
      const targetY = coordM !== null && coordM[2] !== undefined ? parseInt(coordM[2], 10) : null;

      let availableMinutes: number | null = null;
      let aflicaoPct = 0;
      if (isTimeMode && dtInput !== null && dtInput.value !== '' && targetX !== null && targetY !== null) {
        aflicaoPct = parseNumLoose(aflicInput?.value);
        // P1-3: "agora" do servidor via parseServerNow, fallback Date.now()
        const serverTime = document.getElementById('serverTime')?.innerText ?? '';
        const serverDate = document.getElementById('serverDate')?.innerText ?? '';
        const serverNow = parseServerNow(serverDate, serverTime);
        const baseTime = serverNow !== null ? serverNow.getTime() : Date.now();
        const target = new Date(dtInput.value).getTime();
        if (!Number.isNaN(target)) availableMinutes = (target - baseTime) / 60000;
      }

      if (!isTimeMode || availableMinutes === null) {
        // Todas as aldeias — coleta totais + dados por aldeia
        troupList.querySelectorAll('tbody tr.call-village').forEach((tr) => {
          const vUnits: Record<string, number> = {};
          unitTypes.forEach((u) => {
            vUnits[u.unit] = 0;
          });
          tr.querySelectorAll('td[data-unit]').forEach((td) => {
            const u = td.getAttribute('data-unit');
            if (u === null || !(u in totals)) return;
            const cnt = parsePtBrInt(td.getAttribute('data-count'));
            const threshold = minEnviarEnabled ? (minEnviarThresholds[u] ?? 0) : 0;
            const effective = threshold > 0 && cnt < threshold ? 0 : cnt;
            totals[u] = (totals[u] ?? 0) + effective;
            vUnits[u] = effective;
          });
          villageData.push({ tr: tr as HTMLTableRowElement, units: vUnits });
        });
      } else if (targetX !== null && targetY !== null) {
        // Filtrado por tempo — só aldeias com ao menos uma unidade elegível
        troupList.querySelectorAll('tbody tr.call-village').forEach((tr) => {
          const link = tr.querySelector('td:first-child a');
          if (link === null) return;
          const cm = /\((\d+)\|(\d+)\)/.exec(link.textContent ?? '');
          if (cm === null || cm[1] === undefined || cm[2] === undefined) return;
          const vx = parseInt(cm[1], 10);
          const vy = parseInt(cm[2], 10);
          const dist = Math.sqrt((vx - targetX) ** 2 + (vy - targetY) ** 2);
          const vUnits: Record<string, number> = {};
          unitTypes.forEach((u) => {
            vUnits[u.unit] = 0;
          });
          let hasEligible = false;
          tr.querySelectorAll('td[data-unit]').forEach((td) => {
            const u = td.getAttribute('data-unit');
            if (u === null || !(u in totals)) return;
            const travelTime = (dist * (UNIT_SPEED[u] ?? Infinity)) / (1 + aflicaoPct / 100);
            if (travelTime <= availableMinutes) {
              const cnt = parsePtBrInt(td.getAttribute('data-count'));
              const threshold = minEnviarEnabled ? (minEnviarThresholds[u] ?? 0) : 0;
              const effective = threshold > 0 && cnt < threshold ? 0 : cnt;
              totals[u] = (totals[u] ?? 0) + effective;
              vUnits[u] = effective;
              if (effective > 0) hasEligible = true;
            }
          });
          if (hasEligible) villageData.push({ tr: tr as HTMLTableRowElement, units: vUnits });
        });
      }

      // Só os tipos desejados com tropas disponíveis (em modo tempo mostra
      // todas as permitidas, zeradas se nenhuma chegar a tempo)
      const active = unitTypes.filter((u) => ALLOWED_UNITS.has(u.unit) && (isTimeMode || (totals[u.unit] ?? 0) > 0));
      if (active.length === 0) return;

      let resultsDiv = document.getElementById('vanta-apoio-results');
      if (resultsDiv === null) {
        resultsDiv = document.createElement('div');
        resultsDiv.id = 'vanta-apoio-results';
        ui.querySelector('#vanta-apoio-body')?.appendChild(resultsDiv);
      }

      resultsDiv.innerHTML = `
                <table id="vanta-troop-table">
                    <thead>
                        <tr>
                            <th class="vanta-tt-label">Tropas</th>
                            ${active.map((u) => `<th><img src="${escAttr(u.src)}" title="${escAttr(u.title)}" width="16" height="16"></th>`).join('')}
                            <th>Pop <span class="vanta-k">k</span></th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr class="vanta-tt-total">
                            <td class="vanta-tt-label">Total</td>
                            ${active.map((u) => `<td>${fmtK(totals[u.unit] ?? 0)} <span class="vanta-k">k</span></td>`).join('')}
                            <td id="vanta-total-pop">${fmtK(active.reduce((s, u) => s + (totals[u.unit] ?? 0) * (UNIT_POP[u.unit] ?? 0), 0))} <span class="vanta-k">k</span></td>
                        </tr>
                        ${minEnviarEnabled ? `
                        <tr class="vanta-tt-minenviar" id="vanta-tt-minenviar-row">
                            <td class="vanta-tt-label">Min Enviar<br><span style="color:#555;font-size:9px">un./aldeia</span></td>
                            ${active.map((u) => `<td><input class="vanta-tt-input" type="number" min="0" step="1" data-unit="${u.unit}" data-row="minenviar" value="${gm.get<number>(K.minEnviar(u.unit), 0)}"></td>`).join('')}
                            <td></td>
                        </tr>` : ''}
                        <tr class="vanta-tt-send">
                            <td class="vanta-tt-label">Enviar</td>
                            ${active.map((u) => `<td><input class="vanta-tt-input" type="number" min="0" step="0.001" data-unit="${u.unit}" data-row="send" value="${gm.get<number>(K.amount('send', u.unit), 0)}"> <span class="vanta-k">k</span></td>`).join('')}
                            <td><input class="vanta-tt-input vanta-tt-pop-input" type="number" min="0" step="0.01" id="vanta-send-pop" data-row="send" value="0"></td>
                        </tr>
                        <tr class="vanta-tt-alloc" id="vanta-tt-alloc-row" style="display:none">
                            <td class="vanta-tt-label" id="vanta-alloc-label">Alocado</td>
                            ${active.map((u) => `<td id="vanta-alloc-${u.unit}">—</td>`).join('')}
                            <td id="vanta-alloc-pop">—</td>
                        </tr>
                    </tbody>
                </table>
                <button id="vanta-fill-btn">Preencher as Tropas</button>
                <button id="vanta-send-btn" style="display:none">Enviar Tropas</button>
            `;

      // Persistência dos inputs "Min Enviar"
      if (minEnviarEnabled) {
        resultsDiv.querySelectorAll<HTMLInputElement>('input[data-row="minenviar"]').forEach((inp) => {
          sc.on(inp, 'change', () => {
            gm.set(K.minEnviar(inp.dataset.unit ?? ''), parseNumLoose(inp.value));
            buildTroopTable(sc, ui);
          });
        });
      }

      // Unidades que recebem distribuição por pop (pop > 0)
      const distributable = active.filter((u) => (UNIT_POP[u.unit] ?? 0) > 0);
      const totalAvailPop = distributable.reduce((s, u) => s + (totals[u.unit] ?? 0) * (UNIT_POP[u.unit] ?? 0), 0);

      function updatePopCols(): void {
        let sendPop = 0;
        active.forEach((u) => {
          const pop = UNIT_POP[u.unit] ?? 0;
          const sv = parseNumLoose(resultsDiv?.querySelector<HTMLInputElement>(`input[data-unit="${u.unit}"][data-row="send"]`)?.value);
          sendPop += sv * 1000 * pop;
        });
        const popInp = resultsDiv?.querySelector<HTMLInputElement>('#vanta-send-pop');
        if (popInp !== null && popInp !== undefined) popInp.value = (sendPop / 1000).toFixed(2);
      }

      function distributeByPop(row: string, targetPopK: number): void {
        if (totalAvailPop === 0) return;
        const targetPop = targetPopK * 1000;
        distributable.forEach((u) => {
          const unitShare = (targetPop * (totals[u.unit] ?? 0) * (UNIT_POP[u.unit] ?? 0)) / totalAvailPop;
          const inK = Math.min(unitShare / (UNIT_POP[u.unit] ?? 1), totals[u.unit] ?? 0) / 1000;
          const inp = resultsDiv?.querySelector<HTMLInputElement>(`input[data-unit="${u.unit}"][data-row="${row}"]`);
          if (inp !== null && inp !== undefined) {
            inp.value = inK.toFixed(3);
            gm.set(K.amount(row, u.unit), parseNumLoose(inp.value));
          }
        });
      }

      // Inputs de unidade → atualiza pop + destaque de excedente
      resultsDiv.querySelectorAll<HTMLInputElement>('.vanta-tt-input:not(.vanta-tt-pop-input)').forEach((inp) => {
        sc.on(inp, 'input', () => {
          const row = inp.dataset.row ?? '';
          const unit = inp.dataset.unit ?? '';
          gm.set(K.amount(row, unit), parseNumLoose(inp.value));
          updatePopCols();
          if (row === 'send') {
            const val = parseNumLoose(inp.value) * 1000;
            inp.classList.toggle('vanta-tt-over', val > (totals[unit] ?? 0));
          }
        });
      });

      // Inputs de pop → distribuição proporcional
      resultsDiv.querySelectorAll<HTMLInputElement>('.vanta-tt-pop-input').forEach((popInp) => {
        sc.on(popInp, 'input', () => {
          distributeByPop(popInp.dataset.row ?? 'send', parseNumLoose(popInp.value));
        });
      });

      updatePopCols();

      const fillBtn = resultsDiv.querySelector<HTMLButtonElement>('#vanta-fill-btn');
      if (fillBtn !== null) {
        sc.on(fillBtn, 'click', () => {
          handlePreencherTropas(sc, troupList, active, resultsDiv);
        });
      }
    }

    function handlePreencherTropas(
      sc: ModuleScope,
      troupList: HTMLTableElement,
      active: UnitCol[],
      resultsDiv: HTMLElement,
    ): void {
      if (villageData.length === 0) return;

      // Desmarca os checkboxes de tipo de unidade do cabeçalho antes de preencher
      troupList.querySelectorAll<HTMLInputElement>('thead th input[id^="checkbox_"]').forEach((cb) => {
        if (cb.checked) cb.click();
      });

      // Quantidades a enviar (k → contagem bruta)
      const sendAmounts: Record<string, number> = {};
      active.forEach(({ unit }) => {
        const inp = resultsDiv.querySelector<HTMLInputElement>(`input[data-unit="${unit}"][data-row="send"]`);
        sendAmounts[unit] = Math.round(parseNumLoose(inp?.value) * 1000);
      });

      // Distribui cada unidade igualmente, respeitando a disponibilidade
      const allocation = waterFill(
        active.map((u) => u.unit),
        sendAmounts,
        villageData,
      );

      const allocRow = resultsDiv.querySelector<HTMLElement>('#vanta-tt-alloc-row');
      const sendBtn = resultsDiv.querySelector<HTMLButtonElement>('#vanta-send-btn');
      let villageCount = 0;
      let allocPop = 0;
      if (allocRow !== null && sendBtn !== null) {
        villageCount = allocation.filter((a) => active.some(({ unit }) => (a[unit] ?? 0) > 0)).length;

        const labelCell = allocRow.querySelector('#vanta-alloc-label');
        if (labelCell !== null) {
          labelCell.innerHTML = `Alocado<br><span style="color:#555;font-size:9px;letter-spacing:0">${villageCount} aldeias</span>`;
        }

        let totalSendPop = 0;
        active.forEach(({ unit }) => {
          const total = allocation.reduce((s, a) => s + (a[unit] ?? 0), 0);
          const cell = allocRow.querySelector<HTMLElement>(`#vanta-alloc-${unit}`);
          if (cell !== null) {
            cell.innerHTML = `${fmtK(total)} <span class="vanta-k">k</span>`;
            cell.style.color = total === (sendAmounts[unit] ?? 0) ? '#3f8f43' : '#c04038';
          }
          allocPop += total * (UNIT_POP[unit] ?? 0);
          totalSendPop += (sendAmounts[unit] ?? 0) * (UNIT_POP[unit] ?? 0);
        });
        const popCell = allocRow.querySelector<HTMLElement>('#vanta-alloc-pop');
        if (popCell !== null) {
          popCell.innerHTML = `${fmtK(allocPop)} <span class="vanta-k">k</span>`;
          popCell.style.color = allocPop === totalSendPop ? '#3f8f43' : '#c04038';
        }
        allocRow.style.display = '';
        sendBtn.style.display = '';
        sendBtn.disabled = true;
        const coordText = (coordInput?.value ?? '').trim();
        // P2: confirmação antes do envio destrutivo
        sendBtn.onclick = () => {
          const ok = window.confirm(
            `Enviar tropas de apoio para ${coordText}: ${Math.round(allocPop)} pop em ${villageCount} aldeia(s). Confirmar?`,
          );
          if (!ok) return;
          document.getElementById('place_call_form_submit')?.click();
        };
      }

      // Preenche os inputs nativos de cada linha .call-village
      // (padrão do name: call[VILLAGE_ID][unit]; o checkbox da linha precisa
      // estar marcado antes para habilitar os inputs)
      let pending = 0;
      const onFillDone = (): void => {
        pending -= 1;
        if (pending === 0 && sendBtn !== null) sendBtn.disabled = false;
      };

      villageData.forEach(({ tr }, i) => {
        const alloc = allocation[i];
        if (alloc === undefined) return;
        const hasAlloc = active.some(({ unit }) => (alloc[unit] ?? 0) > 0);
        const checkbox = tr.querySelector<HTMLInputElement>('input[type="checkbox"]');

        const fillInputs = (): void => {
          active.forEach(({ unit }) => {
            const amount = alloc[unit] ?? 0;
            const input = tr.querySelector<HTMLInputElement>(`input[name$="][${unit}]"]`);
            if (input === null) return;
            input.value = String(amount);
            input.dispatchEvent(new Event('change', { bubbles: true }));
          });
          onFillDone();
        };

        pending += 1;
        if (checkbox !== null && hasAlloc && !checkbox.checked) {
          checkbox.click();
          // Um tick para o JS do jogo habilitar os inputs
          sc.after(fillInputs, 5);
        } else if (checkbox !== null && !hasAlloc && checkbox.checked) {
          // Desmarca explicitamente aldeias filtradas para o jogo não enviá-las
          checkbox.click();
          fillInputs();
        } else {
          fillInputs();
        }
      });
    }

    // ── Orquestração ────────────────────────────────────────────────────
    const ui = scope.owns(buildApoioUI());
    h3.insertAdjacentElement('afterend', ui);
    setupApoioControls(scope, ui);

    // Calcular Tropas — preenche o alvo e clica no village-item gerado
    let activeVillageObserver: MutationObserver | null = null;
    const calcBtn = ui.querySelector<HTMLButtonElement>('#vanta-apoio-calc-btn');
    if (calcBtn !== null) {
      scope.on(calcBtn, 'click', () => {
        const coord = (coordInput?.value ?? '').trim();
        if (coordInput !== null && !COORD_RE.test(coord)) {
          coordInput.focus();
          return;
        }

        // Garante grupo correto e page=-1 (todas as aldeias visíveis)
        const p = new URLSearchParams(window.location.search);
        const urlGroup = p.get('group') ?? '0';
        const urlPage = p.get('page');
        const wantGroup = groupSelect?.value || '0';
        if (urlGroup !== wantGroup || urlPage !== '-1') {
          p.set('group', wantGroup);
          p.set('page', '-1');
          window.location.replace('?' + p.toString());
          return;
        }

        const targetContainer = document.getElementById('place_target');
        if (targetContainer === null) return;

        buildTroopTable(scope, ui);

        // Aldeia já selecionada com a mesma coordenada? Não refaz
        const existingItem = targetContainer.querySelector<HTMLElement>('.village-item');
        if (existingItem !== null) {
          const existingName = existingItem.querySelector('.village-name')?.textContent ?? '';
          if (existingName.includes(`(${coord})`)) return;
          existingItem.remove();
        }

        const targetField = targetContainer.querySelector<HTMLInputElement>('input.target-input-field');
        if (targetField === null) return;

        // Desconecta observer anterior antes de criar um novo
        if (activeVillageObserver !== null) {
          activeVillageObserver.disconnect();
          activeVillageObserver = null;
        }

        // Aguarda o TW criar o .village-item e clica nele
        const obs = new MutationObserver(() => {
          const villageItem = targetContainer.querySelector<HTMLElement>('.village-item');
          if (villageItem !== null) {
            if (activeVillageObserver !== null) {
              activeVillageObserver.disconnect();
              activeVillageObserver = null;
            }
            villageItem.click();
          }
        });
        activeVillageObserver = scope.observer(obs);
        obs.observe(targetContainer, { childList: true, subtree: true });

        // Mostra, foca e preenche o input
        targetField.style.display = '';
        targetField.focus();
        targetField.value = coord;
        targetField.dispatchEvent(new Event('input', { bubbles: true }));
        targetField.dispatchEvent(new Event('change', { bubbles: true }));

        // Aguarda o autocomplete processar antes de enviar Enter
        scope.after(() => {
          const keyInit = { key: 'Enter', keyCode: 13, bubbles: true } as KeyboardEventInit;
          targetField.dispatchEvent(new KeyboardEvent('keydown', keyInit));
          targetField.dispatchEvent(new KeyboardEvent('keypress', keyInit));
          targetField.dispatchEvent(new KeyboardEvent('keyup', keyInit));
        }, 300);

        // Timeout de segurança do observer
        scope.after(() => {
          if (activeVillageObserver !== null) {
            activeVillageObserver.disconnect();
            activeVillageObserver = null;
          }
        }, 5000);
      });
    }
  },
});
