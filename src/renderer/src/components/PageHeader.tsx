import type { ReactNode } from 'react';

interface PageHeaderProps {
  /** Eyebrow curto em caps, ex.: "Sistema" ou "Módulo SG4 — Fase 4". */
  kicker?: string;
  title: string;
  description?: string;
  /** Ações alinhadas à direita (botões, pills). */
  actions?: ReactNode;
}

export default function PageHeader({ kicker, title, description, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        {kicker && <p className="page-kicker">{kicker}</p>}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-desc">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
