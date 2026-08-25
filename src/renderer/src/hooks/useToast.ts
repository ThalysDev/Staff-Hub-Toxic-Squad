import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastVariant = 'ok' | 'error' | 'info';

export interface ToastItem {
  id: number;
  variant: ToastVariant;
  message: string;
}

const DEFAULT_DURATION_MS = 5000;
/** Máximo de toasts simultâneos na tela. */
const MAX_VISIBLE = 4;

/**
 * Fila local de toasts com auto-dismiss. Os timers vivem num Map fora do state
 * e o cleanup no desmonte cancela os pendentes (sem setState pós-unmount).
 */
export function useToast(durationMs: number = DEFAULT_DURATION_MS) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (variant: ToastVariant, message: string) => {
      nextId.current += 1;
      const id = nextId.current;
      setToasts((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), { id, variant, message }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), durationMs),
      );
    },
    [dismiss, durationMs],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return { toasts, push, dismiss };
}
