import { z } from 'zod';

/**
 * Codec das LINHAS DE APOIO do "Apoio em massa" (`place&mode=call`) — engine
 * PURA e determinística: sem DOM, sem rede e sem relógio próprio (o instante
 * de referência entra por parâmetro).
 *
 * Gramática real do jogo (a mesma que circula nos posts de tribo):
 *   `<x|y> <u1/u2/.../u10> [i]<DD/MM-HH:MM:SS:mmm> [<DD/MM-HH:MM:SS:mmm>]`
 * - as 10 unidades estão em ORDEM FIXA (`SUPPORT_LINE_UNITS`) e a barra é
 *   obrigatória: faltando ou sobrando valor a linha é rejeitada com erro claro
 *   (nunca um apoio com composição adivinhada);
 * - sem datas = imediato; uma data = chegada cravada; `i` + data e uma segunda
 *   data = JANELA (chegar depois do início, até a data-alvo);
 * - `mmm` aceita 1 a 3 dígitos: os dígitos são o valor em milissegundos, sem
 *   deslocamento (zero à esquerda não multiplica);
 * - o ANO não existe na linha: é inferido do instante de referência e, se a
 *   data já passou (mais de 1h atrás), rola para o ano seguinte. O fim de uma
 *   janela usa o início como piso, então janela que cruza o Ano Novo funciona.
 *
 * Os campos de data são lidos em UTC: o chamador injeta o epoch do horário do
 * SERVIDOR (o Hub já resolve o offset) e a conversão fica determinística,
 * independente do fuso da máquina — mesma escolha do resto do ext.
 */

const SUPPORT_LINE_UNIT_KEYS = [
  'spear',
  'sword',
  'axe',
  'archer',
  'spy',
  'light',
  'marcher',
  'heavy',
  'ram',
  'catapult',
] as const;

/** Ordem FIXA das 10 unidades da linha de apoio (índice = posição na barra). */
export const SUPPORT_LINE_UNITS: readonly string[] = Object.freeze([...SUPPORT_LINE_UNIT_KEYS]);

/** Rótulos pt-BR na mesma ordem (mensagens de erro e UI do painel). */
export const SUPPORT_LINE_UNIT_LABELS: readonly string[] = Object.freeze([
  'lança',
  'espada',
  'machado',
  'arqueiro',
  'explorador',
  'cav. leve',
  'arq. a cavalo',
  'cav. pesada',
  'ariete',
  'catapulta',
]);

const UNIT_ORDER_HINT =
  'lança/espada/machado/arqueiro/explorador/cav. leve/arq. a cavalo/cav. pesada/ariete/catapulta';

const ONE_HOUR_MS = 3_600_000;
const UNIT_COUNT = SUPPORT_LINE_UNIT_KEYS.length;

const COORDINATE_RE = /^(\d{1,3})\|(\d{1,3})$/;
const DATE_RE = /^(\d{1,2})\/(\d{1,2})-(\d{1,2}):(\d{1,2}):(\d{1,2}):(\d{1,3})$/;

export interface SupportLine {
  readonly target: { x: number; y: number };
  /** As 10 chaves canônicas, sempre presentes e >= 0. */
  readonly units: Readonly<Record<string, number>>;
  /** Início da janela (`i<data>`, epoch ms) — null quando a linha não tem janela. */
  readonly earliestArrivalMs: number | null;
  /** Data única OU data-alvo da janela (epoch ms) — null no imediato. */
  readonly exactArrivalMs: number | null;
}

export type SupportLineTiming = 'imediato' | 'cravado' | 'janela';

interface SupportDateParts {
  readonly day: number;
  readonly month: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

const buildUtcMs = (parts: SupportDateParts, year: number): number =>
  Date.UTC(year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);

const parseCoordinate = (token: string): { x: number; y: number } | { error: string } => {
  const match = COORDINATE_RE.exec(token);
  if (match === null) {
    return { error: `Coordenada inválida: use x|y entre 0|0 e 999|999 (ex.: 500|500): "${token}".` };
  }
  return { x: Number(match[1]), y: Number(match[2]) };
};

const parseUnits = (token: string): { units: Record<string, number> } | { error: string } => {
  const parts = token.split('/');
  if (parts.length !== UNIT_COUNT) {
    return {
      error:
        `A lista de unidades precisa de exatamente ${UNIT_COUNT} valores separados por "/" ` +
        `(${UNIT_ORDER_HINT}), na ordem — recebi ${parts.length}: "${token}".`,
    };
  }
  const units: Record<string, number> = {};
  for (const [index, key] of SUPPORT_LINE_UNIT_KEYS.entries()) {
    const raw = parts[index] ?? '';
    if (!/^\d+$/.test(raw)) {
      return {
        error: `Quantidade inválida em ${SUPPORT_LINE_UNIT_LABELS[index]}: "${raw}" (use inteiro >= 0).`,
      };
    }
    units[key] = Number(raw);
  }
  return { units };
};

const parseDateParts = (token: string): SupportDateParts | { error: string } => {
  const match = DATE_RE.exec(token);
  if (match === null) {
    return { error: `Data inválida: use DD/MM-HH:MM:SS:mmm (ex.: 24/09-21:30:00:500): "${token}".` };
  }
  const parts: SupportDateParts = {
    day: Number(match[1]),
    month: Number(match[2]),
    hour: Number(match[3]),
    minute: Number(match[4]),
    second: Number(match[5]),
    millisecond: Number(match[6]),
  };
  if (
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > 31 ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
  ) {
    return { error: `Data fora do calendário: "${token}".` };
  }
  // 31/02 e afins passam pelas faixas acima — o round-trip do calendário pega.
  if (new Date(Date.UTC(2000, parts.month - 1, parts.day)).getUTCDate() !== parts.day) {
    return { error: `Data fora do calendário: "${token}".` };
  }
  return parts;
};

/**
 * Epoch ms de uma data sem ano: usa o `yearHint` quando informado; senão o ano
 * do instante de referência e, se a data ficar antes do piso, o ano seguinte.
 * O piso é `nowMs - 1h` na primeira data e o INÍCIO da janela no fim dela.
 */
const resolveDateMs = (
  parts: SupportDateParts,
  nowMs: number,
  yearHint: number | undefined,
  floorMs: number,
): number => {
  const year = yearHint ?? new Date(nowMs).getUTCFullYear();
  const resolved = buildUtcMs(parts, year);
  if (yearHint !== undefined || resolved >= floorMs) return resolved;
  return buildUtcMs(parts, year + 1);
};

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

const formatDateMs = (ms: number): string => {
  const date = new Date(ms);
  return (
    `${pad(date.getUTCDate(), 2)}/${pad(date.getUTCMonth() + 1, 2)}-` +
    `${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:` +
    `${pad(date.getUTCSeconds(), 2)}:${pad(date.getUTCMilliseconds(), 3)}`
  );
};

/**
 * Linha de apoio de um texto do jogo. Devolve `{ error }` pt-BR em qualquer
 * desvio da gramática (fail-closed: nada de completar dado faltante).
 */
export function parseSupportLine(
  raw: string,
  nowMs: number,
  yearHint?: number,
): SupportLine | { error: string } {
  if (!Number.isFinite(nowMs)) return { error: 'Instante de referência inválido.' };
  const tokens = raw.trim().split(/\s+/).filter((token) => token !== '');
  if (tokens.length < 2) {
    return { error: `Linha incompleta: informe <x|y> e as ${UNIT_COUNT} unidades separadas por "/".` };
  }
  const coordinate = parseCoordinate(tokens[0] ?? '');
  if ('error' in coordinate) return coordinate;
  const parsedUnits = parseUnits(tokens[1] ?? '');
  if ('error' in parsedUnits) return parsedUnits;
  const units = parsedUnits.units;

  const dates: { parts: SupportDateParts; markedEarliest: boolean }[] = [];
  let pendingEarliest = false;
  for (const token of tokens.slice(2)) {
    if (token === 'i') {
      pendingEarliest = true;
      continue;
    }
    const markedEarliest = token.startsWith('i');
    const parts = parseDateParts(markedEarliest ? token.slice(1) : token);
    if ('error' in parts) return parts;
    dates.push({ parts, markedEarliest: markedEarliest || pendingEarliest });
    pendingEarliest = false;
  }
  if (pendingEarliest) return { error: 'A marca "i" precisa da data de início da janela logo depois dela.' };
  if (dates.length > 2) {
    return { error: `A linha aceita no máximo duas datas (janela: i<início> <fim>) — recebi ${dates.length}.` };
  }

  let earliestArrivalMs: number | null = null;
  let exactArrivalMs: number | null = null;
  if (dates.length === 1) {
    const only = dates[0]!;
    if (only.markedEarliest) {
      return { error: 'A marca "i" abre uma JANELA e exige a data-alvo: use i<início> <fim>.' };
    }
    exactArrivalMs = resolveDateMs(only.parts, nowMs, yearHint, nowMs - ONE_HOUR_MS);
  } else if (dates.length === 2) {
    const start = dates[0]!;
    const end = dates[1]!;
    if (!start.markedEarliest) {
      return { error: 'Duas datas exigem a marca "i" na primeira (janela: i<início> <fim>).' };
    }
    if (end.markedEarliest) {
      return { error: 'A marca "i" pertence à data de INÍCIO da janela, não à data-alvo.' };
    }
    earliestArrivalMs = resolveDateMs(start.parts, nowMs, yearHint, nowMs - ONE_HOUR_MS);
    exactArrivalMs = resolveDateMs(end.parts, nowMs, yearHint, earliestArrivalMs);
    if (exactArrivalMs < earliestArrivalMs) {
      return { error: 'O início da janela não pode ser depois da data-alvo.' };
    }
  }

  return { target: coordinate, units, earliestArrivalMs, exactArrivalMs };
}

/**
 * Lista de linhas de um texto colado (uma por linha): linha vazia é ignorada,
 * linha ilegível vira `{ raw, error }` e NUNCA entra na lista de linhas — o
 * painel mostra os erros ao lado do que foi aceito.
 */
export function parseSupportLines(
  text: string,
  nowMs: number,
): { lines: SupportLine[]; errors: { raw: string; error: string }[] } {
  const lines: SupportLine[] = [];
  const errors: { raw: string; error: string }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const raw = rawLine.trim();
    if (raw === '') continue;
    const parsed = parseSupportLine(raw, nowMs);
    if ('error' in parsed) errors.push({ raw, error: parsed.error });
    else lines.push(parsed);
  }
  return { lines, errors };
}

/** Instante alvo da linha: imediato (sem datas), cravado (uma data) ou janela (`i` + duas datas). */
export function lineTiming(line: SupportLine): SupportLineTiming {
  if (line.exactArrivalMs === null) return 'imediato';
  return line.earliestArrivalMs === null ? 'cravado' : 'janela';
}

/**
 * Texto canônico da linha, na MESMA gramática do jogo (roundtrip estável com
 * `parseSupportLine` no mesmo instante de referência). O ano não é escrito — a
 * linha do jogo não o tem.
 */
export function formatSupportLine(line: SupportLine): string {
  const units = SUPPORT_LINE_UNIT_KEYS.map((unit) => {
    const amount = line.units[unit] ?? 0;
    return Number.isFinite(amount) && amount > 0 ? String(Math.floor(amount)) : '0';
  }).join('/');
  const head = `${line.target.x}|${line.target.y} ${units}`;
  const exactArrivalMs = line.exactArrivalMs;
  if (exactArrivalMs === null || !Number.isFinite(exactArrivalMs)) return head;
  const earliestArrivalMs = line.earliestArrivalMs;
  if (earliestArrivalMs === null || !Number.isFinite(earliestArrivalMs)) {
    return `${head} ${formatDateMs(exactArrivalMs)}`;
  }
  return `${head} i${formatDateMs(earliestArrivalMs)} ${formatDateMs(exactArrivalMs)}`;
}

const quantitySchema = z.number().int().nonnegative().max(1_000_000_000);
const coordinateSchema = z.number().int().min(0).max(999);
const arrivalSchema = z.number().int().nonnegative().nullable();

/** Contrato persistível da linha (settings/estado do painel): 10 unidades exatas e sem negativo. */
export const supportLineSchema = z
  .object({
    target: z.object({ x: coordinateSchema, y: coordinateSchema }).strict(),
    units: z
      .object({
        spear: quantitySchema,
        sword: quantitySchema,
        axe: quantitySchema,
        archer: quantitySchema,
        spy: quantitySchema,
        light: quantitySchema,
        marcher: quantitySchema,
        heavy: quantitySchema,
        ram: quantitySchema,
        catapult: quantitySchema,
      })
      .strict(),
    earliestArrivalMs: arrivalSchema,
    exactArrivalMs: arrivalSchema,
  })
  .strict()
  .refine(
    (line) =>
      line.earliestArrivalMs === null ||
      line.exactArrivalMs === null ||
      line.earliestArrivalMs <= line.exactArrivalMs,
    { path: ['exactArrivalMs'], message: 'O início da janela não pode ser depois da data-alvo' },
  );
