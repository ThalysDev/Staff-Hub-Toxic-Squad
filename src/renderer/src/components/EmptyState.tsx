import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  hint?: string;
  /** Conteúdo extra (ex.: lista de fluxos) entre o hint e a ação. */
  children?: ReactNode;
  action?: ReactNode;
}

/** Estado vazio padronizado: ícone grande, título em Cinzel, hint e ação. */
export default function EmptyState({ icon: Icon, title, hint, children, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">
        <Icon size={26} aria-hidden="true" />
      </span>
      <h2 className="empty-state-title">{title}</h2>
      {hint && <p className="empty-state-hint">{hint}</p>}
      {children}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
