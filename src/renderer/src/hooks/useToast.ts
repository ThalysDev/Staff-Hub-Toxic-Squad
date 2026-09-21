import { useCallback, useSyncExternalStore } from 'react';

export type ToastVariant = 'ok' | 'error' | 'info';

export interface ToastItem {
  id: number;
  variant: ToastVariant;
  message: string;
}

const DEFAULT_DURATION_MS = 5000;
/** Máximo de toasts simultâneos na tela. */
const MAX_VISIBLE = 4;

// BARRAMENTO GLOBAL de toasts: UM único viewport (montado no App) renderiza
// todos — antes, cada página/seção tinha viewport próprio position:fixed no
// MESMO canto: toasts simultâneos se sobrepunham pixel a pixel, e toasts de
// páginas keep-mounted escondidas (display:none) eram invisíveis. Com o
// barramento, qualquer origem (inclusive 2º plano) aparece, sempre empilhada.
let toasts: ToastItem[] = [];
let nextId = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
/** Prazo absoluto de dismiss (epoch ms) — pausar guarda o RESTANTE, não zera os 5s. */
const deadlines = new Map<number, number>();
/** Presente = auto-dismiss pausado (pointer sobre o toast OU foco dentro dele). */
const pausedRemaining = new Map<number, number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ToastItem[] {
  return toasts;
}

function clearTimer(id: number): void {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

function dismissToast(id: number): void {
  if (!toasts.some((toast) => toast.id === id)) return;
  toasts = toasts.filter((toast) => toast.id !== id);
  clearTimer(id);
  deadlines.delete(id);
  pausedRemaining.delete(id);
  emit();
}

/** (Re)agenda o auto-dismiss a partir de AGORA + durationMs. */
function scheduleDismiss(id: number, durationMs: number): void {
  clearTimer(id);
  deadlines.set(id, Date.now() + durationMs);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), durationMs),
  );
}

/** Pausa o auto-dismiss de UM toast (hover/foco) — guarda o tempo restante. */
export function pauseToastDismiss(id: number): void {
  const deadline = deadlines.get(id);
  if (deadline === undefined || pausedRemaining.has(id)) return;
  clearTimer(id);
  pausedRemaining.set(id, Math.max(0, deadline - Date.now()));
}

/** Retoma o auto-dismiss com o tempo RESTANTE (não reinicia os 5s). */
export function resumeToastDismiss(id: number): void {
  const remaining = pausedRemaining.get(id);
  if (remaining === undefined) return;
  pausedRemaining.delete(id);
  scheduleDismiss(id, remaining);
}

function pushToast(variant: ToastVariant, message: string, durationMs: number = DEFAULT_DURATION_MS): void {
  nextId += 1;
  const id = nextId;
  toasts = [...toasts.slice(-(MAX_VISIBLE - 1)), { id, variant, message }];
  scheduleDismiss(id, durationMs);
  emit();
}

/** API compatível com a antiga fila local: { push, dismiss }. */
export function useToast() {
  const push = useCallback(
    (variant: ToastVariant, message: string) => {
      pushToast(variant, message);
    },
    [],
  );
  const dismiss = useCallback((id: number) => {
    dismissToast(id);
  }, []);
  return { push, dismiss };
}

/** Alimenta o ÚNICO ToastViewport (no App). */
export function useToastViewport(): { toasts: ToastItem[]; dismiss: (id: number) => void } {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const dismiss = useCallback((id: number) => {
    dismissToast(id);
  }, []);
  return { toasts: current, dismiss };
}
