// Contrato IPC entre renderer e processo principal do Staff Hub Toxic Squad.
// Toda evolução da ponte começa aqui — preload e main implementam, renderer consome.

import type {
  DiplomacyRelations,
  Sg1Input,
  Sg1Result,
  WorldAlly,
  WorldDataStatus,
  WorldVillage,
} from './types';

export type { DiplomacyRelations, Sg1Input, Sg1Result, WorldAlly, WorldDataStatus, WorldVillage };

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
    /** Relações diplomáticas da tribo do jogador (página autenticada). */
    relations(): Promise<DiplomacyRelations>;
  };
  sg1: {
    /** Análise de Aldeias e Distâncias (buckets de tempo de nobre). */
    analyze(input: Sg1Input): Promise<Sg1Result>;
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
