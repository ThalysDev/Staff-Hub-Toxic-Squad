import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { FilterPreset } from '@shared/filter-presets';
import {
  MAX_PRESET_NAME_LENGTH,
  listPresets,
  parsePresets,
  removePreset,
  serializePresets,
  upsertPreset,
} from '@shared/filter-presets';
import { useToast } from '../hooks/useToast';
import ToastViewport from './Toast';

export interface PresetManagerProps {
  /** Módulo de preferências onde o preset persiste ('sg1'|'sg2'). */
  module: 'sg1' | 'sg2';
  /** Distingue conjuntos de presets no MESMO módulo (ex.: 'consulta', 'fullsemi'). */
  scope: string;
  /** Campos atuais do formulário para salvar (objeto raso string→string). */
  currentFields: Record<string, string>;
  /** Aplica os campos do preset na página. */
  onApply: (fields: Record<string, string>) => void;
  /** Rótulo humano (ex.: "da consulta"). */
  label?: string;
}

/** Callout de falha: título curto + mensagem PT-BR do rules/IPC. */
interface PresetCallout {
  title: string;
  message: string;
}

/**
 * Gerenciador de presets de filtro nomeados (salvar/carregar/excluir) para as
 * páginas SG_1/SG_2. Genérico: um conjunto por `scope`, tudo persistido em UMA
 * única chave de preferência `presets:${scope}` do módulo — o merge raso do
 * store garante que chaves alheias do módulo nunca são tocadas.
 *
 * - Mount: `preferences.get(module)` → `parsePresets`; JSON corrompido vira
 *   callout--danger + lista vazia (o app não crasha por lixo no disco).
 * - Salvar: `upsertPreset` + `serializePresets` + `preferences.save` — erros de
 *   cap do rules (nome, campos, coleção, tamanho do JSON) e do IPC aparecem em
 *   callout PT-BR. A lista recarrega mantendo o salvo selecionado.
 * - Aplicar: `onApply(fields)` + toast ok.
 * - Excluir: `removePreset` + persist (com window.confirm); seleção volta a vazia.
 */
export default function PresetManager({ module, scope, currentFields, onApply, label }: PresetManagerProps): JSX.Element {
  const { toasts, push, dismiss } = useToast();

  // Coleção viva (objeto por nome trimado) — fonte de verdade local após o mount.
  const [presets, setPresets] = useState<Record<string, FilterPreset>>({});
  // Nome do preset selecionado no select ('' = nenhum).
  const [selected, setSelected] = useState('');
  // Texto do input de nome para salvar o preset atual.
  const [nameText, setNameText] = useState('');
  // Falha do carregamento (parse corrompido / IPC) — callout--danger no topo.
  const [loadError, setLoadError] = useState<PresetCallout | null>(null);
  // Falha de salvar/excluir — callout--danger transitório.
  const [actionError, setActionError] = useState<PresetCallout | null>(null);
  // IPC em voo: trava os botões contra duplo clique.
  const [busy, setBusy] = useState<'saving' | 'deleting' | null>(null);

  /** Lista para o select: savedAt mais recente primeiro (listPresets). */
  const list = useMemo(() => listPresets(presets), [presets]);

  // IDs estáveis por instância (module+scope) para label/aria do select e input.
  const idBase = `prst-${module}-${scope.replace(/[^a-zA-Z0-9]+/g, '-')}`;
  // Sufixo humano das mensagens: "… da consulta" quando há label.
  const labelSuffix = label === undefined || label === '' ? '' : ` ${label}`;

  // Hidratação no mount/troca de module|scope: UMA leitura, UMA chave.
  useEffect(() => {
    let cancelled = false;
    setSelected('');
    setLoadError(null);
    setActionError(null);
    const bridge = window.staffhub.preferences;
    if (!bridge) {
      // Preload sem o contrato de preferences: fail-soft com lista vazia.
      console.warn(`[PresetManager] bridge sem "preferences"; presets de "${scope}" iniciam vazios.`);
      setPresets({});
      return () => {
        cancelled = true;
      };
    }
    bridge
      .get(module)
      .then((stored) => {
        if (cancelled) return;
        const raw = stored[`presets:${scope}`];
        if (raw === undefined || raw === '' || raw === null) {
          setPresets({});
          return;
        }
        if (typeof raw !== 'string') {
          setLoadError({
            title: 'Presets corrompidos',
            message: `A chave "presets:${scope}" guardou ${typeof raw} em vez de texto JSON — os presets${labelSuffix} foram descartados. Salvar um preset novo substitui o conteúdo corrompido.`,
          });
          setPresets({});
          return;
        }
        try {
          setPresets(parsePresets(raw));
        } catch (error) {
          // fail-closed do parse vira aviso claro — a página continua de pé.
          setLoadError({
            title: 'Presets corrompidos',
            message: `${error instanceof Error ? error.message : String(error)} Os presets${labelSuffix} foram descartados nesta sessão; salvar um preset novo substitui o conteúdo corrompido.`,
          });
          setPresets({});
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError({
          title: 'Não foi possível carregar os presets',
          message: error instanceof Error ? error.message : String(error),
        });
        setPresets({});
      });
    return () => {
      cancelled = true;
    };
  }, [module, scope, labelSuffix]);

  /** Persiste a coleção inteira na única chave do scope (merge raso no main). */
  async function persist(next: Record<string, FilterPreset>): Promise<void> {
    await window.staffhub.preferences.save(module, { [`presets:${scope}`]: serializePresets(next) });
  }

  function handleApply(): void {
    const preset = selected === '' ? undefined : presets[selected];
    if (preset === undefined) return;
    // Cópia rasa: quem aplica não ganha referência ao estado interno.
    onApply({ ...preset.fields });
    push('ok', `Preset "${preset.name}" aplicado${labelSuffix}.`);
  }

  async function handleSave(): Promise<void> {
    const name = nameText.trim();
    if (name === '' || busy !== null) return;
    setBusy('saving');
    setActionError(null);
    try {
      const next = upsertPreset(presets, { name, fields: { ...currentFields }, savedAt: new Date().toISOString() });
      await persist(next);
      setPresets(next);
      setSelected(name); // mantém o salvo selecionado após recarregar a lista
      setNameText('');
      setLoadError(null); // o disco voltou a ter JSON válido
      push('ok', `Preset "${name}" salvo${labelSuffix}.`);
    } catch (error) {
      // Caps do rules (nome/campos/coleção/tamanho) ou falha de IPC — PT-BR.
      setActionError({
        title: 'Não foi possível salvar o preset',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(): Promise<void> {
    const preset = selected === '' ? undefined : presets[selected];
    if (preset === undefined || busy !== null) return;
    if (!window.confirm(`Excluir o preset "${preset.name}"${labelSuffix}? Esta ação não pode ser desfeita.`)) return;
    setBusy('deleting');
    setActionError(null);
    try {
      const next = removePreset(presets, preset.name);
      await persist(next);
      setPresets(next);
      setSelected(''); // seleção volta a vazia
      setLoadError(null);
      push('ok', `Preset "${preset.name}" excluído${labelSuffix}.`);
    } catch (error) {
      setActionError({
        title: 'Não foi possível excluir o preset',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  }

  const buttonsDisabled = busy !== null;

  return (
    <div className="prst">
      {loadError !== null && (
        <div className="callout callout--danger prst-callout" role="alert">
          <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
          <div className="callout-body">
            <p className="callout-title">{loadError.title}</p>
            <p>{loadError.message}</p>
          </div>
        </div>
      )}
      {actionError !== null && (
        <div className="callout callout--danger prst-callout" role="alert">
          <AlertTriangle size={18} className="callout-icon" aria-hidden="true" />
          <div className="callout-body">
            <p className="callout-title">{actionError.title}</p>
            <p>{actionError.message}</p>
          </div>
        </div>
      )}
      <div className="prst-row">
        {list.length === 0 ? (
          <p className="muted prst-empty">Nenhum preset salvo ainda.</p>
        ) : (
          <select
            id={`${idBase}-select`}
            className="select prst-select"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            aria-label={label === undefined || label === '' ? 'Preset de filtro' : `Preset ${label}`}
            disabled={buttonsDisabled}
          >
            <option value="">Selecione um preset…</option>
            {list.map((preset) => (
              <option key={preset.name} value={preset.name}>
                {preset.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="btn btn-sm prst-apply"
          onClick={handleApply}
          disabled={selected === '' || buttonsDisabled}
        >
          Aplicar
        </button>
        <input
          id={`${idBase}-name`}
          className="input prst-name"
          type="text"
          value={nameText}
          onChange={(event) => setNameText(event.target.value)}
          placeholder="Nome do preset"
          maxLength={MAX_PRESET_NAME_LENGTH}
          aria-label={label === undefined || label === '' ? 'Nome do novo preset de filtro' : `Nome do novo preset ${label}`}
          autoComplete="off"
          disabled={buttonsDisabled}
        />
        <button
          type="button"
          className="btn btn-sm prst-save"
          onClick={() => void handleSave()}
          disabled={nameText.trim() === '' || buttonsDisabled}
        >
          Salvar atual
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm prst-delete"
          onClick={() => void handleDelete()}
          disabled={selected === '' || buttonsDisabled}
        >
          Excluir
        </button>
        <span className="prst-count" title={`${list.length} preset(s) salvo(s)${labelSuffix}`}>
          {list.length}
        </span>
      </div>
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
