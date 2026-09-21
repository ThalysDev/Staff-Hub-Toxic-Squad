import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Copy, Crosshair, Plus, Share2, Swords } from 'lucide-react';
import { parseCoordList } from '@shared/coords';
import { distributionSummary } from '@shared/sg4-engine';
import type { DistributionResult, OriginPlayer, originsSummary } from '@shared/sg4-engine';
import Callout from '../../components/Callout';
import Field from '../../components/Field';
import WorldMapCanvas from '../sg1/WorldMapCanvas';
import MoraleCurve from './MoraleCurve';
import { GatedHint, LINE_NAMES, type OriginLine } from './Sg4Page';

function mixChannel(a: number, b: number, u: number): number {
  return Math.round(a + (b - a) * u);
}

/** Cor do heatmap por proporção t ∈ [0,1]: verde → amarelo → vermelho. */
function heatColor(t: number): [number, number, number] {
  const clamped = Math.min(1, Math.max(0, t));
  if (clamped < 0.5) {
    const u = clamped * 2;
    return [mixChannel(67, 251, u), mixChannel(160, 192, u), mixChannel(71, 45, u)];
  }
  const u = (clamped - 0.5) * 2;
  return [mixChannel(251, 211, u), mixChannel(192, 47, u), mixChannel(45, 47, u)];
}

function heatStyle(t: number): CSSProperties {
  const [r, g, b] = heatColor(t);
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return {
    backgroundColor: `rgb(${r}, ${g}, ${b})`,
    color: luminance > 150 ? '#202020' : '#fdf6e8',
  };
}

/** Visualização da Distribuição: origens (verde) × alvos (branco) sobre o mapa. */
const EMPTY_MARKINGS = new Map<number, import('@shared/types').TribeMarking>();

function DistributionMap({ assignments, onError }: { assignments: { playerName: string; origin: string; target: string }[]; onError: (message: string) => void }) {
  const [villages, setVillages] = useState<readonly import('@shared/types').WorldVillage[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.staffhub.world
      .villages()
      .then((list) => {
        if (!cancelled) setVillages(list);
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [onError]);

  if (villages === null) {
    return <p className="muted">Carregando mapa para a visualização da distribuição…</p>;
  }
  const origins = new Set(assignments.map((a) => a.origin));
  const targets = new Set(assignments.map((a) => a.target));
  return (
    <div className="card sg4-mapviz">
      <div className="card-header">
        <h3 className="card-title">Visualização da distribuição</h3>
        <span className="muted">● origens (NTs) · □ alvos</span>
      </div>
      <div className="card-body">
        <WorldMapCanvas
          villages={villages}
          markings={EMPTY_MARKINGS}
          highlights={targets}
          origins={origins}
          connections={assignments.map((a) => ({ from: a.origin, to: a.target }))}
        />
      </div>
    </div>
  );
}

/** Props da etapa 2 (Distribuição): TODO o estado de negócio continua no
 *  Sg4Page (o run/restore de uma etapa derruba resultados das outras) — aqui só
 *  entram valores + onChange e o estado de UI local (revelar a seção gated). */
export interface Sg4DistributionSectionProps {
  /** stepDistributionStatus — mesma linha muted sob o título (stepper no pai). */
  statusText: string;
  originsText: string;
  onOriginsTextChange: (value: string) => void;
  originsPreview: { players: OriginPlayer[]; summary: ReturnType<typeof originsSummary> } | null;
  onFillFromSnapshot: () => void;
  lines: OriginLine[];
  onLineChange: (index: number, key: keyof OriginLine, value: string) => void;
  onRemoveLine: (index: number) => void;
  onAddLine: () => void;
  priority: 'nearest' | 'farthest';
  onPriorityChange: (priority: 'nearest' | 'farthest') => void;
  minMoraleText: string;
  onMinMoraleTextChange: (value: string) => void;
  maxFieldsText: string;
  onMaxFieldsTextChange: (value: string) => void;
  moraleActive: boolean;
  originsError: string | undefined;
  busy: boolean;
  runError: string;
  onRun: (planOnly: boolean) => void;
  planning: DistributionResult | null;
  distribution: DistributionResult | null;
  /** distributionStale — banner e travas de arquivar. */
  stale: boolean;
  opTitle: string;
  onOpTitleChange: (value: string) => void;
  archiving: boolean;
  onArchive: () => void;
  onCopy: (text: string) => void;
  onMapError: (message: string) => void;
  onNavigate: ((page: string) => void) | undefined;
}

/** ===== Etapa 2 — Distribuição de Alvos de OP ===== */
export default function Sg4DistributionSection(props: Sg4DistributionSectionProps) {
  const {
    statusText,
    originsText,
    onOriginsTextChange,
    originsPreview,
    onFillFromSnapshot,
    lines,
    onLineChange,
    onRemoveLine,
    onAddLine,
    priority,
    onPriorityChange,
    minMoraleText,
    onMinMoraleTextChange,
    maxFieldsText,
    onMaxFieldsTextChange,
    moraleActive,
    originsError,
    busy,
    runError,
    onRun,
    planning,
    distribution,
    stale,
    opTitle,
    onOpTitleChange,
    archiving,
    onArchive,
    onCopy,
    onMapError,
    onNavigate,
  } = props;

  // Progressive disclosure (3-J): default COLAPSADA enquanto o pré-requisito
  // falta; com o pré-requisito satisfeito o flag é ignorado e a seção renderiza
  // como sempre. Nada de lógica nova: só apresenta o que já estava lá.
  const [revealed, setRevealed] = useState(false);
  // Gate: a MESMA condição do callout de "vazio" que a seção já computava
  // (origem E alvos vazios — e sem resultado na tela, que nunca pode sumir).
  const collapsed =
    planning === null &&
    distribution === null &&
    originsText.trim() === '' &&
    lines.every((line) => parseCoordList(line.coordsText).length === 0) &&
    !revealed;

  const heatRange = useMemo(() => {
    if (planning === null) return { min: 0, max: 1 };
    const hours = planning.matrix.flatMap((row) => row.cells.map((cell) => cell.hours));
    if (hours.length === 0) return { min: 0, max: 1 };
    return { min: Math.min(...hours), max: Math.max(...hours) };
  }, [planning]);

  /** "Distância máxima" em número, para APAGAR células além do limite no
   * heatmap (aviso visual — o filtro de verdade vale na distribuição). */
  const maxFieldsLimit = useMemo<number | null>(() => {
    const parsed = Number(maxFieldsText);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, [maxFieldsText]);

  /** Memoizado: recalcular distributionSummary a cada render é desperdício. */
  const distributionSummaryText = useMemo(
    () => (distribution === null ? '' : distributionSummary(distribution)),
    [distribution],
  );

  return (
    <section className="page-section" aria-labelledby="sg4-dist-title">
      <h2 className="section-title" id="sg4-dist-title">Distribuição de alvos da OP</h2>
      <p className="muted">{statusText}</p>
      {collapsed ? (
        <GatedHint
          hint="Sem origens nem alvos nesta etapa — conclua a etapa anterior (alvos e fakes) para liberar."
          onReveal={() => setRevealed(true)}
        />
      ) : (
        <>
          {originsText.trim() === '' && (
            <Callout variant="info">
              <p>
                <strong>Sem origens ainda</strong> — cole a saída do contador do SG2 no campo
                "Origens da tribo" abaixo (ou use o botão "Preencher com o SG2").
              </p>
            </Callout>
          )}
          {lines.every((line) => parseCoordList(line.coordsText).length === 0) && (
            <Callout variant="info">
              <p>
                <strong>Sem alvos nesta etapa</strong> — cole as coordenadas dos alvos (123|456
                456|123) na primeira linha de alvos, ou traga os alvos da etapa 1 com o botão "Usar
                estes alvos na distribuição".
              </p>
            </Callout>
          )}
          <div className="card">
            <div className="card-body">
              <Field
                id="sg4-origins"
                label="Origens da tribo (nick;fulls;coords)"
                hint="Cada coordenada de origem = 1 NT estacionado (1 alvo a receber). Formatos: nick;fulls;coords ou nick;fulls;semis;coords (coords fulls primeiro — saída do contador do SG2)."
                error={originsError}
              >
                <textarea
                  id="sg4-origins"
                  className="textarea sg4-coords"
                  rows={4}
                  placeholder={'hasua;50;686|420 686|424\nou com semis: hasua;3;2;686|420 686|424 690|430 691|431'}
                  value={originsText}
                  data-tip="Um jogador por linha: nick;fulls;semis;coords (semis opcional; fulls primeiro). Cada coordenada = 1 nobre pronto = 1 alvo. Cole a saída do SG2 ou use o botão."
                  aria-describedby={originsError !== undefined ? 'sg4-origins-error' : 'sg4-origins-hint'}
                  onChange={(event) => onOriginsTextChange(event.target.value)}
                />
                <div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={onFillFromSnapshot}
                    data-tip="Substitui o campo com as aldeias com nobre da última coleta do SG2."
                  >
                    <Swords size={14} aria-hidden="true" />
                    Preencher com o SG2 (aldeias com nobre)
                  </button>
                </div>
              </Field>

              {originsPreview !== null && (
                <div className="col" style={{ gap: 8, marginBottom: 12 }}>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="pill pill--muted">{originsPreview.summary.players} jogador(es)</span>
                    <span className="pill pill--muted">{originsPreview.summary.fulls} full(s)</span>
                    {originsPreview.summary.semis > 0 && <span className="pill pill--muted">{originsPreview.summary.semis} semi(s)</span>}
                    <span className="pill pill--muted">{originsPreview.summary.villages} origem(ns)</span>
                  </div>
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Jogador</th>
                          <th scope="col" className="cell-num">Fulls</th>
                          <th scope="col" className="cell-num">Semis</th>
                          <th scope="col">Origens (F = full · S = semi)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {originsPreview.players.map((player) => {
                          const semiSet = new Set((player.semiOrigins ?? []).map((coord) => `${coord.x}|${coord.y}`));
                          return (
                            <tr key={player.playerName}>
                              <td className="cell-nowrap">{player.playerName}</td>
                              <td className="cell-num"><strong>{player.fulls}</strong></td>
                              <td className="cell-num">{player.semis ?? 0}</td>
                              <td className="cell-detail">
                                {player.origins.map((coord) => {
                                  const label = `${coord.x}|${coord.y}`;
                                  return semiSet.has(label)
                                    ? <span key={label} className="text-warn">S {label} </span>
                                    : <span key={label}>F {label} </span>;
                                })}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {lines.map((line, index) => (
                <div className="sg4-line-grid" key={index}>
                  {/* Faixas fulls/semis: UM rótulo por par (legível) — os limites
                      de/até são identificados por aria-label e placeholder. */}
                  <fieldset className="field" style={{ gridColumn: 'span 2' }}>
                    <legend className="field-label">Fulls (de–até)</legend>
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={200}
                        placeholder="0"
                        value={line.fullsFrom}
                        style={{ flex: 1, minWidth: 0 }}
                        aria-label={`Fulls mínimas da linha ${index + 1}`}
                        data-tip="Só entram nesta linha jogadores com essa quantidade de fulls. Vazio = todos."
                        onChange={(event) => onLineChange(index, 'fullsFrom', event.target.value)}
                      />
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={200}
                        placeholder="200"
                        value={line.fullsTo}
                        style={{ flex: 1, minWidth: 0 }}
                        aria-label={`Fulls máximas da linha ${index + 1}`}
                        data-tip="Só entram nesta linha jogadores com essa quantidade de fulls. Vazio = todos."
                        onChange={(event) => onLineChange(index, 'fullsTo', event.target.value)}
                      />
                    </div>
                  </fieldset>
                  <fieldset className="field" style={{ gridColumn: 'span 2' }}>
                    <legend className="field-label">Semis (de–até)</legend>
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={200}
                        placeholder="0"
                        value={line.semisFrom}
                        style={{ flex: 1, minWidth: 0 }}
                        aria-label={`Semis mínimas da linha ${index + 1}`}
                        data-tip="Filtro extra pela quantidade de semis (origens em formato legado têm 0 semis)."
                        onChange={(event) => onLineChange(index, 'semisFrom', event.target.value)}
                      />
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={200}
                        placeholder="200"
                        value={line.semisTo}
                        style={{ flex: 1, minWidth: 0 }}
                        aria-label={`Semis máximas da linha ${index + 1}`}
                        data-tip="Filtro extra pela quantidade de semis (origens em formato legado têm 0 semis)."
                        onChange={(event) => onLineChange(index, 'semisTo', event.target.value)}
                      />
                    </div>
                  </fieldset>
                  <label className="field">
                    <span className="field-label">
                      Coordenadas de destino ({(LINE_NAMES[index] ?? `${index + 1}ª linha`).toLowerCase()})
                    </span>
                    <textarea
                      className="textarea"
                      rows={2}
                      placeholder="123|456 456|123 111|222"
                      value={line.coordsText}
                      data-tip="Alvos desta linha, separados por espaço. Só jogadores na faixa de fulls/semis ao lado podem pegá-los."
                      onChange={(event) => onLineChange(index, 'coordsText', event.target.value)}
                    />
                    <div>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={lines.length <= 1}
                        onClick={() => onRemoveLine(index)}
                      >
                        Remover linha
                      </button>
                    </div>
                  </label>
                </div>
              ))}
              <button type="button" className="btn btn-ghost btn-sm" onClick={onAddLine}>
                <Plus size={14} aria-hidden="true" />
                Adicionar linha de alvos
              </button>

              <div className="sg4-params">
                <fieldset className="field" data-tip="Cada origem escolhe o alvo elegível mais perto (ou mais longe) primeiro.">
                  <legend className="field-label">Priorizar</legend>
                  <div className="sg4-radio-row">
                    <label className="checkbox-field">
                      <input
                        type="radio"
                        name="sg4-priority"
                        checked={priority === 'nearest'}
                        onChange={() => onPriorityChange('nearest')}
                      />
                      mais próximas
                    </label>
                    <label className="checkbox-field">
                      <input
                        type="radio"
                        name="sg4-priority"
                        checked={priority === 'farthest'}
                        onChange={() => onPriorityChange('farthest')}
                      />
                      mais distantes
                    </label>
                  </div>
                </fieldset>
                <label className="field">
                  <span className="field-label">Moral mínima (%) — 0 desliga</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={100}
                    value={minMoraleText}
                    disabled={!moraleActive}
                    data-tip="Moral mínima do par atacante→alvo. 0 desliga o filtro."
                    aria-describedby={!moraleActive ? 'sg4-morale-hint' : undefined}
                    onChange={(event) => onMinMoraleTextChange(event.target.value)}
                  />
                  {!moraleActive && (
                    <p className="field-hint" id="sg4-morale-hint">
                      Mundo clássico — sem moral por pontos
                    </p>
                  )}
                </label>
                <label className="field">
                  <span className="field-label">Distância máxima (campos)</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={maxFieldsText}
                    data-tip="Distância máxima origem→alvo, em campos. O heatmap mostra todos; o filtro vale na distribuição."
                    onChange={(event) => onMaxFieldsTextChange(event.target.value)}
                  />
                </label>
              </div>

              {/* Curva da moral com a linha da moral mínima configurada — só
                  quando o valor é um número válido em 0–100 (senão, curva pura). */}
              {moraleActive &&
                (() => {
                  const mm = Number(minMoraleText);
                  return (
                    <MoraleCurve
                      {...(Number.isFinite(mm) && mm >= 0 && mm <= 100 ? { minMorale: Math.round(mm) } : {})}
                    />
                  );
                })()}

              <div className="sg4-form-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => void onRun(true)}
                  data-tip="Só calcula a matriz origem×alvo para revisar — nada é fechado."
                >
                  <Crosshair size={15} aria-hidden="true" />
                  {busy ? 'Calculando…' : 'Simular (ver mapa de calor)'}
                </button>
                <button
                  type="button"
                  className="btn sg4-btn-green"
                  disabled={busy}
                  onClick={() => void onRun(false)}
                  data-tip="Fecha a distribuição: cada origem fica com 1 alvo e habilita agenda, MPs, mapa e arquivo."
                >
                  <Share2 size={15} aria-hidden="true" />
                  {busy ? 'Calculando…' : 'Distribuir agora'}
                </button>
              </div>
              {runError !== '' && (
                <p className="error" role="alert">{runError}</p>
              )}
            </div>
          </div>

          {planning !== null && (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Simulação (origem × alvo)</h3>
                <span className="spacer" />
                <span className="pill pill--muted">
                  {planning.matrix.length} origens · {planning.lineTargets.length} alvos
                </span>
              </div>
              {planning.matrix.length === 0 || planning.lineTargets.length === 0 ? (
                <div className="card-body">
                  <p className="muted">Matriz vazia — confira as origens e os alvos informados.</p>
                </div>
              ) : (
                <div className="card-body">
                  <div className="table-wrap sg4-heat-wrap">
                    <table className="table sg4-heat">
                      <thead>
                        <tr>
                          <th scope="col">Origem (Jogador)</th>
                          {planning.lineTargets.map((target, index) => (
                            <th scope="col" key={`${target.x}|${target.y}-${index}`}>
                              {target.x}|{target.y}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {planning.matrix.map((row) => (
                          <tr key={row.origin}>
                            <th scope="row" className="cell-nowrap sg4-heat-origin">
                              <span className="muted">{row.origin}</span> {row.player}
                              {row.tier === 'semi' && <span className="text-warn" title="Origem SEMI (população ofensiva abaixo do limiar de full)"> semi</span>}
                            </th>
                        {row.cells.map((cell, index) => {
                          const span = heatRange.max - heatRange.min;
                          const t = span === 0 ? 0.5 : (cell.hours - heatRange.min) / span;
                          const morale = cell.morale;
                          // Célula além da "Distância máxima": apagada (aviso, não filtro).
                          const far = maxFieldsLimit !== null && cell.fields > maxFieldsLimit;
                          const tipParts = [
                            `${cell.hours.toFixed(1).replace('.', ',')}h de viagem`,
                            `${cell.fields} campos`,
                          ];
                          if (morale !== null) tipParts.push(`moral ${morale}%`);
                          if (far && maxFieldsLimit !== null) tipParts.push(`fora do limite de ${maxFieldsLimit} campos`);
                          return (
                            <td
                              key={index}
                              className={far ? 'sg4-heat-cell sg4-heat-cell--far' : 'sg4-heat-cell'}
                              style={heatStyle(t)}
                              data-tip={tipParts.join(' · ')}
                            >
                              {cell.hours.toFixed(1)}
                            </td>
                          );
                        })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="muted sg4-heat-legend">
                    Horas de NOBRE da origem até o alvo: verde (mais perto) → amarelo → vermelho (mais longe).
                    Células apagadas estão além da "Distância máxima" — o filtro vale na distribuição.
                    Passe o mouse sobre as células para ver horas, campos e moral.
                  </p>
                </div>
              )}
            </div>
          )}

          {distribution !== null && (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Distribuição</h3>
                <span className="spacer" />
                <span className="pill pill--muted">
                  {distribution.assignments.length} pares fechados · {distribution.orphanOrigins.length} origens sem
                  alvo · {distribution.orphanTargets.length} alvos sem atacante
                </span>
              </div>
              {stale && (
                <div className="card-body" style={{ paddingBottom: 0 }}>
                  <Callout variant="warn" title="Distribuição possivelmente desatualizada">
                    <p>Os parâmetros mudaram depois da distribuição — redistribua antes de usar.</p>
                  </Callout>
                </div>
              )}
              <div className="card-body">
                <label className="field">
                  <span className="field-label">Resultado: quem ataca o quê (nick;coords)</span>
                  <textarea
                    className="textarea sg4-coords"
                    rows={6}
                    readOnly
                    value={distributionSummaryText}
                    aria-label="Resultado da distribuição: quem ataca o quê (nick;coords)"
                  />
                  <div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={distribution.assignments.length === 0}
                      onClick={() => onCopy(distributionSummary(distribution))}
                    >
                      <Copy size={14} aria-hidden="true" />
                      Copiar distribuição
                    </button>
                  </div>
                </label>
                {distribution.orphanOrigins.length > 0 && (
                  <p className="muted">
                    Origens sem alvo:{' '}
                    {distribution.orphanOrigins.map((orphan) => `${orphan.playerName} (${orphan.origin})`).join(' · ')}{' '}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        void onCopy(distribution.orphanOrigins.map((orphan) => orphan.origin).join(' '))
                      }
                    >
                      <Copy size={14} aria-hidden="true" />
                      Copiar
                    </button>
                  </p>
                )}
                {distribution.orphanTargets.length > 0 && (
                  <p className="muted">
                    Alvos sem atacante: {distribution.orphanTargets.join(' ')}{' '}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void onCopy(distribution.orphanTargets.join(' '))}
                    >
                      <Copy size={14} aria-hidden="true" />
                      Copiar
                    </button>
                  </p>
                )}
                {distribution.orphanOrigins.length === 0 && distribution.orphanTargets.length === 0 && (
                  <p className="ok">Todos os alvos receberam um atacante.</p>
                )}
                <div className="sg4-params" style={{ marginTop: 12 }}>
                  <label className="field">
                    <span className="field-label">Nome da OP (para o histórico)</span>
                    <input
                      className="input"
                      value={opTitle}
                      data-tip="Nome com que a OP entra no arquivo de OPs (Sala de Guerra) e no plano do fórum."
                      onChange={(event) => onOpTitleChange(event.target.value)}
                      aria-label="Nome da OP para o histórico"
                    />
                  </label>
                  <div className="field">
                    <span className="field-label">Arquivo de OPs</span>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={
                        archiving || distribution.assignments.length === 0 || stale
                      }
                      title={
                        stale
                          ? 'Os parâmetros mudaram depois da distribuição — redistribua antes de arquivar.'
                          : undefined
                      }
                      onClick={onArchive}
                    >
                      {archiving ? <><span className="btn-spinner" aria-hidden="true" /> Arquivando…</> : 'Arquivar OP (Sala de Guerra)'}
                    </button>
                    {/* Hand-off pós-arquivo: atalho para acompanhar a OP na Sala
                        de Guerra — só existe quando o App injeta onNavigate. */}
                    {onNavigate !== undefined && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => onNavigate('guerra')}
                        data-tip="Abre a Sala de Guerra para acompanhar esta OP arquivada."
                      >
                        Abrir Sala de Guerra
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {distribution !== null && distribution.assignments.length > 0 && (
            <DistributionMap assignments={distribution.assignments} onError={onMapError} />
          )}
        </>
      )}
    </section>
  );
}
