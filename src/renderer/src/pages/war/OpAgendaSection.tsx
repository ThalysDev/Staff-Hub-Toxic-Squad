// Sala de Guerra · Agenda da OP (v0.33): lê o `sendSchedule` ARQUIVADO da OP
// (o dado que até agora era gravado e nunca lido) e apresenta como tabela
// buscável, com copiar TSV e agendamento de alertas T-minus em 1 clique.
import { useMemo, useState } from 'react';
import { AlarmClock, ClipboardCopy, Table2 } from 'lucide-react';
import type { JSX } from 'react';
import { parseSendSchedule } from '@shared/comms-package';
import type { OpArchiveEntry } from '@shared/ipc-types';
import { fold } from '@shared/fold';
import EmptyState from '../../components/EmptyState';
import { useToast } from '../../hooks/useToast';

export interface OpAgendaSectionProps {
  op: OpArchiveEntry;
}

/** Linha da agenda da OP arquivada. */
interface AgendaRow {
  playerName: string;
  targetCoord: string;
  time: string;
}

export default function OpAgendaSection({ op }: OpAgendaSectionProps): JSX.Element {
  const { push } = useToast();
  const [query, setQuery] = useState('');
  const [scheduling, setScheduling] = useState(false);

  /** Parse fail-closed: agenda ausente/corrompida vira estado explícito. */
  const parsed = useMemo<{ rows: AgendaRow[]; error: string }>(() => {
    const schedule = op.sendSchedule?.trim() ?? '';
    if (schedule === '') return { rows: [], error: '' };
    try {
      return { rows: parseSendSchedule(schedule), error: '' };
    } catch (error) {
      return { rows: [], error: error instanceof Error ? error.message : String(error) };
    }
  }, [op.sendSchedule]);

  const visibleRows = useMemo(() => {
    const needle = fold(query);
    if (needle === '') return parsed.rows;
    return parsed.rows.filter((row) => fold(`${row.playerName} ${row.targetCoord}`).includes(needle));
  }, [parsed.rows, query]);

  async function copyTsv(): Promise<void> {
    const tsv = ['Jogador\tAlvo\tEnviar às', ...visibleRows.map((row) => `${row.playerName}\t${row.targetCoord}\t${row.time}`)].join('\n');
    try {
      await navigator.clipboard.writeText(tsv);
      push('ok', 'Agenda copiada como TSV (cola direto no Excel/planilha).');
    } catch {
      push('error', 'Não foi possível copiar — permissão de área de transferência negada.');
    }
  }

  async function scheduleTminus(): Promise<void> {
    if (scheduling) return;
    const schedule = op.sendSchedule?.trim() ?? '';
    if (schedule === '') return;
    setScheduling(true);
    try {
      const result = await window.staffhub.tminus.schedule(schedule);
      push('ok', `T-minus agendado: ${result.alerts} alerta(s) — ${result.detail}`);
    } catch (error) {
      push('error', error instanceof Error ? error.message : String(error));
    } finally {
      setScheduling(false);
    }
  }

  return (
    <section className="card" aria-labelledby="op-agenda-title">
      <div className="card-header">
        <h2 className="card-title" id="op-agenda-title">
          <Table2 size={16} aria-hidden="true" style={{ marginRight: 6, verticalAlign: -3 }} />
          Agenda da OP
        </h2>
        <span className="spacer" />
        {parsed.rows.length > 0 && <span className="pill pill--muted">{parsed.rows.length} envio(s)</span>}
      </div>
      <div className="card-body col" style={{ gap: 10 }}>
        <p className="muted">
          Quem envia o quê e quando — os horários calculados arquivados com a OP. O T-minus usa esta
          agenda como está (alertas 15/5/1 minuto antes de cada envio).
        </p>

        {parsed.error !== '' ? (
          <p className="error" role="alert">Agenda da OP inválida: {parsed.error}</p>
        ) : parsed.rows.length === 0 ? (
          <EmptyState
            compact
            icon={Table2}
            title="Esta OP não tem agenda arquivada"
            hint="OPs criadas antes da v0.28 ou sem o horário calculado não trazem a agenda — gere pela Sala de Guerra para tê-la."
          />
        ) : (
          <>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input
                className="input"
                style={{ maxWidth: 280 }}
                placeholder="Buscar por jogador ou alvo (ignora acento)…"
                aria-label="Buscar na agenda da OP"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyTsv()}>
                <ClipboardCopy size={14} aria-hidden="true" /> Copiar TSV
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={scheduling} onClick={() => void scheduleTminus()}>
                <AlarmClock size={14} aria-hidden="true" />
                {scheduling ? 'Agendando…' : 'Agendar no T-minus'}
              </button>
            </div>
            <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Jogador</th>
                    <th scope="col">Alvo</th>
                    <th scope="col">Enviar às</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row, index) => (
                    <tr key={`${row.playerName}-${row.targetCoord}-${index}`}>
                      <td className="cell-nowrap">{row.playerName}</td>
                      <td className="cell-nowrap">{row.targetCoord}</td>
                      <td className="cell-nowrap"><strong>{row.time}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {visibleRows.length === 0 && <p className="muted">Nenhum envio corresponde à busca.</p>}
          </>
        )}
      </div>
    </section>
  );
}
