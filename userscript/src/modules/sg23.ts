// Módulo SG_2/SG_3 — seção "Tropas & Defesa" do Staff Hub In-Game.
// Glue fino: TODA a lógica (parsers, motores de resumo/blind/histórico e
// formatters) vive em '@shared/...' — os mesmos módulos do app Electron. Aqui é
// só coleta PACED via pacedGet (≥200ms entre chamadas, anti-ban — nunca em
// paralelo), persistência por mundo no GM storage e renderização em DOM puro
// dentro do Shadow DOM (classes shs-*). 100% leitura — nenhuma mutação.

import { CaptchaDetectedError, SessionRequiredError, pacedGet } from '../core/net';
import { gameContext, registerSection } from '../core/shell';
import { gm, worldKey } from '../core/storage';
import {
  extractPagedNavPages,
  parseMemberSelector,
  parseMemberVillageDefense,
  parseMemberVillageTroops,
  parseMembersDefense,
  parseMembersTroops,
  type AllyUnitsResult,
  type MemberVillageDefenseResult,
  type MemberVillageTroopsResult,
} from '@shared/parsers/ally-parsers';
import { isMemberSummaryPage } from '@shared/parsers/village-parsers';
import { parseUnitInfoXml } from '@shared/parsers/world-parsers';
import { normalizeCoordText } from '@shared/coord-input';
import { parseCoordList } from '@shared/coords';
import { UNITS, type UnitCounts, type UnitId } from '@shared/units';
import type { DefenseSnapshot, DefenseVillageEntry, TroopEntry, TroopSnapshot } from '@shared/sg2-engine';
import type { TroopKind } from '@shared/ipc-types';
import {
  SUMMARY_UNIT_ORDER,
  formatSummaryPlayerTsv,
  summarizeSnapshot,
  type Sg2Summary,
} from '@shared/sg2-summary';
import { formatFullSemiRows, fullSemiReport } from '@shared/full-semi';
import { blindBbcodeTable, checkBlind } from '@shared/sg3-engine';
import {
  aggregateSnapshot,
  capHistory,
  diffTroopsVersions,
  newVersionId,
  type TroopsHistoryVersion,
} from '@shared/snapshot-history';
import {
  AUDIT_SIGNAL_LABEL,
  STAGNATION_LABEL,
  auditSignals,
  detectStagnation,
  formatAuditDiffTsv,
} from '@shared/member-audit';

// ---------------------------------------------------------------------------
// Constantes e formas persistidas
// ---------------------------------------------------------------------------

/** Teto de segurança de paginação por membro — acima disso o pager está em loop. */
const MAX_PAGES_PER_MEMBER = 50;
/** TTL do cache de população por unidade (get_unit_info) — mesma régua do app (1 dia). */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** Padrões do Full/Semi (mesmos do Sg2Page do app). */
const FULL_POP_DEFAULT = '18000';
const SEMI_POP_DEFAULT = '12000';
/** Unidades do blind desejado (mesmas do Sg3Page do app). */
const BLIND_UNITS: readonly UnitId[] = ['spear', 'sword', 'archer', 'heavy'];

/**
 * Própria conta logada: o jogo IGNORA o player_id da sessão e devolve o resumo
 * por jogador (sem tabela por aldeia). No app a conta própria vem de
 * overview_villages&mode=units; aqui registrada como falha do membro, sem
 * inventar dados.
 */
const OWN_ACCOUNT_NOTE =
  'Própria conta logada: o jogo devolve o resumo por jogador nesta tela, sem a tabela por aldeia — os dados desta conta ficam de fora da coleta por membro.';

/** Última coleta de TROPAS (resumo ou por membro) — collectedAt/source dentro do snapshot. */
interface Sg2Store {
  world: string | null;
  snapshot: TroopSnapshot | null;
}

/** Última coleta de DEFESA + o recorte por aldeia (com trânsito) usado pelo blind. */
interface Sg3Store {
  world: string | null;
  snapshot: TroopSnapshot | null;
  defenseVillages: DefenseSnapshot | null;
}

interface HistoryStore {
  versions: TroopsHistoryVersion[];
}

interface UnitPopsStore {
  fetchedAt: string | null;
  pops: Record<string, number> | null;
}

const sg2Key = (world: string): string => worldKey(world, 'sg2-snapshot');
const sg3Key = (world: string): string => worldKey(world, 'sg3-snapshot');
const historyKey = (world: string): string => worldKey(world, 'sg23-history');
const unitPopsKey = (world: string): string => worldKey(world, 'sg23-unit-pops');

function loadTroopsSnapshot(world: string): TroopSnapshot | null {
  return gm.get<Sg2Store>(sg2Key(world), { world: null, snapshot: null }).snapshot;
}

function loadDefenseStore(world: string): Sg3Store {
  return gm.get<Sg3Store>(sg3Key(world), { world: null, snapshot: null, defenseVillages: null });
}

function loadHistory(world: string): TroopsHistoryVersion[] {
  return gm.get<HistoryStore>(historyKey(world), { versions: [] }).versions;
}

/** Grava o snapshot na posição do tipo, preservando a outra coleta salva. */
function saveCollected(world: string, snapshot: TroopSnapshot, defenseVillages: DefenseSnapshot | null): void {
  if (snapshot.kind === 'troops') {
    const store: Sg2Store = { world, snapshot };
    gm.set(sg2Key(world), store);
    return;
  }
  const store: Sg3Store = { world, snapshot, defenseVillages };
  gm.set(sg3Key(world), store);
}

/**
 * Arquiva UMA versão agregada por jogador no histórico (mesmas regras do app em
 * ipc-history: aggregateSnapshot fail-closed, id novo, cap 20 com rotação).
 * Só coleta POR MEMBRO de TROPAS entra (o diff do histórico compara crescimento
 * de tropas — versões de defesa misturariam as réguas). Retorna se arquivou.
 */
function archiveHistory(world: string, snapshot: TroopSnapshot): boolean {
  if (snapshot.kind !== 'troops' || snapshot.source !== 'per-member' || snapshot.entries.length === 0) {
    return false;
  }
  const version: TroopsHistoryVersion = {
    id: newVersionId(),
    collectedAt: snapshot.collectedAt,
    source: snapshot.source,
    players: aggregateSnapshot(snapshot),
  };
  gm.set(historyKey(world), { versions: capHistory([version, ...loadHistory(world)]) });
  return true;
}

/** População por unidade do mundo (interface.php?func=get_unit_info), cache 1 dia por mundo. */
async function unitPops(world: string): Promise<Record<string, number>> {
  const cached = gm.get<UnitPopsStore>(unitPopsKey(world), { fetchedAt: null, pops: null });
  if (
    cached.pops !== null &&
    cached.fetchedAt !== null &&
    Date.now() - Date.parse(cached.fetchedAt) < ONE_DAY_MS
  ) {
    return cached.pops;
  }
  const units = parseUnitInfoXml(await pacedGet('/interface.php?func=get_unit_info'));
  const pops: Record<string, number> = {};
  for (const [id, info] of Object.entries(units)) pops[id] = info.pop;
  gm.set(unitPopsKey(world), { fetchedAt: new Date().toISOString(), pops });
  return pops;
}

/** Fallback do catálogo fixo BR (mesma régua do app quando o unit-info falha). */
function catalogPops(): Record<string, number> {
  const pops: Record<string, number> = {};
  for (const id of Object.keys(UNITS) as UnitId[]) pops[id] = UNITS[id].population;
  return pops;
}

// ---------------------------------------------------------------------------
// Coleta (toda via pacedGet — serializada com pacing ≥200ms pelo core/net)
// ---------------------------------------------------------------------------

/** Mundo ativo do jogo; fail-closed com mensagem clara fora de uma página do jogo. */
function currentWorld(): string {
  const world = gameContext().world;
  if (world === '' || world === '—') {
    throw new Error('Mundo não identificado — abra o painel dentro de uma página do jogo.');
  }
  return world;
}

function membersPagePath(kind: TroopKind): string {
  return `/game.php?screen=ally&mode=${kind === 'troops' ? 'members_troops' : 'members_defense'}`;
}

/**
 * Resumo em 1 requisição (visão SEM membro selecionado): uma linha por JOGADOR,
 * sem coordenada (coord -1|-1), igual ao TroopsService.collectSummary do app.
 * (Sem parâmetro de mundo: o pacedGet do userscript é same-origin.)
 */
async function collectSummary(kind: TroopKind): Promise<TroopSnapshot> {
  const body = await pacedGet(membersPagePath(kind));
  let parsed: AllyUnitsResult;
  try {
    parsed = kind === 'troops' ? parseMembersTroops(body) : parseMembersDefense(body);
  } catch (error) {
    throw new Error(
      `Página de resumo com formato inesperado: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const entries: TroopEntry[] = parsed.players.map((row) => ({
    playerId: row.playerId,
    playerName: row.name,
    coord: { x: -1, y: -1 },
    villageName: '',
    units: row.units,
    ...(row.commandsCount !== undefined ? { commandsCount: row.commandsCount } : {}),
    ...(row.incomingAttacksCount !== undefined ? { incomingAttacksCount: row.incomingAttacksCount } : {}),
  }));
  return {
    kind,
    source: 'summary',
    collectedAt: new Date().toISOString(),
    entries,
  };
}

/** Aldeia de uma página por membro (tropas OU defesa) — união dos dois parsers. */
type MemberVillage =
  | MemberVillageTroopsResult['villages'][number]
  | MemberVillageDefenseResult['villages'][number];

/**
 * Coleta completa por ALDEIA: 1 requisição do dropdown + 1 por membro (+ páginas
 * extras via extractPagedNavPages, teto de 50 — fix do pager memorizado na
 * sessão: a 1ª chamada usa page=1 EXPLÍCITO). Um membro com erro NÃO aborta a
 * coleta; sentinelas de sessão/captcha abortam tudo. shouldCancel é checado
 * ENTRE membros e ENTRE páginas (nunca no meio de um GET); ao cancelar, o
 * parcial coletado até então volta com cancelled: true.
 */
async function collectMembers(
  kind: TroopKind,
  onProgress: (done: number, total: number, nick: string) => void,
  shouldCancel: () => boolean,
): Promise<{ snapshot: TroopSnapshot; defenseVillages: DefenseSnapshot | null; cancelled: boolean }> {
  const base = membersPagePath(kind);
  const selector = parseMemberSelector(await pacedGet(base));
  const members = selector.options;
  if (members.length === 0) {
    throw new Error('Nenhum membro no dropdown — confira se a página carregou com a tribo correta.');
  }
  // TETO de requisições (paridade de ban-surface com o app: teto 400 default).
  // Cada membro = 1+ GETs (paginação). Sem o teto, tribo grande = centenas de
  // chamadas sem que o líder saiba (P2 da revisão do script).
  const REQUEST_CEILING = 400;
  if (members.length + 1 > REQUEST_CEILING) {
    throw new Error(
      `Coleta maior que o teto de ${REQUEST_CEILING} requisições (${members.length} membros) — use "Resumo (1 requisição)" ou aumente o teto nas configurações do jogo.`,
    );
  }
  const parsePage = kind === 'troops' ? parseMemberVillageTroops : parseMemberVillageDefense;
  const entries: TroopEntry[] = [];
  const defenseRows: DefenseVillageEntry[] = [];
  const failures: NonNullable<TroopSnapshot['failures']> = [];
  let cancelled = false;

  for (let i = 0; i < members.length; i += 1) {
    if (shouldCancel()) {
      // Cancelamento ENTRE membros: mantém o parcial já coletado.
      cancelled = true;
      break;
    }
    const member = members[i];
    if (member === undefined) continue;
    onProgress(i + 1, members.length, member.name);
    try {
      const firstBody = await pacedGet(`${base}&player_id=${member.playerId}&page=1`);
      // Própria conta: o jogo devolve o resumo por jogador (sem tabela por aldeia).
      if (!firstBody.includes('vis w100') || isMemberSummaryPage(firstBody)) {
        failures.push({ playerName: member.name, reason: OWN_ACCOUNT_NOTE });
        continue;
      }
      // Dedupe defensivo entre páginas: se o jogo ignorar o page param e
      // devolver as mesmas aldeias, não duplica entradas.
      const seenVillages = new Set<number>();
      const pushVillages = (villages: readonly MemberVillage[]): void => {
        for (const village of villages) {
          if (seenVillages.has(village.villageId)) continue;
          seenVillages.add(village.villageId);
          if ('unitsInVillage' in village) {
            entries.push({
              playerId: member.playerId,
              playerName: member.name,
              coord: village.coord,
              villageId: village.villageId,
              villageName: village.name,
              units: village.unitsInVillage,
            });
            defenseRows.push({
              playerId: member.playerId,
              playerName: member.name,
              villageId: village.villageId,
              name: village.name,
              coord: village.coord,
              points: village.points,
              unitsInVillage: village.unitsInVillage,
              unitsInTransit: village.unitsInTransit,
            });
          } else {
            entries.push({
              playerId: member.playerId,
              playerName: member.name,
              coord: village.coord,
              villageId: village.villageId,
              villageName: village.name,
              units: village.units,
            });
          }
        }
      };
      pushVillages(parsePage(firstBody).villages);
      // Paginação: páginas extras do pager (paged-nav-item). Falha de página não
      // descarta as já coletadas — registra e segue (mesma resiliência do app).
      for (const page of extractPagedNavPages(firstBody)) {
        if (shouldCancel()) {
          // Cancelamento ENTRE páginas (nunca no meio de um GET).
          cancelled = true;
          break;
        }
        if (page > MAX_PAGES_PER_MEMBER) {
          failures.push({
            playerName: member.name,
            reason: `Mais de ${MAX_PAGES_PER_MEMBER} páginas de aldeias — coleta interrompida na página ${MAX_PAGES_PER_MEMBER}.`,
          });
          break;
        }
        const pageBody = await pacedGet(`${base}&player_id=${member.playerId}&page=${page}`);
        pushVillages(parsePage(pageBody).villages);
      }
    } catch (error) {
      // Sessão expirou/captcha: sentinela aborta a coleta INTEIRA (fail-fast).
      if (error instanceof SessionRequiredError || error instanceof CaptchaDetectedError) throw error;
      failures.push({
        playerName: member.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const snapshot: TroopSnapshot = {
    kind,
    source: 'per-member',
    collectedAt: new Date().toISOString(),
    entries,
    ...(failures.length > 0 ? { failures } : {}),
  };
  const defenseVillages: DefenseSnapshot | null =
    kind === 'defense'
      ? { kind: 'defense', collectedAt: snapshot.collectedAt, entries: defenseRows }
      : null;
  return { snapshot, defenseVillages, cancelled };
}

// ---------------------------------------------------------------------------
// UI (DOM puro no Shadow DOM — classes shs-*)
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined && className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const fmt = (value: number): string => value.toLocaleString('pt-BR');
const signed = (delta: number): string => (delta >= 0 ? `+${fmt(delta)}` : fmt(delta));

function fmtIso(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString('pt-BR') : iso;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numInput(placeholder: string, value: string, width: string): HTMLInputElement {
  const input = el('input', 'shs-input');
  input.type = 'number';
  input.min = '0';
  input.placeholder = placeholder;
  input.title = placeholder;
  input.value = value;
  input.style.width = width;
  return input;
}

/** Rótulo da fonte da coleta ("resumo"/"por membro") + sufixo de falhas. */
function sourceLabel(snapshot: TroopSnapshot): string {
  return snapshot.source === 'summary' ? 'resumo' : 'por membro';
}

function failuresSuffix(snapshot: TroopSnapshot): string {
  const count = snapshot.failures?.length ?? 0;
  return count > 0 ? ` · ${count} membro(s) com falha` : '';
}

function renderSection(container: HTMLElement): void {
  container.textContent = '';
  let world: string;
  try {
    world = currentWorld();
  } catch (error) {
    container.appendChild(el('p', 'shs-danger', errorMessage(error)));
    return;
  }

  // ---- Linha de coleta ----
  const collectRow = el('div', 'shs-row');
  const btnTroops = el('button', 'shs-btn', 'Coletar tropas (membros)');
  const btnDefense = el('button', 'shs-btn', 'Coletar defesa (membros)');
  const btnSummary = el('button', 'shs-btn shs-btn-ghost', 'Resumo (1 requisição)');
  const btnCancel = el('button', 'shs-btn shs-btn-ghost', 'Cancelar');
  btnCancel.disabled = true;
  const progress = el('span', 'shs-muted');
  collectRow.append(btnTroops, btnDefense, btnSummary, btnCancel, progress);
  container.appendChild(collectRow);
  container.appendChild(
    el(
      'p',
      'shs-muted',
      'Coleta por membro: 1 requisição por membro (pacing anti-ban) + páginas extras. O resumo substitui a última coleta de tropas (uma posição por tipo). O cancelamento interrompe a coleta entre membros e mantém o parcial já coletado.',
    ),
  );

  const message = el('div', 'shs-muted');
  const statusLine = el('div', 'shs-muted');
  container.append(message, statusLine);

  // ---- Abas internas ----
  const tabDefs = [
    { id: 'resumo', label: 'Resumo' },
    { id: 'fullsemi', label: 'Full/Semi' },
    { id: 'defesa', label: 'Defesa' },
    { id: 'historico', label: 'Histórico' },
  ] as const;
  type TabId = (typeof tabDefs)[number]['id'];
  let activeTab: TabId = 'resumo';
  const tabsRow = el('div', 'shs-row');
  const tabBody = el('div');
  container.append(tabsRow, tabBody);

  function setMsg(text: string, kind: 'ok' | 'err' | 'muted'): void {
    message.textContent = text;
    message.className = kind === 'ok' ? 'shs-ok' : kind === 'err' ? 'shs-danger' : 'shs-muted';
  }

  function setBusy(busy: boolean): void {
    btnTroops.disabled = busy;
    btnDefense.disabled = busy;
    btnSummary.disabled = busy;
  }

  /** Pedido de cancelamento da coleta por membro — checado só ENTRE GETs. */
  let cancelRequested = false;

  function copyText(text: string, okMessage: string): void {
    navigator.clipboard.writeText(text).then(
      () => setMsg(okMessage, 'ok'),
      () => setMsg('Não foi possível copiar — permissão de área de transferência negada.', 'err'),
    );
  }

  function renderStatus(): void {
    const troops = loadTroopsSnapshot(world);
    const defense = loadDefenseStore(world).snapshot;
    const part = (label: string, snap: TroopSnapshot | null): string =>
      snap === null
        ? `${label}: nunca coletado`
        : `${label}: ${fmtIso(snap.collectedAt)} · ${sourceLabel(snap)} · ${fmt(snap.entries.length)} entrada(s)`;
    statusLine.textContent = `${part('Tropas', troops)} — ${part('Defesa', defense)}`;
  }

  function renderTabs(): void {
    tabsRow.textContent = '';
    for (const def of tabDefs) {
      const tab = el('button', 'shs-tab', def.label);
      tab.dataset.active = String(def.id === activeTab);
      tab.addEventListener('click', () => {
        activeTab = def.id;
        renderTabs();
        renderTabBody();
      });
      tabsRow.appendChild(tab);
    }
  }

  function renderTabBody(): void {
    tabBody.textContent = '';
    if (activeTab === 'resumo') renderResumo(tabBody);
    else if (activeTab === 'fullsemi') renderFullSemi(tabBody);
    else if (activeTab === 'defesa') renderDefesa(tabBody);
    else renderHistorico(tabBody);
  }

  // -------------------------------------------------------------------------
  // Aba RESUMO — sg2-summary (filtro por jogador + totais por jogador)
  // -------------------------------------------------------------------------

  function renderResumo(root: HTMLElement): void {
    const loaded = loadTroopsSnapshot(world);
    if (loaded === null) {
      root.appendChild(el('p', 'shs-muted', 'Colete as tropas para ver o resumo.'));
      return;
    }
    const snapshot: TroopSnapshot = loaded;
    const filters = el('div', 'shs-row');
    const nameInput = el('input', 'shs-input');
    nameInput.placeholder = 'Filtrar por jogador (contém)';
    const copyBtn = el('button', 'shs-btn shs-btn-ghost', 'Copiar resumo (TSV)');
    copyBtn.disabled = true;
    filters.append(nameInput, copyBtn);
    root.appendChild(filters);

    const meta = el('div');
    const tableWrap = el('div');
    root.append(meta, tableWrap);
    let tsv = '';

    function draw(): void {
      tableWrap.textContent = '';
      meta.textContent = '';
      copyBtn.disabled = true;
      let summary: Sg2Summary;
      try {
        const query = nameInput.value.trim();
        summary = summarizeSnapshot(snapshot, query === '' ? undefined : { playerQuery: query });
      } catch (error) {
        meta.appendChild(el('p', 'shs-danger', errorMessage(error)));
        return;
      }
      if (summary.summaryOnly) {
        meta.appendChild(
          el(
            'p',
            'shs-muted',
            'Coleta em modo Resumo (por jogador): não traz aldeias — use "Coletar tropas (membros)" para o detalhe por aldeia.',
          ),
        );
      }
      const table = el('table');
      const headRow = el('tr');
      for (const label of [
        'Jogador',
        'Aldeias',
        'Ofensivas',
        'Defensivas',
        'Vazias',
        'Pop Off',
        'Pop Def',
        ...SUMMARY_UNIT_ORDER.map((id) => UNITS[id].name),
      ]) {
        headRow.appendChild(el('th', undefined, label));
      }
      const thead = el('thead');
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = el('tbody');
      for (const row of summary.byPlayer) {
        const tr = el('tr');
        tr.appendChild(el('td', undefined, row.playerName));
        for (const value of [
          row.villageCount,
          row.offensiveCount,
          row.defensiveCount,
          row.emptyCount,
          row.offPop,
          row.defPop,
        ]) {
          tr.appendChild(el('td', undefined, fmt(value)));
        }
        for (const id of SUMMARY_UNIT_ORDER) {
          tr.appendChild(el('td', undefined, fmt(row.units[id] ?? 0)));
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);

      const tfoot = el('tfoot');
      const totalsRow = el('tr');
      totalsRow.appendChild(el('th', undefined, 'Totais'));
      for (const value of [
        summary.totals.villages,
        summary.totals.offensive,
        summary.totals.defensive,
        summary.totals.empty,
        summary.totals.offPop,
        summary.totals.defPop,
      ]) {
        totalsRow.appendChild(el('td', undefined, fmt(value)));
      }
      for (const id of SUMMARY_UNIT_ORDER) {
        totalsRow.appendChild(el('td', undefined, fmt(summary.totals.units[id] ?? 0)));
      }
      tfoot.appendChild(totalsRow);
      table.appendChild(tfoot);
      tableWrap.appendChild(table);

      if (summary.byPlayer.length === 0) {
        tableWrap.appendChild(el('p', 'shs-muted', 'Nenhuma linha corresponde ao filtro.'));
      } else {
        tsv = formatSummaryPlayerTsv(summary.byPlayer);
        copyBtn.disabled = false;
      }
    }

    nameInput.addEventListener('input', () => draw());
    copyBtn.addEventListener('click', () => copyText(tsv, 'Resumo copiado (TSV).'));
    draw();
  }

  // -------------------------------------------------------------------------
  // Aba FULL/SEMI — full-semi report (população por unidade do unit-info)
  // -------------------------------------------------------------------------

  function renderFullSemi(root: HTMLElement): void {
    const form = el('div', 'shs-row');
    const fullInput = numInput('Pop FULL', FULL_POP_DEFAULT, '90px');
    const semiInput = numInput('Pop SEMI', SEMI_POP_DEFAULT, '90px');
    const calcBtn = el('button', 'shs-btn', 'Calcular Full/Semi');
    const copyBtn = el('button', 'shs-btn shs-btn-ghost', 'Copiar Full/Semi');
    copyBtn.disabled = true;
    form.append(fullInput, semiInput, calcBtn, copyBtn);
    root.appendChild(form);

    const meta = el('div');
    const out = el('div');
    root.append(meta, out);
    let rowsText = '';

    calcBtn.addEventListener('click', () => {
      void (async () => {
        meta.textContent = '';
        out.textContent = '';
        copyBtn.disabled = true;
        setMsg('', 'muted');
        const snapshot = loadTroopsSnapshot(world);
        if (snapshot === null) {
          meta.appendChild(el('p', 'shs-muted', 'Colete as tropas primeiro.'));
          return;
        }
        if (snapshot.source === 'summary') {
          meta.appendChild(
            el('p', 'shs-muted', 'A coleta em modo Resumo não traz aldeias — use "Coletar tropas (membros)".'),
          );
          return;
        }
        calcBtn.disabled = true;
        let pops: Record<string, number>;
        try {
          pops = await unitPops(world);
        } catch {
          pops = catalogPops();
          meta.appendChild(
            el('p', 'shs-muted', 'População por unidade do mundo indisponível — usando os valores padrão do catálogo.'),
          );
        }
        try {
          const report = fullSemiReport(
            { entries: snapshot.entries, popByUnit: pops },
            { fullPop: Number(fullInput.value), semiPop: Number(semiInput.value) },
          );
          if (report.unknownUnits.length > 0) {
            meta.appendChild(
              el('p', 'shs-muted', `Unidades sem população no mundo (contam 0): ${report.unknownUnits.join(', ')}.`),
            );
          }
          meta.appendChild(
            el(
              'p',
              'shs-muted',
              `FULL ≥ ${fmt(Number(fullInput.value))} · SEMI ≥ ${fmt(Number(semiInput.value))} — ${fmt(report.totals.players)} jogador(es), ${fmt(report.totals.fulls)} full, ${fmt(report.totals.semis)} semi.`,
            ),
          );
          const table = el('table');
          const headRow = el('tr');
          for (const label of ['Jogador', 'Fulls', 'Semis', 'Coordenadas']) {
            headRow.appendChild(el('th', undefined, label));
          }
          const thead = el('thead');
          thead.appendChild(headRow);
          table.appendChild(thead);
          const tbody = el('tbody');
          for (const player of report.players) {
            const tr = el('tr');
            tr.appendChild(el('td', undefined, player.playerName));
            tr.appendChild(el('td', undefined, fmt(player.fulls)));
            tr.appendChild(el('td', undefined, fmt(player.semis)));
            tr.appendChild(el('td', undefined, player.villages.map((village) => village.coord).join(' ')));
            tbody.appendChild(tr);
          }
          table.appendChild(tbody);
          out.appendChild(table);
          if (report.players.length === 0) {
            out.appendChild(el('p', 'shs-muted', 'Nenhum jogador atingiu o limiar SEMI.'));
          } else {
            rowsText = formatFullSemiRows(report.players);
            copyBtn.disabled = false;
          }
        } catch (error) {
          meta.appendChild(el('p', 'shs-danger', errorMessage(error)));
        } finally {
          calcBtn.disabled = false;
        }
      })();
    });
    copyBtn.addEventListener('click', () => copyText(rowsText, 'Full/Semi copiado.'));
  }

  // -------------------------------------------------------------------------
  // Aba DEFESA — sg3-engine (blind por aldeia vs. stack desejado)
  // -------------------------------------------------------------------------

  function renderDefesa(root: HTMLElement): void {
    const defense = loadDefenseStore(world).defenseVillages;
    if (defense === null || defense.entries.length === 0) {
      root.appendChild(
        el('p', 'shs-muted', 'Sem defesa por aldeia — use "Coletar defesa (membros)" para consultar o blind.'),
      );
      return;
    }

    const form = el('div', 'shs-row');
    const desiredInputs: Partial<Record<UnitId, HTMLInputElement>> = {};
    for (const unit of BLIND_UNITS) {
      const input = numInput(UNITS[unit].name, '', '110px');
      desiredInputs[unit] = input;
      form.appendChild(input);
    }
    const modeSelect = el('select', 'shs-input');
    modeSelect.title = 'Contagem da blind';
    const optParadas = el('option', undefined, 'Paradas');
    optParadas.value = 'paradas';
    const optTransito = el('option', undefined, 'Paradas + a caminho');
    optTransito.value = 'paradas-e-transito';
    modeSelect.append(optParadas, optTransito);
    const coordsInput = el('input', 'shs-input');
    coordsInput.placeholder = 'Coordenadas "x|y" (vazio = todas as aldeias)';
    const runBtn = el('button', 'shs-btn', 'Verificar blind');
    const copyBtn = el('button', 'shs-btn shs-btn-ghost', 'Copiar blind (BBCode)');
    copyBtn.disabled = true;
    form.append(modeSelect, coordsInput, runBtn, copyBtn);
    root.appendChild(form);

    const meta = el('div');
    const out = el('div');
    root.append(meta, out);
    let bbcode = '';

    runBtn.addEventListener('click', () => {
      meta.textContent = '';
      out.textContent = '';
      copyBtn.disabled = true;
      setMsg('', 'muted');
      const desiredUnits: Partial<UnitCounts> = {};
      for (const unit of BLIND_UNITS) {
        const raw = desiredInputs[unit]?.value ?? '';
        if (raw.trim() === '') continue;
        const value = Number(raw.replace(/\./g, ''));
        if (Number.isFinite(value) && value > 0) desiredUnits[unit] = value;
      }
      if (Object.keys(desiredUnits).length === 0) {
        meta.appendChild(el('p', 'shs-danger', 'Informe ao menos uma unidade desejada (ex.: lanceiros/espadachins).'));
        return;
      }
      const normalized = normalizeCoordText(coordsInput.value);
      if (normalized.invalidTokens > 0) {
        meta.appendChild(
          el('p', 'shs-muted', `${normalized.invalidTokens} trecho(s) inválido(s) ignorado(s) no filtro de coordenadas.`),
        );
      }
      const results = checkBlind({
        defense,
        desiredUnits,
        countMode: modeSelect.value === 'paradas-e-transito' ? 'paradas-e-transito' : 'paradas',
        coordsFilter: parseCoordList(normalized.display),
      });
      if (results.length === 0) {
        meta.appendChild(el('p', 'shs-ok', 'Nenhuma aldeia com falta — blind em dia.'));
        return;
      }
      meta.appendChild(el('p', 'shs-muted', `${fmt(results.length)} aldeia(s) com falta (ordem: jogador, coordenada).`));
      const table = el('table');
      const headRow = el('tr');
      for (const label of ['Jogador', 'Aldeia', 'Coordenada', 'Falta']) {
        headRow.appendChild(el('th', undefined, label));
      }
      const thead = el('thead');
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = el('tbody');
      for (const result of results) {
        const tr = el('tr');
        tr.appendChild(el('td', undefined, result.playerName));
        tr.appendChild(el('td', undefined, result.villageName));
        tr.appendChild(el('td', undefined, `${result.coord.x}|${result.coord.y}`));
        tr.appendChild(
          el(
            'td',
            undefined,
            Object.entries(result.missing)
              .map(([unit, amount]) => `${UNITS[unit as UnitId]?.name ?? unit} ${fmt(amount ?? 0)}`)
              .join(', '),
          ),
        );
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      out.appendChild(table);
      bbcode = blindBbcodeTable(results);
      copyBtn.disabled = false;
    });
    copyBtn.addEventListener('click', () => copyText(bbcode, 'Blind copiado (BBCode).'));
  }

  // -------------------------------------------------------------------------
  // Aba HISTÓRICO — member-audit (diff das 2 últimas versões + estagnação)
  // -------------------------------------------------------------------------

  function renderHistorico(root: HTMLElement): void {
    const ordered = capHistory(loadHistory(world));
    const latest = ordered[0];
    if (latest === undefined) {
      root.appendChild(
        el('p', 'shs-muted', 'Sem histórico — cada coleta de tropas (membros) arquiva uma versão agregada por jogador (cap 20).'),
      );
      return;
    }
    root.appendChild(
      el(
        'p',
        'shs-muted',
        `${fmt(ordered.length)} versão(ões) arquivada(s) · mais recente: ${fmtIso(latest.collectedAt)} (${latest.source === 'summary' ? 'resumo' : 'por membro'}).`,
      ),
    );

    const previous = ordered[1];
    if (previous === undefined) {
      root.appendChild(el('p', 'shs-muted', 'Apenas 1 versão arquivada — colete de novo para comparar.'));
      return;
    }

    const diff = diffTroopsVersions(previous, latest);
    const signals = auditSignals(diff);

    const copyBtn = el('button', 'shs-btn shs-btn-ghost', 'Copiar diff (TSV)');
    root.appendChild(copyBtn);
    copyBtn.addEventListener('click', () => {
      copyText(formatAuditDiffTsv(diff), 'Diff copiado (TSV).');
    });

    root.appendChild(el('strong', undefined, `Comparando ${fmtIso(previous.collectedAt)} → ${fmtIso(latest.collectedAt)}`));
    const table = el('table');
    const headRow = el('tr');
    for (const label of ['Jogador', 'Δ Pop Off', 'Δ Pop Def', 'Δ Aldeias', 'Novo']) {
      headRow.appendChild(el('th', undefined, label));
    }
    const thead = el('thead');
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const row of diff) {
      const tr = el('tr');
      tr.appendChild(el('td', undefined, row.playerName));
      tr.appendChild(el('td', undefined, signed(row.offPopDelta)));
      tr.appendChild(el('td', undefined, signed(row.defPopDelta)));
      tr.appendChild(el('td', undefined, signed(row.villageCountDelta)));
      tr.appendChild(el('td', undefined, row.isNew ? 'sim' : '—'));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    root.appendChild(table);

    // Sinais de auditoria entre as duas versões.
    root.appendChild(el('strong', undefined, 'Sinais de auditoria'));
    if (signals.length === 0) {
      root.appendChild(el('p', 'shs-muted', 'Nenhum sinal no período.'));
    } else {
      const signalTable = el('table');
      const signalHead = el('tr');
      for (const label of ['Sinal', 'Jogador', 'Δ Pop Off', 'Δ Pop Def', 'Δ Aldeias']) {
        signalHead.appendChild(el('th', undefined, label));
      }
      const signalThead = el('thead');
      signalThead.appendChild(signalHead);
      signalTable.appendChild(signalThead);
      const signalBody = el('tbody');
      for (const signal of signals) {
        const tr = el('tr');
        tr.appendChild(el('td', undefined, AUDIT_SIGNAL_LABEL[signal.kind]));
        tr.appendChild(el('td', undefined, signal.playerName));
        tr.appendChild(el('td', undefined, signed(signal.offPopDelta)));
        tr.appendChild(el('td', undefined, signed(signal.defPopDelta)));
        tr.appendChild(el('td', undefined, signed(signal.villageCountDelta)));
        signalBody.appendChild(tr);
      }
      signalTable.appendChild(signalBody);
      root.appendChild(signalTable);
    }

    // Estagnação/declínio na JANELA CHEIA (todas as versões arquivadas).
    const stagnant = detectStagnation(ordered);
    root.appendChild(el('strong', undefined, 'Estagnação/declínio (janela cheia)'));
    if (stagnant.length === 0) {
      root.appendChild(el('p', 'shs-muted', 'Nenhum jogador estagnado ou em declínio.'));
    } else {
      const stagTable = el('table');
      const stagHead = el('tr');
      for (const label of ['Jogador', 'Situação', 'Δ Pop Off', 'Δ Aldeias', 'Presenças']) {
        stagHead.appendChild(el('th', undefined, label));
      }
      const stagThead = el('thead');
      stagThead.appendChild(stagHead);
      stagTable.appendChild(stagThead);
      const stagBody = el('tbody');
      for (const signal of stagnant) {
        const tr = el('tr');
        tr.appendChild(el('td', undefined, signal.playerName));
        tr.appendChild(el('td', undefined, STAGNATION_LABEL[signal.kind]));
        tr.appendChild(el('td', undefined, signed(signal.offPopDelta)));
        tr.appendChild(el('td', undefined, signed(signal.villagesDelta)));
        tr.appendChild(el('td', undefined, fmt(signal.versionsPresent)));
        stagBody.appendChild(tr);
      }
      stagTable.appendChild(stagBody);
      root.appendChild(stagTable);
    }
  }

  // -------------------------------------------------------------------------
  // Ações de coleta
  // -------------------------------------------------------------------------

  async function runMemberCollect(kind: TroopKind): Promise<void> {
    setBusy(true);
    cancelRequested = false;
    btnCancel.disabled = false;
    setMsg('', 'muted');
    progress.textContent = 'Lendo membros da tribo…';
    let lastDone = 0;
    let lastTotal = 0;
    try {
      const { snapshot, defenseVillages, cancelled } = await collectMembers(
        kind,
        (done, total, nick) => {
          lastDone = done;
          lastTotal = total;
          progress.textContent = `Coletando ${done}/${total} — ${nick}`;
        },
        () => cancelRequested,
      );
      saveCollected(world, snapshot, defenseVillages);
      progress.textContent = '';
      const label = kind === 'troops' ? 'Tropas' : 'Defesa';
      if (cancelled) {
        // Parcial fica coletado (uma posição por tipo, como a coleta completa),
        // mas NÃO vira versão do histórico — diff com dados parciais geraria
        // sinais falsos de auditoria/estagnação.
        const membros = lastTotal > 0 ? `${fmt(lastDone)} de ${fmt(lastTotal)} membros` : 'nenhum membro processado';
        setMsg(
          `Coleta cancelada — dados parciais (${membros}): ${fmt(snapshot.entries.length)} aldeia(s)${failuresSuffix(snapshot)}.`,
          'err',
        );
      } else {
        const archived = archiveHistory(world, snapshot);
        const emptyWarning = snapshot.entries.length === 0 ? ' · NENHUMA entrada coletada' : '';
        setMsg(
          `${label} coletadas: ${fmt(snapshot.entries.length)} aldeia(s)${failuresSuffix(snapshot)}${archived ? ' · versão arquivada no histórico' : ''}${emptyWarning}`,
          snapshot.entries.length > 0 ? 'ok' : 'err',
        );
      }
      renderStatus();
      renderTabBody();
    } catch (error) {
      progress.textContent = '';
      setMsg(errorMessage(error), 'err');
    } finally {
      btnCancel.disabled = true;
      cancelRequested = false;
      setBusy(false);
    }
  }

  async function runSummaryCollect(): Promise<void> {
    setBusy(true);
    setMsg('', 'muted');
    progress.textContent = 'Coletando resumo…';
    try {
      const snapshot = await collectSummary('troops');
      saveCollected(world, snapshot, null);
      progress.textContent = '';
      setMsg(
        `Resumo de tropas coletado: ${fmt(snapshot.entries.length)} jogador(es).${snapshot.entries.length === 0 ? ' Página sem tabela (confira a tribo).' : ''}`,
        snapshot.entries.length > 0 ? 'ok' : 'muted',
      );
      renderStatus();
      renderTabBody();
    } catch (error) {
      progress.textContent = '';
      setMsg(errorMessage(error), 'err');
    } finally {
      setBusy(false);
    }
  }

  btnTroops.addEventListener('click', () => void runMemberCollect('troops'));
  btnDefense.addEventListener('click', () => void runMemberCollect('defense'));
  btnSummary.addEventListener('click', () => void runSummaryCollect());
  btnCancel.addEventListener('click', () => {
    // Checado ENTRE membros e ENTRE páginas — nunca interrompe um GET no meio.
    cancelRequested = true;
    btnCancel.disabled = true;
  });

  renderTabs();
  renderStatus();
  renderTabBody();
}

registerSection({
  id: 'sg23',
  label: 'Tropas & Defesa',
  render: renderSection,
});
