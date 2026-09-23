// Saúde do Stack (port do TW Vanta, linhas 5388-5829): widget na tela overview
// que simula o stack (tropas da aldeia + apoios que chegam ANTES do 1º ataque)
// contra um clear padrão no simulador do jogo, aplicando bônus/bandeira lidos
// da própria página, e mostra OK / Checar Blind / NOK conforme a folga de
// fulls (overblind).
// Correções/adaptações da porta:
// - P1-5: simulação UNIFICADA via ./tw-sim (runSimulator + parseDefenseEffects,
//   com def_benefits, def_flag e o caso "mais de 100") — nenhuma cópia local de
//   buildSimUrl/parseSimResult.
// - P1-2: números pt-BR do DOM lidos com parsePtBrInt (gatherTroops, #support_sum,
//   endtimes) em vez de parseInt cru.
// - P1-4: listeners via ModuleScope; widget registrado com scope.owns.
// - Rede: info_village via pacedDoc e detalhes de comando via pacedGet+JSON.parse
//   (GET same-origin; a fila global já pacinga ≥200ms). O delay extra de 100ms
//   do original (linha 5507) foi REMOVIDO — o pacing global já cobre.
// - Storage gm com chaves tsh-vanta:stackhealth:* (mesmos defaults do original).

import { gm } from '../../core/storage';
import type { ModuleScope } from './vanta-lifecycle';
import { gameData, pacedDoc, pacedGet } from './vanta-net';
import { registerVanta } from './vanta-registry';
import { ensureVantaStyles } from './vanta-styles';
import { parseDefenseEffects, runSimulator } from './tw-sim';
import { escAttr, parseNumLoose, parsePtBrInt } from './vanta-utils';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

const KEY_CLEAR = 'tsh-vanta:stackhealth:clear';
const KEY_MULTIPLIERS = 'tsh-vanta:stackhealth:multipliers';
const KEY_THRESHOLDS = 'tsh-vanta:stackhealth:thresholds';
const KEY_OFFBOOSTS = 'tsh-vanta:stackhealth:offboosts';
const KEY_ATTFLAG = 'tsh-vanta:stackhealth:attflag';

// Composição padrão do clear (idêntica ao original, linha 5398).
const DEFAULT_CLEAR: Record<string, number> = {
  spear: 0,
  sword: 0,
  axe: 7000,
  archer: 0,
  spy: 50,
  light: 2800,
  marcher: 100,
  heavy: 0,
  ram: 350,
  catapult: 10,
};
const DEFAULT_MULTIPLIERS: Record<string, number> = { small: 0.1, medium: 0.5, large: 1.0, unknown: 1.0 };
const DEFAULT_THRESHOLDS: Record<string, number> = { ok: 5, check: 2 };
const DEFAULT_OFF_BOOSTS: Record<string, number> = { axe: 8, light: 8, marcher: 8 };
const DEFAULT_ATT_FLAG = -1;

const TROOP_UNITS = [
  'spear',
  'sword',
  'axe',
  'archer',
  'spy',
  'light',
  'marcher',
  'heavy',
  'ram',
  'catapult',
  'knight',
  'snob',
] as const;

const IMG_BASE = 'graphic/command/';

interface IncomingCounts {
  small: number;
  medium: number;
  large: number;
  unknown: number;
  nobles: number;
}

interface HealthStatus {
  clears: number;
  surplus: string;
  status: string;
  cssClass: string;
  incomingClears: string;
  incomings: IncomingCounts;
}

/** game_data.units como string[] (cast defensivo — P1-5 exige filtrar boosts). */
function toWorldUnits(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((u) => String(u));
  if (typeof raw === 'object' && raw !== null) return Object.keys(raw);
  return [];
}

/** Contagem de uma unidade no JSON do ajax details (number ou {count}). */
function commandUnitCount(info: unknown): number {
  if (typeof info === 'number') return Math.trunc(info);
  if (info !== null && typeof info === 'object' && 'count' in info) {
    return parsePtBrInt(String((info as { count?: unknown }).count ?? ''));
  }
  return parsePtBrInt(String(info ?? ''));
}

registerVanta({
  id: 'vanta-stackhealth',
  label: 'Saúde do Stack',
  icon: 'activity',
  desc: 'Simula o stack contra um clear padrão e mostra OK/Checar/NOK',
  group: 'defesa',
  match: () => params().get('screen') === 'overview',
  url: () => '/game.php?screen=overview',
  mount(scope: ModuleScope): void {
    ensureVantaStyles();
    if (document.getElementById('vanta-stackhealth-widget') !== null) return;

    const gd = gameData();
    const village = gd.village as { id?: unknown; buildings?: Record<string, unknown> } | undefined;
    if (village === undefined) return; // sem game_data não há como simular
    const villageId = String(village.id ?? '');
    // Número interno do jogo (não texto pt-BR do DOM): parseInt cru —
    // parsePtBrInt removeria espaços e colaria dígitos ("20 3" → 203).
    const wall = parseInt(String(village.buildings?.wall ?? ''), 10) || 0;
    const worldUnits = toWorldUnits(gd.units);

    // Estado persistido (merge com defaults — chaves novas não zombam a UI).
    const clearData: Record<string, number> = { ...DEFAULT_CLEAR, ...gm.get<Record<string, number>>(KEY_CLEAR, {}) };
    const multipliers: Record<string, number> = {
      ...DEFAULT_MULTIPLIERS,
      ...gm.get<Record<string, number>>(KEY_MULTIPLIERS, {}),
    };
    const thresholds: Record<string, number> = {
      ...DEFAULT_THRESHOLDS,
      ...gm.get<Record<string, number>>(KEY_THRESHOLDS, {}),
    };
    const offBoosts: Record<string, number> = {
      ...DEFAULT_OFF_BOOSTS,
      ...gm.get<Record<string, number>>(KEY_OFFBOOSTS, {}),
    };
    let attFlag = gm.get<number>(KEY_ATTFLAG, DEFAULT_ATT_FLAG);
    if (!Number.isFinite(attFlag)) attFlag = DEFAULT_ATT_FLAG;

    const mult = (size: string): number => multipliers[size] ?? 0;
    const thresh = (k: string): number => thresholds[k] ?? 0;

    function zeroTroops(): Record<string, number> {
      const t: Record<string, number> = {};
      TROOP_UNITS.forEach((u) => {
        t[u] = 0;
      });
      return t;
    }

    // Tropas presentes na aldeia, lidas do overview (`.all_unit [data-count]`).
    function gatherTroops(): Record<string, number> {
      const troops = zeroTroops();
      document.querySelectorAll('.all_unit [data-count]').forEach((el) => {
        const unit = el.getAttribute('data-count');
        if (unit !== null && troops[unit] !== undefined) troops[unit] += parsePtBrInt(el.textContent);
      });
      return troops;
    }

    // Apoios chegando antes do 1º ataque (porta do original 5430-5521, com
    // pacedDoc/pacedGet e sem o delay extra de 100ms da linha 5507).
    async function fetchIncomingSupport(): Promise<Record<string, number>> {
      const zero = zeroTroops();
      try {
        const doc = await pacedDoc(`/game.php?village=${villageId}&screen=info_village&id=${villageId}`, {
          fresh: true, // "Salvar e Recalcular" precisa dos apoios AGORA (P3 revisão Onda 2)
        });

        const supportSum = doc.querySelector('#support_sum');
        if (supportSum === null) return zero;

        const totalSupport = zeroTroops();
        supportSum.querySelectorAll('td[data-unit]').forEach((td) => {
          const unit = td.getAttribute('data-unit');
          if (unit !== null && totalSupport[unit] !== undefined) totalSupport[unit] += parsePtBrInt(td.textContent);
        });
        const hasAnySupport = TROOP_UNITS.some((u) => (totalSupport[u] ?? 0) > 0);
        if (!hasAnySupport) return zero;

        const rows = doc.querySelectorAll('#commands_incomings .command-row.no_ignored_command');
        if (rows.length === 0) return totalSupport;

        const supports: Array<{ endtime: number; cmdId: string | null }> = [];
        let firstAttackTime = Number.POSITIVE_INFINITY;

        rows.forEach((row) => {
          const endtimeSpan = row.querySelector('[data-endtime]');
          const endtime = endtimeSpan !== null ? parsePtBrInt(endtimeSpan.getAttribute('data-endtime')) : 0;
          const isSupport =
            row.querySelector('[data-command-type="support"]') !== null || row.querySelector('img[src*="support"]') !== null;
          const isAttack = row.querySelector('img[src*="attack"]') !== null;

          if (isAttack && endtime < firstAttackTime) firstAttackTime = endtime;
          if (isSupport && endtime > 0) {
            const cmdSpan = row.querySelector('[data-command-id]');
            supports.push({ endtime, cmdId: cmdSpan?.getAttribute('data-command-id') ?? null });
          }
        });

        // Sem ataques → todo apoio chega a tempo.
        if (firstAttackTime === Number.POSITIVE_INFINITY) return totalSupport;

        const beforeAttack = supports.filter((s) => s.endtime < firstAttackTime);
        const afterAttack = supports.filter((s) => s.endtime >= firstAttackTime);

        if (afterAttack.length === 0) return totalSupport; // todos antes do 1º ataque
        if (beforeAttack.length === 0) return zero; // nenhum antes → não conta

        // Misto — busca o MENOR conjunto e deriva o outro por diferença.
        const fetchBefore = beforeAttack.length <= afterAttack.length;
        const toFetch = fetchBefore ? beforeAttack : afterAttack;

        const fetchedTroops = zeroTroops();
        for (const cmd of toFetch) {
          if (cmd.cmdId === null) continue;
          try {
            const body = await pacedGet(
              `/game.php?village=${villageId}&screen=info_command&ajax=details&id=${cmd.cmdId}`,
            );
            const json = JSON.parse(body) as { units?: unknown; response?: { units?: unknown } };
            const units = (json.units ?? json.response?.units ?? {}) as Record<string, unknown>;
            Object.entries(units).forEach(([unit, info]) => {
              if (fetchedTroops[unit] === undefined) return;
              fetchedTroops[unit] += commandUnitCount(info);
            });
          } catch {
            /* pula comando que falhou */
          }
        }

        if (fetchBefore) return fetchedTroops;
        const result = zeroTroops();
        TROOP_UNITS.forEach((u) => {
          result[u] = Math.max(0, (totalSupport[u] ?? 0) - (fetchedTroops[u] ?? 0));
        });
        return result;
      } catch {
        return zero;
      }
    }

    // Incoming attacks por tamanho (porta do original 5524-5537).
    function countIncomings(): IncomingCounts {
      const counts: IncomingCounts = { small: 0, medium: 0, large: 0, unknown: 0, nobles: 0 };
      const commandsTable = document.getElementById('commands_incomings');
      if (commandsTable === null) return counts;
      commandsTable.querySelectorAll('.command-row.no_ignored_command').forEach((row) => {
        if (row.querySelector('img[src*="support"]') !== null) return;
        if (row.querySelector('img[src*="attack_small"]') !== null) counts.small++;
        else if (row.querySelector('img[src*="attack_medium"]') !== null) counts.medium++;
        else if (row.querySelector('img[src*="attack_large"]') !== null) counts.large++;
        else if (row.querySelector('img[src*="attack"]') !== null) counts.unknown++;
        if (row.querySelector('img[src*="snob"]') !== null) counts.nobles++;
      });
      return counts;
    }

    // Status de saúde (porta do original 5647-5662).
    function calcHealth(clears: number, incomings: IncomingCounts): HealthStatus {
      const incomingClears =
        incomings.small * mult('small') +
        incomings.medium * mult('medium') +
        incomings.large * mult('large') +
        incomings.unknown * mult('unknown');
      const surplus = clears - incomingClears;

      let status: string;
      let cssClass: string;
      if (surplus >= thresh('ok')) {
        status = 'OK';
        cssClass = 'vanta-sh-ok';
      } else if (surplus >= thresh('check')) {
        status = 'Checar Blind';
        cssClass = 'vanta-sh-check';
      } else {
        status = 'NOK';
        cssClass = 'vanta-sh-nok';
      }

      return {
        clears,
        surplus: surplus.toFixed(1),
        status,
        cssClass,
        incomingClears: incomingClears.toFixed(1),
        incomings,
      };
    }

    // Widget (porta do original 5665-5716 — mesmos ids/classes do CSS injetado).
    const widget = document.createElement('div');
    widget.id = 'vanta-stackhealth-widget';
    widget.className = 'vis moveable widget';
    widget.innerHTML = `
            <h4 class="head with-button">Saúde do Stack: <span class="vanta-sh-loading">carregando...</span></h4>
            <div class="widget_content" style="display:block">
                <table style="width:100%"><tbody id="vanta-sh-body">
                    <tr><td class="vanta-sh-loading">Calculando...</td></tr>
                </tbody></table>
                <div style="margin-top:4px">
                    <a id="vanta-sh-settings-toggle" href="#" style="font-size:10px">Configurações ▶</a>
                </div>
                <div id="vanta-stackhealth-settings" style="display:none">
                    <table class="vis" width="100%"><tbody>
                        <tr><th colspan="2">Composição do Clear</th></tr>
                        ${Object.keys(DEFAULT_CLEAR)
                          .map(
                            (u) => `
                            <tr>
                                <td><img src="graphic/unit/unit_${u}.png" style="vertical-align:middle"> ${u}</td>
                                <td><input type="number" class="vanta-sh-clear" data-unit="${u}" value="${clearData[u] ?? 0}" min="0"></td>
                            </tr>`,
                          )
                          .join('')}
                        <tr><th colspan="2">Bônus Ofensivos (%)</th></tr>
                        ${Object.keys(DEFAULT_OFF_BOOSTS)
                          .map(
                            (u) => `
                            <tr>
                                <td><img src="graphic/unit/unit_${u}.png" style="vertical-align:middle"> ${u}</td>
                                <td><input type="number" class="vanta-sh-offboost" data-unit="${u}" value="${offBoosts[u] ?? 0}" min="0" max="100">%</td>
                            </tr>`,
                          )
                          .join('')}
                        <tr><th colspan="2">Bandeira de Ataque</th></tr>
                        <tr>
                            <td>Nível</td>
                            <td>
                                <select id="vanta-sh-attflag">
                                    <option value="-1" ${attFlag < 0 ? 'selected' : ''}>Nenhuma</option>
                                    ${[...Array(10)]
                                      .map((_, i) => `<option value="${i}" ${attFlag === i ? 'selected' : ''}>+${i + 1}% ataque</option>`)
                                      .join('')}
                                </select>
                            </td>
                        </tr>
                        <tr><th colspan="2">Multiplicadores de Ataque</th></tr>
                        ${Object.keys(DEFAULT_MULTIPLIERS)
                          .map(
                            (s) => `
                            <tr>
                                <td><img src="${IMG_BASE}attack${s === 'unknown' ? '' : '_' + s}.webp" style="vertical-align:-2px"> ${s}</td>
                                <td><input type="number" class="vanta-sh-mult" data-size="${s}" value="${multipliers[s] ?? 0}" min="0" max="5" step="0.1"></td>
                            </tr>`,
                          )
                          .join('')}
                        <tr><th colspan="2">Limites de Status (fulls de overblind)</th></tr>
                        <tr><td class="vanta-sh-ok">OK ≥</td><td><input type="number" id="vanta-sh-threshold-ok" value="${thresh('ok')}" min="0"></td></tr>
                        <tr><td class="vanta-sh-check">Checar ≥</td><td><input type="number" id="vanta-sh-threshold-check" value="${thresh('check')}" min="0"></td></tr>
                        <tr><td colspan="2"><input type="button" class="btn" id="vanta-sh-save" value="Salvar e Recalcular"></td></tr>
                    </tbody></table>
                </div>
            </div>`;

    // Insere depois da fila de construções (porta do original 5718-5726).
    const buildQueue = document.getElementById('show_buildqueue');
    if (buildQueue !== null) {
      buildQueue.after(widget);
    } else {
      const rightCol: HTMLElement | null =
        document.getElementById('rightcolumn') ?? document.querySelector('.modemenu')?.parentElement ?? null;
      if (rightCol === null) return;
      rightCol.prepend(widget);
    }
    scope.owns(widget);

    const toggleLink = document.getElementById('vanta-sh-settings-toggle');
    const settingsBox = document.getElementById('vanta-stackhealth-settings');
    const headerSpanEl = widget.querySelector('h4 span');
    const bodyElEl = document.getElementById('vanta-sh-body');
    const saveBtn = document.getElementById('vanta-sh-save');
    if (
      toggleLink === null ||
      settingsBox === null ||
      headerSpanEl === null ||
      bodyElEl === null ||
      saveBtn === null
    ) {
      return;
    }
    // Consts já estreitadas — o narrowing precisa valer dentro das closures.
    const headerSpan: Element = headerSpanEl;
    const bodyEl: HTMLElement = bodyElEl;

    scope.on(toggleLink, 'click', (e) => {
      e.preventDefault();
      const visible = settingsBox.style.display !== 'none';
      settingsBox.style.display = visible ? 'none' : '';
      toggleLink.textContent = `Configurações ${visible ? '▶' : '▼'}`;
    });

    // Cálculo (porta do original 5738-5790, agora via runSimulator do ./tw-sim).
    async function calculate(): Promise<void> {
      const troops = gatherTroops();
      const incomingSupport = await fetchIncomingSupport();
      TROOP_UNITS.forEach((u) => {
        troops[u] = (troops[u] ?? 0) + (incomingSupport[u] ?? 0);
      });
      const incomings = countIncomings();
      const { defBenefits, defFlag } = parseDefenseEffects(document);

      try {
        const sim = await runSimulator({
          villageId,
          troops,
          wall,
          clear: clearData,
          offBoosts,
          attFlag,
          defBenefits,
          defFlag,
          worldUnits,
        });
        const health = calcHealth(sim.result.clears, incomings);

        headerSpan.className = health.cssClass;
        headerSpan.textContent = health.status;

        const sIcon = (s: string): string =>
          `<img src="${IMG_BASE}attack${s === 'unknown' ? '' : '_' + s}.webp" style="vertical-align:-2px">`;
        const anyIncoming = incomings.small + incomings.medium + incomings.large + incomings.unknown;

        bodyEl.innerHTML = `
                    <tr>
                        <td>Stack:</td>
                        <td><strong>${sim.result.over100 ? 'mais de 100' : health.clears}</strong> full(s)</td>
                    </tr>
                    <tr>
                        <td><strong>#1</strong> <img src="graphic/unit/unit_ram.png" style="vertical-align:-2px"></td>
                        <td><img src="graphic/buildings/wall.png" style="vertical-align:-2px"> <strong>${wall}</strong> → <strong class="${health.cssClass}">${sim.result.postWall}</strong></td>
                    </tr>
                    ${anyIncoming > 0 ? `
                    <tr>
                        <td>Incomings:</td>
                        <td>
                            <strong>${health.incomingClears}</strong> fulls
                            ${sIcon('small')} <strong>${incomings.small}</strong>
                            ${sIcon('medium')} <strong>${incomings.medium}</strong>
                            ${sIcon('large')} <strong>${incomings.large}</strong>
                            ${sIcon('unknown')} <strong>${incomings.unknown}</strong>
                        </td>
                    </tr>
                    <tr>
                        <td>Overblind:</td>
                        <td><strong class="${health.cssClass}">${health.surplus}</strong> fulls</td>
                    </tr>` : ''}
                    ${incomings.nobles > 0 ? `<tr><td>Nobres:</td><td><strong>${incomings.nobles}</strong></td></tr>` : ''}
                    <tr><td colspan="2"><small><a href="${escAttr(sim.url)}" target="_blank">Resultados do Simulador</a></small></td></tr>`;
      } catch {
        headerSpan.className = 'vanta-sh-nok';
        headerSpan.textContent = 'Erro';
        bodyEl.innerHTML = '<tr><td style="color:#c04038">Erro ao carregar simulador</td></tr>';
      }
    }

    void calculate();

    // Salvar configurações e recalcular (porta do original 5795-5828).
    scope.on(saveBtn, 'click', () => {
      const newClear: Record<string, number> = {};
      widget.querySelectorAll('.vanta-sh-clear').forEach((el) => {
        if (el instanceof HTMLInputElement && el.dataset.unit !== undefined) newClear[el.dataset.unit] = parsePtBrInt(el.value);
      });
      const newMult: Record<string, number> = {};
      widget.querySelectorAll('.vanta-sh-mult').forEach((el) => {
        if (el instanceof HTMLInputElement && el.dataset.size !== undefined) newMult[el.dataset.size] = parseNumLoose(el.value);
      });
      const okInput = document.getElementById('vanta-sh-threshold-ok');
      const checkInput = document.getElementById('vanta-sh-threshold-check');
      const newThresh = {
        ok: (okInput instanceof HTMLInputElement ? parsePtBrInt(okInput.value) : 0) || 5,
        check: (checkInput instanceof HTMLInputElement ? parsePtBrInt(checkInput.value) : 0) || 2,
      };
      const newOffBoosts: Record<string, number> = {};
      widget.querySelectorAll('.vanta-sh-offboost').forEach((el) => {
        if (el instanceof HTMLInputElement && el.dataset.unit !== undefined) newOffBoosts[el.dataset.unit] = parsePtBrInt(el.value);
      });
      const attSelect = document.getElementById('vanta-sh-attflag');
      const newAttFlag = attSelect instanceof HTMLSelectElement ? parsePtBrInt(attSelect.value) : DEFAULT_ATT_FLAG;

      gm.set(KEY_CLEAR, newClear);
      gm.set(KEY_MULTIPLIERS, newMult);
      gm.set(KEY_THRESHOLDS, newThresh);
      gm.set(KEY_OFFBOOSTS, newOffBoosts);
      gm.set(KEY_ATTFLAG, newAttFlag);

      Object.assign(clearData, newClear);
      Object.assign(multipliers, newMult);
      Object.assign(thresholds, newThresh);
      Object.assign(offBoosts, newOffBoosts);
      attFlag = newAttFlag;
      void calculate();
    });
  },
});
