import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Copy, Crosshair, Plus, Radar, Share2, Swords } from 'lucide-react';
import { parseCoord, parseCoordList } from '@shared/coords';
import {
  centralOpAnalysis,
  distributeTargets,
  distributionSummary,
  parseOriginsInput,
  splitTargetsFakes,
  type CentralOpRow,
  type DistributionInput,
  type DistributionResult,
  type EnemyVillageRef,
  type TargetLine,
} from '@shared/sg4-engine';
import type { DiplomacyRelations, WorldPlayer } from '@shared/types';
import Field from '../../components/Field';
import PageHeader from '../../components/PageHeader';
import ToastViewport from '../../components/Toast';
import WorldMapCanvas from '../sg1/WorldMapCanvas';
import { useToast } from '../../hooks/useToast';
import { MODULES } from '../../modules';

const HOUR_LABELS = [
  '1 Hora',
  '2 Horas',
  '3 Horas',
  '4 Horas',
  '5 Horas',
  '6 Horas',
  '7 Horas',
  '8 Horas',
];

const LINE_NAMES = ['PRIMEIRA', 'SEGUNDA', 'TERCEIRA', 'QUARTA', 'QUINTA', 'SEXTA'];

interface OriginLine {
  fullsFrom: string;
  fullsTo: string;
  coordsText: string;
}

function parseTags(text: string): string[] {
  return text
    .split(';')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Falha de comunicação com o processo principal.';
}

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

/** SG_4 — Criação de Operações (screen=ally&mode=contracts, grupo OP). */
export default function Sg4Page() {
  const { toasts, push, dismiss } = useToast();
  const moduleInfo = MODULES.find((module) => module.id === 'sg4');

  // ---- Seção A — OP com coordenada central ----
  const [relations, setRelations] = useState<DiplomacyRelations | null>(null);
  const [relationsFailed, setRelationsFailed] = useState(false);
  const [enemyTagsText, setEnemyTagsText] = useState('');
  const [centralCoordText, setCentralCoordText] = useState('');
  const [errorsA, setErrorsA] = useState<{ tags?: string; central?: string }>({});
  const [runErrorA, setRunErrorA] = useState('');
  const [loadingVillages, setLoadingVillages] = useState(false);
  const [opRows, setOpRows] = useState<CentralOpRow[] | null>(null);
  const [enemyVillages, setEnemyVillages] = useState<EnemyVillageRef[]>([]);
  const [nobleMinutes, setNobleMinutes] = useState(0);
  const [actions, setActions] = useState<Map<number, 'alvo' | 'fake'>>(new Map());
  const [cutoffHours, setCutoffHours] = useState(5);
  const [splitResult, setSplitResult] = useState<{ targets: string[]; fakes: string[] } | null>(null);
  const [sepByEnter, setSepByEnter] = useState(true);

  // Caches de dump para a seção B (moral da distribuição).
  const [playersCache, setPlayersCache] = useState<WorldPlayer[] | null>(null);

  // ---- Seção B — Distribuição de Alvos de OP ----
  const [originsText, setOriginsText] = useState('');
  const [lines, setLines] = useState<OriginLine[]>([
    { fullsFrom: '', fullsTo: '', coordsText: '' },
    { fullsFrom: '', fullsTo: '', coordsText: '' },
  ]);
  const [priority, setPriority] = useState<'nearest' | 'farthest'>('nearest');
  const [minMoraleText, setMinMoraleText] = useState('0');
  const [maxFieldsText, setMaxFieldsText] = useState('70');
  const [errorsB, setErrorsB] = useState<{ origins?: string }>({});
  const [runErrorB, setRunErrorB] = useState('');
  const [busyB, setBusyB] = useState(false);
  const [planning, setPlanning] = useState<DistributionResult | null>(null);
  const [distribution, setDistribution] = useState<DistributionResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.staffhub.world
      .relations()
      .then((current) => {
        if (!cancelled) setRelations(current);
      })
      .catch(() => {
        if (!cancelled) setRelationsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function ensureWorldData(): Promise<void> {
    const status = await window.staffhub.world.status();
    if (status.villageCount === 0) {
      push('info', 'Baixando dados do mundo…');
      await window.staffhub.world.refresh();
    }
  }

  // -----------------------------------------------------------------------
  // Seção A
  // -----------------------------------------------------------------------

  function useEnemyTagsFromDiplomacy(): void {
    if (relations === null) {
      push(
        'error',
        relationsFailed
          ? 'Diplomacia indisponível — faça login no jogo para carregar as relações.'
          : 'Diplomacia ainda carregando — tente de novo em instantes.',
      );
      return;
    }
    setEnemyTagsText(relations.enemies.map((enemy) => enemy.tag).join(';'));
    push('ok', `Inimigas da diplomacia preenchidas: ${relations.enemies.length} tribo(s).`);
  }

  async function runLoadEnemies(): Promise<void> {
    const tags = parseTags(enemyTagsText);
    const central = parseCoord(centralCoordText);
    const nextErrors: { tags?: string; central?: string } = {};
    if (tags.length === 0) nextErrors.tags = 'Informe ao menos uma tag inimiga (ex.: DARK;SAV).';
    if (central === null) nextErrors.central = 'Coordenada inválida — use o formato 123|456.';
    if (tags.length === 0 || central === null) {
      setErrorsA(nextErrors);
      const message = nextErrors.central ?? nextErrors.tags ?? 'Confira os campos da OP.';
      push('error', message);
      return;
    }
    setErrorsA({});
    setRunErrorA('');
    setLoadingVillages(true);
    setOpRows(null);
    setSplitResult(null);
    try {
      await ensureWorldData();
      const [villages, players, tribes, noble] = await Promise.all([
        window.staffhub.world.villages(),
        window.staffhub.world.players(),
        window.staffhub.world.tribes(),
        window.staffhub.world.nobleMinutes(),
      ]);
      const tagSet = new Set(tags.map((tag) => tag.toLowerCase()));
      const allyIds = new Set<number>();
      for (const ally of tribes) {
        if (tagSet.has(ally.tag.toLowerCase())) allyIds.add(ally.id);
      }
      if (allyIds.size === 0) {
        const message = 'Nenhuma tribo encontrada com as tags informadas.';
        setRunErrorA(message);
        push('error', message);
        return;
      }
      const playersById = new Map(players.map((player) => [player.id, player]));
      const enemies: EnemyVillageRef[] = [];
      for (const village of villages) {
        if (village.playerId === 0) continue;
        if (!allyIds.has(village.allyId)) continue;
        const player = playersById.get(village.playerId);
        enemies.push({
          playerId: village.playerId,
          playerName: player?.name ?? `Jogador ${village.playerId}`,
          coord: { x: village.x, y: village.y },
          points: village.points,
        });
      }
      if (enemies.length === 0) {
        const message = 'Nenhuma aldeia inimiga carregada para as tags informadas.';
        setRunErrorA(message);
        push('error', message);
        return;
      }
      const analysis = centralOpAnalysis(enemies, central, noble);
      setEnemyVillages(enemies);
      setNobleMinutes(noble);
      setPlayersCache(players);
      setOpRows(analysis.rows);
      const initialActions = new Map<number, 'alvo' | 'fake'>();
      for (const row of analysis.rows) initialActions.set(row.playerId, row.action);
      setActions(initialActions);
      push('ok', `${enemies.length} aldeia(s) inimiga(s) — ${analysis.rows.length} jogador(es).`);
    } catch (error) {
      const message = errorMessage(error);
      setRunErrorA(message);
      push('error', message);
    } finally {
      setLoadingVillages(false);
    }
  }

  function updateAction(playerId: number, action: 'alvo' | 'fake'): void {
    setActions((current) => {
      const next = new Map(current);
      next.set(playerId, action);
      return next;
    });
    setSplitResult(null);
  }

  function markAllFake(): void {
    if (opRows === null) return;
    const allFake = new Map<number, 'alvo' | 'fake'>();
    for (const row of opRows) allFake.set(row.playerId, 'fake');
    setActions(allFake);
    setSplitResult(null);
  }

  function runSplit(): void {
    const central = parseCoord(centralCoordText);
    if (opRows === null || enemyVillages.length === 0 || central === null || nobleMinutes <= 0) {
      const message = 'Obtenha os dados das aldeias antes de separar alvos e fakes.';
      setRunErrorA(message);
      push('error', message);
      return;
    }
    const result = splitTargetsFakes(enemyVillages, central, nobleMinutes, actions, cutoffHours);
    setSplitResult(result);
    push('ok', `Alvos: ${result.targets.length} · Fakes: ${result.fakes.length}.`);
  }

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      push('ok', 'Copiado para a área de transferência.');
    } catch {
      push('error', 'Não foi possível copiar — permissão de área de transferência negada.');
    }
  }

  // -----------------------------------------------------------------------
  // Seção B
  // -----------------------------------------------------------------------

  function updateLine(index: number, key: keyof OriginLine, value: string): void {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, [key]: value } : line)));
  }

  function removeLine(index: number): void {
    setLines((current) => (current.length > 1 ? current.filter((_, i) => i !== index) : current));
  }

  function addLine(): void {
    setLines((current) => [...current, { fullsFrom: '', fullsTo: '', coordsText: '' }]);
  }

  async function runDistribution(planOnly: boolean): Promise<void> {
    if (busyB) return;
    const nextErrors: { origins?: string } = {};
    const messages: string[] = [];

    let origins: ReturnType<typeof parseOriginsInput> | null = null;
    try {
      origins = parseOriginsInput(originsText);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Linhas de origem inválidas.';
      nextErrors.origins = message;
      messages.push(message);
    }

    const builtLines: TargetLine[] = [];
    for (const line of lines) {
      const targets = parseCoordList(line.coordsText);
      if (targets.length === 0) continue;
      const from = line.fullsFrom.trim() === '' ? 0 : Number(line.fullsFrom);
      const to = line.fullsTo.trim() === '' ? 200 : Number(line.fullsTo);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > 200 || from > to) {
        messages.push('Confira a faixa FULLS DE/ATÉ (0–200) das linhas de coordenadas.');
        break;
      }
      builtLines.push({ fullsFrom: from, fullsTo: to, targets });
    }
    if (builtLines.length === 0) {
      messages.push('Informe ao menos 1 coordenada de alvo nas linhas (123|456 456|123 …).');
    }

    const minMoraleRaw = Number(minMoraleText);
    const maxFields = Number(maxFieldsText);
    if (minMoraleText.trim() !== '' && !Number.isFinite(minMoraleRaw)) {
      messages.push('Moral aceita deve ser um número entre 0 e 100.');
    }
    if (!Number.isFinite(maxFields) || maxFields <= 0) {
      messages.push('Distância aceita deve ser um número de campos maior que 0.');
    }

    if (origins === null || messages.length > 0) {
      setErrorsB(nextErrors);
      setRunErrorB(nextErrors.origins === undefined ? (messages[0] ?? '') : '');
      push('error', messages[0] ?? 'Confira os parâmetros da distribuição.');
      return;
    }
    setErrorsB({});
    setRunErrorB('');
    setBusyB(true);
    try {
      await ensureWorldData();
      const players = playersCache ?? (await window.staffhub.world.players());
      if (playersCache === null) setPlayersCache(players);
      const noble = nobleMinutes > 0 ? nobleMinutes : await window.staffhub.world.nobleMinutes();
      if (nobleMinutes === 0) setNobleMinutes(noble);

      const originPoints = new Map(players.map((player) => [player.name, player.points]));
      const playerPointsById = new Map(players.map((player) => [player.id, player.points]));
      const targetPoints = new Map<string, number>();
      for (const enemy of enemyVillages) {
        if (enemy.points !== undefined) targetPoints.set(`${enemy.coord.x}|${enemy.coord.y}`, playerPointsById.get(enemy.playerId) ?? enemy.points ?? 0);
      }
      const minMorale = Math.min(100, Math.max(0, Math.round(minMoraleRaw)));
      const input: DistributionInput = {
        origins,
        lines: builtLines,
        nobleMinutesPerField: noble,
        priority,
        minMorale,
        maxFields,
        ...(originPoints.size > 0 ? { originPoints } : {}),
        ...(targetPoints.size > 0 ? { targetPoints } : {}),
      };
      const result = distributeTargets(input);
      if (planOnly) {
        setPlanning(result);
        push('ok', `Planificação: ${result.matrix.length} origem(ns) × ${result.lineTargets.length} alvo(s).`);
      } else {
        setDistribution(result);
        push(
          'ok',
          `Distribuição: ${result.assignments.length} atacante(s) alocado(s) — ${result.orphanOrigins.length} origem(ns) e ${result.orphanTargets.length} alvo(s) órfãos.`,
        );
      }
    } catch (error) {
      const message = errorMessage(error);
      setRunErrorB(message);
      push('error', message);
    } finally {
      setBusyB(false);
    }
  }

  const heatRange = useMemo(() => {
    if (planning === null) return { min: 0, max: 1 };
    const hours = planning.matrix.flatMap((row) => row.cells.map((cell) => cell.hours));
    if (hours.length === 0) return { min: 0, max: 1 };
    return { min: Math.min(...hours), max: Math.max(...hours) };
  }, [planning]);

  const separator = sepByEnter ? '\n' : ' ';

  return (
    <section className="page">
      <PageHeader
        kicker={`Módulo SG4 — Fase ${moduleInfo?.phase ?? 4}`}
        title={moduleInfo?.originalLabel ?? 'Criação de Operações'}
        description="OP por coordenada central com camadas de 1 a 8 horas, separação de alvos e fakes, e distribuição origem × alvo com moral."
      />

      {/* ===== Seção A — Criação de OP com Coordenada Central ===== */}
      <section className="page-section" aria-labelledby="sg4-op-title">
        <h2 className="section-title" id="sg4-op-title">Criação de OP com Coordenada Central</h2>
        <div className="card">
          <div className="card-body">
            <div className="sg4-form-grid">
              <div className="sg4-span-2">
                <Field
                  id="sg4-enemyTags"
                  label="TAG TRIBOS INIMIGAS (TAG;TAG;TAG)"
                  hint="Separe as tags com ; ou use o botão abaixo para preencher com a diplomacia."
                  error={errorsA.tags}
                >
                  <textarea
                    id="sg4-enemyTags"
                    className="textarea"
                    rows={2}
                    value={enemyTagsText}
                    aria-describedby={errorsA.tags !== undefined ? 'sg4-enemyTags-error' : 'sg4-enemyTags-hint'}
                    onChange={(event) => setEnemyTagsText(event.target.value)}
                  />
                  <div>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={useEnemyTagsFromDiplomacy}>
                      <Swords size={14} aria-hidden="true" />
                      Usar inimigas da diplomacia
                    </button>
                  </div>
                </Field>
              </div>
              <Field id="sg4-central" label="COORDENADA OP (123|456)" error={errorsA.central}>
                <input
                  id="sg4-central"
                  className="input"
                  placeholder="123|456"
                  value={centralCoordText}
                  aria-describedby={errorsA.central !== undefined ? 'sg4-central-error' : undefined}
                  onChange={(event) => setCentralCoordText(event.target.value)}
                />
              </Field>
            </div>
            <div className="sg4-form-actions">
              <button
                type="button"
                className="btn sg4-btn-green"
                onClick={() => void runLoadEnemies()}
                disabled={loadingVillages}
              >
                {loadingVillages ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    Obter Dados das Aldeias…
                  </>
                ) : (
                  <>
                    <Radar size={15} aria-hidden="true" />
                    Obter Dados das Aldeias
                  </>
                )}
              </button>
            </div>
            {runErrorA !== '' && (
              <p className="error" role="alert">{runErrorA}</p>
            )}
          </div>
        </div>

        {opRows !== null && (
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Análise por Jogador ({opRows.length})</h3>
              <span className="spacer" />
              <div className="sg4-cutoff">
                <label className="field-label" htmlFor="sg4-cutoff">Utilizar Coordenadas Até (1-5 horas)</label>
                <select
                  id="sg4-cutoff"
                  className="select"
                  value={cutoffHours}
                  onChange={(event) => {
                    setCutoffHours(Number(event.target.value));
                    setSplitResult(null);
                  }}
                >
                  {[1, 2, 3, 4, 5].map((hours) => (
                    <option key={hours} value={hours}>{hours}</option>
                  ))}
                </select>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={markAllFake}>
                Selecionar todos para fake
              </button>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Jogador</th>
                    {HOUR_LABELS.map((label) => (
                      <th scope="col" key={label} className="cell-num">{label}</th>
                    ))}
                    <th scope="col" className="cell-num">Outras</th>
                    <th scope="col">Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {opRows.map((row) => (
                    <tr key={row.playerId}>
                      <td className="cell-nowrap">{row.playerName}</td>
                      {row.hourCounts.map((count, index) => (
                        <td key={index} className="cell-num">{count}</td>
                      ))}
                      <td className="cell-num">{row.others}</td>
                      <td className="cell-nowrap">
                        <select
                          className="select sg4-action-cell"
                          value={actions.get(row.playerId) ?? 'fake'}
                          aria-label={`Ação do jogador ${row.playerName}`}
                          onChange={(event) => updateAction(row.playerId, event.target.value as 'alvo' | 'fake')}
                        >
                          <option value="fake">Fake</option>
                          <option value="alvo">Alvo</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-body">
              <button
                type="button"
                className="btn"
                onClick={runSplit}
              >
                <Crosshair size={15} aria-hidden="true" />
                Obter Alvos e Fakes
              </button>
            </div>
          </div>
        )}

        {splitResult !== null && (
          <div className="sg4-split">
            <div className="card">
              <div className="card-body">
                <div className="sg4-split-head">
                  <h4 className="sg4-split-title">QUANTIDADE DE ALDEIAS ALVO</h4>
                  <span className="sg4-count">{splitResult.targets.length}</span>
                </div>
                <label className="field">
                  <span className="field-label">ALDEIAS ALVOS</span>
                  <textarea
                    className="textarea sg4-coords"
                    rows={6}
                    readOnly
                    value={splitResult.targets.join(separator)}
                    aria-label="ALDEIAS ALVOS"
                  />
                </label>
              </div>
            </div>
            <div className="card">
              <div className="card-body">
                <div className="sg4-split-head">
                  <h4 className="sg4-split-title">QUANTIDADE DE ALDEIAS FAKE</h4>
                  <span className="sg4-count">{splitResult.fakes.length}</span>
                </div>
                <label className="field">
                  <span className="field-label">ALDEIAS FAKES</span>
                  <textarea
                    className="textarea sg4-coords"
                    rows={6}
                    readOnly
                    value={splitResult.fakes.join(separator)}
                    aria-label="ALDEIAS FAKES"
                  />
                </label>
              </div>
            </div>
            <div className="sg4-split-actions">
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={sepByEnter}
                  onChange={(event) => setSepByEnter(event.target.checked)}
                />
                <span>Separação com Enter</span>
              </label>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={splitResult.targets.length === 0}
                onClick={() => void copyText(splitResult.targets.join(separator))}
              >
                <Copy size={14} aria-hidden="true" />
                Copiar alvos
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={splitResult.fakes.length === 0}
                onClick={() => void copyText(splitResult.fakes.join(separator))}
              >
                <Copy size={14} aria-hidden="true" />
                Copiar fakes
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ===== Seção B — Distribuição de Alvos de OP ===== */}
      <section className="page-section" aria-labelledby="sg4-dist-title">
        <h2 className="section-title" id="sg4-dist-title">Distribuição de Alvos de OP</h2>
        <div className="card">
          <div className="card-body">
            <Field
              id="sg4-origins"
              label="INFORMAÇÕES ORIGEM (Nick;Nro Fulls;Coordenadas Origem)"
              hint="Cada coordenada de origem = 1 NT estacionado (1 alvo a receber)."
              error={errorsB.origins}
            >
              <textarea
                id="sg4-origins"
                className="textarea sg4-coords"
                rows={4}
                placeholder="hasua;50;686|420 686|424"
                value={originsText}
                aria-describedby={errorsB.origins !== undefined ? 'sg4-origins-error' : 'sg4-origins-hint'}
                onChange={(event) => setOriginsText(event.target.value)}
              />
            </Field>

            {lines.map((line, index) => (
              <div className="sg4-line-grid" key={index}>
                <label className="field">
                  <span className="field-label">FULLS DE</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={200}
                    placeholder="0"
                    value={line.fullsFrom}
                    onChange={(event) => updateLine(index, 'fullsFrom', event.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field-label">ATÉ</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={200}
                    placeholder="200"
                    value={line.fullsTo}
                    onChange={(event) => updateLine(index, 'fullsTo', event.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field-label">
                    COORDENADAS DESTINO {LINE_NAMES[index] ?? `${index + 1}ª`} LINHA (123|456 456|123 111|222)
                  </span>
                  <textarea
                    className="textarea"
                    rows={2}
                    placeholder="123|456 456|123 111|222"
                    value={line.coordsText}
                    onChange={(event) => updateLine(index, 'coordsText', event.target.value)}
                  />
                  <div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={lines.length <= 1}
                      onClick={() => removeLine(index)}
                    >
                      Remover linha
                    </button>
                  </div>
                </label>
              </div>
            ))}
            <button type="button" className="btn btn-ghost btn-sm" onClick={addLine}>
              <Plus size={14} aria-hidden="true" />
              Adicionar linha (faixa 0–200 = todos)
            </button>

            <div className="sg4-params">
              <fieldset className="field">
                <legend className="field-label">Priorizar</legend>
                <div className="sg4-radio-row">
                  <label className="checkbox-field">
                    <input
                      type="radio"
                      name="sg4-priority"
                      checked={priority === 'nearest'}
                      onChange={() => setPriority('nearest')}
                    />
                    mais próximas
                  </label>
                  <label className="checkbox-field">
                    <input
                      type="radio"
                      name="sg4-priority"
                      checked={priority === 'farthest'}
                      onChange={() => setPriority('farthest')}
                    />
                    mais distantes
                  </label>
                </div>
              </fieldset>
              <label className="field">
                <span className="field-label">Moral aceita (0 = ignorar)</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  value={minMoraleText}
                  onChange={(event) => setMinMoraleText(event.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Distância aceita (campos)</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={maxFieldsText}
                  onChange={(event) => setMaxFieldsText(event.target.value)}
                />
              </label>
            </div>

            <div className="sg4-form-actions">
              <button type="button" className="btn" disabled={busyB} onClick={() => void runDistribution(true)}>
                <Crosshair size={15} aria-hidden="true" />
                {busyB ? 'Calculando…' : 'Obter Planificação'}
              </button>
              <button type="button" className="btn" disabled={busyB} onClick={() => void runDistribution(false)}>
                <Share2 size={15} aria-hidden="true" />
                {busyB ? 'Calculando…' : 'Realizar Distribuição'}
              </button>
            </div>
            {runErrorB !== '' && (
              <p className="error" role="alert">{runErrorB}</p>
            )}
          </div>
        </div>

        {planning !== null && (
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Planificação (origem × alvo)</h3>
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
                          </th>
                          {row.cells.map((cell, index) => {
                            const span = heatRange.max - heatRange.min;
                            const t = span === 0 ? 0.5 : (cell.hours - heatRange.min) / span;
                            const morale = cell.morale;
                            return (
                              <td
                                key={index}
                                className="sg4-heat-cell"
                                style={heatStyle(t)}
                                title={`${cell.hours.toFixed(1)}h ${cell.fields}campos${morale !== null ? ` ${morale}%` : ''}`}
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
                {distribution.assignments.length} alocados · {distribution.orphanOrigins.length} origens ·{' '}
                {distribution.orphanTargets.length} alvos órfãos
              </span>
            </div>
            <div className="card-body">
              <label className="field">
                <span className="field-label">Nick;coords distribuídas</span>
                <textarea
                  className="textarea sg4-coords"
                  rows={6}
                  readOnly
                  value={distributionSummary(distribution)}
                  aria-label="Nick;coords distribuídas"
                />
                <div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={distribution.assignments.length === 0}
                    onClick={() => void copyText(distributionSummary(distribution))}
                  >
                    <Copy size={14} aria-hidden="true" />
                    Copiar distribuição
                  </button>
                </div>
              </label>
              {distribution.orphanOrigins.length > 0 && (
                <p className="muted">
                  Origens sem alvo:{' '}
                  {distribution.orphanOrigins.map((orphan) => `${orphan.playerName} (${orphan.origin})`).join(' · ')}
                </p>
              )}
              {distribution.orphanTargets.length > 0 && (
                <p className="muted">Alvos sem atacante: {distribution.orphanTargets.join(' ')}</p>
              )}
              {distribution.orphanOrigins.length === 0 && distribution.orphanTargets.length === 0 && (
                <p className="ok">Todos os alvos receberam um atacante.</p>
              )}
            </div>
          </div>
        )}

        {distribution !== null && distribution.assignments.length > 0 && <DistributionMap assignments={distribution.assignments} onError={(message) => push('error', message)} />}
      </section>

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </section>
  );
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
        <h3 className="card-title">Visualização da Distribuição</h3>
        <span className="muted">● origens (NTs) · □ alvos</span>
      </div>
      <div className="card-body">
        <WorldMapCanvas villages={villages} markings={EMPTY_MARKINGS} highlights={targets} origins={origins} />
      </div>
    </div>
  );
}