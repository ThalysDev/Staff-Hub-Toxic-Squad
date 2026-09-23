// Plugin TSH 'mega-builder' — porta do plugin da extensão
// (toxic-squad-hub-ext/.../modules/features/mega-builder/plugin.ts) para o
// motor de ciclos do userscript:
// - fila de construção por settings (priorities/reserve) OU template GC
//   importado (base64 decodificado pelo codec vendado
//   decodeGcTemplate — igrejas rejeitadas, limiar de fazenda honrado);
// - NOVO (Onda 16): fila em TEXTO (settings.prioritiesText, "um edifício por
//   linha; opcionalmente edifício:nível") — parse PURA com whitelist de
//   edifícios; linha inválida = status warn e NADA muda (as priorities
//   anteriores seguem valendo — fail-closed). Preenchido e válido, o texto
//   tem PRIORIDADE sobre o template GC;
// - leitura da tela screen=main: fila ativa (#build_queue, presente só com
//   construção ativa — verificado ao vivo no br142), níveis dos edifícios
//   ([data-building]+data-level, porta do readBuildings) e recursos da barra;
// - F2: UMA mutação por ciclo — upgradeBuilding do primeiro item pendente da
//   fila (respeitando as reservas de recursos configuradas).
// - Onda 5b: VISÃO HORAS (settings.viewMode 'fila'|'horas') — o relatório de
//   prévia passa a ordenar a fila pendente pelo tempo estimado até os recursos
//   caberem, usando o farm (produção por hora) lido da página; sem leitura de
//   custo/produção o item sai como "sem estimativa" (fail-closed, nada é
//   inventado). COMPARAR PP (settings.comparePp + ppFactor) mostra o custo
//   estimado em Pontos Premium (custo total / 1000 × fator). COLETAR QUESTS
//   (settings.collectQuests) clica o botão canônico de recompensa de quest da
//   tela main quando ele é inequívoco (rótulo exato + exatamente 1 candidato)
//   — a armação do módulo é a confirmação implícita; o clique consome o F2 do
//   ciclo (nenhuma ampliação no mesmo ciclo).

import { z } from 'zod';
import { registerTsh, type TshAutomation, type TshCycleContext } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import { upgradeBuilding } from '../tsh-transport';
import { awaitRoutineMutation } from '../tsh-humanize';
import {
  decodeGcTemplate,
  GcTemplateCodecError,
  type GcTemplateCodecErrorCode,
} from '../../../ext/modules/features/mega-builder/gc-template-codec';
import type { ResourceType } from '../../../ext/modules/shared/module-types';

const RESOURCES: readonly ResourceType[] = ['wood', 'stone', 'iron'];

function gcCodecErrorMessage(code: GcTemplateCodecErrorCode): string {
  switch (code) {
    case 'GC_BASE64_INVALID':
      return 'O template GC não é um Base64 válido.';
    case 'GC_INPUT_TOO_LARGE':
      return 'O template GC excede o tamanho suportado.';
    case 'GC_MARKER_MISSING':
      return 'O template GC não contém o marcador de template esperado.';
    case 'GC_NO_VALID_STEPS':
      return 'O template GC não contém passos de construção válidos.';
    case 'MODEL_OUT_OF_BOUNDS':
      return 'O template GC está fora dos limites suportados.';
  }
}

/** Decodificação + gates do template GC (porta 1:1 do plugin da extensão). */
export function decodeBuilderImport(
  encoded: string,
):
  | { ok: true; steps: ReadonlyArray<{ buildingId: string; targetLevel: number }>; name: string; threshold: number }
  | { ok: false; reason: string } {
  let decoded;
  try {
    decoded = decodeGcTemplate(encoded);
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof GcTemplateCodecError
          ? gcCodecErrorMessage(error.code)
          : 'O template GC não pôde ser decodificado.',
    };
  }
  if (decoded.orderedSteps.some((step) => step.buildingId === 'church' || step.buildingId === 'church_f')) {
    return { ok: false, reason: 'Template contém edifícios de igreja ainda não suportados' };
  }
  return {
    ok: true,
    steps: decoded.orderedSteps,
    name: decoded.name,
    threshold: decoded.farmPriority.thresholdPercent,
  };
}

/** Item da fila de construção (mesma forma do settings.priorities). */
export interface BuilderPriority {
  building: string;
  targetLevel: number;
}

/** Edifícios aceitos na fila em texto (chaves do jogo). */
const BUILDING_WHITELIST: ReadonlySet<string> = new Set([
  'main',
  'barracks',
  'stable',
  'garage',
  'snob',
  'smith',
  'place',
  'statue',
  'market',
  'wood',
  'stone',
  'iron',
  'farm',
  'storage',
  'hide',
  'wall',
]);
const WHITELIST_LABEL = [...BUILDING_WHITELIST].join(', ');

/**
 * Nível-alvo de linha SEM nível explícito ("main") = até o máximo do
 * edifício no mundo. Nenhum edifício do jogo passa de 99, então o item
 * permanece pendente enquanto o jogo oferecer o link de ampliação.
 */
export const PRIORITY_UNTIL_MAX_LEVEL = 99;

/**
 * Parser PURA da fila em texto (Onda 16): um edifício por linha, na ordem;
 * opcionalmente "edifício:nível" (ex.: "main:20"). Case e espaços extra são
 * tolerados; linhas vazias são ignoradas. Qualquer linha inválida (edifício
 * fora da whitelist, nível não inteiro/≤ 0, dois-pontos sobrando) derruba o
 * parse INTEIRO com o motivo da primeira linha ruim — o chamador mantém as
 * priorities anteriores (fail-closed).
 */
export function parsePrioritiesText(
  text: string,
): { ok: true; priorities: BuilderPriority[] } | { ok: false; reason: string } {
  const priorities: BuilderPriority[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parts = line.split(':');
    const building = (parts[0] ?? '').trim().toLowerCase();
    const levelPart = parts[1];
    if (parts.length > 2 || building === '' || !BUILDING_WHITELIST.has(building)) {
      return {
        ok: false,
        reason: `linha ${index + 1} ("${line}") não é um edifício aceito — use um por linha: ${WHITELIST_LABEL}.`,
      };
    }
    let targetLevel = PRIORITY_UNTIL_MAX_LEVEL;
    if (levelPart !== undefined && levelPart.trim() !== '') {
      const parsedLevel = Number(levelPart.trim().replace(',', '.'));
      if (!Number.isInteger(parsedLevel) || parsedLevel <= 0) {
        return {
          ok: false,
          reason: `linha ${index + 1} ("${line}") tem nível inválido — use um inteiro positivo (ex.: main:20).`,
        };
      }
      targetLevel = parsedLevel;
    }
    priorities.push({ building, targetLevel });
  }
  return { ok: true, priorities };
}

const builderSettings = z
  .object({
    priorities: z.array(z.object({ building: z.string(), targetLevel: z.number().int().positive() })).default([]),
    reserve: z.record(z.string(), z.number().int().nonnegative()).default({ wood: 0, stone: 0, iron: 0 }),
    gcTemplateImport: z.string().default(''),
    prioritiesText: z.string().default(''),
    farmPriorityThreshold: z.number().int().min(0).max(100).default(0),
    /** Visão do relatório de prévia (Onda 5b): fila (de sempre) ou horas. */
    viewMode: z.enum(['fila', 'horas']).default('fila'),
    /** Coleta recompensa de quest visível na tela main (Onda 5b). */
    collectQuests: z.boolean().default(false),
    /** Mostra o custo estimado em PP na prévia (Onda 5b). */
    comparePp: z.boolean().default(false),
    /** Fator fixo de conversão recurso → PP da estimativa (Onda 5b). */
    ppFactor: z.number().min(0).max(1000).default(30),
  })
  .superRefine((settings, context) => {
    if (settings.gcTemplateImport.trim() === '') return;
    const decoded = decodeBuilderImport(settings.gcTemplateImport);
    if (!decoded.ok) context.addIssue({ code: 'custom', path: ['gcTemplateImport'], message: decoded.reason });
  });

type BuilderSettings = z.infer<typeof builderSettings>;

/** Espelha os defaults do schema zod (usado como fallback e semente do painel). */
export const DEFAULT_SETTINGS: BuilderSettings = {
  priorities: [],
  reserve: { wood: 0, stone: 0, iron: 0 },
  gcTemplateImport: '',
  prioritiesText: '',
  farmPriorityThreshold: 0,
  viewMode: 'fila',
  collectQuests: false,
  comparePp: false,
  ppFactor: 30,
};

const SETTINGS_FORM: SettingsField[] = [
  {
    key: 'prioritiesText',
    label: 'Fila de construção (texto)',
    type: 'textarea',
    placeholder: 'main:20\nbarracks\nstable:15',
    help: 'Um edifício por linha, na ordem de prioridade; opcionalmente "edifício:nível" (ex.: main:20). Linha sem nível = amplia até o máximo do edifício. Preenchido e válido, vale MAIS que o template GC. Linha inválida: nada é feito e as prioridades salvas continuam valendo.',
  },
  {
    key: 'gcTemplateImport',
    label: 'Template GC (Base64)',
    type: 'textarea',
    placeholder: 'Cole aqui o template GC exportado (Base64)…',
    help: 'Se preenchido (e a fila em texto acima estiver vazia/inválida), o template define a fila de construção na ordem (igrejas são rejeitadas e o limiar de fazenda vem do próprio template).',
  },
  {
    key: 'viewMode',
    label: 'Visão do relatório',
    type: 'select',
    options: [
      { value: 'fila', label: 'Fila (ordem de prioridade)' },
      { value: 'horas', label: 'Horas (tempo estimado com o farm atual)' },
    ],
    help: 'A visão Horas ordena a fila pendente pelo tempo estimado até os recursos caberem, usando a produção por hora lida da página; itens sem custo/produção legível saem como "sem estimativa".',
  },
  {
    key: 'collectQuests',
    label: 'Coletar recompensas de quest',
    type: 'boolean',
    help: 'Ligado, clica o botão canônico "Receber recompensa" quando ele está visível na tela principal (rótulo exato e um único candidato — sem dúvida, nada é clicado). A armação do módulo é a confirmação; o clique consome o ciclo (1 mutação).',
  },
  {
    key: 'comparePp',
    label: 'Mostrar custo em PP na prévia',
    type: 'boolean',
    help: 'Acrescenta ao relatório o custo estimado em Pontos Premium de cada item pendente (custo total / 1000 × fator).',
  },
  {
    key: 'ppFactor',
    label: 'Fator de conversão para PP',
    type: 'number',
    min: 0,
    max: 1000,
    step: 1,
    help: 'Fator fixo usado na estimativa de PP (padrão 30). Vale só quando "Mostrar custo em PP" está ligado.',
  },
];

/** Inteiro de jogo pt-BR ("1.234") — porta do parseGameInteger. */
function parseGameInteger(value: string | null | undefined): number {
  if (!value) return 0;
  const normalized = value.trim().replace(/\s/g, '');
  const brazilian = normalized.replace(/\./g, '').replace(',', '.');
  const parsed = Number(brazilian.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function readResources(doc: Document): Record<ResourceType, number> {
  const read = (resource: ResourceType): number => {
    const element = doc.querySelector(`#${resource}, [data-resource="${resource}"], .resource-${resource}`);
    const text =
      element instanceof HTMLInputElement || element instanceof HTMLSelectElement
        ? element.value
        : element?.textContent;
    return parseGameInteger(text);
  };
  return { wood: read('wood'), stone: read('stone'), iron: read('iron') };
}

/** Fila de construção ativa (porta do readBuildQueue: #build_queue presente). */
function hasActiveBuildQueue(doc: Document): boolean {
  return doc.querySelector('#build_queue') !== null;
}

// ── Visão Horas / comparação em PP (Onda 5b — puro e testável) ──────────────

export type ProductionRates = Record<ResourceType, number>;

/**
 * Produção por hora lida da página (HEURÍSTICA tolerante e fail-closed):
 * procura um atributo de dados por recurso e, se não houver, o "N por hora"
 * do título/tooltip do recurso no header. Nada legível → null (o relatório
 * diz "sem estimativa" em vez de inventar tempo).
 */
export function readProductionPerHour(doc: Document): ProductionRates | null {
  const rates: ProductionRates = { wood: 0, stone: 0, iron: 0 };
  let readable = 0;
  for (const resource of RESOURCES) {
    const direct = doc.querySelector<HTMLElement>(`[data-production="${resource}"], #${resource}_production`);
    let value = parseGameInteger(direct?.getAttribute('data-production-value') ?? direct?.textContent ?? '');
    if (value <= 0) {
      const header = doc.querySelector<HTMLElement>(
        `#${resource}, [data-resource="${resource}"], .resource-${resource}`,
      );
      const title = `${header?.getAttribute('title') ?? ''} ${header?.getAttribute('data-tooltip') ?? ''}`;
      const match = title.match(/([\d.]+)[^\d]{0,20}por hora/i) ?? title.match(/por hora[^\d]{0,20}([\d.]+)/i);
      if (match) value = parseGameInteger(match[1] ?? '');
    }
    if (value > 0) {
      rates[resource] = value;
      readable += 1;
    }
  }
  return readable === 0 ? null : rates;
}

/**
 * Custo por recurso do próximo nível lido da linha do edifício (HEURÍSTICA
 * tolerante): atributos data-cost-<recurso> primeiro, depois os ícones de
 * recurso da própria linha com o número do recipiente mais próximo (mesma
 * técnica do custo de unidade do recrutamento). Custo ilegível = ausente.
 */
export function readBuildingCosts(doc: Document): Map<string, Partial<Record<ResourceType, number>>> {
  const costs = new Map<string, Partial<Record<ResourceType, number>>>();
  for (const row of Array.from(doc.querySelectorAll<HTMLElement>('[data-building]'))) {
    const building = row.getAttribute('data-building');
    if (building === null || building === '') continue;
    const cost: Partial<Record<ResourceType, number>> = {};
    for (const resource of RESOURCES) {
      const fromAttribute = parseGameInteger(row.getAttribute(`data-cost-${resource}`));
      if (fromAttribute > 0) {
        cost[resource] = fromAttribute;
        continue;
      }
      const icon = row.querySelector<HTMLImageElement>(`img[src*="${resource}"]`);
      if (icon === null) continue;
      const text = icon.closest('span, td')?.textContent ?? '';
      const amount = parseGameInteger((text.match(/[\d.,]+/) ?? ['0'])[0]);
      if (amount > 0) cost[resource] = amount;
    }
    if (Object.keys(cost).length > 0) costs.set(building, cost);
  }
  return costs;
}

/**
 * Horas estimadas até a aldeia poder pagar o custo (PURA): máximo, por
 * recurso, de faltante / produção por hora. Custo AUSENTE (não lido) ou
 * produção ilegível/zerada para um recurso faltante → null (sem estimativa).
 */
export function estimateHoursUntilAffordable(
  cost: Partial<Record<ResourceType, number>>,
  resources: Record<ResourceType, number>,
  production: ProductionRates | null,
): number | null {
  if (Object.keys(cost).length === 0) return null; // custo não lido
  let hours = 0;
  for (const resource of RESOURCES) {
    const missing = Math.max(0, (cost[resource] ?? 0) - (resources[resource] ?? 0));
    if (missing <= 0) continue;
    const rate = production?.[resource] ?? 0;
    if (rate <= 0) return null;
    hours = Math.max(hours, missing / rate);
  }
  return hours;
}

/** Custo total estimado em PP: (recursos totais / 1000) × fator (PURA). */
export function estimatePpCost(cost: Partial<Record<ResourceType, number>>, ppFactor: number): number {
  const total = RESOURCES.reduce((sum, resource) => sum + (cost[resource] ?? 0), 0);
  return Math.round((total / 1000) * Math.max(0, ppFactor));
}

/** Horas em pt-BR curto ("~1,2h" / "~3h" / "~45min"). */
export function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return '?';
  if (hours < 1) return `~${Math.max(1, Math.round(hours * 60))}min`;
  return `~${hours.toFixed(hours < 10 ? 1 : 0).replace('.', ',')}h`;
}

export interface BuilderReportInput {
  /** Fila pendente na ordem de prioridade (só o que falta ampliar). */
  pending: BuilderPriority[];
  resources: Record<ResourceType, number>;
  production: ProductionRates | null;
  costs: ReadonlyMap<string, Partial<Record<ResourceType, number>>>;
  viewMode: 'fila' | 'horas';
  comparePp: boolean;
  ppFactor: number;
}

/**
 * Relatório de prévia do construtor (PURO): na visão 'fila' sem comparação em
 * PP não há relatório (comportamento de sempre); 'horas' ordena a fila pelo
 * tempo estimado até os recursos caberem (farm atual) e 'comparePp' acrescenta
 * o custo estimado em Pontos Premium. Item sem custo/produção legível sai como
 * "sem estimativa" — nada é inventado (fail-closed).
 */
export function buildBuilderQueueReport(input: BuilderReportInput): string {
  if (input.viewMode !== 'horas' && !input.comparePp) return '';
  const label = (item: BuilderPriority): string => `${item.building}:${item.targetLevel}`;
  const parts: string[] = [];
  if (input.viewMode === 'horas') {
    if (input.production === null) {
      parts.push(
        `Visão Horas: produção por hora não legível — fila na ordem: ${input.pending.map(label).join(', ')}.`,
      );
    } else {
      const estimated = input.pending.map((item, index) => ({
        item,
        index,
        hours: estimateHoursUntilAffordable(input.costs.get(item.building) ?? {}, input.resources, input.production),
      }));
      const known = estimated
        .filter((entry) => entry.hours !== null)
        .sort((left, right) => (left.hours ?? 0) - (right.hours ?? 0) || left.index - right.index);
      const unknown = estimated.filter((entry) => entry.hours === null);
      const knownText = known.map((entry, position) => `${position + 1}) ${label(entry.item)} ${formatHours(entry.hours ?? 0)}`);
      parts.push(
        `Visão Horas (farm atual): ${knownText.length > 0 ? knownText.join('; ') : 'nenhum item com estimativa'}${
          unknown.length > 0 ? `; sem estimativa: ${unknown.map((entry) => label(entry.item)).join(', ')}` : ''
        }.`,
      );
    }
  }
  if (input.comparePp) {
    const pp = input.pending.map((item) => {
      const cost = input.costs.get(item.building);
      if (cost === undefined || Object.keys(cost).length === 0) return `${label(item)} (custo não lido)`;
      return `${label(item)} ~${estimatePpCost(cost, input.ppFactor).toLocaleString('pt-BR')} PP`;
    });
    parts.push(`Custo em PP estimado (fator ${input.ppFactor}): ${pp.join('; ')}.`);
  }
  return parts.join(' ');
}

// ── Quests (Onda 5b — seleção fail-closed) ─────────────────────────────────

/**
 * Rótulos aceitos do botão de recompensa de quest (o clique só acontece com
 * rótulo EXATO — "concluir"/"aceitar" NÃO entram: poderiam fazer outra coisa).
 */
export const QUEST_REWARD_LABELS: readonly string[] = ['receber recompensa', 'coletar recompensa'];

/** Texto normalizado (minúsculas, espaços colapsados) para comparar rótulos. */
export function normalizeQuestLabel(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** O texto é de um botão de recompensa canônico? (PURA) */
export function isQuestRewardLabel(text: string | null | undefined): boolean {
  return QUEST_REWARD_LABELS.includes(normalizeQuestLabel(text));
}

/**
 * Botão canônico de recompensa de quest na tela main: precisa estar DENTRO de
 * um contêiner de quest ([class*="quest"]) e ter rótulo exato. Zero ou mais de
 * um candidato → null (fail-closed: nunca clica em dúvida).
 */
export function findQuestRewardButton(doc: Document): HTMLElement | null {
  const controls = Array.from(
    doc.querySelectorAll<HTMLElement>('a, button, input[type="submit"], input[type="button"]'),
  );
  const candidates = controls.filter((control) => {
    const text = control instanceof HTMLInputElement ? control.value : control.textContent;
    if (!isQuestRewardLabel(text)) return false;
    return control.closest('[class*="quest"]') !== null;
  });
  if (candidates.length !== 1) return null;
  const button = candidates[0];
  if (button === undefined) return null;
  if (button instanceof HTMLInputElement && button.disabled) return null;
  return button;
}

/**
 * Níveis dos edifícios da tela principal: caminho primário [data-building]
 * (porta do readBuildings da extensão) com fallback para os links canônicos
 * de ampliação (a chave do edifício viaja no parâmetro id=/type= do href —
 * mesmos seletores do transporte) + "Nível N" do texto da linha.
 */
function readMainBuildings(doc: Document): Map<string, number> {
  const levels = new Map<string, number>();
  for (const row of Array.from(doc.querySelectorAll<HTMLElement>('[data-building]'))) {
    const building = row.getAttribute('data-building');
    if (building === null || building === '') continue;
    const level = parseGameInteger(
      row.getAttribute('data-level') ??
        row.querySelector('[data-level]')?.getAttribute('data-level') ??
        row.textContent ??
        '',
    );
    if (level > 0) levels.set(building, level);
  }
  if (levels.size > 0) return levels;
  for (const link of Array.from(
    doc.querySelectorAll<HTMLAnchorElement>('a[href*="screen=main"][href*="action=upgrade_building"]'),
  )) {
    const href = new URL(link.href, doc.baseURI);
    const building = href.searchParams.get('id') ?? href.searchParams.get('type') ?? '';
    if (building === '' || levels.has(building)) continue;
    const levelText = link.closest('tr')?.textContent ?? '';
    const match = levelText.match(/n[íi]vel\s+(\d{1,3})/i);
    levels.set(building, match !== null ? Number(match[1]) : 0);
  }
  return levels;
}

async function runCycle(ctx: TshCycleContext): Promise<void> {
  const parsed = builderSettings.safeParse(ctx.storage.get('settings', DEFAULT_SETTINGS));
  if (!parsed.success) {
    ctx.status('Configurações do Mega Construtor inválidas — nada foi feito. Revise prioridades/template GC.', 'warn');
    return;
  }
  const settings: BuilderSettings = parsed.data;

  // Coletar quests (Onda 5b): a recompensa visível é coletada ANTES de tudo e
  // consome o F2 do ciclo. Botão inequívoco (rótulo exato + 1 candidato) e
  // humanização de rotina respeitada; sem candidato, segue o fluxo normal.
  if (settings.collectQuests) {
    const reward = findQuestRewardButton(document);
    if (reward !== null) {
      const liberado = await awaitRoutineMutation('construcao');
      if (!liberado) {
        ctx.status('Pausa de humanização ativa — a recompensa de quest foi pulada neste ciclo.', 'info');
        return;
      }
      reward.click();
      ctx.status('Recompensa de quest coletada (1 clique por ciclo; a próxima ampliação fica para o ciclo seguinte).', 'ok');
      return;
    }
  }

  if (hasActiveBuildQueue(document)) {
    ctx.status('Já existe uma construção em andamento nesta aldeia.', 'info');
    return;
  }
  let priorities = settings.priorities;
  let templateName: string | undefined;
  // Fila em texto (Onda 16): preenchida e VÁLIDA, tem prioridade sobre o
  // template GC. Linha inválida = fail-closed: status warn e as priorities
  // anteriores seguem valendo (o ciclo não cai para o template nem muta).
  if (settings.prioritiesText.trim() !== '') {
    const parsedText = parsePrioritiesText(settings.prioritiesText);
    if (!parsedText.ok) {
      ctx.status(`Fila em texto inválida — nada foi feito e as prioridades salvas seguem valendo (${parsedText.reason}).`, 'warn');
      return;
    }
    priorities = parsedText.priorities;
  } else if (settings.gcTemplateImport.trim() !== '') {
    const imported = decodeBuilderImport(settings.gcTemplateImport);
    if (!imported.ok) {
      ctx.status(imported.reason, 'warn');
      return;
    }
    priorities = imported.steps.map((step) => ({ building: step.buildingId, targetLevel: step.targetLevel }));
    templateName = imported.name;
  }
  if (priorities.length === 0) {
    ctx.status('Nenhuma fila de construção configurada (texto, settings.priorities ou template GC).', 'info');
    return;
  }
  const buildings = readMainBuildings(document);
  const pending = priorities.filter((candidate) => (buildings.get(candidate.building) ?? 0) < candidate.targetLevel);
  if (pending.length === 0) {
    ctx.status('Nenhuma prioridade de construção está pendente.', 'info');
    return;
  }
  // Relatório de prévia (Onda 5b): visão Horas ordena por tempo estimado com o
  // farm atual; comparePp acrescenta o custo estimado em PP. Só monta o
  // relatório quando o usuário pediu (default = comportamento de sempre).
  const resources = readResources(document); // 1 leitura da barra (não 1 por recurso)
  const report =
    settings.viewMode === 'horas' || settings.comparePp
      ? buildBuilderQueueReport({
          pending,
          resources,
          production: readProductionPerHour(document),
          costs: readBuildingCosts(document),
          viewMode: settings.viewMode,
          comparePp: settings.comparePp,
          ppFactor: settings.ppFactor,
        })
      : '';
  const priority = pending[0];
  if (priority === undefined) return;
  const reserve = settings.reserve ?? {};
  const withinReserve = RESOURCES.every((resource) => resources[resource] >= (reserve[resource] ?? 0));
  if (!withinReserve) {
    ctx.status(`Os recursos estão abaixo das reservas configuradas.${report !== '' ? ` ${report}` : ''}`, 'info');
    return;
  }
  // F2: UMA mutação por ciclo — ampliação do próximo pendente da fila.
  await upgradeBuilding(priority.building);
  ctx.status(
    `Ampliação enviada: ${priority.building} → nível ${priority.targetLevel}${
      templateName !== undefined && templateName !== '' ? ` (template "${templateName}")` : ''
    }.${report !== '' ? ` ${report}` : ''}`,
    'ok',
  );
}

export const megaBuilderAutomation: TshAutomation = {
  id: 'mega-builder',
  label: 'Mega Construtor',
  desc: 'Fila de construção por texto, prioridades salvas ou template GC no Edifício Principal: amplia o próximo pendente (1 upgrade por ciclo), com visão Horas e coleta de quests opcionais.',
  category: 'producao',
  screen: 'main',
  mutating: true,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  runCycle,
};

registerTsh(megaBuilderAutomation);
