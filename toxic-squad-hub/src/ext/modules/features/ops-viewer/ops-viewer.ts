import { z } from 'zod';

/**
 * Engine PURA do Mapa de Operações (Onda 1): filtros, ordenação, conflitos de
 * PRECISÃO (ms), edição em massa de horários e IO JSON do conjunto de comandos
 * agendados.
 *
 * Sem DOM, sem rede e sem relógio: os comandos chegam JÁ parseados do estado
 * do Agendador (`core/scheduler-state.ts`) com partida e chegada resolvidas em
 * ms — quem lê a página e quem desenha a tela são outras camadas. Toda função
 * devolve estruturas NOVAS; a entrada nunca é mutada (a UI filtra em cima do
 * resultado, não do estado do mundo).
 *
 * Vocabulário de status (o do scheduler-state): `agendado`/`janela`/`enviando`
 * são PENDENTES (ainda não terminiais); `enviado` é ENVIADO; `falhou`/`incerto`
 * são FALHAS; `pausado` é o comando congelado pela UI; `removido` é lápide e
 * nunca entra em listagem nenhuma. Status fora do vocabulário não casa nenhum
 * filtro específico (a engine não inventa classificação) e aparece só em
 * "todos" — que é exatamente "tudo, menos removido".
 */

export type ViewerKind = 'attack' | 'support' | 'noble' | 'fake' | 'cancel';
export type ViewerDateField = 'partida' | 'chegada';
export type ViewerStatusFilter = 'todos' | 'pendentes' | 'enviados' | 'falhas';
export type ViewerSort = 'partida_asc' | 'partida_desc' | 'chegada_asc' | 'chegada_desc' | 'cadastro';

export const VIEWER_KINDS = Object.freeze(['attack', 'support', 'noble', 'fake', 'cancel'] as const);

/**
 * Espaço mínimo entre partidas da MESMA origem. Cada comando cravado abre a
 * própria confirmação na aba daquela aldeia (pré-arme → carregar → clique):
 * com menos de ~5 s o segundo perde a janela. Era 300 ms — valor que só o
 * trem NATIVO do jogo (1 clique) consegue cumprir.
 */
export const VIEWER_CONFLICT_WINDOW_MS = 5_000;

/** Versão do envelope de exportação (o import recusa qualquer outra). */
export const VIEWER_SET_VERSION = 1;

export interface ViewerCommand {
  readonly id: string;
  readonly origin: { x: number; y: number };
  readonly target: { x: number; y: number };
  readonly kind: ViewerKind;
  readonly departureMs: number;
  readonly arrivalMs: number;
  readonly status: string;
  readonly order: number;
  readonly fakeFlagged?: boolean;
  readonly groupId?: number;
}

export interface ViewerFilters {
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly dateField: ViewerDateField;
  readonly kinds?: readonly ViewerKind[];
  readonly status: ViewerStatusFilter;
  /** "555|444" casa origem OU alvo; texto solto casa por trecho nos dois. */
  readonly coordQuery?: string;
  readonly groupId?: number;
  readonly conflictsOnly?: boolean;
}

const PENDING_VIEWER_STATUSES: ReadonlySet<string> = new Set(['agendado', 'janela', 'enviando']);
const SENT_VIEWER_STATUSES: ReadonlySet<string> = new Set(['enviado']);
const FAILED_VIEWER_STATUSES: ReadonlySet<string> = new Set(['falhou', 'incerto']);
const HIDDEN_VIEWER_STATUSES: ReadonlySet<string> = new Set(['removido']);

const VIEWER_COORDINATE_MAX = 999;

const VIEWER_SORT_FIELDS: Readonly<
  Record<ViewerSort, { readonly field: 'departureMs' | 'arrivalMs' | 'order'; readonly descending: boolean }>
> = {
  partida_asc: { field: 'departureMs', descending: false },
  partida_desc: { field: 'departureMs', descending: true },
  chegada_asc: { field: 'arrivalMs', descending: false },
  chegada_desc: { field: 'arrivalMs', descending: true },
  cadastro: { field: 'order', descending: false },
};

// ---------------------------------------------------------------------------
// Filtro
// ---------------------------------------------------------------------------

type ViewerCoordQuery =
  | { readonly mode: 'exact'; readonly x: number; readonly y: number }
  | { readonly mode: 'loose'; readonly text: string };

/** Coordenada no formato do jogo (`x|y`), usado tanto na consulta quanto no casamento. */
function formatViewerCoordinate(coordinate: { x: number; y: number }): string {
  return `${coordinate.x}|${coordinate.y}`;
}

/**
 * "555|444" (espaços tolerados) vira consulta EXATA de coordenada; qualquer
 * outro texto é consulta SOLTA (trecho). Texto vazio/branco = sem consulta.
 */
function parseViewerCoordQuery(raw: string | undefined): ViewerCoordQuery | undefined {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return undefined;
  const exact = /^(\d{1,3})\s*\|\s*(\d{1,3})$/.exec(trimmed);
  if (exact) {
    const x = Number.parseInt(exact[1] ?? '', 10);
    const y = Number.parseInt(exact[2] ?? '', 10);
    if (Number.isInteger(x) && Number.isInteger(y)) return { mode: 'exact', x, y };
  }
  return { mode: 'loose', text: trimmed.toLowerCase() };
}

function matchesViewerCoordQuery(command: ViewerCommand, query: ViewerCoordQuery): boolean {
  if (query.mode === 'exact') {
    return (
      (command.origin.x === query.x && command.origin.y === query.y) ||
      (command.target.x === query.x && command.target.y === query.y)
    );
  }
  const text = query.text;
  return (
    formatViewerCoordinate(command.origin).toLowerCase().includes(text) ||
    formatViewerCoordinate(command.target).toLowerCase().includes(text)
  );
}

function matchesViewerStatus(status: string, filter: ViewerStatusFilter): boolean {
  switch (filter) {
    case 'pendentes':
      return PENDING_VIEWER_STATUSES.has(status);
    case 'enviados':
      return SENT_VIEWER_STATUSES.has(status);
    case 'falhas':
      return FAILED_VIEWER_STATUSES.has(status);
    case 'todos':
      return true;
  }
}

function viewerDateMs(command: ViewerCommand, field: ViewerDateField): number {
  return field === 'chegada' ? command.arrivalMs : command.departureMs;
}

/**
 * Filtro combinado do Mapa (todas as condições são E):
 * - `fromMs`/`toMs` fecham o intervalo no eixo de `dateField`, INCLUSIVO nas
 *   pontas (ausente = sem limite daquele lado);
 * - `kinds` ausente = todos os tipos; vetor VAZIO = nenhum tipo selecionado
 *   (nada lista — desmarcar tudo na UI não pode virar "mostrar tudo");
 * - `status` conforme o vocabulário acima; `removido` nunca lista;
 * - `coordQuery` exata ou solta (origem OU alvo);
 * - `groupId` casa só quem está no grupo (comando sem grupo nunca casa);
 * - `conflictsOnly` mantém apenas ids em `detectDepartureConflicts`, calculado
 *   sobre a ENTRADA INTEIRA: o conflito é um fato do conjunto, não do recorte
 *   — filtrar por período/grupo não apaga o conflito que existe de verdade.
 */
export function filterViewerCommands(cmds: readonly ViewerCommand[], filters: ViewerFilters): ViewerCommand[] {
  const query = parseViewerCoordQuery(filters.coordQuery);
  const conflicts = filters.conflictsOnly === true ? detectDepartureConflicts(cmds) : undefined;
  return cmds.filter((command) => {
    if (HIDDEN_VIEWER_STATUSES.has(command.status)) return false;
    if (!matchesViewerStatus(command.status, filters.status)) return false;
    if (filters.kinds !== undefined && !filters.kinds.includes(command.kind)) return false;
    if (filters.groupId !== undefined && command.groupId !== filters.groupId) return false;
    if (query !== undefined && !matchesViewerCoordQuery(command, query)) return false;
    const instant = viewerDateMs(command, filters.dateField);
    if (filters.fromMs !== undefined && instant < filters.fromMs) return false;
    if (filters.toMs !== undefined && instant > filters.toMs) return false;
    if (conflicts !== undefined && !conflicts.has(command.id)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Ordenação
// ---------------------------------------------------------------------------

/**
 * Ordena em cinco modos sem tocar a entrada. Empate é ESTÁVEL: preserva a
 * ordem recebida (índice de entrada no desempate), independente do `sort`
 * nativo ser estável.
 */
export function sortViewerCommands(cmds: readonly ViewerCommand[], sortBy: ViewerSort): ViewerCommand[] {
  const { field, descending } = VIEWER_SORT_FIELDS[sortBy];
  const direction = descending ? -1 : 1;
  return cmds
    .map((command, index) => ({ command, index }))
    .sort((left, right) => {
      const difference = left.command[field] - right.command[field];
      return difference !== 0 ? direction * difference : left.index - right.index;
    })
    .map((entry) => entry.command);
}

// ---------------------------------------------------------------------------
// Conflitos de precisão (ms)
// ---------------------------------------------------------------------------

function appendViewerConflict(conflicts: Map<string, string[]>, id: string, partnerId: string): void {
  const partners = conflicts.get(id);
  if (partners === undefined) {
    conflicts.set(id, [partnerId]);
    return;
  }
  if (!partners.includes(partnerId)) partners.push(partnerId);
}

/**
 * Conflito de PRECISÃO: mesma origem com partidas mais próximas que `windowMs`
 * (default 300ms). Dois comandos não saem da mesma aldeia com milissegundos de
 * diferença — quem planeja precisa ver o par e separar os horários.
 *
 * Devolve `id → ids conflitantes`, com os DOIS lados do par (a UI marca as duas
 * linhas). Diferença exatamente igual à janela NÃO é conflito (o corte é
 * "mais próximas que", estrito). Janela zero ou inválida nunca conflita.
 * As partidas são comparadas em módulo: vale a distância, não a ordem.
 */
export function detectDepartureConflicts(
  cmds: readonly ViewerCommand[],
  windowMs = VIEWER_CONFLICT_WINDOW_MS,
): ReadonlyMap<string, readonly string[]> {
  const conflicts = new Map<string, string[]>();
  if (!Number.isFinite(windowMs) || windowMs <= 0) return conflicts;
  // Agrupa por origem: só comandos da MESMA aldeia podem conflitar.
  const byOrigin = new Map<string, ViewerCommand[]>();
  for (const command of cmds) {
    const key = formatViewerCoordinate(command.origin);
    const group = byOrigin.get(key);
    if (group === undefined) byOrigin.set(key, [command]);
    else group.push(command);
  }
  for (const group of byOrigin.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const first = group[left]!;
        const second = group[right]!;
        if (Math.abs(first.departureMs - second.departureMs) >= windowMs) continue;
        appendViewerConflict(conflicts, first.id, second.id);
        appendViewerConflict(conflicts, second.id, first.id);
      }
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Edição em massa de horários
// ---------------------------------------------------------------------------

/**
 * Move `partida` ou `chegada` dos comandos selecionados para `newTimeMs`; a
 * outra ponta ACOMPANHA pela duração fixa do comando (`arrivalMs −
 * departureMs`), porque a duração é o dado que o Composer congelou — editar o
 * mapa é reposicionar o comando, não reescrever a viagem.
 *
 * Ids desconhecidos são ignorados e o instante não finito não edita nada
 * (fail-closed). A ordem do vetor é preservada: a UI reordena em seguida com
 * `sortViewerCommands`.
 */
export function applyBulkTimeEdit(
  cmds: readonly ViewerCommand[],
  ids: readonly string[],
  field: ViewerDateField,
  newTimeMs: number,
): readonly ViewerCommand[] {
  const selected = new Set(ids);
  if (selected.size === 0 || !Number.isFinite(newTimeMs)) return [...cmds];
  return cmds.map((command) => {
    if (!selected.has(command.id)) return command;
    const durationMs = command.arrivalMs - command.departureMs;
    return field === 'partida'
      ? { ...command, departureMs: newTimeMs, arrivalMs: newTimeMs + durationMs }
      : { ...command, departureMs: newTimeMs - durationMs, arrivalMs: newTimeMs };
  });
}

// ---------------------------------------------------------------------------
// Classificação por população
// ---------------------------------------------------------------------------

/**
 * Corte de população do alvo (a populção é calculada FORA — aqui só o corte):
 * `pop >= fullMinPop` é cheio; `pop <= fakeMaxPop` é fake; o meio é neutro.
 * Quando os cortes se sobrepõem, o "cheio" vence: é o corte que não pode ser
 * violado (mandar fake em alvo cheio é o erro caro). População ilegível (NaN)
 * não casa nenhum corte → neutro.
 */
export function classifyByPopulation(
  pop: number,
  opts: { readonly fullMinPop: number; readonly fakeMaxPop: number },
): 'full' | 'fake' | 'neutro' {
  if (pop >= opts.fullMinPop) return 'full';
  if (pop <= opts.fakeMaxPop) return 'fake';
  return 'neutro';
}

// ---------------------------------------------------------------------------
// IO JSON do conjunto
// ---------------------------------------------------------------------------

const viewerCoordinateSchema = z.object({
  x: z.number().int().min(0).max(VIEWER_COORDINATE_MAX),
  y: z.number().int().min(0).max(VIEWER_COORDINATE_MAX),
});

/**
 * Forma canônica de um comando no arquivo. Chaves desconhecidas são
 * descartadas (um campo novo de uma versão futura não derruba o import do que
 * já é conhecido); todo campo conhecido é validado — `removido` inclusive, que
 * faz roundtrip como lápide e some na listagem.
 */
const viewerCommandSchema = z.object({
  id: z.string().min(1),
  origin: viewerCoordinateSchema,
  target: viewerCoordinateSchema,
  kind: z.enum(VIEWER_KINDS),
  departureMs: z.number().int(),
  arrivalMs: z.number().int(),
  status: z.string().min(1),
  order: z.number().int().min(0),
  fakeFlagged: z.boolean().optional(),
  // 0 é o "Sem grupo" do jogo: aceito como grupo válido, não como ausência.
  groupId: z.number().int().min(0).optional(),
});

const viewerSetFileSchema = z.object({
  version: z.literal(VIEWER_SET_VERSION),
  cmds: z.array(viewerCommandSchema),
});

const VIEWER_FIELD_LABELS: Record<string, string> = {
  id: 'id',
  origin: 'origem',
  target: 'alvo',
  x: 'x',
  y: 'y',
  kind: 'tipo de comando',
  departureMs: 'horário de partida',
  arrivalMs: 'horário de chegada',
  status: 'status',
  order: 'ordem de cadastro',
  fakeFlagged: 'marcação de fake',
  groupId: 'grupo',
  version: 'versão do arquivo',
  cmds: 'comandos',
};

/** Campos culpados de um erro zod, em pt-BR e sem repetição (`origem.x`). */
function viewerIssueFields(error: z.ZodError): string[] {
  const fields = error.issues.map((issue) => {
    const parts = issue.path.filter((part): part is string => typeof part === 'string');
    const last = parts.at(-1);
    const parent = parts.at(-2);
    if (last === 'x' || last === 'y') {
      if (parent !== undefined) return `${VIEWER_FIELD_LABELS[parent] ?? parent}.${last}`;
      return last;
    }
    if (last === undefined) return 'registro';
    return VIEWER_FIELD_LABELS[last] ?? last;
  });
  return [...new Set(fields)];
}

type ParsedViewerCommand = z.infer<typeof viewerCommandSchema>;

/** Dados validados → `ViewerCommand` (opcionais só quando presentes). */
function viewerCommandFromParsed(parsed: ParsedViewerCommand): ViewerCommand {
  return {
    id: parsed.id,
    origin: { x: parsed.origin.x, y: parsed.origin.y },
    target: { x: parsed.target.x, y: parsed.target.y },
    kind: parsed.kind,
    departureMs: parsed.departureMs,
    arrivalMs: parsed.arrivalMs,
    status: parsed.status,
    order: parsed.order,
    ...(parsed.fakeFlagged !== undefined ? { fakeFlagged: parsed.fakeFlagged } : {}),
    ...(parsed.groupId !== undefined ? { groupId: parsed.groupId } : {}),
  };
}

/** JSON com chaves ORDENADAS em todos os níveis: mesma entrada, mesmo texto. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Exporta o conjunto no envelope `{ version, cmds }` em JSON ESTÁVEL (chaves
 * ordenadas). Comando inválido derruba a exportação com mensagem pt-BR: nunca
 * gera arquivo que a própria engine não consiga reimportar.
 */
export function serializeViewerSet(cmds: readonly ViewerCommand[]): string {
  const commands = cmds.map((command) => {
    const parsed = viewerCommandSchema.safeParse(command);
    if (!parsed.success) {
      throw new Error(
        `Comando "${command.id}" não pode ser exportado — nada foi gerado. Revise: ${viewerIssueFields(parsed.error).join(', ')}.`,
      );
    }
    return viewerCommandFromParsed(parsed.data);
  });
  return stableStringify({ version: VIEWER_SET_VERSION, cmds: commands });
}

export type ViewerSetImport = { readonly cmds: readonly ViewerCommand[] } | { readonly error: string };

function readViewerSetVersion(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const version = (value as { version?: unknown }).version;
  return typeof version === 'number' ? version : undefined;
}

/**
 * Lê um arquivo de operações. Fail-closed: qualquer desvio (JSON ilegível,
 * versão desconhecida, registro malformado) devolve `{ error }` em pt-BR e
 * NADA é importado — nunca entra comando pela metade no mapa.
 */
export function deserializeViewerSet(raw: string): ViewerSetImport {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { error: 'Arquivo de operações ilegível: o conteúdo não é JSON válido — nada foi importado.' };
  }
  const version = readViewerSetVersion(parsedJson);
  if (version !== undefined && version !== VIEWER_SET_VERSION) {
    return {
      error: `Arquivo de operações na versão ${version} — o Mapa lê a versão ${VIEWER_SET_VERSION}. Nada foi importado.`,
    };
  }
  const parsed = viewerSetFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      error: `Arquivo de operações inválido — nada foi importado. Revise: ${viewerIssueFields(parsed.error).join(', ')}.`,
    };
  }
  return { cmds: parsed.data.cmds.map(viewerCommandFromParsed) };
}
