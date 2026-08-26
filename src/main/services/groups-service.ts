import { randomUUID } from 'node:crypto';
import type { Journal } from '../journal';
import { JsonStore } from '../stores/json-store';
import type { GroupEntry, GroupSaveInput } from '@shared/groups-rules';
import {
  capGroups,
  createGroupEntry,
  findGroupById,
  groupNotFoundError,
  groupPayloadForExport,
  normalizeGroupInput,
  parseGroupPayload,
  sortNewestFirst,
  updateGroupEntry,
  upsertGroup,
} from '@shared/groups-rules';

/** Forma persistida do arquivo de grupos (userData/stores/groups.json). */
export interface GroupsStore {
  groups: GroupEntry[];
}

/**
 * Grupos (coleções de coordenadas da Análise de Tropas): service fino no
 * padrão do OpArchiveService — validação, merge, teto de 100 e ordenação
 * moram em regras puras (@shared/groups-rules); aqui é só JsonStore + journal.
 * Sem rede e sem sessão do jogo: grupos são locais e persistem entre
 * sessões/contas.
 */
export class GroupsService {
  private readonly store = new JsonStore<GroupsStore>('groups', { groups: [] });

  constructor(
    private readonly journal: Journal,
  ) {}

  /** Grupos salvos, mais recente primeiro. */
  async list(): Promise<GroupEntry[]> {
    const store = await this.store.load();
    return sortNewestFirst(store.groups);
  }

  /**
   * Cria (sem id) ou atualiza (com id) um grupo. Atualização preserva id e
   * criadoEm; inexistente = erro fail-closed. Aplica o teto de 100 mantendo o
   * grupo salvo mesmo sendo o mais antigo.
   */
  async save(input: GroupSaveInput): Promise<GroupEntry> {
    const data = normalizeGroupInput(input);
    const store = await this.store.load();
    const existing = input.id === undefined ? undefined : findGroupById(store.groups, input.id);
    if (input.id !== undefined && existing === undefined) throw groupNotFoundError(input.id);
    const entry = existing === undefined
      ? createGroupEntry(data, randomUUID(), new Date().toISOString())
      : updateGroupEntry(existing, data);
    await this.store.save({ groups: capGroups(upsertGroup(store.groups, entry), entry.id) });
    await this.journal.append('system', 'groups-save', `nome=${entry.nome} mundo=${entry.mundo} papel=${entry.papel} coords=${entry.coords.length} ${existing === undefined ? 'novo' : 'atualizado'}`, false);
    return entry;
  }

  /** Remove o grupo do arquivo (confirmação fica na UI). */
  async remove(id: string): Promise<void> {
    const store = await this.store.load();
    const existing = findGroupById(store.groups, id);
    if (existing === undefined) throw groupNotFoundError(id);
    await this.store.save({ groups: store.groups.filter((group) => group.id !== id) });
    await this.journal.append('system', 'groups-remove', `nome=${existing.nome} (id=${id})`, false);
  }

  /** Payload JSON boninho do grupo para salvar em arquivo (.json). */
  async exportPayload(id: string): Promise<string> {
    const store = await this.store.load();
    const group = findGroupById(store.groups, id);
    if (group === undefined) throw groupNotFoundError(id);
    return groupPayloadForExport(group);
  }

  /**
   * Import de arquivo (.json exportado por esta função ou wrapper {groups:[…]}):
   * parseGroupPayload valida tudo fail-closed; o grupo entra como NOVO
   * (sempre passa pelo save → upsert+cap+journal 'groups-import').
   */
  async importPayload(json: unknown): Promise<GroupEntry> {
    const parsed = parseGroupPayload(json);
    const entry = await this.save({ ...parsed });
    await this.journal.append('system', 'groups-import', `nome=${entry.nome} mundo=${entry.mundo} coords=${entry.coords.length} (id=${entry.id})`, false);
    return entry;
  }
}
