import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Lock, RefreshCw, RotateCcw, Save } from 'lucide-react';
import type { AppSettings, UpdateCheckResult } from '@shared/ipc-types';
import { DEFAULT_SETTINGS } from '@shared/ipc-types';
import PageHeader from '../components/PageHeader';
import { useToast } from '../hooks/useToast';
import { currentThemeChoice, setThemeChoice, THEME_EVENT, type ThemeChoice } from '../theme';

interface SettingsDraft {
  requestMinIntervalMs: string;
  requestJitterMs: string;
  requestCeiling: string;
}

function toDraft(settings: AppSettings): SettingsDraft {
  return {
    requestMinIntervalMs: String(settings.requestMinIntervalMs),
    requestJitterMs: String(settings.requestJitterMs),
    requestCeiling: String(settings.requestCeiling),
  };
}

interface FieldErrors {
  min?: string;
  jitter?: string;
  ceiling?: string;
}

function validateDraft(draft: SettingsDraft): FieldErrors {
  const errors: FieldErrors = {};
  const min = Number(draft.requestMinIntervalMs);
  const jitter = Number(draft.requestJitterMs);
  const ceiling = Number(draft.requestCeiling);

  if (!Number.isFinite(min) || min <= 0) errors.min = 'Informe um número maior que zero.';
  if (!Number.isFinite(jitter) || jitter < 0) errors.jitter = 'Informe um número maior ou igual a zero.';
  if (!Number.isFinite(ceiling) || ceiling <= 0) errors.ceiling = 'Informe um número maior que zero.';

  return errors;
}

/** Validação de UI do canal: só aceita URL absoluta http(s). */
function validateUpdateUrl(value: string): string | undefined {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'Informe a URL completa do latest.json (começa com http:// ou https://).';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'O canal precisa começar com http:// ou https://.';
  }
  return undefined;
}

function describedBy(id: string, hasError: boolean): string {
  return hasError ? `${id}-error` : `${id}-hint`;
}

/** Campo numérico curto (150px) com o help correndo ao lado — o card usa a
 * largura do container em vez de deixar 430px vazios. */
function NumberField(props: {
  id: string;
  label: string;
  hint: string;
  error: string | undefined;
  value: string;
  min: number;
  onChange: (value: string) => void;
}) {
  const { id, label, hint, error, value, min, onChange } = props;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="field-inline">
        <input
          id={id}
          className="input input--num"
          type="number"
          min={min}
          value={value}
          aria-describedby={describedBy(id, error !== undefined)}
          onChange={(event) => onChange(event.target.value)}
        />
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      </div>
      {error !== undefined && (
        <p className="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <div className="card">
      <div className="card-body">
        <div className="skeleton-form" aria-hidden="true">
          <div className="skeleton skeleton-title" />
          <div className="skeleton skeleton-input" />
          <div className="skeleton skeleton-input" />
          <div className="skeleton skeleton-input" />
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [justSaved, setJustSaved] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // ---- Seção Atualizações -------------------------------------------------
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [themeChoice, setThemeChoiceState] = useState<ThemeChoice>(currentThemeChoice);
  const [updateUrlDraft, setUpdateUrlDraft] = useState('');
  const [savingChannel, setSavingChannel] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null);

  const { push } = useToast();

  // Tema mudou pela paleta/outra tela com Configurações aberta → select sincroniza.
  useEffect(() => {
    const onThemeEvent = (event: Event): void => {
      const detail = (event as CustomEvent<ThemeChoice>).detail;
      if (detail !== undefined) setThemeChoiceState(detail);
    };
    window.addEventListener(THEME_EVENT, onThemeEvent);
    return () => {
      window.removeEventListener(THEME_EVENT, onThemeEvent);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.staffhub.settings
      .get()
      .then((current) => {
        if (cancelled) return;
        setSettings(current);
        setDraft(toDraft(current));
        setUpdateUrlDraft(current.updateUrl);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    void window.staffhub.app
      .getVersion()
      .then((value) => {
        if (!cancelled) setAppVersion(value);
      })
      .catch(() => undefined); // Versão fica em "…" até resolver.
    return () => {
      cancelled = true;
    };
  }, []);

  // Confirmação "Salvo" no botão por 2,5s após cada gravação bem-sucedida.
  useEffect(() => {
    if (savedAt === 0) return;
    setJustSaved(true);
    const timer = setTimeout(() => setJustSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [savedAt]);

  async function handleSave(): Promise<void> {
    if (!settings || !draft) return;
    const errors = validateDraft(draft);
    if (errors.min !== undefined || errors.jitter !== undefined || errors.ceiling !== undefined) {
      return;
    }

    const min = Number(draft.requestMinIntervalMs);
    const jitter = Number(draft.requestJitterMs);
    const ceiling = Number(draft.requestCeiling);

    const patch: Partial<AppSettings> = {};
    if (min !== settings.requestMinIntervalMs) patch.requestMinIntervalMs = min;
    if (jitter !== settings.requestJitterMs) patch.requestJitterMs = jitter;
    if (ceiling !== settings.requestCeiling) patch.requestCeiling = ceiling;

    setSaving(true);
    try {
      const updated = await window.staffhub.settings.update(patch);
      setSettings(updated);
      setDraft(toDraft(updated));
      setSavedAt(Date.now());
      push('ok', 'Configurações salvas.');
    } catch {
      push('error', 'Não foi possível salvar as configurações. Tente novamente.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveChannel(): Promise<void> {
    if (!settings) return;
    const channelUrl = updateUrlDraft.trim();
    if (validateUpdateUrl(channelUrl) !== undefined) return;
    setSavingChannel(true);
    try {
      const updated = await window.staffhub.settings.update({ updateUrl: channelUrl });
      setSettings(updated);
      setUpdateUrlDraft(updated.updateUrl);
      push('ok', 'Canal de atualização salvo.');
    } catch {
      push('error', 'Não foi possível salvar o canal de atualização. Tente novamente.');
    } finally {
      setSavingChannel(false);
    }
  }

  async function handleCheckNow(): Promise<void> {
    setCheckBusy(true);
    setCheckResult(null);
    try {
      setCheckResult(await window.staffhub.updater.check());
    } catch {
      // Falha de ponte IPC: vira erro visível na linha de resultado.
      setCheckResult({
        currentVersion: appVersion ?? '?',
        latestVersion: '?',
        updateAvailable: false,
        error: 'Não foi possível consultar o canal de atualização agora.',
      });
    } finally {
      setCheckBusy(false);
    }
  }

  if (loadError) {
    return (
      <section className="page">
        <PageHeader kicker="Sistema" title="Configurações" />
        <div className="card">
          <div className="card-body">
            <p className="inline-error">
              <AlertTriangle size={16} aria-hidden="true" />
              Não foi possível carregar as configurações. Feche e abra o hub e tente de novo.
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (!settings || !draft) {
    return (
      <section className="page">
        <PageHeader kicker="Sistema" title="Configurações" />
        <SettingsSkeleton />
      </section>
    );
  }

  const errors = validateDraft(draft);
  const canSave =
    errors.min === undefined && errors.jitter === undefined && errors.ceiling === undefined;

  const channelTrimmed = updateUrlDraft.trim();
  const channelError = validateUpdateUrl(channelTrimmed);

  return (
    <section className="page">
      <PageHeader
        kicker="Sistema"
        title="Configurações"
        description="Pacing e limites das requisições ao jogo — proteção contra bloqueio da sua conta."
      />
      <section className="page-section">
        <h2 className="section-title">Aparência</h2>
        <div className="card">
          <div className="card-body">
            <div className="field">
              <label className="field-label" htmlFor="theme-choice">
                Tema
              </label>
              <select
                id="theme-choice"
                className="select"
                value={themeChoice}
                onChange={(event) => {
                  const choice = event.target.value as ThemeChoice;
                  setThemeChoice(choice);
                  setThemeChoiceState(choice);
                }}
              >
                <option value="system">Seguir o sistema</option>
                <option value="claro">Claro (pergaminho)</option>
                <option value="escuro">Escuro (Nexus escuro)</option>
              </select>
              <p className="field-hint">
                Aplicado na hora e lembrado entre sessões. "Seguir o sistema" acompanha a
                preferência claro/escuro do Windows.
              </p>
            </div>
          </div>
        </div>
      </section>
      <div className="card">
        <div className="card-body">
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave();
            }}
          >
            <NumberField
              id="requestMinIntervalMs"
              label="Intervalo mínimo entre requisições (ms)"
              hint="Pausa mínima entre uma requisição e outra ao jogo."
              error={errors.min}
              value={draft.requestMinIntervalMs}
              min={1}
              onChange={(value) => setDraft({ ...draft, requestMinIntervalMs: value })}
            />
            <NumberField
              id="requestJitterMs"
              label="Jitter (ms)"
              hint="Variação aleatória somada ao intervalo, para o ritmo parecer humano."
              error={errors.jitter}
              value={draft.requestJitterMs}
              min={0}
              onChange={(value) => setDraft({ ...draft, requestJitterMs: value })}
            />
            <NumberField
              id="requestCeiling"
              label="Teto de requisições por operação"
              hint="Limite por operação de coleta — trava antes de virar ruído no servidor."
              error={errors.ceiling}
              value={draft.requestCeiling}
              min={1}
              onChange={(value) => setDraft({ ...draft, requestCeiling: value })}
            />

            <div className="callout callout--warn">
              <Lock size={18} className="callout-icon" aria-hidden="true" />
              <div className="callout-body">
                <p>Mutações rodam sempre em modo real — a confirmação dupla e o journal seguem ativos.</p>
              </div>
            </div>

            <div className="row">
              <button type="submit" className="btn" disabled={saving || !canSave}>
                {saving ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    Salvando…
                  </>
                ) : justSaved ? (
                  <>
                    <CheckCircle2 size={15} aria-hidden="true" />
                    Salvo
                  </>
                ) : (
                  <>
                    <Save size={15} aria-hidden="true" />
                    Salvar
                  </>
                )}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setDraft(toDraft(DEFAULT_SETTINGS))}
              >
                <RotateCcw size={15} aria-hidden="true" />
                Restaurar padrões
              </button>
            </div>
          </form>
        </div>
      </div>

      <section className="page-section">
        <h2 className="section-title">Atualizações</h2>
        <div className="card">
          <div className="card-body">
            <form
              className="col"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSaveChannel();
              }}
            >
              <div className="field">
                <label className="field-label" htmlFor="updateChannelUrl">
                  Canal de atualização (latest.json)
                </label>
                <input
                  id="updateChannelUrl"
                  className="input"
                  type="url"
                  value={updateUrlDraft}
                  aria-describedby={
                    channelError !== undefined ? 'updateChannelUrl-error' : 'updateChannelUrl-hint'
                  }
                  aria-invalid={channelError !== undefined || undefined}
                  onChange={(event) => setUpdateUrlDraft(event.target.value)}
                />
                {channelError !== undefined ? (
                  <p className="field-error" id="updateChannelUrl-error" role="alert">
                    {channelError}
                  </p>
                ) : (
                  <p className="field-hint" id="updateChannelUrl-hint">
                    Endereço do manifest que o hub consulta por novas versões.
                  </p>
                )}
              </div>

              <div className="row">
                <button
                  type="submit"
                  className="btn"
                  aria-label="Salvar o canal de atualização"
                  disabled={savingChannel || channelError !== undefined || channelTrimmed === ''}
                >
                  {savingChannel ? (
                    <>
                      <span className="btn-spinner" aria-hidden="true" />
                      Salvando…
                    </>
                  ) : (
                    <>
                      <Save size={15} aria-hidden="true" />
                      Salvar canal
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label="Verificar agora se existe nova versão no canal"
                  onClick={() => void handleCheckNow()}
                  disabled={checkBusy}
                >
                  {checkBusy ? (
                    <>
                      <span className="btn-spinner" aria-hidden="true" />
                      Verificando…
                    </>
                  ) : (
                    <>
                      <RefreshCw size={15} aria-hidden="true" />
                      Verificar agora
                    </>
                  )}
                </button>
                <span className="muted">
                  Versão instalada: <strong>{appVersion ?? '…'}</strong>
                </span>
              </div>

              {checkResult !== null &&
                (checkResult.error !== undefined ? (
                  <p className="error" role="alert">
                    {checkResult.error}
                  </p>
                ) : checkResult.updateAvailable ? (
                  <p className="text-warn">
                    Versão {checkResult.latestVersion} disponível — veja o aviso no Início.
                  </p>
                ) : (
                  <p className="ok" role="status">
                    Você está na versão mais recente ({checkResult.currentVersion}).
                  </p>
                ))}

              <p className="hint-note">
                O download e a instalação acontecem pelo botão no Início; a versão só é trocada quando você clica
                em Reiniciar e atualizar.
              </p>

              <RollbackSection />
            </form>
          </div>
        </div>
      </section>
    </section>
  );
}

/** Seção de rollback: lista versões anteriores no canal e permite voltar. */
function RollbackSection() {
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<{ version: string; url: string }[] | null>(null);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState('');

  async function loadVersions(): Promise<void> {
    setBusy(true);
    setError('');
    setDetail('');
    try {
      const result = await window.staffhub.updater.listAvailableVersions();
      setVersions(result.versions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function rollback(version: string, url: string): Promise<void> {
    if (!window.confirm(`Voltar para a versão ${version}? O hub vai baixar e reiniciar na versão anterior.`)) return;
    setBusy(true);
    setDetail('');
    try {
      const result = await window.staffhub.updater.prepareVersion(version, url, '');
      if (result.ok) {
        await window.staffhub.updater.restartToUpdate();
      } else {
        setDetail(result.detail);
      }
    } catch (err) {
      setDetail(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <p className="field-label">Versões anteriores</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadVersions()} disabled={busy}>
          <RotateCcw size={14} aria-hidden="true" />
          {busy ? 'Verificando…' : 'Ver versões anteriores'}
        </button>
        {versions?.map((v) => (
          <button
            key={v.version}
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void rollback(v.version, v.url)}
            disabled={busy}
          >
            Voltar para {v.version}
          </button>
        ))}
      </div>
      {versions?.length === 0 && <p className="muted">Nenhuma versão anterior disponível no canal.</p>}
      {error !== '' && <p className="error" role="alert">{error}</p>}
      {detail !== '' && <p className="error" role="alert">{detail}</p>}
    </div>
  );
}
