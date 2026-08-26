import { useEffect, useState } from 'react';
import { ArrowRight, Camera, Info, LogIn, Map, User } from 'lucide-react';
import StatBlock from '../components/StatBlock';
import { useSessionStatus } from '../hooks/useSessionStatus';
import { MODULES, type ModuleId, type PageId } from '../modules';
import { BRAND_LOGO_WIDE } from '../assets';

const HERO_DESC =
  'Análise de aldeias e tropas, operações, conferência e blindagem — a central da sua tribo.';

/** Resumo de 1 linha por módulo: o que ele faz de fato (sem repetir o título). */
const MODULE_BLURBS: Record<ModuleId, string> = {
  sg1: 'Distâncias e tempo de marcha',
  sg2: 'Tropas por jogador e aldeia',
  sg3: 'Blind e apoiadores no front',
  sg4: 'Alvos e distribuição por jogador',
  sg5: 'Conferência alvo a alvo e totalizador',
  sg6: 'Reservas em massa e MPs personalizadas',
  sg7: 'Pedidos do fórum conferidos e ajustados',
};

interface DashboardPageProps {
  onNavigate: (page: PageId) => void;
}

export default function DashboardPage({ onNavigate }: DashboardPageProps) {
  const [version, setVersion] = useState<string | null>(null);
  const status = useSessionStatus();
  const hasSession = status.state === 'logged-in';
  const isLoggingIn = status.state === 'logging-in';

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

  // Gramática de vazio uniforme nos 3 cartões de jogo: valor serif "—" +
  // badge de estado. Nada de "DESCONHECIDO".
  const offlineBadge = (
    <span className="pill pill--muted">
      <span className="pill-dot" aria-hidden="true" />
      Desconectado
    </span>
  );
  const connectingBadge = (
    <span className="pill pill--info">
      <span className="pill-dot pill-dot--pulse" aria-hidden="true" />
      Conectando…
    </span>
  );

  return (
    <section className="page">
      <div className="hero">
        <img className="hero-logo" src={BRAND_LOGO_WIDE} alt="" height={56} style={{ borderRadius: 8 }} />
        <div className="hero-main">
          <p className="hero-kicker">Quartel-general da liderança</p>
          <h1 className="hero-title">Staff Hub Toxic Squad</h1>
          <p className="hero-desc">{HERO_DESC}</p>
        </div>
        {!hasSession && (
          <button type="button" className="btn hero-login" onClick={() => onNavigate('sessao')}>
            <LogIn size={15} aria-hidden="true" />
            Fazer login no jogo
          </button>
        )}
      </div>

      {status.state !== 'logged-in' && (
        <div className="callout callout--info">
          <Info size={18} className="callout-icon" aria-hidden="true" />
          <div className="callout-body">
            <p className="callout-title">Faça login primeiro</p>
            <p>Os módulos precisam de uma sessão ativa no jogo para funcionar. Use o botão 'Fazer login no jogo' acima ou vá em Sessão.</p>
          </div>
        </div>
      )}

      <div className="stat-row">
        <StatBlock
          label="Sessão do jogo"
          tone={hasSession ? 'ok' : isLoggingIn ? 'info' : 'default'}
          icon={LogIn}
          value={hasSession ? 'Ativa' : '—'}
          delta={
            hasSession ? (
              status.checkedAt ? (
                `Verificada às ${new Date(status.checkedAt).toLocaleTimeString('pt-BR')}`
              ) : (
                'Sessão ativa no jogo'
              )
            ) : isLoggingIn ? (
              connectingBadge
            ) : (
              offlineBadge
            )
          }
        />
        <StatBlock
          label="Mundo"
          tone={hasSession ? 'gold' : 'default'}
          icon={Map}
          value={(hasSession && status.world) || '—'}
          delta={
            hasSession ? (
              status.world ? (
                'Desenvolvimento'
              ) : (
                'Mundo não identificado'
              )
            ) : (
              offlineBadge
            )
          }
        />
        <StatBlock
          label="Jogador"
          icon={User}
          value={(hasSession && status.player) || '—'}
          delta={
            hasSession ? (
              status.player ? (
                'Conta ativa nesta sessão'
              ) : (
                'Jogador não identificado'
              )
            ) : (
              offlineBadge
            )
          }
        />
        <StatBlock
          label="Versão do hub"
          icon={Info}
          value={version ?? '…'}
          delta="7 frentes entregues"
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
                <span className="module-original">{MODULE_BLURBS[module.id]}</span>
                <span className="module-foot">
                  <span className="pill pill--ok">Fase {module.phase} · ativo</span>
                  <span className="module-open">
                    Abrir
                    <ArrowRight size={13} aria-hidden="true" />
                  </span>
                </span>
              </button>
            );
          })}
          {/* 8º tile: "em breve" — Capturas de tela ganhará entrada própria;
              enquanto isso, o tile explica o estado em vez de fingir ação. */}
          <div className="module-card module-card--soon" aria-disabled="true">
            <span className="icon-badge">
              <Camera size={18} aria-hidden="true" />
            </span>
            <span className="module-title">Preparar terreno</span>
            <span className="module-original">Capturas de tela para conferência offline</span>
            <span className="module-foot">
              <span className="pill pill--warn">Em breve</span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
