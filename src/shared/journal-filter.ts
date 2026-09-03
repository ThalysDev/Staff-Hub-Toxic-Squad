// Filtro e export do Journal (P2): regras puras usadas pela página Journal do
// renderer para buscar/filtrar entradas e exportar CSV/JSON. Sem DOM, sem
// rede, sem estado — a UI monta um JournalFilterState e chama as funções.
// Tipagem estrutural (genérica): JournalEntry real do journal.ts
// (id/ts/kind/action/detail/dryRun) encaixa sem cast; campos extras de T são
// preservados pelo filtro (o export emite só os campos públicos).

/** Dia em ms — usado só na aritmética de "dias atrás" do agrupamento LOCAL. */
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
   * Período: datas ISO (YYYY-MM-DD) — a entrada precisa ter ts dentro do dia
   * LOCAL (from = meia-noite local; to = 23:59:59.999 local). Opcional; cada
   * bound é aplicado sozinho.
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
 * rejeitado no round-trip, com componentes LOCAIS). Devolve as componentes
 * do dia; null se inválido — bound inválido do filtro é IGNORADO (data pela
 * metade no input da UI não pode sumir com o histórico todo).
 */
function parseDayParts(day: string): { year: number; month: number; date: number } | null {
  const match = DAY_PATTERN.exec(day);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(date)) return null;
  const check = new Date(year, month - 1, date);
  if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== date) {
    return null;
  }
  return { year, month, date };
}

/**
 * Filtra entradas pelo estado dado. Determinístico e puro: devolve um array
 * NOVO na MESMA ordem de entrada, com as mesmas referências de T (campos
 * extras preservados). Filtro vazio (query '', kinds/actions [] e sem datas)
 * deixa tudo passar.
 *
 * Período — dias LOCAIS, alinhados ao agrupamento por dia (groupByDay é
 * local): from vira a meia-noite LOCAL do dia (inclusivo) e to vira o fim do
 * dia LOCAL, 23:59:59.999 (inclusivo). A comparação é em epoch ms (ts ISO
 * parseado), então o filtro acompanha o fuso da máquina do líder em vez do
 * UTC — 22h local do dia X entra no filtro to=X (em UTC-3 antes ficava de
 * fora). Bound com data inválida é ignorado; to no futuro (qualquer ano à
 * frente) deixa tudo passar; ts não parseável passa pelos bounds (comparar
 * NaN é sempre falso — histórico não se perde por ts lixo).
 */
export function filterJournalEntries<T extends { ts: string; kind: string; action: string; detail: string }>(
  entries: readonly T[],
  filter: JournalFilterState,
): T[] {
  const query = normalizeText(filter.query.trim());
  const kinds = new Set(filter.kinds);
  const actions = new Set(filter.actions);
  const fromParts = filter.from === undefined ? null : parseDayParts(filter.from);
  const toParts = filter.to === undefined ? null : parseDayParts(filter.to);
  const fromBound =
    fromParts === null ? null : new Date(fromParts.year, fromParts.month - 1, fromParts.date).getTime();
  const toBound =
    toParts === null
      ? null
      : new Date(toParts.year, toParts.month - 1, toParts.date, 23, 59, 59, 999).getTime();
  return entries.filter((entry) => {
    if (query !== '' && !normalizeText(`${entry.action} ${entry.detail}`).includes(query)) return false;
    // 'write' é o alias LEGADO de 'mutation' (mains antigos): o chip
    // "Mutação" precisa pegar os dois, senão linha pillada de Mutação some
    // do próprio filtro (P2 da revisão 2 da v0.35).
    const kindEfetivo = entry.kind === 'write' ? 'mutation' : entry.kind;
    if (kinds.size > 0 && !kinds.has(kindEfetivo)) return false;
    if (actions.size > 0 && !actions.has(entry.action)) return false;
    const ts = new Date(entry.ts).getTime();
    if (fromBound !== null && ts < fromBound) return false;
    if (toBound !== null && ts > toBound) return false;
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

// ---- Agrupamento por dia (WAVE 1-B): UM grupo por dia, chave SEMPRE absoluta ----

/** Chave do grupo sem data parseável — ordenada por último (entradas órfãs). */
const INVALID_DAY_KEY = 'data-indisponivel';

/** "Hoje"/"Ontem" são SÓ rótulo; a chave do grupo é sempre a data local. */
export interface JournalDayGroup<T> {
  /** Data local "YYYY-MM-DD" — absoluta, nunca "Hoje"/"Ontem" (duplicata estruturalmente impossível). */
  key: string;
  /** Rótulo pt-BR: "Hoje · terça-feira, 2 de setembro de 2026" / "Ontem · …" / data por extenso. */
  label: string;
  /** Entradas do dia, mais novas primeiro (ordenadas aqui, independente da ordem recebida). */
  entries: T[];
}

/** Capitaliza a primeira letra (rótulo de dia por extenso vira maiúscula). */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Data local "YYYY-MM-DD" — campos locais do Date, JAMAIS toISOString (UTC). */
function localDayKey(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Ms da meia-noite LOCAL do dia do Date (componentes locais, sem UTC). */
function localDayStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Agrupa entradas por dia LOCAL. Puro e determinístico: um dia = UM grupo
 * (a chave é a data absoluta "YYYY-MM-DD"), o sufixo relativo "Hoje"/"Ontem"
 * vive só no LABEL — relativo e absoluto do mesmo dia nunca dividem a lista.
 * Entradas de um grupo ficam ordenadas por ts decrescente e os grupos do dia
 * mais novo para o mais antigo, MESMO que a entrada chegue fora de ordem
 * (defensivo — o IPC manda newest-first, mas a ordem não é assumida).
 * ts inválido (Date não parseável) vai para um grupo "Data indisponível"
 * isolado, sempre por último. `now` é injetável para testes.
 */
export function groupByDay<T extends { ts: string }>(
  entries: readonly T[],
  now: Date = new Date(),
): JournalDayGroup<T>[] {
  const todayStart = localDayStart(now);
  const groups = new Map<string, JournalDayGroup<T>>();
  for (const entry of entries) {
    const date = new Date(entry.ts);
    const valid = !Number.isNaN(date.getTime());
    const key = valid ? localDayKey(date) : INVALID_DAY_KEY;
    let group = groups.get(key);
    if (group === undefined) {
      let label = 'Data indisponível';
      if (valid) {
        const daysAgo = Math.round((todayStart - localDayStart(date)) / DAY_MS);
        const absolute = date.toLocaleDateString('pt-BR', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        });
        label =
          daysAgo === 0 ? `Hoje · ${absolute}` : daysAgo === 1 ? `Ontem · ${absolute}` : capitalize(absolute);
      }
      group = { key, label, entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  const list = [...groups.values()];
  for (const group of list) {
    group.entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  }
  // "YYYY-MM-DD" ordena lexicográfico = cronológico; chave inválida ("")
  // perde de qualquer data real no desc → grupo fica por último.
  list.sort((a, b) => {
    const ka = a.key === INVALID_DAY_KEY ? '' : a.key;
    const kb = b.key === INVALID_DAY_KEY ? '' : b.key;
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
  return list;
}

// ---- Coalescência de repetições (mitigação do flood histórico de boot) ----

/** Sequência de entradas IDÊNTICAS e CONSECUTIVAS colapsadas em uma linha. */
export interface JournalRun<T> {
  /** Primeira entrada da sequência (na ordem recebida — a mais nova). */
  entry: T;
  /** Quantas entradas colapsaram (1 = nada colapsado; sem pílula "×N" na UI). */
  count: number;
  /** ts do primeiro da trecho (ordem recebida) — ponta do title na UI. */
  firstTs: string;
  /** ts do último da trecho (ordem recebida) — outra ponta do title na UI. */
  lastTs: string;
}

/**
 * Colapsa APENAS repetições CONSECUTIVAS (kind+action+detail iguais) em uma
 * linha com contagem — presentação pura sobre a lista já filtrada; repetições
 * não adjacentes permanecem separadas. A ordem de entrada é preservada.
 */
export function coalesceRepeated<
  T extends { ts: string; kind: string; action: string; detail: string },
>(entries: readonly T[]): JournalRun<T>[] {
  const runs: JournalRun<T>[] = [];
  for (const entry of entries) {
    const last = runs[runs.length - 1];
    if (
      last !== undefined &&
      last.entry.kind === entry.kind &&
      last.entry.action === entry.action &&
      last.entry.detail === entry.detail
    ) {
      last.count += 1;
      last.lastTs = entry.ts;
      continue;
    }
    runs.push({ entry, count: 1, firstTs: entry.ts, lastTs: entry.ts });
  }
  return runs;
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
