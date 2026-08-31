// LoginPage (v0.30) — tela inicial do sistema: login/senha + criar conta
// (pendente até o admin aprovar). Toda chamada vai ao main (auth:*) — o
// renderer nunca vê tokens. Sem efeitos de carga automática: cada tentativa
// nasce de um clique/Enter (lição 0.29.1: nunca efeito que re-dispare só).
import { useEffect, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { KeyRound, LogIn, ShieldCheck, UserPlus } from 'lucide-react';
import type { AuthStatus } from '@shared/ipc-types';
import { useToast } from '../hooks/useToast';

type Modo = 'login' | 'criar' | 'aguardando';

interface LoginPageProps {
  /** Status vivo (o LoginGate injeta; eventos onAuthChanged sobem do main). */
  status: AuthStatus;
  /** Executado quando o login dá certo — o gate troca para o app. */
  onLogado: () => void;
}

export default function LoginPage({ status, onLogado }: LoginPageProps): JSX.Element {
  const { push } = useToast();
  const [modo, setModo] = useState<Modo>('login');
  const [nick, setNick] = useState('');
  const [senha, setSenha] = useState('');
  const [senhaConfirma, setSenhaConfirma] = useState('');
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const focoNick = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    focoNick.current?.focus();
  }, [modo]);

  // Sessão 'expirada' pré-carregada (veio de um 401): mensagem única e clara.
  useEffect(() => {
    if (status.estado === 'expirado' && erro === '') {
      setErro('Sua sessão foi encerrada — entre novamente.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.estado]);

  async function entrar(event?: React.FormEvent): Promise<void> {
    event?.preventDefault();
    if (ocupado) return;
    const nickLimpo = nick.trim();
    if (nickLimpo === '' || senha === '') {
      setErro('Informe nick e senha.');
      return;
    }
    setOcupado(true);
    setErro('');
    try {
      const resultado = await window.staffhub.auth.login(nickLimpo, senha);
      if (resultado.ok) {
        push('ok', `Bem-vindo, ${resultado.user.nick}!`);
        onLogado();
        return;
      }
      if (resultado.code === 'pending') {
        setModo('aguardando');
      }
      setErro(resultado.erro);
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err));
    } finally {
      setOcupado(false);
    }
  }

  async function criarConta(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (ocupado) return;
    const nickLimpo = nick.trim();
    if (nickLimpo === '' || senha === '') {
      setErro('Informe nick e senha.');
      return;
    }
    if (senha !== senhaConfirma) {
      setErro('As senhas não conferem.');
      return;
    }
    if (senha.length < 8) {
      setErro('A senha precisa ter pelo menos 8 caracteres.');
      return;
    }
    setOcupado(true);
    setErro('');
    try {
      const resultado = await window.staffhub.auth.register(nickLimpo, senha);
      if (resultado.ok) {
        setModo('aguardando');
        setSenha('');
        setSenhaConfirma('');
      } else {
        setErro(resultado.erro ?? 'Não foi possível criar a conta.');
      }
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err));
    } finally {
      setOcupado(false);
    }
  }

  const campo = (label: string, id: string, valor: string, onChange: (v: string) => void, tipo: 'text' | 'password', dica?: string, autoFocus = false): ReactNode => (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        ref={autoFocus ? focoNick : undefined}
        className="input"
        type={tipo}
        value={valor}
        autoComplete={tipo === 'password' ? 'current-password' : 'username'}
        onChange={(event) => onChange(event.target.value)}
      />
      {dica !== undefined && <span className="field-hint">{dica}</span>}
    </div>
  );

  return (
    <div className="login-page">
      <div className="login-card" role="main">
        <div className="login-brasao" aria-hidden="true">
          <ShieldCheck size={34} />
        </div>
        <h1 className="login-titulo">Staff Hub</h1>
        <p className="login-sub">Toxic Squad · comando de operações</p>

        {modo === 'login' && (
          <form className="col" style={{ gap: 12 }} onSubmit={(e) => void entrar(e)}>
            {campo('Nick', 'login-nick', nick, setNick, 'text', undefined, true)}
            {campo('Senha', 'login-senha', senha, setSenha, 'password')}
            {erro !== '' && (
              <p className="error" role="alert">
                {erro}
              </p>
            )}
            <button type="submit" className="btn login-btn-primario" disabled={ocupado}>
              {ocupado ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" /> Entrando…
                </>
              ) : (
                <>
                  <LogIn size={16} aria-hidden="true" /> Entrar
                </>
              )}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setModo('criar');
                setErro('');
              }}
            >
              <UserPlus size={15} aria-hidden="true" /> Criar conta
            </button>
          </form>
        )}

        {modo === 'criar' && (
          <form className="col" style={{ gap: 12 }} onSubmit={(e) => void criarConta(e)}>
            {campo('Nick', 'criar-nick', nick, setNick, 'text', 'Como a staff te conhece no jogo.', true)}
            {campo('Senha (mínimo 8)', 'criar-senha', senha, setSenha, 'password')}
            {campo('Confirmar senha', 'criar-confirma', senhaConfirma, setSenhaConfirma, 'password')}
            {erro !== '' && (
              <p className="error" role="alert">
                {erro}
              </p>
            )}
            <button type="submit" className="btn login-btn-primario" disabled={ocupado}>
              {ocupado ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" /> Criando…
                </>
              ) : (
                <>
                  <KeyRound size={16} aria-hidden="true" /> Criar minha conta
                </>
              )}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setModo('login');
                setErro('');
              }}
            >
              Voltar para o login
            </button>
          </form>
        )}

        {modo === 'aguardando' && (
          <div className="col" style={{ gap: 12 }}>
            <div className="callout callout--warn" role="status">
              <span className="callout-icon">
                <KeyRound size={16} aria-hidden="true" />
              </span>
              <div className="callout-body">
                <p className="callout-title">Conta criada — aguardando aprovação</p>
                <p>Avise o administrador (líder) que você criou sua conta. Assim que ele aprovar, entre com o nick e a senha.</p>
              </div>
            </div>
            {erro !== '' && erro !== 'As senhas não conferem.' && (
              <p className="error" role="alert">
                {erro}
              </p>
            )}
            <button
              type="button"
              className="btn login-btn-primario"
              onClick={() => {
                setModo('login');
                setErro('');
              }}
            >
              <LogIn size={16} aria-hidden="true" /> Já fui aprovado — entrar
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setModo('criar');
                setErro('');
              }}
            >
              Criar outra conta
            </button>
          </div>
        )}

        <p className="login-rodape">Acesso pessoal e intransferível · uso exclusivo da Toxic Squad</p>
      </div>
    </div>
  );
}
