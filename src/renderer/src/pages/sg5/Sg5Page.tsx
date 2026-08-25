import { useEffect, useState } from 'react';
import { ClipboardCopy, ListChecks, Printer, ShieldQuestion } from 'lucide-react';
import type { Sg5TotalsResult, Sg5VerifyResult } from '@shared/ipc-types';
import { parseCoordList } from '@shared/coords';
import { useToast } from '../../hooks/useToast';

import ProgressBar from '../../components/ProgressBar';
import ToastViewport from '../../components/Toast';

function parseEntries(text: string): { playerName: string; coords: string[] }[] {
  const entries: { playerName: string; coords: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = /^([^;]{2,40});((?:\d{1,3}\|\d{1,3}\s*)+)$/.exec(trimmed);
    if (match === null) {
      throw new Error(`Linha inválida (use "nick;coord coord"): "${trimmed.slice(0, 60)}"`);
    }
    entries.push({ playerName: match[1] ?? '', coords: (match[2] ?? '').trim().split(/\s+/) });
  }
  return entries;
}

export default function Sg5Page() {
  const { toasts, push, dismiss } = useToast();
  const [entriesText, setEntriesText] = useState('');
  const [docTitle, setDocTitle] = useState(`OP do ${new Date().toLocaleDateString('pt-BR')}`);
  const [coordsText, setCoordsText] = useState('');
  const [verifyResult, setVerifyResult] = useState<Sg5VerifyResult | null>(null);
  const [totalsResult, setTotalsResult] = useState<Sg5TotalsResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'verify' | 'totals' | null>(null);
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);

  useEffect(() => {
    const unsubscribe = window.staffhub.events.onQueueProgress(setProgress);
    return unsubscribe;
  }, []);

  async function runVerify(): Promise<void> {
    setBusy('verify');
    setError('');
    try {
      const entries = parseEntries(entriesText);
      if (entries.length === 0) throw new Error('Cole as linhas "nick;coord coord" (saída da distribuição do SG_4).');
      const result = await window.staffhub.sg5.verify(entries);
      setVerifyResult(result);
      const total = result.villages.reduce((sum, v) => sum + v.commands.length, 0);
      push('ok', `Verificação concluída: ${total} comando(s) em ${result.villages.length} aldeia(s).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    } finally {
      setBusy(null);
    }
  }

  async function runTotals(): Promise<void> {
    setBusy('totals');
    setError('');
    try {
      const coords = parseCoordList(coordsText).map((c) => `${c.x}|${c.y}`);
      if (coords.length === 0) throw new Error('Cole as coordenadas dos alvos (separadas por espaço).');
      const result = await window.staffhub.sg5.totals(coords);
      setTotalsResult(result);
      push('ok', `Totalizador pronto: ${result.totals.length} jogador(es).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <header className="page-header">
        <div>
          <p className="kicker">Conferência de Comandos</p>
          <h1>Verificação & Totalizador</h1>
        </div>
      </header>

      <div className="callout" role="note">
        <ShieldQuestion size={16} aria-hidden="true" />
        <span>
          Os comandos só aparecem se os membros <strong>compartilharem comandos com a liderança</strong> nas
          configurações do jogo. A verificação faz 1 requisição por aldeia (com pacing) — rode perto da OP
          para dados frescos.
        </span>
      </div>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Verificação de Comandos de OP (alvo-a-alvo)</h2>
        </div>
        <label className="field">
          <span className="field-label">Título do documento (impressão)</span>
          <input className="input" style={{ maxWidth: 360 }} value={docTitle} onChange={(event) => setDocTitle(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Entradas (nick;coordenadas — uma linha por jogador)</span>
          <textarea
            className="textarea"
            rows={4}
            placeholder={'mjmetal;547|381 549|478\nericson123;485|307'}
            value={entriesText}
            onChange={(event) => setEntriesText(event.target.value)}
          />
        </label>
        {error !== '' && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button type="button" className="btn" onClick={() => void runVerify()} disabled={busy !== null}>
            <ListChecks size={16} aria-hidden="true" />
            {busy === 'verify' ? <><span className="btn-spinner" aria-hidden="true" /> Verificando…</> : 'Obter Verificação'}
          </button>
          {busy !== null && progress !== null && (
          <ProgressBar done={progress.done} total={progress.total} label={progress.label} />
        )}

        {verifyResult !== null && (
            <button type="button" className="btn btn-ghost" onClick={() => window.print()}>
              <Printer size={16} aria-hidden="true" />
              Imprimir documento
            </button>
          )}
        </div>
      </section>

      {verifyResult !== null && (
        <section className="card sg5-printable">
          <h2 className="sg5-doc-title">{docTitle}</h2>
          {verifyResult.villages.map((village) => (
            <div key={village.coord} className="sg5-village">
              <h3 className="sg5-village-title">{village.coord} — {village.commands.length} comando(s)</h3>
              {village.commands.length === 0 ? (
                <p className="muted">Nenhum comando compartilhado chegando (ou membro não compartilha).</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Comando</th>
                        <th>Tipo</th>
                        <th>Jogador</th>
                        <th>Origem</th>
                        <th>Chegada</th>
                        <th>Chega em</th>
                      </tr>
                    </thead>
                    <tbody>
                      {village.commands.map((command) => (
                        <tr key={command.commandId}>
                          <td>{command.name}{command.hasNoble ? <strong title="Com nobre"> ♛</strong> : null}{command.sizeHint === 'pequeno' && !command.hasNoble ? <span className="muted"> (fake)</span> : null}</td>
                          <td><span className={command.type === 'attack' ? 'error' : 'muted'}>{command.type === 'attack' ? 'Ataque' : 'Suporte'}</span></td>
                          <td className="cell-nowrap">{command.playerName}</td>
                          <td className="cell-nowrap">{command.origin.coord}</td>
                          <td className="cell-nowrap">{command.arrivesAtText}</td>
                          <td className="cell-nowrap">{command.arrivesInText}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Totalizador de Comandos</h2>
        </div>
        <label className="field">
          <span className="field-label">Coordenadas (separadas por espaço)</span>
          <textarea
            className="textarea"
            rows={3}
            placeholder="547|381 549|478 485|307"
            value={coordsText}
            onChange={(event) => setCoordsText(event.target.value)}
          />
        </label>
        <div className="row">
          <button type="button" className="btn" onClick={() => void runTotals()} disabled={busy !== null}>
            {busy === 'totals' ? <><span className="btn-spinner" aria-hidden="true" /> Totalizando…</> : 'Obter Verificação (totalizador)'}
          </button>
          {totalsResult !== null && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                const text = totalsResult.totals.map((t) => `${t.playerName};ataques=${t.attacks};suportes=${t.supports};total=${t.total}`).join('\n');
                void navigator.clipboard.writeText(text).then(() => push('ok', 'Resumo copiado.')).catch(() => push('error', 'Não consegui copiar — selecione e use Ctrl+C.'));
              }}
            >
              <ClipboardCopy size={14} aria-hidden="true" />
              Copiar resumo
            </button>
          )}
        </div>
        {totalsResult !== null && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Jogador</th>
                  <th>Ataques</th>
                  <th>Fakes</th>
                  <th>Com nobre</th>
                  <th>Suportes</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {totalsResult.totals.map((total) => (
                  <tr key={total.playerName}>
                    <td>{total.playerName}</td>
                    <td className="cell-nowrap">{total.attacks}</td>
                    <td className="cell-nowrap">{total.fakes}</td>
                    <td className="cell-nowrap">{total.nobleAttacks}</td>
                    <td className="cell-nowrap">{total.supports}</td>
                    <td className="cell-nowrap"><strong>{total.total}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
