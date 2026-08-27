// Tema do app: única fonte da verdade para escolha/apply, compartilhada entre
// App (estado) e Configurações (toggle). A escolha vive em localStorage
// ('shs-theme' — o index.html lê ANTES do CSS para boot sem flash) e o tema
// efetivo vai no data-theme do <html> (tokens.css + theme-dark.css).

export type ThemeChoice = 'system' | 'claro' | 'escuro';

export const THEME_STORAGE_KEY = 'shs-theme';
/** Evento disparado no window quando a escolha muda (detail = nova escolha). */
export const THEME_EVENT = 'shs-theme-change';

export function currentThemeChoice(): ThemeChoice {
  // ?theme=claro|escuro pina o tema na sessão (deep link/QA visual) — vence o salvo.
  const pinned = new URLSearchParams(window.location.search).get('theme');
  if (pinned === 'claro' || pinned === 'escuro') return pinned;
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'claro' || stored === 'escuro' ? stored : 'system';
}

export function resolveTheme(choice: ThemeChoice): 'claro' | 'escuro' {
  if (choice !== 'system') return choice;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro';
}

export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = resolveTheme(choice);
  window.localStorage.setItem(THEME_STORAGE_KEY, choice);
}

/** Troca a escolha, aplica e avisa os ouvintes (App sincroniza o estado). */
export function setThemeChoice(choice: ThemeChoice): void {
  applyTheme(choice);
  window.dispatchEvent(new CustomEvent<ThemeChoice>(THEME_EVENT, { detail: choice }));
}
