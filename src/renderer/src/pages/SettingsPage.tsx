import { useEffect, useState } from 'react';
import type { AppSettings } from '@shared/ipc-types';

interface SettingsDraft {
  requestMinIntervalMs: string;
  requestJitterMs: string;
  requestCeiling: string;
  dryRun: boolean;
}

type FormMessage = { kind: 'error' | 'ok'; text: string };

function toDraft(settings: AppSettings): SettingsDraft {
  return {
    requestMinIntervalMs: String(settings.requestMinIntervalMs),
    requestJitterMs: String(settings.requestJitterMs),
    requestCeiling: String(settings.requestCeiling),
    dryRun: settings.dryRun,
  };
}

function isValidDraft(draft: SettingsDraft): boolean {
  const min = Number(draft.requestMinIntervalMs);
  const jitter = Number(draft.requestJitterMs);
  const ceiling = Number(draft.requestCeiling);
  return (
    Number.isFinite(min) && min > 0 &&
    Number.isFinite(jitter) && jitter >= 0 &&
    Number.isFinite(ceiling) && ceiling > 0
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<FormMessage | null>(null);

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
        if (!cancelled) setMessage({ kind: 'error', text: 'Não foi possível carregar as configurações.' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave(): Promise<void> {
    if (!settings || !draft || !isValidDraft(draft)) return;

    const min = Number(draft.requestMinIntervalMs);
    const jitter = Number(draft.requestJitterMs);
    const ceiling = Number(draft.requestCeiling);

    const patch: Partial<AppSettings> = {};
    if (min !== settings.requestMinIntervalMs) patch.requestMinIntervalMs = min;
    if (jitter !== settings.requestJitterMs) patch.requestJitterMs = jitter;
    if (ceiling !== settings.requestCeiling) patch.requestCeiling = ceiling;
    if (draft.dryRun !== settings.dryRun) patch.dryRun = draft.dryRun;

    setSaving(true);
    setMessage(null);
    try {
      const updated = await window.staffhub.settings.update(patch);
      setSettings(updated);
      setDraft(toDraft(updated));
      setMessage({ kind: 'ok', text: 'Configurações salvas.' });
    } catch {
      setMessage({ kind: 'error', text: 'Não foi possível salvar as configurações.' });
    } finally {
      setSaving(false);
    }
  }

  if (!settings || !draft) {
    return (
      <section>
        <h1>Configurações</h1>
        <p className="muted">Carregando…</p>
      </section>
    );
  }

  return (
    <section>
      <h1>Configurações</h1>
      <div className="card">
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <div className="field">
            <label htmlFor="requestMinIntervalMs">Intervalo mínimo entre requisições (ms)</label>
            <input
              id="requestMinIntervalMs"
              className="input"
              type="number"
              min={1}
              value={draft.requestMinIntervalMs}
              onChange={(event) => setDraft({ ...draft, requestMinIntervalMs: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="requestJitterMs">Jitter (ms)</label>
            <input
              id="requestJitterMs"
              className="input"
              type="number"
              min={0}
              value={draft.requestJitterMs}
              onChange={(event) => setDraft({ ...draft, requestJitterMs: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="requestCeiling">Teto de requisições por operação</label>
            <input
              id="requestCeiling"
              className="input"
              type="number"
              min={1}
              value={draft.requestCeiling}
              onChange={(event) => setDraft({ ...draft, requestCeiling: event.target.value })}
            />
          </div>
          <label className="field checkbox-field">
            <input
              type="checkbox"
              checked={draft.dryRun}
              onChange={(event) => setDraft({ ...draft, dryRun: event.target.checked })}
            />
            <span>DRY-RUN (mutações apenas simuladas)</span>
          </label>
          <p className="muted field-hint">Mantenha ligado até validar os fluxos na sua tribo.</p>
          {message && <p className={message.kind === 'error' ? 'error' : 'ok'}>{message.text}</p>}
          <div className="row">
            <button type="submit" className="btn" disabled={saving || !isValidDraft(draft)}>
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}