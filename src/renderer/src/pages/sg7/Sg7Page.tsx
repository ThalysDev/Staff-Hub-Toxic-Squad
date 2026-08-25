import { useState } from 'react';
import { ClipboardCopy, ScrollText, ShieldAlert } from 'lucide-react';
import type { ForumConferenceResult } from '@shared/ipc-types';
import { useToast } from '../../hooks/useToast';
import ToastViewport from '../../components/Toast';

export default function Sg7Page() {
  const { toasts, push, dismiss } = useToast();
  const [threadUrl, setThreadUrl] = useState('');
  const [conference, setConference] = useState<ForumConferenceResult | null>(null);
  const [adjustResult, setAdjustResult] = useState<{ dryRun: boolean; ok: boolean | null; detail: string } | null>(null);
  const [pendingAdjust, setPendingAdjust] = useState(false);
  const [selectedPosts, setSelectedPosts] = useState<number[]>([]);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleteResult, setDeleteResult] = useState<{ dryRun: boolean; ok: boolean | null; detail: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function runConference(): Promise<void> {
    setBusy(true);
    setError('');
    setConference(null);
    setAdjustResult(null);
    setPendingAdjust(false);
    setPendingDelete(false);
    try {
      if (!/thread_id=\d+/.test(threadUrl)) throw new Error('Cole a URL completa do tópico (com thread_id).');
      const result = await window.staffhub.sg7.conference(threadUrl.trim());
      setConference(result);
      push('ok', result.changed ? 'Conferência pronta — há ajustes a aplicar.' : 'Conferência pronta — nada a ajustar.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    } finally {
      setBusy(false);
    }
  }

  async function runAdjust(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const result = await window.staffhub.sg7.adjust(threadUrl.trim(), true);
      setAdjustResult(result);
      push(result.ok === false ? 'error' : 'ok', result.detail);
      setPendingAdjust(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    } finally {
      setBusy(false);
    }
  }

  async function runDelete(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const result = await window.staffhub.sg7.deletePosts(threadUrl.trim(), selectedPosts, true);
      setDeleteResult(result);
      push(result.ok === false ? "error" : "ok", result.detail);
      setPendingDelete(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push("error", message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <header className="page-header">
        <div>
          <p className="kicker">Atualização de Blindagem no Fórum</p>
          <h1>Fórum — Pedidos</h1>
        </div>
      </header>

      <div className="callout" role="note">
        <ShieldAlert size={16} aria-hidden="true" />
        <span>
          Fluxo: a staff publica a tabela BBCode do SG_3 no primeiro post; os membros comentam no formato
          rígido <strong>pedido/lanceiros/espadachins/arqueiros</strong> (ex.: <code>243/100/0/0</code> — sempre
          as 3 unidades, 0 quando não enviar). Ajuste e exclusão são <strong>mutações reais</strong> (confirmação
          dupla + journal + verificação pós-envio).
        </span>
      </div>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Conferência do Tópico</h2>
        </div>
        <label className="field">
          <span className="field-label">URL do tópico de blindagem</span>
          <input
            className="input"
            placeholder="https://br142.tribalwars.com.br/game.php?screen=forum&screenmode=view_thread&forum_id=597&thread_id=…"
            value={threadUrl}
            onChange={(event) => setThreadUrl(event.target.value)}
          />
        </label>
        {error !== '' && <p className="error" role="alert">{error}</p>}
        <button type="button" className="btn" onClick={() => void runConference()} disabled={busy}>
          <ScrollText size={16} aria-hidden="true" />
          {busy ? <><span className="btn-spinner" aria-hidden="true" /> Lendo tópico…</> : 'Realizar Conferência Posts'}
        </button>
      </section>

      {conference !== null && (
        <>
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">Pedidos Reconhecidos Somados</h2>
              <span className="spacer" />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  void navigator.clipboard.writeText(conference.recognized).then(() => push('ok', 'Reconhecidos copiados.')).catch(() => push('error', 'Não consegui copiar — selecione e use Ctrl+C.'));
                }}
              >
                <ClipboardCopy size={14} aria-hidden="true" />
                Copiar
              </button>
            </div>
            <pre className="sg7-code">{conference.recognized === '' ? 'Nenhum comentário no formato reconhecido.' : conference.recognized}</pre>
          </section>

          <section className="card">
            <div className="card-header">
              <h2 className="card-title">Tabela Atualizada (prévia)</h2>
            </div>
            <pre className="sg7-code">{conference.updatedMessage}</pre>
            {!pendingAdjust ? (
              <button
                type="button"
                className="btn"
                disabled={busy || !conference.changed}
                onClick={() => setPendingAdjust(true)}
              >
                Ajustar Conforme Script
              </button>
            ) : (
              <div className="sg6-confirm">
                <p>
                  Confirmar a edição do <strong>primeiro post</strong> do tópico {conference.threadId} com a
                  tabela atualizada? Ação REAL — uma única tentativa; tudo vai para o Journal.
                </p>
                <div className="row">
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void runAdjust()}>
                    {busy ? <><span className="btn-spinner" aria-hidden="true" /> Salvando…</> : 'Confirmar Ajuste'}
                  </button>
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setPendingAdjust(false)}>
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </section>
        </>
      )}

      {conference !== null && conference.recognizedPostIds.length > 0 && (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Apagar mensagens ({conference.recognizedPostIds.length} com comentários)</h2>
          </div>
          <p className="muted">Selecione os posts já contabilizados para excluir (moderação). Confirmação dupla + verificação real.</p>
          <div className="col" style={{ gap: 6 }}>
            {conference.recognizedPostIds.map((postId) => (
              <label key={postId} className="checkbox-field">
                <input
                  type="checkbox"
                  checked={selectedPosts.includes(postId)}
                  onChange={(event) => {
                    setSelectedPosts((prev) => (event.target.checked ? [...prev, postId] : prev.filter((id) => id !== postId)));
                  }}
                />
                Post #{postId}
              </label>
            ))}
          </div>
          {!pendingDelete ? (
            <button type="button" className="btn" disabled={busy || selectedPosts.length === 0} onClick={() => setPendingDelete(true)}>
              Apagar mensagens
            </button>
          ) : (
            <div className="sg6-confirm">
              <p>
                Confirmar a exclusão de <strong>{selectedPosts.length}</strong> post(s)? Mutação única, tudo no Journal.
              </p>
              <div className="row">
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void runDelete()}>
                  {busy ? <><span className="btn-spinner" aria-hidden="true" /> Excluindo…</> : 'Confirmar Exclusão'}
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setPendingDelete(false)}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
          {deleteResult !== null && <p>{deleteResult.detail}</p>}
        </section>
      )}

      {adjustResult !== null && (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Resultado do Ajuste</h2>
          </div>
          <p>{adjustResult.detail}</p>
        </section>
      )}

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
