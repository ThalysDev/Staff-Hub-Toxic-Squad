// Disjuntor global (Onda 1 · 3.1.2): captcha ou sessão expirada PARAM o
// script inteiro — nenhuma automação roda e nenhum pedido sai para o jogo até
// o jogador resolver no próprio navegador e clicar em "Já resolvi — retomar".
// Antes cada módulo só lançava erro e tentava de novo no ciclo seguinte
// (inclusive a Sentinela), martelando o jogo com a proteção aberta.
// Estado em GM storage: vale para TODAS as abas do jogo ao mesmo tempo.

import { gm } from './storage';

export type HaltReason = 'captcha' | 'sessao';

export interface HaltState {
  reason: HaltReason;
  at: number;
  detail: string;
}

const HALT_KEY = 'tsh:halt';

/** Lançado por quem tenta usar a rede com o disjuntor aberto. */
export class HaltedError extends Error {
  constructor(state: HaltState) {
    super(`${haltLabel(state)} — o script está pausado até você resolver no jogo e clicar em "Já resolvi — retomar".`);
    this.name = 'HaltedError';
  }
}

export function haltState(): HaltState | null {
  return gm.get<HaltState | null>(HALT_KEY, null);
}

export function isHalted(): boolean {
  return haltState() !== null;
}

/** Abre o disjuntor (idempotente: o primeiro motivo fica registrado). */
export function tripHalt(reason: HaltReason, detail: string): void {
  if (isHalted()) return;
  gm.set<HaltState>(HALT_KEY, { reason, at: Date.now(), detail });
}

/** Só o jogador fecha o disjuntor (botão na Início). */
export function clearHalt(): void {
  gm.set<HaltState | null>(HALT_KEY, null);
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
