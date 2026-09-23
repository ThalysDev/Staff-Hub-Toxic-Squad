// Template C do Auto Farm (Onda 4) — engine PURA da composição PRÓPRIA do Hub.
//
// O jogo mantém os templates A/B fixos no Assistente de Saque; o "C" é a
// composição do jogador (unidades próprias em ordem de prioridade), montada
// AQUI a partir das tropas disponíveis em casa. A regra do lote é fail-closed
// e determinística:
//   1. o saque exigido do alvo é max(minHaulPerCommand, pontos × fator);
//   2. as unidades são consumidas na ORDEM da prioridade, cada uma até o
//      necessário, limitada pelo estoque disponível;
//   3. sem unidade utilizável ou sem estoque suficiente, o alvo é pulado com
//      motivo em pt-BR — o motor nunca inventa tropa nem reduz o mínimo.

import { z } from 'zod';

/** Configuração do Template C (persistida como objeto aninhado do settings). */
export interface FarmTemplateC {
  readonly id: string;
  readonly name: string;
  /** Ordem de consumo: ex. ['light', 'marcher', 'heavy'] (a 1ª é a preferida). */
  readonly priority: readonly string[];
  /** Piso de saque estimado por comando (recursos). */
  readonly minHaulPerCommand: number;
  /** Horas até o alvo precisar de nova exploração (frescor da lista do mapper). */
  readonly reScoutHours: number;
  /** Limiar (%) de armazém cheio do alvo (política lida pelo relatório do ciclo). */
  readonly warehouseFullPct: number;
}

export const FARM_TEMPLATE_C_DEFAULTS: FarmTemplateC = Object.freeze({
  id: 'C',
  name: 'Template C (composição própria)',
  priority: Object.freeze(['light', 'marcher', 'heavy']),
  minHaulPerCommand: 200,
  reScoutHours: 6,
  warehouseFullPct: 90,
});

/**
 * Recursos estimados por ponto da aldeia-alvo (heurística do mínimo de saque):
 * o piso do comando vira `max(minHaulPerCommand, pontos × este fator)`.
 */
export const FARM_TEMPLATE_C_POINTS_HAUL_FACTOR = 1;

/**
 * Mesmo vocabulário de unidades do Assistente de Saque (contrato do Auto Farm).
 * Maiúsculas são aceitas e normalizadas para minúsculas; item sem forma de
 * unidade é descartado na normalização (unidade desconhecida fica inofensiva —
 * capacidade 0 no mapa do jogo — em vez de derrubar o motor inteiro).
 */
const UNIT_KEY = /^[a-z][a-z0-9_]{0,23}$/;

/**
 * Contrato de persistência do Template C: campo com tipo errado cai no default
 * do campo (fail-closed) — o motor nunca lê um valor que não saiba interpretar.
 */
export const farmTemplateCSchema = z.object({
  id: z.string().trim().min(1).max(24).catch(FARM_TEMPLATE_C_DEFAULTS.id),
  name: z.string().trim().min(1).max(80).catch(FARM_TEMPLATE_C_DEFAULTS.name),
  priority: z
    .array(z.string().trim().max(24))
    .min(1)
    .max(12)
    .catch(() => [...FARM_TEMPLATE_C_DEFAULTS.priority]),
  minHaulPerCommand: z.number().int().min(0).max(1_000_000_000).catch(FARM_TEMPLATE_C_DEFAULTS.minHaulPerCommand),
  reScoutHours: z.number().int().min(0).max(720).catch(FARM_TEMPLATE_C_DEFAULTS.reScoutHours),
  warehouseFullPct: z.number().int().min(1).max(100).catch(FARM_TEMPLATE_C_DEFAULTS.warehouseFullPct),
});

/**
 * Normaliza o Template C vindo da persistência: merge sobre os defaults, cada
 * campo validado isoladamente e prioridade sem repetições nem itens vazios.
 * Entrada que nem é objeto devolve os defaults puros. O resultado é congelado.
 */
export function normalizeFarmTemplateC(raw: unknown): FarmTemplateC {
  const parsed = farmTemplateCSchema.safeParse(raw);
  const template = parsed.success ? parsed.data : FARM_TEMPLATE_C_DEFAULTS;
  const priority: string[] = [];
  for (const unit of template.priority) {
    const normalized = unit.trim().toLowerCase();
    if (!UNIT_KEY.test(normalized) || priority.includes(normalized)) continue;
    priority.push(normalized);
  }
  return Object.freeze({
    id: template.id,
    name: template.name,
    priority: Object.freeze(priority.length > 0 ? priority : [...FARM_TEMPLATE_C_DEFAULTS.priority]),
    minHaulPerCommand: template.minHaulPerCommand,
    reScoutHours: template.reScoutHours,
    warehouseFullPct: template.warehouseFullPct,
  });
}

export interface FarmCLot {
  readonly units: Readonly<Record<string, number>>;
  readonly estimatedHaul: number;
}

export type FarmCLotDecision = FarmCLot | Readonly<{ skip: string }>;

/** Inteiro ≥0 de uma quantidade do jogo; ausente/inválido/não finito = 0. */
function positiveInt(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Monta o lote do Template C para um alvo: consome as tropas na ordem da
 * prioridade até o mínimo de saque estimado (pontos do alvo × fator, com o
 * piso de `minHaulPerCommand`). O lote leva SEMPRE ao menos uma unidade (um
 * comando sem tropa não existe) e nunca ultrapassa o estoque informado.
 * `unitCapacity` é a capacidade de carga por unidade (AUTO_FARM_UNIT_HAUL).
 */
export function buildFarmCLot(
  available: Readonly<Record<string, number>>,
  target: Readonly<{ points: number }>,
  template: FarmTemplateC,
  unitCapacity: Readonly<Record<string, number>>,
): FarmCLotDecision {
  const policy = normalizeFarmTemplateC(template);
  const points = Number.isFinite(target.points) ? Math.max(0, Math.floor(target.points)) : 0;
  const requiredHaul = Math.max(policy.minHaulPerCommand, Math.ceil(points * FARM_TEMPLATE_C_POINTS_HAUL_FACTOR));
  const usable = policy.priority.filter((unit) => positiveInt(unitCapacity[unit]) > 0);
  if (usable.length === 0) {
    return Object.freeze({ skip: 'O Template C não tem nenhuma unidade com capacidade de saque na prioridade configurada.' });
  }
  const availableHaul = usable.reduce((total, unit) => total + positiveInt(available[unit]) * positiveInt(unitCapacity[unit]), 0);
  if (availableHaul < requiredHaul) {
    return Object.freeze({
      skip: `Tropas insuficientes para o mínimo de saque: ${availableHaul} de carga disponível contra ${requiredHaul} exigido (${points} ponto(s) do alvo).`,
    });
  }
  const units: Record<string, number> = {};
  let remaining = requiredHaul;
  let estimatedHaul = 0;
  for (const unit of usable) {
    if (remaining <= 0 && estimatedHaul > 0) break;
    const capacity = positiveInt(unitCapacity[unit]);
    const stock = positiveInt(available[unit]);
    if (stock === 0) continue;
    const take = Math.min(stock, Math.max(1, Math.ceil(remaining / capacity)));
    units[unit] = take;
    const haul = take * capacity;
    estimatedHaul += haul;
    remaining -= haul;
  }
  if (estimatedHaul <= 0) {
    return Object.freeze({ skip: 'Nenhuma tropa da prioridade do Template C está disponível em casa para este alvo.' });
  }
  return Object.freeze({ units: Object.freeze(units), estimatedHaul });
}

/** Resumo do Template C para status/relatório (texto curto, sem inventar nada). */
export function farmTemplateCSummary(template: FarmTemplateC): string {
  const policy = normalizeFarmTemplateC(template);
  return `${policy.name}: ${policy.priority.join(' → ')}; mínimo ${policy.minHaulPerCommand} de saque; reexploração ${policy.reScoutHours}h; armazém cheio ${policy.warehouseFullPct}%`;
}
