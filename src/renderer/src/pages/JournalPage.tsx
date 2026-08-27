import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, FileJson, FilterX, History, RefreshCw, Trash2 } from 'lucide-react';
import type { JournalEntry } from '@shared/ipc-types';
import {
  distinctActions,
  filterJournalEntries,
  journalToCsv,
  journalToJson,
} from '@shared/journal-filter';
import type { JournalFilterState } from '@shared/journal-filter';
import EmptyState from '../components/EmptyState';
import PageHeader from '../components/PageHeader';
import { useToast } from '../hooks/useToast';

const KIND_LABELS: Record<JournalEntry['kind'], string> = {
  read: 'Leitura',
  mutation: 'Mutação',
  session: 'Sessão',
  system: 'Sistema',
};

/** Ordem fixa dos chips de tipo na barra de filtros. */
const KIND_ORDER: readonly JournalEntry['kind'][] = ['read', 'mutation', 'session', 'system'];

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
  'prefs-save': 'Preferências salvas',
  'prefs-reset': 'Preferências restauradas',
  'templates-save': 'Template salvo',
  'templates-remove': 'Template removido',
  'templates-default': 'Template padrão definido',
  'opshare-export': 'OP exportada',
  'opshare-import': 'OP importada',
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

// ---- Limite configurável (persistido em preferences('journal').limite) ----

const JOURNAL_LIMITS = [100, 200, 500, 1000] as const;
type JournalLimit = (typeof JOURNAL_LIMITS)[number];
const JOURNAL_LIMIT_DEFAULT: JournalLimit = 200;

/** Fail-soft: qualquer lixo no disco volta ao default em vez de quebrar a página. */
function parseJournalLimit(raw: unknown): JournalLimit {
  return typeof raw === 'number' && (JOURNAL_LIMITS as readonly number[]).includes(raw)
    ? (raw as JournalLimit)
    : JOURNAL_LIMIT_DEFAULT;
}

// ---- Export via Blob URL (download do renderer, sem fileSave no main) ----

/** "AAAAMMDD-HHmm" local para o nome do arquivo exportado. */
function exportStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
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
  const [limit, setLimit] = useState<JournalLimit>(JOURNAL_LIMIT_DEFAULT);
  const { push } = useToast();

  // ---- Estado interno dos filtros (vivos — aplicam a cada tecla/clique) ----
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<ReadonlySet<JournalEntry['kind']>>(new Set());
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async (effectiveLimit: number) => {
    setBusy(true);
    setError(null);
    try {
      setEntries(await window.staffhub.journal.list(effectiveLimit));
    } catch {
      setError('Não foi possível carregar o journal. Verifique a conexão com o processo principal.');
    } finally {
      setBusy(false);
    }
  }, []);

  // Mount: lê o limite persistido ANTES da primeira carga (default 200).
  useEffect(() => {
    let active = true;
    void (async () => {
      let persisted: JournalLimit = JOURNAL_LIMIT_DEFAULT;
      try {
        const prefs = await window.staffhub.preferences.get('journal');
        persisted = parseJournalLimit(prefs['limite']);
      } catch {
        // fail-soft — sem preferências legíveis segue com o limite padrão
      }
      if (!active) return;
      setLimit(persisted);
      void load(persisted);
    })();
    return () => {
      active = false;
    };
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

  /** Troca o limite: recarrega já com o novo valor e persiste (merge raso). */
  async function handleLimitChange(next: JournalLimit): Promise<void> {
    if (next === limit) return;
    setLimit(next);
    try {
      await window.staffhub.preferences.save('journal', { limite: next });
    } catch {
      push('error', 'Não foi possível salvar o limite — ele volta ao valor anterior ao reiniciar.');
    }
    await load(next);
  }

  function toggleKind(kind: JournalEntry['kind']): void {
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  const filterActive =
    query.trim() !== '' || kinds.size > 0 || action !== '' || from !== '' || to !== '';

  function handleClearFilters(): void {
    setQuery('');
    setKinds(new Set());
    setAction('');
    setFrom('');
    setTo('');
  }

  // ---- Aplicação viva: motor puro de src/shared/journal-filter.ts ----

  /** Ações distintas das entradas CARREGADAS (não das filtradas) — o select
   *  continua oferecendo tudo que existe no período carregado. */
  const actionOptions = useMemo(() => distinctActions(entries ?? []), [entries]);

  const filteredEntries = useMemo(() => {
    if (entries === null) return null;
    const filter: JournalFilterState = {
      query,
      kinds: [...kinds],
      actions: action === '' ? [] : [action],
    };
    if (from !== '') filter.from = from;
    if (to !== '') filter.to = to;
    return filterJournalEntries(entries, filter);
  }, [entries, query, kinds, action, from, to]);

  const groups = filteredEntries === null ? [] : groupByDay(filteredEntries);

  /** Exporta o conjunto FILTRADO (o que a tabela mostra) em CSV/JSON. */
  function handleExport(format: 'csv' | 'json'): void {
    const source = filteredEntries ?? [];
    const name = `journal-${exportStamp(new Date())}.${format}`;
    try {
      const content = format === 'csv' ? journalToCsv(source) : journalToJson(source);
      const url = URL.createObjectURL(
        new Blob([content], {
          type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8',
        }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      push('ok', `Arquivo ${name} gerado para download (${source.length} ${source.length === 1 ? 'entrada' : 'entradas'}).`);
    } catch {
      push('error', `Não foi possível exportar ${format.toUpperCase()} — tente novamente.`);
    }
  }

  const total = entries?.length ?? 0;
  const visible = filteredEntries?.length ?? 0;

  return (
    <section className="page">
      <PageHeader
        kicker="Sistema"
        title="Journal"
        description="Histórico das ações do hub — leituras, mutações e mudanças de sessão."
        actions={
          <>
            <label className="field-inline" data-tip="Máximo de entradas carregadas do journal">
              <span className="muted">Limite</span>
              <select
                className="select"
                value={limit}
                aria-label="Limite de entradas carregadas"
                onChange={(event) => void handleLimitChange(Number(event.target.value) as JournalLimit)}
                disabled={busy}
              >
                {JOURNAL_LIMITS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-tip="Recarregar entradas"
              onClick={() => void load(limit)}
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
              disabled={busy || total === 0}
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
        <>
          <div className="card">
            <div className="row journal-filters-row">
              <input
                type="search"
                className="input"
                placeholder="Buscar por ação ou detalhe…"
                aria-label="Buscar por ação ou detalhe"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                style={{ flex: '1 1 220px', minWidth: 180 }}
              />
              <label className="field-inline">
                <span className="muted">Ação</span>
                <select
                  className="select"
                  value={action}
                  aria-label="Filtrar por ação"
                  title="Ação interna registrada no journal"
                  onChange={(event) => setAction(event.target.value)}
                >
                  <option value="">Todas as ações</option>
                  {actionOptions.map((rawAction) => (
                    <option key={rawAction} value={rawAction} title={journalActionLabel(rawAction)}>
                      {rawAction}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-inline">
                <span className="muted">De</span>
                <input
                  type="date"
                  className="input"
                  aria-label="Data inicial do período"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </label>
              <label className="field-inline">
                <span className="muted">até</span>
                <input
                  type="date"
                  className="input"
                  aria-label="Data final do período"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleClearFilters}
                disabled={!filterActive}
                data-tip="Voltar a ver todas as entradas carregadas"
              >
                <FilterX size={14} aria-hidden="true" />
                Limpar filtros
              </button>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <span className="muted">Tipo</span>
              <div className="fs-chips" style={{ marginTop: 0 }}>
                {KIND_ORDER.map((kind) => {
                  const on = kinds.has(kind);
                  return (
                    <label key={kind} className={`fs-chip${on ? ' fs-chip--on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        aria-label={`Filtrar por tipo ${KIND_LABELS[kind]}`}
                        onChange={() => toggleKind(kind)}
                      />
                      {KIND_LABELS[kind]}
                    </label>
                  );
                })}
                {kinds.size === 0 && <span className="muted">nenhum marcado = todos os tipos</span>}
              </div>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => handleExport('csv')}
                disabled={visible === 0}
                data-tip="Baixa as entradas filtradas em CSV (abre no Excel)"
              >
                <Download size={14} aria-hidden="true" />
                Exportar CSV
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => handleExport('json')}
                disabled={visible === 0}
                data-tip="Baixa as entradas filtradas em JSON"
              >
                <FileJson size={14} aria-hidden="true" />
                Exportar JSON
              </button>
            </div>
          </div>

          <div className="card card--flush" style={{ marginTop: 12 }}>
            <div className="card-header">
              <h3 className="card-title">Entradas</h3>
              <span className="muted">
                {visible} de {total} {total === 1 ? 'entrada' : 'entradas'}
              </span>
            </div>
            <div className="table-wrap">
              <table className="table journal-table">
                <thead>
                  <tr>
                    <th>Hora</th>
                    <th>Tipo</th>
                    <th>Ação</th>
                    <th>Detalhe</th>
                    <th>Teste?</th>
                  </tr>
                </thead>
                {groups.length === 0 ? (
                  <tbody>
                    <tr>
                      <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: '26px 14px' }}>
                        Nenhuma entrada corresponde aos filtros.
                      </td>
                    </tr>
                  </tbody>
                ) : (
                  groups.map((group) => (
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
                  ))
                )}
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
