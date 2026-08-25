import { useCallback, useEffect, useState } from 'react';
import type { JournalEntry } from '@shared/ipc-types';

const KIND_LABELS: Record<JournalEntry['kind'], string> = {
  read: 'Leitura',
  mutation: 'Mutação',
  session: 'Sessão',
  system: 'Sistema',
};

const KIND_PILLS: Record<JournalEntry['kind'], string> = {
  read: 'pill--info',
  mutation: 'pill--gold',
  session: 'pill--ok',
  system: 'pill--muted',
};

function formatTs(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleString('pt-BR');
}

export default function JournalPage() {
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setEntries(await window.staffhub.journal.list(200));
    } catch {
      setError('Não foi possível carregar o journal.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleClear(): Promise<void> {
    if (!window.confirm('Limpar todas as entradas do journal? Essa ação não pode ser desfeita.')) return;
    setBusy(true);
    setError(null);
    try {
      await window.staffhub.journal.clear();
      setEntries([]);
    } catch {
      setError('Não foi possível limpar o journal.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="page-header">
        <h1>Journal</h1>
        <button type="button" className="btn" onClick={() => void load()} disabled={busy}>
          Atualizar
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void handleClear()}
          disabled={busy || (entries?.length ?? 0) === 0}
        >
          Limpar
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {entries === null ? (
        <p className="muted">Carregando…</p>
      ) : entries.length === 0 ? (
        <div className="card empty">
          <p>Nenhuma entrada registrada ainda. As ações da ferramenta aparecerão aqui.</p>
        </div>
      ) : (
        <div className="card card--flush table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Hora</th>
                <th>Tipo</th>
                <th>Ação</th>
                <th>Detalhe</th>
                <th>DRY-RUN</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="cell-nowrap">{formatTs(entry.ts)}</td>
                  <td>
                    <span className={`pill ${KIND_PILLS[entry.kind]}`}>{KIND_LABELS[entry.kind]}</span>
                  </td>
                  <td>{entry.action}</td>
                  <td className="cell-detail">{entry.detail}</td>
                  <td className="cell-nowrap">{entry.dryRun ? 'Sim' : 'Não'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}