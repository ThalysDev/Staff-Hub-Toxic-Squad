import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ClipboardCopy, ScrollText, ShieldAlert } from 'lucide-react';
import type { ForumConferenceResult } from '@shared/ipc-types';
import { usePreferences } from '../../hooks/usePreferences';
import { useToast } from '../../hooks/useToast';
import PageHeader from '../../components/PageHeader';
import ToastViewport from '../../components/Toast';
import { MODULES } from '../../modules';

/** Padrões dos campos persistidos do módulo sg7 (só a URL do tópico — posts e
 * reconhecidos ficam voláteis). */
const SG7_DEFAULTS = {
  threadUrl: '',
};

export default function Sg7Page() {
  const { toasts, push, dismiss } = useToast();
  const moduleInfo = MODULES.find((module) => module.id === 'sg7');
  const { prefs, savePrefs, resetPrefs } = usePreferences('sg7', SG7_DEFAULTS);
  const [threadUrl, setThreadUrl] = useState(SG7_DEFAULTS.threadUrl);
  const [conference, setConference] = useState<ForumConferenceResult | null>(null);
  const [adjustResult, setAdjustResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [pendingAdjust, setPendingAdjust] = useState(false);
  const [selectedPosts, setSelectedPosts] = useState<number[]>([]);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleteResult, setDeleteResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Preferências do módulo: a URL do tópico sobrevive a F5/reinício.
  const prefsHydrated = useRef(false);

  // Hidratação (uma única vez, após prefs chegar do main): aplica só as chaves
  // presentes, para não pisar em estado que o usuário já editou.
  useEffect(() => {
    if (prefs === null || prefsHydrated.current) return;
    prefsHydrated.current = true;
    if (typeof prefs.threadUrl === 'string') setThreadUrl(prefs.threadUrl);
  }, [prefs]);

  // Persistência com guard: só grava DEPOIS da hidratação — nunca sobrescreve o
  // storage com o default vazio do primeiro render. savePrefs é debounced.
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ threadUrl });
  }, [threadUrl, savePrefs]);

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
    <section className="page">
      <PageHeader
        kicker={moduleInfo !== undefined ? `Módulo ${moduleInfo.id.toUpperCase()} — Fase ${moduleInfo.phase}` : 'Módulo SG7 — Fase 7'}
        title={moduleInfo?.originalLabel ?? 'Atualização de Blindagem no Fórum'}
        description="Conferência dos pedidos de blindagem no tópico, com tabela atualizada e limpeza dos comentários processados."
      />

      <div className="row">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setThreadUrl(SG7_DEFAULTS.threadUrl);
            void resetPrefs();
          }}
        >
          Restaurar padrões do módulo
        </button>
      </div>

      <div className="callout" role="note">
        <ShieldAlert size={18} className="callout-icon" aria-hidden="true" />
        <div className="callout-body">
          <p className="callout-title">Fluxo do tópico</p>
          <p>
            A staff publica a tabela BBCode do SG3 no primeiro post; os membros comentam no formato rígido{' '}
            <strong>pedido/lanceiros/espadachins/arqueiros</strong> (ex.: <code>243/100/0/0</code> — sempre as 3
            unidades, 0 quando não enviar).
          </p>
        </div>
      </div>

      <div className="callout callout--warn" role="note">
        <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
        <div className="callout-body">
          <p className="callout-title">Mutações reais</p>
          <p>
            Ajustar a tabela e apagar comentários alteram o fórum de verdade — confirmação dupla,
            verificação pós-envio e registro no Journal.
          </p>
        </div>
      </div>

      <section className="page-section" aria-labelledby="sg7-conference-title">
        <h2 className="section-title" id="sg7-conference-title">Conferência do Tópico</h2>
        <div className="card">
          <div className="card-body">
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
            <div>
              <button type="button" className="btn" onClick={() => void runConference()} disabled={busy}>
                <ScrollText size={16} aria-hidden="true" />
                {busy ? <><span className="btn-spinner" aria-hidden="true" /> Lendo tópico…</> : 'Conferenciar posts'}
              </button>
            </div>
          </div>
        </div>
      </section>

      {conference !== null && (
        <>
          <section className="page-section" aria-labelledby="sg7-recognized-title">
            <h2 className="section-title" id="sg7-recognized-title">Pedidos Reconhecidos Somados</h2>
            <div className="card card--flush">
              <div className="card-header">
                <h3 className="card-title">Comentários no formato reconhecido</h3>
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
              <div className="card-body">
                <pre className="sg7-code">{conference.recognized === '' ? 'Nenhum comentário no formato reconhecido.' : conference.recognized}</pre>
              </div>
            </div>
          </section>

          <section className="page-section" aria-labelledby="sg7-adjust-title">
            <h2 className="section-title" id="sg7-adjust-title">Tabela Atualizada (prévia)</h2>
            <div className="card">
              <div className="card-body">
                <pre className="sg7-code">{conference.updatedMessage}</pre>
                {!pendingAdjust ? (
                  <div>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busy || !conference.changed}
                      onClick={() => setPendingAdjust(true)}
                    >
                      Ajustar conforme script
                    </button>
                  </div>
                ) : (
                  <div className="sg6-confirm">
                    <p>
                      Confirmar a edição do <strong>primeiro post</strong> do tópico {conference.threadId} com a
                      tabela atualizada? Ação REAL — uma única tentativa; tudo vai para o Journal.
                    </p>
                    <div className="row">
                      <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void runAdjust()}>
                        {busy ? <><span className="btn-spinner" aria-hidden="true" /> Salvando…</> : 'Confirmar ajuste'}
                      </button>
                      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setPendingAdjust(false)}>
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        </>
      )}

      {conference !== null && conference.recognizedPostIds.length > 0 && (
        <section className="page-section" aria-labelledby="sg7-delete-title">
          <h2 className="section-title" id="sg7-delete-title">Apagar mensagens ({conference.recognizedPostIds.length} com comentários)</h2>
          <div className="card">
            <div className="card-body">
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
                <div>
                  <button type="button" className="btn btn-danger" disabled={busy || selectedPosts.length === 0} onClick={() => setPendingDelete(true)}>
                    Apagar mensagens
                  </button>
                </div>
              ) : (
                <div className="sg6-confirm">
                  <p>
                    Confirmar a exclusão de <strong>{selectedPosts.length}</strong> post(s)? Mutação única, tudo no Journal.
                  </p>
                  <div className="row">
                    <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void runDelete()}>
                      {busy ? <><span className="btn-spinner" aria-hidden="true" /> Excluindo…</> : 'Confirmar exclusão'}
                    </button>
                    <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setPendingDelete(false)}>
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
              {deleteResult !== null && <p>{deleteResult.detail}</p>}
            </div>
          </div>
        </section>
      )}

      {adjustResult !== null && (
        <section className="page-section" aria-labelledby="sg7-adjust-result-title">
          <h2 className="section-title" id="sg7-adjust-result-title">Resultado do Ajuste</h2>
          <div className="card">
            <div className="card-body">
              <p>{adjustResult.detail}</p>
            </div>
          </div>
        </section>
      )}

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </section>
  );
}
