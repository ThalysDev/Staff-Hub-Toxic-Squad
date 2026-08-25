import { Fragment, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  Eye,
  Layers,
  ShieldCheck,
  Swords,
  Users,
} from 'lucide-react';
import { parseCoordList, type AxesRange } from '@shared/coords';
import type { QueueProgress } from '@shared/ipc-types';
// Contrato assumido de src/shared/sg2-engine.ts (agente paralelo — NÃO editado aqui):
//   export interface TroopSnapshot { kind: 'troops' | 'defense'; collectedAt: string; members: TroopMember[] }
//   export interface Sg2Filters {
//     mode?: 'has' | 'lacks';            // possui / não possui as tropas informadas
//     scope?: 'village' | 'player';      // Total de aldeia / Total de jogador
//     unitMinimums?: UnitCounts;         // mínimo por unidade (ausente = sem filtro de tropas)
//     coordsFilter?: Coord[];            // Coordenadas Filtradas
//     axesRange?: AxesRange;             // Eixo X/Y mín/máx
//   }
//   export interface Sg2FilterResult {
//     villageCount: number;              // total de aldeias que batem o filtro
//     players: { playerName: string; villageCount: number; coords: string[] }[];
//     classification?: { offensive: number; defensive: number }; // sem mínimos → classificação de TODAS as aldeias
//   }
//   export function filterTroops(snapshot: TroopSnapshot, filters?: Sg2Filters): Sg2FilterResult;
//   export function playersSummary(result: Sg2FilterResult): string; // linhas "nick;qtde;coord coord"
import { filterTroops, playersSummary } from '@shared/sg2-engine';
import type { Sg2FilterResult, Sg2Filters, TroopSnapshot } from '@shared/sg2-engine';
import { UNITS, type UnitCounts, type UnitId } from '@shared/units';
import { TW_UNIT_ICONS } from '../../assets';
import EmptyState from '../../components/EmptyState';
import Field from '../../components/Field';
import PageHeader from '../../components/PageHeader';
import ProgressBar from '../../components/ProgressBar';
import StatBlock from '../../components/StatBlock';
import ToastViewport from '../../components/Toast';
import { useToast } from '../../hooks/useToast';
import { MODULES } from '../../modules';

/**
 * SG_2 — Análise de Tropas das Aldeias (screen=ally&mode=members_troops).
 * Rótulos e formatos fiéis à ferramenta original (docs/MODULOS-SG.md):
 * painel "Dados em Memória" com data da última atualização, coleta completa
 * (membro a membro, com pacing) ou resumo em 1 requisição, e o filtro de
 * tropas por unidade/escopo/coordenadas/eixos. A consulta roda LOCALMENTE
 * no renderer sobre o snapshot guardado em memória no processo principal.
 */

/** Unidades do formulário de filtro: spear..snob (Milícia fica de fora). */
const FILTER_UNIT_ORDER: readonly UnitId[] = [
  'spear',
  'sword',
  'axe',
  'archer',
  'spy',
  'light',
  'marcher',
  'heavy',
  'ram',
  'catapult',
  'knight',
  'snob',
];

function emptyUnitInputs(): Record<UnitId, string> {
  return Object.fromEntries(FILTER_UNIT_ORDER.map((id) => [id, ''])) as Record<UnitId, string>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Falha de comunicação com o processo principal.';
}

/** Mínimo por unidade: número inteiro >= 1; vazio/0/inválido = sem mínimo. */
function parseUnitMinimum(text: string): number | null {
  const value = Number(text);
  if (text.trim() === '' || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

/** Valor de eixo (0..999); vazio/inválido = sem filtro no eixo. */
function parseAxisValue(text: string): number | null {
  const value = Number(text);
  if (text.trim() === '' || !Number.isInteger(value) || value < 0 || value > 999) return null;
  return value;
}

export default function Sg2Page() {
  const { toasts, push, dismiss } = useToast();
  const moduleInfo = MODULES.find((module) => module.id === 'sg2');

  // Memória (persistida no processo principal; F5 não perde).
  const [troopsAt, setTroopsAt] = useState<string | null>(null);
  const [memorySummary, setMemorySummary] = useState<{ players: number; villages: number; collectedAt: string; source: string } | null>(null);
  const [snapshot, setSnapshot] = useState<TroopSnapshot | null>(null);
  const [collecting, setCollecting] = useState<'members' | 'summary' | null>(null);
  const [progress, setProgress] = useState<QueueProgress | null>(null);
  const [actionError, setActionError] = useState('');

  // Formulário de filtro.
  const [showForm, setShowForm] = useState(false);
  const [unitInputs, setUnitInputs] = useState<Record<UnitId, string>>(emptyUnitInputs);
  const [mode, setMode] = useState<'has' | 'lacks'>('has');
  const [scope, setScope] = useState<'village' | 'player'>('village');
  const [coordsText, setCoordsText] = useState('');
  const [minXText, setMinXText] = useState('');
  const [maxXText, setMaxXText] = useState('');
  const [minYText, setMinYText] = useState('');
  const [maxYText, setMaxYText] = useState('');

  // Resultado.
  const [result, setResult] = useState<Sg2FilterResult | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Carrega o que já está em memória ao abrir a página.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.staffhub.troops.status(), window.staffhub.troops.get('troops')])
      .then(([status, stored]) => {
        if (cancelled) return;
        setTroopsAt(status.troopsAt);
        setSnapshot(stored);
      })
      .catch((error) => {
        if (!cancelled) push('error', errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [push]);

  // Progresso das coletas do processo principal.
  useEffect(() => {
    const unsubscribe = window.staffhub.events.onQueueProgress(setProgress);
    return unsubscribe;
  }, []);

  async function refreshMemory(): Promise<TroopSnapshot | null> {
    const [status, stored] = await Promise.all([
      window.staffhub.troops.status(),
      window.staffhub.troops.get('troops'),
    ]);
    setTroopsAt(status.troopsAt);
    setSnapshot(stored);
    return stored;
  }

  async function startCollect(kind: 'members' | 'summary'): Promise<void> {
    if (collecting !== null) return;
    setCollecting(kind);
    setProgress(null);
    setActionError('');
    setResult(null);
    try {
      await (kind === 'members'
        ? window.staffhub.troops.collectMembers('troops')
        : window.staffhub.troops.collectSummary('troops'));
      await refreshMemory();
      push(
        'ok',
        kind === 'members'
          ? 'Coleta de tropas concluída — dados em memória atualizados.'
          : 'Resumo coletado — dados em memória atualizados.',
      );
    } catch (error) {
      const message = errorMessage(error);
      setActionError(message);
      push('error', message);
    } finally {
      setCollecting(null);
    }
  }

  async function exhibit(): Promise<void> {
    try {
      const stored = await refreshMemory();
      setResult(null);
      if (stored === null) {
        push('info', 'Nada em memória — colete as informações de tropas primeiro.');
        setMemorySummary(null);
        return;
      }
      const players = new Set(stored.entries.map((entry) => entry.playerName));
      const villages = stored.entries.filter((entry) => entry.coord.x >= 0).length;
      setMemorySummary({
        players: players.size,
        villages,
        collectedAt: new Date(stored.collectedAt).toLocaleString('pt-BR'),
        source: stored.source === 'summary' ? 'resumo (por jogador)' : 'por aldeia (por membro)',
      });
      push('ok', 'Memória carregada — resumo abaixo.');
    } catch (error) {
      push('error', errorMessage(error));
    }
  }

  function buildFilters(): Sg2Filters {
    const filters: Sg2Filters = { mode: mode === 'has' ? 'possuem' : 'nao-possuem', scope: scope === 'village' ? 'aldeia' : 'jogador' };
    const minimums: UnitCounts = {};
    for (const id of FILTER_UNIT_ORDER) {
      const value = parseUnitMinimum(unitInputs[id] ?? '');
      if (value !== null) minimums[id] = value;
    }
    if (Object.keys(minimums).length > 0) filters.unitMinimums = minimums;
    const coords = parseCoordList(coordsText);
    if (coords.length > 0) filters.coordsFilter = coords;
    const axesRange: AxesRange = {};
    const minX = parseAxisValue(minXText);
    const maxX = parseAxisValue(maxXText);
    const minY = parseAxisValue(minYText);
    const maxY = parseAxisValue(maxYText);
    if (minX !== null) axesRange.minX = minX;
    if (maxX !== null) axesRange.maxX = maxX;
    if (minY !== null) axesRange.minY = minY;
    if (maxY !== null) axesRange.maxY = maxY;
    if (Object.keys(axesRange).length > 0) filters.axesRange = axesRange;
    return filters;
  }

  function runQuery(): void {
    if (snapshot === null) {
      const message = 'Colete primeiro — não há dados de tropas em memória.';
      setActionError(message);
      push('error', message);
      return;
    }
    try {
      const next = filterTroops(snapshot, buildFilters());
      setResult(next);
      setExpanded(new Set());
      setActionError('');
      push('ok', `Consulta concluída: ${next.totalVillages} aldeia(s) no filtro.`);
    } catch (error) {
      const message = errorMessage(error);
      setActionError(message);
      push('error', message);
    }
  }

  function toggleRow(index: number): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  async function copySummary(): Promise<void> {
    if (result === null) return;
    const text = playersSummary(result);
    if (text.trim() === '') {
      push('info', 'Sem resultados para copiar.');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      push('ok', 'Resumo copiado (nick;qtde;coords).');
    } catch {
      push('error', 'Não foi possível copiar — permissão de área de transferência negada.');
    }
  }

  function updateUnitInput(id: UnitId, value: string): void {
    setUnitInputs((current) => ({ ...current, [id]: value }));
  }

  const updatedLabel =
    troopsAt !== null ? new Date(troopsAt).toLocaleString('pt-BR') : 'Nunca coletado';

  return (
    <section className="page">
      <PageHeader
        kicker={moduleInfo !== undefined ? `Módulo ${moduleInfo.id.toUpperCase()} — Fase ${moduleInfo.phase}` : 'Módulo SG2 — Fase 2'}
        title={moduleInfo?.originalLabel ?? 'Análise de Tropas das Aldeias'}
        description="Coleta as tropas recrutadas de cada aldeia da tribo (com progresso e memória local), filtra por unidade, escopo, coordenadas e eixos — e classifica ofensivas vs defensivas sem filtro de tropas."
      />

      {memorySummary !== null && (
        <section className="page-section" aria-label="Resumo dos dados em memória">
          <div className="card">
            <div className="card-body sg2-memory-summary">
              <strong>{memorySummary.players}</strong> jogador(es) ·{" "}
              <strong>{memorySummary.villages}</strong> aldeia(s) · coleta{" "}
              {memorySummary.source} · {memorySummary.collectedAt}
            </div>
          </div>
        </section>
      )}

      {/* ===== Painel Dados em Memória ===== */}
      <section className="page-section" aria-labelledby="sg2-memory-title">
        <h2 className="section-title" id="sg2-memory-title">Dados em Memória</h2>
        <div className="card">
          <div className="card-body">
            <div className="sg2-memory-bar">
              <span className="pill pill--gold">
                <Database size={12} aria-hidden="true" />
                Dados em Memória
              </span>
              <p className="sg2-memory-date muted">
                Data da Última Atualização: <strong>{updatedLabel}</strong>
              </p>
              <div className="sg2-memory-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void exhibit()}
                  disabled={collecting !== null}
                >
                  <Eye size={14} aria-hidden="true" />
                  Exibir Dados
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void startCollect('members')}
                  disabled={collecting !== null}
                >
                  {collecting === 'members' ? (
                    <span className="btn-spinner" aria-hidden="true" />
                  ) : (
                    <Users size={14} aria-hidden="true" />
                  )}
                  Coletar Informações de Tropas
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void startCollect('summary')}
                  disabled={collecting !== null}
                >
                  {collecting === 'summary' ? (
                    <span className="btn-spinner" aria-hidden="true" />
                  ) : (
                    <Layers size={14} aria-hidden="true" />
                  )}
                  Coletar Resumo (1 requisição)
                </button>
              </div>
            </div>
            <p className="hint-note muted">
              A coleta completa percorre todos os membros da tribo com pacing humano — quanto
              maior a tribo, mais demorada. Prefira o resumo (1 requisição) para uma visão rápida.
            </p>
            {collecting !== null && progress !== null && (
              <div className="sg2-progress">
                <ProgressBar done={progress.done} total={progress.total} label={progress.label} />
              </div>
            )}
          </div>
        </div>
      </section>

      {actionError !== '' && (
        <div className="callout callout--danger">
          <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
          <div className="callout-body">
            <p className="callout-title">Falha na operação</p>
            <p>{actionError}</p>
          </div>
        </div>
      )}

      {snapshot === null ? (
        <div className="card">
          <EmptyState
            icon={Swords}
            title="Nenhuma coleta em memória"
            hint="O painel começa vazio: colete as informações de tropas (membro a membro, com progresso) ou o resumo em 1 requisição para alimentar os filtros."
            action={
              <button
                type="button"
                className="btn"
                onClick={() => void startCollect('members')}
                disabled={collecting !== null}
              >
                <Users size={14} aria-hidden="true" />
                Coletar agora
              </button>
            }
          />
        </div>
      ) : (
        <>
          {/* ===== Realizar Filtro de Tropas ===== */}
          <section className="page-section" aria-labelledby="sg2-filter-title">
            <div className="sg2-filter-head">
              <h2 className="section-title" id="sg2-filter-title">Realizar Filtro de Tropas</h2>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-expanded={showForm}
                onClick={() => setShowForm((visible) => !visible)}
              >
                {showForm ? 'Ocultar filtros' : 'Abrir filtros'}
                <ChevronDown
                  size={14}
                  aria-hidden="true"
                  className={showForm ? 'sg2-chevron sg2-chevron--open' : 'sg2-chevron'}
                />
              </button>
            </div>

            {showForm && (
              <div className="card">
                <div className="card-body">
                  <form
                    className="sg2-filter-grid"
                    noValidate
                    onSubmit={(event) => {
                      event.preventDefault();
                      runQuery();
                    }}
                  >
                    <fieldset className="sg2-fieldset sg2-span-2">
                      <legend className="field-label">Unidades (quantidade mínima)</legend>
                      <div className="sg2-units-grid">
                        {FILTER_UNIT_ORDER.map((id) => (
                          <label key={id} className="sg2-unit-row">
                            <img src={TW_UNIT_ICONS[id]} width={18} height={18} alt="" aria-hidden="true" />
                            <span className="sg2-unit-name">{UNITS[id].name}</span>
                            <input
                              type="number"
                              className="input sg2-unit-input"
                              min={0}
                              value={unitInputs[id] ?? ''}
                              aria-label={`Quantidade mínima de ${UNITS[id].name}`}
                              onChange={(event) => updateUnitInput(id, event.target.value)}
                            />
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    <fieldset className="sg2-fieldset">
                      <legend className="field-label">Modalidade</legend>
                      <div className="sg2-radio-row">
                        <label className="checkbox-field">
                          <input
                            type="radio"
                            name="sg2-mode"
                            value="has"
                            checked={mode === 'has'}
                            onChange={() => setMode('has')}
                          />
                          <span>Possuem as tropas informadas</span>
                        </label>
                        <label className="checkbox-field">
                          <input
                            type="radio"
                            name="sg2-mode"
                            value="lacks"
                            checked={mode === 'lacks'}
                            onChange={() => setMode('lacks')}
                          />
                          <span>Não possuem as tropas informadas</span>
                        </label>
                      </div>
                    </fieldset>

                    <fieldset className="sg2-fieldset">
                      <legend className="field-label">Escopo</legend>
                      <div className="sg2-radio-row">
                        <label className="checkbox-field">
                          <input
                            type="radio"
                            name="sg2-scope"
                            value="village"
                            checked={scope === 'village'}
                            onChange={() => setScope('village')}
                          />
                          <span>Total de aldeia</span>
                        </label>
                        <label className="checkbox-field">
                          <input
                            type="radio"
                            name="sg2-scope"
                            value="player"
                            checked={scope === 'player'}
                            onChange={() => setScope('player')}
                          />
                          <span>Total de jogador</span>
                        </label>
                      </div>
                    </fieldset>

                    <div className="sg2-span-2">
                      <Field
                        id="sg2-coords"
                        label="Coordenadas Filtradas (123|456 456|123 ...)"
                        hint="Separadas por espaço ou Enter — normalmente a saída do SG_1."
                      >
                        <textarea
                          id="sg2-coords"
                          className="textarea sg2-coords"
                          rows={3}
                          value={coordsText}
                          aria-describedby="sg2-coords-hint"
                          onChange={(event) => setCoordsText(event.target.value)}
                        />
                      </Field>
                    </div>

                    <div className="sg2-axis-group">
                      <span className="field-label">Eixo X de [ ] a [ ]</span>
                      <div className="sg2-axis-inputs">
                        <label className="sg2-axis-field">
                          <span className="muted">de</span>
                          <input
                            type="number"
                            className="input"
                            min={0}
                            max={999}
                            placeholder="0"
                            value={minXText}
                            aria-label="Eixo X mínimo"
                            onChange={(event) => setMinXText(event.target.value)}
                          />
                        </label>
                        <label className="sg2-axis-field">
                          <span className="muted">a</span>
                          <input
                            type="number"
                            className="input"
                            min={0}
                            max={999}
                            placeholder="999"
                            value={maxXText}
                            aria-label="Eixo X máximo"
                            onChange={(event) => setMaxXText(event.target.value)}
                          />
                        </label>
                      </div>
                    </div>

                    <div className="sg2-axis-group">
                      <span className="field-label">Eixo Y de [ ] a [ ]</span>
                      <div className="sg2-axis-inputs">
                        <label className="sg2-axis-field">
                          <span className="muted">de</span>
                          <input
                            type="number"
                            className="input"
                            min={0}
                            max={999}
                            placeholder="0"
                            value={minYText}
                            aria-label="Eixo Y mínimo"
                            onChange={(event) => setMinYText(event.target.value)}
                          />
                        </label>
                        <label className="sg2-axis-field">
                          <span className="muted">a</span>
                          <input
                            type="number"
                            className="input"
                            min={0}
                            max={999}
                            placeholder="999"
                            value={maxYText}
                            aria-label="Eixo Y máximo"
                            onChange={(event) => setMaxYText(event.target.value)}
                          />
                        </label>
                      </div>
                    </div>

                    <div className="sg2-span-2 sg2-form-actions">
                      <button type="submit" className="btn">
                        <Swords size={15} aria-hidden="true" />
                        Realizar Consulta
                      </button>
                      <span className="muted">
                        Sem mínimos de unidade, a consulta classifica todas as aldeias em
                        ofensivas e defensivas.
                      </span>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </section>

          {/* ===== Resultado ===== */}
          {result !== null && (
            <section className="page-section" aria-labelledby="sg2-result-title">
              <h2 className="section-title" id="sg2-result-title">Resultado da Consulta</h2>
              <div className="card card--flush">
                <div className="card-header">
                  <h3 className="card-title">Jogadores</h3>
                  <span className="spacer" />
                  <span className="sg2-total">
                    <span className="sg2-total-value">{result.totalVillages}</span>
                    <span className="sg2-total-label">aldeias</span>
                  </span>
                </div>

                {result.classification !== undefined && (
                  <div className="card-body sg2-classification">
                    <div className="stat-row">
                      <StatBlock
                        label="Ofensivas"
                        icon={Swords}
                        tone="ok"
                        value={result.classification.offensive}
                        delta="aldeias classificadas por população de ataque"
                      />
                      <StatBlock
                        label="Defensivas"
                        icon={ShieldCheck}
                        tone="gold"
                        value={result.classification.defensive}
                        delta="aldeias classificadas por população de defesa"
                      />
                    </div>
                  </div>
                )}

                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Jogador</th>
                        <th scope="col" className="cell-num">Aldeias</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.players.map((player, index) => {
                        const isOpen = expanded.has(index);
                        return (
                          <Fragment key={`${player.playerName}-${index}`}>
                            <tr>
                              <td>
                                <button
                                  type="button"
                                  className="sg2-row-toggle"
                                  aria-expanded={isOpen}
                                  aria-controls={`sg2-drilldown-${index}`}
                                  onClick={() => toggleRow(index)}
                                >
                                  {isOpen ? (
                                    <ChevronDown size={14} aria-hidden="true" />
                                  ) : (
                                    <ChevronRight size={14} aria-hidden="true" />
                                  )}
                                  <span>{player.playerName}</span>
                                </button>
                              </td>
                              <td className="cell-num tabular">{player.villageCount}</td>
                            </tr>
                            {isOpen && (
                              <tr id={`sg2-drilldown-${index}`} className="sg2-drilldown">
                                <td colSpan={2} className="sg2-coords">
                                  {player.coords.length > 0
                                    ? player.coords.join(' ')
                                    : 'Sem coordenadas'}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="card-body">
                  <div className="sg2-form-actions">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void copySummary()}
                    >
                      <Copy size={14} aria-hidden="true" />
                      Copiar resumo (nick;qtde;coords)
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}
        </>
      )}

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </section>
  );
}
