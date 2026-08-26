// Contrato IPC entre renderer e processo principal do Staff Hub Toxic Squad.
// Toda evolução da ponte começa aqui — preload e main implementam, renderer consome.

import type {
  DiplomacyRelations,
  Sg1Input,
  Sg1Result,
  SupportersResult,
  WorldAlly,
  WorldDataStatus,
  WorldPlayer,
  WorldVillage,
} from './types';
import type { Sg2FilterResult, Sg2Filters, TroopSnapshot } from './sg2-engine';
import type { BlindCheckInput, BlindVillageResult } from './sg3-engine';
import type { IncomingCommandRow, PlayerCommandTotal } from './parsers/village-parsers';

export interface Sg5VerifyEntry {
  playerName: string;
  coords: string[];
}

export interface Sg5VerifyResult {
  generatedAt: string;
  villages: { coord: string; loadedAt: number; commands: IncomingCommandRow[] }[];
  unknown: IncomingCommandRow[];
}

export interface Sg5TotalsResult {
  generatedAt: string;
  totals: PlayerCommandTotal[];
}

export type {
  DiplomacyRelations,
  Sg1Input,
  Sg1Result,
  SupportersResult,
  WorldAlly,
  WorldDataStatus,
  WorldPlayer,
  WorldVillage,
};
export type { Sg2FilterResult, Sg2Filters, TroopSnapshot };
export type { BlindCheckInput, BlindVillageResult };

export interface Sg6MutationOutcome {
  coord?: string;
  playerName?: string;
  ok: boolean;
  detail: string;
}

export interface ForumConferenceResult {
  threadId: number;
  firstPostMessage: string;
  recognized: string;
  updatedMessage: string;
  changed: boolean;
  /** Posts que contêm comentários reconhecidos (para "Apagar mensagens"). */
  recognizedPostIds: number[];
}

export type SessionState = 'logged-out' | 'logging-in' | 'logged-in' | 'unknown';

export interface SessionStatus {
  state: SessionState;
  /** Mundo ativo, ex.: "br142". */
  world: string | null;
  /** Nick do jogador logado (se conhecido). */
  player: string | null;
  /** Hora da última verificação bem-sucedida da sessão. */
  checkedAt: string | null;
}

export interface AppSettings {
  /** Intervalo mínimo entre requisições ao jogo, em ms. */
  requestMinIntervalMs: number;
  /** Jitter máximo adicional por requisição, em ms. */
  requestJitterMs: number;
  /** Teto de requisições por operação de coleta. */
  requestCeiling: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  requestMinIntervalMs: 350,
  requestJitterMs: 250,
  requestCeiling: 400,
};

export interface JournalEntry {
  id: string;
  ts: string;
  kind: 'read' | 'mutation' | 'session' | 'system';
  action: string;
  detail: string;
  dryRun: boolean;
}

export interface QueueProgress {
  operationId: string;
  label: string;
  done: number;
  total: number;
}

/** Tipo de coleta de tropas: tropas recrutadas da tribo ou defesa das aldeias (SG_3). */
export type TroopKind = 'troops' | 'defense';

export interface TroopsStatus {
  /** ISO da última coleta de tropas (null = nunca coletado). */
  troopsAt: string | null;
  /** ISO da última coleta de defesa (null = nunca coletado). */
  defenseAt: string | null;
}

export type FixtureCaptureResult =
  | { ok: true; name: string; bytes: number; path: string }
  | { ok: false; name: string; error: string };

// ---------------------------------------------------------------------------
// Arquivo de OPs + Sala de Guerra (Sprint 3)
// ---------------------------------------------------------------------------

/** Participação de um jogador na conferência de UMA OP. */
export interface OpPlayerConference {
  playerName: string;
  /** Alvos atribuídos ao jogador na distribuição. */
  assigned: number;
  /** Alvos dele com ≥1 comando compartilhado chegando. */
  sent: number;
}

/** Conferência de uma OP (derivada do SG_5 verify) arquivada com a OP. */
export interface OpConferenceSnapshot {
  verifiedAt: string;
  /** % de alvos com ≥1 comando do jogador esperado (0–100). */
  coveragePct: number;
  perPlayer: OpPlayerConference[];
  /** Alvos atribuídos sem NENHUM comando do jogador esperado. */
  targetsWithoutCommand: string[];
}

/** Totalizador de UMA OP (snapshot do SG_5 totals). */
export interface OpTotalsSnapshot {
  playerName: string;
  attacks: number;
  fakes: number;
  nobleAttacks: number;
  supports: number;
  total: number;
}

/** OP arquivada — memória histórica das operações da tribo. */
export interface OpArchiveEntry {
  id: string;
  title: string;
  createdAt: string;
  /** Alvos da OP (coords). */
  targets: string[];
  /** Distribuição "nick;coords" (saída do SG_4) no arquivamento. */
  distribution: string;
  /** Agenda "nick;alvo;HH:MM:SS" (saída da calculadora de envio), se houver. */
  sendSchedule?: string;
  conference?: OpConferenceSnapshot;
  totals?: OpTotalsSnapshot[];
}

/** Entrada para criar/atualizar uma OP do arquivo. */
export interface OpSaveInput {
  /** Presente = atualiza a OP existente (mesmo id). */
  id?: string;
  title: string;
  targets: string[];
  distribution: string;
  sendSchedule?: string;
}

export type SidLoginResult =
  | { ok: true; status: SessionStatus }
  | { ok: false; error: string };

export interface StaffHubApi {
  session: {
    openLogin(): Promise<void>;
    logout(): Promise<void>;
    status(): Promise<SessionStatus>;
    /**
     * Import de sessão via sid colado pelo próprio usuário (fluxo
     * EditThisCookie, autorizado pelo dono — ver AGENTS.md). O app apenas
     * grava o cookie e verifica; nunca gera/renova/rotaciona sid.
     */
    loginWithSid(world: string, sid: string): Promise<SidLoginResult>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
  journal: {
    list(limit: number): Promise<JournalEntry[]>;
    clear(): Promise<void>;
  };
  app: {
    getVersion(): Promise<string>;
  };
  queue: {
    /** Cancela a operação de coleta em andamento na RequestQueue. */
    cancel(): Promise<void>;
  };
  dev: {
    /** Baixa uma URL do jogo com a sessão atual e salva como fixture em userData/fixtures. */
    captureFixture(name: string, url: string): Promise<FixtureCaptureResult>;
  };
  world: {
    /** Baixa/atualiza os map dumps oficiais (village/player/ally) do mundo ativo. */
    refresh(): Promise<WorldDataStatus>;
    /** Status do cache local (sem rede). */
    status(): Promise<WorldDataStatus>;
    /** Tribos do mundo (do dump ally.txt). */
    tribes(): Promise<WorldAlly[]>;
    /** Aldeias do mundo (do dump village.txt) — payload do mapa mundial. */
    villages(): Promise<WorldVillage[]>;
    /** Jogadores do mundo (do dump player.txt) — join playerId→nome/tribo. */
    players(): Promise<WorldPlayer[]>;
    /** Minutos por campo do NOBRE no mundo ativo (efetivo, com speeds). */
    nobleMinutes(): Promise<number>;
    /** Bônus noturno do mundo (get_config): se ativo e a janela de horas. */
    nightBonus(): Promise<{ active: boolean; startHour: number; endHour: number }>;
    /** Relações diplomáticas da tribo do jogador (página autenticada). */
    relations(): Promise<DiplomacyRelations>;
  };
  sg1: {
    /** Análise de Aldeias e Distâncias (buckets de tempo de nobre). */
    analyze(input: Sg1Input): Promise<Sg1Result>;
  };
  troops: {
    /** Coleta completa, membro a membro, com pacing humano (progresso via events.onQueueProgress). */
    collectMembers(kind: TroopKind): Promise<TroopSnapshot>;
    /** Coleta resumida em 1 requisição (sem detalhamento por membro). */
    collectSummary(kind: TroopKind): Promise<TroopSnapshot>;
    /** Momento da última coleta por tipo (sem rede). */
    status(): Promise<TroopsStatus>;
    /** Snapshot guardado em memória (null = ainda não coletado; F5 não perde). */
    get(kind: TroopKind): Promise<TroopSnapshot | null>;
  };
  sg3: {
    /** Verificação de blind sobre a última coleta de defesa (paradas × paradas+trânsito). */
    checkBlind(input: Omit<BlindCheckInput, 'defense'>): Promise<{ results: BlindVillageResult[]; bbcode: string }>;
    /** Exibir apoiadores: 1 requisição por aldeia (volume!) — via RequestQueue. */
    supporters(coords: string[]): Promise<SupportersResult>;
  };
  sg5: {
    /** Verificação alvo-a-alvo ("nick;coords") — 1 requisição por aldeia, com pacing. */
    verify(entries: Sg5VerifyEntry[]): Promise<Sg5VerifyResult>;
    /** Totalizador por jogador a partir de coordenadas. */
    totals(coords: string[]): Promise<Sg5TotalsResult>;
    /** P0-5: varre as aldeias PRÓPRIAS do jogador logado (mesmo parser do verify). */
    scanOwnVillages(): Promise<Sg5VerifyResult & { player: string }>;
  };
  sg7: {
    /** Conferência dos posts do tópico de blindagem (leitura). */
    conference(threadUrl: string): Promise<ForumConferenceResult>;
    /** MUTAÇÃO: aplica o BBCode atualizado no primeiro post — dupla confirmação + journal (modo real permanente). */
    adjust(threadUrl: string, confirm: boolean): Promise<{ ok: boolean; detail: string }>;
    /** MUTAÇÃO: apaga posts do tópico (moderação) — dupla confirmação + journal + verificação (modo real permanente). */
    deletePosts(threadUrl: string, postIds: number[], confirm: boolean): Promise<{ ok: boolean; detail: string }>;
    /** MUTAÇÃO (P0-8): substitui o primeiro post do tópico pelo PLANO BBCode — dupla confirmação + dialog nativo + journal + verificação real. */
    postPlan(input: { threadUrl: string; bbcode: string }, confirm: boolean): Promise<{ ok: boolean; detail: string }>;
  };
  sg6: {
    /** Reserva em massa no Planejador — MUTAÇÃO: confirmação dupla + journal (modo real permanente). */
    reserveMass(coords: string[], confirm: boolean): Promise<Sg6MutationOutcome[]>;
    /** MPs personalizadas (#alvos# e opcionalmente #horarios# por jogador) — MUTAÇÃO: confirmação dupla + journal. */
    sendMps(input: {
      subject: string;
      body: string;
      entries: { playerName: string; coords: string[]; horarios?: string[] }[];
    }, confirm: boolean): Promise<Sg6MutationOutcome[]>;
  };
  opArchive: {
    /** OPs arquivadas, mais recente primeiro. */
    list(): Promise<OpArchiveEntry[]>;
    /** Cria (sem id) ou atualiza (com id) uma OP do arquivo. */
    save(input: OpSaveInput): Promise<OpArchiveEntry>;
    /** Anexa a conferência (e opcionalmente o totalizador) a uma OP arquivada. */
    attachConference(id: string, conference: OpConferenceSnapshot, totals?: OpTotalsSnapshot[]): Promise<OpArchiveEntry>;
    /** Remove uma OP do arquivo (confirmação na UI). */
    remove(id: string): Promise<void>;
  };
  window: {
    /** Titlebar personalizada (frame:false). */
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
  };
  events: {
    onQueueProgress(cb: (progress: QueueProgress) => void): () => void;
    onSessionChanged(cb: (status: SessionStatus) => void): () => void;
    /** Estado maximizado da janela (titlebar). */
    onWindowMaxChanged(cb: (maximized: boolean) => void): () => void;
  };
}

declare global {
  interface Window {
    staffhub: StaffHubApi;
  }
}
