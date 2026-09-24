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
import { tripHalt } from '../../../core/halt';
import { awaitRoutineMutation } from '../tsh-humanize';
import { postGameForm } from './onda5-form-post';
import {
  massRecruitBody,
  parseMassRecruit,
  parseTrainScreen,
  planVillageRecruit,
  type RecruitUnit,
} from './recruitment-mass';
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
  /** v3.8.0: 'fundo' = todas as aldeias pelo Recrutamento em massa; 'tela' = só com a tela de recrutamento aberta. */
  execMode: z.enum(['fundo', 'tela']).default('fundo'),
  /** Recursos que ficam SEMPRE na aldeia (para construir). */
  keepResources: z.number().int().min(0).default(0),
  /** No máximo quanto de cada tropa por envio (0 = sem limite) — espalha o recrutamento. */
  batchMax: z.number().int().min(0).default(0),
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



/** Modo salvo: quem já usava (settings sem execMode) segue em 'tela' até escolher. */
function savedRecruitMode(world: string): { mode: 'fundo' | 'tela' | null; legacy: boolean } {
  const raw = gm.get<Record<string, unknown> | null>(`tsh-auto:${world}:recruitment:settings`, null);
  if (raw === null || typeof raw !== 'object' || Object.keys(raw).length === 0) return { mode: null, legacy: false };
  if (raw.execMode === 'fundo' || raw.execMode === 'tela') {
    const since = typeof raw.legacyTela === 'number' ? raw.legacyTela : 0;
    return { mode: raw.execMode, legacy: raw.execMode === 'tela' && Date.now() - since < 7 * 24 * 60 * 60_000 };
  }
  // Grava a escolha: a tela de Configurar passa a mostrar "Só na tela" (e não o padrão novo). Aviso por 7 dias.
  gm.set(`tsh-auto:${world}:recruitment:settings`, { ...raw, execMode: 'tela', legacyTela: Date.now() });
  return { mode: 'tela', legacy: true };
}

/** Metas por aldeia: globais, ou do modelo do grupo (grupoId:modeloId). */
async function goalsResolver(
  ctx: TshCycleContext,
  settings: RecruitmentSettings,
  notes: Set<string>,
): Promise<((vid: string, existing: Partial<Record<UnitType, number>>) => Partial<Record<string, number>>) | null> {
  const global = Object.fromEntries(Object.entries(settings.goals).filter(([u, n]) => UNIT_TYPES.includes(u as UnitType) && n > 0));
  if (!settings.useGroupModels || settings.groupModels.trim() === '') {
    if (settings.useGroupModels) notes.add('Modelos por grupo ligados sem mapeamento — valem as metas por tropa.');
    return () => global;
  }
  const parsed = parseGroupModels(settings.groupModels);
  if (!parsed.ok) {
    ctx.status(`Mapeamento de modelos por grupo inválido — nada foi feito (${parsed.reason}).`, 'warn');
    return null;
  }
  const byVillage = new Map<string, TroopModel>();
  for (const entry of parsed.entries) {
    const model = modelFromStorage(ctx.world, entry.modelId);
    if (model === null) {
      notes.add(`Modelo "${entry.modelId}" não encontrado no cofre de modelos.`);
      continue;
    }
    const villages = await getGroupVillages(entry.groupId);
    if (villages.length === 0) {
      // Grupo não lido: as aldeias dele cairiam nas metas gerais (mistura errada de tropas).
      ctx.status(`Não consegui ler as aldeias do grupo ${entry.groupId} dos modelos por grupo — nada foi recrutado neste ciclo.`, 'warn');
      return null;
    }
    for (const v of villages) if (!byVillage.has(String(v.villageId))) byVillage.set(String(v.villageId), model);
  }
  return (vid, existing) => {
    const model = byVillage.get(vid);
    return model === undefined ? global : goalsFromModel(model, existing);
  };
}

function unitsLabel(units: Partial<Record<string, number>>): string {
  return Object.entries(units)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([u, n]) => `${n} ${UNIT_LABEL[u as UnitType] ?? u}`)
    .join(', ');
}

/** Segundo plano: uma página do Recrutamento em massa por ciclo, 1 envio. */
async function runBackground(ctx: TshCycleContext, settings: RecruitmentSettings): Promise<void> {
  const notes = new Set<string>();
  const goalsFor = await goalsResolver(ctx, settings, notes);
  if (goalsFor === null) return;
  const pageNo = ctx.storage.get<number>('massPage', 0);
  const pagePath = `/game.php?village=${ctx.villageId}&screen=train&mode=mass&page=${pageNo}`;
  const page = parseMassRecruit(await pacedGet(pagePath, { fresh: true }));
  if (page === null && pageNo > 0) {
    ctx.storage.set('massPage', 0); // a página sumiu (menos aldeias?) — recomeça do início
    ctx.status('A página seguinte do Recrutamento em massa não abriu — recomeço do início no próximo ciclo.', 'info');
    return;
  }
  if (page === null) {
    ctx.status('Não consegui abrir o Recrutamento em massa — ele só existe com Conta Premium ativa. Nada foi recrutado. Sem Premium, escolha "Só na tela" em Configurar.', 'warn');
    return;
  }
  const next = pageNo < page.lastLinkedPage || page.full ? pageNo + 1 : 0;
  if (page.groupId !== 0) notes.add(`O jogo está mostrando só um grupo de aldeias no Recrutamento em massa: o recrutamento cobre só essas. Para todas, escolha "todos" no menu de grupos do jogo.`);
  const plan = new Map<string, Partial<Record<RecruitUnit, number>>>();
  let noGoals = true;
  let popCap = 0;
  let short = 0;
  for (const v of page.villages) {
    if (settings.maxPopulation > 0 && v.farm.used >= settings.maxPopulation) {
      popCap += 1;
      continue;
    }
    const existing = Object.fromEntries(Object.entries(v.units).map(([u, i]) => [u, i?.existing ?? 0])) as Partial<Record<UnitType, number>>;
    const goals = goalsFor(v.id, existing);
    if (Object.values(goals).some((n) => (n ?? 0) > 0)) noGoals = false;
    const units = planVillageRecruit(v, page.costs, { goals, keepResources: settings.keepResources, batchMax: settings.batchMax, popCeiling: settings.maxPopulation });
    if (Object.keys(units).length > 0) plan.set(v.id, units);
    else if (Object.entries(goals).some(([u, g]) => (g ?? 0) > (v.units[u as RecruitUnit]?.existing ?? 0) + (v.units[u as RecruitUnit]?.running ?? 0))) short += 1;
  }
  ctx.storage.set('massPage', next);
  const extra = [...notes].slice(0, 1).map((n) => ` ${n}`).join('') + (popCap > 0 ? ` ${popCap} aldeia(s) no teto de população.` : '');
  if (noGoals) {
    ctx.status(`Nenhuma meta de recrutamento — abra Configurar e diga quantas tropas cada aldeia deve ter.${extra}`, 'info');
    return;
  }
  if (plan.size === 0) {
    ctx.status(
      `${short > 0 ? `Nada a recrutar agora: ${short} aldeia(s) abaixo da meta, mas sem recurso${settings.keepResources > 0 ? ` (respeitando os ${settings.keepResources.toLocaleString('pt-BR')} que ficam em casa)` : ''}, sem fazenda ou o jogo não deixa agora.` : 'Metas atendidas em todas as aldeias lidas (contando a fila).'}${next !== 0 ? ' Sigo nas próximas aldeias em 1 min.' : ''}${extra}`,
      'info',
    );
    return;
  }
  if (!(await awaitRoutineMutation('recrutamento'))) {
    ctx.storage.set('massPage', pageNo); // nada saiu: a mesma página no próximo ciclo
    ctx.status('Pausa de humanização ativa — o recrutamento fica para o próximo ciclo.', 'info');
    return;
  }
  const body = massRecruitBody(plan);
  const result = await postGameForm(page.action, Object.fromEntries(body.entries()));
  if (!result.ok) {
    if (/captcha/i.test(result.message)) tripHalt('captcha', result.message);
    ctx.status(result.afterMutation ? `${result.message} Confiro de novo no próximo ciclo (sem repetir às cegas).` : `Recrutamento não enviado: ${result.message}`, 'warn');
    return;
  }
  // Confirmação pelo PRÓPRIO jogo: a fila (data-running) das aldeias enviadas subiu?
  const after = parseMassRecruit(await pacedGet(pagePath, { fresh: true }).catch(() => ''));
  const confirmed =
    after === null
      ? null
      : [...plan.keys()].filter((vid) => {
          const antes = page.villages.find((v) => v.id === vid);
          const depois = after.villages.find((v) => v.id === vid);
          if (antes === undefined || depois === undefined) return false;
          return Object.keys(plan.get(vid) ?? {}).some((u) => (depois.units[u as RecruitUnit]?.running ?? 0) > (antes.units[u as RecruitUnit]?.running ?? 0));
        }).length;
  if (next !== 0) ctx.again?.(60_000);
  const total: Partial<Record<string, number>> = {};
  for (const units of plan.values()) for (const [u, n] of Object.entries(units)) total[u] = (total[u] ?? 0) + (n ?? 0);
  if (confirmed === 0) {
    ctx.status(`O jogo não aceitou o recrutamento (a fila não mudou em nenhuma das ${plan.size} aldeia(s)). Nada foi recrutado — confira os recursos e a fazenda.${extra}`, 'warn');
    return;
  }
  ctx.status(
    `Recrutamento enviado em ${confirmed ?? plan.size} aldeia(s)${confirmed !== null && confirmed < plan.size ? ` (de ${plan.size} planejadas — o jogo recusou o resto)` : ''}: ${unitsLabel(total)}.${next !== 0 ? ' Ainda faltam aldeias — continuo em 1 min.' : ''}${extra}`,
    confirmed !== null && confirmed < plan.size ? 'warn' : 'ok',
  );
}

/** Só na tela: a aldeia aberta, pelo formulário da tela de recrutamento. */
async function runScreen(ctx: TshCycleContext, settings: RecruitmentSettings, legacy: boolean): Promise<void> {
  if (new URLSearchParams(window.location.search).get('screen') !== 'train') {
    ctx.status(
      legacy
        ? 'Novo na 3.8: o Recrutamento pode rodar em TODAS as aldeias sem abrir a tela — escolha "Segundo plano" em Configurar. Por enquanto ele segue só na tela de recrutamento, como antes.'
        : 'Modo "Só na tela": abra a tela de recrutamento (Quartel/Estábulo/Oficina) para ele agir.',
      'info',
    );
    return;
  }
  const notes = new Set<string>();
  const goalsFor = await goalsResolver(ctx, settings, notes);
  if (goalsFor === null) return;
  const screen = parseTrainScreen(document.documentElement.outerHTML);
  if (screen === null) {
    ctx.status('Não reconheci a tela de recrutamento — nada foi recrutado.', 'warn');
    return;
  }
  if (settings.maxPopulation > 0 && screen.village.farm.used >= settings.maxPopulation) {
    ctx.status(`População em ${screen.village.farm.used}/${screen.village.farm.max}: no teto configurado (${settings.maxPopulation}) — nada foi recrutado.`, 'info');
    return;
  }
  const existing = Object.fromEntries(Object.entries(screen.village.units).map(([u, i]) => [u, i?.existing ?? 0])) as Partial<Record<UnitType, number>>;
  const goals = goalsFor(ctx.villageId, existing);
  const research = settings.autoResearch ? await researchNote(ctx, Object.keys(goals), Object.keys(screen.village.units) as UnitType[]) : '';
  const extra = [...notes].slice(0, 1).map((n) => ` ${n}`).join('');
  if (!Object.values(goals).some((n) => (n ?? 0) > 0)) {
    ctx.status(`Nenhuma meta de recrutamento — abra Configurar e diga quantas tropas a aldeia deve ter.${extra}`, 'info');
    return;
  }
  const units = planVillageRecruit(screen.village, screen.costs, { goals, keepResources: settings.keepResources, batchMax: settings.batchMax, popCeiling: settings.maxPopulation });
  if (Object.keys(units).length === 0) {
    ctx.status(`Nada a recrutar agora: metas atendidas (contando a fila) ou sem recursos/fazenda.${extra}${research}`, 'info');
    return;
  }
  await recruitUnits(units as Record<string, number>);
  ctx.status(`Recrutamento enviado: ${unitsLabel(units)}.${extra}${research}`, 'ok');
}

async function runCycle(ctx: TshCycleContext): Promise<void> {
  const parsed = recruitmentSettings.safeParse(ctx.storage.get<unknown>('settings', {}));
  if (!parsed.success) {
    ctx.status('Configurações de recrutamento inválidas — nada foi feito. Revise em Configurar.', 'warn');
    return;
  }
  const saved = savedRecruitMode(ctx.world);
  const mode = saved.mode ?? parsed.data.execMode;
  if (mode === 'fundo') await runBackground(ctx, parsed.data);
  else await runScreen(ctx, parsed.data, saved.legacy);
}

export const recruitmentAutomation: TshAutomation = {
  id: 'recruitment',
  label: 'Recrutamento',
  desc: 'Mantém cada aldeia com as tropas-meta: em segundo plano (todas as aldeias, pelo Recrutamento em massa) ou só na tela de recrutamento. Conta a fila, respeita recursos, fazenda e o máximo do jogo.',
  category: 'producao',
  screen: null,
  mutating: true,
  settingsDefaults: { goals: {}, maxPopulation: 0, useGroupModels: false, groupModels: '', autoResearch: false, execMode: 'fundo', keepResources: 0, batchMax: 0 },
  settingsForm: [
    {
      key: 'execMode',
      label: 'Onde roda',
      type: 'select',
      options: [
        { value: 'fundo', label: 'Segundo plano — todas as aldeias (precisa de Conta Premium)' },
        { value: 'tela', label: 'Só na tela de recrutamento (a aldeia aberta)' },
      ],
      help: 'Segundo plano: usa o Recrutamento em massa do jogo e recruta em todas as aldeias, em qualquer tela, um bloco de aldeias por vez. Só na tela: age só na aldeia aberta, com a tela de recrutamento aberta. Quem usava a versão antiga segue em "Só na tela" até escolher aqui.',
    },
    {
      key: 'goals',
      label: 'Metas por unidade',
      type: 'record',
      help: 'Quanto cada aldeia deve ter NO TOTAL, contando as tropas em casa, fora e na fila. Ex.: meta 1.000 lanças, tem 800 e 100 na fila → recruta até 100. 0 = não recruta. Paladino e Nobre não entram (são feitos na Estátua e na Academia).',
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
      ],
    },
    {
      key: 'keepResources',
      label: 'Recursos que ficam em casa (cada tipo)',
      type: 'number',
      min: 0,
      step: 1000,
      help: 'Madeira, argila e ferro que o recrutamento nunca usa (ex.: para construir). 0 = pode usar tudo.',
    },
    {
      key: 'batchMax',
      label: 'Máximo por tropa em cada envio',
      type: 'number',
      min: 0,
      step: 10,
      help: 'Espalha o recrutamento: no máximo isso de cada tropa por vez. 0 = o que couber.',
    },
    {
      key: 'maxPopulation',
      label: 'Teto de população da aldeia',
      type: 'number',
      min: 0,
      step: 100,
      placeholder: '0',
      help: 'Quando a fazenda da aldeia chega nesse número, ela para de recrutar. 0 = sem teto.',
    },

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
      help: 'Cada grupo de aldeias pode seguir um modelo de tropas; sem modelo, valem as Metas acima. Formato por linha: número do grupo:modelo (ex.: 182608:preset:ataque). Modelos prontos: preset:defesa, preset:ataque, preset:lanceiro; os seus: custom:<nome>.',
    },
    {
      key: 'autoResearch',
      label: 'Avisar pesquisas pendentes no Ferreiro',
      type: 'boolean',
      help: 'Só avisa no status quando dá para pesquisar uma tropa das metas (modo "Só na tela"). Não pesquisa nada sozinho.',
    },
  ],
  runCycle,
};

registerTsh(recruitmentAutomation);
