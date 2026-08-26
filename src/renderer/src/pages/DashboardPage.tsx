import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Camera, CheckCircle2, DownloadCloud, Info, LogIn, Map, RefreshCw, User } from 'lucide-react';
import type { UpdateManifest } from '@shared/ipc-types';
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

// ---------------------------------------------------------------------------
// Card de atualização — checagem silenciosa no mount; falha nunca derruba a página.
// ---------------------------------------------------------------------------

/** Etapas locais do preparo: espelham os eventos de updater + o resultado da Promise. */
type UpdateStage = 'idle' | 'download' | 'verify' | 'extract' | 'ready' | 'error';

interface ConfirmedUpdate {
  /** Versão em execução quando a checagem encontrou novidade. */
  currentVersion: string;
  manifest: UpdateManifest;
}

function formatMb(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

function UpdateCard() {
  const [update, setUpdate] = useState<ConfirmedUpdate | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [stage, setStage] = useState<UpdateStage>('idle');
  const [errorDetail, setErrorDetail] = useState('');
  const [bytes, setBytes] = useState({ received: 0, total: 0 });
  const [restarting, setRestarting] = useState(false);

  // Checagem silenciosa (fail-soft): sem atualização disponível OU com erro do
  // canal → nada renderiza. Erros de rede ficam fora da tela de propósito.
  // O resultado também carrega o ESTADO VIVO do atualizador (download em curso
  // / versão já preparada) — o Início desmonta ao navegar, então o card precisa
  // renascer no estágio certo em vez de oferecer "Atualizar" de novo.
  useEffect(() => {
    let cancelled = false;
    void window.staffhub.updater
      .check()
      .then((result) => {
        if (cancelled || result.error !== undefined) return;
        if (!result.updateAvailable || result.manifest === undefined) return;
        setUpdate({ currentVersion: result.currentVersion, manifest: result.manifest });
        if (result.preparedVersion === result.manifest.version) {
          setStage('ready');
        } else if (result.downloadInProgress === true) {
          const live = result.lastProgress;
          if (live?.phase === 'download') {
            setBytes({ received: live.receivedBytes, total: live.totalBytes });
            setStage('download');
          } else if (live?.phase === 'verify' || live?.phase === 'extract') {
            setStage(live.phase);
          } else {
            setStage('download');
          }
        }
      })
      .catch(() => {
        // Canal inessível: silencioso por design.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Progresso do preparo — cleanup garantido no unmount.
  useEffect(() => {
    return window.staffhub.events.onUpdaterProgress((progress) => {
      switch (progress.phase) {
        case 'download':
          setStage('download');
          setBytes({ received: progress.receivedBytes, total: progress.totalBytes });
          break;
        case 'verify':
        case 'extract':
        case 'ready':
          setStage(progress.phase);
          break;
        case 'error':
          setErrorDetail(progress.detail);
          setStage('error');
          break;
      }
    });
  }, []);

  async function handlePrepare(): Promise<void> {
    setErrorDetail('');
    setBytes({ received: 0, total: 0 });
    // Otimista: botão some na hora — clique duplo/remount não re-dispara.
    setStage('download');
    try {
      const outcome = await window.staffhub.updater.downloadAndPrepare();
      if (!outcome.ok) {
        // "Já está em andamento" é INFORMAÇÃO (download continua), não falha.
        if (outcome.detail.includes('já está em andamento')) {
          setStage((current) => (current === 'ready' ? current : 'download'));
          return;
        }
        setErrorDetail(outcome.detail || 'Não foi possível preparar a atualização.');
        setStage((current) => (current === 'ready' ? current : 'error'));
      }
    } catch {
      setErrorDetail('Não foi possível preparar a atualização. Tente novamente.');
      setStage((current) => (current === 'ready' ? current : 'error'));
    }
  }

  async function handleRestart(): Promise<void> {
    setRestarting(true);
    try {
      await window.staffhub.updater.restartToUpdate();
      // Sucesso aqui = o app está saindo para trocar de versão.
    } catch {
      setRestarting(false);
      setErrorDetail('O hub não conseguiu reiniciar sozinho. Feche-o manualmente e abra de novo para concluir.');
      setStage('error');
    }
  }

  if (update === null || dismissed) return null;

  const { manifest } = update;

  // ---- Falha: callout vermelho + repetir ou adiar -------------------------
  if (stage === 'error') {
    return (
      <div className="callout callout--danger" role="alert">
        <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
        <div className="callout-body">
          <p className="callout-title">Falha ao atualizar</p>
          <p>{errorDetail}</p>
          <div className="row">
            <button
              type="button"
              className="btn"
              aria-label={`Tentar baixar a versão ${manifest.version} novamente`}
              onClick={() => void handlePrepare()}
            >
              Tentar de novo
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              aria-label="Fechar aviso de atualização até a próxima visita"
              onClick={() => setDismissed(true)}
            >
              Mais tarde
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Pronto: callout verde de sucesso + reinício explícito --------------
  if (stage === 'ready') {
    return (
      <div className="callout callout--info">
        <CheckCircle2 size={18} className="callout-icon" aria-hidden="true" />
        <div className="callout-body">
          <p className="callout-title">Versão {manifest.version} pronta</p>
          <p>
            Download conferido e extraído. O arquivo novo já está preparado — reinicie o hub para trocar
            para a versão {manifest.version}.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn-danger"
              aria-label={`Fechar o hub agora e abrir a nova versão ${manifest.version}`}
              onClick={() => void handleRestart()}
              disabled={restarting}
            >
              {restarting ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Reiniciando…
                </>
              ) : (
                <>
                  <RefreshCw size={15} aria-hidden="true" />
                  Reiniciar e atualizar
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Preparando: barra de download / fases conferir + extrair -----------
  if (stage !== 'idle') {
    const percent =
      bytes.total > 0
        ? Math.min(100, Math.max(0, Math.round((bytes.received / bytes.total) * 100)))
        : 0;
    const label =
      bytes.total > 0
        ? `${percent}% · ${formatMb(bytes.received)} / ${formatMb(bytes.total)} MB`
        : `${formatMb(bytes.received)} MB baixados`;
    return (
      <div className="callout callout--info">
        <DownloadCloud size={18} className="callout-icon" aria-hidden="true" />
        <div className="callout-body" aria-live="polite">
          <p className="callout-title">Preparando versão {manifest.version}</p>
          {stage === 'download' && (
            <div
              className="progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label={`Baixando atualização: ${percent}% concluído`}
            >
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${percent}%` }} />
              </div>
              <span className="progress-label">{label}</span>
            </div>
          )}
          {stage === 'verify' && (
            <p className="row">
              <span className="btn-spinner" aria-hidden="true" /> Conferindo integridade…
            </p>
          )}
          {stage === 'extract' && (
            <p className="row">
              <span className="btn-spinner" aria-hidden="true" /> Extraindo…
            </p>
          )}
        </div>
      </div>
    );
  }

  // ---- Oferta inicial: notas do release + adiar ---------------------------
  return (
    <div className="callout callout--info">
      <DownloadCloud size={18} className="callout-icon" aria-hidden="true" />
      <div className="callout-body">
        <p className="callout-title">Versão {manifest.version} disponível</p>
        <p style={{ whiteSpace: 'pre-wrap' }}>{manifest.notes}</p>
        <p className="muted">
          Versão atual: {update.currentVersion} · Nova versão: {manifest.version}
        </p>
        <div className="row">
          <button
            type="button"
            className="btn"
            aria-label={`Baixar e preparar a versão ${manifest.version} agora`}
            onClick={() => void handlePrepare()}
          >
            <DownloadCloud size={15} aria-hidden="true" />
            Atualizar agora
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            aria-label="Fechar aviso de atualização até a próxima visita"
            onClick={() => setDismissed(true)}
          >
            Mais tarde
          </button>
        </div>
      </div>
    </div>
  );
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

      <UpdateCard />

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
