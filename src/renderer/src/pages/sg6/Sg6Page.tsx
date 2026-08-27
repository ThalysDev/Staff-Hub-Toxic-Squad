import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, MapPin } from 'lucide-react';
import type { Sg6MutationOutcome } from '@shared/ipc-types';
import { parseCoordList } from '@shared/coords';
import { previewMps, validateNicks, type MpPreviewEntry, type NickValidation } from '@shared/mp-preview';
import { usePreferences } from '../../hooks/usePreferences';
import { useToast } from '../../hooks/useToast';
import PageHeader from '../../components/PageHeader';
import TemplateLibrary from '../../components/TemplateLibrary';
import ToastViewport from '../../components/Toast';
import { MODULES } from '../../modules';

/** Padrões dos campos persistidos do módulo sg6 (só ENTRADAS: textos da MP e
 * caixas de entrada — resultados/tabelas de envio ficam voláteis). */
const SG6_DEFAULTS = {
  reserveCoords: '',
  mpSubject: '',
  mpBody: '',
  mpEntriesText: '',
};

export default function Sg6Page() {
  const { toasts, push, dismiss } = useToast();
  const moduleInfo = MODULES.find((module) => module.id === 'sg6');
  const { prefs, savePrefs, resetPrefs } = usePreferences('sg6', SG6_DEFAULTS);
  const [reserveCoords, setReserveCoords] = useState(SG6_DEFAULTS.reserveCoords);
  const [reservePending, setReservePending] = useState<string[] | null>(null);
  const [reserveResults, setReserveResults] = useState<Sg6MutationOutcome[] | null>(null);
  const [mpSubject, setMpSubject] = useState(SG6_DEFAULTS.mpSubject);
  const [mpBody, setMpBody] = useState(SG6_DEFAULTS.mpBody);
  const [mpEntriesText, setMpEntriesText] = useState(SG6_DEFAULTS.mpEntriesText);
  const [mpPending, setMpPending] = useState<{ playerName: string; coords: string[]; horarios?: string[] }[] | null>(null);
  const [mpResults, setMpResults] = useState<Sg6MutationOutcome[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Preferências do módulo: formulários sobrevivem a F5/reinício.
  const prefsHydrated = useRef(false);

  // Hidratação (uma única vez, após prefs chegar do main): aplica só as chaves
  // presentes, para não pisar em estado que o usuário já editou.
  useEffect(() => {
    if (prefs === null || prefsHydrated.current) return;
    prefsHydrated.current = true;
    if (typeof prefs.reserveCoords === 'string') setReserveCoords(prefs.reserveCoords);
    if (typeof prefs.mpSubject === 'string') setMpSubject(prefs.mpSubject);
    if (typeof prefs.mpBody === 'string') setMpBody(prefs.mpBody);
    if (typeof prefs.mpEntriesText === 'string') setMpEntriesText(prefs.mpEntriesText);
  }, [prefs]);

  // Persistência com guard: só grava DEPOIS da hidratação — nunca sobrescreve o
  // storage com os defaults vazios do primeiro render. savePrefs é debounced.
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ reserveCoords, mpSubject, mpBody, mpEntriesText });
  }, [reserveCoords, mpSubject, mpBody, mpEntriesText, savePrefs]);

  // Template padrão na 1ª visita: se as prefs hidratadas NÃO trouxeram
  // assunto/corpo (v0.23 já persistia os campos), parte do template marcado
  // como padrão — aplicado UMA única vez (aplicadoDefaultRef). Preferência
  // salva do usuário sempre vence: campos com conteúdo nunca são sobrescritos.
  const aplicadoDefaultRef = useRef(false);

  useEffect(() => {
    if (prefs === null || aplicadoDefaultRef.current) return;
    if (prefs.mpSubject !== '' || prefs.mpBody !== '') {
      aplicadoDefaultRef.current = true;
      return;
    }
    let cancelled = false;
    void window.staffhub.templates
      .list()
      .then((templates) => {
        if (cancelled || aplicadoDefaultRef.current) return;
        aplicadoDefaultRef.current = true;
        const defaultTemplate = templates.find((template) => template.isDefault);
        if (defaultTemplate === undefined) return;
        setMpSubject(defaultTemplate.subject ?? '');
        setMpBody(defaultTemplate.body);
      })
      .catch(() => {
        // Fail-soft (IPC fora/erro): campos seguem como estão e não repete.
        aplicadoDefaultRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [prefs]);

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
    <section className="page">
      <PageHeader
        kicker={moduleInfo !== undefined ? `Módulo ${moduleInfo.id.toUpperCase()} — Fase ${moduleInfo.phase}` : 'Módulo SG6 — Fase 6'}
        title={moduleInfo?.originalLabel ?? 'Reservas e MPs'}
        description="Reserva em massa no planejador da tribo e MPs personalizadas em cadeia, sempre com confirmação dupla."
      />

      <div className="row">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setReserveCoords(SG6_DEFAULTS.reserveCoords);
            setMpSubject(SG6_DEFAULTS.mpSubject);
            setMpBody(SG6_DEFAULTS.mpBody);
            setMpEntriesText(SG6_DEFAULTS.mpEntriesText);
            void resetPrefs();
          }}
        >
          Restaurar padrões do módulo
        </button>
      </div>

      <div className="callout callout--warn" role="note">
        <KeyRound size={18} className="callout-icon" aria-hidden="true" />
        <div className="callout-body">
          <p className="callout-title">Mutações reais</p>
          <p>
            Estas ações <strong>alteram o jogo de verdade</strong> (modo real permanente). Cada uma exige
            confirmação dupla, faz <strong>uma única tentativa</strong> por item com pacing humano e guarda tudo no
            Journal para auditoria.
          </p>
        </div>
      </div>

      <section className="page-section" aria-labelledby="sg6-reserve-title">
        <h2 className="section-title" id="sg6-reserve-title">Reserva em Massa (Planejador)</h2>
        <div className="card">
          <div className="card-body">
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
              <div>
                <button
                  type="button"
                  className="btn btn-danger"
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
              </div>
            ) : (
              <div className="sg6-confirm">
                <p>
                  Confirmar reserva em massa de <strong>{reservePending.length}</strong> aldeia(s)? Ação REAL no
                  jogo — cada uma faz 1 tentativa; “já reservada” é tolerada.
                </p>
                <div className="row">
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void runReserve(reservePending)}>
                    {busy ? <><span className="btn-spinner" aria-hidden="true" /> Enviando…</> : 'Confirmar reserva em massa'}
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
          </div>
        </div>
      </section>

      <section className="page-section" aria-labelledby="sg6-mps-title">
        <h2 className="section-title" id="sg6-mps-title">MPs Personalizadas em Cadeia</h2>
        <TemplateLibrary
          variant="sg6"
          currentSubject={mpSubject}
          currentBody={mpBody}
          onApply={(subject, body) => {
            setMpSubject(subject);
            setMpBody(body);
          }}
        />
        <div className="card">
          <div className="card-body">
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
            <div className="field">
              <label className="field-label" htmlFor="sg6-mp-entries">Destinatários (um por linha)</label>
              <textarea
                id="sg6-mp-entries"
                className="textarea"
                rows={3}
                placeholder={'nick;123|456 456|789;22:00:00,22:00:05\nnick;485|307'}
                value={mpEntriesText}
                aria-describedby="sg6-mp-entries-hint"
                onChange={(event) => setMpEntriesText(event.target.value)}
              />
              <p className="field-hint" id="sg6-mp-entries-hint">
                Formato: nick;coordenadas e, com a agenda do SG4, também os horários.
              </p>
            </div>
            {mpPending === null ? (
              <div>
                <button
                  type="button"
                  className="btn btn-danger"
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
              </div>
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
                    {busy ? <><span className="btn-spinner" aria-hidden="true" /> Enviando…</> : 'Confirmar envio'}
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
          </div>
        </div>
      </section>

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </section>
  );
}
