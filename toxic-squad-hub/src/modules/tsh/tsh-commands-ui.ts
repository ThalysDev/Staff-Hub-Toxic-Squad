// Tela "Comandos" do Agendador — abre pelo botão "Comandos" do cartão
// command-scheduler no painel (extraActions → openSchedulerCommands).
// Reutiliza o MESMO scaffold de modal das configurações (buildTshModal) e a
// MESMA storage do motor (tsh-auto:<world>:command-scheduler:scheduler), então
// o que é agendado aqui dispara sozinho no ciclo do plugin — nada de formulário
// paralelo pedindo ao usuário o que o script lê do jogo:
// - Origem: select com as ALDEIAS PRÓPRIAS (ownVillages — village.txt), default
//   = aldeia atual da URL (village=);
// - Alvo: "x|y" com lookup no mapa (villageAt → nome/pontos, com debounce);
// - Momento: "Enviar às" ou "Chegar às" — a conversão chegada→envio usa
//   travelMinutes (a MAIS LENTA unidade do conjunto; null = indisponível e o
//   modo chegada é desabilitado);
// - Lista: status derivado por deriveSchedulerCommandStatus (pausado nunca
//   dispara; terminais são fatos) — Remover grava o evento 'removido' ANTES de
//   tirar o comando da lista (se algo interromper no meio, o motor vê o
//   terminal e não dispara).
// Onda 1 (Central de Agendamentos completa): colar horário do clipboard,
// tropas em PERCENTUAL (absoluto resolvido no disparo), alvo de catapulta,
// trem de nobres 2–5, cancelamento cronometrado, repetição sequencial,
// estratégia snipe/dodge e "agendar mesmo impossível" (forced) no formulário;
// seções colapsáveis de AGENDAMENTO EM BLOCO (matriz origem×alvo com preview +
// confirm) e MAPA DE OPERAÇÕES (filtros, conflitos de ms, edição em massa e
// export/import JSON). As engines puras vivem em ext/ (noble-train,
// block-scheduler, ops-viewer) — aqui é só fiação de DOM e storage.
// Regras da casa: zero innerHTML com dado dinâmico (tudo textContent), pt-BR,
// horários com MILISSEGUNDOS na referência escolhida (Hora do servidor, padrão,
// ou do computador — convertida pelo relógio medido) e poucos timers: o
// debounce do lookup do alvo e o relógio vivo da tela (1 interval, some ao
// fechar). Partes puras exportadas para testes em
// tsh-commands-ui.test.ts.

import { icon, type IconName } from '../../core/icons';
import { gm } from '../../core/storage';
import {
  CATAPULT_TARGETS,
  deriveSchedulerCommandStatus,
  SCHEDULER_CANCEL_COUNTS,
  SCHEDULER_DEFAULT_WINDOW,
  SCHEDULER_TIMING_STRATEGIES,
  SCHEDULER_NATIVE_TRAIN_MAX_EXTRA,
  NATIVE_TRAIN_ARRIVAL_STEP_MS,
  type HubSchedulerState,
  type ScheduledCommandRecord,
  type ScheduledCommandViewStatus,
  type SchedulerTimingStrategy,
} from '../../ext/core/scheduler-state';
import {
  NOBLE_TRAIN_SIZES,
  planNobleTrain,
  validateNobleTrain,
  type NobleTrainSize,
} from '../../ext/modules/features/noble-train/noble-train-planner';
import {
  BLOCK_CALC_MODES,
  planBlockSchedule,
  type BlockCalcMode,
  type BlockCoord,
  type BlockPlanCommand,
} from '../../ext/modules/features/block-scheduler/block-scheduler-planner';
import {
  applyBulkTimeEdit,
  classifyByPopulation,
  deserializeViewerSet,
  detectDepartureConflicts,
  filterViewerCommands,
  serializeViewerSet,
  sortViewerCommands,
  VIEWER_CONFLICT_WINDOW_MS,
  VIEWER_KINDS,
  type ViewerCommand,
  type ViewerDateField,
  type ViewerFilters,
  type ViewerKind,
  type ViewerSort,
  type ViewerStatusFilter,
} from '../../ext/modules/features/ops-viewer/ops-viewer';
import type { UnitType } from '../../ext/modules/shared/module-types';
import { aimIsHot, calibrateClock, clockInfo, serverNowMs, serverOffsetMs } from '../../core/game-clock';
import { clockSourceLabel } from '../../ext/core/timing/clock-source';
import { clockLabelMs, travelDurationMs } from '../../ext/core/timing/precise-fire';
import { createScheduledCommand, UNIT_POPULATION, type NewScheduledCommandInput } from './plugins/command-scheduler';
import { getGroupOptions, getGroupVillages, type GroupVillageRow } from './tsh-groups';
import { ownVillages, travelMinutes, villageAt, type OwnVillage } from './tsh-game-data';
import { buildTshModal, tshConfirm, tshNoteBanner } from './tsh-settings-ui';
import { commandUnitStrip, kindIcon, unitIcon, unitStrip, UNIT_LABELS as UNIT_LABELS_SHARED } from './tsh-units';
import { readinessOf } from './tsh-condutor';
import { cachedNightBonus, inNightBonus, loadPlaceData, worldNightBonus, type NightBonus } from './tsh-templates';
import { frameAliveFor, readDiary } from './tsh-envio-quadro';
import {
  cancelManyCommands,
  cardActionsFor,
  countByKind,
  exportCommands,
  failureReasonOf,
  formatDelta,
  HISTORY_STATUSES,
  importCommands,
  matchesHistory,
  matchesKind,
  matchesQuery,
  precisionSummary,
  sendResultOf,
  type HistoryFilter,
  type KindFilter,
} from './tsh-central-logic';

// ── Partes puras (testadas em tsh-commands-ui.test.ts) ──

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Alvo digitado "x|y" (também aceita vírgula/ponto-e-vírgula/espaço como
 * separador) → coordenada 0–999; null = inválido (fail-closed).
 */
export function parseTargetInput(text: string): { x: number; y: number } | null {
  const match = /^\s*(\d{1,3})\s*[|,;\s]\s*(\d{1,3})\s*$/.exec(text);
  if (match === null) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x > 999 || y > 999) return null;
  return { x, y };
}

/** Distância euclidiana em campos do mapa. */
export function fieldsDistance(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

/**
 * Conversão do modo "Chegar às": envio = chegada − tempo de viagem. Onda A: a
 * viagem é arredondada ao SEGUNDO, como o jogo faz (sem isso o cravado por
 * chegada errava até ±500ms).
 */
export function arrivalToSendAt(arrival: Date, travelMinutesValue: number): Date {
  return new Date(arrival.getTime() - travelDurationMs(travelMinutesValue));
}

/** Chegada derivada do modo "Enviar às" (simétrico). */
export function sendToArrival(send: Date, travelMinutesValue: number): Date {
  return new Date(send.getTime() + travelDurationMs(travelMinutesValue));
}

/** "dd/mm HH:MM:SS.mmm" — exibição de precisão (cravados). */
export function formatTimestampMs(date: Date): string {
  return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)} ${clockLabelMs(date.getTime())}`;
}

/** Milissegundos digitados (0–999; vazio/lixo = 0). */
export function parseMillisInput(raw: string): number {
  const n = Math.floor(Number(raw.trim().replace(',', '.')));
  return Number.isFinite(n) ? Math.min(999, Math.max(0, n)) : 0;
}

/** "dd/mm HH:MM:SS" no relógio local. */
export function formatTimestamp(date: Date): string {
  return (
    `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

/** Valor para <input type="datetime-local" step="1"> no relógio local. */
export function toDatetimeLocalValue(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

/** Parse de datetime-local ("yyyy-MM-ddTHH:mm[:ss]") no relógio local; null = inválido. */
export function parseDatetimeLocal(value: string): Date | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(trimmed)) return null;
  const parsed = new Date(trimmed); // sem Z → hora LOCAL do computador
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ── Relógio do servidor × relógio local (Onda 9) ─────────────────────────────
// O usuário digita no relógio DO PC; o motor mira pelo relógio DO SERVIDOR
// (serverNow = local + offset). Para disparar quando o PC marcar T, o sendAt
// (em hora de servidor) precisa ser T + offset — P1 da revisão: o sinal era
// o inverso e o disparo saía 2×offset fora da hora.

// Onda A: o operador escolhe em que relógio DIGITA os horários. Padrão =
// Hora do SERVIDOR (é o que o jogo mostra e o que se copia das chegadas);
// "Meu computador" converte pelo offset MEDIDO (core/game-clock).
export type TimeReference = 'servidor' | 'local';
const TIME_REF_KEY = 'tsh-ui:time-ref';

export function timeReference(): TimeReference {
  return gm.get<TimeReference>(TIME_REF_KEY, 'servidor') === 'local' ? 'local' : 'servidor';
}

export function setTimeReference(ref: TimeReference): void {
  gm.set(TIME_REF_KEY, ref);
}

/** Offset puro entre as referências: 0 se os horários já são do servidor. */
export function referenceOffsetMs(ref: TimeReference, measuredOffsetMs: number): number {
  return ref === 'servidor' ? 0 : measuredOffsetMs;
}

/**
 * Offset (ms) entre o relógio em que o operador DIGITA/LÊ e o relógio do
 * servidor: 0 na referência "servidor"; o offset medido na "local".
 */
export function currentServerOffsetMs(): number {
  return referenceOffsetMs(timeReference(), serverOffsetMs());
}

/** "Agora" na referência em que o operador digita (servidor ou computador). */
export function referenceNow(): Date {
  return new Date(serverNowMs() - currentServerOffsetMs());
}

/** Horário LOCAL escolhido → epoch no RELÓGIO DO SERVIDOR (gravação do sendAt). */
export function localToServerEpoch(local: Date, offsetMs: number): number {
  return local.getTime() + offsetMs;
}

/** sendAt do registro (servidor) → Date no relógio LOCAL (exibição). */
export function serverToLocal(serverIso: string, offsetMs: number): Date {
  return new Date(Date.parse(serverIso) - offsetMs);
}

/** Inteiro com separador de milhar pt-BR (1.234) — sem Intl (determinístico). */
export function formatInt(n: number): string {
  const sign = n < 0 ? '-' : '';
  const digits = Math.abs(Math.round(n)).toString();
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += '.';
    out += digits.charAt(i);
  }
  return sign + out;
}

/** Decimal pt-BR com 1 casa quando fracionário ("12,3"; inteiro sem vírgula). */
export function formatDecimalPtBr(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  const whole = Math.floor(rounded);
  const frac = Math.round((rounded - whole) * 10);
  return frac === 0 ? formatInt(whole) : `${formatInt(whole)},${frac}`;
}

/** Leitura defensiva de caixa numérica de tropas: inteiro ≥ 1 (vazio/lixo = 0). */
export function parseUnitCount(raw: string): number {
  const trimmed = raw.trim();
  // Onda 1: "1.500" é MIL E QUINHENTAS (separador de milhar pt-BR) — antes
  // virava 1,5 → 1 unidade. Tropas nunca são fracionárias.
  if (/^\d{1,3}(\.\d{3})+$/.test(trimmed)) return Math.min(1_000_000, Number(trimmed.replace(/\./g, '')));
  const n = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1_000_000, Math.floor(n));
}

// ── Colar horário (Onda 1, A.1) ──────────────────────────────────────────────

/**
 * Horário copiado do jogo ("HH:mm:ss", "HH:mm:ss:ms" ou "HH:mm:ss.mmm"; "HH:mm"
 * também vale) → Date no relógio LOCAL, HOJE naquele horário — se o horário já
 * passou (≤ `now`), AMANHÃ. Texto ilegível/fora de faixa = null (fail-closed:
 * nada é preenchido no formulário).
 */
export function parseClipboardTime(text: string, now: Date): Date | null {
  const match = /^\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:[:.](\d{1,3}))?\s*$/.exec(text);
  if (match === null) return null;
  const hours = Number.parseInt(match[1] ?? '', 10);
  const minutes = Number.parseInt(match[2] ?? '', 10);
  const seconds = match[3] === undefined ? 0 : Number.parseInt(match[3], 10);
  const millis = match[4] === undefined ? 0 : Number.parseInt(match[4].padEnd(3, '0'), 10);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || !Number.isInteger(seconds) || !Number.isInteger(millis)) {
    return null;
  }
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, seconds, millis);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

// ── Percentual de tropas (Onda 1, A.2) ───────────────────────────────────────

/**
 * Percentual × tropas DISPONÍVEIS da origem, floor, só unidades > 0 — a conta
 * do `percentMode`, que roda no DISPARO contra as tropas atuais da aldeia de
 * origem. Percentual fora de 0–100 é clampado; disponível ilegível vale 0.
 */
export function resolvePercentUnits(
  unitsPercent: Partial<Record<UnitType, number>>,
  available: Partial<Record<UnitType, number>>,
): Partial<Record<UnitType, number>> {
  const units: Partial<Record<UnitType, number>> = {};
  for (const [rawUnit, rawPercent] of Object.entries(unitsPercent)) {
    if (!(rawUnit in UNIT_LABELS)) continue;
    const unit = rawUnit as UnitType;
    const percent = Number(rawPercent);
    const availableCount = Number(available[unit]);
    if (!Number.isFinite(percent) || percent <= 0 || !Number.isFinite(availableCount) || availableCount <= 0) continue;
    const count = Math.floor((Math.min(100, percent) / 100) * Math.floor(availableCount));
    if (count > 0) units[unit] = count;
  }
  return units;
}

// ── Listas de coordenadas e ids (Onda 1, C/D) ────────────────────────────────

/**
 * Coordenadas em texto livre (uma por linha, espaço ou ";") → lista única na
 * ordem digitada + os tokens ILEGÍVEIS (a UI avisa em vez de sumir com eles).
 * Vírgula NÃO separa entradas (ela é um separador válido de x,y no alvo).
 */
export function parseCoordList(text: string): { coords: { x: number; y: number }[]; invalid: string[] } {
  const coords: { x: number; y: number }[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const token of text.split(/[\s;]+/)) {
    if (token.trim() === '') continue;
    const parsed = parseTargetInput(token);
    if (parsed === null) {
      invalid.push(token);
      continue;
    }
    const key = `${parsed.x}|${parsed.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    coords.push(parsed);
  }
  return { coords, invalid };
}

/**
 * Sufixa "-2", "-3"… nos ids que colidem com `existing` (ou entre si) — um id
 * canônico repetido faria o motor marcar os dois comandos como enviados.
 */
export function dedupeRecordIds(
  records: readonly ScheduledCommandRecord[],
  existing: readonly string[],
): ScheduledCommandRecord[] {
  const taken = new Set(existing);
  return records.map((record) => {
    if (!taken.has(record.id)) {
      taken.add(record.id);
      return record;
    }
    let suffix = 2;
    while (taken.has(`${record.id}-${suffix}`)) suffix += 1;
    const id = `${record.id}-${suffix}`;
    taken.add(id);
    return { ...record, id };
  });
}

/** Replica o comando (1–20 vezes) com sendAt/arrivalAt + i × intervalo. */
export function replicateCommandInput(
  input: NewScheduledCommandInput,
  count: number,
  intervalMs: number,
): NewScheduledCommandInput[] {
  const total = Math.min(20, Math.max(1, Math.floor(count)));
  const step = Math.max(0, Math.floor(intervalMs));
  const sendBase = Date.parse(input.sendAt);
  if (!Number.isFinite(sendBase)) return [input];
  const arrivalBase = input.arrivalAt === undefined ? Number.NaN : Date.parse(input.arrivalAt);
  const out: NewScheduledCommandInput[] = [];
  for (let index = 0; index < total; index += 1) {
    const shift = index * step;
    out.push({
      ...input,
      sendAt: new Date(sendBase + shift).toISOString(),
      ...(Number.isFinite(arrivalBase) ? { arrivalAt: new Date(arrivalBase + shift).toISOString() } : {}),
    });
  }
  return out;
}

// ── Sequência de Nobres (Onda 1, A.4) ────────────────────────────────────────

export interface NobleTrainRecordInput {
  readonly sourceVillageId: string;
  readonly sourceName?: string;
  readonly source?: { x: number; y: number };
  readonly target: { x: number; y: number };
  readonly targetName?: string;
  readonly targetPoints?: number;
  /** Chegada do slot 0 (epoch ms, hora do SERVIDOR). */
  readonly firstArrivalMs: number;
  readonly trainSize: NobleTrainSize;
  readonly gapMs: number;
  readonly noblesAvailable: number;
  readonly allowLoneSnob: boolean;
  readonly autoSplitExtraNobles: boolean;
  /** Escolta (sem nobre) repetida em TODOS os slots; os nobres entram por slot. */
  readonly escort: Partial<Record<UnitType, number>>;
  /** Viagem em MINUTOS do conjunto de unidades; null = indisponível (recusa o plano). */
  readonly travelMinutesFor: (units: Partial<Record<UnitType, number>>) => number | null;
  /** Alvo da catapulta (só quando o conjunto tem catapulta). */
  readonly catapultTarget?: string;
  readonly forced?: boolean;
  readonly detail?: string;
}

export type BuildRecordsResult =
  | { readonly ok: true; readonly records: ScheduledCommandRecord[] }
  | { readonly ok: false; readonly message: string };

/**
 * Trem de nobres (2–5 chegadas encadeadas): `planNobleTrain` distribui os
 * nobres entre os slots (slot 0 = limpeza, sem nobre) e cada slot vira UM
 * registro `noble` com chegada = chegada do slot 0 + slot × gap e partida =
 * chegada − viagem do PRÓPRIO conjunto (o slot sem nobre pode ter viagem
 * diferente). Nobres insuficientes / viagem indisponível = recusa com mensagem
 * pt-BR (nunca um trem incompleto em silêncio).
 */
export function buildNobleTrainRecords(input: NobleTrainRecordInput): BuildRecordsResult {
  const problem = validateNobleTrain({
    trainSize: input.trainSize,
    gapMs: input.gapMs,
    noblesAvailable: input.noblesAvailable,
    allowLoneSnob: input.allowLoneSnob,
    autoSplitExtraNobles: input.autoSplitExtraNobles,
  });
  if (problem !== null) return { ok: false, message: problem };

  let plan;
  try {
    plan = planNobleTrain({
      trainSize: input.trainSize,
      gapMs: input.gapMs,
      noblesAvailable: input.noblesAvailable,
      allowLoneSnob: input.allowLoneSnob,
      autoSplitExtraNobles: input.autoSplitExtraNobles,
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const records: ScheduledCommandRecord[] = [];
  for (const slot of plan.slots) {
    const units: Partial<Record<UnitType, number>> = { ...input.escort };
    if (slot.nobles > 0) units.snob = slot.nobles;
    if (Object.values(units).every((amount) => (amount ?? 0) <= 0)) {
      return { ok: false, message: `Slot ${slot.slotIndex + 1} do trem ficou sem tropas — informe a escolta.` };
    }
    const travel = input.travelMinutesFor(units);
    if (travel === null || !Number.isFinite(travel) || travel < 0) {
      return {
        ok: false,
        message: `Tempo de viagem indisponível para o slot ${slot.slotIndex + 1} do trem — confira as unidades e as velocidades do mundo.`,
      };
    }
    const arrivalMs = input.firstArrivalMs + slot.arrivalOffsetMs;
    const hasCatapult = (units.catapult ?? 0) > 0;
    records.push(
      createScheduledCommand({
        kind: 'noble',
        sourceVillageId: input.sourceVillageId,
        ...(input.sourceName !== undefined ? { sourceName: input.sourceName } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
        target: input.target,
        ...(input.targetName !== undefined ? { targetName: input.targetName } : {}),
        ...(input.targetPoints !== undefined ? { targetPoints: input.targetPoints } : {}),
        units,
        timingMode: 'arrival',
        sendAt: new Date(arrivalMs - travel * 60_000).toISOString(),
        arrivalAt: new Date(arrivalMs).toISOString(),
        ...(hasCatapult && input.catapultTarget !== undefined && input.catapultTarget !== ''
          ? { catapultTarget: input.catapultTarget }
          : {}),
        ...(input.forced === true ? { forced: true } : {}),
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
      }),
    );
  }
  return { ok: true, records };
}

/**
 * Onda E — TREM NATIVO do jogo: 2–5 ataques COM NOBRE saindo num ÚNICO clique
 * da tela de confirmação ("Adicionar ataque adicional"); o próprio jogo espaça
 * as chegadas em 100 ms. Cada linha leva ≥1 nobre (todas na velocidade do
 * nobre — sem isso as chegadas não ficariam a 100 ms); os nobres extras vão
 * para as ÚLTIMAS linhas; a escolta se repete em todas. Vira UM registro
 * (`units` = ataque #1, `trainUnits` = #2..#N) ancorado na chegada do #1.
 */
export function buildNativeNobleTrainRecord(input: {
  readonly sourceVillageId: string;
  readonly sourceName?: string;
  readonly source?: { x: number; y: number };
  readonly target: { x: number; y: number };
  readonly targetName?: string;
  readonly targetPoints?: number;
  readonly firstArrivalMs: number;
  readonly trainSize: number;
  readonly noblesAvailable: number;
  readonly escort: Partial<Record<UnitType, number>>;
  /** Viagem em MINUTOS do ataque #1 (escolta + nobre); null = indisponível. */
  readonly travelMinutes: number | null;
  readonly catapultTarget?: string;
  readonly forced?: boolean;
}): BuildRecordsResult {
  const size = Math.floor(input.trainSize);
  if (!Number.isInteger(size) || size < 2 || size > SCHEDULER_NATIVE_TRAIN_MAX_EXTRA + 1) {
    return { ok: false, message: `O trem nativo do jogo aceita de 2 a ${SCHEDULER_NATIVE_TRAIN_MAX_EXTRA + 1} ataques.` };
  }
  if (input.noblesAvailable < size) {
    return {
      ok: false,
      message: `Trem nativo de ${size} precisa de ${size} nobres na grade (1 por ataque) — há ${input.noblesAvailable}.`,
    };
  }
  if (input.travelMinutes === null || !Number.isFinite(input.travelMinutes) || input.travelMinutes <= 0) {
    return { ok: false, message: 'Tempo de viagem indisponível — confira as unidades e as velocidades do mundo.' };
  }
  const temEscolta = Object.entries(input.escort).some(([unit, amount]) => unit !== 'snob' && unit !== 'spy' && (amount ?? 0) > 0);
  if (!temEscolta) {
    return { ok: false, message: 'Trem nativo precisa de escolta (o jogo recusa nobre sem proteção) — informe as tropas que acompanham cada nobre.' };
  }
  const nobles = new Array<number>(size).fill(1);
  for (let extra = 0; extra < input.noblesAvailable - size; extra += 1) {
    const index = size - 1 - (extra % size);
    nobles[index] = (nobles[index] ?? 1) + 1;
  }
  const rows = nobles.map((snob) => {
    const units: Partial<Record<UnitType, number>> = {};
    for (const [unit, amount] of Object.entries(input.escort)) {
      if (unit !== 'snob' && (amount ?? 0) > 0) units[unit as UnitType] = amount;
    }
    units.snob = snob;
    return units;
  });
  const [first, ...extras] = rows;
  if (first === undefined) return { ok: false, message: 'Trem vazio.' };
  const hasCatapult = (first.catapult ?? 0) > 0;
  const arrivalIso = new Date(input.firstArrivalMs).toISOString();
  const record = createScheduledCommand({
    kind: 'noble',
    sourceVillageId: input.sourceVillageId,
    ...(input.sourceName !== undefined ? { sourceName: input.sourceName } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    target: input.target,
    ...(input.targetName !== undefined ? { targetName: input.targetName } : {}),
    ...(input.targetPoints !== undefined ? { targetPoints: input.targetPoints } : {}),
    units: first,
    trainUnits: extras,
    timingMode: 'arrival',
    sendAt: new Date(input.firstArrivalMs - travelDurationMs(input.travelMinutes)).toISOString(),
    arrivalAt: arrivalIso,
    ...(hasCatapult && input.catapultTarget !== undefined && input.catapultTarget !== ''
      ? { catapultTarget: input.catapultTarget }
      : {}),
    ...(input.forced === true ? { forced: true } : {}),
    detail: `Trem nativo de ${size} ataques (chegadas a cada ${NATIVE_TRAIN_ARRIVAL_STEP_MS} ms, pelo jogo).`,
  });
  return { ok: true, records: [record] };
}

// ── Agendamento em Bloco (Onda 1, C) ─────────────────────────────────────────

export type BlockTiming =
  | { readonly mode: 'arrival'; readonly arrivalMs: number }
  | { readonly mode: 'window'; readonly fromMs: number; readonly toMs: number }
  | { readonly mode: 'asap' };

export interface BlockRecordInput {
  readonly commands: readonly BlockPlanCommand[];
  /** Aldeia PRÓPRIA da coordenada de origem; ausente = comando ignorado (aviso). */
  readonly originFor: (coord: BlockCoord) => { readonly id: string; readonly name?: string } | undefined;
  readonly targetInfoFor?: (
    coord: BlockCoord,
  ) => { readonly name?: string; readonly points?: number } | undefined;
  readonly kind: 'attack' | 'support' | 'noble' | 'fake';
  readonly units: Partial<Record<UnitType, number>>;
  readonly percentMode: boolean;
  readonly unitsPercent: Partial<Record<UnitType, number>>;
  readonly timing: BlockTiming;
  /** Agora em hora do SERVIDOR (partida no passado é recusada sem `forceLate`). */
  readonly nowMs: number;
  /** Separa partidas da MESMA origem em ≥ 5 s (cada envio abre a própria confirmação). */
  readonly avoidMsConflicts: boolean;
  /** "Forçar atraso": aceita partida no passado e marca o registro como `forced`. */
  readonly forceLate: boolean;
  readonly catapultTarget?: string;
  readonly detail?: string;
}

export interface BlockRecordsResult {
  readonly records: ScheduledCommandRecord[];
  readonly warnings: string[];
}

/** Lead do "o quanto antes" (a UI ainda mostra o preview e confirma antes). */
const BLOCK_ASAP_LEAD_MS = 5_000;

/**
 * Plano em bloco → registros individuais do Agendador (um por comando). A
 * chegada desejada vem do `timing` (única / distribuída na janela / o quanto
 * antes) e a partida = chegada − viagem do par (injetada pelo plano). Com
 * `avoidMsConflicts`, partidas da mesma origem são empurradas para frente até
 * ficarem ≥ 5 s entre si; sem `forceLate`, partida no passado é ignorada com
 * aviso (nada de comando que já nasce atrasado).
 */
export function buildBlockRecords(input: BlockRecordInput): BlockRecordsResult {
  const warnings: string[] = [];
  const records: ScheduledCommandRecord[] = [];
  const lastDepartureByOrigin = new Map<string, number>();
  const span = input.timing.mode === 'window' ? Math.max(0, input.timing.toMs - input.timing.fromMs) : 0;
  const steps = Math.max(1, input.commands.length - 1);

  const desiredDeparture = new Map<number, number>();
  input.commands.forEach((command, position) => {
    const travelMs = command.travelMinutes * 60_000;
    if (input.timing.mode === 'arrival') {
      desiredDeparture.set(command.index, input.timing.arrivalMs - travelMs);
      return;
    }
    if (input.timing.mode === 'window') {
      const offset = input.commands.length <= 1 ? 0 : Math.round((span * position) / steps);
      desiredDeparture.set(command.index, input.timing.fromMs + offset - travelMs);
      return;
    }
    desiredDeparture.set(command.index, input.nowMs + BLOCK_ASAP_LEAD_MS);
  });

  const ordered = [...input.commands].sort(
    (left, right) =>
      (desiredDeparture.get(left.index) ?? 0) - (desiredDeparture.get(right.index) ?? 0) || left.index - right.index,
  );

  for (const command of ordered) {
    const originKey = `${command.origin.x}|${command.origin.y}`;
    const targetKey = `${command.target.x}|${command.target.y}`;
    const origin = input.originFor(command.origin);
    if (origin === undefined) {
      warnings.push(`Origem ${originKey} não é uma aldeia sua (ou não foi lida) — comando ignorado.`);
      continue;
    }
    if (!Number.isFinite(command.travelMinutes) || command.travelMinutes < 0) {
      warnings.push(`Viagem indisponível de ${originKey} para ${targetKey} — comando ignorado.`);
      continue;
    }
    let departure = desiredDeparture.get(command.index) ?? input.nowMs;
    if (input.avoidMsConflicts) {
      const last = lastDepartureByOrigin.get(originKey);
      if (last !== undefined && departure < last + VIEWER_CONFLICT_WINDOW_MS) {
        departure = last + VIEWER_CONFLICT_WINDOW_MS;
      }
    }
    if (!input.forceLate && departure <= input.nowMs) {
      warnings.push(
        `Partida de ${originKey} para ${targetKey} cairia no passado — comando ignorado (ative "forçar atraso" para agendar mesmo assim).`,
      );
      continue;
    }
    const arrival = departure + command.travelMinutes * 60_000;
    // Revisão de produto (Onda 1): partida empurrada pelo espaço mínimo muda
    // a CHEGADA — o jogador precisa ver isso antes de agendar.
    const wanted = desiredDeparture.get(command.index);
    if (input.timing.mode === 'window' && wanted !== undefined && departure > wanted && arrival > input.timing.toMs) {
      warnings.push(
        `Partida de ${originKey} → ${targetKey} empurrada para fora da janela: chegaria às ${clockLabelMs(arrival)}, depois do fim (${clockLabelMs(input.timing.toMs)}) — comando ignorado. Alargue a janela ou desmarque "Evitar conflito de ms".`,
      );
      continue;
    }
    lastDepartureByOrigin.set(originKey, departure);
    if (wanted !== undefined && departure > wanted) {
      warnings.push(
        `Partida de ${originKey} → ${targetKey} empurrada +${Math.round((departure - wanted) / 1000)} s (mesma aldeia precisa de ${VIEWER_CONFLICT_WINDOW_MS / 1000} s entre envios) — chega às ${clockLabelMs(arrival)}. Para chegadas coladas da mesma aldeia, use o Trem do jogo.`,
      );
    }
    const targetInfo = input.targetInfoFor?.(command.target);
    records.push(
      createScheduledCommand({
        kind: input.kind,
        sourceVillageId: origin.id,
        ...(origin.name !== undefined ? { sourceName: origin.name } : {}),
        source: { x: command.origin.x, y: command.origin.y },
        target: { x: command.target.x, y: command.target.y },
        ...(targetInfo?.name !== undefined ? { targetName: targetInfo.name } : {}),
        ...(targetInfo?.points !== undefined ? { targetPoints: targetInfo.points } : {}),
        units: input.units,
        ...(input.percentMode ? { percentMode: true, unitsPercent: input.unitsPercent } : {}),
        timingMode: input.timing.mode === 'asap' ? 'send' : 'arrival',
        sendAt: new Date(departure).toISOString(),
        arrivalAt: new Date(arrival).toISOString(),
        ...(input.forceLate ? { forced: true } : {}),
        ...(input.catapultTarget !== undefined && input.catapultTarget !== ''
          ? { catapultTarget: input.catapultTarget }
          : {}),
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
      }),
    );
  }
  return { records, warnings };
}

// ── Mapa de Operações (Onda 1, D) ────────────────────────────────────────────

export interface ViewerSet {
  readonly commands: ViewerCommand[];
  /** Registros fora do mapa: sem coordenada de origem conhecida ou já removidos. */
  readonly skipped: number;
}

/**
 * Registros VIVOS do Agendador → comandos do Mapa de Operações. Status é o do
 * estado (relógio + eventos); `removido` fica fora (lápide) e registro sem
 * coordenada de origem não tem onde ser plotado — os dois contam em `skipped`.
 * `groupIdFor` marca o grupo da ORIGEM (filtro por grupo do mapa).
 */
export function toViewerCommands(
  records: readonly ScheduledCommandRecord[],
  now: Date,
  window: { focusLeadMs: number; allowLateMs: number } = SCHEDULER_DEFAULT_WINDOW,
  groupIdFor?: (villageId: string) => number | undefined,
): ViewerSet {
  const commands: ViewerCommand[] = [];
  let skipped = 0;
  for (const record of records) {
    const status = deriveSchedulerCommandStatus(record, now, window);
    if (status === 'removido' || record.source === undefined) {
      skipped += 1;
      continue;
    }
    const departureMs = Date.parse(record.sendAt);
    const arrivalRaw = record.arrivalAt === undefined ? Number.NaN : Date.parse(record.arrivalAt);
    const arrivalMs = Number.isFinite(arrivalRaw) ? arrivalRaw : departureMs;
    if (!Number.isFinite(departureMs)) {
      skipped += 1;
      continue;
    }
    const groupId = groupIdFor?.(record.sourceVillageId);
    commands.push({
      id: record.id,
      origin: { x: record.source.x, y: record.source.y },
      target: { x: record.target.x, y: record.target.y },
      kind: record.kind,
      departureMs,
      arrivalMs,
      status,
      order: commands.length,
      ...(record.kind === 'fake' ? { fakeFlagged: true } : {}),
      ...(groupId !== undefined ? { groupId } : {}),
    });
  }
  return { commands, skipped };
}

// ── Grade de unidades e resumo ──────────────────────────────────────────────

// P3 (revisão Onda 21): mapa único em tsh-units — sem cópia divergente.
const UNIT_LABELS: Record<UnitType, string> = UNIT_LABELS_SHARED as Record<UnitType, string>;

/** Ordem da grade de unidades + passo das setinhas (elite a passo 1). */
const UNIT_ROWS: readonly { key: UnitType; step: number }[] = [
  { key: 'spear', step: 10 },
  { key: 'sword', step: 10 },
  { key: 'axe', step: 10 },
  { key: 'archer', step: 10 },
  { key: 'spy', step: 1 },
  { key: 'light', step: 5 },
  { key: 'marcher', step: 5 },
  { key: 'heavy', step: 5 },
  { key: 'ram', step: 5 },
  { key: 'catapult', step: 5 },
  { key: 'knight', step: 1 },
  { key: 'snob', step: 1 },
];

export function unitLabel(unit: UnitType): string {
  return UNIT_LABELS[unit];
}

/** Resumo curto das tropas: "2.350 pop · Machado ×2.000, Aríete ×50, Nobre ×1" (— se vazio). */
export function summarizeUnits(units: Partial<Record<UnitType, number>>): string {
  const entries: [UnitType, number][] = [];
  for (const row of UNIT_ROWS) {
    const n = units[row.key];
    if (n !== undefined && n > 0) entries.push([row.key, n]);
  }
  if (entries.length === 0) return '—';
  const pop = entries.reduce((total, [unit, n]) => total + (UNIT_POPULATION[unit] ?? 0) * n, 0);
  const top3 = [...entries]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([unit, n]) => `${UNIT_LABELS[unit]} ×${formatInt(n)}`);
  return `${formatInt(pop)} pop · ${top3.join(', ')}`;
}

// ── Tipo de comando e status ────────────────────────────────────────────────

type CommandKind = ScheduledCommandRecord['kind'];

const KIND_ROWS: readonly { kind: CommandKind; label: string; badge: string }[] = [
  { kind: 'attack', label: 'Ataque', badge: 'tsh-badge tsh-badge--muta' },
  { kind: 'fake', label: 'Fake', badge: 'tsh-badge' },
  { kind: 'support', label: 'Apoio', badge: 'tsh-badge' },
  { kind: 'noble', label: 'Nobre', badge: 'tsh-badge tsh-badge--previa' },
  { kind: 'cancel', label: 'Cancelar', badge: 'tsh-badge tsh-badge--armed' },
];

export function commandKindLabel(kind: CommandKind): string {
  return KIND_ROWS.find((row) => row.kind === kind)?.label ?? kind;
}

export function commandKindBadgeClass(kind: CommandKind): string {
  return KIND_ROWS.find((row) => row.kind === kind)?.badge ?? 'tsh-badge';
}

export function commandStatusLabel(status: ScheduledCommandViewStatus): string {
  switch (status) {
    case 'agendado':
      return 'Agendado';
    case 'janela':
      return 'Na mira';
    case 'enviando':
      return 'Enviando';
    case 'enviado':
      return 'Enviado';
    case 'incerto':
      return 'Incerto';
    case 'falhou':
      return 'Falhou';
    case 'removido':
      return 'Removido';
    case 'pausado':
      return 'Pausado';
  }
}

export function commandStatusBadgeClass(status: ScheduledCommandViewStatus): string {
  switch (status) {
    case 'agendado':
      return 'tsh-badge tsh-badge--previa';
    case 'janela':
    case 'enviando':
      return 'tsh-badge tsh-badge--armed';
    case 'enviado':
      return 'tsh-badge tsh-badge--on';
    case 'falhou':
    case 'incerto':
      return 'tsh-badge tsh-badge--muta';
    default:
      return 'tsh-badge'; // pausado | removido
  }
}

const TERMINAL_VIEW_STATUSES: ReadonlySet<ScheduledCommandViewStatus> = new Set([
  'enviado',
  'incerto',
  'falhou',
  'removido',
]);

export interface CommandRow {
  record: ScheduledCommandRecord;
  status: ScheduledCommandViewStatus;
}

/**
 * Ordem da lista: vivos (agendados/janela/enviando/pausados) por sendAt
 * crescente (o próximo a disparar primeiro), depois o histórico por sendAt
 * decrescente (mais recente primeiro).
 */
export function orderCommandRows(
  records: readonly ScheduledCommandRecord[],
  now: Date,
  window: { focusLeadMs: number; allowLateMs: number } = SCHEDULER_DEFAULT_WINDOW,
): CommandRow[] {
  const rows = records.map((record) => ({ record, status: deriveSchedulerCommandStatus(record, now, window) }));
  const bySendAsc = (a: CommandRow, b: CommandRow): number => Date.parse(a.record.sendAt) - Date.parse(b.record.sendAt);
  const alive = rows.filter((row) => !TERMINAL_VIEW_STATUSES.has(row.status)).sort(bySendAsc);
  const history = rows.filter((row) => TERMINAL_VIEW_STATUSES.has(row.status)).sort((a, b) => bySendAsc(b, a));
  return [...alive, ...history];
}

/**
 * Limpeza do histórico (Onda C): tira os registros ENCERRADOS (enviado,
 * falhou, removido) e mantém os vivos e os INCERTOS (esses o operador precisa
 * conferir no jogo antes de apagar). Puro/testável.
 */
export function pruneCommandHistory(records: readonly ScheduledCommandRecord[]): {
  kept: ScheduledCommandRecord[];
  removed: number;
} {
  // Revisão Onda C: só FATOS gravados contam — o "falhou" derivado pelo
  // relógio (janela padrão) pode ser um comando que o motor ainda envia com a
  // tolerância configurada pelo usuário.
  const kept = records.filter((record) => {
    const last = [...record.events]
      .reverse()
      .find((event) => ['enviado', 'falhou', 'removido', 'incerto'].includes(event.status));
    return !(last !== undefined && last.status !== 'incerto');
  });
  return { kept, removed: records.length - kept.length };
}

/** Quantos itens do histórico a lista mostra (o resto fica resumido). */
export const HISTORY_VISIBLE_LIMIT = 30;

// ── Storage do motor (MESMA chave do command-scheduler) ──

const schedulerKey = (world: string): string => `tsh-auto:${world}:command-scheduler:scheduler`;

export function loadSchedulerState(world: string): HubSchedulerState {
  const stored = gm.get<Partial<HubSchedulerState>>(schedulerKey(world), {});
  return {
    commands: Array.isArray(stored.commands) ? stored.commands : [],
    transit: Array.isArray(stored.transit) ? stored.transit : [],
  };
}

export function saveSchedulerState(world: string, state: HubSchedulerState): void {
  gm.set(schedulerKey(world), state);
}

function setCommandPaused(world: string, id: string, paused: boolean): void {
  const state = loadSchedulerState(world);
  saveSchedulerState(world, {
    ...state,
    commands: state.commands.map((command) => (command.id === id ? { ...command, paused } : command)),
  });
}

/** Anexa registros ao estado do motor, com ids únicos (nada sobrescreve comando). */
export function appendSchedulerRecords(world: string, records: readonly ScheduledCommandRecord[]): ScheduledCommandRecord[] {
  const state = loadSchedulerState(world);
  const unique = dedupeRecordIds(records, state.commands.map((command) => command.id));
  saveSchedulerState(world, { ...state, commands: [...state.commands, ...unique] });
  return unique;
}

/** Edição em massa do Mapa: substitui sendAt/arrivalAt dos ids informados. */
function applySchedulerTimes(world: string, times: ReadonlyMap<string, { sendAt: string; arrivalAt?: string }>): number {
  const state = loadSchedulerState(world);
  let changed = 0;
  const commands = state.commands.map((command) => {
    const next = times.get(command.id);
    if (next === undefined) return command;
    changed += 1;
    return { ...command, sendAt: next.sendAt, ...(next.arrivalAt !== undefined ? { arrivalAt: next.arrivalAt } : {}) };
  });
  if (changed > 0) saveSchedulerState(world, { ...state, commands });
  return changed;
}

/** Rótulo pt-BR da estratégia de envio (`direto` é o default). */
export function timingStrategyLabel(strategy: SchedulerTimingStrategy | undefined): string {
  switch (strategy) {
    case 'snipe':
      return 'Snipe (cruzar o ataque que chega)';
    case 'dodge':
      return 'Dodge (sair antes do impacto e voltar)';
    default:
      return 'Direto (partida no horário calculado)';
  }
}

/** Texto do select de estratégia, na ordem do contrato. */
const TIMING_STRATEGY_LABELS: Readonly<Record<SchedulerTimingStrategy, string>> = {
  direto: 'Direto',
  snipe: 'Snipe',
  dodge: 'Dodge',
};

/** Aldeia da URL sem prefixo "n" (mesma normalização do transporte). */
const normalizeVillageId = (id: string): string => id.replace(/^n/, '');

// ── Blocos de UI (tudo textContent — nada de HTML dinâmico) ──

/** Seção-caixa Nexus: título UPPERCASE com ícone + corpo (mesmo padrão das
 *  configurações — cópia local para não exportar a mais do settings-ui). */
function sectionBoxEl(title: string, iconName: IconName): { box: HTMLDivElement; body: HTMLDivElement } {
  const box = document.createElement('div');
  box.className = 'tsh-section';
  const head = document.createElement('div');
  head.className = 'tsh-section-title';
  head.appendChild(icon(iconName, 12));
  head.appendChild(document.createTextNode(title));
  const body = document.createElement('div');
  box.append(head, body);
  return { box, body };
}

function labelEl(text: string, help?: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'tsh-field-label';
  el.appendChild(document.createTextNode(text));
  if (help !== undefined) {
    // ⓘ com tooltip CSS (data-tip, à direita). Onda B: sem title nativo (duplicava).
    const tip = document.createElement('span');
    tip.className = 'tsh-field-info tsh-tip tsh-tip--right';
    tip.setAttribute('data-tip', help);
    tip.setAttribute('aria-label', help);
    tip.appendChild(icon('info', 11));
    el.appendChild(tip);
  }
  return el;
}

function badgeEl(cls: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

function helpEl(text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'tsh-field-help';
  el.textContent = text;
  return el;
}

function statusRowEl(text: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'tsh-status-row';
  const msg = document.createElement('span');
  msg.className = 'tsh-status-msg';
  msg.textContent = text;
  row.appendChild(msg);
  return row;
}

function statusMsgOf(row: HTMLDivElement): HTMLSpanElement {
  const msg = row.querySelector('.tsh-status-msg');
  return msg instanceof HTMLSpanElement ? msg : row;
}

/** Seção COLAPSÁVEL (Onda 1): o título vira botão e o corpo abre/fecha. */
function collapsibleSectionEl(
  title: string,
  iconName: IconName,
  startOpen: boolean,
): { box: HTMLDivElement; body: HTMLDivElement; toggle: HTMLButtonElement } {
  const box = document.createElement('div');
  box.className = 'tsh-section';
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'tsh-section-title';
  head.style.width = '100%';
  head.style.background = 'none';
  head.style.border = '0';
  head.style.padding = '0';
  head.style.cursor = 'pointer';
  head.style.textAlign = 'left';
  head.appendChild(icon(iconName, 12));
  head.appendChild(document.createTextNode(title));
  const caret = document.createElement('span');
  caret.style.marginLeft = 'auto';
  caret.textContent = startOpen ? '▾' : '▸';
  head.appendChild(caret);
  const body = document.createElement('div');
  body.style.display = startOpen ? '' : 'none';
  head.addEventListener('click', () => {
    const open = body.style.display === 'none';
    body.style.display = open ? '' : 'none';
    caret.textContent = open ? '▾' : '▸';
  });
  box.append(head, body);
  return { box, body, toggle: head };
}

function selectEl(options: readonly { value: string; label: string }[]): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'tsh-select';
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    select.appendChild(el);
  }
  return select;
}

function checkboxEl(label: string, help?: string): { row: HTMLDivElement; input: HTMLInputElement } {
  const row = document.createElement('div');
  row.className = 'tsh-check-row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  const text = document.createElement('span');
  text.textContent = label;
  if (help !== undefined) {
    const tip = document.createElement('span');
    tip.className = 'tsh-field-info tsh-tip tsh-tip--right';
    tip.setAttribute('data-tip', help);
    tip.setAttribute('aria-label', help);
    tip.appendChild(icon('info', 11));
    text.appendChild(document.createTextNode(' '));
    text.appendChild(tip);
  }
  row.append(input, text);
  return { row, input };
}

function textAreaEl(placeholder: string, rows = 3): HTMLTextAreaElement {
  const area = document.createElement('textarea');
  area.className = 'tsh-textarea';
  area.rows = rows;
  area.placeholder = placeholder;
  area.setAttribute('autocomplete', 'off');
  return area;
}

function numberInputEl(value: string, min: number, max: number, step: number): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'tsh-input';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = value;
  return input;
}

/** Bloco label + controle (padrão `tsh-field--block` das outras telas). */
function fieldEl(label: HTMLSpanElement, ...controls: HTMLElement[]): HTMLDivElement {
  const field = document.createElement('div');
  field.className = 'tsh-field tsh-field--block';
  field.append(label, ...controls);
  return field;
}

// ── Grade de unidades reutilizável (form principal e bloco) ──

interface UnitsGridHandle {
  readonly grid: HTMLDivElement;
  /** Contagens ABSOLUTAS digitadas (> 0). */
  read(): Partial<Record<UnitType, number>>;
  /** Percentuais 0–100 digitados (> 0) — o mesmo conjunto de caixas. */
  readPercent(): Partial<Record<UnitType, number>>;
  reset(): void;
  /** Preenche a grade (Reagendar / modelo do jogo); `all` marca "Todas". */
  set(values: Partial<Record<string, number>>, all?: ReadonlyArray<string>): void;
  /** Unidades marcadas em "Todas" (v3.3.0). */
  readAll(): UnitType[];
  /** Mostra/esconde as caixas "Todas" (somem no modo percentual). */
  setAllEnabled(on: boolean): void;
  /** Quantas há de cada tropa agora (null = desconhecido) — aparece em "Todas (N)". */
  setAvailable(available: Partial<Record<string, number>> | null): void;
}

function buildUnitsGrid(onInput?: () => void, opts?: { allowAll?: boolean }): UnitsGridHandle {
  const grid = document.createElement('div');
  grid.className = 'tsh-record-grid';
  const inputs: { key: UnitType; input: HTMLInputElement; all: HTMLInputElement | null; allText: Text | null; cell: HTMLDivElement }[] = [];
  const applyAll = (input: HTMLInputElement, all: HTMLInputElement, cell: HTMLDivElement): void => {
    input.disabled = all.checked;
    cell.classList.toggle('is-all', all.checked);
    if (all.checked) {
      input.value = '';
      input.placeholder = 'todas';
    } else {
      input.placeholder = '';
      if (input.value === '') input.value = '0';
    }
  };
  for (const row of UNIT_ROWS) {
    const cell = document.createElement('div');
    cell.className = 'tsh-record-cell tsh-unit-cell';
    const label = document.createElement('span');
    label.className = 'tsh-record-label';
    // v3.2: ÍCONE oficial no lugar do nome (mais curto e didático) — o nome
    // fica na dica e no rótulo acessível do campo.
    label.title = unitLabel(row.key);
    label.appendChild(unitIcon(row.key, 18));
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'tsh-input';
    input.setAttribute('aria-label', unitLabel(row.key));
    input.min = '0';
    input.step = String(row.step);
    input.value = '0';
    input.addEventListener('input', () => onInput?.());
    cell.append(label, input);
    // v3.3.0: "Todas" desta tropa (como o "(200)" da Praça do jogo) — o total
    // é lido na Praça da origem na hora do disparo.
    let all: HTMLInputElement | null = null;
    let allText: Text | null = null;
    if (opts?.allowAll === true) {
      const allLabel = document.createElement('label');
      allLabel.className = 'tsh-unit-all';
      all = document.createElement('input');
      all.type = 'checkbox';
      all.setAttribute('aria-label', `Todas as unidades de ${unitLabel(row.key)}`);
      const allBox = all;
      allBox.addEventListener('change', () => {
        applyAll(input, allBox, cell);
        onInput?.();
      });
      allText = document.createTextNode('');
      const allWord = document.createElement('span');
      allWord.textContent = 'Todas';
      const allCount = document.createElement('span');
      allCount.className = 'tsh-unit-avail';
      allCount.appendChild(allText);
      allLabel.append(allBox, allWord);
      allLabel.title = `Enviar TODAS as unidades de ${unitLabel(row.key)} que houver na aldeia na hora do envio. Se não houver nenhuma: com "Chegar às" o comando não sai (se ela for a mais lenta); com "Enviar às" ele sai sem essa tropa.`;
      cell.append(allLabel, allCount);
    }
    inputs.push({ key: row.key, input, all, allText, cell });
    grid.appendChild(cell);
  }
  const readPercent = (): Partial<Record<UnitType, number>> => {
    const units: Partial<Record<UnitType, number>> = {};
    for (const { key, input } of inputs) {
      const n = Number(input.value.trim().replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0) continue;
      units[key] = Math.min(100, Math.floor(n));
    }
    return units;
  };
  return {
    grid,
    read: () => {
      const units: Partial<Record<UnitType, number>> = {};
      for (const { key, input, all } of inputs) {
        if (all?.checked === true) continue;
        const n = parseUnitCount(input.value);
        if (n > 0) units[key] = n;
      }
      return units;
    },
    readAll: () => inputs.filter((row) => row.all?.checked === true).map((row) => row.key),
    setAvailable: (available) => {
      for (const row of inputs) {
        if (row.allText === null) continue;
        const n = available?.[row.key];
        row.allText.textContent = n === undefined ? '' : `na aldeia: ${n.toLocaleString('pt-BR')}`;
        row.cell.classList.toggle('is-empty', n === 0);
      }
    },
    setAllEnabled: (on) => {
      for (const row of inputs) {
        if (row.all === null) continue;
        (row.all.parentElement as HTMLElement).hidden = !on;
        if (!on && row.all.checked) {
          row.all.checked = false;
          applyAll(row.input, row.all, row.cell);
        }
      }
    },
    readPercent,
    reset: () => {
      for (const row of inputs) {
        if (row.all !== null && row.all.checked) {
          row.all.checked = false;
          applyAll(row.input, row.all, row.cell);
        }
        row.input.value = '0';
      }
    },
    set: (values, allList) => {
      for (const row of inputs) {
        const isAll = row.all !== null && allList?.includes(row.key) === true;
        if (row.all !== null) {
          row.all.checked = isAll;
          applyAll(row.input, row.all, row.cell);
        }
        if (!isAll) row.input.value = String(values[row.key] ?? 0);
      }
    },
  };
}

/** Tropas de um comando em texto (confirmação e resultado). */
function describeUnits(record: Pick<ScheduledCommandRecord, 'units' | 'allUnits' | 'percentMode' | 'unitsPercent' | 'trainUnits'>): string {
  if (record.percentMode === true) return `${summarizePercentUnits((record.unitsPercent ?? {}) as Partial<Record<UnitType, number>>)} das tropas`;
  const partes = Object.entries(record.units)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([u, n]) => `${formatInt(n ?? 0)} ${unitLabel(u as UnitType)}`);
  for (const u of record.allUnits ?? []) partes.push(`TODAS ${unitLabel(u)}`);
  const base = partes.length > 0 ? partes.join(', ') : '—';
  return record.trainUnits !== undefined && record.trainUnits.length > 0 ? `${base} + ${record.trainUnits.length} ataque(s) no trem` : base;
}

/** Resumo curto de um conjunto de tropas em percentual (para o preview). */
export function summarizePercentUnits(unitsPercent: Partial<Record<UnitType, number>>): string {
  const entries = Object.entries(unitsPercent).filter(([, percent]) => (percent ?? 0) > 0);
  if (entries.length === 0) return '—';
  return entries.map(([unit, percent]) => `${unitLabel(unit as UnitType)} ${percent}%`).join(', ');
}

/** Registro vivo sem coordenada de origem entra no mapa? Não — contamos e avisamos. */
function viewerSkippedNote(skipped: number): string {
  return skipped === 1
    ? '1 comando ficou fora do mapa (removido ou sem coordenada de origem conhecida).'
    : `${skipped} comandos ficaram fora do mapa (removidos ou sem coordenada de origem conhecida).`;
}

// ── Fila e Histórico (v3.3.0) ──

/** Filtros vivos da Fila/Histórico (sobrevivem aos redesenhos da lista). */
interface ListFilters {
  query: string;
  kind: KindFilter;
  history: HistoryFilter;
}

/** Ações da Central que precisam de outras partes do modal. */
interface CentralHooks {
  /** Leva o comando para a aba "Novo comando", com os campos preenchidos (novo comando). */
  reagendar(record: ScheduledCommandRecord, mode: 'reuse' | 'duplicate'): void;
  /** Abre o comando PENDENTE no formulário; salvar substitui o original. */
  editar(record: ScheduledCommandRecord): void;
}

/**
 * Por que um comando pendente NÃO pode mais ser alterado (null = pode):
 * já saiu, está na mira ou foi pré-armado (a confirmação já está aberta com
 * o horário/tropas antigos — mexer agora seria no escuro).
 */
function notEditableReason(world: string, id: string): string | null {
  const alvo = loadSchedulerState(world).commands.find((c) => c.id === id);
  if (alvo === undefined || alvo.events.some((e) => HISTORY_STATUSES.has(e.status) || e.status === 'enviando')) {
    return 'Este comando já saiu da fila — nada foi alterado.';
  }
  const statusAgora = deriveSchedulerCommandStatus(alvo, new Date(serverNowMs()), SCHEDULER_DEFAULT_WINDOW);
  const prearm = gm.get<{ id?: string; at?: number } | null>(
    `tsh-auto:${world}:command-scheduler:prearm:${normalizeVillageId(alvo.sourceVillageId)}`,
    null,
  );
  const prearmado = prearm !== null && prearm.id === alvo.id && Date.now() - (prearm.at ?? 0) < 45_000;
  if ((statusAgora !== 'agendado' && statusAgora !== 'pausado') || prearmado) {
    return 'Este comando já está na mira (pré-armado) — não dá para alterá-lo agora. Cancele o envio e crie outro.';
  }
  return null;
}

const KIND_FILTER_OPTIONS: readonly { value: KindFilter; label: string }[] = [
  { value: 'todos', label: 'Todos os tipos' },
  { value: 'attack', label: 'Ataque' },
  { value: 'fake', label: 'Fake' },
  { value: 'support', label: 'Apoio' },
  { value: 'noble', label: 'Nobre' },
  { value: 'cancel', label: 'Cancelar' },
];

function rowsOf(world: string): CommandRow[] {
  return orderCommandRows(loadSchedulerState(world).commands, new Date(serverNowMs()));
}

/** Fila: comandos que ainda vão sair (pendentes, na mira, enviando, pausados). */
function renderQueue(
  wrap: HTMLElement,
  shadow: ShadowRoot,
  world: string,
  filters: ListFilters,
  hooks: CentralHooks,
  rerender: () => void,
  refresh: () => void,
): void {
  wrap.replaceChildren();
  const alive = rowsOf(world).filter((row) => !HISTORY_STATUSES.has(row.status));
  if (alive.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'shs-empty';
    empty.textContent = 'Nenhum comando na fila. Crie um em "Novo comando" ou vários em "Em bloco".';
    wrap.appendChild(empty);
    return;
  }
  const shown = alive.filter((row) => matchesQuery(row.record, filters.query) && matchesKind(row.record, filters.kind));
  const meta = document.createElement('div');
  meta.className = 'tsh-meta-row';
  const paused = alive.filter((row) => row.status === 'pausado').length;
  meta.textContent =
    shown.length === alive.length
      ? `${alive.length} na fila${paused > 0 ? ` · ${paused} pausado(s)` : ''}`
      : `Mostrando ${shown.length} de ${alive.length} (filtro ativo)`;
  wrap.appendChild(meta);
  if (shown.length === 0) {
    wrap.appendChild(helpEl('Nenhum comando combina com o filtro.'));
    return;
  }
  for (const row of shown) wrap.appendChild(commandCard(row, shadow, world, hooks, rerender, refresh));
}

/** Histórico: enviados, falhos, incertos e cancelados — com o desfecho de cada um. */
function renderHistory(
  wrap: HTMLElement,
  shadow: ShadowRoot,
  world: string,
  filters: ListFilters,
  hooks: CentralHooks,
  rerender: () => void,
  refresh: () => void,
): void {
  wrap.replaceChildren();
  const history = rowsOf(world).filter((row) => HISTORY_STATUSES.has(row.status));
  if (history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'shs-empty';
    empty.textContent = 'O histórico está vazio. Cada comando enviado aparece aqui com a precisão do envio.';
    wrap.appendChild(empty);
    return;
  }
  const summary = precisionSummary(history.filter((row) => row.status === 'enviado').map((row) => row.record));
  if (summary !== null) {
    const stat = document.createElement('div');
    stat.className = 'tsh-central-precision';
    stat.append(icon('crosshair', 14));
    const txt = document.createElement('span');
    txt.textContent = `Precisão: ${summary.meanAbsMs} ms de desvio médio em ${summary.count} envio(s) (pior: ${summary.worstAbsMs} ms).`;
    stat.appendChild(txt);
    wrap.appendChild(stat);
  }
  const shown = history.filter(
    (row) => matchesHistory(row.status, filters.history) && matchesQuery(row.record, filters.query) && matchesKind(row.record, filters.kind),
  );
  if (shown.length === 0) {
    wrap.appendChild(helpEl('Nenhum registro combina com o filtro.'));
    return;
  }
  for (const row of shown.slice(0, HISTORY_VISIBLE_LIMIT)) wrap.appendChild(commandCard(row, shadow, world, hooks, rerender, refresh));
  if (shown.length > HISTORY_VISIBLE_LIMIT) {
    wrap.appendChild(helpEl(`… e mais ${shown.length - HISTORY_VISIBLE_LIMIT} registro(s) antigo(s). Use "Limpar histórico" para apagar os encerrados.`));
  }
}

const EVENT_LABELS: Record<string, string> = {
  agendado: 'Agendado',
  janela: 'Pré-arme',
  enviando: 'Enviando',
  enviado: 'Enviado',
  incerto: 'Incerto',
  falhou: 'Falhou',
  removido: 'Cancelado',
};
const DIARY_LABELS: Record<string, string> = {
  abriu: 'Praça abriu',
  pronto: 'Praça pronta',
  fechou: 'Praça fechou',
  falhou: '2º plano falhou',
  'saiu-da-pagina': 'Aba saiu',
};

/**
 * "Detalhes": linha do tempo do comando — eventos do motor + o diário do
 * envio em 2º plano daquela aldeia (quando a Praça invisível abriu/fechou).
 */
function timelineEl(record: ScheduledCommandRecord, world: string): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'tsh-timeline';
  const summary = document.createElement('summary');
  summary.textContent = 'Detalhes';
  details.appendChild(summary);
  details.addEventListener(
    'toggle',
    () => {
      if (!details.open || details.dataset.filled === '1') return;
      details.dataset.filled = '1';
      const skew = serverNowMs() - Date.now();
      const sendLocal = Date.parse(record.sendAt) - skew;
      const rows: { at: number; label: string; text: string }[] = record.events.map((e) => ({
        at: Date.parse(e.at),
        label: EVENT_LABELS[e.status] ?? e.status,
        text: e.detail ?? '',
      }));
      // Só o que é DESTE envio: a abertura marcada com este horário (±5 s) e
      // o que aconteceu com o quadro até 1 min depois dele.
      const sendServer = Date.parse(record.sendAt);
      for (const d of readDiary(world, normalizeVillageId(record.sourceVillageId), sendLocal - 3 * 60_000, sendLocal + 60_000)) {
        if (d.kind === 'abriu' && d.sendAt !== undefined && Math.abs(d.sendAt - sendServer) > 5_000) continue;
        rows.push({ at: d.at, label: DIARY_LABELS[d.kind] ?? d.kind, text: d.detail });
      }
      rows.sort((a, b) => a.at - b.at);
      const list = document.createElement('ol');
      list.className = 'tsh-timeline-list';
      for (const row of rows) {
        const li = document.createElement('li');
        const when = document.createElement('span');
        when.className = 'tsh-timeline-at';
        when.textContent = Number.isFinite(row.at) ? clockLabelMs(row.at + skew) : '—';
        const tag = document.createElement('span');
        tag.className = 'tsh-timeline-tag';
        tag.textContent = row.label;
        const text = document.createElement('span');
        text.textContent = row.text;
        li.append(when, tag, text);
        list.appendChild(li);
      }
      if (rows.length === 0) list.appendChild(helpEl('Sem registros.'));
      details.appendChild(list);
      details.appendChild(helpEl('Registros da Praça invisível podem incluir outro comando da mesma aldeia no mesmo minuto.'));
    },
    { once: false },
  );
  return details;
}

/** Selo de QUEM vai enviar um comando pendente (a mesma verdade do Condutor). */
function readinessBadge(record: ScheduledCommandRecord, world: string): HTMLSpanElement | null {
  const r = readinessOf(record, world);
  const perto = Date.parse(record.sendAt) - serverNowMs() <= 30 * 60_000;
  switch (r) {
    case 'aqui':
      return badgeEl('tsh-badge tsh-badge--on', 'Esta aba envia');
    case 'pronta':
      return badgeEl('tsh-badge tsh-badge--on', frameAliveFor(world, record.sourceVillageId.replace(/^n/, '')) ? 'Pronta (2º plano)' : 'Pronta na Praça');
    case 'fundo':
      return badgeEl('tsh-badge', 'Sai em 2º plano');
    case 'automatico':
      return badgeEl('tsh-badge', 'Aba vai à Praça');
    case 'manual':
      return perto ? badgeEl('tsh-badge tsh-badge--muta', 'Sem aba na Praça') : null;
  }
}

/**
 * "Mudar horário" de um pendente: novo ENVIO (mesma referência de hora do
 * formulário); a chegada anda junto (a viagem não muda). Sem cancelar/recriar.
 */
function openTimeEditor(
  card: HTMLElement,
  record: ScheduledCommandRecord,
  world: string,
  rerender: () => void,
  refresh: () => void,
): void {
  if (card.querySelector('.tsh-time-editor') !== null) return;
  const offset = currentServerOffsetMs();
  // Comando pensado pela CHEGADA (snipe/dodge/"Chegar às"): edita a chegada.
  const byArrival = record.timingMode === 'arrival' && record.arrivalAt !== undefined;
  const current = serverToLocal(byArrival ? (record.arrivalAt as string) : record.sendAt, offset);
  const box = document.createElement('div');
  box.className = 'tsh-time-editor';
  const input = document.createElement('input');
  input.type = 'datetime-local';
  input.step = '1';
  input.className = 'tsh-input tsh-input--dt';
  input.value = toDatetimeLocalValue(current);
  input.setAttribute('aria-label', byArrival ? 'Nova chegada' : 'Novo envio');
  const ms = document.createElement('input');
  ms.type = 'number';
  ms.min = '0';
  ms.max = '999';
  ms.className = 'tsh-input tsh-input--ms';
  ms.value = String(current.getMilliseconds());
  ms.setAttribute('aria-label', 'Milissegundos');
  const msg = document.createElement('span');
  msg.className = 'tsh-time-editor-msg';
  const ref = timeReference() === 'servidor' ? 'hora do servidor' : 'hora do seu computador';
  msg.textContent = byArrival ? `Nova CHEGADA (${ref}) — o envio anda junto.` : `Novo horário de ENVIO (${ref}) — a chegada anda junto.`;
  const save = actionButton('Salvar', 'check', 'tsh-btn tsh-btn--sm tsh-btn--primary', () => {
    const base = parseDatetimeLocal(input.value);
    if (base === null) {
      msg.textContent = 'Informe data e hora completas.';
      return;
    }
    const local = new Date(base.getTime() + parseMillisInput(ms.value));
    const typed = localToServerEpoch(local, currentServerOffsetMs());
    const delta = typed - Date.parse(byArrival ? (record.arrivalAt as string) : record.sendAt);
    const newSend = Date.parse(record.sendAt) + delta;
    if (newSend <= serverNowMs() + 5_000) {
      msg.textContent = byArrival
        ? 'Com essa chegada o envio cairia no passado (ou a menos de 5 s) — escolha uma chegada mais tarde.'
        : 'O novo envio precisa ser no futuro (pelo menos 5 s a partir de agora).';
      return;
    }
    const bloqueio = notEditableReason(world, record.id);
    if (bloqueio !== null) {
      msg.textContent = bloqueio;
      return;
    }
    const alvo = loadSchedulerState(world).commands.find((c) => c.id === record.id);
    if (alvo === undefined) return;
    applySchedulerTimes(
      world,
      new Map([
        [
          record.id,
          {
            sendAt: new Date(newSend).toISOString(),
            ...(alvo.arrivalAt !== undefined ? { arrivalAt: new Date(Date.parse(alvo.arrivalAt) + delta).toISOString() } : {}),
          },
        ],
      ]),
    );
    rerender();
    refresh();
  });
  const cancel = actionButton('Cancelar', 'x', 'tsh-btn tsh-btn--sm tsh-btn--ghost', () => box.remove());
  box.append(input, ms, save, cancel, msg);
  card.appendChild(box);
  input.focus();
}

function actionButton(label: string, iconName: IconName, cls: string, onClick: () => void, title?: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = cls;
  if (title !== undefined) btn.title = title;
  btn.append(icon(iconName, 12), document.createTextNode(label));
  btn.addEventListener('click', onClick);
  return btn;
}

function commandCard(
  row: CommandRow,
  shadow: ShadowRoot,
  world: string,
  hooks: CentralHooks,
  rerender: () => void,
  refresh: () => void,
): HTMLDivElement {
  const { record, status } = row;
  const card = document.createElement('div');
  card.className = 'tsh-card tsh-ccard';
  card.dataset.status = status;
  if (status === 'pausado' || status === 'removido') card.classList.add('tsh-card--off');

  // Cabeçalho: ícone do tipo + tipo + alvo … contagem + estado.
  const head = document.createElement('div');
  head.className = 'tsh-card-head';
  const kIcon = kindIcon(record.kind, 18);
  if (kIcon !== null) head.appendChild(kIcon);
  const title = document.createElement('div');
  title.className = 'tsh-card-title';
  title.style.flex = '1';
  title.textContent =
    record.targetName !== undefined ? `${record.targetName} (${record.target.x}|${record.target.y})` : `${record.target.x}|${record.target.y}`;
  head.append(badgeEl(commandKindBadgeClass(record.kind), commandKindLabel(record.kind)), title);
  if (!HISTORY_STATUSES.has(status) && status !== 'pausado') {
    const sendAtServer = Date.parse(record.sendAt);
    if (Number.isFinite(sendAtServer)) {
      const eta = document.createElement('span');
      eta.className = 'tsh-eta';
      eta.dataset.tshEta = String(sendAtServer);
      eta.textContent = formatEta(sendAtServer - serverNowMs());
      head.appendChild(eta);
    }
  }
  if (status === 'agendado' || status === 'janela') {
    const who = readinessBadge(record, world);
    if (who !== null) head.appendChild(who);
  }
  head.appendChild(badgeEl(commandStatusBadgeClass(status), commandStatusLabel(status)));
  card.appendChild(head);

  // Origem → alvo.
  const originText = record.sourceName !== undefined ? record.sourceName : `aldeia ${record.sourceVillageId}`;
  const originCoord = record.source !== undefined ? ` (${record.source.x}|${record.source.y})` : '';
  const points = record.targetPoints !== undefined ? ` · ${formatInt(record.targetPoints)} pts` : '';
  const line1 = document.createElement('div');
  line1.className = 'tsh-card-desc';
  line1.textContent = `De ${originText}${originCoord} → ${record.target.x}|${record.target.y}${points}`;
  card.appendChild(line1);

  // Horários + tropas (ícones).
  const offset = currentServerOffsetMs();
  const sendDate = serverToLocal(record.sendAt, offset);
  const timing = Number.isFinite(sendDate.getTime())
    ? `Envio ${formatTimestampMs(sendDate)}` +
      (record.arrivalAt !== undefined ? ` · Chegada ${formatTimestampMs(serverToLocal(record.arrivalAt, offset))}` : '')
    : `Envio: ${record.sendAt} (horário ilegível)`;
  const line2 = document.createElement('div');
  line2.className = 'tsh-card-desc tsh-card-line';
  const timingEl = document.createElement('span');
  timingEl.textContent = timing;
  line2.appendChild(timingEl);
  if (record.kind === 'cancel') {
    const cancelEl = document.createElement('span');
    cancelEl.textContent = `Cancelar até ${record.cancelCount ?? 1} comando(s) no alvo`;
    line2.appendChild(cancelEl);
  } else {
    line2.appendChild(commandUnitStrip(record));
  }
  card.appendChild(line2);

  // Desfecho: precisão (enviado) ou motivo (falhou/incerto/cancelado).
  if (status === 'enviado') {
    const result = sendResultOf(record);
    const ok = document.createElement('div');
    ok.className = 'tsh-card-desc tsh-card-result';
    if (result?.confirmedAt !== undefined || result?.arrivalDeltaMs !== undefined) {
      const parts: string[] = [];
      if (result.arrivalDeltaMs !== undefined) parts.push(`Chegada conferida no jogo: ${formatDelta(result.arrivalDeltaMs)} do planejado`);
      if (result.confirmedAt !== undefined) {
        const d = result.clickDeltaMs;
        parts.push(
          d === undefined
            ? `clique às ${result.confirmedAt}`
            : d < 0
              ? `clique às ${result.confirmedAt} (${Math.abs(d)} ms antes, para compensar a latência)`
              : `clique às ${result.confirmedAt} (${formatDelta(d)} do horário)`,
        );
      }
      ok.textContent = parts.join(' · ');
    } else {
      ok.textContent = 'Enviado.';
    }
    card.appendChild(ok);
  } else if (status === 'falhou' || status === 'incerto' || status === 'removido') {
    const reason = failureReasonOf(record);
    const why = document.createElement('div');
    why.className = status === 'removido' ? 'tsh-card-desc' : 'tsh-card-desc tsh-card-why';
    why.textContent =
      status === 'incerto'
        ? `Incerto: ${reason ?? 'o envio pode ter acontecido'} — confira na Visão de Comandos do jogo.`
        : status === 'removido'
          ? reason === 'Substituído por edição.'
            ? 'Substituído por uma edição — a versão nova está na Fila.'
            : 'Cancelado antes de sair — nada foi enviado.'
          : `Motivo: ${reason ?? 'o horário passou sem envio.'}`;
    card.appendChild(why);
  }

  // Bônus noturno: ataque pendente que chega na janela (defesa em dobro).
  if (!HISTORY_STATUSES.has(status) && record.kind !== 'support' && record.kind !== 'cancel' && record.arrivalAt !== undefined) {
    if (inNightBonus(Date.parse(record.arrivalAt), cachedNightBonus())) {
      const nb = document.createElement('div');
      nb.className = 'tsh-card-desc tsh-card-warn';
      nb.textContent = 'Chega no bônus noturno (defesa ×2).';
      card.appendChild(nb);
    }
  }
  // Detalhes que mudam a leitura (estratégia, repetição, catapulta, forçar, trem).
  const extras: string[] = [];
  if (record.timingStrategy !== undefined && record.timingStrategy !== 'direto') extras.push(timingStrategyLabel(record.timingStrategy));
  if (record.sequentialCount !== undefined && record.sequentialCount > 1) extras.push(`${record.sequentialCount}×`);
  if (record.catapultTarget !== undefined && record.catapultTarget !== '') {
    extras.push(`catapulta: ${CATAPULT_TARGETS[record.catapultTarget as keyof typeof CATAPULT_TARGETS] ?? record.catapultTarget}`);
  }
  if (record.forced === true) extras.push('forçado (mesmo impossível)');
  if (record.trainUnits !== undefined && record.trainUnits.length > 0) extras.push(`trem do jogo: +${record.trainUnits.length} ataque(s)`);
  if (extras.length > 0) {
    const line3 = document.createElement('div');
    line3.className = 'tsh-card-desc';
    line3.textContent = extras.join(' · ');
    card.appendChild(line3);
  }
  for (const [i, trainRow] of (record.trainUnits ?? []).entries()) {
    const trainLine = document.createElement('div');
    trainLine.className = 'tsh-card-desc tsh-card-line';
    const tag = document.createElement('span');
    tag.textContent = `#${i + 2}`;
    tag.style.fontFamily = 'var(--shs-font-mono)';
    trainLine.append(tag, unitStrip(trainRow));
    card.appendChild(trainLine);
  }

  card.appendChild(timelineEl(record, world));
  // Ações — só as que fazem sentido no estado (enviado não se pausa).
  const acts = cardActionsFor(status);
  if (acts.length > 0) {
    const actions = document.createElement('div');
    actions.className = 'tsh-actions';
    if (status === 'agendado' || status === 'pausado') {
      actions.appendChild(actionButton('Mudar horário', 'clock', 'tsh-btn tsh-btn--sm', () => openTimeEditor(card, record, world, rerender, refresh)));
      // Trem do jogo não se remonta no formulário — só horário/cancelar.
      if (record.trainUnits === undefined || record.trainUnits.length === 0) {
        actions.appendChild(
          actionButton('Editar', 'edit', 'tsh-btn tsh-btn--sm', () => hooks.editar(record), 'Abre este comando no formulário (tropas, alvo, horário). Salvar substitui o original.'),
        );
      }
      actions.appendChild(
        actionButton('Duplicar', 'copy', 'tsh-btn tsh-btn--sm tsh-btn--ghost', () => hooks.reagendar(record, 'duplicate'), 'Cria OUTRO comando igual a este (este continua na fila). Confira o horário.'),
      );
    }
    for (const act of acts) {
      if (act === 'pausar' || act === 'retomar') {
        actions.appendChild(
          actionButton(act === 'pausar' ? 'Pausar' : 'Retomar', act === 'pausar' ? 'pause' : 'play', 'tsh-btn tsh-btn--sm', () => {
            setCommandPaused(world, record.id, act === 'pausar');
            rerender();
            refresh();
          }),
        );
      } else if (act === 'cancelar') {
        actions.appendChild(
          actionButton('Cancelar envio', 'x', 'tsh-btn tsh-btn--sm tsh-btn--danger', () => {
            void removeCommandWithConfirm(record, shadow, world, rerender, refresh);
          }),
        );
      } else if (act === 'reagendar') {
        actions.appendChild(
          actionButton('Usar de novo', 'refresh', 'tsh-btn tsh-btn--sm', () => hooks.reagendar(record, 'reuse'), 'Cria um comando NOVO com a mesma origem, alvo e tropas. Confira o horário.'),
        );
      } else {
        actions.appendChild(
          actionButton('Apagar do histórico', 'trash', 'tsh-btn tsh-btn--sm tsh-btn--ghost', () => {
            void removeCommandWithConfirm(record, shadow, world, rerender, refresh);
          }),
        );
      }
    }
    card.appendChild(actions);
  } else if (status === 'enviando') {
    card.appendChild(helpEl('Saindo agora — aguarde a confirmação do jogo.'));
  }
  return card;
}

/**
 * Remoção com confirmação: grava o evento terminal 'removido' ANTES de tirar o
 * comando da lista — se algo interromper entre as duas gravações, o motor vê o
 * status terminal e nunca dispara. 'Incerto' pede confirmação mais forte
 * (o envio pode ter acontecido). P2 (auditoria impeccable): window.confirm →
 * diálogo Nexus (tshConfirm) — handler async; o rerender/refresh só rodam
 * depois do "Confirmar".
 */
async function removeCommandWithConfirm(
  record: ScheduledCommandRecord,
  shadow: ShadowRoot,
  world: string,
  rerender: () => void,
  refresh: () => void,
): Promise<void> {
  const status = deriveSchedulerCommandStatus(record, new Date(serverNowMs()), SCHEDULER_DEFAULT_WINDOW);
  const label = `${commandKindLabel(record.kind)} → ${record.target.x}|${record.target.y}`;
  const pendente = !HISTORY_STATUSES.has(status);
  const message =
    status === 'incerto'
      ? `O envio de "${label}" está INCERTO — pode ter acontecido ou não. Apagar o registro mesmo assim?`
      : pendente
        ? `Cancelar o envio de "${label}"? Ele NÃO será enviado e fica no histórico como cancelado.`
        : `Apagar "${label}" do histórico? (não afeta o jogo)`;
  const ok = await tshConfirm(shadow, pendente ? 'Cancelar envio' : 'Apagar do histórico', message, {
    danger: true,
    okLabel: pendente ? 'Sim, cancelar o envio' : 'Apagar',
    cancelLabel: pendente ? 'Manter na fila' : 'Manter',
  });
  if (!ok) return;
  if (pendente) {
    const atual = loadSchedulerState(world);
    saveSchedulerState(world, { ...atual, commands: cancelManyCommands(atual.commands, new Set([record.id]), new Date().toISOString()) });
    rerender();
    refresh();
    return;
  }
  const state = loadSchedulerState(world);
  saveSchedulerState(world, {
    ...state,
    commands: state.commands.map((command) =>
      command.id === record.id
        ? {
            ...command,
            events: [
              ...command.events,
              { status: 'removido', at: new Date().toISOString(), detail: 'Removido na tela Comandos.' },
            ],
          }
        : command,
    ),
  });
  const after = loadSchedulerState(world);
  saveSchedulerState(world, { ...after, commands: after.commands.filter((command) => command.id !== record.id) });
  rerender();
  refresh();
}

// ── Tela principal ──

/** "em 1h02m", "em 02:13.450" ou "vencido há 3s" — contagem do cravado. */
export function formatEta(deltaMs: number): string {
  if (!Number.isFinite(deltaMs)) return '';
  if (deltaMs < 0) {
    const late = Math.round(-deltaMs / 1000);
    return late < 1 ? 'agora' : `passou há ${late}s`;
  }
  if (deltaMs >= 3_600_000) {
    const h = Math.floor(deltaMs / 3_600_000);
    const m = Math.floor((deltaMs % 3_600_000) / 60_000);
    return `em ${h}h${pad2(m)}m`;
  }
  const totalMs = Math.floor(deltaMs);
  const mm = Math.floor(totalMs / 60_000);
  const ss = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `em ${pad2(mm)}:${pad2(ss)}.${String(ms).padStart(3, '0')}`;
}

/** Barra do relógio de precisão (fonte, incerteza, hora do servidor viva, Calibrar). */
function clockBarEl(onCalibrated: () => void): { bar: HTMLDivElement; tick: () => void } {
  const bar = document.createElement('div');
  bar.className = 'tsh-clockbar';
  const now = document.createElement('span');
  now.className = 'tsh-clockbar-now';
  const meta = document.createElement('span');
  meta.className = 'tsh-clockbar-meta';
  const calibrar = document.createElement('button');
  calibrar.type = 'button';
  calibrar.className = 'tsh-btn tsh-btn--ghost tsh-btn--sm';
  calibrar.appendChild(icon('clock', 12));
  const calibrarTxt = document.createElement('span');
  calibrarTxt.className = 'tsh-btn-txt';
  calibrarTxt.textContent = 'Calibrar relógio';
  calibrar.appendChild(calibrarTxt);
  calibrar.title = 'Mede o relógio do servidor agora (até 11 consultas leves, alguns segundos).';
  calibrar.addEventListener('click', () => {
    calibrar.disabled = true;
    calibrarTxt.textContent = 'Calibrando…';
    void calibrateClock().finally(() => {
      calibrar.disabled = false;
      calibrarTxt.textContent = 'Calibrar relógio';
      tick();
      onCalibrated();
    });
  });
  const tick = (): void => {
    const info = clockInfo();
    now.textContent = `Servidor ${clockLabelMs(serverNowMs())}`;
    const fonte = info.source === 'nenhuma' ? 'sem fonte' : clockSourceLabel(info.source);
    const rtt = info.rttMedianMs !== null ? ` · resposta ~${info.rttMedianMs} ms` : '';
    const aprendido =
      info.learnedCompensationMs !== null
        ? ` · autoajuste ${info.learnedCompensationMs} ms (${info.feedbackCount} envio(s)${
            info.lastArrivalErrorMs !== null ? `, último ${info.lastArrivalErrorMs >= 0 ? '+' : ''}${info.lastArrivalErrorMs} ms` : ''
          })`
        : info.feedbackCount > 0 && info.lastArrivalErrorMs !== null
          ? ` · último envio ${info.lastArrivalErrorMs >= 0 ? '+' : ''}${info.lastArrivalErrorMs} ms`
          : '';
    meta.textContent = `${fonte} · precisão ±${info.uncertaintyMs} ms${rtt}${aprendido}`;
    bar.dataset.quality = info.uncertaintyMs <= 60 ? 'ok' : info.uncertaintyMs <= 300 ? 'warn' : 'bad';
  };
  tick();
  bar.append(icon('clock', 13), now, meta, calibrar);
  return { bar, tick };
}

/** Abas da Central (v3.3.0). */
export type CentralTab = 'fila' | 'novo' | 'bloco' | 'mapa' | 'historico';

/** Última aba aberta (a Central reabre onde o jogador estava). */
let lastCentralTab: CentralTab = 'fila';

/** Barra de abas simples: botões + painéis; mostra um por vez. */
function centralTabs(parent: HTMLElement, defs: readonly { id: CentralTab; label: string; icon: IconName }[]): {
  panel(id: CentralTab): HTMLDivElement;
  select(id: CentralTab): void;
  setCount(id: CentralTab, n: number | null): void;
} {
  const bar = document.createElement('div');
  bar.className = 'tsh-tabs';
  bar.setAttribute('role', 'tablist');
  parent.appendChild(bar);
  const buttons = new Map<CentralTab, { btn: HTMLButtonElement; count: HTMLSpanElement }>();
  const panels = new Map<CentralTab, HTMLDivElement>();
  const select = (id: CentralTab): void => {
    lastCentralTab = id;
    for (const [key, { btn }] of buttons) {
      btn.setAttribute('aria-selected', String(key === id));
      btn.tabIndex = key === id ? 0 : -1;
    }
    for (const [key, panel] of panels) panel.hidden = key !== id;
  };
  // ←/→ entre as abas (padrão de tablist).
  bar.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const order = defs.map((d) => d.id);
    const i = order.indexOf(lastCentralTab);
    const next = order[(i + (event.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
    if (next === undefined) return;
    event.preventDefault();
    select(next);
    buttons.get(next)?.btn.focus();
  });
  for (const def of defs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tsh-tab';
    btn.setAttribute('role', 'tab');
    btn.id = `tsh-tab-${def.id}`;
    btn.setAttribute('aria-controls', `tsh-tabpanel-${def.id}`);
    const count = document.createElement('span');
    count.className = 'tsh-tab-count';
    count.hidden = true;
    btn.append(icon(def.icon, 14), document.createTextNode(def.label), count);
    btn.addEventListener('click', () => select(def.id));
    bar.appendChild(btn);
    buttons.set(def.id, { btn, count });
    const panel = document.createElement('div');
    panel.className = 'tsh-tab-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.id = `tsh-tabpanel-${def.id}`;
    panel.setAttribute('aria-labelledby', `tsh-tab-${def.id}`);
    panel.hidden = true;
    parent.appendChild(panel);
    panels.set(def.id, panel);
  }
  return {
    panel: (id) => panels.get(id) as HTMLDivElement,
    select,
    setCount: (id, n) => {
      const entry = buttons.get(id);
      if (entry === undefined) return;
      entry.count.hidden = n === null || n === 0;
      entry.count.textContent = n === null ? '' : String(n);
    },
  };
}

/** Faixa de números da fila: total, por tipo (com ícone do jogo) e o próximo. */
function renderCentralStats(wrap: HTMLElement, world: string): void {
  wrap.replaceChildren();
  const fila = rowsOf(world).filter((row) => !HISTORY_STATUSES.has(row.status));
  const alive = fila.filter((row) => row.status !== 'pausado');
  const pausados = fila.length - alive.length;
  const chip = (label: string, value: string, kind?: string): HTMLDivElement => {
    const el = document.createElement('div');
    el.className = 'tsh-stat-chip';
    const v = document.createElement('strong');
    v.textContent = value;
    const l = document.createElement('span');
    l.textContent = label;
    const k = kind !== undefined ? kindIcon(kind, 16) : null;
    if (k !== null) el.appendChild(k);
    el.append(v, l);
    return el;
  };
  wrap.appendChild(chip(pausados > 0 ? `na fila (${pausados} pausado${pausados > 1 ? 's' : ''})` : 'na fila', String(fila.length)));
  const counts = countByKind(alive.map((row) => row.record));
  const labels: Record<string, string> = { attack: 'ataques', fake: 'fakes', support: 'apoios', noble: 'nobres', cancel: 'cancelamentos' };
  for (const [kind, n] of Object.entries(counts)) {
    if (n > 0) wrap.appendChild(chip(labels[kind] ?? kind, String(n), kind));
  }
  const next = alive.find((row) => row.status === 'agendado' || row.status === 'janela');
  if (next !== undefined) {
    const at = Date.parse(next.record.sendAt);
    const el = document.createElement('div');
    el.className = 'tsh-stat-chip tsh-stat-chip--next';
    const l = document.createElement('span');
    l.textContent = `próximo: ${commandKindLabel(next.record.kind).toLowerCase()} → ${next.record.target.x}|${next.record.target.y}`;
    const v = document.createElement('strong');
    v.dataset.tshEta = String(at);
    v.textContent = formatEta(at - serverNowMs());
    el.append(icon('clock', 14), l, v);
    wrap.appendChild(el);
  }
}

export async function openSchedulerCommands(
  shadow: ShadowRoot,
  world: string,
  rerender: () => void,
  focus?: 'form' | CentralTab,
): Promise<void> {
  // Relógio vivo (Onda A): UM interval de 250ms enquanto a tela está aberta —
  // atualiza a hora do servidor e as contagens [data-tsh-eta]; some ao fechar.
  let liveTimer: number | undefined;
  const { body, foot, requestClose, markClean } = buildTshModal(shadow, 'Central de comandos', 'crosshair', {
    onClose: () => {
      if (liveTimer !== undefined) window.clearInterval(liveTimer);
    },
  });
  const modalEl = body.parentElement; // modal é o pai do body no scaffold
  if (modalEl !== null) {
    modalEl.style.width = 'min(820px, calc(100vw - 32px))';
    modalEl.style.maxHeight = 'min(90vh, 900px)';
  }

  body.appendChild(
    tshNoteBanner(
      'Os comandos saem sozinhos no horário, pela Praça da aldeia de origem — em segundo plano, sem trocar a sua tela. Deixe uma aba do jogo aberta e o computador acordado.',
    ),
  );

  // ── Relógio de precisão ──
  const clock = clockBarEl(() => refreshList());
  body.appendChild(clock.bar);
  const tickLive = (): void => {
    if (aimIsHot()) return; // reta final de um cravado nesta página
    clock.tick();
    const nowServer = serverNowMs();
    for (const el of body.querySelectorAll<HTMLElement>('[data-tsh-eta]')) {
      const at = Number(el.dataset.tshEta);
      el.textContent = formatEta(at - nowServer);
    }
  };
  // A Fila acompanha o motor sozinha: quando algum comando muda de estado
  // (saiu, falhou, entrou na mira), a lista é redesenhada (antes ficava velha).
  let lastSig = '';
  let liveTicks = 0;
  const sigOf = (): string =>
    rowsOf(world)
      .map((row) => `${row.record.id}:${row.status}:${row.record.sendAt}`)
      .join('|');
  const tickAll = (): void => {
    tickLive();
    liveTicks += 1;
    if (liveTicks % 4 !== 0 || aimIsHot()) return;
    // Editor de horário aberto ou importação em curso: não redesenha por cima.
    if (body.querySelector('.tsh-time-editor') !== null || !importBox.hidden) return;
    const sig = sigOf();
    if (sig !== lastSig) {
      lastSig = sig;
      refreshList();
    }
  };
  liveTimer = window.setInterval(tickAll, 250);
  if (clockInfo().source !== 'http') void calibrateClock().then(() => clock.tick());

  // ── Números da fila ──
  const stats = document.createElement('div');
  stats.className = 'tsh-central-stats';
  body.appendChild(stats);

  // ── Abas ──
  const tabs = centralTabs(body, [
    { id: 'fila', label: 'Fila', icon: 'list' },
    { id: 'novo', label: 'Novo comando', icon: 'plus' },
    { id: 'bloco', label: 'Em bloco', icon: 'layers' },
    { id: 'mapa', label: 'Mapa', icon: 'map' },
    { id: 'historico', label: 'Histórico', icon: 'clock' },
  ]);
  const initialTab: CentralTab = focus === 'form' ? 'novo' : (focus ?? lastCentralTab);

  const queueFilters: ListFilters = { query: '', kind: 'todos', history: 'todos' };
  const historyFilters: ListFilters = { query: '', kind: 'todos', history: 'todos' };
  let prefillForm: ((record: ScheduledCommandRecord, mode: 'reuse' | 'duplicate' | 'edit') => void) | null = null;
  let formIsDirty: () => boolean = () => false;
  // Aldeias desta conta (para o Importar recusar origens alheias) — carregadas com o formulário.
  let ownIds: ReadonlySet<string> | undefined;
  const openInForm = (record: ScheduledCommandRecord, mode: 'reuse' | 'duplicate' | 'edit'): void => {
    void (async () => {
      tabs.select('novo');
      if (prefillForm === null) {
        showNotice('O formulário ainda não carregou suas aldeias — espere um instante e clique de novo.');
        return;
      }
      // Não apaga em silêncio o que o jogador já digitou no formulário.
      if (formIsDirty()) {
        const ok = await tshConfirm(
          shadow,
          'Substituir o formulário?',
          'Você já preencheu dados em "Novo comando". Substituir pelos dados deste comando?',
          { okLabel: 'Substituir', cancelLabel: 'Manter o que digitei' },
        );
        if (!ok) return;
      }
      prefillForm(record, mode);
    })();
  };
  const hooks: CentralHooks = {
    reagendar: (record, mode) => openInForm(record, mode),
    editar: (record) => {
      const bloqueio = notEditableReason(world, record.id);
      if (bloqueio !== null) {
        showQueueNote(bloqueio);
        return;
      }
      openInForm(record, 'edit');
    },
  };

  // Fila: barra de ferramentas (fica fixa) + lista (redesenha).
  const filaPanel = tabs.panel('fila');
  const queueBar = document.createElement('div');
  queueBar.className = 'tsh-central-toolbar';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'tsh-input tsh-central-search';
  search.placeholder = 'Buscar coordenada ou aldeia';
  search.setAttribute('aria-label', 'Buscar na fila');
  const kindFilter = selectEl(KIND_FILTER_OPTIONS.map((o) => ({ value: o.value, label: o.label })));
  kindFilter.setAttribute('aria-label', 'Filtrar por tipo');
  const bulk = document.createElement('div');
  bulk.className = 'tsh-central-bulk';
  queueBar.append(search, kindFilter, bulk);
  filaPanel.appendChild(queueBar);
  const importBox = document.createElement('div');
  importBox.className = 'tsh-central-import';
  importBox.hidden = true;
  filaPanel.appendChild(importBox);
  const queueList = document.createElement('div');
  filaPanel.appendChild(queueList);

  // Histórico: filtro (Todos/Enviados/Falhas) + limpar.
  const histPanel = tabs.panel('historico');
  const histBar = document.createElement('div');
  histBar.className = 'tsh-central-toolbar';
  const seg = document.createElement('div');
  seg.className = 'tsh-seg';
  seg.setAttribute('role', 'radiogroup');
  const segBtns: HTMLButtonElement[] = [];
  for (const [value, label] of [
    ['todos', 'Todos'],
    ['enviados', 'Enviados'],
    ['falhas', 'Falhas'],
  ] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tsh-seg-btn';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(value === 'todos'));
    b.textContent = label;
    b.addEventListener('click', () => {
      historyFilters.history = value as HistoryFilter;
      for (const other of segBtns) other.setAttribute('aria-checked', String(other === b));
      refreshList();
    });
    segBtns.push(b);
    seg.appendChild(b);
  }
  const limpar = actionButton('Limpar histórico', 'trash', 'tsh-btn tsh-btn--ghost tsh-btn--sm', () => {
    void (async () => {
      const { removed } = pruneCommandHistory(loadSchedulerState(world).commands);
      if (removed === 0) return;
      const ok = await tshConfirm(
        shadow,
        'Limpar histórico',
        `Apagar ${removed} registro(s) encerrado(s) (enviados, falhos e cancelados)? Os INCERTOS ficam — confira-os no jogo antes.`,
        { danger: true },
      );
      if (!ok) return;
      const atual = loadSchedulerState(world);
      saveSchedulerState(world, { ...atual, commands: pruneCommandHistory(atual.commands).kept });
      rerender();
      refreshList();
    })();
  });
  const histSearch = document.createElement('input');
  histSearch.type = 'search';
  histSearch.className = 'tsh-input tsh-central-search';
  histSearch.placeholder = 'Buscar coordenada ou aldeia';
  histSearch.setAttribute('aria-label', 'Buscar no histórico');
  histSearch.addEventListener('input', () => {
    historyFilters.query = histSearch.value;
    refreshList();
  });
  histBar.append(seg, histSearch, limpar);
  histPanel.appendChild(histBar);
  const histList = document.createElement('div');
  histPanel.appendChild(histList);

  const refreshList = (): void => {
    renderCentralStats(stats, world);
    renderQueue(queueList, shadow, world, queueFilters, hooks, rerender, refreshList);
    renderHistory(histList, shadow, world, historyFilters, hooks, rerender, refreshList);
    renderBulk();
    const rows = rowsOf(world);
    tabs.setCount('fila', rows.filter((row) => !HISTORY_STATUSES.has(row.status)).length);
    tabs.setCount('historico', rows.filter((row) => HISTORY_STATUSES.has(row.status)).length);
  };

  // Ações em lote da Fila (valem para o que o filtro mostra).
  const filtered = (): ScheduledCommandRecord[] =>
    rowsOf(world)
      .filter((row) => !HISTORY_STATUSES.has(row.status) && row.status !== 'enviando')
      .map((row) => row.record)
      .filter((record) => matchesQuery(record, queueFilters.query) && matchesKind(record, queueFilters.kind));
  function filtroTexto(): string {
    const partes: string[] = [];
    if (queueFilters.kind !== 'todos') partes.push(KIND_FILTER_OPTIONS.find((o) => o.value === queueFilters.kind)?.label ?? '');
    if (queueFilters.query.trim() !== '') partes.push(`"${queueFilters.query.trim()}"`);
    return partes.length > 0 ? ` (filtro: ${partes.join(' · ')})` : '';
  }
  function renderBulk(): void {
    bulk.replaceChildren();
    const list = filtered();
    const pausados = list.filter((r) => r.paused);
    const ativos = list.filter((r) => !r.paused);
    if (ativos.length > 0) {
      bulk.appendChild(
        actionButton(`Pausar ${ativos.length}`, 'pause', 'tsh-btn tsh-btn--sm', () => {
          void (async () => {
            const breve = ativos.filter((r) => Date.parse(r.sendAt) - serverNowMs() < 5 * 60_000).length;
            if (breve > 0) {
              const ok = await tshConfirm(
                shadow,
                'Pausar comandos',
                `Pausar ${ativos.length} comando(s)${filtroTexto()}? ${breve} sai(em) nos próximos 5 min — pausado não sai, e se passar da hora não é reenviado.`,
                { danger: true, okLabel: `Sim, pausar ${ativos.length}`, cancelLabel: 'Não pausar' },
              );
              if (!ok) return;
            }
            for (const r of ativos) setCommandPaused(world, r.id, true);
            rerender();
            refreshList();
          })();
        }),
      );
    }
    if (pausados.length > 0) {
      bulk.appendChild(
        actionButton(`Retomar ${pausados.length}`, 'play', 'tsh-btn tsh-btn--sm', () => {
          for (const r of pausados) setCommandPaused(world, r.id, false);
          rerender();
          refreshList();
        }),
      );
    }
    if (list.length > 0) {
      bulk.appendChild(
        actionButton(`Cancelar ${list.length}`, 'x', 'tsh-btn tsh-btn--sm tsh-btn--danger', () => {
          void (async () => {
            const breve = list.filter((r) => Date.parse(r.sendAt) - serverNowMs() < 2 * 60_000).length;
            const ok = await tshConfirm(
              shadow,
              'Cancelar envios',
              `Cancelar ${list.length} comando(s)${filtroTexto()}?${breve > 0 ? ` ${breve} sai(em) nos próximos 2 min.` : ''} Eles NÃO serão enviados e ficam no histórico como cancelados.`,
              { danger: true, okLabel: `Sim, cancelar ${list.length}`, cancelLabel: 'Manter na fila' },
            );
            if (!ok) return;
            const atual = loadSchedulerState(world);
            saveSchedulerState(world, { ...atual, commands: cancelManyCommands(atual.commands, new Set(list.map((r) => r.id)), new Date().toISOString()) });
            rerender();
            refreshList();
          })();
        }),
      );
      bulk.appendChild(
        actionButton('Exportar', 'copy', 'tsh-btn tsh-btn--sm tsh-btn--ghost', () => {
          const text = exportCommands(world, list);
          void navigator.clipboard.writeText(text).then(
            () => showQueueNote(`${list.length} comando(s) copiado(s). Cole em "Importar" em outro navegador desta mesma conta.`),
            () => openImport(text, 'Copie o texto abaixo (Ctrl+C):'),
          );
        }),
      );
    }
    bulk.appendChild(actionButton('Importar', 'download', 'tsh-btn tsh-btn--sm tsh-btn--ghost', () => openImport('', null)));
  }
  let queueNote: HTMLDivElement | null = null;
  const showQueueNote = (text: string): void => {
    if (queueNote === null) {
      queueNote = statusRowEl('');
      filaPanel.insertBefore(queueNote, queueList);
    }
    statusMsgOf(queueNote).textContent = text;
  };
  const openImport = (preset: string, title: string | null): void => {
    importBox.replaceChildren();
    importBox.hidden = false;
    const area = textAreaEl('Cole aqui o texto do botão "Exportar".', 5);
    area.value = preset;
    const msg = helpEl(title ?? 'Os comandos entram na fila como novos. Os que já passaram do horário ficam de fora.');
    const go = actionButton('Importar comandos', 'download', 'tsh-btn tsh-btn--primary tsh-btn--sm', () => {
      const out = importCommands(
        area.value,
        world,
        new Set(loadSchedulerState(world).commands.map((c) => c.id)),
        serverNowMs(),
        ownIds,
      );
      if (!out.ok) {
        msg.textContent = out.message;
        msg.style.color = 'var(--shs-danger)';
        return;
      }
      const { records, past, invalid, foreign } = out.result;
      if (records.length > 0) appendSchedulerRecords(world, records);
      const parts = [`${records.length} comando(s) importado(s)`];
      if (past > 0) parts.push(`${past} já tinha(m) passado do horário`);
      if (foreign > 0) parts.push(`${foreign} sai(em) de aldeia que não é sua`);
      if (invalid > 0) parts.push(`${invalid} inválido(s)`);
      importBox.hidden = true;
      showQueueNote(`${parts.join(' · ')}.`);
      rerender();
      refreshList();
    });
    const fechar = actionButton('Fechar', 'x', 'tsh-btn tsh-btn--sm tsh-btn--ghost', () => {
      importBox.hidden = true;
    });
    const row = document.createElement('div');
    row.className = 'tsh-actions';
    row.append(go, fechar);
    importBox.append(area, msg, row);
    if (preset !== '') area.select();
    else area.focus();
  };
  search.addEventListener('input', () => {
    queueFilters.query = search.value;
    refreshList();
  });
  kindFilter.addEventListener('change', () => {
    queueFilters.kind = kindFilter.value as KindFilter;
    refreshList();
  });

  // ── Novo comando ──
  const formSection = sectionBoxEl('Agendar comando', 'plus');
  tabs.panel('novo').appendChild(formSection.box);
  let noticeEl: HTMLDivElement | null = null;
  const showNotice = (text: string): void => {
    if (noticeEl === null) {
      noticeEl = statusRowEl('');
      noticeEl.classList.add('tsh-central-notice');
      formSection.body.prepend(noticeEl);
    }
    statusMsgOf(noticeEl).textContent = text;
    noticeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  refreshList();
  tabs.select(initialTab);
  const form = document.createElement('div');
  formSection.body.appendChild(form);

  // Carregamento inicial: village.txt pode levar 1–2s (cache ajuda nas próximas).
  const loadingRow = statusRowEl('Carregando aldeias do mapa… (a primeira leitura pode levar 1–2s)');
  form.appendChild(loadingRow);
  let villages: OwnVillage[] = [];
  try {
    villages = await ownVillages();
  } catch {
    villages = [];
  }
  loadingRow.remove();

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'tsh-btn tsh-btn--ghost';
  closeBtn.appendChild(icon('x', 12));
  closeBtn.appendChild(document.createTextNode('Fechar'));
  closeBtn.addEventListener('click', requestClose); // pergunta se há comando meio digitado
  foot.appendChild(closeBtn);

  ownIds = new Set(villages.map((v) => normalizeVillageId(v.id)));
  // Bônus noturno do mundo (aviso no resumo) — não bloqueia o formulário.
  let nightBonus: NightBonus | null = null;
  void worldNightBonus().then((nb) => {
    nightBonus = nb;
    try {
      updateSummary();
    } catch {
      /* formulário não montou (sem aldeias) — nada a atualizar */
    }
  });
  const firstVillage = villages[0];
  if (firstVillage === undefined) {
    const err = document.createElement('div');
    err.className = 'tsh-error';
    err.textContent = 'Não foi possível carregar suas aldeias do mapa — feche e reabra a tela "Comandos" para tentar de novo.';
    form.appendChild(err);
    return;
  }

  // Estado do formulário.
  const urlVillageId = normalizeVillageId(new URLSearchParams(window.location.search).get('village') ?? '');
  let origin: OwnVillage = villages.find((v) => normalizeVillageId(v.id) === urlVillageId) ?? firstVillage;
  let target: { x: number; y: number } | null = null;
  let targetName: string | undefined;
  let targetPoints: number | undefined;
  let travelMin: number | null = null; // último travelMinutes válido do conjunto atual

  let errorEl: HTMLDivElement | null = null;
  // Onde o erro aparece: na barra de ações fixa (criada mais abaixo), à vista.
  let errorHost: HTMLElement = form;
  const showError = (message: string): void => {
    if (errorEl === null) {
      errorEl = document.createElement('div');
      errorEl.className = 'tsh-error';
      errorHost.prepend(errorEl);
    }
    errorEl.textContent = message; // sempre textContent — nunca HTML
  };
  const clearError = (): void => {
    if (errorEl !== null) {
      errorEl.remove();
      errorEl = null;
    }
  };

  // ── Origem ──
  const originField = document.createElement('div');
  originField.className = 'tsh-field tsh-field--block';
  const originLabel = labelEl('Origem');
  const originSelect = document.createElement('select');
  originSelect.className = 'tsh-select';
  for (const village of villages) {
    const option = document.createElement('option');
    option.value = village.id;
    option.textContent = `${village.name} (${village.x}|${village.y})`;
    originSelect.appendChild(option);
  }
  originSelect.value = origin.id;
  originSelect.addEventListener('change', () => {
    const found = villages.find((v) => v.id === originSelect.value);
    if (found !== undefined) {
      origin = found;
      clearError();
      loadTemplatesFor(found.id);
      void recomputeTravel();
      updateSummary();
    }
  });
  originField.append(originLabel, originSelect);
  originField.appendChild(helpEl('Suas aldeias, lidas do próprio jogo. A coordenada da origem é usada para converter chegada→envio.'));
  form.appendChild(originField);

  // ── Alvo ──
  const targetField = document.createElement('div');
  targetField.className = 'tsh-field tsh-field--block';
  const targetLabel = labelEl('Alvo (x|y)');
  const targetInput = document.createElement('input');
  targetInput.type = 'text';
  targetInput.className = 'tsh-input';
  targetInput.placeholder = '534|551';
  targetInput.setAttribute('autocomplete', 'off');
  const targetInfo = helpEl('Coordenadas de 0 a 999. O nome e os pontos são buscados no mapa automaticamente.');
  targetField.append(targetLabel, targetInput, targetInfo);
  form.appendChild(targetField);

  // ── Tipo ──
  const kindField = document.createElement('div');
  kindField.className = 'tsh-field tsh-field--block';
  const kindLabel = labelEl(
    'Tipo',
    'Ataque/Fake/Nobre/Cancelar saem como ataque na Praça; Apoio como apoio. Fake com pontos do alvo respeita o limite do mundo; Cancelar cancela comandos no alvo.',
  );
  const kindSelect = selectEl(KIND_ROWS.map((row) => ({ value: row.kind, label: row.label })));
  kindField.append(kindLabel, kindSelect);
  kindField.appendChild(
    helpEl(
      'Ataque/Fake/Nobre saem como ataque na Praça; Apoio como apoio. Fake com pontos do alvo respeita o limite do mundo. Cancelar não envia tropas: cancela N comandos no alvo no horário marcado.',
    ),
  );
  form.appendChild(kindField);

  // ── Estratégia de envio (Onda 1: direto/snipe/dodge) ──
  const strategyField = document.createElement('div');
  strategyField.className = 'tsh-field tsh-field--block';
  const strategyLabel = labelEl(
    'Estratégia',
    'Snipe e dodge fazem o horário digitado ser a CHEGADA-alvo (a partida sai pela unidade mais lenta). Direto é o envio no horário calculado.',
  );
  const strategySelect = selectEl(
    SCHEDULER_TIMING_STRATEGIES.map((value) => ({ value, label: TIMING_STRATEGY_LABELS[value] })),
  );
  const strategyHelp = helpEl('');
  strategyField.append(strategyLabel, strategySelect, strategyHelp);
  form.appendChild(strategyField);

  // ── Unidades (grade de 12) com modo Unidades/Percentual ──
  const unitsField = document.createElement('div');
  unitsField.className = 'tsh-field tsh-field--block';
  const unitsLabel = labelEl(
    'Unidades',
    'Absoluto: a soma das tropas deve ser maior que zero. Percentual: % das tropas da aldeia de origem no momento do disparo (exige a Praça da origem aberta). A viagem vale a MAIS LENTA unidade do conjunto.',
  );
  const unitsModeRow = document.createElement('div');
  unitsModeRow.className = 'tsh-check-row';
  unitsModeRow.style.gap = '16px';
  const unitsModeAbsoluteRadio = document.createElement('input');
  unitsModeAbsoluteRadio.type = 'radio';
  unitsModeAbsoluteRadio.name = 'tsh-cmd-units-mode';
  unitsModeAbsoluteRadio.checked = true;
  const absoluteText = document.createElement('span');
  absoluteText.textContent = 'Unidades';
  const unitsModeAbsolute = document.createElement('div');
  unitsModeAbsolute.className = 'tsh-check-row';
  unitsModeAbsolute.append(unitsModeAbsoluteRadio, absoluteText);
  const unitsModePercentRadio = document.createElement('input');
  unitsModePercentRadio.type = 'radio';
  unitsModePercentRadio.name = 'tsh-cmd-units-mode';
  const percentText = document.createElement('span');
  percentText.textContent = 'Percentual (%)';
  const unitsModePercent = document.createElement('div');
  unitsModePercent.className = 'tsh-check-row';
  unitsModePercent.append(unitsModePercentRadio, percentText);
  unitsModeRow.append(unitsModeAbsolute, unitsModePercent);
  const unitsGridHandle = buildUnitsGrid(
    () => {
      clearError();
      updateConditionalFields();
      void recomputeTravel();
      updateSummary();
    },
    { allowAll: true },
  );
  // ── Modelos de tropas do jogo (v3.3.0): os MESMOS da Praça, 1 clique ──
  const templatesRow = document.createElement('div');
  templatesRow.className = 'tsh-templates-row';
  let templatesSeq = 0;
  const loadTemplatesFor = (villageId: string): void => {
    const seq = ++templatesSeq;
    templatesRow.replaceChildren(helpEl('Carregando seus modelos de tropas do jogo…'));
    unitsGridHandle.setAvailable(null);
    void loadPlaceData(villageId)
      .then((place) => {
        if (seq !== templatesSeq) return; // outra aldeia foi escolhida depois
        const list = place.templates;
        unitsGridHandle.setAvailable(place.available);
        templatesRow.replaceChildren();
        if (list.length === 0) {
          templatesRow.appendChild(helpEl('Não achei modelos de tropas nesta aldeia — digite as tropas ou marque "Todas".'));
          return;
        }
        const title = document.createElement('span');
        title.className = 'tsh-templates-title';
        title.textContent = 'Modelos do jogo:';
        templatesRow.appendChild(title);
        for (const tpl of list) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'tsh-template-chip';
          chip.textContent = tpl.name;
          const resumo = [
            ...Object.entries(tpl.units).map(([u, n]) => `${unitLabel(u as UnitType)} ${formatInt(n ?? 0)}`),
            ...tpl.useAll.map((u) => `${unitLabel(u)}: todas`),
          ].join(' · ');
          chip.title = resumo === '' ? tpl.name : resumo;
          chip.setAttribute('aria-label', resumo === '' ? `Modelo ${tpl.name}` : `Modelo ${tpl.name}: ${resumo}`);
          chip.addEventListener('click', () => {
            unitsModeAbsoluteRadio.checked = true;
            unitsGridHandle.setAllEnabled(true);
            unitsGridHandle.set(tpl.units, tpl.useAll);
            clearError();
            // Modelo com nobre + tipo Ataque: o jogador quer um NOBRE.
            const temNobre = (tpl.units.snob ?? 0) > 0 || tpl.useAll.includes('snob');
            if (temNobre && kindSelect.value === 'attack') {
              kindSelect.value = 'noble';
              kindSelect.dispatchEvent(new Event('change'));
              showNotice(`Modelo "${tpl.name}" leva nobre — o tipo mudou para Nobre.`);
            }
            if (tpl.useAll.length > 0 && trainCheck.input.checked) {
              showError('Este modelo usa "Todas" — o trem de nobres precisa de quantidades fixas. Desmarque o trem ou ajuste as tropas.');
            }
            updateConditionalFields();
            void recomputeTravel();
            updateSummary();
          });
          templatesRow.appendChild(chip);
        }
      })
      .catch(() => {
        templatesRow.replaceChildren(helpEl('Não consegui ler os modelos de tropas agora — digite as tropas ou marque "Todas".'));
      });
  };
  const unitsHelp = helpEl('A soma das tropas deve ser maior que zero. A viagem vale a MAIS LENTA unidade do conjunto.');
  unitsField.append(unitsLabel, unitsModeRow, templatesRow, unitsGridHandle.grid, unitsHelp);
  loadTemplatesFor(origin.id);
  form.appendChild(unitsField);

  // ── Alvo da catapulta (só com catapulta no conjunto) ──
  const catapultField = document.createElement('div');
  catapultField.className = 'tsh-field tsh-field--block';
  const catapultLabel = labelEl(
    'Alvo da catapulta',
    'O que as catapultas do comando devem derrubar. "Padrão" deixa o jogo escolher.',
  );
  const catapultSelect = selectEl(Object.entries(CATAPULT_TARGETS).map(([value, label]) => ({ value, label })));
  catapultField.append(catapultLabel, catapultSelect);
  catapultField.appendChild(helpEl('Vale só para comando com catapulta no conjunto.'));
  form.appendChild(catapultField);

  // ── Sequência de Nobres (2–5 chegadas encadeadas) ──
  const trainField = document.createElement('div');
  trainField.className = 'tsh-field tsh-field--block';
  const trainLabel = labelEl(
    'Sequência de Nobres',
    'Trem de nobres: o slot 0 limpa o alvo e os seguintes noblam, com as chegadas separadas pelo gap. Exige a contagem ABSOLUTA de nobres e o modo "Chegar às".',
  );
  const trainCheck = checkboxEl(
    'Trem de nobres (2–5 chegadas)',
    'Cada slot vira um comando agendado próprio, com chegadas defasadas pelo gap.',
  );
  const trainSizeSelect = selectEl(NOBLE_TRAIN_SIZES.map((size) => ({ value: String(size), label: `${size} chegadas` })));
  trainSizeSelect.value = '2';
  // Onda E: modo do trem — nativo do jogo (1 clique, 100 ms) ou comandos separados.
  const trainModeSelect = selectEl([
    { value: 'nativo', label: 'Trem do jogo — 1 envio, chegadas a cada 100 ms (recomendado)' },
    { value: 'separado', label: 'Comandos separados — gap livre (um envio por ataque)' },
  ]);
  trainModeSelect.value = 'nativo';
  // Só vale no modo SEPARADO: cada nobre é um envio próprio da mesma aldeia
  // (confirmação por envio) — abaixo de ~5 s o segundo perde a janela.
  const trainGapInput = numberInputEl(String(VIEWER_CONFLICT_WINDOW_MS), VIEWER_CONFLICT_WINDOW_MS, 60_000, 500);
  const trainGapRow = document.createElement('div');
  trainGapRow.className = 'tsh-field';
  trainGapRow.append(labelEl('Gap entre chegadas (ms)'), trainGapInput);
  const loneSnobCheck = checkboxEl(
    'Nobre solitário',
    'Autoriza o trem incompleto quando faltam nobres (as primeiras chegadas levam os nobres disponíveis).',
  );
  const trainModeHelp = helpEl('');
  trainField.append(trainLabel, trainCheck.row, trainModeSelect, trainSizeSelect, trainGapRow, loneSnobCheck.row, trainModeHelp);
  const applyTrainMode = (): void => {
    const nativo = trainModeSelect.value === 'nativo';
    trainGapRow.style.display = nativo ? 'none' : '';
    loneSnobCheck.row.style.display = nativo ? 'none' : '';
    trainModeHelp.textContent = nativo
      ? 'Todos os ataques levam nobre e saem num ÚNICO clique na confirmação; o jogo espaça as chegadas em 100 ms. O horário é a chegada do 1º. Precisa de 1 nobre por ataque na grade.'
      : `Um comando por ataque, cada um com sua própria confirmação — o gap mínimo é ${VIEWER_CONFLICT_WINDOW_MS / 1000} s (cada envio precisa abrir e confirmar a tela). Para chegadas coladas (100 ms), use o trem do jogo.`;
  };
  trainModeSelect.addEventListener('change', () => {
    applyTrainMode();
    updateSummary();
  });
  applyTrainMode();
  trainField.appendChild(
    helpEl(
      'Os nobres da grade são distribuídos entre os slots; o excedente pinga nas ÚLTIMAS chegadas. Repetição sequencial fica desligada no trem.',
    ),
  );
  form.appendChild(trainField);

  // ── Cancelamento Cronometrado (kind 'cancel') ──
  const cancelField = document.createElement('div');
  cancelField.className = 'tsh-field tsh-field--block';
  const cancelLabel = labelEl(
    'Cancelamento',
    'Quantos comandos PRÓPRIOS com destino ao alvo devem ser cancelados no horário marcado (o jogo só cancela comandos dentro da janela de cancelamento).',
  );
  const cancelCountSelect = selectEl(
    SCHEDULER_CANCEL_COUNTS.map((count) => ({ value: String(count), label: `${count} comando(s)` })),
  );
  cancelCountSelect.value = '1';
  cancelField.append(cancelLabel, cancelCountSelect);
  cancelField.appendChild(
    helpEl(
      'Sem tropas: o motor lê a Visão de Comandos e cancela até N comandos com destino ao alvo, no instante marcado (precisão de ms).',
    ),
  );
  form.appendChild(cancelField);

  // ── Momento (Enviar às / Chegar às + datetime-local + colar horário) ──
  const timingField = document.createElement('div');
  timingField.className = 'tsh-field tsh-field--block';
  const timingLabel = labelEl('Momento');
  const sendRadio = document.createElement('input');
  sendRadio.type = 'radio';
  sendRadio.name = 'tsh-cmd-timing';
  sendRadio.value = 'send';
  sendRadio.checked = true;
  const arrivalRadio = document.createElement('input');
  arrivalRadio.type = 'radio';
  arrivalRadio.name = 'tsh-cmd-timing';
  arrivalRadio.value = 'arrival';
  const sendRow = document.createElement('div');
  sendRow.className = 'tsh-check-row';
  const sendText = document.createElement('span');
  sendText.textContent = 'Enviar às';
  sendRow.append(sendRadio, sendText);
  const arrivalRow = document.createElement('div');
  arrivalRow.className = 'tsh-check-row';
  const arrivalText = document.createElement('span');
  arrivalText.textContent = 'Chegar às';
  arrivalRow.append(arrivalRadio, arrivalText);
  const timeInput = document.createElement('input');
  timeInput.type = 'datetime-local';
  timeInput.step = '1';
  timeInput.className = 'tsh-input';
  // Conforto: pré-preenchido com daqui a 10 minutos (relógio local).
  timeInput.value = toDatetimeLocalValue(new Date(referenceNow().getTime() + 10 * 60_000));
  const msInput = document.createElement('input');
  msInput.type = 'number';
  msInput.min = '0';
  msInput.max = '999';
  msInput.step = '1';
  msInput.value = '0';
  msInput.className = 'tsh-input tsh-input--ms';
  msInput.title = 'Milissegundos (0–999)';
  msInput.setAttribute('aria-label', 'Milissegundos');
  const msSuffix = document.createElement('span');
  msSuffix.className = 'tsh-ms-suffix';
  msSuffix.textContent = 'ms';
  const timeRow = document.createElement('div');
  timeRow.style.display = 'flex';
  timeRow.style.gap = '6px';
  timeRow.style.alignItems = 'center';
  timeRow.style.flexWrap = 'wrap';
  const pasteBtn = document.createElement('button');
  pasteBtn.type = 'button';
  pasteBtn.className = 'tsh-btn tsh-btn--ghost';
  pasteBtn.appendChild(icon('copy', 12));
  pasteBtn.appendChild(document.createTextNode('Colar horário'));
  pasteBtn.title = 'Lê a área de transferência (HH:mm:ss ou HH:mm:ss:ms) e preenche HOJE nesse horário — amanhã se já passou.';
  timeRow.append(timeInput, msInput, msSuffix, pasteBtn);
  // v3.3.1: ajuste rápido do horário (sem redigitar a data inteira).
  const nudges = document.createElement('div');
  nudges.className = 'tsh-time-nudges';
  for (const [label, deltaMs] of [
    ['−1 min', -60_000],
    ['+1 min', 60_000],
    ['+5 min', 5 * 60_000],
    ['+10 min', 10 * 60_000],
    ['+1 h', 60 * 60_000],
  ] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tsh-nudge';
    b.textContent = label;
    b.title = deltaMs < 0 ? `Voltar ${label.slice(1)} no horário digitado` : `Adiantar ${label.slice(1)} no horário digitado`;
    b.addEventListener('click', () => {
      const base = parseDatetimeLocal(timeInput.value) ?? referenceNow();
      timeInput.value = toDatetimeLocalValue(new Date(base.getTime() + deltaMs));
      timeInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    nudges.appendChild(b);
  }
  timeRow.appendChild(nudges);
  // Referência do horário digitado (Onda A) — persistida.
  const refRow = document.createElement('div');
  refRow.className = 'tsh-check-row';
  refRow.style.gap = '14px';
  const refServer = document.createElement('input');
  refServer.type = 'radio';
  refServer.name = 'tsh-cmd-timeref';
  const refLocal = document.createElement('input');
  refLocal.type = 'radio';
  refLocal.name = 'tsh-cmd-timeref';
  refServer.checked = timeReference() === 'servidor';
  refLocal.checked = !refServer.checked;
  const refServerLabel = document.createElement('label');
  refServerLabel.className = 'tsh-check-row';
  refServerLabel.append(refServer, document.createTextNode('Hora do servidor'));
  const refLocalLabel = document.createElement('label');
  refLocalLabel.className = 'tsh-check-row';
  refLocalLabel.append(refLocal, document.createTextNode('Hora do meu computador'));
  refRow.append(refServerLabel, refLocalLabel);
  const timingHelp = helpEl('');
  timingField.append(timingLabel, sendRow, arrivalRow, timeRow, refRow, timingHelp);
  form.appendChild(timingField);

  // ── Forçar (agendar mesmo impossível) ──
  const forcedCheck = checkboxEl(
    'Agendar mesmo impossível',
    'O motor envia mesmo fora da janela de viabilidade (partida já passada/horário perdido) e avisa no status. O risco é do operador.',
  );
  form.appendChild(forcedCheck.row);

  // ── Sequencial (repetir o comando) ──
  const sequentialField = document.createElement('div');
  sequentialField.className = 'tsh-field tsh-field--block';
  const sequentialLabel = labelEl(
    'Repetir',
    'Replica o MESMO comando N vezes (1–20) com o horário somado do intervalo — cada repetição vira um registro próprio no Agendador.',
  );
  const repeatRow = document.createElement('div');
  repeatRow.className = 'tsh-check-row';
  repeatRow.style.gap = '8px';
  const repeatCountInput = numberInputEl('1', 1, 20, 1);
  repeatCountInput.style.width = '70px';
  const repeatIntervalInput = numberInputEl('1000', 0, 600_000, 100);
  repeatIntervalInput.style.width = '110px';
  const repeatCountText = document.createElement('span');
  repeatCountText.textContent = 'vezes, a cada';
  const repeatMsText = document.createElement('span');
  repeatMsText.textContent = 'ms';
  repeatRow.append(repeatCountInput, repeatCountText, repeatIntervalInput, repeatMsText);
  sequentialField.append(sequentialLabel, repeatRow);
  sequentialField.appendChild(
    helpEl('1 repetição = comando único. O intervalo desloca partida E chegada (a viagem não muda).'),
  );
  form.appendChild(sequentialField);

  const applyTravelAvailability = (): void => {
    const strategy = strategySelect.value as SchedulerTimingStrategy;
    const needsArrival = strategy === 'snipe' || strategy === 'dodge';
    const unavailable = travelMin === null;
    arrivalRadio.disabled = unavailable;
    sendRadio.disabled = needsArrival && !unavailable;
    if (needsArrival && !unavailable) arrivalRadio.checked = true;
    if (unavailable && arrivalRadio.checked) sendRadio.checked = true;
    timingHelp.textContent = unavailable
      ? 'Velocidades do mundo indisponíveis — use "Enviar às".'
      : needsArrival
        ? strategy === 'dodge'
          ? 'Dodge: o horário é a CHEGADA-alvo; as tropas saem ANTES do impacto e voltam depois — a partida sai pela unidade mais lenta.'
          : 'Snipe: o horário é a CHEGADA-alvo (cruzamento com o ataque que chega); a partida sai pela unidade mais lenta.'
        : timeReference() === 'servidor'
          ? 'Horário na HORA DO SERVIDOR (a do rodapé do jogo), com milissegundos. "Colar horário" aceita HH:mm:ss:ms.'
          : 'Horário no relógio do SEU COMPUTADOR — o agendador converte para o servidor pelo relógio medido.';
  };

  // ── Campos condicionais do tipo/modo (cancelar esconde tropas; nobre mostra o trem) ──
  const usePercentMode = (): boolean => unitsModePercentRadio.checked;
  const readCatapultCount = (): number => {
    if (!usePercentMode() && unitsGridHandle.readAll().includes('catapult')) return 1;
    const source = usePercentMode() ? unitsGridHandle.readPercent() : unitsGridHandle.read();
    return source.catapult ?? 0;
  };
  const updateConditionalFields = (): void => {
    const isCancel = kindSelect.value === 'cancel';
    const isNoble = kindSelect.value === 'noble';
    unitsField.style.display = isCancel ? 'none' : '';
    strategyField.style.display = isCancel ? 'none' : '';
    sequentialField.style.display = isCancel || trainCheck.input.checked ? 'none' : '';
    catapultField.style.display = !isCancel && readCatapultCount() > 0 ? '' : 'none';
    trainField.style.display = !isCancel && isNoble ? '' : 'none';
    cancelField.style.display = isCancel ? '' : 'none';
    trainCheck.row.style.display = isNoble ? '' : 'none';
    unitsHelp.textContent = usePercentMode()
      ? 'Percentual das tropas da aldeia de origem NO DISPARO (floor). O motor exige a Praça da aldeia de origem aberta; sem leitura das tropas, o envio é abortado.'
      : 'A soma das tropas deve ser maior que zero. A viagem vale a MAIS LENTA unidade do conjunto.';
  };

  /** Data+hora do campo + milissegundos (null = incompleto). */
  const readWhen = (): Date | null => {
    const base = parseDatetimeLocal(timeInput.value);
    if (base === null) return null;
    return new Date(base.getTime() + parseMillisInput(msInput.value));
  };

  // ── Resumo vivo ──
  const summaryRow = statusRowEl('Preencha alvo, tropas e horário — o resumo aparece aqui.');
  form.appendChild(summaryRow);
  const summaryMsg = statusMsgOf(summaryRow);

  const readUnitsForTravel = (): Partial<Record<UnitType, number>> => {
    if (usePercentMode()) return unitsGridHandle.readPercent();
    const units = { ...unitsGridHandle.read() };
    // "Todas" entra na conta da viagem (a mais lenta manda) com 1 unidade.
    for (const unit of unitsGridHandle.readAll()) units[unit] = Math.max(1, units[unit] ?? 0);
    return units;
  };

  const updateSummary = (): void => {
    const parts: string[] = [];
    const when = readWhen();
    const isCancel = kindSelect.value === 'cancel';
    const strategy = strategySelect.value as SchedulerTimingStrategy;
    const needsArrival = strategy === 'snipe' || strategy === 'dodge';
    const mode: 'arrival' | 'send' = needsArrival || arrivalRadio.checked ? 'arrival' : 'send';
    if (when !== null && travelMin !== null && !isCancel) {
      if (mode === 'arrival') {
        parts.push(`Enviar ${formatTimestampMs(arrivalToSendAt(when, travelMin))}`, `Chegar ${formatTimestampMs(when)}`);
      } else {
        parts.push(`Enviar ${formatTimestampMs(when)}`, `Chegar ${formatTimestampMs(sendToArrival(when, travelMin))}`);
      }
    } else if (when !== null) {
      parts.push(`${isCancel ? 'Cancelar' : mode === 'arrival' ? 'Chegar' : 'Enviar'} ${formatTimestampMs(when)}`);
    }
    if (target !== null) parts.push(`dist ${formatDecimalPtBr(fieldsDistance(origin, target))} campos`);
    if (isCancel) {
      parts.push(`cancelar ${cancelCountSelect.value} comando(s)`);
    } else {
      const allList = usePercentMode() ? [] : unitsGridHandle.readAll();
      const units = usePercentMode() ? unitsGridHandle.readPercent() : unitsGridHandle.read();
      const total = Object.values(units).reduce((sum, n) => sum + (n ?? 0), 0);
      if (total > 0) parts.push(usePercentMode() ? `${formatInt(total)}% de tropa` : `${formatInt(total)} tropa(s)`);
      if (allList.length > 0) parts.push(`TODAS: ${allList.map((u) => unitLabel(u)).join(', ')}`);
      if (allList.length > 0 && kindSelect.value === 'fake') parts.push('ATENÇÃO: fake com "Todas" envia TODA a tropa marcada');
      // Bônus noturno (get_config): ataque chegando na janela = defesa em dobro.
      if (when !== null && travelMin !== null && kindSelect.value !== 'support' && nightBonus !== null) {
        const chegadaLocal = mode === 'arrival' ? when : sendToArrival(when, travelMin);
        if (inNightBonus(localToServerEpoch(chegadaLocal, currentServerOffsetMs()), nightBonus)) {
          parts.push(`ATENÇÃO: chega no bônus noturno (${nightBonus.startHour}h–${nightBonus.endHour}h) — a defesa vale o dobro`);
        }
      }
      if (strategy !== 'direto') parts.push(strategy === 'dodge' ? 'dodge' : 'snipe');
      if (kindSelect.value === 'noble' && trainCheck.input.checked) {
        parts.push(
          trainModeSelect.value === 'nativo'
            ? `trem do jogo de ${trainSizeSelect.value} (chegadas a cada ${NATIVE_TRAIN_ARRIVAL_STEP_MS} ms)`
            : `trem de ${trainSizeSelect.value} (gap ${trainGapInput.value} ms)`,
        );
      }
    }
    if (forcedCheck.input.checked) parts.push('FORÇADO');
    const repeats = Math.min(20, Math.max(1, Math.floor(Number(repeatCountInput.value) || 1)));
    if (repeats > 1 && !isCancel && !trainCheck.input.checked) {
      parts.push(`${repeats}× a cada ${repeatIntervalInput.value} ms`);
    }
    summaryMsg.textContent = parts.length > 0 ? parts.join(' · ') : 'Preencha alvo, tropas e horário — o resumo aparece aqui.';
  };

  // ── Conversão chegada→envio (travelMinutes da unidade mais lenta) ──
  let travelSeq = 0;
  const recomputeTravel = async (): Promise<void> => {
    const seq = ++travelSeq;
    const to = target;
    const units = readUnitsForTravel();
    const hasUnits = Object.values(units).some((n) => (n ?? 0) > 0);
    if (to === null || !hasUnits || kindSelect.value === 'cancel') {
      travelMin = null;
      applyTravelAvailability();
      updateSummary();
      return;
    }
    const minutes = await travelMinutes(origin, to, units);
    if (seq !== travelSeq) return; // input mais novo venceu — descarta
    travelMin = minutes;
    applyTravelAvailability();
    updateSummary();
  };

  // ── Colar horário (clipboard + fallback do evento paste) ──
  const applyPastedTime = (text: string): void => {
    const parsed = parseClipboardTime(text, referenceNow());
    if (parsed === null) {
      showError(`Horário colado ilegível: "${text.trim()}". Use HH:mm:ss ou HH:mm:ss:ms.`);
      return;
    }
    timeInput.value = toDatetimeLocalValue(parsed);
    msInput.value = String(parsed.getMilliseconds());
    clearError();
    updateSummary();
  };
  const pasteFromClipboard = async (): Promise<void> => {
    let text: string | null = null;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = null; // sem permissão (ou contexto inseguro) → fallback do Ctrl+V
    }
    if (text !== null && text.trim() !== '') {
      applyPastedTime(text);
      return;
    }
    // Fallback: uma ÚNICA escuta de paste no modal; o usuário pressiona Ctrl+V.
    const pasteTarget: HTMLElement = modalEl ?? form;
    const onPaste = (event: Event): void => {
      pasteTarget.removeEventListener('paste', onPaste, true);
      const data = (event as ClipboardEvent).clipboardData?.getData('text') ?? '';
      applyPastedTime(data);
    };
    pasteTarget.addEventListener('paste', onPaste, true);
    showError('Não foi possível ler a área de transferência — pressione Ctrl+V nesta tela para colar o horário.');
  };
  pasteBtn.addEventListener('click', () => {
    void pasteFromClipboard();
  });

  // ── Eventos do alvo (validação + lookup com debounce) e do momento ──
  let lookupTimer: number | undefined;
  let lookupSeq = 0;
  targetInput.addEventListener('input', () => {
    clearError();
    const parsed = parseTargetInput(targetInput.value);
    if (parsed === null) {
      target = null;
      targetName = undefined;
      targetPoints = undefined;
      targetInfo.textContent = 'Formato: x|y (coordenadas 0–999).';
      targetInfo.style.color = '';
      updateSummary();
      void recomputeTravel();
      return;
    }
    target = parsed;
    updateSummary();
    void recomputeTravel();
    if (lookupTimer !== undefined) window.clearTimeout(lookupTimer);
    const seq = ++lookupSeq;
    lookupTimer = window.setTimeout(() => {
      void villageAt(parsed.x, parsed.y).then((found) => {
        if (seq !== lookupSeq) return; // usuário digitou outra coisa enquanto isso
        if (found !== null) {
          targetName = found.name;
          targetPoints = found.points;
          targetInfo.textContent = `${found.name} · ${formatInt(found.points)} pontos`;
          targetInfo.style.color = '';
        } else {
          targetName = undefined;
          targetPoints = undefined;
          targetInfo.textContent = 'Coordenada válida, mas não encontrada no mapa — confira antes de agendar.';
          targetInfo.style.color = 'var(--shs-danger)';
        }
        updateSummary();
      });
    }, 350);
  });
  for (const radio of [sendRadio, arrivalRadio]) {
    radio.addEventListener('change', () => {
      clearError();
      void recomputeTravel();
      updateSummary();
    });
  }
  for (const input of [timeInput, msInput]) {
    input.addEventListener('input', () => {
      clearError();
      updateSummary();
    });
  }
  for (const radio of [refServer, refLocal]) {
    radio.addEventListener('change', () => {
      setTimeReference(refServer.checked ? 'servidor' : 'local');
      applyTravelAvailability();
      refreshList();
      updateSummary();
    });
  }
  kindSelect.addEventListener('change', () => {
    clearError();
    updateConditionalFields();
    void recomputeTravel();
    updateSummary();
  });
  strategySelect.addEventListener('change', () => {
    clearError();
    applyTravelAvailability();
    updateSummary();
  });
  for (const radio of [unitsModeAbsoluteRadio, unitsModePercentRadio]) {
    radio.addEventListener('change', () => {
      unitsGridHandle.setAllEnabled(!unitsModePercentRadio.checked);
      clearError();
      updateConditionalFields();
      void recomputeTravel();
      updateSummary();
    });
  }
  for (const input of [repeatCountInput, repeatIntervalInput, trainGapInput]) {
    input.addEventListener('input', () => {
      clearError();
      updateSummary();
    });
  }
  trainCheck.input.addEventListener('change', () => {
    clearError();
    updateConditionalFields();
    updateSummary();
  });
  trainSizeSelect.addEventListener('change', () => {
    clearError();
    updateSummary();
  });
  forcedCheck.input.addEventListener('change', () => {
    clearError();
    updateSummary();
  });

  updateConditionalFields();
  applyTravelAvailability();
  updateSummary();

  // ── Formulário "sujo" (há algo digitado que um preenchimento apagaria) ──
  let dirty = false;
  form.addEventListener('input', () => {
    dirty = true;
  });
  form.addEventListener('change', () => {
    dirty = true;
  });
  formIsDirty = () => dirty;

  // ── Edição (v3.3.1): salvar substitui o comando original ──
  let editingId: string | null = null;
  const editBanner = document.createElement('div');
  editBanner.className = 'tsh-edit-banner';
  editBanner.hidden = true;
  const editText = document.createElement('span');
  const stopEdit = actionButton('Cancelar edição', 'x', 'tsh-btn tsh-btn--sm tsh-btn--ghost', () => {
    setEditing(null);
    // Limpa alvo e tropas: um "Adicionar" depois disso criaria uma CÓPIA do pendente.
    target = null;
    targetName = undefined;
    targetPoints = undefined;
    targetInput.value = '';
    unitsGridHandle.reset();
    travelMin = null;
    applyTravelAvailability();
    updateConditionalFields();
    updateSummary();
    dirty = false;
    showNotice('Edição cancelada — o comando original continua na Fila sem mudanças.');
  });
  editBanner.append(icon('edit', 14), editText, stopEdit);
  form.prepend(editBanner);
  const addLabel = document.createTextNode('Adicionar comando');
  let actionsBarRef: HTMLElement | null = null;
  const setEditing = (record: ScheduledCommandRecord | null): void => {
    editingId = record?.id ?? null;
    editBanner.hidden = record === null;
    editText.textContent =
      record === null ? '' : `Editando: ${commandKindLabel(record.kind)} → ${record.target.x}|${record.target.y}. Ao salvar, o comando original é substituído.`;
    addLabel.textContent = record === null ? 'Adicionar comando' : 'Salvar alterações (substitui)';
    actionsBarRef?.classList.toggle('is-editing', record !== null);
  };

  // ── Reagendar / Duplicar / Editar: um comando vem para o formulário ──
  prefillForm = (record: ScheduledCommandRecord, mode: 'reuse' | 'duplicate' | 'edit'): void => {
    const village = villages.find((v) => normalizeVillageId(v.id) === normalizeVillageId(record.sourceVillageId));
    if (village !== undefined) {
      origin = village;
      originSelect.value = village.id;
    }
    const origemAviso = village === undefined ? ` A origem ${record.sourceName ?? record.sourceVillageId} não está entre suas aldeias — escolha outra.` : '';
    kindSelect.value = record.kind;
    strategySelect.value = record.timingStrategy ?? 'direto';
    if (record.percentMode === true) {
      unitsModePercentRadio.checked = true;
      unitsGridHandle.setAllEnabled(false);
      unitsGridHandle.set(record.unitsPercent ?? {});
    } else {
      unitsModeAbsoluteRadio.checked = true;
      unitsGridHandle.setAllEnabled(true);
      unitsGridHandle.set(record.units, record.allUnits ?? []);
    }
    if (record.cancelCount !== undefined) cancelCountSelect.value = String(record.cancelCount);
    if (record.catapultTarget !== undefined) catapultSelect.value = record.catapultTarget;
    // Edição mantém o "forçado" do original; um comando novo começa sem ele.
    forcedCheck.input.checked = mode === 'edit' && record.forced === true;
    trainCheck.input.checked = false;
    // Um comando vira UM comando (repetir herdado de antes multiplicaria).
    repeatCountInput.value = '1';
    if (village !== undefined) loadTemplatesFor(village.id);
    targetInput.value = `${record.target.x}|${record.target.y}`;
    targetInput.dispatchEvent(new Event('input'));
    if (mode === 'edit') {
      // Edição: os horários ORIGINAIS (pela chegada, se foi criado assim).
      const byArrival = record.timingMode === 'arrival' && record.arrivalAt !== undefined;
      arrivalRadio.checked = byArrival;
      sendRadio.checked = !byArrival;
      const local = serverToLocal(byArrival ? (record.arrivalAt as string) : record.sendAt, currentServerOffsetMs());
      timeInput.value = toDatetimeLocalValue(local);
      msInput.value = String(local.getMilliseconds());
    } else {
      // Novo comando: "Enviar às" daqui a 10 min (com "Chegar às" a partida
      // podia cair no passado). O jogador ajusta antes de adicionar.
      arrivalRadio.checked = false;
      sendRadio.checked = true;
      timeInput.value = toDatetimeLocalValue(new Date(referenceNow().getTime() + 10 * 60_000));
      msInput.value = '0';
    }
    setEditing(mode === 'edit' ? record : null);
    hideResult();
    syncAdvanced();
    updateConditionalFields();
    void recomputeTravel().then(() => {
      // Sem velocidades do mundo o formulário cai para "Enviar às": na edição
      // pela chegada, troca também o HORÁRIO para o envio original (senão a
      // chegada digitada viraria envio).
      if (mode === 'edit' && record.timingMode === 'arrival' && sendRadio.checked) {
        const envio = serverToLocal(record.sendAt, currentServerOffsetMs());
        timeInput.value = toDatetimeLocalValue(envio);
        msInput.value = String(envio.getMilliseconds());
        showNotice('Velocidades do mundo indisponíveis agora — editando pelo horário de ENVIO original.');
        updateSummary();
      }
    });
    updateSummary();
    clearError();
    showNotice(
      mode === 'edit'
        ? `Editando o comando das ${formatTimestampMs(serverToLocal(record.sendAt, currentServerOffsetMs()))}. Ajuste e clique em "Salvar alterações".${origemAviso}`
        : `Dados de "${commandKindLabel(record.kind)} → ${record.target.x}|${record.target.y}" copiados para um comando NOVO${
            record.trainUnits !== undefined && record.trainUnits.length > 0 ? ' (o trem do jogo precisa ser remontado)' : ''
          }. O horário voltou para ENVIO daqui a 10 min — ajuste antes de clicar em "Adicionar comando".${origemAviso}`,
    );
    dirty = false;
    timeInput.focus();
  };

  // ── Botão Adicionar + validações ──
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'tsh-btn tsh-btn--primary';
  addBtn.appendChild(icon('plus', 13));
  addBtn.appendChild(addLabel);
  let adding = false;

  const handleAdd = async (): Promise<void> => {
    if (adding) return; // clique repetido não cria o comando duas vezes
    adding = true;
    try {
      await handleAddOnce();
    } finally {
      adding = false;
    }
  };

  const handleAddOnce = async (): Promise<void> => {
    clearError();
    const kindRow = KIND_ROWS.find((row) => row.kind === kindSelect.value);
    if (kindRow === undefined) {
      showError('Selecione o tipo do comando (Ataque, Fake, Apoio, Nobre ou Cancelar).');
      return;
    }
    const kind = kindRow.kind;
    const isCancel = kind === 'cancel';
    const to = target;
    if (to === null) {
      showError('Alvo inválido — use o formato x|y (coordenadas de 0 a 999).');
      return;
    }
    const when = readWhen();
    if (when === null) {
      showError('Informe o horário (data e hora, com segundos).');
      return;
    }
    const forced = forcedCheck.input.checked;
    const strategy = strategySelect.value as SchedulerTimingStrategy;
    const needsArrival = !isCancel && (strategy === 'snipe' || strategy === 'dodge');

    // Tropas (absolutas ou percentuais) — cancelamento não tem tropas.
    const absolute = unitsGridHandle.read();
    const percent = unitsGridHandle.readPercent();
    const usePercent = !isCancel && usePercentMode();
    const allUnits = !isCancel && !usePercent ? unitsGridHandle.readAll() : [];
    if (!isCancel) {
      const hasUnits = usePercent ? Object.keys(percent).length > 0 : Object.keys(absolute).length > 0 || allUnits.length > 0;
      if (!hasUnits) {
        showError(
          usePercent
            ? 'Informe ao menos um percentual maior que zero.'
            : 'Informe ao menos uma unidade (ou marque "Todas" em alguma tropa).',
        );
        return;
      }
    }
    const trainEnabled = !isCancel && kind === 'noble' && trainCheck.input.checked;
    // Cancelamento não leva tropas nem alvo de catapulta (o motor só cancela).
    const catapultTargetValue = !isCancel && readCatapultCount() > 0 ? catapultSelect.value : '';

    // Partida e chegada (o horário digitado é o do MODO escolhido; snipe/dodge
    // SEMPRE ancoram na chegada — semântica de cruzamento).
    const mode: 'arrival' | 'send' = needsArrival || arrivalRadio.checked ? 'arrival' : 'send';
    let sendDate: Date;
    let arrivalDate: Date | null = null;
    if (isCancel) {
      sendDate = when;
    } else if (mode === 'arrival') {
      if (travelMin === null) {
        showError(
          needsArrival
            ? `"${TIMING_STRATEGY_LABELS[strategy]}" exige o cálculo de chegada (velocidades do mundo + tropas) — confira as unidades.`
            : 'Conversão de chegada indisponível (velocidades do mundo desconhecidas) — use o modo "Enviar às".',
        );
        return;
      }
      arrivalDate = when;
      sendDate = arrivalToSendAt(when, travelMin);
    } else {
      sendDate = when;
      if (travelMin !== null) arrivalDate = sendToArrival(when, travelMin);
    }
    if (sendDate.getTime() <= referenceNow().getTime() + 5_000 && !forced) {
      showError(
        'O horário de envio precisa ser no FUTURO (pelo menos 5 segundos a partir de agora) — marque "Agendar mesmo impossível" para forçar.',
      );
      return;
    }

    const offset = currentServerOffsetMs();
    // Grava no RELÓGIO DO SERVIDOR (o motor mira por ele): local + offset.
    const sendAtIso = new Date(localToServerEpoch(sendDate, offset)).toISOString();
    const arrivalIso = arrivalDate !== null ? new Date(localToServerEpoch(arrivalDate, offset)).toISOString() : undefined;
    const repeatCount = Math.min(20, Math.max(1, Math.floor(Number(repeatCountInput.value) || 1)));
    const repeatInterval = Math.max(0, Math.floor(Number(repeatIntervalInput.value) || 0));

    const baseInput = (sendAt: string, arrivalAt: string | undefined): NewScheduledCommandInput => ({
      kind,
      sourceVillageId: origin.id,
      sourceName: origin.name,
      source: { x: origin.x, y: origin.y },
      target: to,
      ...(targetName !== undefined ? { targetName } : {}),
      ...(targetPoints !== undefined ? { targetPoints } : {}),
      units: isCancel || usePercent ? {} : absolute,
      timingMode: mode,
      sendAt,
      ...(arrivalAt !== undefined ? { arrivalAt } : {}),
      ...(usePercent ? { percentMode: true, unitsPercent: percent } : {}),
      ...(allUnits.length > 0 ? { allUnits } : {}),
      ...(strategy !== 'direto' && !isCancel ? { timingStrategy: strategy } : {}),
      ...(forced ? { forced: true } : {}),
      ...(catapultTargetValue !== '' ? { catapultTarget: catapultTargetValue } : {}),
    });

    let records: ScheduledCommandRecord[] = [];
    if (isCancel) {
      records = [
        createScheduledCommand({
          ...baseInput(sendAtIso, undefined),
          cancelCount: Number(cancelCountSelect.value),
          detail: `Cancelamento cronometrado de ${cancelCountSelect.value} comando(s) no alvo.`,
        }),
      ];
    } else if (trainEnabled) {
      if (usePercent) {
        showError('O trem de nobres exige a contagem ABSOLUTA de nobres — desligue o modo percentual para montar o trem.');
        return;
      }
      if (allUnits.length > 0) {
        showError('O trem de nobres precisa de quantidades fixas — desmarque "Todas" nas tropas do trem.');
        return;
      }
      if (arrivalIso === undefined || mode !== 'arrival') {
        showError('O trem de nobres ancora na CHEGADA (o horário digitado é a chegada do slot 0) — use o modo "Chegar às".');
        return;
      }
      const trainSize = Number(trainSizeSelect.value) as NobleTrainSize;
      const gapMs = Math.floor(Number(trainGapInput.value) || VIEWER_CONFLICT_WINDOW_MS);
      if (trainModeSelect.value !== 'nativo' && gapMs < VIEWER_CONFLICT_WINDOW_MS) {
        showError(
          `Comandos separados precisam de pelo menos ${VIEWER_CONFLICT_WINDOW_MS / 1000} s entre chegadas (cada nobre abre a própria confirmação). Para chegadas coladas, use "Trem do jogo".`,
        );
        return;
      }
      const noblesAvailable = absolute.snob ?? 0;
      const escort: Partial<Record<UnitType, number>> = { ...absolute };
      delete escort.snob;
      if (trainModeSelect.value === 'nativo') {
        const nativo = buildNativeNobleTrainRecord({
          sourceVillageId: origin.id,
          sourceName: origin.name,
          source: { x: origin.x, y: origin.y },
          target: to,
          ...(targetName !== undefined ? { targetName } : {}),
          ...(targetPoints !== undefined ? { targetPoints } : {}),
          firstArrivalMs: Date.parse(arrivalIso),
          trainSize,
          noblesAvailable,
          escort,
          travelMinutes: await travelMinutes(origin, to, { ...escort, snob: 1 }),
          ...(catapultTargetValue !== '' ? { catapultTarget: catapultTargetValue } : {}),
          ...(forced ? { forced: true } : {}),
        });
        if (!nativo.ok) {
          showError(nativo.message);
          return;
        }
        records = nativo.records;
      } else {
        const travelEscort = await travelMinutes(origin, to, escort);
        const travelWithNobles = await travelMinutes(origin, to, { ...escort, snob: 1 });
        const result = buildNobleTrainRecords({
          sourceVillageId: origin.id,
          sourceName: origin.name,
          source: { x: origin.x, y: origin.y },
          target: to,
          ...(targetName !== undefined ? { targetName } : {}),
          ...(targetPoints !== undefined ? { targetPoints } : {}),
          firstArrivalMs: Date.parse(arrivalIso),
          trainSize,
          gapMs,
          noblesAvailable,
          allowLoneSnob: loneSnobCheck.input.checked,
          autoSplitExtraNobles: true,
          escort,
          travelMinutesFor: (slotUnits) => ((slotUnits.snob ?? 0) > 0 ? travelWithNobles : travelEscort),
          ...(catapultTargetValue !== '' ? { catapultTarget: catapultTargetValue } : {}),
          ...(forced ? { forced: true } : {}),
          detail: `Trem de ${trainSize} chegadas (gap ${gapMs} ms).`,
        });
        if (!result.ok) {
          showError(result.message);
          return;
        }
        records = result.records;
      }
    } else {
      const inputs = replicateCommandInput(baseInput(sendAtIso, arrivalIso), repeatCount, repeatInterval);
      records = inputs.map((input) => createScheduledCommand(input));
    }

    // Confirmação com EXATAMENTE o que vai ser agendado (tropas, alvo, horas).
    const first = records[0];
    if (first === undefined) return;
    if (editingId !== null) {
      const original = loadSchedulerState(world).commands.find((c) => c.id === editingId);
      if (records.length > 1) {
        showError('Na edição, um comando continua sendo UM comando — deixe "Repetir" em 1 (para mais cópias, use Duplicar).');
        return;
      }
      if (original !== undefined && normalizeVillageId(original.sourceVillageId) !== normalizeVillageId(origin.id)) {
        showError('A origem mudou em relação ao comando editado — para sair de outra aldeia, cancele a edição e crie um comando novo.');
        return;
      }
    }
    const offsetNow = currentServerOffsetMs();
    const quandoEnvio = formatTimestampMs(serverToLocal(first.sendAt, offsetNow));
    const quandoChegada = first.arrivalAt !== undefined ? formatTimestampMs(serverToLocal(first.arrivalAt, offsetNow)) : null;
    const tropasTxt = describeUnits(first);
    const linhas = [
      `${commandKindLabel(first.kind)}: ${origin.name} (${origin.x}|${origin.y}) → ${first.target.x}|${first.target.y}${first.targetName !== undefined ? ` (${first.targetName})` : ''}`,
      first.kind === 'cancel' ? `Cancelar até ${first.cancelCount ?? 1} comando(s) no alvo` : `Tropas: ${tropasTxt}`,
      `Envio: ${quandoEnvio}${quandoChegada !== null ? ` · Chegada: ${quandoChegada}` : ''} (${timeReference() === 'servidor' ? 'hora do servidor' : 'hora do seu computador'})`,
    ];
    if (records.length > 1) linhas.push(`${records.length} comandos no total (o primeiro acima).`);
    const editando = editingId;
    if (editando !== null) {
      linhas.push(records.length > 1 ? `O comando original será SUBSTITUÍDO por estes ${records.length}.` : 'O comando original será SUBSTITUÍDO por este.');
    }
    // Detector de duplicata: mesma origem, alvo e envio (±1 s) já na Fila.
    const igual = loadSchedulerState(world).commands.find(
      (c) =>
        c.id !== editando &&
        !c.events.some((e) => HISTORY_STATUSES.has(e.status)) &&
        normalizeVillageId(c.sourceVillageId) === normalizeVillageId(first.sourceVillageId) &&
        c.target.x === first.target.x &&
        c.target.y === first.target.y &&
        Math.abs(Date.parse(c.sendAt) - Date.parse(first.sendAt)) <= 1_000,
    );
    if (igual !== undefined) {
      linhas.push(`⚠ Já existe um comando igual na Fila (envio ${formatTimestampMs(serverToLocal(igual.sendAt, offsetNow))}). Agendar mesmo assim?`);
    }
    linhas.push('', 'Enter confirma · Esc volta para revisar.');
    const ok = await tshConfirm(shadow, editando !== null ? 'Salvar alterações?' : 'Agendar este comando?', linhas.join('\n'), {
      okLabel: editando !== null ? 'Salvar' : records.length > 1 ? `Agendar ${records.length}` : 'Agendar',
      cancelLabel: 'Revisar',
    });
    if (!ok) return;
    // A janela pode ter ficado aberta um tempo: o horário ainda é futuro?
    if (!forced && records.some((r) => Date.parse(r.sendAt) <= serverNowMs() + 5_000)) {
      showError('Enquanto a confirmação estava aberta, o horário de envio chegou (ou ficou a menos de 5 s) — nada foi agendado. Ajuste o horário.');
      return;
    }
    let criados: ScheduledCommandRecord[];
    if (editando !== null) {
      const bloqueio = notEditableReason(world, editando);
      if (bloqueio !== null) {
        showError(`${bloqueio} Suas alterações NÃO foram salvas.`);
        return;
      }
      // Uma gravação só: original vira "substituído" (fica no histórico) + os novos.
      const atual = loadSchedulerState(world);
      const agoraIso = new Date().toISOString();
      const marcados = atual.commands.map((c) =>
        c.id === editando
          ? { ...c, paused: false, events: [...c.events, { status: 'removido' as const, at: agoraIso, detail: 'Substituído por edição.' }] }
          : c,
      );
      criados = dedupeRecordIds(records, marcados.map((c) => c.id));
      saveSchedulerState(world, { ...atual, commands: [...marcados, ...criados] });
    } else {
      criados = appendSchedulerRecords(world, records);
    }
    rerender();
    refreshList();
    showResult(
      editando !== null
        ? `Alterações salvas: ${commandKindLabel(first.kind)} → ${first.target.x}|${first.target.y} · ${tropasTxt} · envio ${quandoEnvio}.`
        : records.length === 1
          ? `Agendado: ${commandKindLabel(first.kind)} → ${first.target.x}|${first.target.y} · ${tropasTxt} · envio ${quandoEnvio}.`
          : `${records.length} comandos agendados (o primeiro sai ${quandoEnvio}).`,
      editando !== null ? [] : criados.map((r) => r.id),
    );
    setEditing(null);

    // Limpa o form (mantém origem, tipo e estratégia — agendar em sequência fica mais rápido).
    target = null;
    targetName = undefined;
    targetPoints = undefined;
    targetInput.value = '';
    targetInfo.textContent = 'Coordenadas de 0 a 999. O nome e os pontos são buscados no mapa automaticamente.';
    targetInfo.style.color = '';
    unitsGridHandle.reset();
    timeInput.value = toDatetimeLocalValue(new Date(referenceNow().getTime() + 10 * 60_000));
    msInput.value = '0';
    travelMin = null;
    applyTravelAvailability();
    updateConditionalFields();
    updateSummary();
    markClean(form);
    dirty = false;
  };
  addBtn.addEventListener('click', () => {
    void handleAdd();
  });
  form.appendChild(addBtn);

  // ── Resultado do último "Adicionar" — ao lado do botão, com Desfazer ──
  const resultBox = document.createElement('div');
  resultBox.className = 'tsh-add-result';
  resultBox.hidden = true;
  form.appendChild(resultBox);

  // ── Layout (v3.3.1): opções avançadas recolhidas + barra de ações FIXA ──
  // Antes: resumo/botão/resultado no fim de um formulário longo — o jogador
  // não via que o comando tinha sido criado e seguia editando um form limpo.
  const advanced = document.createElement('details');
  advanced.className = 'tsh-advanced';
  const advSummary = document.createElement('summary');
  advSummary.textContent = 'Opções avançadas — estratégia (snipe/dodge), forçar, repetir';
  advanced.append(advSummary, strategyField, forcedCheck.row, sequentialField);
  form.insertBefore(advanced, summaryRow);
  const actionsBar = document.createElement('div');
  actionsBar.className = 'tsh-form-actions';
  const actionsRow = document.createElement('div');
  actionsRow.className = 'tsh-form-actions-row';
  actionsRow.append(summaryRow, addBtn);
  actionsBar.append(actionsRow, resultBox);
  form.appendChild(actionsBar);
  errorHost = actionsBar;
  actionsBarRef = actionsBar;
  // Resultado anterior some quando o jogador começa o próximo comando.
  form.addEventListener('input', () => {
    if (!resultBox.hidden) hideResult();
  });
  // Estratégia fora do padrão abre as avançadas (ninguém esquece um snipe escondido).
  const syncAdvanced = (): void => {
    const ativos: string[] = [];
    if (strategySelect.value !== 'direto') ativos.push(`${TIMING_STRATEGY_LABELS[strategySelect.value as SchedulerTimingStrategy]} ativo`);
    if (forcedCheck.input.checked) ativos.push('forçado');
    const rep = Math.floor(Number(repeatCountInput.value) || 1);
    if (rep > 1) ativos.push(`repetir ${rep}×`);
    advSummary.textContent = ativos.length > 0 ? `Opções avançadas (${ativos.join(' · ')})` : 'Opções avançadas — estratégia (snipe/dodge), forçar, repetir';
    if (ativos.length > 0) advanced.open = true;
  };
  strategySelect.addEventListener('change', syncAdvanced);
  forcedCheck.input.addEventListener('change', syncAdvanced);
  repeatCountInput.addEventListener('input', syncAdvanced);
  function hideResult(): void {
    resultBox.hidden = true;
    resultBox.replaceChildren();
  }
  function showResult(text: string, createdIds: readonly string[]): void {
    resultBox.replaceChildren();
    resultBox.hidden = false;
    const msg = document.createElement('span');
    msg.className = 'tsh-add-result-msg';
    msg.append(icon('check', 14), document.createTextNode(` ${text}`));
    const ver = actionButton('Ver na Fila', 'list', 'tsh-btn tsh-btn--sm', () => tabs.select('fila'));
    resultBox.append(msg, ver);
    if (createdIds.length > 0) {
      const desfazer = actionButton('Desfazer', 'undo', 'tsh-btn tsh-btn--sm tsh-btn--ghost', () => {
        const ids = new Set(createdIds);
        const atual = loadSchedulerState(world);
        // Só desfaz o que ainda não entrou na mira/pré-arme.
        const presos = atual.commands.filter((c) => ids.has(c.id) && notEditableReason(world, c.id) !== null);
        saveSchedulerState(world, { ...atual, commands: atual.commands.filter((c) => !ids.has(c.id) || presos.includes(c)) });
        rerender();
        refreshList();
        resultBox.replaceChildren();
        const done = document.createElement('span');
        done.className = 'tsh-add-result-msg';
        done.textContent =
          presos.length === 0 ? 'Desfeito — nada foi agendado.' : `Desfeito em parte: ${presos.length} já estava(m) na mira e continua(m) na Fila.`;
        resultBox.appendChild(done);
      });
      resultBox.appendChild(desfazer);
    }
    resultBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ── Seções novas (Onda 1): bloco em massa e mapa de operações ──
  const uiContext: SchedulerUiContext = {
    shadow,
    world,
    rerender,
    refreshList,
    villages,
    percentMode: usePercentMode,
  };
  appendBlockSection(tabs.panel('bloco'), uiContext);
  appendMapSection(tabs.panel('mapa'), uiContext);
  // Onda B: fechar com um comando meio digitado pede confirmação.
  markClean(form);
}

// ── Agendamento em Bloco (Onda 1, C) ─────────────────────────────────────────

/** Contexto comum das seções novas do modal (lista + aldeias + modo percentual). */
interface SchedulerUiContext {
  readonly shadow: ShadowRoot;
  readonly world: string;
  readonly rerender: () => void;
  readonly refreshList: () => void;
  readonly villages: readonly OwnVillage[];
  /** Modo percentual do formulário principal — a grade do bloco herda. */
  readonly percentMode: () => boolean;
}

/** Tempo do bloco na forma que a engine espera (null = partida imediata). */
type BlockEngineTiming = { arrivalMs?: number; windowFromMs?: number; windowFromToMs?: number } | null;

type BlockTimingRead =
  | { readonly ok: true; readonly timing: BlockTiming; readonly engine: BlockEngineTiming }
  | { readonly ok: false; readonly message: string };

const BLOCK_KIND_ROWS: readonly { value: 'attack' | 'support' | 'noble'; label: string }[] = [
  { value: 'attack', label: 'Ataque' },
  { value: 'support', label: 'Apoio' },
  { value: 'noble', label: 'Nobre' },
];

/** Linhas exibidas no preview antes de resumir o restante. */
const BLOCK_PREVIEW_ROWS = 25;

function appendBlockSection(parent: HTMLElement, ctx: SchedulerUiContext): void {
  const { box, body } = collapsibleSectionEl('Agendamento em Bloco', 'zap', true);
  parent.appendChild(box);
  body.appendChild(
    tshNoteBanner(
      'Matriz origem×alvo em massa: o preview (origem → alvo → partida) aparece ANTES de gravar e só o "Confirmar" cria os comandos.',
    ),
  );

  let statusEl: HTMLDivElement | null = null;
  const showStatus = (message: string, danger: boolean): void => {
    if (statusEl === null) {
      statusEl = statusRowEl('');
      body.insertBefore(statusEl, body.firstChild?.nextSibling ?? null);
    }
    const msg = statusMsgOf(statusEl);
    msg.textContent = message;
    msg.style.color = danger ? 'var(--shs-danger)' : '';
    // v3.2.1: o botão fica no fim de uma seção longa — a mensagem vem à vista.
    statusEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  // ── Origens (grupo do jogo OU coordenadas digitadas) ──
  const groupSelect = selectEl([{ value: '', label: '— sem grupo —' }]);
  const groupInfo = helpEl('Grupos do jogo carregados ao abrir esta seção.');
  const originsArea = textAreaEl('500|500 501|501', 3);
  const attachOriginsCheck = checkboxEl(
    'Anexar às aldeias do grupo',
    'Marcado, as coordenadas digitadas SOMAM às aldeias do grupo escolhido; desmarcado, elas substituem o grupo (o grupo só vale quando não há coordenadas digitadas).',
  );
  const groupVillages: GroupVillageRow[] = [];
  const loadGroups = async (): Promise<void> => {
    try {
      const groups = await getGroupOptions();
      for (const group of groups) {
        const option = document.createElement('option');
        option.value = String(group.groupId);
        option.textContent = group.name;
        groupSelect.appendChild(option);
      }
      groupInfo.textContent =
        groups.length > 0
          ? `${groups.length} grupo(s) do jogo disponíveis.`
          : 'Nenhum grupo encontrado — use as coordenadas digitadas.';
    } catch {
      groupInfo.textContent = 'Não foi possível ler os grupos do jogo — use as coordenadas digitadas.';
    }
  };
  groupSelect.addEventListener('change', () => {
    groupVillages.length = 0;
    const groupId = Number(groupSelect.value);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      groupInfo.textContent = 'Sem grupo selecionado — valem só as coordenadas digitadas.';
      return;
    }
    groupInfo.textContent = 'Carregando aldeias do grupo…';
    void getGroupVillages(groupId)
      .then((rows) => {
        groupVillages.length = 0;
        const seen = new Set<string>();
        for (const row of rows) {
          const key = String(row.villageId);
          if (seen.has(key)) continue;
          seen.add(key);
          groupVillages.push(row);
        }
        // Contrato do tsh-groups: [] pode ser "não lido" — avisa em vez de
        // afirmar que o grupo está vazio.
        groupInfo.textContent =
          groupVillages.length > 0
            ? `${groupVillages.length} aldeia(s) no grupo.`
            : 'O grupo não devolveu aldeias (pode ser leitura vazia) — confira no jogo ou use as coordenadas digitadas.';
      })
      .catch(() => {
        groupInfo.textContent = 'Falha ao ler as aldeias do grupo — use as coordenadas digitadas.';
      });
  });
  body.append(fieldEl(labelEl('Grupo de origens'), groupSelect, groupInfo));
  body.appendChild(fieldEl(labelEl('Origens (x|y)'), originsArea));
  body.appendChild(attachOriginsCheck.row);

  const perOriginInput = document.createElement('input');
  perOriginInput.type = 'text';
  perOriginInput.className = 'tsh-input';
  perOriginInput.value = '2';
  perOriginInput.setAttribute('autocomplete', 'off');
  const perTargetInput = document.createElement('input');
  perTargetInput.type = 'text';
  perTargetInput.className = 'tsh-input';
  perTargetInput.value = '2';
  perTargetInput.setAttribute('autocomplete', 'off');
  body.appendChild(
    fieldEl(
      labelEl('Comandos por origem', 'Formato "2;1" (uma cota por aldeia) ou "2" (mesma cota para todas).'),
      perOriginInput,
    ),
  );
  body.appendChild(
    fieldEl(labelEl('Comandos por alvo', 'Formato "2;1" (uma cota por alvo) ou "2" (mesma cota para todos).'), perTargetInput),
  );
  const allowSameCheck = checkboxEl('Permitir mesma origem→alvo', 'Sem marcar, pares origem=alvo são bloqueados pela engine.');
  body.appendChild(allowSameCheck.row);
  const calcModeSelect = selectEl(
    BLOCK_CALC_MODES.map((mode) => ({ value: mode, label: mode === 'otimizado' ? 'Otimizado (2-opt)' : 'Mais perto' })),
  );
  body.appendChild(fieldEl(labelEl('Cálculo'), calcModeSelect));

  // ── Alvos e torres de vigia ──
  const targetsArea = textAreaEl('534|551 535|552', 3);
  body.appendChild(fieldEl(labelEl('Alvos (x|y)'), targetsArea));
  const towersArea = textAreaEl('500|500 (opcional)', 2);
  body.appendChild(fieldEl(labelEl('Torres de vigia (opcional)'), towersArea));
  body.appendChild(
    helpEl('As torres ficam registradas no plano para referência — o tempo de viagem do jogo não muda por causa delas.'),
  );

  // ── Tempo (chegada única / janela / o quanto antes) ──
  const arrivalRadio = document.createElement('input');
  arrivalRadio.type = 'radio';
  arrivalRadio.name = 'tsh-block-timing';
  arrivalRadio.value = 'arrival';
  arrivalRadio.checked = true;
  const windowRadio = document.createElement('input');
  windowRadio.type = 'radio';
  windowRadio.name = 'tsh-block-timing';
  windowRadio.value = 'window';
  const asapRadio = document.createElement('input');
  asapRadio.type = 'radio';
  asapRadio.name = 'tsh-block-timing';
  asapRadio.value = 'asap';
  const timingRow = document.createElement('div');
  timingRow.className = 'tsh-check-row';
  timingRow.style.gap = '14px';
  for (const [radio, label] of [
    [arrivalRadio, 'Chegada única'],
    [windowRadio, 'Janela de chegada'],
    [asapRadio, 'O quanto antes'],
  ] as const) {
    const row = document.createElement('div');
    row.className = 'tsh-check-row';
    const text = document.createElement('span');
    text.textContent = label;
    row.append(radio, text);
    timingRow.appendChild(row);
  }
  const arrivalInput = document.createElement('input');
  arrivalInput.type = 'datetime-local';
  arrivalInput.step = '1';
  arrivalInput.className = 'tsh-input';
  arrivalInput.value = toDatetimeLocalValue(new Date(referenceNow().getTime() + 30 * 60_000));
  const windowFromInput = document.createElement('input');
  windowFromInput.type = 'datetime-local';
  windowFromInput.step = '1';
  windowFromInput.className = 'tsh-input';
  windowFromInput.value = toDatetimeLocalValue(new Date(referenceNow().getTime() + 30 * 60_000));
  const windowToInput = document.createElement('input');
  windowToInput.type = 'datetime-local';
  windowToInput.step = '1';
  windowToInput.className = 'tsh-input';
  windowToInput.value = toDatetimeLocalValue(new Date(referenceNow().getTime() + 60 * 60_000));
  const arrivalMsInput = document.createElement('input');
  arrivalMsInput.type = 'number';
  arrivalMsInput.min = '0';
  arrivalMsInput.max = '999';
  arrivalMsInput.value = '0';
  arrivalMsInput.className = 'tsh-input tsh-input--ms';
  arrivalMsInput.title = 'Milissegundos da chegada (0–999)';
  arrivalMsInput.setAttribute('aria-label', 'Milissegundos da chegada');
  const arrivalField = fieldEl(labelEl('Chegada única (+ ms)'), arrivalInput, arrivalMsInput);
  const windowField = fieldEl(labelEl('Janela (início e fim)'), windowFromInput, windowToInput);
  const asapHint = helpEl('O quanto antes: as partidas saem já (com 5s de folga) e o espaçamento por origem continua valendo.');
  const applyBlockTimingVisibility = (): void => {
    arrivalField.style.display = arrivalRadio.checked ? '' : 'none';
    windowField.style.display = windowRadio.checked ? '' : 'none';
    asapHint.style.display = asapRadio.checked ? '' : 'none';
  };
  for (const radio of [arrivalRadio, windowRadio, asapRadio]) {
    radio.addEventListener('change', applyBlockTimingVisibility);
  }
  body.appendChild(fieldEl(labelEl('Tempo'), timingRow));
  body.append(arrivalField, windowField, asapHint);
  applyBlockTimingVisibility();

  // ── Tipo + flags ──
  const blockKindSelect = selectEl(BLOCK_KIND_ROWS.map((row) => ({ value: row.value, label: row.label })));
  body.appendChild(fieldEl(labelEl('Tipo'), blockKindSelect));
  const markFakeCheck = checkboxEl('Marcar como fake', 'Grava o comando como FAKE: sai humanizado e respeita o limite de fakes do mundo.');
  const fillAllCheck = checkboxEl('Preencher tudo', 'Anotado no detalhe do plano: aloca o máximo que as duas cotas permitem (a engine nunca corta o lado menor em silêncio).');
  const autoSplitCheck = checkboxEl('Auto-split NT', 'Anotado no detalhe do plano. O trem de nobres de verdade vive na seção "Sequência de Nobres" do formulário.');
  const nightBonusCheck = checkboxEl('Ignorar bônus noturno', 'Anotado no detalhe do plano: o cálculo de viagem do Hub não aplica bônus noturno de qualquer forma.');
  const forceLateCheck = checkboxEl(
    'Forçar atraso',
    'Aceita partida no passado e marca o registro como forçado (o motor envia mesmo fora da janela).',
  );
  const distributeCheck = checkboxEl('Distribuir excedente', 'Anotado no detalhe do plano: cotas sobrando aparecem nos avisos do preview.');
  const avoidMsCheck = checkboxEl('Evitar conflito de ms', `Separa as partidas da MESMA origem em pelo menos ${VIEWER_CONFLICT_WINDOW_MS / 1000} s — cada envio abre a própria confirmação.`);
  avoidMsCheck.input.checked = true;
  for (const check of [markFakeCheck, fillAllCheck, autoSplitCheck, nightBonusCheck, forceLateCheck, distributeCheck, avoidMsCheck]) {
    body.appendChild(check.row);
  }

  // ── Tropas (grade que herda o modo Unidades/Percentual do formulário) ──
  const blockGrid = buildUnitsGrid();
  const blockUnitsHelp = helpEl('');
  body.appendChild(fieldEl(labelEl('Tropas do bloco'), blockGrid.grid, blockUnitsHelp));
  const refreshUnitsHelp = (): void => {
    blockUnitsHelp.textContent = ctx.percentMode()
      ? 'Modo percentual (herdado do formulário): o absoluto é calculado no disparo, contra as tropas de cada origem.'
      : 'As MESMAS tropas para todos os comandos do plano.';
  };
  refreshUnitsHelp();
  const catapultBlockSelect = selectEl(Object.entries(CATAPULT_TARGETS).map(([value, label]) => ({ value, label })));
  body.appendChild(fieldEl(labelEl('Alvo da catapulta'), catapultBlockSelect));

  const previewWrap = document.createElement('div');
  body.appendChild(previewWrap);
  let planning = false;

  const readOrigins = (): { coords: BlockCoord[]; invalid: string[] } => {
    const parsed = parseCoordList(originsArea.value);
    const groupCoords: BlockCoord[] = groupVillages.map((row) => ({ x: row.x, y: row.y }));
    // Grupo é a BASE das origens; as coordenadas digitadas SOMAM com "anexar" e
    // SUBSTITUEM sem ele (sem coordenadas digitadas, o grupo vale sempre).
    const manual = parsed.coords;
    const source = attachOriginsCheck.input.checked || manual.length === 0 ? [...groupCoords, ...manual] : manual;
    const coords: BlockCoord[] = [];
    const seen = new Set<string>();
    for (const coord of source) {
      const key = `${coord.x}|${coord.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      coords.push(coord);
    }
    return { coords, invalid: parsed.invalid };
  };

  const readTiming = (offsetMs: number): BlockTimingRead => {
    if (asapRadio.checked) return { ok: true, timing: { mode: 'asap' }, engine: null };
    const from = parseDatetimeLocal(windowRadio.checked ? windowFromInput.value : arrivalInput.value);
    if (from === null) return { ok: false, message: 'Informe o horário do bloco (data e hora, com segundos).' };
    if (!windowRadio.checked) {
      const arrivalMs = localToServerEpoch(from, offsetMs) + parseMillisInput(arrivalMsInput.value);
      return { ok: true, timing: { mode: 'arrival', arrivalMs }, engine: { arrivalMs } };
    }
    const to = parseDatetimeLocal(windowToInput.value);
    if (to === null) return { ok: false, message: 'Informe o FIM da janela de chegada.' };
    const fromMs = localToServerEpoch(from, offsetMs);
    const toMs = localToServerEpoch(to, offsetMs);
    if (toMs < fromMs) return { ok: false, message: 'Janela de chegada inválida: o fim é anterior ao início.' };
    return { ok: true, timing: { mode: 'window', fromMs, toMs }, engine: { windowFromMs: fromMs, windowFromToMs: toMs } };
  };

  const renderPreview = (records: readonly ScheduledCommandRecord[], warnings: readonly string[]): void => {
    previewWrap.replaceChildren();
    const offset = currentServerOffsetMs();
    const summary = document.createElement('div');
    summary.className = 'tsh-meta-row';
    summary.textContent = `${records.length} comando(s) no plano${warnings.length > 0 ? ` · ${warnings.length} aviso(s)` : ''}`;
    previewWrap.appendChild(summary);
    for (const record of records.slice(0, BLOCK_PREVIEW_ROWS)) {
      const row = document.createElement('div');
      row.className = 'tsh-card-desc';
      const originText = record.source !== undefined ? `${record.source.x}|${record.source.y}` : record.sourceVillageId;
      row.textContent = `${originText} → ${record.target.x}|${record.target.y} · partida ${formatTimestampMs(serverToLocal(record.sendAt, offset))} · ${summarizeUnits(record.units)}`;
      previewWrap.appendChild(row);
    }
    if (records.length > BLOCK_PREVIEW_ROWS) {
      previewWrap.appendChild(helpEl(`… e mais ${records.length - BLOCK_PREVIEW_ROWS} comando(s).`));
    }
    for (const warning of warnings.slice(0, 8)) {
      const line = helpEl(`• ${warning}`);
      line.style.color = 'var(--shs-danger)';
      previewWrap.appendChild(line);
    }
    if (warnings.length > 8) previewWrap.appendChild(helpEl(`… e mais ${warnings.length - 8} aviso(s).`));
  };

  const createPlan = async (): Promise<void> => {
    if (planning) return; // clique repetido não grava o plano duas vezes
    planning = true;
    try {
      await createPlanOnce();
    } finally {
      planning = false;
    }
  };

  const createPlanOnce = async (): Promise<void> => {
    previewWrap.replaceChildren();
    showStatus('', false);
    refreshUnitsHelp();
    const originsRead = readOrigins();
    const targetsRead = parseCoordList(targetsArea.value);
    if (originsRead.invalid.length > 0 || targetsRead.invalid.length > 0) {
      showStatus(
        `Coordenadas ilegíveis: ${[...originsRead.invalid, ...targetsRead.invalid].join(', ')}. Corrija e tente de novo (nada foi agendado).`,
        true,
      );
      return;
    }
    if (originsRead.coords.length === 0) {
      showStatus('Informe ao menos uma aldeia de origem (grupo e/ou coordenadas).', true);
      return;
    }
    if (targetsRead.coords.length === 0) {
      showStatus('Informe ao menos um alvo.', true);
      return;
    }
    const usePercent = ctx.percentMode();
    const absolute = blockGrid.read();
    const percent = blockGrid.readPercent();
    const unitSet = usePercent ? percent : absolute;
    if (Object.keys(unitSet).length === 0) {
      showStatus('Informe as tropas do bloco — a viagem usa a unidade mais lenta do conjunto.', true);
      return;
    }
    const offset = currentServerOffsetMs();
    const timingRead = readTiming(offset);
    if (!timingRead.ok) {
      showStatus(timingRead.message, true);
      return;
    }
    showStatus('Calculando o plano… (as viagens usam as velocidades do mundo)', false);
    // A engine chama `travelMinutes` de forma SÍNCRONA e memoiza por par: as
    // viagens são pré-computadas aqui (uma leitura por par, em minutos).
    const travelCache = new Map<string, number>();
    for (const from of originsRead.coords) {
      for (const to of targetsRead.coords) {
        const minutes = await travelMinutes(from, to, unitSet);
        travelCache.set(`${from.x}|${from.y}>${to.x}|${to.y}`, minutes === null ? Number.NaN : minutes);
      }
    }
    const travelMinutesFor = (from: BlockCoord, to: BlockCoord): number =>
      travelCache.get(`${from.x}|${from.y}>${to.x}|${to.y}`) ?? Number.NaN;

    let plan;
    try {
      plan = planBlockSchedule({
        origins: originsRead.coords,
        targets: targetsRead.coords,
        commandsPerOrigin: perOriginInput.value,
        commandsPerTarget: perTargetInput.value,
        allowSameOriginTarget: allowSameCheck.input.checked,
        calcMode: calcModeSelect.value as BlockCalcMode,
        travelMinutes: travelMinutesFor,
        timing: timingRead.engine,
      });
    } catch (error) {
      showStatus(error instanceof Error ? error.message : String(error), true);
      return;
    }

    const targetInfo = new Map<string, { name?: string; points?: number }>();
    for (const coord of targetsRead.coords) {
      try {
        const found = await villageAt(coord.x, coord.y);
        if (found !== null) targetInfo.set(`${coord.x}|${coord.y}`, { name: found.name, points: found.points });
      } catch {
        /* alvo sem nome/pontos: o comando sai sem eles (a engine não exige) */
      }
    }
    const originVillages = new Map<string, { id: string; name: string }>();
    for (const village of ctx.villages) originVillages.set(`${village.x}|${village.y}`, { id: village.id, name: village.name });
    for (const row of groupVillages) {
      const key = `${row.x}|${row.y}`;
      if (!originVillages.has(key)) originVillages.set(key, { id: String(row.villageId), name: row.name });
    }

    const kind = markFakeCheck.input.checked ? 'fake' : (blockKindSelect.value as 'attack' | 'support' | 'noble');
    const flagNotes: string[] = [];
    if (fillAllCheck.input.checked) flagNotes.push('preencher tudo');
    if (autoSplitCheck.input.checked) flagNotes.push('auto-split NT');
    if (nightBonusCheck.input.checked) flagNotes.push('ignorar bônus noturno');
    if (distributeCheck.input.checked) flagNotes.push('distribuir excedente');
    const towers = parseCoordList(towersArea.value);
    if (towers.coords.length > 0) flagNotes.push(`torres de vigia ${towers.coords.length}`);
    const catapultValue = (absolute.catapult ?? 0) > 0 || (percent.catapult ?? 0) > 0 ? catapultBlockSelect.value : '';

    const built = buildBlockRecords({
      commands: plan.commands,
      originFor: (coord) => originVillages.get(`${coord.x}|${coord.y}`),
      targetInfoFor: (coord) => targetInfo.get(`${coord.x}|${coord.y}`),
      kind,
      units: usePercent ? {} : absolute,
      percentMode: usePercent,
      unitsPercent: percent,
      timing: timingRead.timing,
      nowMs: serverNowMs(),
      avoidMsConflicts: avoidMsCheck.input.checked,
      forceLate: forceLateCheck.input.checked,
      ...(catapultValue !== '' ? { catapultTarget: catapultValue } : {}),
      detail: `Plano em bloco (${calcModeSelect.value})${flagNotes.length > 0 ? ` · ${flagNotes.join(', ')}` : ''}.`,
    });
    const warnings = [...plan.warnings, ...built.warnings];
    renderPreview(built.records, warnings);
    if (built.records.length === 0) {
      showStatus('Nenhum comando foi criado — veja os avisos do preview. Nada foi agendado.', true);
      return;
    }
    const ok = await tshConfirm(
      ctx.shadow,
      'Criar plano em bloco',
      `Gravar ${built.records.length} comando(s) no Agendador?${warnings.length > 0 ? ` Há ${warnings.length} aviso(s) no preview.` : ''}`,
    );
    if (!ok) {
      showStatus('Plano NÃO gravado (cancelado no preview).', false);
      return;
    }
    appendSchedulerRecords(ctx.world, built.records);
    ctx.rerender();
    ctx.refreshList();
    showStatus(
      `${built.records.length} comando(s) agendado(s) em bloco${warnings.length > 0 ? ` (${warnings.length} aviso(s) no preview)` : ''}.`,
      false,
    );
  };

  const planBtn = document.createElement('button');
  planBtn.type = 'button';
  planBtn.className = 'tsh-btn tsh-btn--primary';
  planBtn.appendChild(icon('zap', 13));
  planBtn.appendChild(document.createTextNode('Criar Plano'));
  planBtn.addEventListener('click', () => {
    void createPlan();
  });
  body.appendChild(planBtn);

  void loadGroups();
}

// ── Mapa de Operações (Onda 1, D) ────────────────────────────────────────────

const VIEWER_SORT_ROWS: readonly { value: ViewerSort; label: string }[] = [
  { value: 'partida_asc', label: 'Partida (mais próxima)' },
  { value: 'partida_desc', label: 'Partida (mais distante)' },
  { value: 'chegada_asc', label: 'Chegada (mais próxima)' },
  { value: 'chegada_desc', label: 'Chegada (mais distante)' },
  { value: 'cadastro', label: 'Ordem de cadastro' },
];

const VIEWER_STATUS_ROWS: readonly { value: ViewerStatusFilter; label: string }[] = [
  { value: 'todos', label: 'Todos' },
  { value: 'pendentes', label: 'Pendentes' },
  { value: 'enviados', label: 'Enviados' },
  { value: 'falhas', label: 'Falhas/incertos' },
];

const VIEWER_KIND_LABELS: Readonly<Record<ViewerKind, string>> = {
  attack: 'Ataque',
  support: 'Apoio',
  noble: 'Nobre',
  fake: 'Fake',
  cancel: 'Cancelar',
};

function appendMapSection(parent: HTMLElement, ctx: SchedulerUiContext): void {
  const { box, body } = collapsibleSectionEl('Mapa de Operações', 'eye', true);
  parent.appendChild(box);
  body.appendChild(
    tshNoteBanner(
      'Todos os comandos vivos do Agendador em uma lista: filtros, conflitos de ms, edição em massa e exportação/importação JSON.',
    ),
  );

  let statusEl: HTMLDivElement | null = null;
  const showStatus = (message: string, danger: boolean): void => {
    if (statusEl === null) {
      statusEl = statusRowEl('');
      body.insertBefore(statusEl, body.firstChild?.nextSibling ?? null);
    }
    const msg = statusMsgOf(statusEl);
    msg.textContent = message;
    msg.style.color = danger ? 'var(--shs-danger)' : '';
    // v3.2.1: o botão fica no fim de uma seção longa — a mensagem vem à vista.
    statusEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  // ── Filtros ──
  const dateFieldSelect = selectEl([
    { value: 'partida', label: 'Partida' },
    { value: 'chegada', label: 'Chegada' },
  ]);
  const fromInput = document.createElement('input');
  fromInput.type = 'datetime-local';
  fromInput.step = '1';
  fromInput.className = 'tsh-input';
  const toInput = document.createElement('input');
  toInput.type = 'datetime-local';
  toInput.step = '1';
  toInput.className = 'tsh-input';
  const coordInput = document.createElement('input');
  coordInput.type = 'text';
  coordInput.className = 'tsh-input';
  coordInput.placeholder = '555|444';
  coordInput.setAttribute('autocomplete', 'off');
  const statusSelect = selectEl(VIEWER_STATUS_ROWS.map((row) => ({ value: row.value, label: row.label })));
  const sortSelect = selectEl(VIEWER_SORT_ROWS.map((row) => ({ value: row.value, label: row.label })));
  const groupSelect = selectEl([{ value: '', label: '— todos —' }]);
  const conflictsCheck = checkboxEl(`Só conflitos de partida (< ${VIEWER_CONFLICT_WINDOW_MS / 1000} s)`, `Comandos da MESMA origem com partidas a menos de ${VIEWER_CONFLICT_WINDOW_MS / 1000} s entre si (a aba não consegue enviar os dois).`);
  const kindChecks = VIEWER_KINDS.map((kind) => {
    const check = checkboxEl(VIEWER_KIND_LABELS[kind]);
    check.input.checked = true;
    return { kind, check };
  });
  const fullPopInput = numberInputEl('5000', 0, 100_000_000, 100);
  const fakePopInput = numberInputEl('280', 0, 100_000_000, 10);
  const kindRow = document.createElement('div');
  kindRow.className = 'tsh-check-row';
  kindRow.style.flexWrap = 'wrap';
  kindRow.style.gap = '12px';
  for (const { check } of kindChecks) kindRow.appendChild(check.row);
  body.appendChild(fieldEl(labelEl('Período'), dateFieldSelect, fromInput, toInput));
  body.appendChild(fieldEl(labelEl('Tipos'), kindRow));
  body.appendChild(fieldEl(labelEl('Status'), statusSelect));
  body.appendChild(fieldEl(labelEl('Coordenada (origem ou alvo)'), coordInput));
  body.appendChild(fieldEl(labelEl('Grupo (por origem)'), groupSelect));
  body.appendChild(fieldEl(labelEl('Ordenação'), sortSelect));
  body.appendChild(conflictsCheck.row);
  body.appendChild(fieldEl(labelEl('Pill cheio (pop ≥)'), fullPopInput, labelEl('Pill fake (pop ≤)'), fakePopInput));

  const listWrap = document.createElement('div');
  body.appendChild(listWrap);

  // ── Estado do grupo (filtro por origem) ──
  let groupVillageIds: Set<string> | null = null;
  let activeGroupId: number | undefined;
  const loadGroups = async (): Promise<void> => {
    try {
      const groups = await getGroupOptions();
      for (const group of groups) {
        const option = document.createElement('option');
        option.value = String(group.groupId);
        option.textContent = group.name;
        groupSelect.appendChild(option);
      }
    } catch {
      /* sem grupos: o filtro fica só com "todos" */
    }
  };
  groupSelect.addEventListener('change', () => {
    const groupId = Number(groupSelect.value);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      groupVillageIds = null;
      activeGroupId = undefined;
      renderList();
      return;
    }
    activeGroupId = groupId;
    groupVillageIds = new Set();
    showStatus('Carregando as aldeias do grupo…', false);
    void getGroupVillages(groupId)
      .then((rows) => {
        groupVillageIds = new Set(rows.map((row) => String(row.villageId)));
        showStatus(
          rows.length > 0
            ? `${rows.length} aldeia(s) no grupo.`
            : 'O grupo não devolveu aldeias (pode ser leitura vazia) — o filtro fica vazio.',
          false,
        );
        renderList();
      })
      .catch(() => {
        groupVillageIds = new Set();
        showStatus('Falha ao ler as aldeias do grupo — filtro vazio.', true);
        renderList();
      });
  });

  // ── Seleção + edição em massa ──
  const selectedIds = new Set<string>();
  const bulkFieldSelect = selectEl([
    { value: 'partida', label: 'Nova partida' },
    { value: 'chegada', label: 'Nova chegada' },
  ]);
  const bulkTimeInput = document.createElement('input');
  bulkTimeInput.type = 'datetime-local';
  bulkTimeInput.step = '1';
  bulkTimeInput.className = 'tsh-input';
  bulkTimeInput.value = toDatetimeLocalValue(new Date(referenceNow().getTime() + 30 * 60_000));
  const bulkMsInput = document.createElement('input');
  bulkMsInput.type = 'number';
  bulkMsInput.min = '0';
  bulkMsInput.max = '999';
  bulkMsInput.value = '0';
  bulkMsInput.className = 'tsh-input tsh-input--ms';
  bulkMsInput.title = 'Milissegundos (0–999)';
  bulkMsInput.setAttribute('aria-label', 'Milissegundos');
  const bulkBtn = document.createElement('button');
  bulkBtn.type = 'button';
  bulkBtn.className = 'tsh-btn';
  bulkBtn.appendChild(icon('clock', 12));
  bulkBtn.appendChild(document.createTextNode('Aplicar horário'));
  bulkBtn.addEventListener('click', () => {
    if (selectedIds.size === 0) {
      showStatus('Selecione ao menos um comando na lista.', true);
      return;
    }
    const when = parseDatetimeLocal(bulkTimeInput.value);
    if (when === null) {
      showStatus('Informe o novo horário (data e hora, com segundos).', true);
      return;
    }
    const field = bulkFieldSelect.value as ViewerDateField;
    const newTimeMs = localToServerEpoch(when, currentServerOffsetMs()) + parseMillisInput(bulkMsInput.value);
    const edited = applyBulkTimeEdit(currentCommands(), [...selectedIds], field, newTimeMs);
    const times = new Map<string, { sendAt: string; arrivalAt: string }>();
    for (const command of edited) {
      if (!selectedIds.has(command.id)) continue;
      times.set(command.id, {
        sendAt: new Date(command.departureMs).toISOString(),
        arrivalAt: new Date(command.arrivalMs).toISOString(),
      });
    }
    const changed = applySchedulerTimes(ctx.world, times);
    selectedIds.clear();
    ctx.rerender();
    ctx.refreshList();
    renderList();
    showStatus(`${changed} comando(s) reposicionado(s) — a outra ponta acompanha a duração da viagem.`, false);
  });
  const bulkRow = document.createElement('div');
  bulkRow.className = 'tsh-check-row';
  bulkRow.style.flexWrap = 'wrap';
  bulkRow.style.gap = '8px';
  bulkRow.append(bulkFieldSelect, bulkTimeInput, bulkMsInput, bulkBtn);
  body.appendChild(fieldEl(labelEl('Edição em massa'), bulkRow));

  // ── Ações ──
  const openMapBtn = document.createElement('button');
  openMapBtn.type = 'button';
  openMapBtn.className = 'tsh-btn';
  openMapBtn.appendChild(icon('target', 12));
  openMapBtn.appendChild(document.createTextNode('Abrir no mapa'));
  openMapBtn.addEventListener('click', () => {
    const first = filteredCommands()[0];
    if (first === undefined) {
      showStatus('Nenhum comando no recorte atual.', true);
      return;
    }
    window.open(`/game.php?screen=map&x=${first.target.x}&y=${first.target.y}`, '_blank', 'noopener');
  });
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'tsh-btn';
  exportBtn.appendChild(icon('download', 12));
  exportBtn.appendChild(document.createTextNode('Exportar JSON'));
  exportBtn.addEventListener('click', () => {
    try {
      const json = serializeViewerSet(currentCommands());
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `tsh-operacoes-${ctx.world}.json`;
      link.click();
      URL.revokeObjectURL(url);
      showStatus('Conjunto exportado.', false);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : String(error), true);
    }
  });
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = 'application/json,.json';
  importInput.style.display = 'none';
  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    if (file === undefined) return;
    void file
      .text()
      .then((raw) => {
        applyImport(raw);
      })
      .catch(() => {
        showStatus('Não foi possível ler o arquivo escolhido.', true);
      })
      .finally(() => {
        importInput.value = '';
      });
  });
  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'tsh-btn';
  importBtn.appendChild(icon('refresh', 12));
  importBtn.appendChild(document.createTextNode('Importar JSON'));
  importBtn.addEventListener('click', () => importInput.click());
  const actionsRow = document.createElement('div');
  actionsRow.className = 'tsh-actions';
  actionsRow.append(openMapBtn, exportBtn, importBtn, importInput);
  body.appendChild(actionsRow);

  /**
   * Importação: id conhecido tem o horário atualizado (roundtrip do export);
   * id novo entra PAUSADO (o arquivo não carrega tropas — retomar sem revisar
   * enviaria um comando vazio) e só com origem que é aldeia sua.
   */
  function applyImport(raw: string): void {
    const parsed = deserializeViewerSet(raw);
    if ('error' in parsed) {
      showStatus(parsed.error, true);
      return;
    }
    const state = loadSchedulerState(ctx.world);
    const knownIds = new Set(state.commands.map((command) => command.id));
    const originVillages = new Map<string, { id: string; name: string }>();
    for (const village of ctx.villages) originVillages.set(`${village.x}|${village.y}`, { id: village.id, name: village.name });
    const times = new Map<string, { sendAt: string; arrivalAt: string }>();
    const created: ScheduledCommandRecord[] = [];
    let unknownOrigins = 0;
    for (const command of parsed.cmds) {
      if (knownIds.has(command.id)) {
        times.set(command.id, {
          sendAt: new Date(command.departureMs).toISOString(),
          arrivalAt: new Date(command.arrivalMs).toISOString(),
        });
        continue;
      }
      const origin = originVillages.get(`${command.origin.x}|${command.origin.y}`);
      if (origin === undefined) {
        unknownOrigins += 1;
        continue;
      }
      created.push(
        createScheduledCommand({
          kind: command.kind,
          sourceVillageId: origin.id,
          sourceName: origin.name,
          source: { x: command.origin.x, y: command.origin.y },
          target: { x: command.target.x, y: command.target.y },
          units: {},
          timingMode: 'arrival',
          sendAt: new Date(command.departureMs).toISOString(),
          arrivalAt: new Date(command.arrivalMs).toISOString(),
          detail: 'Importado do Mapa de Operações — revise as tropas e retome.',
        }),
      );
    }
    const changed = applySchedulerTimes(ctx.world, times);
    const saved = appendSchedulerRecords(ctx.world, created);
    for (const record of saved) setCommandPaused(ctx.world, record.id, true);
    ctx.rerender();
    ctx.refreshList();
    renderList();
    showStatus(
      `Importação: ${changed} horário(s) atualizado(s), ${saved.length} comando(s) novo(s) PAUSADO(S) — tropas desconhecidas, revise antes de retomar` +
        `${unknownOrigins > 0 ? `, ${unknownOrigins} ignorado(s) por origem desconhecida` : ''}.`,
      saved.length > 0,
    );
  }

  // ── Dados e render ──
  let currentSet: ViewerSet = { commands: [], skipped: 0 };
  const targetPointsById = new Map<string, number>();

  function currentCommands(): ViewerCommand[] {
    return currentSet.commands;
  }

  function detectConflicts(): ReadonlyMap<string, readonly string[]> {
    return detectDepartureConflicts(currentCommands(), VIEWER_CONFLICT_WINDOW_MS);
  }

  function filteredCommands(): ViewerCommand[] {
    const from = parseDatetimeLocal(fromInput.value);
    const to = parseDatetimeLocal(toInput.value);
    const offset = currentServerOffsetMs();
    const selectedKinds = kindChecks.filter(({ check }) => check.input.checked).map(({ kind }) => kind);
    const filters: ViewerFilters = {
      dateField: dateFieldSelect.value as ViewerDateField,
      status: statusSelect.value as ViewerStatusFilter,
      ...(from !== null ? { fromMs: localToServerEpoch(from, offset) } : {}),
      ...(to !== null ? { toMs: localToServerEpoch(to, offset) } : {}),
      ...(coordInput.value.trim() !== '' ? { coordQuery: coordInput.value } : {}),
      ...(selectedKinds.length < VIEWER_KINDS.length ? { kinds: selectedKinds } : {}),
      ...(activeGroupId !== undefined ? { groupId: activeGroupId } : {}),
      ...(conflictsCheck.input.checked ? { conflictsOnly: true } : {}),
    };
    return sortViewerCommands(filterViewerCommands(currentCommands(), filters), sortSelect.value as ViewerSort);
  }

  const rebuild = (): void => {
    const records = loadSchedulerState(ctx.world).commands;
    targetPointsById.clear();
    for (const record of records) {
      if (record.targetPoints !== undefined) targetPointsById.set(record.id, record.targetPoints);
    }
    currentSet = toViewerCommands(records, new Date(serverNowMs()), SCHEDULER_DEFAULT_WINDOW, (villageId) =>
      groupVillageIds !== null && activeGroupId !== undefined && groupVillageIds.has(normalizeVillageId(villageId))
        ? activeGroupId
        : undefined,
    );
    for (const id of [...selectedIds]) {
      if (!currentSet.commands.some((command) => command.id === id)) selectedIds.delete(id);
    }
  };

  const mapRow = (
    command: ViewerCommand,
    offset: number,
    conflicts: ReadonlyMap<string, readonly string[]>,
    cuts: { fullMinPop: number; fakeMaxPop: number },
  ): HTMLDivElement => {
    const row = document.createElement('div');
    row.className = 'tsh-card';
    const head = document.createElement('div');
    head.className = 'tsh-card-head';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = selectedIds.has(command.id);
    check.addEventListener('change', () => {
      if (check.checked) selectedIds.add(command.id);
      else selectedIds.delete(command.id);
    });
    const title = document.createElement('div');
    title.className = 'tsh-card-title';
    title.style.flex = '1';
    title.textContent = `${command.origin.x}|${command.origin.y} → ${command.target.x}|${command.target.y}`;
    head.append(check, badgeEl(commandKindBadgeClass(command.kind), VIEWER_KIND_LABELS[command.kind]), title);
    const points = targetPointsById.get(command.id);
    if (points !== undefined) {
      const pill = classifyByPopulation(points, cuts);
      if (pill !== 'neutro') {
        head.appendChild(
          badgeEl(
            pill === 'full' ? 'tsh-badge tsh-badge--muta' : 'tsh-badge tsh-badge--on',
            `${pill === 'full' ? 'CHEIO' : 'FAKE'} ${formatInt(points)}`,
          ),
        );
      }
    }
    head.appendChild(badgeEl('tsh-badge', commandStatusLabel(command.status as ScheduledCommandViewStatus)));
    row.appendChild(head);
    const desc = document.createElement('div');
    desc.className = 'tsh-card-desc';
    const conflict = conflicts.has(command.id);
    desc.textContent =
      `Partida ${formatTimestampMs(serverToLocal(new Date(command.departureMs).toISOString(), offset))}` +
      ` · Chegada ${formatTimestampMs(serverToLocal(new Date(command.arrivalMs).toISOString(), offset))}` +
      (conflict ? ' · CONFLITO de ms' : '');
    if (conflict) desc.style.color = 'var(--shs-danger)';
    row.appendChild(desc);
    return row;
  };

  function renderList(): void {
    listWrap.replaceChildren();
    const rows = filteredCommands();
    const conflicts = detectConflicts();
    const meta = document.createElement('div');
    meta.className = 'tsh-meta-row';
    meta.textContent = `${rows.length} de ${currentSet.commands.length} comando(s) · ${conflicts.size} com conflito de ms`;
    listWrap.appendChild(meta);
    if (currentSet.skipped > 0) {
      const note = helpEl(viewerSkippedNote(currentSet.skipped));
      note.style.color = 'var(--shs-danger)';
      listWrap.appendChild(note);
    }
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'shs-empty';
      empty.textContent = 'Nenhum comando no recorte atual.';
      listWrap.appendChild(empty);
      return;
    }
    const offset = currentServerOffsetMs();
    const cuts = { fullMinPop: Number(fullPopInput.value) || 0, fakeMaxPop: Number(fakePopInput.value) || 0 };
    for (const command of rows) listWrap.appendChild(mapRow(command, offset, conflicts, cuts));
  }

  for (const control of [dateFieldSelect, statusSelect, sortSelect]) control.addEventListener('change', renderList);
  for (const input of [fromInput, toInput, coordInput, fullPopInput, fakePopInput]) input.addEventListener('input', renderList);
  conflictsCheck.input.addEventListener('change', renderList);
  for (const { check } of kindChecks) check.input.addEventListener('change', renderList);

  // O estado do motor é síncrono (GM storage): a primeira pintura já mostra a
  // lista; os grupos chegam depois (async) e só completam o filtro.
  rebuild();
  renderList();
  void loadGroups();
}
