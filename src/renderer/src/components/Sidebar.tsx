import type { PageId } from '../modules';

export interface SidebarItem {
  id: PageId;
  label: string;
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
        <span className="brand-mark">SH</span>
        <div className="brand-block">
          <span className="brand-title">Staff Hub</span>
          <span className="brand-subtitle muted">Toxic Squad</span>
        </div>
      </div>
      <nav className="sidebar-nav">
        {groups.map((group) => (
          <div key={group.label} className="nav-group">
            <h2 className="nav-group-title">{group.label}</h2>
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`nav-item${item.id === active ? ' nav-item--active' : ''}`}
                onClick={() => onNavigate(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}