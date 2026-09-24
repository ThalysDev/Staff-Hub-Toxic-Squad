// Envio em SEGUNDO PLANO (v3.3.0). O disparo precisa da Praça da aldeia de
// origem aberta — e em vez de levar a aba do jogador até lá (Condutor), a aba
// abre essa Praça num QUADRO invisível (iframe da mesma origem). O próprio
// script roda dentro do quadro, em "modo quadro": só o Agendador daquela
// aldeia, sem painel — pré-arme, confirmação e clique no ms saem pelo MESMO
// fluxo real da Praça que já é usado com a aba aberta. A tela do jogador não
// muda e várias origens podem sair no mesmo minuto (um quadro por origem).
//
// Lado do QUADRO: isEnvioFrame/startEnvioFrame (chamados no main).
// Lado da ABA: hostFramesTick (chamado pelo Condutor a cada 1 s).
// Nada de captcha/evasão: se o jogo mostrar o desafio dentro do quadro, o
// disjuntor pausa tudo e a faixa de pausa pede ao jogador que resolva.

import { gm } from '../../core/storage';
import { currentWorld } from '../../core/page';
import { isHalted, tripHalt, pageShowsBotProtection } from '../../core/halt';
import { licenseState } from '../../core/license';
import type { ModuleScope } from '../vanta/vanta-lifecycle';
import { currentVillageId, restrictTshTo, startTshHeartbeat } from './tsh-runtime';

/** Prefixo do `window.name` do quadro — sobrevive às navegações dentro dele. */
export const FRAME_NAME_PREFIX = 'tsh-envio:';
/** Quanto antes do envio o quadro é aberto (folga para abas em 2º plano, cujos timers o navegador desacelera). */
export const FRAME_LEAD_MS = 120_000;
/** Mais perto que isso, abrir o quadro não dá tempo de carregar + pré-armar. */
export const FRAME_MIN_MS = 10_000;
/** Quadro sem sinal de vida por esse tempo = falhou (a aba cai no plano B). */
const FRAME_BOOT_TIMEOUT_MS = 25_000;
/**
 * Sinal de vida do quadro e reserva do anfitrião valem por isso. Longo de
 * propósito: aba oculta há mais de 5 min tem os timers desacelerados pelo
 * navegador para 1 disparo por minuto. A aba que hospeda NÃO depende disso —
 * ela lê o próprio quadro direto (mesma origem); o prazo só serve às OUTRAS
 * abas. Aba fechada solta a reserva no pagehide.
 */
const FRAME_BEAT_TTL_MS = 75_000;
const HOST_TTL_MS = 75_000;
/** Depois do último envio da origem, o quadro espera isso antes de fechar (redirect do POST). */
const FRAME_LINGER_MS = 8_000;
/** Teto de quadros simultâneos numa aba. */
const MAX_FRAMES = 15;
/** Uma falha de quadro tira a origem do 2º plano por esse tempo (vai para o plano B). */
const FAIL_COOLDOWN_MS = 5 * 60_000;

const beatKey = (world: string, vid: string): string => `tsh:${world}:envio-quadro:${vid}`;
const hostKey = (world: string, vid: string): string => `tsh:${world}:envio-host:${vid}`;
const failKey = (world: string, vid: string): string => `tsh:${world}:envio-falha:${vid}`;

export type FrameState = 'ok' | 'aldeia-errada' | 'sem-licenca' | 'desafio' | 'fora-da-praca';

interface FrameBeat {
  at: number;
  state: FrameState;
}

// ── Lado do QUADRO ──────────────────────────────────────────────────────────

/** Esta página é um quadro de envio? (iframe com o nome certo) */
export function isEnvioFrame(): boolean {
  try {
    return window.self !== window.top && window.name.startsWith(FRAME_NAME_PREFIX);
  } catch {
    return false;
  }
}

/** Esta página é um iframe QUALQUER (que não é nosso)? O script não roda lá. */
export function isForeignFrame(): boolean {
  try {
    return window.self !== window.top && !window.name.startsWith(FRAME_NAME_PREFIX);
  } catch {
    return true;
  }
}

function frameVillage(): string {
  return window.name.slice(FRAME_NAME_PREFIX.length);
}

/**
 * Sobe o modo quadro: só o Agendador desta aldeia, sem painel. Emite um sinal
 * de vida por segundo com o estado (a aba que hospeda lê e decide).
 */
export function startEnvioFrame(scope: ModuleScope): void {
  const world = currentWorld();
  const vid = frameVillage();
  const stateNow = (): FrameState => {
    if (pageShowsBotProtection()) return 'desafio';
    const lic = licenseState();
    if (lic.kind !== 'valida' && lic.kind !== 'graca') return 'sem-licenca';
    if (currentVillageId() !== vid) return 'aldeia-errada';
    if (new URLSearchParams(window.location.search).get('screen') !== 'place') return 'fora-da-praca';
    return 'ok';
  };
  const beat = (): void => {
    gm.set<FrameBeat>(beatKey(world, vid), { at: Date.now(), state: stateNow() });
  };
  beat();
  scope.every(beat, 1_000);
  const state = stateNow();
  if (state === 'desafio') {
    tripHalt('captcha', 'O jogo mostrou o desafio anti-bot no envio em 2º plano — abra a Praça numa aba e resolva.');
    return;
  }
  if (state !== 'ok') return;
  restrictTshTo(['command-scheduler']);
  startTshHeartbeat(scope);
}

// ── Lado da ABA que hospeda ─────────────────────────────────────────────────

/** Quadros que ESTA aba criou, por aldeia. */
const frames = new Map<string, { el: HTMLIFrameElement; createdAt: number; lastNeededAt: number; everOk: boolean }>();

let tabIdForHost = '';
/** A aba informa seu id (evita import circular com o runtime). */
export function setHostTabId(id: string): void {
  tabIdForHost = id;
}

function readBeat(world: string, vid: string): FrameBeat | null {
  const beat = gm.get<FrameBeat | null>(beatKey(world, vid), null);
  return beat !== null && Date.now() - beat.at < FRAME_BEAT_TTL_MS ? beat : null;
}

/** Existe um quadro VIVO e saudável desta aldeia (em qualquer aba)? */
export function frameAliveFor(world: string, vid: string): boolean {
  const mine = frames.get(vid);
  if (mine !== undefined) return localFrameState(mine.el, vid) === 'ok';
  return readBeat(world, vid)?.state === 'ok';
}

/** Esta aba hospeda algum quadro agora (ela não pode navegar sem matá-los). */
export function hostingFrames(): boolean {
  return frames.size > 0;
}

/** Esta origem falhou no 2º plano há pouco (fica no plano B por um tempo)? */
export function frameFailedRecently(world: string, vid: string): string | null {
  const fail = gm.get<{ at: number; reason: string } | null>(failKey(world, vid), null);
  return fail !== null && Date.now() - fail.at < FAIL_COOLDOWN_MS ? fail.reason : null;
}

function markFailed(world: string, vid: string, reason: string): void {
  gm.set(failKey(world, vid), { at: Date.now(), reason });
}

/** Limpa a marca de falha (ex.: botão "Tentar de novo"). */
export function clearFrameFailure(world: string, vid: string): void {
  gm.set(failKey(world, vid), null);
}

const FAIL_REASONS: Record<Exclude<FrameState, 'ok'>, string> = {
  'aldeia-errada': 'o jogo abriu outra aldeia no quadro',
  'sem-licenca': 'a licença não estava ativa no quadro',
  desafio: 'o jogo pediu o desafio anti-bot',
  'fora-da-praca': 'o jogo não abriu a Praça no quadro (sessão expirada?)',
};

export interface HostDemand {
  /** Aldeia de origem (sem "n"). */
  vid: string;
  /** Envio mais próximo dessa origem (hora do servidor, ms). */
  nextSendAt: number;
}

/**
 * Um passo do anfitrião: abre quadros para as origens que precisam, mantém a
 * reserva viva, detecta falha e fecha quadros sem uso. `demands` = origens com
 * comando vivo sem aba pronta; `stillNeeded` = origens com comando vivo ou em
 * envio nos próximos minutos (o quadro fica aberto).
 */
export function hostFramesTick(world: string, demands: readonly HostDemand[], stillNeeded: ReadonlySet<string>, nowServer: number): void {
  const now = Date.now();
  bindPagehide(world);
  // 1) Manter/fechar/diagnosticar os quadros desta aba — lendo o quadro DIRETO
  // (mesma origem), sem depender do sinal no storage (timers desacelerados).
  for (const [vid, info] of frames) {
    if (stillNeeded.has(vid)) info.lastNeededAt = now;
    const state = localFrameState(info.el, vid);
    if (state === 'ok') info.everOk = true;
    if (state === 'desafio') {
      // Desafio anti-bot no quadro: pausa TUDO (nunca resolver sozinho).
      if (!isHalted()) tripHalt('captcha', 'O jogo mostrou o desafio anti-bot no envio em 2º plano — abra a Praça numa aba e resolva.');
      markFailed(world, vid, FAIL_REASONS.desafio);
      closeFrame(world, vid);
      continue;
    }
    if (state !== 'ok' && state !== 'carregando' && !frameMidSend(info.el)) {
      markFailed(world, vid, FAIL_REASONS[state]);
      closeFrame(world, vid);
      continue;
    }
    // Prazo de carga só vale ANTES da 1ª vez pronto: depois, "carregando" é a
    // navegação do próprio envio (confirmação/POST) — nunca fecha no meio.
    if (state === 'carregando' && !info.everOk && now - info.createdAt > FRAME_BOOT_TIMEOUT_MS) {
      markFailed(world, vid, 'o quadro não respondeu (a página não carregou a tempo)');
      closeFrame(world, vid);
      continue;
    }
    if (now - info.lastNeededAt > FRAME_LINGER_MS && !frameMidSend(info.el)) {
      closeFrame(world, vid);
      continue;
    }
    gm.set(hostKey(world, vid), { tab: tabIdForHost, at: now });
  }
  // 2) Abrir quadros novos.
  for (const demand of demands) {
    if (frames.size >= MAX_FRAMES) break;
    if (frames.has(demand.vid)) continue;
    const inMs = demand.nextSendAt - nowServer;
    if (inMs > FRAME_LEAD_MS || inMs < FRAME_MIN_MS) continue;
    if (frameFailedRecently(world, demand.vid) !== null) continue;
    const host = gm.get<{ tab: string; at: number } | null>(hostKey(world, demand.vid), null);
    if (host !== null && host.tab !== tabIdForHost && now - host.at < HOST_TTL_MS) continue;
    if (frameAliveFor(world, demand.vid)) continue;
    gm.set(hostKey(world, demand.vid), { tab: tabIdForHost, at: now });
    openFrame(demand.vid);
  }
}

/** Estado do quadro lido direto do documento dele (mesma origem). */
function localFrameState(el: HTMLIFrameElement, vid: string): FrameState | 'carregando' {
  try {
    const w = el.contentWindow as (Window & { game_data?: { village?: { id?: unknown } } }) | null;
    const d = el.contentDocument;
    if (w === null || d === null) return 'carregando';
    if (w.location.href === 'about:blank' || d.readyState === 'loading') return 'carregando';
    if (pageShowsBotProtection(d)) return 'desafio';
    if (!/\/game\.php$/.test(w.location.pathname) || new URLSearchParams(w.location.search).get('screen') !== 'place') return 'fora-da-praca';
    const id = w.game_data?.village?.id;
    if (id !== undefined && id !== null && String(id) !== vid) return 'aldeia-errada';
    return 'ok';
  } catch {
    // Outra origem (o jogo mandou para a tela de login): sessão caiu.
    return 'fora-da-praca';
  }
}

let pagehideBound = false;
/** Aba saindo (navegou/fechou): os quadros morrem junto — solta as reservas
 *  e o sinal de vida, para outra aba (ou a próxima página) assumir na hora. */
function bindPagehide(world: string): void {
  if (pagehideBound) return;
  pagehideBound = true;
  window.addEventListener('pagehide', () => {
    for (const vid of frames.keys()) {
      const host = gm.get<{ tab: string; at: number } | null>(hostKey(world, vid), null);
      if (host !== null && host.tab === tabIdForHost) gm.set(hostKey(world, vid), null);
      gm.set(beatKey(world, vid), null);
    }
  });
}

/** O quadro está no meio do envio (tela de confirmação aberta)? Não fecha. */
function frameMidSend(el: HTMLIFrameElement): boolean {
  try {
    return /[?&]try=confirm/.test(el.contentWindow?.location.search ?? '');
  } catch {
    return false;
  }
}

function openFrame(vid: string): void {
  const el = document.createElement('iframe');
  el.name = `${FRAME_NAME_PREFIX}${vid}`;
  el.src = `/game.php?village=${encodeURIComponent(vid)}&screen=place`;
  el.title = 'Envio em segundo plano (Toxic Squad Hub)';
  el.setAttribute('aria-hidden', 'true');
  el.tabIndex = -1;
  // Invisível, mas NÃO display:none (o navegador poderia congelar o quadro).
  el.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;height:600px;border:0;opacity:0;pointer-events:none;';
  document.body.appendChild(el);
  frames.set(vid, { el, createdAt: Date.now(), lastNeededAt: Date.now(), everOk: false });
}

function closeFrame(world: string, vid: string): void {
  const info = frames.get(vid);
  info?.el.remove();
  frames.delete(vid);
  const host = gm.get<{ tab: string; at: number } | null>(hostKey(world, vid), null);
  if (host !== null && host.tab === tabIdForHost) gm.set(hostKey(world, vid), null);
}

/** Fecha todos os quadros desta aba (testes e desligamento). */
export function closeAllFrames(world: string): void {
  for (const vid of [...frames.keys()]) closeFrame(world, vid);
}

/** Quantos quadros esta aba mantém agora (para a interface). */
export function hostedFrameCount(): number {
  return frames.size;
}
