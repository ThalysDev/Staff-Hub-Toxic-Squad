import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardCopy, ListChecks, Printer, ShieldQuestion } from 'lucide-react';
import type { Sg5TotalsResult, Sg5VerifyResult } from '@shared/ipc-types';
import { parseCoordList } from '@shared/coords';
import { formatHms } from '@shared/sg4-timing';
import { buildArrivalTimeline, formatCountdown, ganttLayout } from '@shared/sg5-arrivals';
import {
  EMPTY_SG5_VIEW_FILTER,
  distinctCommandTypes,
  filterSg5Result,
  type Sg5ViewFilter,
} from '@shared/sg5-view-filter';
import { useToast } from '../../hooks/useToast';
import Callout from '../../components/Callout';
import PageHeader from '../../components/PageHeader';
import ProgressBar from '../../components/ProgressBar';
import { usePreferences } from '../../hooks/usePreferences';
import { MODULES } from '../../modules';
import Sg5DiffSection from './Sg5DiffSection';

/** Título padrão do documento de conferência (usado também no "Restaurar padrões"). */
const DEFAULT_DOC_TITLE = `OP do ${new Date().toLocaleDateString('pt-BR')}`;

/**
 * Campos persistidos do SG_5 (módulo "sg5"): APENAS o título do documento.
 * Resultados/conferências NÃO são preferências — o snapshot da última conferência
 * é persistido pelo Sg5DiffSection na chave 'ultimaConferencia' deste MESMO módulo.
 * O merge no main é raso por chave, então salvar só { tituloDoc } aqui preserva
 * 'ultimaConferencia' (chave de nome distinto, nunca gravada por esta página).
 */
type Sg5Prefs = {
  tituloDoc: string;
};

function parseEntries(text: string): { playerName: string; coords: string[] }[] {
  const entries: { playerName: string; coords: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = /^([^;]{2,40});((?:\d{1,3}\|\d{1,3})(?:\s+\d{1,3}\|\d{1,3})*\s*)$/.exec(trimmed);
    if (match === null) {
      throw new Error(`Linha inválida (use "nick;coord coord"): "${trimmed.slice(0, 60)}"`);
    }
    entries.push({ playerName: match[1] ?? '', coords: (match[2] ?? '').trim().split(/\s+/) });
  }
  return entries;
}

/** Rótulo pt-BR do tipo de comando no select de filtro (fallback = tipo cru do parser). */
function typeLabel(type: string): string {
  if (type === 'attack') return 'Ataque';
  if (type === 'support') return 'Suporte';
  return type;
}

export default function Sg5Page() {
  const { push } = useToast();
  const moduleInfo = MODULES.find((module) => module.id === 'sg5');
  const [entriesText, setEntriesText] = useState('');
  const [docTitle, setDocTitle] = useState(DEFAULT_DOC_TITLE);
  const [coordsText, setCoordsText] = useState('');
  const [verifyResult, setVerifyResult] = useState<Sg5VerifyResult | null>(null);
  // Filtro de VISUALIZAÇÃO (estado interno, volátil): não afeta coleta nem diff.
  const [viewFilter, setViewFilter] = useState<Sg5ViewFilter>(EMPTY_SG5_VIEW_FILTER);
  const [totalsResult, setTotalsResult] = useState<Sg5TotalsResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'verify' | 'totals' | null>(null);
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);

  // Preferências do módulo: o título do documento sobrevive a F5/reinício
  // (resultados, conferências e o Gantt continuam voláteis).
  const { prefs, savePrefs, resetPrefs } = usePreferences<Sg5Prefs>('sg5', { tituloDoc: DEFAULT_DOC_TITLE });

  // Hidratação única: aplica o título persistido sobre o estado do formulário.
  const prefsHydrated = useRef(false);
  useEffect(() => {
    if (prefs === null || prefsHydrated.current) return;
    prefsHydrated.current = true;
    if (typeof prefs.tituloDoc === 'string') setDocTitle(prefs.tituloDoc);
  }, [prefs]);

  // Persistência com guard: só grava DEPOIS da hidratação — nunca sobrescreve o
  // storage com o default do primeiro render. savePrefs é debounced e o merge
  // no main é raso por chave: 'ultimaConferencia' (gravada pelo Sg5DiffSection
  // no mesmo módulo "sg5") não é tocada por este patch de { tituloDoc }.
  useEffect(() => {
    if (!prefsHydrated.current) return;
    savePrefs({ tituloDoc: docTitle });
  }, [docTitle, savePrefs]);

  useEffect(() => {
    const unsubscribe = window.staffhub.events.onQueueProgress(setProgress);
    return unsubscribe;
  }, []);

  // ---- Filtros de visualização (SG_5): TODAS as vistas (documento, Gantt e
  // contagem) derivam deste `filtered`; o diff continua com o resultado COMPLETO
  // (snapshot histórico — ver comentário no Sg5DiffSection abaixo). ----
  const filtered = useMemo(() => {
    if (verifyResult === null) return null;
    // new Date() capturado AQUI: recomputa o status chegados/pendentes a cada
    // mudança de filtro/resultado (relógio vivo fica por conta do nowTick do Gantt).
    return filterSg5Result(verifyResult, viewFilter, new Date());
  }, [verifyResult, viewFilter]);

  /** Tipos distintos da verificação atual — alimenta o select de tipo. */
  const typeOptions = useMemo(
    () => (verifyResult === null ? [] : distinctCommandTypes(verifyResult)),
    [verifyResult],
  );

  /** Contagem discreta pós-filtro: "X comandos em Y aldeias". */
  const filteredCounts = useMemo(() => {
    if (filtered === null) return { commands: 0, villages: 0 };
    return {
      commands: filtered.villages.reduce((sum, village) => sum + village.commands.length, 0),
      villages: filtered.villages.length,
    };
  }, [filtered]);

  const hasActiveFilter =
    viewFilter.query.trim() !== '' ||
    viewFilter.types.length > 0 ||
    viewFilter.noble !== 'todos' ||
    viewFilter.status !== 'todos';

  // Valor do select de tipo: o motor aceita array, a UI é single-select.
  const selectedType = viewFilter.types.length === 1 ? (viewFilter.types[0] ?? '') : '';

  // ---- Gantt de chegadas (P0-3): timeline absoluta + countdown ao vivo (do FILTRADO) ----
  const timeline = useMemo(() => {
    if (filtered === null) return null;
    return buildArrivalTimeline(
      filtered.villages.map((village) => ({ coord: village.coord, commands: village.commands, loadedAt: village.loadedAt })),
    );
  }, [filtered]);

  /** Régua calculada UMA vez por verificação (não pula a cada segundo). */
  const ganttWindow = useMemo(() => {
    if (timeline === null || timeline.entries.length === 0) return null;
    const first = timeline.entries[0]?.arrivalAt ?? Date.now();
    const last = timeline.entries[timeline.entries.length - 1]?.arrivalAt ?? Date.now();
    const now = Date.now();
    return { from: Math.min(first, now) - 10 * 60_000, to: Math.max(last, now) + 10 * 60_000 };
  }, [timeline]);

  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (ganttWindow === null) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ganttWindow]);

  async function runVerify(): Promise<void> {
    setBusy('verify');
    setError('');
    try {
      const entries = parseEntries(entriesText);
      if (entries.length === 0) throw new Error('Cole as linhas "nick;coord coord" (saída da distribuição do SG4).');
      const result = await window.staffhub.sg5.verify(entries);
      setVerifyResult(result);
      const total = result.villages.reduce((sum, v) => sum + v.commands.length, 0);
      push('ok', `Verificação concluída: ${total} comando(s) em ${result.villages.length} aldeia(s).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    } finally {
      setBusy(null);
    }
  }

  async function runTotals(): Promise<void> {
    setBusy('totals');
    setError('');
    try {
      const coords = parseCoordList(coordsText).map((c) => `${c.x}|${c.y}`);
      if (coords.length === 0) throw new Error('Cole as coordenadas dos alvos (separadas por espaço).');
      const result = await window.staffhub.sg5.totals(coords);
      setTotalsResult(result);
      push('ok', `Totalizador pronto: ${result.totals.length} jogador(es).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      push('error', message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="page">
      <PageHeader
        kicker={moduleInfo !== undefined ? `Módulo ${moduleInfo.id.toUpperCase()} — Fase ${moduleInfo.phase}` : 'Módulo SG5 — Fase 5'}
        title={moduleInfo?.originalLabel ?? 'Conferência de Comandos'}
        description="Verificação alvo-a-alvo dos comandos compartilhados com a liderança, totalizador por jogador e documento imprimível da OP."
      />

      {/* Padrão das páginas de módulo: restaurar sempre visível, direto abaixo
          do cabeçalho — MUTAÇÃO ampla, sempre com confirmação. */}
      <div className="row">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            const confirmed = window.confirm(
              'Restaurar padrões? TODOS os campos salvos deste módulo voltam ao padrão e os resultados na tela somem. Esta ação não pode ser desfeita.',
            );
            if (!confirmed) return;
            setDocTitle(DEFAULT_DOC_TITLE);
            // Reset do módulo "sg5" inteiro (inclui 'ultimaConferencia' do diff —
            // comportamento padrão de "Restaurar padrões do módulo").
            void resetPrefs();
          }}
        >
          Restaurar padrões do módulo
        </button>
      </div>

      <Callout variant="danger" title="Compartilhamento de comandos" icon={ShieldQuestion}>
        <p>
          Os comandos só aparecem se os membros <strong>compartilharem comandos com a liderança</strong> nas
          configurações do jogo.
        </p>
        {/* Detalhe de pacing rebaixado para hint — o conselho ("perto da OP")
            continua visível; o custo técnico fica no tooltip. */}
        <p className="muted" style={{ marginTop: 4, fontSize: 12 }} title="A verificação faz 1 requisição por aldeia (com pacing).">
          Rode perto da OP para dados frescos.
        </p>
      </Callout>

      <section className="page-section" aria-labelledby="sg5-verify-title">
        <h2 className="section-title" id="sg5-verify-title">Verificação de comandos de OP</h2>
        <div className="card">
          <div className="card-body">
            <label className="field">
              <span className="field-label">Título do documento (impressão)</span>
              <input className="input" style={{ maxWidth: 360 }} value={docTitle} onChange={(event) => setDocTitle(event.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Entradas (nick;coordenadas — uma linha por jogador)</span>
              <textarea
                className="textarea"
                rows={4}
                placeholder={'mjmetal;547|381 549|478\nericson123;485|307'}
                value={entriesText}
                onChange={(event) => setEntriesText(event.target.value)}
              />
            </label>
            {error !== '' && <p className="error" role="alert">{error}</p>}
            <div className="row">
              <button type="button" className="btn" onClick={() => void runVerify()} disabled={busy !== null}>
                <ListChecks size={16} aria-hidden="true" />
                {busy === 'verify' ? <><span className="btn-spinner" aria-hidden="true" /> Verificando…</> : 'Obter verificação'}
              </button>
              {busy !== null && progress !== null && (
              <>
              <ProgressBar done={progress.done} total={progress.total} label={progress.label} />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  void window.staffhub.queue
                    .cancel()
                    .then(() => push('info', 'Cancelamento pedido — a coleta para na próxima requisição.'))
                    .catch(() => push('error', 'Não foi possível pedir o cancelamento.'));
                }}
              >
                Cancelar
              </button>
              </>
            )}

            {verifyResult !== null && (
                <button type="button" className="btn btn-ghost" onClick={() => window.print()}>
                  <Printer size={16} aria-hidden="true" />
                  Imprimir documento
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Barra de filtros: só existe com verificação presente; filtro vazio = tudo. */}
      {filtered !== null && (
        <section className="page-section" aria-labelledby="sg5-filter-title">
          <h2 className="section-title" id="sg5-filter-title">Filtros de visualização</h2>
          <div className="card">
            <div className="card-body">
              <div className="row" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
                <label className="field" style={{ flex: '1 1 240px' }}>
                  <span className="field-label">Buscar (jogador, aldeia ou coordenada)</span>
                  <input
                    className="input"
                    value={viewFilter.query}
                    placeholder="nick, nome da aldeia ou x|y"
                    aria-label="Busca da visualização"
                    onChange={(event) => setViewFilter((f) => ({ ...f, query: event.target.value }))}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Tipo</span>
                  <select
                    className="select"
                    value={selectedType}
                    aria-label="Filtro por tipo de comando"
                    onChange={(event) =>
                      setViewFilter((f) => ({ ...f, types: event.target.value === '' ? [] : [event.target.value] }))
                    }
                  >
                    <option value="">Todos</option>
                    {typeOptions.map((type) => (
                      <option key={type} value={type}>{typeLabel(type)}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Nobre</span>
                  <select
                    className="select"
                    value={viewFilter.noble}
                    aria-label="Filtro por nobre"
                    onChange={(event) => setViewFilter((f) => ({ ...f, noble: event.target.value as Sg5ViewFilter['noble'] }))}
                  >
                    <option value="todos">Todos</option>
                    <option value="com">Com nobre</option>
                    <option value="sem">Sem nobre</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Status</span>
                  <select
                    className="select"
                    value={viewFilter.status}
                    aria-label="Filtro por status de chegada"
                    onChange={(event) => setViewFilter((f) => ({ ...f, status: event.target.value as Sg5ViewFilter['status'] }))}
                  >
                    <option value="todos">Todos</option>
                    <option value="chegados">Chegados</option>
                    <option value="pendentes">Pendentes</option>
                  </select>
                </label>
                {hasActiveFilter && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setViewFilter({ ...EMPTY_SG5_VIEW_FILTER })}
                  >
                    Limpar filtros
                  </button>
                )}
                <span className="muted cell-nowrap" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
                  {filteredCounts.commands} comandos em {filteredCounts.villages} aldeia(s)
                </span>
              </div>
            </div>
          </div>
        </section>
      )}

      {filtered !== null && (
        <section className="page-section" aria-labelledby="sg5-doc-heading">
          <h2 className="section-title" id="sg5-doc-heading">Documento de conferência</h2>
          <div className="card sg5-printable">
            <h3 className="sg5-doc-title">{docTitle}</h3>
            {filtered.villages.length === 0 && (
              <p className="muted">Nenhum comando corresponde aos filtros atuais.</p>
            )}
            {filtered.villages.map((village) => (
              <div key={village.coord} className="sg5-village">
                <h4 className="sg5-village-title">{village.coord} — {village.commands.length} comando(s)</h4>
                {village.commands.length === 0 ? (
                  <p className="muted">Nenhum comando compartilhado chegando (ou membro não compartilha).</p>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Comando</th>
                          <th>Tipo</th>
                          <th>Jogador</th>
                          <th>Origem</th>
                          <th>Chegada</th>
                          <th>Chega em</th>
                        </tr>
                      </thead>
                      <tbody>
                        {village.commands.map((command) => (
                          <tr key={command.commandId}>
                            <td>{command.name}{command.hasNoble ? <strong title="Com nobre"> ♛</strong> : null}{command.sizeHint === 'pequeno' && !command.hasNoble ? <span className="muted"> (fake)</span> : null}</td>
                            <td><span className={command.type === 'attack' ? 'error' : 'muted'}>{command.type === 'attack' ? 'Ataque' : 'Suporte'}</span></td>
                            <td className="cell-nowrap">{command.playerName}</td>
                            <td className="cell-nowrap">{command.origin.coord}</td>
                            <td className="cell-nowrap">{command.arrivesAtText}</td>
                            <td className="cell-nowrap">{command.arrivesInText}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {timeline !== null && ganttWindow !== null && (
        <section className="page-section" aria-labelledby="sg5-gantt-title">
          <h2 className="section-title" id="sg5-gantt-title">Gantt de chegadas</h2>
          <div className="card sg5-printable">
            <div className="card-body">
              <div>
                <span className="pill pill--muted">
                  {timeline.entries.length} com horário · {timeline.unresolved} sem timestamp
                </span>
              </div>
              {timeline.entries.length === 0 ? (
                <p className="muted">
                  Nenhum comando com horário em formato máquina — as páginas do jogo trouxeram apenas texto visível
                  (sem data-endtime/data-duration). A conferência por tabela continua acima.
                </p>
              ) : (
                <>
                  {(() => {
                    const layout = ganttLayout(timeline.entries, ganttWindow);
                    const span = ganttWindow.to - ganttWindow.from;
                    const nowPct = Math.max(0, Math.min(100, ((nowTick - ganttWindow.from) / span) * 100));
                    const height = Math.min(Math.max(layout.rows.length, 1), 30) * 16 + 16;
                    return (
                      <div className="sg5-gantt" style={{ height }} role="img" aria-label="Linha do tempo das chegadas dos comandos">
                        <div className="sg5-gantt-now" style={{ left: `${nowPct}%` }} title="agora" />
                        {layout.rows.map((row, index) => (
                          <div
                            key={row.entry.commandId}
                            className={`sg5-gantt-mark${row.entry.hasNoble ? ' sg5-gantt-mark--noble' : row.entry.sizeHint === 'pequeno' && !row.entry.hasNoble ? ' sg5-gantt-mark--fake' : ''}`}
                            style={{ left: `${row.offsetPct}%`, top: `${(index % 30) * 16 + 8}px` }}
                            title={`${formatHms(new Date(row.entry.arrivalAt))} · ${row.entry.coord} · ${row.entry.playerName}${row.entry.hasNoble ? ' · NOBRE' : ''}${row.entry.sizeHint === 'pequeno' && !row.entry.hasNoble ? ' · fake' : ''}`}
                          />
                        ))}
                      </div>
                    );
                  })()}
                  <p className="muted">
                    Traços vermelhos = comandos com nobre · cinza = fakes (ataque pequeno) · a linha vertical é o AGORA.
                    Passe o mouse sobre os traços para ver horário, alvo e jogador.
                  </p>
                  <div className="col" style={{ gap: 4 }}>
                    {timeline.entries
                      .filter((entry) => entry.arrivalAt > nowTick - 60_000)
                      .slice(0, 8)
                      .map((entry) => (
                        <div key={entry.commandId} className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                          <strong className="cell-nowrap">{formatHms(new Date(entry.arrivalAt))}</strong>
                          <span className="cell-nowrap">alvo {entry.coord}</span>
                          <span className="cell-nowrap">{entry.playerName}{entry.hasNoble ? ' ♛' : ''}</span>
                          <span className={entry.arrivalAt < nowTick ? 'muted' : 'ok'}>
                            {formatCountdown(entry.arrivalAt - nowTick)}
                          </span>
                        </div>
                      ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Comparação com a conferência anterior: recebe o resultado COMPLETO,
          SEM o filtro de visualização (é snapshot histórico — filtrá-lo
          corromperia a comparação com a última conferência salva). */}
      <Sg5DiffSection current={verifyResult} />

      <section className="page-section" aria-labelledby="sg5-totals-title">
        <h2 className="section-title" id="sg5-totals-title">Totalizador de comandos</h2>
        <div className="card">
          <div className="card-body">
            <label className="field">
              <span className="field-label">Coordenadas (separadas por espaço)</span>
              <textarea
                className="textarea"
                rows={3}
                placeholder="547|381 549|478 485|307"
                value={coordsText}
                onChange={(event) => setCoordsText(event.target.value)}
              />
            </label>
            <div className="row">
              <button type="button" className="btn" onClick={() => void runTotals()} disabled={busy !== null}>
                {busy === 'totals' ? <><span className="btn-spinner" aria-hidden="true" /> Totalizando…</> : 'Totalizar comandos'}
              </button>
              {totalsResult !== null && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    const text = totalsResult.totals.map((t) => `${t.playerName};ataques=${t.attacks};suportes=${t.supports};total=${t.total}`).join('\n');
                    void navigator.clipboard.writeText(text).then(() => push('ok', 'Resumo copiado.')).catch(() => push('error', 'Não consegui copiar — selecione e use Ctrl+C.'));
                  }}
                >
                  <ClipboardCopy size={14} aria-hidden="true" />
                  Copiar resumo
                </button>
              )}
            </div>
            {totalsResult !== null && (
              // Totalizador NÃO recebe filtro: totalsResult vem de fonte própria (IPC sg5.totals por coordenadas), não do verify local.
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Jogador</th>
                      <th>Ataques</th>
                      <th>Fakes</th>
                      <th>Com nobre</th>
                      <th>Suportes</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {totalsResult.totals.map((total) => (
                      <tr key={total.playerName}>
                        <td>{total.playerName}</td>
                        <td className="cell-nowrap">{total.attacks}</td>
                        <td className="cell-nowrap">{total.fakes}</td>
                        <td className="cell-nowrap">{total.nobleAttacks}</td>
                        <td className="cell-nowrap">{total.supports}</td>
                        <td className="cell-nowrap"><strong>{total.total}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </section>

    </section>
  );
}
