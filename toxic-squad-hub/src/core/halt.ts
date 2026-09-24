// Disjuntor global (Onda 1 · 3.1.2): captcha ou sessão expirada PARAM o
// script inteiro — nenhuma automação roda e nenhum pedido sai para o jogo até
// o jogador resolver no próprio navegador e clicar em "Já resolvi — retomar".
// Antes cada módulo só lançava erro e tentava de novo no ciclo seguinte
// (inclusive a Sentinela), martelando o jogo com a proteção aberta.
// Estado em GM storage POR MUNDO: vale para todas as abas daquele mundo.

import { gm } from './storage';

/** Mundo desta página (subdomínio). A pausa vale POR MUNDO: captcha no BR141
 *  não pode parar a OP do BR142 (revisão de produto da Onda 1). */
function worldOf(): string {
  if (typeof window === 'undefined') return 'mundo'; // testes em node
  return window.location.hostname.split('.')[0] ?? 'mundo';
}

export type HaltReason = 'captcha' | 'sessao';

export interface HaltState {
  reason: HaltReason;
  at: number;
  detail: string;
}

const haltKey = (): string => `tsh:${worldOf()}:halt`;

/** Lançado por quem tenta usar a rede com o disjuntor aberto. */
export class HaltedError extends Error {
  constructor(state: HaltState) {
    super(`${haltLabel(state)} — o script está pausado. Resolva no jogo e clique em "Já resolvi — retomar" na aba Início do painel.`);
    this.name = 'HaltedError';
  }
}

export function haltState(): HaltState | null {
  return gm.get<HaltState | null>(haltKey(), null);
}

export function isHalted(): boolean {
  return haltState() !== null;
}

/** Abre o disjuntor (idempotente: o primeiro motivo fica registrado). */
export function tripHalt(reason: HaltReason, detail: string): void {
  if (isHalted()) return;
  gm.set<HaltState>(haltKey(), { reason, at: Date.now(), detail });
}

/** Só o jogador fecha o disjuntor (botão na Início). */
export function clearHalt(): void {
  gm.set<HaltState | null>(haltKey(), null);
}

export function haltLabel(state: HaltState): string {
  return state.reason === 'captcha' ? 'Proteção anti-bot (captcha) do jogo' : 'Sessão do jogo expirada';
}

/** Barra a rede com o disjuntor aberto (chamado pelas filas de core/net). */
export function assertNotHalted(): void {
  const state = haltState();
  if (state !== null) throw new HaltedError(state);
}

/**
 * Proteção anti-bot VISÍVEL na página atual (o jogo mostra o desafio no
 * próprio documento). Checagem barata por seletor — sem varrer o texto.
 */
export function pageShowsBotProtection(doc: Document = document): boolean {
  return (
    doc.querySelector('#bot_check, #botprotection_quest, .bot-protection-row, [id*="captcha"], iframe[src*="captcha"]') !==
    null
  );
}
