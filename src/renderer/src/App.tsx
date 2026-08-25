import { useState } from 'react';
import Sidebar, { type SidebarGroup, type SidebarItem } from './components/Sidebar';
import CapturesPage from './pages/CapturesPage';
import DashboardPage from './pages/DashboardPage';
import JournalPage from './pages/JournalPage';
import ModulePlaceholderPage from './pages/ModulePlaceholderPage';
import SessionPage from './pages/SessionPage';
import SettingsPage from './pages/SettingsPage';
import { MODULES, type PageId } from './modules';

const SYSTEM_ITEMS: readonly SidebarItem[] = [
  { id: 'dashboard', label: 'Início' },
  { id: 'sessao', label: 'Sessão' },
  { id: 'config', label: 'Configurações' },
  { id: 'journal', label: 'Journal' },
  { id: 'captures', label: 'Capturas BR142' },
];

const NAV_GROUPS: readonly SidebarGroup[] = [
  {
    label: 'Operações',
    items: MODULES.map((module) => ({ id: module.id, label: module.title })),
  },
  { label: 'Sistema', items: SYSTEM_ITEMS },
];

function renderPage(page: PageId) {
  switch (page) {
    case 'dashboard':
      return <DashboardPage />;
    case 'sessao':
      return <SessionPage />;
    case 'config':
      return <SettingsPage />;
    case 'journal':
      return <JournalPage />;
    case 'captures':
      return <CapturesPage />;
    default: {
      const moduleInfo = MODULES.find((module) => module.id === page);
      if (!moduleInfo) return <DashboardPage />; // inalcançável: PageId cobre todos os módulos
      return (
        <ModulePlaceholderPage
          title={moduleInfo.title}
          description={moduleInfo.originalLabel}
          phase={moduleInfo.phase}
        />
      );
    }
  }
}

export default function App() {
  const [page, setPage] = useState<PageId>('dashboard');

  return (
    <div className="app-shell">
      <Sidebar groups={NAV_GROUPS} active={page} onNavigate={setPage} />
      <main className="content">{renderPage(page)}</main>
    </div>
  );
}