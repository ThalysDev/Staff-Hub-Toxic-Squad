import type { JSX, ReactNode } from 'react';
import { Info, TriangleAlert, type LucideIcon } from 'lucide-react';

type CalloutVariant = 'info' | 'warn' | 'danger';

const CALLOUT_ICONS: Record<CalloutVariant, LucideIcon> = {
  info: Info,
  warn: TriangleAlert,
  danger: TriangleAlert,
};

/** role por variante: info é mudança polida (status); warn/danger devem
 * interromper a leitura de tela (alert). Fonte única — sucesso visual =
 * info + icon. */
const CALLOUT_ROLE: Record<CalloutVariant, 'status' | 'alert'> = {
  info: 'status',
  warn: 'alert',
  danger: 'alert',
};

export interface CalloutProps {
  variant: CalloutVariant;
  title?: string;
  children: ReactNode;
  /** Ícone próprio (ex.: CheckCircle2 em confirmações, Lock em segurança) —
   * default por variante. */
  icon?: LucideIcon;
  /** Ações no pé do callout (botões) — recebe marginTop pronto. */
  actions?: ReactNode;
}

/**
 * Callout padrão (v0.33; prop icon na v0.35): fonte única de estrutura dos
 * avisos do app (classes .callout/.callout--{info,warn,danger} no app.css).
 * Migração: ~46 sites migrados na v0.35; restam 5 manuais intencionais —
 * 3 painéis de confirmação interativos (embutem inputs), 1 aviso de geração
 * role=status no planner (não-bloqueante) e 1 callout neutro no SG_7.
 */
export default function Callout({ variant, title, children, icon, actions }: CalloutProps): JSX.Element {
  const Icon = icon ?? CALLOUT_ICONS[variant];
  return (
    <div className={`callout callout--${variant}`} role={CALLOUT_ROLE[variant]}>
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
