// Filtro e export do Journal (P2): regras puras usadas pela página Journal do
// renderer para buscar/filtrar entradas e exportar CSV/JSON. Sem DOM, sem
// rede, sem estado — a UI monta um JournalFilterState e chama as funções.
// Tipagem estrutural (genérica): JournalEntry real do journal.ts
// (id/ts/kind/action/detail/dryRun) encaixa sem cast; campos extras de T são
// preservados pelo filtro (o export emite só os campos públicos).

/** Dia em ms — usado só em aritmética UTC (sem DST), para o bound exclusivo. */
const DAY_MS = 86_400_000;

/**
 * Forma estrutural de uma entrada de journal aceita pelo EXPORT (CSV/JSON):
 * os campos públicos de JournalEntry (@shared/ipc-types), com kind/action em
 * bruto (mesmo contrato do journal do main). É o "T genérico" completo —
 * qualquer objeto com essa forma serve; JournalLike não exige a união de
 * kinds para que mocks/tests encaixem sem cast.
 */
export interface JournalLike {
  id: string;
  /** Timestamp ISO 8601 completo em UTC — sempre de new Date().toISOString(). */
  ts: string;
  /** Tipo bruto: 'read' | 'mutation' | 'session' | 'system' (valores do journal.ts). */
  kind: string;
  /** Ação interna bruta (ex.: 'sg5-verify', 'mp-send') — sem tradução. */
  action: string;
  /** Detalhe livre em pt-BR. */
  detail: string;
  /** true = mutação simulada (na UI vira "Teste? Sim"). */
  dryRun: boolean;
}

export interface JournalFilterState {
  /** Busca textual (contains, acento/case-insensitive) em action + detail. Vazio = todas. */
  query: string;
  /** Tipos incluídos (kind: 'read'|'mutation'|'session'|'system' — valores REAIS do journal.ts). Vazio = todos. */
  kinds: string[];
  /** Ações incluídas (valor cru do campo action). Vazio = todas. */
  actions: string[];
  /**
   * Período: datas ISO (YYYY-MM-DD) — a entrada precisa ter ts dentro
   * [from..to+1dia). Opcional; cada bound é aplicado sozinho.
   */
  from?: string;
  to?: string;
}

/**
 * Normalização acento/case-insensitive: NFD + strip de diacríticos combinantes
 * + toLowerCase. "Verificação" e "verificaçao" viram "verificacao" — a busca
 * do líder não depende de ele acentuar certo. v0.33: fonte única em ./fold
 * (antes era cópia local normalizeText).
 */
import { fold as normalizeText } from './fold';

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Valida "YYYY-MM-DD" como data REAL (2026-02-30 rola para março e é
 * rejeitado no round-trip). Retorna ms UTC da meia-noite do dia; null se
 * inválido — bound inválido do filtro é IGNORADO (data pela metade no input
 * da UI não pode sumir com o histórico todo).
 */
function parseDayMs(day: string): number | null {
  const match = DAY_PATTERN.exec(day);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(date)) return null;
  const ms = Date.UTC(year, month - 1, date);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== date
  ) {
    return null;
  }
  return ms;
}

/** "YYYY-MM-DD" de um ms UTC; null se o Date estourar (ex.: 10000-12-31). */
function dayIso(ms: number): string | null {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/**
 * Filtra entradas pelo estado dado. Determinístico e puro: devolve um array
 * NOVO na MESMA ordem de entrada, com as mesmas referências de T (campos
 * extras preservados). Filtro vazio (query '', kinds/actions [] e sem datas)
 * deixa tudo passar.
 *
 * Período — comparação de STRING ISO, simples e determinística (sem fuso):
 * o journal grava ts sempre via toISOString() (UTC, largura fixa), então a
 * ordem lexicográfica é a ordem cronológica. from vira `${from}T00:00:00`
 * (inclusivo) e to vira `${to+1dia}T00:00:00` (EXCLUSIVO — o dia seguinte
 * entra calculado via Date UTC + 1 dia, formato YYYY-MM-DD, o que acerta
 * viradas de mês/ano). Bound com data inválida é ignorado; to no futuro
 * (qualquer ano à frente) deixa tudo passar.
 */
export function filterJournalEntries<T extends { ts: string; kind: string; action: string; detail: string }>(
  entries: readonly T[],
  filter: JournalFilterState,
): T[] {
  const query = normalizeText(filter.query.trim());
  const kinds = new Set(filter.kinds);
  const actions = new Set(filter.actions);
  const fromBound =
    filter.from === undefined || parseDayMs(filter.from) === null ? null : `${filter.from}T00:00:00`;
  let toBound: string | null = null;
  if (filter.to !== undefined) {
    const ms = parseDayMs(filter.to);
    const next = ms === null ? null : dayIso(ms + DAY_MS);
    toBound = next === null ? null : `${next}T00:00:00`;
  }
  return entries.filter((entry) => {
    if (query !== '' && !normalizeText(`${entry.action} ${entry.detail}`).includes(query)) return false;
    if (kinds.size > 0 && !kinds.has(entry.kind)) return false;
    if (actions.size > 0 && !actions.has(entry.action)) return false;
    if (fromBound !== null && entry.ts < fromBound) return false;
    if (toBound !== null && entry.ts >= toBound) return false;
    return true;
  });
}

/**
 * Lista distinta de ações presentes (valor bruto de action), ordenada
 * alfabeticamente em pt-BR — alimenta o select de ações da UI.
 */
export function distinctActions<T extends { action: string }>(entries: readonly T[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) seen.add(entry.action);
  return [...seen].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

/**
 * Escapa um campo CSV (RFC 4180 com separador ";"): aspas dobradas; o campo é
 * cercado por aspas quando contém ";", aspas, CR ou LF — detalhe do journal é
 * texto livre do jogo e pode ter tudo isso.
 */
function csvField(value: string): string {
  const needsQuotes = value.includes(';') || value.includes('"') || value.includes('\r') || value.includes('\n');
  const escaped = value.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

const CSV_HEADER = 'Data;Tipo;Ação;Detalhe;Teste';

/**
 * Export CSV (pt-BR, abre direto no Excel com ";"): cabeçalho fixo
 * "Data;Tipo;Ação;Detalhe;Teste", uma linha por entrada NA ORDEM recebida,
 * separador ";" e linhas unidas por "\n". Valores em bruto (ts ISO, kind e
 * action internos — contrato com o journal do main); "Teste" vira Sim/Não
 * como na coluna da UI. Lista vazia devolve só o cabeçalho.
 */
export function journalToCsv(entries: readonly JournalLike[]): string {
  const lines = [CSV_HEADER];
  for (const entry of entries) {
    const row = [entry.ts, entry.kind, entry.action, entry.detail, entry.dryRun ? 'Sim' : 'Não'];
    lines.push(row.map(csvField).join(';'));
  }
  return lines.join('\n');
}

/**
 * Export JSON: array puro das entradas com os campos públicos
 * (id/ts/kind/action/detail/dryRun), indent 2, SEM BOM — pronto para gravar
 * em arquivo UTF-8. Campos extras do objeto de origem são descartados (o
 * arquivo espelha o contrato do journal, não internals da UI); a ordem
 * recebida é preservada.
 */
export function journalToJson(entries: readonly JournalLike[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      id: entry.id,
      ts: entry.ts,
      kind: entry.kind,
      action: entry.action,
      detail: entry.detail,
      dryRun: entry.dryRun,
    })),
    null,
    2,
  );
}
