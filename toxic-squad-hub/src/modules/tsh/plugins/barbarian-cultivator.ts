// Cultivador de Bárbaras (userscript) — porta da frente da extensão
// toxic-squad-hub-ext (src/modules/features/farming-suite/plugin.ts,
// barbarianCultivatorPlugin). Na origem o plugin escolhe o primeiro alvo
// bárbaro e o primeiro edifício alvo não protegido a partir do snapshot
// compartilhado — e o page-adapter da extensão nunca popula `targets`, ou seja,
// não havia execução canarada. Aqui a prévia avalia a mesma regra sobre os
// alvos de TEXTO "x|y por linha" (settings.targetsText, todos bárbaros por
// definição) ou, com o texto vazio, sobre a lista local (storage 'targets'),
// com catapultas conhecidas (storage 'troops').
// Onda 4 — execução OPCIONAL (mode 'preview' é o default e nada muda):
// no modo EXECUTAR, o ciclo envia UMA onda de catapultas por ciclo no primeiro
// alvo elegível com o livro-razão ('ledger') liberado, pela Praça de Reunião
// (submitCommand2Step, lane 'humanizado'), com o registro gravado ANTES do
// clique (o passo 2 navega: nunca duplica). O edifício-alvo é PLANEJADO e
// reportado, mas a seleção do edifício é feita na tela de confirmação do jogo —
// o transporte de 2 passos ainda não a define (limitação honesta, não fingida).
// Frescor: alvo coberto pela lista do Mapper ('tsh-auto:<mundo>:auto-farm:targets',
// contrato de leitura com o Auto Farm) passa por `needsRescout` com a config
// que veio na própria lista; sem exploração comprovada o alvo é PULADO
// (fail-closed) — a lista local/texto, sem cobertura do Mapper, é a via
// explícita de execução. A prévia ('last-preview') é gravada SEMPRE.

import { z } from 'zod';
import { registerTsh } from '../tsh-runtime';
import { gm } from '../../../core/storage';
import { isUncertainMutationError, submitCommand2Step } from '../tsh-transport';
import { automationReserveBlock } from '../tsh-reserva';
import { coordinateLinesNote, parseCoordinateLines, serverNowIso } from './op-generator';
import {
  mapperTargetListSchema,
  needsRescout,
  normalizeMapperConfig,
  targetCoordinate,
  type MapperConfig,
  type ScoredTarget,
} from '../../../ext/modules/features/auto-farm/barbarian-mapper';

/** Modos do plugin: prévia (default — nada muda) e execução real. */
export const BARBARIAN_CULTIVATOR_MODES = Object.freeze(['preview', 'executar'] as const);
export type BarbarianCultivatorMode = (typeof BARBARIAN_CULTIVATOR_MODES)[number];

export const barbarianCultivatorSettingsSchema = z.object({
  catapultsPerWave: z.number().int().min(1).default(20),
  protectedBuildings: z.array(z.string()).default(['wood', 'stone', 'iron', 'farm', 'storage']),
  targetBuildings: z.array(z.string()).default(['main', 'barracks', 'stable', 'market']),
  /** Editor de texto "x|y por linha" — alvos bárbaros do Cultivador. */
  targetsText: z.string().max(20_000).default(''),
  mode: z.enum(BARBARIAN_CULTIVATOR_MODES).catch('preview'),
  /** Cooldown por alvo do livro-razão (min): evita repetir a mesma bárbara. */
  cooldownMinutes: z.number().int().min(1).max(10_080).catch(60),
});
export type BarbarianCultivatorSettings = z.infer<typeof barbarianCultivatorSettingsSchema>;

/** Defaults efetivos do schema (o que o plugin assume com settings vazio). */
export const DEFAULT_SETTINGS: BarbarianCultivatorSettings = {
  catapultsPerWave: 20,
  protectedBuildings: ['wood', 'stone', 'iron', 'farm', 'storage'],
  targetBuildings: ['main', 'barracks', 'stable', 'market'],
  targetsText: '',
  mode: 'preview',
  cooldownMinutes: 60,
};

/** Alvo local: fatos mínimos que a regra da origem consome (VillageTarget). */
export const barbarianCultivatorTargetSchema = z.object({
  id: z.string().min(1),
  x: z.number().int().min(0).max(999),
  y: z.number().int().min(0).max(999),
  points: z.number().int().nonnegative().default(0),
  barbarian: z.boolean(),
});
export type BarbarianCultivatorTarget = z.infer<typeof barbarianCultivatorTargetSchema>;

export interface BarbarianCultivatorTextTargets {
  targets: BarbarianCultivatorTarget[];
  invalidLines: number[];
  duplicates: number;
}

/**
 * Texto "x|y por linha" → alvos que o planner lê (id = coordenada, pontos 0,
 * bárbara por definição — o módulo cultiva bárbaras). Linha com segmento
 * extra (ex.: "500|500|3") é inválida AQUI: o Cultivador não tem contrato de
 * nível. Linha inválida é reportada (1-based) e NUNCA vira alvo.
 */
export function barbarianTargetsFromText(text: string): BarbarianCultivatorTextTargets {
  const parsed = parseCoordinateLines(text);
  const invalidLines = [...parsed.invalidLines];
  const targets: BarbarianCultivatorTarget[] = [];
  for (const line of parsed.targets) {
    if (line.extras.length > 0) {
      invalidLines.push(line.line);
      continue;
    }
    targets.push({ id: line.coordinate, x: line.x, y: line.y, points: 0, barbarian: true });
  }
  return { targets, invalidLines: invalidLines.sort((left, right) => left - right), duplicates: parsed.duplicates };
}

export type BarbarianCultivationPlan =
  | Readonly<{ kind: 'NO_WORK'; reason: string }>
  | Readonly<{ kind: 'PLAN'; targetId: string; building: string; catapult: number }>;

/**
 * Planejador puro — mesma regra do plugin da origem: primeiro alvo bárbaro
 * desde que exista edifício alvo fora da lista de protegidos e catapultas
 * suficientes em casa.
 */
export function planBarbarianCultivation(
  settings: BarbarianCultivatorSettings,
  targets: readonly BarbarianCultivatorTarget[],
  catapultsAvailable: number,
): BarbarianCultivationPlan {
  const targetBuilding = settings.targetBuildings.find((building) => !settings.protectedBuildings.includes(building));
  const target = targets.find((candidate) => candidate.barbarian && targetBuilding !== undefined);
  if (!target || !targetBuilding || catapultsAvailable < settings.catapultsPerWave) {
    return { kind: 'NO_WORK', reason: 'Nenhuma construção bárbara está elegível para cultivo.' };
  }
  return { kind: 'PLAN', targetId: target.id, building: targetBuilding, catapult: settings.catapultsPerWave };
}

// ── Livro-razão de execução (ctx.storage 'ledger') ─────────────────────────

const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LEDGER_MAX_TARGETS = 500;

/** Alvo já cultivado pelo Hub: último envio e ondas acumuladas. */
export interface BarbarianCultivatorLedgerEntry {
  readonly lastSentAt: string;
  readonly lastSentAtMs: number;
  readonly attempts: number;
}

/** Livro-razão do Cultivador (alvo → último envio + ondas). */
export interface BarbarianCultivatorLedger {
  readonly version: 1;
  readonly targets: Readonly<Record<string, BarbarianCultivatorLedgerEntry>>;
}

export function createBarbarianCultivatorLedger(): BarbarianCultivatorLedger {
  return Object.freeze({ version: 1 as const, targets: Object.freeze({}) });
}

function isBarbarianCultivatorLedger(value: unknown): value is BarbarianCultivatorLedger {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { version?: unknown; targets?: unknown };
  return record.version === 1 && typeof record.targets === 'object' && record.targets !== null;
}

/** Ledger persistido; conteúdo estranho reinicia vazio (nunca deduz dele). */
export function loadBarbarianCultivatorLedger(raw: unknown): BarbarianCultivatorLedger {
  return isBarbarianCultivatorLedger(raw) ? raw : createBarbarianCultivatorLedger();
}

/**
 * Registra uma onda (chamado ANTES do clique: o passo 2 pode navegar e matar o
 * contexto do ciclo — o registro precisa existir para nunca duplicar). Poda
 * entradas velhas e limita o tamanho do ledger.
 */
export function recordBarbarianCultivation(
  ledger: unknown,
  coordinate: string,
  sentAtMs: number,
  sentAtIso: string,
): BarbarianCultivatorLedger {
  const current = loadBarbarianCultivatorLedger(ledger);
  const entries: [string, BarbarianCultivatorLedgerEntry][] = [];
  const previous = current.targets[coordinate];
  for (const [key, entry] of Object.entries(current.targets)) {
    if (key === coordinate) continue;
    if (!Number.isFinite(entry.lastSentAtMs)) continue; // entrada corrompida não volta para o ledger
    if (sentAtMs - entry.lastSentAtMs <= LEDGER_RETENTION_MS) entries.push([key, entry]);
  }
  entries.push([
    coordinate,
    {
      lastSentAt: sentAtIso,
      lastSentAtMs: sentAtMs,
      attempts: (Number.isFinite(previous?.attempts) ? (previous?.attempts ?? 0) : 0) + 1,
    },
  ]);
  entries.sort((left, right) => left[1].lastSentAtMs - right[1].lastSentAtMs);
  const pruned = entries.slice(Math.max(0, entries.length - LEDGER_MAX_TARGETS));
  const targets: Record<string, BarbarianCultivatorLedgerEntry> = {};
  for (const [key, entry] of pruned) targets[key] = Object.freeze({ ...entry });
  return Object.freeze({ version: 1 as const, targets: Object.freeze(targets) });
}

/** Ondas registradas do alvo (0 = nunca cultivado). */
export function cultivationAttempts(ledger: unknown, coordinate: string): number {
  const entry = loadBarbarianCultivatorLedger(ledger).targets[coordinate];
  if (entry === undefined || !Number.isFinite(entry.attempts) || entry.attempts < 0) return 0;
  return Math.floor(entry.attempts);
}

/**
 * O alvo está em cooldown do livro-razão? Entrada com carimbo inutilizável
 * conta como EM COOLDOWN (fail-closed: sem dado confiável, não repete o envio).
 */
export function isCultivationTargetCoolingDown(
  ledger: unknown,
  coordinate: string,
  nowMs: number,
  cooldownMs: number,
): boolean {
  const entry = loadBarbarianCultivatorLedger(ledger).targets[coordinate];
  if (entry === undefined) return false;
  if (!Number.isFinite(entry.lastSentAtMs)) return true;
  return nowMs - entry.lastSentAtMs < Math.max(0, cooldownMs);
}

// ── Frescor do Mapper (contrato de LEITURA com o Auto Farm) ────────────────

/**
 * A lista do Mapper mora no namespace do plugin Auto Farm (chave COMPLETA —
 * o ctx.storage deste módulo prefixaria com 'cultivador'). Lista ausente ou
 * inválida = sem cobertura: nenhum alvo passa pelo gate de reexploração.
 */
export const autoFarmTargetsKey = (world: string): string => `tsh-auto:${world}:auto-farm:targets`;

export interface CultivatorMapperIndex {
  readonly byCoordinate: ReadonlyMap<string, ScoredTarget>;
  /** Config de frescor que veio NA lista (mesma régua do Auto Farm). */
  readonly config: MapperConfig;
}

/** Índice da lista do Mapper (coordenada → alvo pontuado) validado por zod. */
export function readCultivatorMapperIndex(raw: unknown): CultivatorMapperIndex | null {
  const parsed = mapperTargetListSchema.safeParse(raw);
  if (!parsed.success) return null;
  const byCoordinate = new Map<string, ScoredTarget>();
  for (const target of parsed.data.targets) byCoordinate.set(targetCoordinate(target), target);
  return { byCoordinate, config: normalizeMapperConfig(parsed.data.config) };
}

/** Resumo do Mapper publicado na prévia (visível no painel, sem HTML). */
export function cultivatorMapperNote(mapper: CultivatorMapperIndex | null): string {
  if (mapper === null) return ' Mapper: sem lista válida — nenhum alvo passa pelo gate de reexploração.';
  return ` Mapper: ${mapper.byCoordinate.size} alvo(s) indexados (reexploração: ${mapper.config.updateValue} ${mapper.config.updateMode}).`;
}

// ── Execução (Onda 4): seleção pura ────────────────────────────────────────

export interface BarbarianCultivationExecutionInput {
  readonly settings: BarbarianCultivatorSettings;
  readonly targets: readonly BarbarianCultivatorTarget[];
  readonly catapultsAvailable: number;
  readonly ledger: unknown;
  readonly mapper: CultivatorMapperIndex | null;
  readonly nowMs: number;
}

export type BarbarianCultivationDecision =
  | Readonly<{
      kind: 'EXECUTE';
      targetId: string;
      /** "x|y" — formato canônico do transporte. */
      coordinate: string;
      building: string;
      catapult: number;
      /** Qual onda é esta (1-based, contada no livro-razão). */
      attempt: number;
    }>
  | Readonly<{ kind: 'SKIP'; reason: string }>;

/**
 * Primeiro alvo elegível LIVRE (F2: uma onda por ciclo): bárbaro, com o
 * edifício-alvo e as catapultas do plano, fora do cooldown do livro-razão e —
 * se coberto pela lista do Mapper — com exploração comprovada dentro do
 * horizonte de `needsRescout`. Alvo que precisa de reexploração é pulado em
 * favor do próximo; sem nenhum livre, o motivo diz quantos caíram em cada
 * gate (nunca "nada foi enviado" sem explicação).
 */
export function selectBarbarianCultivationExecution(
  input: BarbarianCultivationExecutionInput,
): BarbarianCultivationDecision {
  const plan = planBarbarianCultivation(input.settings, input.targets, input.catapultsAvailable);
  if (plan.kind === 'NO_WORK') return Object.freeze({ kind: 'SKIP', reason: plan.reason });
  const mapper = input.mapper;
  const cooldownMs = input.settings.cooldownMinutes * 60_000;
  let rescout = 0;
  let cooling = 0;
  for (const target of input.targets) {
    if (!target.barbarian) continue;
    const coordinate = `${target.x}|${target.y}`;
    const mapperTarget = mapper === null ? undefined : mapper.byCoordinate.get(coordinate);
    if (mapperTarget !== undefined && mapper !== null && needsRescout(mapperTarget, mapper.config, input.nowMs)) {
      rescout += 1;
      continue;
    }
    if (isCultivationTargetCoolingDown(input.ledger, coordinate, input.nowMs, cooldownMs)) {
      cooling += 1;
      continue;
    }
    return Object.freeze({
      kind: 'EXECUTE',
      targetId: target.id,
      coordinate,
      building: plan.building,
      catapult: plan.catapult,
      attempt: cultivationAttempts(input.ledger, coordinate) + 1,
    });
  }
  return Object.freeze({
    kind: 'SKIP',
    reason: `Nenhum alvo elegível livre: ${rescout} exigem nova exploração (Mapper) e ${cooling} estão no cooldown de ${input.settings.cooldownMinutes} min do livro-razão.`,
  });
}

/** Resumo da execução do ciclo (status). */
export type BarbarianCultivationExecutionSummary =
  | Readonly<{
      outcome: 'ENVIADO';
      coordinate: string;
      building: string;
      catapult: number;
      attempt: number;
    }>
  | Readonly<{ outcome: 'PULADO'; reason: string }>
  | Readonly<{ outcome: 'FALHA'; reason: string }>
  | Readonly<{ outcome: 'BLOQUEADO'; reason: string }>;

/** Status do ciclo (puro — testável): prévia sempre legível, execução honesta. */
export function barbarianCultivationStatusMessage(input: {
  plan: BarbarianCultivationPlan;
  mode: BarbarianCultivatorMode;
  note: string;
  mapperNote: string;
  execution?: BarbarianCultivationExecutionSummary;
}): { message: string; kind: 'ok' | 'info' | 'warn' } {
  const noteSuffix = `${input.note !== '' ? ` ${input.note}` : ''}${input.mapperNote}`;
  if (input.mode === 'preview') {
    if (input.plan.kind === 'PLAN') {
      return {
        message: `Prévia Cultivador de Bárbaras: alvo ${input.plan.targetId}, edifício ${input.plan.building}, ${input.plan.catapult} catapultas —${noteSuffix} Prévia, sem execução.`,
        kind: 'ok',
      };
    }
    return { message: `${input.plan.reason}${noteSuffix} Prévia, sem execução.`, kind: 'info' };
  }
  const execution = input.execution;
  switch (execution?.outcome) {
    case 'ENVIADO':
      return {
        message: `Cultivador de Bárbaras: onda de ${execution.catapult} catapultas enviada para ${execution.coordinate} (tentativa ${execution.attempt}, faixa humanizada). Edifício planejado: ${execution.building} — a escolha do edifício é feita na tela de confirmação do jogo.`,
        kind: 'ok',
      };
    case 'PULADO':
      return { message: `Nada foi enviado: ${execution.reason}`, kind: 'info' };
    case 'FALHA':
      return { message: `Envio falhou: ${execution.reason}`, kind: 'warn' };
    case 'BLOQUEADO':
      return { message: `Execução bloqueada: ${execution.reason}`, kind: 'warn' };
    default:
      return { message: 'Nada foi enviado neste ciclo.', kind: 'info' };
  }
}

/** Agora na perspectiva do SERVIDOR (header do jogo), em epoch ms. */
function serverNowMs(): number {
  const parsed = Date.parse(serverNowIso());
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** A Praça de Reunião (ou sua tela de confirmação) está aberta para o envio? */
function isCommandScreenOpen(): boolean {
  return document.querySelector('#command-data-form, form[action*="screen=place"][action*="action=command"]') !== null;
}

registerTsh({
  id: 'barbarian-cultivator',
  label: 'Cultivador de Bárbaras',
  desc: 'Prévia + execução opcional: escolhe o alvo bárbaro e o edifício alvo da onda de catapultas; no modo EXECUTAR (com o módulo armado) envia 1 onda por ciclo pela Praça de Reunião, na faixa humanizada.',
  category: 'planejamento',
  screen: null,
  // Onda 4: o módulo MUTA o jogo no modo EXECUTAR — o runtime exige opt-in +
  // armar 30min (mesma postura do Auto Farm). A prévia é o default do modo.
  mutating: true,
  settingsDefaults: DEFAULT_SETTINGS,
  // Ficam FORA do formulário: protectedBuildings/targetBuildings são LISTAS de
  // edifícios e a lista 'targets' do storage não é escalar do settings — o
  // TEXTO "x|y por linha" abaixo é o editor dessa lista no painel.
  settingsForm: [
    {
      key: 'mode',
      label: 'Modo',
      type: 'select',
      options: [
        { value: 'preview', label: 'Prévia (somente leitura)' },
        { value: 'executar', label: 'Executar (1 onda por ciclo)' },
      ],
      help: 'Prévia é o padrão: nada é enviado. EXECUTAR envia 1 onda de catapultas por ciclo pela Praça de Reunião (exige o módulo armado).',
    },
    {
      key: 'catapultsPerWave',
      label: 'Catapultas por onda',
      type: 'number',
      min: 1,
      help: 'Precisa haver esta quantidade em casa para a prévia formar a onda.',
    },
    {
      key: 'cooldownMinutes',
      label: 'Cooldown por alvo (min)',
      type: 'number',
      min: 1,
      max: 10_080,
      help: 'Tempo mínimo entre ondas no MESMO alvo (livro-razão). O ciclo sempre passa para o próximo alvo livre.',
    },
    {
      key: 'targetsText',
      label: 'Alvos (texto)',
      type: 'textarea',
      placeholder: '500|500\n501|503',
      help: 'Coordenadas x|y de bárbaras, uma por linha. Preenchido, substitui a lista "targets" do JSON; vazio, vale a lista salva. Linha inválida é ignorada e avisada no status.',
    },
  ],
  async runCycle(ctx): Promise<void> {
    const settings = barbarianCultivatorSettingsSchema.parse(ctx.storage.get('settings', DEFAULT_SETTINGS));
    const fromText = settings.targetsText.trim() !== '';
    const textTargets = fromText ? barbarianTargetsFromText(settings.targetsText) : null;
    const targets =
      textTargets !== null
        ? textTargets.targets
        : z.array(barbarianCultivatorTargetSchema).parse(ctx.storage.get<unknown>('targets', []));
    const troops = z
      .object({ catapult: z.number().int().nonnegative().default(0) })
      .parse(ctx.storage.get<unknown>('troops', {}));
    const plan = planBarbarianCultivation(settings, targets, troops.catapult);
    const note = textTargets !== null ? coordinateLinesNote('targetsText', textTargets) : '';
    // Frescor do Mapper: a lista é LIDA (nunca gravada aqui) no namespace do
    // Auto Farm; lista ausente/inválida não cobre alvo nenhum.
    const mapper = readCultivatorMapperIndex(gm.get<unknown>(autoFarmTargetsKey(ctx.world), null));
    const mapperNote = cultivatorMapperNote(mapper);
    const ledger = ctx.storage.get<unknown>('ledger', null);
    const preview = {
      ...plan,
      generatedAt: new Date().toISOString(),
      source: textTargets !== null ? 'targetsText' : 'targets',
      targetsConsidered: targets.length,
      mode: settings.mode,
      mapperTargets: mapper?.byCoordinate.size ?? 0,
      mapperPolicy: mapper === null ? null : `${mapper.config.updateValue} ${mapper.config.updateMode}`,
    };
    // A prévia é gravada SEMPRE — antes de qualquer mutação (o passo 1 do
    // comando navega e pode destruir o contexto do ciclo).
    ctx.storage.set('last-preview', preview);
    if (settings.mode !== 'executar') {
      const status = barbarianCultivationStatusMessage({ plan, mode: settings.mode, note, mapperNote });
      ctx.status(status.message, status.kind);
      return;
    }

    // ── Execução: 1 onda por ciclo, das regras mais baratas à mutação ──────
    let execution: BarbarianCultivationExecutionSummary;
    if (!isCommandScreenOpen()) {
      execution = {
        outcome: 'BLOQUEADO',
        reason: 'abra a Praça de Reunião (screen=place) — o envio usa o formulário da tela.',
      };
    } else {
      const nowMs = serverNowMs();
      const decision = selectBarbarianCultivationExecution({
        settings,
        targets,
        catapultsAvailable: troops.catapult,
        ledger,
        mapper,
        nowMs,
      });
      const reserva = decision.kind === 'SKIP' ? null : automationReserveBlock(ctx.world, ctx.villageId, { catapult: decision.catapult });
      if (decision.kind === 'SKIP') {
        execution = { outcome: 'PULADO', reason: decision.reason };
      } else if (reserva !== null) {
        // v3.5.0: catapultas reservadas para um comando agendado desta aldeia.
        execution = { outcome: 'PULADO', reason: reserva };
      } else {
        // Ledger ANTES do clique (o passo 2 navega): nunca duplica o envio.
        ctx.storage.set(
          'ledger',
          recordBarbarianCultivation(ledger, decision.coordinate, nowMs, new Date(nowMs).toISOString()),
        );
        try {
          await submitCommand2Step(decision.coordinate, { catapult: decision.catapult }, { attack: true, lane: 'humanizado' });
          execution = {
            outcome: 'ENVIADO',
            coordinate: decision.coordinate,
            building: decision.building,
            catapult: decision.catapult,
            attempt: decision.attempt,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          execution = isUncertainMutationError(error)
            ? { outcome: 'PULADO', reason: `envio inconclusivo (${message}) — alvo mantido no ledger, sem repetição.` }
            : { outcome: 'FALHA', reason: `${message} A onda ficou no ledger do alvo.` };
        }
      }
    }

    ctx.storage.set('last-preview', { ...preview, execution });
    const status = barbarianCultivationStatusMessage({ plan, mode: settings.mode, note, mapperNote, execution });
    ctx.status(status.message, status.kind);
  },
});
