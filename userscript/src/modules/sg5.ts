// SG_5 in-game — "Conferência" ao vivo na página info_village (ferramenta nº 1
// do líder dentro do jogo). SOMENTE LEITURA: nada de gamePost neste módulo.
// Fluxo: pacedGet(info_village) → parser compartilhado → agenda de chegadas
// (sg5-arrivals) → triagem de risco (incoming-risk, defaults do app) → tabela;
// "Salvar rodada" persiste até 2 rodadas por aldeia (máx. 20 aldeias por mundo,
// LRU) e a comparação usa o motor puro @shared/sg5-diff (novos/cancelados).

import { parseIncomingCommandRows, pageLoadSec, type IncomingCommandRow } from '@shared/parsers/village-parsers';
import { diffConferences, type ConferenceSnapshot } from '@shared/sg5-diff';
import { DEFAULT_THREAT_THRESHOLDS, assessVillageThreat } from '@shared/incoming-risk';
import { gm, worldKey } from '../core/storage';
import { pacedGet } from '../core/net';
import { gameContext, registerSection } from '../core/shell';
import { mountConferenceUi, type ConferenceRound, type ConferenceUi, type SavedRoundsState, type StoredRound } from './sg5.ui';

const MAX_ROUNDS_POR_ALDEIA = 2;
const MAX_ALDEIAS = 20;

// ---------------------------------------------------------------------------
// Persistência (GM storage, namespaced por mundo):
//   shs-in-game:<world>:sg5-rounds:<villageId> → StoredRound[] (máx. 2, mais recente primeiro)
//   shs-in-game:<world>:sg5-rounds:index       → IndexEntry[]   (LRU de 20 aldeias)
// ---------------------------------------------------------------------------

interface IndexEntry {
  id: string;
  at: number;
}

function isStoredRound(value: unknown): value is StoredRound {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { savedAt?: unknown; snapshot?: unknown };
  return typeof candidate.savedAt === 'number' && Number.isFinite(candidate.savedAt) && candidate.snapshot !== null && typeof candidate.snapshot === 'object';
}

function isIndexEntry(value: unknown): value is IndexEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { id?: unknown; at?: unknown };
  return typeof candidate.id === 'string' && typeof candidate.at === 'number' && Number.isFinite(candidate.at);
}

function roundsKey(world: string | null, villageId: string): string {
  return worldKey(world, `sg5-rounds:${villageId}`);
}

function indexKey(world: string | null): string {
  return worldKey(world, 'sg5-rounds:index');
}

/** Rodadas da aldeia, mais recente primeiro (leitura fail-soft: lixo → vazio). */
function loadRounds(world: string | null, villageId: string): StoredRound[] {
  const value = gm.get<unknown>(roundsKey(world, villageId), []);
  if (!Array.isArray(value)) return [];
  return value
    .filter(isStoredRound)
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, MAX_ROUNDS_POR_ALDEIA);
}

/** Grava a rodada nova (frente), corta em 2 e aplica o LRU de 20 aldeias. */
function saveRound(world: string | null, villageId: string, snapshot: ConferenceSnapshot): StoredRound[] {
  const rounds = [{ savedAt: Date.now(), snapshot }, ...loadRounds(world, villageId)].slice(0, MAX_ROUNDS_POR_ALDEIA);
  gm.set(roundsKey(world, villageId), rounds);

  const index = gm.get<unknown>(indexKey(world), []);
  const entries = (Array.isArray(index) ? index : []).filter(isIndexEntry).filter((entry) => entry.id !== villageId);
  entries.unshift({ id: villageId, at: rounds[0]?.savedAt ?? Date.now() });
  entries.sort((a, b) => b.at - a.at);
  const kept = entries.slice(0, MAX_ALDEIAS);
  for (const evicted of entries.slice(MAX_ALDEIAS)) gm.remove(roundsKey(world, evicted.id));
  gm.set(indexKey(world), kept);
  return rounds;
}

// ---------------------------------------------------------------------------
// Coleta e derivados (mesma régua do Sg5Service do app)
// ---------------------------------------------------------------------------

function currentWorld(): string | null {
  const world = gameContext().world;
  return world === '—' ? null : world;
}

/** Aldeia inspecionada: parâmetro `id` da URL (info_village); fallback = game_data. */
function currentVillageId(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('id');
  const trimmed = fromUrl?.trim();
  if (trimmed !== undefined && trimmed !== '') return trimmed;
  const ctx = gameContext();
  return ctx.villageId === '—' ? null : ctx.villageId;
}

/** Coordenada do alvo: célula de destino das linhas; fallback = <title> da página. */
function coordFromRowsOrTitle(rows: IncomingCommandRow[], html: string): string | null {
  for (const row of rows) {
    if (row.destination.coord !== '') return row.destination.coord;
  }
  const fromTitle = /<title>[^<]*\((\d{1,3}\|\d{1,3})\)[^<]*<\/title>/.exec(html)?.[1];
  return fromTitle ?? null;
}

async function fetchRound(villageId: string): Promise<ConferenceRound> {
  const html = await pacedGet(`game.php?screen=info_village&id=${encodeURIComponent(villageId)}`, { fresh: true });
  const rows = parseIncomingCommandRows(html);
  const fetchedAt = Date.now();
  // Âncora das chegadas: Timing.init da PRÓPRIA página quando existe; sem ela,
  // o momento do fetch (mesmo fallback do sg5-service do app). Nunca parseia o
  // texto visível "hoje às …" — doutrina do parser.
  const anchorSec = pageLoadSec(html);
  const loadedAt = anchorSec !== null ? Math.round(anchorSec * 1000) : fetchedAt;
  const coord = coordFromRowsOrTitle(rows, html);
  // Triagem "vai cair?" com os mesmos defaults do app (Sg3Page). O userscript
  // não tem o DefenseSnapshot do SG_3: defesa fica desconhecida → veredito
  // fail-closed 'sem-dados' (nunca "resistente" chutado).
  const threat = assessVillageThreat({ coord: coord ?? '', commands: rows }, DEFAULT_THREAT_THRESHOLDS);
  return { villageId, coord, fetchedAt, loadedAt, rows, threat };
}

/** Snapshot no formato do motor sg5-diff (identidade = commandId). */
function toSnapshot(round: ConferenceRound): ConferenceSnapshot {
  return {
    generatedAt: new Date(round.fetchedAt).toISOString(),
    villages: [
      {
        coord: round.coord ?? '',
        commands: round.rows.map((row) => ({
          playerName: row.playerName,
          commandId: row.commandId,
          hasNoble: row.hasNoble,
          sizeHint: row.sizeHint,
        })),
      },
    ],
  };
}

/** Diff entre as DUAS últimas rodadas; snapshot quebrado → erro PT-BR do motor. */
function diffLastTwo(rounds: StoredRound[]): SavedRoundsState {
  const current = rounds[0];
  const previous = rounds[1];
  if (current === undefined || previous === undefined) return { rounds, diff: null, diffError: null };
  try {
    return { rounds, diff: diffConferences(previous.snapshot, current.snapshot), diffError: null };
  } catch (error) {
    return { rounds, diff: null, diffError: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Seção registrada no shell (aba "Conferência", só em info_village)
// ---------------------------------------------------------------------------

/** Última conferência da sessão — sobrevive à re-renderização da aba
 *  (navegação interna do jogo refaz as abas sem recarregar a página). */
let lastRound: ConferenceRound | null = null;

function handleConferir(ui: ConferenceUi, villageId: string | null): void {
  if (villageId === null) {
    ui.setMessage('Não encontrei o id da aldeia na URL (game.php?screen=info_village&id=…).', 'erro');
    return;
  }
  ui.setBusy(true);
  ui.setMessage('Conferindo os comandos compartilhados desta aldeia…', 'info');
  void fetchRound(villageId)
    .then((round) => {
      lastRound = round;
      ui.showRound(round);
      refreshSaved(ui, villageId);
      ui.setMessage(`Conferência concluída: ${round.rows.length} comando(s) nesta aldeia.`, 'ok');
    })
    .catch((error: unknown) => {
      ui.setMessage(error instanceof Error ? error.message : String(error), 'erro');
    })
    .finally(() => {
      ui.setBusy(false);
    });
}

function refreshSaved(ui: ConferenceUi, villageId: string): void {
  const state = diffLastTwo(loadRounds(currentWorld(), villageId));
  ui.showSaved(state);
}

function handleSalvar(ui: ConferenceUi, villageId: string | null): void {
  if (villageId === null) {
    ui.setMessage('Não encontrei o id da aldeia na URL (game.php?screen=info_village&id=…).', 'erro');
    return;
  }
  if (lastRound === null || lastRound.villageId !== villageId) {
    ui.setMessage('Confira os comandos antes de salvar a rodada.', 'erro');
    return;
  }
  if (lastRound.coord === null) {
    ui.setMessage('Não consegui determinar a coordenada do alvo — rodada não salva.', 'erro');
    return;
  }
  const rounds = saveRound(currentWorld(), villageId, toSnapshot(lastRound));
  refreshSaved(ui, villageId);
  ui.setMessage(`Rodada salva — ${rounds.length} rodada(s) guardada(s) para esta aldeia.`, 'ok');
}

function render(container: HTMLElement): void {
  // O shell re-renderiza a aba ativa sem limpar o corpo — a seção é idempotente.
  container.innerHTML = '';
  const villageId = currentVillageId();
  const ui = mountConferenceUi(container, {
    onConferir: () => handleConferir(ui, villageId),
    onSalvar: () => handleSalvar(ui, villageId),
  });
  if (lastRound !== null && lastRound.villageId === villageId) {
    ui.showRound(lastRound);
  } else {
    ui.setMessage(
      villageId === null
        ? 'Abra a página de uma aldeia (info_village) para conferir os comandos.'
        : 'Clique em “Conferir agora” para puxar os comandos compartilhados desta aldeia.',
      'info',
    );
  }
  if (villageId !== null) refreshSaved(ui, villageId);
}

registerSection({
  id: 'sg5',
  label: 'Conferência',
  icon: 'eye',
  matchScreen: 'info_village',
  render,
});
