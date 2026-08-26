import { useState } from 'react';
import { Info, KeyRound, LogIn, LogOut, ShieldCheck } from 'lucide-react';
import EmptyState from '../components/EmptyState';
import Field from '../components/Field';
import PageHeader from '../components/PageHeader';
import StatusPill from '../components/StatusPill';
import ToastViewport from '../components/Toast';
import { useSessionStatus } from '../hooks/useSessionStatus';
import { useToast } from '../hooks/useToast';

interface SidErrors {
  world?: string;
  sid?: string;
}

// Mundos regulares (br142), clássicos (brc2) e casuais (brp8).
const WORLD_PATTERN = /^br[a-z]?\d{1,4}$/i;

export default function SessionPage() {
  const status = useSessionStatus();
  const hasSession = status.state === 'logged-in';
  const loggingIn = status.state === 'logging-in';

  const [sidWorld, setSidWorld] = useState('');
  const [sidValue, setSidValue] = useState('');
  const [sidErrors, setSidErrors] = useState<SidErrors>({});
  const [sidBusy, setSidBusy] = useState(false);
  const { toasts, push, dismiss } = useToast();

  const handleLogin = (): void => {
    void window.staffhub.session.openLogin();
  };

  const handleLogout = (): void => {
    if (window.confirm('Encerrar a sessão atual? Você precisará refazer o login para capturar dados do jogo.')) {
      void window.staffhub.session.logout();
    }
  };

  async function handleSidLogin(): Promise<void> {
    const world = sidWorld.trim().toLowerCase();
    const sid = sidValue.trim();

    const errors: SidErrors = {};
    if (!WORLD_PATTERN.test(world)) errors.world = 'Use br + número (ex.: br142), brc + número (clássico) ou brp + número (casual).';
    if (sid.length === 0) errors.sid = 'Cole o valor do cookie sid.';
    setSidErrors(errors);
    if (errors.world !== undefined || errors.sid !== undefined) return;

    setSidBusy(true);
    try {
      const result = await window.staffhub.session.loginWithSid(world, sid);
      if (result.ok) {
        setSidValue('');
        setSidErrors({});
        push('ok', `Sessão iniciada via SID no ${world}.`);
      } else {
        setSidErrors({ sid: result.error });
        push('error', result.error);
      }
    } catch {
      push('error', 'Não foi possível entrar com o SID. Tente novamente.');
    } finally {
      setSidBusy(false);
    }
  }

  return (
    <section className="page">
      <PageHeader
        kicker="Sistema"
        title="Sessão"
        description="Conecte o hub à sua conta do Tribal Wars BR: janela de login oficial ou import do cookie sid."
      />

      <div className="card">
        <div className="card-header">
          <span className="icon-badge">
            <ShieldCheck size={17} aria-hidden="true" />
          </span>
          <h2 className="card-title">Estado da sessão</h2>
          <span className="spacer" />
          <StatusPill state={status.state} />
        </div>
        <div className="card-body">
          {loggingIn && (
            <div className="callout callout--info">
              <Info size={18} className="callout-icon" aria-hidden="true" />
              <div className="callout-body">
                <p className="callout-title">Abrindo a página de login</p>
                <p>
                  Faça login no portal e <strong>clique no seu mundo</strong> para entrar no jogo. O
                  hub detecta sozinho quando você entra no mundo e fecha a janela.
                </p>
              </div>
            </div>
          )}

          {hasSession ? (
            <>
              <dl className="session-dl">
                <dt>Mundo</dt>
                <dd>{status.world ?? '—'}</dd>
                <dt>Jogador</dt>
                <dd>{status.player ?? '—'}</dd>
                <dt>Última verificação</dt>
                <dd>
                  {status.checkedAt ? new Date(status.checkedAt).toLocaleString('pt-BR') : '—'}
                </dd>
              </dl>
              <div className="row">
                <button type="button" className="btn btn-danger" onClick={handleLogout}>
                  <LogOut size={15} aria-hidden="true" />
                  Encerrar sessão
                </button>
              </div>
              <p className="hint-note">
                A sessão fica salva entre execuções do hub (partição própria do jogo). Encerre só
                quando for trocar de conta.
              </p>
            </>
          ) : (
            !loggingIn && (
              <EmptyState
                icon={LogIn}
                title="Sem sessão ativa"
                hint="Faça login com a janela oficial abaixo — ou importe o cookie sid no cartão seguinte, se você já está logado no navegador."
                action={
                  <button type="button" className="btn" onClick={handleLogin}>
                    <LogIn size={15} aria-hidden="true" />
                    Fazer login no jogo
                  </button>
                }
              />
            )
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="icon-badge">
            <KeyRound size={17} aria-hidden="true" />
          </span>
          <h2 className="card-title">Entrar com SID</h2>
        </div>
        <div className="card-body">
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSidLogin();
            }}
          >
            <Field
              id="sid-world"
              label="Mundo"
              error={sidErrors.world}
            >
              <input
                id="sid-world"
                className="input"
                type="text"
                placeholder="br142, brc2 ou brp8"
                autoComplete="off"
                value={sidWorld}
                onChange={(event) => setSidWorld(event.target.value)}
              />
            </Field>
            <Field
              id="sid-value"
              label="SID"
              error={sidErrors.sid}
            >
              <input
                id="sid-value"
                className="input"
                type="text"
                placeholder="cole o export completo do EditThisCookie ou só o valor do sid"
                autoComplete="off"
                spellCheck={false}
                value={sidValue}
                onChange={(event) => setSidValue(event.target.value)}
              />
            </Field>
            <ol className="step-list">
              <li>Faça login no jogo pelo navegador, normalmente.</li>
              <li>
                Na extensão de cookies (EditThisCookie), clique em <strong>Export</strong>.
              </li>
              <li>
                Cole o resultado no campo acima — o hub extrai o <strong>sid</strong> de
                br###.tribalwars.com.br sozinho.
              </li>
            </ol>
            <p className="hint-note">
              Só o valor do sid também serve:{' '}
              <code className="code-chip">0%3A2e4a9f77b1c3…</code> ou{' '}
              <code className="code-chip">0:2e4a9f77b1c3…</code>. O hub grava apenas os cookies
              que você colar — nunca gera ou renova sid.
            </p>
            <div className="row">
              <button type="submit" className="btn btn-ghost" disabled={sidBusy}>
                {sidBusy ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    Entrando…
                  </>
                ) : (
                  <>
                    <KeyRound size={15} aria-hidden="true" />
                    Entrar com SID
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </section>
  );
}
