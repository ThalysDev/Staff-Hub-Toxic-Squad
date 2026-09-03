import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, JSX } from 'react';
import { GitCompare, TrendingDown, TrendingUp } from 'lucide-react';
import type { Sg5VerifyResult } from '@shared/ipc-types';
import { diffConferences } from '@shared/sg5-diff';
import type { ConferenceCommand, ConferenceDiff, ConferenceSnapshot } from '@shared/sg5-diff';
import Callout from '../../components/Callout';

/**
 * SG_5 — seção "Comparação com a Conferência Anterior".
 * Consome o motor puro e testado '@shared/sg5-diff' (diffConferences):
 * comandos novos/ cancelados (identidade = commandId), alvos que apareceram/
 * sumiram e a variação de cobertura por alvo.
 *
 * A conferência "anterior" da próxima comparação é registrada automaticamente
 * a cada verificação (efeito controlado por REFERÊNCIA do `current`; a
 * persistência é controlada pela STRING JSON da última salva — nunca salvar em
 * useMemo, nunca em loop):
 *  1. preferências `preferences.get('sg5').ultimaConferencia` — quando o JSON
 *     couber no limite de 20.000 caracteres;
 *  2. senão, memória da sessão da página (o SG_5 é keep-mounted e sobrevive à
 *     navegação). Após reiniciar o aplicativo, a comparação usa a conferência
 *     persistida quando couber (documentado no callout/ nota da seção).
 */

/** Limite de caracteres do JSON persistido em preferences ('sg5'.ultimaConferencia). */
const MAX_PERSIST_CHARS = 20_000;

/** De onde veio a conferência usada como "anterior" na comparação exibida. */
type PreviousSource = 'sessao' | 'persistida';

const SOURCE_LABEL: Record<PreviousSource, string> = {
  sessao: 'memória da sessão',
  persistida: 'preferências (sessão anterior)',
};

/** Par capturado a cada `current` novo: o atual + o anterior efetivo (se houver). */
interface CapturedPair {
  current: ConferenceSnapshot;
  previous: ConferenceSnapshot | null;
  previousSource: PreviousSource | null;
}

/** Resultado do último clique em "Comparar" (explícito — nunca automático). */
interface CompareReport {
  diff: ConferenceDiff;
  /** Comandos do snapshot ATUAL por commandId (para tipo dos comandos novos). */
  currentCommands: Map<number, ConferenceCommand>;
  /** Comandos do snapshot ANTERIOR por commandId (para tipo dos cancelados). */
  previousCommands: Map<number, ConferenceCommand>;
}

export interface Sg5DiffSectionProps {
  /** Resultado da verificação ATUAL no SG_5 (mesmo objeto do estado da página); null se nenhuma. */
  current: Sg5VerifyResult | null;
}

/** Guarda estrutural leve do resultado do sg5.verify (defesa contra IPC estranho). */
function isValidVerifyResult(value: unknown): value is Sg5VerifyResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Sg5VerifyResult>;
  return typeof candidate.generatedAt === 'string' && candidate.generatedAt !== '' && Array.isArray(candidate.villages);
}

/** Sg5VerifyResult → ConferenceSnapshot: só os campos que o motor compara
 * (descarta loadedAt/origin/arrival — JSON menor, mais chance de caber no limite). */
function toConferenceSnapshot(result: Sg5VerifyResult): ConferenceSnapshot {
  return {
    generatedAt: result.generatedAt,
    villages: result.villages.map((village) => ({
      coord: village.coord,
      commands: village.commands.map((command) => ({
        playerName: command.playerName,
        commandId: command.commandId,
        hasNoble: command.hasNoble,
        sizeHint: command.sizeHint,
      })),
    })),
  };
}

/** Revalida a conferência persistida (fail-closed: valor estranho ⇒ null ⇒ cai
 * para a memória da sessão). Corrupção mais profunda vira erro PT-BR do motor
 * no momento da comparação (try/catch → callout de erro). */
function parsePersistedSnapshot(value: unknown): ConferenceSnapshot | null {
  if (typeof value !== 'string' || value === '' || value.length > MAX_PERSIST_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as { generatedAt?: unknown; villages?: unknown };
  if (typeof record.generatedAt !== 'string' || record.generatedAt === '') return null;
  if (!Array.isArray(record.villages)) return null;
  const villages: ConferenceSnapshot['villages'] = [];
  for (const village of record.villages) {
    if (typeof village !== 'object' || village === null) return null;
    const villageRecord = village as { coord?: unknown; commands?: unknown };
    if (typeof villageRecord.coord !== 'string' || !Array.isArray(villageRecord.commands)) return null;
    const commands: ConferenceCommand[] = [];
    for (const command of villageRecord.commands) {
      if (typeof command !== 'object' || command === null) return null;
      const commandRecord = command as {
        playerName?: unknown;
        commandId?: unknown;
        hasNoble?: unknown;
        sizeHint?: unknown;
      };
      if (typeof commandRecord.playerName !== 'string') return null;
      if (typeof commandRecord.commandId !== 'number') return null;
      if (typeof commandRecord.hasNoble !== 'boolean') return null;
      if (commandRecord.sizeHint !== null && typeof commandRecord.sizeHint !== 'string') return null;
      commands.push({
        playerName: commandRecord.playerName,
        commandId: commandRecord.commandId,
        hasNoble: commandRecord.hasNoble,
        sizeHint: commandRecord.sizeHint,
      });
    }
    villages.push({ coord: villageRecord.coord, commands });
  }
  return { generatedAt: record.generatedAt, villages };
}

/** Índice commandId → comando de um snapshot (para a coluna "Tipo" das tabelas). */
function commandsById(snapshot: ConferenceSnapshot): Map<number, ConferenceCommand> {
  const map = new Map<number, ConferenceCommand>();
  for (const village of snapshot.villages) {
    for (const command of village.commands) map.set(command.commandId, command);
  }
  return map;
}

/** Tipo resumido do comando no snapshot (o diff não carrega sizeHint dos cancelados). */
function describeTipo(command: ConferenceCommand | undefined): string {
  if (command === undefined) return '—';
  if (command.hasNoble) return 'Nobre';
  if (command.sizeHint === 'pequeno') return 'Fake';
  return 'Ataque';
}

function formatStamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('pt-BR');
}

const CARD_STYLE: CSSProperties = {
  border: '1px solid var(--divider)',
  borderRadius: 8,
  padding: '10px 12px',
};

export default function Sg5DiffSection({ current }: Sg5DiffSectionProps): JSX.Element {
  /** "Anterior" efetivo para o `current` exibido (persistida ⇒ memória da sessão). */
  const [captured, setCaptured] = useState<CapturedPair | null>(null);
  const [report, setReport] = useState<CompareReport | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  // ---- Refs de controle (nunca estado: evitam loop de efeito) ----
  /** Última conferência vista nesta sessão — "anterior para a PRÓXIMA comparação". */
  const sessionPrevRef = useRef<ConferenceSnapshot | null>(null);
  /** Conferência persistida carregada no mount (só se couber no limite). */
  const persistedPrevRef = useRef<ConferenceSnapshot | null>(null);
  /** Referência do `current` já processado (gate do efeito — evita StrictMode/re-render). */
  const lastCurrentRef = useRef<Sg5VerifyResult | null>(null);
  /** JSON da última conferência SALVA com sucesso (gate da persistência, por string). */
  const savedJsonRef = useRef<string | null>(null);

  // ---- Mount: carrega a conferência persistida (quando couber no limite) ----
  useEffect(() => {
    let active = true;
    void window.staffhub.preferences
      .get('sg5')
      .then((prefs) => {
        if (!active) return;
        const persisted = parsePersistedSnapshot(prefs['ultimaConferencia']);
        if (persisted === null) return;
        persistedPrevRef.current = persisted;
        // Prefs chegaram depois de um `current` já capturado sem anterior
        // (raro: verificação antes do IPC responder) — completa o par.
        setCaptured((cur) =>
          cur !== null && cur.previous === null ? { ...cur, previous: persisted, previousSource: 'persistida' } : cur,
        );
      })
      .catch((error: unknown) => {
        console.warn('[Sg5DiffSection] Não foi possível ler a última conferência persistida:', error);
      });
    return () => {
      active = false;
    };
  }, []);

  // ---- `current` novo (por REFERÊNCIA): guarda como anterior da PRÓXIMA comparação ----
  useEffect(() => {
    if (!isValidVerifyResult(current)) return;
    if (lastCurrentRef.current === current) return; // mesma referência (StrictMode/re-render) — já capturado
    lastCurrentRef.current = current;

    const snapshot = toConferenceSnapshot(current);
    // Captura o anterior ANTES de sobrescrever a sessão (persistida é o fallback).
    const sessionPrev = sessionPrevRef.current;
    const previous = sessionPrev ?? persistedPrevRef.current;
    const previousSource: PreviousSource | null =
      sessionPrev !== null ? 'sessao' : previous !== null ? 'persistida' : null;
    sessionPrevRef.current = snapshot;

    setCaptured({ current: snapshot, previous, previousSource });
    setReport(null); // comparação anterior não descreve mais o estado atual
    setDiffError(null);

    // Persistência (fora de useMemo; gate por JSON da última salva; silenciosa).
    const json = JSON.stringify(snapshot);
    if (savedJsonRef.current === json) return; // mesmo conteúdo já persistido
    if (json.length > MAX_PERSIST_CHARS) return; // não couber — fica só na sessão
    void window.staffhub.preferences
      .save('sg5', { ultimaConferencia: json })
      .then(() => {
        savedJsonRef.current = json;
      })
      .catch((error: unknown) => {
        console.warn('[Sg5DiffSection] Persistência da última conferência falhou (seguindo só na sessão):', error);
      });
  }, [current]);

  /** Compara o par capturado; erro de validação do motor vira callout--danger. */
  function runCompare(): void {
    if (captured === null || captured.previous === null) return;
    setDiffError(null);
    try {
      const diff = diffConferences(captured.previous, captured.current);
      setReport({
        diff,
        currentCommands: commandsById(captured.current),
        previousCommands: commandsById(captured.previous),
      });
    } catch (error) {
      setReport(null);
      setDiffError(error instanceof Error ? error.message : String(error));
    }
  }

  const hasCurrent = isValidVerifyResult(current);
  const canCompare = captured !== null && captured.previous !== null;
  const isFirstConference = captured !== null && captured.previous === null;
  const totalDelta =
    report?.diff.coverageDelta.reduce((sum, entry) => sum + (entry.after - entry.before), 0) ?? 0;
  const unchanged =
    report !== null &&
    report.diff.newCommands.length === 0 &&
    report.diff.cancelledCommands.length === 0 &&
    report.diff.newTargets.length === 0 &&
    report.diff.lostTargets.length === 0 &&
    report.diff.coverageDelta.length === 0;

  return (
    <section className="page-section" aria-labelledby="sg5-diff-title">
      <h2 className="section-title" id="sg5-diff-title">Comparação com a conferência anterior</h2>
      <div className="card">
        <div className="card-body">
          <div className="row">
            <button type="button" className="btn" onClick={runCompare} disabled={!canCompare}>
              <GitCompare size={16} aria-hidden="true" />
              Comparar com a conferência anterior
            </button>
            {captured !== null && (
              <span className="muted">
                Conferência atual: {formatStamp(captured.current.generatedAt)}
                {captured.previous !== null && (
                  <>
                    {' · '}anterior: {formatStamp(captured.previous.generatedAt)} (
                    {captured.previousSource !== null ? SOURCE_LABEL[captured.previousSource] : '—'})
                  </>
                )}
              </span>
            )}
          </div>

          {!hasCurrent && (
            <p className="muted" style={{ margin: 0 }}>
              Rode a “Obter verificação” acima para registrar a conferência atual.
            </p>
          )}

          {isFirstConference && (
            <Callout variant="info" title="Primeira conferência registrada">
              <p>
                A próxima conferência já poderá ser comparada — comandos novos/ cancelados, alvos que
                apareceram/ sumiram e a variação de cobertura só fazem sentido entre duas rodadas.
              </p>
            </Callout>
          )}

          {diffError !== null && (
            <Callout variant="danger" title="Falha ao comparar">
              <p>{diffError}</p>
            </Callout>
          )}

          {report !== null && (
            <div className="sgd-report col" style={{ gap: 12 }}>
              <div className="sgd-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
                <div className="sgd-card" style={CARD_STYLE}>
                  <span className="muted" style={{ display: 'block', fontSize: 12 }}>Comandos novos</span>
                  <strong style={{ fontSize: 22 }}>{report.diff.newCommands.length}</strong>
                </div>
                <div className="sgd-card" style={CARD_STYLE}>
                  <span className="muted" style={{ display: 'block', fontSize: 12 }}>Cancelados</span>
                  <strong style={{ fontSize: 22 }}>{report.diff.cancelledCommands.length}</strong>
                </div>
                <div className="sgd-card" style={CARD_STYLE}>
                  <span className="muted" style={{ display: 'block', fontSize: 12 }}>Alvos novos</span>
                  <strong style={{ fontSize: 22 }}>{report.diff.newTargets.length}</strong>
                </div>
                <div className="sgd-card" style={CARD_STYLE}>
                  <span className="muted" style={{ display: 'block', fontSize: 12 }}>Alvos perdidos</span>
                  <strong style={{ fontSize: 22 }}>{report.diff.lostTargets.length}</strong>
                </div>
                <div className="sgd-card sgd-card--delta" style={CARD_STYLE} title="Variação no total de comandos dos alvos">
                  <span className="muted" style={{ display: 'block', fontSize: 12 }}>Δ de cobertura</span>
                  <strong
                    className={totalDelta > 0 ? 'ok' : totalDelta < 0 ? 'error' : 'muted'}
                    style={{ fontSize: 22, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    {totalDelta > 0 ? <TrendingUp size={18} aria-hidden="true" /> : totalDelta < 0 ? <TrendingDown size={18} aria-hidden="true" /> : null}
                    {totalDelta > 0 ? `+${totalDelta}` : totalDelta}
                  </strong>
                </div>
              </div>

              {unchanged ? (
                <p className="muted" style={{ margin: 0 }}>
                  Nenhuma mudança — todos os comandos e alvos da conferência anterior seguem presentes.
                </p>
              ) : (
                <>
                  {report.diff.coverageDelta.length > 0 && (
                    <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                      Cobertura por alvo:{' '}
                      {report.diff.coverageDelta.map((entry) => `${entry.coord} ${entry.before}→${entry.after}`).join(' · ')}
                    </p>
                  )}
                  {report.diff.newTargets.length > 0 && (
                    <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                      Alvos novos: {report.diff.newTargets.join(' · ')}
                    </p>
                  )}
                  {report.diff.lostTargets.length > 0 && (
                    <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                      Alvos perdidos: {report.diff.lostTargets.join(' · ')}
                    </p>
                  )}

                  {report.diff.newCommands.length > 0 && (
                    <div className="sgd-block">
                      <h4 className="sgd-block-title" style={{ margin: '0 0 4px' }}>
                        Comandos novos ({report.diff.newCommands.length})
                      </h4>
                      <div className="table-wrap">
                        <table className="table" aria-label="Comandos novos desde a conferência anterior">
                          <thead>
                            <tr>
                              <th scope="col">Jogador</th>
                              <th scope="col">Alvo</th>
                              <th scope="col">Tipo</th>
                            </tr>
                          </thead>
                          <tbody>
                            {report.diff.newCommands.map((command) => (
                              <tr key={command.commandId}>
                                <td className="cell-nowrap">{command.playerName}</td>
                                <td className="cell-nowrap">{command.coord}</td>
                                <td className="cell-nowrap">
                                  {describeTipo(report.currentCommands.get(command.commandId))}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {report.diff.cancelledCommands.length > 0 && (
                    <div className="sgd-block">
                      <h4 className="sgd-block-title" style={{ margin: '0 0 4px' }}>
                        Comandos cancelados ({report.diff.cancelledCommands.length})
                      </h4>
                      <div className="table-wrap">
                        <table className="table" aria-label="Comandos cancelados desde a conferência anterior">
                          <thead>
                            <tr>
                              <th scope="col">Jogador</th>
                              <th scope="col">Alvo</th>
                              <th scope="col">Tipo</th>
                            </tr>
                          </thead>
                          <tbody>
                            {report.diff.cancelledCommands.map((command) => (
                              <tr key={command.commandId}>
                                <td className="cell-nowrap">{command.playerName}</td>
                                <td className="cell-nowrap">{command.coord}</td>
                                <td className="cell-nowrap">
                                  {describeTipo(report.previousCommands.get(command.commandId))}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <p className="muted sgd-note" style={{ margin: 0, fontSize: 13 }}>
            A comparação guarda automaticamente a última conferência bem-sucedida — rode a verificação acima para
            atualizar.
          </p>
        </div>
      </div>
    </section>
  );
}
