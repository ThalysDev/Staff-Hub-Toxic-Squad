// Handlers IPC do DIGESTO DO QUARTEL (resumo diário via webhook externo).
// Monta a mensagem a partir de dados que já existem no app — journal (coletas
// e MPs/cobranças do dia), histórico de tropas (sinais da Auditoria de
// Membros: auditSignals no diff das 2 versões mais recentes + contagens de
// detectStagnation na janela cheia), prefs 'sg2' (intervalo da coleta
// automática) e snapshot de tropas (última coleta) — e faz POST {content} no
// webhook (formato Discord). Regras puras em @shared/digest e
// @shared/member-audit; aqui é orquestração no padrão do ipc-preferences
// (JsonStore próprio + journal best-effort). O envio é o ÚNICO canal que sai
// da máquina — 'digest:send' pertence ao CANAIS_PROTEGIDOS; get/set são
// config local (livres, como settings).

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { app, ipcMain } from 'electron';
import {
  auditSignals,
  detectStagnation,
  type AuditSignal,
  type StagnationSignal,
} from '@shared/member-audit';
import { capHistory, diffTroopsVersions, type TroopsHistoryVersion } from '@shared/snapshot-history';
import {
  buildDigestMessage,
  filterJournalToday,
  localDateKey,
  summarizeAuditSignals,
} from '@shared/digest';
import type { DigestConfig, DigestSendResult, DigestStatus } from '@shared/ipc-types';
import { JsonStore } from './stores/json-store';
import type { Journal } from './journal';
import type { TwSessionManager } from './tw/session';

export interface DigestIpcDeps {
  journal: Journal;
  /** Sessão do jogo: só para rotular o digesto com o jogador (best-effort). */
  twSession: TwSessionManager;
  /** Opcional: exigir sessão válida do SISTEMA no envio AUTOMÁTICO (P3 da
   * revisão 1 da 0.36 — sem isso, um renderer comprometido configura webhook
   * + enabled e o digesto sai sozinho, sem autenticação). */
  exigirSessao?: () => void;
}

/** Forma persistida do módulo (userData/stores/digest.json). */
interface DigestStore {
  webhookUrl: string;
  enabled: boolean;
  lastSentDate: string | null;
}

const EMPTY_DIGEST: DigestStore = { webhookUrl: '', enabled: false, lastSentDate: null };

/** Leitura ONLY do histórico de tropas (store do ipc-history) — nunca grava. */
interface TroopsHistoryReadStore {
  versions: TroopsHistoryVersion[];
}

/** Leitura ONLY do snapshot de tropas (store do troops-service): só precisamos
 *  de troops.collectedAt para projetar a próxima coleta automática. */
interface TroopsSnapshotsReadStore {
  troops: { collectedAt: string } | null;
}

/** Leitura ONLY das prefs (store do ipc-preferences): só sg2.autoCollectHours. */
interface PreferencesReadStore {
  sg2?: { autoCollectHours?: unknown } | null;
}

const EMPTY_TROOPS_READ: TroopsSnapshotsReadStore = { troops: null };

/** Ritmo do digesto automático: tenta no boot e depois a cada 6h. */
const AUTO_DIGEST_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Hora local mínima para o envio automático (o dono lê de manhã). */
const AUTO_DIGEST_MIN_HOUR = 8;
/** Webhook externo: teto de espera de 10s (mesma régua do updater). */
const WEBHOOK_TIMEOUT_MS = 10_000;
/** Journal suficiente para cobrir um dia inteiro de operação (cap = 10k). */
const JOURNAL_READ_LIMIT = 10_000;

const URL_PATTERN = /^https?:\/\/\S+$/;

// ---------------------------------------------------------------------------
// Prefs por usuário (mesmo esquema do ipc-preferences/ipc-planner-draft — a
// store 'preferences' é por conta do sistema; o digesto só LÊ o intervalo da
// coleta automática e, em qualquer fracasso, volta como "não configurada",
// fail-open).
// ---------------------------------------------------------------------------

async function currentUserNick(): Promise<string | null> {
  try {
    const raw = await fs.readFile(join(app.getPath('userData'), 'stores', 'auth-session.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { user?: { nick?: unknown } | null };
    const nick = parsed.user?.nick;
    return typeof nick === 'string' && nick !== '' ? nick : null;
  } catch {
    return null; // sem sessão (logout) ou arquivo ausente: store legada
  }
}

/** Parte de NOME DE ARQUIVO derivada do nick — espelho EXATO do
 *  ipc-preferences/ipc-planner-draft (não dá para importar: outro módulo). */
function nickFilePart(nick: string): string {
  const base = (nick.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'user').slice(0, 40);
  let hash = 0;
  for (let index = 0; index < nick.length; index++) hash = (hash * 31 + nick.charCodeAt(index)) >>> 0;
  return `${base}-${hash.toString(36)}`;
}

/** Intervalo da coleta automática (horas) das prefs do usuário corrente; 0 =
 *  desligada/ausente/ilegível — o lembrete simplesmente não entra no digesto. */
async function readAutoCollectHours(): Promise<number> {
  const names: string[] = [];
  const nick = await currentUserNick();
  if (nick !== null) names.push(`preferences.${nickFilePart(nick)}.json`);
  names.push('preferences.json'); // legada machine-wide como fallback
  for (const name of names) {
    try {
      const raw = await fs.readFile(join(app.getPath('userData'), 'stores', name), 'utf-8');
      const parsed = JSON.parse(raw) as PreferencesReadStore;
      const hours = Number(parsed.sg2?.autoCollectHours);
      if (Number.isFinite(hours) && hours > 0) return hours;
    } catch {
      // arquivo ausente/ilegível: tenta o próximo (best-effort)
    }
  }
  return 0;
}

/** 'HH:MM' da próxima coleta automática (última coleta + intervalo); null =
 *  desligada, nunca coletou (o main não conhece o "montado às" da UI) ou data
 *  ilegível — o digesto mostra "não configurada" e segue. */
async function nextAutoCollectLabel(): Promise<string | null> {
  try {
    const hours = await readAutoCollectHours();
    if (hours <= 0) return null;
    const troopsStore = new JsonStore<TroopsSnapshotsReadStore>('troops-snapshots', EMPTY_TROOPS_READ);
    const troopsAt = (await troopsStore.load()).troops?.collectedAt ?? null;
    if (troopsAt === null) return null;
    const last = Date.parse(troopsAt);
    if (!Number.isFinite(last)) return null;
    const next = new Date(last + hours * 60 * 60 * 1000);
    return next.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return null; // lembrete é best-effort: nunca derruba o digesto
  }
}

/** Sinais da Auditoria: diff das 2 versões mais recentes + estagnação na
 *  janela cheia (cap 20 — mesma régua da tela do SG_2). Menos de 2 versões →
 *  só estagnação (também vazia sem histórico mínimo). */
function collectAuditSignals(versions: readonly TroopsHistoryVersion[]): {
  audit: AuditSignal[];
  stagnation: StagnationSignal[];
} {
  const recentFirst = capHistory(versions);
  const newest = recentFirst[0];
  const previous = recentFirst[1];
  const audit = newest !== undefined && previous !== undefined ? auditSignals(diffTroopsVersions(previous, newest)) : [];
  return { audit, stagnation: detectStagnation(recentFirst) };
}

export interface DigestService {
  status(): Promise<DigestStatus>;
  set(config: DigestConfig): Promise<DigestStatus>;
  send(): Promise<DigestSendResult>;
  /** Envio automático: no-op silencioso a menos que enabled + URL válida +
   *  ainda não enviou hoje + hora local >= 08:00. `now` injetável p/ testes. */
  maybeAutoSend(now?: Date): Promise<void>;
}

export function createDigestService(deps: DigestIpcDeps): DigestService {
  const { journal, twSession } = deps;
  const store = new JsonStore<DigestStore>('digest', EMPTY_DIGEST);
  // Só leitura: a store de verdade do histórico é do ipc-history — um JSON
  // store próprio apontando para o mesmo arquivo é seguro porque NUNCA
  // gravamos nele (pior caso: versão arquivada no mesmo instante não entra no
  // digesto — best-effort).
  const historyRead = new JsonStore<TroopsHistoryReadStore>('troops-history', { versions: [] });

  async function status(): Promise<DigestStatus> {
    const current = await store.load();
    return {
      config: { webhookUrl: current.webhookUrl, enabled: current.enabled },
      lastSentDate: current.lastSentDate,
    };
  }

  async function set(input: DigestConfig): Promise<DigestStatus> {
    const webhookUrl = typeof input?.webhookUrl === 'string' ? input.webhookUrl.trim() : '';
    const enabled = input?.enabled === true;
    if (enabled && !URL_PATTERN.test(webhookUrl)) {
      throw new Error('Não é possível ativar o envio automático sem uma URL de webhook http(s) válida.');
    }
    const current = await store.load();
    await store.save({ webhookUrl, enabled, lastSentDate: current.lastSentDate });
    try {
      // A URL não vai ao journal (dado de configuração sensível) — só o estado.
      await journal.append('system', 'digest-config', `enabled=${enabled} url=${webhookUrl === '' ? 'vazia' : 'configurada'}`, false);
    } catch {
      // Journal é best-effort: falha de disco no registro nunca derruba o save.
    }
    return status();
  }

  /** Monta a mensagem do digesto com os dados correntes (journal + histórico +
   *  sessão + prefs). Nunca lança para falha de leitura auxiliar: cada peça
   *  degrada para o estado "vazio" do builder. */
  async function buildCurrentMessage(now: Date): Promise<string> {
    const today = localDateKey(now);
    const entries = journal.list(JOURNAL_READ_LIMIT);
    const collectionsToday = filterJournalToday(entries, today, ['collect-']);
    const mutationsToday = filterJournalToday(entries, today, ['mp-', 'charge-']);
    const { audit, stagnation } = collectAuditSignals((await historyRead.load()).versions);
    return buildDigestMessage({
      date: today,
      playerName: twSession.getStatus().player,
      signals: summarizeAuditSignals(audit, stagnation),
      collectionsToday,
      mutationsToday,
      nextAutoCollect: await nextAutoCollectLabel(),
    });
  }

  async function send(): Promise<DigestSendResult> {
    const current = await store.load();
    const webhookUrl = current.webhookUrl.trim();
    // NUNCA envia com URL vazia/inválida — nem manual, nem automático.
    if (!URL_PATTERN.test(webhookUrl)) {
      return { ok: false, detail: 'URL do webhook vazia ou inválida — configure um endereço http(s) antes de enviar.' };
    }
    try {
      const message = await buildCurrentMessage(new Date());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: message }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error(`webhook respondeu HTTP ${response.status}`);
      // Sucesso (manual ou automático) marca o dia: o automático não repete.
      await store.save({ ...current, webhookUrl, lastSentDate: localDateKey(new Date()) });
      try {
        await journal.append('system', 'digest-sent', `digesto de ${localDateKey(new Date())} enviado (${message.length} caracteres)`, false);
      } catch {
        // Journal é best-effort.
      }
      return { ok: true, detail: 'Digesto enviado com sucesso.' };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const detail = /abort/i.test(raw) ? `webhook não respondeu em ${WEBHOOK_TIMEOUT_MS / 1000}s` : raw;
      try {
        await journal.append('system', 'digest-error', detail, false);
      } catch {
        // Journal é best-effort.
      }
      return { ok: false, detail: `Falha ao enviar o digesto: ${detail}` };
    }
  }

  async function maybeAutoSend(now: Date = new Date()): Promise<void> {
    const current = await store.load();
    if (!current.enabled || !URL_PATTERN.test(current.webhookUrl.trim())) return;
    if (current.lastSentDate === localDateKey(now)) return; // já saiu digesto hoje
    if (now.getHours() < AUTO_DIGEST_MIN_HOUR) return; // só depois das 08:00 locais
    // O timer roda FORA do gate central de IPC: o envio automático exige
    // sessão do sistema por conta própria (P3 da revisão 1 da 0.36).
    deps.exigirSessao?.();
    await send();
  }

  return { status, set, send, maybeAutoSend };
}

/**
 * Registra os canais digest:get/set/send e arma o ciclo automático: tenta no
 * boot e a cada 6h ({@link maybeAutoSend} — no-op a menos que enabled + URL
 * válida + não enviado hoje + >= 08:00 local). O timer é unref'd para nunca
 * segurar o processo sozinho; o ciclo morre com o app (sem cleanup necessário).
 */
export function registerDigestIpc(deps: DigestIpcDeps): void {
  const service = createDigestService(deps);
  ipcMain.handle('digest:get', async (): Promise<DigestStatus> => service.status());
  ipcMain.handle('digest:set', async (_event, config: DigestConfig): Promise<DigestStatus> => service.set(config));
  ipcMain.handle('digest:send', async (): Promise<DigestSendResult> => service.send());
  // Sem sessão do sistema o exigirSessao lança — estado NORMAL quando
  // deslogado: a recusa é silenciosa (sem journal, sem ruído).
  void service.maybeAutoSend().catch(() => {});
  const timer = setInterval(() => {
    void service.maybeAutoSend().catch(() => {});
  }, AUTO_DIGEST_INTERVAL_MS);
  timer.unref();
}
