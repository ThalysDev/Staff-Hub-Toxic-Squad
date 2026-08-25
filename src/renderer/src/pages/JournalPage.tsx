import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, History, RefreshCw, Trash2 } from 'lucide-react';
import type { JournalEntry } from '@shared/ipc-types';
import EmptyState from '../components/EmptyState';
import PageHeader from '../components/PageHeader';
import ToastViewport from '../components/Toast';
import { useToast } from '../hooks/useToast';

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

function JournalSkeleton() {
  return (
    <div className="card card--flush" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="skeleton-table skeleton-row" key={index}>
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" />
        </div>
      ))}
    </div>
  );
}

export default function JournalPage() {
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toasts, push, dismiss } = useToast();

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setEntries(await window.staffhub.journal.list(200));
    } catch {
      setError('Não foi possível carregar o journal. Verifique a conexão com o processo principal.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleClear(): Promise<void> {
    if (!window.confirm('Limpar todas as entradas do journal? Essa ação não pode ser desfeita.')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await window.staffhub.journal.clear();
      setEntries([]);
      push('ok', 'Journal limpo.');
    } catch {
      push('error', 'Não foi possível limpar o journal.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page">
      <PageHeader
        kicker="Sistema"
        title="Journal"
        description="Histórico das ações do hub — leituras, mutações e mudanças de sessão."
        actions={
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-tip="Recarregar entradas"
              onClick={() => void load()}
              disabled={busy}
            >
              <RefreshCw size={14} aria-hidden="true" />
              Atualizar
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => void handleClear()}
              disabled={busy || (entries?.length ?? 0) === 0}
            >
              <Trash2 size={14} aria-hidden="true" />
              Limpar
            </button>
          </>
        }
      />

      {error && (
        <p className="inline-error">
          <AlertTriangle size={16} aria-hidden="true" />
          {error}
        </p>
      )}

      {entries === null && !error && <JournalSkeleton />}

      {entries !== null && entries.length === 0 && (
        <div className="card">
          <EmptyState
            icon={History}
            title="Nada por aqui ainda"
            hint="Ações aparecem aqui conforme você usa o hub — leituras de telas, mutações simuladas e entradas de sessão."
          />
        </div>
      )}

      {entries !== null && entries.length > 0 && (
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
                  <td className="cell-nowrap tabular">{formatTs(entry.ts)}</td>
                  <td>
                    <span className={`pill ${KIND_PILLS[entry.kind]}`}>{KIND_LABELS[entry.kind]}</span>
                  </td>
                  <td>{entry.action}</td>
                  <td className="cell-detail">{entry.detail}</td>
                  <td className="cell-nowrap">
                    {entry.dryRun ? <span className="text-warn">Sim</span> : <span className="muted">Não</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </section>
  );
}
