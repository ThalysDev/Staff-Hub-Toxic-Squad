/**
 * Escolha da MELHOR fonte de relógio do servidor (Onda A). Puro/node-safe.
 *
 * Fontes, da mais precisa para a menos:
 *  - 'http'  — cabeçalho Date das respostas + interseção (erro ≈ RTT/2, medido);
 *  - 'jogo'  — relógio interno do próprio jogo (Timing), erro típico ~150ms;
 *  - 'tela'  — texto "Hora do servidor" (resolução de 1s), último recurso.
 * A incerteza de uma medição HTTP cresce com a idade (deriva do relógio local).
 */

export type ClockSourceKind = 'http' | 'jogo' | 'tela';

export interface ClockCandidate {
  readonly kind: ClockSourceKind;
  /** Offset (quadro do jogo − relógio local), ms. */
  readonly offsetMs: number;
  /** Incerteza medida no instante da medição (±ms). */
  readonly uncertaintyMs: number;
  /** Quando foi medido (relógio local, ms). */
  readonly measuredAtMs: number;
}

export interface ClockChoice extends ClockCandidate {
  /** Incerteza ATUAL (com a deriva desde a medição). */
  readonly effectiveUncertaintyMs: number;
}

/** Deriva assumida do relógio local: 3ms por minuto (~50ppm, pior caso comum). */
export const LOCAL_DRIFT_MS_PER_MIN = 3;

/** Medição HTTP com mais de 30min é descartada (recalibrar). */
export const HTTP_MAX_AGE_MS = 30 * 60_000;

/** Incerteza efetiva agora. */
export function effectiveUncertainty(candidate: ClockCandidate, nowLocalMs: number): number {
  const ageMin = Math.max(0, nowLocalMs - candidate.measuredAtMs) / 60_000;
  const drift = candidate.kind === 'http' ? ageMin * LOCAL_DRIFT_MS_PER_MIN : 0;
  return Math.round(candidate.uncertaintyMs + drift);
}

/** A fonte de menor incerteza efetiva (http velho demais fica de fora); null = nenhuma. */
export function pickClockSource(candidates: readonly (ClockCandidate | null)[], nowLocalMs: number): ClockChoice | null {
  let best: ClockChoice | null = null;
  for (const candidate of candidates) {
    if (candidate === null || !Number.isFinite(candidate.offsetMs)) continue;
    if (candidate.kind === 'http' && nowLocalMs - candidate.measuredAtMs > HTTP_MAX_AGE_MS) continue;
    const effectiveUncertaintyMs = effectiveUncertainty(candidate, nowLocalMs);
    if (best === null || effectiveUncertaintyMs < best.effectiveUncertaintyMs) {
      best = { ...candidate, effectiveUncertaintyMs };
    }
  }
  return best;
}

/** Rótulo curto para a UI. */
export function clockSourceLabel(kind: ClockSourceKind): string {
  return kind === 'http' ? 'servidor (medido)' : kind === 'jogo' ? 'relógio do jogo' : 'hora da tela';
}
