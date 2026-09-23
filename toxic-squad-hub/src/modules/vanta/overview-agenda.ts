// Agenda das Aldeias — coluna "Agenda" na tabela de aldeias das Visualizações
// (screen=overview_villages) com o nº de comandos VIVOS do Agendador por aldeia
// de origem, filtros rápidos (Com agendamento / Sem agendamento / Ignorar
// fakes) e "Copiar visíveis" (coordenadas das linhas visíveis, uma por linha).
// Mesmo trio do concorrente (coluna + filtros + copiar visíveis) no visual do
// tema Vanta.
//
// Decisões (e o porquê):
// - Tabela alvo por FORMATO, não por id fixo (o jogo troca id/classe entre modos
//   e versões): uma linha é de aldeia quando expõe UM id de aldeia —
//   `span.quickedit-vn[data-id]` (marcador de todas as Visualizações; ver
//   src/shared/parsers/village-parsers.ts e os fixtures br142) ou link
//   `screen=info_village&id=NNN` (o formato que o groups-parser já lê); em
//   versões sem esses marcadores, o último recurso é um link `village=NNN` com a
//   coordenada no próprio texto. Entre as candidatas vence a tabela com MAIS
//   linhas de aldeia, exigindo cabeçalho `<th>`.
// - Só o modo PADRÃO (sem `mode=`, tolerando `combined`, que o jogo reporta para
//   a visão geral em algumas versões): em `mode=units` a aldeia é agrupada com
//   rowspan e em `commands`/`incomings` as linhas são comandos — uma célula por
//   linha desalinharia a grade nesses modos.
// - Aldeia↔comando pelo `sourceVillageId` do ScheduledCommandRecord (id
//   canônico, normalizado sem o prefixo "n" da URL do jogo). Quando um dos lados
//   não tem id, cai para a coordenada `source` do record contra o "(x|y)" do
//   texto da linha — é a MESMA coordenada que o Composer grava em `source`;
//   sem esse fallback, comando legado/migrado sem id ficaria invisível.
// - "Vivos" = mesmo critério da home (nextScheduled) e da tela Comandos:
//   `paused` fora e último evento terminal (enviado/incerto/falhou/removido)
//   fora — histórico e pausados não inflam a coluna.
// - Zero innerHTML com dado dinâmico: o casco da barra é estático e todo texto
//   (contagem, título, resumo) vai por textContent.
// - Estilos próprios no próprio nó (como o Mapa Enxuto): a barra não usa as
//   classes da suíte, então não chama ensureVantaStyles() à toa.

import { gm } from '../../core/storage';
import { pageWindow } from '../../core/page';
import { currentVillageId } from './vanta-net';
import { isVantaEnabled, mountVanta, registerVanta } from './vanta-registry';
import type { ModuleScope } from './vanta-lifecycle';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

const MODULE_ID = 'vanta-overview-agenda';
/** Guard de idempotência do mount (barra de filtros acima da tabela). */
const UI_ID = 'vanta-overview-agenda-ui';
/** Status terminais do histórico do agendador (mesmo critério de "vivos" da home). */
const EVENTOS_TERMINAIS: ReadonlySet<string> = new Set(['enviado', 'incerto', 'falhou', 'removido']);
/** Primeira coordenada "(x|y)" do texto da linha (nome da aldeia nas Visualizações). */
const COORD_RE = /\((\d{1,3})\|(\d{1,3})\)/;

/** Registro do agendador (shape real: ext/core/scheduler-state.ts). */
interface CommandRecordLike {
  kind?: unknown;
  paused?: unknown;
  sourceVillageId?: unknown;
  source?: { x?: unknown; y?: unknown };
  events?: unknown;
}

interface VillageLine {
  tr: HTMLTableRowElement;
  villageId: string | null;
  coord: string | null;
  /** `display` inline que a linha já tinha (restaurado quando ela volta a aparecer). */
  display: string;
  count: number;
  fakeOnly: boolean;
}

interface VillageRowRef {
  tr: HTMLTableRowElement;
  villageId: string | null;
}

interface VillageTable {
  table: HTMLTableElement;
  headerRow: HTMLTableRowElement;
  rows: VillageRowRef[];
}

/**
 * Estado dos filtros vive no MÓDULO (não no mount): um remount por ajax parcial
 * (quickedit/paginador) não devolve o usuário ao filtro default.
 */
const FILTROS = { com: false, sem: false, fakes: false };

/** setTimeout rastreado que sobrevive ao dispose (não estoura "escopo descartado"). */
function waitTracked(scope: ModuleScope, ms: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      scope.after(resolve, ms);
    } catch {
      resolve();
    }
  });
}

// ── Leitura da tabela ───────────────────────────────────────────────────────

/** Prefixo "n" que a URL do jogo usa em aldeias (`village=n123`); o id canônico não tem. */
function normalizeVillageId(id: string): string {
  return id.replace(/^n/, '');
}

/**
 * Ids FORTES de aldeia da linha: `span.quickedit-vn[data-id]` (marcador de todas
 * as Visualizações; ver src/shared/parsers/village-parsers.ts) e link
 * `screen=info_village&id=NNN` (formato que o groups-parser já lê). Dedupe —
 * os dois marcadores podem repetir o mesmo id.
 */
function strongIdsInRow(tr: HTMLTableRowElement): string[] {
  const ids = new Set<string>();
  tr.querySelectorAll('span.quickedit-vn[data-id]').forEach((el) => {
    const id = el.getAttribute('data-id');
    if (id !== null && /^\d+$/.test(id)) ids.add(id);
  });
  tr.querySelectorAll<HTMLAnchorElement>('a[href*="screen=info_village"]').forEach((a) => {
    const match = /[?&]id=(\d+)/.exec(a.getAttribute('href') ?? '');
    const id = match?.[1];
    if (id !== undefined) ids.add(id);
  });
  return [...ids];
}

/**
 * Id FRACO (último recurso, para versões da Visão geral sem os marcadores
 * fortes): link `village=NNN` cujo PRÓPRIO texto traz a coordenada — o nome da
 * aldeia, não o rótulo de um comando. Só é usado quando a tabela inteira não tem
 * nenhum marcador forte (senão uma tabela de comandos, que cita `village=` com a
 * coordenada do alvo no rótulo, passaria por lista de aldeias).
 */
function weakIdInRow(tr: HTMLTableRowElement): string | null {
  let found: string | null = null;
  tr.querySelectorAll<HTMLAnchorElement>('a[href*="village="]').forEach((a) => {
    if (found !== null || !COORD_RE.test(a.textContent ?? '')) return;
    const match = /[?&]village=n?(\d+)/.exec(a.getAttribute('href') ?? '');
    found = match?.[1] ?? null;
  });
  return found;
}

function coordFromRow(tr: HTMLTableRowElement): string | null {
  const match = COORD_RE.exec(tr.textContent ?? '');
  const x = match?.[1];
  const y = match?.[2];
  return x === undefined || y === undefined ? null : `${x}|${y}`;
}

/** Tabela de aldeias: a candidata com mais linhas de aldeia e cabeçalho com `<th>`. */
function findVillageTable(): VillageTable | null {
  let best: VillageTable | null = null;
  document.querySelectorAll<HTMLTableElement>('table').forEach((table) => {
    const all = Array.from(table.rows);
    const headerRow = all.find((tr) => tr.querySelector('th') !== null);
    if (headerRow === undefined) return;
    const dataRows = all.filter((tr) => tr !== headerRow);

    // Uma linha de aldeia tem UM id forte (mais de um = linha de comandos, com
    // origem e destino). Sem nenhum id forte na tabela, tenta o id fraco.
    const rows: VillageRowRef[] = [];
    dataRows.forEach((tr) => {
      const fortes = strongIdsInRow(tr);
      if (fortes.length === 1) rows.push({ tr, villageId: fortes[0] ?? null });
    });
    if (rows.length === 0) {
      dataRows.forEach((tr) => {
        const fraco = weakIdInRow(tr);
        if (fraco !== null) rows.push({ tr, villageId: fraco });
      });
    }
    if (rows.length === 0) return;
    if (best === null || rows.length > best.rows.length) best = { table, headerRow, rows };
  });
  return best;
}

// ── Storage do Agendador (mesma chave do motor) ─────────────────────────────

function worldName(): string {
  // Mesma convenção do runtime (`game_data.world`; fallback do hostname): sem o
  // fallback, `game_data` ausente lia o balde errado (agenda sempre vazia).
  const world = pageWindow().game_data?.world;
  if (typeof world === 'string' && world !== '') return world;
  return window.location.hostname.split('.')[0] ?? '';
}

function readSchedulerRecords(world: string): CommandRecordLike[] {
  if (world === '') return [];
  const state = gm.get<{ commands?: unknown }>(`tsh-auto:${world}:command-scheduler:scheduler`, {});
  if (!Array.isArray(state.commands)) return [];
  return state.commands.filter((raw): raw is CommandRecordLike => typeof raw === 'object' && raw !== null);
}

function isAliveRecord(record: CommandRecordLike): boolean {
  if (record.paused === true) return false;
  const events = Array.isArray(record.events) ? record.events : [];
  const last: unknown = events.at(-1);
  if (typeof last !== 'object' || last === null) return true;
  const status = (last as { status?: unknown }).status;
  return !(typeof status === 'string' && EVENTOS_TERMINAIS.has(status));
}

/** Comando sai desta aldeia? Por id (canônico); sem id de um dos lados, pela coordenada de origem. */
function recordMatchesLine(record: CommandRecordLike, line: VillageLine): boolean {
  const sourceId = typeof record.sourceVillageId === 'string' ? normalizeVillageId(record.sourceVillageId) : '';
  if (sourceId !== '' && line.villageId !== null) return sourceId === normalizeVillageId(line.villageId);
  const source = record.source;
  if (source === undefined || line.coord === null) return false;
  const x = Number(source.x);
  const y = Number(source.y);
  return Number.isInteger(x) && Number.isInteger(y) && `${x}|${y}` === line.coord;
}

// ── Rede do jogo: ajaxComplete namespaced (padrão do dashboard) ─────────────

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
 * módulo (mountVanta dispõe o escopo antigo — th/células/barra e listeners
 * velhos morrem junto; o mount novo reinjeta tudo).
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

// ── Cópia (clipboard com fallback execCommand) ──────────────────────────────

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* clipboard bloqueado (aba sem foco/permissão) — cai para o execCommand */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

// ── UI ──────────────────────────────────────────────────────────────────────

const BAR_STYLES = `
  #${UI_ID} {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    margin: 0 0 6px; padding: 8px 10px;
    background: var(--shs-bg-card, #fffdf3); border: 1px solid var(--shs-border, #e0cda0); border-radius: 10px;
    font-family: var(--shs-font, Verdana, sans-serif); font-size: 11.5px; color: var(--shs-ink-strong, #3c250a);
  }
  #${UI_ID} * { box-sizing: border-box; }
  #vanta-agenda-head { display: flex; align-items: center; gap: 8px; margin-right: auto; }
  #vanta-agenda-title {
    font-size: 10.5px; font-weight: 700; letter-spacing: 1.5px;
    text-transform: uppercase; color: var(--shs-ink-strong, #3c250a);
  }
  #vanta-agenda-resumo { color: var(--shs-muted, #6f5e40); }
  .vanta-ag-btn {
    padding: 4px 10px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--shs-border-strong, #cbb384); background: var(--shs-bg-inset, #f4ead0); color: var(--shs-ink, #5a3a16);
    font-size: 11px; font-weight: 600; font-family: inherit;
  }
  .vanta-ag-btn:hover:not(:disabled) { background: var(--shs-bg-head, #efe2ba); }
  .vanta-ag-btn:disabled { cursor: default; }
  .vanta-ag-btn--on { background: var(--shs-action, #6d3c14); border-color: var(--shs-action, #6d3c14); color: #fff; }
  .vanta-ag-btn--primary { background: var(--shs-ok, #3f8f43); border-color: var(--shs-ok-hover, #357a39); color: #fff; }
  .vanta-ag-btn--primary:hover:not(:disabled) { background: var(--shs-ok-hover, #357a39); }
  .vanta-ag-btn--ok { background: var(--shs-ok, #3f8f43); border-color: var(--shs-ok-hover, #357a39); color: #fff; }
  .vanta-ag-btn--err { background: var(--shs-danger-bg, #fceaea); border-color: var(--shs-danger, #c04038); color: var(--shs-danger, #c04038); }
  /* Pill da coluna: verde = tem agendamento, âmbar = só fakes, cinza = nenhum. */
  .vanta-ag-pill {
    display: inline-block; min-width: 20px; padding: 1px 7px; border-radius: 999px;
    background: var(--shs-ok-bg, #e8f4e2); border: 1px solid var(--shs-ok-border, #b5d4a8); color: var(--shs-ok-ink, #2e5b2a);
    font-size: 11px; font-weight: 700; line-height: 16px; text-align: center;
  }
  .vanta-ag-pill--fake { background: var(--shs-warn-soft, #fdf6d8); border-color: #e8d588; color: #6b5518; }
  .vanta-ag-pill--none { background: var(--shs-bg-inset, #f4ead0); border-color: var(--shs-border, #e0cda0); color: var(--shs-ink-disabled, #b3a27d); font-weight: 500; }
  .vanta-ag-cell, #vanta-agenda-th { text-align: center; }
`;

function buildCell(line: VillageLine): HTMLTableCellElement {
  const td = document.createElement('td');
  td.className = 'vanta-ag-cell';

  const pill = document.createElement('span');
  if (line.count === 0) {
    pill.className = 'vanta-ag-pill vanta-ag-pill--none';
    pill.textContent = '—';
    pill.title = 'Nenhum comando agendado saindo desta aldeia';
  } else {
    pill.className = line.fakeOnly ? 'vanta-ag-pill vanta-ag-pill--fake' : 'vanta-ag-pill';
    pill.textContent = String(line.count);
    pill.title = line.fakeOnly
      ? `${line.count} comando(s) agendado(s) — todos fakes`
      : `${line.count} comando(s) agendado(s) saindo desta aldeia`;
  }
  td.appendChild(pill);
  return td;
}

/** Barra acima da tabela: título/resumo, 3 filtros toggle e "Copiar visíveis". */
function buildBar(scope: ModuleScope, lines: VillageLine[]): HTMLElement {
  const bar = document.createElement('div');
  bar.id = UI_ID;
  bar.innerHTML = `
        <style>${BAR_STYLES}</style>
        <div id="vanta-agenda-head">
            <span id="vanta-agenda-title">Agenda das Aldeias</span>
            <span id="vanta-agenda-resumo"></span>
        </div>
        <div id="vanta-agenda-acoes">
            <button type="button" id="vanta-agenda-f-com" class="vanta-ag-btn">Com agendamento</button>
            <button type="button" id="vanta-agenda-f-sem" class="vanta-ag-btn">Sem agendamento</button>
            <button type="button" id="vanta-agenda-f-fakes" class="vanta-ag-btn">Ignorar fakes</button>
            <button type="button" id="vanta-agenda-copiar" class="vanta-ag-btn vanta-ag-btn--primary">Copiar visíveis</button>
        </div>
    `;

  const resumo = bar.querySelector<HTMLElement>('#vanta-agenda-resumo');
  const btnCom = bar.querySelector<HTMLButtonElement>('#vanta-agenda-f-com');
  const btnSem = bar.querySelector<HTMLButtonElement>('#vanta-agenda-f-sem');
  const btnFakes = bar.querySelector<HTMLButtonElement>('#vanta-agenda-f-fakes');
  const btnCopiar = bar.querySelector<HTMLButtonElement>('#vanta-agenda-copiar');

  function syncButtons(): void {
    const pares: Array<[HTMLButtonElement | null, boolean]> = [
      [btnCom, FILTROS.com],
      [btnSem, FILTROS.sem],
      [btnFakes, FILTROS.fakes],
    ];
    pares.forEach(([btn, ativo]) => {
      if (btn === null) return;
      btn.classList.toggle('vanta-ag-btn--on', ativo);
      btn.setAttribute('aria-pressed', ativo ? 'true' : 'false');
    });
  }

  function updateResumo(): void {
    if (resumo === null) return;
    const visiveis = lines.filter((line) => line.tr.style.display !== 'none').length;
    const com = lines.filter((line) => line.count > 0).length;
    const plural = (n: number): string => (n === 1 ? '' : 's');
    resumo.textContent = `${lines.length} aldeia${plural(lines.length)} · ${com} com agendamento · ${visiveis} visíveis`;
  }

  function applyFilters(): void {
    lines.forEach((line) => {
      const escondida =
        (FILTROS.com && line.count === 0) || (FILTROS.sem && line.count > 0) || (FILTROS.fakes && line.fakeOnly);
      // Volta ao display ORIGINAL da linha (o jogo pode ter inline próprio).
      line.tr.style.display = escondida ? 'none' : line.display;
    });
    syncButtons();
    updateResumo();
  }

  function flash(btn: HTMLButtonElement, texto: string, ok: boolean): void {
    btn.textContent = texto;
    btn.disabled = true;
    btn.classList.toggle('vanta-ag-btn--ok', ok);
    btn.classList.toggle('vanta-ag-btn--err', !ok);
    void waitTracked(scope, 1500).then(() => {
      btn.textContent = 'Copiar visíveis';
      btn.disabled = false;
      btn.classList.remove('vanta-ag-btn--ok', 'vanta-ag-btn--err');
    });
  }

  function toggle(key: 'com' | 'sem' | 'fakes'): void {
    if (key === 'fakes') {
      FILTROS.fakes = !FILTROS.fakes;
    } else {
      // "Com"/"Sem" são exclusivos: ligados juntos não sobraria nenhuma linha.
      const next = !FILTROS[key];
      FILTROS.com = false;
      FILTROS.sem = false;
      FILTROS[key] = next;
    }
    applyFilters();
  }

  if (btnCom !== null) scope.on(btnCom, 'click', () => toggle('com'));
  if (btnSem !== null) scope.on(btnSem, 'click', () => toggle('sem'));
  if (btnFakes !== null) scope.on(btnFakes, 'click', () => toggle('fakes'));

  if (btnCopiar !== null) {
    scope.on(btnCopiar, 'click', () => {
      const coords = lines
        .filter((line) => line.tr.style.display !== 'none' && line.coord !== null)
        .map((line) => line.coord ?? '');
      if (coords.length === 0) {
        flash(btnCopiar, 'Nada visível', false);
        return;
      }
      void copyText(coords.join('\n')).then((ok) => {
        flash(btnCopiar, ok ? 'Copiado!' : 'Falha ao copiar', ok);
      });
    });
  }

  applyFilters();
  return bar;
}

// ── Registro ────────────────────────────────────────────────────────────────

registerVanta({
  id: MODULE_ID,
  label: 'Agenda das Aldeias',
  icon: 'calendar',
  desc: 'Coluna com comandos agendados por aldeia, filtros rápidos e cópia das aldeias visíveis.',
  group: 'utilidades',
  match: () => params().get('screen') === 'overview_villages',
  url: () => `/game.php?village=${currentVillageId()}&screen=overview_villages`,
  mount(scope: ModuleScope): void {
    if (document.getElementById(UI_ID) !== null) return; // idempotente

    const mode = params().get('mode');
    if (mode !== null && mode !== '' && mode !== 'combined') return; // só o modo padrão

    const found = findVillageTable();
    if (found === null) return;
    const { table, headerRow, rows } = found;

    // Contagem por aldeia: comandos VIVOS do Agendador saindo da origem.
    const commands = readSchedulerRecords(worldName()).filter(isAliveRecord);
    const lines: VillageLine[] = rows.map((row) => {
      const line: VillageLine = {
        tr: row.tr,
        villageId: row.villageId,
        coord: coordFromRow(row.tr),
        display: row.tr.style.display,
        count: 0,
        fakeOnly: false,
      };
      const vivos = commands.filter((record) => recordMatchesLine(record, line));
      line.count = vivos.length;
      line.fakeOnly = vivos.length > 0 && vivos.every((record) => record.kind === 'fake');
      return line;
    });
    if (lines.length === 0) return;

    // Coluna "Agenda": th no cabeçalho + uma célula por linha de aldeia.
    const headerCells = headerRow.children.length; // ANTES do th (usado no realinhamento)
    const th = document.createElement('th');
    th.id = 'vanta-agenda-th';
    th.textContent = 'Agenda';
    th.title = 'Comandos agendados (Agendador do Hub) por aldeia de origem';
    headerRow.appendChild(th);
    scope.owns(th);

    lines.forEach((line) => {
      const cell = buildCell(line);
      line.tr.appendChild(cell);
      scope.owns(cell);
    });

    // Linhas sem aldeia (total/rodapé): célula vazia só para não desalinhar a grade.
    const lineRows = new Set<HTMLTableRowElement>(lines.map((line) => line.tr));
    Array.from(table.rows).forEach((tr) => {
      if (tr === headerRow || lineRows.has(tr) || tr.children.length !== headerCells) return;
      const filler = document.createElement('td');
      tr.appendChild(filler);
      scope.owns(filler);
    });

    const bar = buildBar(scope, lines);
    table.insertAdjacentElement('beforebegin', bar);
    scope.owns(bar);

    // Re-render do jogo (paginação/quickedit via ajax parcial) → remonta limpo.
    rebindAjaxRemount('vantaOverviewAgenda', MODULE_ID);
  },
});
