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
import type { DefenseSnapshot, Sg2FilterResult, Sg2Filters, TroopSnapshot } from './sg2-engine';
import type { BlindCheckInput, BlindVillageResult } from './sg3-engine';
import type { IncomingCommandRow, PlayerCommandTotal } from './parsers/village-parsers';
import type { GroupEntry, GroupSaveInput } from './groups-rules';
import type { MpTemplateEntry, MpTemplateSaveInput } from './mp-templates-rules';
import type { TroopsHistoryVersion } from './snapshot-history';
import type { WorldHistoryVersion } from './world-history';
import type { BlindDebtEntry } from './blind-debt';

export type { GroupEntry, GroupSaveInput };

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
export type { DefenseSnapshot, Sg2FilterResult, Sg2Filters, TroopSnapshot };
export type { BlindCheckInput, BlindVillageResult };

export interface Sg6MutationOutcome {
  coord?: string;
  playerName?: string;
  ok: boolean;
  detail: string;
}

/** Entrada da cobrança em lote (Sala de Guerra): corpo JÁ renderizado por jogador. */
export interface Sg6ChargeEntry {
  nick: string;
  subject: string;
  body: string;
}

/** Resultado por jogador da cobrança em lote. */
export interface Sg6ChargeOutcome {
  nick: string;
  ok: boolean;
  detail: string;
  /** true = linha SINTÉTICA do cancelamento no diálogo nativo (nada foi enviado). */
  cancelled: boolean;
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
  /** Endpoint do manifest de atualização (latest.json) do canal oficial. */
  updateUrl: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  requestMinIntervalMs: 350,
  requestJitterMs: 250,
  requestCeiling: 400,
  updateUrl: 'http://74.0.5.75/staffhub/latest.json',
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

// ---------------------------------------------------------------------------
// Atualização automática (canal oficial na VPS)
// ---------------------------------------------------------------------------

/** Manifest publicado no canal (latest.json) — validado fail-closed. */
export interface UpdateManifest {
  version: string;
  notes: string;
  url: string;
  sha256: string;
  releasedAt: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  /** Presente quando há atualização. */
  manifest?: UpdateManifest;
  /** Rede/servidor indisponível etc. — checagem é fail-soft, nunca derruba o app. */
  error?: string;
  /** true quando um download/preparo está em curso agora (card renasce em andamento). */
  downloadInProgress?: boolean;
  /** Versão já baixada+verificada+pronta para aplicar (card renasce em "pronta"). */
  preparedVersion?: string;
  /** Último progresso emitido pelo preparo em curso (fase/bytes atuais). */
  lastProgress?: UpdateProgress;
}

export type UpdateProgress =
  | { phase: 'download'; receivedBytes: number; totalBytes: number }
  | { phase: 'verify' }
  | { phase: 'extract' }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; detail: string };

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

// ---------------------------------------------------------------------------
// Autenticação do SISTEMA (staffhub-auth na VPS) — v0.30
// ---------------------------------------------------------------------------

export type AuthEstado = 'verificando' | 'deslogado' | 'logado' | 'offline' | 'expirado';

export interface AuthUser {
  nick: string;
  role: 'admin' | 'staff';
  status: 'pending' | 'active' | 'banned';
}

export interface AuthStatus {
  estado: AuthEstado;
  user: AuthUser | null;
  /** Válida até (epoch ms) a sessão OFFLINE atual — só com estado 'offline'. */
  offlineAte: number | null;
}

/** Linha da tabela de usuários no Admin (nunca contém hash/salt). */
export interface AdminUserRow {
  id: string;
  nick: string;
  role: 'admin' | 'staff';
  status: 'pending' | 'active' | 'banned';
  criadoEm: string;
  aprovadoEm: string | null;
}

export interface AuthAdminAudit {
  ts: string;
  ator: string;
  evento: string;
  detalhe: string;
}

export type AuthLoginResultado =
  | { ok: true; user: AuthUser }
  | { ok: false; erro: string; code?: 'pending' | 'banned' | 'rate' | 'rede' | 'sessao' };

export interface StaffHubApi {
  auth: {
    /** Estado atual da sessão do SISTEMA (eventos via onAuthChanged). */
    status(): Promise<AuthStatus>;
    /** Login com conta aprovada (mensagens PT-BR da API; code p/ UX). */
    login(nick: string, senha: string): Promise<AuthLoginResultado>;
    /** Cria conta PENDENTE — entra quando o admin aprovar. */
    register(nick: string, senha: string): Promise<{ ok: boolean; erro?: string }>;
    /** Sai da sessão atual (revoga na API e limpa o disco). */
    logout(): Promise<void>;
    /** Renovação manual (a automática roda a cada 10 min). */
    refreshNow(): Promise<AuthStatus>;
    /** Troca a senha da conta logada (desconecta — exige novo login). */
    trocarSenha(senhaAtual: string, senhaNova: string): Promise<{ ok: boolean; erro?: string }>;
    // ---- Admin (role admin; erros PT-BR) ----
    adminUsers(): Promise<{ users: AdminUserRow[] }>;
    adminUsersAcao(id: string, acao: 'aprovar' | 'banir' | 'reabilitar'): Promise<{ ok: boolean; erro?: string }>;
    adminResetarSenha(id: string): Promise<{ ok: boolean; senhaTemporaria?: string; erro?: string }>;
    adminAudit(): Promise<{ eventos: AuthAdminAudit[] }>;
  };
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
  tminus: {
    /** Agenda alertas T-minus a partir da agenda "nick;alvo;HH:MM:SS". Retorna nº de alertas.
     *  marksMinutes: minutos-antes opcionais (default [15,5,1]); inválidos → erro PT-BR. */
    schedule(scheduleText: string, marksMinutes?: number[]): Promise<{ alerts: number; detail: string }>;
    /** Cancela todos os alertas agendados. */
    cancel(): Promise<void>;
  };
  templates: {
    /** Templates de MP salvos, mais recente primeiro. */
    list(): Promise<MpTemplateEntry[]>;
    /** Cria (sem id) ou atualiza (com id) um template. */
    save(input: MpTemplateSaveInput): Promise<MpTemplateEntry>;
    /** Remove um template (o default volta a nenhum). */
    remove(id: string): Promise<void>;
    /** Marca um template como default (desmarca os demais). */
    setDefault(id: string): Promise<MpTemplateEntry | null>;
  };
  troopsHistory: {
    /** Versões arquivadas (agregado por jogador), mais recente primeiro. */
    list(): Promise<TroopsHistoryVersion[]>;
    /** Arquiva o snapshot dado (agregado por jogador; cap 20 com rotação). */
    archive(snapshot: TroopSnapshot): Promise<{ ok: boolean; detail: string }>;
    /** Remove uma versão do histórico. */
    remove(id: string): Promise<void>;
  };
  worldHistory: {
    /** Versões arquivadas (agregados por tribo + mudanças de dono), mais recente primeiro. */
    list(): Promise<WorldHistoryVersion[]>;
  };
  blindDebt: {
    /** Débito acumulado por jogador (pediu vs enviou de blind). */
    get(): Promise<BlindDebtEntry[]>;
    /** Mescla uma rodada reconhecida (pedido por jogador + enviado) no débito. */
    apply(round: { playerName: string; requested: number; sent: number }[]): Promise<BlindDebtEntry[]>;
    /** Zera o débito (confirmação na UI). */
    clear(): Promise<void>;
  };
  queue: {
    /** Cancela a operação de coleta em andamento na RequestQueue. */
    cancel(): Promise<void>;
  };
  updater: {
    /** Verifica o canal oficial (fail-soft: erro volta em `error`). */
    check(): Promise<UpdateCheckResult>;
    /** Baixa + confere SHA-256 + extrai em área de staging + gera script de troca.
     *  Progresso via events.onUpdaterProgress. Só funciona empacotado. */
    downloadAndPrepare(): Promise<{ ok: boolean; detail: string }>;
    /** Sai do app executando a troca de pasta e relança a nova versão. */
    restartToUpdate(): Promise<void>;
    /** Lista versões anteriores disponíveis no canal (para rollback). */
    listAvailableVersions(): Promise<{ versions: { version: string; url: string }[] }>;
    /** Baixa e prepara uma VERSÃO ESPECÍFICA (rollback). Mesmo pipeline do downloadAndPrepare. */
    prepareVersion(version: string, url: string, sha256: string): Promise<{ ok: boolean; detail: string }>;
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
    /** Moral por pontos do mundo (get_config disable_morale): mundos clássicos NÃO têm. */
    moraleInfo(): Promise<{ active: boolean }>;
    /** População por unidade do mundo (unit-info) — contadores FULL/SEMI e medidas por população. */
    unitPops(): Promise<Record<string, number>>;
    /** Minutos-por-campo EFETIVOS por unidade (unit-info) — velocidade de viagem do Planner em Massa. */
    unitSpeeds(): Promise<Record<string, number>>;
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
    /** v0.31: defesa por aldeia ("Na Aldeia" + "a caminho") para a fonte
     *  "Disponível na aldeia (agora)" da Análise de Tropas (null = não coletada
     *  no mundo atual). */
    getDefense(): Promise<DefenseSnapshot | null>;
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
    /** Cobrança de faltas em lote (Sala de Guerra): UM diálogo nativo para o lote
     *  inteiro e depois 1 MP por jogador — MUTAÇÃO: pacing humano, journal do lote
     *  + falhas por item; um nick que falha não aborta o resto. */
    chargeBatch(entries: Sg6ChargeEntry[]): Promise<{ results: Sg6ChargeOutcome[] }>;
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
  groups: {
    /** Grupos salvos (persistentes entre sessões/contas), mais recentes primeiro. */
    list(): Promise<GroupEntry[]>;
    /** Cria/atualiza um grupo (snapshot congelado de coordenadas). */
    save(input: GroupSaveInput): Promise<GroupEntry>;
    /** Remove um grupo. */
    remove(id: string): Promise<void>;
    /** Exporta um grupo para arquivo JSON (diálogo nativo de salvar). */
    exportGroup(id: string): Promise<{ ok: boolean; path?: string; detail: string }>;
    /** Importa grupo de arquivo JSON (diálogo nativo de abrir) — multi-tribo/backup. */
    importGroup(): Promise<{ ok: boolean; entry?: GroupEntry; detail: string }>;
  };
  preferences: {
    /** Preferências do módulo (ex.: 'sg1', 'sg4', 'geral'); objeto vazio se nunca salvas. */
    get(module: string): Promise<Record<string, unknown>>;
    /** Mescla patch nas preferências do módulo (merge raso por chave) e devolve o estado final. */
    save(module: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
    /** Apaga as preferências do módulo (volta ao default vazio), PRESERVANDO
     *  as chaves presets:* — presets nomeados são dado do usuário, não padrão. */
    reset(module: string): Promise<void>;
  };
  plannerDraft: {
    /** Grupos adicionados do Planner em Massa (store dedicado — o rascunho real
     *  passa do teto de 20k das prefs). Array cru: a UI revalida cada grupo. */
    get(): Promise<unknown[]>;
    /** Grava o rascunho inteiro (fail-closed: recusa não-array ou >2 MB). */
    save(groups: unknown[]): Promise<unknown[]>;
  };
  opShare: {
    /** Exporta uma OP arquivada para arquivo .json (diálogo nativo de salvar). */
    exportOp(id: string): Promise<{ ok: boolean; path?: string; detail: string }>;
    /** Importa OP de arquivo .json (diálogo nativo de abrir) — revalidação fail-closed. */
    importOp(): Promise<{ ok: boolean; detail: string }>;
  };
  window: {
    /** Titlebar personalizada (frame:false). */
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
  };
  events: {
    /** Sessão do SISTEMA mudou (login/logout/expiração/offline) — o gate da UI escuta. */
    onAuthChanged(cb: (status: AuthStatus) => void): () => void;
    onQueueProgress(cb: (progress: QueueProgress) => void): () => void;
    onSessionChanged(cb: (status: SessionStatus) => void): () => void;
    /** Estado maximizado da janela (titlebar). */
    onWindowMaxChanged(cb: (maximized: boolean) => void): () => void;
    /** Progresso do download/preparo da atualização. */
    onUpdaterProgress(cb: (progress: UpdateProgress) => void): () => void;
  };
}

declare global {
  interface Window {
    staffhub: StaffHubApi;
  }
}
