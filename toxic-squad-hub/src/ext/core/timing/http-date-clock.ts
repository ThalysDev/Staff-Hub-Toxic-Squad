/**
 * Relógio por cabeçalho HTTP `Date` (Onda A — precisão dos cravados).
 *
 * O `Date` da resposta tem resolução de SEGUNDOS, mas cada amostra limita o
 * offset (servidor − cliente) a um intervalo: se a resposta diz `D` e o round
 * trip foi de t0 a t1 (relógio do cliente), então em ALGUM instante entre t0 e
 * t1 o servidor marcava entre D e D+999ms. Logo:
 *
 *     offset ∈ [D − t1, D + 1000 − t0]
 *
 * Amostras tiradas em fases diferentes do segundo estreitam a interseção até a
 * ordem do RTT. A combinação usa o algoritmo de Marzullo (região coberta pelo
 * MAIOR número de intervalos) — uma amostra ruim nunca esvazia o resultado.
 *
 * Módulo PURO: zero DOM, zero rede, determinístico (testável em node).
 */

export interface DateHeaderSample {
  /** Relógio do cliente quando o request saiu (ms). */
  readonly sentAtMs: number;
  /** Relógio do cliente quando a resposta chegou (ms). */
  readonly receivedAtMs: number;
  /** Cabeçalho `Date` já convertido em epoch ms (múltiplo de 1000). */
  readonly dateHeaderMs: number;
}

export interface OffsetInterval {
  readonly lo: number;
  readonly hi: number;
}

export interface DateClockEstimate {
  /** Melhor offset (servidor − cliente), ms: centro da região de consenso. */
  readonly offsetMs: number;
  /** Meia-largura da região (incerteza ±), ms. */
  readonly halfWidthMs: number;
  /** Quantas amostras concordam com a região escolhida. */
  readonly agreeing: number;
  /** Total de amostras válidas consideradas. */
  readonly total: number;
  /** Mediana do RTT das amostras válidas (ms). */
  readonly rttMedianMs: number;
}

/** RTT acima disto não estreita nada (e sugere rede travada): descartado. */
export const DATE_SAMPLE_MAX_RTT_MS = 3_000;

/** Intervalo de offset admitido por UMA amostra; null = amostra inválida. */
export function dateSampleInterval(sample: DateHeaderSample): OffsetInterval | null {
  const { sentAtMs, receivedAtMs, dateHeaderMs } = sample;
  if (![sentAtMs, receivedAtMs, dateHeaderMs].every(Number.isFinite)) return null;
  const rtt = receivedAtMs - sentAtMs;
  if (rtt < 0 || rtt > DATE_SAMPLE_MAX_RTT_MS) return null;
  return { lo: dateHeaderMs - receivedAtMs, hi: dateHeaderMs + 1000 - sentAtMs };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Marzullo: varre os extremos ordenados e acha a região coberta pelo maior
 * número de intervalos. Empate de posição: abertura antes do fechamento
 * (intervalos que se tocam contam como sobrepostos).
 */
export function marzullo(intervals: readonly OffsetInterval[]): { lo: number; hi: number; count: number } | null {
  if (intervals.length === 0) return null;
  const edges: { at: number; kind: 1 | -1 }[] = [];
  for (const interval of intervals) {
    edges.push({ at: interval.lo, kind: 1 }, { at: interval.hi, kind: -1 });
  }
  edges.sort((a, b) => a.at - b.at || b.kind - a.kind);
  let best = 0;
  let current = 0;
  let bestLo = 0;
  let bestHi = 0;
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    if (edge === undefined) continue;
    current += edge.kind;
    if (edge.kind === 1 && current > best) {
      best = current;
      bestLo = edge.at;
      // O fim da região é o próximo extremo (sempre existe: todo lo tem um hi).
      bestHi = edges[index + 1]?.at ?? edge.at;
    }
  }
  return best === 0 ? null : { lo: bestLo, hi: bestHi, count: best };
}

/** Estimativa combinada das amostras; null = nenhuma amostra válida. */
export function estimateDateClock(samples: readonly DateHeaderSample[]): DateClockEstimate | null {
  const valid: { sample: DateHeaderSample; interval: OffsetInterval }[] = [];
  for (const sample of samples) {
    const interval = dateSampleInterval(sample);
    if (interval !== null) valid.push({ sample, interval });
  }
  const region = marzullo(valid.map((entry) => entry.interval));
  if (region === null) return null;
  return {
    offsetMs: Math.round((region.lo + region.hi) / 2),
    halfWidthMs: Math.max(0, Math.round((region.hi - region.lo) / 2)),
    agreeing: region.count,
    total: valid.length,
    rttMedianMs: Math.round(median(valid.map((entry) => entry.sample.receivedAtMs - entry.sample.sentAtMs))),
  };
}

/**
 * Deslocamento de fuso entre o "quadro do jogo" (Hora do servidor lida como
 * relógio de parede local) e o UTC verdadeiro, arredondado a 15 min (todos os
 * fusos reais são múltiplos de 15 min). null = divergência fora de ±2,5s do
 * múltiplo mais próximo (leitura incoerente — fonte recusada).
 */
export function frameShiftMs(frameNowMs: number, utcNowMs: number, toleranceMs = 2_500): number | null {
  if (!Number.isFinite(frameNowMs) || !Number.isFinite(utcNowMs)) return null;
  const quarter = 15 * 60_000;
  const raw = frameNowMs - utcNowMs;
  const shift = Math.round(raw / quarter) * quarter;
  return Math.abs(raw - shift) <= toleranceMs ? shift : null;
}

/**
 * Atrasos (ms, a partir do 1º request) de uma rajada de calibração: fases do
 * segundo espalhadas (passo primo de 173ms) para estreitar a interseção — com
 * piso de `minGapMs` entre requests (pacing da casa).
 */
export function calibrationSchedule(count: number, minGapMs = 250): number[] {
  const delays: number[] = [];
  let at = 0;
  for (let index = 0; index < Math.max(0, Math.floor(count)); index += 1) {
    delays.push(at);
    at += minGapMs + ((index * 173) % 200);
  }
  return delays;
}
