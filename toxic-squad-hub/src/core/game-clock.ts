// Relógio do servidor com precisão de milissegundos (Onda A — regra de ouro).
//
// Porta RUNTIME dos motores puros de ext/core/timing: mede o offset entre o
// "quadro do jogo" (a Hora do servidor lida como relógio de parede local — o
// mesmo quadro em que os sendAt são gravados) e o relógio do navegador, por
// três fontes (a de menor incerteza vence — clock-source.ts):
//   1. 'http'  — rajada curta de HEAD same-origin lendo o cabeçalho Date
//                (interseção de intervalos — http-date-clock.ts). Também mede
//                o RTT usado na compensação de latência do clique final;
//   2. 'jogo'  — Timing.getCurrentServerTime() da própria página (quando existe);
//   3. 'tela'  — texto #serverTime (resolução de 1s) — o comportamento antigo.
// A medição HTTP persiste por mundo (GM) e vale 30 min, então a página nova
// (ex.: a tela de confirmação) já nasce calibrada.
//
// Também oferece a ESPERA DE PRECISÃO (`waitUntilServerMs`): timer grosso num
// Web Worker (não sofre o estrangulamento de timers das abas em 2º plano) e o
// último trecho em espera ativa no relógio monotônico (performance.now).

import { pageWindow } from './page';
import { gm } from './storage';
import { parseServerTimeText } from '../ext/core/execution/server-clock';
import {
  calibrationSchedule,
  estimateDateClock,
  frameShiftMs,
  nextBisectionSendAt,
  type DateHeaderSample,
} from '../ext/core/timing/http-date-clock';
import { pickClockSource, type ClockCandidate, type ClockChoice } from '../ext/core/timing/clock-source';
import { MAX_LATENCY_COMPENSATION_MS, spinBudgetMs } from '../ext/core/timing/precise-fire';
import { learnedCompensationMs, type FeedbackSample } from '../ext/core/timing/arrival-feedback';

// ── Onda E: autocalibração pelas chegadas reais ────────────────────────────

function feedbackKey(): string {
  return `tsh-clock-learn:${worldId()}`;
}

/** Amostras de chegada real (mais antiga → mais recente). */
export function arrivalFeedback(): FeedbackSample[] {
  const raw = gm.get<unknown>(feedbackKey(), []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is FeedbackSample =>
      typeof item === 'object' &&
      item !== null &&
      Number.isFinite((item as FeedbackSample).errorMs) &&
      Number.isFinite((item as FeedbackSample).compensationMs),
  );
}

/** Guarda uma chegada conferida (mantém as 20 mais recentes). */
export function recordArrivalFeedback(sample: FeedbackSample): void {
  gm.set(feedbackKey(), [...arrivalFeedback(), sample].slice(-20));
}

/** Zera o aprendizado (ex.: mudou de internet/computador). */
export function resetArrivalFeedback(): void {
  gm.set(feedbackKey(), []);
}

interface PersistedHttpClock {
  offsetMs: number;
  halfWidthMs: number;
  rttMedianMs: number;
  measuredAtMs: number;
  agreeing: number;
}

export interface ClockInfo {
  /** Onda E: compensação aprendida pelas chegadas reais (null = sem amostras suficientes). */
  learnedCompensationMs: number | null;
  /** Último erro medido (chegada real − planejada), ms. */
  lastArrivalErrorMs: number | null;
  /** Quantos envios já foram conferidos. */
  feedbackCount: number;
  source: ClockChoice['kind'] | 'nenhuma';
  offsetMs: number;
  uncertaintyMs: number;
  rttMedianMs: number | null;
  measuredAtMs: number | null;
  calibrating: boolean;
}

const JOGO_UNCERTAINTY_MS = 150;
const TELA_UNCERTAINTY_MS = 1_000;
const SPREAD_SAMPLES = 4;
const BISECTION_SAMPLES = 7;

function worldId(): string {
  return window.location.hostname.split('.')[0] ?? 'mundo';
}

function persistKey(): string {
  return `tsh-clock:${worldId()}`;
}

let httpClock: PersistedHttpClock | null = null;
let httpLoaded = false;
let calibrating: Promise<void> | null = null;
let lastCalibrationAttemptMs = 0;
/** Intervalo mínimo entre calibrações AUTOMÁTICAS (a manual ignora). */
const AUTO_CALIBRATION_MIN_GAP_MS = 5 * 60_000;

function loadHttpClock(): PersistedHttpClock | null {
  if (!httpLoaded) {
    httpLoaded = true;
    const stored = gm.get<PersistedHttpClock | null>(persistKey(), null);
    if (
      stored !== null &&
      typeof stored === 'object' &&
      [stored.offsetMs, stored.halfWidthMs, stored.rttMedianMs, stored.measuredAtMs].every(
        (value) => typeof value === 'number' && Number.isFinite(value),
      )
    ) {
      httpClock = stored;
    }
  }
  return httpClock;
}

/** Quadro do jogo lido do texto da tela (null = sem relógio legível). */
function readScreenFrame(localNow: Date): number | null {
  const time = document.querySelector('#serverTime, #server_time, .server-time')?.textContent ?? null;
  if (time === null) return null;
  const date = document.querySelector('#serverDate, #server_date, .server-date')?.textContent ?? '';
  const parsed = parseServerTimeText(`${time} ${date}`.trim(), localNow);
  if (parsed === undefined) return null;
  const ms = parsed.getTime();
  return Math.abs(ms - localNow.getTime()) > 24 * 3_600_000 ? null : ms;
}

function screenCandidate(nowLocal: number): ClockCandidate | null {
  const frame = readScreenFrame(new Date(nowLocal));
  if (frame === null) return null;
  // O texto marca o INÍCIO do segundo corrente: o centro do intervalo é +500ms.
  return { kind: 'tela', offsetMs: frame + 500 - nowLocal, uncertaintyMs: TELA_UNCERTAINTY_MS, measuredAtMs: nowLocal };
}

/**
 * Deslocamento quadro↔UTC: pela tela quando legível (tolerância 2,5s); sem a
 * tela, assume o fuso do navegador (P2 revisão Onda A: tolerância larga — o
 * relógio do PC errado é justamente o caso em que medir importa).
 */
function frameShiftFor(utcNowMs: number, nowLocal: number): number | null {
  const frame = readScreenFrame(new Date(nowLocal));
  return frame !== null ? frameShiftMs(frame, utcNowMs) : frameShiftMs(nowLocal, utcNowMs, 7 * 60_000);
}

function jogoCandidate(nowLocal: number): ClockCandidate | null {
  try {
    const timing = (pageWindow() as { Timing?: { getCurrentServerTime?: () => unknown } }).Timing;
    const raw = timing?.getCurrentServerTime?.();
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
    const shift = frameShiftFor(raw, nowLocal);
    if (shift === null) return null; // relógio do jogo incoerente com a tela: recusa
    return { kind: 'jogo', offsetMs: raw + shift - nowLocal, uncertaintyMs: JOGO_UNCERTAINTY_MS, measuredAtMs: nowLocal };
  } catch {
    return null;
  }
}

function httpCandidate(): ClockCandidate | null {
  const clock = loadHttpClock();
  if (clock === null) return null;
  return { kind: 'http', offsetMs: clock.offsetMs, uncertaintyMs: clock.halfWidthMs, measuredAtMs: clock.measuredAtMs };
}

function currentChoice(): ClockChoice | null {
  const nowLocal = Date.now();
  return pickClockSource([httpCandidate(), jogoCandidate(nowLocal), screenCandidate(nowLocal)], nowLocal);
}

/** Offset atual (quadro do jogo − relógio local), ms. 0 sem nenhuma fonte. */
export function serverOffsetMs(): number {
  return currentChoice()?.offsetMs ?? 0;
}

/** "Agora" no relógio do servidor (quadro do jogo), ms. */
export function serverNowMs(): number {
  return Date.now() + serverOffsetMs();
}

/**
 * Mira quente (Onda 1): instante (hora do servidor) de um clique cravado
 * iminente NESTA página. Nos 2 s antes (e 0,5 s depois) os redesenhos
 * periódicos da interface se calam — uma tarefa longa de render atrasava a
 * mensagem do Worker e o clique saía tarde.
 */
let aimFireAtServerMs = 0;
const AIM_HOT_BEFORE_MS = 2_000;
const AIM_HOT_AFTER_MS = 500;

export function markAimHot(fireAtServerMs: number): void {
  aimFireAtServerMs = fireAtServerMs;
}

export function aimIsHot(): boolean {
  if (aimFireAtServerMs === 0) return false;
  const now = serverNowMs();
  return now >= aimFireAtServerMs - AIM_HOT_BEFORE_MS && now <= aimFireAtServerMs + AIM_HOT_AFTER_MS;
}

/** Estado do relógio para a UI e para a compensação de latência. */
export function clockInfo(): ClockInfo {
  const choice = currentChoice();
  const http = loadHttpClock();
  const feedback = arrivalFeedback();
  return {
    learnedCompensationMs: learnedCompensationMs(feedback, MAX_LATENCY_COMPENSATION_MS),
    lastArrivalErrorMs: feedback.at(-1)?.errorMs ?? null,
    feedbackCount: feedback.length,
    source: choice?.kind ?? 'nenhuma',
    offsetMs: choice?.offsetMs ?? 0,
    uncertaintyMs: choice?.effectiveUncertaintyMs ?? TELA_UNCERTAINTY_MS,
    rttMedianMs: http?.rttMedianMs ?? null,
    measuredAtMs: http?.measuredAtMs ?? null,
    calibrating: calibrating !== null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function oneDateSample(seq: number): Promise<DateHeaderSample | null> {
  const url = `${window.location.origin}/favicon.ico?tshclock=${Date.now()}-${seq}`;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 4_000);
  try {
    const sentAtMs = Date.now();
    const response = await fetch(url, {
      method: 'HEAD',
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    });
    const receivedAtMs = Date.now();
    const header = response.headers.get('date');
    const dateHeaderMs = header === null ? Number.NaN : Date.parse(header);
    if (!Number.isFinite(dateHeaderMs)) return null;
    return { sentAtMs, receivedAtMs, dateHeaderMs };
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Rajada de calibração HTTP (até 11 HEAD leves no favicon, até ~10s: 4 em fases
 * espalhadas + bissecção da virada de segundo). Concorrência
 * única (chamadas simultâneas reaproveitam a mesma rajada). Falha silenciosa:
 * sem Date legível o relógio segue nas outras fontes.
 */
export function calibrateClock(): Promise<void> {
  if (calibrating !== null) return calibrating;
  lastCalibrationAttemptMs = Date.now();
  calibrating = (async () => {
    const samples: DateHeaderSample[] = [];
    // Fase 1: fases espalhadas (estimativa inicial).
    const delays = calibrationSchedule(SPREAD_SAMPLES);
    const start = Date.now();
    for (let index = 0; index < delays.length; index += 1) {
      const wait = start + (delays[index] ?? 0) - Date.now();
      if (wait > 0) await sleep(wait);
      const sample = await oneDateSample(index);
      if (sample !== null) samples.push(sample);
    }
    // Fase 2: BISSECÇÃO — cada request mira a virada de segundo estimada e
    // corta a incerteza pela metade (converge para a ordem do RTT).
    for (let index = 0; index < BISECTION_SAMPLES; index += 1) {
      const current = estimateDateClock(samples);
      if (current === null) break;
      // Limite físico ≈ RTT/2 (a bissecção só se aproxima dele): margem de 10%.
      if (current.halfWidthMs <= current.rttMedianMs / 2 + Math.max(3, current.rttMedianMs * 0.1)) break;
      const at = nextBisectionSendAt({
        nowLocalMs: Date.now(),
        offsetMs: current.offsetMs,
        rttMs: current.rttMedianMs,
      });
      const wait = at - Date.now();
      if (wait > 0) await sleep(wait);
      const sample = await oneDateSample(SPREAD_SAMPLES + index);
      if (sample !== null) samples.push(sample);
    }
    const estimate = estimateDateClock(samples);
    if (estimate === null || estimate.agreeing < 3) return;
    const nowLocal = Date.now();
    const shift = frameShiftFor(nowLocal + estimate.offsetMs, nowLocal);
    if (shift === null) return;
    httpClock = {
      offsetMs: estimate.offsetMs + shift,
      halfWidthMs: estimate.halfWidthMs,
      rttMedianMs: estimate.rttMedianMs,
      measuredAtMs: nowLocal,
      agreeing: estimate.agreeing,
    };
    httpLoaded = true;
    gm.set(persistKey(), httpClock);
  })().finally(() => {
    calibrating = null;
  });
  return calibrating;
}

/**
 * Garante calibração HTTP recente (≤ maxAgeMs) antes de um cravado. Não lança;
 * devolve a incerteza resultante (ms).
 */
export async function ensureClockCalibrated(maxAgeMs = 10 * 60_000): Promise<number> {
  // Calibração já em andamento (ex.: disparada pelo ciclo): espera o resultado.
  if (calibrating !== null) {
    try {
      await calibrating;
    } catch {
      /* segue nas outras fontes */
    }
    return clockInfo().uncertaintyMs;
  }
  const http = loadHttpClock();
  const stale = http === null || Date.now() - http.measuredAtMs > maxAgeMs || http.halfWidthMs > 120;
  // P2 (revisão Onda A): rede instável não pode virar rajada a cada heartbeat.
  if (stale && Date.now() - lastCalibrationAttemptMs >= AUTO_CALIBRATION_MIN_GAP_MS) {
    try {
      await calibrateClock();
    } catch {
      /* segue nas outras fontes */
    }
  }
  return clockInfo().uncertaintyMs;
}

// ── Espera de precisão ─────────────────────────────────────────────────────

type WorkerTimer = { sleep(ms: number): Promise<void> };

let workerTimer: WorkerTimer | null | undefined;

/** Timer num Web Worker (Blob): não é estrangulado em aba de fundo. null = indisponível. */
function getWorkerTimer(): WorkerTimer | null {
  if (workerTimer !== undefined) return workerTimer;
  try {
    const source = 'onmessage=function(e){var d=e.data;setTimeout(function(){postMessage(d.id)},d.ms)}';
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url);
    const pending = new Map<number, () => void>();
    let seq = 0;
    worker.onmessage = (event: MessageEvent<number>) => {
      const done = pending.get(event.data);
      pending.delete(event.data);
      done?.();
    };
    worker.onerror = () => {
      workerTimer = null; // CSP/erro: próximas esperas usam setTimeout
      for (const done of pending.values()) done();
      pending.clear();
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    workerTimer = {
      sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
          seq += 1;
          pending.set(seq, resolve);
          worker.postMessage({ id: seq, ms: Math.max(0, Math.floor(ms)) });
        });
      },
    };
  } catch {
    workerTimer = null;
  }
  return workerTimer;
}

/**
 * Espera que NÃO é estrangulada em aba de fundo (Web Worker; queda para
 * setTimeout). Usada pelo pacing da Central de Farm — o Chrome reduz os
 * timers de abas ocultas a 1 por minuto.
 */
export function backgroundSleep(ms: number): Promise<void> {
  const timer = getWorkerTimer();
  if (timer !== null) return timer.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function coarseSleep(ms: number): Promise<void> {
  const timer = getWorkerTimer();
  return timer !== null ? timer.sleep(ms) : sleep(ms);
}

/**
 * Espera até o instante `targetServerMs` do relógio do servidor. O trecho
 * grosso vai no worker (recalculado a cada volta — o offset pode ser refinado
 * no meio). Com `precise` (o CLIQUE do cravado), o fim — 25ms na aba visível,
 * ~1,1s em 2º plano — é espera ativa no relógio monotônico; sem `precise`
 * (aberturas de janela/pré-arme) não há espera ativa. `shouldAbort` é
 * consultado a cada volta grossa. Devolve false se abortou.
 */
export async function waitUntilServerMs(
  targetServerMs: number,
  shouldAbort?: () => boolean,
  opts?: { precise?: boolean },
): Promise<boolean> {
  const precise = opts?.precise === true;
  for (;;) {
    if (shouldAbort?.() === true) return false;
    const remaining = targetServerMs - serverNowMs();
    const spin = precise ? spinBudgetMs(document.hidden) : 0;
    if (remaining <= spin) break;
    await coarseSleep(Math.min(remaining - spin, 20_000));
  }
  if (!precise) return true;
  const perfTarget = performance.now() + (targetServerMs - serverNowMs());
  while (performance.now() < perfTarget) {
    // espera ativa curta (≤ spinBudgetMs): o disparo sai no ms planejado
  }
  return true;
}
