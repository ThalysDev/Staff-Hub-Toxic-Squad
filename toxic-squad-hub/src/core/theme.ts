// Tema ÚNICO do Toxic Squad Hub — "Instrumento" (v3.2, redesign aprovado no
// Claude Design): painel neutro claro, UM acento verde, âmbar só para cravado
// próximo e vermelho só para pausa/falha. Uma só fonte de verdade — o shell
// (Shadow DOM), Automações, Início/Ajuda e as injeções da Suite Vanta nas
// telas do jogo usam as MESMAS variáveis --shs-*. Os NOMES dos tokens
// seguem os da Onda D (brass = mira, action = acento) para nada quebrar.

export const THEME_TOKENS = {
  // Superfícies
  bg: '#f4f3ef',
  'bg-card': '#ffffff',
  'bg-inset': '#efede7',
  'bg-head': '#ffffff',
  'bg-side': '#f9f8f5',
  'bg-hover': '#f1efea',
  'bg-active': '#ffffff',
  'bg-field': '#ffffff',
  // Tinta
  ink: '#34312c',
  'ink-strong': '#1b1a17',
  muted: '#6b665d',
  'ink-disabled': '#a9a49a',
  // Bordas
  border: '#e5e2db',
  'border-strong': '#d4d0c7',
  'border-head': '#e5e2db',
  // Ação (acento verde)
  action: '#2e6b3e',
  'action-hover': '#255833',
  'action-dark': '#1f4d2c',
  'action-deep': '#1f4d2c',
  'accent-ink': '#2e6b3e',
  'switch-off': '#d4d0c7',
  // Mira (âmbar) — só para cravado próximo
  brass: '#9a6512',
  'brass-bright': '#b7791f',
  'brass-soft': '#f3ddb0',
  // Estados
  danger: '#b3261e',
  'danger-bg': '#fcebe9',
  ok: '#2e6b3e',
  'ok-bg': '#e6efe8',
  'ok-border': '#b9d3bf',
  'ok-ink': '#1f4d2c',
  'ok-hover': '#255833',
  info: '#2f5fa8',
  'info-bg': '#e7eef8',
  warn: '#7a4f0e',
  'warn-bg': '#fbf0dc',
  'warn-soft': '#fdf7ec',
  // Texto SOBRE fundo escuro/ação (significado próprio — nunca por valor).
  'on-dark': '#ffffff',
  'on-action': '#ffffff',
} as const;

export type ThemeToken = keyof typeof THEME_TOKENS;

// Fontes do SISTEMA (sem baixar nada a cada página do jogo): Segoe UI no
// texto, Cascadia/Consolas nos números — horários, coordenadas e ms em mono
// tabular para os dígitos não mudarem de largura.
export const THEME_FONTS = {
  font: "'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', sans-serif",
  'font-display': "'Segoe UI Variable Display', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', sans-serif",
  'font-mono': "'Cascadia Mono', 'Cascadia Code', Consolas, 'SF Mono', ui-monospace, monospace",
} as const;

/** Declarações `--shs-*` (sem seletor) — para :host, :root ou outro escopo. */
export function themeDeclarations(): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(THEME_TOKENS)) lines.push(`--shs-${name}: ${value};`);
  for (const [name, value] of Object.entries(THEME_FONTS)) lines.push(`--shs-${name}: ${value};`);
  lines.push('--shs-radius: 10px;');
  lines.push('--shs-radius-sm: 8px;');
  lines.push('--shs-shadow: 0 24px 60px rgba(20, 18, 14, .18), 0 2px 6px rgba(20, 18, 14, .08);');
  lines.push('--shs-shadow-sm: 0 1px 2px rgba(20, 18, 14, .06);');
  return lines.join('\n      ');
}

/** Hex (minúsculo) → token do tema, para migrar CSS antigo (e testes). */
export function tokenForHex(hex: string): ThemeToken | null {
  const wanted = hex.toLowerCase();
  for (const [name, value] of Object.entries(THEME_TOKENS)) {
    if (name.startsWith('on-')) continue; // aliases de texto: escolhidos à mão, nunca por valor
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
