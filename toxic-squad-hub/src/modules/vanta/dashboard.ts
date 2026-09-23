// Painel de Incomings + Cores de Incomings — port do TW Vanta (linhas
// 4384-5384 do original) para o Toxic Squad Hub. Correções da auditoria:
// - P1-1 XSS: nome de jogador, nome de aldeia, rótulo de comando, dia e
//   href/ids em atributo são escapados (escapeHtml/escAttr). O original
//   injetava cru (linhas 4499, 4570, 4620, 4645-4650).
// - P1-2: números do DOM do jogo lidos com parsePtBrInt (nunca parseInt cru).
// - P1-4 interval leak: setInterval(updateCountdowns, 1000) → scope.every.
//   O rebind ajaxComplete REMONTA o módulo (mountVanta descarta o escopo
//   antigo — o dispose mata o interval antigo, é assim que o leak morre).
// - P1-5: "Buscar Tropas" usa o sim unificado runSimulator (tw-sim) com
//   defBenefits/defFlag REAIS lidos da overview da aldeia (parseDefenseEffects)
//   e worldUnits de game_data.units — o original mandava def_benefits='[]'.
// - P2: "Buscar Todas Tropas" encadeia a Promise de cada aldeia via
//   buscarTropas(btn, villageId) (o original polava o valor do botão a cada
//   200ms com um setInterval solto).
// - P3: ícones via caminho relativo 'graphic/command/' (o original prendia a
//   um hash de CDN que quebra a cada deploy).

import { gm } from '../../core/storage';
import { pageWindow } from '../../core/page';
import { escapeHtml, escAttr, parsePtBrInt, parseCountdown, fmtLead, UNITS } from './vanta-utils';
import { pacedDoc, pacedGet, renameCommand, gameData } from './vanta-net';
import { registerVanta, mountVanta, isVantaEnabled } from './vanta-registry';
import type { ModuleScope } from './vanta-lifecycle';
import { ensureVantaStyles } from './vanta-styles';
import { runSimulator, parseDefenseEffects } from './tw-sim';
import { RENOMEADOR_TAGS, buildTaggedText, type RenomeadorTag } from './renomeador-tags';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

type AttackSize = 'small' | 'medium' | 'large' | 'unknown';

/** Caminho relativo do jogo p/ ícones de comando (P3 — sem CDN fixa). */
const IMG_BASE = 'graphic/command/';

const COORD_RE = /\d{1,3}\|\d{1,3}/;

/** Uma linha da tabela #incomings_table (um comando de ataque). */
interface IncomingRow {
  row: HTMLTableRowElement;
  size: AttackSize;
  hasNoble: boolean;
  isTagged: boolean;
  matchedTag: RenomeadorTag | null;
  player: string;
  dayKey: string;
  labelText: string;
  targetCoord: string | null;
  sourceCoord: string | null;
  targetName: string;
  targetHref: string;
  targetVillageId: string;
  commandId: string;
  arrivalFull: string;
  chegaEmText: string;
  torreText: string;
}

/** Aldeia-alvo agrupando seus comandos (seção "Comandos por Aldeia"). */
interface VillageEntry {
  name: string;
  href: string;
  id: string;
  commands: IncomingRow[];
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

// ─── jQuery do jogo p/ ajaxComplete namespaced (única exceção de bind cru) ──

type AjaxCompleteHandler = (event: unknown, xhr: unknown, settings?: { url?: string }) => void;

interface JQueryCollection {
  off(eventName: string): JQueryCollection;
  on(eventName: string, handler: AjaxCompleteHandler): JQueryCollection;
}

function gameJQuery(): ((target: Document) => JQueryCollection) | undefined {
  return (pageWindow() as { jQuery?: (target: Document) => JQueryCollection }).jQuery;
}

/**
 * Rebind ajaxComplete namespaced: atualização parcial da tabela → REMONTA o
 * módulo (mountVanta dispõe o escopo antigo e cria um novo — timers,
 * listeners e observers velhos morrem junto, P1-4).
 */
function rebindAjaxRemount(namespace: string, moduleId: string): void {
  const jq = gameJQuery();
  if (jq === undefined) return;
  jq(document)
    .off(`ajaxComplete.${namespace}`)
    .on(`ajaxComplete.${namespace}`, (_event, _xhr, settings) => {
      const url = settings?.url;
      if (typeof url === 'string' && url.includes('partial') && isVantaEnabled(moduleId)) {
        mountVanta(moduleId);
      }
    });
}

// ─── Painel de Incomings ───────────────────────────────────────────────────

function scanRows(table: HTMLTableElement): IncomingRow[] {
  const data: IncomingRow[] = [];
  table.querySelectorAll<HTMLTableRowElement>('tr.nowrap').forEach((row) => {
    const tds = row.querySelectorAll('td');
    if (tds.length < 6) return;

    // Tamanho do ataque
    let size: AttackSize = 'unknown';
    if (row.querySelector('img[src*="attack_small"]') !== null) size = 'small';
    else if (row.querySelector('img[src*="attack_medium"]') !== null) size = 'medium';
    else if (row.querySelector('img[src*="attack_large"]') !== null) size = 'large';

    const hasNoble = row.querySelector('img[src*="snob"]') !== null;

    // Status de tag (tag mais à direita no rótulo)
    const labelEl = row.querySelector('.quickedit-label');
    const labelText = (labelEl?.textContent ?? '').trim();
    let matchedTag: RenomeadorTag | null = null;
    let bestPos = -1;
    for (const tag of RENOMEADOR_TAGS) {
      if (tag.label === '') continue;
      const pos = labelText.lastIndexOf(tag.label);
      if (pos > bestPos) {
        bestPos = pos;
        matchedTag = tag;
      }
    }
    const isTagged = bestPos >= 0;

    // Jogador atacante
    const playerLink = tds[3]?.querySelector('a[href*="info_player"]') ?? null;
    const player = playerLink !== null ? (playerLink.textContent ?? '').trim() : '???';

    // Coordenadas origem/destino
    const targetMatch = tds[1]?.textContent?.match(COORD_RE) ?? null;
    const sourceMatch = tds[2]?.textContent?.match(COORD_RE) ?? null;

    // Dia de chegada ("hoje" / "amanhã" / dd.mm)
    const arrText = (tds[5]?.textContent ?? '').trim();
    let dayKey = '';
    if (arrText.includes('hoje')) dayKey = 'hoje';
    else if (arrText.includes('amanhã')) dayKey = 'amanhã';
    else {
      const dm = arrText.match(/\d{1,2}\.\d{1,2}/);
      if (dm !== null) dayKey = dm[0] ?? '';
    }

    // Aldeia-alvo
    const targetLink = tds[1]?.querySelector('a') ?? null;
    const targetName = targetLink !== null ? (targetLink.textContent ?? '').trim() : '';
    const targetHref = targetLink?.getAttribute('href') ?? '';
    const targetVillageId = targetHref.match(/village=(\d+)/)?.[1] ?? '';

    // Comando
    const qeSpan = row.querySelector('span.quickedit[data-id]');
    const commandId = qeSpan?.getAttribute('data-id') ?? '';

    const arrivalFull = (tds[5]?.textContent ?? '').trim();
    const chegaEmText = (tds[6]?.textContent ?? '').trim();
    const torreText = (tds[7]?.textContent ?? '').trim();

    data.push({
      row,
      size,
      hasNoble,
      isTagged,
      matchedTag,
      player,
      dayKey,
      labelText,
      targetCoord: targetMatch?.[0] ?? null,
      sourceCoord: sourceMatch?.[0] ?? null,
      targetName,
      targetHref,
      targetVillageId,
      commandId,
      arrivalFull,
      chegaEmText,
      torreText,
    });
  });
  return data;
}

function pct(n: number, total: number): string {
  return total > 0 ? ((n / total) * 100).toFixed(1) : '0.0';
}

function buildDashboard(data: IncomingRow[]): string {
  const total = data.length;
  const bySize: Record<AttackSize, number> = { small: 0, medium: 0, large: 0, unknown: 0 };
  const nobles: Record<AttackSize, number> & { total: number } = { total: 0, small: 0, medium: 0, large: 0, unknown: 0 };
  let tagged = 0;
  let untagged = 0;
  const byTag: Record<string, number> = {};
  const players: Record<string, number> = {};
  const days: Record<string, number> = {};

  data.forEach((d) => {
    bySize[d.size]++;
    if (d.hasNoble) {
      nobles.total++;
      nobles[d.size]++;
    }
    if (d.isTagged) {
      tagged++;
      const tagLabel = d.matchedTag?.label ?? '?';
      byTag[tagLabel] = (byTag[tagLabel] ?? 0) + 1;
    } else {
      untagged++;
    }
    players[d.player] = (players[d.player] ?? 0) + 1;
    if (d.dayKey !== '') days[d.dayKey] = (days[d.dayKey] ?? 0) + 1;
  });

  const sortedPlayers = Object.entries(players).sort((a, b) => b[1] - a[1]);
  const sortedDays = Object.entries(days);

  const sIcon = (s: AttackSize): string =>
    `<img src="${IMG_BASE}attack${s === 'unknown' ? '' : '_' + s}.webp" style="vertical-align:-2px">`;
  const nIcon = `<img src="${IMG_BASE}snob.webp" style="vertical-align:-2px">`;

  // P1-1: valor do filtro vem de nome de jogador/tag/dia do DOM → escAttr.
  const fLink = (filter: string, value: string, text: string): string =>
    `<a class="vanta-dash-filter" data-filter="${escAttr(filter)}" data-value="${escAttr(value)}" style="cursor:pointer"><strong>${text}</strong></a>`;

  // Zebra: reset() reinicia em row_a
  let rc = 0;
  const rowClass = (): string => (rc++ % 2 === 0 ? 'row_a' : 'row_b');
  const resetRc = (): string => {
    rc = 0;
    return '';
  };

  return `<table width="100%" cellspacing="0" cellpadding="0"><tbody><tr>
                <td width="50%" valign="top">
                    <div class="vis spaced">
                        <h4 class="ui-sortable-handle">Resumo de Ataques</h4>
                        <table class="vis" width="100%"><tbody>
                            <tr>
                                <td width="40%"><strong><img src="${IMG_BASE}attack.webp" style="vertical-align:-2px"> Total</strong></td>
                                <td>${fLink('all', '', String(total))} <small><a class="vanta-dash-filter" data-filter="all" style="cursor:pointer">resetar</a></small></td>
                            </tr>
                            <tr><th width="25%">${sIcon('small')}</th><th width="25%">${sIcon('medium')}</th><th width="25%">${sIcon('large')}</th><th width="25%">${sIcon('unknown')}</th></tr>
                            <tr class="${rowClass()}">
                                ${(['small', 'medium', 'large', 'unknown'] as const)
                                  .map((s) => `<td>${fLink('size', s, String(bySize[s]))} <span style="color:#6f5e40">(${pct(bySize[s], total)}%)</span></td>`)
                                  .join('')}
                            </tr>
                            <tr><th colspan="4">Status de Tags</th></tr>
                            ${resetRc()}<tr class="${rowClass()}">
                                <td colspan="2" style="cursor:pointer" class="vanta-tag-breakdown-toggle">▶ Tageados</td>
                                <td colspan="2">${fLink('tagged', 'true', String(tagged))} <span style="color:#6f5e40">(${pct(tagged, total)}%)</span></td>
                            </tr>
                            ${Object.entries(byTag)
                              .sort((a, b) => b[1] - a[1])
                              .map(
                                ([label, count]) => `
                                <tr class="${rowClass()} vanta-tag-breakdown-row" style="display:none">
                                    <td colspan="2" style="padding-left:20px">${escapeHtml(label)}</td>
                                    <td colspan="2">${fLink('tag', label, String(count))} <span style="color:#6f5e40">(${pct(count, total)}%)</span></td>
                                </tr>`,
                              )
                              .join('')}
                            <tr class="${rowClass()}">
                                <td colspan="2">Sem Tag</td>
                                <td colspan="2">${fLink('tagged', 'false', String(untagged))} <span style="color:#6f5e40">(${pct(untagged, total)}%)</span></td>
                            </tr>
                            <tr><th colspan="4">Por Dia</th></tr>
                            ${resetRc()}${sortedDays
                              .map(
                                ([day, count]) => `
                                <tr class="${rowClass()}">
                                    <td colspan="2">${escapeHtml(day)}</td>
                                    <td colspan="2">${fLink('day', day, String(count))} <span style="color:#6f5e40">(${pct(count, total)}%)</span></td>
                                </tr>`,
                              )
                              .join('')}
                        </tbody></table>
                    </div>
                </td>
                <td width="50%" valign="top">
                    <div class="vis spaced">
                        <h4 class="ui-sortable-handle">Resumo de Nobres</h4>
                        <table class="vis" width="100%"><tbody>
                            <tr>
                                <td>${nIcon} <strong>Total</strong></td>
                                <td colspan="4">${fLink('noble', '', String(nobles.total))}</td>
                            </tr>
                            <tr>
                                <th></th>
                                ${(['small', 'medium', 'large', 'unknown'] as const)
                                  .map((s) => `<th>${sIcon(s)} ${nIcon}</th>`)
                                  .join('')}
                            </tr>
                            ${resetRc()}<tr class="${rowClass()}">
                                <td></td>
                                ${(['small', 'medium', 'large', 'unknown'] as const)
                                  .map(
                                    (s) =>
                                      `<td>${nobles[s] > 0 ? fLink('noble-size', s, String(nobles[s])) + ` <span style="color:#6f5e40">(${pct(nobles[s], nobles.total)}%)</span>` : '-'}</td>`,
                                  )
                                  .join('')}
                            </tr>
                        </tbody></table>
                    </div>
                    <div class="vis spaced">
                        <h4 class="ui-sortable-handle">Por Jogador</h4>
                        <div class="vanta-dash-player-list">
                            <table class="vis" width="100%"><tbody>
                                ${resetRc()}${sortedPlayers
                                  .map(
                                    ([name, count]) => `
                                    <tr class="${rowClass()}">
                                        <td width="60%">${escapeHtml(name)}</td>
                                        <td>${fLink('player', name, String(count))} <span style="color:#6f5e40">(${pct(count, total)}%)</span></td>
                                    </tr>`,
                                  )
                                  .join('')}
                            </tbody></table>
                        </div>
                    </div>
                </td>
            </tr></tbody></table>
            `;
}

function buildVillageSection(table: HTMLTableElement, data: IncomingRow[]): string {
  // Agrupa por aldeia-alvo
  const byVillage: Record<string, VillageEntry> = {};
  data.forEach((d) => {
    if (d.targetVillageId === '') return;
    const key = d.targetVillageId;
    const entry = byVillage[key] ?? { name: d.targetName, href: d.targetHref, id: key, commands: [] };
    byVillage[key] = entry;
    entry.commands.push(d);
  });

  // Ordena por chegada mais cedo (posição do 1º comando na tabela original)
  const allRows = Array.from(table.querySelectorAll('tr.nowrap'));
  const villages = Object.values(byVillage).sort((a, b) => {
    const aRow = a.commands[0];
    const bRow = b.commands[0];
    if (aRow === undefined || bRow === undefined) return 0;
    return allRows.indexOf(aRow.row) - allRows.indexOf(bRow.row);
  });
  if (villages.length === 0) return '';

  // Divide em 2 colunas
  const mid = Math.ceil(villages.length / 2);
  const left = villages.slice(0, mid);
  const right = villages.slice(mid);

  function buildVillageTable(v: VillageEntry): string {
    let rc = 0;
    const rClass = (): string => (rc++ % 2 === 0 ? 'row_a' : 'row_b');
    const tagBtns = RENOMEADOR_TAGS.map(
      (tag) =>
        `<button type="button" class="btn vanta-village-tag-btn" data-tag-id="${escAttr(tag.id)}" style="color:${tag.textColor};font-size:8px !important;background:linear-gradient(to bottom,${tag.topGrad} 30%,${tag.botGrad} 10%)" title="${escAttr(tag.label)}">${escapeHtml(tag.abbrev)}</button>`,
    ).join('');

    return `
                    <div class="vis spaced" style="margin-bottom:6px">
                        <h4 class="ui-sortable-handle vanta-village-toggle" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer" data-village-id="${escAttr(v.id)}">
                            <span><span class="vanta-arrow">▼</span> <a href="${escAttr(v.href)}" onclick="event.stopPropagation()">${escapeHtml(v.name)}</a> — ${v.commands.length} comando${v.commands.length !== 1 ? 's' : ''}</span>
                            <span style="display:flex;align-items:center;gap:6px" onclick="event.stopPropagation()">
                                <span class="vanta-village-sh" data-village-id="${escAttr(v.id)}" style="font-size:10px"></span>
                                <input type="button" class="btn vanta-buscar-tropas" data-village-id="${escAttr(v.id)}" value="Buscar Tropas" style="font-size:9px;padding:1px 4px;margin:0">
                            </span>
                        </h4>
                        <div class="vanta-village-body" data-village-id="${escAttr(v.id)}">
                        <div class="vanta-troop-row" data-village-id="${escAttr(v.id)}" style="display:none">
                            <table class="vis" width="100%"><tbody>
                                <tr>${UNITS.map((u) => `<th style="text-align:center;width:${(100 / UNITS.length).toFixed(0)}%"><img src="graphic/unit/unit_${u}.png" style="vertical-align:middle" title="${u}"></th>`).join('')}</tr>
                                <tr>${UNITS.map((u) => `<td style="text-align:center" data-unit="${u}">-</td>`).join('')}</tr>
                            </tbody></table>
                        </div>
                        <table class="vis" width="100%"><tbody>
                            <tr><th>Comando</th><th width="25%">Chegada</th></tr>
                            ${v.commands
                              .map((cmd) => {
                                const textShadow = '-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000';
                                const cmdBg = cmd.matchedTag !== null ? cmd.matchedTag.topGrad : '#ff0000';
                                const cls = rClass();
                                const cmdIdAttr = escAttr(cmd.commandId);
                                return `
                                <tr class="${cls}" data-command-id="${cmdIdAttr}">
                                    <td style="background:${cmdBg} !important">
                                        ${cmd.size !== 'unknown' ? `<img src="${IMG_BASE}attack_${cmd.size}.webp" style="vertical-align:-2px">` : `<img src="${IMG_BASE}attack.webp" style="vertical-align:-2px">`}
                                        ${cmd.hasNoble ? `<img src="${IMG_BASE}snob.webp" style="vertical-align:-2px">` : ''}
                                        <span class="vanta-cmd-label" style="color:#fff;text-shadow:${textShadow}">${escapeHtml(cmd.labelText)}</span>
                                    </td>
                                    <td rowspan="2" style="vertical-align:middle;font-size:11px;line-height:1.5">
                                        ${escapeHtml(cmd.arrivalFull)}
                                        <br><span style="color:#6f5e40;font-size:10px">Duração: <span class="vanta-cmd-duracao" data-command-id="${cmdIdAttr}">${escapeHtml(cmd.chegaEmText || '--:--:--')}</span></span>
                                        ${cmd.torreText !== '' ? `<br><span style="color:#6f5e40;font-size:10px">Torre: <span class="vanta-cmd-torre" data-command-id="${cmdIdAttr}">${escapeHtml(cmd.torreText)}</span> <span class="vanta-cmd-lead" data-command-id="${cmdIdAttr}"></span></span>` : ''}
                                    </td>
                                </tr>
                                <tr class="${cls}" data-command-id="${cmdIdAttr}">
                                    <td style="white-space:nowrap;padding:1px 2px">${tagBtns}</td>
                                </tr>`;
                              })
                              .join('')}
                        </tbody></table>
                        </div>
                    </div>`;
  }

  const buildCol = (list: VillageEntry[]): string => list.map((v) => buildVillageTable(v)).join('');

  return `
                <div class="vis spaced" style="margin-top:6px">
                    <h4 class="ui-sortable-handle" id="vanta-village-section-toggle" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between">
                        <span><span class="vanta-arrow">▶</span> Comandos por Aldeia (${villages.length} aldeias)</span>
                        <span style="display:none" onclick="event.stopPropagation()">
                            <input type="button" class="btn" id="vanta-mark-duplicates" value="Marcar Duplicados" style="font-size:9px;padding:1px 4px;margin:0">
                            <input type="button" class="btn" id="vanta-fetch-all-troops" value="Buscar Todas Tropas" style="font-size:9px;padding:1px 4px;margin:0">
                            <input type="button" class="btn" id="vanta-village-sort-toggle" value="Ordenar por: Horário" style="font-size:9px;padding:1px 4px;margin:0">
                            <input type="button" class="btn" id="vanta-collapse-all-villages" value="Colapsar Todas" style="font-size:9px;padding:1px 4px;margin:0">
                        </span>
                    </h4>
                    <div id="vanta-village-section-body" style="display:none">
                        <table width="100%" cellspacing="0" cellpadding="0"><tbody><tr>
                            <td id="vanta-village-col-left" width="50%" valign="top">${buildCol(left)}</td>
                            <td id="vanta-village-col-right" width="50%" valign="top">${buildCol(right)}</td>
                        </tr></tbody></table>
                    </div>
                </div>`;
}

function matchesFilter(d: IncomingRow, filterType: string, filterValue: string): boolean {
  if (filterType === 'size') return d.size === filterValue;
  if (filterType === 'tagged') return String(d.isTagged) === filterValue;
  if (filterType === 'tag') return d.isTagged && d.matchedTag?.label === filterValue;
  if (filterType === 'noble') return d.hasNoble;
  if (filterType === 'noble-size') return d.hasNoble && d.size === filterValue;
  if (filterType === 'player') return d.player === filterValue;
  if (filterType === 'day') return d.dayKey === filterValue;
  return true;
}

/** game_data.units com cast defensivo → array de nomes de unidade (array OU objeto — par com o stack-health). */
function toWorldUnits(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((u) => String(u));
  if (typeof raw === 'object' && raw !== null) return Object.keys(raw);
  return [];
}

function mountDashboard(scope: ModuleScope): void {
  ensureVantaStyles();
  if (document.getElementById('vanta-dashboard') !== null) return; // idempotente

  const tableEl = document.getElementById('incomings_table');
  if (!(tableEl instanceof HTMLTableElement)) return;
  // const com tipo declarado: closures aninhadas veem HTMLTableElement
  const table: HTMLTableElement = tableEl;

  const container = document.createElement('div');
  container.id = 'vanta-dashboard';
  table.parentElement?.insertBefore(container, table);
  scope.owns(container);

  // Filtros ativos (OR multi-filtro): cada entrada é "filterType:filterValue"
  const activeFilters = new Set<string>();

  function matchesAnyActiveFilter(d: IncomingRow): boolean {
    if (activeFilters.size === 0) return true;
    for (const key of activeFilters) {
      // divide só no 1º ':' — nome de jogador pode conter ':' (split(…, 2) do
      // original truncava o valor)
      const sep = key.indexOf(':');
      const type = sep >= 0 ? key.slice(0, sep) : key;
      const value = sep >= 0 ? key.slice(sep + 1) : '';
      if (matchesFilter(d, type, value)) return true;
    }
    return false;
  }

  function applyActiveFilters(data: IncomingRow[]): void {
    data.forEach((d) => {
      d.row.style.display = matchesAnyActiveFilter(d) ? '' : 'none';
    });
    const visible = data.filter((d) => d.row.style.display !== 'none').length;
    const th = table.querySelector('th');
    if (th !== null) th.textContent = `Comando (${visible})`;
    filterVillageTablesMulti(data);
  }

  function filterVillageTablesMulti(data: IncomingRow[]): void {
    const leftCol = document.getElementById('vanta-village-col-left');
    const rightCol = document.getElementById('vanta-village-col-right');
    if (leftCol === null || rightCol === null) return;

    const byVillage: Record<string, IncomingRow[]> = {};
    data.forEach((d) => {
      if (d.targetVillageId === '') return;
      const list = byVillage[d.targetVillageId] ?? [];
      list.push(d);
      byVillage[d.targetVillageId] = list;
    });

    const allDivs = [...leftCol.children, ...rightCol.children] as HTMLElement[];
    allDivs.forEach((div) => {
      const h4 = div.querySelector('.vanta-village-toggle');
      if (h4 === null) return;
      const vid = h4.getAttribute('data-village-id') ?? '';
      const commands = byVillage[vid] ?? [];

      let visibleCount = 0;
      commands.forEach((d) => {
        const show = matchesAnyActiveFilter(d);
        if (show) visibleCount++;
        div.querySelectorAll<HTMLElement>(`tr[data-command-id="${CSS.escape(d.commandId)}"]`).forEach((tr) => {
          tr.style.display = show ? '' : 'none';
        });
      });
      div.style.display = visibleCount > 0 ? '' : 'none';
    });

    const visibleDivs = allDivs.filter((d) => d.style.display !== 'none');
    leftCol.innerHTML = '';
    rightCol.innerHTML = '';
    const mid = Math.ceil(visibleDivs.length / 2);
    visibleDivs.forEach((div, i) => {
      (i < mid ? leftCol : rightCol).appendChild(div);
    });
    allDivs.filter((d) => d.style.display === 'none').forEach((d) => {
      leftCol.appendChild(d);
    });
  }

  function resetFilter(data: IncomingRow[]): void {
    activeFilters.clear();
    data.forEach((d) => {
      d.row.style.display = '';
    });
    const th = table.querySelector('th');
    if (th !== null) th.textContent = `Comando (${data.length})`;
    filterVillageTablesMulti(data);
  }

  // Busca tropas + sim de uma aldeia; retorna Promise (o "Buscar Todas
  // Tropas" encadeia — P2 — em vez de polvilhar o valor do botão).
  async function buscarTropas(btn: HTMLInputElement, villageId: string, data: IncomingRow[]): Promise<void> {
    const troopRow = container.querySelector<HTMLElement>(`.vanta-troop-row[data-village-id="${CSS.escape(villageId)}"]`);
    if (troopRow === null) return;

    btn.disabled = true;
    btn.value = 'Buscando...';

    try {
      // Overview da aldeia: tropas nela (próprias + apoios instalados)
      const overviewDoc = await pacedDoc(`/game.php?village=${encodeURIComponent(villageId)}&screen=overview`, { fresh: true });

      const troops: Record<string, number> = {};
      UNITS.forEach((u) => {
        troops[u] = 0;
      });

      overviewDoc.querySelectorAll('.all_unit [data-count]').forEach((el) => {
        const unit = el.getAttribute('data-count');
        if (unit !== null && troops[unit] !== undefined) troops[unit] += parsePtBrInt(el.textContent);
      });

      // Apoios chegando antes do 1º ataque — via info_village
      try {
        const ivDoc = await pacedDoc(`/game.php?village=${encodeURIComponent(villageId)}&screen=info_village&id=${encodeURIComponent(villageId)}`, { fresh: true });
        const supportSum = ivDoc.querySelector('#support_sum');
        if (supportSum !== null) {
          const totalSupport: Record<string, number> = {};
          UNITS.forEach((u) => {
            totalSupport[u] = 0;
          });
          supportSum.querySelectorAll('td[data-unit]').forEach((td) => {
            const unit = td.getAttribute('data-unit');
            if (unit !== null && totalSupport[unit] !== undefined) {
              totalSupport[unit] = parsePtBrInt(td.textContent);
            }
          });

          const ivRows = ivDoc.querySelectorAll('#commands_incomings .command-row.no_ignored_command');
          let firstAttackTime = Number.POSITIVE_INFINITY;
          const supports: Array<{ endtime: number; cmdId: string | null }> = [];

          ivRows.forEach((row) => {
            const endtimeSpan = row.querySelector('[data-endtime]');
            const endtime = endtimeSpan !== null ? parsePtBrInt(endtimeSpan.getAttribute('data-endtime')) : 0;
            const isSupport = row.querySelector('[data-command-type="support"]') !== null || row.querySelector('img[src*="support"]') !== null;
            const isAttack = row.querySelector('img[src*="attack"]') !== null;
            if (isAttack && endtime < firstAttackTime) firstAttackTime = endtime;
            if (isSupport && endtime > 0) {
              const cmdSpan = row.querySelector('[data-command-id]');
              supports.push({ endtime, cmdId: cmdSpan?.getAttribute('data-command-id') ?? null });
            }
          });

          if (firstAttackTime === Number.POSITIVE_INFINITY) {
            // Sem ataques → todo o apoio conta
            UNITS.forEach((u) => {
              troops[u] = (troops[u] ?? 0) + (totalSupport[u] ?? 0);
            });
          } else {
            const before = supports.filter((s) => s.endtime < firstAttackTime);
            const after = supports.filter((s) => s.endtime >= firstAttackTime);

            if (after.length === 0) {
              UNITS.forEach((u) => {
                troops[u] = (troops[u] ?? 0) + (totalSupport[u] ?? 0);
              });
            } else if (before.length > 0) {
              const fetchBefore = before.length <= after.length;
              const toFetch = fetchBefore ? before : after;
              const fetched: Record<string, number> = {};
              UNITS.forEach((u) => {
                fetched[u] = 0;
              });
              for (const cmd of toFetch) {
                if (cmd.cmdId === null) continue;
                try {
                  const body = await pacedGet(`/game.php?village=${encodeURIComponent(villageId)}&screen=info_command&ajax=details&id=${encodeURIComponent(cmd.cmdId)}`);
                  const dj = JSON.parse(body) as { units?: Record<string, unknown>; response?: { units?: Record<string, unknown> } };
                  const unitsRaw = dj.units ?? dj.response?.units ?? {};
                  Object.entries(unitsRaw).forEach(([unit, info]) => {
                    const count =
                      typeof info === 'object' && info !== null && 'count' in info
                        ? parsePtBrInt(String((info as { count?: unknown }).count ?? 0))
                        : parsePtBrInt(String(info ?? 0));
                    if (fetched[unit] !== undefined) fetched[unit] += count;
                  });
                  await waitTracked(scope, 100);
                } catch {
                  /* pula comando com falha */
                }
              }
              if (fetchBefore) {
                UNITS.forEach((u) => {
                  troops[u] = (troops[u] ?? 0) + (fetched[u] ?? 0);
                });
              } else {
                UNITS.forEach((u) => {
                  troops[u] = (troops[u] ?? 0) + Math.max(0, (totalSupport[u] ?? 0) - (fetched[u] ?? 0));
                });
              }
            }
          }
        }
      } catch {
        /* sem dados de apoio — segue só com as tropas na aldeia */
      }

      // Mostra a linha de tropas
      troopRow.style.display = '';
      UNITS.forEach((u) => {
        const td = troopRow.querySelector(`td[data-unit="${u}"]`);
        const n = troops[u] ?? 0;
        if (td !== null) td.textContent = n > 0 ? n.toLocaleString('pt-BR') : '-';
      });

      // Sim de blindagem desta aldeia — sim UNIFICADO (P1-5)
      const shSpan = container.querySelector<HTMLElement>(`.vanta-village-sh[data-village-id="${CSS.escape(villageId)}"]`);
      if (shSpan !== null) {
        shSpan.textContent = 'simulando...';
        shSpan.style.color = '#6f5e40';
        try {
          const shClear = gm.get<Record<string, number>>('tsh-vanta:stackhealth:clear', { axe: 7000, spy: 50, light: 2800, marcher: 100, ram: 350, catapult: 10 });
          const shMult = gm.get<Record<string, number>>('tsh-vanta:stackhealth:multipliers', { small: 0.1, medium: 0.5, large: 1.0, unknown: 1.0 });
          const shThresh = gm.get<{ ok: number; check: number }>('tsh-vanta:stackhealth:thresholds', { ok: 5, check: 2 });
          const shBoosts = gm.get<Record<string, number>>('tsh-vanta:stackhealth:offboosts', { axe: 8, light: 8, marcher: 8 });
          const shFlag = gm.get<number>('tsh-vanta:stackhealth:attflag', -1);

          // Muralha lida da overview buscada
          const wallText =
            overviewDoc.querySelector('.visual-label-wall')?.textContent ?? overviewDoc.querySelector('#l_wall td:nth-child(2)')?.textContent ?? '';
          const wallMatch = wallText.match(/\d+/);
          const vWall = wallMatch !== null ? parsePtBrInt(wallMatch[0]) : 0;

          // Benefícios/bandeira REAIS da aldeia (o original mandava def_benefits='[]')
          const { defBenefits, defFlag } = parseDefenseEffects(overviewDoc);
          const worldUnits = toWorldUnits(gameData().units);

          const { url: simUrl, result: sim } = await runSimulator({
            villageId,
            troops,
            wall: vWall,
            defBenefits,
            defFlag,
            worldUnits,
            clear: shClear,
            offBoosts: shBoosts,
            attFlag: shFlag,
          });

          // Clears estimados pelos incomings desta aldeia
          const villageCommands = data.filter((d) => d.targetVillageId === villageId);
          let incClears = 0;
          villageCommands.forEach((d) => {
            incClears += shMult[d.size] ?? shMult.unknown ?? 1.0;
          });

          const surplus = sim.clears - incClears;
          let status: string;
          let color: string;
          if (surplus >= shThresh.ok) {
            status = 'OK';
            color = '#3f8f43';
          } else if (surplus >= shThresh.check) {
            status = 'Checar Blind';
            color = '#2f66c0';
          } else {
            status = 'NOK';
            color = '#c04038';
          }

          const fullsTxt = sim.over100 ? '100+' : String(sim.clears);
          shSpan.innerHTML = `<strong style="color:${color}">${status}</strong> ${fullsTxt} full(s) | <img src="graphic/buildings/wall.png" style="vertical-align:-2px;height:14px"> ${vWall}→<strong style="color:${color}">${sim.postWall}</strong> | Overblind: <strong style="color:${color}">${surplus.toFixed(1)}</strong> | <a href="${escAttr(simUrl)}" target="_blank" style="font-size:9px">Sim</a>`;
        } catch {
          shSpan.innerHTML = '<span style="color:#c04038">Erro sim</span>';
        }
      }

      btn.value = 'Atualizar';
      btn.disabled = false;
    } catch {
      btn.value = 'Erro!';
      btn.disabled = false;
      waitTracked(scope, 2000).then(() => {
        btn.value = 'Buscar Tropas';
      });
    }
  }

  function bindVillageSectionEvents(data: IncomingRow[]): void {
    const toggle = document.getElementById('vanta-village-section-toggle');
    const body = document.getElementById('vanta-village-section-body');
    if (toggle === null || body === null) return;

    const collapseAllBtn = document.getElementById('vanta-collapse-all-villages');
    const buttonsSpan = collapseAllBtn !== null ? collapseAllBtn.parentElement : null;

    const toggleArrow = toggle.querySelector('.vanta-arrow');
    scope.on(toggle, 'click', () => {
      const visible = body.style.display !== 'none';
      body.style.display = visible ? 'none' : '';
      if (buttonsSpan !== null) buttonsSpan.style.display = visible ? 'none' : '';
      if (toggleArrow !== null) toggleArrow.textContent = visible ? '▶' : '▼';
    });

    // Colapsáveis por aldeia
    container.querySelectorAll<HTMLElement>('.vanta-village-toggle').forEach((h4) => {
      scope.on(h4, 'click', () => {
        const vid = h4.dataset.villageId ?? '';
        const vBody = container.querySelector<HTMLElement>(`.vanta-village-body[data-village-id="${CSS.escape(vid)}"]`);
        if (vBody === null) return;
        const visible = vBody.style.display !== 'none';
        vBody.style.display = visible ? 'none' : '';
        const arrow = h4.querySelector('.vanta-arrow');
        if (arrow !== null) arrow.textContent = visible ? '▶' : '▼';
      });
    });

    // Colapsar todas
    if (collapseAllBtn instanceof HTMLInputElement) {
      scope.on(collapseAllBtn, 'click', () => {
        const allBodies = container.querySelectorAll<HTMLElement>('.vanta-village-body');
        const anyOpen = Array.from(allBodies).some((b) => b.style.display !== 'none');
        allBodies.forEach((b) => {
          b.style.display = anyOpen ? 'none' : '';
        });
        container.querySelectorAll('.vanta-village-toggle .vanta-arrow').forEach((arrow) => {
          arrow.textContent = anyOpen ? '▶' : '▼';
        });
        collapseAllBtn.value = anyOpen ? 'Expandir Todas' : 'Colapsar Todas';
      });
    }

    // Buscar Todas Tropas — sequencial, encadeando a Promise de cada aldeia (P2)
    const fetchAllBtn = document.getElementById('vanta-fetch-all-troops');
    if (fetchAllBtn instanceof HTMLInputElement) {
      scope.on(fetchAllBtn, 'click', () => {
        void (async () => {
          const allBtns = Array.from(container.querySelectorAll<HTMLInputElement>('.vanta-buscar-tropas'));
          fetchAllBtn.disabled = true;
          fetchAllBtn.value = `Buscando 0/${allBtns.length}...`;
          let done = 0;
          for (const vBtn of allBtns) {
            if (vBtn.value === 'Atualizar') {
              done++;
              continue;
            }
            await buscarTropas(vBtn, vBtn.dataset.villageId ?? '', data);
            done++;
            fetchAllBtn.value = `Buscando ${done}/${allBtns.length}...`;
            await waitTracked(scope, 300);
          }
          fetchAllBtn.value = 'Buscar Todas Tropas';
          fetchAllBtn.disabled = false;
        })();
      });
    }

    // Ordenar por horário/quantidade
    const sortBtn = document.getElementById('vanta-village-sort-toggle');
    let sortByTime = true; // default: horário de chegada
    if (sortBtn instanceof HTMLInputElement) {
      scope.on(sortBtn, 'click', () => {
        sortByTime = !sortByTime;
        sortBtn.value = sortByTime ? 'Ordenar por: Horário' : 'Ordenar por: Quantidade';

        const leftCol = document.getElementById('vanta-village-col-left');
        const rightCol = document.getElementById('vanta-village-col-right');
        if (leftCol === null || rightCol === null) return;
        const allDivs = [...leftCol.children, ...rightCol.children];

        const allRows = Array.from(table.querySelectorAll('tr.nowrap'));
        allDivs.sort((a, b) => {
          const aId = a.querySelector<HTMLElement>('.vanta-village-toggle')?.dataset.villageId;
          const bId = b.querySelector<HTMLElement>('.vanta-village-toggle')?.dataset.villageId;
          if (sortByTime) {
            // Pela chegada mais cedo (índice do 1º comando na tabela original)
            const aData = data.find((d) => d.targetVillageId === aId);
            const bData = data.find((d) => d.targetVillageId === bId);
            const aIdx = aData !== undefined ? allRows.indexOf(aData.row) : -1;
            const bIdx = bData !== undefined ? allRows.indexOf(bData.row) : -1;
            return aIdx - bIdx;
          }
          // Pela quantidade de comandos (desc)
          const aCount = data.filter((d) => d.targetVillageId === aId).length;
          const bCount = data.filter((d) => d.targetVillageId === bId).length;
          return bCount - aCount;
        });

        // Redistribui nas duas colunas
        leftCol.innerHTML = '';
        rightCol.innerHTML = '';
        const mid = Math.ceil(allDivs.length / 2);
        allDivs.forEach((div, i) => {
          (i < mid ? leftCol : rightCol).appendChild(div);
        });
      });
    }

    // Lazy: csrf resolvido no 1º clique (renameCommand) — csrf ausente no
    // mount não pode derrubar o painel inteiro (P3 consenso revisão Onda 2/3).
    let csrf: string | undefined;

    // Botões de tag nas tabelas por aldeia
    container.querySelectorAll<HTMLButtonElement>('.vanta-village-tag-btn').forEach((btn) => {
      scope.on(btn, 'click', (e) => {
        e.stopPropagation();
        void (async () => {
          const tagId = btn.dataset.tagId ?? '';
          const tag = RENOMEADOR_TAGS.find((t) => t.id === tagId);
          if (tag === undefined) return;

          const tr = btn.closest('tr[data-command-id]');
          if (tr === null) return;
          const commandId = tr.getAttribute('data-command-id') ?? '';
          // O rótulo está na linha irmã (a 1ª das duas com o mesmo command-id)
          const tbody = tr.closest('tbody');
          const labelSpan = tbody?.querySelector(`tr[data-command-id="${CSS.escape(commandId)}"] .vanta-cmd-label`) ?? null;
          if (labelSpan === null) return;

          const currentText = (labelSpan.textContent ?? '').trim();
          const newText = buildTaggedText(currentText, tag);

          btn.style.opacity = '0.5';
          btn.style.pointerEvents = 'none';
          try {
            const result = await renameCommand(commandId, newText, csrf);
            csrf = result.csrf;
            labelSpan.textContent = newText;
            // Cor da célula do comando
            const cmdTd = labelSpan.closest('td');
            if (cmdTd !== null) cmdTd.style.setProperty('background', tag.isRemove === true ? '#ff0000' : tag.topGrad, 'important');
            // Rótulo na tabela principal de incomings
            const mainLabel = table.querySelector(`span.quickedit[data-id="${CSS.escape(commandId)}"] .quickedit-label`);
            if (mainLabel !== null) mainLabel.textContent = newText;
          } catch {
            btn.style.outline = '2px solid #c04038';
            waitTracked(scope, 1500).then(() => {
              btn.style.outline = '';
            });
          } finally {
            btn.style.opacity = '';
            btn.style.pointerEvents = '';
          }
        })();
      });
    });

    // Botões "Buscar Tropas" de cada aldeia
    container.querySelectorAll<HTMLInputElement>('.vanta-buscar-tropas').forEach((btn) => {
      const villageId = btn.dataset.villageId ?? '';
      scope.on(btn, 'click', () => {
        void buscarTropas(btn, villageId, data);
      });
    });

    // Atualização ao vivo — Duração (col 6), Torre (col 7) e lead time
    function updateCountdowns(): void {
      const cmdData: Record<string, { duracao?: string; torre?: string }> = {};
      container.querySelectorAll('.vanta-cmd-duracao, .vanta-cmd-torre').forEach((span) => {
        const cmdId = span.getAttribute('data-command-id');
        if (cmdId === null || cmdId === '') return;
        const origQe = table.querySelector(`tr.nowrap span.quickedit[data-id="${CSS.escape(cmdId)}"]`);
        if (origQe === null) return;
        const tr = origQe.closest('tr');
        if (tr === null) return;
        const tds = tr.querySelectorAll('td');
        const colIdx = span.classList.contains('vanta-cmd-duracao') ? 6 : 7;
        const td = tds[colIdx];
        if (td !== undefined) {
          const text = (td.textContent ?? '').trim();
          span.textContent = text;
          const entry = (cmdData[cmdId] ??= {});
          if (colIdx === 6) entry.duracao = text;
          else entry.torre = text;
        }
      });
      // Lead time (pula "em andamento" ou texto sem countdown)
      container.querySelectorAll('.vanta-cmd-lead').forEach((span) => {
        const cmdId = span.getAttribute('data-command-id') ?? '';
        const d = cmdData[cmdId];
        if (d === undefined || d.duracao === undefined || d.torre === undefined) {
          span.textContent = '';
          return;
        }
        if (d.torre.includes('andamento')) {
          span.textContent = '';
          return;
        }
        const duracaoSec = parseCountdown(d.duracao);
        const torreSec = parseCountdown(d.torre);
        if (Number.isNaN(duracaoSec) || Number.isNaN(torreSec)) {
          span.textContent = '';
          return;
        }
        span.textContent = `(${fmtLead(duracaoSec - torreSec)})`;
      });
    }
    updateCountdowns();
    scope.every(updateCountdowns, 1000); // P1-4: interval rastreado pelo escopo
  }

  // Marcar Duplicados — adiciona [D#n] ao rótulo dos ataques repetidos
  async function marcarDuplicados(dupBtn: HTMLInputElement, data: IncomingRow[]): Promise<void> {
    dupBtn.disabled = true;
    dupBtn.value = 'Marcando...';

    // Lazy: o loop tem try/catch por renome (conta erro e restaura o botão no
    // fim) — csrf ausente vira "N erros", não unhandled rejection (P2 Onda 3).
    let csrf: string | undefined;

    // Conta comandos por coordenada de origem
    const sourceCount: Record<string, number> = {};
    data.forEach((d) => {
      if (d.sourceCoord !== null) sourceCount[d.sourceCoord] = (sourceCount[d.sourceCoord] ?? 0) + 1;
    });

    const dupes = data.filter((d) => d.sourceCoord !== null && (sourceCount[d.sourceCoord] ?? 0) > 1);

    // P3 (revisão Onda 2): renomeação em lote com confirmação.
    if (dupes.length > 0 && !window.confirm(`Marcar ${dupes.length} comando(s) duplicado(s) com [D#n]?`)) {
      dupBtn.disabled = false;
      dupBtn.value = 'Marcar Duplicados';
      return;
    }

    let renamed = 0;
    let errors = 0;
    for (const d of dupes) {
      const src = d.sourceCoord;
      if (src === null) continue;
      const labelEl = d.row.querySelector('.quickedit-label');
      if (labelEl === null) continue;
      const currentText = (labelEl.textContent ?? '').trim();
      const count = sourceCount[src] ?? 0;
      const dupMarker = `[D#${count}]`;

      // Pula se já tem o marcador correto
      const existingMarker = currentText.match(/\[D#\d+\]/);
      if (existingMarker !== null && existingMarker[0] === dupMarker) continue;

      // Troca o marcador existente ou anexa um novo
      const newText = existingMarker !== null ? currentText.replace(/\[D#\d+\]/, dupMarker) : `${currentText} ${dupMarker}`;

      const qeSpan = d.row.querySelector('span.quickedit[data-id]');
      if (qeSpan === null) continue;
      const commandId = qeSpan.getAttribute('data-id');
      if (commandId === null || commandId === '') continue;

      try {
        const result = await renameCommand(commandId, newText, csrf);
        csrf = result.csrf;
        labelEl.textContent = newText;
        renamed++;
        await waitTracked(scope, 200);
      } catch {
        errors++;
      }
    }

    dupBtn.value = errors > 0 ? `${renamed} marcados, ${errors} erros` : `${renamed} marcados`;
    dupBtn.disabled = false;
    waitTracked(scope, 3000).then(() => {
      dupBtn.value = 'Marcar Duplicados';
    });
  }

  function render(): void {
    const data = scanRows(table);
    container.innerHTML = buildDashboard(data) + buildVillageSection(table, data);

    // Eventos da seção por aldeia (colapso, tags, tropas)
    bindVillageSectionEvents(data);

    // Links de filtro (OR multi-filtro)
    container.querySelectorAll<HTMLAnchorElement>('a.vanta-dash-filter').forEach((link) => {
      scope.on(link, 'click', (e) => {
        e.preventDefault();
        const filterType = link.dataset.filter ?? '';
        const filterValue = link.dataset.value ?? '';

        if (filterType === 'all') {
          activeFilters.clear();
          container.querySelectorAll('tr').forEach((r) => r.classList.remove('vanta-dash-active'));
          resetFilter(data);
        } else {
          const key = `${filterType}:${filterValue}`;
          const tr = link.closest('tr');
          if (activeFilters.has(key)) {
            activeFilters.delete(key);
            tr?.classList.remove('vanta-dash-active');
          } else {
            activeFilters.add(key);
            tr?.classList.add('vanta-dash-active');
          }
          if (activeFilters.size === 0) {
            resetFilter(data);
          } else {
            applyActiveFilters(data);
          }
        }
      });
    });

    // Colapso do detalhamento por tag
    container.querySelectorAll<HTMLElement>('.vanta-tag-breakdown-toggle').forEach((td) => {
      scope.on(td, 'click', () => {
        const rows = container.querySelectorAll<HTMLElement>('.vanta-tag-breakdown-row');
        const first = rows[0];
        const visible = rows.length > 0 && first !== undefined && first.style.display !== 'none';
        rows.forEach((r) => {
          r.style.display = visible ? 'none' : '';
        });
        td.textContent = (visible ? '▶' : '▼') + (td.textContent ?? '').substring(1);
      });
    });

    // Marcar Duplicados
    const dupBtn = document.getElementById('vanta-mark-duplicates');
    if (dupBtn instanceof HTMLInputElement) {
      scope.on(dupBtn, 'click', () => {
        void marcarDuplicados(dupBtn, data);
      });
    }
  }

  render();

  // Atualização parcial via ajax → REMONTA o módulo limpo (P1-4)
  rebindAjaxRemount('vantaDashboard', 'vanta-dashboard');
}

// ─── Cores de Incomings ────────────────────────────────────────────────────

function mountCores(scope: ModuleScope): void {
  ensureVantaStyles();
  if (document.getElementById('vanta-cores-applied') !== null) return; // idempotente

  const tableEl = document.getElementById('incomings_table');
  if (!(tableEl instanceof HTMLTableElement)) return;
  const table: HTMLTableElement = tableEl;

  // Marca como aplicado
  const marker = document.createElement('span');
  marker.id = 'vanta-cores-applied';
  marker.style.display = 'none';
  table.appendChild(marker);
  scope.owns(marker);

  const TEXT_SHADOW = '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000';

  function colorizeRows(): void {
    table.querySelectorAll('tr.nowrap').forEach((row) => {
      const firstTd = row.querySelector<HTMLElement>('td');
      if (firstTd === null) return;
      const firstA = firstTd.querySelector<HTMLAnchorElement>('a');

      // Apoio → amarelo
      const firstImg = row.querySelector<HTMLImageElement>('img:first-of-type');
      if (firstImg !== null && (firstImg.getAttribute('src') ?? '').includes('support')) {
        firstTd.style.cssText = 'background: #e8c30d !important;';
        if (firstA !== null) firstA.style.cssText = `color: white !important; text-shadow: ${TEXT_SHADOW};`;
        return;
      }

      const labelEl = row.querySelector('.quickedit-label');
      if (labelEl === null) return;
      const name = (labelEl.textContent ?? '').trim();

      // Par de tags (o mais à direita) → listrado
      let bestPairPos = -1;
      let pairTag1: RenomeadorTag | null = null;
      let pairTag2: RenomeadorTag | null = null;
      for (let i = 0; i < RENOMEADOR_TAGS.length; i++) {
        const t1 = RENOMEADOR_TAGS[i];
        if (t1 === undefined || t1.label === '') continue;
        for (let j = 0; j < RENOMEADOR_TAGS.length; j++) {
          const t2 = RENOMEADOR_TAGS[j];
          if (t2 === undefined || t2.label === '') continue;
          const combined = t1.label + t2.label;
          const pos = name.lastIndexOf(combined);
          if (pos > bestPairPos) {
            bestPairPos = pos;
            pairTag1 = t1;
            pairTag2 = t2;
          }
        }
      }

      if (bestPairPos >= 0 && pairTag1 !== null && pairTag2 !== null) {
        firstTd.style.cssText = `background: repeating-linear-gradient(45deg, ${pairTag1.topGrad}, ${pairTag1.topGrad} 10px, ${pairTag2.topGrad} 10px, ${pairTag2.topGrad} 20px) !important;`;
        if (firstA !== null) firstA.style.cssText = `color: white !important; text-shadow: ${TEXT_SHADOW};`;
        return;
      }

      // Tag única (a mais à direita)
      let bestPos = -1;
      let matchedTag: RenomeadorTag | null = null;
      for (const tag of RENOMEADOR_TAGS) {
        if (tag.label === '') continue;
        const pos = name.lastIndexOf(tag.label);
        if (pos > bestPos) {
          bestPos = pos;
          matchedTag = tag;
        }
      }

      if (matchedTag !== null) {
        firstTd.style.cssText = `background: ${matchedTag.topGrad} !important;`;
      } else {
        // Sem tag → vermelho
        firstTd.style.cssText = 'background: #ff0000 !important;';
      }
      if (firstA !== null) firstA.style.cssText = `color: white !important; text-shadow: ${TEXT_SHADOW};`;
    });
  }

  colorizeRows();

  // Atualização parcial via ajax → REMONTA o módulo limpo (P1-4)
  rebindAjaxRemount('vantaCores', 'vanta-cores');
}

// ─── Registro ──────────────────────────────────────────────────────────────

registerVanta({
  id: 'vanta-dashboard',
  label: 'Painel de Incomings',
  desc: 'Resumo de ataques/nobres/jogadores, comandos por aldeia, tropas e sim de blindagem',
  group: 'defesa',
  match: () => params().get('screen') === 'overview_villages' && params().get('mode') === 'incomings',
  url: () => '/game.php?screen=overview_villages&mode=incomings&type=unignored&subtype=attacks&page=-1',
  mount: mountDashboard,
});

registerVanta({
  id: 'vanta-cores',
  label: 'Cores de Incomings',
  desc: 'Colore os ataques da lista de incomings conforme a tag do rótulo',
  group: 'defesa',
  match: () => params().get('screen') === 'overview_villages' && params().get('mode') === 'incomings',
  url: () => '/game.php?screen=overview_villages&mode=incomings&type=unignored&subtype=attacks&page=-1',
  mount: mountCores,
});
