// v3.10.0: vira a CUNHAGEM EM MASSA — segundo plano em todas as aldeias pela
// própria "Cunhar moedas de ouro" do jogo (coin_multi, ver coin-mass.ts), com
// reserva fixa ou % do armazém; o modo "Só na tela" abaixo segue como antes.
//
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
// - Onda 5b: modo PERCENTUAL (settings.keepPercent 0..90) — com > 0 o ciclo
//   mantém X% do disponível de cada recurso no armazém em vez das reservas
//   fixas: mint = min(teto por ciclo, máximo da página, floor(disponível ×
//   (1 − X%) / custo) por recurso). 0 (default) = comportamento de sempre
//   (reservas fixas por recurso).

import { registerTsh, type TshCycleContext } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import { mintCoins, mintCoinsMultiApi } from '../tsh-transport';
import { parsePtBrInt } from '../../vanta/vanta-utils';
import { pacedGet } from '../../../core/net';
import { gm } from '../../../core/storage';
import { parseCoinOverview, parseSnobScreen, planMassMint, readMintedCoins } from './coin-mass';
import { buildCoinMassPanel } from './coin-mass-panel';

export type CoinResource = 'wood' | 'stone' | 'iron';
const RESOURCES: readonly CoinResource[] = ['wood', 'stone', 'iron'];

// Type alias (não interface) para continuar atribuível a Record<string, unknown>
// em settingsDefaults.
export type CoinSettings = {
  maxCoinsPerCycle: number;
  reserveWood: number;
  reserveStone: number;
  reserveIron: number;
  /**
   * Modo percentual (Onda 5b): percentual do DISPONÍVEL de cada recurso que
   * fica no armazém (0..90). 0/ausente = modo de reservas fixas (comportamento
   * de sempre); > 0 substitui as reservas fixas.
   */
  keepPercent?: number;
  /** Custo de reserva (o ciclo lê o custo real da página do jogo). */
  coinCost: Record<CoinResource, number>;
  /** v3.10.0: 'fundo' = todas as aldeias (Cunhagem em massa); 'tela' = só na Academia aberta. */
  execMode?: 'fundo' | 'tela';
  /** Teto de moedas por aldeia por rodada (0 = o máximo do jogo). */
  perVillage?: number;
  /** Pula aldeias com a cunhagem nativa do jogo ativa. */
  skipNative?: boolean;
};

export const DEFAULT_SETTINGS: CoinSettings = {
  maxCoinsPerCycle: 1,
  reserveWood: 0,
  reserveStone: 0,
  reserveIron: 0,
  keepPercent: 0,
  coinCost: { wood: 28_000, stone: 30_000, iron: 25_000 },
  execMode: 'fundo',
  perVillage: 0,
  skipNative: true,
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
    key: 'keepPercent',
    label: 'Manter % dos recursos (modo percentual)',
    type: 'number',
    min: 0,
    max: 90,
    step: 5,
    help: 'Acima de 0, o ciclo cunha mantendo este percentual do DISPONÍVEL de cada recurso (as reservas fixas acima são ignoradas). 0 = modo de reservas fixas (comportamento de sempre).',
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

/** Plano de cunhagem com o percentual efetivamente usado no ciclo. */
export interface PercentMintPlan extends CoinMintPlan {
  /** 0 = modo de reservas fixas (o comportamento de sempre). */
  keepPercent: number;
}

/** Percentual de retenção higienizado (fora de 0..90 = 0 = modo reservas). */
export function normalizeKeepPercent(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  const percent = Math.floor(value);
  if (percent <= 0) return 0;
  return Math.min(90, percent);
}

/**
 * Decisão de cunhagem do ciclo (PURA, Onda 5b): keepPercent 0 = modo de
 * reservas fixas (delega ao planCoinMintDetails de sempre — nenhum teste
 * existente muda); keepPercent > 0 = mantém X% do DISPONÍVEL de cada recurso
 * no armazém e cunha com o restante:
 *   possible = min por recurso de floor(disponível × (1 − X%) / custo);
 *   count    = min(teto por ciclo, possible, máximo da página quando informado).
 * Gate affordable da origem (recursos cobrem 1 moeda) vale nos dois modos.
 */
export function decideMintWithPercent(
  resources: Record<CoinResource, number>,
  settings: CoinSettings,
  pageMax?: number,
): PercentMintPlan {
  const keepPercent = normalizeKeepPercent(settings.keepPercent);
  if (keepPercent === 0) return { ...planCoinMintDetails(resources, settings, pageMax), keepPercent: 0 };
  const cost = settings.coinCost;
  if (!RESOURCES.every((resource) => resources[resource] >= (cost[resource] ?? 0))) {
    return { count: 0, possible: 0, keepPercent };
  }
  const usableFactor = 1 - keepPercent / 100;
  const possible = Math.min(
    ...RESOURCES.map((resource) => {
      const resourceCost = cost[resource] ?? 0;
      if (resourceCost <= 0) return 0;
      return Math.floor((resources[resource] * usableFactor) / resourceCost);
    }),
  );
  const capped = Math.min(settings.maxCoinsPerCycle, possible);
  const count = pageMax !== undefined ? Math.min(capped, Math.max(0, pageMax)) : capped;
  return { count: Math.max(0, count), possible: Math.max(0, possible), keepPercent };
}

// ── v3.10.0: Cunhagem em massa (segundo plano) ──────────────────────────────

type MassSettings = CoinSettings;

/** Modo salvo: quem já usava (settings sem execMode) fica gravado em 'tela' (aviso 7 dias). */
function savedCoinMode(world: string): { mode: 'fundo' | 'tela' | null; legacy: boolean } {
  const key = `tsh-auto:${world}:coin-center:settings`;
  const raw = gm.get<Record<string, unknown> | null>(key, null);
  if (raw === null || typeof raw !== 'object' || Object.keys(raw).length === 0) {
    // Nunca salvou, mas já estava ligado/rodando na versão antiga: segue na tela (sem gastar tudo em massa).
    const used = gm.get<boolean>('tsh-auto:coin-center:enabled', false) || gm.get<unknown>(`tsh-auto:${world}:coin-center:state`, null) !== null;
    if (!used) return { mode: null, legacy: false };
    gm.set(key, { execMode: 'tela', legacyTela: Date.now() });
    return { mode: 'tela', legacy: true };
  }
  if (raw.execMode === 'fundo' || raw.execMode === 'tela') {
    const since = typeof raw.legacyTela === 'number' ? raw.legacyTela : 0;
    return { mode: raw.execMode, legacy: raw.execMode === 'tela' && Date.now() - since < 7 * 24 * 60 * 60_000 };
  }
  gm.set(key, { ...raw, execMode: 'tela', legacyTela: Date.now() });
  return { mode: 'tela', legacy: true };
}

/** Aldeias com sessão nativa ativa (o que a Cunhagem nativa sabe). */
function nativeActive(world: string): Set<string> {
  const next = gm.get<Record<string, number>>(`tsh-auto:${world}:auto-mint-nativo:active`, {});
  const now = Date.now();
  return new Set(Object.entries(next).filter(([, until]) => until > now).map(([id]) => id));
}

async function runMass(ctx: TshCycleContext, settings: MassSettings): Promise<void> {
  const from = ctx.storage.get<number>('massFrom', 0);
  const html = await pacedGet(`/game.php?village=${ctx.villageId}&screen=snob&mode=coin&from=${from}`, { fresh: true });
  const page = parseCoinOverview(html, from);
  if (page === null) {
    if (from > 0) ctx.storage.set('massFrom', 0);
    ctx.status('Não consegui ler "Cunhar moedas de ouro" da Academia (exige Conta Premium) — nada foi cunhado. Sem Premium, use "Só na tela da Academia" em Configurar.', 'warn');
    return;
  }
  const nextFrom = page.more ? from + 1000 : 0;
  const cost = page.cost ?? settings.coinCost;
  const keepPct = normalizeKeepPercent(settings.keepPercent);
  const skip = settings.skipNative !== false ? nativeActive(ctx.world) : new Set<string>();
  const eligible = page.villages.filter((v) => !skip.has(v.id));
  const plan = planMassMint(eligible, cost, {
    keep: { wood: settings.reserveWood, stone: settings.reserveStone, iron: settings.reserveIron },
    keepPct,
    perVillage: Math.max(0, Math.floor(settings.perVillage ?? 0)),
  });
  const note =
    (page.groupId !== 0 ? ' O jogo está mostrando só um grupo de aldeias: a cunhagem cobre só essas (escolha "todos" no menu de grupos do jogo para todas).' : '') +
    (skip.size > 0 ? ` ${skip.size} aldeia(s) com a cunhagem nativa ativa ficaram de fora.` : '');
  ctx.storage.set('massFrom', nextFrom);
  if (nextFrom !== 0) ctx.again?.(60_000);
  const n = Object.keys(plan).length;
  if (n === 0) {
    ctx.status(`Nenhuma moeda a cunhar agora: nenhuma aldeia tem recursos para 1 moeda além do que fica em casa.${nextFrom !== 0 ? ' Sigo nas próximas aldeias em 1 min.' : ''}${note}`, 'info');
    return;
  }
  const total = Object.values(plan).reduce((a, b) => a + b, 0);
  let response: unknown;
  try {
    response = await mintCoinsMultiApi(plan);
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === 'HUMANIZE_PAUSE') {
      ctx.status('Pausa de humanização ativa — a cunhagem fica para o próximo ciclo.', 'info');
      return;
    }
    ctx.status(
      e.code === 'RESULT_UNCERTAIN'
        ? `${e.message ?? 'Cunhagem inconclusiva'} — não repito às cegas; a próxima leitura mostra o que o jogo cunhou.`
        : `O jogo não cunhou: ${e.message ?? String(error)}`,
      'warn',
    );
    return;
  }
  const minted = readMintedCoins(response);
  if (minted === null) {
    ctx.status(`Cunhagem enviada (${total} moeda(s) em ${n} aldeia(s)), mas a resposta do jogo não disse quantas saíram — confiro na próxima leitura.${note}`, 'warn');
    return;
  }
  const got = Object.values(minted).reduce((a, b) => a + b, 0);
  const villagesOk = Object.keys(minted).length;
  ctx.status(
    `Cunhadas ${got} moeda(s) em ${villagesOk} aldeia(s) — confirmado pelo jogo${got < total ? ` (pedidas ${total}; o jogo cunhou o que coube)` : ''}.${nextFrom !== 0 ? ' Sigo nas próximas aldeias em 1 min.' : ''}${note}`,
    got > 0 ? 'ok' : 'warn',
  );
}

/** Só na tela da Academia (comportamento de antes, custo lido da própria página). */
async function runScreen(ctx: TshCycleContext, settings: MassSettings, legacy: boolean): Promise<void> {
  if (new URLSearchParams(window.location.search).get('screen') !== 'snob') {
    ctx.status(
      legacy
        ? 'Novo na 3.10: a Cunhagem pode rodar em TODAS as aldeias sem abrir a Academia — escolha "Segundo plano" em Configurar. Por enquanto ela segue só na tela da Academia, como antes.'
        : 'Modo "Só na tela": abra a Academia para cunhar.',
      'info',
    );
    return;
  }
  const page = parseSnobScreen(document.documentElement.outerHTML);
  const raw = gm.get<Record<string, unknown> | null>(`tsh-auto:${ctx.world}:coin-center:settings`, null);
  const per = typeof raw?.perVillage === 'number' ? raw.perVillage : settings.maxCoinsPerCycle;
  const capped: CoinSettings = { ...settings, maxCoinsPerCycle: per > 0 ? per : 100_000 };
  const effective: CoinSettings = page === null || page.cost.wood === 0 ? capped : { ...capped, coinCost: page.cost };
  const resources: Record<CoinResource, number> = {
    wood: readPageResource('wood', document),
    stone: readPageResource('stone', document),
    iron: readPageResource('iron', document),
  };
  const { count, possible, keepPercent } = decideMintWithPercent(resources, effective, readMintMax(document));
  if (count < 1) {
    ctx.status(
      possible >= 1
        ? `O jogo não deixa cunhar agora nesta aldeia (limite da Academia) — pelas suas reservas daria ${possible}.`
        : keepPercent > 0
          ? `Recursos insuficientes para cunhar mantendo ${keepPercent}% de cada recurso no armazém.`
          : 'Recursos insuficientes para cunhar dentro das reservas.',
      'info',
    );
    return;
  }
  await mintCoins(count);
  ctx.status(`Cunhagem enviada: ${count} de ${possible} ${possible === 1 ? 'possível' : 'possíveis'} — a Academia vai recarregar.`, 'ok');
}

registerTsh({
  id: 'coin-center',
  label: 'Cunhagem em massa',
  desc: 'Cunha de uma vez o que já está acumulado em todas as aldeias (a própria "Cunhar moedas de ouro" do jogo), deixando em casa a reserva que você escolher. Para cunhar o dia todo, prefira a Cunhagem nativa.',
  category: 'economia',
  screen: null,
  mutating: true,
  cooldownMs: 10 * 60_000,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  settingsPanel: (settings, world) => buildCoinMassPanel(settings, world),
  async runCycle(ctx) {
    const settings = { ...DEFAULT_SETTINGS, ...ctx.storage.get<Partial<MassSettings>>('settings', DEFAULT_SETTINGS) } as MassSettings;
    const saved = savedCoinMode(ctx.world);
    const mode = saved.mode ?? settings.execMode ?? 'fundo';
    if (mode === 'fundo') await runMass(ctx, settings);
    else await runScreen(ctx, settings, saved.legacy);
  },
});
