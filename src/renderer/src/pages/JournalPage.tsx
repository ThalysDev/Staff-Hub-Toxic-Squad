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

/** Ações internas → rótulo que o líder entende. O que não está na tabela
 * permanece com o código original (contrato com o journal do main). */
const ACTION_LABELS: Record<string, string> = {
  'settings-boot': 'Configurações carregadas',
  'settings-update': 'Configurações salvas',
  'world-relations': 'Diplomacia lida',
  'world-refresh': 'Dados do mundo atualizados',
  'queue-started': 'Coleta iniciada',
  'queue-finished': 'Coleta concluída',
  'queue-failed': 'Coleta falhou',
  'collect-members': 'Coleta por membro',
  'collect-summary': 'Coleta resumida',
  'sg1-analyze': 'Análise de aldeias',
  'sg5-verify': 'Conferência de comandos',
  'sg5-scan-own': 'Varredura de ataques',
  'sg5-totals': 'Totalização',
  'sg7-conference': 'Conferência do fórum',
  session: 'Login',
  login: 'Login',
  'login-sid': 'Login',
  reserve: 'Reserva',
  'reserve-halt': 'Reserva interrompida',
  'mp-send': 'MP enviada',
  'mp-halt': 'MPs interrompidas',
  'forum-adjust': 'Fórum ajustado',
  'forum-delete-posts': 'Posts apagados',
  'forum-post-plan': 'Plano postado',
  'op-archive-save': 'OP arquivada',
  'op-archive-conference': 'OP conferida',
  'op-archive-remove': 'OP removida',
  'capture-fixture': 'Captura de tela',
};

/** Ações do SG2 compartilham o rótulo; "-erro" = rodou sem confirmação. */
function journalActionLabel(action: string): string {
  const uncertain = action.endsWith('-erro');
  const base = uncertain ? action.slice(0, -'-erro'.length) : action;
  const known: string | undefined = Object.prototype.hasOwnProperty.call(ACTION_LABELS, base)
    ? ACTION_LABELS[base]
    : undefined;
  const label = known ?? (base.startsWith('sg2-') ? 'Análise de tropas' : action);
  return uncertain && label !== action ? `${label} (resultado incerto)` : label;
}

/** Só hh:mm:ss — o dia vive no header de seção. */
function formatTime(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime())
    ? ts
    : date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

interface DayGroup {
  key: string;
  label: string;
  entries: JournalEntry[];
}

const DAY_MS = 86_400_000;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Agrupa por dia (data local) com header "Hoje"/"Ontem"/data por extenso. */
function groupByDay(entries: readonly JournalEntry[]): DayGroup[] {
  const startOfDay = (date: Date): number =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const todayStart = startOfDay(new Date());
  const groups = new Map<string, DayGroup>();
  for (const entry of entries) {
    const date = new Date(entry.ts);
    const valid = !Number.isNaN(date.getTime());
    const dayStart = valid ? startOfDay(date) : 0;
    const key = valid ? String(dayStart) : 'data-indisponivel';
    let group = groups.get(key);
    if (group === undefined) {
      let label = 'Data indisponível';
      if (valid) {
        const daysAgo = Math.round((todayStart - dayStart) / DAY_MS);
        label =
          daysAgo === 0
            ? 'Hoje'
            : daysAgo === 1
              ? 'Ontem'
              : capitalize(
                  date.toLocaleDateString('pt-BR', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  }),
                );
      }
      group = { key, label, entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
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

  const groups = entries === null ? [] : groupByDay(entries);

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
              className="btn btn-ghost btn-ghost--danger btn-sm"
              data-tip="Apagar todas as entradas"
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
                <th>Teste?</th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.key}>
                <tr className="table-group-row">
                  <th colSpan={5} scope="rowgroup">
                    {group.label}
                  </th>
                </tr>
                {group.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="cell-nowrap tabular">{formatTime(entry.ts)}</td>
                    <td>
                      <span className={`pill ${KIND_PILLS[entry.kind]}`}>{KIND_LABELS[entry.kind]}</span>
                    </td>
                    <td>
                      <span title={`Ação interna: ${entry.action}`}>{journalActionLabel(entry.action)}</span>
                    </td>
                    <td className="cell-detail cell-detail--clamp" title={entry.detail}>
                      {entry.detail}
                    </td>
                    <td className="cell-nowrap">
                      {entry.dryRun ? <span className="text-warn">Sim</span> : <span className="muted">Não</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </section>
  );
}
