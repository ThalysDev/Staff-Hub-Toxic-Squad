import { useEffect, useMemo, useState } from 'react';
import { Camera, CheckCircle2, LogIn, XCircle } from 'lucide-react';
import type { FixtureCaptureResult } from '@shared/ipc-types';
import EmptyState from '../components/EmptyState';
import PageHeader from '../components/PageHeader';
import ProgressBar from '../components/ProgressBar';
import ToastViewport from '../components/Toast';
import { useToast } from '../hooks/useToast';
import { useSessionStatus } from '../hooks/useSessionStatus';

/**
 * Alvos de captura para fixtures do do mundo (Fase 0.5). O sufixo `{world}` é
 * substituído pelo mundo da sessão ativa. IDs de tribo/jogador/tópico ficam
 * com placeholder para preencher no dia da captura — cada tela nova de módulo
 * entra aqui antes de ganhar parser.
 */
const CAPTURE_TARGETS: readonly { name: string; label: string; path: string }[] = [
  { name: 'ally-members', label: 'Tribo — Membros', path: '/game.php?screen=ally&mode=members' },
  { name: 'ally-members-troops', label: 'Tribo — Membros › Tropas', path: '/game.php?screen=ally&mode=members_troops' },
  { name: 'ally-members-defense', label: 'Tribo — Membros › Defesa', path: '/game.php?screen=ally&mode=members_defense' },
  { name: 'ally-contracts', label: 'Tribo — Diplomacia', path: '/game.php?screen=ally&mode=contracts' },
  { name: 'ally-reservations', label: 'Tribo — Planejador (reservas)', path: '/game.php?screen=ally&mode=reservations' },
  { name: 'ally-wars', label: 'Tribo — Guerras', path: '/game.php?screen=wars' },
  { name: 'forum-index', label: 'Fórum — índice', path: '/game.php?screen=forum' },
  { name: 'forum-thread-blindagem', label: 'Fórum — tópico de blindagem (preencher thread_id)', path: '/game.php?screen=forum&screenmode=view_thread&thread_id=0&page=last' },
  { name: 'forum-thread-edit', label: 'Fórum — edição de post (preencher answer_id)', path: '/game.php?screen=forum&screenmode=view_thread&thread_id=0&answer_id=0' },
  { name: 'mail-inbox', label: 'Mensagens — caixa', path: '/game.php?screen=mail' },
  { name: 'mail-new', label: 'Mensagens — nova MP', path: '/game.php?screen=mail&mode=new' },
  { name: 'info-ally-enemy', label: 'Tribo inimiga — perfil (preencher id)', path: '/game.php?screen=info_ally&id=0' },
  { name: 'info-player-enemy', label: 'Jogador inimigo — perfil (preencher id)', path: '/game.php?screen=info_player&id=0' },
  { name: 'village-commands', label: 'Aldeia com comandos compartilhados (preencher id)', path: '/game.php?screen=info_village&id=0' },
  { name: 'overview', label: 'Visão geral (probe de sessão)', path: '/game.php?screen=overview' },
  { name: 'world-config-xml', label: 'Config do mundo (XML)', path: '/interface.php?func=get_config' },
];

/** Chave dentro de preferences('captures') com a seleção serializada (JSON string). */
const PREF_KEY = 'selected';

/** Seleção padrão: TODOS os alvos marcados. */
function defaultSelection(): Record<string, boolean> {
  return Object.fromEntries(CAPTURE_TARGETS.map((target) => [target.name, true] as const));
}

function formatBytes(bytes: number): string {
  const kb = bytes / 1024;
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} kB`;
}

export default function CapturesPage() {
  const session = useSessionStatus();
  const [selected, setSelected] = useState<Record<string, boolean>>(defaultSelection);
  const [results, setResults] = useState<FixtureCaptureResult[]>([]);
  const [running, setRunning] = useState(false);
  const { toasts, push, dismiss } = useToast();

  const world = session.world;
  const loggedIn = session.state === 'logged-in';

  const selectedTargets = useMemo(
    () => CAPTURE_TARGETS.filter((target) => selected[target.name] === true),
    [selected],
  );
  const selectedCount = selectedTargets.length;
  const allSelected = selectedCount === CAPTURE_TARGETS.length;
  const disabled = !world || !loggedIn || running || selectedCount === 0;

  // Mount: hidrata a seleção persistida em preferences('captures'). Prefs só
  // aceitam JSON raso, então a lista de nomes vive serializada como string.
  useEffect(() => {
    let active = true;
    void window.staffhub.preferences
      .get('captures')
      .then((prefs) => {
        if (!active) return;
        const raw = prefs[PREF_KEY];
        if (typeof raw !== 'string') return;
        let names: unknown;
        try {
          names = JSON.parse(raw);
        } catch {
          return; // JSON corrompido → mantém o default (todos marcados)
        }
        if (!Array.isArray(names)) return;
        const known = new Set(CAPTURE_TARGETS.map((target) => target.name));
        // Nomes desconhecidos (alvo renomeado/removido) são ignorados; a lista
        // salva vence — inclusive vazia, se o usuário desmarcou tudo de propósito.
        const validNames = names.filter((name): name is string => typeof name === 'string' && known.has(name));
        setSelected(Object.fromEntries(CAPTURE_TARGETS.map((target) => [target.name, validNames.includes(target.name)] as const)));
      })
      .catch((error: unknown) => {
        console.warn('[CapturesPage] Não foi possível ler a seleção de capturas persistida:', error);
      });
    return () => {
      active = false;
    };
  }, []);

  /** Persiste a seleção a cada mudança (16 itens — debounce desnecessário). Fail-soft. */
  function persistSelection(next: Record<string, boolean>): void {
    const names = CAPTURE_TARGETS.filter((target) => next[target.name] === true).map((target) => target.name);
    void window.staffhub.preferences
      .save('captures', { [PREF_KEY]: JSON.stringify(names) })
      .catch((error: unknown) => {
        console.warn('[CapturesPage] Falha ao salvar a seleção de capturas:', error);
      });
  }

  function toggleTarget(name: string): void {
    const next = { ...selected, [name]: !(selected[name] === true) };
    setSelected(next);
    persistSelection(next);
  }

  function toggleAll(): void {
    const markAll = !allSelected;
    const next = Object.fromEntries(CAPTURE_TARGETS.map((target) => [target.name, markAll] as const));
    setSelected(next);
    persistSelection(next);
  }

  async function captureAll(): Promise<void> {
    if (!world || selectedTargets.length === 0) return;
    // Snapshot do clique: a corrida usa exatamente os alvos marcados no botão.
    const targets = selectedTargets;
    setRunning(true);
    setResults([]);
    const collected: FixtureCaptureResult[] = [];
    try {
      for (const target of targets) {
        const url = `https://${world}.tribalwars.com.br${target.path}`;
        // eslint-disable-next-line no-await-in-loop -- sequencial de propósito: pacing humano entre capturas
        const result = await window.staffhub.dev.captureFixture(target.name, url);
        collected.push(result);
        setResults([...collected]);
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    } catch {
      // Falha de ponte IPC no meio da coleta: mantém o que veio e libera o botão.
      collected.push({ ok: false, name: 'ipc', error: 'Comunicação interrompida — recarregue a página.' });
      setResults([...collected]);
    } finally {
      setRunning(false);
      const okCount = collected.filter((r) => r.ok).length;
      if (okCount === collected.length && collected.length > 0) {
        push('ok', `Captura concluída: ${okCount} de ${collected.length} alvos salvos.`);
      } else if (collected.length > 0) {
        push('error', `Captura encerrada com falhas: ${okCount} de ${collected.length} alvos salvos.`);
      }
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const needsLogin = !world || !loggedIn;

  return (
    <section className="page">
      <PageHeader
        kicker="Sistema"
        title="Capturas de tela"
        description="Baixa páginas do jogo com a sua sessão para conferência offline — somente leitura, nada é enviado ao jogo."
      />

      {needsLogin ? (
        <div className="card">
          <EmptyState
            icon={LogIn}
            title="Sessão necessária"
            hint="As capturas usam os cookies da sua sessão do jogo. Faça login para habilitar a coleta das telas."
            action={
              <button
                type="button"
                className="btn"
                onClick={() => void window.staffhub.session.openLogin()}
              >
                <LogIn size={15} aria-hidden="true" />
                Fazer login no jogo
              </button>
            }
          />
        </div>
      ) : (
        <>
          <div className="row">
            <span className="field-label">Telas a capturar</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={toggleAll} disabled={running}>
              {allSelected ? 'Desmarcar todas' : 'Marcar todas'}
            </button>
            <span className="muted">
              {selectedCount}/{CAPTURE_TARGETS.length} selecionadas
            </span>
          </div>

          <div className="capsel-grid">
            {CAPTURE_TARGETS.map((target) => (
              <label key={target.name} className="capsel-item checkbox-field">
                <input
                  type="checkbox"
                  checked={selected[target.name] === true}
                  onChange={() => toggleTarget(target.name)}
                  disabled={running}
                />
                {target.label}
              </label>
            ))}
          </div>

          <div className="row">
            <button type="button" className="btn" onClick={() => void captureAll()} disabled={disabled}>
              {running ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Capturando…
                </>
              ) : (
                <>
                  <Camera size={15} aria-hidden="true" />
                  Capturar {selectedCount} {selectedCount === 1 ? 'tela' : 'telas'} do mundo {world}
                </>
              )}
            </button>
            {selectedCount === 0 && !running && (
              <span className="muted">Nenhuma tela selecionada — marque ao menos um alvo acima.</span>
            )}
            {results.length > 0 && (
              <span className={okCount === results.length ? 'ok' : 'error'}>
                {okCount}/{results.length} ok
              </span>
            )}
          </div>

          {running && <ProgressBar done={results.length} total={selectedCount} label="Capturando" />}

          <div className="capture-grid">
            {selectedTargets.map((target) => {
              const result = results.find((r) => r.name === target.name);
              return (
                <article key={target.name} className="capture-card">
                  <h3 className="capture-card-head">
                    <Camera size={15} aria-hidden="true" />
                    {target.label}
                  </h3>
                  <p className="capture-path">{target.path}</p>
                  {result === undefined ? (
                    <span className="capture-result capture-result--pending">Aguardando</span>
                  ) : result.ok ? (
                    <span className="capture-result capture-result--ok">
                      <CheckCircle2 size={15} aria-hidden="true" />
                      Salvo
                      <span className="capture-result-detail">· {formatBytes(result.bytes)}</span>
                    </span>
                  ) : (
                    <span className="capture-result capture-result--error">
                      <XCircle size={15} aria-hidden="true" />
                      Falhou
                      <span className="capture-result-detail">· {result.error}</span>
                    </span>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </section>
  );
}
