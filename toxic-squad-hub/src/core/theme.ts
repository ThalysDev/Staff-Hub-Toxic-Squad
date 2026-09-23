// Tema ÚNICO do Toxic Squad Hub (Onda D): pergaminho/latão "Nexus".
// Uma só fonte de verdade para as cores/fontes — o shell (Shadow DOM), a aba
// Automações, a Início/Ajuda e as injeções da Suite Vanta nas telas do jogo
// usam as MESMAS variáveis --shs-*. Antes eram 3 sistemas de estilo e ~80
// cores escritas à mão (e fontes diferentes: Verdana × Segoe UI).

export const THEME_TOKENS = {
  // Superfícies
  bg: '#f8f0d4',
  'bg-card': '#fffdf3',
  'bg-inset': '#f4ead0',
  'bg-head': '#efe2ba',
  'bg-side': '#ece0b6',
  'bg-hover': '#f2e6c4',
  'bg-active': '#f7ecd2',
  'bg-field': '#fbf4de',
  // Tinta
  ink: '#5a3a16',
  'ink-strong': '#3c250a',
  muted: '#6f5e40',
  'ink-disabled': '#b3a27d',
  // Bordas
  border: '#e0cda0',
  'border-strong': '#cbb384',
  'border-head': '#d9c48f',
  // Ação
  action: '#6d3c14',
  'action-hover': '#834a1a',
  'action-dark': '#4a2708',
  'action-deep': '#5a3110',
  'accent-ink': '#8a5a1e',
  'switch-off': '#d8cbb0',
  // Latão
  brass: '#b8860b',
  'brass-bright': '#d9a520',
  'brass-soft': '#e8c040',
  // Estados
  danger: '#c04038',
  'danger-bg': '#fceaea',
  ok: '#3f8f43',
  'ok-bg': '#e8f4e2',
  'ok-border': '#b5d4a8',
  'ok-ink': '#2e5b2a',
  'ok-hover': '#357a39',
  info: '#2f66c0',
  'info-bg': '#e2ebfa',
  warn: '#8a6d1f',
  'warn-bg': '#f5ecd0',
  'warn-soft': '#fdf6d8',
} as const;

export type ThemeToken = keyof typeof THEME_TOKENS;

export const THEME_FONTS = {
  font: "Verdana, Geneva, 'DejaVu Sans', sans-serif",
  'font-display': "Georgia, 'Times New Roman', serif",
  'font-mono': "ui-monospace, Consolas, 'Courier New', monospace",
} as const;

/** Declarações `--shs-*` (sem seletor) — para :host, :root ou outro escopo. */
export function themeDeclarations(): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(THEME_TOKENS)) lines.push(`--shs-${name}: ${value};`);
  for (const [name, value] of Object.entries(THEME_FONTS)) lines.push(`--shs-${name}: ${value};`);
  lines.push('--shs-radius: 10px;');
  lines.push('--shs-shadow: 0 14px 40px rgba(40, 24, 6, .38), 0 2px 8px rgba(40, 24, 6, .22);');
  return lines.join('\n      ');
}

/** Hex (minúsculo) → token do tema, para migrar CSS antigo (e testes). */
export function tokenForHex(hex: string): ThemeToken | null {
  const wanted = hex.toLowerCase();
  for (const [name, value] of Object.entries(THEME_TOKENS)) {
    if (value === wanted) return name as ThemeToken;
  }
  return null;
}

const DOC_THEME_ID = 'tsh-theme-vars';

/**
 * Publica as variáveis do tema no documento do JOGO (para as injeções Vanta
 * fora do Shadow DOM). Nomes com prefixo --shs-* — não colidem com o jogo.
 * Idempotente.
 */
export function ensureDocumentTheme(doc: Document = document): void {
  if (doc.getElementById(DOC_THEME_ID) !== null) return;
  const style = doc.createElement('style');
  style.id = DOC_THEME_ID;
  // + alinhamento dos ícones SVG (substitutos dos emojis) nos botões injetados.
  style.textContent = `:root {\n      ${themeDeclarations()}\n    }\n    .shs-ic { vertical-align: -2px; flex-shrink: 0; }`;
  (doc.head ?? doc.documentElement).appendChild(style);
}
