import { z } from 'zod';
import { SUPPORT_UNITS, type PlannedSupportCommand, type SupportUnitAmounts } from './support-planner';

/**
 * Seleção de execução do Apoio em Massa — lógica pura da Onda A: escolhe o
 * PRÓXIMO comando do plano na ordem determinística, respeitando a restrição
 * de transporte (a Praça de Reunião só envia da aldeia cuja tela está aberta)
 * e o dedupe por id canônico, e mapeia o comando para a action CERTIFICADA
 * do Agendador (`command-scheduler`). Nenhuma mutação de jogo acontece aqui;
 * a integração no plugin (module-plugins.ts) é da Onda B.
 *
 * Restrições do contrato de ciclo do Hub (1 mutação por ciclo): o selecionado
 * é SEMPRE o primeiro comando da ordem canônica que parte da aldeia atual e
 * ainda não foi enviado — nada de ordem aleatória, janela ou reenvio.
 */

const isoTimestampSchema = z.string().datetime({ offset: true });

/** Ordem canônica do planner (support-planner.ts `commandComparator`): alvo → duração → origem → id. */
export const supportCommandComparator = (left: PlannedSupportCommand, right: PlannedSupportCommand): number =>
  left.targetCoordinate.localeCompare(right.targetCoordinate) ||
  left.durationSeconds - right.durationSeconds ||
  left.sourceCoordinate.localeCompare(right.sourceCoordinate) ||
  left.id.localeCompare(right.id);

export interface SupportExecutionContext {
  /** Aldeia da aba aberta (a Praça de Reunião só envia daqui — mesma restrição do balanceador avançado). */
  sourceVillageId: string;
  /** IDs canônicos (`command_<hex16>`) já enviados nesta sessão: dedupe por id do plano. */
  executedCommandIds: readonly string[];
  /**
   * Instante de referência do ciclo (ms). Presente, comandos cujo ENVIO é
   * futuro ficam agendados (nenhuma action nasce antes de `sendAt − lead`):
   * um comando de defesa com chegada agendada enviado no ciclo em que nasce
   * chegaria adiantado (`now + duração` em vez da chegada marcada).
   * Ausente = todos os comandos são elegíveis (comportamento de prévia).
   */
  nowMs?: number;
  /** Antecedência máxima de envio antes do sendAt (default SUPPORT_SEND_LEAD_MS). */
  sendLeadMs?: number;
}

export type SupportCommandSelection =
  { command: PlannedSupportCommand; reason: string } | { command: null; reason: string };

/** Antecedência de envio aceita antes do sendAt (mesma ordem do focusLead do Agendador). */
export const SUPPORT_SEND_LEAD_MS = 15_000;

/** Momento de envio do comando: chegada agendada − duração de viagem. */
export const supportCommandSendAtMs = (command: PlannedSupportCommand): number =>
  Date.parse(command.arrivalAt) - command.durationSeconds * 1000;

/** Comando elegível no ciclo: sendAt já alcançado (com a folga do lead). */
export const isSupportCommandDue = (
  command: PlannedSupportCommand,
  nowMs: number,
  sendLeadMs = SUPPORT_SEND_LEAD_MS,
): boolean => supportCommandSendAtMs(command) <= nowMs + sendLeadMs;

/**
 * Próximo comando de apoio a executar: copia ordena pela ordem canônica do
 * planner, filtra pela aldeia da aba, pula os já enviados e — com `nowMs` no
 * contexto — mantém AGENDADOS os comandos de envio futuro (nenhuma action
 * nasce antes da janela de envio). Sem elegível, devolve razão pt-BR no
 * estilo NO_WORK do Hub (benigno para o ciclo armado).
 */
export const selectNextSupportCommand = (
  commands: readonly PlannedSupportCommand[],
  context: SupportExecutionContext,
): SupportCommandSelection => {
  if (commands.length === 0) {
    return Object.freeze({ command: null, reason: 'Nenhum comando de apoio planejado para esta sessão.' });
  }
  const fromHere = [...commands]
    .sort(supportCommandComparator)
    .filter((command) => command.sourceVillageId === context.sourceVillageId);
  if (fromHere.length === 0) {
    return Object.freeze({ command: null, reason: 'Nenhum comando parte desta aldeia.' });
  }
  const eligible =
    context.nowMs === undefined
      ? fromHere
      : fromHere.filter((command) => isSupportCommandDue(command, context.nowMs!, context.sendLeadMs));
  const executed = new Set(context.executedCommandIds);
  const next = eligible.find((command) => !executed.has(command.id));
  if (next !== undefined) {
    return Object.freeze({
      command: next,
      reason: `Enviar apoio de ${next.sourceCoordinate} para ${next.targetCoordinate} (população ${next.population}).`,
    });
  }
  // Sem elegível: se resta trabalho FUTURO desta aldeia, o estado é agendado
  // (comando de envio à frente não pode ter sido enviado ainda); só declara
  // "todos enviados" quando nenhum comando futuro permanece.
  const notDue =
    context.nowMs === undefined
      ? []
      : fromHere.filter((command) => !isSupportCommandDue(command, context.nowMs!, context.sendLeadMs));
  if (notDue.length > 0) {
    const upcoming = notDue.reduce((earliest, command) =>
      supportCommandSendAtMs(command) < supportCommandSendAtMs(earliest) ? command : earliest,
    );
    const sendAt = new Date(supportCommandSendAtMs(upcoming)).toISOString();
    return Object.freeze({
      command: null,
      reason: `Comando agendado: envio de ${upcoming.sourceCoordinate} para ${upcoming.targetCoordinate} sai às ${sendAt} (chegada ${upcoming.arrivalAt}) — aguardando a janela de envio.`,
    });
  }
  return Object.freeze({ command: null, reason: 'Todos os comandos planejados já foram enviados.' });
};

/**
 * Kind da action certificada do Agendador (Praça de Reunião, `#command-data-form`,
 * 2 passos: preencher e enviar → `command-confirm`). Reusada AS IS: nenhum
 * transporte novo é inventado. O payload carrega o kind 'support' — a Praça
 * tem DOIS submits nomeados (#target_attack/#target_support) e o transporte
 * clica o botão do tipo do comando (doc vivo 20/08/2026).
 */
export const SUPPORT_COMMAND_ACTION_KIND = 'command-scheduler' as const;

export interface SupportCommandAction {
  kind: typeof SUPPORT_COMMAND_ACTION_KIND;
  payload: {
    commandId: string;
    /** Tipo do comando: apoio em massa é sempre APOIO (nunca o botão de ataque). */
    kind: 'support';
    target: { x: number; y: number };
    units: SupportUnitAmounts;
  };
}

/**
 * Mapeia um comando planejado para a action certificada do Agendador:
 * coordenada `x|y` do planner viram `target: { x, y }` e as 7 unidades de
 * apoio entram SEMPRE completas com zero onde ausentes — o transporte itera
 * as chaves do payload e um campo omitido deixaria o valor anterior do
 * formulário vivo (contaminação entre ciclos).
 */
export const toSupportCommandAction = (command: PlannedSupportCommand): SupportCommandAction => {
  const [rawX, rawY] = command.targetCoordinate.split('|');
  const x = Number(rawX);
  const y = Number(rawY);
  // Domínio do planner (`0|0`..`999|999`): fora disso o plano não poderia ter
  // sido produzido — coordenada corrompida nunca vira ação.
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 999 || y > 999) {
    throw new TypeError(`Invalid coordinate: ${command.targetCoordinate}`);
  }
  const units: SupportUnitAmounts = { spear: 0, sword: 0, archer: 0, spy: 0, light: 0, marcher: 0, heavy: 0 };
  for (const unit of SUPPORT_UNITS) units[unit] = Math.max(0, Math.floor(command.units[unit] ?? 0));
  return deepFreeze({
    kind: SUPPORT_COMMAND_ACTION_KIND,
    payload: { commandId: command.id, kind: 'support', target: { x, y }, units },
  });
};

/**
 * Livro-razão de comandos já executados por mundo — JSON puro (shape
 * compatível com as convenções de estado do Hub: `structuredClone`-ável,
 * sem datas/código). O id canônico do plano (`command_<hex16>`) é a chave de
 * dedupe entre ciclos; entradas são ordenadas por executedAt e depois id.
 */
export const supportExecutionLedgerEntrySchema = z
  .object({
    commandId: z.string().regex(/^command_[0-9a-f]{16}$/),
    executedAt: isoTimestampSchema,
  })
  .strict();

export const supportExecutionLedgerSchema = z
  .object({
    version: z.literal(1),
    worlds: z.record(z.string(), z.array(supportExecutionLedgerEntrySchema)),
  })
  .strict();

export type SupportExecutionLedgerEntry = z.infer<typeof supportExecutionLedgerEntrySchema>;

export interface SupportExecutionLedger {
  version: 1;
  worlds: Record<string, readonly SupportExecutionLedgerEntry[]>;
}

export interface SupportExecutionAppendInput {
  worldId: string;
  commandId: string;
  executedAt: string;
}

export interface SupportExecutionPruneInput {
  /** Instante de referência (ISO); entradas mais antigas que retentionMs caem. */
  now: string;
  retentionMs: number;
  /** Limite opcional de entradas por mundo (mantém as MAIS RECENTES). */
  maxEntriesPerWorld?: number;
}

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

const entryComparator = (left: SupportExecutionLedgerEntry, right: SupportExecutionLedgerEntry): number =>
  Date.parse(left.executedAt) - Date.parse(right.executedAt) || left.commandId.localeCompare(right.commandId);

export const createSupportExecutionLedger = (): SupportExecutionLedger => deepFreeze({ version: 1, worlds: {} });

/**
 * Registra um comando executado: idempotente (o mesmo id no mesmo mundo não
 * duplica) e determinístico (ordem por executedAt, desempate por id).
 */
export const appendSupportExecution = (
  ledger: SupportExecutionLedger,
  input: SupportExecutionAppendInput,
): SupportExecutionLedger => {
  const current = supportExecutionLedgerSchema.parse(ledger);
  const entry = supportExecutionLedgerEntrySchema.parse({ commandId: input.commandId, executedAt: input.executedAt });
  const existing = current.worlds[input.worldId] ?? [];
  if (existing.some((item) => item.commandId === entry.commandId)) return deepFreeze(current);
  const next = [...existing, entry].sort(entryComparator);
  return deepFreeze({ ...current, worlds: { ...current.worlds, [input.worldId]: next } });
};

export const hasExecutedSupportCommand = (
  ledger: SupportExecutionLedger,
  worldId: string,
  commandId: string,
): boolean => {
  const current = supportExecutionLedgerSchema.parse(ledger);
  return (current.worlds[worldId] ?? []).some((item) => item.commandId === commandId);
};

/** IDs executados do mundo, na ordem determinística do livro-razão (para o dedupe da sessão). */
export const listExecutedSupportCommandIds = (ledger: SupportExecutionLedger, worldId: string): readonly string[] => {
  const current = supportExecutionLedgerSchema.parse(ledger);
  return Object.freeze((current.worlds[worldId] ?? []).map((item) => item.commandId));
};

/**
 * Poda por retenção: remove entradas mais antigas que `now - retentionMs` e,
 * com `maxEntriesPerWorld`, mantém apenas as N mais recentes. Mundos que
 * ficam vazios são removidos do livro-razão (determinístico).
 */
export const pruneSupportExecutionLedger = (
  ledger: SupportExecutionLedger,
  input: SupportExecutionPruneInput,
): SupportExecutionLedger => {
  const current = supportExecutionLedgerSchema.parse(ledger);
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be an ISO timestamp');
  if (!Number.isFinite(input.retentionMs) || input.retentionMs < 0) {
    throw new TypeError('retentionMs must be a nonnegative finite number');
  }
  const cutoffMs = nowMs - input.retentionMs;
  const cap = input.maxEntriesPerWorld === undefined ? undefined : Math.floor(Math.max(0, input.maxEntriesPerWorld));
  const worlds: Record<string, readonly SupportExecutionLedgerEntry[]> = {};
  for (const [worldId, entries] of Object.entries(current.worlds)) {
    const kept = entries.filter((entry) => Date.parse(entry.executedAt) >= cutoffMs);
    let limited = kept;
    if (cap !== undefined) {
      limited = cap <= 0 ? [] : kept.length > cap ? kept.slice(kept.length - cap) : kept;
    }
    if (limited.length > 0) worlds[worldId] = limited;
  }
  return deepFreeze({ ...current, worlds });
};
