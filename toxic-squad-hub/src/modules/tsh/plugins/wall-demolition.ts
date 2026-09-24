// Demolidor de Muralhas (userscript) — porta da frente da extensão
// toxic-squad-hub-ext (src/modules/features/farming-suite/plugin.ts,
// wallDemolitionPlugin). Na origem o plugin planeja a primeira onda de aríetes
// sobre um alvo com muralha mínima a partir do snapshot compartilhado — e o
// page-adapter da extensão nunca popula `targets` (lista sempre vazia), ou
// seja, não havia execução canarada. Aqui a prévia avalia a mesma regra sobre
// os alvos de TEXTO "x|y|nível" (settings.targetsText; sem nível = muralha 0,
// nunca elegível) ou, com o texto vazio, sobre a lista local (storage
// 'targets'), com tropas conhecidas (storage 'troops').
// Onda 4 — execução OPCIONAL (mode 'preview' é o default e nada muda):
// no modo EXECUTAR, o ciclo envia UMA onda de aríetes por ciclo no 1º alvo
// elegível com tentativas sobrando no livro-razão ('ledger'), pela Praça de
// Reunião (submitCommand2Step, lane 'humanizado' — demolição é rotina), com o
// registro gravado ANTES do clique (o passo 2 navega e mata o contexto: nunca
// duplica). O alvo precisa ter muralha >= minWallLevel e aríetes em casa; cada
// alvo aceita no máximo `maxAttempts` ondas, contadas no ledger. A prévia
// ('last-preview') é gravada SEMPRE, também no modo EXECUTAR.

import { z } from 'zod';
import { registerTsh } from '../tsh-runtime';
import { isUncertainMutationError, submitCommand2Step } from '../tsh-transport';
import { automationReserveBlock } from '../tsh-reserva';
import { coordinateLinesNote, parseCoordinateLines, serverNowIso } from './op-generator';

/** Modos do plugin: prévia (default — nada muda) e execução real. */
export const WALL_DEMOLITION_MODES = Object.freeze(['preview', 'executar'] as const);
export type WallDemolitionMode = (typeof WALL_DEMOLITION_MODES)[number];

export const wallDemolitionSettingsSchema = z.object({
  minRams: z.number().int().min(1).default(10),
  maxAttempts: z.number().int().min(1).max(10).default(1),
  minWallLevel: z.number().int().min(1).default(1),
  /** Editor de texto "x|y por linha" (opcional "x|y|nível da muralha"). */
  targetsText: z.string().max(20_000).default(''),
  mode: z.enum(WALL_DEMOLITION_MODES).catch('preview'),
});
export type WallDemolitionSettings = z.infer<typeof wallDemolitionSettingsSchema>;

/** Defaults efetivos do schema (o que o plugin assume com settings vazio). */
export const DEFAULT_SETTINGS: WallDemolitionSettings = {
  minRams: 10,
  maxAttempts: 1,
  minWallLevel: 1,
  targetsText: '',
  mode: 'preview',
};

/** Alvo local: fatos mínimos que a regra da origem consome (VillageTarget). */
export const wallDemolitionTargetSchema = z.object({
  id: z.string().min(1),
  x: z.number().int().min(0).max(999),
  y: z.number().int().min(0).max(999),
  points: z.number().int().nonnegative().default(0),
  wallLevel: z.number().int().min(0),
  barbarian: z.boolean().default(false),
});
export type WallDemolitionTarget = z.infer<typeof wallDemolitionTargetSchema>;

export interface WallDemolitionTextTargets {
  targets: WallDemolitionTarget[];
  invalidLines: number[];
  duplicates: number;
}

/**
 * Texto "x|y por linha" → alvos que o planner lê (id = coordenada, pontos 0).
 * O segmento opcional "x|y|nível" define a muralha do alvo (o planner só
 * forma onda com muralha >= minWallLevel); sem nível a muralha conta como 0.
 * Linha inválida é reportada (número 1-based) e NUNCA vira alvo.
 */
export function wallTargetsFromText(text: string): WallDemolitionTextTargets {
  const parsed = parseCoordinateLines(text);
  return {
    targets: parsed.targets.map((line) => ({
      id: line.coordinate,
      x: line.x,
      y: line.y,
      points: 0,
      wallLevel: line.extras.length > 0 ? Number(line.extras[0] ?? 0) : 0,
      barbarian: false,
    })),
    invalidLines: [...parsed.invalidLines],
    duplicates: parsed.duplicates,
  };
}

export type WallDemolitionPlan =
  | Readonly<{ kind: 'NO_WORK'; reason: string }>
  | Readonly<{ kind: 'PLAN'; targetId: string; ram: number; attempts: number }>;

/**
 * Planejador puro — mesma regra do plugin da origem: primeiro alvo com
 * muralha >= minWallLevel desde que haja aríetes suficientes em casa.
 */
export function planWallDemolition(
  settings: WallDemolitionSettings,
  targets: readonly WallDemolitionTarget[],
  ramsAvailable: number,
): WallDemolitionPlan {
  if (targets.length === 0) {
    return { kind: 'NO_WORK', reason: 'Nenhum alvo cadastrado na lista local — a prévia fica sem candidato.' };
  }
  const target = targets.find(
    (candidate) => candidate.wallLevel >= settings.minWallLevel && ramsAvailable >= settings.minRams,
  );
  if (!target) {
    return { kind: 'NO_WORK', reason: 'Nenhuma muralha elegível possui aríetes suficientes.' };
  }
  return { kind: 'PLAN', targetId: target.id, ram: settings.minRams, attempts: settings.maxAttempts };
}

// ── Livro-razão de execução (ctx.storage 'ledger') ─────────────────────────

const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LEDGER_MAX_TARGETS = 500;

/** Alvo já atacado pelo Hub: último envio e tentativas consumidas. */
export interface WallDemolitionLedgerEntry {
  readonly lastSentAt: string;
  readonly lastSentAtMs: number;
  readonly attempts: number;
}

/** Livro-razão do Demolidor (alvo → último envio + tentativas). */
export interface WallDemolitionLedger {
  readonly version: 1;
  readonly targets: Readonly<Record<string, WallDemolitionLedgerEntry>>;
}

export function createWallDemolitionLedger(): WallDemolitionLedger {
  return Object.freeze({ version: 1 as const, targets: Object.freeze({}) });
}

function isWallDemolitionLedger(value: unknown): value is WallDemolitionLedger {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { version?: unknown; targets?: unknown };
  return record.version === 1 && typeof record.targets === 'object' && record.targets !== null;
}

/** Ledger persistido; conteúdo estranho reinicia vazio (nunca deduz dele). */
export function loadWallDemolitionLedger(raw: unknown): WallDemolitionLedger {
  return isWallDemolitionLedger(raw) ? raw : createWallDemolitionLedger();
}

/**
 * Registra uma onda (chamado ANTES do clique: o passo 2 pode navegar e matar o
 * contexto do ciclo — o registro precisa existir para nunca duplicar). Poda
 * entradas velhas e limita o tamanho do ledger.
 */
export function recordWallDemolitionAttempt(
  ledger: unknown,
  coordinate: string,
  sentAtMs: number,
  sentAtIso: string,
): WallDemolitionLedger {
  const current = loadWallDemolitionLedger(ledger);
  const entries: [string, WallDemolitionLedgerEntry][] = [];
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
  const targets: Record<string, WallDemolitionLedgerEntry> = {};
  for (const [key, entry] of pruned) targets[key] = Object.freeze({ ...entry });
  return Object.freeze({ version: 1 as const, targets: Object.freeze(targets) });
}

/**
 * Tentativas registradas do alvo (0 = nunca atacado). Entrada presente com
 * contagem inválida devolve null — o seletor trata como ESGOTADO (fail-closed:
 * sem dado confiável, não repete a onda).
 */
export function wallDemolitionAttempts(ledger: unknown, coordinate: string): number | null {
  const entry = loadWallDemolitionLedger(ledger).targets[coordinate];
  if (entry === undefined) return 0;
  if (!Number.isFinite(entry.attempts) || entry.attempts < 0) return null;
  return Math.floor(entry.attempts);
}

/** Progresso por alvo elegível (tentativas usadas e restantes) — status/prévia. */
export interface WallDemolitionProgressEntry {
  readonly coordinate: string;
  readonly attempts: number;
  readonly remaining: number;
}

export function wallDemolitionProgress(
  settings: WallDemolitionSettings,
  targets: readonly WallDemolitionTarget[],
  ledger: unknown,
): readonly WallDemolitionProgressEntry[] {
  const progress: WallDemolitionProgressEntry[] = [];
  for (const target of targets) {
    if (target.wallLevel < settings.minWallLevel) continue;
    const coordinate = `${target.x}|${target.y}`;
    const attempts = wallDemolitionAttempts(ledger, coordinate) ?? settings.maxAttempts;
    progress.push(
      Object.freeze({ coordinate, attempts, remaining: Math.max(0, settings.maxAttempts - attempts) }),
    );
  }
  return Object.freeze(progress);
}

/** Nota curta do progresso (até 3 alvos; o resto é resumido). */
export function wallDemolitionProgressNote(progress: readonly WallDemolitionProgressEntry[]): string {
  if (progress.length === 0) return '';
  const shown = progress
    .slice(0, 3)
    .map((entry) => `${entry.coordinate} ${entry.attempts} usada(s)/${entry.remaining} restante(s)`);
  const extra = progress.length > 3 ? ` +${progress.length - 3} alvo(s)` : '';
  return ` Progresso do livro-razão: ${shown.join('; ')}${extra}.`;
}

// ── Execução (Onda 4): seleção pura ────────────────────────────────────────

export interface WallDemolitionExecution {
  readonly targetId: string;
  /** "x|y" — formato canônico do transporte. */
  readonly coordinate: string;
  readonly ram: number;
  /** Teto de tentativas do plano (settings.maxAttempts). */
  readonly attempts: number;
  /** Qual tentativa é esta (1-based). */
  readonly attempt: number;
}

export type WallDemolitionExecutionDecision =
  | Readonly<{ kind: 'EXECUTE'; execution: WallDemolitionExecution }>
  | Readonly<{ kind: 'SKIP'; reason: string }>;

/**
 * Primeiro alvo elegível com tentativas sobrando no livro-razão (F2: uma onda
 * por ciclo). Alvo sem muralha mínima ou sem aríetes em casa não entra; alvo
 * que já consumiu `maxAttempts` é pulado em favor do próximo elegível.
 */
export function selectWallDemolitionExecution(
  settings: WallDemolitionSettings,
  targets: readonly WallDemolitionTarget[],
  ramsAvailable: number,
  ledger: unknown,
): WallDemolitionExecutionDecision {
  if (targets.length === 0) {
    return Object.freeze({ kind: 'SKIP', reason: 'Nenhum alvo cadastrado na lista local — não há onda para executar.' });
  }
  if (ramsAvailable < settings.minRams) {
    return Object.freeze({ kind: 'SKIP', reason: 'Nenhuma muralha elegível possui aríetes suficientes.' });
  }
  let eligible = 0;
  let exhausted = 0;
  for (const target of targets) {
    if (target.wallLevel < settings.minWallLevel) continue;
    eligible += 1;
    const coordinate = `${target.x}|${target.y}`;
    const attempts = wallDemolitionAttempts(ledger, coordinate);
    if (attempts === null || attempts >= settings.maxAttempts) {
      exhausted += 1;
      continue;
    }
    return Object.freeze({
      kind: 'EXECUTE',
      execution: Object.freeze({
        targetId: target.id,
        coordinate,
        ram: settings.minRams,
        attempts: settings.maxAttempts,
        attempt: attempts + 1,
      }),
    });
  }
  if (eligible === 0) {
    return Object.freeze({ kind: 'SKIP', reason: 'Nenhuma muralha elegível possui aríetes suficientes.' });
  }
  return Object.freeze({
    kind: 'SKIP',
    reason: `Todos os ${eligible} alvo(s) elegíveis já esgotaram as ${settings.maxAttempts} tentativa(s) no livro-razão.`,
  });
}

/** Resumo da execução do ciclo (status). */
export type WallDemolitionExecutionSummary =
  | Readonly<{ outcome: 'ENVIADO'; coordinate: string; ram: number; attempt: number; attempts: number }>
  | Readonly<{ outcome: 'PULADO'; reason: string }>
  | Readonly<{ outcome: 'FALHA'; reason: string }>
  | Readonly<{ outcome: 'BLOQUEADO'; reason: string }>;

/** Status do ciclo (puro — testável): prévia sempre legível, execução honesta. */
export function wallDemolitionStatusMessage(input: {
  plan: WallDemolitionPlan;
  mode: WallDemolitionMode;
  progress: readonly WallDemolitionProgressEntry[];
  note: string;
  levelHint: string;
  execution?: WallDemolitionExecutionSummary;
}): { message: string; kind: 'ok' | 'info' | 'warn' } {
  const noteSuffix = `${input.note !== '' ? ` ${input.note}` : ''}`;
  const progressNote = wallDemolitionProgressNote(input.progress);
  if (input.mode === 'preview') {
    if (input.plan.kind === 'PLAN') {
      return {
        message: `Prévia Demolidor de Muralhas: alvo ${input.plan.targetId} com ${input.plan.ram} aríetes (${input.plan.attempts} tentativa(s)) —${noteSuffix}${progressNote} Prévia, sem execução.`,
        kind: 'ok',
      };
    }
    return {
      message: `${input.plan.reason}${input.levelHint}${noteSuffix}${progressNote} Prévia, sem execução.`,
      kind: 'info',
    };
  }
  const execution = input.execution;
  switch (execution?.outcome) {
    case 'ENVIADO':
      return {
        message: `Demolidor de Muralhas: onda de ${execution.ram} aríetes enviada para ${execution.coordinate} (tentativa ${execution.attempt}/${execution.attempts}, faixa humanizada).${progressNote}`,
        kind: 'ok',
      };
    case 'PULADO':
      return { message: `Nada foi enviado: ${execution.reason}${progressNote}`, kind: 'info' };
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
  id: 'wall-demolition',
  label: 'Demolidor de Muralhas',
  desc: 'Prévia + execução opcional: planeja a onda de aríetes sobre o 1º alvo com muralha mínima; no modo EXECUTAR (com o módulo armado) envia 1 onda por ciclo pela Praça de Reunião, na faixa humanizada.',
  category: 'planejamento',
  screen: null,
  // Onda 4: o módulo MUTA o jogo no modo EXECUTAR — o runtime exige opt-in +
  // armar 30min (mesma postura do Auto Farm). A prévia é o default do modo.
  mutating: true,
  settingsDefaults: DEFAULT_SETTINGS,
  // Ficam FORA do formulário: a lista 'targets' do storage (objetos com
  // muralha/pontos) e 'troops' não são escalares do settings — o TEXTO
  // "x|y|nível" abaixo é o editor dessa lista no painel.
  settingsForm: [
    {
      key: 'mode',
      label: 'Modo',
      type: 'select',
      options: [
        { value: 'preview', label: 'Prévia (somente leitura)' },
        { value: 'executar', label: 'Executar (1 onda por ciclo)' },
      ],
      help: 'Prévia é o padrão: nada é enviado. EXECUTAR envia 1 onda de aríetes por ciclo pela Praça de Reunião (exige o módulo armado).',
    },
    { key: 'minRams', label: 'Aríetes por onda', type: 'number', min: 1, help: 'Precisa haver esta quantidade em casa para a prévia formar a onda.' },
    { key: 'maxAttempts', label: 'Máximo de tentativas', type: 'number', min: 1, max: 10, help: 'Ondas por alvo no livro-razão: esgotadas, o ciclo passa para o próximo alvo elegível.' },
    { key: 'minWallLevel', label: 'Nível mínimo da muralha', type: 'number', min: 1, help: 'Só alvos com muralha neste nível ou acima entram na prévia.' },
    {
      key: 'targetsText',
      label: 'Alvos (texto)',
      type: 'textarea',
      placeholder: '501|504|6\n505|510',
      help: 'Uma coordenada x|y por linha, com o nível da muralha opcional: "x|y|nível" (ex.: 501|504|6). Preenchido, substitui a lista "targets" do JSON; vazio, vale a lista salva. Sem nível a muralha conta como 0 — a prévia não forma onda. Linha inválida é ignorada e avisada no status.',
    },
  ],
  async runCycle(ctx): Promise<void> {
    const settings = wallDemolitionSettingsSchema.parse(ctx.storage.get('settings', DEFAULT_SETTINGS));
    const fromText = settings.targetsText.trim() !== '';
    const textTargets = fromText ? wallTargetsFromText(settings.targetsText) : null;
    const targets =
      textTargets !== null
        ? textTargets.targets
        : z.array(wallDemolitionTargetSchema).parse(ctx.storage.get<unknown>('targets', []));
    const troops = z
      .object({ ram: z.number().int().nonnegative().default(0) })
      .parse(ctx.storage.get<unknown>('troops', {}));
    const plan = planWallDemolition(settings, targets, troops.ram);
    const note = textTargets !== null ? coordinateLinesNote('targetsText', textTargets) : '';
    // Texto sem nível nenhum: a muralha conta como 0 e NADA é elegível —
    // o motivo honesto precisa dizer isso, não "falta aríete".
    const allLevelZero =
      textTargets !== null && textTargets.targets.length > 0 && textTargets.targets.every((target) => target.wallLevel === 0);
    const levelHint =
      plan.kind === 'NO_WORK' && allLevelZero
        ? ' Dica: informe o nível da muralha no texto ("x|y|nível", ex.: 501|504|6) — sem nível nenhum alvo é elegível.'
        : '';
    const ledger = ctx.storage.get<unknown>('ledger', null);
    const progress = wallDemolitionProgress(settings, targets, ledger);
    const preview = {
      ...plan,
      generatedAt: new Date().toISOString(),
      source: textTargets !== null ? 'targetsText' : 'targets',
      targetsConsidered: targets.length,
      mode: settings.mode,
      progress,
    };
    // A prévia é gravada SEMPRE — antes de qualquer mutação (o passo 1 do
    // comando navega e pode destruir o contexto do ciclo).
    ctx.storage.set('last-preview', preview);
    if (settings.mode !== 'executar') {
      const status = wallDemolitionStatusMessage({ plan, mode: settings.mode, progress, note, levelHint });
      ctx.status(status.message, status.kind);
      return;
    }

    // ── Execução: 1 onda por ciclo, das regras mais baratas à mutação ──────
    let execution: WallDemolitionExecutionSummary;
    if (!isCommandScreenOpen()) {
      execution = {
        outcome: 'BLOQUEADO',
        reason: 'abra a Praça de Reunião (screen=place) — o envio usa o formulário da tela.',
      };
    } else {
      const decision = selectWallDemolitionExecution(settings, targets, troops.ram, ledger);
      let reservaMuro: string | null = null;
      if (decision.kind === 'SKIP') {
        execution = { outcome: 'PULADO', reason: decision.reason };
      } else if ((reservaMuro = automationReserveBlock(ctx.world, ctx.villageId, { ram: decision.execution.ram })) !== null) {
        // v3.5.0: aríetes reservados para um comando agendado desta aldeia.
        execution = { outcome: 'PULADO', reason: reservaMuro };
      } else {
        const wave = decision.execution;
        const nowMs = serverNowMs();
        // Ledger ANTES do clique (o passo 2 navega): nunca duplica o envio.
        ctx.storage.set(
          'ledger',
          recordWallDemolitionAttempt(ledger, wave.coordinate, nowMs, new Date(nowMs).toISOString()),
        );
        try {
          await submitCommand2Step(wave.coordinate, { ram: wave.ram }, { attack: true, lane: 'humanizado' });
          execution = {
            outcome: 'ENVIADO',
            coordinate: wave.coordinate,
            ram: wave.ram,
            attempt: wave.attempt,
            attempts: wave.attempts,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          execution = isUncertainMutationError(error)
            ? { outcome: 'PULADO', reason: `envio inconclusivo (${message}) — alvo mantido no ledger, sem repetição.` }
            : { outcome: 'FALHA', reason: `${message} A tentativa ficou no ledger do alvo.` };
        }
      }
    }

    const finalProgress = wallDemolitionProgress(settings, targets, ctx.storage.get<unknown>('ledger', null));
    ctx.storage.set('last-preview', { ...preview, progress: finalProgress, execution });
    const status = wallDemolitionStatusMessage({
      plan,
      mode: settings.mode,
      progress: finalProgress,
      note,
      levelHint,
      execution,
    });
    ctx.status(status.message, status.kind);
  },
});
