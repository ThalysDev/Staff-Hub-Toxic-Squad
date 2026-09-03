import { useState } from 'react';
import { Gamepad2, KeyRound, LogIn, LogOut, ShieldCheck } from 'lucide-react';
import type { SessionState } from '@shared/ipc-types';
import Callout from '../components/Callout';
import EmptyState from '../components/EmptyState';
import Field from '../components/Field';
import PageHeader from '../components/PageHeader';
import { useAuthStatus } from '../hooks/useAuthStatus';
import { useSessionStatus } from '../hooks/useSessionStatus';
import { useToast } from '../hooks/useToast';

interface SidErrors {
  world?: string;
  sid?: string;
}

// Mundos regulares (br142), clássicos (brc2) e casuais (brp8).
const WORLD_PATTERN = /^br[a-z]?\d{1,4}$/i;

/** Vocabulário unificado do estado da sessão (P1) — os mesmos rótulos do
 * Dashboard: Conectado / Desconectado / Não conectado. Nada de "Desconhecido". */
const ESTADO_SESSAO: Record<SessionState, { label: string; className: string; pulse?: boolean }> = {
  'logged-in': { label: 'Conectado', className: 'pill--ok' },
  'logged-out': { label: 'Desconectado', className: 'pill--error' },
  'logging-in': { label: 'Conectando…', className: 'pill--info', pulse: true },
  unknown: { label: 'Não conectado', className: 'pill--muted' },
};

function EstadoSessaoPill({ state }: { state: SessionState }) {
  const meta = ESTADO_SESSAO[state];
  return (
    <span className={`pill ${meta.className}`}>
      <span
        className={`pill-dot${meta.pulse === true ? ' pill-dot--pulse' : ''}`}
        aria-hidden="true"
      />
      {meta.label}
    </span>
  );
}

export default function SessionPage() {
  const status = useSessionStatus();
  const hasSession = status.state === 'logged-in';
  const loggingIn = status.state === 'logging-in';

  const [sidWorld, setSidWorld] = useState('');
  const [sidValue, setSidValue] = useState('');
  const [sidErrors, setSidErrors] = useState<SidErrors>({});
  const [sidBusy, setSidBusy] = useState(false);
  const { push } = useToast();

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
        description="Duas coisas distintas vivem aqui: a SESSÃO DO JOGO (conexão com o Tribal Wars que captura os dados) e a sua CONTA DO STAFF HUB (login do sistema) — cada uma em sua seção abaixo."
      />

      {/* ===== SEÇÃO 1 — Sessão do jogo (a conexão que alimenta o hub) ===== */}
      <section className="page-section" aria-labelledby="sessao-jogo-title">
        <div className="sg2-filter-head">
          <h2 className="section-title" id="sessao-jogo-title">
            <Gamepad2 size={17} aria-hidden="true" style={{ marginRight: 6, verticalAlign: -3 }} />
            Sessão do jogo (Tribal Wars)
          </h2>
        </div>
        <p className="muted" style={{ margin: '-4px 0 8px' }}>
          É daqui que o hub lê o jogo: coletas, dados do mundo, reservas e MPs. Entre pela janela
          oficial — ou importe o cookie sid se você já está logado no navegador.
        </p>

        <div className="card">
          <div className="card-header">
            <span className="icon-badge">
              <Gamepad2 size={17} aria-hidden="true" />
            </span>
            <h2 className="card-title">Estado da sessão</h2>
            <span className="spacer" />
            <EstadoSessaoPill state={status.state} />
          </div>
          <div className="card-body">
            {loggingIn && (
              <Callout variant="info" title="Abrindo a página de login">
                <p>
                  Faça login no portal e <strong>clique no seu mundo</strong> para entrar no jogo. O
                  hub detecta sozinho quando você entra no mundo e fecha a janela.
                </p>
              </Callout>
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
                  hint="Faça login com a janela oficial — ou importe o cookie sid logo abaixo, se você já está logado no navegador."
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
            <h2 className="card-title">Alternativa: entrar com SID</h2>
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
      </section>

      {/* ===== SEÇÃO 2 — Conta do Staff Hub (o login do sistema) ===== */}
      <section className="page-section" aria-labelledby="conta-hub-title">
        <div className="sg2-filter-head">
          <h2 className="section-title" id="conta-hub-title">
            <ShieldCheck size={17} aria-hidden="true" style={{ marginRight: 6, verticalAlign: -3 }} />
            Conta do Staff Hub
          </h2>
        </div>
        <p className="muted" style={{ margin: '-4px 0 8px' }}>
          Seu acesso ao sistema (aprovado pelo admin). Não tem relação com a conta do jogo — trocar
          senha aqui não afeta o Tribal Wars.
        </p>

        <div className="card">
          <div className="card-header">
            <span className="icon-badge">
              <ShieldCheck size={17} aria-hidden="true" />
            </span>
            <h2 className="card-title">Sua conta</h2>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-ghost btn-ghost--danger btn-sm"
              data-tip="Encerra a sessão do SISTEMA (login/senha) neste computador."
              onClick={() => {
                if (window.confirm('Sair da conta do Staff Hub? Você voltará para a tela de login.')) {
                  void window.staffhub.auth.logout();
                }
              }}
            >
              <LogOut size={14} aria-hidden="true" /> Sair da conta
            </button>
          </div>
          <div className="card-body">
            <SessaoSistema />
          </div>
        </div>
      </section>
    </section>
  );
}

/** Card da conta do SISTEMA (v0.30): quem está logado + trocar senha. */
function SessaoSistema() {
  const auth = useAuthStatus();
  const { push } = useToast();
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [ocupado, setOcupado] = useState(false);

  if (auth.user === null) {
    return <p className="muted">Sem sessão do sistema ativa.</p>;
  }

  async function trocar(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (ocupado) return;
    if (nova.length < 8) {
      push('error', 'A nova senha precisa ter pelo menos 8 caracteres.');
      return;
    }
    setOcupado(true);
    try {
      const resultado = await window.staffhub.auth.trocarSenha(atual, nova);
      if (resultado.ok) {
        setAtual('');
        setNova('');
        push('ok', 'Senha alterada — entre novamente com a nova senha.');
      } else {
        push('error', resultado.erro ?? 'Não foi possível trocar a senha.');
      }
    } catch (erro) {
      // Rejeição de IPC (rede/offline) também precisa de feedback — sem isto
      // virava unhandled rejection silenciosa (P3 da revisão integrada).
      push('error', erro instanceof Error ? erro.message : 'Não foi possível trocar a senha.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <strong>{auth.user.nick}</strong>
        <span className={`pill ${auth.user.role === 'admin' ? 'pill--gold' : 'pill--muted'}`}>
          {auth.user.role === 'admin' ? 'Admin' : 'Staff'}
        </span>
        {auth.estado === 'offline' && (
          <span className="pill pill--warn" title="Sem contato com o servidor — sessão válida no modo guerra">
            offline
          </span>
        )}
      </div>
      <form className="col" style={{ gap: 10 }} onSubmit={(e) => void trocar(e)}>
        <Field id="conta-senha-atual" label="Senha atual">
          <input
            id="conta-senha-atual"
            className="input"
            type="password"
            autoComplete="current-password"
            value={atual}
            onChange={(event) => setAtual(event.target.value)}
          />
        </Field>
        <Field id="conta-senha-nova" label="Nova senha (mínimo 8)">
          <input
            id="conta-senha-nova"
            className="input"
            type="password"
            autoComplete="new-password"
            value={nova}
            onChange={(event) => setNova(event.target.value)}
          />
        </Field>
        <div>
          <button type="submit" className="btn btn-sm" disabled={ocupado}>
            <KeyRound size={14} aria-hidden="true" />
            {ocupado ? 'Trocando…' : 'Trocar senha'}
          </button>
        </div>
      </form>
    </div>
  );
}
