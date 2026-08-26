// SG_5 (parte de dados): agenda de chegadas pura a partir das linhas de
// comandos compartilhados parseadas por village-parsers. Sem DOM — somente
// conversão tempo→posição para alimentar o Gantt do renderer.
import type { IncomingCommandRow } from './parsers/village-parsers';

export interface ArrivalEntry {
  coord: string;
  playerName: string;
  commandId: number;
  /** Chegada absoluta (epoch ms) = loadedAt + arrivalSecFromLoad * 1000. */
  arrivalAt: number;
  name: string;
  hasNoble: boolean;
  sizeHint: 'pequeno' | 'médio' | 'grande' | null;
}

/** Entrada por alvo: página info_village carregada em loadedAt (epoch ms). */
export interface VillageArrivalsInput {
  coord: string;
  commands: IncomingCommandRow[];
  loadedAt: number;
}

export interface ArrivalTimeline {
  entries: ArrivalEntry[];
  /** Linhas sem atributo máquina: contadas, nunca omitidas nem inventadas. */
  unresolved: number;
}

/**
 * Converte arrivalSecFromLoad + loadedAt em chegada absoluta e ordena
 * crescentemente. Linhas com arrivalSecFromLoad null entram só na contagem
 * unresolved (fail-closed: ausência de dado nunca vira horário chutado).
 */
export function buildArrivalTimeline(villages: VillageArrivalsInput[]): ArrivalTimeline {
  let unresolved = 0;
  const entries: ArrivalEntry[] = [];
  for (const village of villages) {
    for (const command of village.commands) {
      if (command.arrivalSecFromLoad === null) {
        unresolved += 1;
        continue;
      }
      entries.push({
        coord: village.coord,
        playerName: command.playerName,
        commandId: command.commandId,
        arrivalAt: village.loadedAt + command.arrivalSecFromLoad * 1000,
        name: command.name,
        hasNoble: command.hasNoble,
        sizeHint: command.sizeHint,
      });
    }
  }
  entries.sort((a, b) => a.arrivalAt - b.arrivalAt || a.commandId - b.commandId);
  return { entries, unresolved };
}

// ---------------------------------------------------------------------------
// Gantt horizontal: cada chegada vira um traço fixo (1% da janela) posicionado
// entre from→to. Janela degenerada → tudo fora (nunca percentual NaN).
// ---------------------------------------------------------------------------

export interface GanttRow {
  entry: ArrivalEntry;
  offsetPct: number;
  widthPct: number;
}

export interface GanttLayout {
  rows: GanttRow[];
  outsideWindow: ArrivalEntry[];
}

/** Largura do marcador em % da janela — ponto/traço constante. */
const MARKER_WIDTH_PCT = 1;

/**
 * Posiciona cada chegada numa régua from→to (percentuais 0–100). Chegadas
 * fora da janela (antes de from ou depois de to) vão para outsideWindow.
 * Determinístico: ordenado por offset, empate por commandId.
 */
export function ganttLayout(entries: ArrivalEntry[], window: { from: number; to: number }): GanttLayout {
  const rows: GanttRow[] = [];
  const outsideWindow: ArrivalEntry[] = [];
  const span = window.to - window.from;
  if (!(span > 0)) return { rows: [], outsideWindow: [...entries] };
  for (const entry of entries) {
    if (entry.arrivalAt < window.from || entry.arrivalAt > window.to) {
      outsideWindow.push(entry);
      continue;
    }
    const rawOffset = ((entry.arrivalAt - window.from) / span) * 100;
    // Traço cabe dentro da régua mesmo no fim da janela (100% → 99–100).
    const offsetPct = Math.min(rawOffset, 100 - MARKER_WIDTH_PCT);
    rows.push({ entry, offsetPct, widthPct: MARKER_WIDTH_PCT });
  }
  rows.sort((a, b) => a.offsetPct - b.offsetPct || a.entry.commandId - b.entry.commandId);
  return { rows, outsideWindow };
}

/**
 * Contagem regressiva humana PT-BR, determinística (recebe ms, não relógio):
 * "faltam 12 min", "faltam 2 h 05 min", "faltam 45 s"; negativo → "atrasado …".
 */
export function formatCountdown(msRemaining: number): string {
  const late = msRemaining < 0;
  const totalSeconds = Math.floor(Math.abs(msRemaining) / 1000);
  const prefix = late ? 'atrasado' : 'faltam';
  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${prefix} ${hours} h ${String(minutes).padStart(2, '0')} min`;
  }
  if (totalSeconds >= 60) return `${prefix} ${Math.floor(totalSeconds / 60)} min`;
  return `${prefix} ${totalSeconds} s`;
}
