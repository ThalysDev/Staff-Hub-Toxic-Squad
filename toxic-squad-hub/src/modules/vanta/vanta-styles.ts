// Estilos das injeções de página da Suite Vanta (port do bloco GM_addStyle do
// TW Vanta, linhas 435-1428 do original). As regras do painel flutuante antigo
// (#vanta-toggle-btn / #vanta-panel / toggles de módulo) foram REMOVIDAS —
// o painel agora é o shell do Toxic Squad Hub. Idempotente.
// Tema visual: Nexus (pergaminho claro).

export function ensureVantaStyles(): void {
  if (document.getElementById('tsh-vanta-styles') !== null) return;
  const style = document.createElement('style');
  style.id = 'tsh-vanta-styles';
  style.textContent = `
        /* ── Apoio em Massa page UI ── */
        #vanta-apoio-ui {
            margin: 10px 0 16px;
            background: var(--shs-bg-card, #fffdf3);
            border: 1px solid var(--shs-border, #e0cda0);
            border-radius: 10px;
            font-family: var(--shs-font, Verdana, sans-serif);
            overflow: hidden;
        }
        #vanta-apoio-ui * {
            box-sizing: border-box;
        }
        #vanta-apoio-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 9px 14px;
            background: var(--shs-bg-head, #efe2ba);
            border-bottom: 1px solid var(--shs-border, #e0cda0);
        }
        #vanta-apoio-header-title {
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0;
            color: var(--shs-ink-strong, #3c250a);
            text-transform: none;
        }
        #vanta-apoio-body {
            padding: 12px 14px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        /* Mode row */
        .vanta-apoio-row {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .vanta-apoio-label {
            font-size: 12px;
            color: var(--shs-muted, #6f5e40);
            white-space: nowrap;
        }
        .vanta-apoio-label.bright {
            color: var(--shs-ink-strong, #3c250a);
            font-weight: 600;
        }

        /* Inline toggle (reuse same look as panel toggles) */
        .vanta-apoio-switch {
            position: relative;
            width: 36px;
            height: 19px;
            flex-shrink: 0;
        }
        .vanta-apoio-switch input { display: none; }
        .vanta-apoio-slider {
            position: absolute;
            inset: 0;
            border-radius: 20px;
            background: var(--shs-border, #e0cda0);
            border: 1px solid var(--shs-border-strong, #cbb384);
            cursor: pointer;
            transition: background 0.2s, border-color 0.2s;
        }
        .vanta-apoio-slider::before {
            content: '';
            position: absolute;
            width: 13px;
            height: 13px;
            border-radius: 50%;
            top: 2px;
            left: 2px;
            background: var(--shs-border-strong, #cbb384);
            transition: transform 0.2s, background 0.2s;
        }
        .vanta-apoio-switch input:checked + .vanta-apoio-slider {
            background: var(--shs-action, #6d3c14);
            border-color: var(--shs-action-deep, #5a3110);
        }
        .vanta-apoio-switch input:checked + .vanta-apoio-slider::before {
            transform: translateX(17px);
            background: var(--shs-bg-card, #fffdf3);
            box-shadow: 0 0 5px rgba(109,60,20,0.35);
        }

        /* Collapsible time section */
        #vanta-apoio-time-section {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 10px 12px;
            background: var(--shs-bg-head, #efe2ba);
            border: 1px solid var(--shs-border, #e0cda0);
            border-radius: 5px;
            overflow: hidden;
            transition: max-height 0.25s ease, opacity 0.2s;
            max-height: 0;
            opacity: 0;
            padding-top: 0;
            padding-bottom: 0;
        }
        #vanta-apoio-time-section.visible {
            max-height: 80px;
            opacity: 1;
            padding: 10px 12px;
        }

        /* Datetime + Aflição inputs */
        .vanta-apoio-inputs {
            display: flex;
            align-items: flex-end;
            gap: 10px;
            flex-wrap: wrap;
        }
        .vanta-apoio-input-group {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .vanta-apoio-input-group span {
            font-size: 9px;
            color: var(--shs-muted, #6f5e40);
            text-transform: none;
            letter-spacing: 0.8px;
        }
        .vanta-apoio-datetime {
            padding: 5px 8px;
            border-radius: 8px;
            background: var(--shs-bg-field, #fbf4de);
            border: 1px solid var(--shs-border-strong, #cbb384);
            color: var(--shs-ink-strong, #3c250a);
            font-size: 12px;
            font-family: var(--shs-font, Verdana, sans-serif);
            outline: none;
            transition: border-color 0.15s;
            color-scheme: light;
        }
        .vanta-apoio-datetime:focus {
            border-color: var(--shs-accent-ink, #8a5a1e);
        }
        .vanta-apoio-num {
            width: 80px;
            padding: 5px 8px;
            border-radius: 8px;
            background: var(--shs-bg-field, #fbf4de);
            border: 1px solid var(--shs-border-strong, #cbb384);
            color: var(--shs-ink-strong, #3c250a);
            font-size: 13px;
            font-family: var(--shs-font, Verdana, sans-serif);
            text-align: center;
            outline: none;
            transition: border-color 0.15s;
        }
        .vanta-apoio-num:focus {
            border-color: var(--shs-accent-ink, #8a5a1e);
        }
        .vanta-apoio-divider-v {
            width: 1px;
            height: 36px;
            background: var(--shs-border, #e0cda0);
            margin-bottom: 1px;
        }

        /* Group selector */
        .vanta-apoio-select-wrap {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .vanta-apoio-select-label {
            font-size: 9px;
            color: var(--shs-muted, #6f5e40);
            text-transform: none;
            letter-spacing: 0.8px;
        }
        .vanta-apoio-select {
            padding: 5px 8px;
            border-radius: 8px;
            background: var(--shs-bg-field, #fbf4de);
            border: 1px solid var(--shs-border-strong, #cbb384);
            color: var(--shs-ink-strong, #3c250a);
            font-size: 12px;
            font-family: var(--shs-font, Verdana, sans-serif);
            outline: none;
            cursor: pointer;
            transition: border-color 0.15s;
            max-width: 100%;
        }
        .vanta-apoio-select:focus {
            border-color: var(--shs-accent-ink, #8a5a1e);
        }
        .vanta-apoio-select option {
            background: var(--shs-bg-field, #fbf4de);
            color: var(--shs-ink-strong, #3c250a);
        }

        /* Coordinate input */
        .vanta-apoio-coord {
            padding: 5px 7px;
            border-radius: 8px;
            background: var(--shs-bg-field, #fbf4de);
            border: 1px solid var(--shs-border-strong, #cbb384);
            color: var(--shs-ink-strong, #3c250a);
            font-size: 12px;
            font-family: var(--shs-font, Verdana, sans-serif);
            text-align: center;
            outline: none;
            transition: border-color 0.15s;
            letter-spacing: 0.5px;
        }
        .vanta-apoio-coord:focus {
            border-color: var(--shs-accent-ink, #8a5a1e);
        }
        .vanta-apoio-coord.valid {
            border-color: var(--shs-ok, #3f8f43);
            color: var(--shs-ok, #3f8f43);
        }
        .vanta-apoio-coord::placeholder {
            color: var(--shs-ink-disabled, #b3a27d);
        }

        /* Aldeia Atual button */
        #vanta-apoio-use-current {
            padding: 4px 8px;
            border-radius: 8px;
            background: var(--shs-bg-field, #fbf4de);
            border: 1px solid var(--shs-border-strong, #cbb384);
            color: var(--shs-muted, #6f5e40);
            font-size: 10px;
            font-family: var(--shs-font, Verdana, sans-serif);
            cursor: pointer;
            white-space: nowrap;
            transition: background 0.15s, border-color 0.15s, color 0.15s;
        }
        #vanta-apoio-use-current:hover {
            background: var(--shs-bg-head, #efe2ba);
            border-color: var(--shs-action-hover, #834a1a);
            color: var(--shs-action-hover, #834a1a);
        }
        #vanta-apoio-use-current:active {
            background: var(--shs-bg-side, #ece0b6);
        }

        /* Calcular Tropas button */
        #vanta-apoio-calc-btn {
            width: 100%;
            padding: 7px 12px;
            border-radius: 8px;
            background: var(--shs-action, #6d3c14);
            border: 1px solid var(--shs-action-deep, #5a3110);
            color: #fff;
            font-size: 12px;
            font-weight: 600;
            font-family: var(--shs-font, Verdana, sans-serif);
            cursor: pointer;
            transition: background 0.15s, border-color 0.15s, color 0.15s;
            letter-spacing: 0.5px;
        }
        #vanta-apoio-calc-btn:hover {
            background: var(--shs-action-hover, #834a1a);
            border-color: var(--shs-accent-ink, #8a5a1e);
            color: #fff;
        }
        #vanta-apoio-calc-btn:active {
            background: var(--shs-action-deep, #5a3110);
        }

        /* Troop table */
        #vanta-troop-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
            font-family: var(--shs-font, Verdana, sans-serif);
        }
        #vanta-troop-table th,
        #vanta-troop-table td {
            padding: 5px 6px;
            text-align: center;
            border: 1px solid var(--shs-border, #e0cda0);
            color: var(--shs-ink, #5a3a16);
            white-space: nowrap;
        }
        #vanta-troop-table thead th {
            background: var(--shs-bg-head, #efe2ba);
            color: var(--shs-muted, #6f5e40);
            font-weight: 600;
        }
        #vanta-troop-table thead th:last-child {
            color: var(--shs-muted, #6f5e40);
        }
        .vanta-tt-label {
            text-align: left !important;
            color: var(--shs-muted, #6f5e40) !important;
            font-size: 10px;
            text-transform: none;
            letter-spacing: 0.6px;
            white-space: nowrap;
        }
        .vanta-tt-total td { background: var(--shs-bg-card, #fffdf3); color: var(--shs-ink-strong, #3c250a); }
        .vanta-tt-total td:last-child { color: var(--shs-muted, #6f5e40) !important; }
        .vanta-tt-send  td { background: var(--shs-bg-inset, #f4ead0); }
        .vanta-k { color: var(--shs-ink-disabled, #b3a27d); font-size: 10px; }
        .vanta-tt-input {
            width: 52px;
            padding: 3px 4px;
            border-radius: 8px;
            background: var(--shs-bg-field, #fbf4de);
            border: 1px solid var(--shs-border-strong, #cbb384);
            color: var(--shs-ink-strong, #3c250a);
            font-size: 11px;
            font-family: var(--shs-font, Verdana, sans-serif);
            text-align: center;
            outline: none;
        }
        .vanta-tt-input:focus { border-color: var(--shs-accent-ink, #8a5a1e); }
        .vanta-tt-over { color: var(--shs-danger, #c04038) !important; font-weight: 700; border-color: var(--shs-danger, #c04038) !important; }
        .vanta-tt-alloc td { background: var(--shs-ok-bg, #e8f4e2); color: var(--shs-ok-ink, #2e5b2a); font-weight: 600; }
        #vanta-fill-btn {
            width: 100%;
            margin-top: 8px;
            padding: 7px 12px;
            border-radius: 8px;
            background: var(--shs-info, #2f66c0);
            border: 1px solid #27549f;
            color: #fff;
            font-size: 12px;
            font-weight: 600;
            font-family: var(--shs-font, Verdana, sans-serif);
            cursor: pointer;
            transition: background 0.15s, border-color 0.15s, color 0.15s;
            letter-spacing: 0.5px;
        }
        #vanta-fill-btn:hover {
            background: #4473cd;
            border-color: var(--shs-info, #2f66c0);
            color: #fff;
        }
        #vanta-fill-btn:active {
            background: #27549f;
        }
        #vanta-send-btn {
            width: 100%;
            margin-top: 6px;
            padding: 7px 12px;
            border-radius: 8px;
            background: var(--shs-action, #6d3c14);
            border: 1px solid var(--shs-action-deep, #5a3110);
            color: #fff;
            font-size: 12px;
            font-weight: 600;
            font-family: var(--shs-font, Verdana, sans-serif);
            cursor: pointer;
            transition: background 0.15s, border-color 0.15s, color 0.15s;
            letter-spacing: 0.5px;
        }
        #vanta-send-btn:hover {
            background: var(--shs-action-hover, #834a1a);
            border-color: var(--shs-accent-ink, #8a5a1e);
            color: #fff;
        }
        #vanta-send-btn:active {
            background: var(--shs-action-deep, #5a3110);
        }
        #vanta-send-btn:disabled {
            background: var(--shs-bg-side, #ece0b6);
            border-color: var(--shs-border, #e0cda0);
            color: var(--shs-ink-disabled, #b3a27d);
            cursor: not-allowed;
        }

        /* ── Coletor e Alocador widget ── */
        #vanta-coletor-widget {
            position: fixed;
            z-index: 2147483100;
            width: 260px;
            background: var(--shs-bg-card, #fffdf3);
            border: 1px solid var(--shs-border-strong, #cbb384);
            border-radius: 12px;
            box-shadow: 0 12px 40px rgba(60,37,10,0.18);
            font-family: var(--shs-font, Verdana, sans-serif);
            font-size: 12px;
            color: var(--shs-ink, #5a3a16);
            user-select: none;
        }
        #vanta-coletor-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 9px 12px 8px;
            background: var(--shs-bg-head, #efe2ba);
            border-bottom: 1px solid var(--shs-border, #e0cda0);
            border-radius: 12px 12px 0 0;
            cursor: grab;
        }
        #vanta-coletor-header:active { cursor: grabbing; }
        #vanta-coletor-title {
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0;
            color: var(--shs-ink-strong, #3c250a);
            text-transform: none;
        }
        #vanta-coletor-close {
            background: none;
            border: none;
            color: var(--shs-muted, #6f5e40);
            font-size: 16px;
            line-height: 1;
            cursor: pointer;
            padding: 0 2px;
        }
        #vanta-coletor-close:hover { color: var(--shs-danger, #c04038); }
        #vanta-coletor-body {
            padding: 10px 12px 12px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        #vanta-coletor-label {
            font-size: 11px;
            color: var(--shs-accent-ink, #8a5a1e);
            font-weight: 600;
        }
        #vanta-coletor-list {
            width: 100%;
            height: 80px;
            background: var(--shs-bg-field, #fbf4de);
            border: 1px solid var(--shs-border-strong, #cbb384);
            border-radius: 8px;
            color: var(--shs-ink-strong, #3c250a);
            font-size: 11px;
            font-family: monospace;
            resize: vertical;
            padding: 4px 6px;
            box-sizing: border-box;
        }
        #vanta-coletor-list:focus { outline: none; border-color: var(--shs-accent-ink, #8a5a1e); }
        #vanta-coletor-buttons {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
        }
        .vanta-coletor-btn {
            flex: 1 1 auto;
            padding: 5px 8px;
            background: var(--shs-bg-field, #fbf4de);
            border: 1px solid var(--shs-border-strong, #cbb384);
            border-radius: 8px;
            color: var(--shs-ink, #5a3a16);
            font-size: 11px;
            cursor: pointer;
            transition: background 0.12s, border-color 0.12s;
            white-space: nowrap;
        }
        .vanta-coletor-btn:hover {
            background: var(--shs-bg-head, #efe2ba);
            border-color: var(--shs-action-hover, #834a1a);
            color: var(--shs-action-hover, #834a1a);
        }
        .vanta-coletor-btn:active { background: var(--shs-bg-side, #ece0b6); }
        #vanta-coletor-save-row {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        #vanta-coletor-mode-row { display: flex; gap: 4px; }
        #vanta-coletor-novo-row, #vanta-coletor-ok-row { display: flex; gap: 4px; align-items: center; }
        #vanta-coletor-add-row  { display: flex; gap: 4px; }
        #vanta-coletor-group-select {
            flex: 1;
            min-width: 0;
            background: var(--shs-bg-field, #fbf4de);
            border: 1px solid var(--shs-border-strong, #cbb384);
            color: var(--shs-ink-strong, #3c250a);
            border-radius: 8px;
            padding: 3px 6px;
            font-size: 11px;
        }
        #vanta-coletor-name-input {
            flex: 1;
            min-width: 0;
            background: var(--shs-bg-field, #fbf4de);
            border: 1px solid var(--shs-border-strong, #cbb384);
            color: var(--shs-ink-strong, #3c250a);
            border-radius: 8px;
            padding: 3px 6px;
            font-size: 11px;
        }
        #vanta-coletor-name-input:focus { outline: none; border-color: var(--shs-accent-ink, #8a5a1e); }
        #vanta-coletor-groups {
            display: flex;
            flex-direction: column;
            gap: 3px;
        }
        #vanta-coletor-ingame-section {
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-top: 4px;
        }
        #vanta-coletor-groups-title,
        #vanta-coletor-ingame-label {
            font-size: 11px;
            color: var(--shs-accent-ink, #8a5a1e);
            font-weight: 600;
        }
        #vanta-coletor-groups-title {
            margin-top: 4px;
        }
        #vanta-coletor-ingame-row {
            display: flex;
            gap: 4px;
        }
        #vanta-coletor-ingame-select {
            flex: 1;
            min-width: 0;
            background: var(--shs-bg-field, #fbf4de);
            border: 1px solid var(--shs-border-strong, #cbb384);
            color: var(--shs-ink-strong, #3c250a);
            border-radius: 8px;
            padding: 3px 6px;
            font-size: 11px;
        }
        #vanta-coletor-ingame-select:disabled { opacity: 0.5; }
        #vanta-coletor-ingame-progress {
            font-size: 11px;
            padding: 2px 0;
        }
        .vanta-group-item {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
            color: var(--shs-ink, #5a3a16);
            padding: 2px 0;
        }
        .vanta-group-swatch {
            width: 12px;
            height: 12px;
            border-radius: 2px;
            border: 1px solid var(--shs-border-strong, #cbb384);
            cursor: pointer;
            flex-shrink: 0;
        }
        .vanta-group-color-input { display: none; }
        #vanta-coletor-group-color {
            width: 24px;
            height: 22px;
            padding: 1px;
            border: 1px solid var(--shs-border-strong, #cbb384);
            border-radius: 8px;
            background: var(--shs-bg-field, #fbf4de);
            cursor: pointer;
            flex-shrink: 0;
        }
        .vanta-group-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            cursor: pointer;
        }
        .vanta-group-name:hover { color: var(--shs-ink-strong, #3c250a); text-decoration: underline; }
        .vanta-group-count { color: var(--shs-accent-ink, #8a5a1e); font-size: 10px; white-space: nowrap; }
        .vanta-group-name-edit {
            flex: 1;
            min-width: 0;
            background: var(--shs-bg-field, #fbf4de);
            border: 1px solid var(--shs-accent-ink, #8a5a1e);
            color: var(--shs-ink-strong, #3c250a);
            border-radius: 2px;
            padding: 1px 4px;
            font-size: 11px;
            outline: none;
        }
        .vanta-group-edit {
            background: none;
            border: none;
            color: var(--shs-muted, #6f5e40);
            cursor: pointer;
            font-size: 12px;
            padding: 0 2px;
            line-height: 1;
        }
        .vanta-group-edit:hover { color: var(--shs-action-hover, #834a1a); }
        .vanta-group-del {
            background: none;
            border: none;
            color: var(--shs-muted, #6f5e40);
            cursor: pointer;
            font-size: 13px;
            padding: 0 2px;
            line-height: 1;
        }
        .vanta-group-del:hover { color: var(--shs-danger, #c04038); }

        /* ── Blindagem ── */
        #vanta-blindagem-ui {
            margin: 10px 0 16px;
            background: var(--shs-bg-card, #fffdf3);
            border: 1px solid var(--shs-border, #e0cda0);
            border-radius: 10px;
            font-family: var(--shs-font, Verdana, sans-serif);
            overflow: hidden;
        }
        #vanta-blindagem-ui * { box-sizing: border-box; }
        #vanta-blindagem-header {
            display: flex;
            align-items: center;
            padding: 9px 14px;
            background: var(--shs-bg-head, #efe2ba);
            border-bottom: 1px solid var(--shs-border, #e0cda0);
        }
        #vanta-blindagem-header-title {
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0;
            color: var(--shs-accent-ink, #8a5a1e);
            text-transform: none;
        }
        #vanta-blindagem-table-wrap {
            padding: 10px 12px 12px;
            overflow-x: auto;
        }
        #vanta-blindagem-ui table {
            border-collapse: collapse;
            table-layout: fixed;
            min-width: 100%;
            font-size: 11px;
            color: var(--shs-ink, #5a3a16);
        }
        #vanta-blindagem-ui th {
            background: var(--shs-bg-head, #efe2ba) !important;
            border-bottom: 1px solid var(--shs-border, #e0cda0) !important;
            border-top: none !important;
            padding: 5px 3px !important;
            text-align: center !important;
            font-weight: 600;
            color: var(--shs-muted, #6f5e40) !important;
            position: sticky; top: 0; z-index: 1;
        }
        #vanta-blindagem-ui th.vanta-b-player {
            text-align: left !important;
            padding-left: 8px !important;
            min-width: 110px;
        }
        #vanta-blindagem-ui td {
            padding: 4px 3px;
            text-align: center;
            border-bottom: 1px solid var(--shs-border, #e0cda0);
            background: none !important;
        }
        #vanta-blindagem-ui td.vanta-b-player {
            text-align: left;
            padding-left: 8px;
            color: var(--shs-ink, #5a3a16);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        #vanta-blindagem-ui td.vanta-zero { color: var(--shs-ink-disabled, #b3a27d); }
        #vanta-blindagem-ui col.vanta-b-unit { width: 44px; }
        #vanta-blindagem-ui col.vanta-b-pop { width: 72px; }
        #vanta-blindagem-ui .vanta-blindagem-total td {
            font-weight: bold;
            color: var(--shs-ink-strong, #3c250a);
            border-top: 1px solid var(--shs-border-strong, #cbb384);
            border-bottom: none;
        }
        #vanta-blindagem-ui col.vanta-b-acoes { width: 110px; }
        #vanta-blindagem-ui th.vanta-b-acoes,
        #vanta-blindagem-ui td.vanta-b-acoes { text-align: center; }
        .vanta-b-dropdown { position: relative; display: inline-block; }
        .vanta-b-acoes-trigger {
            background: var(--shs-bg-field, #fbf4de); color: var(--shs-ink, #5a3a16);
            border: 1px solid var(--shs-border-strong, #cbb384); border-radius: 8px;
            padding: 3px 8px; font-size: 10px; cursor: pointer; white-space: nowrap;
        }
        .vanta-b-acoes-trigger:hover { border-color: var(--shs-action-hover, #834a1a); color: var(--shs-action-hover, #834a1a); }
        .vanta-b-acoes-trigger:disabled { opacity: 0.35; cursor: default; }
        .vanta-b-dropdown-menu {
            position: fixed; z-index: 9999;
            background: var(--shs-bg-card, #fffdf3); border: 1px solid var(--shs-border-strong, #cbb384); border-radius: 8px;
            min-width: 140px; display: flex; flex-direction: column;
            box-shadow: 0 4px 12px rgba(60,37,10,0.18);
        }
        .vanta-b-dropdown-menu[hidden] { display: none; }
        .vanta-b-devolver-btn, .vanta-b-devolver-parcial-btn, .vanta-b-analise-grupo-btn {
            background: none; color: var(--shs-ink, #5a3a16);
            border: none; border-bottom: 1px solid var(--shs-border, #e0cda0);
            padding: 6px 10px; font-size: 11px; cursor: pointer;
            text-align: left; white-space: nowrap; width: 100%;
        }
        .vanta-b-devolver-btn:last-child, .vanta-b-devolver-parcial-btn:last-child, .vanta-b-analise-grupo-btn:last-child { border-bottom: none; }
        .vanta-b-devolver-btn:hover, .vanta-b-devolver-parcial-btn:hover, .vanta-b-analise-grupo-btn:hover { background: var(--shs-bg-head, #efe2ba); color: var(--shs-action-hover, #834a1a); }
        #vanta-analise-section { margin-top: 8px; border-top: 1px solid var(--shs-border, #e0cda0); }
        #vanta-analise-header { background: var(--shs-bg-head, #efe2ba); padding: 6px 12px; font-size: 11px; font-weight: 700; color: var(--shs-accent-ink, #8a5a1e); text-transform: none; letter-spacing: 0.5px; }
        #vanta-ag-summary { padding: 6px 12px; font-size: 11px; color: var(--shs-muted, #6f5e40); cursor: pointer; display: flex; align-items: center; gap: 6px; }
        #vanta-ag-summary:hover { color: var(--shs-action-hover, #834a1a); }
        #vanta-ag-summary .vanta-ag-arrow { font-size: 9px; transition: transform 0.15s; }
        #vanta-ag-summary.vanta-ag-expanded .vanta-ag-arrow { transform: rotate(90deg); }
        #vanta-ag-summary .vanta-ag-selected-names { color: var(--shs-ink, #5a3a16); }
        #vanta-ag-picker { padding: 8px 12px; display: flex; flex-wrap: wrap; gap: 6px 14px; }
        #vanta-ag-picker label { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--shs-ink, #5a3a16); cursor: pointer; }
        #vanta-ag-picker label:hover { color: var(--shs-action-hover, #834a1a); }
        #vanta-ag-picker input[type="checkbox"] { accent-color: var(--shs-action, #6d3c14); }
        #vanta-ag-status { padding: 4px 12px; font-size: 11px; color: var(--shs-muted, #6f5e40); }
        #vanta-ag-actions { padding: 4px 12px 8px; }
        #vanta-ag-analisar { background: var(--shs-action, #6d3c14); color: #fff; border: 1px solid var(--shs-action-deep, #5a3110); border-radius: 8px; padding: 4px 12px; cursor: pointer; font-size: 11px; }
        #vanta-ag-analisar:disabled { opacity: 0.35; cursor: default; }
        #vanta-ag-results table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 11px; }
        #vanta-ag-results th { background: var(--shs-bg-head, #efe2ba) !important; color: var(--shs-muted, #6f5e40) !important; font-size: 11px !important; font-weight: 600; padding: 5px 3px !important; text-align: center !important; border-bottom: 1px solid var(--shs-border, #e0cda0) !important; }
        #vanta-ag-results td { padding: 4px 3px; text-align: center; color: var(--shs-ink, #5a3a16); border-bottom: 1px solid var(--shs-border, #e0cda0); }
        #vanta-ag-results td.vanta-ag-group-name { text-align: left; padding-left: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
        #vanta-ag-results th.vanta-ag-group-header { text-align: left !important; padding-left: 8px !important; min-width: 110px; }
        #vanta-ag-results tr.vanta-ag-total td { font-weight: bold; border-top: 1px solid var(--shs-border-strong, #cbb384); color: var(--shs-ink-strong, #3c250a); border-bottom: none; }
        #vanta-ag-results tr.vanta-ag-outras td.vanta-ag-group-name { color: var(--shs-muted, #6f5e40); font-style: italic; }
        #vanta-ag-results .vanta-zero { color: var(--shs-ink-disabled, #b3a27d); font-weight: normal; }
        #vanta-ag-results td.vanta-ag-acoes { text-align: center; }
        #vanta-ag-results col.vanta-ag-acoes-col { width: 110px; }
        #vanta-ag-results col.vanta-ag-unit { width: 44px; }
        #vanta-ag-results col.vanta-ag-pop { width: 72px; }
        #vanta-ag-parcial-tr td { background: var(--shs-warn-soft, #fdf6d8) !important; }
        #vanta-ag-parcial-tr td.vanta-ag-parcial-cell { vertical-align: middle; padding: 4px 2px; text-align: center; }
        #vanta-ag-parcial-tr td.vanta-ag-parcial-cell input { width: 54px; background: var(--shs-bg-field, #fbf4de); color: var(--shs-ink-strong, #3c250a); border: 1px solid var(--shs-border-strong, #cbb384); border-radius: 8px; text-align: center; font-size: 11px; padding: 2px 1px; display: block; margin: 0 auto; -moz-appearance: textfield; }
        #vanta-ag-parcial-tr td.vanta-ag-parcial-cell input::-webkit-outer-spin-button, #vanta-ag-parcial-tr td.vanta-ag-parcial-cell input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        #vanta-ag-parcial-tr td.vanta-ag-parcial-cell input.vanta-parcial-over { border-color: var(--shs-danger, #c04038) !important; color: var(--shs-danger, #c04038) !important; }
        .vanta-ag-parcial-max { display: block; font-size: 9px; color: var(--shs-muted, #6f5e40); margin-top: 1px; text-align: center; }
        #vanta-ag-parcial-btns { display: flex; flex-direction: column; gap: 4px; }
        #vanta-ag-preencher-parcial { background: var(--shs-action, #6d3c14); color: #fff; border: 1px solid var(--shs-action-deep, #5a3110); border-radius: 8px; padding: 4px 8px; cursor: pointer; font-size: 11px; }
        #vanta-ag-parcial-cancel { background: var(--shs-danger-bg, #fceaea); color: var(--shs-danger, #c04038); border: 1px solid var(--shs-danger, #c04038); border-radius: 8px; padding: 4px 8px; cursor: pointer; font-size: 11px; }
        #vanta-ag-resumo-row td { color: var(--shs-ok, #3f8f43); font-weight: 600; border-top: 1px solid var(--shs-border-strong, #cbb384); }
        #vanta-ag-resumo-row.vanta-resumo-alocado td:not(.vanta-shortfall):not(.vanta-zero) { color: var(--shs-info, #2f66c0); }
        #vanta-ag-resumo-row td.vanta-zero { color: var(--shs-ink-disabled, #b3a27d); font-weight: normal; }
        #vanta-blindagem-actions {
            padding: 10px 12px;
            text-align: right;
            border-top: 1px solid var(--shs-border-strong, #cbb384);
        }
        #vanta-parcial-tr td { background: var(--shs-warn-soft, #fdf6d8) !important; }
        #vanta-parcial-tr td.vanta-b-player { box-shadow: inset 3px 0 0 var(--shs-action, #6d3c14); }
        #vanta-parcial-tr td.vanta-parcial-cell { vertical-align: middle; padding: 4px 2px; }
        .vanta-parcial-cell { text-align: center; }
        .vanta-parcial-cell img { width: 18px; height: 18px; display: block; margin: 0 auto 2px; }
        .vanta-parcial-cell input { width: 54px; background: var(--shs-bg-field, #fbf4de); color: var(--shs-ink-strong, #3c250a); border: 1px solid var(--shs-border-strong, #cbb384); border-radius: 8px; text-align: center; font-size: 11px; padding: 2px 1px; display: block; margin: 0 auto; -moz-appearance: textfield; }
        .vanta-parcial-cell input::-webkit-outer-spin-button, .vanta-parcial-cell input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        .vanta-parcial-cell input.vanta-parcial-over { border-color: var(--shs-danger, #c04038) !important; color: var(--shs-danger, #c04038) !important; }
        .vanta-parcial-max { display: block; font-size: 9px; color: var(--shs-muted, #6f5e40); margin-top: 1px; text-align: center; }
        #vanta-parcial-btns { display: flex; flex-direction: column; gap: 4px; }
        #vanta-preencher-parcial { background: var(--shs-action, #6d3c14); color: #fff; border: 1px solid var(--shs-action-deep, #5a3110); border-radius: 8px; padding: 4px 8px; cursor: pointer; font-size: 11px; }
        #vanta-parcial-cancel { background: var(--shs-danger-bg, #fceaea); color: var(--shs-danger, #c04038); border: 1px solid var(--shs-danger, #c04038); border-radius: 8px; padding: 4px 8px; cursor: pointer; font-size: 11px; }
        .vanta-shortfall { color: var(--shs-danger, #c04038) !important; font-weight: bold !important; }
        .vanta-parcial-pop-cell { text-align: center; vertical-align: middle; padding: 4px 2px !important; }
        .vanta-parcial-pop-cell input { width: 50px; background: var(--shs-bg-field, #fbf4de); color: var(--shs-ink-strong, #3c250a); border: 1px solid var(--shs-border-strong, #cbb384); border-radius: 8px; text-align: center; font-size: 11px; padding: 2px 1px; display: block; margin: 0 auto; }
        .vanta-parcial-pop-cell span { display: block; font-size: 9px; color: var(--shs-muted, #6f5e40); margin-top: 1px; text-align: center; }
        #vanta-blindagem-ui tr.vanta-proprias-row td.vanta-b-player { box-shadow: inset 3px 0 0 var(--shs-action, #6d3c14); padding-left: 6px; }
        #vanta-blindagem-ui #vanta-blindagem-resumo-row.vanta-resumo-alocado td:not(.vanta-shortfall):not(.vanta-zero) { color: var(--shs-info, #2f66c0); }
        #vanta-blindagem-ui #vanta-blindagem-resumo-row td {
            color: var(--shs-ok, #3f8f43);
            font-weight: 600;
            border-top: 1px solid var(--shs-border-strong, #cbb384);
        }
        #vanta-blindagem-ui #vanta-blindagem-resumo-row td.vanta-zero {
            color: var(--shs-ink-disabled, #b3a27d);
            font-weight: normal;
        }
        #vanta-enviar-de-volta {
            background: var(--shs-action, #6d3c14); color: #fff;
            border: 1px solid var(--shs-action-deep, #5a3110); border-radius: 8px;
            padding: 5px 14px; cursor: pointer; font-size: 12px;
        }
        #vanta-enviar-de-volta:disabled { opacity: 0.35; cursor: default; }

        /* ── Visao Geral de Apoios ────────────────────────────────────── */
        #vanta-apoio-overview {
            margin: 10px 0 16px;
            background: var(--shs-bg-card, #fffdf3);
            border: 1px solid var(--shs-border, #e0cda0);
            border-radius: 10px;
            font-family: var(--shs-font, Verdana, sans-serif);
            overflow: hidden;
        }
        #vanta-apoio-overview * { box-sizing: border-box; }
        #vanta-ao-header {
            display: flex;
            align-items: center;
            padding: 9px 14px;
            background: var(--shs-bg-head, #efe2ba);
            border-bottom: 1px solid var(--shs-border, #e0cda0);
        }
        #vanta-ao-header-title {
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0;
            color: var(--shs-accent-ink, #8a5a1e);
            text-transform: none;
        }
        #vanta-ao-table-wrap {
            padding: 10px 12px 12px;
            overflow-x: auto;
        }
        #vanta-apoio-overview table {
            border-collapse: collapse;
            table-layout: fixed;
            min-width: 100%;
            font-size: 11px;
            color: var(--shs-ink, #5a3a16);
        }
        #vanta-apoio-overview th {
            background: var(--shs-bg-head, #efe2ba) !important;
            border-bottom: 1px solid var(--shs-border, #e0cda0) !important;
            border-top: none !important;
            padding: 5px 3px !important;
            text-align: center !important;
            font-weight: 600;
            color: var(--shs-muted, #6f5e40) !important;
            position: sticky; top: 0; z-index: 1;
        }
        #vanta-apoio-overview th.vanta-ao-name {
            text-align: left !important;
            padding-left: 8px !important;
            min-width: 110px;
        }
        #vanta-apoio-overview td {
            padding: 4px 3px;
            text-align: center;
            border-bottom: 1px solid var(--shs-border, #e0cda0);
            background: none !important;
        }
        #vanta-apoio-overview td.vanta-ao-name {
            text-align: left;
            padding-left: 8px;
            color: var(--shs-ink, #5a3a16);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        #vanta-apoio-overview td.vanta-zero { color: var(--shs-ink-disabled, #b3a27d); }
        #vanta-apoio-overview col.vanta-ao-unit { width: 44px; }
        #vanta-apoio-overview col.vanta-ao-pop { width: 72px; }
        #vanta-apoio-overview col.vanta-ao-acoes { width: 110px; }
        .vanta-ao-tribe-row { cursor: pointer; }
        .vanta-ao-tribe-row td { font-weight: 700; color: var(--shs-action, #6d3c14); }
        .vanta-ao-tribe-row td.vanta-ao-name { box-shadow: inset 3px 0 0 var(--shs-action, #6d3c14); color: var(--shs-action, #6d3c14); }
        .vanta-ao-player-row td { font-weight: 600; }
        .vanta-ao-player-row td.vanta-ao-name { padding-left: 20px !important; }
        .vanta-ao-hidden { display: none !important; }
        .vanta-ao-toggle {
            display: inline-block;
            font-size: 9px;
            margin-right: 5px;
            transition: transform 0.15s;
        }
        .vanta-ao-toggle.open { transform: rotate(90deg); }
        .vanta-ao-total-row td {
            font-weight: bold;
            color: var(--shs-ink-strong, #3c250a);
            border-top: 1px solid var(--shs-border-strong, #cbb384);
            border-bottom: none;
        }
        .vanta-ao-devolver-btn {
            background: var(--shs-bg-field, #fbf4de); color: var(--shs-ink, #5a3a16);
            border: 1px solid var(--shs-border-strong, #cbb384); border-radius: 8px;
            padding: 3px 8px; font-size: 10px; cursor: pointer; white-space: nowrap;
        }
        .vanta-ao-devolver-btn:hover { border-color: var(--shs-action-hover, #834a1a); color: var(--shs-action-hover, #834a1a); }
        .vanta-ao-devolver-btn:disabled { opacity: 0.35; cursor: default; }
        #vanta-ao-group-bar {
            padding: 8px 14px;
            border-bottom: 1px solid var(--shs-border, #e0cda0);
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 11px;
            color: var(--shs-muted, #6f5e40);
        }
        #vanta-ao-group-select {
            background: var(--shs-bg-field, #fbf4de);
            color: var(--shs-ink-strong, #3c250a);
            border: 1px solid var(--shs-border-strong, #cbb384);
            border-radius: 8px;
            padding: 3px 6px;
            font-size: 11px;
            flex: 1;
            max-width: 300px;
        }
        #vanta-ao-group-select option { background: var(--shs-bg-field, #fbf4de); }
        #vanta-ao-gerar-btn {
            background: var(--shs-action, #6d3c14); color: #fff;
            border: 1px solid var(--shs-action-deep, #5a3110); border-radius: 8px;
            padding: 3px 10px; font-size: 11px; cursor: pointer; white-space: nowrap;
        }
        #vanta-ao-gerar-btn:hover { background: var(--shs-action-hover, #834a1a); }
        #vanta-ao-gerar-btn:disabled { opacity: 0.35; cursor: default; }
        #vanta-ao-actions {
            padding: 10px 12px;
            text-align: right;
            border-top: 1px solid var(--shs-border-strong, #cbb384);
        }
        #vanta-ao-enviar {
            background: var(--shs-action, #6d3c14); color: #fff;
            border: 1px solid var(--shs-action-deep, #5a3110); border-radius: 8px;
            padding: 5px 14px; cursor: pointer; font-size: 12px;
        }
        #vanta-ao-enviar:disabled { opacity: 0.35; cursor: default; }
        #vanta-ao-resumo-row td { color: var(--shs-ok, #3f8f43); font-weight: 600; border-top: 1px solid var(--shs-border-strong, #cbb384); }
        #vanta-ao-resumo-row td.vanta-zero { color: var(--shs-ink-disabled, #b3a27d); font-weight: normal; }

        /* ── Etiquetador ─────────────────────────────────────────── */
        #vanta-etiquetador-ui {
            background: var(--shs-bg-card, #fffdf3); border: 1px solid var(--shs-border, #e0cda0); border-radius: 10px;
            font-family: var(--shs-font, Verdana, sans-serif); margin: 10px 0; overflow: hidden;
        }
        #vanta-etiquetador-header {
            background: var(--shs-bg-head, #efe2ba); padding: 6px 10px; display: flex; align-items: center; justify-content: space-between;
        }
        #vanta-etiquetador-header-title {
            color: var(--shs-accent-ink, #8a5a1e); font-weight: 700; font-size: 12px; text-transform: none; letter-spacing: 0;
        }
        #vanta-etiquetador-body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
        #vanta-etiquetador-body label { color: var(--shs-ink, #5a3a16); font-size: 12px; display: flex; align-items: center; gap: 8px; }
        #vanta-etiquetador-interval {
            background: var(--shs-bg-field, #fbf4de); border: 1px solid var(--shs-border-strong, #cbb384); color: var(--shs-ink-strong, #3c250a); border-radius: 8px;
            padding: 3px 6px; font-size: 12px; width: 60px; text-align: center;
        }
        #vanta-etiquetador-toggle {
            position: relative; width: 36px; height: 20px; appearance: none; -webkit-appearance: none;
            background: var(--shs-border, #e0cda0); border-radius: 10px; outline: none; cursor: pointer; transition: background 0.2s;
        }
        #vanta-etiquetador-toggle:checked { background: var(--shs-action, #6d3c14); }
        #vanta-etiquetador-toggle::before {
            content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
            background: #fff; border-radius: 50%; transition: transform 0.2s;
        }
        #vanta-etiquetador-toggle:checked::before { transform: translateX(16px); }
        #vanta-etiquetador-status {
            font-size: 11px; padding: 4px 0; min-height: 16px;
        }

        /* ── Auto Cunhar ─────────────────────────────────────────── */
        #vanta-cunhar-ui {
            background: var(--shs-bg-card, #fffdf3); border: 1px solid var(--shs-border, #e0cda0); border-radius: 10px;
            font-family: var(--shs-font, Verdana, sans-serif); margin: 10px 0; overflow: hidden;
        }
        #vanta-cunhar-header {
            background: var(--shs-bg-head, #efe2ba); padding: 6px 10px; display: flex; align-items: center; justify-content: space-between;
        }
        #vanta-cunhar-header-title {
            color: var(--shs-accent-ink, #8a5a1e); font-weight: 700; font-size: 12px; text-transform: none; letter-spacing: 0;
        }
        #vanta-cunhar-body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
        #vanta-cunhar-body label { color: var(--shs-ink, #5a3a16); font-size: 12px; display: flex; align-items: center; gap: 8px; }
        #vanta-cunhar-interval {
            background: var(--shs-bg-field, #fbf4de); border: 1px solid var(--shs-border-strong, #cbb384); color: var(--shs-ink-strong, #3c250a); border-radius: 8px;
            padding: 3px 6px; font-size: 12px; width: 60px; text-align: center;
        }
        #vanta-cunhar-toggle {
            position: relative; width: 36px; height: 20px; appearance: none; -webkit-appearance: none;
            background: var(--shs-border, #e0cda0); border-radius: 10px; outline: none; cursor: pointer; transition: background 0.2s;
        }
        #vanta-cunhar-toggle:checked { background: var(--shs-action, #6d3c14); }
        #vanta-cunhar-toggle::before {
            content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
            background: #fff; border-radius: 50%; transition: transform 0.2s;
        }
        #vanta-cunhar-toggle:checked::before { transform: translateX(16px); }
        #vanta-cunhar-status {
            font-size: 11px; padding: 4px 0; min-height: 16px;
        }

        /* ── Saúde do Stack ─────────────────────────────────────────────── */
        .vanta-sh-ok { color: var(--shs-ok, #3f8f43); font-weight: bold; }
        .vanta-sh-check { color: var(--shs-info, #2f66c0); font-weight: bold; }
        .vanta-sh-nok { color: var(--shs-danger, #c04038); font-weight: bold; }
        .vanta-sh-loading { color: var(--shs-muted, #6f5e40); font-style: italic; }
        #vanta-stackhealth-settings { margin-top: 4px; }
        #vanta-stackhealth-settings input[type="number"] { width: 60px; }
        #vanta-stackhealth-settings td { padding: 2px 4px; }

        /* ── Renomeador ─────────────────────────────────────────────────── */
        .vanta-tag-row { float: right; }
        .vanta-tag-btn.vanta-tag-pending { opacity: 0.5; pointer-events: none; }
        .vanta-tag-btn.vanta-tag-error { outline: 2px solid var(--shs-danger, #c04038); }

        /* ── Painel de Incomings ────────────────────────────────────────── */
        #vanta-dashboard { margin-bottom: 6px; }
        #vanta-dashboard td a.vanta-dash-filter { cursor: pointer; }
        #vanta-dashboard td a.vanta-dash-filter:hover { text-decoration: underline; }
        #vanta-dashboard .vanta-dash-active td { background-color: #cdad6d !important; }
        .vanta-dash-player-list { max-height: 160px; overflow-y: auto; }
        .vanta-village-tag-btn { padding: 0 3px !important; font-size: 7px !important; line-height: 14px; }
`;
  document.head.appendChild(style);
}
