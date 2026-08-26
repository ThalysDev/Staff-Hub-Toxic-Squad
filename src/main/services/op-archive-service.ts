import { randomUUID } from 'node:crypto';
import type { Journal } from '../journal';
import { JsonStore } from '../stores/json-store';
import type {
  OpArchiveEntry,
  OpConferenceSnapshot,
  OpSaveInput,
  OpTotalsSnapshot,
} from '@shared/ipc-types';
import {
  capOps,
  createOpEntry,
  findOpById,
  normalizeOpInput,
  opNotFoundError,
  sortNewestFirst,
  updateOpEntry,
  upsertOp,
  withConference,
} from '@shared/op-archive-rules';

/** Forma persistida do arquivo de OPs (userData/stores/op-archive.json). */
export interface OpArchiveStore {
  ops: OpArchiveEntry[];
}

/**
 * Arquivo de OPs (P0-9): memória histórica das operações da tribo. Service
 * fino — validação, merge, teto de 200 e ordenação moram em regras puras
 * (@shared/op-archive-rules); aqui é só JsonStore + journal. Sem rede e sem
 * sessão do jogo: arquivar é local.
 */
export class OpArchiveService {
  private readonly store = new JsonStore<OpArchiveStore>('op-archive', { ops: [] });

  constructor(
    private readonly journal: Journal,
  ) {}

  /** OPs arquivadas, mais recente primeiro. */
  async list(): Promise<OpArchiveEntry[]> {
    const store = await this.store.load();
    return sortNewestFirst(store.ops);
  }

  /**
   * Cria (sem id) ou atualiza (com id) uma OP. Atualização preserva
   * createdAt/conference/totals; inexistente = erro fail-closed. Aplica o
   * teto de 200 mantendo a OP salva mesmo sendo a mais antiga.
   */
  async save(input: OpSaveInput): Promise<OpArchiveEntry> {
    const data = normalizeOpInput(input);
    const store = await this.store.load();
    const existing = input.id === undefined ? undefined : findOpById(store.ops, input.id);
    if (input.id !== undefined && existing === undefined) throw opNotFoundError(input.id);
    const entry = existing === undefined
      ? createOpEntry(data, input.distribution, input.sendSchedule, randomUUID(), new Date().toISOString())
      : updateOpEntry(existing, data, input.distribution, input.sendSchedule);
    await this.store.save({ ops: capOps(upsertOp(store.ops, entry), entry.id) });
    await this.journal.append('system', 'op-archive-save', `título=${entry.title} alvos=${entry.targets.length} ${existing === undefined ? 'novo' : 'atualizado'}`, false);
    return entry;
  }

  /** Substitui a conferência da OP; totals substitui quando informado. */
  async attachConference(id: string, conference: OpConferenceSnapshot, totals?: OpTotalsSnapshot[]): Promise<OpArchiveEntry> {
    const store = await this.store.load();
    const existing = findOpById(store.ops, id);
    if (existing === undefined) throw opNotFoundError(id);
    const entry = withConference(existing, conference, totals);
    await this.store.save({ ops: capOps(upsertOp(store.ops, entry), entry.id) });
    await this.journal.append('system', 'op-archive-conference', `título=${entry.title} cobertura=${conference.coveragePct}%${totals === undefined ? '' : ` totais=${totals.length} jogadores`}`, false);
    return entry;
  }

  /** Remove a OP do arquivo (confirmação fica na UI). */
  async remove(id: string): Promise<void> {
    const store = await this.store.load();
    const existing = findOpById(store.ops, id);
    if (existing === undefined) throw opNotFoundError(id);
    await this.store.save({ ops: store.ops.filter((op) => op.id !== id) });
    await this.journal.append('system', 'op-archive-remove', `título=${existing.title} (id=${id})`, false);
  }
}
