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
// - Onda 5b: MODELOS POR GRUPO (settings.useGroupModels + groupModels,
//   "grupoId:modeloId" por linha, parse puro) — as metas da aldeia atual vêm
//   do modelo do grupo a que ela pertence (grupos lidos pelo tsh-groups com
//   cache; leitura vazia = "não lido", avisa e mantém as metas atuais). A
//   resolução do grupo vive aqui e é exportada (groupIdForVillage) porque a
//   Coleta usa a mesma regra por grupo.
// - AUTO-PESQUISA (settings.autoResearch): após recrutar, o ciclo LÊ a tela do
//   Ferreiro (pacedGet com cache de 10 min — o plugin roda em 'train', então a
//   leitura é de rede) e apenas PLANEJA: reporta "pesquisa X disponível — vá ao
//   Ferreiro". NENHUM POST nesta onda (a mutação fica para o transporte
//   futuro). Fail-closed: leitura/parse sem confirmação não afirma nada.

import { z } from 'zod';
import { registerTsh, type TshAutomation, type TshCycleContext } from '../tsh-runtime';
import { recruitUnits } from '../tsh-transport';
import { pacedGet } from '../../../core/net';
import { gm } from '../../../core/storage';
import { getGroupOptions, getGroupVillages } from '../tsh-groups';
import {
  normalizeTroopModelStore,
  resolveModelUnits,
  troopModelById,
  type TroopModel,
} from '../../../ext/core/troop-models/troop-models';
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

/** Rótulos pt-BR das unidades (mensagens de status). */
const UNIT_LABEL: Record<UnitType, string> = {
  spear: 'Lança',
  sword: 'Espada',
  axe: 'Machado',
  archer: 'Arqueiro',
  spy: 'Explorador',
  light: 'Cav. Leve',
  marcher: 'Arq. Cavalo',
  heavy: 'Cav. Pesada',
  ram: 'Aríete',
  catapult: 'Catapulta',
  knight: 'Paladino',
  snob: 'Nobre',
};

/** TTL da leitura do Ferreiro na auto-pesquisa (parcimônia: 1 leitura/10min). */
const RESEARCH_READ_TTL_MS = 10 * 60_000;

const recruitmentSettings = z.object({
  horizonMinutes: z.number().int().min(1).default(60),
  reservePopulation: z.number().int().min(0).default(0),
  goals: z.record(z.string(), z.number().int().nonnegative()).default({}),
  maxPopulation: z.number().int().min(0).default(0),
  /** Metas pelo modelo do grupo da aldeia (Onda 5b). */
  useGroupModels: z.boolean().default(false),
  /** "grupoId:modeloId" por linha (textarea). */
  groupModels: z.string().default(''),
  /** Planeja a pesquisa do Ferreiro (report-only nesta onda). */
  autoResearch: z.boolean().default(false),
});

type RecruitmentSettings = z.infer<typeof recruitmentSettings>;

// ── Grupos de aldeias (Onda 5b — compartilhado com a Coleta) ────────────────

/**
 * Grupo da aldeia atual, resolvido pelos grupos do jogo (tsh-groups: dropdown
 * + aldeias por grupo, ambos com cache). Contrato do tsh-groups: leitura VAZIA
 * é "não lido" — devolvemos null (o chamador avisa e NÃO filtra tudo).
 * `villageId` aceita o id cru ou com prefixo n. A varredura para no primeiro
 * grupo que contém a aldeia e tem teto de grupos (20) para limitar a rede no
 * pior caso; cada leitura de grupo já é cacheada por 5 min pelo tsh-groups.
 */
export async function groupIdForVillage(world: string, villageId: string): Promise<number | null> {
  const wanted = villageId.replace(/^n/, '');
  if (wanted === '') return null;
  const cacheKey = `group-map:${world}:${wanted}`;
  const cached = gm.get<{ groupId: number; at: number } | null>(cacheKey, null);
  if (cached !== null && Date.now() - cached.at < 10 * 60_000) return cached.groupId;
  const groups = await getGroupOptions();
  for (const group of groups.slice(0, 20)) {
    const villages = await getGroupVillages(group.groupId);
    if (villages.length === 0) continue; // "não lido" — não é resposta
    if (villages.some((village) => String(village.villageId) === wanted)) {
      gm.set(cacheKey, { groupId: group.groupId, at: Date.now() });
      return group.groupId;
    }
  }
  return null;
}

// ── Modelos por grupo (puros — testáveis) ───────────────────────────────────

export interface GroupModelEntry {
  groupId: number;
  modelId: string;
}

/**
 * Parser PURO do textarea "grupoId:modeloId" (uma linha por linha vazia
 * ignorada). Modelo aceito: `preset:<slug>` ou `custom:<slug>` (o formato
 * canônico dos modelos de tropa). Linha inválida derruba o parse INTEIRO com o
 * motivo (fail-closed: rotear um grupo para o modelo errado seria pior que não
 * usar modelo nenhum).
 */
export function parseGroupModels(
  text: string,
): { ok: true; entries: GroupModelEntry[] } | { ok: false; reason: string } {
  const entries: GroupModelEntry[] = [];
  const seen = new Set<number>();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parts = line.split(':');
    const bad = (detail: string): { ok: false; reason: string } => ({
      ok: false,
      reason: `linha ${index + 1} ("${line}") ${detail} — use "grupoId:modeloId" (ex.: 182608:preset:ataque).`,
    });
    if (parts.length < 3) return bad('não tem os 2 campos');
    const groupId = Number((parts[0] ?? '').trim());
    if (!Number.isInteger(groupId) || groupId <= 0) return bad('tem grupo inválido');
    const modelId = parts.slice(1).join(':').trim();
    if (!/^(preset|custom):[A-Za-z0-9][A-Za-z0-9._-]*$/.test(modelId)) {
      return bad('tem modelo inválido (use preset:<nome> ou custom:<nome>)');
    }
    if (seen.has(groupId)) return bad(`repete o grupo ${groupId}`);
    seen.add(groupId);
    entries.push({ groupId, modelId });
  }
  return { ok: true, entries };
}

/** Modelo de um grupo (null = sem entrada para o grupo). */
export function modelForGroup(entries: GroupModelEntry[], groupId: number | null): string | null {
  if (groupId === null) return null;
  return entries.find((entry) => entry.groupId === groupId)?.modelId ?? null;
}

/**
 * Chave do cofre de modelos de tropa POR MUNDO (Onda 0: `normalizeTroopModelStore`).
 * Convenção nova do userscript no espírito do `tsh-groups:<mundo>` — quem
 * gravar modelos deve usar ESTA chave para o recrutamento enxergá-los.
 */
export function troopModelsKey(world: string): string {
  return `tsh-models:${world}`;
}

/** Modelo do cofre do mundo pelo id (presets resolvem sempre; custom ausente = null). */
export function modelFromStorage(world: string, modelId: string): TroopModel | null {
  return troopModelById(normalizeTroopModelStore(gm.get<unknown>(troopModelsKey(world), {})), modelId) ?? null;
}

/**
 * Metas de recrutamento do modelo (PURA, Onda 5b): valor NUMÉRICO do modelo é
 * a meta absoluta da unidade; `'max'` ("tudo que houver") é resolvido pelo
 * engine da Onda 0 (resolveModelUnits) contra o efetivo atual — mantém o que a
 * aldeia já tem e não gera déficit (recrutar "max" sem fim não é meta).
 * Unidades fora do modelo ficam fora das metas (meta 0 = não recruta).
 */
export function goalsFromModel(
  model: TroopModel,
  current: Partial<Record<UnitType, number>>,
): Partial<Record<UnitType, number>> {
  const maxResolved = resolveModelUnits(model, current);
  const goals: Partial<Record<UnitType, number>> = {};
  for (const [unit, value] of Object.entries(model.units)) {
    if (value === undefined) continue;
    const goal = value === 'max' ? (maxResolved[unit as UnitType] ?? 0) : Math.max(0, Math.floor(value));
    if (goal > 0) goals[unit as UnitType] = goal;
  }
  return goals;
}

// ── Auto-pesquisa (Onda 5b — planejamento puro) ─────────────────────────────

/**
 * Pesquisas DISPONÍVEIS na tela do Ferreiro (PURA): só o link canônico de
 * pesquisa (`action=research` com a unidade em `id=`/`type=`, a mesma família
 * do `action=upgrade_building` do transporte) conta — qualquer outra coisa
 * (texto solto, link de ampliação) é ignorada. Sem link legível a lista sai
 * VAZIA: o ciclo não afirma "pesquisa disponível" sem confirmação (fail-closed).
 */
export function parseResearchOptions(html: string): UnitType[] {
  const found: UnitType[] = [];
  for (const match of html.matchAll(/action=research[^"'&\s]*[^"']*?[?&](?:id|type)=([a-z_]+)/gi)) {
    const unit = (match[1] ?? '').toLowerCase() as UnitType;
    if (!UNIT_TYPES.includes(unit) || found.includes(unit)) continue;
    found.push(unit);
  }
  return found;
}

/**
 * Pesquisas a reportar (PURA): unidades com META que ainda não aparecem no
 * formulário de recrutamento (não pesquisadas) E que o Ferreiro oferece agora.
 * A interseção é o que dá para afirmar sem chutar; a ordem é a das metas.
 */
export function planResearch(goalUnits: string[], trainable: readonly UnitType[], available: UnitType[]): UnitType[] {
  const trainableSet = new Set<string>(trainable);
  const availableSet = new Set<string>(available);
  return goalUnits.filter((unit) => !trainableSet.has(unit) && availableSet.has(unit)) as UnitType[];
}

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

/** Efetivo atual das 12 unidades (base da resolução dos modelos do grupo). */
function readCurrentUnits(doc: Document): Partial<Record<UnitType, number>> {
  const counts: Partial<Record<UnitType, number>> = {};
  for (const unit of UNIT_TYPES) {
    const count = readUnitCount(doc, unit);
    if (count > 0) counts[unit] = count;
  }
  return counts;
}

/**
 * Nota da auto-pesquisa (Onda 5b): LÊ o Ferreiro (pacedGet, cache de 10 min em
 * storage para parcimônia) e devolve o que reportar no status. NÃO muta nada:
 * a pesquisa fica para o transporte futuro. Falha de leitura → nota honesta,
 * nunca uma afirmação de disponibilidade (fail-closed).
 */
async function researchNote(
  ctx: TshCycleContext,
  goalUnits: string[],
  trainable: readonly UnitType[],
): Promise<string> {
  const cache = ctx.storage.get<{ at: number; units: UnitType[] } | null>('research-cache', null);
  let available: UnitType[];
  if (cache !== null && Date.now() - cache.at < RESEARCH_READ_TTL_MS) {
    available = cache.units;
  } else {
    try {
      const html = await pacedGet(`/game.php?village=${encodeURIComponent(ctx.villageId)}&screen=smith`);
      available = parseResearchOptions(html);
      ctx.storage.set('research-cache', { at: Date.now(), units: available });
    } catch {
      return ' Não foi possível ler o Ferreiro agora — nada foi pesquisado (tente no próximo ciclo).';
    }
  }
  const candidates = planResearch(goalUnits, trainable, available);
  if (candidates.length === 0) return '';
  return ` Pesquisa ${candidates.map((unit) => UNIT_LABEL[unit]).join(', ')} disponível — vá à Ferreiro (nada foi enviado).`;
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
  let goals = Object.entries(settings.goals).filter(
    ([unit, amount]) => UNIT_TYPES.includes(unit as UnitType) && amount > 0,
  );
  // Modelos por grupo (Onda 5b): metas da aldeia vêm do modelo do SEU grupo.
  // Sem grupo identificado/modelo/sem regra → metas atuais (com nota no status).
  let groupNote = '';
  if (settings.useGroupModels) {
    if (settings.groupModels.trim() === '') {
      groupNote = ' Modelos por grupo ligados sem mapeamento "grupoId:modeloId" — usando as metas por unidade.';
    } else {
      const parsedModels = parseGroupModels(settings.groupModels);
      if (!parsedModels.ok) {
        ctx.status(
          `Mapeamento de modelos por grupo inválido — nada foi feito (${parsedModels.reason}).`,
          'warn',
        );
        return;
      }
      const groupId = await groupIdForVillage(ctx.world, ctx.villageId);
      const modelId = modelForGroup(parsedModels.entries, groupId);
      if (modelId === null) {
        groupNote =
          groupId === null
            ? ' Grupo da aldeia não identificado (leitura de grupos vazia/indisponível) — usando as metas por unidade.'
            : ` Sem modelo para o grupo ${groupId} — usando as metas por unidade.`;
      } else {
        const model = modelFromStorage(ctx.world, modelId);
        if (model === null) {
          groupNote = ` Modelo "${modelId}" não encontrado no cofre de modelos deste mundo — usando as metas por unidade.`;
        } else {
          const modelGoals = goalsFromModel(model, readCurrentUnits(document));
          goals = Object.entries(modelGoals).filter(
            ([unit, amount]) => UNIT_TYPES.includes(unit as UnitType) && amount > 0,
          );
          groupNote = ` Metas do modelo "${model.name}" (grupo ${groupId}).`;
        }
      }
    }
  }
  if (goals.length === 0) {
    ctx.status(
      `Nenhuma meta de recrutamento configurada — abra "Configurar" e defina as quantidades-alvo.${groupNote}`,
      'info',
    );
    return;
  }
  if (hasActiveTrainQueue(document)) {
    ctx.status(`Já existe um recrutamento em andamento nesta aldeia.${groupNote}`, 'info');
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
  const goalUnits = goals.map(([unit]) => unit);
  const candidates = goals
    .map(([unit, goal]) => {
      const typed = unit as UnitType;
      return { unit: typed, goal, current: readUnitCount(document, typed), trainable: screen.trainable.has(typed) };
    })
    .filter((candidate) => candidate.current < candidate.goal && candidate.trainable)
    .sort((left, right) => left.current / left.goal - right.current / right.goal);
  // Auto-pesquisa (Onda 5b): só PLANEJA e reporta — nenhuma mutação aqui.
  const research = settings.autoResearch
    ? await researchNote(ctx, goalUnits, [...screen.trainable])
    : '';
  if (candidates.length === 0) {
    const unresearched = goals.filter(([unit]) => !screen.trainable.has(unit as UnitType));
    ctx.status(
      `${
        unresearched.length > 0
          ? 'Há metas para unidades ainda não pesquisadas no Ferreiro desta aldeia.'
          : 'Todas as metas de recrutamento estão atendidas.'
      }${groupNote}${research}`,
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
      `Recursos insuficientes para recrutar ${candidate.unit} agora (meta ${candidate.goal}, tem ${candidate.current}).${groupNote}${research}`,
      'info',
    );
    return;
  }
  // F2: UMA mutação por ciclo — 1 submit com o lote cabível da meta mais carente.
  await recruitUnits({ [candidate.unit]: amount });
  ctx.status(
    `Recrutamento enviado: ${amount} ${candidate.unit} (meta ${candidate.goal}, tinha ${candidate.current}).${groupNote}${research}`,
    'ok',
  );
}

export const recruitmentAutomation: TshAutomation = {
  id: 'recruitment',
  label: 'Recrutamento',
  desc: 'Metas por unidade (ou pelo modelo do grupo da aldeia) na tela do Quartel/Estábulo/Oficina: recruta o lote cabível da unidade mais carente (1 submit por ciclo).',
  category: 'producao',
  screen: 'train',
  mutating: true,
  settingsDefaults: { goals: {}, maxPopulation: 0, useGroupModels: false, groupModels: '', autoResearch: false },
  settingsForm: [
    {
      key: 'useGroupModels',
      label: 'Usar modelos de tropa por grupo',
      type: 'boolean',
      help: 'Ligado, as metas desta aldeia vêm do modelo do grupo a que ela pertence (mapeamento abaixo) em vez das metas por unidade.',
    },
    {
      key: 'groupModels',
      label: 'Modelos por grupo (um por linha)',
      type: 'textarea',
      placeholder: '182608:preset:ataque\n182622:custom:defesa-5k',
      help: 'Formato "grupoId:modeloId" (ex.: 182608:preset:ataque). Modelos: preset:dispensar/lanceiro/lanca-com-cl, defesa, ataque ou custom:<nome> do cofre de modelos. Sem grupo identificado (leitura vazia) ou sem modelo para o grupo, valem as metas por unidade — o status avisa.',
    },
    {
      key: 'autoResearch',
      label: 'Auto-pesquisa (somente planejar)',
      type: 'boolean',
      help: 'Após recrutar, lê o Ferreiro (cache de 10 min) e reporta no status "pesquisa X disponível — vá ao Ferreiro". Nesta versão NADA é pesquisado automaticamente (a mutação fica para o transporte futuro).',
    },
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
