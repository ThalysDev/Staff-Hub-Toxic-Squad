import { useState } from 'react';
import { Camera, History, LayoutDashboard, LogIn, Settings2 } from 'lucide-react';
import Sidebar, { type SidebarGroup, type SidebarItem } from './components/Sidebar';
import CapturesPage from './pages/CapturesPage';
import DashboardPage from './pages/DashboardPage';
import JournalPage from './pages/JournalPage';
import ModulePlaceholderPage from './pages/ModulePlaceholderPage';
import Sg1Page from './pages/sg1/Sg1Page';
import Sg2Page from './pages/sg2/Sg2Page';
import Sg3Page from './pages/sg3/Sg3Page';
import Sg4Page from './pages/sg4/Sg4Page';
import Sg5Page from './pages/sg5/Sg5Page';
import Sg6Page from './pages/sg6/Sg6Page';
import SessionPage from './pages/SessionPage';
import SettingsPage from './pages/SettingsPage';
import { MODULES, type PageId } from './modules';

const SYSTEM_ITEMS: readonly SidebarItem[] = [
  { id: 'dashboard', label: 'Início', icon: LayoutDashboard },
  { id: 'sessao', label: 'Sessão', icon: LogIn },
  { id: 'config', label: 'Configurações', icon: Settings2 },
  { id: 'journal', label: 'Journal', icon: History },
  { id: 'captures', label: 'Capturas BR142', icon: Camera },
];

const NAV_GROUPS: readonly SidebarGroup[] = [
  {
    label: 'Operações',
    items: MODULES.map((module) => ({ id: module.id, label: module.navLabel, icon: module.icon })),
  },
  { label: 'Sistema', items: SYSTEM_ITEMS },
];

function renderPage(page: PageId, onNavigate: (page: PageId) => void) {
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
    case 'sg1':
      return <Sg1Page />;
    case 'sg2':
      return <Sg2Page />;
    case 'sg3':
      return <Sg3Page />;
    case 'sg4':
      return <Sg4Page />;
    case 'sg5':
      return <Sg5Page />;
    case 'sg6':
      return <Sg6Page />;
    default: {
      const moduleInfo = MODULES.find((module) => module.id === page);
      if (!moduleInfo) return <DashboardPage onNavigate={onNavigate} />; // inalcançável: PageId cobre todos os módulos
      return <ModulePlaceholderPage module={moduleInfo} />;
    }
  }
}

export default function App() {
  const [page, setPage] = useState<PageId>('dashboard');

  return (
    <div className="app-shell">
      <Sidebar groups={NAV_GROUPS} active={page} onNavigate={setPage} />
      <main className="content">{renderPage(page, setPage)}</main>
    </div>
  );
}
