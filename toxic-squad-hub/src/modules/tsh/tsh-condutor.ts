// Condutor do Agendador (v3.2.2). O disparo precisa do formulário da PRAÇA
// da aldeia de origem aberto numa aba (pré-arme + clique na confirmação).
// Antes, se o jogador estava em outra tela, nada acontecia: o comando ficava
// "Na mira" e virava "Falhou" em silêncio. O Condutor:
//  - diz a VERDADE sobre cada comando: há uma aba pronta na Praça de origem?
//    Vai haver (o Condutor cobre)? Ou não vai sair?
//  - leva UMA aba até a Praça de origem 60 s antes do envio (abas em 2º plano
//    primeiro; aba em uso — texto sendo escrito, confirmação aberta — nunca),
//    com faixa visível e botões "Ir agora" / "Não levar esta aba"; depois do
//    envio volta para onde o jogador estava;
//  - grava o MOTIVO quando um comando passa da hora sem ninguém para enviá-lo.
// Travas: só uma aba reivindica cada comando; aba com envio próprio iminente
// não sai; nada de navegar a menos de 13 s (sairia no meio do pré-arme).
// Sem timers próprios: tudo acontece nos tiques de 1 s do vigia do main.

import { gm } from '../../core/storage';
import { currentWorld } from '../../core/page';
import { isHalted } from '../../core/halt';
import { serverNowMs } from '../../core/game-clock';
import { clockLabelMs } from '../../ext/core/timing/precise-fire';
import type { HubSchedulerState, ScheduledCommandRecord } from '../../ext/core/scheduler-state';
import { loadSettings } from './tsh-settings';
import { currentVillageId, isTshEnabled, tshAgendaBlock, tshTabId } from './tsh-runtime';
import { laneForSchedulerRecord } from '../../ext/core/humanize/humanize-policy';
import { HUMANIZED_LATE_GRACE_MS } from '../../ext/core/timing/precise-fire';
import { appendSchedulerEvent, DEFAULT_SETTINGS as SCHEDULER_DEFAULTS } from './plugins/command-scheduler';

/** Quanto antes do envio uma aba em 2º plano vai para a Praça. */
export const NAV_LEAD_MS = 60_000;
/** Aba À VISTA espera mais um pouco: a de 2º plano tem a preferência. */
const NAV_LEAD_VISIBLE_MS = 45_000;
/** Faixa de aviso antes de navegar. */
const NAV_WARN_MS = 15_000;
/** Mais perto que isso do envio, navegar arriscaria o pré-arme. */
const NAV_MIN_MS = 13_000;
/** Uma aba só atende a próxima origem se houver essa folga entre os envios. */
const CHAIN_GAP_MS = 30_000;
/** Lock do Agendador vale 2 min (mesmo TTL do runtime). */
const READY_MAX_AGE_MS = 120_000;
const CLAIM_TTL_MS = 20_000;
/** Depois do envio, a volta espera isso (o jogador lê "Enviado"). */
const RETURN_DELAY_MS = 2_500;
const RETURN_KEY = 'tsh-nav-return';
const DECLINE_KEY = 'tsh-nav-decline';
const TERMINAL = new Set(['enviado', 'incerto', 'falhou', 'removido']);

const schedulerKey = (world: string): string => `tsh-auto:${world}:command-scheduler:scheduler`;
const claimKey = (world: string): string => `tsh:${world}:nav-claim`;

interface ReturnInfo {
  url: string;
  cmd: string;
  origin: string;
  /** Instante (Date.now) em que a volta acontece; ausente = ainda não enviado. */
  at?: number;
}

function vid(raw: string): string {
  return raw.replace(/^n/, '');
}

function screenIs(name: string): boolean {
  return new URLSearchParams(window.location.search).get('screen') === name;
}

function loadState(world: string): HubSchedulerState {
  const stored = gm.get<Partial<HubSchedulerState>>(schedulerKey(world), {});
  return { ...stored, commands: Array.isArray(stored.commands) ? stored.commands : [] } as HubSchedulerState;
}

function schedulerSettings(world: string): { autoNavigate: boolean; autoSend: boolean; allowLateMs: number } {
  const s = loadSettings(world, 'command-scheduler', SCHEDULER_DEFAULTS as unknown as Record<string, unknown>);
  return {
    autoNavigate: s.autoNavigate !== false,
    autoSend: s.autoSend !== false,
    allowLateMs: typeof s.allowLateMs === 'number' ? s.allowLateMs : 250,
  };
}

/** Por que o Agendador NÃO vai rodar na Praça agora (null = vai). */
function schedulerBlock(world: string): string | null {
  if (!isTshEnabled('command-scheduler')) return 'o Agendador está desligado';
  if (isHalted()) return 'o script está pausado (captcha/sessão)';
  return tshAgendaBlock('command-scheduler', world);
}

/** Tolerância de atraso do comando: fakes humanizados saem atrasados DE PROPÓSITO. */
function lateToleranceMs(record: ScheduledCommandRecord, allowLateMs: number): number {
  return laneForSchedulerRecord(record) === 'humanizado' ? allowLateMs + HUMANIZED_LATE_GRACE_MS : allowLateMs;
}

/** Comando ainda sem desfecho (nem terminal, nem enviando) e não pausado. */
function alive(record: ScheduledCommandRecord): boolean {
  if (record.paused === true || !Array.isArray(record.events)) return false;
  return !record.events.some((event) => TERMINAL.has(event.status) || event.status === 'enviando');
}

/** Há uma aba PRONTA na Praça desta aldeia (lock fresco do Agendador ou pré-arme em curso)? */
export function tabReadyFor(world: string, villageId: string): boolean {
  const now = Date.now();
  const lock = gm.get<{ tab: string; at: number } | null>(`tsh-auto:${world}:command-scheduler:v${villageId}:lock`, null);
  if (lock !== null && lock.at > 0 && now - lock.at < READY_MAX_AGE_MS) return true;
  const prearm = gm.get<{ at: number } | null>(`tsh-auto:${world}:command-scheduler:prearm:${villageId}`, null);
  return prearm !== null && now - prearm.at < 45_000;
}

function onPlaceOf(villageId: string): boolean {
  return screenIs('place') && currentVillageId() === villageId;
}

export type Readiness =
  /** Esta aba está na Praça da origem: ela envia. */
  | 'aqui'
  /** Outra aba está pronta na Praça da origem. */
  | 'pronta'
  /** Ninguém pronto, mas o Condutor vai levar uma aba até lá. */
  | 'automatico'
  /** Ninguém pronto e ninguém vai: Condutor desligado, script pausado ou
   *  outra origem colada demais (uma aba só atende uma origem por vez). */
  | 'manual';

/** Comandos vivos ainda dentro da janela de envio, do mais cedo ao mais tarde. */
function aliveSorted(world: string, allowLateMs: number): ScheduledCommandRecord[] {
  const now = serverNowMs();
  return loadState(world)
    .commands.filter((r) => alive(r) && Number.isFinite(Date.parse(r.sendAt)) && Date.parse(r.sendAt) >= now - lateToleranceMs(r, allowLateMs))
    .sort((a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt));
}

/**
 * Situação de cada comando vivo. O Condutor só cobre uma origem por vez: um
 * comando de OUTRA origem a menos de 30 s do anterior coberto fica 'manual'
 * (antes todos diziam "vai sozinho" e o 2º/3º falhavam — o bug original com
 * outro nome).
 */
function coverage(world: string): Map<string, Readiness> {
  const { autoNavigate, autoSend, allowLateMs } = schedulerSettings(world);
  const autoOk = autoNavigate && autoSend && schedulerBlock(world) === null;
  const out = new Map<string, Readiness>();
  let last: { at: number; origin: string } | undefined;
  for (const r of aliveSorted(world, allowLateMs)) {
    const origin = vid(r.sourceVillageId);
    const at = Date.parse(r.sendAt);
    if (onPlaceOf(origin)) out.set(r.id, 'aqui');
    else if (tabReadyFor(world, origin)) out.set(r.id, 'pronta');
    else if (autoOk && (last === undefined || last.origin === origin || at - last.at >= CHAIN_GAP_MS)) {
      out.set(r.id, 'automatico');
      last = { at, origin };
    } else out.set(r.id, 'manual');
  }
  return out;
}

/** Situação de UM comando vivo, para a interface dizer a verdade. */
export function readinessOf(record: ScheduledCommandRecord, world = currentWorld()): Readiness {
  const origin = vid(record.sourceVillageId);
  if (onPlaceOf(origin)) return 'aqui';
  if (tabReadyFor(world, origin)) return 'pronta';
  return coverage(world).get(record.id) ?? 'manual';
}

/** Próximo comando vivo (Início e escudo). */
export function nextAliveRecord(world = currentWorld()): ScheduledCommandRecord | undefined {
  return aliveSorted(world, schedulerSettings(world).allowLateMs)[0];
}

/** Rótulo curto da origem para mensagens. */
export function originLabel(record: ScheduledCommandRecord): string {
  const coord = record.source !== undefined ? `${record.source.x}|${record.source.y}` : '';
  return record.sourceName !== undefined && record.sourceName !== '' ? `${record.sourceName}${coord !== '' ? ` (${coord})` : ''}` : coord || `aldeia ${vid(record.sourceVillageId)}`;
}

/** Nome curto (sem coordenadas) — para o escudo e a faixa. */
function shortLabel(record: ScheduledCommandRecord): string {
  return record.sourceName !== undefined && record.sourceName !== '' ? record.sourceName : originLabel(record);
}

function hhmmss(record: ScheduledCommandRecord): string {
  return clockLabelMs(Date.parse(record.sendAt)).slice(0, 8);
}

/** Vai AGORA para a Praça da origem (botão "Ir agora" e o próprio Condutor). */
export function goToPlaceOf(record: ScheduledCommandRecord): void {
  const origin = vid(record.sourceVillageId);
  try {
    // Já está numa ida guardada? Mantém a URL ORIGINAL do jogador.
    const prev = readReturn();
    const url = prev !== null ? prev.url : window.location.href;
    const info: ReturnInfo = { url, cmd: record.id, origin };
    sessionStorage.setItem(RETURN_KEY, JSON.stringify(info));
  } catch {
    /* sem sessionStorage: só não volta sozinho */
  }
  window.location.href = `/game.php?village=${encodeURIComponent(origin)}&screen=place`;
}

/** "Não levar esta aba": esta aba desiste de ir para ESTE comando. */
export function declineNav(record: ScheduledCommandRecord): void {
  try {
    sessionStorage.setItem(DECLINE_KEY, record.id);
  } catch {
    /* sem sessionStorage: nada a lembrar */
  }
  const claim = gm.get<{ cmd: string; tab: string; at: number } | null>(claimKey(currentWorld()), null);
  if (claim !== null && claim.tab === tshTabId()) gm.set(claimKey(currentWorld()), null);
}

function declined(record: ScheduledCommandRecord): boolean {
  try {
    return sessionStorage.getItem(DECLINE_KEY) === record.id;
  } catch {
    return false;
  }
}

/**
 * Esta aba está EM USO? (texto sendo escrito, confirmação de comando aberta,
 * tropas digitadas na Praça, foco no painel do hub). Aba em uso nunca é levada
 * embora — o jogador perderia o que estava fazendo.
 */
export function tabBusyReason(): string | null {
  if (/[?&]try=confirm/.test(window.location.search)) return 'há uma confirmação de comando aberta nesta aba';
  const active = document.activeElement;
  if (active !== null && active !== document.body) {
    const tag = active.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (active as HTMLElement).isContentEditable) return 'você está digitando nesta aba';
    if (active.shadowRoot !== null && active.shadowRoot.activeElement !== null) {
      const inner = active.shadowRoot.activeElement;
      if (inner.tagName === 'INPUT' || inner.tagName === 'TEXTAREA' || inner.tagName === 'SELECT') return 'você está usando o painel nesta aba';
    }
  }
  for (const area of Array.from(document.querySelectorAll('textarea'))) {
    if (area.value.trim() !== '' && area.value !== area.defaultValue) return 'há um texto não enviado nesta aba';
  }
  if (screenIs('place')) {
    const typed = Array.from(document.querySelectorAll<HTMLInputElement>('#command-data-form input.unitsInput, #command-data-form input[name="input"]')).some(
      (input) => input.value.trim() !== '' && input.value !== input.defaultValue,
    );
    if (typed) return 'há um comando sendo montado nesta Praça';
  }
  return null;
}

export interface ConductorBar {
  kind: 'info' | 'warn' | 'danger';
  title: string;
  body: string;
  /** Comando dos botões (Ir agora / Não levar esta aba). */
  record?: ScheduledCommandRecord;
  /** Mostra "Não levar esta aba". */
  canDecline?: boolean;
}

export interface ConductorStatus {
  /** Texto para a dica do escudo (null = sem aviso do Condutor). */
  fabText: string | null;
  /** Faixa visível acima do escudo (null = sem faixa). */
  bar: ConductorBar | null;
}

const NONE: ConductorStatus = { fabText: null, bar: null };

/**
 * Um passo do Condutor (chamado a cada 1 s pelo vigia do main). Grava o motivo
 * de comandos perdidos, avisa, navega e volta. Nunca lança.
 */
export function conductorTick(): ConductorStatus {
  try {
    const world = currentWorld();
    const { autoNavigate, autoSend, allowLateMs } = schedulerSettings(world);
    markMissed(world, allowLateMs, autoSend);
    const back = returnIfDone(world, allowLateMs);
    if (back !== null) return back;
    if (!isTshEnabled('command-scheduler') || isHalted()) return NONE;
    // Envio automático desligado: o Agendador só avisa — o dono do motivo é ele.
    if (!autoSend) return NONE;
    const block = schedulerBlock(world);
    const now = serverNowMs();
    const cov = coverage(world);
    const list = aliveSorted(world, allowLateMs);

    // 1) O próximo comando que o Condutor cobre.
    const next = list.find((r) => cov.get(r.id) === 'automatico');
    const nav = next !== undefined ? navigateFor(world, next, now) : null;
    if (nav !== null) return nav;

    // 2) Comando que NÃO vai sair (sem aba e sem cobertura) em até 2 min: faixa vermelha.
    const orphan = list.find((r) => cov.get(r.id) === 'manual' && Date.parse(r.sendAt) - now <= 120_000);
    if (orphan !== undefined) {
      const motivo = block !== null
        ? `Ele não vai rodar: ${block}.`
        : !autoNavigate
        ? 'Abra a Praça dessa aldeia numa aba (ou ligue "Levar uma aba até a Praça sozinho" no Agendador).'
        : 'Uma aba só atende uma origem por vez e este sai colado em outro. Abra a Praça dessa aldeia em outra aba.';
      return {
        fabText: `${shortLabel(orphan)} às ${hhmmss(orphan)}: sem aba na Praça — não vai sair`,
        bar: { kind: 'danger', title: `Comando de ${shortLabel(orphan)} às ${hhmmss(orphan)} não vai sair`, body: `Nenhuma aba está na Praça de ${originLabel(orphan)}. ${motivo}`, record: orphan },
      };
    }
    return NONE;
  } catch {
    return NONE;
  }
}

/** Avisa/navega para UM comando coberto. null = nada a fazer nesta aba. */
function navigateFor(world: string, next: ScheduledCommandRecord, now: number): ConductorStatus | null {
  const origin = vid(next.sourceVillageId);
  if (onPlaceOf(origin) || tabReadyFor(world, origin)) return null;
  const inMs = Date.parse(next.sendAt) - now;
  const lead = document.hidden ? NAV_LEAD_MS : NAV_LEAD_VISIBLE_MS;
  if (inMs > lead + NAV_WARN_MS || inMs < NAV_MIN_MS) return null;
  // Esta aba tem envio PRÓPRIO iminente? Então não sai da Praça dela.
  if (screenIs('place')) {
    const here = currentVillageId();
    const busy = loadState(world).commands.some((r) => alive(r) && vid(r.sourceVillageId) === here && Math.abs(Date.parse(r.sendAt) - now) < 90_000);
    if (busy) return null;
  }
  // Outra aba já reivindicou este comando.
  const claim = gm.get<{ cmd: string; tab: string; at: number } | null>(claimKey(world), null);
  if (claim !== null && claim.cmd === next.id && claim.tab !== tshTabId() && Date.now() - claim.at < CLAIM_TTL_MS) {
    return { fabText: `Outra aba vai à Praça de ${shortLabel(next)} (${hhmmss(next)})`, bar: null };
  }
  if (declined(next)) {
    return {
      fabText: `${shortLabel(next)} às ${hhmmss(next)}: esta aba não vai à Praça`,
      bar: {
        kind: 'warn',
        title: `Esta aba não vai à Praça de ${shortLabel(next)}`,
        body: `Se nenhuma outra aba do jogo estiver aberta, o comando das ${hhmmss(next)} não sai.`,
        record: next,
      },
    };
  }
  const busyReason = tabBusyReason();
  if (busyReason !== null) {
    return {
      fabText: `${shortLabel(next)} às ${hhmmss(next)}: esta aba está em uso — não vai à Praça`,
      bar: {
        kind: 'warn',
        title: `Comando de ${shortLabel(next)} às ${hhmmss(next)}: esta aba não vai à Praça`,
        body: `${busyReason[0]?.toUpperCase() ?? ''}${busyReason.slice(1)}. Outra aba do jogo pode ir sozinha; se não houver, abra a Praça de ${originLabel(next)} ou clique em "Ir agora".`,
        record: next,
      },
    };
  }
  if (inMs > lead) {
    const secs = Math.ceil((inMs - lead) / 1000);
    return {
      fabText: `Em ${secs} s → Praça de ${shortLabel(next)} (${hhmmss(next)})`,
      bar: {
        kind: 'info',
        title: `Em ${secs} s esta aba vai à Praça de ${shortLabel(next)}`,
        body: `Comando das ${hhmmss(next)}. Ela envia e depois volta para esta página.`,
        record: next,
        canDecline: true,
      },
    };
  }
  gm.set(claimKey(world), { cmd: next.id, tab: tshTabId(), at: Date.now() });
  goToPlaceOf(next);
  return { fabText: `Indo à Praça de ${shortLabel(next)}…`, bar: { kind: 'info', title: `Indo à Praça de ${shortLabel(next)}…`, body: `Comando das ${hhmmss(next)}.` } };
}

/**
 * Comando que passou da hora SEM ninguém para enviá-lo: grava 'falhou' com o
 * motivo (antes virava "Falhou" só pela derivação do relógio, sem explicação).
 */
function markMissed(world: string, allowLateMs: number, autoSend: boolean): void {
  // Envio automático desligado: o Agendador segura os comandos e grava ele
  // mesmo o motivo — o Condutor não se mete.
  if (!autoSend) return;
  const now = serverNowMs();
  const state = loadState(world);
  const missed = state.commands.filter((r) => {
    if (!alive(r) || r.forced === true || !Number.isFinite(Date.parse(r.sendAt))) return false;
    if (now <= Date.parse(r.sendAt) + lateToleranceMs(r, allowLateMs) + 5_000) return false;
    // Pré-arme fresco DESTE comando: o envio está em curso numa aba.
    const prearm = gm.get<{ id?: string; at: number } | null>(`tsh-auto:${world}:command-scheduler:prearm:${vid(r.sourceVillageId)}`, null);
    return !(prearm !== null && prearm.id === r.id && Date.now() - prearm.at < 45_000);
  });
  if (missed.length === 0) return;
  const block = schedulerBlock(world);
  const motivos = new Map<string, string>();
  for (const r of missed) {
    const origin = vid(r.sourceVillageId);
    motivos.set(
      r.id,
      block !== null
        ? `Não saiu porque ${block} no horário — nada foi enviado.`
        : tabReadyFor(world, origin)
          ? 'A aba na Praça não conseguiu enviar a tempo — nada foi enviado. Confira o histórico do comando.'
          : `Nenhuma aba estava na Praça de ${originLabel(r)} no horário — nada foi enviado.`,
    );
  }
  // Relê e aplica SOBRE o estado fresco (outra aba pode ter gravado no meio).
  let fresh = loadState(world);
  for (const [id, motivo] of motivos) {
    const c = fresh.commands.find((cmd) => cmd.id === id);
    if (c !== undefined && alive(c)) fresh = appendSchedulerEvent(fresh, id, 'falhou', new Date().toISOString(), motivo);
  }
  gm.set(schedulerKey(world), fresh);
}

function readReturn(): ReturnInfo | null {
  try {
    const raw = sessionStorage.getItem(RETURN_KEY);
    if (raw === null) return null;
    const info = JSON.parse(raw) as Partial<ReturnInfo>;
    if (typeof info.url !== 'string' || typeof info.cmd !== 'string' || typeof info.origin !== 'string') {
      sessionStorage.removeItem(RETURN_KEY);
      return null;
    }
    return info as ReturnInfo;
  } catch {
    return null;
  }
}

function dropReturn(): void {
  try {
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    /* nada */
  }
}

/** Depois do envio, volta para a página em que o jogador estava. */
function returnIfDone(world: string, allowLateMs: number): ConductorStatus | null {
  const info = readReturn();
  if (info === null) return null;
  // Confirmação aberta: o envio está em curso — espera.
  if (/[?&]try=confirm/.test(window.location.search)) return null;
  // O jogador saiu da Praça da origem por conta própria: não volta mais.
  if (!onPlaceOf(info.origin)) {
    dropReturn();
    return null;
  }
  const record = loadState(world).commands.find((c) => c.id === info.cmd);
  if (record !== undefined && alive(record)) return null;
  // Outro comando chegando em breve? Fica (o Condutor decide para onde ir).
  const soon = aliveSorted(world, allowLateMs)[0];
  if (soon !== undefined && Date.parse(soon.sendAt) - serverNowMs() < 3 * 60_000) return null;
  // O jogador começou a montar outro comando aqui: não atrapalha.
  if (tabBusyReason() !== null) {
    dropReturn();
    return null;
  }
  if (info.url === '' || info.url === window.location.href) {
    dropReturn();
    return null;
  }
  const sent = record?.events.some((e) => e.status === 'enviado') === true;
  const titulo = sent ? 'Comando enviado. Voltando para onde você estava…' : 'Voltando para onde você estava…';
  if (info.at === undefined) {
    try {
      sessionStorage.setItem(RETURN_KEY, JSON.stringify({ ...info, at: Date.now() + RETURN_DELAY_MS }));
    } catch {
      /* nada */
    }
    return { fabText: titulo, bar: { kind: 'info', title: titulo, body: 'Clique em "Não levar esta aba" para ficar aqui.', canDecline: true } };
  }
  if (Date.now() < info.at) {
    return { fabText: titulo, bar: { kind: 'info', title: titulo, body: 'Clique em "Não levar esta aba" para ficar aqui.', canDecline: true } };
  }
  dropReturn();
  window.location.href = info.url;
  return { fabText: titulo, bar: null };
}

/** "Não levar esta aba" durante a VOLTA: fica na Praça. */
export function cancelReturn(): void {
  dropReturn();
}
