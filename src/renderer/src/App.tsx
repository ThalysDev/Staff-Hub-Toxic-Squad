import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Camera, Flame, History, LayoutDashboard, LogIn, Settings2 } from 'lucide-react';
import TitleBar from './components/TitleBar';
import Sidebar, { type SidebarGroup, type SidebarItem } from './components/Sidebar';
import CommandPalette, { type CommandItem } from './components/CommandPalette';
import Sg1Page from './pages/sg1/Sg1Page';
import Sg2Page from './pages/sg2/Sg2Page';
import Sg3Page from './pages/sg3/Sg3Page';
import Sg4Page from './pages/sg4/Sg4Page';
import Sg5Page from './pages/sg5/Sg5Page';
import Sg6Page from './pages/sg6/Sg6Page';
import Sg7Page from './pages/sg7/Sg7Page';
import WarRoomPage from './pages/war/WarRoomPage';
import { MODULES, type ModuleId, type PageId, type SystemPageId, type WarPageId } from './modules';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { applyTheme, currentThemeChoice, resolveTheme, setThemeChoice, THEME_EVENT, type ThemeChoice } from './theme';

// Code-split: páginas de sistema são switch-rendered (montam/desmontam) —
// lazy reduz o bundle inicial (as SG ficam montadas por design U1, eager).
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const SessionPage = lazy(() => import('./pages/SessionPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const JournalPage = lazy(() => import('./pages/JournalPage'));
const CapturesPage = lazy(() => import('./pages/CapturesPage'));

const SYSTEM_ITEMS: readonly SidebarItem[] = [
  { id: 'dashboard', label: 'Início', icon: LayoutDashboard },
  { id: 'sessao', label: 'Sessão', icon: LogIn },
  { id: 'config', label: 'Configurações', icon: Settings2 },
  { id: 'journal', label: 'Journal', icon: History },
  { id: 'captures', label: 'Capturas de tela', icon: Camera },
];

const NAV_GROUPS: readonly SidebarGroup[] = [
  {
    label: 'Operações',
    items: [
      ...MODULES.map((module) => ({ id: module.id as PageId, label: module.navLabel, icon: module.icon })),
      { id: 'guerra' as PageId, label: 'Sala de Guerra', icon: Flame },
    ],
  },
  { label: 'Sistema', items: SYSTEM_ITEMS },
];

/** Páginas dos módulos SG: montam na 1ª visita e NUNCA desmontam — o estado
 * da OP (alvos, distribuição, conferência) sobrevive à navegação. */
const SG_PAGES: Readonly<Record<ModuleId, () => ReactElement>> = {
  sg1: Sg1Page,
  sg2: Sg2Page,
  sg3: Sg3Page,
  sg4: Sg4Page,
  sg5: Sg5Page,
  sg6: Sg6Page,
  sg7: Sg7Page,
};

const isModulePage = (page: PageId): page is ModuleId | WarPageId =>
  MODULES.some((module) => module.id === page) || page === 'guerra';

function renderSystemPage(page: SystemPageId, onNavigate: (page: PageId) => void) {
  switch (page) {
    case 'dashboard':
      return <DashboardPage onNavigate={onNavigate} />;
    case 'sessao':
      return <SessionPage />;
    case 'config':
      return <SettingsPage />;
    case 'journal':
      return <JournalPage />;
    case 'captures':
      return <CapturesPage />;
  }
}

const INITIAL_PAGE = ((): PageId => {
  const param = new URLSearchParams(window.location.search).get("page");
  const valid =
    MODULES.some((m) => m.id === param) ||
    param === 'guerra' ||
    ["dashboard", "sessao", "config", "journal", "captures"].includes(param ?? "");
  return valid && param !== null ? (param as PageId) : "dashboard";
})();

export default function App() {
  const [page, setPage] = useState<PageId>(INITIAL_PAGE);
  const [mountedModules, setMountedModules] = useState<ReadonlySet<ModuleId | WarPageId>>(
    () => (isModulePage(INITIAL_PAGE) ? new Set([INITIAL_PAGE]) : new Set<ModuleId | WarPageId>()),
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [themeChoice, setThemeChoiceState] = useState<ThemeChoice>(currentThemeChoice);

  const navigate = (next: PageId): void => {
    if (isModulePage(next)) {
      setMountedModules((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    }
    setPage(next);
  };

  // Tema: aplica na troca, segue o sistema em 'system' e sincroniza quando
  // outra tela (Configurações/paleta) muda a escolha via theme.ts.
  useEffect(() => {
    applyTheme(themeChoice);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => applyTheme(themeChoice);
    media.addEventListener('change', onChange);
    const onThemeEvent = (event: Event): void => {
      const detail = (event as CustomEvent<ThemeChoice>).detail;
      if (detail !== undefined) setThemeChoiceState(detail);
    };
    window.addEventListener(THEME_EVENT, onThemeEvent);
    return () => {
      media.removeEventListener('change', onChange);
      window.removeEventListener(THEME_EVENT, onThemeEvent);
    };
  }, [themeChoice]);

  const setTheme = useCallback((choice: ThemeChoice): void => setThemeChoice(choice), []);

  const commands = useMemo<CommandItem[]>(() => {
    const nav: CommandItem[] = [
      ...MODULES.map((module) => ({
        id: `nav-${module.id}`,
        label: module.navLabel,
        hint: `Ir para o módulo ${module.id.toUpperCase()}`,
        group: 'Navegação' as const,
        keywords: `${module.originalLabel} módulo ir abrir`,
        run: () => navigate(module.id as PageId),
      })),
      {
        id: 'nav-guerra',
        label: 'Sala de Guerra',
        hint: 'Cobertura, scorecard e grupos',
        group: 'Navegação',
        keywords: 'guerra guerra room ir abrir',
        run: () => navigate('guerra'),
      },
      ...SYSTEM_ITEMS.map((item) => ({
        id: `nav-${item.id}`,
        label: item.label,
        hint: 'Página do sistema',
        group: 'Navegação' as const,
        keywords: 'sistema ir abrir',
        run: () => navigate(item.id as PageId),
      })),
    ];
    const acoes: CommandItem[] = [
      {
        id: 'acao-tema',
        label: resolveTheme(themeChoice) === 'escuro' ? 'Mudar para tema claro' : 'Mudar para tema escuro',
        group: 'Ações',
        keywords: 'tema dark light escuro claro alternar',
        run: () => setTheme(resolveTheme(themeChoice) === 'escuro' ? 'claro' : 'escuro'),
      },
      {
        id: 'acao-atualizar',
        label: 'Verificar atualizações',
        hint: 'Checa o canal de atualização agora',
        group: 'Ações',
        keywords: 'update atualização verificar canal',
        run: () => {
          void window.staffhub.updater.check();
          navigate('dashboard');
        },
      },
    ];
    return [...nav, ...acoes];
  }, [navigate, themeChoice, setTheme]);

  useKeyboardShortcuts(navigate, () => setPaletteOpen((open) => !open));

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="app-main-row">
        <Sidebar groups={NAV_GROUPS} active={page} onNavigate={navigate} onOpenPalette={() => setPaletteOpen(true)} />
        <main className="content">
          {MODULES.filter((module) => mountedModules.has(module.id)).map((module) => {
            const SgPage = SG_PAGES[module.id];
            return (
              <div key={module.id} className="sg-page" hidden={page !== module.id}>
                <SgPage />
              </div>
            );
          })}
          {mountedModules.has('guerra') && (
            <div className="sg-page" hidden={page !== 'guerra'}>
              <WarRoomPage onNavigate={navigate} />
            </div>
          )}
          {!isModulePage(page) && (
            <Suspense fallback={<p className="muted">Carregando…</p>}>
              {renderSystemPage(page, navigate)}
            </Suspense>
          )}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
  );
}
