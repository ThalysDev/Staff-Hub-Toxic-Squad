// AdminPage (v0.30) — gestão de contas do sistema: aprovar pendentes,
// banir/reabilitar, resetar senha e auditoria. Só aparece para role admin
// (a API também nega no servidor — a UI não é a barreira).
// v0.37: chaves in-game (licença do userscript) — emissão (chave em claro
// mostrada UMA vez), listagem por prefixo e revogação.
// Efeito de carga com guard de ERRO + retry manual (lição do 0.29.1).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { ClipboardCopy, KeyRound, RefreshCw, ShieldOff, ShieldCheck, Undo2, UserCheck } from 'lucide-react';
import type { AdminKeyRow, AdminUserRow, AuthAdminAudit } from '@shared/ipc-types';
import Callout from '../components/Callout';
import EmptyState from '../components/EmptyState';
import PageHeader from '../components/PageHeader';
import { useToast } from '../hooks/useToast';

type Aba = 'pendentes' | 'ativas' | 'banidas';

export default function AdminPage(): JSX.Element {
  const { push } = useToast();
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [audit, setAudit] = useState<AuthAdminAudit[] | null>(null);
  const [keys, setKeys] = useState<AdminKeyRow[] | null>(null);
  const [erro, setErro] = useState('');
  const [aba, setAba] = useState<Aba>('pendentes');
  const [carregando, setCarregando] = useState(false);
  const [trabalhando, setTrabalhando] = useState<string | null>(null);
  const [senhaTemp, setSenhaTemp] = useState<{ nick: string; senha: string } | null>(null);
  // Chaves in-game: formulário de emissão + chave em claro (exibida UMA vez).
  const [formConta, setFormConta] = useState('');
  const [formDias, setFormDias] = useState('30');
  const [formTier, setFormTier] = useState<'staff' | 'lider'>('staff');
  const [emitindo, setEmitindo] = useState(false);
  const [chaveEmitida, setChaveEmitida] = useState<{ chave: string; owner: string } | null>(null);
  const carregouUmaVez = useRef(false);

  async function carregar(silencioso = false): Promise<void> {
    setCarregando(true);
    if (!silencioso) setErro('');
    try {
      const [lista, auditoria, chaves] = await Promise.all([
        window.staffhub.auth.adminUsers(),
        window.staffhub.auth.adminAudit(),
        window.staffhub.auth.adminKeys.listar(),
      ]);
      setUsers(lista.users);
      setAudit(auditoria.eventos);
      setKeys(chaves.keys);
    } catch (err) {
      const mensagem = err instanceof Error ? err.message : String(err);
      setErro(mensagem);
      if (!silencioso) push('error', mensagem);
    } finally {
      setCarregando(false);
    }
  }

  // Carga inicial única + recarga manual (o guard de erro impede re-disparo).
  useEffect(() => {
    if (carregouUmaVez.current) return;
    carregouUmaVez.current = true;
    void carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const porStatus = useMemo(() => {
    const base = { pending: [], active: [], banned: [] } as Record<AdminUserRow['status'], AdminUserRow[]>;
    for (const user of users ?? []) base[user.status].push(user);
    return base;
  }, [users]);

  const listaDaAba: AdminUserRow[] =
    aba === 'pendentes' ? porStatus.pending : aba === 'ativas' ? porStatus.active : porStatus.banned;

  async function agir(user: AdminUserRow, acao: 'aprovar' | 'banir' | 'reabilitar'): Promise<void> {
    const mensagens = {
      aprovar: `Aprovar a conta de "${user.nick}"? Ela passa a acessar o Staff Hub imediatamente.`,
      banir: `Banir "${user.nick}"? A sessão dele é encerrada na hora e o login é bloqueado.`,
      reabilitar: `Reabilitar "${user.nick}"? A conta volta a aceitar login.`,
    } as const;
    if (!window.confirm(mensagens[acao])) return;
    setTrabalhando(`${user.id}:${acao}`);
    try {
      const resultado = await window.staffhub.auth.adminUsersAcao(user.id, acao);
      if (!resultado.ok) {
        push('error', resultado.erro ?? 'Ação falhou.');
        return;
      }
      push('ok', `Conta de "${user.nick}": ${acao} concluída.`);
      await carregar(true);
    } finally {
      setTrabalhando(null);
    }
  }

  async function resetar(user: AdminUserRow): Promise<void> {
    if (!window.confirm(`Resetar a senha de "${user.nick}"? Uma senha temporária é gerada e a sessão atual dele é encerrada.`)) {
      return;
    }
    setTrabalhando(`${user.id}:reset`);
    try {
      const resultado = await window.staffhub.auth.adminResetarSenha(user.id);
      if (!resultado.ok || resultado.senhaTemporaria === undefined) {
        push('error', resultado.erro ?? 'Ação falhou.');
        return;
      }
      setSenhaTemp({ nick: user.nick, senha: resultado.senhaTemporaria });
      push('ok', `Senha temporária gerada para "${user.nick}".`);
      await carregar(true);
    } finally {
      setTrabalhando(null);
    }
  }

  async function copiarSenha(): Promise<void> {
    if (senhaTemp === null) return;
    try {
      await navigator.clipboard.writeText(senhaTemp.senha);
      push('ok', 'Senha temporária copiada.');
    } catch {
      push('error', 'Não foi possível copiar — permissão de área de transferência negada.');
    }
  }

  // ---- chaves in-game ----

  async function emitirChave(evento: FormEvent): Promise<void> {
    evento.preventDefault();
    const conta = formConta.trim();
    const dias = Number(formDias);
    if (conta === '') {
      push('error', 'Informe a conta do Tribal Wars dona da chave.');
      return;
    }
    if (!Number.isInteger(dias) || dias < 1 || dias > 3650) {
      push('error', 'Dias deve ser um número entre 1 e 3650.');
      return;
    }
    setEmitindo(true);
    try {
      const resultado = await window.staffhub.auth.adminKeys.emitir(conta, dias, formTier);
      if (!resultado.ok) {
        push('error', resultado.erro);
        return;
      }
      setChaveEmitida({ chave: resultado.key, owner: conta });
      setFormConta('');
      push('ok', `Chave emitida para "${conta}" — copie agora: não será exibida de novo.`);
      await carregar(true);
    } catch (err) {
      push('error', err instanceof Error ? err.message : String(err));
    } finally {
      setEmitindo(false);
    }
  }

  async function copiarChave(): Promise<void> {
    if (chaveEmitida === null) return;
    try {
      await navigator.clipboard.writeText(chaveEmitida.chave);
      push('ok', 'Chave copiada.');
    } catch {
      push('error', 'Não foi possível copiar — permissão de área de transferência negada.');
    }
  }

  async function revogarChave(chave: AdminKeyRow): Promise<void> {
    if (
      !window.confirm(
        `Revogar a chave ${chave.keyPrefix}… de "${chave.ownerNick}"? O userscript dela para de validar na hora.`,
      )
    ) {
      return;
    }
    setTrabalhando(`chave:${chave.id}`);
    try {
      const resultado = await window.staffhub.auth.adminKeys.revogar(chave.id);
      if (!resultado.ok) {
        push('error', resultado.erro ?? 'Ação falhou.');
        return;
      }
      push('ok', `Chave ${chave.keyPrefix}… revogada.`);
      await carregar(true);
    } finally {
      setTrabalhando(null);
    }
  }

  const statusChave = (chave: AdminKeyRow): JSX.Element => {
    if (chave.revoked === 1) return <span className="pill pill--error">Revogada</span>;
    if (chave.expiresAt !== null && chave.expiresAt <= Date.now()) {
      return <span className="pill pill--warn">Expirada</span>;
    }
    if (chave.boundPlayer === null) return <span className="pill pill--muted">Não ativada</span>;
    return <span className="pill pill--ok">Ativa</span>;
  };

  const abaBotao = (chave: Aba, rotulo: string, total: number): JSX.Element => (
    <button
      key={chave}
      type="button"
      role="tab"
      aria-selected={aba === chave}
      className={`seg-tab${aba === chave ? ' seg-tab--active' : ''}`}
      onClick={() => setAba(chave)}
    >
      {rotulo} <span className="pill pill--muted">{total}</span>
    </button>
  );

  return (
    <div className="col">
      <PageHeader
        kicker="Sistema"
        title="Administração de contas"
        description="Aprove quem criou conta, banir abusos e audite acessos — você é o dono do acesso ao Staff Hub."
        actions={
          <button type="button" className="btn btn-sm" onClick={() => void carregar()} disabled={carregando}>
            <RefreshCw size={14} aria-hidden="true" />
            {carregando ? 'Carregando…' : 'Recarregar'}
          </button>
        }
      />

      {erro !== '' && (
        <Callout variant="danger" title="Falha ao carregar">
          <p>{erro}</p>
        </Callout>
      )}

      {senhaTemp !== null && (
        <Callout variant="warn" icon={KeyRound} title={`Senha temporária de ${senhaTemp.nick}`}>
          <p>
            <code className="login-senha-temp">{senhaTemp.senha}</code>{' '}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copiarSenha()}>
              <ClipboardCopy size={14} aria-hidden="true" /> Copiar
            </button>
          </p>
          <p className="field-hint">Repasse por mensagem privada e oriente a trocar no 1º login (perfil em Sessão).</p>
        </Callout>
      )}

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Contas</h2>
          <span className="spacer" />
          <div className="seg-tabs" role="tablist" aria-label="Filtro de contas">
            {abaBotao('pendentes', 'Pendentes', porStatus.pending.length)}
            {abaBotao('ativas', 'Ativas', porStatus.active.length)}
            {abaBotao('banidas', 'Banidas', porStatus.banned.length)}
          </div>
        </div>

        {users === null && erro === '' ? (
          <p className="muted" style={{ padding: 16 }}>
            Carregando contas…
          </p>
        ) : listaDaAba.length === 0 ? (
          <EmptyState
            compact
            icon={UserCheck}
            title={aba === 'pendentes' ? 'Nenhuma conta aguardando aprovação' : `Nenhuma conta ${aba}`}
            {...(aba === 'pendentes' ? { hint: 'Quando alguém criar conta no app, ela aparece aqui para você aprovar.' } : {})}
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Nick</th>
                  <th scope="col">Papel</th>
                  <th scope="col">Criada em</th>
                  <th scope="col">Status</th>
                  <th scope="col">Ações</th>
                </tr>
              </thead>
              <tbody>
                {listaDaAba.map((user) => (
                  <tr key={user.id}>
                    <td className="cell-nowrap">
                      <strong>{user.nick}</strong>
                    </td>
                    <td className="cell-nowrap">{user.role === 'admin' ? 'Admin' : 'Staff'}</td>
                    <td className="cell-nowrap">{new Date(user.criadoEm).toLocaleString('pt-BR')}</td>
                    <td className="cell-nowrap">
                      {user.status === 'pending' && <span className="pill pill--warn">Pendente</span>}
                      {user.status === 'active' && <span className="pill pill--ok">Ativa</span>}
                      {user.status === 'banned' && <span className="pill pill--error">Banida</span>}
                    </td>
                    <td className="cell-nowrap">
                      <span className="row" style={{ gap: 6 }}>
                        {user.status === 'pending' && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={trabalhando !== null}
                            onClick={() => void agir(user, 'aprovar')}
                          >
                            <ShieldCheck size={14} aria-hidden="true" />
                            {trabalhando === `${user.id}:aprovar` ? 'Aprovando…' : 'Aprovar'}
                          </button>
                        )}
                        {user.status === 'active' && (
                          <>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={trabalhando !== null}
                              onClick={() => void resetar(user)}
                            >
                              <KeyRound size={14} aria-hidden="true" /> Resetar senha
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-ghost--danger btn-sm"
                              disabled={trabalhando !== null}
                              onClick={() => void agir(user, 'banir')}
                            >
                              <ShieldOff size={14} aria-hidden="true" />
                              {trabalhando === `${user.id}:banir` ? 'Banindo…' : 'Banir'}
                            </button>
                          </>
                        )}
                        {user.status === 'banned' && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={trabalhando !== null}
                            onClick={() => void agir(user, 'reabilitar')}
                          >
                            <Undo2 size={14} aria-hidden="true" /> Reabilitar
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Chaves In-Game</h2>
          <span className="spacer" />
          {keys !== null && <span className="pill pill--muted">{keys.length}</span>}
        </div>

        <p className="muted" style={{ marginTop: 0 }}>
          Licença do userscript in-game: a chave vincula à conta do TW na 1ª ativação e a
          validação é sempre no servidor (revogação vale na hora).
        </p>

        <form className="row" style={{ gap: 12 }} onSubmit={(e) => void emitirChave(e)}>
          <div className="field" style={{ minWidth: 200 }}>
            <label className="field-label" htmlFor="chave-conta">
              Conta do TW
            </label>
            <input
              id="chave-conta"
              className="input"
              value={formConta}
              placeholder="nick do jogador"
              onChange={(event) => setFormConta(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="chave-dias">
              Dias
            </label>
            <input
              id="chave-dias"
              className="input"
              type="number"
              min={1}
              max={3650}
              value={formDias}
              style={{ maxWidth: 110 }}
              onChange={(event) => setFormDias(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="chave-tier">
              Tier
            </label>
            <select
              id="chave-tier"
              className="select"
              value={formTier}
              onChange={(event) => setFormTier(event.target.value as 'staff' | 'lider')}
            >
              <option value="staff">Staff</option>
              <option value="lider">Líder</option>
            </select>
          </div>
          <button type="submit" className="btn" style={{ alignSelf: 'flex-end' }} disabled={emitindo || carregando}>
            <KeyRound size={14} aria-hidden="true" />
            {emitindo ? 'Emitindo…' : 'Emitir chave'}
          </button>
        </form>

        {chaveEmitida !== null && (
          <Callout variant="warn" icon={KeyRound} title={`Chave de ${chaveEmitida.owner}`}>
            <p>
              <code className="login-senha-temp">{chaveEmitida.chave}</code>{' '}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copiarChave()}>
                <ClipboardCopy size={14} aria-hidden="true" /> Copiar
              </button>
            </p>
            <p className="field-hint">
              Mostra SÓ agora — não existe como ver de novo. Repasse ao jogador por MP.
            </p>
          </Callout>
        )}

        {keys === null && erro === '' ? (
          <p className="muted" style={{ padding: 16 }}>
            Carregando chaves…
          </p>
        ) : (keys?.length ?? 0) === 0 ? (
          <EmptyState
            compact
            icon={KeyRound}
            title="Nenhuma chave emitida"
            hint="Emita a primeira licença do userscript in-game no formulário acima."
          />
        ) : (
          <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Chave</th>
                  <th scope="col">Conta</th>
                  <th scope="col">Vinculada a</th>
                  <th scope="col">Expira</th>
                  <th scope="col">Status</th>
                  <th scope="col">Ações</th>
                </tr>
              </thead>
              <tbody>
                {(keys ?? []).map((chave) => (
                  <tr key={chave.id}>
                    <td className="cell-nowrap">
                      <code>{chave.keyPrefix}…</code>
                    </td>
                    <td className="cell-nowrap">
                      <strong>{chave.ownerNick}</strong>
                    </td>
                    <td className="cell-nowrap">{chave.boundPlayer ?? '—'}</td>
                    <td className="cell-nowrap">
                      {chave.expiresAt === null ? 'Sem prazo' : new Date(chave.expiresAt).toLocaleDateString('pt-BR')}
                    </td>
                    <td className="cell-nowrap">{statusChave(chave)}</td>
                    <td className="cell-nowrap">
                      {chave.revoked === 0 && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-ghost--danger btn-sm"
                          disabled={trabalhando !== null}
                          onClick={() => void revogarChave(chave)}
                        >
                          <ShieldOff size={14} aria-hidden="true" />
                          {trabalhando === `chave:${chave.id}` ? 'Revogando…' : 'Revogar'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Auditoria</h2>
          <span className="spacer" />
          {(audit?.length ?? 0) > 0 && <span className="pill pill--muted">últimos {audit?.length ?? 0}</span>}
        </div>
        {audit === null ? (
          <p className="muted" style={{ padding: 16 }}>
            Carregando auditoria…
          </p>
        ) : audit.length === 0 ? (
          <EmptyState compact icon={UserCheck} title="Sem eventos ainda" hint="Logins, aprovações e banners aparecem aqui." />
        ) : (
          <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Quando</th>
                  <th scope="col">Ator</th>
                  <th scope="col">Evento</th>
                  <th scope="col">Detalhe</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((evento, indice) => (
                  <tr key={`${evento.ts}-${indice}`}>
                    <td className="cell-nowrap">{new Date(evento.ts).toLocaleString('pt-BR')}</td>
                    <td className="cell-nowrap">{evento.ator}</td>
                    <td className="cell-nowrap">{evento.evento}</td>
                    <td className="cell-nowrap muted">{evento.detalhe}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
