import { useEffect, useState } from 'react';
import { ArrowRight, Camera, Info, LogIn, Map, User } from 'lucide-react';
import type { SessionState } from '@shared/ipc-types';
import StatBlock, { type StatTone } from '../components/StatBlock';
import StatusPill from '../components/StatusPill';
import { useSessionStatus } from '../hooks/useSessionStatus';
import { MODULES, type PageId } from '../modules';

const SESSION_TONE: Record<SessionState, StatTone> = {
  'logged-in': 'ok',
  'logged-out': 'danger',
  'logging-in': 'info',
  unknown: 'default',
};

const HERO_DESC =
  'Análise de aldeias e tropas, planejamento de operações, conferência de comandos e blindagem — tudo em um só lugar.';

interface DashboardPageProps {
  onNavigate: (page: PageId) => void;
}

export default function DashboardPage({ onNavigate }: DashboardPageProps) {
  const [version, setVersion] = useState<string | null>(null);
  const status = useSessionStatus();
  const hasSession = status.state === 'logged-in';

  useEffect(() => {
    let cancelled = false;
    void window.staffhub.app
      .getVersion()
      .then((value) => {
        if (!cancelled) setVersion(value);
      })
      .catch(() => {
        // Versão indisponível; fica com "…".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="page">
      <div className="hero">
        <div className="hero-main">
          <p className="hero-kicker">Quartel-general da liderança</p>
          <h1 className="hero-title">Staff Hub Toxic Squad</h1>
        </div>
        <p className="hero-desc" title={HERO_DESC}>
          {HERO_DESC}
        </p>
        {!hasSession && (
          <button type="button" className="btn hero-login" onClick={() => onNavigate('sessao')}>
            <LogIn size={15} aria-hidden="true" />
            Fazer login no jogo
          </button>
        )}
      </div>

      <div className="stat-row">
        <StatBlock
          label="Sessão do jogo"
          tone={SESSION_TONE[status.state]}
          icon={LogIn}
          value={<StatusPill state={status.state} />}
          delta={
            status.checkedAt
              ? `Verificada em ${new Date(status.checkedAt).toLocaleTimeString('pt-BR')}`
              : 'Ainda sem verificação'
          }
        />
        <StatBlock
          label="Mundo"
          tone="gold"
          icon={Map}
          value={status.world ?? '—'}
          delta={status.world ? 'Canário de desenvolvimento' : 'Faça login'}
        />
        <StatBlock
          label="Jogador"
          icon={User}
          value={status.player ?? '—'}
          delta={status.player ? 'Conta ativa nesta sessão' : 'Faça login'}
        />
        <StatBlock
          label="Versão do hub"
          icon={Info}
          value={version ?? '…'}
          delta="7 frentes · v0.8.0"
        />
      </div>

      <div className="page-section">
        <h2 className="section-title">Frente de operações</h2>
        <div className="module-grid">
          {MODULES.map((module) => {
            const Icon = module.icon;
            return (
              <button
                key={module.id}
                type="button"
                className="module-card"
                onClick={() => onNavigate(module.id)}
              >
                <span className="icon-badge">
                  <Icon size={18} aria-hidden="true" />
                </span>
                <span className="module-title">{module.title}</span>
                <span className="module-original">{module.originalLabel}</span>
                <span className="module-foot">
                  <span className="pill pill--ok">Fase {module.phase} · ativo</span>
                  <span className="module-open">
                    Abrir
                    <ArrowRight size={12} aria-hidden="true" />
                  </span>
                </span>
              </button>
            );
          })}
          {/* 8º tile: ação real em vez de buraco no grid. */}
          <button
            type="button"
            className="module-card module-card--cta"
            onClick={() => onNavigate('captures')}
          >
            <span className="icon-badge">
              <Camera size={18} aria-hidden="true" />
            </span>
            <span className="module-title">Preparar terreno</span>
            <span className="module-original">Capturas BR142 — fixtures para os parsers</span>
            <span className="module-foot">
              <span className="module-cta-btn">
                Começar
                <ArrowRight size={12} aria-hidden="true" />
              </span>
            </span>
          </button>
        </div>
      </div>
    </section>
  );
}
