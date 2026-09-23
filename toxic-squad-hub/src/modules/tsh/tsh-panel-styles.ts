// Estilos da aba Automações (linhas, chips, switch, modais) — tema "Nexus".
// Injetado no Shadow DOM do shell ao lado do <style> do core. Usa os MESMOS
// tokens do shell (com fallback nos valores Nexus para nascer certo mesmo
// antes/sem o re-theme do shell) + constantes exclusivas do Nexus (lavanda,
// divisória tracejada, gradiente do cabeçalho do modal). Prefixo tsh-*.

export function ensureTshPanelStyles(shadow: ShadowRoot): void {
  if (shadow.getElementById('tsh-panel-styles') !== null) return;
  const style = document.createElement('style');
  style.id = 'tsh-panel-styles';
  style.textContent = `
    /* P2 (revisão Nexus): display:inline-flex dos chips sobrescrevia o
       [hidden] do UA — o chip "Armado" preso precisava disto para sumir. */
    [hidden] { display: none !important; }
    .tsh-statuschip--off { background: var(--shs-bg-inset, #f4ead0); color: var(--shs-muted, #6f5e40); }
    /* P2 (auditoria impeccable): todo dado numérico vivo em tabular-nums —
       countdown e contadores não "dançam" a cada tick de 1s. */
    [data-tsh-next],
    .tsh-row-meta,
    .tsh-group-count,
    .tsh-badge--armed,
    [data-tsh-armed],
    [data-tsh-armed-btn] {
      font-variant-numeric: tabular-nums;
    }
    .tsh-btn, .tsh-icbtn, .tsh-runbtn, .tsh-switch, .tsh-headbtn { transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease; }
    /* P3 (auditoria impeccable): feedback de imprensa em TODOS os botões. */
    .tsh-btn:active:not(:disabled),
    .tsh-icbtn:active,
    .tsh-runbtn:active:not(:disabled) { transform: translateY(1px); }
    /* ── Cabeçalho da aba ── */
    .tsh-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    .tsh-head-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 16px;
      font-weight: 700;
      color: var(--shs-ink-strong, #3c250a);
    }
    .tsh-head-title .shs-ic { color: var(--shs-action, #6d3c14); flex: none; }
    .tsh-head-pills { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .tsh-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 10px;
      border-radius: 999px;
      background: var(--shs-bg-card, #fffdf3);
      border: 1px solid var(--shs-border-strong, #cbb384);
      color: var(--shs-ink, #5a3a16);
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    }
    .tsh-pill .shs-ic { flex: none; }
    .tsh-pill--ok {
      background: var(--shs-ok-bg, #e8f4e2);
      border-color: transparent;
      color: var(--shs-ok, #3f8f43);
    }
    .tsh-pill--danger {
      background: var(--shs-danger-bg, #fceaea);
      border-color: transparent;
      color: var(--shs-danger, #c04038);
    }
    .tsh-head-desc {
      font-size: 12px;
      color: var(--shs-muted, #6f5e40);
      line-height: 1.45;
      margin-top: 6px;
    }

    /* ── Grupo ── */
    .tsh-group-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: var(--shs-muted, #6f5e40);
      margin: 14px 0 2px;
    }
    .tsh-group-title .shs-ic { flex: none; }
    .tsh-group-title--on { color: var(--shs-action, #6d3c14); }
    .tsh-group-count {
      font-size: 10px;
      font-weight: 600;
      line-height: 1;
      padding: 3px 7px;
      border-radius: 999px;
      background: var(--shs-bg-inset, #f4ead0);
      color: var(--shs-muted, #6f5e40);
    }
    .tsh-group-count--on {
      background: var(--shs-ok-bg, #e8f4e2);
      color: var(--shs-ok, #3f8f43);
    }

    /* ── Linha de automação (Nexus) ── */
    .tsh-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      padding: 12px 4px;
    }
    .tsh-row + .tsh-row { border-top: 1px dashed #d9c48f; }
    /* P2 (auditoria impeccable): OFF por COR DE TEXTO dedicada (paridade com a
       esteira irmã) — sem opacity, que apagava também bordas/ícones de chip. */
    .tsh-row--off .tsh-row-name,
    .tsh-row--off .tsh-row-desc { color: #b3a27d; }
    .tsh-row--off .tsh-ic-box { color: #c9b998; }
    .tsh-row-main {
      flex: 1;
      min-width: 220px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .tsh-row-titleline {
      display: flex;
      align-items: center;
      gap: 7px;
      flex-wrap: wrap;
    }
    .tsh-ic-box {
      width: 30px;
      height: 30px;
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      background: var(--shs-bg-inset, #f4ead0);
      color: var(--shs-muted, #6f5e40);
    }
    .tsh-ic-box--eco { color: #b8860b; }
    .tsh-ic-box--prod { color: var(--shs-action, #6d3c14); }
    .tsh-ic-box--plan { color: var(--shs-info, #2f66c0); }
    .tsh-row-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--shs-ink-strong, #3c250a);
    }
    .tsh-row-desc {
      font-size: 11.5px;
      color: var(--shs-muted, #6f5e40);
      line-height: 1.4;
    }
    .tsh-row-meta {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      font-size: 10.5px;
      color: var(--shs-muted, #6f5e40);
    }
    .tsh-row-side {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
      flex: none;
    }

    /* ── Status ── */
    .tsh-statuschip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 600;
      line-height: 1.2;
      white-space: nowrap;
      background: var(--shs-bg-inset, #f4ead0);
      color: var(--shs-muted, #6f5e40);
    }
    .tsh-statuschip .shs-ic { flex: none; }
    .tsh-statuschip--ok { background: var(--shs-ok-bg, #e8f4e2); color: var(--shs-ok, #3f8f43); }
    .tsh-statuschip--wait { background: var(--shs-info-bg, #e2ebfa); color: var(--shs-info, #2f66c0); }
    .tsh-statuschip--err { background: var(--shs-danger-bg, #fceaea); color: var(--shs-danger, #c04038); }
    .tsh-status-line {
      display: flex;
      align-items: baseline;
      gap: 8px;
      min-width: 0;
      font-size: 11px;
      color: var(--shs-ink, #5a3a16);
    }
    /* Painel: mensagem longa = 1 linha truncada (inteiro no title). */
    .tsh-status-line .tsh-status-msg {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tsh-status-when { color: var(--shs-muted, #6f5e40); font-size: 10px; white-space: nowrap; }
    /* Comandos (modal): status inline simples com quebra. */
    .tsh-status-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      font-size: 11px;
      color: var(--shs-ink, #5a3a16);
      background: var(--shs-bg-inset, #f4ead0);
      border-radius: 8px;
      padding: 6px 9px;
      min-height: 26px;
    }
    .tsh-status-row .tsh-status-msg { flex: 1; min-width: 0; overflow-wrap: anywhere; }

    /* ── Badges/chips mini ── */
    .tsh-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 600;
      line-height: 1;
      padding: 3px 7px;
      border-radius: 999px;
      color: var(--shs-muted, #6f5e40);
      background: var(--shs-bg-inset, #f4ead0);
      white-space: nowrap;
    }
    .tsh-badge .shs-ic { flex: none; }
    .tsh-badge--muta { color: var(--shs-danger, #c04038); background: var(--shs-danger-bg, #fceaea); }
    .tsh-badge--previa { color: var(--shs-muted, #6f5e40); background: var(--shs-bg-inset, #f4ead0); }
    .tsh-badge--on { color: var(--shs-ok, #3f8f43); background: var(--shs-ok-bg, #e8f4e2); }
    .tsh-badge--armed { color: var(--shs-danger, #c04038); background: var(--shs-danger-bg, #fceaea); }

    /* ── Botões (pill Nexus, ícone 12–13px antes do texto) ── */
    .tsh-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
    }
    .tsh-btn {
      font-family: var(--shs-font, Verdana, sans-serif);
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.2;
      padding: 6px 12px;
      border-radius: 8px;
      border: 1px solid var(--shs-border-strong, #cbb384);
      background: var(--shs-bg-card, #fffdf3);
      color: var(--shs-ink, #5a3a16);
      cursor: pointer;
      white-space: nowrap;
    }
    .tsh-btn .shs-ic { flex: none; }
    .tsh-btn:hover:not(:disabled) {
      border-color: var(--shs-brass, #b8860b);
      color: var(--shs-action, #6d3c14);
    }
    .tsh-btn:focus-visible { outline: 2px solid var(--shs-brass, #b8860b); outline-offset: 1px; }
    .tsh-btn:disabled { opacity: 0.5; cursor: default; }
    .tsh-btn--primary {
      background: var(--shs-action, #6d3c14);
      border-color: var(--shs-action, #6d3c14);
      color: #fff;
    }
    .tsh-btn--primary:hover:not(:disabled) {
      background: var(--shs-action-hover, #5d3211);
      border-color: var(--shs-action-hover, #5d3211);
      color: #fff;
    }
    .tsh-btn--danger {
      background: var(--shs-danger-bg, #fceaea);
      border-color: transparent;
      color: var(--shs-danger, #c04038);
    }
    .tsh-btn--danger:hover:not(:disabled) { background: #f9dcdc; color: var(--shs-danger, #c04038); }
    .tsh-btn--ghost { background: transparent; }
    .tsh-btn--cancel {
      background: #e5d5a8;
      border-color: transparent;
      color: var(--shs-ink, #5a3a16);
    }
    .tsh-btn--cancel:hover:not(:disabled) { background: #ddc98f; color: var(--shs-ink-strong, #3c250a); }
    .tsh-foot-left { margin-right: auto; }
    .tsh-icbtn {
      width: 28px;
      height: 28px;
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: var(--shs-ink, #5a3a16);
      cursor: pointer;
    }
    .tsh-icbtn:hover { background: var(--shs-bg-inset, #f4ead0); color: var(--shs-ink-strong, #3c250a); }
    .tsh-icbtn:focus-visible { outline: 2px solid var(--shs-brass, #b8860b); outline-offset: 1px; }
    .tsh-runbtn {
      width: 28px;
      height: 28px;
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: var(--shs-ok, #3f8f43);
      color: #fff;
      cursor: pointer;
    }
    .tsh-runbtn .shs-ic { margin-left: 1px; }
    .tsh-runbtn:hover:not(:disabled) { background: #347a38; }
    .tsh-runbtn:focus-visible { outline: 2px solid var(--shs-brass, #b8860b); outline-offset: 1px; }
    .tsh-runbtn:disabled { background: #d8cbb0; cursor: default; }

    /* ── Switch iOS 36×20 ── */
    .tsh-switch {
      position: relative;
      width: 36px;
      height: 20px;
      flex: none;
      display: inline-block;
      cursor: pointer;
    }
    .tsh-switch input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; }
    .tsh-switch-track {
      position: absolute;
      inset: 0;
      border-radius: 999px;
      background: #d8cbb0;
      transition: background 0.15s ease;
      pointer-events: none;
    }
    .tsh-switch-track::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 2px rgba(60, 37, 10, 0.35);
      transition: transform 0.15s ease;
    }
    .tsh-switch input:checked + .tsh-switch-track { background: var(--shs-action, #6d3c14); }
    .tsh-switch input:checked + .tsh-switch-track::after { transform: translateX(16px); }
    .tsh-switch input:focus-visible + .tsh-switch-track {
      outline: 2px solid var(--shs-brass, #b8860b);
      outline-offset: 2px;
    }
    .tsh-check-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--shs-ink, #5a3a16); }
    .tsh-check-row input { accent-color: var(--shs-action, #6d3c14); }

    /* ── Cartão (lista de comandos no modal) ── */
    .tsh-card {
      background: var(--shs-bg-card, #fffdf3);
      border: 1px solid var(--shs-border, #e0cda0);
      border-radius: 10px;
      padding: 10px 12px;
      margin-bottom: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    /* Mesma cor de texto dedicada do .tsh-row--off (sem opacity). */
    .tsh-card--off .tsh-card-title,
    .tsh-card--off .tsh-card-desc { color: #b3a27d; }
    .tsh-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .tsh-card-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--shs-ink-strong, #3c250a);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tsh-card-desc { font-size: 11.5px; color: var(--shs-muted, #6f5e40); line-height: 1.4; }
    .tsh-meta-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      font-size: 11px;
      color: var(--shs-muted, #6f5e40);
    }

    /* ── Modal Nexus ── */
    .tsh-overlay {
      position: fixed;
      inset: 0;
      background: rgba(40, 24, 8, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2147483000;
      /* P3 (auditoria impeccable): único momento de entrada — fade do overlay. */
      animation: tsh-overlay-in 120ms ease-out;
    }
    @keyframes tsh-overlay-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .tsh-modal {
      width: min(720px, calc(100vw - 32px));
      max-height: min(82vh, 780px);
      display: flex;
      flex-direction: column;
      background: var(--shs-bg-card, #fffdf3);
      border: 1px solid var(--shs-border-strong, #cbb384);
      border-radius: 12px;
      box-shadow: 0 24px 70px rgba(30, 18, 4, 0.4);
      overflow: hidden;
      /* P3: entrada do modal (scale .98→1 + fade) — nada mais anima. */
      animation: tsh-modal-in 140ms ease-out;
    }
    @keyframes tsh-modal-in {
      from { opacity: 0; transform: scale(0.98); }
      to { opacity: 1; transform: scale(1); }
    }
    .tsh-modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 16px;
      background: linear-gradient(90deg, #f2e2b4, #e9d7a4);
      border-bottom: 1px solid #d9c48f;
    }
    .tsh-modal-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: #4a3010;
    }
    .tsh-modal-title .shs-ic { flex: none; }
    .tsh-modal-close {
      width: 28px;
      height: 28px;
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: var(--shs-ink, #5a3a16);
      cursor: pointer;
    }
    .tsh-modal-close:hover { background: #e5d5a8; color: var(--shs-ink-strong, #3c250a); }
    .tsh-modal-close:focus-visible { outline: 2px solid var(--shs-brass, #b8860b); outline-offset: 1px; }
    .tsh-modal-body {
      padding: 14px 16px;
      overflow-y: auto;
      background: var(--shs-bg-card, #fffdf3);
    }
    .tsh-modal-foot {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid var(--shs-border, #e0cda0);
      background: var(--shs-bg-inset, #f4ead0);
    }
    .tsh-note {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      background: #fdf6d8;
      border: 1px solid #e8d588;
      border-radius: 8px;
      padding: 8px 10px;
      margin: 0 0 12px;
      font-size: 11.5px;
      line-height: 1.4;
      color: #6b5518;
    }
    .tsh-note .shs-ic { flex: none; margin-top: 1px; }
    .tsh-note + .tsh-section { margin-top: 0; }

    /* ── Seções-caixa ──
       P3 (auditoria impeccable): fundo INSET — dentro do modal (bg-card) a
       seção deixava de ser "card dentro de card"; inputs seguem #fbf4de. */
    .tsh-section {
      background: var(--shs-bg-inset, #f4ead0);
      border: 1px solid var(--shs-border, #e0cda0);
      border-radius: 10px;
      padding: 12px;
      margin: 12px 0;
    }
    .tsh-modal-body > .tsh-section:first-child { margin-top: 0; }
    .tsh-modal-body > .tsh-section:last-child { margin-bottom: 0; }
    .tsh-section-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: var(--shs-muted, #6f5e40);
      margin: 0 0 10px;
    }
    .tsh-section-title .shs-ic { flex: none; }

    /* ── Campos (label à esquerda + controle à direita) ── */
    .tsh-field {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 5px 0;
    }
    .tsh-field--block { display: block; }
    .tsh-field--block .tsh-field-side { margin-bottom: 5px; }
    .tsh-field-side { min-width: 0; }
    .tsh-field-label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      font-weight: 600;
      color: var(--shs-ink, #5a3a16);
    }
    .tsh-field-info {
      display: inline-flex;
      color: var(--shs-muted, #6f5e40);
      cursor: help;
    }
    .tsh-field-help {
      font-size: 10.5px;
      color: var(--shs-muted, #6f5e40);
      margin-top: 3px;
      line-height: 1.35;
    }
    .tsh-input, .tsh-select, .tsh-textarea {
      box-sizing: border-box;
      width: 100%;
      font-family: var(--shs-font, Verdana, sans-serif);
      font-size: 12px;
      color: var(--shs-ink-strong, #3c250a);
      background: #fbf4de;
      border: 1px solid var(--shs-border-strong, #cbb384);
      border-radius: 8px;
      padding: 6px 9px;
      outline: none;
    }
    .tsh-input:focus, .tsh-select:focus, .tsh-textarea:focus { border-color: var(--shs-brass, #b8860b); }
    .tsh-input--num { width: 110px; flex: none; text-align: right; }
    .tsh-textarea { min-height: 84px; resize: vertical; font-family: var(--shs-font-mono, monospace); }
    .tsh-record-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
      gap: 6px 8px;
      margin-top: 4px;
    }
    .tsh-record-cell {
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: #fbf4de;
      border: 1px solid var(--shs-border-strong, #cbb384);
      border-radius: 8px;
      padding: 7px 8px;
    }
    .tsh-record-cell .tsh-input { padding: 4px 7px; text-align: right; }
    .tsh-record-label {
      font-size: 10px;
      color: var(--shs-muted, #6f5e40);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* Célula de unidade: ícone do jogo acima do rótulo (image-rendering padrão). */
    .tsh-unit-cell { align-items: center; }
    .tsh-unit-cell .tsh-record-label {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      text-align: center;
    }
    .tsh-unit-cell .tsh-record-label img { display: block; width: 18px; height: 18px; }
    .tsh-error {
      margin: 10px 0 0;
      font-size: 11px;
      color: var(--shs-danger, #c04038);
      background: var(--shs-danger-bg, #fceaea);
      border: 1px solid var(--shs-danger, #c04038);
      border-radius: 8px;
      padding: 7px 10px;
    }

    /* ── Tooltips (CSS puro via data-tip, mesma estética do shell) ──
       Escopados na classe .tsh-tip para NÃO re-estilizar os tooltips do shell
       (mesmo shadow root — o [data-tip] do shell também casa nos elementos
       tsh, então toda a geometria é reafirmada nos estados :hover/
       :focus-visible com especificidade maior que a regra do shell). Padrão:
       acima do elemento; variantes .tsh-tip--below (rodapé/últimas linhas) e
       .tsh-tip--right (ⓘ de help, à direita para não cobrir o input). */
    .tsh-tip { position: relative; }
    .tsh-tip::after,
    .tsh-tip:hover::after,
    .tsh-tip:focus-visible::after {
      content: attr(data-tip);
      position: absolute;
      bottom: calc(100% + 6px);
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483600;
      background: var(--shs-ink-strong, #3c250a);
      color: #f5ecd0;
      border: 1px solid var(--shs-brass, #b8860b);
      padding: 5px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 400;
      font-family: var(--shs-font, Verdana, sans-serif);
      line-height: 1.35;
      white-space: normal;
      width: max-content;
      max-width: min(260px, 90vw);
      text-align: center;
      pointer-events: none;
      box-shadow: 0 3px 10px rgba(40, 24, 6, 0.35);
      opacity: 0;
      transition: opacity 0.12s ease;
    }
    .tsh-tip::before,
    .tsh-tip:hover::before,
    .tsh-tip:focus-visible::before {
      content: '';
      position: absolute;
      bottom: calc(100% + 1px);
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483600;
      border: 5px solid transparent;
      border-top-color: var(--shs-ink-strong, #3c250a);
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.12s ease;
    }
    .tsh-tip:hover::after,
    .tsh-tip:focus-visible::after { opacity: 1; transition-delay: 0.35s; }
    .tsh-tip:hover::before,
    .tsh-tip:focus-visible::before { opacity: 1; transition-delay: 0.35s; }
    /* Variante abaixo (elementos no rodapé do modal / últimas linhas). */
    .tsh-tip--below::after,
    .tsh-tip--below:hover::after,
    .tsh-tip--below:focus-visible::after { bottom: auto; top: calc(100% + 6px); }
    .tsh-tip--below::before,
    .tsh-tip--below:hover::before,
    .tsh-tip--below:focus-visible::before {
      bottom: auto;
      top: calc(100% + 1px);
      border-top-color: transparent;
      border-bottom-color: var(--shs-ink-strong, #3c250a);
    }
    /* Rodapé do modal: tooltip abaixo do botão (regra pedida — hoje nenhum
       botão do rodapé carrega data-tip; botões com texto dispensam tooltip). */
    .tsh-modal-foot .tsh-tip::after,
    .tsh-modal-foot .tsh-tip:hover::after,
    .tsh-modal-foot .tsh-tip:focus-visible::after { bottom: auto; top: calc(100% + 6px); }
    .tsh-modal-foot .tsh-tip::before,
    .tsh-modal-foot .tsh-tip:hover::before,
    .tsh-modal-foot .tsh-tip:focus-visible::before {
      bottom: auto;
      top: calc(100% + 1px);
      border-top-color: transparent;
      border-bottom-color: var(--shs-ink-strong, #3c250a);
    }
    /* Variante à direita (ⓘ de help — não cobre o input ao lado). */
    .tsh-tip--right::after,
    .tsh-tip--right:hover::after,
    .tsh-tip--right:focus-visible::after {
      bottom: auto;
      top: -4px;
      left: calc(100% + 8px);
      transform: none;
      text-align: left;
    }
    .tsh-tip--right::before,
    .tsh-tip--right:hover::before,
    .tsh-tip--right:focus-visible::before {
      bottom: auto;
      top: 0;
      left: calc(100% + 3px);
      transform: none;
      border-top-color: transparent;
      border-left-color: var(--shs-ink-strong, #3c250a);
    }

    /* ── Prévia (planos/relatórios) ── */
    /* P3 (auditoria impeccable): resumo legível ANTES do JSON cru. */
    .tsh-preview-summary {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin: 0 0 10px;
      font-size: 12px;
      line-height: 1.45;
      color: var(--shs-ink, #5a3a16);
    }
    .tsh-preview-label { color: var(--shs-muted, #6f5e40); font-weight: 600; }
    .tsh-preview-details > summary {
      cursor: pointer;
      font-size: 11px;
      color: var(--shs-muted, #6f5e40);
      margin-bottom: 6px;
      user-select: none;
    }
    .tsh-preview-details > summary:hover { color: var(--shs-ink, #5a3a16); }
    .tsh-preview {
      background: var(--shs-bg-inset, #f4ead0);
      border: 1px solid var(--shs-border, #e0cda0);
      border-radius: 8px;
      padding: 8px 10px;
      max-height: 320px;
      overflow: auto;
    }
    .tsh-preview pre {
      margin: 0;
      font-family: var(--shs-font-mono, monospace);
      font-size: 10.5px;
      line-height: 1.45;
      color: var(--shs-ink, #5a3a16);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    /* ── Diálogo de confirmação (tshConfirm — substitui window.confirm) ── */
    .tsh-confirm-msg {
      font-size: 12.5px;
      line-height: 1.5;
      color: var(--shs-ink, #5a3a16);
      overflow-wrap: anywhere;
    }

    /* ── Onda A: relógio de precisão, contagem e ms ── */
    .tsh-clockbar {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      margin: 0 0 12px; padding: 7px 10px; border-radius: 8px;
      background: var(--shs-bg-inset, #f4ead0); border: 1px solid var(--shs-border, #e0cda0);
      font-size: 11.5px; color: var(--shs-ink, #5a3a16);
    }
    .tsh-clockbar[data-quality='ok'] { border-color: var(--shs-ok, #3f8f43); }
    .tsh-clockbar[data-quality='warn'] { border-color: var(--shs-warn, #8a6d1f); }
    .tsh-clockbar[data-quality='bad'] { border-color: var(--shs-danger, #c04038); }
    .tsh-clockbar-now {
      font-family: var(--shs-font-mono, ui-monospace, Consolas, monospace);
      font-weight: 700; color: var(--shs-ink-strong, #3c250a); font-variant-numeric: tabular-nums;
    }
    .tsh-clockbar-meta { color: var(--shs-muted, #6f5e40); flex: 1; min-width: 160px; }
    .tsh-eta {
      font-family: var(--shs-font-mono, ui-monospace, Consolas, monospace);
      font-size: 11px; font-weight: 600; color: var(--shs-info, #2f66c0);
      font-variant-numeric: tabular-nums; white-space: nowrap;
    }
    .tsh-input--ms { width: 72px !important; flex: none; }
    .tsh-ms-suffix { font-size: 11px; color: var(--shs-muted, #6f5e40); }
    .tsh-btn--sm { padding: 3px 8px; font-size: 11px; }
  `;
  shadow.appendChild(style);
}
