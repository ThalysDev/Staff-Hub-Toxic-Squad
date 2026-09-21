import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { RefreshCw } from 'lucide-react';
import type { OdaOddRefreshResult, OdaOddStatus } from '@shared/ipc-types';
import { buildOdaOddHistory } from '@shared/oda-odd';
import EmptyState from '../../components/EmptyState';
import { usePreferences } from '../../hooks/usePreferences';
import { useToast } from '../../hooks/useToast';

/**
 * Sala de Guerra (Monitoramento) — "◆ OD de guerra": curva de kills ofensivos
 * (ODA) e defensivos (ODD) da tribo, a partir dos dumps oficiais do mundo
 * (kill_att/def_tribe.txt.gz). Seção autossuficiente (sem props): o ID da
 * tribo persiste nas preferências do módulo 'guerra' (chave odaTribeId) e o
 * histórico vem do store 'oda-odd' via oda:status (sem rede). "Atualizar ODs"
 * chama oda:refresh — a guarda de 1 download/hora/arquivo é do serviço, que
 * devolve por arquivo se o número veio de download novo ou do cache.
 * Os deltas (curva da guerra) são calculados pelo motor puro '@shared/oda-odd'.
 */

const NUMBER_FMT = new Intl.NumberFormat('pt-BR');

/** Linha da tabela: uma leitura (att/def emparelhados pelo fim do histórico). */
interface OdaRow {
  date: string;
  attKills: number | null;
  attDelta: number | null;
  defKills: number | null;
  defDelta: number | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Falha de comunicação com o processo principal.';
}

/** Data legível e à prova de ISO malformado (nunca "Invalid Date" na tela). */
function formatQuando(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('pt-BR');
}

/** Delta com sinal explícito: +1.234 / −500 / ±0 (Intl pt-BR nos valores). */
function formatSigned(value: number): string {
  if (value > 0) return `+${NUMBER_FMT.format(value)}`;
  if (value < 0) return `−${NUMBER_FMT.format(Math.abs(value))}`;
  return '±0';
}

/** Mensagem pós-refresh por arquivo: novo download vs cache (guarda de 1h). */
function describeOutcomes(result: OdaOddRefreshResult): string {
  return result.outcomes
    .map((outcome) => {
      const label = outcome.kind === 'att' ? 'ODA' : 'ODD';
      const value =
        outcome.delta === null
          ? `1ª leitura (${NUMBER_FMT.format(outcome.kills)} kills)`
          : formatSigned(outcome.delta);
      const source = outcome.source === 'cache' ? 'cache — limite de 1 download/hora' : 'baixado agora';
      return `${label}: ${value} (${source})`;
    })
    .join(' · ');
}

export default function OdaOddSection(): JSX.Element {
  const { push } = useToast();
  // Mesmo módulo 'guerra' da aba (salaTab) — merge raso por chave no main,
  // então odaTribeId convive com as preferências das outras seções.
  const { prefs, savePrefs } = usePreferences<{ odaTribeId: string }>('guerra', { odaTribeId: '' });
  const [tribeInput, setTribeInput] = useState('');
  const [status, setStatus] = useState<OdaOddStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Resumo do último refresh (cache vs baixado) — vazio até o 1º clique. */
  const [lastOutcome, setLastOutcome] = useState('');
  const hydrated = useRef(false);

  // Hidrata o input com o ID persistido (uma única vez).
  useEffect(() => {
    if (prefs === null || hydrated.current) return;
    hydrated.current = true;
    setTribeInput(prefs.odaTribeId);
  }, [prefs]);

  // Estado local (sem rede) no mount e após cada refresh.
  useEffect(() => {
    let cancelled = false;
    window.staffhub.oda
      .status()
      .then((loaded) => {
        if (!cancelled) setStatus(loaded);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = errorMessage(err);
        setError(message);
        push('error', message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Tabela do histórico: mais recente primeiro, Δ vs a leitura anterior.
   *  att e def são emparelhados pelo FIM dos arrays (leituras em ordem
   *  cronológica, recente no fim — convenção do store). */
  const rows = useMemo<OdaRow[]>(() => {
    if (status === null) return [];
    const { att, def } = status.history;
    if (att.length === 0 && def.length === 0) return [];
    const tribeLabel = `tribe ${status.allyTribeId ?? '?'}`;
    const attRows = att.length > 0 ? buildOdaOddHistory(att, tribeLabel) : [];
    const defRows = def.length > 0 ? buildOdaOddHistory(def, tribeLabel) : [];
    const total = Math.max(attRows.length, defRows.length);
    const merged: OdaRow[] = [];
    for (let offset = 1; offset <= total; offset += 1) {
      const a = attRows[attRows.length - offset];
      const d = defRows[defRows.length - offset];
      if (a === undefined && d === undefined) continue;
      merged.push({
        date: (a ?? d)!.date,
        attKills: a?.kills ?? null,
        attDelta: a?.delta ?? null,
        defKills: d?.kills ?? null,
        defDelta: d?.delta ?? null,
      });
    }
    return merged;
  }, [status]);

  // Totais = última leitura de cada arquivo (kills é cumulativo no mundo).
  const attTotal = status?.history.att[status.history.att.length - 1]?.kills ?? null;
  const defTotal = status?.history.def[status.history.def.length - 1]?.kills ?? null;

  async function refresh(): Promise<void> {
    const trimmed = tribeInput.trim();
    const tribeId = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(tribeId) || tribeId <= 0 || String(tribeId) !== trimmed) {
      const message = 'Informe o ID numérico da tribo (sem pontos) — ver o perfil da tribo no jogo.';
      setError(message);
      push('error', message);
      return;
    }
    setBusy(true);
    setError('');
    try {
      savePrefs({ odaTribeId: trimmed });
      const result = await window.staffhub.oda.refresh(tribeId);
      const summary = describeOutcomes(result);
      setLastOutcome(summary);
      push('ok', summary);
      setStatus(await window.staffhub.oda.status());
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      push('error', message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="oda-odd-title">
      <div className="card-header">
        <h2 className="card-title" id="oda-odd-title">◆ OD de guerra</h2>
        <span className="spacer" />
        {status !== null && status.world !== null && (
          <span className="pill pill--muted">{status.world}</span>
        )}
      </div>
      <div className="card-body col" style={{ gap: 12 }}>
        <p className="muted">
          Kills ofensivos (ODA) e defensivos (ODD) da tribo nos dumps oficiais do mundo — cada
          atualização arquiva um snapshot e o Δ mostra kills ganhos/perdidos desde a leitura
          anterior. A API do jogo permite 1 download por hora por arquivo: dentro dessa janela o
          número vem do cache.
        </p>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ margin: 0, maxWidth: 200 }}>
            <span className="field-label">ID da tribo</span>
            <input
              className="input"
              inputMode="numeric"
              placeholder="ex.: 123"
              aria-label="ID da tribo (ver o perfil da tribo no jogo)"
              value={tribeInput}
              onChange={(event) => setTribeInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !busy) void refresh();
              }}
            />
          </label>
          <button type="button" className="btn" onClick={() => void refresh()} disabled={busy}>
            {busy ? (
              <>
                <span className="btn-spinner" aria-hidden="true" /> Atualizando…
              </>
            ) : (
              <>
                <RefreshCw size={15} aria-hidden="true" /> Atualizar ODs
              </>
            )}
          </button>
          {lastOutcome !== '' && <span className="pill pill--muted">{lastOutcome}</span>}
        </div>

        {error !== '' && <p className="error" role="alert">{error}</p>}

        {rows.length === 0 ? (
          <EmptyState
            compact
            icon={RefreshCw}
            title="Sem leituras de OD ainda"
            hint="Informe o ID da tribo (ver perfil da tribo no jogo) e atualize."
          />
        ) : (
          <div className="col" style={{ gap: 8 }}>
            <div className="table-wrap">
              <table className="table" aria-label="Histórico de kills da tribo por leitura (mais recente primeiro)">
                <thead>
                  <tr>
                    <th scope="col">Data</th>
                    <th scope="col" className="cell-num">ODA (Δ)</th>
                    <th scope="col" className="cell-num">ODD (Δ)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.date}>
                      <td className="cell-nowrap">{formatQuando(row.date)}</td>
                      <td className="cell-num">
                        {row.attKills === null ? (
                          '—'
                        ) : (
                          <>
                            {NUMBER_FMT.format(row.attKills)}
                            {row.attDelta !== null && (
                              <span className={row.attDelta >= 0 ? 'ok' : 'error'}> ({formatSigned(row.attDelta)})</span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="cell-num">
                        {row.defKills === null ? (
                          '—'
                        ) : (
                          <>
                            {NUMBER_FMT.format(row.defKills)}
                            {row.defDelta !== null && (
                              <span className={row.defDelta >= 0 ? 'ok' : 'error'}> ({formatSigned(row.defDelta)})</span>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted">
              ODA total: {attTotal === null ? '—' : NUMBER_FMT.format(attTotal)} · ODD total:{' '}
              {defTotal === null ? '—' : NUMBER_FMT.format(defTotal)}
              {status !== null && (status.lastFetch.att !== '' || status.lastFetch.def !== '') && (
                <>
                  {' '}· último download: ODA {status.lastFetch.att === '' ? 'nunca' : formatQuando(status.lastFetch.att)} · ODD{' '}
                  {status.lastFetch.def === '' ? 'nunca' : formatQuando(status.lastFetch.def)}
                </>
              )}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
