import { useRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { pauseToastDismiss, resumeToastDismiss } from '../hooks/useToast';
import type { ToastItem, ToastVariant } from '../hooks/useToast';

const TOAST_ICONS: Record<ToastVariant, LucideIcon> = {
  ok: CheckCircle2,
  error: XCircle,
  info: Info,
};

interface ToastViewportProps {
  toasts: readonly ToastItem[];
  onDismiss: (id: number) => void;
}

/**
 * Viewport fixo no canto superior direito. Sempre montado para que o
 * aria-live anuncie quando o primeiro toast entra.
 *
 * WCAG: enquanto o pointer está sobre um toast (ou o foco está dentro dele),
 * o auto-dismiss fica PAUSADO (useToast.pauseToastDismiss) — ao sair, retoma
 * com o tempo RESTANTE. Ao fechar um toast com foco dentro dele, o foco vai
 * para o PRÓXIMO toast visível (ou para o próprio viewport), nunca para o body.
 */
export default function ToastViewport({ toasts, onDismiss }: ToastViewportProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);

  /** Fecha mantendo o foco visível: próximo toast → viewport (tabIndex=-1). */
  function handleDismiss(id: number): void {
    const index = toasts.findIndex((toast) => toast.id === id);
    if (index === -1) {
      onDismiss(id);
      return;
    }
    const active = document.activeElement;
    const hadFocusInside =
      active instanceof HTMLElement &&
      active.closest('[data-toast-id]')?.getAttribute('data-toast-id') === String(id);
    onDismiss(id);
    if (!hadFocusInside) return;
    const next = toasts[index + 1] ?? toasts[index - 1];
    window.setTimeout(() => {
      const target =
        next !== undefined ? document.querySelector<HTMLElement>(`[data-toast-id="${next.id}"]`) : null;
      if (target !== null) target.focus();
      else viewportRef.current?.focus();
    }, 0);
  }

  return (
    <div ref={viewportRef} className="toast-viewport" aria-live="polite" tabIndex={-1}>
      {toasts.map((toast) => {
        const Icon = TOAST_ICONS[toast.variant];
        return (
          <div
            key={toast.id}
            role={toast.variant === 'error' ? 'alert' : 'status'}
            className={`toast toast--${toast.variant}`}
            data-toast-id={toast.id}
            tabIndex={-1}
            onMouseEnter={() => pauseToastDismiss(toast.id)}
            onMouseLeave={() => resumeToastDismiss(toast.id)}
            onFocus={() => pauseToastDismiss(toast.id)}
            onBlur={() => resumeToastDismiss(toast.id)}
          >
            <Icon size={16} className="toast-icon" aria-hidden="true" />
            <p className="toast-message">{toast.message}</p>
            <button
              type="button"
              className="toast-close"
              onClick={() => handleDismiss(toast.id)}
              aria-label="Fechar aviso"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
