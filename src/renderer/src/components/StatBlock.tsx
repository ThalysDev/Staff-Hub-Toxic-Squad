import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export type StatTone = 'default' | 'gold' | 'ok' | 'danger' | 'info';

interface StatBlockProps {
  /** Legenda curta em caps, ex.: "Sessão do jogo". */
  label: string;
  /** Valor-destaque em Cinzel (número ou texto curto). */
  value: ReactNode;
  icon?: LucideIcon;
  /** Linha auxiliar abaixo do valor (ex.: "verificado às 21:34"). */
  delta?: ReactNode;
  tone?: StatTone;
}

export default function StatBlock({ label, value, icon: Icon, delta, tone = 'default' }: StatBlockProps) {
  return (
    <div className={`stat-block stat-block--${tone}`}>
      <span className="stat-block-label">
        {Icon && <Icon size={13} className="stat-block-icon" aria-hidden="true" />}
        {label}
      </span>
      <span className="stat-block-value" title={typeof value === 'string' ? value : undefined}>
        {value}
      </span>
      {delta && <span className="stat-block-delta">{delta}</span>}
    </div>
  );
}
