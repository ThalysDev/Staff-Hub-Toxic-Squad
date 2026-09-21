// Shell de UI: mini-botão flutuante + painel em Shadow DOM (isolamento total
// do CSS do jogo) com abas registradas por módulo. PT-BR.

import { licenseState } from './license';

export interface SectionDef {
  id: string;
  label: string;
  /** Só ativa nesta screen do jogo (undefined = todas). */
  matchScreen?: string;
  render: (container: HTMLElement) => void;
}

const sections: SectionDef[] = [];

export function registerSection(section: SectionDef): void {
  sections.push(section);
}

let panelOpen = false;

export function currentScreen(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('screen') ?? 'overview';
}

export function gameContext(): { player: string; world: string; villageId: string } {
  const data = (window as unknown as {
    game_data?: { player?: { name?: string }; world?: string; village?: { id?: number | string } };
  }).game_data;
  return {
    player: data?.player?.name ?? '—',
    world: data?.world ?? '—',
    villageId: String(data?.village?.id ?? '—'),
  };
}

function styles(): string {
  return `
    /* ===== Staff Hub In-Game — tema pergaminho Tribal Wars (v1.1) =====
       Tokens de design: pergaminho quente, madeira/tinta escura, latão e o
       verde de ação do hub. Tudo em Shadow DOM — zero conflito com o jogo. */
    :host {
      --shs-bg: #f0e6cf;
      --shs-bg-card: #f8f2e2;
      --shs-bg-inset: #e9dfc6;
      --shs-bg-head: #2e2a20;
      --shs-ink: #2e2a20;
      --shs-ink-strong: #1d1a12;
      --shs-muted: #7a6b55;
      --shs-border: #c9bb9c;
      --shs-border-strong: #8a7a58;
      --shs-brass: #a8862f;
      --shs-brass-soft: #e8d9ac;
      --shs-action: #4a7c3f;
      --shs-action-hover: #3c6633;
      --shs-danger: #a2261f;
      --shs-danger-bg: #f3d9d3;
      --shs-warn: #8a6d1f;
      --shs-warn-bg: #f5ecd0;
      --shs-ok-bg: #dcead2;
      --shs-radius: 8px;
      --shs-shadow: 0 10px 30px rgba(20, 14, 4, .45), 0 2px 6px rgba(20, 14, 4, .25);
      --shs-font: Verdana, Geneva, 'DejaVu Sans', sans-serif;
      --shs-font-display: Georgia, 'Times New Roman', serif;
      all: initial;
      font-family: var(--shs-font);
      font-size: 12px;
      color: var(--shs-ink);
    }

    /* ---- FAB (botão escudo flutuante) ---- */
    .shs-fab { position: fixed; left: 10px; bottom: 10px; z-index: 2147483000;
      width: 44px; height: 44px; border-radius: 12px; cursor: pointer;
      border: 2px solid #6b5d3f; background: linear-gradient(180deg, #3c3626, #26221a);
      color: #e8dcc0; font-family: var(--shs-font-display); font-size: 15px;
      font-weight: 700; letter-spacing: .5px;
      box-shadow: 0 3px 10px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.08); }
    .shs-fab:hover { border-color: var(--shs-brass); color: #f5ecd0; }
    .shs-fab:focus-visible { outline: 2px solid var(--shs-brass); outline-offset: 2px; }

    /* ---- Painel ---- */
    .shs-panel { position: fixed; left: 10px; bottom: 62px; z-index: 2147483000;
      width: min(600px, calc(100vw - 24px)); max-height: min(82vh, 780px);
      display: flex; flex-direction: column;
      background: var(--shs-bg); color: var(--shs-ink);
      border: 1px solid var(--shs-border-strong); border-radius: var(--shs-radius);
      box-shadow: var(--shs-shadow);
      font-family: var(--shs-font); font-size: 12px; line-height: 1.45; }
    .shs-head { display: flex; align-items: center; gap: 8px; padding: 9px 12px;
      background: linear-gradient(180deg, #332d21, #26221a); color: #e8dcc0;
      border-bottom: 2px solid var(--shs-brass); border-radius: var(--shs-radius) var(--shs-radius) 0 0; }
    .shs-head strong { font-family: var(--shs-font-display); font-size: 14px;
      letter-spacing: .4px; }
    .shs-head .shs-muted { color: #b3a58b; }
    .shs-headbtn { margin-left: 4px; background: none; border: 1px solid transparent;
      border-radius: 4px; color: #b3a58b; cursor: pointer; font-size: 13px;
      padding: 1px 6px; line-height: 1.2; }
    .shs-headbtn:hover { color: #e8dcc0; border-color: #55492f; }
    .shs-headbtn:focus-visible { outline: 2px solid var(--shs-brass); }
    .shs-head-spacer { margin-left: auto; }

    /* Faixa de estado da licença (graça offline etc.) */
    .shs-license { padding: 5px 12px; background: var(--shs-warn-bg);
      color: var(--shs-warn); border-bottom: 1px solid var(--shs-border);
      font-size: 11px; }

    /* ---- Abas ---- */
    .shs-tabs { display: flex; flex-wrap: wrap; gap: 3px; padding: 8px 8px 0;
      background: var(--shs-bg-inset); border-bottom: 1px solid var(--shs-border-strong); }
    .shs-tab { padding: 5px 11px; border: 1px solid var(--shs-border);
      border-bottom: none; border-radius: 6px 6px 0 0; background: var(--shs-bg-inset);
      color: var(--shs-muted); cursor: pointer; font-family: var(--shs-font);
      font-size: 11.5px; font-weight: 600; }
    .shs-tab:hover { color: var(--shs-ink); }
    .shs-tab[data-active='true'] { background: var(--shs-bg-card); color: var(--shs-ink-strong);
      border-color: var(--shs-border-strong); border-bottom: 2px solid var(--shs-bg-card);
      margin-bottom: -1px; }
    .shs-tab:focus-visible { outline: 2px solid var(--shs-brass); outline-offset: -2px; }

    /* ---- Corpo ---- */
    .shs-body { overflow: auto; padding: 12px; background: var(--shs-bg);
      border-radius: 0 0 var(--shs-radius) var(--shs-radius);
      overscroll-behavior: contain; }
    .shs-body::-webkit-scrollbar { width: 10px; height: 10px; }
    .shs-body::-webkit-scrollbar-thumb { background: #b7a98d; border-radius: 6px;
      border: 2px solid var(--shs-bg); }
    .shs-body::-webkit-scrollbar-track { background: transparent; }
    .shs-body:focus-visible { outline: none; }
    .shs-body table { border-collapse: collapse; width: 100%; margin: 8px 0;
      background: var(--shs-bg-card); }
    .shs-body th, .shs-body td { border: 1px solid var(--shs-border);
      padding: 4px 8px; text-align: left; vertical-align: top; }
    .shs-body thead th { background: var(--shs-bg-inset); color: var(--shs-ink-strong);
      font-size: 11px; text-transform: uppercase; letter-spacing: .4px; }
    .shs-body tbody tr:nth-child(even) { background: rgba(233, 223, 198, .45); }
    .shs-body tbody tr:hover { background: var(--shs-brass-soft); }
    .shs-body tfoot td { font-weight: 700; background: var(--shs-bg-inset); }
    .shs-tabular { font-variant-numeric: tabular-nums; }

    /* ---- Cartões / seções ---- */
    .shs-card { background: var(--shs-bg-card); border: 1px solid var(--shs-border);
      border-radius: var(--shs-radius); padding: 10px 12px; margin: 0 0 12px; }
    .shs-card:last-child { margin-bottom: 0; }
    .shs-card-title { display: flex; align-items: center; gap: 6px; margin: 0 0 8px;
      font-family: var(--shs-font-display); font-size: 13.5px; font-weight: 700;
      color: var(--shs-ink-strong); }
    .shs-card-title::before { content: '◆'; color: var(--shs-brass); font-size: 11px; }

    /* ---- Campos ---- */
    .shs-field { display: flex; flex-direction: column; gap: 3px; min-width: 0;
      margin: 0 0 8px; }
    .shs-field-label, .shs-field > .shs-label { font-size: 10.5px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .4px; color: var(--shs-muted); }
    .shs-input, .shs-body select, .shs-body textarea { padding: 5px 8px;
      border: 1px solid var(--shs-border-strong); border-radius: 5px;
      background: var(--shs-bg-card); color: var(--shs-ink-strong);
      font-family: var(--shs-font); font-size: 12px; width: 100%;
      box-sizing: border-box; }
    .shs-body textarea { resize: vertical; min-height: 56px;
      font-family: var(--shs-font); line-height: 1.4; }
    .shs-input:focus, .shs-body select:focus, .shs-body textarea:focus {
      outline: 2px solid var(--shs-brass); outline-offset: -1px; }
    .shs-input::placeholder, .shs-body textarea::placeholder { color: #9a8c6e; }

    /* ---- Botões ---- */
    .shs-btn { padding: 5px 12px; border: 1px solid #3c6633; border-radius: 6px;
      background: var(--shs-action); color: #fff; cursor: pointer;
      font-family: var(--shs-font); font-size: 12px; font-weight: 600; }
    .shs-btn:hover:not([disabled]) { background: var(--shs-action-hover); }
    .shs-btn[disabled] { opacity: .55; cursor: default; }
    .shs-btn:focus-visible { outline: 2px solid var(--shs-brass); outline-offset: 1px; }
    .shs-btn-ghost { background: transparent; color: var(--shs-ink);
      border-color: var(--shs-border-strong); }
    .shs-btn-ghost:hover:not([disabled]) { background: var(--shs-bg-inset); }
    .shs-btn-danger { background: transparent; color: var(--shs-danger);
      border-color: var(--shs-danger); }
    .shs-btn-danger:hover:not([disabled]) { background: var(--shs-danger-bg); }
    .shs-btn-sm { padding: 3px 8px; font-size: 11px; }

    /* ---- Linhas / textos ---- */
    .shs-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
    .shs-muted { color: var(--shs-muted); }
    .shs-danger { color: var(--shs-danger); font-weight: 700; }
    .shs-ok { color: var(--shs-action); font-weight: 700; }
    .shs-warn { color: var(--shs-warn); font-weight: 600; }
    .shs-strong { color: var(--shs-ink-strong); font-weight: 700; }

    /* ---- Pills ---- */
    .shs-pill { display: inline-block; padding: 1px 8px; border-radius: 999px;
      border: 1px solid var(--shs-border); background: var(--shs-bg-inset);
      font-size: 10.5px; font-weight: 600; }
    .shs-pill--error { background: #f3d9d3; border-color: var(--shs-danger); color: var(--shs-danger); }
    .shs-pill--ok { background: var(--shs-ok-bg); border-color: var(--shs-action); color: var(--shs-action); }
    .shs-pill--warn { background: #f5ecd0; border-color: var(--shs-warn); color: var(--shs-warn); }
    .shs-pill--info { background: #dce5f0; border-color: #4a6a8a; color: #33506b; }
    .shs-pill--muted { background: var(--shs-bg-inset); color: var(--shs-muted); }

    /* ---- Estados / utilitários ---- */
    .shs-empty { padding: 18px 12px; text-align: center; color: var(--shs-muted); }
    .shs-progress { margin: 8px 0; }
    .shs-progress-bar { height: 6px; border-radius: 4px; overflow: hidden;
      background: var(--shs-bg-inset); border: 1px solid var(--shs-border); }
    .shs-progress-fill { height: 100%; background: var(--shs-action); transition: width .3s; }
    .shs-warnbox { padding: 6px 10px; background: var(--shs-warn-bg);
      border: 1px solid var(--shs-warn); border-radius: 6px; color: var(--shs-warn);
      font-weight: 600; margin: 8px 0; }
    .shs-divider { border: none; border-top: 1px solid var(--shs-border); margin: 10px 0; }
    .shs-tablewrap { overflow-x: auto; }
    .shs-notification { margin: 0 0 10px; padding: 6px 10px; border-radius: 6px;
      font-weight: 600; }
    .shs-notification--ok { background: var(--shs-ok-bg); color: var(--shs-action);
      border: 1px solid var(--shs-action); }
    .shs-notification--error { background: var(--shs-danger-bg); color: var(--shs-danger);
      border: 1px solid var(--shs-danger); }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
      outline: 2px solid var(--shs-brass); outline-offset: 1px; }
    a { color: inherit; }
  `;
}

/** Cria o host+estilo se ainda não existem e devolve o ShadowRoot
 *  (P0 da revisão: main.ts criava o host antes, o que fazia o mountShell
 *  retornar cedo e o shell NUNCA montar). */
export function ensureHost(): ShadowRoot {
  let host = document.getElementById('shs-in-game-host');
  if (host === null) {
    host = document.createElement('div');
    host.id = 'shs-in-game-host';
    document.body.appendChild(host);
  }
  if (host.shadowRoot === null) {
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = styles();
    shadow.appendChild(style);
  }
  return host.shadowRoot as ShadowRoot;
}

export function mountShell(): void {
  const shadow = ensureHost();
  if (shadow.querySelector('.shs-panel') !== null) {
    // Já montado: só garante visível.
    (shadow.querySelector('.shs-panel') as HTMLElement).style.display = 'flex';
    return;
  }

  const fab = document.createElement('button');
  fab.className = 'shs-fab';
  fab.title = 'Staff Hub In-Game';
  fab.textContent = 'SH';
  fab.addEventListener('click', () => {
    panelOpen = !panelOpen;
    panel.style.display = panelOpen ? 'flex' : 'none';
    if (panelOpen) renderTabs();
  });
  shadow.appendChild(fab);

  const panel = document.createElement('div');
  panel.className = 'shs-panel';
  panel.style.display = 'flex';
  // Nasce aberto: sincronizar o estado, senão o 1º clique no FAB é no-op.
  panelOpen = true;
  shadow.appendChild(panel);

  const head = document.createElement('div');
  head.className = 'shs-head';
  const strong = document.createElement('strong');
  strong.textContent = 'Staff Hub In-Game';
  const who = document.createElement('span');
  who.className = 'shs-muted';
  const ctx = gameContext();
  who.textContent = `${ctx.player} · ${ctx.world}`;
  head.append(strong, who);
  const spacer = document.createElement('span');
  spacer.className = 'shs-head-spacer';
  head.appendChild(spacer);

  // Minimizar: recolhe para a barra de título (diferente de fechar).
  const minimize = document.createElement('button');
  minimize.className = 'shs-headbtn';
  minimize.textContent = '—';
  minimize.title = 'Minimizar painel';
  minimize.addEventListener('click', () => {
    panelOpen = false;
    panel.style.display = 'none';
  });
  head.appendChild(minimize);

  const close = document.createElement('button');
  close.className = 'shs-headbtn';
  close.textContent = '×';
  close.title = 'Fechar painel';
  close.addEventListener('click', () => {
    panelOpen = false;
    panel.style.display = 'none';
  });
  head.appendChild(close);
  panel.appendChild(head);

  // Faixa de estado da licença em modo graça (rede caiu / revalidação 24h) —
  // DEPOIS do head, entre a barra de título e as abas.
  const license = licenseState();
  if (license.kind === 'graca') {
    const faixa = document.createElement('div');
    faixa.className = 'shs-license';
    const ate = new Date(license.offlineAte).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    faixa.textContent = `Modo offline — licença será revalidada automaticamente (tenta de novo a partir das ${ate}).`;
    panel.appendChild(faixa);
  }

  const tabs = document.createElement('div');
  tabs.className = 'shs-tabs';
  panel.appendChild(tabs);

  const body = document.createElement('div');
  body.className = 'shs-body';
  body.dataset.section = '';
  panel.appendChild(body);

  function renderTabs(): void {
    const screen = currentScreen();
    tabs.innerHTML = '';
    const available = sections.filter((section) => section.matchScreen === undefined || section.matchScreen === screen);
    for (const section of available) {
      const tab = document.createElement('button');
      tab.className = 'shs-tab';
      tab.textContent = section.label;
      tab.dataset.active = String(body.dataset.section === section.id);
      tab.addEventListener('click', () => {
        body.innerHTML = '';
        body.dataset.section = section.id;
        for (const other of Array.from(tabs.children)) (other as HTMLElement).dataset.active = 'false';
        tab.dataset.active = 'true';
        section.render(body);
      });
      tabs.appendChild(tab);
    }
    // Re-render a aba ativa quando as abas são refeitas (troca de página do jogo).
    const active = sections.find((section) => section.id === body.dataset.section);
    if (active !== undefined && available.includes(active)) active.render(body);
  }

  // Navegação interna do jogo troca o conteúdo sem recarregar: observa e refaz as abas.
  const observer = new MutationObserver(() => renderTabs());
  observer.observe(document.getElementById('content_value') ?? document.body, { childList: true, subtree: false });

  renderTabs();
}
