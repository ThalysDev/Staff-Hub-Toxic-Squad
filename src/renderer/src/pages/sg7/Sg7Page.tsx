import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, BookmarkPlus, ClipboardCopy, ScrollText, ShieldAlert, X } from 'lucide-react';
import type { ForumConferenceResult } from '@shared/ipc-types';
import { parseBlindTable } from '@shared/sg7-engine';
import { usePreferences } from '../../hooks/usePreferences';
import { useToast } from '../../hooks/useToast';
import PageHeader from '../../components/PageHeader';
import { MODULES } from '../../modules';
import BlindDebtSection from './BlindDebtSection';

/** Padrões dos campos persistidos do módulo sg7 (URL do tópico + tópicos salvos
 * — posts e reconhecidos ficam voláteis). */
const SG7_DEFAULTS = {
  threadUrl: '',
  salvosTopicos: '[]',
};

/** Tópico de blindagem nomeado (roadmap 15) — cap de SAVED_TOPICS_CAP itens. */
interface SavedTopic {
  label: string;
  url: string;
}

const SAVED_TOPICS_CAP = 10;

/** Linha da rodada de débito da conferência ATUAL; `pedido` é interno (liga a
 * linha ao pedido da tabela — não viaja para o BlindDebtSection). */
interface DebtRoundRow {
  pedido: number;
  playerName: string;
  requested: number;
  sent: number;
}

/** Lê `salvosTopicos` das prefs: JSON "[{label,url}]" com cap 10 — string
 * corrompida/lixo vira lista vazia (fail-soft, nunca derruba a página). */
function parseSavedTopics(raw: string): SavedTopic[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const topics: SavedTopic[] = [];
    for (const item of parsed) {
      if (topics.length >= SAVED_TOPICS_CAP) break;
      if (typeof item !== 'object' || item === null) continue;
      const { label, url } = item as Record<string, unknown>;
      if (typeof label !== 'string' || typeof url !== 'string') continue;
      if (label.trim() === '' || url.trim() === '') continue;
      const clean = { label: label.trim().slice(0, 40), url: url.trim() };
      if (topics.some((topic) => topic.url === clean.url)) continue; // URL repetida no disco
      topics.push(clean);
    }
    return topics;
  } catch {
    return [];
  }
}

/** Total de faltas publicadas numa linha da tabela (o que aquele pedido pedia). */
function missingTotal(missing: { spear?: number; sword?: number; archer?: number }): number {
  return (missing.spear ?? 0) + (missing.sword ?? 0) + (missing.archer ?? 0);
}

/**
 * Rodada de débito do conference: uma linha por pedido RECONHECIDO que exista
 * na tabela do primeiro post. LIMITAÇÃO (fluxo real): o IPC devolve só
 * "pedido/valores" somados por pedido — o AUTOR de cada comentário não chega
 * ao renderer — então a identidade da linha é a ALDEIA do pedido, com
 * requested = faltas publicadas na linha e sent = 0 até o ajuste aplicar.
 */
function buildDebtRound(result: ForumConferenceResult): DebtRoundRow[] {
  const tableRows = new Map(parseBlindTable(result.firstPostMessage).map((row) => [row.pedido, row]));
  const round: DebtRoundRow[] = [];
  for (const line of result.recognized.split('\n')) {
    const pedido = Number(/^(\d{1,4})\//.exec(line.trim())?.[1]);
    if (!Number.isFinite(pedido) || pedido <= 0) continue;
    const row = tableRows.get(pedido);
    if (row === undefined) continue; // reconhecido sem linha na tabela: o ajuste nunca toca
    round.push({
      pedido,
      playerName: row.villageLabel.trim().slice(0, 40) || `Pedido ${pedido}`,
      requested: missingTotal(row.missing),
      sent: 0,
    });
  }
  return round;
}

/**
 * Enviado por pedido = o que o "Ajustar conforme script" aplicou na tabela:
 * diff (primeiro post → tabela atualizada) do conference revisado na tela — o
 * adjust re-conferencia internamente, então em tópicos estáveis é exato.
 */
function appliedByPedido(result: ForumConferenceResult): Map<number, number> {
  const before = new Map(parseBlindTable(result.firstPostMessage).map((row) => [row.pedido, missingTotal(row.missing)]));
  const applied = new Map<number, number>();
  for (const row of parseBlindTable(result.updatedMessage)) {
    const sent = (before.get(row.pedido) ?? 0) - missingTotal(row.missing);
    if (sent > 0) applied.set(row.pedido, sent);
  }
  return applied;
}

export default function Sg7Page() {
  const { push } = useToast();
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
  // Tópicos salvos (roadmap 15): URLs nomeadas nas prefs; rótulo digitado para salvar o atual.
  const [savedTopics, setSavedTopics] = useState<SavedTopic[]>([]);
  const [topicLabel, setTopicLabel] = useState('');
  // Rodada de débito da conferência atual (null = nada pendente para somar).
  const [debtRound, setDebtRound] = useState<DebtRoundRow[] | null>(null);

  // Preferências do módulo: a URL do tópico sobrevive a F5/reinício.
  const prefsHydrated = useRef(false);

  // Hidratação (uma única vez, após prefs chegar do main): aplica só as chaves
  // presentes, para não pisar em estado que o usuário já editou.
  useEffect(() => {
    if (prefs === null || prefsHydrated.current) return;
    prefsHydrated.current = true;
    if (typeof prefs.threadUrl === 'string') setThreadUrl(prefs.threadUrl);
    if (typeof prefs.salvosTopicos === 'string') setSavedTopics(parseSavedTopics(prefs.salvosTopicos));
  }, [prefs]);

  // Persistência com guard: só grava DEPOIS da hidratação — nunca sobrescreve o
  // storage com o default vazio do primeiro render. savePrefs é debounced.
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ threadUrl });
  }, [threadUrl, savePrefs]);

  // Tópicos salvos: UMA chave JSON nas prefs do módulo (merge raso por chave).
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ salvosTopicos: JSON.stringify(savedTopics) });
  }, [savedTopics, savePrefs]);

  async function runConference(): Promise<void> {
    setBusy(true);
    setError('');
    setConference(null);
    setAdjustResult(null);
    setPendingAdjust(false);
    setPendingDelete(false);
    setDebtRound(null);
    try {
      if (!/thread_id=\d+/.test(threadUrl)) throw new Error('Cole a URL completa do tópico (com thread_id).');
      const result = await window.staffhub.sg7.conference(threadUrl.trim());
      setConference(result);
      // Rodada de débito pendente: pedidos reconhecidos COM linha na tabela
      // (requested = faltas publicadas; sent = 0 até o ajuste aplicar).
      const round = buildDebtRound(result);
      setDebtRound(round.length > 0 ? round : null);
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
      // Ajuste verificado: preenche o sent da rodada com o que a tabela aplicou
      // por pedido (diff do conference revisado na tela). Falha = sent fica 0.
      if (result.ok && conference !== null) {
        const applied = appliedByPedido(conference);
        setDebtRound((prev) =>
          prev === null ? prev : prev.map((row) => ({ ...row, sent: applied.get(row.pedido) ?? 0 })),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    } finally {
      setBusy(false);
    }
  }

  /** Salva o tópico atual com rótulo (mesma URL atualiza o rótulo; cap 10 derruba o mais antigo). */
  function handleSaveTopic(): void {
    const url = threadUrl.trim();
    if (!/thread_id=\d+/.test(url)) {
      push('error', 'Cole a URL completa do tópico (com thread_id) antes de salvar.');
      return;
    }
    const fallback = `Tópico ${/thread_id=(\d+)/.exec(url)?.[1] ?? ''}`.trim();
    const label = topicLabel.trim() !== '' ? topicLabel.trim().slice(0, 40) : fallback;
    setSavedTopics((prev) => {
      const next = [...prev.filter((topic) => topic.url !== url), { label, url }];
      return next.length > SAVED_TOPICS_CAP ? next.slice(next.length - SAVED_TOPICS_CAP) : next;
    });
    setTopicLabel('');
    push('ok', `Tópico salvo: ${label}.`);
  }

  /** Remove um tópico salvo (o X do chip). */
  function handleRemoveTopic(url: string): void {
    setSavedTopics((prev) => prev.filter((topic) => topic.url !== url));
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
            setSavedTopics([]);
            setTopicLabel('');
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
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select
                className="select"
                style={{ maxWidth: 220 }}
                value=""
                aria-label="Tópicos de blindagem salvos"
                disabled={savedTopics.length === 0}
                onChange={(event) => {
                  const url = event.target.value;
                  if (url !== '') setThreadUrl(url);
                }}
              >
                <option value="">Tópicos salvos…</option>
                {savedTopics.map((topic) => (
                  <option key={topic.url} value={topic.url}>
                    {topic.label}
                  </option>
                ))}
              </select>
              <input
                className="input"
                style={{ maxWidth: 180 }}
                placeholder="Rótulo do tópico"
                value={topicLabel}
                maxLength={40}
                aria-label="Rótulo do tópico a salvar"
                onChange={(event) => setTopicLabel(event.target.value)}
              />
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={handleSaveTopic}>
                <BookmarkPlus size={14} aria-hidden="true" />
                Salvar tópico atual
              </button>
            </div>
            {savedTopics.length > 0 && (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {savedTopics.map((topic) => (
                  <span key={topic.url} className="muted" style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
                    {topic.label}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label={`Remover tópico salvo ${topic.label}`}
                      onClick={() => handleRemoveTopic(topic.url)}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
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

      <section className="page-section" aria-labelledby="sg7-debt-title">
        <h2 className="section-title" id="sg7-debt-title">Débito de Blind</h2>
        <BlindDebtSection pendingRound={debtRound} onApplied={() => setDebtRound(null)} />
      </section>

    </section>
  );
}
