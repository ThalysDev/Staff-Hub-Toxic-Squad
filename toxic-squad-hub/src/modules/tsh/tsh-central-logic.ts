// Regras PURAS da Central de comandos (v3.3.0): que ações cada estado
// permite, quanto o envio desviou do alvo, filtros da Fila/Histórico,
// contagem por tipo e exportar/importar. Sem DOM — tudo testável.

import {
  parseSchedulerCommandRecord,
  type ScheduledCommandKind,
  type ScheduledCommandRecord,
  type ScheduledCommandViewStatus,
} from '../../ext/core/scheduler-state';

// ── Ações por estado ──────────────────────────────────────────────────────

export type CardAction = 'pausar' | 'retomar' | 'cancelar' | 'reagendar' | 'apagar';

/**
 * Ações que fazem sentido em cada estado. Enviado NÃO se pausa (bug da 3.2:
 * o histórico oferecia "Pausar" num comando que já tinha saído).
 */
export function cardActionsFor(status: ScheduledCommandViewStatus): CardAction[] {
  switch (status) {
    case 'agendado':
    case 'janela':
      return ['pausar', 'cancelar'];
    case 'pausado':
      return ['retomar', 'cancelar'];
    case 'enviando':
      return [];
    case 'enviado':
    case 'falhou':
    case 'incerto':
      return ['reagendar', 'apagar'];
    case 'removido':
      return ['reagendar', 'apagar'];
  }
}

export const HISTORY_STATUSES: ReadonlySet<ScheduledCommandViewStatus> = new Set(['enviado', 'incerto', 'falhou', 'removido']);

// ── Resultado do envio (precisão) ─────────────────────────────────────────

export interface SendResult {
  /** Hora (servidor) em que o clique saiu, "HH:MM:SS.mmm". */
  confirmedAt?: string;
  /** Desvio do clique em relação ao alvo (ms; + = depois). */
  clickDeltaMs?: number;
  /** Desvio da CHEGADA real conferida no jogo (ms; + = depois). */
  arrivalDeltaMs?: number;
}

const CLOCK_RE = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;

function clockMs(text: string): number | null {
  const m = CLOCK_RE.exec(text);
  if (m === null) return null;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
}

/** Diferença entre dois horários do dia, tratando a virada da meia-noite. */
function dayDelta(a: number, b: number): number {
  let d = a - b;
  if (d > 43_200_000) d -= 86_400_000;
  if (d < -43_200_000) d += 86_400_000;
  return d;
}

/**
 * Lê o desfecho gravado pelo motor: "… confirmado às HH:MM:SS.mmm (alvo
 * HH:MM:SS.mmm; …)" e, quando conferida, "Chegada real … (…; +3 ms)".
 */
export function sendResultOf(record: ScheduledCommandRecord): SendResult | null {
  const out: SendResult = {};
  for (const event of record.events) {
    if (event.status !== 'enviado' || event.detail === undefined) continue;
    const d = event.detail;
    const confirm = /confirmado às (\d{2}:\d{2}:\d{2}\.\d{3}) \(alvo (\d{2}:\d{2}:\d{2}\.\d{3})/.exec(d);
    if (confirm !== null && confirm[1] !== undefined && confirm[2] !== undefined) {
      out.confirmedAt = confirm[1];
      const a = clockMs(confirm[1]);
      const b = clockMs(confirm[2]);
      if (a !== null && b !== null) out.clickDeltaMs = dayDelta(a, b);
    }
    const arrival = /Chegada real .*?;\s*([+-]?\d+) ms\)/.exec(d);
    if (arrival !== null && arrival[1] !== undefined) out.arrivalDeltaMs = Number(arrival[1]);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** "+3 ms", "−12 ms", "0 ms". */
export function formatDelta(ms: number): string {
  if (ms === 0) return '0 ms';
  return `${ms > 0 ? '+' : '−'}${Math.abs(ms)} ms`;
}

/** Precisão dos envios do histórico (prefere a chegada conferida). */
export function precisionSummary(records: readonly ScheduledCommandRecord[]): { count: number; meanAbsMs: number; worstAbsMs: number } | null {
  const deltas: number[] = [];
  for (const record of records) {
    const r = sendResultOf(record);
    const d = r?.arrivalDeltaMs ?? r?.clickDeltaMs;
    if (d !== undefined && Number.isFinite(d)) deltas.push(Math.abs(d));
  }
  if (deltas.length === 0) return null;
  return {
    count: deltas.length,
    meanAbsMs: Math.round(deltas.reduce((s, d) => s + d, 0) / deltas.length),
    worstAbsMs: Math.max(...deltas),
  };
}

/** Motivo do último desfecho ruim (falhou/incerto/removido). */
export function failureReasonOf(record: ScheduledCommandRecord): string | null {
  const last = [...record.events].reverse().find((e) => e.status === 'falhou' || e.status === 'incerto' || e.status === 'removido');
  return last?.detail ?? null;
}

// ── Filtros ───────────────────────────────────────────────────────────────

export type KindFilter = 'todos' | ScheduledCommandKind;
export type HistoryFilter = 'todos' | 'enviados' | 'falhas';

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Busca por coordenada (origem/alvo) ou nome da aldeia. */
export function matchesQuery(record: ScheduledCommandRecord, query: string): boolean {
  const q = normalize(query.trim());
  if (q === '') return true;
  const hay = normalize(
    [
      `${record.target.x}|${record.target.y}`,
      record.targetName ?? '',
      record.source !== undefined ? `${record.source.x}|${record.source.y}` : '',
      record.sourceName ?? '',
    ].join(' '),
  );
  return hay.includes(q);
}

export function matchesKind(record: ScheduledCommandRecord, kind: KindFilter): boolean {
  return kind === 'todos' || record.kind === kind;
}

export function matchesHistory(status: ScheduledCommandViewStatus, filter: HistoryFilter): boolean {
  if (filter === 'enviados') return status === 'enviado';
  if (filter === 'falhas') return status === 'falhou' || status === 'incerto';
  return true;
}

/** Quantos pendentes por tipo (para os contadores da Fila). */
export function countByKind(records: readonly ScheduledCommandRecord[]): Record<ScheduledCommandKind, number> {
  const out: Record<ScheduledCommandKind, number> = { attack: 0, fake: 0, support: 0, noble: 0, cancel: 0 };
  for (const r of records) out[r.kind] += 1;
  return out;
}

// ── Exportar / importar ───────────────────────────────────────────────────

const EXPORT_TAG = 'toxic-squad-hub/comandos';

/** Texto para copiar: só o essencial de cada comando (sem histórico de eventos). */
export function exportCommands(world: string, records: readonly ScheduledCommandRecord[]): string {
  const commands = records.map((r) => {
    const { events: _events, paused: _paused, ...rest } = r;
    void _events;
    void _paused;
    return rest;
  });
  return JSON.stringify({ formato: EXPORT_TAG, versao: 1, mundo: world, exportadoEm: new Date().toISOString(), comandos: commands });
}

export interface ImportResult {
  records: ScheduledCommandRecord[];
  /** Já passaram do horário (não são importados). */
  past: number;
  /** Inválidos (formato quebrado). */
  invalid: number;
  /** Origem que não é aldeia desta conta (não importados). */
  foreign: number;
}

/**
 * Lê o texto exportado (por este script) e devolve registros NOVOS: eventos
 * zerados, não pausados, ids trocados se já existirem. Horário passado fica
 * de fora — importar nunca dispara nada atrasado.
 */
export function importCommands(
  text: string,
  world: string,
  existingIds: ReadonlySet<string>,
  nowServerMs: number,
  ownVillageIds?: ReadonlySet<string>,
): { ok: true; result: ImportResult } | { ok: false; message: string } {
  let data: unknown;
  try {
    data = JSON.parse(text.trim());
  } catch {
    return { ok: false, message: 'Texto ilegível — cole exatamente o que o botão "Exportar" copiou.' };
  }
  const obj = data as { formato?: unknown; mundo?: unknown; comandos?: unknown };
  if (obj === null || typeof obj !== 'object' || obj.formato !== EXPORT_TAG || !Array.isArray(obj.comandos)) {
    return { ok: false, message: 'Isto não é uma exportação de comandos do Toxic Squad Hub.' };
  }
  // Mundo diferente: coordenadas e aldeias não valem aqui — recusa ANTES de gravar.
  if (typeof obj.mundo === 'string' && obj.mundo !== world) {
    return { ok: false, message: `Estes comandos são do mundo ${obj.mundo}, e você está no ${world} — nada foi importado.` };
  }
  const now = new Date().toISOString();
  const ids = new Set(existingIds);
  let foreign = 0;
  const records: ScheduledCommandRecord[] = [];
  let past = 0;
  let invalid = 0;
  for (const raw of obj.comandos) {
    const candidate = { ...(raw as Record<string, unknown>), paused: false, events: [{ status: 'agendado', at: now, detail: 'Importado.' }] };
    const parsed = parseSchedulerCommandRecord(candidate);
    if (!parsed.ok) {
      invalid += 1;
      continue;
    }
    const record = parsed.record;
    if (ownVillageIds !== undefined && !ownVillageIds.has(record.sourceVillageId.replace(/^n/, ''))) {
      foreign += 1;
      continue;
    }
    if (!(Date.parse(record.sendAt) > nowServerMs + 5_000)) {
      past += 1;
      continue;
    }
    let id = record.id;
    let n = 2;
    while (ids.has(id)) id = `${record.id}-${n++}`;
    ids.add(id);
    records.push({ ...record, id });
  }
  return { ok: true, result: { records, past, invalid, foreign } };
}

/**
 * Cancela vários comandos PENDENTES de uma vez: grava 'removido' (o motor
 * nunca dispara um terminal) e tira da lista. Enviado/enviando não é tocado.
 */
export function cancelManyCommands(
  records: readonly ScheduledCommandRecord[],
  ids: ReadonlySet<string>,
  atIso: string,
): ScheduledCommandRecord[] {
  // Grava 'removido' (terminal: o motor nunca dispara) e MANTÉM o registro no
  // histórico como "Cancelado" — trilha da OP até o jogador limpar.
  const terminal = new Set(['enviado', 'incerto', 'falhou', 'removido', 'enviando']);
  const cancelable = (r: ScheduledCommandRecord): boolean => ids.has(r.id) && !r.events.some((e) => terminal.has(e.status));
  return records.map((r) =>
    cancelable(r) ? { ...r, paused: false, events: [...r.events, { status: 'removido' as const, at: atIso, detail: 'Cancelado na Central.' }] } : r,
  );
}
