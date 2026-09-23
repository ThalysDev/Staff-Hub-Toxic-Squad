// Mercado Premium — porta do plugin premium-exchange da extensão Toxic Squad
// Hub (toxic-squad-hub-ext/.../modules/features/premium-exchange/plugin.ts):
// - regras buyBelow/sellAbove por recurso (preço por mil recursos), saldos e
//   lotes com os MESMOS defaults do schema zod da origem;
// - cotações lidas do corpo da página de Troca Premium (porta do readExchange
//   do page-adapter: "X ⇄ 1" por recurso + linha "Estoque a b c") e pontos
//   premium de #premium_points;
// - desvio documentado: a origem lia rate/stock do snapshot de página; aqui a
//   leitura é direta do documento vivo (mesmos regex/semântica);
// - disponibilidade validada ANTES de mutar: campo buy_/sell_<recurso>
//   disabled = estoque cheio → status warn e NENHUMA mutação (o transporte
//   reconfirma o disabled — dupla verificação);
// - status didático cita recurso, quantia, preço e a regra decidida:
//   "comprar 500 madeira a 35,71 pts/mil (regra: comprar abaixo de 40,00)" /
//   "executada: comprou 500 madeira a 35,71 pts/mil";
// - F2: no máximo 1 mutação por ciclo — premiumExchange(step) (1 recurso +
//   1 direção, como a origem).

import { registerTsh } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import { premiumExchange, type PremiumExchangeStep } from '../tsh-transport';
import { parsePtBrInt } from '../../vanta/vanta-utils';

export type ExchangeResource = 'wood' | 'stone' | 'iron';
const RESOURCES: readonly ExchangeResource[] = ['wood', 'stone', 'iron'];

const RESOURCE_LABEL: Record<ExchangeResource, string> = { wood: 'madeira', stone: 'argila', iron: 'ferro' };

export interface ExchangeQuote {
  rate: number;
  stock: number;
}

// Type alias (não interface) para continuar atribuível a Record<string, unknown>
// em settingsDefaults.
export type ExchangeSettings = {
  minPremiumPoints: number;
  maxPremiumPointsPerCycle: number;
  batchSize: number;
  buyBelow: Partial<Record<ExchangeResource, number>>;
  sellAbove: Partial<Record<ExchangeResource, number>>;
};

export const DEFAULT_SETTINGS: ExchangeSettings = {
  minPremiumPoints: 0,
  maxPremiumPointsPerCycle: 0,
  batchSize: 1000,
  buyBelow: {},
  sellAbove: {},
};

const SETTINGS_FORM: SettingsField[] = [
  {
    key: 'minPremiumPoints',
    label: 'Pontos Premium mínimos',
    type: 'number',
    min: 0,
    max: 1_000_000,
    step: 10,
    help: 'O módulo só opera se o saldo de Pontos Premium for maior ou igual a este valor (margem de segurança).',
  },
  {
    key: 'maxPremiumPointsPerCycle',
    label: 'Máximo de pontos por ciclo',
    type: 'number',
    min: 0,
    max: 1_000_000,
    step: 10,
    help: 'Teto de pontos gastos em compras num mesmo ciclo; 0 = sem teto além do saldo disponível.',
  },
  {
    key: 'batchSize',
    label: 'Lote por troca (recursos)',
    type: 'number',
    min: 1,
    max: 1_000_000,
    step: 100,
    help: 'Quantidade máxima de recursos comprada ou vendida em uma única troca.',
  },
  {
    key: 'buyBelow',
    label: 'Comprar quando o preço por mil estiver abaixo de',
    type: 'record',
    help: 'Preço máximo (em Pontos Premium por mil recursos) para COMPRAR cada recurso. 0 = não compra aquele recurso.',
    recordKeys: [
      { key: 'wood', label: 'Madeira', min: 0, step: 0.5 },
      { key: 'stone', label: 'Argila', min: 0, step: 0.5 },
      { key: 'iron', label: 'Ferro', min: 0, step: 0.5 },
    ],
  },
  {
    key: 'sellAbove',
    label: 'Vender quando o preço por mil estiver acima de',
    type: 'record',
    help: 'Preço mínimo (em Pontos Premium por mil recursos) para VENDER cada recurso. 0 = não vende aquele recurso.',
    recordKeys: [
      { key: 'wood', label: 'Madeira', min: 0, step: 0.5 },
      { key: 'stone', label: 'Argila', min: 0, step: 0.5 },
      { key: 'iron', label: 'Ferro', min: 0, step: 0.5 },
    ],
  },
];

/**
 * Taxa decimal do jogo no formato pt-BR (P2 revisão Onda 11-19): o jogo pode
 * exibir "28.000" (milhar) OU "35,71" (decimal com vírgula). Regra pt-BR:
 * pontos são milhar, vírgula é decimal. "35.71" nunca ocorre no jogo BR.
 */
export function parseExchangeRate(raw: string): number {
  const normalized = raw.trim().replace(/\./g, '').replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Cotações da página (porta do readExchange do page-adapter): taxas na ordem
 * madeira/argila/ferro do "valor ⇄ 1" e estoques da linha "Estoque a b c".
 */
export function parseExchangeQuotes(
  body: string,
  premiumText: string | null | undefined,
): { quotes: Partial<Record<ExchangeResource, ExchangeQuote>>; premiumPoints: number } {
  const quotes: Partial<Record<ExchangeResource, ExchangeQuote>> = {};
  if (body.includes('Troca Premium') && body.includes('⇄')) {
    const rates = Array.from(body.matchAll(/([\d.,]+)\s*⇄\s*1/g)).map((match) => parseExchangeRate(match[1] ?? ''));
    const stockMatch = body.match(/Estoque\s*([\d.]+)\s*([\d.]+)\s*([\d.]+)/);
    const stocks =
      stockMatch === null ? [] : [stockMatch[1], stockMatch[2], stockMatch[3]].map((value) => parsePtBrInt(value));
    RESOURCES.forEach((resource, index) => {
      const rate = rates[index];
      if (rate !== undefined && rate > 0) quotes[resource] = { rate, stock: stocks[index] ?? 0 };
    });
  }
  return { quotes, premiumPoints: parsePtBrInt(premiumText) };
}

export interface ExchangeDecision {
  direction: 'buy' | 'sell';
  resource: ExchangeResource;
  amount: number;
  pricePerThousand: number;
}

/**
 * plan() da origem (portado fiel): compra quando o preço por mil está <=
 * buyBelow (limitado por lote, estoque e pontos premium); vende quando >=
 * sellAbove (limitado por lote e saldo do recurso). Primeira regra atingida
 * vence — 1 recurso/direção por ciclo.
 */
export function planExchangeStep(
  quotes: Partial<Record<ExchangeResource, ExchangeQuote>>,
  premiumPoints: number,
  resources: Record<ExchangeResource, number>,
  settings: ExchangeSettings,
): { step: ExchangeDecision | null; reason: string } {
  if (premiumPoints < settings.minPremiumPoints)
    return { step: null, reason: 'Saldo de Pontos Premium abaixo do mínimo configurado.' };
  for (const [rawResource, threshold] of Object.entries(settings.buyBelow)) {
    const resource = rawResource as ExchangeResource;
    if (threshold <= 0) continue; // 0 = regra desativada (o formulário grava zeros explícitos)
    const quote = quotes[resource];
    if (quote === undefined || quote.rate <= 0) continue;
    const pricePerThousand = 1000 / quote.rate;
    if (pricePerThousand > 0 && pricePerThousand <= threshold) {
      const allowedPP =
        settings.maxPremiumPointsPerCycle > 0
          ? Math.min(settings.maxPremiumPointsPerCycle, premiumPoints - settings.minPremiumPoints)
          : premiumPoints - settings.minPremiumPoints;
      const maxByPoints = Math.floor(allowedPP * quote.rate);
      const amount = Math.max(
        0,
        Math.min(settings.batchSize, quote.stock > 0 ? quote.stock : settings.batchSize, maxByPoints),
      );
      if (amount < 1) continue;
      return { step: { direction: 'buy', resource, amount, pricePerThousand }, reason: '' };
    }
  }
  for (const [rawResource, threshold] of Object.entries(settings.sellAbove)) {
    const resource = rawResource as ExchangeResource;
    if (threshold <= 0) continue; // 0 = regra desativada (senão venderia a qualquer preço)
    const quote = quotes[resource];
    if (quote === undefined || quote.rate <= 0) continue;
    const pricePerThousand = 1000 / quote.rate;
    if (pricePerThousand >= threshold) {
      const amount = Math.max(0, Math.min(settings.batchSize, resources[resource]));
      if (amount < 1) continue;
      return { step: { direction: 'sell', resource, amount, pricePerThousand }, reason: '' };
    }
  }
  return { step: null, reason: 'Nenhuma regra de mercado foi atingida com as cotações atuais.' };
}

/** Preço/limiar em pts/mil com vírgula decimal ("35.71" → "35,71"). */
export function formatarPtsMil(valor: number): string {
  return valor.toFixed(2).replace('.', ',');
}

/**
 * Status didático da decisão: cita recurso, quantia, preço por mil e a REGRA
 * que decidiu. Prévia no infinitivo ("comprar/vender"); executada no passado
 * ("comprou/vendeu a ... pts/mil").
 */
export function exchangeStatusLabel(
  step: ExchangeDecision,
  threshold: number,
  fase: 'previa' | 'executado',
): string {
  const infinitivo = step.direction === 'buy' ? 'comprar' : 'vender';
  const passado = step.direction === 'buy' ? 'comprou' : 'vendeu';
  const regra = step.direction === 'buy' ? 'comprar abaixo de' : 'vender acima de';
  const corpo = `${step.amount} ${RESOURCE_LABEL[step.resource]} a ${formatarPtsMil(step.pricePerThousand)} pts/mil`;
  if (fase === 'previa') return `Prévia: ${infinitivo} ${corpo} (regra: ${regra} ${formatarPtsMil(threshold)}).`;
  return `Troca Premium executada: ${passado} ${corpo}.`;
}

/** Limiar da regra que produziu a decisão (buyBelow/sellAbove do recurso). */
export function ruleThresholdFor(step: ExchangeDecision, settings: ExchangeSettings): number {
  const rules = step.direction === 'buy' ? settings.buyBelow : settings.sellAbove;
  return rules[step.resource] ?? 0;
}

function readPageResource(resource: ExchangeResource): number {
  const element = document.querySelector<HTMLElement>(`#${resource}, [data-resource="${resource}"], .resource-${resource}`);
  if (element === null) return 0;
  const text =
    element instanceof HTMLInputElement || element instanceof HTMLSelectElement
      ? element.value
      : (element.textContent ?? '');
  return parsePtBrInt(text);
}

registerTsh({
  id: 'premium-exchange',
  label: 'Mercado Premium',
  desc: 'Compra/vende recursos na Troca Premium pelas regras de preço configuradas (máx. 1 troca por ciclo).',
  category: 'economia',
  screen: 'market',
  mutating: true,
  cooldownMs: 5 * 60_000,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  async runCycle(ctx) {
    // O runtime casa só screen=market; as cotações e o formulário existem
    // apenas na sub-aba da Troca Premium (runtime 'premium-exchange' da origem).
    if (new URLSearchParams(window.location.search).get('mode') !== 'exchange') return;
    const settings = ctx.storage.get('settings', DEFAULT_SETTINGS);
    const premiumText = document.querySelector<HTMLElement>('#premium_points')?.textContent ?? null;
    const { quotes, premiumPoints } = parseExchangeQuotes(document.body?.textContent ?? '', premiumText);
    const resources: Record<ExchangeResource, number> = {
      wood: readPageResource('wood'),
      stone: readPageResource('stone'),
      iron: readPageResource('iron'),
    };
    const { step, reason } = planExchangeStep(quotes, premiumPoints, resources, settings);
    if (step === null) {
      ctx.status(reason, 'info');
      return;
    }
    // Disponibilidade ANTES de mutar (origem: EXCHANGE_UNAVAILABLE do
    // transporte): campo disabled = estoque na capacidade → warn, sem mutação.
    const input = document.querySelector<HTMLInputElement>(`input[name="${step.direction}_${step.resource}"]`);
    if (input === null) {
      ctx.status('O formulário da Troca Premium não foi encontrado nesta página.', 'warn');
      return;
    }
    if (input.disabled) {
      ctx.status('A Troca Premium está com o estoque cheio para este recurso e direção.', 'warn');
      return;
    }
    ctx.status(exchangeStatusLabel(step, ruleThresholdFor(step, settings), 'previa'), 'info');
    const payload: PremiumExchangeStep =
      step.direction === 'buy' ? { buy: { [step.resource]: step.amount } } : { sell: { [step.resource]: step.amount } };
    await premiumExchange(payload);
    ctx.status(exchangeStatusLabel(step, ruleThresholdFor(step, settings), 'executado'), 'ok');
  },
});
