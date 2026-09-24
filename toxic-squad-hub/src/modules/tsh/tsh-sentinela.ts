// Modo Sentinela (Onda 5, Parte A): uma ABA DE FUNDO do próprio jogo que
// mantém as automações ciclando sem o painel aberto.
//
// O que é (e o que NÃO é): é uma página NORMAL do jogo
// (/game.php?screen=overview_villages&tsh-sentinela=1) com o userscript
// carregado — nada de service worker, nada de aba abrindo sozinha. Nessa aba o
// main.ts pula shell/painel (aba de fundo não precisa de UI além do título) e
// liga o MESMO heartbeat das automações (startTshHeartbeat). O lock por
// módulo+mundo do runtime garante que só UMA aba executa cada automação, então
// Sentinela + aba normal não duplicam ações.
//
// LIMITE DOCUMENTADO (decisão desta onda; o gate de tela do runtime NÃO foi
// reescrito): automações API-first (screen null) rodam em qualquer tela — logo
// rodam na Sentinela; as automações presas a uma tela (snob, train, market,
// inventory, statue…) continuam rodando só quando a ABA ATIVA está naquela
// tela. A Sentinela destrava as API-first e ACELERA as demais quando o jogador
// navega nela (a aba fica viva e assume os módulos assim que a tela aparece).
//
// O botão "Abrir Sentinela" mora FORA do shadow do painel (a aba de fundo não
// carrega shell): é um mini-botão flutuante discreto injetado no documento,
// com confirmação explicando o que a aba faz.

import { icon } from '../../core/icons';
import type { ModuleScope } from '../vanta/vanta-lifecycle';
import { currentVillageId } from '../vanta/vanta-net';
import { activeTshCount } from './tsh-runtime';
import { tshConfirm } from './tsh-settings-ui';
import { ensureHost } from '../../core/shell';

// ── Registro dos plugins novos da Onda 5 (efeito colateral) ────────────────
// O index da suíte (./index) não é desta onda, então o registro dos módulos
// novos mora aqui — este módulo é importado pelo main.ts em qualquer aba.
import './plugins/auto-mint-nativo';
import './plugins/abrir-pacotes';
import './plugins/renomeador-aldeias';
import './plugins/ativador-itens';
import './plugins/paladino-skills';

/** Parâmetro que marca a aba como Sentinela. */
export const SENTINELA_PARAM = 'tsh-sentinela';
/** Título-base da aba (o badge acrescenta a contagem de automações ativas). */
export const SENTINELA_TITULO = '🛡 Sentinela TSH';
const SENTINELA_TAB_NAME = 'tsh-sentinela';
const BADGE_INTERVAL_MS = 5_000;
const FAB_ID = 'tsh-sentinela-fab';
const FAB_STYLE_ID = 'tsh-sentinela-fab-style';

/** A aba atual é a Sentinela? (URL com &tsh-sentinela=1) */
export function isSentinelaTab(): boolean {
  return new URLSearchParams(window.location.search).get(SENTINELA_PARAM) === '1';
}

/**
 * URL da Sentinela (pura, testável): Visão das Aldeias marcada com o
 * parâmetro — é uma tela leve e estável, que não dispara nenhuma ação do jogo.
 */
export function sentinelaUrl(villageId: string): string {
  const id = String(villageId).replace(/^n/, '').trim();
  const prefixo = id === '' ? '' : `village=${encodeURIComponent(id)}&`;
  return `/game.php?${prefixo}screen=overview_villages&${SENTINELA_PARAM}=1`;
}

/** Rótulo do badge: "nenhuma ativa" / "3 ativas". */
export function sentinelaBadgeTitle(ativas: number): string {
  const total = Number.isFinite(ativas) ? Math.max(0, Math.floor(ativas)) : 0;
  return `${SENTINELA_TITULO} — ${total === 0 ? 'nenhuma ativa' : `${total} ativa${total === 1 ? '' : 's'}`}`;
}

/**
 * Badge da aba: mantém o título com a contagem de automações ATIVAS (o painel
 * fica fechado/escondido; o título é a única leitura rápida). Timer RASTRADO
 * pelo escopo — nenhum interval solto no documento.
 */
export function startSentinelaBadge(scope: ModuleScope): void {
  const atualizar = (): void => {
    document.title = sentinelaBadgeTitle(activeTshCount());
  };
  atualizar();
  scope.every(atualizar, BADGE_INTERVAL_MS);
}

/**
 * Abre a aba da Sentinela (window.open) na aldeia pedida — sem parâmetro, usa
 * a aldeia aberta no jogo. Bloqueio de pop-up é reportado com clareza, sem
 * fallback silencioso. O título provisório é best-effort: a própria aba o
 * substitui pelo badge ao carregar.
 */
export function openSentinelaTab(villageId: string = currentVillageId()): void {
  const aba = window.open(sentinelaUrl(villageId), SENTINELA_TAB_NAME);
  if (aba === null) {
    window.alert(
      'O navegador bloqueou a aba da Sentinela. Libere pop-ups para este site e clique de novo.',
    );
    return;
  }
  try {
    aba.document.title = SENTINELA_TITULO;
  } catch {
    /* aba ainda carregando — o badge da Sentinela assume o título */
  }
}

function ensureFabStyle(): void {
  if (document.getElementById(FAB_STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = FAB_STYLE_ID;
  // Instrumento (v3.2): à DIREITA do escudo (60 + 44 + 8 px), branco e discreto.
  style.textContent = `
    #${FAB_ID} { position: fixed; left: 112px; bottom: 16px; z-index: 2147482999;
      display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 11px; box-sizing: border-box;
      border-radius: 9px; cursor: pointer; border: 1px solid var(--shs-border-strong, #d4d0c7);
      background: var(--shs-bg-card, #ffffff); color: var(--shs-ink, #34312c);
      font: 500 12.5px/1 var(--shs-font, 'Segoe UI', system-ui, sans-serif);
      box-shadow: 0 2px 8px rgba(20,18,14,.18); }
    #${FAB_ID}:hover { color: var(--shs-ink-strong, #1b1a17); border-color: var(--shs-ink-disabled, #a9a49a); }
    #${FAB_ID}:focus-visible { outline: 2px solid var(--shs-action, #2e6b3e); outline-offset: 2px; }
  `;

  document.head.appendChild(style);
}

/**
 * Mini-botão flutuante "Abrir Sentinela" (fora do shadow do painel), com
 * confirmação explicando que a aba de fundo mantém as automações ciclando.
 * Idempotente e ausente na própria Sentinela.
 */
export function mountSentinelaLauncher(): void {
  if (isSentinelaTab()) return; // a aba de fundo não tem launcher
  if (document.getElementById(FAB_ID) !== null) return;
  ensureFabStyle();
  const fab = document.createElement('button');
  fab.id = FAB_ID;
  fab.type = 'button';
  fab.title =
    'Abrir Sentinela — abre uma aba de fundo do jogo que mantém as automações ciclando com o painel fechado';
  fab.setAttribute('aria-label', 'Abrir Sentinela');
  fab.appendChild(icon('shieldCheck', 12));
  const rotulo = document.createElement('span');
  rotulo.textContent = 'Sentinela';
  fab.appendChild(rotulo);
  fab.addEventListener('click', () => {
    // Mesmo diálogo do painel (antes: window.confirm nativo do navegador).
    void tshConfirm(
      ensureHost(),
      'Abrir o Modo Sentinela',
      'Abre uma aba de fundo do jogo que mantém as automações ligadas rodando, mesmo com o painel fechado. ' +
        'Nada é duplicado: o script trava por mundo. Automações presas a uma tela (Academia, Mercado, Inventário) só rodam quando essa tela estiver aberta na Sentinela.',
    ).then((confirmado) => {
      if (confirmado) openSentinelaTab(currentVillageId());
    });
  });
  document.body.appendChild(fab);
}
