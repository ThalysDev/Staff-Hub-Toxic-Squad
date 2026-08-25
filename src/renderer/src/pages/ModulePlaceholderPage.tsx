import EmptyState from '../components/EmptyState';
import PageHeader from '../components/PageHeader';
import type { ModuleInfo } from '../modules';

interface ModulePlaceholderPageProps {
  module: ModuleInfo;
}

/**
 * Estado vazio dos módulos SG ainda não implementados: ícone do módulo,
 * rótulo ORIGINAL da ferramenta em Cinzel e os fluxos planejados.
 */
export default function ModulePlaceholderPage({ module }: ModulePlaceholderPageProps) {
  return (
    <section className="page">
      <PageHeader
        kicker={`Módulo ${module.id.toUpperCase()} — Fase ${module.phase}`}
        title={module.title}
        description={module.description}
      />
      <div className="card">
        <EmptyState
          icon={module.icon}
          title={module.originalLabel}
          hint={`Em construção — entra na Fase ${module.phase} do plano de entregas. O que está planejado:`}
        >
          <ul className="empty-state-list">
            {module.flows.map((flow) => (
              <li key={flow}>{flow}</li>
            ))}
          </ul>
        </EmptyState>
      </div>
    </section>
  );
}
