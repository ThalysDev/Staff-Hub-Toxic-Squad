// Shell de UI: mini-botão flutuante + painel "Nexus" em Shadow DOM (isolamento
// total do CSS do jogo) — janela premium em pergaminho com cabeçalho de marca,
// sidebar de navegação vertical (seções registradas por módulo), conteúdo com
// scroll próprio e faixa de licença no rodapé. PT-BR.

import { licenseState } from './license';
import { gameContextFrom, pageWindow } from './page';
import { gm } from './storage';
import { icon, type IconName } from './icons';
import { themeDeclarations } from './theme';

export interface SectionDef {
  id: string;
  label: string;
  /** Ícone da aba (catálogo core/icons.ts). */
  icon?: IconName;
  /** Só ativa nesta screen do jogo (undefined = todas). */
  matchScreen?: string;
  /**
   * Desenha a seção. Pode devolver uma função de LIMPEZA (timers de
   * atualização ao vivo etc.) — o shell a chama ao trocar de seção, ao
   * re-renderizar e ao fechar o painel (Onda B: nada de timer órfão).
   */
  render: (container: HTMLElement) => void | (() => void);
}

const sections: SectionDef[] = [];

export function registerSection(section: SectionDef): void {
  sections.push(section);
}

// ── Busca rápida (Onda 6): provedores registram entradas; o shell desenha ──

export interface SearchEntry {
  /** id estável da entrada (dedupe/teclas). */
  id: string;
  /** Texto principal exibido. */
  label: string;
  /** Contexto curto (ex.: "Suite Vanta", "Automações"). */
  hint?: string;
  /** Seção do painel para onde o clique navega. */
  sectionId: string;
  icon?: IconName;
  /** Termos extra para casar (ex.: desc da automação). */
  keywords?: string;
  /**
   * Alvo dentro da seção (Onda C): elemento com `data-search-id` igual a
   * este valor é rolado até a vista e destacado após a navegação.
   */
  targetId?: string;
  /** Prepara a seção antes de navegar (ex.: tirar filtro que esconde o alvo). */
  beforeNavigate?: () => void;
}

const searchEntries = new Map<string, SearchEntry>();

export function registerSearchEntries(entries: SearchEntry[]): void {
  for (const entry of entries) searchEntries.set(entry.id, entry);
}

/** Normaliza p/ busca: minúsculas sem acentos (ç→c, ã→a…). */
function normalizeSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

let panelOpen = false;
const PANEL_OPEN_KEY = 'shs-in-game:panel-open';
const LAST_SECTION_KEY = 'shs-in-game:last-section';

/** Alvo de digitação (campo de texto/número, select, textarea, contenteditable)? */
function isEditableTarget(node: EventTarget | undefined): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (node.isContentEditable) return true;
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) return true;
  if (node instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(node.type);
  }
  return false;
}

/**
 * Onda B — isolamento do teclado: fora do Shadow DOM o evento de tecla chega
 * "reapontado" para o host, então os ATALHOS DO JOGO não percebem que você
 * está digitando no painel (cada letra podia disparar um atalho). Tecla
 * digitada num campo do painel para no host; Esc e combinações com Ctrl/⌘
 * seguem (fechar diálogos, Ctrl+K).
 */
function isolateKeyboard(host: HTMLElement): void {
  const stop = (event: Event): void => {
    const key = event as KeyboardEvent;
    // Esc/Tab seguem (diálogos e foco preso); Ctrl/⌘ são comandos — exceto
    // AltGr (teclado ABNT2 reporta ctrlKey no AltGr+Q = "/").
    const comando = (key.ctrlKey || key.metaKey) && !key.getModifierState('AltGraph');
    if (key.key === 'Escape' || key.key === 'Tab' || comando) return;
    if (isEditableTarget(event.composedPath()[0])) event.stopPropagation();
  };
  for (const type of ['keydown', 'keypress', 'keyup']) host.addEventListener(type, stop);
}

/**
 * Onda C — alerta no botão flutuante: com texto, o escudo pulsa em latão e o
 * rótulo acessível/tooltip dizem o motivo (ex.: cravado chegando); null limpa.
 */
export function setFabAlert(text: string | null): void {
  const fab = document.getElementById('shs-in-game-host')?.shadowRoot?.querySelector<HTMLButtonElement>('.shs-fab');
  if (fab === null || fab === undefined) return;
  // Só escreve quando muda (leitores de tela não re-anunciam a cada segundo).
  if ((fab.getAttribute('data-tip') ?? null) === text) return;
  fab.classList.toggle('shs-fab--alert', text !== null);
  if (text !== null) {
    fab.setAttribute('data-tip', text);
    fab.setAttribute('aria-label', `Abrir Toxic Squad Hub — ${text}`);
  } else {
    fab.removeAttribute('data-tip');
    fab.setAttribute('aria-label', 'Abrir Toxic Squad Hub');
  }
}

export function currentScreen(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('screen') ?? 'overview';
}

export function gameContext(): { player: string; world: string; villageId: string } {
  return gameContextFrom(pageWindow().game_data);
}

function styles(): string {
  return `
    /* ===== Staff Hub In-Game — tema "Nexus" (pergaminho premium, v2.0) =====
       Janela flutuante: header de marca no topo, sidebar de navegação à
       esquerda, conteúdo rolável à direita e faixa de licença no rodapé do
       conteúdo. Tudo em Shadow DOM — zero conflito com o jogo. */
    :host {
      ${themeDeclarations()}
      all: initial;
      font-family: var(--shs-font);
      font-size: 12px;
      color: var(--shs-ink);
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition: none !important; animation: none !important; }
    }
    /* [3] Superfícies do browser dentro do painel: seleção em latão translúcido. */
    ::selection { background: #e8c04066; }

    /* ---- FAB (botão escudo flutuante — mesmo gradiente chocolate do badge) ---- */
    .shs-fab { position: fixed; left: 10px; bottom: 10px; z-index: 2147483000;
      width: 44px; height: 44px; border-radius: 12px; cursor: pointer;
      border: 2px solid var(--shs-action-dark, #4a2708); background: linear-gradient(180deg, var(--shs-action, #6d3c14), var(--shs-action-dark, #4a2708));
      color: var(--shs-brass-soft); font-family: var(--shs-font-display); font-size: 15px;
      font-weight: 700; letter-spacing: .5px;
      box-shadow: 0 3px 10px rgba(40,24,6,.45), inset 0 1px 0 rgba(255,255,255,.12); }
    .shs-fab:hover { border-color: var(--shs-brass); color: var(--shs-warn-bg, #f5ecd0); }
    .shs-fab:focus-visible { outline: 2px solid var(--shs-brass); outline-offset: 2px; }
    @keyframes shs-fab-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(217,165,32,.0), 0 3px 10px rgba(40,24,6,.45); }
      50% { box-shadow: 0 0 0 6px rgba(217,165,32,.55), 0 3px 10px rgba(40,24,6,.45); } }
    .shs-fab--alert { border-color: var(--shs-brass-bright); animation: shs-fab-pulse 1.2s ease-in-out infinite; }
    .shs-fab[data-tip]:hover::after { left: 0; transform: none; bottom: calc(100% + 8px); }
    .shs-fab[data-tip]:hover::before { left: 16px; transform: none; }

    /* ---- Painel (janela Nexus) ---- */
    .shs-panel { position: fixed; left: 10px; bottom: 62px; z-index: 2147483000;
      display: flex; flex-direction: column; overflow: hidden;
      background: var(--shs-bg); color: var(--shs-ink);
      border: 1px solid var(--shs-border-strong); border-radius: var(--shs-radius);
      box-shadow: var(--shs-shadow);
      font-family: var(--shs-font); font-size: 12px; line-height: 1.45;
      transition: width .18s ease, height .18s ease, max-height .18s ease,
        left .18s ease, bottom .18s ease, transform .18s ease; }
    /* Painel do hub (o diálogo de ativação reutiliza .shs-panel sem altura fixa). */
    .shs-panel--app { width: min(1060px, calc(100vw - 24px));
      height: min(720px, calc(100vh - 86px)); }
    /* Maximizado (botão ⤢ do cabeçalho; preferência persistida). */
    .shs-panel--app.shs-panel--max { width: 92vw; height: 86vh;
      left: 50%; transform: translateX(-50%); bottom: 7vh; }
    /* Minimizado: recolhe TUDO exceto o header (a janela encolhe com ele);
       o ⤢ de maximizar some — não faz sentido com o corpo escondido. */
    .shs-panel--min > :not(.shs-head) { display: none !important; }
    /* Minimizado = só o cabeçalho: sem recorte, para tooltips e a lista da
       busca não serem cortados (revisão Onda C). */
    .shs-panel--min { overflow: visible; }
    .shs-panel--app.shs-panel--min { height: auto; }
    .shs-panel--min .shs-headbtn[data-max] { display: none; }
    /* [11] Momento autoral ÚNICO do shell: entrada do painel ao abrir (FAB ou
       1º mount) — 140ms ease-out; a classe é efêmera (removida no animationend).
       Variante para o maximizado, que é centrado via transform. */
    .shs-panel.shs-open { animation: shs-open .14s ease-out; }
    .shs-panel--max.shs-open { animation-name: shs-open-max; }
    @keyframes shs-open { from { opacity: 0; transform: scale(.98); } to { opacity: 1; transform: scale(1); } }
    @keyframes shs-open-max {
      from { opacity: 0; transform: translateX(-50%) scale(.98); }
      to { opacity: 1; transform: translateX(-50%) scale(1); }
    }

    /* ---- Header: badge chocolate + wordmark + botões-ícone ---- */
    .shs-head { display: flex; align-items: center; gap: 10px; flex-shrink: 0;
      height: 52px; padding: 0 12px;
      background: var(--shs-bg-head); border-bottom: 1px solid var(--shs-border-head, #d9c48f);
      border-radius: var(--shs-radius) var(--shs-radius) 0 0; }
    .shs-brand-badge { width: 34px; height: 34px; flex-shrink: 0; border-radius: 9px;
      display: inline-flex; align-items: center; justify-content: center;
      background: linear-gradient(180deg, var(--shs-action, #6d3c14), var(--shs-action-dark, #4a2708));
      color: var(--shs-brass-soft);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.14), 0 1px 2px rgba(40,24,6,.25); }
    .shs-head-txt { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .shs-head strong { font-family: var(--shs-font); font-size: 15px; font-weight: 700;
      letter-spacing: 2.5px; line-height: 1.2; color: var(--shs-ink-strong);
      white-space: nowrap; }
    .shs-head-sub { display: inline-flex; align-items: center; gap: 5px;
      font-size: 10px; color: var(--shs-muted); white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; max-width: 320px; }
    .shs-head .shs-muted { color: var(--shs-muted); }
    .shs-headbtn { margin-left: 4px; width: 30px; height: 30px; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      background: transparent; border: 1px solid transparent; border-radius: 8px;
      color: var(--shs-ink); cursor: pointer; padding: 0; line-height: 1;
      position: relative; }
    .shs-headbtn:hover { background: #e5d5a8; }
    .shs-headbtn:focus-visible { outline: 2px solid var(--shs-brass); }
    .shs-head-spacer { margin-left: auto; }
    /* Onda B: tooltips do cabeçalho abrem PARA BAIXO (para cima eram cortados
       pela borda do painel). */
    .shs-head [data-tip]:hover::after, .shs-head [data-tip]:focus-visible::after {
      bottom: auto; top: calc(100% + 7px); }
    .shs-head [data-tip]:hover::before, .shs-head [data-tip]:focus-visible::before {
      bottom: auto; top: calc(100% + 2px); border-top-color: transparent;
      border-bottom-color: var(--shs-ink-strong); }
    .shs-head [data-tip]:last-child:hover::after, .shs-head [data-tip]:last-child:focus-visible::after {
      left: auto; right: 0; transform: none; }
    /* Onda C: destaque do item encontrado pela busca. */
    @keyframes shs-flash { 0%, 100% { box-shadow: 0 0 0 0 rgba(217,165,32,0); }
      30% { box-shadow: 0 0 0 3px rgba(217,165,32,.75); } }
    .shs-flash { animation: shs-flash 1.6s ease-in-out 2; border-radius: 8px; }

    /* Busca rápida (Onda 6): campo no header + dropdown ancorado. */
    .shs-searchwrap { position: relative; margin-left: 8px; }
    .shs-search { width: 180px; height: 28px; padding: 0 10px; font-size: 11.5px;
      font-family: var(--shs-font); color: var(--shs-ink); background: #fbf5e2;
      border: 1px solid var(--shs-border-strong); border-radius: 8px; outline: none; }
    .shs-search:focus { border-color: var(--shs-brass); background: var(--shs-bg-card, #fffdf3); }
    .shs-search::placeholder { color: var(--shs-muted); }
    .shs-searchpop { display: none; position: absolute; top: 32px; left: 0; width: 300px;
      max-height: 320px; overflow-y: auto; background: var(--shs-bg-card);
      border: 1px solid var(--shs-border-strong); border-radius: 10px;
      box-shadow: var(--shs-shadow); z-index: 40; padding: 4px; }
    .shs-searchpop--open { display: block; }
    .shs-searchitem { display: flex; align-items: center; gap: 8px; width: 100%;
      padding: 7px 9px; background: transparent; border: none; border-radius: 7px;
      font-family: var(--shs-font); font-size: 12px; color: var(--shs-ink);
      cursor: pointer; text-align: left; }
    .shs-searchitem:hover, .shs-searchitem:focus-visible,
    .shs-searchitem[data-active='true'] { background: var(--shs-bg-hover, #f2e6c4); outline: none; }
    .shs-searchitem-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .shs-searchitem-hint { font-size: 10.5px; color: var(--shs-muted); flex-shrink: 0; }
    .shs-searchempty { padding: 9px; font-size: 11.5px; color: var(--shs-muted); }

    /* Faixa de estado da licença em modo graça (rede caiu / revalidação 24h). */
    .shs-license { flex-shrink: 0; padding: 4px 12px; background: var(--shs-warn-bg);
      color: var(--shs-warn); border-bottom: 1px solid var(--shs-border);
      font-size: 11px; }

    /* ---- Layout em colunas: sidebar + conteúdo ---- */
    .shs-layout { display: flex; flex: 1; min-height: 0; }

    /* Sidebar de navegação (um item por seção registrada). */
    .shs-side { width: 200px; flex-shrink: 0; display: flex; flex-direction: column;
      min-height: 0; background: var(--shs-bg-side, #ece0b6); border-right: 1px solid var(--shs-border-head, #d9c48f); }
    .shs-nav { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 0;
      display: flex; flex-direction: column; overscroll-behavior: contain; }
    .shs-nav::-webkit-scrollbar { width: 8px; }
    .shs-nav::-webkit-scrollbar-thumb { background: var(--shs-border-strong);
      border-radius: 4px; }
    .shs-nav::-webkit-scrollbar-track { background: var(--shs-bg-side, #ece0b6); }
    .shs-navitem { display: flex; align-items: center; gap: 8px; height: 40px;
      flex-shrink: 0; margin-right: 6px; padding: 0 12px; border: none;
      border-radius: 0 8px 8px 0; background: transparent; color: var(--shs-ink);
      cursor: pointer; font-family: var(--shs-font); font-size: 12.5px;
      font-weight: 600; text-align: left; }
    .shs-navitem:hover { background: var(--shs-bg-hover, #f2e6c4); }
    /* Ativo: fundo claro + barra vertical 3px vermelho-escuro colada na borda
       esquerda da sidebar (inset = sem deslocar o conteúdo).
       [12] EXCEÇÃO de mundo comprometido mantida de propósito: a barra de 3px
       do item ativo é a gramática visual do Nexus (a esteira irmã mostra
       exatamente isto) — não remover. */
    .shs-navitem[data-active='true'] { background: var(--shs-bg-active, #f7ecd2);
      color: var(--shs-ink-strong); box-shadow: inset 3px 0 0 #8a2f1e; }
    .shs-navitem[data-active='true'] .shs-ic { color: var(--shs-danger); }
    .shs-navitem:focus-visible { outline: 2px solid var(--shs-brass); outline-offset: -2px; }
    /* [11] Feedback de toque nos controles (único :active do shell). */
    .shs-navitem:active, .shs-headbtn:active { transform: translateY(1px); }

    /* Coluna de conteúdo. */
    .shs-main { flex: 1; min-width: 0; min-height: 0; display: flex;
      flex-direction: column; background: var(--shs-bg); }
    .shs-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px;
      overscroll-behavior: contain; }
    .shs-body::-webkit-scrollbar { width: 8px; height: 8px; }
    .shs-body::-webkit-scrollbar-thumb { background: var(--shs-border-strong);
      border-radius: 4px; }
    .shs-body::-webkit-scrollbar-track { background: var(--shs-bg-side, #ece0b6); }
    /* [3] Mesmo scrollbar custom para os wrappers de tabela roláveis. */
    .shs-tablewrap::-webkit-scrollbar { width: 8px; height: 8px; }
    .shs-tablewrap::-webkit-scrollbar-thumb { background: var(--shs-border-strong);
      border-radius: 4px; }
    .shs-tablewrap::-webkit-scrollbar-track { background: var(--shs-bg-side, #ece0b6); }
    .shs-body:focus-visible { outline: none; }
    .shs-body table { border-collapse: collapse; width: 100%; margin: 8px 0;
      background: var(--shs-bg-card); }
    .shs-body th, .shs-body td { border: 1px solid var(--shs-border);
      padding: 4px 8px; text-align: left; vertical-align: top; }
    .shs-body thead th { background: var(--shs-bg-inset); color: var(--shs-ink-strong);
      font-size: 11px; text-transform: uppercase; letter-spacing: .4px; }
    .shs-body tbody tr:nth-child(even) { background: rgba(236, 224, 182, .5); }
    .shs-body tbody tr:hover { background: rgba(232, 192, 64, .25); }
    .shs-body tfoot td { font-weight: 700; background: var(--shs-bg-inset); }
    .shs-tabular { font-variant-numeric: tabular-nums; }

    /* ---- Rodapé do conteúdo: faixa fina de licença + versão ---- */
    .shs-foot { display: flex; align-items: center; gap: 8px; flex-shrink: 0;
      padding: 4px 12px; font-size: 11px; flex-wrap: wrap;
      background: var(--shs-ok-bg); border-top: 1px solid var(--shs-ok-border, #b5d4a8); color: var(--shs-ok-ink, #2e5b2a);
      font-variant-numeric: tabular-nums; }
    .shs-foot--warn { background: var(--shs-warn-bg);
      border-top-color: var(--shs-border-strong); color: var(--shs-warn); }
    .shs-selo { display: inline-flex; align-items: center; gap: 6px;
      font-weight: 600; min-width: 0; }
    .shs-selo--ok { color: inherit; }
    .shs-selo--warn { color: var(--shs-warn); }
    .shs-foot-ver { margin-left: auto; color: inherit; opacity: .75;
      font-size: 10.5px; white-space: nowrap; }

    /* ---- Cartões / seções ---- */
    .shs-card { background: var(--shs-bg-card); border: 1px solid var(--shs-border);
      border-radius: var(--shs-radius); padding: 10px 12px; margin: 0 0 12px;
      box-shadow: 0 1px 2px rgba(40, 24, 6, .06); }
    .shs-card:last-child { margin-bottom: 0; }
    .shs-card-title { display: flex; align-items: center; gap: 6px; margin: 0 0 8px;
      font-family: var(--shs-font-display); font-size: 13.5px; font-weight: 700;
      color: var(--shs-ink-strong); }
    /* [9] Sem glifo decorativo (◆ era Unicode como ícone) — o peso/tamanho do
       título já basta. */
    .shs-card-title--icon .shs-ic { color: var(--shs-brass); }

    /* ---- Campos ---- */
    .shs-field { display: flex; flex-direction: column; gap: 3px; min-width: 0;
      margin: 0 0 8px; }
    .shs-field-label, .shs-field > .shs-label { font-size: 10.5px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .4px; color: var(--shs-muted); }
    .shs-input, .shs-body select, .shs-body textarea { padding: 5px 8px;
      border: 1px solid var(--shs-border-strong); border-radius: 5px;
      background: var(--shs-bg-card); color: var(--shs-ink-strong);
      font-family: var(--shs-font); font-size: 12px; width: 100%;
      box-sizing: border-box; caret-color: var(--shs-action); }
    .shs-body textarea { resize: vertical; min-height: 56px;
      font-family: var(--shs-font); line-height: 1.4; }
    .shs-input:focus, .shs-body select:focus, .shs-body textarea:focus {
      outline: 2px solid var(--shs-brass); outline-offset: -1px; }
    /* [2] Placeholder com contraste ≥4.5:1 sobre var(--shs-bg-card, #fffdf3) (era #b3a17c ≈2,5:1). */
    .shs-input::placeholder, .shs-body textarea::placeholder { color: var(--shs-muted); }

    /* ---- Botões ---- */
    .shs-btn { display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 12px; border: 1px solid var(--shs-action-dark, #4a2708); border-radius: 6px;
      background: var(--shs-action); color: var(--shs-bg-active, #f7ecd2); cursor: pointer;
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
    .shs-ic { flex-shrink: 0; }

    /* ---- Tooltips (CSS puro: hover/focus via data-tip) ---- */
    [data-tip] { position: relative; }
    [data-tip]:hover::after, [data-tip]:focus-visible::after {
      content: attr(data-tip); position: absolute; bottom: calc(100% + 7px);
      left: 50%; transform: translateX(-50%); z-index: 2147483600;
      background: var(--shs-ink-strong); color: var(--shs-warn-bg, #f5ecd0);
      border: 1px solid var(--shs-brass);
      padding: 4px 9px; border-radius: 5px; font-size: 11px; font-weight: 400;
      font-family: var(--shs-font); line-height: 1.35;
      white-space: normal; max-width: min(260px, 90vw); text-align: center;
      pointer-events: none; box-shadow: 0 3px 10px rgba(40,24,6,.35); }
    [data-tip]:hover::before, [data-tip]:focus-visible::before {
      content: ''; position: absolute; bottom: calc(100% + 2px); left: 50%;
      transform: translateX(-50%); z-index: 2147483600;
      border: 5px solid transparent; border-top-color: var(--shs-ink-strong);
      pointer-events: none; }
    /* P0 revisão Onda C: o [data-tip] acima (position: relative) NÃO pode
       tirar o botão flutuante do canto quando ele ganha tooltip de alerta. */
    .shs-fab, .shs-fab[data-tip] { position: fixed; }

    /* ---- Spinner (currentColor: visível em botão primário E ghost/danger) ---- */
    .shs-spinner { width: 13px; height: 13px; display: inline-block;
      border: 2px solid color-mix(in srgb, currentColor 35%, transparent);
      border-top-color: currentColor;
      border-radius: 50%; animation: shs-spin .7s linear infinite; }
    @keyframes shs-spin { to { transform: rotate(360deg); } }

    /* ---- Ativação (tela de licença — reutiliza .shs-panel sem .shs-panel--app,
       então continua com altura por conteúdo sobre o layout Nexus) ---- */
    .shs-activate { left: 50%; transform: translateX(-50%); bottom: auto;
      top: max(9vh, 48px); width: min(440px, calc(100vw - 28px)); max-height: none; }
    .shs-activate .shs-brand-badge { width: 40px; height: 40px; border-radius: 10px; }
    .shs-activate .shs-brand { display: flex; align-items: center; gap: 12px;
      padding: 14px 16px; }
    .shs-activate .shs-brand-txt { display: flex; flex-direction: column; gap: 2px; }
    .shs-activate .shs-brand-txt strong { font-family: var(--shs-font);
      font-size: 15px; letter-spacing: 2px; color: var(--shs-ink-strong); }
    .shs-activate .shs-brand-txt span { font-size: 11px; color: var(--shs-muted); }
    .shs-input--key { font-family: ui-monospace, Consolas, 'Courier New', monospace;
      letter-spacing: 2px; text-transform: uppercase; font-size: 13px !important; }
    .shs-activate-foot { display: flex; align-items: flex-start; gap: 7px;
      margin: 10px 0 0; color: var(--shs-muted); font-size: 11px; line-height: 1.4; }
    .shs-activate-foot .shs-ic { color: var(--shs-brass); margin-top: 1px; }

    /* ---- Linhas / textos ---- */
    .shs-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
    .shs-muted { color: var(--shs-muted); }
    .shs-danger { color: var(--shs-danger); font-weight: 700; }
    .shs-ok { color: var(--shs-ok); font-weight: 700; }
    .shs-warn { color: var(--shs-warn); font-weight: 600; }
    .shs-strong { color: var(--shs-ink-strong); font-weight: 700; }

    /* ---- Pills ---- */
    .shs-pill { display: inline-block; padding: 1px 8px; border-radius: 999px;
      border: 1px solid var(--shs-border); background: var(--shs-bg-inset);
      font-size: 10.5px; font-weight: 600;
      font-variant-numeric: tabular-nums; }
    .shs-pill--error { background: var(--shs-danger-bg); border-color: var(--shs-danger); color: var(--shs-danger); }
    .shs-pill--ok { background: var(--shs-ok-bg); border-color: var(--shs-ok); color: var(--shs-ok); }
    .shs-pill--warn { background: var(--shs-warn-bg); border-color: var(--shs-warn); color: var(--shs-warn); }
    .shs-pill--info { background: var(--shs-info-bg); border-color: var(--shs-info); color: var(--shs-info); }
    .shs-pill--muted { background: var(--shs-bg-inset); color: var(--shs-muted); }

    /* ---- Estados / utilitários ---- */
    .shs-empty { padding: 18px 12px; text-align: center; color: var(--shs-muted); }
    .shs-progress { margin: 8px 0; }
    .shs-progress-bar { height: 6px; border-radius: 4px; overflow: hidden;
      background: var(--shs-bg-inset); border: 1px solid var(--shs-border); }
    .shs-progress-fill { height: 100%; background: var(--shs-ok); transition: width .3s; }
    .shs-warnbox { padding: 6px 10px; background: var(--shs-warn-bg);
      border: 1px solid var(--shs-warn); border-radius: 6px; color: var(--shs-warn);
      font-weight: 600; margin: 8px 0; }
    .shs-divider { border: none; border-top: 1px solid var(--shs-border); margin: 10px 0; }
    .shs-tablewrap { overflow-x: auto; }
    .shs-notification { margin: 0 0 10px; padding: 6px 10px; border-radius: 6px;
      font-weight: 600; }
    .shs-notification--ok { background: var(--shs-ok-bg); color: var(--shs-ok);
      border: 1px solid var(--shs-ok); }
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
    isolateKeyboard(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = styles();
    shadow.appendChild(style);
  }
  return host.shadowRoot as ShadowRoot;
}

export function mountShell(): void {
  const shadow = ensureHost();
  // [11] Momento autoral único do shell: classe efêmera de entrada do painel
  // (keyframes shs-open — opacity+scale, 140ms), removida no animationend.
  const animarAbertura = (alvo: HTMLElement): void => {
    alvo.classList.remove('shs-open');
    void alvo.offsetWidth; // força reflow para reiniciar a animação em reaberturas
    alvo.classList.add('shs-open');
  };
  const painelExistente = shadow.querySelector('.shs-panel');
  if (painelExistente !== null) {
    // Já montado: só garante visível (sincronizar o estado — senão o 1º
    // clique no FAB seria no-op).
    const existente = painelExistente as HTMLElement;
    existente.style.display = 'flex';
    panelOpen = true;
    animarAbertura(existente);
    return;
  }

  const ctx = gameContext();

  const fab = document.createElement('button');
  fab.className = 'shs-fab';
  fab.type = 'button';

  fab.setAttribute('aria-label', 'Abrir Toxic Squad Hub');
  fab.appendChild(icon('shield', 22));
  fab.addEventListener('click', () => {
    setPanelOpen(!panelOpen);
  });
  shadow.appendChild(fab);

  const panel = document.createElement('div');
  // .shs-panel--app = janela do hub com tamanho fixo (~1060×720); o diálogo de
  // ativação usa .shs-panel puro e não é afetado.
  panel.className = 'shs-panel shs-panel--app';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Toxic Squad Hub');
  // Onda B: o painel LEMBRA se estava aberto ou fechado (antes reabria sobre o
  // jogo a cada troca de página). 1º uso = aberto.
  panelOpen = gm.get<boolean>(PANEL_OPEN_KEY, true);
  panel.style.display = panelOpen ? 'flex' : 'none';
  // [11] Entrada animada no 1º mount (e a classe se remove sozinha ao terminar).
  panel.addEventListener('animationend', (event) => {
    if (event.target === panel && event.animationName === 'shs-open') panel.classList.remove('shs-open');
    if (event.target === panel && event.animationName === 'shs-open-max') panel.classList.remove('shs-open');
  });
  if (panelOpen) animarAbertura(panel);
  // Preferência de tamanho persistida (maximizado entre sessões).
  const maximizarPref = gm.get<boolean>('shs-in-game:panel-max', false);
  if (maximizarPref) panel.classList.add('shs-panel--max');
  // Posição arrastada persistida (restaurada no tamanho normal).
  const POS_KEY = 'shs-in-game:panel-pos';
  /** Mantém a posição dentro da janela (Onda C: monitor/janela menor escondia o painel). */
  const clampPos = (left: number, top: number): { l: number; t: number } => {
    const width = panel.offsetWidth || Math.min(1060, window.innerWidth - 24);
    return {
      l: Math.min(Math.max(4, left), Math.max(4, window.innerWidth - width - 4)),
      t: Math.min(Math.max(4, top), Math.max(4, window.innerHeight - 60)),
    };
  };
  const restorePanelPos = (): void => {
    const pos = gm.get<{ l: number; t: number } | null>(POS_KEY, null);
    if (pos === null || !Number.isFinite(pos.l) || !Number.isFinite(pos.t)) return;
    const safe = clampPos(pos.l, pos.t);
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = `${safe.l}px`;
    panel.style.top = `${safe.t}px`;
  };
  window.addEventListener('resize', () => {
    if (!panel.classList.contains('shs-panel--max') && panel.style.top !== '') restorePanelPos();
  });
  restorePanelPos();
  shadow.appendChild(panel);

  // ===== Header: badge chocolate + wordmark + contexto + botões-ícone =====
  const head = document.createElement('div');
  head.className = 'shs-head';
  const badge = document.createElement('span');
  badge.className = 'shs-brand-badge';
  badge.appendChild(icon('shield', 18));
  const headTxt = document.createElement('span');
  headTxt.className = 'shs-head-txt';
  const strong = document.createElement('strong');
  strong.textContent = 'TOXIC SQUAD';
  const sub = document.createElement('span');
  sub.className = 'shs-head-sub';
  sub.appendChild(icon('user', 11));
  sub.appendChild(document.createTextNode(ctx.player));
  sub.appendChild(document.createTextNode('·'));
  sub.appendChild(icon('globe', 11));
  sub.appendChild(document.createTextNode(ctx.world));
  headTxt.append(strong, sub);
  head.append(badge, headTxt);
  // Busca rápida logo após a marca (Onda B: antes ficava à direita do X).
  const searchWrap = document.createElement('div');
  searchWrap.className = 'shs-searchwrap';
  head.appendChild(searchWrap);
  const spacer = document.createElement('span');
  spacer.className = 'shs-head-spacer';
  head.appendChild(spacer);

  // Maximizar/restaurar (⤢): painel largo persistido em GM storage.
  const maximize = document.createElement('button');
  maximize.className = 'shs-headbtn';
  maximize.type = 'button';
  maximize.setAttribute('data-max', 'true');
  const defineMax = (max: boolean): void => {
    panel.classList.toggle('shs-panel--max', max);
    // Posição arrastada só vale no tamanho normal — maximizado é centrado.
    if (max) {
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '';
      panel.style.bottom = '';
    } else {
      restorePanelPos();
    }
    maximize.replaceChildren(icon(max ? 'compress' : 'maximize', 14));
    // Onda B: só o tooltip do painel (o title nativo gerava DOIS tooltips).
    const rotulo = max ? 'Restaurar tamanho' : 'Maximizar painel';
    maximize.setAttribute('aria-label', rotulo);
    maximize.setAttribute('data-tip', rotulo);
    gm.set('shs-in-game:panel-max', max);
  };
  maximize.addEventListener('click', () => {
    defineMax(!panel.classList.contains('shs-panel--max'));
  });
  defineMax(maximizarPref);
  head.appendChild(maximize);

  // Minimizar REAL: recolhe TUDO exceto o header (faixa/sidebar/conteúdo/rodapé
  // escondidos e a janela encolhe); o botão vira restaurar. Diferente de fechar
  // (some da tela).
  const minimize = document.createElement('button');
  minimize.className = 'shs-headbtn';
  minimize.type = 'button';
  const defineMin = (min: boolean): void => {
    panel.classList.toggle('shs-panel--min', min);
    minimize.replaceChildren(icon(min ? 'maximize' : 'minus', 14));
    const rotulo = min ? 'Restaurar painel' : 'Minimizar painel';
    minimize.setAttribute('aria-label', rotulo);
    minimize.setAttribute('data-tip', rotulo);
  };
  minimize.addEventListener('click', () => {
    defineMin(!panel.classList.contains('shs-panel--min'));
  });
  defineMin(false);
  head.appendChild(minimize);

  const close = document.createElement('button');
  close.className = 'shs-headbtn';
  close.type = 'button';
  close.appendChild(icon('x', 14));
  close.setAttribute('aria-label', 'Fechar painel');
  close.setAttribute('data-tip', 'Fechar painel');
  close.addEventListener('click', () => {
    setPanelOpen(false);
  });
  head.appendChild(close);
  panel.appendChild(head);

  // ===== Busca rápida (Onda 6): Ctrl+K foca; resultados navegam à seção =====
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'shs-search';
  searchInput.placeholder = 'Buscar (Ctrl+K)';
  searchInput.setAttribute('aria-label', 'Busca rápida de ferramentas');
  const searchPop = document.createElement('div');
  searchPop.className = 'shs-searchpop';
  searchWrap.append(searchInput, searchPop);
  // Clique na lista (inclusive na barra de rolagem) não tira o foco do campo.
  searchPop.addEventListener('mousedown', (event) => event.preventDefault());

  // Seção ativa: desenha com LIMPEZA do anterior (timers ao vivo) e lembra a
  // escolha entre páginas (Onda B: antes voltava sempre para "Início").
  let sectionCleanup: (() => void) | null = null;
  const disposeSection = (): void => {
    const cleanup = sectionCleanup;
    sectionCleanup = null;
    try {
      cleanup?.();
    } catch {
      /* limpeza nunca derruba o painel */
    }
  };
  const drawSection = (section: SectionDef): void => {
    disposeSection();
    body.replaceChildren();
    const cleanup = section.render(body);
    sectionCleanup = typeof cleanup === 'function' ? cleanup : null;
  };
  const switchToSection = (sectionId: string, targetId?: string): void => {
    const section = sections.find((s) => s.id === sectionId);
    if (section === undefined) return;
    body.dataset.section = section.id;
    gm.set(LAST_SECTION_KEY, section.id);
    for (const other of Array.from(nav.children)) {
      (other as HTMLElement).dataset.active = 'false';
      (other as HTMLElement).setAttribute('aria-selected', 'false');
    }
    const item = Array.from(nav.children).find(
      (child) => (child as HTMLElement).dataset.sectionId === section.id,
    );
    if (item instanceof HTMLElement) {
      item.dataset.active = 'true';
      item.setAttribute('aria-selected', 'true');
    }
    drawSection(section);
    body.scrollTop = 0;
    if (targetId !== undefined) highlightTarget(targetId);
  };
  /** Rola até o item da busca e pisca o destaque (Onda C). */
  const highlightTarget = (targetId: string): void => {
    const alvo = Array.from(body.querySelectorAll<HTMLElement>('[data-search-id]')).find(
      (el) => el.dataset.searchId === targetId,
    );
    if (alvo === undefined) return;
    alvo.scrollIntoView({ block: 'center' });
    alvo.classList.remove('shs-flash');
    void alvo.offsetWidth;
    alvo.classList.add('shs-flash');
    window.setTimeout(() => alvo.classList.remove('shs-flash'), 3_400);
  };

  const setPanelOpen = (open: boolean): void => {
    panelOpen = open;
    gm.set(PANEL_OPEN_KEY, open);
    panel.style.display = open ? 'flex' : 'none';
    // Reabrir volta do estado minimizado para o painel completo.
    defineMin(false);
    if (open) {
      renderedScreen = null; // redesenha a seção ativa (dados frescos)
      renderNav();
      animarAbertura(panel);
    } else {
      disposeSection(); // painel fechado: nenhum timer de seção fica rodando
    }
  };

  const closeSearch = (): void => {
    searchPop.replaceChildren();
    searchPop.classList.remove('shs-searchpop--open');
  };

  searchInput.addEventListener('input', () => {
    const raw = searchInput.value.trim();
    if (raw.length < 2) {
      closeSearch();
      return;
    }
    const needle = normalizeSearch(raw);
    const matches = [...searchEntries.values()]
      .filter((entry) => {
        const haystack = normalizeSearch(`${entry.label} ${entry.hint ?? ''} ${entry.keywords ?? ''}`);
        return haystack.includes(needle);
      })
      .slice(0, 12);
    searchPop.replaceChildren();
    if (matches.length === 0) {
      const vazio = document.createElement('div');
      vazio.className = 'shs-searchempty';
      vazio.textContent = 'Nada encontrado.';
      searchPop.appendChild(vazio);
    }
    for (const entry of matches) {
      const botao = document.createElement('button');
      botao.type = 'button';
      botao.className = 'shs-searchitem';
      if (entry.icon !== undefined) botao.appendChild(icon(entry.icon, 14));
      const texto = document.createElement('span');
      texto.className = 'shs-searchitem-label';
      texto.textContent = entry.label;
      botao.appendChild(texto);
      if (entry.hint !== undefined && entry.hint !== '') {
        const hint = document.createElement('span');
        hint.className = 'shs-searchitem-hint';
        hint.textContent = entry.hint;
        botao.appendChild(hint);
      }
      botao.addEventListener('click', () => {
        entry.beforeNavigate?.();
        switchToSection(entry.sectionId, entry.targetId);
        searchInput.value = '';
        closeSearch();
        searchInput.blur();
      });
      searchPop.appendChild(botao);
    }
    searchPop.classList.add('shs-searchpop--open');
  });
  // Onda C: ↑/↓ percorrem os resultados, Enter abre o destacado (ou o 1º).
  let activeIndex = -1;
  const resultButtons = (): HTMLButtonElement[] =>
    Array.from(searchPop.querySelectorAll<HTMLButtonElement>('.shs-searchitem'));
  const markActive = (index: number): void => {
    const buttons = resultButtons();
    if (buttons.length === 0) return;
    activeIndex = (index + buttons.length) % buttons.length;
    buttons.forEach((button, i) => {
      button.dataset.active = String(i === activeIndex);
    });
    buttons[activeIndex]?.scrollIntoView({ block: 'nearest' });
  };
  searchInput.addEventListener('input', () => {
    activeIndex = -1;
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      searchInput.value = '';
      closeSearch();
      searchInput.blur();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      markActive(activeIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      markActive(activeIndex - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const buttons = resultButtons();
      buttons[activeIndex >= 0 ? activeIndex : 0]?.click();
    }
  });
  searchInput.addEventListener('blur', () => {
    closeSearch();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      // Onda B: Ctrl+K também ABRE o painel fechado/minimizado.
      if (!panelOpen) setPanelOpen(true);
      if (panel.classList.contains('shs-panel--min')) defineMin(false);
      searchInput.focus();
      searchInput.select();
    }
  });

  // Onda C: Esc fecha o painel quando o foco está nele (e não há diálogo
  // aberto nem campo sendo editado — Esc no campo só sai do campo).
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !panelOpen) return;
    if (shadow.querySelector('.tsh-overlay') !== null) return;
    if (isEditableTarget(event.composedPath()[0])) {
      (event.composedPath()[0] as HTMLElement).blur();
      return;
    }
    setPanelOpen(false);
    fab.focus();
  });

  // ===== Arraste pelo header (Onda 22): posição persistida, botões excluídos =====
  head.style.cursor = 'grab';
  head.addEventListener('mousedown', (event) => {
    if (!(event.target instanceof Element)) return;
    // Onda B: botões E a busca não arrastam (o mousedown com preventDefault
    // impedia clicar no campo de busca).
    if (event.target.closest('.shs-headbtn, .shs-searchwrap, input, button, select, textarea') !== null) return;
    if (panel.classList.contains('shs-panel--max')) return; // maximizado é fixo
    if (event.button !== 0) return;
    const rect = panel.getBoundingClientRect();
    const dx = event.clientX - rect.left;
    const dy = event.clientY - rect.top;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    head.style.cursor = 'grabbing';
    const onMove = (move: MouseEvent): void => {
      const left = Math.min(Math.max(4, move.clientX - dx), Math.max(4, window.innerWidth - panel.offsetWidth - 4));
      const top = Math.min(Math.max(4, move.clientY - dy), Math.max(4, window.innerHeight - 48));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      head.style.cursor = 'grab';
      const final = panel.getBoundingClientRect();
      gm.set(POS_KEY, clampPos(Math.round(final.left), Math.round(final.top)));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    event.preventDefault();
  });
  // Duplo clique no header alterna maximizar (como janelas de desktop).
  head.addEventListener('dblclick', (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('.shs-headbtn, .shs-searchwrap, input, button') !== null) return;
    defineMax(!panel.classList.contains('shs-panel--max'));
  });

  // Faixa de estado da licença em modo graça (rede caiu / revalidação 24h) —
  // entre o header e o layout.
  // (Onda C: a faixa de modo offline no topo repetia o rodapé — o aviso agora
  //  vive só no rodapé, com o horário da revalidação.)
  const license = licenseState();

  // ===== Layout em colunas: sidebar de navegação + conteúdo =====
  const layout = document.createElement('div');
  layout.className = 'shs-layout';

  const side = document.createElement('div');
  side.className = 'shs-side';
  const nav = document.createElement('div');
  nav.className = 'shs-nav';
  nav.role = 'tablist';
  nav.setAttribute('aria-orientation', 'vertical');
  side.appendChild(nav);
  // (Onda 23: chip decorativo "Busca rápida Ctrl K" removido a pedido do dono
  //  — não havia filtro vinculado e afetava a honestidade da UI.)
  layout.appendChild(side);

  const main = document.createElement('div');
  main.className = 'shs-main';
  const body = document.createElement('div');
  body.className = 'shs-body';
  body.role = 'tabpanel';
  body.dataset.section = '';
  main.appendChild(body);

  // Faixa de licença no rodapé do conteúdo: estado (com validade) + versão.
  const foot = document.createElement('div');
  foot.className = 'shs-foot';
  if (license.kind !== 'valida') foot.classList.add('shs-foot--warn');
  const selo = document.createElement('span');
  selo.className = `shs-selo ${license.kind === 'graca' ? 'shs-selo--warn' : 'shs-selo--ok'}`;
  selo.appendChild(icon(license.kind === 'graca' ? 'clock' : 'key', 12));
  if (license.kind === 'valida') {
    selo.appendChild(document.createTextNode(`Licença de ${license.accountName}`));
    const validade = document.createElement('span');
    validade.className = 'shs-pill shs-pill--ok';
    validade.setAttribute('data-tip', 'Validade da sua chave — emita a próxima com o líder.');
    validade.textContent =
      license.licenseExpiresAt !== null
        ? `válida até ${new Date(license.licenseExpiresAt).toLocaleDateString('pt-BR')}`
        : 'ativa';
    selo.appendChild(validade);
  } else if (license.kind === 'graca') {
    const ate = new Date(license.offlineAte).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    selo.appendChild(
      document.createTextNode(`Modo offline — a licença revalida no próximo carregamento da página (a partir das ${ate})`),
    );
  } else {
    selo.className = 'shs-selo shs-selo--warn';
    selo.appendChild(document.createTextNode('Licença inativa'));
  }
  const versao = document.createElement('span');
  versao.className = 'shs-foot-ver';
  versao.textContent = `v${__SHS_VERSION__}`;
  foot.append(selo, versao);
  main.appendChild(foot);

  layout.appendChild(main);
  panel.appendChild(layout);

  // Última screen do jogo renderizada (null = nenhuma ainda): o re-render
  // automático da seção ativa só acontece quando a screen MUDA — mutações de
  // DOM sem navegação não descartam o estado do usuário.
  let renderedScreen: string | null = null;

  function renderNav(): void {
    const screen = currentScreen();
    nav.innerHTML = '';
    const available = sections.filter((section) => section.matchScreen === undefined || section.matchScreen === screen);
    // Seção padrão (Onda 22 — corrige conteúdo em branco): sem seleção salva
    // ou se a selecionada não está disponível nesta tela → a primeira disponível.
    const atualValida = available.some((section) => section.id === body.dataset.section);
    if (body.dataset.section === '' || body.dataset.section === undefined || !atualValida) {
      // Onda B: volta para a última seção usada (se disponível nesta tela).
      const lembrada = gm.get<string>(LAST_SECTION_KEY, '');
      const escolhida = available.find((section) => section.id === lembrada) ?? available[0];
      if (escolhida !== undefined) body.dataset.section = escolhida.id;
    }
    for (const section of available) {
      const item = document.createElement('button');
      item.className = 'shs-navitem';
      item.type = 'button';
      if (section.icon !== undefined) item.appendChild(icon(section.icon, 15));
      item.appendChild(document.createTextNode(section.label));
      item.role = 'tab';
      item.dataset.sectionId = section.id;
      const selected = String(body.dataset.section === section.id);
      item.dataset.active = selected;
      item.setAttribute('aria-selected', selected);
      item.addEventListener('click', () => {
        switchToSection(section.id);
      });
      nav.appendChild(item);
    }
    // Re-render a seção ativa SÓ quando a screen do jogo mudou (troca de
    // página); no 1º render renderedScreen é null, então renderiza.
    if (screen !== renderedScreen && panelOpen) {
      renderedScreen = screen;
      const active = sections.find((section) => section.id === body.dataset.section);
      if (active !== undefined && available.includes(active)) {
        // P1 (revisão Nexus): limpa ANTES de renderizar — as seções só fazem
        // appendChild; sem isto, navegar in-game duplicava a seção inteira.
        drawSection(active);
      }
    }
  }

  // Navegação interna do jogo troca o conteúdo sem recarregar: observa e refaz a sidebar.
  const observer = new MutationObserver(() => renderNav());
  observer.observe(document.getElementById('content_value') ?? document.body, { childList: true, subtree: false });

  renderNav();
}
