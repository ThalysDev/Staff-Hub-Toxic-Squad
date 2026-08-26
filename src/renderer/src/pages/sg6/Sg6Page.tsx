import { useEffect, useMemo, useState } from 'react';
import { KeyRound, MapPin } from 'lucide-react';
import type { Sg6MutationOutcome } from '@shared/ipc-types';
import { parseCoordList } from '@shared/coords';
import { previewMps, validateNicks, type MpPreviewEntry, type NickValidation } from '@shared/mp-preview';
import { useToast } from '../../hooks/useToast';
import ToastViewport from '../../components/Toast';

export default function Sg6Page() {
  const { toasts, push, dismiss } = useToast();
  const [reserveCoords, setReserveCoords] = useState('');
  const [reservePending, setReservePending] = useState<string[] | null>(null);
  const [reserveResults, setReserveResults] = useState<Sg6MutationOutcome[] | null>(null);
  const [mpSubject, setMpSubject] = useState('');
  const [mpBody, setMpBody] = useState('');
  const [mpEntriesText, setMpEntriesText] = useState('');
  const [mpPending, setMpPending] = useState<{ playerName: string; coords: string[]; horarios?: string[] }[] | null>(null);
  const [mpResults, setMpResults] = useState<Sg6MutationOutcome[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // U5: validação dos nicks contra o dump do mundo (players), para o painel de
  // confirmação. Sem dump disponível, a validação fica best-effort (aviso).
  const [nickValidation, setNickValidation] = useState<{ validation: NickValidation; source: 'dump' } | { validation: null; source: 'indisponivel' } | null>(null);

  useEffect(() => {
    if (mpPending === null) {
      setNickValidation(null);
      return;
    }
    let cancelled = false;
    void window.staffhub.world
      .players()
      .then((players) => {
        if (!cancelled) setNickValidation({ validation: validateNicks(mpPending, players.map((player) => player.name)), source: 'dump' });
      })
      .catch(() => {
        if (!cancelled) setNickValidation({ validation: null, source: 'indisponivel' });
      });
    return () => {
      cancelled = true;
    };
  }, [mpPending]);

  /**
   * Prévia EXATA da 1ª MP (mesma substituição do envio real). Fail-closed em
   * render: se a combinação template×entradas não compila (ex.: #horarios#
   * sem horários), o erro aparece inline e o Confirmar fica travado —
   * NUNCA lançar durante o render (derrubaria o app).
   */
  const firstMpPreview = useMemo<{ preview: MpPreviewEntry | null; error: string }>(() => {
    if (mpPending === null || mpPending.length === 0) return { preview: null, error: '' };
    try {
      return { preview: previewMps(mpSubject, mpBody, mpPending, 1)[0] ?? null, error: '' };
    } catch (error) {
      return { preview: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [mpPending, mpSubject, mpBody]);

  const blockUnknownNicks = nickValidation?.source === 'dump' && nickValidation.validation !== null && nickValidation.validation.unknown.length > 0;
  /** Fail-closed em mutação REAL: Confirmar fica travado ENQUANTO a validação
   * de nicks está em voo (nunca "habilitado até provar problema"). */
  const validatingNicks = mpPending !== null && nickValidation === null;

  function parseMpEntries(text: string): { playerName: string; coords: string[]; horarios?: string[] }[] {
    const entries: { playerName: string; coords: string[]; horarios?: string[] }[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      // 3º bloco opcional: horários "HH:MM:SS,HH:MM:SS" (saída do Pacote de
      // Comunicação do SG_4) substitui #horarios# no corpo.
      const match = /^([^;]{2,40});((?:\d{1,3}\|\d{1,3})(?:\s+\d{1,3}\|\d{1,3})*\s*)(?:;((?:\d{2}:\d{2}:\d{2})(?:,\d{2}:\d{2}:\d{2})*))?$/.exec(trimmed);
      if (match === null) throw new Error(`Linha inválida (use "nick;coord coord[;HH:MM:SS,HH:MM:SS]"): "${trimmed.slice(0, 60)}"`);
      const horariosRaw = match[3];
      entries.push({
        playerName: match[1] ?? '',
        coords: (match[2] ?? '').trim().split(/\s+/),
        ...(horariosRaw !== undefined ? { horarios: horariosRaw.split(',') } : {}),
      });
    }
    return entries;
  }

  async function runReserve(coords: string[]): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const results = await window.staffhub.sg6.reserveMass(coords, true);
      setReserveResults(results);
      const okCount = results.filter((r) => r.ok === true).length;
      push('ok', `Reservas: ${okCount} ok, ${results.length - okCount} com aviso (veja o detalhe).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    } finally {
      setReservePending(null);
      setBusy(false);
    }
  }

  async function runMps(entries: { playerName: string; coords: string[]; horarios?: string[] }[]): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const results = await window.staffhub.sg6.sendMps({ subject: mpSubject, body: mpBody, entries }, true);
      setMpResults(results);
      const sent = results.filter((r) => r.ok === true).length;
      push('ok', `MPs: ${sent} enviadas, ${results.length - sent} com problema.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    } finally {
      setMpPending(null);
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <header className="page-header">
        <div>
          <p className="kicker">Reservas e MPs</p>
          <h1>Reservas e MPs</h1>
        </div>
      </header>

      <div className="callout" role="note">
        <KeyRound size={16} aria-hidden="true" />
        <span>
          Estas ações <strong>alteram o jogo de verdade</strong> (modo real permanente). Cada uma exige
          confirmação dupla, faz <strong>uma única tentativa</strong> por item com pacing humano e guarda tudo no
          Journal para auditoria.
        </span>
      </div>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Reserva em Massa (Planejador)</h2>
        </div>
        <label className="field">
          <span className="field-label">Coordenadas para Reservar (123|456 456|789)</span>
          <textarea
            className="textarea"
            rows={3}
            placeholder="123|456 456|789 111|222"
            value={reserveCoords}
            onChange={(event) => setReserveCoords(event.target.value)}
          />
        </label>
        {error !== '' && <p className="error" role="alert">{error}</p>}
        {reservePending === null ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              try {
                const coords = parseCoordList(reserveCoords).map((c) => `${c.x}|${c.y}`);
                if (coords.length === 0) throw new Error('Cole ao menos uma coordenada.');
                setError('');
                setReservePending(coords);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            <MapPin size={16} aria-hidden="true" />
            Reservar
          </button>
        ) : (
          <div className="sg6-confirm">
            <p>
              Confirmar reserva em massa de <strong>{reservePending.length}</strong> aldeia(s)? Ação REAL no
              jogo — cada uma faz 1 tentativa; “já reservada” é tolerada.
            </p>
            <div className="row">
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void runReserve(reservePending)}>
                {busy ? <><span className="btn-spinner" aria-hidden="true" /> Enviando…</> : 'Confirmar Reserva em Massa'}
              </button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setReservePending(null)}>
                Cancelar
              </button>
            </div>
          </div>
        )}
        {reserveResults !== null && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Aldeia</th>
                  <th>Resultado</th>
                  <th>Detalhe</th>
                </tr>
              </thead>
              <tbody>
                {reserveResults.map((result) => (
                  <tr key={result.coord}>
                    <td className="cell-nowrap">{result.coord}</td>
                    <td>{result.ok ? <span className="ok">Enviado</span> : <span className="error">Falhou</span>}</td>
                    <td className="cell-detail">{result.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">MPs Personalizadas em Cadeia</h2>
        </div>
        <label className="field">
          <span className="field-label">Assunto</span>
          <input className="input" value={mpSubject} onChange={(event) => setMpSubject(event.target.value)} placeholder="OP — seus alvos" />
        </label>
        <label className="field">
          <span className="field-label">Corpo da mensagem (use #alvos# onde entram as coordenadas do jogador)</span>
          <textarea
            className="textarea"
            rows={4}
            placeholder={'Olá! Seguem seus alvos para a operação:\n#alvos#\nBoa sorte!'}
            value={mpBody}
            onChange={(event) => setMpBody(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">
            Destinatários (nick;coordenadas[;horários] — nick EXATO do jogo, um por linha; horários opcionais no formato HH:MM:SS,HH:MM:SS)
          </span>
          <textarea
            className="textarea"
            rows={3}
            placeholder={'mjmetal;547|381 549|478;22:00:00,22:00:05\nericson123;485|307'}
            value={mpEntriesText}
            onChange={(event) => setMpEntriesText(event.target.value)}
          />
        </label>
        {mpPending === null ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              try {
                if (!mpBody.includes('#alvos#') && !mpBody.includes('#horarios#')) {
                  throw new Error('O corpo precisa conter #alvos# e/ou #horarios#.');
                }
                const entries = parseMpEntries(mpEntriesText);
                if (entries.length === 0) throw new Error('Cole as linhas "nick;coords".');
                // Fail-closed no clique: TODAS as entradas precisam compilar
                // (ex.: #horarios# exige o 3º bloco em cada linha) antes de
                // abrir o painel de confirmação.
                previewMps(mpSubject, mpBody, entries);
                setError('');
                setMpPending(entries);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            Enviar MPs
          </button>
        ) : (
          <div className="sg6-confirm">
            <p>
              Confirmar envio de <strong>{mpPending.length}</strong> MP(s)? Nick tem de bater exatamente; envio
              sequencial com pacing humano.
            </p>
            {firstMpPreview.error !== '' && (
              <p className="error" role="alert">{firstMpPreview.error}</p>
            )}
            {firstMpPreview.preview !== null && (
              <div className="sg6-preview">
                <p className="field-label">Prévia da 1ª MP ({firstMpPreview.preview.playerName}) — #alvos#/#horarios# já substituídos:</p>
                <pre className="sg7-code">{`Assunto: ${firstMpPreview.preview.subject}\n\n${firstMpPreview.preview.body}`}</pre>
              </div>
            )}
            {nickValidation !== null && nickValidation.source === 'dump' && nickValidation.validation !== null && (
              <div className="sg6-nick-check">
                <p className="field-label">Nicks contra o dump do mundo:</p>
                <ul className="sg6-nick-list">
                  {nickValidation.validation.caseMismatch.map((mismatch) => (
                    <li key={mismatch.given} className="text-warn">
                      ⚠ {mismatch.given} — no jogo consta “{mismatch.known}” (MP diferencia maiúsculas!)
                    </li>
                  ))}
                  {nickValidation.validation.unknown.map((nick) => (
                    <li key={nick} className="error">
                      ✕ {nick} — não existe no dump do mundo
                    </li>
                  ))}
                  {nickValidation.validation.valid.length > 0 && (
                    <li className="ok">✓ {nickValidation.validation.valid.length} nick(s) confirmados no dump</li>
                  )}
                </ul>
                {blockUnknownNicks && (
                  <p className="error" role="alert">
                    Há nick(s) que NÃO existem no dump — corrija as linhas antes de enviar (MP para nick errado não entrega).
                  </p>
                )}
              </div>
            )}
            {nickValidation !== null && nickValidation.source === 'indisponivel' && (
              <p className="muted">Não foi possível validar os nicks contra o dump do mundo (dump não baixado?) — revise manualmente.</p>
            )}
            {validatingNicks && <p className="muted">Validando nicks contra o dump do mundo…</p>}
            <div className="row">
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy || validatingNicks || blockUnknownNicks || firstMpPreview.error !== ''}
                onClick={() => void runMps(mpPending)}
              >
                {busy ? <><span className="btn-spinner" aria-hidden="true" /> Enviando…</> : 'Confirmar Envio'}
              </button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setMpPending(null)}>
                Cancelar
              </button>
            </div>
          </div>
        )}
        {mpResults !== null && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Jogador</th>
                  <th>Resultado</th>
                  <th>Detalhe</th>
                </tr>
              </thead>
              <tbody>
                {mpResults.map((result) => (
                  <tr key={result.playerName}>
                    <td className="cell-nowrap">{result.playerName}</td>
                    <td>{result.ok ? <span className="ok">Enviada</span> : <span className="error">Falhou</span>}</td>
                    <td className="cell-detail">{result.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
