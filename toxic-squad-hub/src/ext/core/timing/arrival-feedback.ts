/**
 * Autocalibração pelo RESULTADO (Onda E) — puro/node-safe.
 *
 * O jogo mostra a chegada real de cada comando com milissegundos
 * ("hoje às 14:56:00:260"). Depois de um envio cravado, o agendador lê essa
 * chegada, compara com a planejada e guarda a "compensação ideal" daquele
 * envio (compensação usada + erro). A compensação automática passa a ser a
 * MEDIANA das últimas ideais — o sistema aprende a latência real do jogador
 * (rede + navegador + processamento do servidor), sem laço de realimentação.
 */

/** Chegada exibida pelo jogo → epoch no quadro do jogo (relógio de parede). null = ilegível. */
export function parseArrivalText(text: string, nowFrameMs: number): number | null {
  const clean = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const time = /(\d{1,2}):(\d{2}):(\d{2})(?::(\d{1,3}))?/.exec(clean);
  if (time === null) return null;
  const [h, m, s] = [Number(time[1]), Number(time[2]), Number(time[3])];
  // O jogo imprime os ms com 3 dígitos ("060"); padStart protege "5" → 5ms.
  const ms = time[4] === undefined ? 0 : Number(time[4].padStart(3, '0'));
  if (h > 23 || m > 59 || s > 59) return null;
  const now = new Date(nowFrameMs);
  let year = now.getFullYear();
  let month = now.getMonth();
  let day = now.getDate();
  if (clean.includes('amanhã') || clean.includes('amanha')) {
    const tomorrow = new Date(year, month, day + 1);
    [year, month, day] = [tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate()];
  } else if (!clean.includes('hoje')) {
    const date = /(\d{1,2})\.(\d{1,2})\.(\d{4})?/.exec(clean);
    if (date === null) return null;
    day = Number(date[1]);
    month = Number(date[2]) - 1;
    if (date[3] !== undefined && date[3] !== '') year = Number(date[3]);
    else if (month < now.getMonth() - 6) year += 1; // virada de ano (dez → jan)
  }
  const result = new Date(year, month, day, h, m, s, ms).getTime();
  return Number.isFinite(result) ? result : null;
}

export interface ArrivalRow {
  readonly target: { x: number; y: number };
  /** Coordenada da aldeia de origem (quando a linha a mostra). */
  readonly origin?: { x: number; y: number };
  readonly arrivalMs: number;
}

/**
 * Chegada real do comando conferido (revisão Onda E — sem adivinhação):
 * mesmo alvo, mesma ORIGEM (quando conhecida), dentro de ±toleranceMs.
 * Trem nativo: a PRIMEIRA chegada do grupo (os demais vêm +100 ms). Comando
 * simples: exatamente UMA candidata — duas ou mais (outros comandos para o
 * mesmo alvo no mesmo instante) = ambíguo = null (nada é aprendido).
 */
export function matchArrival(
  rows: readonly ArrivalRow[],
  query: { target: { x: number; y: number }; origin?: { x: number; y: number }; expectedMs: number; train: boolean },
  toleranceMs = 1_000,
): number | null {
  const candidates = rows
    .filter((row) => row.target.x === query.target.x && row.target.y === query.target.y)
    .filter(
      (row) =>
        query.origin === undefined ||
        row.origin === undefined ||
        (row.origin.x === query.origin.x && row.origin.y === query.origin.y),
    )
    .filter((row) => Math.abs(row.arrivalMs - query.expectedMs) <= toleranceMs)
    .map((row) => row.arrivalMs)
    .sort((a, b) => a - b);
  if (candidates.length === 0) return null;
  if (query.train) return candidates[0] ?? null;
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/** Latência plausível de um envio (ms): fora disto a amostra é descartada. */
export function plausibleLatency(latencyMs: number): boolean {
  return Number.isFinite(latencyMs) && latencyMs >= -100 && latencyMs <= 1_000;
}

export interface FeedbackSample {
  /** Erro medido: chegada real − planejada (ms; positivo = atrasou). */
  readonly errorMs: number;
  /** Compensação usada no envio (ms). */
  readonly compensationMs: number;
  readonly at: number;
}

/** Quantas amostras recentes contam para a mediana. */
export const FEEDBACK_WINDOW = 7;

/**
 * Compensação aprendida = mediana de (compensação usada + erro) das últimas
 * amostras, limitada a 0..teto. null com menos de 2 amostras (ainda não
 * confiável — vale a estimativa pelo RTT).
 */
export function learnedCompensationMs(samples: readonly FeedbackSample[], maxMs: number): number | null {
  const recent = samples.slice(-FEEDBACK_WINDOW);
  if (recent.length < 2) return null;
  const ideals = recent.map((sample) => sample.compensationMs + sample.errorMs).sort((a, b) => a - b);
  const mid = Math.floor(ideals.length / 2);
  const median = ideals.length % 2 === 1 ? (ideals[mid] ?? 0) : ((ideals[mid - 1] ?? 0) + (ideals[mid] ?? 0)) / 2;
  return Math.round(Math.min(maxMs, Math.max(0, median)));
}
