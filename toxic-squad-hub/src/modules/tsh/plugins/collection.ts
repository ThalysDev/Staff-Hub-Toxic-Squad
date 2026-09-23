// Plugin TSH 'collection' — porta do plugin da extensão
// (toxic-squad-hub-ext/.../modules/features/collection/plugin.ts) para o motor
// de ciclos do userscript:
// - leitura das opções de coleta da tela (Praça de Reunião → Coletar
//   recursos; no jogo a URL é screen=place&mode=scavenge[_mass] — o ciclo
//   valida o mode antes de agir);
// - settings: duração (pequena/média/grande/extrema), mínimo de unidades e
//   modo do lote — 'fixo' usa o lote por unidade (vazio = todas as tropas
//   disponíveis, como hoje) e 'tudo' envia TODAS as disponíveis na tela —
//   que é exatamente o comportamento do plugin original (ele sempre enviava
//   todas as tropas lidas); o default 'fixo' preserva o comportamento atual;
// - F2: UM envio por ciclo — tela individual: sendScavengingSquads (API
//   scavenge_api/send_squads com o villageId do ctx, fallback DOM do
//   transporte); tela em massa: sendScavengingMass (gatilhos de nível).

import { z } from 'zod';
import { registerTsh, type TshAutomation, type TshCycleContext } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import {
  normalizeVillageId,
  sendScavengingMass,
  sendScavengingSquads,
  type ScavengeDuration,
} from '../tsh-transport';
import type { UnitType } from '../../../ext/modules/shared/module-types';

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

const collectionSettings = z.object({
  duration: z.enum(['pequena', 'media', 'grande', 'extrema']).default('media'),
  minUnits: z.number().int().min(1).default(10),
  /** 'fixo' = lote por unidade (como hoje); 'tudo' = todas as disponíveis na tela. */
  lotMode: z.enum(['fixo', 'tudo']).default('fixo'),
  units: z.record(z.string(), z.number().int().nonnegative()).default({}),
  autoUnlock: z.boolean().default(false),
});

type CollectionSettings = z.infer<typeof collectionSettings>;

/** Espelha os defaults do schema zod (usado como fallback e semente do painel). */
export const DEFAULT_SETTINGS: CollectionSettings = {
  duration: 'media',
  minUnits: 10,
  lotMode: 'fixo',
  units: {},
  autoUnlock: false,
};

// ── Decisão do lote (pura — testável) ───────────────────────────────────────

export type CollectionLotMode = 'fixo' | 'tudo';

export type CollectionLotDecision =
  | Readonly<{ kind: 'send'; units: Record<string, number> }>
  | Readonly<{ kind: 'skip'; reason: string }>;

/**
 * Lote efetivo da coleta (mesma semântica do plugin original):
 * - modo 'tudo': TODAS as tropas disponíveis lidas na tela — é o que o plugin
 *   da extensão sempre enviou (village.troops inteiro);
 * - modo 'fixo': unidades configuradas (>0) limitadas pelas disponíveis; sem
 *   configuração, cai para todas as disponíveis (comportamento de hoje).
 * Fail-closed com UMA exceção documentada (P3 revisão Onda 11-19): no modo
 * 'fixo' com o teto da tela ilegível, o lote configurado vai INTEIRO (o
 * servidor satura no disponível — nunca além); leitura AUSENTE zera a tropa.
 * O envio só acontece se algum tipo do lote atinge o mínimo configurado.
 */
export function decideCollectionLot(
  available: Partial<Record<UnitType, number>>,
  configuredUnits: Record<string, number>,
  options: { lotMode: CollectionLotMode; minUnits: number },
): CollectionLotDecision {
  const configured = Object.entries(configuredUnits).filter(
    ([unit, amount]) => UNIT_TYPES.includes(unit as UnitType) && amount > 0,
  );
  const units: Record<string, number> = {};
  if (options.lotMode === 'fixo' && configured.length > 0) {
    for (const [unit, amount] of configured) {
      const cap = available[unit as UnitType];
      // Cap ilegível na tela = envia o configurado (o jogo satura no servidor).
      units[unit] = cap === undefined ? amount : Math.min(amount, cap);
    }
  } else {
    for (const [unit, amount] of Object.entries(available)) {
      if ((amount ?? 0) > 0) units[unit] = amount ?? 0;
    }
  }
  if (!Object.values(units).some((amount) => amount >= options.minUnits)) {
    return { kind: 'skip', reason: 'Tropas insuficientes para o mínimo configurado.' };
  }
  return { kind: 'send', units };
}

const SETTINGS_FORM: SettingsField[] = [
  {
    key: 'duration',
    label: 'Duração da coleta',
    type: 'select',
    options: [
      { value: 'pequena', label: 'Pequena' },
      { value: 'media', label: 'Média' },
      { value: 'grande', label: 'Grande' },
      { value: 'extrema', label: 'Extrema' },
    ],
    help: 'Slot de coleta usado no envio: quanto maior a duração, mais tempo as tropas ficam fora e mais recursos trazem.',
  },
  {
    key: 'minUnits',
    label: 'Mínimo de unidades no lote',
    type: 'number',
    min: 1,
    max: 10_000,
    step: 1,
    help: 'Só envia quando pelo menos UM tipo de unidade do lote atinge este mínimo (mesma regra do plugin original).',
  },
  {
    key: 'lotMode',
    label: 'Modo do lote',
    type: 'select',
    options: [
      { value: 'fixo', label: 'Fixo (lote por unidade)' },
      { value: 'tudo', label: 'Tudo (todas as tropas da tela)' },
    ],
    help: 'Fixo: usa o lote por unidade abaixo — vazio = envia todas as disponíveis (como hoje). Tudo: envia TODAS as tropas disponíveis da tela, respeitando o mínimo.',
  },
  {
    key: 'units',
    label: 'Lote por unidade (modo Fixo)',
    type: 'record',
    help: 'Modo Fixo: quantidade FIXA de cada unidade no lote; 0 = unidade não entra; vazio = todas as disponíveis. Ignorado no modo Tudo.',
    recordKeys: [
      { key: 'spear', label: 'Lança', min: 0, step: 100 },
      { key: 'sword', label: 'Espada', min: 0, step: 100 },
      { key: 'axe', label: 'Machado', min: 0, step: 100 },
      { key: 'archer', label: 'Arqueiro', min: 0, step: 100 },
      { key: 'spy', label: 'Explorador', min: 0, step: 10 },
      { key: 'light', label: 'Cav. Leve', min: 0, step: 100 },
      { key: 'marcher', label: 'Arq. Cavalo', min: 0, step: 100 },
      { key: 'heavy', label: 'Cav. Pesada', min: 0, step: 100 },
    ],
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

/** Estado dos slots de coleta da tela individual (porta do readCollection). */
function readCollectionSlots(doc: Document): { unlocked: boolean; activeSlots: number; maxSlots: number } | undefined {
  const options = Array.from(doc.querySelectorAll('.scavenge-option, [data-scavenge-option]'));
  if (options.length === 0) return undefined;
  const activeSlots = options.filter((option) =>
    option.querySelector('[data-scavenge-active], .scavenge-active, .timer'),
  ).length;
  return { unlocked: true, activeSlots, maxSlots: options.length };
}

interface ScavengeMassVillage {
  id: string;
  troops: Record<string, number>;
  hasRallyPoint: boolean;
  unlockedOptions: number;
}

/**
 * JSON embutido 'ScavengeMassScreen' da tela de Coleta em Massa (porta do
 * readScavengeMassVillages): tropas em casa e opções desbloqueadas por aldeia.
 * Robustez fail-closed: entrada da aldeia sem 'unit_counts_home' legível entra
 * com tropas VAZIAS (o ciclo nada envia) — descartá-la faria a leitura cair no
 * leitor da tela errada; tropa malformada é simplesmente ignorada.
 */
function readScavengeMassVillages(doc: Document): ScavengeMassVillage[] {
  const script = Array.from(doc.querySelectorAll('script')).find((candidate) =>
    (candidate.textContent ?? '').includes('ScavengeMassScreen'),
  );
  const text = script?.textContent ?? '';
  if (text === '') return [];
  const anchors = Array.from(text.matchAll(/"village_id":(\d+),"player_id"/g)).map((match) => ({
    id: match[1] ?? '',
    index: match.index ?? 0,
  }));
  const villages: ScavengeMassVillage[] = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i];
    const next = anchors[i + 1];
    if (anchor === undefined || anchor.id === '') continue;
    const entry = text.slice(anchor.index, next?.index ?? text.length);
    const troops: Record<string, number> = {};
    const troopsMatch = entry.match(/"unit_counts_home":\{([^}]*)\}/);
    if (troopsMatch?.[1] !== undefined) {
      for (const pair of troopsMatch[1].split(',')) {
        const separator = pair.indexOf(':');
        if (separator <= 0) continue;
        const unit = pair.slice(0, separator).replace(/"/g, '').trim();
        const amount = Number(pair.slice(separator + 1));
        if (unit !== '' && Number.isFinite(amount) && amount > 0) troops[unit] = amount;
      }
    }
    villages.push({
      id: anchor.id,
      troops,
      hasRallyPoint: /"has_rally_point":true/.test(entry),
      unlockedOptions: (entry.match(/"is_locked":false/g) ?? []).length,
    });
  }
  return villages;
}

/**
 * Tropas disponíveis na tela individual: contagem numérica do link da linha
 * de cada input.unitsInput (o jogo usa o link como preenchimento máximo).
 * Linha ilegível → 0 (fail-closed: manda menos, nunca mais).
 */
function readScavengeUnitsFromRows(doc: Document): Partial<Record<UnitType, number>> {
  const troops: Partial<Record<UnitType, number>> = {};
  for (const input of Array.from(doc.querySelectorAll<HTMLInputElement>('input.unitsInput[name]'))) {
    const unit = input.name as UnitType;
    if (!UNIT_TYPES.includes(unit)) continue;
    const row = input.closest('tr');
    const link = row?.querySelector('a');
    const amount = parseGameInteger(link?.textContent);
    if (amount > 0) troops[unit] = amount;
  }
  return troops;
}

async function runCycle(ctx: TshCycleContext): Promise<void> {
  const mode = new URLSearchParams(window.location.search).get('mode');
  if (mode !== 'scavenge' && mode !== 'scavenge_mass') {
    ctx.status('Abra a tela de Coleta na Praça de Reunião (Coletar recursos) para este módulo agir.', 'info');
    return;
  }
  const parsed = collectionSettings.safeParse(ctx.storage.get('settings', DEFAULT_SETTINGS));
  if (!parsed.success) {
    ctx.status('Configurações de coleta inválidas — nada foi feito. Revise duração/mínimo/unidades.', 'warn');
    return;
  }
  const settings: CollectionSettings = parsed.data;

  // Slots elegíveis: tela individual lê as opções; tela em massa usa o JSON
  // embutido (mesma semântica do page-runner da extensão).
  const mass = readScavengeMassVillages(document);
  const mine = mass.find((village) => normalizeVillageId(village.id) === normalizeVillageId(ctx.villageId));
  const collection =
    mode === 'scavenge_mass' && mine !== undefined
      ? { unlocked: mine.hasRallyPoint && mine.unlockedOptions > 0, activeSlots: 0, maxSlots: Math.max(1, mine.unlockedOptions) }
      : readCollectionSlots(document);
  if (collection === undefined || !collection.unlocked || collection.activeSlots >= collection.maxSlots) {
    ctx.status('Nenhum slot de coleta elegível.', 'info');
    return;
  }

  const available: Partial<Record<UnitType, number>> =
    mine !== undefined ? mine.troops : readScavengeUnitsFromRows(document);
  // Lote efetivo (puro): 'tudo' = todas as disponíveis (original); 'fixo' =
  // lote por unidade, caindo para todas as disponíveis quando vazio (hoje).
  const decision = decideCollectionLot(available, settings.units, {
    lotMode: settings.lotMode,
    minUnits: settings.minUnits,
  });
  if (decision.kind === 'skip') {
    ctx.status(decision.reason, 'info');
    return;
  }
  const units = decision.units;

  const duration = settings.duration as ScavengeDuration;
  // F2: UM envio por ciclo. Tela em massa = gatilhos de nível; individual =
  // esquadrilha da aldeia atual (API-first com o villageId do ctx).
  if (mode === 'scavenge_mass') {
    await sendScavengingMass(units, duration);
  } else {
    await sendScavengingSquads(ctx.villageId, [{ duration, units }]);
  }
  const total = Object.values(units).reduce((sum, amount) => sum + amount, 0);
  ctx.status(`Coleta enviada (${duration}): ${total} unidades em ${Object.keys(units).length} tipo(s).`, 'ok');
}

export const collectionAutomation: TshAutomation = {
  id: 'collection',
  label: 'Coleta',
  desc: 'Envia tropas para coletar recursos (Praça → Coletar recursos): 1 envio por ciclo na duração configurada.',
  category: 'producao',
  screen: 'place',
  mutating: true,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  runCycle,
};

registerTsh(collectionAutomation);
