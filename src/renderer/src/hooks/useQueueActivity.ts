import { useEffect, useRef, useState } from 'react';

/** Uma operação segue "ativa" por este tempo após o último evento de progresso. */
const ACTIVE_WINDOW_MS = 30_000;

export interface QueueActivity {
  /** Operações em andamento (done < total e com evento nos últimos 30 s). */
  activeCount: number;
  /** A operação ativa de maior total (empate: evento mais recente). */
  latest?: { label: string; done: number; total: number };
}

interface QueueOpState {
  label: string;
  done: number;
  total: number;
  /** Último evento desta operação (epoch ms, relógio local — só UI). */
  lastAt: number;
}

function summarize(ops: Map<string, QueueOpState>, now: number): QueueActivity {
  let activeCount = 0;
  let latest: QueueOpState | null = null;
  for (const state of ops.values()) {
    const expired = now - state.lastAt >= ACTIVE_WINDOW_MS;
    if (state.done >= state.total || expired) continue;
    activeCount += 1;
    if (
      latest === null ||
      state.total > latest.total ||
      (state.total === latest.total && state.lastAt > latest.lastAt)
    ) {
      latest = state;
    }
  }
  if (latest === null) return { activeCount: 0 };
  return { activeCount, latest: { label: latest.label, done: latest.done, total: latest.total } };
}

/** Compara apenas o que a UI exibe — evita re-render por diferença irrelevante. */
function sameActivity(a: QueueActivity, b: QueueActivity): boolean {
  if (a.activeCount !== b.activeCount) return false;
  if (a.latest === undefined || b.latest === undefined) return a.latest === b.latest;
  return (
    a.latest.label === b.latest.label &&
    a.latest.done === b.latest.done &&
    a.latest.total === b.latest.total
  );
}

/**
 * Resumo global da fila de requisições (indicador global), a partir de
 * onQueueProgress. Re-render só quando o resumo muda: em vez de tick de 1s,
 * agenda UMA verificação no instante em que a próxima operação expiraria.
 */
export function useQueueActivity(): QueueActivity {
  const opsRef = useRef<Map<string, QueueOpState>>(new Map());
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activity, setActivity] = useState<QueueActivity>({ activeCount: 0 });

  useEffect(() => {
    let cancelled = false;

    const reevaluate = (): void => {
      if (cancelled) return;
      const now = Date.now();
      setActivity((prev) => {
        const summary = summarize(opsRef.current, now);
        return sameActivity(prev, summary) ? prev : summary;
      });

      // Próximo momento em que alguma ativa completaria 30s sem evento.
      let delayMs: number | null = null;
      for (const state of opsRef.current.values()) {
        if (state.done >= state.total) continue;
        const expiresAt = state.lastAt + ACTIVE_WINDOW_MS;
        if (expiresAt <= now) continue;
        const remaining = expiresAt - now;
        if (delayMs === null || remaining < delayMs) delayMs = remaining;
      }
      if (expiryTimerRef.current !== null) clearTimeout(expiryTimerRef.current);
      // Pequena folga para o relógio já ter passado do marco de expiração.
      expiryTimerRef.current =
        delayMs === null ? null : setTimeout(reevaluate, delayMs + 100);
    };

    const unsubscribe = window.staffhub.events.onQueueProgress((progress) => {
      opsRef.current.set(progress.operationId, {
        label: progress.label,
        done: progress.done,
        total: progress.total,
        lastAt: Date.now(),
      });
      reevaluate();
    });

    return () => {
      cancelled = true;
      if (expiryTimerRef.current !== null) clearTimeout(expiryTimerRef.current);
      unsubscribe();
    };
  }, []);

  return activity;
}
