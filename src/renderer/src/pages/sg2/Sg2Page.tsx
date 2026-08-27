import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
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
import {
  fullSemiReport,
  formatFullSemiRows,
  formatOriginsRows,
  type FullSemiReport,
  type FullSemiSortBy,
} from '@shared/full-semi';
import { UNITS, type UnitCounts, type UnitId } from '@shared/units';
import { TW_UNIT_ICONS } from '../../assets';
import EmptyState from '../../components/EmptyState';
import Field from '../../components/Field';
import PageHeader from '../../components/PageHeader';
import ProgressBar from '../../components/ProgressBar';
import StatBlock from '../../components/StatBlock';
import ToastViewport from '../../components/Toast';
import { useSessionStatus } from '../../hooks/useSessionStatus';
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

/** Unidades do conjunto OFENSIVO por padrão do contador Full/Semi. */
const OFFENSIVE_UNIT_IDS: ReadonlySet<string> = new Set(['axe', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'snob']);

/** Ks 0-99 de um texto ("55 77" → [55, 77]). */
function parseKs(text: string): number[] {
  return [...new Set((text.match(/\d{1,2}/g) ?? []).map(Number).filter((k) => k >= 0 && k <= 99))];
}

/** Nicks de um texto colado (espaço/;/quebra de linha como separadores). */
function parseNames(text: string): string[] {
  return text.split(/[\s;]+/).map((name) => name.trim()).filter((name) => name.length > 0);
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
  const [collectFailures, setCollectFailures] = useState<{ playerName: string; reason: string }[] | null>(null);
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
  const [kText, setKText] = useState('');
  const [kMode, setKMode] = useState<'incluir' | 'excluir'>('incluir');
  // ---- Contador Full/Semi (relatório premium) + Grupos ----
  const [fullPopText, setFullPopText] = useState('18000');
  const [semiPopText, setSemiPopText] = useState('12000');
  const [minFullsText, setMinFullsText] = useState('0');
  const [minSemisText, setMinSemisText] = useState('0');
  const [fsSort, setFsSort] = useState<FullSemiSortBy>('fulls');
  const [fsUnitMode, setFsUnitMode] = useState<'ofensivas' | 'todas' | 'custom'>('ofensivas');
  const [fsCustomUnits, setFsCustomUnits] = useState<Set<string>>(new Set());
  const [fsKText, setFsKText] = useState('');
  const [fsKMode, setFsKMode] = useState<'incluir' | 'excluir'>('incluir');
  const [fsPlayersText, setFsPlayersText] = useState('');
  const [fsPlayersMode, setFsPlayersMode] = useState<'incluir' | 'excluir'>('excluir');
  const [report, setReport] = useState<FullSemiReport | null>(null);
  const [fsExpanded, setFsExpanded] = useState<Set<number>>(new Set());
  const [fullSemiBusy, setFullSemiBusy] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupPapel, setGroupPapel] = useState<'origem' | 'alvo'>('origem');
  const [groupAuthor, setGroupAuthor] = useState('');
  const [groupBusy, setGroupBusy] = useState(false);
  const unitPopsRef = useRef<Record<string, number> | null>(null);
  const session = useSessionStatus();

  /** Unidades presentes no snapshot (ordem do formulário, depois as demais). */
  const snapshotUnitIds = useMemo<string[]>(() => {
    if (snapshot === null) return [];
    const present = new Set<string>();
    for (const entry of snapshot.entries) {
      for (const [unit, count] of Object.entries(entry.units)) {
        if (count > 0) present.add(unit);
      }
    }
    const ordered: string[] = FILTER_UNIT_ORDER.filter((id) => present.has(id));
    for (const unit of [...present].sort((a, b) => a.localeCompare(b, 'pt-BR'))) {
      if (!ordered.includes(unit)) ordered.push(unit);
    }
    return ordered;
  }, [snapshot]);

  /** IDs contabilizados no modo atual (undefined = todas as unidades). */
  function fsUnitIds(): string[] | undefined {
    if (fsUnitMode === 'todas') return undefined;
    if (fsUnitMode === 'ofensivas') return snapshotUnitIds.filter((id) => OFFENSIVE_UNIT_IDS.has(id));
    return fsCustomUnits.size > 0 ? [...fsCustomUnits] : undefined;
  }
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
      const snapshotAfter = await window.staffhub.troops.get('troops');
      const failed = snapshotAfter?.failures ?? [];
      if (snapshotAfter) {
        const playersSet = new Set(snapshotAfter.entries.map((e) => e.playerName));
        const villages = snapshotAfter.entries.filter((e) => e.coord.x >= 0).length;
        setMemorySummary({
          players: playersSet.size,
          villages,
          collectedAt: new Date(snapshotAfter.collectedAt).toLocaleString('pt-BR'),
          source: snapshotAfter.source === 'summary' ? 'resumo (por jogador)' : 'por aldeia (por membro)',
        });
      }
      await refreshMemory();
      if (failed.length > 0) {
        push('info', `Coleta concluída com ${failed.length} membro(s) com erro — lista abaixo do painel de memória.`);
        setCollectFailures(failed);
      } else {
        push('ok', kind === 'members' ? 'Coleta de tropas concluída — dados em memória atualizados.' : 'Resumo coletado — dados em memória atualizados.');
        setCollectFailures(null);
      }
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
    const ks = [...new Set((kText.match(/\d{1,2}/g) ?? []).map((value) => Number(value)).filter((k) => k >= 0 && k <= 99))];
    if (ks.length > 0) filters.kFilter = { ks, mode: kMode };
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

  /** Entradas do snapshot restritas ao resultado da filtragem corrente. */
  function resultEntries(): { playerName: string; coord: { x: number; y: number }; units: Record<string, number> }[] {
    if (snapshot === null || result === null) return [];
    const porJogador = new Map(result.players.map((player) => [player.playerName, new Set(player.coords)]));
    return snapshot.entries
      .filter((entry) => entry.coord.x >= 0)
      .filter((entry) => porJogador.get(entry.playerName)?.has(`${entry.coord.x}|${entry.coord.y}`) === true)
      .map((entry) => ({ playerName: entry.playerName, coord: entry.coord, units: entry.units as Record<string, number> }));
  }

  async function runFullSemi(): Promise<void> {
    if (result === null || snapshot === null) return;
    const fullPop = Number(fullPopText);
    const semiPop = Number(semiPopText);
    setFullSemiBusy(true);
    try {
      if (unitPopsRef.current === null) {
        unitPopsRef.current = await window.staffhub.world.unitPops();
      }
      const ks = parseKs(fsKText);
      const names = parseNames(fsPlayersText);
      const units = fsUnitIds();
      const next = fullSemiReport(
        { entries: resultEntries(), popByUnit: unitPopsRef.current ?? {} },
        {
          fullPop,
          semiPop,
          ...(units !== undefined ? { unitIds: units } : {}),
          ...(ks.length > 0 ? { kFilter: { ks, mode: fsKMode } } : {}),
          ...(names.length > 0 ? { playerFilter: { names, mode: fsPlayersMode } } : {}),
          sortBy: fsSort,
          minFulls: Number.isFinite(Number(minFullsText)) ? Math.max(0, Math.round(Number(minFullsText))) : 0,
          minSemis: Number.isFinite(Number(minSemisText)) ? Math.max(0, Math.round(Number(minSemisText))) : 0,
        },
      );
      setReport(next);
      setFsExpanded(new Set());
      push('ok', `Contagem pronta: ${next.totals.players} jogador(es), ${next.totals.fulls} full(s), ${next.totals.semis} semi(s).`);
    } catch (error) {
      const message = errorMessage(error);
      push('error', message);
    } finally {
      setFullSemiBusy(false);
    }
  }

  /** Critério PT-BR dos filtros atuais — vai congelado no grupo. */
  function criterioText(): string {
    const parts: string[] = [];
    const minimums = buildFilters().unitMinimums ?? {};
    const minDesc = Object.entries(minimums).map(([unit, min]) => `${min}+ ${UNITS[unit as UnitId]?.name ?? unit}`).join(', ');
    if (minDesc !== '') parts.push(mode === 'has' ? `possui ${minDesc}` : `não possui ${minDesc}`);
    const ks = parseKs(kText);
    if (ks.length > 0) parts.push(`K consulta ${kMode} ${ks.join(',')}`);
    if (coordsText.trim() !== '') parts.push('lista de coordenadas');
    const fsKs = parseKs(fsKText);
    if (fsKs.length > 0) parts.push(`K contador ${fsKMode} ${fsKs.join(',')}`);
    const units = fsUnitIds();
    if (units !== undefined) parts.push(`unidades: ${units.map((id) => UNITS[id as UnitId]?.name ?? id).join('+')}`);
    parts.push(`FULL≥${fullPopText}, SEMI≥${semiPopText}`);
    return parts.join('; ');
  }

  async function saveGroup(): Promise<void> {
    if (result === null) return;
    const nome = groupName.trim();
    if (nome === '') {
      push('error', 'Dê um nome ao grupo antes de salvar.');
      return;
    }
    const mundo = session.world ?? '';
    if (mundo === '') {
      push('error', 'Sessão sem mundo identificado — faça login antes de salvar o grupo.');
      return;
    }
    setGroupBusy(true);
    try {
      // Sem contador rodado: agrupa sem fulls/semis (0/0) com as coords do
      // resultado; com contador: congelam as contagens e as coords full→semi.
      const perPlayer = report !== null
        ? report.players.map((player) => ({
            playerName: player.playerName,
            fulls: player.fulls,
            semis: player.semis,
            coords: player.villages.map((village) => village.coord),
          }))
        : result.players.map((player) => ({
            playerName: player.playerName,
            fulls: 0,
            semis: 0,
            coords: player.coords,
          }));
      const entry = await window.staffhub.groups.save({
        nome,
        mundo,
        autor: groupAuthor.trim() === '' ? (session.player ?? 'staff') : groupAuthor.trim(),
        papel: groupPapel,
        coords: perPlayer.flatMap((player) => player.coords),
        perPlayer,
        criterio: criterioText(),
      });
      push('ok', `Grupo "${entry.nome}" salvo (${entry.coords.length} coordenadas) — disponível na Sala de Guerra.`);
    } catch (error) {
      push('error', errorMessage(error));
    } finally {
      setGroupBusy(false);
    }
  }

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      push('ok', 'Copiado para a área de transferência.');
    } catch {
      push('error', 'Não foi possível copiar — selecione e use Ctrl+C.');
    }
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

      {collectFailures !== null && (
        <section className="page-section" aria-label="Membros com erro na coleta">
          <div className="card">
            <div className="card-header"><h2 className="card-title">Membros com erro na última coleta ({collectFailures.length})</h2></div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Membro</th><th>Motivo</th></tr></thead>
                <tbody>
                  {collectFailures.map((failure) => (
                    <tr key={failure.playerName}><td className="cell-nowrap">{failure.playerName}</td><td className="cell-detail muted">{failure.reason}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted">Os demais membros foram coletados normalmente — filtro e classificação usam o que veio.</p>
          </div>
        </section>
      )}

      {/* ===== Painel Dados em Memória ===== */}
      <section className="page-section" aria-labelledby="sg2-memory-title">
        <h2 className="section-title" id="sg2-memory-title">Dados em Memória</h2>
        <div className="card">
          <div className="card-body">
            <div className="sg2-memory-bar">
              <p className="sg2-memory-date muted">
                Data da última atualização: <strong>{updatedLabel}</strong>
              </p>
              <div className="sg2-memory-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void exhibit()}
                  disabled={collecting !== null || snapshot === null}
                >
                  <Eye size={14} aria-hidden="true" />
                  Exibir Dados
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
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
                  className="btn"
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
                        hint="Separadas por espaço ou Enter — normalmente a saída do SG1."
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

                    <div className="field">
                      <span className="field-label">Continentes K (ex.: 55 77)</span>
                      <div className="sg2-axis-inputs">
                        <input
                          className="input"
                          placeholder="55 77"
                          value={kText}
                          aria-label="Continentes K"
                          onChange={(event) => setKText(event.target.value)}
                        />
                        <div className="sg2-radio-row" role="radiogroup" aria-label="Modo do filtro por continente">
                          <label className="checkbox-field">
                            <input type="radio" name="sg2-kmode" checked={kMode === 'incluir'} onChange={() => setKMode('incluir')} />
                            incluir apenas
                          </label>
                          <label className="checkbox-field">
                            <input type="radio" name="sg2-kmode" checked={kMode === 'excluir'} onChange={() => setKMode('excluir')} />
                            excluir
                          </label>
                        </div>
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

            {result !== null && (
              <div className="card">
                <div className="card-header">
                  <h3 className="card-title">Contador Full/Semi</h3>
                  <span className="spacer" />
                  <span className="pill pill--muted">{result.totalVillages} aldeia(s) no filtro</span>
                </div>
                <div className="card-body">
                  <div className="sg4-params">
                    <label className="field">
                      <span className="field-label">População mínima FULL</span>
                      <input className="input" type="number" min={1} value={fullPopText} aria-label="População mínima para FULL" onChange={(event) => setFullPopText(event.target.value)} />
                    </label>
                    <label className="field">
                      <span className="field-label">População mínima SEMI</span>
                      <input className="input" type="number" min={1} value={semiPopText} aria-label="População mínima para SEMI" onChange={(event) => setSemiPopText(event.target.value)} />
                    </label>
                    <label className="field">
                      <span className="field-label">Mín. de fulls por jogador</span>
                      <input className="input" type="number" min={0} value={minFullsText} aria-label="Mínimo de aldeias full por jogador" onChange={(event) => setMinFullsText(event.target.value)} />
                    </label>
                    <label className="field">
                      <span className="field-label">Mín. de semis por jogador</span>
                      <input className="input" type="number" min={0} value={minSemisText} aria-label="Mínimo de aldeias semi por jogador" onChange={(event) => setMinSemisText(event.target.value)} />
                    </label>
                    <label className="field">
                      <span className="field-label">Ordenar por</span>
                      <select className="select" value={fsSort} aria-label="Ordenação do contador" onChange={(event) => setFsSort(event.target.value as FullSemiSortBy)}>
                        <option value="fulls">Mais fulls</option>
                        <option value="semis">Mais semis</option>
                        <option value="total">Mais aldeias (full+semi)</option>
                        <option value="nick">Nick (A–Z)</option>
                      </select>
                    </label>
                    <div className="field">
                      <span className="field-label">Contagem</span>
                      <button type="button" className="btn" onClick={() => void runFullSemi()} disabled={fullSemiBusy}>
                        {fullSemiBusy ? <><span className="btn-spinner" aria-hidden="true" /> Contando…</> : 'Contar Full/Semi'}
                      </button>
                    </div>
                  </div>

                  <div className="field" style={{ marginTop: 12 }}>
                    <span className="field-label">Unidades contabilizadas na população</span>
                    <div className="sg2-radio-row" role="radiogroup" aria-label="Conjunto de unidades contabilizadas" style={{ marginBottom: 6 }}>
                      <label className="checkbox-field">
                        <input type="radio" name="fs-units-mode" checked={fsUnitMode === 'ofensivas'} onChange={() => setFsUnitMode('ofensivas')} />
                        ofensivas do mundo
                      </label>
                      <label className="checkbox-field">
                        <input type="radio" name="fs-units-mode" checked={fsUnitMode === 'todas'} onChange={() => setFsUnitMode('todas')} />
                        todas as unidades
                      </label>
                      <label className="checkbox-field">
                        <input type="radio" name="fs-units-mode" checked={fsUnitMode === 'custom'} onChange={() => { setFsUnitMode('custom'); if (fsCustomUnits.size === 0) setFsCustomUnits(new Set(snapshotUnitIds.filter((id) => OFFENSIVE_UNIT_IDS.has(id)))); }} />
                        personalizado
                      </label>
                    </div>
                    {fsUnitMode === 'custom' && (
                      <div className="fs-chips">
                        {snapshotUnitIds.map((id) => {
                          const on = fsCustomUnits.has(id);
                          return (
                            <label key={id} className={`fs-chip${on ? ' fs-chip--on' : ''}`}>
                              <input
                                type="checkbox"
                                checked={on}
                                aria-label={`Contabilizar ${UNITS[id as UnitId]?.name ?? id}`}
                                onChange={() => {
                                  setFsCustomUnits((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(id)) next.delete(id);
                                    else next.add(id);
                                    return next;
                                  });
                                }}
                              />
                              {TW_UNIT_ICONS[id as UnitId] !== undefined && <img src={TW_UNIT_ICONS[id as UnitId]} alt="" width={16} height={16} />}
                              {UNITS[id as UnitId]?.name ?? id}
                            </label>
                          );
                        })}
                        <span className="muted">{fsCustomUnits.size === 0 ? 'nenhuma marcada = todas contam' : `${fsCustomUnits.size} marcada(s)`}</span>
                      </div>
                    )}
                  </div>

                  <div className="sg4-params">
                    <label className="field">
                      <span className="field-label">Continentes K (ex.: 55 77)</span>
                      <input className="input" placeholder="55 77" value={fsKText} aria-label="Continentes do contador" onChange={(event) => setFsKText(event.target.value)} />
                      <div className="sg2-radio-row" role="radiogroup" aria-label="Modo do K do contador">
                        <label className="checkbox-field">
                          <input type="radio" name="fs-kmode" checked={fsKMode === 'incluir'} onChange={() => setFsKMode('incluir')} />
                          incluir apenas
                        </label>
                        <label className="checkbox-field">
                          <input type="radio" name="fs-kmode" checked={fsKMode === 'excluir'} onChange={() => setFsKMode('excluir')} />
                          excluir
                        </label>
                      </div>
                    </label>
                    <label className="field">
                      <span className="field-label">Jogadores (nicks, um por linha ou espaço)</span>
                      <textarea className="textarea" rows={2} placeholder="nick1 nick2" value={fsPlayersText} aria-label="Filtro por jogadores do contador" onChange={(event) => setFsPlayersText(event.target.value)} />
                      <div className="sg2-radio-row" role="radiogroup" aria-label="Modo do filtro por jogadores">
                        <label className="checkbox-field">
                          <input type="radio" name="fs-pmode" checked={fsPlayersMode === 'incluir'} onChange={() => setFsPlayersMode('incluir')} />
                          incluir apenas
                        </label>
                        <label className="checkbox-field">
                          <input type="radio" name="fs-pmode" checked={fsPlayersMode === 'excluir'} onChange={() => setFsPlayersMode('excluir')} />
                          excluir
                        </label>
                      </div>
                    </label>
                  </div>

                  {report !== null && (
                    <>
                      {report.unknownUnits.length > 0 && (
                        <div className="callout callout--warn" role="alert">
                          <AlertTriangle size={16} className="callout-icon" aria-hidden="true" />
                          <span>
                            Unidades sem população no unit-info do mundo ({report.unknownUnits.join(', ')}) — as contagens podem subestimar.
                          </span>
                        </div>
                      )}
                      <div className="stat-row" style={{ marginTop: 12 }}>
                        <StatBlock label="Jogadores" icon={Users} value={report.totals.players} delta="após os filtros do contador" />
                        <StatBlock label="Fulls" icon={Swords} tone="ok" value={report.totals.fulls} delta={`pop ≥ ${fullPopText}`} />
                        <StatBlock label="Semis" icon={ShieldCheck} tone="gold" value={report.totals.semis} delta={`pop ≥ ${semiPopText}`} />
                        <StatBlock label="Aldeias" icon={Layers} value={report.totals.villages} delta="full + semi" />
                      </div>

                      <div className="table-wrap" style={{ marginTop: 12 }}>
                        <table className="table">
                          <thead>
                            <tr>
                              <th scope="col">Jogador</th>
                              <th scope="col" className="cell-num">Fulls</th>
                              <th scope="col" className="cell-num">Semis</th>
                              <th scope="col" className="cell-num">Total</th>
                              <th scope="col">Continentes</th>
                            </tr>
                          </thead>
                          <tbody>
                            {report.players.map((player, index) => {
                              const isOpen = fsExpanded.has(index);
                              return (
                                <Fragment key={`${player.playerName}-${index}`}>
                                  <tr>
                                    <td>
                                      <button
                                        type="button"
                                        className="sg2-row-toggle"
                                        aria-expanded={isOpen}
                                        aria-controls={`fs-drilldown-${index}`}
                                        onClick={() => {
                                          setFsExpanded((prev) => {
                                            const next = new Set(prev);
                                            if (next.has(index)) next.delete(index);
                                            else next.add(index);
                                            return next;
                                          });
                                        }}
                                      >
                                        {isOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                                        <span>{player.playerName}</span>
                                      </button>
                                    </td>
                                    <td className="cell-num tabular"><strong>{player.fulls}</strong></td>
                                    <td className="cell-num tabular">{player.semis}</td>
                                    <td className="cell-num tabular muted">{player.fulls + player.semis}</td>
                                    <td>
                                      <span className="fs-ks">
                                        {player.byK.map((k) => (
                                          <span key={k.k} className="pill pill--muted cell-nowrap" title={`K${k.k}: ${k.fulls} full(s), ${k.semis} semi(s)`}>
                                            K{k.k} · {k.fulls}F{k.semis > 0 ? `/${k.semis}S` : ''}
                                          </span>
                                        ))}
                                      </span>
                                    </td>
                                  </tr>
                                  {isOpen && (
                                    <tr id={`fs-drilldown-${index}`} className="sg2-drilldown">
                                      <td colSpan={5} className="sg2-coords">
                                        <div className="table-wrap">
                                          <table className="table">
                                            <thead>
                                              <tr>
                                                <th scope="col">Coordenada</th>
                                                <th scope="col" className="cell-num">K</th>
                                                <th scope="col" className="cell-num">População</th>
                                                <th scope="col">Nível</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {player.villages.map((village) => (
                                                <tr key={village.coord}>
                                                  <td className="cell-nowrap">{village.coord}</td>
                                                  <td className="cell-num">K{village.k}</td>
                                                  <td className="cell-num tabular">{village.pop.toLocaleString('pt-BR')}</td>
                                                  <td>{village.tier === 'full' ? <span className="ok">FULL</span> : <span className="text-warn">SEMI</span>}</td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      </td>
                                    </tr>
                                  )}
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyText(formatFullSemiRows(report.players))}>
                          <Copy size={14} aria-hidden="true" />
                          Copiar contagem (nick;fulls;semis;coords)
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyText(formatOriginsRows(report.players))}>
                          <Copy size={14} aria-hidden="true" />
                          Copiar origens SG_4 (nick;fulls;coords)
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void copyText(report.players.flatMap((player) => player.villages.filter((village) => village.tier === 'full').map((village) => village.coord)).join('\n'))}
                        >
                          <Copy size={14} aria-hidden="true" />
                          Copiar alvos FULL (um por linha)
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void copyText(report.players.flatMap((player) => player.villages.map((village) => village.coord)).join('\n'))}
                        >
                          <Copy size={14} aria-hidden="true" />
                          Copiar alvos FULL+SEMI (um por linha)
                        </button>
                      </div>
                    </>
                  )}

                  <h4 className="section-title" style={{ marginTop: 16 }}>Salvar como grupo</h4>
                  <p className="muted">Congela as coordenadas do resultado atual para reutilizar na montagem de OPs (Sala de Guerra → Grupos).</p>
                  <div className="sg4-params">
                    <label className="field">
                      <span className="field-label">Nome do grupo</span>
                      <input className="input" value={groupName} aria-label="Nome do grupo" placeholder="Ofensivos K55" onChange={(event) => setGroupName(event.target.value)} />
                    </label>
                    <div className="field">
                      <span className="field-label">Papel na OP</span>
                      <div className="sg2-radio-row" role="radiogroup" aria-label="Papel do grupo">
                        <label className="checkbox-field">
                          <input type="radio" name="group-papel" checked={groupPapel === 'origem'} onChange={() => setGroupPapel('origem')} />
                          origem
                        </label>
                        <label className="checkbox-field">
                          <input type="radio" name="group-papel" checked={groupPapel === 'alvo'} onChange={() => setGroupPapel('alvo')} />
                          alvo
                        </label>
                      </div>
                    </div>
                    <label className="field">
                      <span className="field-label">Autor</span>
                      <input className="input" value={groupAuthor} aria-label="Autor do grupo" onChange={(event) => setGroupAuthor(event.target.value)} />
                    </label>
                    <div className="field">
                      <span className="field-label">Salvar</span>
                      <button type="button" className="btn btn-ghost" onClick={() => void saveGroup()} disabled={groupBusy}>
                        {groupBusy ? <><span className="btn-spinner" aria-hidden="true" /> Salvando…</> : 'Salvar como grupo'}
                      </button>
                    </div>
                  </div>
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
                        {report !== null && (<>
                          <th scope="col" className="cell-num" title="Aldeias FULL no contador atual">Fulls</th>
                          <th scope="col" className="cell-num" title="Aldeias SEMI no contador atual">Semis</th>
                        </>)}
                      </tr>
                    </thead>
                    <tbody>
                      {result.players.map((player, index) => {
                        const isOpen = expanded.has(index);
                        const fs = report?.players.find((p) => p.playerName === player.playerName);
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
                              {report !== null && (<>
                                <td className="cell-num tabular">{fs !== undefined ? <strong>{fs.fulls}</strong> : <span className="muted">—</span>}</td>
                                <td className="cell-num tabular">{fs !== undefined ? fs.semis : <span className="muted">—</span>}</td>
                              </>)}
                            </tr>
                            {isOpen && (
                              <tr id={`sg2-drilldown-${index}`} className="sg2-drilldown">
                                <td colSpan={report !== null ? 4 : 2} className="sg2-coords">
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
