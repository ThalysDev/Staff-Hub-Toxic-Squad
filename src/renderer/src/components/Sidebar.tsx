import { Search } from 'lucide-react';
import { useSessionStatus } from '../hooks/useSessionStatus';
import { BRAND_LOGO_SQUARE } from '../assets';
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
  /** Abre a paleta de comandos (Ctrl+K) — a "busca rápida" da sidebar. */
  onOpenPalette?: () => void;
}

export default function Sidebar({ groups, active, onNavigate, onOpenPalette }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark">
          <img src={BRAND_LOGO_SQUARE} alt="" width={26} height={26} style={{ borderRadius: 6 }} />
        </span>
        <div className="brand-block">
          <span className="brand-title">Staff Hub</span>
          <span className="brand-subtitle">Toxic Squad</span>
        </div>
      </div>
      <PlayerBadge />
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
      {/* Busca rápida = paleta de comandos (Ctrl+K): navegação e ações. */}
      <button
        type="button"
        className="sidebar-search"
        onClick={onOpenPalette}
        aria-label="Abrir paleta de comandos (Ctrl+K)"
      >
        <Search size={14} aria-hidden="true" />
        <span className="sidebar-search-text">Busca rápida</span>
        <span className="kbd-mini">Ctrl K</span>
      </button>
      <div className="sidebar-foot">Quartel-general · Tribal Wars BR</div>
    </aside>
  );
}

function PlayerBadge() {
  const session = useSessionStatus();
  if (session.state !== 'logged-in' || !session.player) return null;
  return (
    <div className="sidebar-player">
      <span className="sidebar-player-dot" aria-hidden="true" />
      <div className="sidebar-player-info">
        <span className="sidebar-player-nick">{session.player}</span>
        <span className="sidebar-player-world">{session.world?.toUpperCase()}</span>
      </div>
    </div>
  );
}
