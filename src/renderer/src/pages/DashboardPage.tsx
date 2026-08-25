import { useEffect, useState } from 'react';
import StatusPill from '../components/StatusPill';
import { useSessionStatus } from '../hooks/useSessionStatus';
import { MODULES } from '../modules';

export default function DashboardPage() {
  const [version, setVersion] = useState<string | null>(null);
  const status = useSessionStatus();

  useEffect(() => {
    let cancelled = false;
    void window.staffhub.app
      .getVersion()
      .then((value) => {
        if (!cancelled) setVersion(value);
      })
      .catch(() => {
        // Versão indisponível; fica com "—".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <header className="page-header">
        <h1>Staff Hub Toxic Squad</h1>
        <StatusPill state={status.state} />
        <span className="muted">{version ? `Versão ${version}` : 'Versão —'}</span>
      </header>
      <div className="module-grid">
        {MODULES.map((module) => (
          <article key={module.id} className="card module-card">
            <h2>{module.title}</h2>
            <p className="muted">{module.description}</p>
            <span className="pill pill--gold">Fase {module.phase} — em breve</span>
          </article>
        ))}
      </div>
    </section>
  );
}