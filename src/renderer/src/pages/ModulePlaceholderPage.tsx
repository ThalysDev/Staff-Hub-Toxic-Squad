interface ModulePlaceholderPageProps {
  title: string;
  description: string;
  phase: number;
}

/**
 * Estado vazio genérico dos módulos SG ainda não implementados.
 * `description` recebe o rótulo ORIGINAL da ferramenta replicada (docs/MODULOS-SG.md).
 */
export default function ModulePlaceholderPage({ title, description, phase }: ModulePlaceholderPageProps) {
  return (
    <section>
      <h1>{title}</h1>
      <div className="card empty">
        <p>{description}</p>
        <span className="pill pill--gold">Fase {phase} — em breve</span>
      </div>
    </section>
  );
}