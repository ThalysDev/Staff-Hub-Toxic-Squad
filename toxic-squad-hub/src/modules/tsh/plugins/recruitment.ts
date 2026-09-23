// Plugin TSH 'recruitment' — porta do plugin da extensão
// (toxic-squad-hub-ext/.../modules/features/recruitment/plugin.ts) para o motor
// de ciclos do userscript:
// - settings por unidade (metas "goals", defaults do zod original) lidas do
//   storage do módulo (chave "settings");
// - leitura da tela screen=train: fila ativa (.trainqueue_wrap .lit-item),
//   unidades recrutáveis (inputs do formulário canônico — só unidades
//   PESQUISADAS aparecem, mesma regra do transporte) e contagem atual
//   (seletores do page-adapter da extensão);
// - candidatura por RAZÃO (current/goal, a mais carente primeiro) — igual à
//   extensão;
// - NOVO (Onda 15a): modo "manter população" — settings.maxPopulation
//   (0 = ilimitado): com teto definido, a barra de população da tela train
//   ("12.345/24.000") é lida e, no teto (ou ilegível — fail-closed), o ciclo
//   não recruta e reporta status claro;
// - F2: UMA mutação por ciclo — 1 submit recruitUnits com o lote cabível
//   (déficit da meta limitado pelos recursos da barra e custos lidos da
//   própria linha da unidade; custo ilegível = sem capa, comportamento da
//   extensão, que enviava o déficit cheio).

import { z } from 'zod';
import { registerTsh, type TshAutomation, type TshCycleContext } from '../tsh-runtime';
import { recruitUnits } from '../tsh-transport';
import type { ResourceType, UnitType } from '../../../ext/modules/shared/module-types';

const UNIT_TYPES: readonly UnitType[] = [
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
const RESOURCES: readonly ResourceType[] = ['wood', 'stone', 'iron'];

const recruitmentSettings = z.object({
  horizonMinutes: z.number().int().min(1).default(60),
  reservePopulation: z.number().int().min(0).default(0),
  goals: z.record(z.string(), z.number().int().nonnegative()).default({}),
  maxPopulation: z.number().int().min(0).default(0),
});

type RecruitmentSettings = z.infer<typeof recruitmentSettings>;

/** Custo de UMA unidade lido da linha do formulário (ausente = ilegível). */
export interface UnitCost {
  wood?: number;
  stone?: number;
  iron?: number;
}

/**
 * Lote cabível (PURa, testável): déficit pedido limitado pelos recursos
 * disponíveis. Custo ilegível em QUALQUER recurso → sem capa (a extensão
 * enviava o déficit cheio e deixava o jogo recusar).
 */
export function capRecruitmentBatch(
  amount: number,
  resources: Record<ResourceType, number>,
  cost: UnitCost,
): number {
  const caps: number[] = [];
  for (const resource of RESOURCES) {
    const unitCost = cost[resource];
    if (unitCost === undefined || unitCost <= 0) return amount;
    caps.push(Math.floor(resources[resource] / unitCost));
  }
  return Math.max(0, Math.min(amount, Math.min(...caps)));
}

/** Inteiro de jogo pt-BR ("1.234", "1.234,5") — porta do parseGameInteger. */
function parseGameInteger(value: string | null | undefined): number {
  if (!value) return 0;
  const normalized = value.trim().replace(/\s/g, '');
  const brazilian = normalized.replace(/\./g, '').replace(',', '.');
  const parsed = Number(brazilian.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

/** População da aldeia lida da barra do jogo ("12.345/24.000"). */
export interface PopulationBar {
  current: number;
  max: number;
}

/** Parse robusto de "12.345/24.000" (espaços e separadores pt-BR tolerados). */
export function parsePopulationBar(value: string | null | undefined): PopulationBar | null {
  if (!value) return null;
  const match = value.match(/([\d.,\s]+)\s*\/\s*([\d.,\s]+)/);
  if (match === null) return null;
  const current = parseGameInteger(match[1]);
  const max = parseGameInteger(match[2]);
  if (current <= 0 || max <= 0) return null;
  return { current, max };
}

/**
 * Decisão do modo "manter população" (PURa): 0 = ilimitado (nunca bloqueia);
 * com teto definido, bloqueia quando a população da aldeia está no teto —
 * ou quando a barra é ilegível (fail-closed: sem leitura não há como honrar
 * o teto, então não recruta).
 */
export function recruitmentBlockedByPopulation(maxPopulation: number, bar: PopulationBar | null): boolean {
  if (maxPopulation <= 0) return false;
  if (bar === null) return true;
  return bar.current >= maxPopulation;
}

/** Barra de recursos da página (#wood/#stone/#iron — seletores canônicos). */
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

/**
 * Barra de população da tela train: recipiente canônico #pop ("12.345/24.000")
 * com fallback pelo ícone da fazenda (img do jogo) — texto "X/Y" do recipiente.
 * null = ilegível (o modo "manter população" falha fechado).
 */
function readPopulationBar(doc: Document): PopulationBar | null {
  const direct = doc.querySelector('#pop, [data-population], .population');
  const text =
    direct instanceof HTMLInputElement || direct instanceof HTMLSelectElement ? direct.value : direct?.textContent;
  const parsed = parsePopulationBar(text);
  if (parsed !== null) return parsed;
  for (const icon of Array.from(doc.querySelectorAll<HTMLImageElement>('img[src*="farm"]'))) {
    const container = icon.closest('td, div, span, p');
    const parsedContainer = parsePopulationBar(container?.textContent ?? '');
    if (parsedContainer !== null) return parsedContainer;
  }
  return null;
}

/** Contagem atual da unidade na aldeia (porta do readUnit do page-adapter). */
function readUnitCount(doc: Document, unit: UnitType): number {
  const element = doc.querySelector(`[data-unit-count="${unit}"], #unit_count_${unit}, .unit-count-${unit}`);
  return parseGameInteger(element?.textContent);
}

/** Fila de recrutamento ativa (porta do readTrainQueue: wrap + lit-item). */
function hasActiveTrainQueue(doc: Document): boolean {
  const wrap = doc.querySelector('.trainqueue_wrap');
  return wrap !== null && wrap.querySelector('.lit-item') !== null;
}

/** Unidades recrutáveis + custo por unidade lidos do formulário da tela train. */
function readTrainScreen(
  doc: Document,
): { trainable: Set<UnitType>; costs: Partial<Record<UnitType, UnitCost>> } {
  const trainable = new Set<UnitType>();
  const costs: Partial<Record<UnitType, UnitCost>> = {};
  const forms = doc.querySelectorAll<HTMLFormElement>(
    '#train_form, form[action*="screen=train"][action*="action=train"]',
  );
  for (const form of Array.from(forms)) {
    for (const input of Array.from(form.querySelectorAll<HTMLInputElement>('input[name]'))) {
      const unit = input.name as UnitType;
      if (!UNIT_TYPES.includes(unit)) continue;
      trainable.add(unit);
      costs[unit] = readUnitCost(input);
    }
  }
  return { trainable, costs };
}

/**
 * Custo por recurso da linha da unidade: ícone do recurso (src do jogo) →
 * número do recipiente mais próximo (span/td "ícone N"). Ícone ausente ou
 * número zero = custo ilegível (sem capa para aquele recurso).
 */
function readUnitCost(input: HTMLInputElement): UnitCost {
  const row = input.closest('tr');
  const cost: UnitCost = {};
  if (row === null) return cost;
  for (const resource of RESOURCES) {
    const icon = row.querySelector(`img[src*="${resource}"]`);
    if (icon === null) continue;
    const text = icon.closest('span, td')?.textContent ?? '';
    const amount = parseGameInteger((text.match(/[\d.,]+/) ?? ['0'])[0]);
    if (amount > 0) cost[resource] = amount;
  }
  return cost;
}

async function runCycle(ctx: TshCycleContext): Promise<void> {
  const parsed = recruitmentSettings.safeParse(ctx.storage.get<unknown>('settings', {}));
  if (!parsed.success) {
    ctx.status('Configurações de recrutamento inválidas — nada foi feito. Revise as metas por unidade.', 'warn');
    return;
  }
  const settings: RecruitmentSettings = parsed.data;
  // P3 (revisão Onda 8): o formulário grava as 12 unidades (zeros inclusos) —
  // meta 0 = "não recutar", então conta só metas positivas.
  const goals = Object.entries(settings.goals).filter(
    ([unit, amount]) => UNIT_TYPES.includes(unit as UnitType) && amount > 0,
  );
  if (goals.length === 0) {
    ctx.status('Nenhuma meta de recrutamento configurada — abra "Configurar" e defina as quantidades-alvo.', 'info');
    return;
  }
  if (hasActiveTrainQueue(document)) {
    ctx.status('Já existe um recrutamento em andamento nesta aldeia.', 'info');
    return;
  }
  // Modo "manter população" (Onda 15a): 0 = ilimitado. Com teto definido,
  // bloqueia no teto (ou com a barra ilegível — fail-closed).
  if (settings.maxPopulation > 0) {
    const bar = readPopulationBar(document);
    if (bar === null) {
      ctx.status(
        `Modo "manter população" (teto ${settings.maxPopulation}): a barra de população da aldeia não pôde ser lida — nada foi recrutado por segurança.`,
        'warn',
      );
      return;
    }
    if (recruitmentBlockedByPopulation(settings.maxPopulation, bar)) {
      ctx.status(
        `Modo "manter população": população da aldeia em ${bar.current}/${bar.max} está no teto configurado (${settings.maxPopulation}) — nada foi recrutado neste ciclo.`,
        'info',
      );
      return;
    }
  }
  const screen = readTrainScreen(document);
  const candidates = goals
    .map(([unit, goal]) => {
      const typed = unit as UnitType;
      return { unit: typed, goal, current: readUnitCount(document, typed), trainable: screen.trainable.has(typed) };
    })
    .filter((candidate) => candidate.current < candidate.goal && candidate.trainable)
    .sort((left, right) => left.current / left.goal - right.current / right.goal);
  if (candidates.length === 0) {
    const unresearched = goals.filter(([unit]) => !screen.trainable.has(unit as UnitType));
    ctx.status(
      unresearched.length > 0
        ? 'Há metas para unidades ainda não pesquisadas no Ferreiro desta aldeia.'
        : 'Todas as metas de recrutamento estão atendidas.',
      'info',
    );
    return;
  }
  const candidate = candidates[0];
  if (candidate === undefined) return;
  const deficit = candidate.goal - candidate.current;
  const amount = capRecruitmentBatch(deficit, readResources(document), screen.costs[candidate.unit] ?? {});
  if (amount <= 0) {
    ctx.status(
      `Recursos insuficientes para recrutar ${candidate.unit} agora (meta ${candidate.goal}, tem ${candidate.current}).`,
      'info',
    );
    return;
  }
  // F2: UMA mutação por ciclo — 1 submit com o lote cabível da meta mais carente.
  await recruitUnits({ [candidate.unit]: amount });
  ctx.status(
    `Recrutamento enviado: ${amount} ${candidate.unit} (meta ${candidate.goal}, tinha ${candidate.current}).`,
    'ok',
  );
}

export const recruitmentAutomation: TshAutomation = {
  id: 'recruitment',
  label: 'Recrutamento',
  desc: 'Metas por unidade na tela do Quartel/Estábulo/Oficina: recruta o lote cabível da unidade mais carente (1 submit por ciclo).',
  category: 'producao',
  screen: 'train',
  mutating: true,
  settingsDefaults: { goals: {}, maxPopulation: 0 },
  settingsForm: [
    {
      key: 'goals',
      label: 'Metas por unidade',
      type: 'record',
      help: 'Quantidade-alvo de cada unidade nesta aldeia. 0 = não recruta. O ciclo preenche a unidade mais distante da meta que couber nos recursos.',
      recordKeys: [
        { key: 'spear', label: 'Lança', min: 0, step: 10 },
        { key: 'sword', label: 'Espada', min: 0, step: 10 },
        { key: 'axe', label: 'Machado', min: 0, step: 10 },
        { key: 'archer', label: 'Arqueiro', min: 0, step: 10 },
        { key: 'spy', label: 'Explorador', min: 0, step: 5 },
        { key: 'light', label: 'Cav. Leve', min: 0, step: 10 },
        { key: 'marcher', label: 'Arq. Cavalo', min: 0, step: 10 },
        { key: 'heavy', label: 'Cav. Pesada', min: 0, step: 10 },
        { key: 'ram', label: 'Aríete', min: 0, step: 5 },
        { key: 'catapult', label: 'Catapulta', min: 0, step: 5 },
        { key: 'knight', label: 'Paladino', min: 0, step: 1 },
        { key: 'snob', label: 'Nobre', min: 0, step: 1 },
      ],
    },
    {
      key: 'maxPopulation',
      label: 'Manter população — teto',
      type: 'number',
      min: 0,
      step: 100,
      placeholder: '0',
      help: 'Modo "manter população": teto de população da aldeia (lido da barra "12.345/24.000" do jogo). Atingido o teto, o ciclo não recruta. 0 = ilimitado.',
    },
  ],
  runCycle,
};

registerTsh(recruitmentAutomation);
