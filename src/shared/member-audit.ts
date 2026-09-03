// Motor de leitura da aba "Auditoria de Membros" (SG_2): derivado do histórico
// compacto de tropas de './snapshot-history'. Puro e sem I/O — consome apenas
// TroopsHistoryVersion/TroopsDiffRow e devolve séries temporais, sinais de
// auditoria e exports TSV (planilha-friendly). Não substitui o diff: lê por cima.

import type { TroopsDiffRow, TroopsHistoryVersion } from './snapshot-history';
import { detectMassiveRecruitment } from './snapshot-history';

/** Ordem cronológica ASC (primeira coleta primeiro): por collectedAt, empate por id. */
function orderByCollectedAtAsc(versions: readonly TroopsHistoryVersion[]): TroopsHistoryVersion[] {
  return [...versions].sort((v1, v2) => {
    if (v1.collectedAt !== v2.collectedAt) return v1.collectedAt < v2.collectedAt ? -1 : 1;
    if (v1.id !== v2.id) return v1.id < v2.id ? -1 : 1;
    return 0;
  });
}

/** Um ponto por versão (ordem CRONOLÓGICA ASC — primeira coleta primeiro). */
export interface TribeTimelinePoint {
  versionId: string;
  collectedAt: string;
  players: number;
  villages: number;
  offPop: number;
  defPop: number;
}

/**
 * Linha do tempo da TRIBO: um ponto por versão, com as somas dos agregados
 * dos jogadores daquela coleta (villages/offPop/defPop). Ordenação ASC por
 * collectedAt, empate por versionId para determinismo. Não muta o input.
 */
export function tribeTimeline(versions: readonly TroopsHistoryVersion[]): TribeTimelinePoint[] {
  return orderByCollectedAtAsc(versions).map((version) => {
    let villages = 0;
    let offPop = 0;
    let defPop = 0;
    for (const player of version.players) {
      villages += player.villageCount;
      offPop += player.offPop;
      defPop += player.defPop;
    }
    return {
      versionId: version.id,
      collectedAt: version.collectedAt,
      players: version.players.length,
      villages,
      offPop,
      defPop,
    };
  });
}

/** Ficha de UM jogador versão a versão (ASC). */
export interface PlayerTimelinePoint {
  versionId: string;
  collectedAt: string;
  /** false = jogador ausente nessa versão (entrou depois / saiu). */
  present: boolean;
  /** 0 quando ausente. */
  offPop: number;
  defPop: number;
  villageCount: number;
  /** vs ponto ANTERIOR DA LINHA: null quando o anterior não existe ou este/ele é ausente. */
  offPopDelta: number | null;
  defPopDelta: number | null;
  villageCountDelta: number | null;
  situation: 'presente' | 'entrou' | 'saiu' | 'ausente';
}

/**
 * Ficha de um jogador (matching por nome EXATO — o agregado já vem do jogo):
 * um ponto por versão em ordem ASC. Deltas comparam com o ponto anterior da
 * linha e só existem quando AMBOS os pontos estão presentes. Situação:
 * 'entrou' = presente sem nenhuma presença anterior; 'saiu' = ausente após já
 * ter estado presente (vale a partir da primeira ausência, não só na última);
 * 'ausente' = ausente sem presença anterior (ainda não entrou); 'presente' = o resto.
 */
export function playerTimeline(versions: readonly TroopsHistoryVersion[], playerName: string): PlayerTimelinePoint[] {
  const points: PlayerTimelinePoint[] = [];
  let everPresent = false;
  let prev: PlayerTimelinePoint | null = null;
  for (const version of orderByCollectedAtAsc(versions)) {
    const player = version.players.find((candidate) => candidate.playerName === playerName);
    const present = player !== undefined;
    const offPop = player?.offPop ?? 0;
    const defPop = player?.defPop ?? 0;
    const villageCount = player?.villageCount ?? 0;
    const point: PlayerTimelinePoint = {
      versionId: version.id,
      collectedAt: version.collectedAt,
      present,
      offPop,
      defPop,
      villageCount,
      // Delta só existe quando o ponto anterior da linha existe E ambos estão presentes.
      offPopDelta: prev !== null && prev.present && present ? offPop - prev.offPop : null,
      defPopDelta: prev !== null && prev.present && present ? defPop - prev.defPop : null,
      villageCountDelta: prev !== null && prev.present && present ? villageCount - prev.villageCount : null,
      situation: present ? (everPresent ? 'presente' : 'entrou') : everPresent ? 'saiu' : 'ausente',
    };
    if (present) everPresent = true;
    prev = point;
    points.push(point);
  }
  return points;
}

/** Sinais de auditoria sobre um diff A→B. */
export type AuditSignalKind = 'massive-recruit' | 'sharp-decline' | 'joined' | 'left' | 'inactive';

export interface AuditSignal {
  playerName: string;
  kind: AuditSignalKind;
  offPopDelta: number;
  defPopDelta: number;
  villageCountDelta: number;
}

/** Limiar padrão de queda acentuada de pop ofensiva (delta <= -15000 dispara). */
export const DEFAULT_SHARP_DECLINE_OFF_POP = 15000;
/** Limiar padrão de queda acentuada de aldeias (delta <= -3 dispara). */
export const DEFAULT_SHARP_DECLINE_VILLAGES = 3;
/** Tolerância padrão de variação de pop off para considerar inativo. */
export const DEFAULT_INACTIVE_ABS_OFF_POP = 500;
/** Tolerância padrão de variação de pop def para considerar inativo. */
export const DEFAULT_INACTIVE_ABS_DEF_POP = 500;

export interface AuditSignalsOptions {
  /** Repassa ao detectMassiveRecruitment (default dele). */
  minOffPopGrowth?: number;
  minVillageGrowth?: number;
  /** default 15000 */
  sharpDeclineOffPop?: number;
  /** default 3 */
  sharpDeclineVillages?: number;
  /** default 500 */
  inactiveAbsOffPop?: number;
  /** default 500 */
  inactiveAbsDefPop?: number;
}

/** Ordem canônica dos sinais (a do union type) para ordenação determinística. */
const KIND_ORDER: Record<AuditSignalKind, number> = {
  'massive-recruit': 0,
  'sharp-decline': 1,
  joined: 2,
  left: 3,
  inactive: 4,
};

/**
 * Sinais de auditoria sobre um diff A→B. Um jogador pode gerar MAIS DE UM
 * sinal (ex.: joined + massive-recruit). Cada regra é independente, com duas
 * exceções anti-ruído: 'sharp-decline' NÃO dispara para quem saiu (o sinal
 * 'left' já é a explicação — queda de quem ficou é que interessa) e 'inactive'
 * exige presença nos dois lados (nunca dispara para joined/left). Ordenação:
 * por kind na ordem do union type, depois nome pt-BR.
 */
export function auditSignals(diff: readonly TroopsDiffRow[], opts?: AuditSignalsOptions): AuditSignal[] {
  const sharpDeclineOffPop = opts?.sharpDeclineOffPop ?? DEFAULT_SHARP_DECLINE_OFF_POP;
  const sharpDeclineVillages = opts?.sharpDeclineVillages ?? DEFAULT_SHARP_DECLINE_VILLAGES;
  const inactiveAbsOffPop = opts?.inactiveAbsOffPop ?? DEFAULT_INACTIVE_ABS_OFF_POP;
  const inactiveAbsDefPop = opts?.inactiveAbsDefPop ?? DEFAULT_INACTIVE_ABS_DEF_POP;
  // exactOptionalPropertyTypes: só inclui as chaves de detecção maciça quando definidas.
  const detectOpts: { minOffPopGrowth?: number; minVillageGrowth?: number } = {};
  if (opts?.minOffPopGrowth !== undefined) detectOpts.minOffPopGrowth = opts.minOffPopGrowth;
  if (opts?.minVillageGrowth !== undefined) detectOpts.minVillageGrowth = opts.minVillageGrowth;

  const signals: AuditSignal[] = [];
  for (const row of diff) {
    // REUSE: recrutamento maciço vem de detectMassiveRecruitment (não reimplementar).
    const massive = detectMassiveRecruitment([row], detectOpts).length > 0;
    const joined = row.isNew;
    const left = !row.isNew && row.offPopB === 0 && row.villageCountB === 0;
    const sharpDecline =
      !left && (row.offPopDelta <= -sharpDeclineOffPop || row.villageCountDelta <= -sharpDeclineVillages);
    const inactive =
      !joined && !left && Math.abs(row.offPopDelta) <= inactiveAbsOffPop && Math.abs(row.defPopDelta) <= inactiveAbsDefPop && row.villageCountDelta === 0;
    const base = {
      playerName: row.playerName,
      offPopDelta: row.offPopDelta,
      defPopDelta: row.defPopDelta,
      villageCountDelta: row.villageCountDelta,
    };
    if (massive) signals.push({ ...base, kind: 'massive-recruit' });
    if (sharpDecline) signals.push({ ...base, kind: 'sharp-decline' });
    if (joined) signals.push({ ...base, kind: 'joined' });
    if (left) signals.push({ ...base, kind: 'left' });
    if (inactive) signals.push({ ...base, kind: 'inactive' });
  }
  signals.sort(
    (s1, s2) => KIND_ORDER[s1.kind] - KIND_ORDER[s2.kind] || s1.playerName.localeCompare(s2.playerName, 'pt-BR'),
  );
  return signals;
}

/** Rótulos PT-BR (UI/tooltips) por tipo de sinal. */
export const AUDIT_SIGNAL_LABEL: Record<AuditSignalKind, string> = {
  'massive-recruit': 'Recrutamento massivo',
  'sharp-decline': 'Queda acentuada',
  joined: 'Entrou na tribo',
  left: 'Saiu da tribo',
  inactive: 'Inativo no período',
};

/** Números INTEIROS sem separador de milhar (planilha-friendly); null vira ''. */
function formatSignedDelta(delta: number | null): string {
  if (delta === null) return '';
  return delta >= 0 ? `+${delta}` : `${delta}`;
}

/**
 * TSV do diff (copiar/colar em planilha): sem BOM, separado por \t, header
 * PT-BR e booleano 'Novo' como sim/não. Sem linha em branco no fim.
 */
export function formatAuditDiffTsv(rows: readonly TroopsDiffRow[]): string {
  const lines = [
    'Jogador\tPop Off A\tPop Off B\tΔ Pop Off\tPop Def A\tPop Def B\tΔ Pop Def\tAldeias A\tAldeias B\tΔ Aldeias\tNovo',
  ];
  for (const row of rows) {
    lines.push(
      [
        row.playerName,
        row.offPopA,
        row.offPopB,
        row.offPopDelta,
        row.defPopA,
        row.defPopB,
        row.defPopDelta,
        row.villageCountA,
        row.villageCountB,
        row.villageCountDelta,
        row.isNew ? 'sim' : 'não',
      ].join('\t'),
    );
  }
  return lines.join('\n');
}

/**
 * TSV da ficha do jogador: Data (ISO cru), Situação e os valores com deltas
 * assinados (+/−; null vira ''). Sem BOM, sem linha em branco no fim.
 */
export function formatPlayerTimelineTsv(points: readonly PlayerTimelinePoint[]): string {
  const lines = ['Data\tSituação\tPop Off\tΔ Pop Off\tPop Def\tΔ Pop Def\tAldeias\tΔ Aldeias'];
  for (const point of points) {
    lines.push(
      [
        point.collectedAt,
        point.situation,
        point.offPop,
        formatSignedDelta(point.offPopDelta),
        point.defPop,
        formatSignedDelta(point.defPopDelta),
        point.villageCount,
        formatSignedDelta(point.villageCountDelta),
      ].join('\t'),
    );
  }
  return lines.join('\n');
}

/**
 * Reconcilia a seleção A/B após recarregar a lista do histórico (mais recente
 * primeiro): mantém o que ainda existe, reaplica os defaults (B = mais recente,
 * A = penúltima) para id sumido — cobre primeiro load, refresh e remoção.
 * Com 0 versões: vazio; com 1: só B (A fica '' — não há com o que comparar).
 */
export function reconcileSelection(
  list: readonly TroopsHistoryVersion[],
  prevAId: string,
  prevBId: string,
): { aId: string; bId: string } {
  if (list.length === 0) return { aId: '', bId: '' };
  const bId = list.some((version) => version.id === prevBId) ? prevBId : (list[0]?.id ?? '');
  // A: mantém o prev se existir; senão penúltima (list[1]); se o escolhido for
  // o próprio B (ex.: B removido e o antigo A promovido a mais recente), cai
  // para a OUTRA versão mais recente — com >= 2 versões A nunca fica vazio
  // (P3 da revisão 2: select fantasma no fluxo de remover a versão B).
  let aId = list.some((version) => version.id === prevAId) ? prevAId : (list[1]?.id ?? '');
  if (aId === '' || aId === bId) {
    aId = list.find((version) => version.id !== bId)?.id ?? '';
  }
  return { aId, bId };
}
