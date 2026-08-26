// Serviço das coletas de tropas (SG_2) e defesa (SG_3): sumário por JOGADOR
// (screen=ally&mode=members_troops/members_defense sem membro selecionado) e
// coleta COMPLETA por aldeia (um request por membro, via RequestQueue com
// pacing humano e teto das settings). 100% leitura — nenhum acesso aqui
// modifica estado do jogo.

import { JsonStore } from '../stores/json-store';
import type { Journal } from '../journal';
import type { TwSessionManager } from '../tw/session';
import type { RequestQueue } from '../tw/request-queue';
import { QueueError } from '../tw/request-queue';
import { DEFAULT_SETTINGS, type AppSettings, type TroopKind, type TroopsStatus } from '@shared/ipc-types';
import {
  parseMemberSelector,
  parseMembersDefense,
  parseMembersTroops,
  parseMemberVillageDefense,
  parseMemberVillageTroops,
  type AllyUnitsResult,
  type MemberSelectorResult,
  type TrainedUnitsRow,
} from '@shared/parsers/ally-parsers';
import { isMemberSummaryPage, parseOwnUnitsTable } from '@shared/parsers/village-parsers';
import type { DefenseSnapshot, TroopSnapshot } from '@shared/sg2-engine';

/** Cache persistido das coletas — uma posição por tipo de coleta. */
interface TroopsSnapshotsStore {
  world: string | null;
  troops: TroopSnapshot | null;
  defense: TroopSnapshot | null;
  /** Defesa completa por aldeia (com trânsito) — consumido pelo SG_3 (blind). */
  defenseVillages: DefenseSnapshot | null;
}

const EMPTY_TROOPS_STORE: TroopsSnapshotsStore = { troops: null, defense: null, defenseVillages: null, world: null };

const KIND_PAGE_MODE: Record<TroopKind, string> = {
  troops: 'members_troops',
  defense: 'members_defense',
};

const KIND_LABEL: Record<TroopKind, string> = {
  troops: 'tropas',
  defense: 'defesa',
};

function assertKind(kind: unknown): asserts kind is TroopKind {
  if (kind !== 'troops' && kind !== 'defense') {
    throw new Error(`Tipo de coleta inválido: "${String(kind)}" — use "troops" (tropas) ou "defense" (defesa).`);
  }
}

export class TroopsService {
  private readonly store: JsonStore<TroopsSnapshotsStore>;
  private readonly settingsStore: JsonStore<AppSettings>;

  constructor(
    private readonly twSession: TwSessionManager,
    private readonly queue: RequestQueue,
    private readonly journal: Journal,
  ) {
    this.store = new JsonStore<TroopsSnapshotsStore>('troops-snapshots', EMPTY_TROOPS_STORE);
    this.settingsStore = new JsonStore<AppSettings>('settings', DEFAULT_SETTINGS);
  }

  /** Mundo ativo da sessão; fail-closed com mensagem clara se não houver login. */
  private world(): string {
    const { state, world } = this.twSession.getStatus();
    if (state !== 'logged-in' || world === null) {
      throw new Error('Nenhuma sessão ativa no jogo — faça login (ou importe o sid) antes de continuar.');
    }
    return world;
  }

  /** Teto de requisições vigente nas settings (inválido/corrompido = default seguro). */
  private async ceiling(): Promise<number> {
    const raw = await this.settingsStore.load();
    const ceiling = Number(raw.requestCeiling);
    if (!Number.isFinite(ceiling) || ceiling < 1) return DEFAULT_SETTINGS.requestCeiling;
    return Math.round(ceiling);
  }

  private pageUrl(world: string, kind: TroopKind): string {
    return `https://${world}.tribalwars.com.br/game.php?screen=ally&mode=${KIND_PAGE_MODE[kind]}`;
  }

  /**
   * Sumário em 1 requisição: tabela "vis w100" na visão sem membro selecionado —
   * uma linha por JOGADOR (tropas recrutadas/que pertencem ao jogador). Na
   * defesa do BR142 a página não renderiza tabela sem seleção: resultado vazio
   * é o dado correto (parseMembersDefense devolve lista vazia, sem erro).
   */
  async collectSummary(kind: TroopKind): Promise<TroopSnapshot> {
    assertKind(kind);
    const url = this.pageUrl(this.world(), kind);
    const ceiling = await this.ceiling();
    const body = (await this.queue.run([url], { label: `Coletando resumo de ${KIND_LABEL[kind]}`, ceiling }))[0];
    if (body === undefined) {
      throw new Error('Resposta da coleta de resumo vazia — tente de novo.');
    }
    let parsed: AllyUnitsResult;
    try {
      parsed = kind === 'troops' ? parseMembersTroops(body) : parseMembersDefense(body);
    } catch (error) {
      throw new Error(
        `Página de resumo de ${KIND_LABEL[kind]} com formato inesperado: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const snapshot: TroopSnapshot = {
      kind,
      source: 'summary',
      collectedAt: new Date().toISOString(),
      entries: parsed.players.map((row) => this.playerEntry(row)),
    };
    await this.saveSnapshot(snapshot);
    await this.journal.append('read', 'collect-summary', `resumo de ${KIND_LABEL[kind]}: ${snapshot.entries.length} jogadores`, false);
    return snapshot;
  }

  /**
   * Coleta completa por ALDEIA: 1 requisição para ler o dropdown "Selecionar
   * membro" e, para cada player_id, uma requisição pela RequestQueue (pacing +
   * teto das settings). Resultado tem uma entrada por aldeia do jogador
   * (parseMemberVillageTroops/parseMemberVillageDefense).
   */
  async collectAllMembers(kind: TroopKind): Promise<TroopSnapshot> {
    assertKind(kind);
    const url = this.pageUrl(this.world(), kind);
    const ceiling = await this.ceiling();
    const selectorBody = (await this.queue.run([url], { label: 'Lendo membros da tribo', ceiling }))[0];
    if (selectorBody === undefined) {
      throw new Error('Resposta da página de membros vazia — tente de novo.');
    }
    let selector: MemberSelectorResult;
    try {
      selector = parseMemberSelector(selectorBody);
    } catch (error) {
      throw new Error(`Dropdown de membros com formato inesperado: ${error instanceof Error ? error.message : String(error)}`);
    }
    const members = selector.options;
    if (members.length === 0) {
      throw new Error('Nenhum membro no dropdown — confira se a página carregou com a tribo correta.');
    }
    const urls = members.map((member) => `${url}&player_id=${member.playerId}`);
    let bodies: string[];
    try {
      bodies = await this.queue.run(urls, { label: `Coletando ${KIND_LABEL[kind]} (${members.length} membros)`, ceiling });
    } catch (error) {
      if (error instanceof QueueError && error.kind === 'ceiling-exceeded') {
        throw new Error(
          `Coleta maior que o teto das settings (${ceiling}): a tribo tem ${members.length} membros — aumente o teto em Configurações.`,
        );
      }
      throw error;
    }
    const collected = await this.memberEntries(kind, members, bodies);
    const { entries, defenseEntries } = collected;
    const failures = collected.failures ?? [];
    const snapshot: TroopSnapshot = {
      kind,
      source: 'per-member',
      collectedAt: new Date().toISOString(),
      entries,
      ...(failures.length > 0 ? { failures } : {}),
    };
    const defenseVillages: DefenseSnapshot | null =
      kind === 'defense'
        ? { kind: 'defense', collectedAt: snapshot.collectedAt, entries: defenseEntries }
        : null;
    await this.saveSnapshot(snapshot, defenseVillages);
    const failuresNote = failures.length > 0 ? `, ${failures.length} membro(s) com erro (ver detalhes)` : '';
    await this.journal.append(
      'read',
      'collect-members',
      `${KIND_LABEL[kind]} por aldeia: ${members.length} membros, ${snapshot.entries.length} aldeias${failuresNote}`,
      false,
    );
    return snapshot;
  }

  /** Snapshot completo de defesa por aldeia (com trânsito) para o SG_3. */
  async getDefenseVillages(): Promise<DefenseSnapshot | null> {
    const data = await this.store.load();
    const currentWorld = this.world();
    if (data.world && data.world !== currentWorld) return null;
    return data.defenseVillages;
  }

  /** Datas das últimas coletas salvas (sem rede). */
  async status(): Promise<TroopsStatus> {
    const data = await this.store.load();
    return { troopsAt: data.troops?.collectedAt ?? null, defenseAt: data.defense?.collectedAt ?? null };
  }

  /** Snapshot salvo do tipo pedido, ou null se ainda não coletado. */
  async get(kind: TroopKind): Promise<TroopSnapshot | null> {
    assertKind(kind);
    const data = await this.store.load();
    const currentWorld = this.world();
    if (data.world && data.world !== currentWorld) {
      return null; // dados de outro mundo = como se não tivesse coletado
    }
    return data[kind];
  }

  /** Grava o snapshot na posição do tipo, preservando a outra coleta salva. */
  private async saveSnapshot(snapshot: TroopSnapshot, defenseVillages?: DefenseSnapshot | null): Promise<void> {
    const current = await this.store.load();
    const next: TroopsSnapshotsStore = { ...current, world: this.world() };
    if (snapshot.kind === 'troops') {
      next.troops = snapshot;
    } else {
      next.defense = snapshot;
      if (defenseVillages !== undefined) next.defenseVillages = defenseVillages;
    }
    await this.store.save(next);
  }

  /** Linha do resumo (visão por jogador): sem coordenada/aldeia reais. */
  private playerEntry(row: TrainedUnitsRow): TroopSnapshot['entries'][number] {
    return {
      playerId: row.playerId,
      playerName: row.name,
      coord: { x: -1, y: -1 },
      villageName: '',
      units: row.units,
      ...(row.commandsCount !== undefined ? { commandsCount: row.commandsCount } : {}),
      ...(row.incomingAttacksCount !== undefined ? { incomingAttacksCount: row.incomingAttacksCount } : {}),
    };
  }

  /**
   * Entradas por aldeia de cada membro, na ordem das respostas da fila.
   * Para defesa devolve TAMBM defenseEntries com o trânsito ("a caminho")
   * preservado — o snapshot genérico de TroopSnapshot carrega só "Na Aldeia".
   */
  private async memberEntries(
    kind: TroopKind,
    members: MemberSelectorResult['options'],
    bodies: readonly string[],
  ): Promise<{ entries: TroopSnapshot['entries']; defenseEntries: DefenseSnapshot['entries']; failures: TroopSnapshot['failures'] }> {
    const entries: TroopSnapshot['entries'] = [];
    const defenseEntries: DefenseSnapshot['entries'] = [];
    const failures: NonNullable<TroopSnapshot['failures']> = [];
    // Fallback da própria conta: quando o player_id é o da sessão, o jogo
    // ignora o parâmetro e devolve o resumo — as tropas por aldeia da própria
    // conta vêm de overview_villages&mode=units (uma única requisição).
    let ownUnitsCache: ReturnType<typeof parseOwnUnitsTable> | null = null;
    const ownUnits = async (): Promise<ReturnType<typeof parseOwnUnitsTable>> => {
      if (ownUnitsCache === null) {
        const world = this.world();
        const ceiling = await this.ceiling();
        const body = (await this.queue.run([`https://${world}.tribalwars.com.br/game.php?screen=overview_villages&mode=units`], { label: 'Tropas da própria conta', ceiling }))[0];
        if (body === undefined) throw new Error('Falha ao ler as tropas da própria conta.');
        ownUnitsCache = parseOwnUnitsTable(body);
      }
      return ownUnitsCache;
    };
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      const body = bodies[i];
      if (member === undefined || body === undefined) {
        failures.push({ playerName: '?', reason: 'Resposta da coleta incompleta.' });
        continue;
      }
      try {
        // Própria conta: o jogo devolve o resumo por jogador (sem tabela por
        // aldeia) quando o player_id é o da sessão. Detectamos pela AUSÊNCIA
        // da tabela "vis w100" com <th> (mais robusto que padrões de URL).
        const isOwnAccount =
          !body.includes('vis w100') ||
          isMemberSummaryPage(body);
        if (isOwnAccount) {
          // Própria conta logada: usa a visão de unidades da conta.
          const own = await ownUnits();
          for (const village of own.villages) {
            entries.push({
              playerId: member.playerId,
              playerName: member.name,
              coord: village.coord,
              villageId: village.villageId,
              villageName: village.name,
              units: kind === 'troops' ? village.own : village.inVillage,
            });
            defenseEntries.push({
              playerId: member.playerId,
              playerName: member.name,
              villageId: village.villageId,
              name: village.name,
              coord: village.coord,
              points: 0,
              unitsInVillage: village.inVillage,
              unitsInTransit: village.inTransit,
            });
          }
          continue;
        }
        const parsed = kind === 'troops' ? parseMemberVillageTroops(body) : parseMemberVillageDefense(body);
        for (const village of parsed.villages) {
          if ('units' in village) {
            entries.push({
              playerId: member.playerId,
              playerName: member.name,
              coord: village.coord,
              villageId: village.villageId,
              villageName: village.name,
              units: village.units,
            });
          } else {
            entries.push({
              playerId: member.playerId,
              playerName: member.name,
              coord: village.coord,
              villageId: village.villageId,
              villageName: village.name,
              units: village.unitsInVillage,
            });
            defenseEntries.push({
              playerId: member.playerId,
              playerName: member.name,
              villageId: village.villageId,
              name: village.name,
              coord: village.coord,
              points: village.points,
              unitsInVillage: village.unitsInVillage,
              unitsInTransit: village.unitsInTransit,
            });
          }
        }
      } catch (error) {
        // RESILIÊNCIA: um membro com erro NÃO aborta a coleta — registra e segue.
        failures.push({
          playerName: member.name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { entries, defenseEntries, failures };
  }
}