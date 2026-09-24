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
//   lote (o excedente sobre a reserva é o disponível real da coleta) — reserva
//   que consome TUDO vira teto 0 da unidade (não confundir com leitura
//   ilegível: chave ausente, que o modo fixo envia o configurado).

import { z } from 'zod';
import { registerTsh, type TshAutomation, type TshCycleContext } from '../tsh-runtime';
import type { SettingsField } from '../tsh-settings';
import {
  normalizeVillageId,
  sendScavengingMass,
  scavengeOptionId,
  sendScavengingSquads,
  type ScavengeDuration,
} from '../tsh-transport';
import { groupIdForVillage } from './recruitment';
import { DEFAULT_LOOT_FACTOR, readScavengeLevels, splitEquilibrada } from './collection-levels';
import {
  freeLevelIds,
  isOffensive,
  parseScavengeMassPage,
  planVillage,
  squadSeconds,
  unlockCandidate,
  usableUnits,
  type MassPage,
  type MassRequest,
} from './collection-mass';
import { buildCollectionPanel } from './collection-panel';
import { levelForMode, profileByVillage, profilesFromLegacy, readProfiles, savedExecMode, type GroupProfile } from './collection-groups';
import { getGroupVillages } from '../tsh-groups';
import { pacedGet } from '../../../core/net';
import { SCAVENGE_BATCH_MAX, sendScavengeBatch, unlockScavengeLevel } from '../tsh-transport';

const DURATION_BY_LEVEL: Record<number, ScavengeDuration> = { 1: 'pequena', 2: 'media', 3: 'grande', 4: 'extrema' };
const DURATION_LABEL: Record<number, string> = { 1: 'Pequena', 2: 'Média', 3: 'Grande', 4: 'Extrema' };

/** "HH:MM" (relógio do computador) de um epoch em segundos. */
function horaLocal(unixSec: number): string {
  return new Date(unixSec * 1000).toTimeString().slice(0, 5);
}
import { estimateScavengeSeconds, readScavengeOptionCfg, reservationForVillage, reservationNote, subtractReservation } from '../tsh-reserva';
import { serverNowMs } from '../../../core/game-clock';
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
  lotMode: z.enum(['fixo', 'tudo', 'equilibrada']).default('equilibrada'),
  units: z.record(z.string(), z.number().int().nonnegative()).default({}),
  autoUnlock: z.boolean().default(false),
  /** v3.6.0: 'fundo' = todas as aldeias pela API (sem tela); 'tela' = só com a Coleta aberta. */
  execMode: z.enum(['fundo', 'tela']).default('fundo'),
  /** Tempo-alvo (h) das aldeias ofensivas/defensivas; 0 = sem alvo (manda tudo). */
  targetHoursOff: z.number().min(0).max(48).default(0),
  targetHoursDef: z.number().min(0).max(48).default(0),
  /** Tropas que NUNCA coletam (desligadas na tela de configuração). */
  skipUnits: z.array(z.string()).default([]),
  /** LEGADO (Onda 5b): "grupoId:duração:lote:min" por linha — a tela nova converte em groupProfiles. */
  groupRules: z.string().default(''),
  /** v3.6.0: regras por grupo em cartões (grupo pelo nome, como coletar, tempo-alvo, tropas). */
  groupProfiles: z.array(z.unknown()).default([]),
  /** Reservas por unidade (0..12 chaves): tropas que NUNCA entram no lote. */
  reserveByUnit: z.record(z.string(), z.number().int().nonnegative()).default({}),
});

type CollectionSettings = z.infer<typeof collectionSettings>;

/** Espelha os defaults do schema zod (usado como fallback e semente do painel). */
export const DEFAULT_SETTINGS: CollectionSettings = {
  duration: 'media',
  minUnits: 10,
  lotMode: 'equilibrada',
  units: {},
  autoUnlock: false,
  execMode: 'fundo',
  targetHoursOff: 0,
  targetHoursDef: 0,
  skipUnits: [],
  groupRules: '',
  groupProfiles: [],
  reserveByUnit: {},
};

// Regras por grupo antigas (texto): ver collection-rules.ts.
export { parseGroupRules, ruleForGroup, type CollectionGroupRule, type GroupRuleLot } from './collection-rules';
import { parseGroupRules, ruleForGroup } from './collection-rules';

/**
 * Disponíveis da tela MENOS as reservas por unidade (PURA): unidade reservada
 * nunca entra no lote (fail-closed: reserva maior que o disponível zera a
 * unidade em vez de mandar negativo). A unidade zerada CONTINUA no resultado
 * com 0 — é o que diferencia "a reserva consumiu tudo" (cap 0: não entra no
 * lote) de "leitura ilegível" (chave AUSENTE, que o modo fixo trata como teto
 * desconhecido).
 */
export function applyUnitReserves(
  available: Partial<Record<UnitType, number>>,
  reserves: Record<string, number>,
): Partial<Record<UnitType, number>> {
  const effective: Partial<Record<UnitType, number>> = {};
  for (const [unit, amount] of Object.entries(available)) {
    const reserve = reserves[unit] ?? 0;
    effective[unit as UnitType] = Math.max(0, (amount ?? 0) - Math.max(0, reserve));
  }
  return effective;
}

// ── Decisão do lote (pura — testável) ───────────────────────────────────────

export type CollectionLotMode = 'fixo' | 'tudo' | 'equilibrada';

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
 * 'fixo' com o teto da tela ILEGÍVEL (chave AUSENTE do mapa de disponíveis), o
 * lote configurado vai INTEIRO (o servidor satura no disponível — nunca além);
 * chave PRESENTE valendo 0 (ex.: reserva por unidade consumiu tudo, ver
 * applyUnitReserves) é teto ZERO: a unidade não entra no lote. No modo 'tudo',
 * leitura ausente/zerada simplesmente não entra.
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
      // Cap ilegível (ausente) = envia o configurado (o jogo satura no
      // servidor); cap 0 (reserva total) = unidade fora do lote.
      const effectiveAmount = cap === undefined ? amount : Math.min(amount, cap);
      if (effectiveAmount > 0) units[unit] = effectiveAmount;
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
    key: 'execMode',
    label: 'Como rodar',
    type: 'select',
    options: [
      { value: 'fundo', label: 'Segundo plano (todas as aldeias)' },
      { value: 'tela', label: 'Só na tela de Coleta' },
    ],
    help: 'Segundo plano: lê a Coleta em massa pela API e envia em todas as aldeias, em qualquer tela. Tela: só age com a Coleta aberta, na aldeia atual.',
  },
  { key: 'targetHoursOff', label: 'Tempo-alvo — ofensivas (h)', type: 'number', min: 0, max: 48, step: 0.5, help: '0 = sem alvo (manda todas as tropas).' },
  { key: 'targetHoursDef', label: 'Tempo-alvo — defensivas (h)', type: 'number', min: 0, max: 48, step: 0.5, help: '0 = sem alvo (manda todas as tropas).' },
  { key: 'autoUnlock', label: 'Desbloquear níveis sozinho', type: 'boolean', help: 'Desbloqueia o próximo nível quando a aldeia tem os recursos (1 por ciclo).' },
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
      { value: 'equilibrada', label: 'Equilibrada (todos os níveis livres, voltam juntos)' },
    ],
    help: 'Fixo: usa o lote por unidade abaixo — vazio = envia todas as disponíveis. Tudo: envia TODAS as tropas no nível da duração escolhida. Equilibrada: divide as tropas entre TODOS os níveis livres para voltarem ao mesmo tempo (a duração escolhida é ignorada) — mais recursos por hora.',
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

async function runScreenCycle(ctx: TshCycleContext): Promise<void> {
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
  // v3.6.0: estado REAL dos níveis (objeto `village` da tela): bloqueado,
  // em coleta (com a volta) ou livre. Antes: `.timer` no DOM — nível
  // bloqueado contava como livre e o jogo recusava o envio.
  const scriptsText = Array.from(document.scripts).map((el) => el.textContent ?? '').join('\n');
  const levels = mode === 'scavenge' ? readScavengeLevels(scriptsText) : null;
  const freeLevels = levels?.filter((l) => !l.locked && l.returnUnix === null) ?? null;
  if (freeLevels !== null && levels !== null && freeLevels.length === 0) {
    const proxima = levels.filter((l) => l.returnUnix !== null).sort((a, b) => (a.returnUnix ?? 0) - (b.returnUnix ?? 0))[0];
    ctx.status(
      proxima !== undefined
        ? `Todos os níveis estão em coleta ou bloqueados — o próximo volta às ${horaLocal(proxima.returnUnix ?? 0)}.`
        : 'Nenhum nível de coleta desbloqueado nesta aldeia.',
      'info',
    );
    return;
  }
  if (freeLevels === null && (collection === undefined || !collection.unlocked || collection.activeSlots >= collection.maxSlots)) {
    ctx.status('Nenhum slot de coleta elegível.', 'info');
    return;
  }

  const available: Partial<Record<UnitType, number>> =
    mine !== undefined ? mine.troops : readScavengeUnitsFromRows(document);
  // Reservas por unidade (Onda 5b): o lote nunca toca as tropas reservadas.
  // Tropas desligadas na Configurar (v3.6.0) não coletam em modo nenhum.
  const usable = applyUnitReserves(
    Object.fromEntries(Object.entries(available).filter(([u]) => !settings.skipUnits.includes(u))),
    settings.reserveByUnit,
  );

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
  if (readProfiles(settings.groupProfiles).length > 0) {
    const profile = (await loadProfiles(settings, new Set())).get(normalizeVillageId(ctx.villageId));
    if (profile !== undefined) {
      const lvl = levelForMode(profile.mode);
      if (lvl === null) {
        ctx.status(`Esta aldeia está no grupo "${profile.groupName || profile.groupId}", que tem a regra "Não coletar".`, 'info');
        return;
      }
      if (lvl !== undefined) {
        effective = {
          ...effective,
          lotMode: lvl === 'equilibrada' ? 'equilibrada' : 'tudo',
          duration: lvl === 'equilibrada' ? effective.duration : (DURATION_BY_LEVEL[lvl] ?? effective.duration),
          units: {},
        };
      }
      groupNote = ` Regra do grupo "${profile.groupName || profile.groupId}".`;
    }
  } else if (settings.groupRules.trim() !== '') {
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
  // v3.5.0 — RESERVA dos comandos agendados desta aldeia: estima a VOLTA do
  // lote (fórmula da própria tela de coleta) e tira as tropas que um comando
  // precisa antes disso ("Todas" reserva o tipo inteiro). Sem os parâmetros
  // da tela, reserva tudo o que sai nas próximas 24 h (conservador).
  const lotOpts = { lotMode: effective.lotMode, minUnits: effective.minUnits };
  let usableFinal = usable;
  let reserveNote = '';
  const draft = decideCollectionLot(usable, effective.units, lotOpts);
  if (draft.kind !== 'skip') {
    const cfg = readScavengeOptionCfg(scriptsText)?.[String(scavengeOptionId(effective.duration))];
    const estSec = cfg !== undefined ? estimateScavengeSeconds(draft.units, cfg) * 1.1 : 24 * 3600;
    const res = reservationForVillage(ctx.world, ctx.villageId, serverNowMs() + estSec * 1000);
    if (res.commands.length > 0) {
      usableFinal = subtractReservation(usable, res);
      reserveNote = reservationNote(res);
    }
  }
  const decision = decideCollectionLot(usableFinal, effective.units, lotOpts);
  if (decision.kind === 'skip') {
    ctx.status(
      draft.kind !== 'skip' && reserveNote !== ''
        ? `Coleta não enviada: as tropas livres ficaram abaixo do mínimo porque comandos agendados desta aldeia saem antes da volta estimada.${reserveNote}${groupNote}`
        : `${decision.reason}${groupNote}${reserveNote}`,
      'info',
    );
    return;
  }
  const units = decision.units;

  // v3.6.0 — Coleta EQUILIBRADA: todos os níveis livres, voltando juntos
  // (uma única requisição com vários grupos — 1 mutação por ciclo).
  if (effective.lotMode === 'equilibrada' && mode === 'scavenge' && freeLevels !== null) {
    const cfgs = readScavengeOptionCfg(scriptsText);
    const lootFactor = (id: number): number => cfgs?.[String(id)]?.loot_factor ?? DEFAULT_LOOT_FACTOR[id] ?? 0.1;
    const squads = splitEquilibrada(units, freeLevels.map((l) => l.id), lootFactor, effective.minUnits);
    if (squads.length === 0) {
      ctx.status(`Coleta equilibrada: tropas insuficientes para o mínimo por nível.${groupNote}${reserveNote}`, 'info');
      return;
    }
    await sendScavengingSquads(
      ctx.villageId,
      squads.map((sq) => ({ duration: DURATION_BY_LEVEL[sq.levelId] ?? 'pequena', units: sq.units as Record<string, number> })),
    );
    const total = squads.reduce((a, sq) => a + Object.values(sq.units).reduce((x, y) => x + (y ?? 0), 0), 0);
    ctx.status(
      `Coleta equilibrada enviada: ${total} unidades em ${squads.length} nível(is) (${squads.map((sq) => DURATION_LABEL[sq.levelId] ?? sq.levelId).join(', ')}), voltando juntas.${groupNote}${reserveNote}`,
      'ok',
    );
    return;
  }

  const duration = effective.duration as ScavengeDuration;
  // v3.6.0: o nível escolhido está livre? (mensagem clara em vez de o jogo recusar)
  if (levels !== null) {
    const nivel = levels.find((l) => l.id === scavengeOptionId(duration));
    if (nivel?.locked === true) {
      ctx.status(`O nível ${DURATION_LABEL[nivel.id] ?? duration} está bloqueado nesta aldeia — desbloqueie no jogo ou escolha outra duração (ou o modo Equilibrada).`, 'warn');
      return;
    }
    if (nivel !== undefined && nivel.returnUnix !== null) {
      ctx.status(`O nível ${DURATION_LABEL[nivel.id] ?? duration} está em coleta até ${horaLocal(nivel.returnUnix)} — próximo envio depois disso (ou use o modo Equilibrada para aproveitar os outros níveis).`, 'info');
      return;
    }
  }
  // F2: UM envio por ciclo. Tela em massa = gatilhos de nível; individual =
  // esquadrilha da aldeia atual (API-first com o villageId do ctx).
  if (mode === 'scavenge_mass') {
    await sendScavengingMass(units, duration);
  } else {
    await sendScavengingSquads(ctx.villageId, [{ duration, units }]);
  }
  const total = Object.values(units).reduce((sum, amount) => sum + amount, 0);
  ctx.status(`Coleta enviada (${duration}): ${total} unidades em ${Object.keys(units).length} tipo(s).${groupNote}${reserveNote}`, 'ok');
}

// ── Coleta em SEGUNDO PLANO (v3.6.0) ────────────────────────────────────────
// Mesmo caminho da tela "Coleta em massa" do jogo: lê as páginas
// (screen=place&mode=scavenge_mass&page=N) e manda até 50 grupos num único
// scavenge_api/send_squads — 1 mutação por ciclo (F2). Sobrou trabalho? O
// próximo ciclo vem em 1 min (ctx.again), com cursor de página no storage.

/** Páginas da Coleta em massa lidas por ciclo, no máximo (leituras com pacing). */
const PAGES_PER_CYCLE = 4;

interface BackgroundPlan {
  requests: MassRequest[];
  /** Aldeias desta página que ficaram para o próximo lote (teto de 50 grupos). */
  leftover: boolean;
  reserved: number;
  unlock: { villageId: string; levelId: number; name: string } | null;
  notes: string[];
}

/** Planeja UMA página: tempo-alvo off/def, fica-em-casa, reserva do Agendador, regras por grupo. */
function planPage(
  ctx: TshCycleContext,
  page: MassPage,
  settings: CollectionSettings,
  room: number,
  profiles: ReadonlyMap<string, GroupProfile>,
): BackgroundPlan {
  const plan: BackgroundPlan = { requests: [], leftover: false, reserved: 0, unlock: null, notes: [] };
  for (const village of page.villages) {
    const vid = String(village.village_id);
    const profile = profiles.get(vid);
    const profileLevel = profile === undefined ? undefined : levelForMode(profile.mode);
    if (profileLevel === null) continue; // regra do grupo: não coletar
    if (freeLevelIds(village).length === 0) {
      if (settings.autoUnlock && plan.unlock === null) {
        const lv = unlockCandidate(village, page.levels);
        if (lv !== null) plan.unlock = { villageId: vid, levelId: lv, name: village.village_name };
      }
      continue;
    }
    // Regra do grupo (se houver) manda no nível, no tempo-alvo e nas tropas; lote fixo não vale nela.
    const level: 'equilibrada' | number =
      profileLevel ?? (settings.lotMode === 'equilibrada' ? 'equilibrada' : scavengeOptionId(settings.duration));
    const fixedCaps: Record<string, number> | null =
      profileLevel === undefined && settings.lotMode === 'fixo' && Object.values(settings.units).some((n) => n > 0) ? settings.units : null;
    const skipUnits = profile?.skipUnits ?? settings.skipUnits;
    const usable = usableUnits(village, { keepHome: settings.reserveByUnit, skipUnits, fixedCaps });
    const ofensiva = isOffensive(village.unit_counts_home);
    const targetHours = ofensiva
      ? (profile?.hoursOff ?? settings.targetHoursOff)
      : (profile?.hoursDef ?? settings.targetHoursDef);
    const opts = { targetHours, minUnits: settings.minUnits, level };
    let reqs = planVillage(village, page, usable, opts);
    if (reqs.length > 0) {
      // Reserva dos comandos agendados até a VOLTA do grupo mais longo (+10%).
      const longest = Math.max(
        ...reqs.map((r) => {
          const cfg = page.levels[String(r.levelId)];
          return cfg === undefined ? 24 * 3600 : squadSeconds(r.units, page.carry, village.unit_carry_factor, cfg);
        }),
      );
      const horizonSec = Number.isFinite(longest) && longest > 0 ? longest * 1.1 : 24 * 3600;
      const res = reservationForVillage(ctx.world, vid, serverNowMs() + horizonSec * 1000);
      if (res.commands.length > 0) {
        plan.reserved += 1;
        reqs = planVillage(village, page, subtractReservation(usable, res), opts);
      }
    }
    if (reqs.length > 0) {
      if (plan.requests.length + reqs.length > room) {
        plan.leftover = true;
        break;
      }
      plan.requests.push(...reqs);
    } else if (settings.autoUnlock && plan.unlock === null) {
      const lv = unlockCandidate(village, page.levels);
      if (lv !== null) plan.unlock = { villageId: vid, levelId: lv, name: village.village_name };
    }
  }
  return plan;
}

/** Só o 1º aviso vai inteiro na linha do status (o resto vira "+N avisos"). */
function notesText(notes: ReadonlySet<string>): string {
  const list = [...notes];
  if (list.length === 0) return '';
  return ` ${list[0] ?? ''}${list.length > 1 ? ` (+${list.length - 1} aviso(s))` : ''}`;
}

function unitsTotal(reqs: readonly MassRequest[]): number {
  return reqs.reduce((a, r) => a + Object.values(r.units).reduce((x, y) => x + (y ?? 0), 0), 0);
}

/** Aldeia → regra do grupo, lendo as aldeias de cada grupo das regras (cache de 5 min). */
async function loadProfiles(settings: CollectionSettings, notes: Set<string>): Promise<Map<string, GroupProfile>> {
  let profiles = readProfiles(settings.groupProfiles);
  if (profiles.length === 0 && settings.groupRules.trim() !== '') {
    const legacy = parseGroupRules(settings.groupRules);
    if (!legacy.ok) throw new Error(`Regras por grupo antigas inválidas — nada foi enviado (${legacy.reason}). Abra Configurar e refaça as regras nos cartões.`);
    profiles = profilesFromLegacy(settings.groupRules);
    if (profiles.length > 0) notes.add('Regras por grupo no formato antigo: abra Configurar e salve para ver os cartões novos.');
  }
  if (profiles.length === 0) return new Map();
  const byGroup = new Map<number, number[]>();
  for (const p of profiles) {
    const villages = await getGroupVillages(p.groupId);
    if (villages.length === 0) notes.add(`Grupo "${p.groupName || p.groupId}" sem aldeias (ou não lido): a regra dele não valeu agora.`);
    byGroup.set(p.groupId, villages.map((v) => v.villageId));
  }
  return profileByVillage(profiles, byGroup);
}

async function runBackground(ctx: TshCycleContext, settings: CollectionSettings): Promise<void> {
  const start = ctx.storage.get<number>('massPage', 0);
  let pageNo = start;
  let lastPage = 0;
  let unlock: BackgroundPlan['unlock'] = null;
  const notes = new Set<string>();
  const profiles = await loadProfiles(settings, notes);
  for (let read = 0; read < PAGES_PER_CYCLE; read++) {
    const html = await pacedGet(`/game.php?village=${ctx.villageId}&screen=place&mode=scavenge_mass&page=${pageNo}`, { fresh: true });
    const page = parseScavengeMassPage(html);
    if (page === null) {
      ctx.status('Não consegui ler a Coleta em massa do jogo — nada foi enviado. Tento de novo no próximo ciclo; se repetir, use "Só na tela" em Configurar.', 'warn');
      return;
    }
    lastPage = page.lastPage;
    const plan = planPage(ctx, page, settings, SCAVENGE_BATCH_MAX, profiles);
    for (const n of plan.notes) notes.add(n);
    if (unlock === null) unlock = plan.unlock;
    if (page.groupId !== 0) {
      notes.add(`O jogo está mostrando só o grupo "${page.groupName || page.groupId}" na Coleta em massa: a coleta cobre só essas aldeias. Para todas, escolha "todos" no menu de grupos do jogo.`);
    }
    if (plan.requests.length > 0) {
      let result: { accepted: number; refused: string[] };
      try {
        result = await sendScavengeBatch(
          plan.requests.map((r) => ({ villageId: r.villageId, levelId: r.levelId, units: r.units as Record<string, number> })),
        );
      } catch (error) {
        // Recusa TOTAL do jogo: segue para as próximas aldeias (senão o mesmo
        // lote seria recusado a cada ciclo e as outras páginas nunca sairiam).
        if ((error as { code?: string }).code === 'GAME_REFUSED') {
          ctx.storage.set('massPage', pageNo >= lastPage ? 0 : pageNo + 1);
          ctx.again?.(60_000);
        }
        throw error;
      }
      const { accepted, refused } = result;
      const aldeias = new Set(plan.requests.map((r) => r.villageId)).size;
      const tropas = unitsTotal(plan.requests);
      // Mesma página de novo se sobrou aldeia (teto de 50 grupos); senão, a próxima.
      const next = plan.leftover ? pageNo : pageNo >= lastPage ? 0 : pageNo + 1;
      ctx.storage.set('massPage', next);
      if (plan.leftover || next !== 0) ctx.again?.(60_000);
      ctx.storage.set('lastBatch', { at: Date.now(), villages: aldeias, squads: accepted, units: tropas });
      const reservaTxt = plan.reserved > 0 ? ` ${plan.reserved} aldeia(s) guardaram tropas para comandos do Agendador.` : '';
      const seguir = plan.leftover || next !== 0 ? ' Ainda faltam aldeias — continuo em 1 min.' : ' Todas as aldeias conferidas; a próxima rodada vem no próximo ciclo.';
      ctx.status(
        `Coleta enviada: ${accepted} coleta(s) em ${aldeias} aldeia(s) (${tropas.toLocaleString('pt-BR')} tropas).` +
          seguir +
          (refused.length > 0 ? ` O jogo recusou ${refused.length}: ${[...new Set(refused)].join(' · ')}. As outras saíram; as recusadas entram na próxima rodada.` : '') +
          reservaTxt +
          notesText(notes),
        refused.length > 0 ? 'warn' : 'ok',
      );
      return;
    }
    pageNo = pageNo >= lastPage ? 0 : pageNo + 1;
    if (pageNo === start) break; // deu a volta em todas as páginas
  }
  ctx.storage.set('massPage', pageNo);
  if (unlock !== null) {
    await unlockScavengeLevel(unlock.villageId, unlock.levelId);
    ctx.status(`Nada para coletar agora — pedi o desbloqueio da ${DURATION_LABEL[unlock.levelId] ?? unlock.levelId} Coleta em ${unlock.name} (o jogo aceitou).`, 'ok');
    return;
  }
  const continua = pageNo !== start && pageNo !== 0;
  if (continua) ctx.again?.(60_000);
  ctx.status(
    `Nada a enviar agora: níveis ocupados, tropas abaixo do mínimo ou grupos em "Não coletar".${continua ? ' Sigo conferindo as outras aldeias em 1 min.' : ' Confiro de novo no próximo ciclo.'}` +
      notesText(notes),
    'info',
  );
}

async function runCycle(ctx: TshCycleContext): Promise<void> {
  const parsed = collectionSettings.safeParse(ctx.storage.get('settings', DEFAULT_SETTINGS));
  if (!parsed.success) {
    ctx.status('Configurações de coleta inválidas — nada foi feito. Revise em Configurar.', 'warn');
    return;
  }
  const saved = savedExecMode(ctx.world);
  const execMode = saved.mode ?? parsed.data.execMode;
  if (execMode === 'fundo') {
    await runBackground(ctx, parsed.data);
    return;
  }
  if (new URLSearchParams(window.location.search).get('screen') !== 'place') {
    ctx.status(
      saved.legacy
        ? 'Novo na 3.6: a Coleta pode rodar em TODAS as aldeias sem abrir a tela — escolha "Segundo plano" em Configurar. Por enquanto ela segue só na tela de Coleta, como antes.'
        : 'Modo "Só na tela": abra Praça → Coletar recursos para a Coleta agir (ou escolha "Segundo plano" em Configurar).',
      'info',
    );
    return;
  }
  await runScreenCycle(ctx);
}

export const collectionAutomation: TshAutomation = {
  id: 'collection',
  label: 'Coleta',
  desc: 'Coleta automática: divide as tropas pelos níveis livres (em todas as aldeias, em segundo plano, ou só na tela de Coleta), respeita o que fica em casa e os comandos do Agendador.',
  category: 'producao',
  screen: null,
  cooldownMs: 10 * 60_000,
  settingsPanel: (settings, world) => buildCollectionPanel(settings, world),
  mutating: true,
  settingsForm: SETTINGS_FORM,
  settingsDefaults: DEFAULT_SETTINGS,
  runCycle,
};

registerTsh(collectionAutomation);
