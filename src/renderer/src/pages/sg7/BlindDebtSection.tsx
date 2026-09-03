import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Plus, Scale, Trash2 } from 'lucide-react';
import { blindBalance, type BlindDebtEntry } from '@shared/blind-debt';
import { useToast } from '../../hooks/useToast';
import Callout from '../../components/Callout';

/**
 * SG_7 — Débito de blind por jogador (roadmap item 14). Acumula, entre as
 * rodadas reconhecidas nos tópicos de blindagem, quanto cada jogador PEDIU e
 * quanto foi ENVIADO — saldo positivo = deve blind, negativo = credor.
 *
 * - Mount: `blindDebt.get()` → tabela Jogador | Pediu | Enviou | Saldo na
 *   ordem do motor (saldo DESC via `mergeBlindDebtRound`; `get()` devolve a
 *   lista persistida nessa ordem). Saldo sempre pelo `blindBalance` do motor.
 * - `pendingRound` (vindo da conferência do tópico) ≠ null: callout de aviso
 *   com o resumo + "Somar esta rodada ao débito" → `blindDebt.apply(round)` →
 *   recarrega a tabela, toast e `onApplied` (o pai limpa o pending).
 * - "Zerar débito": window.confirm → `blindDebt.clear()` → recarrega.
 */

/** Números pt-BR (contagens de blind podem vir decimais do tópico). */
const INT_FMT = new Intl.NumberFormat('pt-BR');

export interface BlindDebtSectionProps {
  /** Rodada reconhecida AGORA (do conference atual) para mesclar — ou null para só exibir. */
  pendingRound: { playerName: string; requested: number; sent: number }[] | null;
  /** Avisa o pai que mesclou (para limpar o pendingRound). */
  onApplied?: () => void;
}

/** Saldo colorido: positivo vermelho (deve), negativo verde (credor), zero neutro. */
function SaldoCell({ entry }: { entry: BlindDebtEntry }): JSX.Element {
  const balance = blindBalance(entry);
  if (balance > 0) {
    return (
      <td className="cell-num bdebt-saldo bdebt-saldo--deve">
        <span style={{ color: 'var(--danger)' }}>{INT_FMT.format(balance)}</span>{' '}
        <span className="muted">deve</span>
      </td>
    );
  }
  if (balance < 0) {
    return (
      <td className="cell-num bdebt-saldo bdebt-saldo--credor">
        <span style={{ color: 'var(--ok-ink)' }}>{INT_FMT.format(balance)}</span>{' '}
        <span className="muted">credor</span>
      </td>
    );
  }
  return (
    <td className="cell-num bdebt-saldo bdebt-saldo--zero">
      <span className="muted">{INT_FMT.format(balance)} · em dia</span>
    </td>
  );
}

/** Seção do débito de blind — leitura + mesclagem de rodadas reconhecidas. */
export default function BlindDebtSection({ pendingRound, onApplied }: BlindDebtSectionProps): JSX.Element {
  const { push } = useToast();
  const [entries, setEntries] = useState<BlindDebtEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'applying' | 'clearing' | null>(null);

  // Mount: UMA leitura do débito acumulado (a ordem já é a do motor — saldo DESC).
  useEffect(() => {
    let cancelled = false;
    const bridge = window.staffhub.blindDebt;
    if (!bridge) {
      // Preload sem o contrato de blindDebt: fail-soft com lista vazia.
      console.warn('[BlindDebtSection] bridge sem "blindDebt"; débito inicia vazio.');
      setLoaded(true);
      return () => {
        cancelled = true;
      };
    }
    bridge
      .get()
      .then((stored) => {
        if (cancelled) return;
        setEntries(stored);
        setLoaded(true);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Mescla a rodada reconhecida e devolve a lista atualizada pelo próprio IPC. */
  async function handleApply(): Promise<void> {
    if (pendingRound === null || pendingRound.length === 0 || busy !== null) return;
    setBusy('applying');
    setError('');
    try {
      const updated = await window.staffhub.blindDebt.apply(pendingRound);
      setEntries(updated);
      push('ok', `Rodada somada ao débito — ${updated.length} jogador(es) na tabela.`);
      onApplied?.();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      push('error', message);
    } finally {
      setBusy(null);
    }
  }

  /** Zera o débito inteiro (confirmação) e recarrega a lista. */
  async function handleClear(): Promise<void> {
    if (busy !== null || entries.length === 0) return;
    if (!window.confirm(`Zerar o débito de blind dos ${entries.length} jogador(es)? Esta ação não pode ser desfeita.`)) return;
    setBusy('clearing');
    setError('');
    try {
      await window.staffhub.blindDebt.clear();
      setEntries(await window.staffhub.blindDebt.get());
      push('ok', 'Débito de blind zerado.');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      push('error', message);
    } finally {
      setBusy(null);
    }
  }

  const totalRequested = pendingRound?.reduce((sum, entry) => sum + entry.requested, 0) ?? 0;
  const totalSent = pendingRound?.reduce((sum, entry) => sum + entry.sent, 0) ?? 0;

  return (
    <div className="card bdebt">
      <div className="card-header">
        <h3 className="card-title">
          <Scale size={15} aria-hidden="true" style={{ marginRight: 6, verticalAlign: -3 }} />
          Débito de blind
        </h3>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-ghost btn-ghost--danger btn-sm bdebt-clear"
          disabled={busy !== null || entries.length === 0}
          onClick={() => void handleClear()}
        >
          <Trash2 size={14} aria-hidden="true" />
          {busy === 'clearing' ? 'Zerando…' : 'Zerar débito'}
        </button>
      </div>
      <div className="card-body">
        {pendingRound !== null && (
          <Callout
            variant="warn"
            title="Rodada reconhecida pronta para somar"
            actions={
              <button
                type="button"
                className="btn btn-sm bdebt-apply"
                disabled={busy !== null || pendingRound.length === 0}
                onClick={() => void handleApply()}
              >
                <Plus size={14} aria-hidden="true" />
                {busy === 'applying' ? 'Somando…' : 'Somar esta rodada ao débito'}
              </button>
            }
          >
            <p>
              {INT_FMT.format(pendingRound.length)} jogador(es) · pedido {INT_FMT.format(totalRequested)} · enviado{' '}
              {INT_FMT.format(totalSent)} de blind.
            </p>
          </Callout>
        )}

        {error !== '' && (
          <Callout variant="danger" title="Não foi possível atualizar o débito de blind">
            <p>{error}</p>
          </Callout>
        )}

        {entries.length === 0 ? (
          loaded && <p className="muted bdebt-empty">Nenhuma rodada somada ainda — conferencie um tópico de blind e some aqui.</p>
        ) : (
          <div className="table-wrap">
            <table className="table bdebt-table">
              <thead>
                <tr>
                  <th scope="col">Jogador</th>
                  <th scope="col" className="cell-num">Pediu</th>
                  <th scope="col" className="cell-num">Enviou</th>
                  <th scope="col" className="cell-num">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.playerName} className="bdebt-row">
                    <td className="cell-nowrap">{entry.playerName}</td>
                    <td className="cell-num">{INT_FMT.format(entry.requested)}</td>
                    <td className="cell-num">{INT_FMT.format(entry.sent)}</td>
                    <SaldoCell entry={entry} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Identidade da linha = aldeia do pedido no tópico (o autor do comentário não chega ao hub) —
          trate o saldo por aldeia, não por pessoa.
        </p>
      </div>
    </div>
  );
}
