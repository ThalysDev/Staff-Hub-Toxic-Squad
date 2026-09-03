import type { JSX, ReactNode } from 'react';
import { AlertTriangle, Info, TriangleAlert } from 'lucide-react';

type CalloutVariant = 'info' | 'warn' | 'danger';

const CALLOUT_ICONS: Record<CalloutVariant, typeof Info> = {
  info: Info,
  warn: TriangleAlert,
  danger: TriangleAlert,
};

export interface CalloutProps {
  variant: CalloutVariant;
  title?: string;
  children: ReactNode;
  /** Ações no pé do callout (botões) — recebe marginTop pronto. */
  actions?: ReactNode;
}

/**
 * Callout padrão (v0.33): encapsula o markup manual repetido em ~20 telas
 * (classes CSS .callout/.callout--{info,warn,danger} continuam as mesmas —
 * migração visual zero, só fonte única de estrutura).
 */
export default function Callout({ variant, title, children, actions }: CalloutProps): JSX.Element {
  const Icon = CALLOUT_ICONS[variant];
  return (
    <div className={`callout callout--${variant}`} role={variant === 'info' ? 'status' : 'alert'}>
      <span className="callout-icon">
        <Icon size={16} aria-hidden="true" />
      </span>
      <div className="callout-body">
        {title !== undefined && <p className="callout-title">{title}</p>}
        {children}
        {actions !== undefined && (
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

/** Referência de import para o ícone de alerta (consumidores antigos). */
export const CalloutAlertIcon = AlertTriangle;
