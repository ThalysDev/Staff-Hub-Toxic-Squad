// Contrato IPC entre renderer e processo principal do Staff Hub Toxic Squad.
// Toda evolução da ponte começa aqui — preload e main implementam, renderer consome.

import type {
  DiplomacyRelations,
  Sg1Input,
  Sg1Result,
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
  villages: { coord: string; commands: IncomingCommandRow[] }[];
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
  dryRun: boolean;
  /** null = simulado (dry-run) — sem resultado real do servidor. */
  ok: boolean | null;
  detail: string;
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
  /** Modo DRY-RUN global: mutações são apenas registradas, nunca enviadas. */
  dryRun: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  requestMinIntervalMs: 350,
  requestJitterMs: 250,
  requestCeiling: 400,
  dryRun: true,
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
  };
  sg5: {
    /** Verificação alvo-a-alvo ("nick;coords") — 1 requisição por aldeia, com pacing. */
    verify(entries: Sg5VerifyEntry[]): Promise<Sg5VerifyResult>;
    /** Totalizador por jogador a partir de coordenadas. */
    totals(coords: string[]): Promise<Sg5TotalsResult>;
  };
  sg6: {
    /** Reserva em massa no Planejador — MUTAÇÃO: confirmação dupla + journal + dry-run. */
    reserveMass(coords: string[], confirm: boolean): Promise<Sg6MutationOutcome[]>;
    /** MPs personalizadas (#alvos#) — MUTAÇÃO: confirmação dupla + journal + dry-run. */
    sendMps(input: { subject: string; body: string; entries: { playerName: string; coords: string[] }[] }, confirm: boolean): Promise<Sg6MutationOutcome[]>;
  };
  events: {
    onQueueProgress(cb: (progress: QueueProgress) => void): () => void;
    onSessionChanged(cb: (status: SessionStatus) => void): () => void;
  };
}

declare global {
  interface Window {
    staffhub: StaffHubApi;
  }
}
