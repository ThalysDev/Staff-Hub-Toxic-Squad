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
// - Onda 5b: REGRAS MÚLTIPLAS POR GRUPO (settings.groupRules, textarea
//   "grupoId:duração:lote:min" por linha, parse puro fail-closed) — a aldeia
//   atual usa a regra do grupo a que pertence (getGroupVillages em cache; a
//   resolução do grupo vem do helper exportado pelo recruitment). Sem regra
//   para a aldeia (ou grupo não lido) = settings atuais, com aviso. RESERVAS
//   POR UNIDADE (settings.reserveByUnit): tropas reservadas nunca entram no
//   lote (o excedente sobre a reserva é o disponível real da coleta).

import { z } from 'zod';
import { registerTsh, type TshAutomation, type TshCycleContext } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import {
  normalizeVillageId,
  sendScavengingMass,
  sendScavengingSquads,
  type ScavengeDuration,
} from '../tsh-transport';
import { groupIdForVillage } from './recruitment';
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
  /** Regras por grupo: "grupoId:duração:lote:min" por linha (Onda 5b). */
  groupRules: z.string().default(''),
  /** Reservas por unidade (0..12 chaves): tropas que NUNCA entram no lote. */
  reserveByUnit: z.record(z.string(), z.number().int().nonnegative()).default({}),
});

type CollectionSettings = z.infer<typeof collectionSettings>;

/** Espelha os defaults do schema zod (usado como fallback e semente do painel). */
export const DEFAULT_SETTINGS: CollectionSettings = {
  duration: 'media',
  minUnits: 10,
  lotMode: 'fixo',
  units: {},
  autoUnlock: false,
  groupRules: '',
  reserveByUnit: {},
};

// ── Regras por grupo (puras — testáveis) ────────────────────────────────────

/** Lote da regra: número fixo por unidade ou 'tudo' (todas as disponíveis). */
export type GroupRuleLot = number | 'tudo';

export interface CollectionGroupRule {
  groupId: number;
  duration: ScavengeDuration;
  lot: GroupRuleLot;
  minUnits: number;
}

const DURATION_ALIASES: Readonly<Record<string, ScavengeDuration>> = {
  pequena: 'pequena',
  media: 'media',
  média: 'media',
  grande: 'grande',
  extrema: 'extrema',
};

/**
 * Parser PURO das regras por grupo (Onda 5b): uma regra por linha, no formato
 * "grupoId:duração:lote:min" (ex.: "182608:grande:200:50" ou
 * "182608:media:tudo:10"). Duração aceita pequena/média/grande/extrema
 * (acento opcional); lote é inteiro ≥ 1 (quantidade FIXA por unidade) ou a
 * palavra 'tudo'; min é inteiro ≥ 1. Linhas vazias são ignoradas; grupo
 * repetido é inválido (a última regra venceria em silêncio). Qualquer linha
 * ruim derruba o parse INTEIRO com o motivo da primeira — o chamador segue
 * com os settings atuais (fail-closed: uma regra malformada não pode rotear a
 * aldeia errada para uma coleta diferente).
 */
export function parseGroupRules(
  text: string,
): { ok: true; rules: CollectionGroupRule[] } | { ok: false; reason: string } {
  const rules: CollectionGroupRule[] = [];
  const seen = new Set<number>();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parts = line.split(':').map((part) => part.trim());
    const bad = (detail: string): { ok: false; reason: string } => ({
      ok: false,
      reason: `linha ${index + 1} ("${line}") ${detail} — use "grupoId:duração:lote:min" (ex.: 182608:grande:200:50).`,
    });
    if (parts.length !== 4) return bad('não tem os 4 campos');
    const [rawGroup, rawDuration, rawLot, rawMin] = parts;
    const groupId = Number(rawGroup);
    if (!Number.isInteger(groupId) || groupId <= 0) return bad('tem grupo inválido');
    const duration = DURATION_ALIASES[(rawDuration ?? '').toLowerCase()];
    if (duration === undefined) return bad('tem duração inválida (pequena/média/grande/extrema)');
    let lot: GroupRuleLot;
    if ((rawLot ?? '').toLowerCase() === 'tudo') {
      lot = 'tudo';
    } else {
      const parsedLot = Number(rawLot);
      if (!Number.isInteger(parsedLot) || parsedLot < 1) return bad("tem lote inválido (inteiro ≥ 1 ou 'tudo')");
      lot = parsedLot;
    }
    const minUnits = Number(rawMin);
    if (!Number.isInteger(minUnits) || minUnits < 1) return bad('tem mínimo inválido (inteiro ≥ 1)');
    if (seen.has(groupId)) return bad(`repete o grupo ${groupId}`);
    seen.add(groupId);
    rules.push({ groupId, duration, lot, minUnits });
  }
  return { ok: true, rules };
}

/** Regra do grupo da aldeia (null = nenhuma regra para ela). */
export function ruleForGroup(rules: CollectionGroupRule[], groupId: number | null): CollectionGroupRule | null {
  if (groupId === null) return null;
  return rules.find((rule) => rule.groupId === groupId) ?? null;
}

/**
 * Disponíveis da tela MENOS as reservas por unidade (PURA): unidade reservada
 * nunca entra no lote (fail-closed: reserva maior que o disponível zera a
 * unidade em vez de mandar negativo).
 */
export function applyUnitReserves(
  available: Partial<Record<UnitType, number>>,
  reserves: Record<string, number>,
): Partial<Record<UnitType, number>> {
  const effective: Partial<Record<UnitType, number>> = {};
  for (const [unit, amount] of Object.entries(available)) {
    const reserve = reserves[unit] ?? 0;
    const usable = Math.max(0, (amount ?? 0) - Math.max(0, reserve));
    if (usable > 0) effective[unit as UnitType] = usable;
  }
  return effective;
}

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
  {
    key: 'reserveByUnit',
    label: 'Reservas por unidade (nunca entram no lote)',
    type: 'record',
    help: 'Quantidade de cada unidade que FICA na aldeia: o lote usa só o excedente sobre a reserva (em qualquer modo). 0 = sem reserva.',
    recordKeys: [
      { key: 'spear', label: 'Lança', min: 0, step: 100 },
      { key: 'sword', label: 'Espada', min: 0, step: 100 },
      { key: 'axe', label: 'Machado', min: 0, step: 100 },
      { key: 'archer', label: 'Arqueiro', min: 0, step: 100 },
      { key: 'spy', label: 'Explorador', min: 0, step: 10 },
      { key: 'light', label: 'Cav. Leve', min: 0, step: 100 },
      { key: 'marcher', label: 'Arq. Cavalo', min: 0, step: 100 },
      { key: 'heavy', label: 'Cav. Pesada', min: 0, step: 100 },
      { key: 'ram', label: 'Aríete', min: 0, step: 10 },
      { key: 'catapult', label: 'Catapulta', min: 0, step: 10 },
      { key: 'knight', label: 'Paladino', min: 0, step: 1 },
      { key: 'snob', label: 'Nobre', min: 0, step: 1 },
    ],
  },
  {
    key: 'groupRules',
    label: 'Regras por grupo (uma por linha)',
    type: 'textarea',
    placeholder: '182608:grande:200:50\n182622:media:tudo:10',
    help: 'Formato "grupoId:duração:lote:min" (ex.: 182608:grande:200:50). Duração: pequena/média/grande/extrema; lote: inteiro (quantidade fixa por unidade) ou "tudo"; min: mínimo de unidades no lote. A aldeia atual usa a regra do grupo a que pertence; sem regra (ou grupo não lido) valem os campos acima. Linha inválida: nada muda (fail-closed).',
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
  // Reservas por unidade (Onda 5b): o lote nunca toca as tropas reservadas.
  const usable = applyUnitReserves(available, settings.reserveByUnit);

  // Regras por grupo (Onda 5b): texto preenchido e VÁLIDO tem prioridade; a
  // aldeia atual usa a regra do SEU grupo. Grupo não lido/não encontrado ou
  // sem regra = settings atuais (com nota no status) — nunca filtra tudo.
  let effective = {
    duration: settings.duration,
    minUnits: settings.minUnits,
    lotMode: settings.lotMode,
    units: settings.units,
  };
  let groupNote = '';
  if (settings.groupRules.trim() !== '') {
    const parsedRules = parseGroupRules(settings.groupRules);
    if (!parsedRules.ok) {
      ctx.status(
        `Regras por grupo inválidas — nada foi feito e os campos acima seguem valendo (${parsedRules.reason}).`,
        'warn',
      );
      return;
    }
    const groupId = await groupIdForVillage(ctx.world, ctx.villageId);
    const rule = ruleForGroup(parsedRules.rules, groupId);
    if (rule === null) {
      groupNote =
        groupId === null
          ? ' Grupo da aldeia não identificado (leitura de grupos vazia/indisponível) — usando os campos acima.'
          : ` Nenhuma regra para o grupo ${groupId} — usando os campos acima.`;
    } else {
      effective = {
        duration: rule.duration,
        minUnits: rule.minUnits,
        lotMode: rule.lot === 'tudo' ? 'tudo' : 'fixo',
        // Lote numérico vale só para as unidades DISPONÍVEIS na tela (unidade
        // ausente não entra: sem leitura do teto o jogo receberia um lote de
        // tropa que a aldeia não tem).
        units:
          rule.lot === 'tudo'
            ? {}
            : Object.fromEntries(
                UNIT_TYPES.filter((unit) => (usable[unit] ?? 0) > 0).map((unit) => [unit, rule.lot as number]),
              ),
      };
      groupNote = ` Regra do grupo ${groupId}: ${rule.duration}, lote ${rule.lot === 'tudo' ? 'tudo' : rule.lot}, mínimo ${rule.minUnits}.`;
    }
  }

  // Reservas por unidade (Onda 5b): o lote nunca toca as tropas reservadas.
  // Lote efetivo (puro): 'tudo' = todas as disponíveis (original); 'fixo' =
  // lote por unidade, caindo para todas as disponíveis quando vazio (hoje).
  const decision = decideCollectionLot(usable, effective.units, {
    lotMode: effective.lotMode,
    minUnits: effective.minUnits,
  });
  if (decision.kind === 'skip') {
    ctx.status(`${decision.reason}${groupNote}`, 'info');
    return;
  }
  const units = decision.units;

  const duration = effective.duration as ScavengeDuration;
  // F2: UM envio por ciclo. Tela em massa = gatilhos de nível; individual =
  // esquadrilha da aldeia atual (API-first com o villageId do ctx).
  if (mode === 'scavenge_mass') {
    await sendScavengingMass(units, duration);
  } else {
    await sendScavengingSquads(ctx.villageId, [{ duration, units }]);
  }
  const total = Object.values(units).reduce((sum, amount) => sum + amount, 0);
  ctx.status(`Coleta enviada (${duration}): ${total} unidades em ${Object.keys(units).length} tipo(s).${groupNote}`, 'ok');
}

export const collectionAutomation: TshAutomation = {
  id: 'collection',
  label: 'Coleta',
  desc: 'Envia tropas para coletar recursos (Praça → Coletar recursos): 1 envio por ciclo na duração configurada (ou na regra do grupo da aldeia).',
  category: 'producao',
  screen: 'place',
  mutating: true,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  runCycle,
};

registerTsh(collectionAutomation);
