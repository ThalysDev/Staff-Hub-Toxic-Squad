import { useEffect, useState } from 'react';
import { ArrowRight, Camera, CheckCircle2, Copy, DownloadCloud, Info, LogIn, Map, RefreshCw, User } from 'lucide-react';
import type { OpArchiveEntry, UpdateManifest } from '@shared/ipc-types';
import type { ScorecardOptions, ScorecardRow } from '@shared/war-room';
import Callout from '../components/Callout';
import StatBlock from '../components/StatBlock';
import { usePreferences } from '../hooks/usePreferences';
import { useSessionStatus } from '../hooks/useSessionStatus';
import { useToast } from '../hooks/useToast';
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
      <Callout
        variant="danger"
        title="Falha ao atualizar"
        actions={
          <>
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
          </>
        }
      >
        <p>{errorDetail}</p>
      </Callout>
    );
  }

  // ---- Pronto: callout verde de sucesso + reinício explícito --------------
  if (stage === 'ready') {
    return (
      <Callout
        variant="info"
        icon={CheckCircle2}
        title={`Versão ${manifest.version} pronta`}
        actions={
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
        }
      >
        <p>
          Download conferido e extraído. O arquivo novo já está preparado — reinicie o hub para trocar
          para a versão {manifest.version}.
        </p>
      </Callout>
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
      <Callout variant="info" icon={DownloadCloud} title={`Preparando versão ${manifest.version}`}>
        <div aria-live="polite">
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
      </Callout>
    );
  }

  // ---- Oferta inicial: notas do release + adiar ---------------------------
  return (
    <Callout
      variant="info"
      icon={DownloadCloud}
      title={`Versão ${manifest.version} disponível`}
      actions={
        <>
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
        </>
      }
    >
      <p style={{ whiteSpace: 'pre-wrap' }}>{manifest.notes}</p>
      <p className="muted">
        Versão atual: {update.currentVersion} · Nova versão: {manifest.version}
      </p>
    </Callout>
  );
}

/**
 * Scorecard da tribo no Dashboard: agregado de participação nas OPs arquivadas.
 * Reaproveita buildScorecard do war-room sobre opArchive.list() — sem rede.
 * Linhas/métrica/janela são configuráveis e persistem em preferences('dashboard').
 */

/** Escolhas do seletor de linhas: "all" = Todos (default 5 = comportamento histórico). */
type ScoreTop = 5 | 10 | 20 | 'all';
/** Métrica de ordenação (espelha ScorecardOptions['metric']). */
type ScoreMetric = 'faltas' | 'envios' | 'percentual';
/** Janela temporal em dias: "all" = tudo desde o começo do arquivo. */
type ScoreWindow = 'all' | 7 | 30;

/** Preferências do scorecard (module 'dashboard' no preferences). */
type ScorePrefs = {
  scoreTop: number | 'all';
  scoreMetric: ScoreMetric;
  scoreWindow: ScoreWindow;
};

/** Rótulo do critério de ordenação para o rodapé (o pior vem primeiro em qualquer métrica). */
const METRIC_ORDER_LABEL: Record<ScoreMetric, string> = {
  faltas: 'com mais faltas',
  envios: 'com mais envios',
  percentual: 'com menor % cumprido',
};

/** Sanitizadores do bruto do preferences: fora do cardápio do seletor, volta ao default. */
function parseScoreTop(value: unknown): ScoreTop {
  return value === 'all' || value === 10 || value === 20 ? value : 5;
}

function parseScoreMetric(value: unknown): ScoreMetric {
  return value === 'envios' || value === 'percentual' ? value : 'faltas';
}

function parseScoreWindow(value: unknown): ScoreWindow {
  return value === 7 || value === 30 ? value : 'all';
}

/** % cumprido (enviado/esperado, 0 decimais) + tom da célula; "—" quando nada foi esperado. */
function pctCell(row: ScorecardRow): { text: string; tone: ' error' | ' ok' | '' } {
  if (row.expected === 0) return { text: '—', tone: '' };
  const pct = Math.round((row.sent / row.expected) * 100);
  return { text: String(pct), tone: pct < 100 ? ' error' : ' ok' };
}

/** TSV da tabela: "Jogador\tOPs\tEsperado\tEnviado\tFaltou" (+ "%" só na métrica percentual). */
function buildScorecardTsv(rows: readonly ScorecardRow[], withPct: boolean): string {
  const header = ['Jogador', 'OPs', 'Esperado', 'Enviado', 'Faltou'];
  if (withPct) header.push('%');
  const lines = rows.map((row) => {
    const cells = [row.playerName, String(row.opsParticipated), String(row.expected), String(row.sent), String(row.missed)];
    if (withPct) cells.push(pctCell(row).text);
    return cells.join('\t');
  });
  return [header.join('\t'), ...lines].join('\n');
}

function ScoreboardSection() {
  const { prefs, savePrefs } = usePreferences<ScorePrefs>('dashboard', {
    scoreTop: 5,
    scoreMetric: 'faltas',
    scoreWindow: 'all',
  });
  const { push } = useToast();

  const [ops, setOps] = useState<OpArchiveEntry[] | null>(null);
  const [engine, setEngine] = useState<typeof import('@shared/war-room') | null>(null);
  const [scorecard, setScorecard] = useState<ScorecardRow[] | null>(null);

  // Leitura única das OPs + engine por import dinâmico para não pesar o bundle.
  useEffect(() => {
    let cancelled = false;
    void window.staffhub.opArchive
      .list()
      .then((entries) => {
        if (cancelled) return;
        void import('@shared/war-room').then((mod) => {
          if (cancelled) return;
          setOps(entries);
          setEngine(mod);
        });
      })
      .catch(() => {
        // Sem arquivo legível: ops permanece null e a seção não renderiza.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Opções atuais sanitizadas (o preferences pode carregar lixo de versões antigas).
  const scoreTop = prefs === null ? 5 : parseScoreTop(prefs.scoreTop);
  const scoreMetric = prefs === null ? 'faltas' : parseScoreMetric(prefs.scoreMetric);
  const scoreWindow = prefs === null ? 'all' : parseScoreWindow(prefs.scoreWindow);

  // Recalcula quando OPs/engine/opções mudam; janela vira limite ISO (hoje − N dias).
  useEffect(() => {
    if (ops === null || engine === null || prefs === null) return;
    // exactOptionalPropertyTypes: chave ausente ≠ undefined — só entra quem tem valor.
    const options: ScorecardOptions = { metric: scoreMetric };
    if (scoreTop !== 'all') options.topN = scoreTop;
    if (scoreWindow !== 'all') {
      options.since = new Date(Date.now() - scoreWindow * 24 * 60 * 60 * 1000).toISOString();
    }
    try {
      setScorecard(engine.buildScorecard(ops, options));
    } catch {
      // Distribuição arquivada malformada: motor fail-closed, seção some.
      setScorecard(null);
    }
  }, [ops, engine, prefs, scoreTop, scoreMetric, scoreWindow]);

  async function handleCopyTsv(): Promise<void> {
    if (scorecard === null || scorecard.length === 0) {
      push('info', 'Sem linhas para copiar.');
      return;
    }
    try {
      await navigator.clipboard.writeText(buildScorecardTsv(scorecard, scoreMetric === 'percentual'));
      push('ok', `Tabela copiada (${scorecard.length} linha(s), TSV).`);
    } catch {
      push('error', 'Não foi possível copiar — permissão de área de transferência negada.');
    }
  }

  // Mesma gramática de antes: sem OPs arquivadas (ou falha de leitura) a seção some.
  if (scorecard === null || scorecard.length === 0) return null;

  const totalMissed = scorecard.reduce((sum, p) => sum + p.missed, 0);
  // O topN corta dentro do motor: quando o corte devolveu exatamente o limite,
  // pode haver mais linhas — o rodapé aponta o scorecard completo na Sala de Guerra.
  const capped = typeof scoreTop === 'number' && scorecard.length === scoreTop;
  const showPct = scoreMetric === 'percentual';

  return (
    <>
      <div className="page-section">
        <h2 className="section-title">Scorecard da staff</h2>
        <div className="card card--flush">
          <div className="card-header">
            <h3 className="card-title">Participação nas OPs</h3>
            <span className="spacer" />
            <span className="pill pill--muted">{scorecard.length} jogador(es)</span>
            {totalMissed > 0 && <span className="pill pill--error">{totalMissed} falta(s) total(is)</span>}
            <button
              type="button"
              className="btn"
              aria-label="Copiar a tabela do scorecard em TSV para a área de transferência"
              onClick={() => void handleCopyTsv()}
            >
              <Copy size={15} aria-hidden="true" />
              Copiar tabela
            </button>
          </div>
          <div className="card-body">
            <div className="row" aria-label="Controles do scorecard">
              <label className="field">
                <span className="field-label">Linhas</span>
                <select
                  className="select"
                  value={scoreTop === 'all' ? 'all' : String(scoreTop)}
                  onChange={(event) =>
                    savePrefs({ scoreTop: event.target.value === 'all' ? 'all' : Number(event.target.value) })
                  }
                  aria-label="Quantidade de jogadores no scorecard"
                >
                  <option value="5">Top 5</option>
                  <option value="10">Top 10</option>
                  <option value="20">Top 20</option>
                  <option value="all">Todos</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Métrica</span>
                <select
                  className="select"
                  value={scoreMetric}
                  onChange={(event) => savePrefs({ scoreMetric: event.target.value as ScoreMetric })}
                  aria-label="Métrica de ordenação do scorecard"
                >
                  <option value="faltas">Faltas</option>
                  <option value="envios">Envios</option>
                  <option value="percentual">% cumprido</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Janela</span>
                <select
                  className="select"
                  value={scoreWindow === 'all' ? 'all' : String(scoreWindow)}
                  onChange={(event) =>
                    savePrefs({
                      scoreWindow: event.target.value === 'all' ? 'all' : (Number(event.target.value) as 7 | 30),
                    })
                  }
                  aria-label="Janela temporal do scorecard"
                >
                  <option value="all">Tudo</option>
                  <option value="7">Últimos 7 dias</option>
                  <option value="30">Últimos 30 dias</option>
                </select>
              </label>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Jogador</th>
                  <th scope="col" className="cell-num">OPs</th>
                  <th scope="col" className="cell-num">Enviado</th>
                  <th scope="col" className="cell-num">Faltou</th>
                  {showPct && (
                    <th scope="col" className="cell-num">%</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {scorecard.map((row) => (
                  <tr key={row.playerName}>
                    <td className="cell-nowrap">{row.playerName}</td>
                    <td className="cell-num">{row.opsParticipated}</td>
                    <td className="cell-num">{row.sent}</td>
                    <td className={`cell-num${row.missed > 0 ? ' error' : ' ok'}`}>{row.missed}</td>
                    {showPct && (
                      <td className={`cell-num${pctCell(row).tone}`}>{pctCell(row).text}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {capped && (
            <div className="card-body">
              <p className="muted">
                Mostrando os {scoreTop} {METRIC_ORDER_LABEL[scoreMetric]} — scorecard completo na Sala de Guerra.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
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

  // Gramática de vazio uniforme nos 3 cartões de jogo: sem sessão o valor vira
  // "aguardando sessão" (muted) + badge de estado com o vocabulário unificado
  // da sessão (o mesmo da página Sessão): Conectado / Desconectado / Não
  // conectado. Nada de "DESCONHECIDO".
  const offlineBadge = (
    <span className="pill pill--muted">
      <span className="pill-dot" aria-hidden="true" />
      Desconectado
    </span>
  );
  const unknownBadge = (
    <span className="pill pill--muted">
      <span className="pill-dot" aria-hidden="true" />
      Não conectado
    </span>
  );
  const connectingBadge = (
    <span className="pill pill--info">
      <span className="pill-dot pill-dot--pulse" aria-hidden="true" />
      Conectando…
    </span>
  );
  // Sem sessão: "Desconectado" só quando o estado é logged-out; desconhecido
  // (ainda não verificado) usa o rótulo neutro "Não conectado".
  const semSessaoBadge = status.state === 'unknown' ? unknownBadge : offlineBadge;

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
        <Callout variant="info" title="Faça login primeiro">
          <p>Os módulos precisam de uma sessão ativa no jogo para funcionar. Use o botão 'Fazer login no jogo' acima ou vá em Sessão.</p>
        </Callout>
      )}

      <UpdateCard />

      <div className="stat-row">
        <StatBlock
          label="Sessão do jogo"
          tone={hasSession ? 'ok' : isLoggingIn ? 'info' : 'default'}
          icon={LogIn}
          value={hasSession ? 'Conectado' : <span className="muted">aguardando sessão</span>}
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
              semSessaoBadge
            )
          }
        />
        <StatBlock
          label="Mundo"
          tone={hasSession ? 'gold' : 'default'}
          icon={Map}
          value={
            hasSession && status.world ? status.world : hasSession ? '—' : <span className="muted">aguardando sessão</span>
          }
          delta={
            hasSession ? (
              status.world ? (
                'Desenvolvimento'
              ) : (
                'Mundo não identificado'
              )
            ) : (
              semSessaoBadge
            )
          }
        />
        <StatBlock
          label="Jogador"
          icon={User}
          value={
            hasSession && status.player ? status.player : hasSession ? '—' : <span className="muted">aguardando sessão</span>
          }
          delta={
            hasSession ? (
              status.player ? (
                'Conta ativa nesta sessão'
              ) : (
                'Jogador não identificado'
              )
            ) : (
              semSessaoBadge
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

      <ScoreboardSection />

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
          {/* 8º tile — Preparar Terreno (Capturas): fora da lista MODULES por não
              ser módulo SG, mas a página existe e abre como os demais tiles. */}
          <button
            type="button"
            className="module-card"
            onClick={() => onNavigate('captures')}
          >
            <span className="icon-badge">
              <Camera size={18} aria-hidden="true" />
            </span>
            <span className="module-title">Preparar terreno</span>
            <span className="module-original">Capturas de tela para conferência offline</span>
            <span className="module-foot">
              <span className="pill pill--warn">Ferramenta</span>
              <span className="module-open">
                Abrir
                <ArrowRight size={13} aria-hidden="true" />
              </span>
            </span>
          </button>
        </div>
      </div>
    </section>
  );
}
