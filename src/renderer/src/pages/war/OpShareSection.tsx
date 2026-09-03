import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { Download, Upload } from 'lucide-react';
import type { OpArchiveEntry } from '@shared/ipc-types';
import Callout from '../../components/Callout';
import { useToast } from '../../hooks/useToast';

export interface OpShareSectionProps {
  /** OPs listadas (para o select de exportação). */
  ops: OpArchiveEntry[];
  /** Recarregar a lista após import. */
  onImported: () => void;
}

/** Rótulo do select: título + data — desambigua OPs homônimas do arquivo. */
function opLabel(op: OpArchiveEntry): string {
  const data = new Date(op.createdAt);
  const quando = Number.isNaN(data.getTime()) ? op.createdAt : data.toLocaleDateString('pt-BR');
  return `${op.title} · ${quando}`;
}

/**
 * Export/Import de OP em .json (Sala de Guerra). A exportação pede o arquivo
 * pelo main (diálogo nativo) e o import revalida tudo via parseOpExport no
 * processo principal — aqui só refletimos ok/erro no toast, nunca inventamos
 * detalhe. `detail` do IPC é sempre PT-BR pronto para exibição.
 */
export default function OpShareSection({ ops, onImported }: OpShareSectionProps): JSX.Element {
  const { push } = useToast();
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);

  // Seleção cai para a primeira OP quando o id guardado sai da lista
  // (lista recarregada após import/remover) — o select nunca fica órfão.
  const selected = useMemo(
    () => ops.find((op) => op.id === selectedId) ?? ops[0] ?? null,
    [ops, selectedId],
  );

  async function handleExport(): Promise<void> {
    if (selected === null) return;
    setBusy('export');
    try {
      const result = await window.staffhub.opShare.exportOp(selected.id);
      if (result.ok) {
        push(
          'ok',
          result.path !== undefined
            ? `OP "${selected.title}" exportada para ${result.path}.`
            : result.detail,
        );
      } else {
        push('error', result.detail);
      }
    } catch (err) {
      push('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleImport(): Promise<void> {
    setBusy('import');
    try {
      const result = await window.staffhub.opShare.importOp();
      if (result.ok) {
        push('ok', result.detail);
        onImported();
      } else {
        push('error', result.detail);
      }
    } catch (err) {
      push('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card opshare-card" aria-labelledby="opshare-title">
      <div className="card-body opshare-body">
        <h2 className="card-title" id="opshare-title">Compartilhar OP</h2>
        <p className="muted opshare-hint">
          Exporte a OP num arquivo .json portável para compartilhar com a staff, ou importe um
          arquivo gerado por outro líder — a importação revalida cada campo antes de arquivar.
        </p>
        <div className="row opshare-row">
          {ops.length === 0 ? (
            <Callout variant="info" title="Nenhuma OP arquivada para exportar">
              <p>Arquive uma OP pela Sala de Guerra ou importe um arquivo .json ao lado.</p>
            </Callout>
          ) : (
            <select
              className="select opshare-select"
              aria-label="OP arquivada para exportar"
              value={selected?.id ?? ''}
              onChange={(event) => setSelectedId(event.target.value)}
              disabled={busy !== null}
            >
              {ops.map((op) => (
                <option key={op.id} value={op.id}>
                  {opLabel(op)}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            disabled={selected === null || busy !== null}
            onClick={() => void handleExport()}
          >
            {busy === 'export' ? (
              <>
                <span className="btn-spinner" aria-hidden="true" /> Exportando…
              </>
            ) : (
              <>
                <Download size={14} aria-hidden="true" /> Exportar OP (.json)
              </>
            )}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void handleImport()}
          >
            {busy === 'import' ? (
              <>
                <span className="btn-spinner" aria-hidden="true" /> Importando…
              </>
            ) : (
              <>
                <Upload size={14} aria-hidden="true" /> Importar OP (.json)
              </>
            )}
          </button>
        </div>
      </div>
    </section>
  );
}
