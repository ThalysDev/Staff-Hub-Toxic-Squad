import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Lock, RotateCcw, Save } from 'lucide-react';
import type { AppSettings } from '@shared/ipc-types';
import { DEFAULT_SETTINGS } from '@shared/ipc-types';
import PageHeader from '../components/PageHeader';
import ToastViewport from '../components/Toast';
import { useToast } from '../hooks/useToast';

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
  const { toasts, push, dismiss } = useToast();

  useEffect(() => {
    let cancelled = false;
    void window.staffhub.settings
      .get()
      .then((current) => {
        if (cancelled) return;
        setSettings(current);
        setDraft(toDraft(current));
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
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

  return (
    <section className="page">
      <PageHeader
        kicker="Sistema"
        title="Configurações"
        description="Pacing e limites das requisições ao jogo — proteção contra bloqueio da sua conta."
      />
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
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </section>
  );
}
