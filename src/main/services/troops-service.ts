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
  extractPagedNavPages,
  type AllyUnitsResult,
  type MemberSelectorResult,
  type MemberVillageDefenseResult,
  type MemberVillageTroopsResult,
  type TrainedUnitsRow,
} from '@shared/parsers/ally-parsers';
import { isMemberSummaryPage, parseOwnUnitsTable, type OwnUnitsVillage } from '@shared/parsers/village-parsers';
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

/** Teto de segurança de paginação por membro (pager do jogo) — acima disso o
 * pager está em loop ou a conta é irreal; registra falha e para de paginar. */
const MAX_PAGES_PER_MEMBER = 50;

/**
 * Erros que ABORTAM a coleta inteira em vez de virar falha de membro/página:
 * sessão expirou, captcha suspeito ou cancelamento do usuário. No lote da
 * RequestQueue esses sentinelas já fail-fast — a paginação (uma chamada por
 * página) precisa propagá-los à mão para não seguir batendo no jogo sem
 * sessão/autorização.
 */
function isAbortiveQueueError(error: unknown): boolean {
  return (
    error instanceof QueueError &&
    (error.kind === 'session-expired' || error.kind === 'captcha-suspected' || error.kind === 'cancelled')
  );
}

function assertKind(kind: unknown): asserts kind is TroopKind {
  if (kind !== 'troops' && kind !== 'defense') {
    throw new Error(`Tipo de coleta inválido: "${String(kind)}" — use "troops" (tropas) ou "defense" (defesa).`);
  }
}

export class TroopsService {
  private readonly store: JsonStore<TroopsSnapshotsStore>;

  constructor(
    private readonly twSession: TwSessionManager,
    private readonly queue: RequestQueue,
    private readonly journal: Journal,
    /** Instância COMPARTILHADA com o index — sem cache obsoleto entre services. */
    private readonly settingsStore: JsonStore<AppSettings>,
  ) {
    this.store = new JsonStore<TroopsSnapshotsStore>('troops-snapshots', EMPTY_TROOPS_STORE);
  }

  /** Mundo ativo da sessão; fail-closed com mensagem clara se não houver login. */
  private world(): string {
    const { state, world } = this.twSession.getStatus();
    if (state !== 'logged-in' || world === null) {
      throw new Error('Nenhuma sessão ativa no jogo — faça login no jogo ou importe a sessão na tela Sessão.');
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
    // page=1 EXPLÍCITO: o jogo MEMORIZA a página atual do pager na SESSÃO e a
    // aplica a requests sem o parâmetro (provado no canário 02/09 — a overview
    // de unidades veio na página 2 por causa de um page=2 anterior na tela de
    // tribo). Sem isso, a 2ª coleta de um membro gigante viraria truncada.
    const urls = members.map((member) => `${url}&player_id=${member.playerId}&page=1`);
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
    const collected = await this.memberEntries(kind, url, members, bodies);
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
    const pagedNote = collected.pagedNotes.length > 0 ? `, ${collected.pagedNotes.join(', ')}` : '';
    await this.journal.append(
      'read',
      'collect-members',
      `${KIND_LABEL[kind]} por aldeia: ${members.length} membros, ${snapshot.entries.length} aldeias${pagedNote}${failuresNote}`,
      false,
    );
    return snapshot;
  }

  /** Snapshot completo de defesa por aldeia (com trânsito) para o SG_3. */
  async getDefenseVillages(): Promise<DefenseSnapshot | null> {
    const data = await this.store.load();
    // Fail-open SÓ na leitura do cache local: sem sessão ativa, o snapshot
    // salvo em disco continua visível (dado salvo não pode virar "nunca
    // coletado" só porque a sessão caiu) — MAS a validação de mundo vale
    // SEMPRE que o mundo ainda é conhecido: markSessionLost PRESERVA o último
    // mundo, então "sessão caiu" não vira desculpa para mostrar dado de outro
    // mundo. Só sem mundo conhecido (logout(), nunca logado) a comparação é
    // pulada. A COLETA continua exigindo sessão (world() fail-closed na escrita).
    const { world } = this.twSession.getStatus();
    if (world !== null && data.world !== world) return null;
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
    // Fail-open SÓ na leitura do cache local: sem sessão ativa, o snapshot
    // salvo em disco continua visível (dado salvo não pode virar "nunca
    // coletado" só porque a sessão caiu). A validação de mundo, porém, vale
    // SEMPRE que o mundo ainda é conhecido: markSessionLost PRESERVA o último
    // mundo, então "sessão caiu" não vira desculpa para mostrar dado de outro
    // mundo. Só sem mundo conhecido (logout(), nunca logado) a comparação é
    // pulada. A COLETA continua exigindo sessão (world() fail-closed na escrita).
    const { world } = this.twSession.getStatus();
    if (world !== null && data.world !== world) {
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
   * Paginação: membros com muitas aldeias paginam (links paged-nav-item) — cada
   * página extra é uma chamada própria à fila (teto por chamada preservado).
   */
  private async memberEntries(
    kind: TroopKind,
    baseUrl: string,
    members: MemberSelectorResult['options'],
    bodies: readonly string[],
  ): Promise<{
    entries: TroopSnapshot['entries'];
    defenseEntries: DefenseSnapshot['entries'];
    failures: TroopSnapshot['failures'];
    /** "Nome: N páginas" para o journal — só quem precisou de páginas extras. */
    pagedNotes: string[];
  }> {
    const entries: TroopSnapshot['entries'] = [];
    const defenseEntries: DefenseSnapshot['entries'] = [];
    const failures: NonNullable<TroopSnapshot['failures']> = [];
    const pagedNotes: string[] = [];
    const ceiling = await this.ceiling();
    const pageReason = (page: number, error: unknown): string =>
      `Página ${page}: ${error instanceof Error ? error.message : String(error)}`;
    const parseMemberPage = (body: string): MemberVillageTroopsResult | MemberVillageDefenseResult =>
      kind === 'troops' ? parseMemberVillageTroops(body) : parseMemberVillageDefense(body);
    // Fallback da própria conta: quando o player_id é o da sessão, o jogo
    // ignora o parâmetro e devolve o resumo — as tropas por aldeia da própria
    // conta vêm de overview_villages&mode=units (paginado também). group=0 =
    // TODOS os grupos de aldeias (sem isso o jogo usa o grupo ativo).
    let ownUnitsCache: { villages: OwnUnitsVillage[]; pages: number; pageFailures: string[] } | null = null;
    const ownUnits = async (): Promise<{ villages: OwnUnitsVillage[]; pages: number; pageFailures: string[] }> => {
      if (ownUnitsCache === null) {
        const world = this.world();
        // page=0 EXPLÍCITO na 1ª leitura: o pager desta tela é 0-based ([1]
        // aponta page=0) e o jogo MEMORIZA a página na sessão — sem o
        // parâmetro, a leitura herda a última página visitada (canário 02/09)
        // e vem truncada.
        const baseUrl = `https://${world}.tribalwars.com.br/game.php?screen=overview_villages&mode=units&group=0`;
        const body = (await this.queue.run([`${baseUrl}&page=0`], { label: 'Tropas da própria conta', ceiling }))[0];
        if (body === undefined) throw new Error('Falha ao ler as tropas da própria conta.');
        const villages = new Map<number, OwnUnitsVillage>();
        for (const village of parseOwnUnitsTable(body).villages) {
          villages.set(village.villageId, village);
        }
        let pages = 1;
        const pageFailures: string[] = [];
        for (const page of extractPagedNavPages(body)) {
          if (page > MAX_PAGES_PER_MEMBER) {
            pageFailures.push(`Mais de ${MAX_PAGES_PER_MEMBER} páginas de aldeias — coleta interrompida na página ${MAX_PAGES_PER_MEMBER}.`);
            break;
          }
          try {
            const pageBody = (await this.queue.run([`${baseUrl}&page=${page}`], { label: `Tropas da própria conta (página ${page})`, ceiling }))[0];
            if (pageBody === undefined) throw new Error(`Página ${page} veio vazia.`);
            for (const village of parseOwnUnitsTable(pageBody).villages) {
              if (!villages.has(village.villageId)) villages.set(village.villageId, village);
            }
            pages += 1;
          } catch (error) {
            // Sentinelas da fila (sessão expirou/captcha/cancelamento) não são
            // falha "desta página": abortam a coleta inteira, como no lote.
            if (isAbortiveQueueError(error)) throw error;
            pageFailures.push(pageReason(page, error));
          }
        }
        ownUnitsCache = { villages: [...villages.values()], pages, pageFailures };
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
          // Própria conta logada: usa a visão de unidades da conta (paginada).
          const cached = ownUnitsCache !== null;
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
          if (!cached) {
            for (const reason of own.pageFailures) {
              failures.push({ playerName: member.name, reason });
            }
            if (own.pages > 1) pagedNotes.push(`${member.name}: ${own.pages} páginas`);
          }
          continue;
        }
        // Dedupe defensivo entre páginas: se o jogo ignorar o page param e
        // devolver as mesmas aldeias, não duplica entradas.
        const seenVillages = new Set<number>();
        const pushVillages = (villages: readonly (MemberVillageTroopsResult['villages'][number] | MemberVillageDefenseResult['villages'][number])[]): void => {
          for (const village of villages) {
            if (seenVillages.has(village.villageId)) continue;
            seenVillages.add(village.villageId);
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
        };
        pushVillages(parseMemberPage(body).villages);
        // Paginação: páginas extras indicadas pelos links paged-nav-item da
        // página 1. Cada página é uma requisição própria na fila (com pacing e
        // teto) e falha isolada NÃO descarta as páginas já coletadas.
        let pageCount = 1;
        for (const page of extractPagedNavPages(body)) {
          if (page > MAX_PAGES_PER_MEMBER) {
            failures.push({
              playerName: member.name,
              reason: `Mais de ${MAX_PAGES_PER_MEMBER} páginas de aldeias — coleta interrompida na página ${MAX_PAGES_PER_MEMBER}.`,
            });
            break;
          }
          try {
            const pageUrl = `${baseUrl}&player_id=${member.playerId}&page=${page}`;
            const pageBody = (await this.queue.run([pageUrl], { label: `Coletando ${KIND_LABEL[kind]} (${member.name}, página ${page})`, ceiling }))[0];
            if (pageBody === undefined) throw new Error(`Página ${page} veio vazia.`);
            pushVillages(parseMemberPage(pageBody).villages);
            pageCount += 1;
          } catch (error) {
            // Sentinelas da fila (sessão expirou/captcha/cancelamento) não são
            // falha "desta página": abortam a coleta inteira, como no lote.
            if (isAbortiveQueueError(error)) throw error;
            failures.push({ playerName: member.name, reason: pageReason(page, error) });
          }
        }
        if (pageCount > 1) pagedNotes.push(`${member.name}: ${pageCount} páginas`);
      } catch (error) {
        // RESILIÊNCIA: um membro com erro NÃO aborta a coleta — registra e segue.
        // EXCEÇÃO: sentinelas da fila (sessão/captcha/cancelamento) abortam tudo.
        if (isAbortiveQueueError(error)) throw error;
        failures.push({
          playerName: member.name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { entries, defenseEntries, failures, pagedNotes };
  }
}
