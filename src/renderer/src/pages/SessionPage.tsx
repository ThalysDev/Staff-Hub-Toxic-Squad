import StatusPill from '../components/StatusPill';
import { useSessionStatus } from '../hooks/useSessionStatus';

export default function SessionPage() {
  const status = useSessionStatus();

  const handleLogin = (): void => {
    void window.staffhub.session.openLogin();
  };

  const handleLogout = (): void => {
    if (window.confirm('Encerrar a sessão atual? Você precisará refazer o login para capturar dados do jogo.')) {
      void window.staffhub.session.logout();
    }
  };

  return (
    <section>
      <h1>Sessão</h1>
      <div className="card">
        <div className="row">
          <StatusPill state={status.state} />
          <span className="muted">
            Verificado em:{' '}
            {status.checkedAt ? new Date(status.checkedAt).toLocaleString('pt-BR') : '—'}
          </span>
        </div>
        <dl className="session-fields">
          <div className="row">
            <dt>Mundo</dt>
            <dd>{status.world ?? '—'}</dd>
          </div>
          <div className="row">
            <dt>Jogador</dt>
            <dd>{status.player ?? '—'}</dd>
          </div>
        </dl>
        <div className="row">
          <button type="button" className="btn" onClick={handleLogin} disabled={status.state === 'logging-in'}>
            Fazer login no jogo
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleLogout}
            disabled={status.state === 'logged-out' || status.state === 'unknown'}
          >
            Encerrar sessão
          </button>
        </div>
        <p className="muted hint-note">
          O login abre a página oficial do jogo; captcha e etapas são resolvidos por você.
        </p>
      </div>
    </section>
  );
}