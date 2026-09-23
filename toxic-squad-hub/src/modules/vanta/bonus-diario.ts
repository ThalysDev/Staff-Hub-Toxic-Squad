// Bônus Diário — coleta o bônus diário do jogo e guarda o histórico (GM storage).
//
// Tela canônica do bônus: screen=info_player&mode=daily_bonus — é para lá que
// aponta o link "Bônus diário" do menu do jogo, com o selo `badge-daily-bonus`
// (capturado nas fixtures do BR142: tests/fixtures/br142/*.html e
// tests/diag/canary-out/*.html). O painel de visão geral também casa o launcher
// porque é de lá que o jogador abre a tela.
//
// Decisões (e o porquê):
// - A coleta é o CLIQUE no controle canônico "Coletar" do jogo, não um POST
//   montado à mão: o controle carrega action e h= corretos e é o único
//   mecanismo certificável sem fixture da tela de bônus (AGENTS.md proíbe
//   parser de tela nova sem fixture real) — o clique dispara o POST do próprio
//   jogo. Fail-closed: sem controle canônico NADA é clicado.
// - Histórico gravado ANTES do clique (o POST pode recarregar a página) e
//   confirmado por ausência: se num carregamento seguinte o botão sumiu, a
//   entrada pendente vira "ok". Sem resposta do jogo, a entrada fica
//   "solicitada" — nunca dizemos "coletado" sem evidência.
// - Confirmação ao LIGAR o automático (automação assumida pelo dono; sem
//   confirmação por ciclo), como no Auto Cunhar/Etiquetador.
// - Teto para a navegação automática: no máximo 3 aberturas da tela do bônus
//   por dia e 1 a cada 5 min — sem isso, "não encontrado" viraria loop de
//   navegação. P1-4: timers/listeners/node via ModuleScope.

import { gm } from '../../core/storage';
import type { ModuleScope } from './vanta-lifecycle';
import { registerVanta } from './vanta-registry';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

const BONUS_URL = '/game.php?screen=info_player&mode=daily_bonus';
const ENABLED_KEY = 'tsh-vanta:bonus:enabled';
const HISTORY_KEY = 'tsh-vanta:bonus:history';
const AUTONAV_KEY = 'tsh-vanta:bonus:autonav';
const ONCE_KEY = 'tsh-vanta:bonus:coletar-uma-vez';

const HISTORY_MAX = 20;
/** Pausa antes de agir (dá tempo do jogo assentar o DOM da tela). */
const PAUSE_MS = 500;
/** Janela para a "confirmação por ausência" do botão depois do clique. */
const CONFIRM_MS = 1500;
/** Flag de coleta armada vale só para a navegação logo em seguida. */
const ONCE_VALID_MS = 2 * 60 * 1000;
const AUTONAV_MAX = 3;
const AUTONAV_INTERVAL_MS = 5 * 60 * 1000;
/** Janela em que uma entrada "solicitada" ainda é a coleta recém-clicada. */
const PENDING_WINDOW_MS = 15 * 60 * 1000;

type BonusOrigin = 'auto' | 'manual';
type BonusOutcome = 'ok' | 'solicitada' | 'falha';

export interface BonusEntry {
  ts: number;
  origem: BonusOrigin;
  resultado: BonusOutcome;
}

/** Tela canônica do bônus diário (link do menu do jogo aponta para cá). */
function isBonusScreen(): boolean {
  return params().get('screen') === 'info_player' && params().get('mode') === 'daily_bonus';
}

/** Visão geral / página principal: onde o jogador está e o link do bônus aparece. */
function isOverviewScreen(): boolean {
  const screen = params().get('screen');
  return screen === null || screen === 'overview' || screen === 'main';
}

// ── Localização do controle canônico de coleta ──────────────────────────────

/** Controles clicáveis do jogo (a, button, input submit/button). */
const CLICKABLE_SELECTOR = 'a.btn, .btn, button, input[type="submit"], input[type="button"]';
/** Containers com "bônus" no id/classe: único escopo seguro fora da tela do bônus. */
const BONUS_SCOPE_SELECTOR =
  '[id*="daily_bonus"], [class*="daily_bonus"], [id*="daily-bonus"], [class*="daily-bonus"], [id*="bonus"], [class*="bonus"]';
const COLLECT_TEXT = /^(coletar|resgatar|receber)(\s|$)/i;

function controlText(el: Element): string {
  const raw = el instanceof HTMLInputElement ? el.value : (el.textContent ?? '');
  return raw.replace(/\s+/g, ' ').trim();
}

function isDisabled(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) {
    if (el.disabled) return true;
  }
  return (
    el.hasAttribute('disabled') ||
    el.getAttribute('aria-disabled') === 'true' ||
    el.classList.contains('btn-disabled') ||
    el.classList.contains('disabled')
  );
}

function usableCollectControl(root: ParentNode): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(CLICKABLE_SELECTOR)) {
    if (isDisabled(el)) continue;
    const text = controlText(el);
    if (!COLLECT_TEXT.test(text)) continue;
    // "Coletar recursos" (Praça de Reunião / coleta em massa) nunca é o bônus.
    if (/recurso/i.test(text)) continue;
    return el;
  }
  return null;
}

/**
 * Controle "Coletar" do bônus diário — conservador de propósito (fail-closed):
 * 1. Escopo explícito com "bônus" no id/classe (vale em qualquer tela);
 * 2. Somente na tela canônica do bônus, o conteúdo principal (aí um "Coletar"
 *    do conteúdo É o do bônus);
 * 3. Nada mais — em outra tela, um "Coletar" genérico pode ser outra ação.
 */
export function findBonusButton(doc: Document = document): HTMLElement | null {
  for (const scope of doc.querySelectorAll<HTMLElement>(BONUS_SCOPE_SELECTOR)) {
    const found = usableCollectControl(scope);
    if (found !== null) return found;
  }
  if (isBonusScreen()) {
    const content = doc.getElementById('contentContainer') ?? doc.body;
    return usableCollectControl(content);
  }
  return null;
}

// ── Storage: histórico e estado da navegação automática ─────────────────────

function loadHistory(): BonusEntry[] {
  const raw: unknown = gm.get<unknown>(HISTORY_KEY, []);
  if (!Array.isArray(raw)) return [];
  const entries: BonusEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.ts !== 'number' || !Number.isFinite(o.ts)) continue;
    const origem: BonusOrigin = o.origem === 'manual' ? 'manual' : 'auto';
    const resultado: BonusOutcome =
      o.resultado === 'ok' ? 'ok' : o.resultado === 'falha' ? 'falha' : 'solicitada';
    entries.push({ ts: o.ts, origem, resultado });
  }
  return entries.slice(0, HISTORY_MAX);
}

function saveHistory(entries: BonusEntry[]): void {
  gm.set(HISTORY_KEY, entries.slice(0, HISTORY_MAX));
}

/** Registra a tentativa e devolve o ts da entrada (chave para confirmá-la). */
function addEntry(origem: BonusOrigin, resultado: BonusOutcome): number {
  const ts = Date.now();
  saveHistory([{ ts, origem, resultado }, ...loadHistory()]);
  return ts;
}

function setEntryOutcome(ts: number, resultado: BonusOutcome): void {
  const entries = loadHistory();
  const index = entries.findIndex((entry) => entry.ts === ts);
  const current = index === -1 ? undefined : entries[index];
  if (current === undefined) return;
  entries[index] = { ts: current.ts, origem: current.origem, resultado };
  saveHistory(entries);
}

function localDayKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function collectedToday(): boolean {
  const first = loadHistory()[0];
  return first !== undefined && first.resultado === 'ok' && localDayKey(first.ts) === localDayKey(Date.now());
}

interface AutoNavState {
  dia: string;
  tentativas: number;
  ultima: number;
}

/** Estado da navegação automática do dia (zera sozinho na virada do dia). */
function loadAutoNav(): AutoNavState {
  const today = localDayKey(Date.now());
  const raw: unknown = gm.get<unknown>(AUTONAV_KEY, null);
  if (typeof raw !== 'object' || raw === null) return { dia: today, tentativas: 0, ultima: 0 };
  const o = raw as Record<string, unknown>;
  if (o.dia !== today) return { dia: today, tentativas: 0, ultima: 0 };
  const tentativas = typeof o.tentativas === 'number' && Number.isFinite(o.tentativas) ? o.tentativas : 0;
  const ultima = typeof o.ultima === 'number' && Number.isFinite(o.ultima) ? o.ultima : 0;
  return { dia: today, tentativas: Math.max(0, Math.trunc(tentativas)), ultima };
}

function shouldAutoOpen(): boolean {
  const state = loadAutoNav();
  if (state.tentativas >= AUTONAV_MAX) return false;
  if (Date.now() - state.ultima < AUTONAV_INTERVAL_MS) return false;
  return !collectedToday();
}

function registerAutoOpen(): void {
  const state = loadAutoNav();
  gm.set(AUTONAV_KEY, { dia: state.dia, tentativas: state.tentativas + 1, ultima: Date.now() });
}

function armOnceCollect(): void {
  try {
    sessionStorage.setItem(ONCE_KEY, String(Date.now()));
  } catch {
    /* sessionStorage indisponível — a navegação segue, sem coleta armada */
  }
}

function consumeOnceCollect(): boolean {
  try {
    const raw = sessionStorage.getItem(ONCE_KEY);
    if (raw === null) return false;
    sessionStorage.removeItem(ONCE_KEY);
    const ts = Number(raw);
    return Number.isFinite(ts) && Date.now() - ts < ONCE_VALID_MS;
  } catch {
    return false;
  }
}

// ── Launcher ────────────────────────────────────────────────────────────────

const STYLES = `
  #vanta-bonus-diario-ui {
    margin: 10px 0 16px;
    background: var(--shs-bg-card, #fffdf3);
    border: 1px solid var(--shs-border, #e0cda0);
    border-radius: 10px;
    font-family: var(--shs-font);
    overflow: hidden;
  }
  #vanta-bonus-diario-ui * { box-sizing: border-box; }
  #vanta-bonus-diario-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 9px 14px; background: var(--shs-bg-head, #efe2ba); border-bottom: 1px solid var(--shs-border, #e0cda0);
  }
  #vanta-bonus-diario-header-title {
    font-size: 12px; font-weight: 700; letter-spacing: 2px;
    color: var(--shs-ink-strong, #3c250a); text-transform: uppercase;
  }
  #vanta-bonus-diario-chip {
    font-size: 10px; font-weight: 600; line-height: 1;
    padding: 4px 9px; border-radius: 999px; background: var(--shs-bg-card, #fffdf3);
    border: 1px solid var(--shs-border-strong, #cbb384); color: var(--shs-ink, #5a3a16); white-space: nowrap;
  }
  #vanta-bonus-diario-body { padding: 10px 14px 12px; font-size: 12px; color: var(--shs-ink-strong, #3c250a); }
  #vanta-bonus-diario-status { min-height: 16px; line-height: 1.35; color: var(--shs-ink, #5a3a16); }
  #vanta-bonus-diario-actions { margin: 8px 0 4px; }
  #vanta-bonus-diario-coletar {
    background: var(--shs-action, #6d3c14); color: #fff; border: 1px solid var(--shs-action-deep, #5a3110);
    border-radius: 8px; padding: 6px 14px; cursor: pointer; font-size: 12px; font-weight: 600;
  }
  #vanta-bonus-diario-coletar:hover { background: #7d4720; }
  #vanta-bonus-diario-auto-row {
    display: flex; align-items: center; gap: 6px; margin-top: 6px; cursor: pointer;
  }
  #vanta-bonus-diario-hist-header {
    display: flex; align-items: center; justify-content: space-between;
    margin: 10px 0 4px; padding-top: 8px; border-top: 1px solid var(--shs-border, #e0cda0);
  }
  #vanta-bonus-diario-hist-title {
    font-size: 10.5px; font-weight: 700; letter-spacing: 1px;
    text-transform: uppercase; color: var(--shs-accent-ink, #8a5a1e);
  }
  #vanta-bonus-diario-limpar {
    background: transparent; border: none; cursor: pointer;
    color: var(--shs-muted, #6f5e40); font-size: 11px; text-decoration: underline; padding: 0;
  }
  #vanta-bonus-diario-limpar:hover { color: var(--shs-danger, #c04038); }
  #vanta-bonus-diario-hist {
    list-style: none; margin: 0; padding: 0; max-height: 132px; overflow-y: auto;
  }
  #vanta-bonus-diario-hist li {
    display: flex; justify-content: space-between; gap: 8px;
    padding: 3px 0; font-size: 11.5px; color: var(--shs-ink, #5a3a16);
    border-bottom: 1px dashed #ece0c0;
  }
  #vanta-bonus-diario-hist li:last-child { border-bottom: none; }
  #vanta-bonus-diario-hist .vbd-ok { color: var(--shs-ok, #3f8f43); font-weight: 600; }
  #vanta-bonus-diario-hist .vbd-pend { color: var(--shs-accent-ink, #8a5a1e); }
  #vanta-bonus-diario-hist .vbd-falha { color: var(--shs-danger, #c04038); font-weight: 600; }
  #vanta-bonus-diario-hist .vbd-vazio { color: var(--shs-muted, #6f5e40); font-style: italic; }
`;

function ensureStyles(scope: ModuleScope): void {
  if (document.getElementById('tsh-bonus-diario-styles') !== null) return;
  const style = document.createElement('style');
  style.id = 'tsh-bonus-diario-styles';
  style.textContent = STYLES;
  (document.head ?? document.documentElement).appendChild(style);
  scope.owns(style);
}

const OUTCOME_LABEL: Record<BonusOutcome, string> = {
  ok: 'coletado',
  solicitada: 'solicitado',
  falha: 'falha',
};

const OUTCOME_CLASS: Record<BonusOutcome, string> = {
  ok: 'vbd-ok',
  solicitada: 'vbd-pend',
  falha: 'vbd-falha',
};

registerVanta({
  id: 'vanta-bonus-diario',
  label: 'Bônus Diário',
  icon: 'gift',
  desc: 'Coleta o bônus diário do jogo e guarda o histórico',
  group: 'utilidades',
  match: () => isBonusScreen() || isOverviewScreen(),
  url: () => BONUS_URL,
  mount(scope: ModuleScope): void {
    if (document.getElementById('vanta-bonus-diario-ui') !== null) return;
    ensureStyles(scope);

    const savedEnabled = gm.get<boolean>(ENABLED_KEY, false);

    // UI monta só onde há container de conteúdo — a AUTOMAÇÃO abaixo é
    // independente da UI (fail-closed: sem UI, nada quebra, só não aparece card).
    let status: HTMLElement | null = null;
    let chip: HTMLElement | null = null;
    let historyList: HTMLElement | null = null;
    /** Coleta em andamento (evita POST duplo por clique duplo/auto+manual). */
    let coletando = false;

    const contentEl = document.getElementById('contentContainer') ?? document.getElementById('content');
    if (contentEl !== null) {
      const container = document.createElement('div');
      container.id = 'vanta-bonus-diario-ui';
      container.innerHTML = `
              <div id="vanta-bonus-diario-header">
                  <span id="vanta-bonus-diario-header-title">Bônus Diário</span>
                  <span id="vanta-bonus-diario-chip"></span>
              </div>
              <div id="vanta-bonus-diario-body">
                  <div id="vanta-bonus-diario-status"></div>
                  <div id="vanta-bonus-diario-actions">
                      <button type="button" id="vanta-bonus-diario-coletar">Coletar bônus diário agora</button>
                  </div>
                  <label id="vanta-bonus-diario-auto-row">
                      <input type="checkbox" id="vanta-bonus-diario-toggle" ${savedEnabled ? 'checked' : ''}>
                      <span>Coletar automaticamente (verifica a cada carregamento)</span>
                  </label>
                  <div id="vanta-bonus-diario-hist-header">
                      <span id="vanta-bonus-diario-hist-title">Histórico</span>
                      <button type="button" id="vanta-bonus-diario-limpar">limpar</button>
                  </div>
                  <ul id="vanta-bonus-diario-hist"></ul>
              </div>
          `;
      contentEl.insertBefore(container, contentEl.firstChild);
      scope.owns(container);

      const statusEl = document.getElementById('vanta-bonus-diario-status');
      const chipEl = document.getElementById('vanta-bonus-diario-chip');
      const histEl = document.getElementById('vanta-bonus-diario-hist');
      const toggleEl = document.getElementById('vanta-bonus-diario-toggle');
      const collectEl = document.getElementById('vanta-bonus-diario-coletar');
      const clearEl = document.getElementById('vanta-bonus-diario-limpar');
      if (
        statusEl !== null &&
        chipEl !== null &&
        histEl !== null &&
        toggleEl instanceof HTMLInputElement &&
        collectEl !== null &&
        clearEl !== null
      ) {
        // Consts já estreitadas — o narrowing precisa valer dentro das closures.
        const statusNode: HTMLElement = statusEl;
        const chipNode: HTMLElement = chipEl;
        const histNode: HTMLElement = histEl;
        const toggleNode: HTMLInputElement = toggleEl;
        status = statusNode;
        chip = chipNode;
        historyList = histNode;

        scope.on(collectEl, 'click', () => {
          if (findBonusButton() !== null) {
            collect('manual');
            return;
          }
          // Sem o controle nesta tela: abre a tela do bônus com a coleta armada
          // 1× (o mount de lá coleta sem exigir um segundo clique).
          armOnceCollect();
          setStatus('#5a3a16', 'Abrindo a tela do bônus diário para coletar…');
          scope.after(() => {
            window.location.href = BONUS_URL;
          }, PAUSE_MS);
        });

        scope.on(clearEl, 'click', () => {
          gm.set(HISTORY_KEY, []);
          paintHistory();
          setStatus('#5a3a16', 'Histórico limpo.');
        });

        scope.on(toggleNode, 'change', () => {
          const on = toggleNode.checked;
          if (
            on &&
            !window.confirm(
              'Ativar a coleta automática do bônus diário?\n\n' +
                'Ela verifica o bônus a cada carregamento de página e coleta sozinha (o clique envia o POST do próprio jogo). ' +
                'Se o botão não estiver na tela atual, abre a tela do bônus diário — no máximo 3× por dia. Confirma?',
            )
          ) {
            toggleNode.checked = false;
            return;
          }
          gm.set(ENABLED_KEY, on);
          if (on) {
            autoRun();
          } else {
            setStatus('#5a3a16', 'Automático desligado.');
          }
          paintChip();
        });
      }
    }

    function setStatus(color: string, text: string): void {
      if (status === null) return;
      status.style.color = color;
      status.textContent = text;
    }

    function paintChip(): void {
      if (chip === null) return;
      const on = gm.get<boolean>(ENABLED_KEY, false);
      chip.textContent = on ? 'automático ligado' : 'automático desligado';
      chip.style.color = on ? '#3f8f43' : '#5a3a16';
    }

    function paintHistory(): void {
      if (historyList === null) return;
      const entries = loadHistory();
      const title = document.getElementById('vanta-bonus-diario-hist-title');
      if (title !== null) title.textContent = `Histórico (${entries.length})`;
      historyList.replaceChildren();
      if (entries.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'vbd-vazio';
        empty.textContent = 'Nenhuma coleta registrada ainda.';
        historyList.appendChild(empty);
        return;
      }
      for (const entry of entries) {
        const item = document.createElement('li');
        const when = document.createElement('span');
        when.textContent = `${fmtDateTime(entry.ts)} · ${entry.origem === 'auto' ? 'auto' : 'manual'}`;
        const result = document.createElement('span');
        result.className = OUTCOME_CLASS[entry.resultado];
        result.textContent = OUTCOME_LABEL[entry.resultado];
        item.append(when, result);
        historyList.appendChild(item);
      }
    }

    function paintIdleStatus(): void {
      if (findBonusButton() !== null) {
        setStatus('#5a3a16', 'Bônus disponível nesta tela — pode coletar agora.');
        return;
      }
      if (collectedToday()) {
        setStatus('#3f8f43', 'Bônus de hoje já coletado (nenhum "Coletar" na tela).');
        return;
      }
      if (isBonusScreen()) {
        setStatus('#5a3a16', 'Bônus não encontrado nesta tela — nada foi clicado.');
        return;
      }
      setStatus(
        '#5a3a16',
        'Esta tela não tem o botão do bônus. "Coletar bônus diário agora" abre a tela do bônus e coleta lá.',
      );
    }

    /** Confirmação por ausência: sumiu o botão depois do clique = coletado. */
    function markCollected(ts: number): void {
      setEntryOutcome(ts, 'ok');
      setStatus('#3f8f43', 'Bônus diário coletado.');
      paintHistory();
    }

    /**
     * Coleta: clica o controle canônico do jogo (que dispara o POST com o h=
     * da própria página). Fail-closed — sem controle, nada é clicado.
     */
    function collect(origem: BonusOrigin): void {
      if (coletando) return; // clique duplo não vira POST duplo
      const button = findBonusButton();
      if (button === null) {
        setStatus('#5a3a16', 'Bônus não encontrado nesta tela — nada foi clicado.');
        return;
      }
      // Histórico ANTES do clique: o POST pode recarregar a página e levar o
      // registro embora junto.
      coletando = true;
      const ts = addEntry(origem, 'solicitada');
      paintHistory();
      setStatus('#3f8f43', `Coletando o bônus diário (${origem === 'auto' ? 'automático' : 'manual'})…`);
      scope.after(() => {
        const target = button.isConnected ? button : findBonusButton();
        if (target === null) {
          // O jogo re-renderizou e não há mais o que clicar.
          coletando = false;
          markCollected(ts);
          return;
        }
        try {
          target.click();
        } catch {
          coletando = false;
          setEntryOutcome(ts, 'falha');
          setStatus('#c04038', 'Falha ao clicar no botão do bônus do jogo.');
          paintHistory();
          return;
        }
        scope.after(() => {
          coletando = false;
          if (findBonusButton() === null) {
            markCollected(ts);
            return;
          }
          setStatus(
            '#5a3a16',
            'Solicitação enviada — o jogo ainda mostra o botão de coleta. Confira na tela antes de repetir.',
          );
          paintHistory();
        }, CONFIRM_MS);
      }, PAUSE_MS);
    }

    /** Rotina do modo automático: coleta aqui; sem o botão, abre a tela do bônus (com teto). */
    function autoRun(): void {
      if (!gm.get<boolean>(ENABLED_KEY, false)) return;
      if (findBonusButton() !== null) {
        collect('auto');
        return;
      }
      if (!isBonusScreen() && shouldAutoOpen()) {
        registerAutoOpen();
        setStatus('#5a3a16', 'Sem o botão nesta tela — abrindo a tela do bônus diário para verificar…');
        scope.after(() => {
          window.location.href = BONUS_URL;
        }, PAUSE_MS);
        return;
      }
      setStatus('#5a3a16', 'Bônus não encontrado nesta tela — nada foi clicado.');
    }

    // Confirmação por ausência de uma coleta anterior (o clique navegou antes de
    // conseguirmos confirmar): na tela do bônus, sem botão, aquela coleta deu certo.
    if (isBonusScreen() && findBonusButton() === null) {
      const pending = loadHistory()[0];
      if (pending !== undefined && pending.resultado === 'solicitada' && Date.now() - pending.ts < PENDING_WINDOW_MS) {
        markCollected(pending.ts);
      }
    }

    paintChip();
    paintHistory();

    // Coleta armada 1× (veio do botão manual) tem prioridade sobre o automático.
    if (consumeOnceCollect()) {
      setStatus('#3f8f43', 'Coleta do bônus armada — coletando…');
      collect('manual');
      return;
    }
    if (savedEnabled) {
      autoRun();
      return;
    }
    paintIdleStatus();
  },
});
