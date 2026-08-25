import { Castle, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PageId } from '../modules';

export interface SidebarItem {
  id: PageId;
  label: string;
  icon: LucideIcon;
}

export interface SidebarGroup {
  label: string;
  items: readonly SidebarItem[];
}

interface SidebarProps {
  groups: readonly SidebarGroup[];
  active: PageId;
  onNavigate: (page: PageId) => void;
}

export default function Sidebar({ groups, active, onNavigate }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark">
          <Castle size={20} aria-hidden="true" />
        </span>
        <div className="brand-block">
          <span className="brand-title">Staff Hub</span>
          <span className="brand-subtitle">Toxic Squad</span>
        </div>
      </div>
      <nav className="sidebar-nav" aria-label="Navegação principal">
        {groups.map((group) => (
          <section key={group.label} className="nav-group">
            <h2 className="nav-group-title">{group.label}</h2>
            {group.items.map((item) => {
              const Icon = item.icon;
              const isActive = item.id === active;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`nav-item${isActive ? ' nav-item--active' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => onNavigate(item.id)}
                >
                  <Icon size={16} className="nav-icon" aria-hidden="true" />
                  <span className="nav-label">{item.label}</span>
                </button>
              );
            })}
          </section>
        ))}
      </nav>
      {/* Assinatura visual da referência: busca rápida decorativa (sem função ainda). */}
      <div className="sidebar-search" hidden aria-hidden="true">
        <Search size={14} />
        <span className="sidebar-search-text">Busca rápida</span>
        <span className="kbd-mini">Ctrl K</span>
      </div>
      <div className="sidebar-foot">Quartel-general · Tribal Wars BR</div>
    </aside>
  );
}
