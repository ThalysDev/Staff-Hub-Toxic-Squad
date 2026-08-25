import type { LucideIcon } from 'lucide-react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
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
 * Viewport fixo no canto inferior direito. Sempre montado para que o
 * aria-live announces funcione quando o primeiro toast entra.
 */
export default function ToastViewport({ toasts, onDismiss }: ToastViewportProps) {
  return (
    <div className="toast-viewport" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = TOAST_ICONS[toast.variant];
        return (
          <div
            key={toast.id}
            role={toast.variant === 'error' ? 'alert' : 'status'}
            className={`toast toast--${toast.variant}`}
          >
            <Icon size={16} className="toast-icon" aria-hidden="true" />
            <p className="toast-message">{toast.message}</p>
            <button
              type="button"
              className="toast-close"
              onClick={() => onDismiss(toast.id)}
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
