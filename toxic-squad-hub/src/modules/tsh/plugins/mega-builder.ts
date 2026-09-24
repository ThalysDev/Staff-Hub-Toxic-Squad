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
import { upgradeBuildingApi } from '../tsh-transport';
import { pacedGet } from '../../../core/net';
import { gm } from '../../../core/storage';
import { backgroundSleep, serverNowMs } from '../../../core/game-clock';
import { jittered } from '../farm/farm-plan';
import {
  BUILDINGS,
  parseBuildingInfo,
  parseBuildingsOverview,
  parseMainScreen,
  parseProdOverview,
  planVillageBuild,
  type BuildingId,
  type BuildingInfo,
  type BuildPlanOptions,
  type BuildTarget,
  type ProdVillage,
  refusalKey,
} from './builder-mass';
import { awaitRoutineMutation } from '../tsh-humanize';
import { getGroupVillages } from '../tsh-groups';
import { pageWindow } from '../../../core/page';
import { modelForVillage, modelTargets, readModels, readRules } from './builder-models';
import { buildBuilderPanel } from './builder-panel';
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
  'watchtower',
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

/** Nomes em português (sem acento) → código do jogo. */
const PT_ALIASES: Readonly<Record<string, string>> = {
  'edificio principal': 'main', 'ed principal': 'main', 'ed. principal': 'main', principal: 'main',
  quartel: 'barracks', estabulo: 'stable', oficina: 'garage', 'torre de vigia': 'watchtower', torre: 'watchtower',
  academia: 'snob', ferreiro: 'smith', praca: 'place', 'praca de reuniao': 'place', estatua: 'statue', mercado: 'market',
  bosque: 'wood', madeira: 'wood', 'poco de argila': 'stone', argila: 'stone', 'mina de ferro': 'iron', ferro: 'iron',
  fazenda: 'farm', armazem: 'storage', esconderijo: 'hide', muralha: 'wall',
};

/** Aceita o código do jogo ou o nome em português (com ou sem acento). */
function buildingKey(raw: string): string {
  const k = raw.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
  return PT_ALIASES[k] ?? k;
}

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
    const building = buildingKey(parts[0] ?? '');
    const levelPart = parts[1];
    if (parts.length > 2 || building === '' || !BUILDING_WHITELIST.has(building)) {
      return {
        ok: false,
        reason: `linha ${index + 1} ("${line}") não é um edifício conhecido — use o nome (fazenda, quartel, bosque…) ou o código do jogo (${WHITELIST_LABEL}).`,
      };
    }
    let targetLevel = PRIORITY_UNTIL_MAX_LEVEL;
    if (levelPart !== undefined && levelPart.trim() !== '') {
      const parsedLevel = Number(levelPart.trim().replace(',', '.'));
      if (!Number.isInteger(parsedLevel) || parsedLevel <= 0) {
        return {
          ok: false,
          reason: `linha ${index + 1} ("${line}") tem nível inválido — use um número inteiro (ex.: fazenda:20).`,
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
    /** v3.9.0: 'fundo' = todas as aldeias pelas visões do jogo; 'tela' = só com o Edifício principal aberto. */
    execMode: z.enum(['fundo', 'tela']).default('fundo'),
    /** Quantos itens deixar na fila do jogo (1–5). */
    maxQueue: z.number().int().min(1).max(5).default(2),
    /** Armazém primeiro quando o próximo custo não cabe nele. */
    storageGuard: z.boolean().default(true),
    /** true = espera o 1º pendente caber; false = pula para o próximo que cabe. */
    strictOrder: z.boolean().default(true),
    /** Ampliações por ciclo no segundo plano (com pausa humana entre elas). */
    perCycle: z.number().int().min(1).max(20).default(5),
    /** Armazém primeiro quando algum recurso passa deste % do armazém (0 = desliga). */
    storageFullPct: z.number().int().min(0).max(100).default(0),
    /**
     * −20% do jogo: CUSTA PONTOS PREMIUM (data-cost="30" no botão, BR142
     * 24/09/2026). Desligado nesta versão — volta com o Redutor (limite de PP
     * + confirmação). O valor salvo é ignorado.
     */
    useCheap: z.boolean().default(false),
    /** Fila do jogo por quantidade de itens ou por horas de construção. */
    queueMode: z.enum(['itens', 'horas']).default('itens'),
    /** Modo horas: manter pelo menos isto de construção na fila (h). */
    queueHours: z.number().min(0.5).max(72).default(5),
    /** v3.9.0: modelos (filas com nome) — lidos com tolerância por readModels. */
    models: z.array(z.unknown()).default([]),
    /** Regras por grupo/coordenada → modelo. */
    rules: z.array(z.unknown()).default([]),
    /** Modelo das aldeias sem regra ('' = elas não constroem). */
    defaultModel: z.string().default(''),
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
  execMode: 'fundo',
  maxQueue: 2,
  storageGuard: true,
  strictOrder: true,
  perCycle: 5,
  storageFullPct: 0,
  useCheap: false,
  queueMode: 'itens',
  queueHours: 5,
  models: [],
  rules: [],
  defaultModel: '',
};

const SETTINGS_FORM: SettingsField[] = [
  {
    key: 'execMode',
    label: 'Onde roda',
    type: 'select',
    options: [
      { value: 'fundo', label: 'Segundo plano — todas as aldeias' },
      { value: 'tela', label: 'Só na tela do Edifício principal (a aldeia aberta)' },
    ],
    help: 'Segundo plano: lê as Visões de Edifícios e de Produção e amplia em todas as aldeias, em qualquer tela, com pausa humana entre os pedidos. Só na tela: age só na aldeia aberta. Quem usava a versão antiga segue em "Só na tela" até escolher aqui.',
  },
  {
    key: 'prioritiesText',
    label: 'Fila de construção (um edifício por linha)',
    type: 'textarea',
    placeholder: 'fazenda:20\nquartel:10\nbosque\narmazém:25',
    help: 'Na ordem em que devem subir. Pode escrever em português ou com o código do jogo: Ed. principal = main, Quartel = barracks, Estábulo = stable, Oficina = garage, Ferreiro = smith, Mercado = market, Bosque = wood, Poço de argila = stone, Mina de ferro = iron, Fazenda = farm, Armazém = storage, Esconderijo = hide, Muralha = wall. Para parar num nível: "fazenda:20"; sem nível = até o máximo.',
  },
  {
    key: 'gcTemplateImport',
    label: 'Template GC (Base64)',
    type: 'textarea',
    placeholder: 'Cole aqui o template GC exportado (Base64)…',
    help: 'Se preenchido (e a fila em texto acima estiver vazia/inválida), o template define a fila de construção na ordem (igrejas são rejeitadas e o limiar de fazenda vem do próprio template).',
  },
  {
    key: 'maxQueue',
    label: 'Itens na fila do jogo',
    type: 'number',
    min: 1,
    max: 5,
    step: 1,
    help: 'O script completa a fila do jogo até este número. Com Conta Premium o jogo aceita até 5; sem Premium, 2. Acima do seu limite o jogo recusa.',
  },
  {
    key: 'queueMode',
    label: 'Fila do jogo por',
    type: 'select',
    options: [
      { value: 'itens', label: 'Itens (quantos na fila)' },
      { value: 'horas', label: 'Horas (quanto tempo de construção na fila)' },
    ],
    help: 'Itens: completa a fila até o número abaixo. Horas: completa enquanto a fila cobre menos que as horas pedidas (sem passar do número de itens).',
  },
  {
    key: 'queueHours',
    label: 'Horas de construção na fila (modo Horas)',
    type: 'number',
    min: 0.5,
    max: 72,
    step: 0.5,
    help: 'Ex.: 5 = mantém pelo menos 5 horas de construção enfileiradas em cada aldeia.',
  },
  {
    key: 'farmPriorityThreshold',
    label: 'Fazenda primeiro abaixo de (% livre)',
    type: 'number',
    min: 0,
    max: 100,
    step: 1,
    help: 'Quando a população livre da aldeia cai abaixo disso, a fazenda sobe antes da fila. 0 = desliga. Sugestão: 10.',
  },
  {
    key: 'storageFullPct',
    label: 'Armazém primeiro acima de (% cheio)',
    type: 'number',
    min: 0,
    max: 100,
    step: 5,
    help: 'Quando algum recurso passa desse % do armazém, o armazém sobe antes da fila (para não perder produção). 0 = desliga. Sugestão: 90.',
  },
  {
    key: 'storageGuard',
    label: 'Armazém primeiro quando ele é pequeno demais',
    type: 'boolean',
    help: 'Se o próximo edifício custa mais do que o armazém comporta, amplia o armazém antes.',
  },
  {
    key: 'strictOrder',
    label: 'Seguir a ordem à risca',
    type: 'boolean',
    help: 'Ligado: espera o próximo da fila caber nos recursos. Desligado: pula para o próximo que já cabe.',
  },
  {
    key: 'reserve',
    label: 'Deixar em casa (recursos)',
    type: 'record',
    help: 'Recursos que o construtor nunca usa (ex.: para recrutar). 0 = pode usar tudo.',
    recordKeys: [
      { key: 'wood', label: 'Madeira', min: 0, step: 1000 },
      { key: 'stone', label: 'Argila', min: 0, step: 1000 },
      { key: 'iron', label: 'Ferro', min: 0, step: 1000 },
    ],
  },
  {
    key: 'perCycle',
    label: 'Ampliações por ciclo (segundo plano)',
    type: 'number',
    min: 1,
    max: 20,
    step: 1,
    help: 'Quantas aldeias recebem uma ampliação em cada ciclo (até 20), com pausa humana entre elas. Sobrou? O próximo ciclo vem em 1 minuto.',
  },
  {
    key: 'collectQuests',
    label: 'Coletar recompensas de quest (modo "Só na tela")',
    type: 'boolean',
    help: 'Quando o botão "Receber recompensa" aparece no Edifício principal, o script clica nele. Nesse ciclo ele não amplia nada.',
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


/** Quem já usava e ainda não tem execMode gravado (a tela não pode pré-marcar "Segundo plano"). */
function legacyWithoutMode(world: string): boolean {
  const raw = gm.get<Record<string, unknown> | null>(`tsh-auto:${world}:mega-builder:settings`, null);
  return raw !== null && typeof raw === 'object' && Object.keys(raw).length > 0 && raw.execMode !== 'fundo' && raw.execMode !== 'tela';
}

/** Modo salvo: quem já usava (settings sem execMode) fica gravado em 'tela'. */
function savedBuilderMode(world: string): { mode: 'fundo' | 'tela' | null; legacy: boolean } {
  const key = `tsh-auto:${world}:mega-builder:settings`;
  const raw = gm.get<Record<string, unknown> | null>(key, null);
  if (raw === null || typeof raw !== 'object' || Object.keys(raw).length === 0) return { mode: null, legacy: false };
  if (raw.execMode === 'fundo' || raw.execMode === 'tela') {
    const since = typeof raw.legacyTela === 'number' ? raw.legacyTela : 0;
    return { mode: raw.execMode, legacy: raw.execMode === 'tela' && Date.now() - since < 7 * 24 * 60 * 60_000 };
  }
  gm.set(key, { ...raw, execMode: 'tela', legacyTela: Date.now() });
  return { mode: 'tela', legacy: true };
}

/** Fila-alvo (texto > template GC > prioridades salvas). null = já avisou e parou. */
function resolveTargets(
  ctx: TshCycleContext,
  settings: BuilderSettings,
): { targets: BuildTarget[]; templateName?: string; farmThreshold?: number } | null {
  let priorities = settings.priorities;
  let templateName: string | undefined;
  let farmThreshold: number | undefined;
  if (settings.prioritiesText.trim() !== '') {
    const parsedText = parsePrioritiesText(settings.prioritiesText);
    if (!parsedText.ok) {
      ctx.status(`Fila em texto inválida — nada foi feito (${parsedText.reason}).`, 'warn');
      return null;
    }
    priorities = parsedText.priorities;
  } else if (settings.gcTemplateImport.trim() !== '') {
    const imported = decodeBuilderImport(settings.gcTemplateImport);
    if (!imported.ok) {
      ctx.status(imported.reason, 'warn');
      return null;
    }
    priorities = imported.steps.map((step) => ({ building: step.buildingId, targetLevel: step.targetLevel }));
    templateName = imported.name;
    const t = (imported as { threshold?: unknown }).threshold;
    if (typeof t === 'number' && Number.isFinite(t)) farmThreshold = t;
  }
  const targets = priorities
    .filter((p) => (BUILDINGS as readonly string[]).includes(p.building))
    .map((p) => ({ building: p.building as BuildingId, level: p.targetLevel }));
  return { targets, ...(templateName !== undefined ? { templateName } : {}), ...(farmThreshold !== undefined ? { farmThreshold } : {}) };
}

/**
 * Fila de CADA aldeia (v3.9.0). Com modelos salvos: regra de coordenada >
 * grupo > modelo padrão (sem nenhum = a aldeia não constrói). Sem modelos: a
 * fila em texto/template GC de antes vale para todas.
 */
interface VillageTargets {
  forVillage(v: { id: string; x?: number; y?: number }): { targets: BuildTarget[]; model?: string } | null;
  templateName?: string;
  farmThreshold?: number;
  notes: string[];
}

async function villageTargets(ctx: TshCycleContext, settings: BuilderSettings): Promise<VillageTargets | null> {
  const models = readModels(settings.models);
  if (models.length === 0) {
    const resolved = resolveTargets(ctx, settings);
    if (resolved === null) return null;
    if (resolved.targets.length === 0) {
      ctx.status('Nenhuma fila de construção configurada — abra Configurar e monte um modelo (ou comece por um pronto).', 'info');
      return null;
    }
    return {
      forVillage: () => ({ targets: resolved.targets }),
      ...(resolved.templateName !== undefined ? { templateName: resolved.templateName } : {}),
      ...(resolved.farmThreshold !== undefined ? { farmThreshold: resolved.farmThreshold } : {}),
      notes: [],
    };
  }
  const rules = readRules(settings.rules).filter((r) => models.some((m) => m.id === r.modelId));
  const defaultModel = models.some((m) => m.id === settings.defaultModel) ? settings.defaultModel : '';
  if (rules.length === 0 && defaultModel === '') {
    ctx.status('Nenhuma aldeia tem modelo: em Configurar → Aldeias, escolha o modelo padrão ou ligue um modelo a um grupo/coordenada.', 'info');
    return null;
  }
  const notes: string[] = [];
  const groups = new Map<number, Set<string>>();
  for (const r of rules) {
    if (r.kind !== 'grupo' || groups.has(r.groupId)) continue;
    const vs = await getGroupVillages(r.groupId);
    if (vs.length === 0) {
      // Fail-closed: sem saber quem é do grupo, as aldeias dele cairiam no modelo padrão.
      ctx.status(`Não consegui ler as aldeias do grupo "${r.groupName || r.groupId}" (grupo vazio, apagado ou leitura falhou) — nada foi construído. Confira a regra em Configurar → Aldeias.`, 'warn');
      return null;
    }
    groups.set(r.groupId, new Set(vs.map((v) => String(v.villageId))));
  }
  const byId = new Map(models.map((m) => [m.id, m]));
  return {
    forVillage: (v) => {
      const id = modelForVillage(v, rules, groups, defaultModel);
      const m = id === null ? undefined : byId.get(id);
      return m === undefined ? null : { targets: modelTargets(m), model: m.name };
    },
    notes,
  };
}

/** Custos-base do mundo (get_building_info), lidos uma vez por sessão. */
let buildingInfoCache: Partial<Record<BuildingId, BuildingInfo>> | null = null;
async function buildingInfo(): Promise<Partial<Record<BuildingId, BuildingInfo>> | null> {
  if (buildingInfoCache === null) buildingInfoCache = parseBuildingInfo(await pacedGet('/interface.php?func=get_building_info'));
  return buildingInfoCache;
}

const BUILDING_LABEL: Record<BuildingId, string> = {
  main: 'Ed. principal', barracks: 'Quartel', stable: 'Estábulo', garage: 'Oficina', watchtower: 'Torre de vigia', snob: 'Academia',
  smith: 'Ferreiro', place: 'Praça', statue: 'Estátua', market: 'Mercado', wood: 'Bosque', stone: 'Poço de argila', iron: 'Mina de ferro',
  farm: 'Fazenda', storage: 'Armazém', hide: 'Esconderijo', wall: 'Muralha',
};

function planOptions(settings: BuilderSettings, templateFarm?: number): BuildPlanOptions {
  const r = settings.reserve ?? {};
  return {
    maxQueue: settings.maxQueue,
    keep: { wood: r.wood ?? 0, stone: r.stone ?? 0, iron: r.iron ?? 0 },
    farmFreePct: settings.farmPriorityThreshold > 0 ? settings.farmPriorityThreshold : (templateFarm ?? 0),
    storageGuard: settings.storageGuard,
    strictOrder: settings.strictOrder,
    storageFullPct: settings.storageFullPct,
    cheap: false,
    ...(settings.queueMode === 'horas' ? { queueHours: settings.queueHours, nowMs: serverNowMs() } : {}),
  };
}

/** Segundo plano: uma página de aldeias por ciclo, até N ampliações com pausa humana. */
async function runBackground(ctx: TshCycleContext, settings: BuilderSettings): Promise<void> {
  const resolved = await villageTargets(ctx, settings);
  if (resolved === null) return;
  const info = await buildingInfo();
  if (info === null) {
    ctx.status('Não consegui ler os custos dos edifícios deste mundo — nada foi construído.', 'warn');
    return;
  }
  const pageNo = ctx.storage.get<number>('massPage', 0);
  const bldHtml = await pacedGet(`/game.php?village=${ctx.villageId}&screen=overview_villages&mode=buildings&page=${pageNo}`, { fresh: true });
  const parsedBld = parseBuildingsOverview(bldHtml, serverNowMs());
  // Página que repete a anterior (conta com múltiplo exato de 1000 aldeias):
  // o jogo devolveu a última de novo — volta ao começo em vez de avançar sem fim.
  const firstId = parsedBld?.villages[0]?.id ?? '';
  const repeated = pageNo > 0 && firstId !== '' && firstId === ctx.storage.get<string>('massFirst', '');
  ctx.storage.set('massFirst', firstId);
  if (repeated) {
    ctx.storage.set('massPage', 0);
    ctx.status('Todas as aldeias revisadas — recomeço pela primeira página em 1 min.', 'info');
    ctx.again?.(60_000);
    return;
  }
  const bld = parsedBld;
  // A Produção NÃO vem na mesma ordem da Visão de Edifícios (verificado no
  // BR142): lê todas as páginas dela e cruza por id da aldeia.
  let prod: ProdVillage[] | null = [];
  for (let p = 0; p < 20 && prod !== null; p++) {
    const page = parseProdOverview(await pacedGet(`/game.php?village=${ctx.villageId}&screen=overview_villages&mode=prod&page=${p}`, { fresh: true }));
    if (page === null) prod = null;
    else {
      const before = prod.length;
      prod.push(...page.filter((v) => !prod?.some((x) => x.id === v.id)));
      if (page.length < 1000 || prod.length === before) break;
    }
  }
  if (bld === null || prod === null) {
    if (pageNo > 0) ctx.storage.set('massPage', 0);
    ctx.status('Não consegui ler as Visões de Edifícios e de Produção — elas exigem Conta Premium. Nada foi construído. Sem Premium, troque para "Só na tela" em Configurar.', 'warn');
    return;
  }
  const groupId = Number(/"group_id":"?(\d+)"?/.exec(bldHtml)?.[1] ?? 0);
  const note =
    (groupId !== 0 ? ' O jogo está mostrando só um grupo de aldeias: o construtor cobre só essas (escolha "todos" no menu de grupos do jogo para todas).' : '') +
    (resolved.notes.length > 0 ? ` ${resolved.notes.join(' ')}` : '');
  const prodById = new Map(prod.map((p) => [p.id, p]));
  const opts = planOptions(settings, resolved.farmThreshold);
  // Recusa recente do jogo (aldeia+edifício+nível): 30 min sem tentar de novo.
  const now = Date.now();
  const refusedUntil = Object.fromEntries(
    Object.entries(ctx.storage.get<Record<string, number>>('refused', {})).filter(([, until]) => until > now),
  );
  const todo: { vid: string; name: string; building: BuildingId; level: number; reason: string }[] = [];
  let full = 0;
  let done = 0;
  let noModel = 0;
  let blocked = 0;
  for (const v of bld.villages) {
    const mine = resolved.forVillage(v);
    if (mine === null) {
      noModel += 1;
      continue;
    }
    const d = planVillageBuild(v, prodById.get(v.id), mine.targets, info, opts);
    if (d.kind === 'construir' && (refusedUntil[refusalKey(v.id, d.building, d.level)] ?? 0) > now) continue;
    if (d.kind === 'construir') todo.push({ vid: v.id, name: v.name, building: d.building, level: d.level, reason: d.reason });
    else if (d.reason === 'fila-cheia') full += 1;
    else if (d.reason === 'concluido' || d.reason === 'maximo') done += 1;
    else if (d.reason === 'bloqueado') blocked += 1;
  }
  const leftover = todo.length > settings.perCycle;
  const next = leftover ? pageNo : bld.full ? pageNo + 1 : 0;
  ctx.storage.set('massPage', next);
  if (todo.length === 0) {
    const parts = [
      full > 0 ? `${full} com a fila do jogo cheia` : '',
      done > 0 ? `${done} com o modelo concluído` : '',
      blocked > 0 ? `${blocked} esperando pré-requisito ou população (veja os avisos ⚠ no modelo)` : '',
      noModel > 0 ? `${noModel} sem modelo` : '',
    ].filter((p) => p !== '');
    const rest = bld.villages.length - full - done - blocked - noModel;
    if (rest > 0) parts.push(`${rest} esperando recursos`);
    ctx.status(`Nada a construir agora: ${parts.join(', ')}.${next !== 0 ? ' Sigo nas próximas aldeias em 1 min.' : ''}${note}`, 'info');
    if (next !== 0) ctx.again?.(60_000);
    return;
  }
  let sent = 0;
  const refused: string[] = [];
  const sentKinds: BuildingId[] = [];
  for (const item of todo.slice(0, settings.perCycle)) {
    try {
      await upgradeBuildingApi(item.vid, item.building);
      sent += 1;
      sentKinds.push(item.building);
    } catch (error) {
      const e = error as { code?: string; message?: string };
      if (e.code === 'GAME_REFUSED') {
        refused.push(`${item.name}: ${e.message ?? ''}`);
        refusedUntil[refusalKey(item.vid, item.building, item.level)] = Date.now() + 30 * 60_000;
        ctx.storage.set('refused', refusedUntil);
      } else if (e.code === 'HUMANIZE_PAUSE') {
        break;
      } else {
        ctx.status(`${e.message ?? String(error)} — parei este ciclo (${sent} ampliação(ões) enviadas antes).`, 'warn');
        return;
      }
    }
    await backgroundSleep(jittered(700, 30));
  }
  if (leftover || next !== 0) ctx.again?.(60_000);
  const byBuilding = new Map<string, number>();
  for (const b of sentKinds) byBuilding.set(BUILDING_LABEL[b], (byBuilding.get(BUILDING_LABEL[b]) ?? 0) + 1);
  if (sent === 0 && refused.length === 0) {
    ctx.status('Pausa de humanização ativa — as ampliações ficam para o próximo ciclo.', 'info');
    return;
  }
  ctx.status(
    `Construção enviada em ${sent} aldeia(s)${byBuilding.size > 0 ? ` (${[...byBuilding].map(([b, n]) => `${n}× ${b}`).join(', ')})` : ''}.` +
      (refused.length > 0 ? ` O jogo recusou ${refused.length} (sem tentar de novo por 30 min): ${refused[0] ?? ''}${refused.length > 1 ? ' …' : ''}` : '') +
      (leftover ? ' Ainda há aldeias para ampliar — continuo em 1 min.' : '') +
      (resolved.templateName !== undefined ? ` Template "${resolved.templateName}".` : '') +
      note,
    refused.length > 0 && sent === 0 ? 'warn' : 'ok',
  );
}

/** Só na tela: a aldeia aberta, 1 ampliação por ciclo (e a recompensa de quest). */
async function runScreen(ctx: TshCycleContext, settings: BuilderSettings, legacy: boolean): Promise<void> {
  if (new URLSearchParams(window.location.search).get('screen') !== 'main') {
    ctx.status(
      legacy
        ? 'Novo na 3.9: o Construtor pode rodar em TODAS as aldeias sem abrir a tela — escolha "Segundo plano" em Configurar. Por enquanto ele segue só no Edifício principal, como antes.'
        : 'Modo "Só na tela": abra o Edifício principal para o Construtor agir.',
      'info',
    );
    return;
  }
  if (settings.collectQuests) {
    const reward = findQuestRewardButton(document);
    if (reward !== null) {
      if (!(await awaitRoutineMutation('construcao'))) {
        ctx.status('Pausa de humanização ativa — a recompensa de quest foi pulada neste ciclo.', 'info');
        return;
      }
      reward.click();
      ctx.status('Cliquei em "Receber recompensa" no Edifício principal (a próxima ampliação fica para o ciclo seguinte).', 'ok');
      return;
    }
  }
  const resolved = await villageTargets(ctx, settings);
  if (resolved === null) return;
  const gv = pageWindow().game_data?.village as { x?: unknown; y?: unknown } | undefined;
  const here = { id: ctx.villageId, ...(typeof gv?.x === 'number' && typeof gv.y === 'number' ? { x: gv.x, y: gv.y } : {}) };
  const mine = resolved.forVillage(here);
  if (mine === null) {
    ctx.status('Esta aldeia não tem modelo de construção (nenhuma regra de grupo/coordenada e sem modelo padrão).', 'info');
    return;
  }
  const info = await buildingInfo();
  // Tela FRESCA: o pedido pela API não atualiza a página aberta (níveis/fila antigos).
  const screen = parseMainScreen(await pacedGet(`/game.php?village=${ctx.villageId}&screen=main`, { fresh: true }), ctx.villageId);
  if (info === null || screen === null) {
    ctx.status('Não reconheci o Edifício principal (ou os custos do mundo) — nada foi construído.', 'warn');
    return;
  }
  const d = planVillageBuild(screen.village, screen.prod, mine.targets, info, planOptions(settings, resolved.farmThreshold));
  if (d.kind === 'esperar') {
    const why = { 'fila-cheia': settings.queueMode === 'horas' ? `A fila do jogo já cobre ${String(settings.queueHours).replace('.', ',')} h de construção (ou tem ${settings.maxQueue} itens).` : `A fila do jogo já tem ${settings.maxQueue} item(ns).`,
      bloqueado: 'O próximo passo pede outro edifício antes (ou falta população) — veja os avisos ⚠ no modelo.', concluido: `${mine.model !== undefined ? `Modelo "${mine.model}"` : 'Fila de construção'} concluído nesta aldeia.`, recursos: 'Esperando recursos para o próximo edifício da sua fila.', maximo: 'Os edifícios da fila já estão no nível máximo.' }[d.reason];
    ctx.status(why, 'info');
    return;
  }
  const key = refusalKey(ctx.villageId, d.building, d.level);
  const refusedAt = ctx.storage.get<Record<string, number>>('refused', {});
  if ((refusedAt[key] ?? 0) > Date.now()) {
    ctx.status(`O jogo recusou ${BUILDING_LABEL[d.building]} → nível ${d.level} há pouco — tento de novo em até 30 min.`, 'info');
    return;
  }
  try {
    await upgradeBuildingApi(ctx.villageId, d.building);
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === 'GAME_REFUSED') {
      const now = Date.now();
      const kept = Object.fromEntries(Object.entries(refusedAt).filter(([, until]) => until > now));
      ctx.storage.set('refused', { ...kept, [key]: now + 30 * 60_000 });
      ctx.status(`O jogo recusou ${BUILDING_LABEL[d.building]} → nível ${d.level}: ${e.message ?? ''} (sem tentar de novo por 30 min).`, 'warn');
      return;
    }
    throw error;
  }
  ctx.status(
    `Ampliação enviada: ${BUILDING_LABEL[d.building]} → nível ${d.level}${d.reason === 'fazenda' ? ' (fazenda primeiro: pouca população livre)' : d.reason === 'armazem' ? ' (armazém primeiro: pequeno demais para o próximo)' : ''}.`,
    'ok',
  );
}

async function runCycle(ctx: TshCycleContext): Promise<void> {
  const parsed = builderSettings.safeParse(ctx.storage.get('settings', DEFAULT_SETTINGS));
  if (!parsed.success) {
    ctx.status('Configurações do Construtor inválidas — nada foi feito. Abra Configurar, confira e salve de novo.', 'warn');
    return;
  }
  const saved = savedBuilderMode(ctx.world);
  const mode = saved.mode ?? parsed.data.execMode;
  if (mode === 'fundo') await runBackground(ctx, parsed.data);
  else await runScreen(ctx, parsed.data, saved.legacy);
}

export const megaBuilderAutomation: TshAutomation = {
  id: 'mega-builder',
  label: 'Mega Construtor',
  desc: 'Constrói na ordem que você escolher em todas as aldeias (ou só na aldeia aberta), subindo fazenda e armazém antes quando falta espaço.',
  category: 'producao',
  screen: null,
  mutating: true,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  settingsPanel: (settings, world) =>
    buildBuilderPanel(settings, { parseText: parsePrioritiesText, decodeGc: decodeBuilderImport }, legacyWithoutMode(world)),
  runCycle,
};

registerTsh(megaBuilderAutomation);
