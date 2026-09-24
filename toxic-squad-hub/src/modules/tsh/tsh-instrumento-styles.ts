// Camada "Instrumento" (redesign v3.2) sobre os estilos de Automações, dos
// diálogos (Configurar, Prévia, confirmações) e da Central de Comandos. Vem
// DEPOIS do CSS antigo no mesmo <style>: mesma especificidade, regra nova
// vence. Neutro, um acento verde, raios 8–14 px, rótulos sem caixa alta,
// números em mono tabular. Sem gradiente, sem lavanda, sem tracejado.

export const TSH_INSTRUMENTO_CSS = `
  /* ---------- Página de Automações ---------- */
  .tsh-page { display: flex; flex-direction: column; gap: 14px; }
  .tsh-head { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; margin: 0; padding: 0; border: 0; background: none; }
  .tsh-head-title { margin: 0; display: block; font-family: var(--shs-font); font-size: 20px; font-weight: 600;
    letter-spacing: -.015em; text-transform: none; color: var(--shs-ink-strong); }
  .tsh-head-desc { margin: 0; font-size: 13px; line-height: 1.45; color: var(--shs-muted); background: none; border: 0; padding: 0; }
  .tsh-toolbar { margin: 0; gap: 8px; }
  .tsh-seg { display: inline-flex; gap: 2px; padding: 3px; border: 0; border-radius: 10px; background: var(--shs-bg-inset); overflow: visible; }
  .tsh-seg-btn { height: 32px; padding: 0 12px; border: 0 !important; border-radius: 7px; background: transparent;
    font-size: 12.5px; font-weight: 500; color: var(--shs-ink); }
  .tsh-seg-btn[aria-checked='true'] { background: var(--shs-bg-card); color: var(--shs-ink-strong);
    box-shadow: 0 0 0 1px var(--shs-border), 0 1px 2px rgba(20,18,14,.06); }
  .tsh-seg-btn:focus-visible { outline: 2px solid var(--shs-action); outline-offset: 0; }

  .tsh-gcard { background: var(--shs-bg-card); border: 1px solid var(--shs-border); border-radius: 12px; overflow: hidden; }
  button.tsh-group-title, .tsh-group-title { display: flex; align-items: center; gap: 8px; width: 100%; margin: 0;
    padding: 12px 16px; border: 0; background: transparent; font-family: var(--shs-font); font-size: 13px; font-weight: 600;
    letter-spacing: 0; text-transform: none; color: var(--shs-ink-strong); }
  button.tsh-group-title:hover { background: var(--shs-bg-side); color: var(--shs-ink-strong); }
  button.tsh-group-title:focus-visible { outline: 2px solid var(--shs-action); outline-offset: -2px; }
  .tsh-group-title .shs-ic { color: var(--shs-muted); }
  .tsh-group-count, .tsh-group-count--on { margin-left: auto; padding: 0; border: 0; background: none;
    font-family: var(--shs-font-mono); font-size: 12px; font-weight: 400; color: var(--shs-muted); }
  .tsh-group-count--on { color: var(--shs-action); }
  .tsh-rows { display: flex; flex-direction: column; gap: 0; margin: 0; padding: 0; }

  .tsh-row { display: flex; flex-wrap: nowrap; align-items: center; gap: 12px; min-height: 56px; margin: 0; padding: 8px 12px 8px 16px;
    border: 0; border-top: 1px solid var(--shs-bg-inset); border-radius: 0; background: transparent; box-shadow: none; }
  .tsh-row:hover { background: var(--shs-bg-side); }
  .tsh-row--off .tsh-row-name { color: var(--shs-ink); }
  .tsh-row--off .tsh-row-desc { color: var(--shs-muted); } /* ink-disabled em texto reprovava contraste */
  .tsh-row-main { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .tsh-row-titleline { display: flex; align-items: center; gap: 8px; margin: 0; min-width: 0; }
  .tsh-row-name { font-family: var(--shs-font); font-size: 13.5px; font-weight: 500; color: var(--shs-ink-strong);
    letter-spacing: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tsh-row-desc { margin: 0; font-size: 12px; line-height: 1.4; color: var(--shs-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tsh-row-side { display: flex; align-items: center; gap: 6px; flex-shrink: 0; flex-wrap: nowrap; }
  /* Ícone da automação (prédio/unidade do jogo ou traço) — v3.2 */
  .tsh-autoic { width: 34px; height: 34px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 9px; background: var(--shs-bg-inset); color: var(--shs-ink); }
  .tsh-autoic img { width: 18px; height: 18px; }
  .tsh-row--off .tsh-autoic { opacity: .55; filter: grayscale(.6); }
  .tsh-group-ic { color: var(--shs-action) !important; }
  .tsh-seg-btn { display: inline-flex; align-items: center; gap: 6px; }
  .tsh-seg-btn .shs-ic { color: var(--shs-muted); }
  .tsh-seg-btn[aria-checked='true'] .shs-ic { color: var(--shs-action); }
  /* Chips de estado: o ícone volta (dá leitura rápida sem ler o texto). */
  .tsh-statuschip .shs-ic { display: inline-block; }
  .tsh-row-next { width: 72px; white-space: nowrap; text-align: right; font-family: var(--shs-font-mono); font-size: 12.5px;
    color: var(--shs-ink); font-variant-numeric: tabular-nums; flex-shrink: 0; }

  .tsh-statuschip { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border: 0;
    border-radius: 999px; font-size: 12px; font-weight: 500; text-transform: none; letter-spacing: 0; white-space: nowrap; }
  .tsh-statuschip--ok { background: var(--shs-ok-bg); color: var(--shs-ok-ink); }
  .tsh-statuschip--wait { background: var(--shs-bg-inset); color: var(--shs-ink); }
  .tsh-statuschip--err { background: var(--shs-danger-bg); color: #8f1d17; }
  .tsh-statuschip--off { background: var(--shs-bg-inset); color: var(--shs-muted); }
  .tsh-badge { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border: 0;
    border-radius: 999px; background: var(--shs-bg-inset); color: var(--shs-ink); font-size: 11px; font-weight: 500;
    text-transform: none; letter-spacing: 0; }
  .tsh-badge--armed { background: var(--shs-bg-inset); color: var(--shs-ink); font-family: var(--shs-font-mono); }

  /* ---------- Botões ---------- */
  .tsh-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; padding: 0 14px;
    border: 1px solid transparent; border-radius: 9px; font-family: var(--shs-font); font-size: 13px; font-weight: 600;
    text-transform: none; letter-spacing: 0; box-shadow: none; background-image: none; cursor: pointer; white-space: nowrap; }
  .tsh-btn--primary { background: var(--shs-action); color: #fff; }
  .tsh-btn--primary:hover:not(:disabled) { background: var(--shs-action-hover); }
  .tsh-btn--ghost, .tsh-btn--cancel { background: var(--shs-bg-card); color: var(--shs-ink-strong); border-color: var(--shs-border-strong); }
  .tsh-btn--ghost:hover:not(:disabled), .tsh-btn--cancel:hover:not(:disabled) { background: var(--shs-bg-side);
    border-color: var(--shs-border-strong); color: var(--shs-ink-strong); }
  .tsh-btn--danger { background: var(--shs-bg-card); color: var(--shs-danger); border-color: var(--shs-border-strong); }
  .tsh-btn--danger:hover:not(:disabled) { background: var(--shs-danger); color: #fff; border-color: var(--shs-danger); }
  .tsh-btn--sm { min-height: 32px; padding: 0 10px; font-size: 12.5px; border-radius: 8px; }
  .tsh-btn:disabled { opacity: .5; cursor: default; }
  .tsh-btn:focus-visible, .tsh-icbtn:focus-visible, .tsh-runbtn:focus-visible { outline: 2px solid var(--shs-action); outline-offset: 2px; }
  .tsh-icbtn, .tsh-runbtn { width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center;
    padding: 0; border: 0; border-radius: 9px; background: transparent; color: var(--shs-ink); cursor: pointer; box-shadow: none; }
  .tsh-icbtn:hover, .tsh-runbtn:hover:not(:disabled) { background: var(--shs-bg-inset); color: var(--shs-ink-strong); }
  .tsh-runbtn:disabled { opacity: .35; cursor: default; background: transparent; }

  /* ---------- Chave liga/desliga ---------- */
  .tsh-switch { position: relative; display: inline-flex; width: 36px; height: 20px; flex-shrink: 0; cursor: pointer; }
  .tsh-switch input { position: absolute; inset: -8px -4px; opacity: 0; margin: 0; cursor: pointer; z-index: 1; } /* área de clique ≥ 36 px */
  .tsh-switch-track { position: absolute; inset: 0; border-radius: 999px; background: var(--shs-switch-off); border: 0; transition: background .15s ease; }
  .tsh-switch-track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 2px rgba(20,18,14,.25); transition: left .15s ease; }
  .tsh-switch input:checked + .tsh-switch-track { background: var(--shs-action); }
  .tsh-switch input:checked + .tsh-switch-track::after { left: 19px; }
  .tsh-switch input:focus-visible + .tsh-switch-track { outline: 2px solid var(--shs-action); outline-offset: 2px; }

  /* ---------- Diálogos ---------- */
  .tsh-overlay { background: rgba(27,26,23,.42); backdrop-filter: none; }
  .tsh-modal { border: 0; border-radius: 14px; background: var(--shs-bg-card); box-shadow: 0 24px 60px rgba(20,18,14,.3); overflow: hidden; }
  .tsh-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 16px 14px 20px;
    background: var(--shs-bg-card); background-image: none; border-bottom: 1px solid var(--shs-border); color: var(--shs-ink-strong); }
  .tsh-modal-title { display: flex; align-items: center; gap: 10px; font-family: var(--shs-font); font-size: 16px; font-weight: 600;
    letter-spacing: -.01em; text-transform: none; color: var(--shs-ink-strong); }
  .tsh-modal-title .shs-ic { color: var(--shs-muted); }
  .tsh-modal-close { width: 34px; height: 34px; border: 0; border-radius: 9px; background: transparent; color: var(--shs-ink);
    display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
  .tsh-modal-close:hover { background: var(--shs-bg-inset); color: var(--shs-ink-strong); }
  .tsh-modal-body { padding: 18px 20px; background: var(--shs-bg-card); color: var(--shs-ink); font-size: 13px; }
  .tsh-modal-foot { display: flex; align-items: center; gap: 8px; padding: 14px 20px; background: var(--shs-bg-card);
    border-top: 1px solid var(--shs-border); }
  .tsh-foot-left { margin-right: auto; }
  .tsh-confirm-msg { font-size: 13.5px; line-height: 1.5; color: var(--shs-ink-strong); }
  .tsh-section { margin: 0 0 16px; padding: 0; border: 0; background: none; border-radius: 0; }
  .tsh-section + .tsh-section { padding-top: 16px; border-top: 1px solid var(--shs-border); }
  .tsh-section-title { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; padding: 0; border: 0; background: none;
    font-family: var(--shs-font); font-size: 12.5px; font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--shs-ink-strong); }
  .tsh-section-title .shs-ic { color: var(--shs-muted); }
  .tsh-note { display: flex; align-items: flex-start; gap: 10px; margin: 0 0 14px; padding: 10px 14px; border: 0; border-radius: 10px;
    background: var(--shs-bg-side); color: var(--shs-ink); font-size: 12.5px; line-height: 1.45; }
  .tsh-note .shs-ic { color: var(--shs-muted); margin-top: 1px; }
  .tsh-error { margin: 12px 0 0; padding: 10px 14px; border: 0; border-radius: 10px; background: var(--shs-danger-bg); color: #8f1d17; font-weight: 500; }

  /* ---------- Campos ---------- */
  .tsh-field { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 0; margin: 0;
    border: 0; border-bottom: 0; }
  .tsh-field + .tsh-field { border-top: 1px solid var(--shs-bg-inset); }
  .tsh-field--block { flex-direction: column; align-items: stretch; gap: 6px; }
  .tsh-field-side { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .tsh-field-label { font-family: var(--shs-font); font-size: 13px; font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--shs-ink-strong); }
  .tsh-field-help { font-size: 12px; line-height: 1.4; color: var(--shs-muted); }
  .tsh-field-info { color: var(--shs-muted); }
  .tsh-input, .tsh-select, .tsh-textarea { min-height: 36px; padding: 7px 11px; border: 1px solid var(--shs-border-strong);
    border-radius: 9px; background: var(--shs-bg-field); color: var(--shs-ink-strong); font-family: var(--shs-font);
    font-size: 13px; box-shadow: none; box-sizing: border-box; }
  .tsh-input--num, .tsh-input--ms, input[type='number'].tsh-input { font-family: var(--shs-font-mono); font-variant-numeric: tabular-nums; }
  .tsh-input--num { width: 140px; }
  .tsh-textarea { width: 100%; min-height: 80px; line-height: 1.45; resize: vertical; }
  .tsh-input:focus, .tsh-select:focus, .tsh-textarea:focus { outline: 2px solid var(--shs-action); outline-offset: 0; border-color: transparent; }
  .tsh-input--invalid { border-color: var(--shs-danger) !important; background: var(--shs-danger-bg) !important; }

  /* ---------- Grade de tropas: ícone oficial do jogo + campo ---------- */
  .tsh-record-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 8px; }
  .tsh-record-cell { display: flex; flex-direction: column; gap: 4px; padding: 0; border: 0; background: none; }
  .tsh-record-label { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 500; color: var(--shs-ink);
    letter-spacing: 0; text-transform: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tsh-record-label img { width: 18px; height: 18px; flex-shrink: 0; image-rendering: auto; }
  .tsh-record-cell .tsh-input { min-height: 34px; font-family: var(--shs-font-mono); }
  /* Ícone oficial do jogo AO LADO do nome (o layout antigo empilhava). */
  .tsh-unit-cell { align-items: stretch; }
  .tsh-unit-cell .tsh-record-label { flex-direction: row; justify-content: center; align-items: center; gap: 6px; min-height: 24px; cursor: help; }
  .tsh-unit-cell .tsh-record-label img { display: inline-block; width: 18px; height: 18px; }
  .tsh-unit-cell .tsh-input { text-align: center; }

  /* ---------- Central de Comandos: relógio e chips ---------- */
  .tsh-clockbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 0 0 14px; padding: 10px 14px;
    border: 1px solid var(--shs-border); border-radius: 10px; background: var(--shs-bg-side); background-image: none; }
  .tsh-clockbar-now { font-family: var(--shs-font-mono); font-size: 18px; font-weight: 500; color: var(--shs-ink-strong); font-variant-numeric: tabular-nums; }
  .tsh-clockbar-meta { font-size: 12px; color: var(--shs-muted); }
  .tsh-eta { font-family: var(--shs-font-mono); font-variant-numeric: tabular-nums; }
  .tsh-pill { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border: 0; border-radius: 999px;
    background: var(--shs-bg-inset); color: var(--shs-ink); font-size: 12px; font-weight: 500; }
  .tsh-pill--ok { background: var(--shs-ok-bg); color: var(--shs-ok-ink); }
  .tsh-pill--danger { background: var(--shs-danger-bg); color: #8f1d17; }
  .tsh-check-row { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: var(--shs-ink-strong); }
  .tsh-preview, .tsh-preview pre { font-family: var(--shs-font-mono); font-size: 12px; background: var(--shs-bg-side);
    border: 1px solid var(--shs-border); border-radius: 10px; }
  .tsh-preview-summary { display: flex; flex-direction: column; gap: 6px; margin: 0 0 12px; font-size: 13px; }
  .tsh-preview-label { color: var(--shs-muted); }
  .tsh-history > summary { font-size: 12.5px; font-weight: 500; color: var(--shs-muted); }

  /* Dicas (tooltip) dos diálogos: mesma tinta escura do painel. */
  .tsh-tip[data-tip]:hover::after, .tsh-tip[data-tip]:focus-visible::after { background: var(--shs-ink-strong); color: #fff;
    border: 0; border-radius: 8px; font-family: var(--shs-font); font-size: 12px; font-weight: 400; }
`;
