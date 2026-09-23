/**
 * Relógio Adaptativo (Onda 0): mantém o offset browser↔servidor do Tribal Wars
 * continuamente, com precisão de milissegundos para comandos "cravados".
 *
 * Cada amostra é um round-trip medido pelo chamador (`sentAtMs` = t0, `receivedAtMs`
 * = t1, `serverMs` = carimbo do servidor: header `Date` em ms ou "Hora do servidor"
 * parseado da página). O offset bruto assume RTT simétrico — o carimbo foi tirado
 * no meio do round-trip. O offset mantido é a mediana aparada da janela de
 * amostras aceitas, com correção por salto limitada a `maxCorrectionMs`: uma
 * amostra absurda nunca "arranca" o relógio de uma vez.
 *
 * Módulo PURO e determinístico: zero DOM, zero rede, zero `Math.random`. Quem
 * mede (fetch, leitura da tela, storage) é o chamador; aqui só se calcula.
 *
 * Complementa `ext/core/execution/server-clock.ts` (parse do texto do jogo e
 * offset estático) — este motor é o lado adaptativo, consumido pelo agendador
 * de comandos.
 */

export type ClockStrategy = 'responsivo' | 'estavel';

export interface ClockSample {
  /** t0: timestamp do cliente quando o request saiu. */
  readonly sentAtMs: number;
  /** t1: timestamp do cliente quando a resposta chegou. */
  readonly receivedAtMs: number;
  /** Timestamp do servidor na resposta (header `Date` em ms OU parseado da página). */
  readonly serverMs: number;
}

export interface AdaptiveClockConfig {
  readonly strategy: ClockStrategy;
  /** Teto do salto de correção por amostra ingerida (clampado em 300..5000). */
  readonly maxCorrectionMs: number;
  /** Tamanho da janela na estratégia `responsivo` (default 8 amostras). */
  readonly windowResponsivo: number;
  /** Tamanho da janela na estratégia `estavel` (default 30 amostras). */
  readonly windowEstavel: number;
  /** Fração descartada de CADA ponta antes da mediana (default 0.2). */
  readonly trimRatio: number;
  /** RTT máximo aceito (ms); acima disso a amostra é descartada. Default `DEFAULT_MAX_RTT_MS`. */
  readonly maxRttMs?: number;
}

/** RTT acima disto indica rede/aba travada: a amostra não entra (default do módulo). */
export const DEFAULT_MAX_RTT_MS = 10_000;

/** Piso do clamp de `maxCorrectionMs` (evita configuração que trava a convergência). */
export const MIN_MAX_CORRECTION_MS = 300;

/** Teto do clamp de `maxCorrectionMs` (evita salto que quebra o "cravado"). */
export const MAX_MAX_CORRECTION_MS = 5_000;

/** Abaixo disto a confiança do offset é sempre `baixa`. */
export const CLOCK_CONFIDENCE_MIN_SAMPLES = 5;

/** Corte máximo aceito por ponta (acima disso a mediana aparada perde o centro). */
const MAX_TRIM_RATIO = 0.45;

export const DEFAULT_ADAPTIVE_CLOCK_CONFIG: AdaptiveClockConfig = {
  // Padrão responsivo: comandos "cravados" exigem aderir rápido ao offset real
  // logo após o login; a mediana + clamp já protegem contra amostra ruim.
  strategy: 'responsivo',
  maxCorrectionMs: 1_000,
  windowResponsivo: 8,
  windowEstavel: 30,
  trimRatio: 0.2,
  maxRttMs: DEFAULT_MAX_RTT_MS,
};

export interface AdaptiveClockState {
  /** Ring buffer das últimas amostras aceitas (a janela vigente da estratégia). */
  readonly samples: readonly ClockSample[];
  /** Melhor estimativa atual (`serverNow = clientNow + offsetMs`). */
  readonly offsetMs: number;
  /** Última correção aplicada (com sinal): positivo = relógio local atrasado. */
  readonly lastCorrectionMs: number;
}

export function initialAdaptiveClockState(baseOffsetMs: number): AdaptiveClockState {
  return {
    samples: [],
    offsetMs: Number.isFinite(baseOffsetMs) ? baseOffsetMs : 0,
    lastCorrectionMs: 0,
  };
}

/** Offset bruto da amostra: carimbo do servidor menos o meio do round-trip. */
export function sampleOffsetMs(sample: ClockSample): number {
  return sample.serverMs - (sample.sentAtMs + sample.receivedAtMs) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function windowSize(config: AdaptiveClockConfig): number {
  const raw = config.strategy === 'responsivo' ? config.windowResponsivo : config.windowEstavel;
  const fallback =
    config.strategy === 'responsivo'
      ? DEFAULT_ADAPTIVE_CLOCK_CONFIG.windowResponsivo
      : DEFAULT_ADAPTIVE_CLOCK_CONFIG.windowEstavel;
  const size = Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return Math.max(1, size);
}

function correctionLimit(config: AdaptiveClockConfig): number {
  const raw = Number.isFinite(config.maxCorrectionMs)
    ? config.maxCorrectionMs
    : DEFAULT_ADAPTIVE_CLOCK_CONFIG.maxCorrectionMs;
  return clamp(raw, MIN_MAX_CORRECTION_MS, MAX_MAX_CORRECTION_MS);
}

function maxRtt(config: AdaptiveClockConfig): number {
  const raw = config.maxRttMs ?? DEFAULT_MAX_RTT_MS;
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_RTT_MS;
}

function isAcceptableSample(sample: ClockSample, config: AdaptiveClockConfig): boolean {
  if (!Number.isFinite(sample.serverMs)) return false;
  const rtt = sample.receivedAtMs - sample.sentAtMs;
  // RTT negativo = relógio local andou para trás durante a medição: descarta.
  if (!Number.isFinite(rtt) || rtt < 0) return false;
  return rtt <= maxRtt(config);
}

/**
 * Mediana aparada: ordena, descarta `trimRatio` de CADA ponta e tira a mediana
 * do miolo. Com corte simétrico o centro é preservado (o ganho é a robustez do
 * estimador a extremos, não a mudança do valor central).
 */
function trimmedMedian(values: readonly number[], trimRatio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const ratio = Number.isFinite(trimRatio) ? clamp(trimRatio, 0, MAX_TRIM_RATIO) : 0;
  const trim = Math.floor(sorted.length * ratio);
  const kept = sorted.slice(trim, sorted.length - trim);
  const source = kept.length > 0 ? kept : sorted;
  const middle = Math.floor(source.length / 2);
  const upper = source[middle] ?? 0;
  if (source.length % 2 === 1) return upper;
  return ((source[middle - 1] ?? 0) + upper) / 2;
}

/**
 * Ingere uma amostra e devolve o estado novo. Amostra com RTT inválido/alta
 * (ou `serverMs` não finito) é descartada e o estado volta IDÊNTICO (mesma
 * referência) — o chamador pode usar isso para detectar descarte.
 */
export function ingestSample(
  state: AdaptiveClockState,
  sample: ClockSample,
  config: AdaptiveClockConfig,
): AdaptiveClockState {
  if (!isAcceptableSample(sample, config)) return state;
  const samples = [...state.samples, sample].slice(-windowSize(config));
  const target = trimmedMedian(samples.map(sampleOffsetMs), config.trimRatio);
  const limit = correctionLimit(config);
  const correction = clamp(target - state.offsetMs, -limit, limit);
  return {
    samples,
    offsetMs: state.offsetMs + correction,
    lastCorrectionMs: correction,
  };
}

/** "Agora" na perspectiva do servidor, a partir do relógio local do cliente. */
export function masterNow(state: AdaptiveClockState, clientNowMs: number): number {
  return clientNowMs + state.offsetMs;
}

/**
 * Qualidade do offset para a UI: `baixa` com menos de `CLOCK_CONFIDENCE_MIN_SAMPLES`,
 * `media` com a janela da estratégia ainda incompleta e `alta` com a janela cheia.
 */
export function clockConfidence(
  state: AdaptiveClockState,
  config: AdaptiveClockConfig,
): 'baixa' | 'media' | 'alta' {
  const count = state.samples.length;
  if (count < CLOCK_CONFIDENCE_MIN_SAMPLES) return 'baixa';
  return count < windowSize(config) ? 'media' : 'alta';
}

/** Sugere recalibrar quando passou `everyMs` desde a última amostra aceita (ou nunca houve). */
export function needsCalibration(state: AdaptiveClockState, nowMs: number, everyMs: number): boolean {
  const last = state.samples.at(-1);
  if (last === undefined) return true;
  return nowMs - last.receivedAtMs >= everyMs;
}
