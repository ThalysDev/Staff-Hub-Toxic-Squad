// Estilos da casca do painel — "Instrumento" (v3.2, redesign aprovado no
// Claude Design). Painel neutro claro, UM acento verde (ação principal e
// estado ativo), âmbar só para cravado próximo e vermelho só para
// pausa/falha. Horários, coordenadas e contagens em mono tabular. Os NOMES
// das classes seguem os da versão anterior: só o visual mudou.

import { themeDeclarations } from './theme';

export function shellStyles(): string {
  return `
    :host {
      ${themeDeclarations()}
      all: initial;
      font-family: var(--shs-font);
      font-size: 13px;
      color: var(--shs-ink);
      -webkit-font-smoothing: antialiased;
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition: none !important; animation: none !important; }
    }
    ::selection { background: #2e6b3e33; }
    .shs-mono, .shs-tabular { font-family: var(--shs-font-mono); font-variant-numeric: tabular-nums; }

    /* ---- Escudo flutuante: tinta (normal) · âmbar (cravado) · vermelho (pausa) ---- */
    .shs-fab { position: fixed; left: 60px; bottom: 10px; z-index: 2147483000;
      width: 44px; height: 44px; border-radius: 12px; cursor: pointer; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      border: 0; background: var(--shs-ink-strong); color: #ffffff;
      box-shadow: 0 4px 12px rgba(20,18,14,.3); }
    .shs-fab:hover { background: #33312c; }
    .shs-fab:focus-visible { outline: 2px solid var(--shs-action); outline-offset: 3px; }
    @keyframes shs-fab-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(154,101,18,0), 0 4px 12px rgba(20,18,14,.3); }
      50% { box-shadow: 0 0 0 6px rgba(154,101,18,.35), 0 4px 12px rgba(20,18,14,.3); } }
    .shs-fab--alert { background: var(--shs-brass); animation: shs-fab-pulse 1.2s ease-in-out infinite; }
    @keyframes shs-fab-halt { 0%, 100% { box-shadow: 0 0 0 0 rgba(179,38,30,0), 0 4px 12px rgba(20,18,14,.3); }
      50% { box-shadow: 0 0 0 7px rgba(179,38,30,.35), 0 4px 12px rgba(20,18,14,.3); } }
    .shs-fab--halt { background: var(--shs-danger); animation: shs-fab-halt 1s ease-in-out infinite; }
    .shs-fab[data-tip]:hover::after { left: 0; transform: none; bottom: calc(100% + 8px); }
    .shs-fab[data-tip]:hover::before { left: 16px; transform: none; }

    /* ---- Painel ---- */
    .shs-panel { position: fixed; left: 10px; bottom: 62px; z-index: 2147483000;
      display: flex; flex-direction: column; overflow: hidden;
      background: var(--shs-bg); color: var(--shs-ink);
      border: 1px solid var(--shs-border-strong); border-radius: 14px;
      box-shadow: var(--shs-shadow);
      font-family: var(--shs-font); font-size: 13px; line-height: 1.45;
      transition: width .18s ease, height .18s ease, max-height .18s ease,
        left .18s ease, bottom .18s ease, transform .18s ease; }
    .shs-panel--app { width: min(1060px, calc(100vw - 24px));
      height: min(720px, calc(100vh - 86px)); }
    .shs-panel--app.shs-panel--max { width: 92vw; height: 86vh;
      left: 50%; transform: translateX(-50%); bottom: 7vh; }
    .shs-panel--min > :not(.shs-head) { display: none !important; }
    .shs-panel--min { overflow: visible; }
    .shs-panel--app.shs-panel--min { height: auto; }
    .shs-panel--min .shs-headbtn[data-max] { display: none; }
    .shs-panel.shs-open { animation: shs-open .14s ease-out; }
    .shs-panel--max.shs-open { animation-name: shs-open-max; }
    @keyframes shs-open { from { opacity: 0; transform: scale(.985); } to { opacity: 1; transform: scale(1); } }
    @keyframes shs-open-max {
      from { opacity: 0; transform: translateX(-50%) scale(.985); }
      to { opacity: 1; transform: translateX(-50%) scale(1); }
    }

    /* ---- Cabeçalho ---- */
    .shs-head { display: flex; align-items: center; gap: 12px; flex-shrink: 0;
      height: 56px; padding: 0 10px 0 16px;
      background: var(--shs-bg-head); border-bottom: 1px solid var(--shs-border); }
    .shs-brand-badge { width: 30px; height: 30px; flex-shrink: 0; border-radius: 8px;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--shs-ink-strong); color: #ffffff; }
    .shs-head-txt { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .shs-head strong { font-size: 14px; font-weight: 600; letter-spacing: -.01em; line-height: 1.2;
      color: var(--shs-ink-strong); white-space: nowrap; }
    .shs-head-sub { display: inline-flex; align-items: center; gap: 5px;
      font-size: 11.5px; color: var(--shs-muted); white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; max-width: 320px; }
    .shs-head .shs-muted { color: var(--shs-muted); }
    .shs-headbtn { width: 36px; height: 36px; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      background: transparent; border: 0; border-radius: 9px;
      color: var(--shs-ink); cursor: pointer; padding: 0; line-height: 1; position: relative; }
    .shs-headbtn:hover { background: var(--shs-bg-hover); color: var(--shs-ink-strong); }
    .shs-head-spacer { margin-left: auto; }
    .shs-head [data-tip]:hover::after, .shs-head [data-tip]:focus-visible::after {
      bottom: auto; top: calc(100% + 7px); }
    .shs-head [data-tip]:hover::before, .shs-head [data-tip]:focus-visible::before {
      bottom: auto; top: calc(100% + 2px); border-top-color: transparent;
      border-bottom-color: var(--shs-ink-strong); }
    .shs-head [data-tip]:last-child:hover::after, .shs-head [data-tip]:last-child:focus-visible::after {
      left: auto; right: 0; transform: none; }
    @keyframes shs-flash { 0%, 100% { box-shadow: 0 0 0 0 rgba(46,107,62,0); }
      30% { box-shadow: 0 0 0 3px rgba(46,107,62,.45); } }
    .shs-flash { animation: shs-flash 1.6s ease-in-out 2; border-radius: 10px; }

    /* Busca rápida (Ctrl+K) */
    .shs-searchwrap { position: relative; margin-left: auto; }
    .shs-search { width: 300px; height: 36px; padding: 0 12px 0 34px; font-size: 13px; box-sizing: border-box;
      font-family: var(--shs-font); color: var(--shs-ink-strong); background: var(--shs-bg-side);
      border: 1px solid var(--shs-border); border-radius: 9px; outline: none; }
    .shs-search:focus { border-color: var(--shs-action); background: var(--shs-bg-card); }
    .shs-search::placeholder { color: var(--shs-muted); }
    .shs-search-ic { position: absolute; left: 11px; top: 50%; transform: translateY(-50%);
      color: var(--shs-muted); pointer-events: none; display: inline-flex; }
    .shs-searchpop { display: none; position: absolute; top: 42px; right: 0; width: 340px;
      max-height: 340px; overflow-y: auto; background: var(--shs-bg-card);
      border: 1px solid var(--shs-border); border-radius: 12px;
      box-shadow: var(--shs-shadow); z-index: 40; padding: 6px; }
    .shs-searchpop--open { display: block; }
    .shs-searchitem { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 36px;
      padding: 6px 10px; background: transparent; border: none; border-radius: 8px;
      font-family: var(--shs-font); font-size: 13px; color: var(--shs-ink-strong);
      cursor: pointer; text-align: left; }
    .shs-searchitem:hover, .shs-searchitem:focus-visible,
    .shs-searchitem[data-active='true'] { background: var(--shs-bg-hover); outline: none; }
    .shs-searchitem-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .shs-searchitem-hint { font-size: 11.5px; color: var(--shs-muted); flex-shrink: 0; }
    .shs-searchempty { padding: 10px; font-size: 12.5px; color: var(--shs-muted); }

    .shs-license { flex-shrink: 0; padding: 6px 16px; background: var(--shs-warn-bg);
      color: var(--shs-warn); border-bottom: 1px solid var(--shs-border); font-size: 12px; }

    /* ---- Layout: barra lateral + conteúdo ---- */
    .shs-layout { display: flex; flex: 1; min-height: 0; }
    .shs-side { width: 208px; flex-shrink: 0; display: flex; flex-direction: column;
      min-height: 0; background: var(--shs-bg-side); border-right: 1px solid var(--shs-border); }
    .shs-nav { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 10px;
      display: flex; flex-direction: column; gap: 2px; overscroll-behavior: contain; }
    .shs-nav::-webkit-scrollbar { width: 8px; }
    .shs-nav::-webkit-scrollbar-thumb { background: var(--shs-border-strong); border-radius: 4px; }
    .shs-navitem { display: flex; align-items: center; gap: 10px; height: 38px;
      flex-shrink: 0; padding: 0 10px; border: none; border-radius: 8px;
      background: transparent; color: var(--shs-ink);
      cursor: pointer; font-family: var(--shs-font); font-size: 13.5px;
      font-weight: 500; text-align: left; }
    .shs-navitem:hover { background: var(--shs-bg-inset); color: var(--shs-ink-strong); }
    .shs-navitem[data-active='true'] { background: var(--shs-bg-card); color: var(--shs-ink-strong);
      box-shadow: 0 0 0 1px var(--shs-border), var(--shs-shadow-sm); }
    .shs-navitem .shs-ic { color: var(--shs-muted); }
    .shs-navitem[data-active='true'] .shs-ic { color: var(--shs-action); }
    .shs-navcount { margin-left: auto; font-family: var(--shs-font-mono); font-size: 11.5px;
      color: var(--shs-muted); font-variant-numeric: tabular-nums; }
    .shs-navitem[data-active='true'] .shs-navcount { color: var(--shs-action); }
    .shs-navitem:focus-visible { outline: 2px solid var(--shs-action); outline-offset: -2px; }
    .shs-sidefoot { flex-shrink: 0; display: flex; flex-direction: column; gap: 6px;
      padding: 12px 20px 14px; border-top: 1px solid var(--shs-border); font-size: 12px; color: var(--shs-ink); }
    .shs-sidefoot-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .shs-sidefoot-row span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .shs-sidefoot-muted { color: var(--shs-muted); }
    .shs-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--shs-ok); display: inline-block; }
    .shs-dot--warn { background: var(--shs-brass); }
    .shs-dot--err { background: var(--shs-danger); }
    .shs-dot--off { background: var(--shs-ink-disabled); }

    /* ---- Conteúdo ---- */
    .shs-main { flex: 1; min-width: 0; min-height: 0; display: flex;
      flex-direction: column; background: var(--shs-bg); }
    .shs-body { flex: 1; min-height: 0; overflow-y: auto; padding: 24px 28px;
      overscroll-behavior: contain; }
    .shs-body::-webkit-scrollbar, .shs-tablewrap::-webkit-scrollbar { width: 10px; height: 10px; }
    .shs-body::-webkit-scrollbar-thumb, .shs-tablewrap::-webkit-scrollbar-thumb {
      background: var(--shs-border-strong); border-radius: 6px; border: 2px solid var(--shs-bg); }
    .shs-body:focus-visible { outline: none; }
    .shs-body table { border-collapse: collapse; width: 100%; margin: 8px 0;
      background: var(--shs-bg-card); font-size: 13px; }
    .shs-body th, .shs-body td { border-bottom: 1px solid var(--shs-border);
      padding: 8px 10px; text-align: left; vertical-align: middle; }
    .shs-body thead th { background: transparent; color: var(--shs-muted);
      font-size: 11.5px; font-weight: 500; }
    .shs-body tbody tr:hover { background: var(--shs-bg-side); }
    .shs-body tfoot td { font-weight: 600; background: var(--shs-bg-side); }

    /* ---- Rodapé ---- */
    .shs-foot { display: flex; align-items: center; gap: 8px; flex-shrink: 0;
      padding: 6px 16px; font-size: 12px; flex-wrap: wrap;
      background: var(--shs-bg-card); border-top: 1px solid var(--shs-border); color: var(--shs-muted);
      font-variant-numeric: tabular-nums; }
    .shs-foot--warn { background: var(--shs-warn-bg); color: var(--shs-warn); }
    .shs-selo { display: inline-flex; align-items: center; gap: 6px; font-weight: 500; min-width: 0; }
    .shs-selo--ok { color: var(--shs-ok-ink); }
    .shs-selo--warn { color: var(--shs-warn); }
    .shs-foot-ver { margin-left: auto; color: var(--shs-muted); font-family: var(--shs-font-mono);
      font-size: 11.5px; white-space: nowrap; }

    /* ---- Cartões ---- */
    .shs-card { background: var(--shs-bg-card); border: 1px solid var(--shs-border);
      border-radius: 12px; padding: 16px 18px; margin: 0 0 12px; }
    .shs-card:last-child { margin-bottom: 0; }
    .shs-card-title { display: flex; align-items: center; gap: 8px; margin: 0 0 10px;
      font-size: 14px; font-weight: 600; color: var(--shs-ink-strong); }
    .shs-card-title--icon .shs-ic { color: var(--shs-muted); }

    /* ---- Campos ---- */
    .shs-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; margin: 0 0 12px; }
    .shs-field-label, .shs-field > .shs-label { font-size: 12.5px; font-weight: 500; color: var(--shs-ink-strong); }
    .shs-input, .shs-body select, .shs-body textarea { min-height: 36px; padding: 7px 11px;
      border: 1px solid var(--shs-border-strong); border-radius: 9px;
      background: var(--shs-bg-field); color: var(--shs-ink-strong);
      font-family: var(--shs-font); font-size: 13px; width: 100%;
      box-sizing: border-box; caret-color: var(--shs-action); }
    .shs-body textarea { resize: vertical; min-height: 72px; line-height: 1.45; }
    .shs-input:focus, .shs-body select:focus, .shs-body textarea:focus {
      outline: 2px solid var(--shs-action); outline-offset: 0; border-color: transparent; }
    .shs-input::placeholder, .shs-body textarea::placeholder { color: var(--shs-muted); }

    /* ---- Botões: primário (verde) · secundário · perigo ---- */
    .shs-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      min-height: 34px; padding: 0 14px; border: 1px solid transparent; border-radius: 9px;
      background: var(--shs-action); color: var(--shs-on-action); cursor: pointer; box-sizing: border-box;
      font-family: var(--shs-font); font-size: 13px; font-weight: 600; white-space: nowrap; }
    .shs-btn:hover:not([disabled]) { background: var(--shs-action-hover); }
    .shs-btn[disabled] { opacity: .5; cursor: default; }
    .shs-btn:focus-visible { outline: 2px solid var(--shs-action); outline-offset: 2px; }
    .shs-btn-ghost { background: var(--shs-bg-card); color: var(--shs-ink-strong); border-color: var(--shs-border-strong); }
    .shs-btn-ghost:hover:not([disabled]) { background: var(--shs-bg-side); }
    .shs-btn-danger { background: var(--shs-bg-card); color: var(--shs-danger); border-color: var(--shs-border-strong); }
    .shs-btn-danger:hover:not([disabled]) { background: var(--shs-danger-bg); border-color: var(--shs-danger); }
    .shs-btn-sm { min-height: 30px; padding: 0 10px; font-size: 12.5px; border-radius: 8px; }
    .shs-ic { flex-shrink: 0; }

    /* ---- Dicas (tooltip) ---- */
    [data-tip] { position: relative; }
    [data-tip]:hover::after, [data-tip]:focus-visible::after {
      content: attr(data-tip); position: absolute; bottom: calc(100% + 7px);
      left: 50%; transform: translateX(-50%); z-index: 2147483600;
      background: var(--shs-ink-strong); color: #ffffff; border: 0;
      padding: 6px 10px; border-radius: 8px; font-size: 12px; font-weight: 400;
      font-family: var(--shs-font); line-height: 1.4;
      white-space: normal; max-width: min(260px, 90vw); width: max-content; text-align: left;
      pointer-events: none; box-shadow: 0 6px 16px rgba(20,18,14,.25); }
    [data-tip]:hover::before, [data-tip]:focus-visible::before {
      content: ''; position: absolute; bottom: calc(100% + 2px); left: 50%;
      transform: translateX(-50%); z-index: 2147483600;
      border: 5px solid transparent; border-top-color: var(--shs-ink-strong); pointer-events: none; }
    .shs-fab, .shs-fab[data-tip] { position: fixed; }

    .shs-spinner { width: 14px; height: 14px; display: inline-block;
      border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
      border-top-color: currentColor; border-radius: 50%; animation: shs-spin .7s linear infinite; }
    @keyframes shs-spin { to { transform: rotate(360deg); } }

    /* ---- Ativação (licença) ---- */
    .shs-activate { left: 50%; transform: translateX(-50%); bottom: auto;
      top: max(9vh, 48px); width: min(440px, calc(100vw - 28px)); max-height: none; }
    .shs-activate .shs-brand-badge { width: 36px; height: 36px; border-radius: 10px; }
    .shs-activate .shs-brand { display: flex; align-items: center; gap: 12px; padding: 16px 18px; }
    .shs-activate .shs-brand-txt { display: flex; flex-direction: column; gap: 2px; }
    .shs-activate .shs-brand-txt strong { font-size: 15px; font-weight: 600; color: var(--shs-ink-strong); }
    .shs-activate .shs-brand-txt span { font-size: 12px; color: var(--shs-muted); }
    .shs-input--key { font-family: var(--shs-font-mono); letter-spacing: 1.5px; text-transform: uppercase; font-size: 14px !important; }
    .shs-activate-foot { display: flex; align-items: flex-start; gap: 8px;
      margin: 12px 0 0; color: var(--shs-muted); font-size: 12px; line-height: 1.45; }
    .shs-activate-foot .shs-ic { color: var(--shs-muted); margin-top: 1px; }

    /* ---- Textos ---- */
    .shs-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
    .shs-muted { color: var(--shs-muted); }
    .shs-danger { color: var(--shs-danger); font-weight: 600; }
    .shs-ok { color: var(--shs-ok); font-weight: 600; }
    .shs-warn { color: var(--shs-warn); font-weight: 600; }
    .shs-strong { color: var(--shs-ink-strong); font-weight: 600; }

    /* ---- Chips de estado ---- */
    .shs-pill { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px; box-sizing: border-box;
      border-radius: 999px; border: 0; background: var(--shs-bg-inset); color: var(--shs-ink);
      font-size: 12px; font-weight: 500; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .shs-pill--error { background: var(--shs-danger-bg); color: #8f1d17; }
    .shs-pill--ok { background: var(--shs-ok-bg); color: var(--shs-ok-ink); }
    .shs-pill--warn { background: var(--shs-warn-bg); color: var(--shs-warn); }
    .shs-pill--info { background: var(--shs-info-bg); color: var(--shs-info); }
    .shs-pill--muted { background: var(--shs-bg-inset); color: var(--shs-muted); }

    .shs-empty { padding: 24px 12px; text-align: center; color: var(--shs-muted); }
    .shs-progress { margin: 8px 0; }
    .shs-progress-bar { height: 6px; border-radius: 4px; overflow: hidden; background: var(--shs-bg-inset); }
    .shs-progress-fill { height: 100%; background: var(--shs-action); transition: width .3s; }
    .shs-warnbox { padding: 10px 14px; background: var(--shs-warn-bg); border-radius: 10px;
      color: var(--shs-warn); font-weight: 500; margin: 8px 0; }
    .shs-divider { border: none; border-top: 1px solid var(--shs-border); margin: 14px 0; }
    .shs-tablewrap { overflow-x: auto; }
    .shs-notification { margin: 0 0 12px; padding: 10px 14px; border-radius: 10px; font-weight: 500; }
    .shs-notification--ok { background: var(--shs-ok-bg); color: var(--shs-ok-ink); }
    .shs-notification--error { background: var(--shs-danger-bg); color: #8f1d17; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
      outline: 2px solid var(--shs-action); outline-offset: 1px; }
    a { color: var(--shs-action); }
  `;
}
