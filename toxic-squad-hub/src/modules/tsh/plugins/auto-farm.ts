// Auto Farm (userscript) — porta da frente da extensão toxic-squad-hub-ext
// (src/modules/features/auto-farm) NA MATURIDADE DE ORIGEM: leitura +
// relatório, sem mutação (PR#4 da origem: leitura → armed → nenhum ataque).
// O plugin original devolve NO_WORK explícito ("Fase de prévia somente
// leitura") e o ciclo automático (auto-farm-cycle.ts) só captura fatos,
// persiste snapshot e regenera a prévia. Aqui o ciclo faz o mesmo:
//   1. resolve a ROTAÇÃO de aldeias: lista configurada ('villages', IDs
//      numéricos) OU, se vazia, AS ALDEIAS PRÓPRIAS do jogador via
//      ../tsh-game-data (auto-serviço; última queda = aldeia aberta no jogo) —
//      um ciclo lê UMA aldeia da rotação, paginação inclusa, pela fila global
//      (pacedGet);
//   2. roda o planejador puro vendado (planAutoFarmPreview);
//   3. guarda o relatório em storage ('last-report') e publica status.
// NENHUM ataque é enviado: mutating=false (o "armar" da origem autorizava o
// runtime contínuo; no userscript isso equivale ao próprio toggle do painel).
// O leitor abaixo é a porta compacta do auto-farm-reader.ts da origem
// (mesmos seletores e sentinelas fail-closed); HTML/CSRF nunca saem dele.
// Nota: core/net não expõe pacedDoc — usamos pacedGet + DOMParser (mesma
// fila/pacing/cache de 60s que o resto do userscript).

import { registerTsh } from '../tsh-runtime';
import { pacedGet } from '../../../core/net';
import { ownVillages } from '../tsh-game-data';
import {
  planAutoFarmPreview,
  type AutoFarmExclusionCounts,
  type AutoFarmPreviewAction,
  type AutoFarmPreviewDecision,
} from '../../../ext/modules/features/auto-farm/auto-farm-planner';
import {
  AUTO_FARM_TEMPLATE_IDS,
  AUTO_FARM_UNIT_TYPES,
  autoFarmSnapshotSchema,
  type AutoFarmSnapshot,
  type AutoFarmPlunderFilters,
  type AutoFarmTarget,
  type AutoFarmTargetResult,
  type AutoFarmTemplate,
  type AutoFarmTemplateId,
  type AutoFarmUnitAmounts,
  type AutoFarmUnitType,
} from '../../../ext/modules/features/auto-farm/auto-farm-contracts';
import { autoFarmSettingsSchema, type AutoFarmSettings } from '../../../ext/modules/features/auto-farm/auto-farm-settings';

export const AUTO_FARM_READER_ERROR = 'PAGE_SELECTOR_CHANGED' as const;
const MAX_PAGES = 100;
const MAX_VILLAGES = 50;
/** Teto de ações persistidas no relatório (a prévia completa fica no ciclo). */
export const MAX_STORED_ACTIONS = 50;

/** Defaults efetivos do schema vendado (o que o plugin assume com settings vazio). */
export const DEFAULT_SETTINGS: AutoFarmSettings = {
  templateId: 'A',
  maximumDistanceFields: 20,
  intervalMinutes: 15,
  targetPriority: 'least-recently-attacked',
  blockAfterLoss: true,
  minimumTargetCooldownMinutes: 0,
  maximumCommandsPerRound: 10_000,
  targetBlacklist: [],
  ignoreScheduledTargets: true,
  ignoreTargetsInFlight: true,
};

export class AutoFarmReaderError extends Error {
  readonly code = AUTO_FARM_READER_ERROR;

  constructor(message: string) {
    super(message);
    this.name = 'AutoFarmReaderError';
  }
}

// ── Leitor do Assistente de Saque (porta do auto-farm-reader.ts) ────────────

function selectorChanged(message: string): never {
  throw new AutoFarmReaderError(message);
}

function parseInteger(raw: string | null | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const normalized = raw.trim().replace(/\./g, '').replace(/\s/g, '');
  if (!/^\d+$/.test(normalized)) return undefined;
  const value = Number(normalized);
  return Number.isSafeInteger(value) ? value : undefined;
}

function parseDistance(raw: string): number | undefined {
  const normalized = raw.trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return undefined;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function sourceVillageId(document: Document): string {
  const form = document.querySelector<HTMLFormElement>('.loot_assistant_templates')?.closest('form');
  const match = form?.getAttribute('action')?.match(/[?&]village=(\d+)(?:&|$)/);
  return match?.[1] ?? selectorChanged('A origem do formulário do Assistente de Saque não foi reconhecida.');
}

function sourceCoordinates(document: Document): { x: number; y: number } {
  const header = document.querySelector('#menu_row2');
  const match = header?.textContent?.match(/\((\d{1,3})\|(\d{1,3})\)/);
  if (!match) return selectorChanged('As coordenadas da aldeia atual não foram reconhecidas no cabeçalho.');
  return { x: Number(match[1]), y: Number(match[2]) };
}

function readTroops(document: Document): AutoFarmUnitAmounts {
  const troops: Partial<Record<AutoFarmUnitType, number>> = {};
  for (const unit of AUTO_FARM_UNIT_TYPES) {
    const cell = document.querySelector<HTMLElement>(`#units_home .unit-item-${unit}[data-unit-count]`);
    if (!cell) continue;
    const quantity = parseInteger(cell.dataset.unitCount);
    if (quantity === undefined) selectorChanged(`A quantidade disponível de ${unit} não foi reconhecida.`);
    troops[unit] = quantity;
  }
  if (Object.keys(troops).length === 0)
    selectorChanged('A disponibilidade de tropas do Assistente de Saque não foi encontrada.');
  return troops;
}

function readPlunderFilters(document: Document): AutoFarmPlunderFilters {
  const container = document.querySelector('#plunder_list_filters');
  if (!container) return selectorChanged('Os filtros do Assistente de Saque não foram encontrados.');
  const checked = (id: string): boolean => {
    const input = container.querySelector<HTMLInputElement>(`#${id}[type="checkbox"]`);
    if (!input) return selectorChanged(`O filtro ${id} do Assistente de Saque não foi reconhecido.`);
    return input.checked;
  };
  return {
    onlyCurrentVillage: checked('all_village_checkbox'),
    includeAttacked: checked('attacked_checkbox'),
    includeFullLosses: checked('full_losses_checkbox'),
    includePartialLosses: checked('partial_losses_checkbox'),
    onlyFullHauls: checked('full_hauls_checkbox'),
  };
}

function templateFor(document: Document, id: AutoFarmTemplateId): AutoFarmTemplate {
  const icon = document.querySelector(`.loot_assistant_templates .farm_icon_${id.toLowerCase()}`);
  const form = icon?.closest('form');
  if (!form) return selectorChanged(`O formulário do template ${id} não foi reconhecido.`);
  const templateIndex = id === 'A' ? 0 : 1;
  const hidden = form.querySelectorAll<HTMLInputElement>('input[name^="template["][name$="[id]"]')[templateIndex];
  const gameTemplateId = hidden?.value;
  if (!gameTemplateId || !/^\d+$/.test(gameTemplateId)) {
    return selectorChanged(`O identificador do template ${id} não foi reconhecido.`);
  }
  const units: Partial<Record<AutoFarmUnitType, number>> = {};
  for (const unit of AUTO_FARM_UNIT_TYPES) {
    const input = form.querySelector<HTMLInputElement>(`input[name="${unit}[${gameTemplateId}]"]`);
    if (!input) continue;
    const quantity = parseInteger(input.value);
    if (quantity === undefined) selectorChanged(`A composição de ${unit} no template ${id} não foi reconhecida.`);
    if (quantity > 0) units[unit] = quantity;
  }
  return { id, gameTemplateId, units };
}

function resultFromRow(row: HTMLTableRowElement): AutoFarmTargetResult {
  const title =
    Array.from(row.querySelectorAll<HTMLImageElement>('img[data-title]'))
      .map((image) => image.getAttribute('data-title')?.trim().toLocaleLowerCase('pt-BR') ?? '')
      .find(
        (candidate) =>
          candidate.includes('vitória') ||
          candidate.includes('explorado') ||
          candidate.includes('perda') ||
          candidate.includes('derrota'),
      ) ?? '';
  if (title.includes('perda') || title.includes('derrota')) return 'LOSS';
  if (title.includes('vitória total')) return 'SUCCESS';
  if (title.includes('vitória parcial')) return 'PARTIAL';
  if (title.includes('explorado')) return 'SCOUTED';
  return 'UNKNOWN';
}

interface PlunderColumns {
  village: number;
  time: number;
  distance: number;
}

function plunderColumns(table: HTMLTableElement): PlunderColumns {
  const headers = Array.from(table.querySelectorAll<HTMLTableCellElement>('tr th'));
  const uniqueIndex = (description: string, predicate: (header: HTMLTableCellElement) => boolean): number => {
    const matches = headers.filter(predicate);
    if (matches.length !== 1 || matches[0]?.cellIndex === undefined) {
      return selectorChanged(`A coluna de ${description} do Assistente de Saque não foi reconhecida.`);
    }
    return matches[0].cellIndex;
  };
  const normalizedText = (header: HTMLTableCellElement): string =>
    (header.textContent ?? '').trim().toLocaleLowerCase('pt-BR');
  return {
    village: uniqueIndex('aldeia', (header) => normalizedText(header) === 'aldeia'),
    time: uniqueIndex(
      'tempo',
      (header) => normalizedText(header) === 'tempo' || Boolean(header.querySelector('a[href*="order=date"]')),
    ),
    distance: uniqueIndex(
      'distância',
      (header) =>
        Boolean(header.querySelector('a[href*="order=distance"]')) ||
        Array.from(header.querySelectorAll<HTMLElement>('[data-title]')).some((element) =>
          (element.dataset.title ?? '').toLocaleLowerCase('pt-BR').includes('distância'),
        ),
    ),
  };
}

function dateFromRow(raw: string, capturedAt: Date): string | undefined {
  const today = raw.match(/hoje\s+às\s+(\d{2}):(\d{2}):(\d{2})/i);
  const yesterday = raw.match(/ontem\s+às\s+(\d{2}):(\d{2}):(\d{2})/i);
  const dated = raw.match(/(?:em\s+)?(\d{2})\.(\d{2})\.\s+às\s+(\d{2}):(\d{2}):(\d{2})/i);
  const make = (year: number, month: number, day: number, hour: number, minute: number, second: number): Date =>
    new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (today) {
    return make(
      capturedAt.getUTCFullYear(),
      capturedAt.getUTCMonth() + 1,
      capturedAt.getUTCDate(),
      Number(today[1]),
      Number(today[2]),
      Number(today[3]),
    ).toISOString();
  }
  if (yesterday) {
    const date = make(
      capturedAt.getUTCFullYear(),
      capturedAt.getUTCMonth() + 1,
      capturedAt.getUTCDate(),
      Number(yesterday[1]),
      Number(yesterday[2]),
      Number(yesterday[3]),
    );
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString();
  }
  if (!dated) return undefined;
  let year = capturedAt.getUTCFullYear();
  let date = make(year, Number(dated[2]), Number(dated[1]), Number(dated[3]), Number(dated[4]), Number(dated[5]));
  if (date.getTime() > capturedAt.getTime() + 24 * 60 * 60 * 1000) {
    year -= 1;
    date = make(year, Number(dated[2]), Number(dated[1]), Number(dated[3]), Number(dated[4]), Number(dated[5]));
  }
  return date.toISOString();
}

function templateControls(row: HTMLTableRowElement): {
  templateIds: AutoFarmTemplateId[];
  availableTemplateIds: AutoFarmTemplateId[];
} {
  const templateIds: AutoFarmTemplateId[] = [];
  const availableTemplateIds: AutoFarmTemplateId[] = [];
  for (const id of AUTO_FARM_TEMPLATE_IDS) {
    const control = row.querySelector<HTMLAnchorElement>(`.farm_icon_${id.toLowerCase()}`);
    if (!control) continue;
    templateIds.push(id);
    if (!control.classList.contains('farm_icon_disabled') && !control.classList.contains('start_locked')) {
      availableTemplateIds.push(id);
    }
  }
  return { templateIds, availableTemplateIds };
}

function readTargets(document: Document, capturedAt: Date): AutoFarmTarget[] {
  const table = document.querySelector<HTMLTableElement>('#plunder_list');
  if (!table) return selectorChanged('A lista de saques não foi encontrada.');
  const columns = plunderColumns(table);
  const targets: AutoFarmTarget[] = [];
  for (const row of table.querySelectorAll<HTMLTableRowElement>('tr[id^="village_"]')) {
    const id = row.id.match(/^village_(\d+)$/)?.[1];
    const villageCell = row.cells[columns.village];
    if (!villageCell) selectorChanged('A célula da aldeia-alvo não foi encontrada.');
    const reportLink = villageCell.querySelector<HTMLAnchorElement>('a[href*="screen=report"][href*="view="]');
    const match = reportLink?.textContent?.match(/\((\d{1,3})\|(\d{1,3})\)/);
    const distanceCell = row.cells[columns.distance];
    const timeCell = row.cells[columns.time];
    const distance = parseDistance(distanceCell?.textContent ?? '');
    if (!id || !reportLink || !match || !timeCell || distance === undefined) {
      selectorChanged('Uma linha de alvo do Assistente de Saque mudou de formato.');
    }
    const label = (reportLink.textContent ?? '')
      .replace(/\(\d{1,3}\|\d{1,3}\)/, '')
      .replace(/K\d+/i, '')
      .trim()
      .toLocaleLowerCase('pt-BR');
    const controls = templateControls(row);
    if (controls.templateIds.length === 0) selectorChanged(`Os controles A/B do alvo ${id} não foram encontrados.`);
    const lastAttackAt = dateFromRow(timeCell.textContent ?? '', capturedAt);
    targets.push({
      id,
      x: Number(match[1]),
      y: Number(match[2]),
      // Na página pt-BR, bárbaras aparecem apenas com coordenadas; qualquer
      // nome não reconhecido permanece inelegível (fail-closed).
      barbarian: label === '' || label === 'aldeia bárbara',
      evidenceSources: ['AM_REPORT'],
      ...controls,
      lastResult: resultFromRow(row),
      ...(lastAttackAt ? { lastAttackAt } : {}),
    });
  }
  return targets;
}

function remainingPagePaths(document: Document): string[] {
  const options = Array.from(document.querySelectorAll<HTMLOptionElement>('#plunder_list_nav select option'));
  const unique = new Set<string>();
  for (const option of options) {
    if (option.selected) continue;
    const value = option.value;
    if (!/[?&]screen=am_farm(?:&|$)/.test(value) || !/[?&]Farm_page=\d+(?:&|$)/.test(value)) {
      selectorChanged('A paginação do Assistente de Saque mudou de formato.');
    }
    unique.add(value);
  }
  if (unique.size > MAX_PAGES - 1) selectorChanged('A paginação excedeu o limite seguro de leitura.');
  return [...unique];
}

interface ReadPageResult {
  source: { villageId: string; x: number; y: number; troops: AutoFarmUnitAmounts };
  plunderFilters: AutoFarmPlunderFilters;
  templates: AutoFarmTemplate[];
  targets: AutoFarmTarget[];
  remainingPagePaths: string[];
}

function readPage(document: Document, expectedVillageId: string, capturedAt: Date): ReadPageResult {
  if (sourceVillageId(document) !== expectedVillageId) {
    selectorChanged('A aldeia do HTML não corresponde à aldeia ativa informada pelo jogo.');
  }
  if (!document.querySelector('#content_value .loot_assistant_templates') || !document.querySelector('#plunder_list')) {
    selectorChanged('A página atual não corresponde ao Assistente de Saque esperado.');
  }
  const coordinates = sourceCoordinates(document);
  return {
    source: { villageId: expectedVillageId, ...coordinates, troops: readTroops(document) },
    plunderFilters: readPlunderFilters(document),
    templates: AUTO_FARM_TEMPLATE_IDS.map((id) => templateFor(document, id)),
    targets: readTargets(document, capturedAt),
    remainingPagePaths: remainingPagePaths(document),
  };
}

function parseDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/**
 * Lê a primeira página do Assistente de Saque e as paginadas por GET (fila
 * global do userscript). O retorno contém apenas fatos mínimos validados;
 * HTML, CSRF e hashes nunca saem do leitor.
 */
export async function loadAutoFarmSnapshot(villageId: string): Promise<AutoFarmSnapshot> {
  const capturedAt = new Date();
  const firstHtml = await pacedGet(`/game.php?village=${encodeURIComponent(villageId)}&screen=am_farm`, {
    fresh: true,
  });
  const first = readPage(parseDoc(firstHtml), villageId, capturedAt);
  const targets = new Map(first.targets.map((target) => [target.id, target]));
  for (const path of first.remainingPagePaths) {
    const html = await pacedGet(path);
    const page = readPage(parseDoc(html), villageId, capturedAt);
    if (
      page.source.villageId !== first.source.villageId ||
      page.source.x !== first.source.x ||
      page.source.y !== first.source.y ||
      JSON.stringify(page.plunderFilters) !== JSON.stringify(first.plunderFilters) ||
      JSON.stringify(page.templates) !== JSON.stringify(first.templates)
    ) {
      selectorChanged('A origem ou os templates mudaram durante a leitura paginada.');
    }
    for (const target of page.targets) targets.set(target.id, target);
  }
  return autoFarmSnapshotSchema.parse({
    capability: 'AVAILABLE',
    source: first.source,
    plunderFilters: first.plunderFilters,
    templates: first.templates,
    targets: [...targets.values()],
    capturedAt: capturedAt.toISOString(),
  });
}

// ── Relatório do ciclo (puro — testável) ────────────────────────────────────

/** De onde vieram as aldeias da rodada (ordem de preferência da rotação). */
export type AutoFarmVillageSource = 'configuradas' | 'proprias' | 'aldeia atual';

export interface AutoFarmRotation {
  /** IDs da rotação do ciclo (um lido por ciclo, cursor próprio). */
  ids: readonly string[];
  source: AutoFarmVillageSource;
}

/** Resumo da rotação persistido dentro do relatório (legibilidade da prévia). */
export interface AutoFarmRotationSummary {
  total: number;
  source: AutoFarmVillageSource;
}

/** Relatório persistido em 'last-report' (ações truncadas para não estourar o storage). */
export type AutoFarmLastReport =
  | Readonly<{
      outcome: 'NO_WORK';
      generatedAt: string;
      villageId: string;
      code: string;
      reason: string;
      exclusions: AutoFarmExclusionCounts;
      rotation: AutoFarmRotationSummary;
    }>
  | Readonly<{
      outcome: 'PLAN';
      generatedAt: string;
      villageId: string;
      capturedAt: string;
      templateId: AutoFarmTemplateId;
      gameTemplateId: string;
      totalTargets: number;
      executableActions: number;
      waitingForTroops: number;
      waitingForCommandLimit: number;
      templateHaulCapacity: number;
      plunderFilters: AutoFarmPlunderFilters;
      actions: readonly AutoFarmPreviewAction[];
      actionsTotal: number;
      actionsTruncated: boolean;
      exclusions: AutoFarmExclusionCounts;
      rotation: AutoFarmRotationSummary;
    }>;

export function buildAutoFarmReport(
  preview: AutoFarmPreviewDecision,
  villageId: string,
  generatedAt: string,
  rotation: AutoFarmRotation,
): AutoFarmLastReport {
  const rotationSummary: AutoFarmRotationSummary = { total: rotation.ids.length, source: rotation.source };
  if (preview.kind === 'NO_WORK') {
    return Object.freeze({
      outcome: 'NO_WORK',
      generatedAt,
      villageId,
      code: preview.code,
      reason: preview.reason,
      exclusions: preview.exclusions,
      rotation: rotationSummary,
    });
  }
  const stored = preview.actions.slice(0, MAX_STORED_ACTIONS);
  return Object.freeze({
    outcome: 'PLAN',
    generatedAt,
    villageId,
    capturedAt: preview.capturedAt,
    templateId: preview.templateId,
    gameTemplateId: preview.gameTemplateId,
    totalTargets: preview.totalTargets,
    executableActions: preview.executableActions,
    waitingForTroops: preview.waitingForTroops,
    waitingForCommandLimit: preview.waitingForCommandLimit,
    templateHaulCapacity: preview.templateHaulCapacity,
    plunderFilters: preview.plunderFilters,
    actions: Object.freeze(stored),
    actionsTotal: preview.actions.length,
    actionsTruncated: preview.actions.length > stored.length,
    exclusions: preview.exclusions,
    rotation: rotationSummary,
  });
}

/** Ação recomendada pelo relatório (pura — orienta o jogador no painel). */
export function autoFarmRecommendedAction(report: AutoFarmLastReport): string {
  if (report.outcome === 'NO_WORK') {
    switch (report.code) {
      case 'CAPABILITY_UNAVAILABLE':
      case 'CAPABILITY_UNKNOWN':
        return 'Ação recomendada: confira a disponibilidade do Assistente de Saque neste mundo.';
      case 'FILTER_COVERAGE_INCOMPLETE':
        return 'Ação recomendada: ajuste os filtros da lista de saques no jogo e rode outro ciclo.';
      case 'SOURCE_COORDINATES_UNAVAILABLE':
        return 'Ação recomendada: rode o ciclo com uma aldeia aberta no jogo.';
      case 'TEMPLATE_NOT_FOUND':
        return 'Ação recomendada: confira os templates A/B do Assistente de Saque no jogo.';
      case 'NO_ELIGIBLE_TARGET':
        return 'Ação recomendada: amplie a distância máxima ou revise bloqueios/cooldowns.';
      case 'NO_EXECUTABLE_TARGET':
        return 'Ação recomendada: aguarde tropas em casa ou aumente o limite de comandos da rodada.';
      default:
        return 'Ação recomendada: rode outro ciclo para atualizar a prévia.';
    }
  }
  if (report.executableActions === 0) {
    return report.waitingForTroops > 0
      ? 'Ação recomendada: aguarde tropas em casa para executar a rodada.'
      : 'Ação recomendada: aumente o máximo de comandos por rodada.';
  }
  return 'Ação recomendada: aprove a rodada pelo Assistente de Saque do jogo — este módulo não envia ataques.';
}

export function autoFarmStatusMessage(
  report: AutoFarmLastReport,
  rotation: AutoFarmRotation,
): { message: string; kind: 'ok' | 'info' } {
  const rodada = ` Aldeias na rodada: ${rotation.ids.length} (${rotation.source}).`;
  if (report.outcome === 'NO_WORK') {
    return {
      message: `${report.reason}${rodada} ${autoFarmRecommendedAction(report)} Somente leitura — nenhum ataque enviado.`,
      kind: 'info',
    };
  }
  return {
    message: `Prévia Auto Farm (${report.villageId}): ${report.executableActions} executáveis de ${report.totalTargets} alvos (template ${report.templateId}).${rodada} ${autoFarmRecommendedAction(report)} Somente leitura — nenhum ataque enviado.`,
    kind: 'ok',
  };
}

// ── Ciclo registrado no runtime ─────────────────────────────────────────────

/** Aldeias configuradas (storage 'villages'): IDs numéricos, sem repetição. */
function configuredVillages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((value): value is string => typeof value === 'string' && /^\d+$/.test(value));
  return [...new Set(ids)].slice(0, MAX_VILLAGES);
}

/**
 * Rotação de aldeias do ciclo (auto-serviço): lista configurada vence; vazia =
 * TODAS as ALDEIAS PRÓPRIAS do jogador (../tsh-game-data, cache de sessão e
 * fila global); sem aldeias próprias legíveis, cai para a aldeia aberta no
 * jogo (comportamento de hoje). Falha de leitura nunca derruba o ciclo.
 */
export async function resolveAutoFarmRotation(configured: string[], currentVillageId: string): Promise<AutoFarmRotation> {
  if (configured.length > 0) return { ids: configured, source: 'configuradas' };
  try {
    const own = await ownVillages();
    const ids = own
      .map((village) => village.id)
      .filter((id) => /^\d+$/.test(id))
      .slice(0, MAX_VILLAGES);
    if (ids.length > 0) return { ids, source: 'proprias' };
  } catch {
    // /map/village.txt indisponível — queda para a aldeia atual abaixo.
  }
  return { ids: currentVillageId === '' ? [] : [currentVillageId], source: 'aldeia atual' };
}

registerTsh({
  id: 'auto-farm',
  label: 'Auto Farm',
  desc: 'Somente leitura: lê o Assistente de Saque das aldeias da rodada (lista configurada; vazia = TODAS as SUAS aldeias) e gera relatório/prévia — nenhum ataque é enviado (fase da origem).',
  category: 'planejamento',
  screen: null,
  mutating: false,
  settingsDefaults: DEFAULT_SETTINGS,
  // Ficam FORA do formulário: villages é chave de storage SEPARADA ('villages',
  // IDs numéricos — não parte do objeto settings) e targetBlacklist é lista.
  // Auto-serviço (Onda 12): 'villages' VAZIA = o ciclo usa TODAS as aldeias
  // próprias do jogador; preenchida = usa exatamente os IDs configurados.
  settingsForm: [
    {
      key: 'templateId',
      label: 'Template do saque',
      type: 'select',
      options: [
        { value: 'A', label: 'A' },
        { value: 'B', label: 'B' },
      ],
      help: 'Template do próprio Assistente de Saque do jogo.',
    },
    {
      key: 'maximumDistanceFields',
      label: 'Distância máxima (campos)',
      type: 'number',
      min: 1,
      max: 1000,
      help: 'Alvos mais longe que isto são excluídos da prévia.',
    },
    { key: 'intervalMinutes', label: 'Intervalo entre ataques ao mesmo alvo (min)', type: 'number', min: 2, max: 1440 },
    {
      key: 'targetPriority',
      label: 'Prioridade de alvo',
      type: 'select',
      options: [
        { value: 'nearest', label: 'Mais próximo' },
        { value: 'least-recently-attacked', label: 'Atacado há mais tempo' },
      ],
    },
    { key: 'blockAfterLoss', label: 'Bloquear alvo após perda', type: 'boolean' },
    { key: 'minimumTargetCooldownMinutes', label: 'Cooldown mínimo por alvo (min)', type: 'number', min: 0, max: 10080 },
    { key: 'maximumCommandsPerRound', label: 'Máximo de comandos por rodada', type: 'number', min: 1, max: 10000 },
    { key: 'ignoreScheduledTargets', label: 'Ignorar alvos agendados', type: 'boolean' },
    { key: 'ignoreTargetsInFlight', label: 'Ignorar alvos com comando a caminho', type: 'boolean' },
  ],
  async runCycle(ctx): Promise<void> {
    // Rotação: um ciclo lê UMA aldeia (a leitura paginada já é longa; a fila
    // global ≥200ms continua protegendo o jogo). Lista configurada vence;
    // vazia = todas as aldeias PRÓPRIAS do jogador (auto-serviço).
    const configured = configuredVillages(ctx.storage.get<unknown>('villages', []));
    const rotation = await resolveAutoFarmRotation(configured, ctx.villageId);
    const list = rotation.ids;
    if (list.length === 0 || list[0] === '') {
      ctx.status(
        'Nenhuma aldeia para analisar: lista configurada vazia, nenhuma aldeia própria encontrada e nenhuma aldeia aberta no jogo.',
        'warn',
      );
      return;
    }
    const cursor = ctx.storage.get<number>('cursor', 0);
    const index = cursor % list.length;
    const villageId = list[index] ?? ctx.villageId;
    ctx.storage.set('cursor', (index + 1) % list.length);

    const settings = autoFarmSettingsSchema.parse(ctx.storage.get('settings', DEFAULT_SETTINGS));

    let snapshot: AutoFarmSnapshot;
    try {
      snapshot = await loadAutoFarmSnapshot(villageId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.status(`Falha ao ler o Assistente de Saque: ${message} Nenhum ataque foi enviado.`, 'warn');
      return;
    }

    const preview = planAutoFarmPreview(snapshot, settings);
    const report = buildAutoFarmReport(preview, villageId, new Date().toISOString(), rotation);
    ctx.storage.set('last-report', report);
    const status = autoFarmStatusMessage(report, rotation);
    ctx.status(status.message, status.kind);
  },
});
