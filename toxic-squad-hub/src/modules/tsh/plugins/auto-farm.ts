// Auto Farm (userscript) — porta da frente da extensão toxic-squad-hub-ext
// (src/modules/features/auto-farm). Onda 4: a prévia da Onda 3 ganhou EXECUÇÃO
// opcional, sem mudar NADA no comportamento padrão (mode 'preview').
//   1. resolve a ROTAÇÃO de aldeias: lista configurada ('villages', IDs
//      numéricos) OU, se vazia, AS ALDEIAS PRÓPRIAS do jogador via
//      ../tsh-game-data (auto-serviço; última queda = aldeia aberta no jogo) —
//      um ciclo lê UMA aldeia da rotação, paginação inclusa, pela fila global
//      (pacedGet);
//   2. roda o planejador puro vendado (planAutoFarmPreview) sobre os fatos do
//      Assistente de Saque e, no modo EXECUTAR, executa O PRIMEIRO comando
//      elegível da rodada via submitCommand2Step (2 passos certificados, lane
//      'humanizado' — farm é rotina), NO MÁXIMO 1 por ciclo (F2);
//   3. guarda o relatório em storage ('last-report') e publica status — o
//      relatório de prévia é gravado SEMPRE, também no modo EXECUTAR.
// Regras de execução: o comando só sai da aldeia ABERTA na Praça de Reunião
// (o transporte preenche o formulário da tela); alvo com envio recente fica em
// cooldown pelo ledger 'tsh-auto:<mundo>:auto-farm:ledger' (gravado ANTES do
// clique, para nunca duplicar); alvo sem dado fresco é pulado com motivo.
// O leitor abaixo é a porta compacta do auto-farm-reader.ts da origem
// (mesmos seletores e sentinelas fail-closed); HTML/CSRF nunca saem dele.
// Nota: core/net não expõe pacedDoc — usamos pacedGet + DOMParser (mesma
// fila/pacing/cache de 60s que o resto do userscript).

import { z } from 'zod';
import { registerTsh } from '../tsh-runtime';
import { pacedGet } from '../../../core/net';
import { gm } from '../../../core/storage';
import { ownVillages } from '../tsh-game-data';
import { isUncertainMutationError, submitCommand2Step } from '../tsh-transport';
import { serverNowIso } from './op-generator';
import {
  AUTO_FARM_UNIT_HAUL,
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
import {
  FARM_TEMPLATE_C_DEFAULTS,
  buildFarmCLot,
  farmTemplateCSummary,
  normalizeFarmTemplateC,
  type FarmTemplateC,
} from '../../../ext/modules/features/auto-farm/farm-template-c';
import {
  isMapperListStale,
  mapperCoordinates,
  mapperTargetListSchema,
} from '../../../ext/modules/features/auto-farm/barbarian-mapper';

export const AUTO_FARM_READER_ERROR = 'PAGE_SELECTOR_CHANGED' as const;
const MAX_PAGES = 100;
const MAX_VILLAGES = 50;
/** Teto de ações persistidas no relatório (a prévia completa fica no ciclo). */
export const MAX_STORED_ACTIONS = 50;

// ── Configuração do plugin (Onda 4: execução opcional) ─────────────────────

/** Modos do plugin: prévia (default — nada muda) e execução real. */
export const AUTO_FARM_MODES = Object.freeze(['preview', 'executar'] as const);
export type AutoFarmMode = (typeof AUTO_FARM_MODES)[number];
/** Fonte dos alvos: o Assistente de Saque do jogo ou a lista do Mapeador. */
export const AUTO_FARM_TARGET_SOURCES = Object.freeze(['assistente', 'mapper'] as const);
export type AutoFarmTargetSource = (typeof AUTO_FARM_TARGET_SOURCES)[number];
/** Lote do comando: templates A/B do jogo ou o C (composição própria do Hub). */
export type AutoFarmLotTemplate = AutoFarmTemplateId | 'C';

/**
 * Settings efetivos do plugin: a base vendada (auto-farm-settings) mais as
 * chaves da Onda 4. `templateId` aceita 'C' AQUI — o 'C' não existe no jogo e
 * por isso não entra no schema vendado (o planejamento usa um template-âncora
 * de 1 unidade; o lote real por alvo vem de buildFarmCLot).
 */
export type AutoFarmPluginSettings = Omit<AutoFarmSettings, 'templateId'> & {
  templateId: AutoFarmLotTemplate;
  mode: AutoFarmMode;
  targetSource: AutoFarmTargetSource;
  templateC: FarmTemplateC;
};

const autoFarmExtrasSchema = z
  .object({
    mode: z.enum(AUTO_FARM_MODES).catch('preview'),
    targetSource: z.enum(AUTO_FARM_TARGET_SOURCES).catch('assistente'),
  })
  .catch({ mode: 'preview', targetSource: 'assistente' });

/** Defaults efetivos (o que o plugin assume com settings vazio). */
export const DEFAULT_SETTINGS: AutoFarmPluginSettings = {
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
  mode: 'preview',
  targetSource: 'assistente',
  templateC: FARM_TEMPLATE_C_DEFAULTS,
};

/**
 * Settings do ciclo: a base é validada pelo schema vendado (tipo errado lança,
 * o ciclo avisa e para) e as chaves da Onda 4 são normalizadas campo a campo.
 * `templateId: 'C'` é traduzido para 'A' na base — o 'C' é do Hub, não do jogo.
 */
export function parseAutoFarmSettings(raw: unknown): AutoFarmPluginSettings {
  const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const wantsTemplateC = record.templateId === 'C';
  const base = autoFarmSettingsSchema.parse({ ...record, ...(wantsTemplateC ? { templateId: 'A' } : {}) });
  const extras = autoFarmExtrasSchema.parse(record);
  return Object.freeze({
    ...base,
    templateId: wantsTemplateC ? 'C' : base.templateId,
    mode: extras.mode,
    targetSource: extras.targetSource,
    templateC: normalizeFarmTemplateC(record.templateC),
  });
}

/** Settings no formato do planejador vendado (template C vira o âncora 'A'). */
function planningSettings(settings: AutoFarmPluginSettings): AutoFarmSettings {
  return autoFarmSettingsSchema.parse({
    ...settings,
    templateId: settings.templateId === 'C' ? 'A' : settings.templateId,
  });
}

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

// ── Execução (Onda 4): ledger, lote e seleção pura ─────────────────────────

const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LEDGER_MAX_TARGETS = 500;

/** Um alvo já atendido pelo Hub: último envio e contagem (dedupe/cooldown). */
export interface AutoFarmLedgerEntry {
  readonly lastSentAt: string;
  readonly lastSentAtMs: number;
  readonly count: number;
}

/** Livro-razão de envios do Auto Farm (alvo → último envio, cooldown por alvo). */
export interface AutoFarmLedger {
  readonly version: 1;
  readonly targets: Readonly<Record<string, AutoFarmLedgerEntry>>;
}

export function createAutoFarmLedger(): AutoFarmLedger {
  return Object.freeze({ version: 1 as const, targets: Object.freeze({}) });
}

function isAutoFarmLedger(value: unknown): value is AutoFarmLedger {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { version?: unknown; targets?: unknown };
  return record.version === 1 && typeof record.targets === 'object' && record.targets !== null;
}

/** Ledger persistido; conteúdo estranho reinicia vazio (nunca deduz dele). */
export function loadAutoFarmLedger(raw: unknown): AutoFarmLedger {
  return isAutoFarmLedger(raw) ? raw : createAutoFarmLedger();
}

/** Coordenada canônica do alvo (mesmo formato do Assistente/transporte). */
function actionCoordinate(action: AutoFarmPreviewAction): string {
  return `${action.target.x}|${action.target.y}`;
}

/**
 * Registra um envio (chamado ANTES do clique: o passo 2 pode navegar e matar o
 * contexto do ciclo — o registro precisa existir para nunca duplicar). Poda
 * entradas velhas e limita o tamanho do ledger.
 */
export function recordAutoFarmSend(
  ledger: unknown,
  coordinate: string,
  sentAtMs: number,
  sentAtIso: string,
): AutoFarmLedger {
  const current = loadAutoFarmLedger(ledger);
  const entries: [string, AutoFarmLedgerEntry][] = [];
  const previous = current.targets[coordinate];
  const keep = (key: string, entry: AutoFarmLedgerEntry): void => {
    if (sentAtMs - entry.lastSentAtMs <= LEDGER_RETENTION_MS) entries.push([key, entry]);
  };
  for (const [key, entry] of Object.entries(current.targets)) {
    if (key === coordinate) continue;
    if (!Number.isFinite(entry.lastSentAtMs)) continue; // entrada corrompida não volta para o ledger
    keep(key, entry);
  }
  entries.push([
    coordinate,
    {
      lastSentAt: sentAtIso,
      lastSentAtMs: sentAtMs,
      count: (previous?.count ?? 0) + 1,
    },
  ]);
  entries.sort((left, right) => left[1].lastSentAtMs - right[1].lastSentAtMs);
  const pruned = entries.slice(Math.max(0, entries.length - LEDGER_MAX_TARGETS));
  const targets: Record<string, AutoFarmLedgerEntry> = {};
  for (const [key, entry] of pruned) targets[key] = Object.freeze({ ...entry });
  return Object.freeze({ version: 1 as const, targets: Object.freeze(targets) });
}

/**
 * O alvo está em cooldown de envio? Entrada sem carimbo utilizável conta como
 * EM COOLDOWN (fail-closed: sem dado confiável, não repete o comando).
 */
export function isAutoFarmTargetCoolingDown(
  ledger: unknown,
  coordinate: string,
  nowMs: number,
  cooldownMs: number,
): boolean {
  const entry = loadAutoFarmLedger(ledger).targets[coordinate];
  if (entry === undefined) return false;
  if (!Number.isFinite(entry.lastSentAtMs)) return true;
  return nowMs - entry.lastSentAtMs < Math.max(0, cooldownMs);
}

/**
 * Snapshot de planejamento no modo Template C: o 'C' é composição do Hub (o
 * jogo não o conhece), então o planejador usa UMA unidade da unidade de maior
 * prioridade presente em casa como unidade de conta — o lote real de cada alvo
 * é montado por buildFarmCLot na hora do envio.
 */
export function snapshotForTemplateC(snapshot: AutoFarmSnapshot, templateC: FarmTemplateC): AutoFarmSnapshot {
  const anchor = snapshot.templates.find((template) => template.id === 'A') ?? snapshot.templates[0];
  if (anchor === undefined) return snapshot;
  const policy = normalizeFarmTemplateC(templateC);
  const unit =
    policy.priority.find((candidate) => (snapshot.source.troops[candidate as AutoFarmUnitType] ?? 0) > 0) ??
    policy.priority[0] ??
    'light';
  try {
    return autoFarmSnapshotSchema.parse({
      ...snapshot,
      templates: [{ id: 'A', gameTemplateId: anchor.gameTemplateId, units: { [unit]: 1 } }],
    });
  } catch {
    return snapshot; // composição fora do contrato: o plano usa o template A/B lido
  }
}

/** Unidades do lote no formato do transporte (só quantidades > 0). */
function lotUnits(amounts: Readonly<AutoFarmUnitAmounts> | Readonly<Record<string, number>>): Record<string, number> {
  const units: Record<string, number> = {};
  for (const [unit, amount] of Object.entries(amounts)) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) continue;
    units[unit] = Math.floor(amount);
  }
  return units;
}

export interface AutoFarmExecutionLot {
  readonly targetId: string;
  /** "x|y" — formato canônico do transporte. */
  readonly coordinate: string;
  readonly distanceFields: number;
  readonly lotTemplate: AutoFarmLotTemplate;
  readonly units: Readonly<Record<string, number>>;
  readonly estimatedHaul: number;
}

export type AutoFarmExecutionDecision =
  | Readonly<{ kind: 'EXECUTE'; lot: AutoFarmExecutionLot }>
  | Readonly<{ kind: 'SKIP'; reason: string }>;

export interface AutoFarmExecutionInput {
  readonly preview: AutoFarmPreviewDecision;
  readonly ledger: unknown;
  readonly nowMs: number;
  /** Cooldown por alvo em ms (usa o "Intervalo entre ataques ao mesmo alvo"). */
  readonly cooldownMs: number;
  readonly templateId: AutoFarmLotTemplate;
  readonly templateC: FarmTemplateC;
  readonly unitCapacity: Readonly<Record<string, number>>;
  readonly sourceTroops: Readonly<AutoFarmUnitAmounts>;
}

/**
 * Escolhe O PRIMEIRO comando elegível da rodada (F2: no máximo um por ciclo):
 * ações EXECUTÁVEIS na ordem determinística do planejador, pulando alvos em
 * cooldown do ledger e — no Template C — alvos para os quais o lote não atinge
 * o mínimo de saque (o motivo do primeiro skip vira o motivo do ciclo).
 */
export function selectAutoFarmExecution(input: AutoFarmExecutionInput): AutoFarmExecutionDecision {
  if (input.preview.kind === 'NO_WORK') {
    return Object.freeze({ kind: 'SKIP', reason: input.preview.reason });
  }
  const executable = input.preview.actions.filter((action) => action.roundStatus === 'EXECUTABLE');
  if (executable.length === 0) {
    return Object.freeze({
      kind: 'SKIP',
      reason: 'Nenhum alvo executável nesta rodada (faltam tropas em casa ou o limite de comandos foi atingido).',
    });
  }
  const eligible = executable.filter(
    (action) => !isAutoFarmTargetCoolingDown(input.ledger, actionCoordinate(action), input.nowMs, input.cooldownMs),
  );
  if (eligible.length === 0) {
    return Object.freeze({
      kind: 'SKIP',
      reason: `Todos os ${executable.length} alvo(s) executáveis já receberam comando deste Hub dentro do intervalo configurado.`,
    });
  }
  let firstSkip = '';
  for (const action of eligible) {
    const coordinate = actionCoordinate(action);
    if (input.templateId === 'C') {
      const lot = buildFarmCLot(
        lotUnits(input.sourceTroops),
        { points: action.target.points ?? 0 },
        input.templateC,
        input.unitCapacity,
      );
      if ('skip' in lot) {
        firstSkip ||= lot.skip;
        continue;
      }
      return Object.freeze({
        kind: 'EXECUTE',
        lot: Object.freeze({
          targetId: action.target.id,
          coordinate,
          distanceFields: action.distanceFields,
          lotTemplate: 'C' as const,
          units: Object.freeze(lotUnits(lot.units)),
          estimatedHaul: lot.estimatedHaul,
        }),
      });
    }
    const units = lotUnits(action.requiredUnits);
    if (Object.keys(units).length === 0) {
      firstSkip ||= `O template ${input.templateId} não tem unidade positiva para o alvo ${coordinate}.`;
      continue;
    }
    return Object.freeze({
      kind: 'EXECUTE',
      lot: Object.freeze({
        targetId: action.target.id,
        coordinate,
        distanceFields: action.distanceFields,
        lotTemplate: input.templateId,
        units: Object.freeze(units),
        estimatedHaul: action.haulCapacity,
      }),
    });
  }
  return Object.freeze({
    kind: 'SKIP',
    reason: firstSkip !== '' ? `Template C sem lote viável: ${firstSkip}` : 'Nenhum lote pôde ser montado para os alvos da rodada.',
  });
}

/** Resumo da execução do ciclo (vai para o relatório e para o status). */
export type AutoFarmExecutionSummary =
  | Readonly<{
      outcome: 'ENVIADO';
      target: string;
      lotTemplate: AutoFarmLotTemplate;
      units: Readonly<Record<string, number>>;
      estimatedHaul: number;
    }>
  | Readonly<{ outcome: 'PULADO'; reason: string }>
  | Readonly<{ outcome: 'FALHA'; reason: string }>
  | Readonly<{ outcome: 'BLOQUEADO'; reason: string }>;

/** Agora na perspectiva do SERVIDOR (header do jogo), em epoch ms. */
function serverNowMs(): number {
  const parsed = Date.parse(serverNowIso());
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** A Praça de Reunião (ou sua tela de confirmação) está aberta para o envio? */
function isCommandScreenOpen(): boolean {
  return (
    document.querySelector('#command-data-form, form[action*="screen=place"][action*="action=command"]') !== null
  );
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

/** Extras da Onda 4 anexados ao relatório (todos opcionais — prévia segue igual). */
export interface AutoFarmReportExtras {
  mode: AutoFarmMode;
  targetSource: AutoFarmTargetSource;
  lotTemplate: AutoFarmLotTemplate;
  /** Quantos alvos do Assistente sobraram depois do filtro da lista do mapper. */
  mapperTargets?: number;
  execution?: AutoFarmExecutionSummary;
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
      mode: AutoFarmMode;
      targetSource: AutoFarmTargetSource;
      lotTemplate: AutoFarmLotTemplate;
      mapperTargets?: number;
      execution?: AutoFarmExecutionSummary;
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
      mode: AutoFarmMode;
      targetSource: AutoFarmTargetSource;
      lotTemplate: AutoFarmLotTemplate;
      mapperTargets?: number;
      execution?: AutoFarmExecutionSummary;
    }>;

function reportExtras(extras: AutoFarmReportExtras | undefined): AutoFarmReportExtras {
  return {
    mode: extras?.mode ?? 'preview',
    targetSource: extras?.targetSource ?? 'assistente',
    lotTemplate: extras?.lotTemplate ?? 'A',
    ...(extras?.mapperTargets !== undefined ? { mapperTargets: extras.mapperTargets } : {}),
    ...(extras?.execution !== undefined ? { execution: extras.execution } : {}),
  };
}

export function buildAutoFarmReport(
  preview: AutoFarmPreviewDecision,
  villageId: string,
  generatedAt: string,
  rotation: AutoFarmRotation,
  extras?: AutoFarmReportExtras,
): AutoFarmLastReport {
  const rotationSummary: AutoFarmRotationSummary = { total: rotation.ids.length, source: rotation.source };
  const extra = reportExtras(extras);
  if (preview.kind === 'NO_WORK') {
    return Object.freeze({
      outcome: 'NO_WORK',
      generatedAt,
      villageId,
      code: preview.code,
      reason: preview.reason,
      exclusions: preview.exclusions,
      rotation: rotationSummary,
      ...extra,
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
    ...extra,
  });
}

/** Ação recomendada pelo relatório (pura — orienta o jogador no painel). */
export function autoFarmRecommendedAction(report: AutoFarmLastReport, mode: AutoFarmMode = 'preview'): string {
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
  if (mode === 'executar') {
    return 'Ação recomendada: abra a Praça de Reunião da aldeia do ciclo (e arme o módulo) para o próximo envio.';
  }
  return 'Ação recomendada: aprove a rodada pelo Assistente de Saque do jogo — este módulo não envia ataques.';
}

/** Trecho de execução do status (modo EXECUTAR). */
function autoFarmExecutionNote(execution: AutoFarmExecutionSummary | undefined): string {
  if (execution === undefined) return 'Nenhum comando foi enviado neste ciclo.';
  switch (execution.outcome) {
    case 'ENVIADO': {
      const units = Object.entries(execution.units)
        .map(([unit, amount]) => `${amount} ${unit}`)
        .join(', ');
      return `Enviado comando ${execution.lotTemplate} para ${execution.target} (${units}; saque estimado ${execution.estimatedHaul}) — 1 comando neste ciclo, faixa humanizada.`;
    }
    case 'PULADO':
      return `Nada foi enviado: ${execution.reason}`;
    case 'FALHA':
      return `Envio falhou: ${execution.reason}`;
    case 'BLOQUEADO':
      return `Execução bloqueada: ${execution.reason}`;
    default:
      return 'Nenhum comando foi enviado neste ciclo.';
  }
}

export function autoFarmStatusMessage(
  report: AutoFarmLastReport,
  rotation: AutoFarmRotation,
  options: Readonly<{ mode?: AutoFarmMode; execution?: AutoFarmExecutionSummary; templateC?: FarmTemplateC }> = {},
): { message: string; kind: 'ok' | 'info' | 'warn' } {
  const mode = options.mode ?? report.mode;
  const rodada = ` Aldeias na rodada: ${rotation.ids.length} (${rotation.source}).`;
  const mapperNote = report.mapperTargets !== undefined ? ` Lista do mapper: ${report.mapperTargets} alvo(s).` : '';
  if (mode === 'preview') {
    if (report.outcome === 'NO_WORK') {
      return {
        message: `${report.reason}${rodada} ${autoFarmRecommendedAction(report)} Somente leitura — nenhum ataque enviado.`,
        kind: 'info',
      };
    }
    return {
      message: `Prévia Auto Farm (${report.villageId}): ${report.executableActions} executáveis de ${report.totalTargets} alvos (template ${report.templateId}).${rodada}${mapperNote} ${autoFarmRecommendedAction(report)} Somente leitura — nenhum ataque enviado.`,
      kind: 'ok',
    };
  }
  const resumo =
    report.outcome === 'NO_WORK'
      ? report.reason
      : `Prévia Auto Farm (${report.villageId}): ${report.executableActions} executáveis de ${report.totalTargets} alvos (lote ${report.lotTemplate}).`;
  const nota =
    report.lotTemplate === 'C'
      ? ` Template C em uso (${farmTemplateCSummary(options.templateC ?? FARM_TEMPLATE_C_DEFAULTS)}).`
      : '';
  const execution = autoFarmExecutionNote(options.execution ?? report.execution);
  return {
    message: `${resumo}${rodada}${mapperNote}${nota} Modo EXECUTAR: ${execution}`,
    kind: options.execution?.outcome === 'ENVIADO' ? 'ok' : options.execution?.outcome === 'FALHA' ? 'warn' : 'info',
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
  desc: 'Lê o Assistente de Saque das aldeias da rodada (lista configurada; vazia = TODAS as SUAS aldeias) e mantém a prévia. No modo EXECUTAR (com o módulo armado) envia 1 comando de farm por ciclo pela Praça de Reunião, na faixa humanizada.',
  category: 'planejamento',
  screen: null,
  // Onda 4: o módulo MUTA o jogo no modo EXECUTAR — o runtime exige opt-in +
  // armar 30min. A prévia segue rodando em qualquer tela; a execução só sai
  // com a Praça de Reunião aberta na aldeia do ciclo.
  mutating: true,
  settingsDefaults: DEFAULT_SETTINGS,
  // Ficam FORA do formulário: villages é chave de storage SEPARADA ('villages',
  // IDs numéricos — não parte do objeto settings), targetBlacklist é lista e o
  // templateC é a estrutura da composição própria (defaults do módulo).
  // Auto-serviço (Onda 12): 'villages' VAZIA = o ciclo usa TODAS as aldeias
  // próprias do jogador; preenchida = usa exatamente os IDs configurados.
  settingsForm: [
    {
      key: 'mode',
      label: 'Modo',
      type: 'select',
      options: [
        { value: 'preview', label: 'Prévia (somente leitura)' },
        { value: 'executar', label: 'Executar (1 comando por ciclo)' },
      ],
      help: 'Prévia é o padrão: nada é enviado. EXECUTAR envia 1 comando por ciclo pela Praça de Reunião (exige o módulo armado).',
    },
    {
      key: 'templateId',
      label: 'Template do saque',
      type: 'select',
      options: [
        { value: 'A', label: 'A (do jogo)' },
        { value: 'B', label: 'B (do jogo)' },
        { value: 'C', label: 'C (composição própria)' },
      ],
      help: 'A/B são os templates do Assistente de Saque. O C é a composição do Hub (por prioridade de unidade e mínimo de saque).',
    },
    {
      key: 'targetSource',
      label: 'Fonte dos alvos',
      type: 'select',
      options: [
        { value: 'assistente', label: 'Assistente de Saque' },
        { value: 'mapper', label: 'Somente lista do Mapeador' },
      ],
      help: 'A lista do Mapeador é gravada pelo módulo "Auto Farm pelo Mapa" (bárbaras por região/distância/pontos). Sem lista fresca, o ciclo não executa.',
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
    let settings: AutoFarmPluginSettings;
    try {
      settings = parseAutoFarmSettings(ctx.storage.get<unknown>('settings', DEFAULT_SETTINGS));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.status(`Configurações inválidas do Auto Farm (${message}) — nenhum ciclo foi executado.`, 'warn');
      return;
    }

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
    // No modo EXECUTAR a aldeia ABERTA tem prioridade quando está na rodada: o
    // transporte só envia da aldeia da tela, então planejar a aldeia aberta é
    // o que permite executar no mesmo ciclo.
    const openIndex = settings.mode === 'executar' ? list.indexOf(ctx.villageId) : -1;
    const cursor = ctx.storage.get<number>('cursor', 0);
    const index = openIndex >= 0 ? openIndex : cursor % list.length;
    const villageId = list[index] ?? ctx.villageId;
    ctx.storage.set('cursor', (index + 1) % list.length);

    let snapshot: AutoFarmSnapshot;
    try {
      snapshot = await loadAutoFarmSnapshot(villageId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.status(`Falha ao ler o Assistente de Saque: ${message} Nenhum ataque foi enviado.`, 'warn');
      return;
    }

    // ── Lista do Mapper (opcional): restringe os alvos às bárbaras mapeadas ──
    let mapperTargets: number | undefined;
    let mapperBlock: string | null = null;
    let planningSnapshot = snapshot;
    if (settings.targetSource === 'mapper') {
      const stored = gm.get<unknown>(`tsh-auto:${ctx.world}:auto-farm:targets`, null);
      const parsed = mapperTargetListSchema.safeParse(stored);
      if (!parsed.success) {
        ctx.status(
          'A lista do Mapper não foi encontrada (ou está inválida) — rode o módulo "Auto Farm pelo Mapa" antes. Nenhum ataque foi enviado.',
          'warn',
        );
        return;
      }
      const coordinates = mapperCoordinates(parsed.data);
      const kept = snapshot.targets.filter((target) => coordinates.has(`${target.x}|${target.y}`));
      mapperTargets = kept.length;
      planningSnapshot = autoFarmSnapshotSchema.parse({ ...snapshot, targets: kept });
      if (isMapperListStale(parsed.data, serverNowMs(), settings.templateC.reScoutHours)) {
        mapperBlock = `A lista do Mapper está mais velha que ${settings.templateC.reScoutHours}h — rode o módulo "Auto Farm pelo Mapa" para atualizá-la.`;
      }
    }

    const templateC = settings.templateC;
    if (settings.templateId === 'C') planningSnapshot = snapshotForTemplateC(planningSnapshot, templateC);

    const preview = planAutoFarmPreview(planningSnapshot, planningSettings(settings));
    const generatedAt = new Date().toISOString();
    const extras: AutoFarmReportExtras = {
      mode: settings.mode,
      targetSource: settings.targetSource,
      lotTemplate: settings.templateId,
      ...(mapperTargets !== undefined ? { mapperTargets } : {}),
    };
    // O relatório de prévia é gravado SEMPRE — antes de qualquer mutação (o
    // passo 1 do comando navega e pode destruir o contexto do ciclo).
    ctx.storage.set('last-report', buildAutoFarmReport(preview, villageId, generatedAt, rotation, extras));
    if (settings.mode !== 'executar') {
      const status = autoFarmStatusMessage(buildAutoFarmReport(preview, villageId, generatedAt, rotation, extras), rotation, {
        templateC,
      });
      ctx.status(status.message, status.kind);
      return;
    }

    // ── Execução: 1 comando por ciclo, das regras mais baratas à mutação ────
    const nowMs = serverNowMs();
    const decision = selectAutoFarmExecution({
      preview,
      ledger: ctx.storage.get<unknown>('ledger', null),
      nowMs,
      cooldownMs: settings.intervalMinutes * 60_000,
      templateId: settings.templateId,
      templateC,
      unitCapacity: AUTO_FARM_UNIT_HAUL,
      sourceTroops: planningSnapshot.source.troops,
    });
    let execution: AutoFarmExecutionSummary;
    if (mapperBlock !== null) {
      execution = { outcome: 'BLOQUEADO', reason: mapperBlock };
    } else if (!isCommandScreenOpen()) {
      execution = {
        outcome: 'BLOQUEADO',
        reason: `abra a Praça de Reunião (screen=place) da aldeia ${villageId} — o envio usa o formulário da tela.`,
      };
    } else if (decision.kind === 'SKIP') {
      execution = { outcome: 'PULADO', reason: decision.reason };
    } else {
      const lot = decision.lot;
      // Ledger ANTES do clique (o passo 2 navega): nunca duplica o envio.
      ctx.storage.set(
        'ledger',
        recordAutoFarmSend(ctx.storage.get<unknown>('ledger', null), lot.coordinate, nowMs, new Date(nowMs).toISOString()),
      );
      try {
        await submitCommand2Step(lot.coordinate, { ...lot.units }, { attack: true, lane: 'humanizado' });
        execution = {
          outcome: 'ENVIADO',
          target: lot.coordinate,
          lotTemplate: lot.lotTemplate,
          units: lot.units,
          estimatedHaul: lot.estimatedHaul,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        execution = isUncertainMutationError(error)
          ? { outcome: 'PULADO', reason: `envio inconclusivo (${message}) — alvo mantido no ledger, sem repetição.` }
          : { outcome: 'FALHA', reason: `${message} O alvo ficou no ledger e só repete após o intervalo configurado.` };
      }
    }

    const report = buildAutoFarmReport(preview, villageId, generatedAt, rotation, { ...extras, execution });
    ctx.storage.set('last-report', report);
    const status = autoFarmStatusMessage(report, rotation, { mode: settings.mode, execution, templateC });
    ctx.status(status.message, status.kind);
  },
});
