// Cancelamento em Bloco (Onda 3 da Suite Vanta) — na Visão de Comandos
// (`overview_villages&mode=commands`) e na aba de comandos da aldeia
// (`screen=info_village`): barra acima da tabela com "Selecionar todos (ida)",
// "Selecionar todos (volta)" e "Cancelar selecionados"; a confirmação abre o
// modal do padrão vanta com a CONTAGEM e os TIPOS do que será cancelado e, só
// depois dela, os comandos são cancelados UM A UM por vantaPostJson (csrf
// renovado pela resposta), com pausa de 300ms entre POSTs e PARADA no primeiro
// erro, com resumo do que já foi cancelado. No fim, a lista é recarregada.
//
// Estrutura verificada (fixtures do br142 em tests/fixtures/br142 e padrões já
// usados pelas ondas anteriores do Hub):
// - cada linha da tabela de comandos traz o checkbox de seleção
//   `input[name="id_<commandId>"]` e o par oculto
//   `input[name="command_ids[<commandId>]"][value="true"]` — usamos os DOIS no
//   POST, como o formulário do próprio jogo faria (incomings-own.html);
// - o cabeçalho da Visão de Comandos expõe `order=start_name` (origem) —
//   usado como marca canônica da tabela (mesma verificação do support-manager);
// - tipo do comando em `[data-command-type]` ("attack"/"support") e o id no
//   link de cancelamento da linha `action=cancel&id=`, padrão verificado no
//   br142 (support-manager.ts);
// - origem/destino da linha pelos links do template (Destino antes de Origem):
//   `screen=info_village&id=` (destino) e `village=` (origem). Linha sem o par
//   reconhecível fica com direção INDEFINIDA: os botões "ida/volta" nunca a
//   marcam por adivinhação.
//
// Fail-closed: sem tabela com o par checkbox+oculto, sem csrf ou sem um alvo
// selecionado, NADA é POSTado — a barra mostra a mensagem pt-BR. O cancelamento
// em si nunca inventa endpoint: usa a URL de cancelamento da própria linha e,
// quando o jogo não a expõe, a ação ajax `info_command&ajaxaction=cancel` (a
// mesma família do `ajaxaction=edit_other_comment` já usada por vanta-net).

import { registerVanta } from './vanta-registry';
import { ensureVantaStyles } from './vanta-styles';
import type { ModuleScope } from './vanta-lifecycle';
import { currentCsrf, currentVillageId, vantaPostJson } from './vanta-net';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/** Aldeia da URL (`village=n123` → `123`); '' quando ausente. */
function normalizeVillageId(raw: string): string {
  return raw.replace(/^n/, '');
}

/** Pausa entre mutações do lote (a fila global já garante ≥200ms; aqui ≥300ms). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Intervalo entre os POSTs do lote (requisito do módulo). */
const PAUSA_MS = 300;

function mensagemDeErro(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Estilos locais (idempotente pelo id; escopo no id do módulo) ──

const STYLE_ID = 'vanta-cb-styles';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
        #vanta-cb-ui {
            display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
            margin: 8px 0; padding: 8px 10px;
            background: #fffdf3; border: 1px solid #e0cda0; border-radius: 10px;
            font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; color: #5a3a16;
        }
        #vanta-cb-ui * { box-sizing: border-box; }
        #vanta-cb-ui .vanta-cb-title {
            font-size: 11px; font-weight: 700; letter-spacing: 1px;
            text-transform: uppercase; color: #8a5a1e;
        }
        #vanta-cb-ui button {
            background: #fbf4de; border: 1px solid #cbb384; border-radius: 8px;
            color: #5a3a16; padding: 4px 10px; font-size: 11px;
            font-family: inherit; cursor: pointer;
        }
        #vanta-cb-ui button:hover:not(:disabled) { background: #efe2ba; border-color: #834a1a; color: #834a1a; }
        #vanta-cb-ui button:disabled { opacity: 0.4; cursor: default; }
        #vanta-cb-ui #vanta-cb-cancelar {
            background: #6d3c14; border-color: #5a3110; color: #fff; font-weight: 600;
        }
        #vanta-cb-ui #vanta-cb-cancelar:hover:not(:disabled) { background: #834a1a; color: #fff; }
        #vanta-cb-ui .vanta-cb-status { flex: 1 1 100%; font-size: 11px; color: #6f5e40; min-height: 14px; }
        #vanta-cb-ui .vanta-cb-status--erro { color: #c04038; }
        #vanta-cb-ui .vanta-cb-status--ok { color: #3f8f43; font-weight: 600; }

        /* Modal de confirmação (padrão vanta, light DOM) */
        .vanta-ccb-overlay {
            position: fixed; inset: 0; z-index: 100002;
            background: rgba(60,37,10,0.42);
            display: flex; align-items: center; justify-content: center;
            font-family: 'Segoe UI', Arial, sans-serif;
        }
        .vanta-ccb-modal {
            width: min(520px, calc(100vw - 32px)); max-height: 80vh;
            display: flex; flex-direction: column;
            background: #fffdf3; border: 1px solid #cbb384; border-radius: 12px;
            box-shadow: 0 16px 48px rgba(60,37,10,0.35); color: #5a3a16;
        }
        .vanta-ccb-head {
            display: flex; align-items: center; justify-content: space-between;
            padding: 9px 14px; background: #efe2ba; border-bottom: 1px solid #e0cda0;
            border-radius: 12px 12px 0 0;
        }
        .vanta-ccb-title {
            font-size: 12px; font-weight: 700; letter-spacing: 1px;
            text-transform: uppercase; color: #8a5a1e;
        }
        .vanta-ccb-close {
            background: none; border: none; color: #6f5e40; font-size: 15px;
            line-height: 1; cursor: pointer; padding: 0 2px;
        }
        .vanta-ccb-close:hover { color: #c04038; }
        .vanta-ccb-body { padding: 12px 14px; overflow-y: auto; font-size: 12.5px; }
        .vanta-ccb-msg { line-height: 1.45; }
        .vanta-ccb-list {
            margin: 8px 0 0; padding: 0; list-style: none;
            font-size: 11.5px; color: #6f5e40;
        }
        .vanta-ccb-list li { padding: 3px 0; border-top: 1px dashed #e0cda0; }
        .vanta-ccb-list li:first-child { border-top: none; }
        .vanta-ccb-foot {
            display: flex; justify-content: flex-end; gap: 8px;
            padding: 10px 14px; border-top: 1px solid #e0cda0;
        }
        .vanta-ccb-btn {
            border: 1px solid #cbb384; border-radius: 8px; background: #fbf4de;
            color: #5a3a16; padding: 5px 14px; font-size: 12px; font-weight: 600;
            font-family: inherit; cursor: pointer;
        }
        .vanta-ccb-btn:hover { background: #efe2ba; }
        .vanta-ccb-btn--danger { background: #fceaea; border-color: #c04038; color: #c04038; }
        .vanta-ccb-btn--danger:hover { background: #f8d7d7; }
    `;
  document.head.appendChild(style);
}

// ── Modal de confirmação (Promise<boolean>) ──

export interface VantaConfirmOptions {
  title: string;
  message: string;
  /** Linhas extras (textContent — nunca HTML dinâmico). */
  details?: readonly string[];
  confirmLabel?: string;
  danger?: boolean;
}

/**
 * Confirmação no visual vanta (pergaminho, light DOM — o painel do Hub vive em
 * Shadow DOM e o tshConfirm de lá não alcança a página do jogo). Resolve false
 * em QUALQUER fechamento sem confirmar (Cancelar, Esc, clique fora, X) e true
 * só no botão de confirmação. Exportada para os launchers da suíte reusarem o
 * MESMO modal (sem cópia divergente).
 */
export function vantaConfirm(scope: ModuleScope, opts: VantaConfirmOptions): Promise<boolean> {
  ensureStyles();
  return new Promise<boolean>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'vanta-ccb-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
            <div class="vanta-ccb-modal">
                <div class="vanta-ccb-head">
                    <span class="vanta-ccb-title"></span>
                    <button type="button" class="vanta-ccb-close" aria-label="Fechar">✕</button>
                </div>
                <div class="vanta-ccb-body">
                    <div class="vanta-ccb-msg"></div>
                    <ul class="vanta-ccb-list" hidden></ul>
                </div>
                <div class="vanta-ccb-foot">
                    <button type="button" class="vanta-ccb-btn vanta-ccb-cancel">Cancelar</button>
                    <button type="button" class="vanta-ccb-btn vanta-ccb-confirm"></button>
                </div>
            </div>`;

    // Todo texto dinâmico entra por textContent (XSS-safe).
    const titleEl = overlay.querySelector('.vanta-ccb-title');
    if (titleEl !== null) titleEl.textContent = opts.title;
    const msgEl = overlay.querySelector('.vanta-ccb-msg');
    if (msgEl !== null) msgEl.textContent = opts.message;
    const listEl = overlay.querySelector<HTMLElement>('.vanta-ccb-list');
    if (listEl !== null && opts.details !== undefined && opts.details.length > 0) {
      opts.details.forEach((linha) => {
        const li = document.createElement('li');
        li.textContent = linha;
        listEl.appendChild(li);
      });
      listEl.hidden = false;
    }

    const closeBtn = overlay.querySelector<HTMLButtonElement>('.vanta-ccb-close');
    const cancelBtn = overlay.querySelector<HTMLButtonElement>('.vanta-ccb-cancel');
    const confirmBtn = overlay.querySelector<HTMLButtonElement>('.vanta-ccb-confirm');
    if (confirmBtn !== null) {
      confirmBtn.textContent = opts.confirmLabel ?? 'Confirmar';
      if (opts.danger === true) confirmBtn.classList.add('vanta-ccb-btn--danger');
    }

    let settled = false;
    const cleanup = (): void => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    const decide = (valor: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(valor);
    };
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') decide(false);
    }

    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) decide(false);
    });
    closeBtn?.addEventListener('click', () => {
      decide(false);
    });
    cancelBtn?.addEventListener('click', () => {
      decide(false);
    });
    confirmBtn?.addEventListener('click', () => {
      decide(true);
    });

    scope.owns(overlay);
    document.body.appendChild(overlay);
    confirmBtn?.focus();
  });
}

// ── Leitura da tabela de comandos ──

interface CommandRow {
  checkbox: HTMLInputElement;
  /** Id do comando (sufixo de `name="id_<id>"`). */
  id: string;
  /** Rótulo pt-BR do tipo (`data-command-type`). */
  typeLabel: string;
  direction: 'ida' | 'volta' | 'indefinida';
  /** Texto do link de destino (para o detalhe da confirmação). */
  destination: string;
  /** Href do link de cancelamento da própria linha, quando o jogo o expõe. */
  cancelHref: string | null;
}

function commandIdOf(checkbox: HTMLInputElement): string | null {
  const match = /^id_(\d+)$/.exec(checkbox.name);
  return match?.[1] ?? null;
}

/** A linha tem o par checkbox + `command_ids[<id>]` (contrato da tela)? */
function hasSelectionPair(checkbox: HTMLInputElement, tr: Element): boolean {
  const id = commandIdOf(checkbox);
  if (id === null) return false;
  return tr.querySelector(`input[name="command_ids[${id}]"]`) !== null;
}

/**
 * Tabela de comandos: prefere a que expõe o cabeçalho canônico da Visão de
 * Comandos (`order=start_name`); sem ele, a primeira tabela com o par de
 * seleção (aba de comandos do info_village). Sem nenhuma → null (fail-closed).
 */
function findCommandsTable(): HTMLTableElement | null {
  const withPair: HTMLTableElement[] = [];
  document.querySelectorAll<HTMLTableElement>('table').forEach((table) => {
    const checkbox = Array.from(table.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name^="id_"]')).some(
      (cb) => {
        const tr = cb.closest('tr');
        return tr !== null && hasSelectionPair(cb, tr);
      },
    );
    if (checkbox) withPair.push(table);
  });
  return withPair.find((table) => table.querySelector('a[href*="order=start_name"]') !== null) ?? withPair[0] ?? null;
}

function typeLabelOf(tr: Element): string {
  const marker = tr.querySelector('[data-command-type]');
  const raw = (marker?.getAttribute('data-command-type') ?? '').toLowerCase();
  if (raw === 'attack') return 'Ataque';
  if (raw === 'support') return 'Apoio';
  return 'Desconhecido';
}

/**
 * Origem/destino da linha pelos links do template (Destino antes de Origem):
 * `screen=info_village&id=` é o destino; o primeiro link com `village=` que não
 * seja do comando/aldeia é a origem. Sem par reconhecível → '' (indefinida).
 */
function rowLinks(tr: Element): { originId: string; destinationId: string; destination: string } {
  let originId = '';
  let destinationId = '';
  let destination = '';
  tr.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    let url: URL;
    try {
      url = new URL(anchor.href, window.location.origin);
    } catch {
      return;
    }
    if (url.origin !== window.location.origin) return;
    const screen = url.searchParams.get('screen') ?? '';
    if (screen === 'info_command') return; // link do próprio comando (nome/renomear)
    if (screen === 'info_village' && destinationId === '') {
      const id = normalizeVillageId(url.searchParams.get('id') ?? '');
      if (id !== '') {
        destinationId = id;
        destination = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim();
      }
      return;
    }
    if (originId === '') {
      const village = normalizeVillageId(url.searchParams.get('village') ?? '');
      if (village !== '') originId = village;
    }
  });
  return { originId, destinationId, destination };
}

function parseRows(table: HTMLTableElement, currentVillage: string): { rows: CommandRow[]; unpaired: number } {
  const rows: CommandRow[] = [];
  let unpaired = 0;
  table.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name^="id_"]').forEach((checkbox) => {
    const tr = checkbox.closest('tr');
    const id = commandIdOf(checkbox);
    if (tr === null || id === null || !hasSelectionPair(checkbox, tr)) {
      unpaired += 1;
      return;
    }
    const { originId, destinationId, destination } = rowLinks(tr);
    const direction: CommandRow['direction'] =
      currentVillage !== '' && originId === currentVillage
        ? 'ida'
        : currentVillage !== '' && destinationId === currentVillage && originId !== currentVillage
          ? 'volta'
          : 'indefinida';
    const cancelAnchor = tr.querySelector<HTMLAnchorElement>('a[href*="action=cancel"], a[href*="ajaxaction=cancel"]');
    rows.push({
      checkbox,
      id,
      typeLabel: typeLabelOf(tr),
      direction,
      destination,
      cancelHref: cancelAnchor !== null ? cancelAnchor.getAttribute('href') : null,
    });
  });
  return { rows, unpaired };
}

// ── Confirmação e execução do lote ──

function typeSummary(rows: readonly CommandRow[]): string {
  const counts = new Map<string, number>();
  rows.forEach((row) => counts.set(row.typeLabel, (counts.get(row.typeLabel) ?? 0) + 1));
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([label, n]) =>
      label === 'Desconhecido'
        ? `${n} de tipo não identificado`
        : `${n} ${label.toLowerCase()}${n > 1 ? 's' : ''}`,
    )
    .join(', ');
}

/** URL de cancelamento do próprio jogo, com o csrf atual; null se não servir. */
function gamePath(href: string, csrf: string): string | null {
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    if (!url.pathname.endsWith('/game.php')) return null;
    url.searchParams.set('h', csrf);
    return `${url.pathname}?${url.searchParams.toString()}`;
  } catch {
    return null;
  }
}

/**
 * Caminho do POST de UM comando: 1º a URL de cancelamento da linha (padrão
 * `action=cancel&id=` verificado no br142 — a URL vem do PRÓPRIO jogo), 2º a
 * ação ajax do `info_command` (mesma família do `ajaxaction=edit_other_comment`
 * já usado em vanta-net), para quando o jogo não expõe o link na linha. A
 * resposta é conferida a cada POST (gameError) e o lote para no primeiro erro.
 */
function cancelPathFor(row: CommandRow, csrf: string): string {
  if (row.cancelHref !== null) {
    const doJogo = gamePath(row.cancelHref, csrf);
    if (doJogo !== null) return doJogo;
  }
  const villageId = currentVillageId();
  const prefix = villageId === '' ? '' : `village=${encodeURIComponent(villageId)}&`;
  return `/game.php?${prefix}screen=info_command&ajaxaction=cancel&id=${encodeURIComponent(row.id)}&h=${encodeURIComponent(csrf)}`;
}

/**
 * Erro devolvido pelo jogo em respostas ajax (`error` direto ou aninhado em
 * `response`). Sucesso = resposta SEM campo de erro; qualquer erro (hash
 * vencido, comando já cancelado etc.) PARA o lote — nunca seguimos em frente
 * acreditando que deu certo.
 */
function gameError(json: Record<string, unknown>): string | null {
  const direct = json.error;
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim();
  const response = json.response;
  if (response !== null && typeof response === 'object') {
    const nested = (response as Record<string, unknown>).error;
    if (typeof nested === 'string' && nested.trim() !== '') return nested.trim();
  }
  return null;
}

registerVanta({
  id: 'vanta-cancelamento-bloco',
  label: 'Cancelamento em Bloco',
  desc: 'Cancela vários comandos de uma vez, com confirmação',
  group: 'defesa',
  match: () => {
    const p = params();
    if (p.get('screen') === 'overview_villages') return p.get('mode') === 'commands';
    return p.get('screen') === 'info_village';
  },
  url: () => {
    const villageId = currentVillageId();
    const prefix = villageId === '' ? '' : `village=${encodeURIComponent(villageId)}&`;
    return `/game.php?${prefix}screen=overview_villages&mode=commands`;
  },
  mount(scope: ModuleScope) {
    ensureVantaStyles();
    ensureStyles();
    if (document.getElementById('vanta-cb-ui') !== null) return;

    const p = params();
    const commandsOverview = p.get('screen') === 'overview_villages' && p.get('mode') === 'commands';
    // O painel pode montar o módulo por flag de navegação em qualquer página:
    // fora das telas do módulo a injeção nem tenta (fail-closed).
    if (!commandsOverview && p.get('screen') !== 'info_village') return;

    let attempts = 0;
    const tryInject = (): void => {
      if (document.getElementById('vanta-cb-ui') !== null) return;
      const table = findCommandsTable();
      if (table === null) {
        // A Visão de Comandos pode renderizar depois do load (ajax do jogo):
        // poucas tentativas e em silêncio (sem mesa de comandos, sem UI).
        if (commandsOverview && ++attempts < 20) scope.after(tryInject, 150);
        return;
      }
      injectBar(scope, table);
    };
    tryInject();
  },
});

function injectBar(scope: ModuleScope, table: HTMLTableElement): void {
  const villageFromUrl = normalizeVillageId(params().get('village') ?? '');
  const currentVillage = currentVillageId() !== '' ? currentVillageId() : villageFromUrl;
  const { rows, unpaired } = parseRows(table, currentVillage);
  if (rows.length === 0) return; // sem o contrato da tela → nenhuma UI

  const bar = document.createElement('div');
  bar.id = 'vanta-cb-ui';
  bar.innerHTML = `
        <span class="vanta-cb-title">Cancelamento em Bloco</span>
        <button type="button" id="vanta-cb-sel-ida">Selecionar todos (ida)</button>
        <button type="button" id="vanta-cb-sel-volta">Selecionar todos (volta)</button>
        <button type="button" id="vanta-cb-cancelar">Cancelar selecionados</button>
        <span class="vanta-cb-status"></span>`;

  const parent = table.parentNode;
  if (parent === null) return;
  parent.insertBefore(scope.owns(bar), table);

  const selIdaBtn = bar.querySelector<HTMLButtonElement>('#vanta-cb-sel-ida');
  const selVoltaBtn = bar.querySelector<HTMLButtonElement>('#vanta-cb-sel-volta');
  const cancelBtn = bar.querySelector<HTMLButtonElement>('#vanta-cb-cancelar');
  const statusEl = bar.querySelector<HTMLElement>('.vanta-cb-status');
  if (selIdaBtn === null || selVoltaBtn === null || cancelBtn === null || statusEl === null) return;

  let running = false;

  function setStatus(text: string, kind: 'info' | 'ok' | 'erro'): void {
    if (statusEl === null) return;
    statusEl.textContent = text;
    statusEl.className = `vanta-cb-status${kind === 'info' ? '' : ` vanta-cb-status--${kind}`}`;
  }

  function setButtons(enabled: boolean): void {
    [selIdaBtn, selVoltaBtn, cancelBtn].forEach((btn) => {
      if (btn !== null) btn.disabled = !enabled;
    });
  }

  function selectedRows(): CommandRow[] {
    return rows.filter((row) => row.checkbox.checked);
  }

  function updateStatus(): void {
    const selected = selectedRows();
    if (selected.length === 0) {
      setStatus(
        unpaired > 0
          ? `Nenhum comando selecionado (${unpaired} linha(s) sem o par de seleção do jogo foram ignoradas).`
          : 'Nenhum comando selecionado.',
        'info',
      );
      return;
    }
    const extra = unpaired > 0 ? ` (${unpaired} linha(s) sem o par de seleção foram ignoradas)` : '';
    setStatus(`${selected.length} selecionado(s): ${typeSummary(selected)}${extra}`, 'info');
  }

  function selectDirection(direction: 'ida' | 'volta'): void {
    if (running) return;
    const targets = rows.filter((row) => row.direction === direction);
    const label = direction === 'ida' ? 'saindo desta aldeia' : 'chegando nesta aldeia';
    if (targets.length === 0) {
      setStatus(`Nenhum comando ${label} foi reconhecido nesta tabela.`, 'erro');
      return;
    }
    // Marca/desmarca por .click() quando o estado difere (o jogo pode ter
    // handler nos checkboxes — mesmo padrão do visao-apoios).
    rows.forEach((row) => {
      if (row.checkbox.checked) row.checkbox.click();
    });
    targets.forEach((row) => {
      if (!row.checkbox.checked) row.checkbox.click();
    });
    updateStatus();
  }

  async function confirmAndCancel(): Promise<void> {
    if (running) return;
    const targets = selectedRows();
    if (targets.length === 0) {
      setStatus('Nenhum comando selecionado — marque os comandos na tabela.', 'erro');
      return;
    }

    const details = targets
      .slice(0, 8)
      .map((row) => `${row.typeLabel} → ${row.destination !== '' ? row.destination : `comando ${row.id}`}`);
    if (targets.length > details.length) details.push(`… e mais ${targets.length - details.length} comando(s).`);

    const ok = await vantaConfirm(scope, {
      title: 'Cancelamento em Bloco',
      message: `${targets.length} comando(s) selecionado(s) — ${typeSummary(targets)}. O cancelamento não pode ser desfeito.`,
      details,
      confirmLabel: 'Cancelar comandos',
      danger: true,
    });
    if (!ok) return;
    await runBatch(targets);
  }

  async function runBatch(targets: CommandRow[]): Promise<void> {
    running = true;
    setButtons(false);

    let csrf: string;
    try {
      csrf = currentCsrf();
    } catch (error) {
      setStatus(`Não foi possível obter o token do jogo: ${mensagemDeErro(error)}`, 'erro');
      running = false;
      setButtons(true);
      return;
    }

    let cancelled = 0;
    let stoppedAt: string | null = null;

    for (let i = 0; i < targets.length; i++) {
      const row = targets[i];
      if (row === undefined) break;
      if (i > 0) await sleep(PAUSA_MS);
      setStatus(`Cancelando ${i + 1}/${targets.length}...`, 'info');
      try {
        const result = await vantaPostJson(cancelPathFor(row, csrf), { h: csrf });
        if (result.csrf !== '') csrf = result.csrf;
        const error = gameError(result.json);
        if (error !== null) {
          stoppedAt = `o jogo recusou o comando ${row.id}: ${error}`;
          break;
        }
        cancelled += 1;
      } catch (error) {
        stoppedAt = `falha no comando ${row.id}: ${mensagemDeErro(error)}`;
        break;
      }
    }

    running = false;
    setButtons(true);

    if (stoppedAt === null) {
      setStatus(`${cancelled} comando(s) cancelado(s). Recarregando a lista...`, 'ok');
      scope.after(() => {
        window.location.reload();
      }, 1500);
      return;
    }
    setStatus(
      `${cancelled} de ${targets.length} cancelado(s) — ${stoppedAt} Atualize a página (F5) para ver a lista real.`,
      'erro',
    );
  }

  scope.on(selIdaBtn, 'click', () => {
    selectDirection('ida');
  });
  scope.on(selVoltaBtn, 'click', () => {
    selectDirection('volta');
  });
  scope.on(cancelBtn, 'click', () => {
    void confirmAndCancel();
  });
  // A seleção também muda pelo "Selecionar todas" do próprio jogo: o contador
  // acompanha qualquer change na tabela.
  scope.on(table, 'change', () => {
    if (!running) updateStatus();
  });

  updateStatus();
}
