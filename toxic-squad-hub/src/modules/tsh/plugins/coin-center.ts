// Cunhagem de moedas — porta do plugin coin-center da extensão Toxic Squad
// Hub (toxic-squad-hub-ext/.../modules/features/coin-center/plugin.ts):
// - reservas por recurso (manter X madeira/argila/ferro no armazém) e teto de
//   moedas por ciclo, com os MESMOS defaults do schema zod da origem (custo
//   br142: 28000/30000/25000; gate "recursos cobrem 1 moeda" do affordable());
// - contagem = min(teto por ciclo, máximo da própria página, floor((recurso −
//   reserva)/custo) por recurso). O plan() da origem calculava só pelas
//   reservas; aqui o máximo do jogo (#coin_mint_fill_max, porta do autocunhar
//   com parsePtBrInt) entra como teto extra fail-closed contra leitura
//   defasada do header;
// - leitura do máximo robusta: "(8.532)" → sem parênteses → parsePtBrInt
//   (correção P1-2 do autocunhar); input raro lê .value; página dizendo 0
//   moedas BLOQUEIA a cunhagem mesmo com reservas sobrando;
// - status didático: "cunhar X de Y possíveis; ficam reservas ..." — Y é o
//   máximo que as reservas permitem (sem os tetos de ciclo/página);
// - F2: no máximo 1 mutação por ciclo — mintCoins(count). O submit navega; o
//   ciclo seguinte reconcilia o saldo de moedas antes de qualquer nova
//   cunhagem.

import { registerTsh } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import { mintCoins } from '../tsh-transport';
import { parsePtBrInt } from '../../vanta/vanta-utils';

export type CoinResource = 'wood' | 'stone' | 'iron';
const RESOURCES: readonly CoinResource[] = ['wood', 'stone', 'iron'];

const RESOURCE_LABEL: Record<CoinResource, string> = { wood: 'madeira', stone: 'argila', iron: 'ferro' };

// Type alias (não interface) para continuar atribuível a Record<string, unknown>
// em settingsDefaults.
export type CoinSettings = {
  maxCoinsPerCycle: number;
  reserveWood: number;
  reserveStone: number;
  reserveIron: number;
  coinCost: Record<CoinResource, number>;
};

export const DEFAULT_SETTINGS: CoinSettings = {
  maxCoinsPerCycle: 1,
  reserveWood: 0,
  reserveStone: 0,
  reserveIron: 0,
  coinCost: { wood: 28_000, stone: 30_000, iron: 25_000 },
};

const SETTINGS_FORM: SettingsField[] = [
  {
    key: 'maxCoinsPerCycle',
    label: 'Máximo de moedas por ciclo',
    type: 'number',
    min: 1,
    max: 100,
    step: 1,
    help: 'Teto de moedas cunhadas em um único ciclo (o máximo da própria página também limita).',
  },
  {
    key: 'reserveWood',
    label: 'Reserva de madeira',
    type: 'number',
    min: 0,
    max: 10_000_000,
    step: 1_000,
    help: 'Madeira que fica guardada no armazém: só o excedente sobre esta reserva é usado para cunhar.',
  },
  {
    key: 'reserveStone',
    label: 'Reserva de argila',
    type: 'number',
    min: 0,
    max: 10_000_000,
    step: 1_000,
    help: 'Argila que fica guardada no armazém: só o excedente sobre esta reserva é usado para cunhar.',
  },
  {
    key: 'reserveIron',
    label: 'Reserva de ferro',
    type: 'number',
    min: 0,
    max: 10_000_000,
    step: 1_000,
    help: 'Ferro que fica guardado no armazém: só o excedente sobre esta reserva é usado para cunhar.',
  },
  {
    key: 'coinCost',
    label: 'Custo de cada moeda (por recurso)',
    type: 'record',
    help: 'Custo da Academia do mundo (padrão br142: 28000 madeira, 30000 argila, 25000 ferro) — só mude se o mundo cobrar diferente.',
    recordKeys: [
      { key: 'wood', label: 'Madeira', min: 0, step: 500 },
      { key: 'stone', label: 'Argila', min: 0, step: 500 },
      { key: 'iron', label: 'Ferro', min: 0, step: 500 },
    ],
  },
];

const RESERVE_KEY: Record<CoinResource, 'reserveWood' | 'reserveStone' | 'reserveIron'> = {
  wood: 'reserveWood',
  stone: 'reserveStone',
  iron: 'reserveIron',
};

/** Recurso do header da página (porta do readResource do page-adapter). */
export function readPageResource(resource: CoinResource, doc: Document): number {
  const element = doc.querySelector<HTMLElement>(`#${resource}, [data-resource="${resource}"], .resource-${resource}`);
  if (element === null) return 0;
  const text =
    element instanceof HTMLInputElement || element instanceof HTMLSelectElement
      ? element.value
      : (element.textContent ?? '');
  return parsePtBrInt(text);
}

/**
 * Máximo de moedas da página: "(8.532)" do link de preencher máximo (porta do
 * autocunhar, correção P1-2 — parsePtBrInt tira parênteses e ponto de milhar).
 * Robusto a variação de render: se o elemento for um input, o valor mora em
 * .value. Sem o link, cai no valor corrente do input de cunhagem (fail-closed).
 */
export function readMintMax(doc: Document): number {
  const fillMax = doc.querySelector('#coin_mint_fill_max');
  if (fillMax !== null) {
    const raw = fillMax instanceof HTMLInputElement ? fillMax.value : (fillMax.textContent ?? '');
    return parsePtBrInt(raw.replace(/[()]/g, ''));
  }
  return parsePtBrInt(doc.querySelector<HTMLInputElement>('#coin_mint_count')?.value ?? null);
}

export interface CoinMintPlan {
  /** Moedas DESTE ciclo (teto por ciclo e máximo da página aplicados). */
  count: number;
  /** Moedas possíveis pelas reservas, SEM os tetos (status didático "de Y"). */
  possible: number;
}

/**
 * plan() da origem + detalhe didático: possible = min por-recurso de
 * floor((recurso − reserva)/custo); count = min(teto por ciclo, possible) e,
 * quando informado, também do máximo da página (pageMax 0 = o jogo não deixa
 * cunhar agora → count 0 mesmo com reservas sobrando). Gate affordable() da
 * origem: recursos têm de cobrir o custo de 1 moeda.
 */
export function planCoinMintDetails(
  resources: Record<CoinResource, number>,
  settings: CoinSettings,
  pageMax?: number,
): CoinMintPlan {
  const cost = settings.coinCost;
  if (!RESOURCES.every((resource) => resources[resource] >= (cost[resource] ?? 0)))
    return { count: 0, possible: 0 };
  const possible = Math.min(
    ...RESOURCES.map((resource) => {
      const reserve = settings[RESERVE_KEY[resource]] ?? 0;
      const resourceCost = cost[resource] ?? 0;
      return resourceCost > 0 ? Math.floor(Math.max(0, resources[resource] - reserve) / resourceCost) : 0;
    }),
  );
  const count = Math.min(settings.maxCoinsPerCycle, possible);
  if (pageMax !== undefined) return { count: Math.min(count, Math.max(0, pageMax)), possible };
  return { count, possible };
}

/**
 * plan() da origem: min(teto por ciclo, por-recurso com reserva) + gate
 * affordable() (recursos cobrem o custo de 1 moeda). pageMax (máximo do jogo)
 * entra como teto extra quando informado.
 */
export function planCoinMint(
  resources: Record<CoinResource, number>,
  settings: CoinSettings,
  pageMax?: number,
): number {
  return planCoinMintDetails(resources, settings, pageMax).count;
}

registerTsh({
  id: 'coin-center',
  label: 'Cunhagem de moedas',
  desc: 'Cunha moedas na Academia respeitando as reservas por recurso (máx. 1 cunhagem por ciclo).',
  category: 'economia',
  screen: 'snob',
  mutating: true,
  cooldownMs: 5 * 60_000,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  async runCycle(ctx) {
    const settings = ctx.storage.get('settings', DEFAULT_SETTINGS);
    const resources: Record<CoinResource, number> = {
      wood: readPageResource('wood', document),
      stone: readPageResource('stone', document),
      iron: readPageResource('iron', document),
    };
    const { count, possible } = planCoinMintDetails(resources, settings, readMintMax(document));
    if (count < 1) {
      // Página informando 0 moedas (limite do jogo) com reservas sobrando é
      // bloqueio do jogo — status didático separado do "sem recursos".
      ctx.status(
        possible >= 1
          ? `Cunhagem bloqueada pela página: 0 moedas disponíveis agora (as reservas permitiriam ${possible}).`
          : 'Recursos insuficientes para cunhar dentro das reservas.',
        'info',
      );
      return;
    }
    ctx.status(
      `Prévia: cunhar ${count} de ${possible} moeda${possible !== 1 ? 's' : ''} possível${possible !== 1 ? 'is' : ''}; ficam reservas ${reserveLabel(settings)} (custo ${costLabel(settings)} por moeda).`,
      'info',
    );
    await mintCoins(count);
    ctx.status(
      `Cunhagem enviada: ${count} de ${possible} possível${possible !== 1 ? 'is' : ''} — a Academia vai recarregar.`,
      'ok',
    );
  },
});

function costLabel(settings: CoinSettings): string {
  return RESOURCES.map((resource) => settings.coinCost[resource] ?? 0).join('/');
}

function reserveLabel(settings: CoinSettings): string {
  return RESOURCES.map((resource) => `${RESOURCE_LABEL[resource]} ${settings[RESERVE_KEY[resource]] ?? 0}`).join(', ');
}
