/**
 * Distribuidor de Apoios (`place&mode=call`) — partes PURAS do launcher
 * `vanta-apoiomassa`: sem DOM, sem rede e sem relógio próprio (todo instante
 * entra por parâmetro), para rodar em node nos testes.
 *
 * Três convenções de tempo convivem aqui e precisam ficar explícitas:
 *
 * 1. **Instante de referência** (`referenceMs`): o epoch cujo `getUTC*` devolve
 *    os DÍGITOS do relógio do SERVIDOR. É a convenção do `support-line-codec`
 *    (as datas da linha se lêem em UTC), então `parseSupportLines`/`formatSupportLine`
 *    recebem exatamente este instante — nada de `Date.now()` cru.
 * 2. **Relógio local**: a mesma data/hora na convenção do Hub (o Agendador grava
 *    `sendAt` como ISO de um `Date` construído com os dígitos no fuso da máquina
 *    — `serverNowIso` do painel). `schedulerIsoFromReferenceMs` faz a ponte.
 * 3. **datetime-local**: o operador digita dígitos; `toDatetimeLocalValue` e
 *    `fromDatetimeLocalValue` tratam esses dígitos como os dígitos da REFERÊNCIA
 *    (não do fuso da máquina) para que o horário digitado seja o horário do jogo.
 *
 * O resto é agregação/forma: totais das 12 colunas, origens do distribuidor,
 * texto do fórum, prévia, fila de execução e os registros que o Agendador
 * consome. Nada aqui decide sozinho: o motor de distribuição é o
 * `support-distributor` e o motor de execução é o Agendador.
 */

import {
  SUPPORT_LINE_UNITS,
  SUPPORT_LINE_UNIT_LABELS,
  lineTiming,
  type SupportLine,
} from '../../ext/modules/features/mass-support/support-line-codec';
import type {
  DistributionMode,
  DistributionResult,
  DistributorInput,
  DistributorOrigin,
  OriginPreference,
} from '../../ext/modules/features/mass-support/support-distributor';
import { fnv1a64 } from '../../ext/modules/shared/canonical-ids';

const ONE_HOUR_MS = 3_600_000;

/** 12 colunas de tropa do painel: as 10 do codec mais paladino e nobre. */
export const TROOP_UNITS: readonly string[] = Object.freeze([...SUPPORT_LINE_UNITS, 'knight', 'snob']);

/** Rótulos pt-BR das 12 colunas (mesma ordem do codec; paladino/nobre no fim). */
export const TROOP_UNIT_LABELS: Readonly<Record<string, string>> = ((): Readonly<Record<string, string>> => {
  const labels: Record<string, string> = {};
  SUPPORT_LINE_UNITS.forEach((unit, index) => {
    labels[unit] = SUPPORT_LINE_UNIT_LABELS[index] ?? unit;
  });
  labels['knight'] = 'paladino';
  labels['snob'] = 'nobre';
  return Object.freeze(labels);
})();

/** Tropas zeradas nas 12 colunas. */
export function zeroTroops(): Record<string, number> {
  const troops: Record<string, number> = {};
  for (const unit of TROOP_UNITS) troops[unit] = 0;
  return troops;
}

/** Inteiro >= 0 de um valor possivelmente ausente/sujo (fail-closed: lixo = 0). */
function amount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Uma linha lida da tabela NATIVA de tropas (`#village_troup_list tr.call-village`). */
export interface NativeTroopRow {
  /** Id da aldeia (0 quando a linha não expõe id — a linha ainda conta no total). */
  readonly villageId: number;
  readonly coord: { readonly x: number; readonly y: number } | null;
  readonly units: Readonly<Record<string, number>>;
}

/** Soma as linhas da tabela nativa nas 12 colunas ("Total de tropas disponíveis"). */
export function sumNativeTroopRows(rows: readonly NativeTroopRow[]): Record<string, number> {
  const totals = zeroTroops();
  for (const row of rows) {
    for (const unit of TROOP_UNITS) totals[unit] = (totals[unit] ?? 0) + amount(row.units[unit]);
  }
  return totals;
}

/**
 * Soma das linhas VÁLIDAS do textarea (só as 10 unidades do codec — a linha de
 * apoio não carrega paladino/nobre).
 */
export function sumLineUnits(lines: readonly SupportLine[]): Record<string, number> {
  const totals = zeroTroops();
  for (const line of lines) {
    for (const unit of TROOP_UNITS) totals[unit] = (totals[unit] ?? 0) + amount(line.units[unit]);
  }
  return totals;
}

// ── Agendador (registros vivos do storage do motor) ────────────────────────

/** Subconjunto do `ScheduledCommandRecord` que interessa ao launcher. */
export interface LiveScheduledRecord {
  readonly kind: string;
  readonly sourceVillageId: string;
  readonly units: Readonly<Record<string, number>>;
}

const TERMINAL_EVENT_STATUSES: ReadonlySet<string> = new Set(['enviado', 'incerto', 'falhou', 'removido']);

function readRecordUnits(raw: unknown): Record<string, number> {
  const units = zeroTroops();
  if (typeof raw !== 'object' || raw === null) return units;
  for (const [unit, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!TROOP_UNITS.includes(unit)) continue;
    units[unit] = amount(typeof value === 'number' ? value : Number(value));
  }
  return units;
}

/**
 * Registros VIVOS do Agendador a partir do estado cru do storage
 * (`tsh-auto:<mundo>:command-scheduler:scheduler`): fora os pausados e os que
 * têm evento terminal como ÚLTIMO evento — mesmo critério da home e da tela
 * Comandos (histórico não infla a conta de tropas comprometidas).
 */
export function liveScheduledRecords(raw: unknown): LiveScheduledRecord[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const commands = (raw as { commands?: unknown }).commands;
  if (!Array.isArray(commands)) return [];
  const records: LiveScheduledRecord[] = [];
  for (const entry of commands) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { kind?: unknown; paused?: unknown; sourceVillageId?: unknown; units?: unknown; events?: unknown };
    if (record.paused === true) continue;
    const events = Array.isArray(record.events) ? record.events : [];
    const last: unknown = events.at(-1);
    if (typeof last === 'object' && last !== null) {
      const status = (last as { status?: unknown }).status;
      if (typeof status === 'string' && TERMINAL_EVENT_STATUSES.has(status)) continue;
    }
    records.push({
      kind: typeof record.kind === 'string' ? record.kind : '',
      sourceVillageId: typeof record.sourceVillageId === 'string' ? record.sourceVillageId.replace(/^n/, '') : '',
      units: readRecordUnits(record.units),
    });
  }
  return records;
}

/** Soma as tropas (12 colunas) de uma lista de registros vivos. */
function sumRecords(records: readonly LiveScheduledRecord[]): Record<string, number> {
  const totals = zeroTroops();
  for (const record of records) {
    for (const unit of TROOP_UNITS) totals[unit] = (totals[unit] ?? 0) + amount(record.units[unit]);
  }
  return totals;
}

/** Soma das tropas comprometidas com APOIOS vivos (a linha "Comprometidas"). */
export function scheduledCommittedUnits(records: readonly LiveScheduledRecord[]): Record<string, number> {
  return sumRecords(records.filter((record) => record.kind === 'support'));
}

/**
 * Tropas comprometidas por aldeia de origem, somando TODO comando vivo (ataque,
 * apoio, fake, nobre ou cancelamento consomem as tropas da origem) — é o mapa
 * que o distribuidor desconta quando "ignorar comandos agendados" está ligado.
 */
export function scheduledUnitsByVillage(
  records: readonly LiveScheduledRecord[],
): Record<string, Record<string, number>> {
  const byVillage: Record<string, Record<string, number>> = {};
  for (const record of records) {
    if (record.sourceVillageId === '') continue;
    const totals = byVillage[record.sourceVillageId] ?? zeroTroops();
    for (const unit of TROOP_UNITS) totals[unit] = (totals[unit] ?? 0) + amount(record.units[unit]);
    byVillage[record.sourceVillageId] = totals;
  }
  return byVillage;
}

// ── Distribuidor (input pronto para a engine) ──────────────────────────────

/** Configuração do popup "Avançado" (defaults do produto). */
export interface DistributorSettings {
  readonly mode: DistributionMode;
  readonly preference: OriginPreference;
  readonly includeSlowerUnits: boolean;
  readonly skipVillagesWithPaladin: boolean;
  readonly ignoreScheduled: boolean;
  readonly allowAttackedVillages: boolean;
  readonly avoidMsConflicts: boolean;
  readonly reserveUnits: Readonly<Record<string, number>>;
}

export const DEFAULT_DISTRIBUTOR_SETTINGS: DistributorSettings = Object.freeze({
  mode: 'minimo',
  preference: 'mais_perto',
  includeSlowerUnits: false,
  skipVillagesWithPaladin: false,
  ignoreScheduled: true,
  allowAttackedVillages: false,
  // Default ON (decisão da spec): dois envios agendados no mesmo ms são
  // recusados pelo jogo.
  avoidMsConflicts: true,
  reserveUnits: Object.freeze({}),
});

/** Config dos selects/checkboxes persistida (leitura defensiva de JSON solto). */
export function normalizeDistributorSettings(raw: unknown): DistributorSettings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_DISTRIBUTOR_SETTINGS;
  const value = raw as Partial<Record<keyof DistributorSettings, unknown>>;
  const bool = (input: unknown, fallback: boolean): boolean => (typeof input === 'boolean' ? input : fallback);
  const reserve: Record<string, number> = {};
  if (typeof value.reserveUnits === 'object' && value.reserveUnits !== null) {
    for (const unit of TROOP_UNITS) {
      const raw2 = (value.reserveUnits as Record<string, unknown>)[unit];
      reserve[unit] = amount(typeof raw2 === 'number' ? raw2 : Number(raw2));
    }
  }
  return {
    mode: value.mode === 'maximo' || value.mode === 'pacotes' ? value.mode : 'minimo',
    preference: value.preference === 'mais_longe' ? 'mais_longe' : 'mais_perto',
    includeSlowerUnits: bool(value.includeSlowerUnits, DEFAULT_DISTRIBUTOR_SETTINGS.includeSlowerUnits),
    skipVillagesWithPaladin: bool(value.skipVillagesWithPaladin, DEFAULT_DISTRIBUTOR_SETTINGS.skipVillagesWithPaladin),
    ignoreScheduled: bool(value.ignoreScheduled, DEFAULT_DISTRIBUTOR_SETTINGS.ignoreScheduled),
    allowAttackedVillages: bool(value.allowAttackedVillages, DEFAULT_DISTRIBUTOR_SETTINGS.allowAttackedVillages),
    avoidMsConflicts: bool(value.avoidMsConflicts, DEFAULT_DISTRIBUTOR_SETTINGS.avoidMsConflicts),
    reserveUnits: reserve,
  };
}

export interface DistributorInputSources {
  readonly rows: readonly NativeTroopRow[];
  readonly lines: readonly SupportLine[];
  readonly settings: DistributorSettings;
  readonly scheduledUnitsByVillage: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly travelMinutes: DistributorInput['travelMinutes'];
  readonly unitSpeedsMinutesPerField: Readonly<Record<string, number>>;
}

/**
 * Monta o `DistributorInput` das origens visíveis. Só linhas com COORDENADA
 * viram origem (sem coordenada não existe viagem). `hasPaladin` é best-effort
 * pela coluna `knight > 0` da tabela nativa; `underAttack` fica SEMPRE false —
 * esta tela não expõe quais aldeias estão sob ataque (fonte seria a Visão geral
 * de aldeias, outra aba), então a flag "apoiar com aldeias atacadas" não filtra
 * nada e o `skipVillagesWithPaladin` é a única guarda de origem efetiva.
 */
export function buildDistributorInput(sources: DistributorInputSources): DistributorInput {
  const origins: DistributorOrigin[] = [];
  for (const row of sources.rows) {
    if (row.coord === null) continue;
    const units = zeroTroops();
    for (const unit of TROOP_UNITS) units[unit] = amount(row.units[unit]);
    origins.push({
      villageId: row.villageId,
      x: row.coord.x,
      y: row.coord.y,
      units,
      hasPaladin: (units['knight'] ?? 0) > 0,
      underAttack: false,
      scheduledUnits: sources.scheduledUnitsByVillage[String(row.villageId)] ?? {},
    });
  }
  const reserveUnits = zeroTroops();
  for (const unit of TROOP_UNITS) reserveUnits[unit] = amount(sources.settings.reserveUnits[unit]);
  return {
    origins,
    lines: [...sources.lines],
    mode: sources.settings.mode,
    preference: sources.settings.preference,
    includeSlowerUnits: sources.settings.includeSlowerUnits,
    skipVillagesWithPaladin: sources.settings.skipVillagesWithPaladin,
    ignoreScheduled: sources.settings.ignoreScheduled,
    allowAttackedVillages: sources.settings.allowAttackedVillages,
    avoidMsConflicts: sources.settings.avoidMsConflicts,
    reserveUnits,
    travelMinutes: sources.travelMinutes,
    unitSpeedsMinutesPerField: sources.unitSpeedsMinutesPerField,
  };
}

// ── Tempo ──────────────────────────────────────────────────────────────────

const TIME_RE = /(\d{1,2}):(\d{2})(?::(\d{2}))?/;
const DATE_RE = /(\d{1,2})\/(\d{1,2})\/(\d{4})/;

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

function utcParts(referenceMs: number): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
} {
  const date = new Date(referenceMs);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    millisecond: date.getUTCMilliseconds(),
  };
}

/**
 * Instante de referência a partir dos textos do jogo (`#serverDate` dd/mm/aaaa e
 * `#serverTime` hh:mm[:ss]). Sem os textos legíveis, cai no relógio LOCAL lido
 * como dígitos de referência — assim o que o operador vê no jogo e o que o
 * painel calcula continuam alinhados mesmo sem a hora do servidor.
 */
export function referenceMsFromServerClock(
  serverDateText: string,
  serverTimeText: string,
  fallbackMs: number,
): number {
  const time = TIME_RE.exec(serverTimeText.trim());
  if (time === null) return fallbackMs;
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  const second = time[3] === undefined ? 0 : Number(time[3]);
  if (hour > 23 || minute > 59 || second > 59) return fallbackMs;
  const date = DATE_RE.exec(serverDateText.trim());
  if (date === null) {
    const now = new Date();
    return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, second, 0);
  }
  const year = Number(date[3]);
  const month = Number(date[2]);
  const day = Number(date[1]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return fallbackMs;
  return Date.UTC(year, month - 1, day, hour, minute, second, 0);
}

/** Fallback de `referenceMsFromServerClock`: relógio local com os dígitos UTC. */
export function localReferenceMs(now = new Date()): number {
  return Date.UTC(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    now.getMilliseconds(),
  );
}

/**
 * O mesmo instante na convenção do AGENDADOR: um `Date` construído com os
 * dígitos no fuso da máquina (é o que `serverNowIso` grava em `sendAt`) →
 * ISO 8601. O motor compara `sendAt` com o relógio local, então a ponte é
 * esta — gravar o ISO direto da referência adiantaria/atrasaria pelo offset.
 */
export function schedulerIsoFromReferenceMs(referenceMs: number): string {
  const parts = utcParts(referenceMs);
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond).toISOString();
}

/** "24/08 22:44:18.500" (dígitos de referência; ms só quando != 0). */
export function formatReferenceMs(referenceMs: number, withMs = true): string {
  const parts = utcParts(referenceMs);
  const base = `${pad(parts.day)}/${pad(parts.month)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
  return withMs && parts.millisecond !== 0 ? `${base}.${pad(parts.millisecond, 3)}` : base;
}

/** Valor de `<input type="datetime-local">` com os dígitos de referência. */
export function toDatetimeLocalValue(referenceMs: number): string {
  const parts = utcParts(referenceMs);
  return (
    `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}` +
    `T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`
  );
}

/** `datetime-local` (dígitos do jogo) → instante de referência; null = inválido. */
export function fromDatetimeLocalValue(value: string): number | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const millisecond = match[7] === undefined ? 0 : Number(match[7].padEnd(3, '0'));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const resolved = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  return new Date(resolved).getUTCDate() === day ? resolved : null;
}

/**
 * Texto colado → instante de referência (botão "colar" dos popups). Aceita o
 * que o jogo mostra e o que o fórum publica:
 * - `24/08/2026 22:44:18`, `24/08 22:44`, `24/08-22:44:18.500`, ISO `2026-08-24T22:44:18`;
 * - só a hora (`22:44:18`): usa o dia da referência e, se o horário já passou
 *   mais de 1h, rola para o dia seguinte (mesma regra de ano do codec).
 * Devolve null quando nada casar — quem colou vê a mensagem e digita.
 */
export function parsePastedTimeMs(text: string, referenceNowMs: number): number | null {
  const raw = text.trim().replace(/\s+/g, ' ');
  if (raw === '') return null;
  const now = utcParts(referenceNowMs);

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/.exec(raw);
  if (iso !== null) {
    const resolved = fromDatetimeLocalValue(raw.replace(' ', 'T'));
    return resolved;
  }

  const withDate = /(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}))?[\sT-]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,:](\d{1,3}))?/.exec(raw);
  if (withDate !== null) {
    const day = Number(withDate[1]);
    const month = Number(withDate[2]);
    const hour = Number(withDate[4]);
    const minute = Number(withDate[5]);
    const second = withDate[6] === undefined ? 0 : Number(withDate[6]);
    const millisecond = withDate[7] === undefined ? 0 : Number(withDate[7].padEnd(3, '0'));
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
    const explicitYear = withDate[3];
    const year = explicitYear === undefined ? now.year : Number(explicitYear);
    const resolved = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    if (new Date(resolved).getUTCDate() !== day) return null;
    // Sem ano explícito e já no passado (> 1h): é o ano que vem.
    if (explicitYear === undefined && resolved < referenceNowMs - ONE_HOUR_MS) {
      return Date.UTC(year + 1, month - 1, day, hour, minute, second, millisecond);
    }
    return resolved;
  }

  const timeOnly = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,:](\d{1,3}))?$/.exec(raw);
  if (timeOnly !== null) {
    const hour = Number(timeOnly[1]);
    const minute = Number(timeOnly[2]);
    const second = timeOnly[3] === undefined ? 0 : Number(timeOnly[3]);
    const millisecond = timeOnly[4] === undefined ? 0 : Number(timeOnly[4].padEnd(3, '0'));
    if (hour > 23 || minute > 59 || second > 59) return null;
    const sameDay = Date.UTC(now.year, now.month - 1, now.day, hour, minute, second, millisecond);
    return sameDay < referenceNowMs - ONE_HOUR_MS
      ? Date.UTC(now.year, now.month - 1, now.day + 1, hour, minute, second, millisecond)
      : sameDay;
  }
  return null;
}

// ── Apresentação (prévia, fórum) ───────────────────────────────────────────

/** "100 lança, 50 espada" (só o que é > 0); vazio = "—". */
export function formatUnitsSummary(units: Readonly<Record<string, number>>): string {
  const parts: string[] = [];
  for (const unit of TROOP_UNITS) {
    const value = amount(units[unit]);
    if (value <= 0) continue;
    parts.push(`${value} ${TROOP_UNIT_LABELS[unit] ?? unit}`);
  }
  return parts.length === 0 ? '—' : parts.join(', ');
}

/** Chegada da linha em texto curto: "imediato", "24/08 22:44:18.500" ou a janela. */
export function formatArrivalLabel(line: SupportLine): string {
  const timing = lineTiming(line);
  if (line.exactArrivalMs === null) return 'imediato';
  if (timing === 'janela' && line.earliestArrivalMs !== null) {
    return `${formatReferenceMs(line.earliestArrivalMs)} → ${formatReferenceMs(line.exactArrivalMs)}`;
  }
  return formatReferenceMs(line.exactArrivalMs);
}

/**
 * Tabela BBCode do fórum (sintaxe do jogo: `[table]` + `[**]` no cabeçalho e
 * `[*]` nas células; `[coord]` e `[unit]` renderizam link e ícone). Sem linha
 * válida devolve string vazia — o painel avisa em vez de copiar tabela oca.
 */
export function buildForumTable(lines: readonly SupportLine[]): string {
  if (lines.length === 0) return '';
  const rows = lines.map((line) => {
    const troops = SUPPORT_LINE_UNITS.filter((unit) => amount(line.units[unit]) > 0)
      .map((unit) => `[unit]${unit}[/unit] ${amount(line.units[unit])}`)
      .join(' ');
    return `[*][coord]${line.target.x}|${line.target.y}[/coord][*]${troops === '' ? '—' : troops}[*]${formatArrivalLabel(line)}`;
  });
  return ['[table]', '[**]Aldeia[**]Tropas[**]Chegada', ...rows, '[/table]'].join('\n');
}

export interface PreviewRow {
  readonly origin: string;
  readonly target: string;
  readonly units: string;
  readonly departure: string;
}

/** Assignments → linhas de prévia (origem → destino → unidades → partida). */
export function assignmentsToPreview(
  assignments: DistributionResult['assignments'],
  lines: readonly SupportLine[],
  originLabel: (villageId: number) => string,
): PreviewRow[] {
  return assignments.map((assignment) => {
    const line = lines[assignment.lineIndex];
    return {
      origin: originLabel(assignment.originVillageId),
      target: line === undefined ? '—' : `${line.target.x}|${line.target.y}`,
      units: formatUnitsSummary(assignment.units),
      departure: assignment.departAtMs === null ? 'agora' : formatReferenceMs(assignment.departAtMs),
    };
  });
}

/** Linhas não atendidas em pt-BR (o que faltou em cada linha do texto). */
export function unmetToPreview(
  unmet: DistributionResult['unmet'],
  lines: readonly SupportLine[],
): string[] {
  return unmet.map((entry) => {
    const line = lines[entry.lineIndex];
    const where =
      line === undefined
        ? `Linha ${entry.lineIndex + 1}`
        : `Linha ${entry.lineIndex + 1} (${line.target.x}|${line.target.y})`;
    // Recusa por colisão de ms: `missing` vem zerado de propósito — o motivo é
    // a informação útil (sem ele a mensagem diria "nada a enviar", que é falso).
    if (entry.reason !== undefined && entry.reason.trim() !== '') {
      return `${where}: recusado: ${entry.reason.trim()}`;
    }
    const missing = formatUnitsSummary(entry.missing);
    return missing === '—' ? `${where}: nenhuma tropa pedida — nada a enviar.` : `${where}: faltou ${missing}.`;
  });
}

// ── Fila de execução (persistida: a página navega a cada envio) ────────────

export interface RunEntry {
  readonly originVillageId: number;
  readonly origin: { readonly x: number; readonly y: number } | null;
  readonly target: { readonly x: number; readonly y: number };
  readonly units: Readonly<Record<string, number>>;
  /** Partida calculada (instante de referência) ou null na linha imediata. */
  readonly departAtMs: number | null;
  /** Chegada-alvo da linha (cravado/janela) ou null no imediato. */
  readonly arrivalAtMs: number | null;
  /** Marcada ANTES do clique no submit (o formulário do jogo navega). */
  readonly sentAtMs: number | null;
}

export interface SupportRun {
  readonly createdAtMs: number;
  readonly entries: readonly RunEntry[];
}

/** Resultado do distribuidor → fila persistível (uma entrada por assignment). */
export function buildRun(
  result: DistributionResult,
  lines: readonly SupportLine[],
  rows: readonly NativeTroopRow[],
  nowMs: number,
): SupportRun {
  const coordinates = new Map<number, { x: number; y: number }>();
  for (const row of rows) {
    if (row.coord !== null) coordinates.set(row.villageId, { x: row.coord.x, y: row.coord.y });
  }
  const entries: RunEntry[] = result.assignments.map((assignment) => {
    const line = lines[assignment.lineIndex];
    const coordinate = coordinates.get(assignment.originVillageId) ?? null;
    const units = zeroTroops();
    for (const unit of TROOP_UNITS) units[unit] = amount(assignment.units[unit]);
    return {
      originVillageId: assignment.originVillageId,
      origin: coordinate === null ? null : { x: coordinate.x, y: coordinate.y },
      target: line === undefined ? { x: 0, y: 0 } : { x: line.target.x, y: line.target.y },
      units,
      departAtMs: assignment.departAtMs,
      arrivalAtMs: line === undefined ? null : line.exactArrivalMs,
      sentAtMs: null,
    };
  });
  return { createdAtMs: nowMs, entries };
}

/** Índice do 1º envio pendente (-1 = fila concluída). */
export function nextPendingIndex(run: SupportRun): number {
  return run.entries.findIndex((entry) => entry.sentAtMs === null);
}

// ── Agendador: registros de apoio a partir da fila ─────────────────────────

/** Registro no formato do `ScheduledCommandRecord` (Agendador v2). */
export interface SchedulerSupportDraft {
  readonly id: string;
  readonly kind: 'support';
  readonly sourceVillageId: string;
  readonly source: { readonly x: number; readonly y: number };
  readonly target: { readonly x: number; readonly y: number };
  readonly units: Record<string, number>;
  readonly timingMode: 'send';
  readonly sendAt: string;
  readonly arrivalAt?: string;
  readonly paused: false;
  readonly createdAt: string;
  readonly events: ReadonlyArray<{ readonly status: 'agendado'; readonly at: string; readonly detail: string }>;
}

export interface SkippedRunEntry {
  readonly entry: RunEntry;
  readonly reason: string;
}

/**
 * Antecedência mínima para o Agendador mirar a janela: partidas a menos disso
 * do agora já nascem fora do `focusLeadMs` (15s) e viram "falhou" em vez de
 * serem enviadas.
 */
export const SCHEDULE_MIN_LEAD_MS = 5_000;

/**
 * Fila → registros de apoio do Agendador (`kind: 'support'`, `sendAt` = partida
 * calculada, `timingMode: 'send'`). Entrada impossível NÃO vira registro: o
 * motivo em pt-BR acompanha o par (o operador decide o que fazer). O id é
 * canônico (`cid_<fnv1a64>`) — replanejar a mesma entrada gera o MESMO id, o
 * que dá dedupe natural contra reenvio.
 */
export function buildSchedulerSupportRecords(
  run: SupportRun,
  nowMs: number,
): { records: SchedulerSupportDraft[]; skipped: SkippedRunEntry[] } {
  const records: SchedulerSupportDraft[] = [];
  const skipped: SkippedRunEntry[] = [];
  const createdAt = schedulerIsoFromReferenceMs(nowMs);
  for (const entry of run.entries) {
    if (entry.origin === null) {
      skipped.push({ entry, reason: 'aldeia de origem sem coordenada lida na tabela nativa.' });
      continue;
    }
    if (entry.departAtMs === null) {
      skipped.push({ entry, reason: 'linha sem data (imediato) — nada a agendar; use o modo Imediato.' });
      continue;
    }
    if (entry.departAtMs - nowMs < SCHEDULE_MIN_LEAD_MS) {
      skipped.push({
        entry,
        reason: `partida ${formatReferenceMs(entry.departAtMs)} já passou ou está a menos de ${Math.round(
          SCHEDULE_MIN_LEAD_MS / 1000,
        )}s do agora — janela impossível para o Agendador.`,
      });
      continue;
    }
    const units: Record<string, number> = {};
    for (const unit of TROOP_UNITS) {
      const value = amount(entry.units[unit]);
      if (value > 0) units[unit] = value;
    }
    if (Object.keys(units).length === 0) {
      skipped.push({ entry, reason: 'nenhuma unidade a enviar.' });
      continue;
    }
    const sendAt = schedulerIsoFromReferenceMs(entry.departAtMs);
    const canonical = `support|${entry.originVillageId}|${entry.target.x}|${entry.target.y}|${sendAt}|${JSON.stringify(units)}`;
    records.push({
      id: `cid_${fnv1a64(canonical)}`,
      kind: 'support',
      sourceVillageId: String(entry.originVillageId),
      source: { x: entry.origin.x, y: entry.origin.y },
      target: { x: entry.target.x, y: entry.target.y },
      units,
      timingMode: 'send',
      sendAt,
      ...(entry.arrivalAtMs === null ? {} : { arrivalAt: schedulerIsoFromReferenceMs(entry.arrivalAtMs) }),
      paused: false,
      createdAt,
      events: [{ status: 'agendado', at: createdAt, detail: 'Criado pelo Distribuidor de Apoios (Apoio em massa).' }],
    });
  }
  return { records, skipped };
}
