// Módulo "OD de guerra" (ODA/ODD) — kills ofensivos/defensivos da tribo.
//
// Fonte: dumps oficiais do mundo /map/kill_att_tribe.txt.gz e
// /map/kill_def_tribe.txt.gz — TSV `rank\ttribeId\tnome\tkills` com o total
// CUMULATIVO de kills da tribo. São arquivos BINÁRIOS gzip: o pacedGet do
// core/net devolve texto, então aqui existe um pacedBinaryGet próprio com a
// MESMA semântica de enfileiramento (uma chamada por vez, ≥200ms entre elas —
// o enqueue de core/net não é exportado; duplicação deliberada e local), e a
// descompressão é feita no navegador via DecompressionStream('gzip').
//
// Regras:
// - A API do jogo permite 1 download por hora por arquivo: guarda lastFetch
//   por tipo; dentro de 1h reaproveita a última leitura e marca "cache (<1h)"
//   na UI, sem re-fetch.
// - Histórico { fetchedAt, kills } por tipo no GM storage (chave por mundo),
//   teto de 60 leituras por tipo (capOdaOddHistory) e curva com delta entre
//   leituras (buildOdaOddHistory) — engines puras reusadas de @shared, zero
//   cópia. Parse fail-closed (parseKillsTribeFile): dump estranho lança com
//   mensagem clara, nunca mostra número silenciosamente errado.
// - Somente leitura (GET same-origin, credentials do jogo): nenhum POST sai
//   daqui. Trocou o ID da tribo? O histórico é reiniciado — delta contra
//   outra tribo seria curva da guerra errada.

import {
  buildOdaOddHistory,
  capOdaOddHistory,
  diffTribeKills,
  parseKillsTribeFile,
  type OdaOddHistoryRow,
  type TribeKillsRow,
  type TribeKillsSnapshot,
} from '@shared/oda-odd';
import { gameContext } from '../core/shell';
import { enqueue } from '../core/net';
import { gm, worldKey } from '../core/storage';
import { card, el, empty, pill, table } from '../core/ui';

/** Tipos de dump de kills (att = ODA ofensivo, def = ODD defensivo). */
const KINDS = {
  att: { label: 'ODA', path: '/map/kill_att_tribe.txt.gz' },
  def: { label: 'ODD', path: '/map/kill_def_tribe.txt.gz' },
} as const;

type KillKind = keyof typeof KINDS;

/** Guarda da API do jogo: 1 download por arquivo por hora. */
const HOUR_MS = 3_600_000;

/** Estado persistido de UM tipo de dump (ordem cronológica, mais recente no fim). */
interface KindState {
  snapshots: TribeKillsSnapshot[];
  lastFetchAt: string | null;
}

/** Estado persistido do módulo — chave GM worldKey(world, 'oda-odd'). */
interface OdaOddPersisted {
  tribeId: string;
  att: KindState;
  def: KindState;
}

/** Linha combinada da tabela (ODA e ODD alinhados pela mesma leitura). */
interface MergedRow {
  date: string;
  att: OdaOddHistoryRow | null;
  def: OdaOddHistoryRow | null;
}

/** Resultado de uma atualização de um tipo, para o resumo na UI. */
interface KindUpdate {
  kind: KillKind;
  reused: boolean;
  kills: number;
  delta: number | null;
}

function emptyKind(): KindState {
  return { snapshots: [], lastFetchAt: null };
}

function emptyStore(tribeId: string): OdaOddPersisted {
  return { tribeId, att: emptyKind(), def: emptyKind() };
}

// --- rede binária (MESMA cadeia de pacing do core/net — P2 da revisão) ------

/**
 * GET same-origin de conteúdo BINÁRIO (dumps .gz) através do enqueue
 * compartilhado do core: a invariante ≥200ms entre QUALQUER par de
 * requisições é global (GETs de texto e binários na mesma fila).
 */
function pacedBinaryGet(path: string): Promise<ArrayBuffer> {
  const url = new URL(path, window.location.origin).toString();
  return enqueue(async () => {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${String(response.status)} em ${path}`);
    return response.arrayBuffer();
  });
}

/** Assinatura gzip (bytes 0x1f 0x8b) — o dump nasce comprimido no disco. */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Bytes do dump → texto TSV. Caminho normal: descomprime gzip no navegador
 * (DecompressionStream('gzip') sobre o ReadableStream do corpo). Se o servidor
 * já entregou texto puro (Content-Encoding: gzip resolvido pelo navegador), os
 * bytes não terão a assinatura e seguem direto para o parse — em qualquer
 * cenário o TSV integral chega ao parseKillsTribeFile, que é fail-closed.
 */
async function decodeDump(path: string, buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  if (!isGzip(bytes)) return new TextDecoder().decode(bytes);
  try {
    const compressed = new Response(bytes).body;
    if (compressed === null) throw new Error('corpo vazio');
    const decompressed = compressed.pipeThrough(new DecompressionStream('gzip'));
    return await new Response(decompressed).text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Não foi possível descomprimir ${path} (gzip): ${detail}`);
  }
}

/** Procura a tribo no dump; ID ausente é erro claro, não 0 silencioso. */
function killsOfTribe(rows: readonly TribeKillsRow[], tribeId: string, path: string): TribeKillsRow {
  const id = Number(tribeId);
  const found = rows.find((row) => row.tribeId === id);
  if (found === undefined) {
    throw new Error(`Tribo ${tribeId} não encontrada em ${path} — confira o ID da tribo.`);
  }
  return found;
}

// --- atualização de UM tipo de dump -----------------------------------------

async function updateKind(store: OdaOddPersisted, kind: KillKind, nowIso: string): Promise<KindUpdate> {
  const spec = KINDS[kind];
  const state = store[kind];
  const latest = state.snapshots.length > 0 ? (state.snapshots[state.snapshots.length - 1] ?? null) : null;

  // Guarda de 1/hora por arquivo: dentro da janela, reaproveita sem re-fetch.
  const fetchedAtMs = state.lastFetchAt === null ? Number.NaN : Date.parse(state.lastFetchAt);
  if (latest !== null && !Number.isNaN(fetchedAtMs) && Date.now() - fetchedAtMs < HOUR_MS) {
    return { kind, reused: true, kills: latest.kills, delta: null };
  }

  const body = await decodeDump(spec.path, await pacedBinaryGet(spec.path));
  const row = killsOfTribe(parseKillsTribeFile(body), store.tribeId, spec.path);
  const delta = diffTribeKills(latest, row.kills)?.delta ?? null;
  state.snapshots = capOdaOddHistory([...state.snapshots, { fetchedAt: nowIso, kills: row.kills }]);
  state.lastFetchAt = nowIso;
  return { kind, reused: false, kills: row.kills, delta };
}

// --- formatação -------------------------------------------------------------

function fmtKills(value: number): string {
  return value.toLocaleString('pt-BR');
}

function deltaText(delta: number | null): string {
  if (delta === null) return '—';
  return `${delta > 0 ? '+' : ''}${delta.toLocaleString('pt-BR')}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Resumo do clique: o que veio do cache (<1h) e o que foi baixado (com Δ). */
function describeUpdates(updates: readonly KindUpdate[]): string {
  return updates
    .map((update) => {
      const label = KINDS[update.kind].label;
      if (update.reused) return `${label}: cache (<1h)`;
      const delta = update.delta === null ? '' : ` (Δ ${deltaText(update.delta)})`;
      return `${label}: atualizado${delta}`;
    })
    .join(' · ');
}

// --- render -----------------------------------------------------------------

/** Histórico por tipo (fail-closed via buildOdaOddHistory) mesclado por data, mais recente primeiro. */
function mergedRows(store: OdaOddPersisted): MergedRow[] {
  const byDate = new Map<string, MergedRow>();
  const collect = (kind: KillKind): void => {
    const state = store[kind];
    if (state.snapshots.length === 0) return;
    for (const entry of buildOdaOddHistory(state.snapshots, store.tribeId)) {
      const existing = byDate.get(entry.date);
      const row = existing ?? { date: entry.date, att: null, def: null };
      row[kind] = entry;
      if (existing === undefined) byDate.set(entry.date, row);
    }
  };
  collect('att');
  collect('def');
  return Array.from(byDate.values()).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

function renderHistoryTable(host: HTMLElement, store: OdaOddPersisted): void {
  const rows = mergedRows(store);
  const latestAtt = store.att.snapshots.length > 0 ? (store.att.snapshots[store.att.snapshots.length - 1] ?? null) : null;
  const latestDef = store.def.snapshots.length > 0 ? (store.def.snapshots[store.def.snapshots.length - 1] ?? null) : null;

  const dataRows = rows.map((row) => [
    formatDate(row.date),
    row.att === null ? '—' : `${fmtKills(row.att.kills)} (${deltaText(row.att.delta)})`,
    row.def === null ? '—' : `${fmtKills(row.def.kills)} (${deltaText(row.def.delta)})`,
  ]);
  const history = table(['Data', 'ODA (Δ)', 'ODD (Δ)'], dataRows);

  // Totais atuais = última leitura arquivada de cada tipo (tfoot fora do
  // helper table(), que só cobre thead+tbody).
  const tfoot = document.createElement('tfoot');
  const footRow = document.createElement('tr');
  const footCells = [
    'Total atual',
    latestAtt === null ? '—' : fmtKills(latestAtt.kills),
    latestDef === null ? '—' : fmtKills(latestDef.kills),
  ];
  for (const text of footCells) {
    const td = document.createElement('td');
    td.textContent = text;
    footRow.appendChild(td);
  }
  tfoot.appendChild(footRow);
  history.appendChild(tfoot);

  host.appendChild(el('div', { className: 'shs-tablewrap' }, history));
}

/**
 * Seção "OD de guerra" do shell (matchScreen: undefined — todas as telas).
 * Monta o formulário ID da tribo + Atualizar e a tabela Data | ODA (Δ) | ODD (Δ).
 */
export function renderOda(container: HTMLElement): void {
  container.innerHTML = '';

  const section = card('OD de guerra');
  container.appendChild(section);

  section.appendChild(
    el('p', {
      className: 'shs-muted',
      text: 'Kills acumulados da tribo nos dumps oficiais do mundo (máx. 1 download por hora por arquivo).',
    }),
  );

  const controls = document.createElement('div');
  controls.className = 'shs-row';
  const input = document.createElement('input');
  input.className = 'shs-input';
  input.type = 'text';
  input.inputMode = 'numeric';
  input.placeholder = 'ID da tribo (ex.: 1234)';
  input.style.maxWidth = '180px';
  const button = document.createElement('button');
  button.className = 'shs-btn';
  button.textContent = 'Atualizar';
  const status = document.createElement('span');
  controls.append(input, button, status);
  section.appendChild(controls);

  const tableHost = document.createElement('div');
  section.appendChild(tableHost);

  const storageKey = worldKey(gameContext().world, 'oda-odd');

  // Status/cache como pill do design system (erro em vermelho, resto neutro).
  function setStatus(text: string, error: boolean): void {
    status.replaceChildren(pill(text, error ? 'error' : 'muted'));
  }

  function draw(store: OdaOddPersisted | null): void {
    tableHost.innerHTML = '';
    if (store === null || (store.att.snapshots.length === 0 && store.def.snapshots.length === 0)) {
      tableHost.appendChild(empty('Nenhuma leitura ainda — informe o ID da tribo e clique Atualizar.'));
      return;
    }
    try {
      renderHistoryTable(tableHost, store);
    } catch (error) {
      // Histórico corrompido no storage: fail-closed com a mensagem da engine.
      tableHost.appendChild(
        el('p', { className: 'shs-danger', text: error instanceof Error ? error.message : String(error) }),
      );
    }
  }

  button.addEventListener('click', () => {
    const tribeId = input.value.trim();
    if (!/^\d+$/.test(tribeId)) {
      setStatus('Informe o ID numérico da tribo.', true);
      return;
    }
    const store = gm.get<OdaOddPersisted | null>(storageKey, null);
    const previousTribe = store?.tribeId ?? null;
    const changedTribe = previousTribe !== null && previousTribe !== tribeId;
    // Delta contra outra tribo seria curva errada: trocou o ID, recomeça.
    const active = store === null || store.tribeId !== tribeId ? emptyStore(tribeId) : store;
    button.disabled = true;
    void (async () => {
      try {
        const nowIso = new Date().toISOString();
        const updates = [await updateKind(active, 'att', nowIso), await updateKind(active, 'def', nowIso)];
        gm.set(storageKey, active);
        draw(active);
        setStatus(changedTribe ? `Tribo alterada — histórico reiniciado. ${describeUpdates(updates)}` : describeUpdates(updates), false);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), true);
      } finally {
        button.disabled = false;
      }
    })();
  });

  const stored = gm.get<OdaOddPersisted | null>(storageKey, null);
  if (stored !== null) input.value = stored.tribeId;
  draw(stored);
}

// registro: coordinator → registerSection({ id:'oda', label:'OD de guerra', render: renderOda })
