import { useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, Sparkles, X } from 'lucide-react';
import type { UpdateProgress } from '@shared/ipc-types';
import { useUpdateStatus } from '../hooks/useUpdateStatus';

// MODO DEMO (?update-banner=demo): captura de QA — renderiza o estado 'pronto'
// com versão fake 9.9.9 sem ler a store (só visual; o App pode rodar um check
// fail-soft do canal por assinar o hook — inofensivo, o demo o ignora).
const DEMO_BANNER = new URLSearchParams(window.location.search).get('update-banner') === 'demo';

function formatMb(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

function UpdateBannerDemo() {
  return (
    <div className="update-banner" role="status">
      <div className="update-banner-row">
        <CheckCircle2 size={18} className="update-banner-icon" aria-hidden="true" />
        <p className="update-banner-title">
          Versão <strong>9.9.9</strong> pronta — reinicie o hub para aplicar
        </p>
        <div className="update-banner-actions">
          <button type="button" className="btn btn-sm" aria-disabled="true">
            Reiniciar agora
          </button>
          <button type="button" className="btn btn-ghost btn-sm" aria-disabled="true">
            Mais tarde
          </button>
        </div>
      </div>
    </div>
  );
}

function DownloadingState({ progress }: { progress: UpdateProgress }) {
  if (progress.phase !== 'download') {
    return (
      <div className="update-banner" role="status">
        <div className="update-banner-row">
          <span className="btn-spinner" aria-hidden="true" />
          <p className="update-banner-title">
            {progress.phase === 'verify' ? 'Conferindo integridade…' : 'Preparando a atualização…'}
          </p>
        </div>
      </div>
    );
  }
  const { receivedBytes, totalBytes } = progress;
  const pct = totalBytes > 0 ? Math.min(100, Math.max(0, Math.round((receivedBytes / totalBytes) * 100))) : 0;
  const title =
    totalBytes > 0
      ? `Baixando atualização… ${pct}% (${formatMb(receivedBytes)} de ${formatMb(totalBytes)} MB)`
      : `Baixando atualização… ${formatMb(receivedBytes)} MB`;
  return (
    <div className="update-banner" role="status">
      <div className="update-banner-row">
        <span className="btn-spinner" aria-hidden="true" />
        <p className="update-banner-title">{title}</p>
        <div
          className="update-banner-progress progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={`Baixando atualização: ${pct}% concluído`}
        >
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function UpdateBannerLive() {
  const { state, snoozedVersion, check, download, restart, snooze } = useUpdateStatus();
  const [notesOpen, setNotesOpen] = useState(false);
  // Erro dispensado some até vir erro NOVO (detail diferente) — sem useEffect.
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  const handleRestart = (): void => {
    setRestarting(true);
    void restart().finally(() => setRestarting(false));
  };

  if (state.phase === 'idle') return null;
  // Snooze é POR VERSÃO: a mesma versão fica oculta; versão nova na store
  // reabre o banner na hora (nada de "sumiu para sempre").
  if (state.phase === 'available' && state.latestVersion === snoozedVersion) return null;
  if (state.phase === 'ready' && state.version === snoozedVersion) return null;
  if (state.phase === 'error' && state.detail === dismissedError) return null;

  // ---- Falha: faixa âmbar + tentar de novo + dispensar (só local) ---------
  if (state.phase === 'error') {
    return (
      <div className="update-banner update-banner--error" role="alert">
        <div className="update-banner-row">
          <AlertTriangle size={18} className="update-banner-icon" aria-hidden="true" />
          <p className="update-banner-title">Falha ao atualizar: {state.detail}</p>
          <div className="update-banner-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void check()}>
              Tentar de novo
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm update-banner-close"
              aria-label="Dispensar o aviso de falha"
              onClick={() => setDismissedError(state.detail)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Pronto: celebração verde + reinício explícito ----------------------
  if (state.phase === 'ready') {
    return (
      <div className="update-banner" role="status">
        <div className="update-banner-row">
          <CheckCircle2 size={18} className="update-banner-icon" aria-hidden="true" />
          <p className="update-banner-title">
            Versão <strong>{state.version}</strong> pronta — reinicie o hub para aplicar
          </p>
          <div className="update-banner-actions">
            <button
              type="button"
              className="btn btn-sm"
              aria-label={`Fechar o hub agora e abrir a versão ${state.version}`}
              onClick={handleRestart}
              disabled={restarting}
            >
              {restarting ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Reiniciando…
                </>
              ) : (
                <>
                  <RefreshCw size={14} aria-hidden="true" />
                  Reiniciar agora
                </>
              )}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Ocultar a faixa desta versão — uma versão nova reaparece"
              onClick={() => snooze(state.version)}
            >
              Mais tarde
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Preparando: spinner + frase da fase + barra slim no download -------
  if (state.phase === 'downloading') {
    return <DownloadingState progress={state.progress} />;
  }

  // ---- Oferta: pulso + notas recolhíveis + baixar / adiar ------------------
  return (
    <div className="update-banner" role="status">
      <div className="update-banner-row">
        <span className="update-banner-dot" aria-hidden="true" />
        <Sparkles size={18} className="update-banner-icon" aria-hidden="true" />
        <p className="update-banner-title">
          <span className="pill pill--ok">Nova versão</span>{' '}
          <strong>{state.latestVersion}</strong> disponível
        </p>
        <div className="update-banner-actions">
          {state.notes !== '' && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-expanded={notesOpen}
              aria-controls="update-banner-notes"
              onClick={() => setNotesOpen((open) => !open)}
            >
              O que mudou
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            aria-label={`Baixar e preparar a versão ${state.latestVersion} agora`}
            onClick={() => void download()}
          >
            Baixar e preparar
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label="Ocultar a faixa desta versão — uma versão nova reaparece"
            onClick={() => snooze(state.latestVersion)}
          >
            Agora não
          </button>
        </div>
      </div>
      {notesOpen && state.notes !== '' && (
        <div id="update-banner-notes" className="update-banner-notes">
          {state.notes}
        </div>
      )}
    </div>
  );
}

export default function UpdateBanner() {
  // Ramo demo NÃO chama hooks: o BANNER não sobe a store. (O App assina o
  // hook desde o fix da paleta, então um check fail-soft do canal pode
  // acontecer na captura — inofensivo, o demo ignora o estado.)
  if (DEMO_BANNER) return <UpdateBannerDemo />;
  return <UpdateBannerLive />;
}
