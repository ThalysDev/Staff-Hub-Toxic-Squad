import { useState } from 'react';
import type { FixtureCaptureResult } from '@shared/ipc-types';
import { useSessionStatus } from '../hooks/useSessionStatus';

/**
 * Alvos de captura para fixtures do BR142 (Fase 0.5). O sufixo `{world}` é
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

export default function CapturesPage() {
  const session = useSessionStatus();
  const [results, setResults] = useState<FixtureCaptureResult[]>([]);
  const [running, setRunning] = useState(false);

  const world = session.world;
  const disabled = !world || session.state !== 'logged-in' || running;

  async function captureAll() {
    if (!world) return;
    setRunning(true);
    setResults([]);
    const collected: FixtureCaptureResult[] = [];
    try {
      for (const target of CAPTURE_TARGETS) {
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
    }
  }

  const okCount = results.filter((r) => r.ok).length;

  return (
    <div className="col" style={{ gap: 16 }}>
      <header className="page-header">
        <h2>Capturas de tela (fixtures BR142)</h2>
        <p className="muted">
          Baixa páginas do jogo com a sua sessão e salva como fixtures para os testes dos
          parsers. Somente leitura — nenhuma ação é enviada ao jogo. Os alvos com
          &quot;preencher&quot; precisam de um id real antes de capturar.
        </p>
      </header>

      {!world || session.state !== 'logged-in' ? (
        <div className="empty">Faça login no jogo (página Sessão) para capturar.</div>
      ) : (
        <>
          <div className="row">
            <button type="button" className="btn" onClick={() => void captureAll()} disabled={disabled}>
              {running ? 'Capturando…' : `Capturar ${CAPTURE_TARGETS.length} telas do mundo ${world}`}
            </button>
            {results.length > 0 && (
              <span className={okCount === results.length ? 'ok' : 'error'}>
                {okCount}/{results.length} ok
              </span>
            )}
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>Alvo</th>
                <th>Resultado</th>
                <th>Detalhe</th>
              </tr>
            </thead>
            <tbody>
              {CAPTURE_TARGETS.map((target) => {
                const result = results.find((r) => r.name === target.name);
                return (
                  <tr key={target.name}>
                    <td>{target.label}</td>
                    <td>
                      {result ? (
                        result.ok ? (
                          <span className="ok">salvo ({result.bytes} bytes)</span>
                        ) : (
                          <span className="error">falhou</span>
                        )
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="muted">
                      {result && !result.ok ? result.error : result?.ok ? result.path : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
