import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { ArrowRight, ChevronDown, Loader2, Save, Star, Trash2 } from 'lucide-react';
import { MP_PLACEHOLDERS, sortTemplatesNewestFirst } from '@shared/mp-templates-rules';
import type { MpTemplateEntry } from '@shared/mp-templates-rules';
import { useToast } from '../hooks/useToast';
import Callout from './Callout';

/**
 * Biblioteca de templates de MP (CRUD pelo bridge window.staffhub.templates),
 * compartilhada pelo SG_6 (assunto+corpo) e pelo SG_4 (só corpo — template de
 * comunicação da OP). Seção colapsável (fechada por padrão): listar, aplicar,
 * definir padrão, excluir (window.confirm) e "salvar atual como template".
 *
 * Sem auto-apply no mount DE PROPÓSITO: se a página quiser partir do template
 * padrão, ela mesma chama templates.list() no seu mount (ou guarda o default
 * num ref interno dela) e aplica nos próprios campos quando quiser — este
 * componente só expõe as ações explícitas do usuário.
 */

/** Mensagem PT-BR de um erro desconhecido (IPC/offline), com fallback claro. */
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback;
}

export interface TemplateLibraryProps {
  /** 'sg6' = assunto+corpo; 'sg4' = só corpo (template de comunicação da OP). */
  variant: 'sg6' | 'sg4';
  /** Estado atual do assunto no campo da página — ignorado quando variant='sg4'. */
  currentSubject: string;
  /** Estado atual do corpo no campo da página (fonte do "salvar como template"). */
  currentBody: string;
  /** Aplica um template nos campos da página (subject sempre '' no variant 'sg4'). */
  onApply: (subject: string, body: string) => void;
}

export default function TemplateLibrary({
  variant,
  currentSubject,
  currentBody,
  onApply,
}: TemplateLibraryProps): JSX.Element {
  const { push } = useToast();

  /** Colapsada por padrão — a biblioteca é acessório, não o foco da página. */
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<MpTemplateEntry[]>([]);
  const [loading, setLoading] = useState(false);
  /** Uma mutação IPC por vez (salvar/padrão/excluir) — evita clique duplo. */
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  /** Último erro PT-BR (rules/IPC) em forma de callout; null = sem erro. */
  const [actionError, setActionError] = useState<string | null>(null);

  /** Guarda de setState pós-unmount (list() resolve depois da página sumir). */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const list = await window.staffhub.templates.list();
      if (!mountedRef.current) return;
      // O store já devolve mais recente primeiro; reordena aqui por garantia.
      setTemplates(sortTemplatesNewestFirst(list));
      setActionError(null);
    } catch (error) {
      if (!mountedRef.current) return;
      const message = errorMessage(error, 'Falha ao carregar a biblioteca de templates.');
      setActionError(message);
      push('error', `Biblioteca de templates: ${message}`);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [push]);

  // Carrega no mount (mesmo colapsada — o contador do cabeçalho já aparece).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Salva o conteúdo atual dos campos da página como um novo template. */
  async function saveCurrent(): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      const saved = await window.staffhub.templates.save({
        name: newName,
        // SG_4 é só corpo: sem chave subject, a sanitização o trata como ausente.
        ...(variant === 'sg6' ? { subject: currentSubject } : {}),
        body: currentBody,
      });
      if (!mountedRef.current) return;
      setNewName('');
      push('ok', `Template "${saved.name}" salvo na biblioteca.`);
      await refresh();
    } catch (error) {
      if (!mountedRef.current) return;
      // Erro PT-BR do rules (nome/corpo vazos, biblioteca cheia…) vira callout.
      const message = errorMessage(error, 'Falha ao salvar o template.');
      setActionError(message);
      push('error', `Biblioteca de templates: ${message}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  function applyTemplate(entry: MpTemplateEntry): void {
    onApply(variant === 'sg6' ? entry.subject ?? '' : '', entry.body);
    push('ok', `Template "${entry.name}" aplicado.`);
  }

  async function makeDefault(entry: MpTemplateEntry): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await window.staffhub.templates.setDefault(entry.id);
      if (!mountedRef.current) return;
      push('ok', `Template "${entry.name}" definido como padrão.`);
      await refresh();
    } catch (error) {
      if (!mountedRef.current) return;
      const message = errorMessage(error, 'Falha ao definir o template padrão.');
      setActionError(message);
      push('error', `Biblioteca de templates: ${message}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function removeEntry(entry: MpTemplateEntry): Promise<void> {
    if (!window.confirm(`Remover o template "${entry.name}"? Esta ação não pode ser desfeita.`)) return;
    setBusy(true);
    setActionError(null);
    try {
      // Remoção idempotente no main: corrida de UI (lista desatualizada) é no-op.
      await window.staffhub.templates.remove(entry.id);
      if (!mountedRef.current) return;
      push('ok', `Template "${entry.name}" removido da biblioteca.`);
      await refresh();
    } catch (error) {
      if (!mountedRef.current) return;
      const message = errorMessage(error, 'Falha ao remover o template.');
      setActionError(message);
      push('error', `Biblioteca de templates: ${message}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <section className="tmpl page-section" aria-labelledby="tmpl-toggle">
      <div className="card">
        <h2 className="tmpl-heading">
          <button
            type="button"
            id="tmpl-toggle"
            className="tmpl-toggle"
            aria-expanded={open}
            aria-controls="tmpl-panel"
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronDown size={16} className={open ? 'tmpl-chevron is-open' : 'tmpl-chevron'} aria-hidden="true" />
            <span>Biblioteca de templates</span>
            {loading && <Loader2 size={14} className="tmpl-spinner" aria-hidden="true" />}
            {templates.length > 0 && <span className="muted tmpl-count">{templates.length}</span>}
          </button>
        </h2>

        {open && (
          <div className="card-body tmpl-panel" id="tmpl-panel">
            {/* ===== Salvar atual como template ===== */}
            <div className="tmpl-save">
              <input
                className="input"
                placeholder="Nome do template (1–50 caracteres)"
                aria-label="Nome do novo template"
                value={newName}
                maxLength={50}
                onChange={(event) => setNewName(event.target.value)}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy || loading}
                onClick={() => void saveCurrent()}
              >
                <Save size={14} aria-hidden="true" />
                Salvar atual como template
              </button>
            </div>
            <p className="muted tmpl-save-hint">
              {variant === 'sg6'
                ? 'Salva o assunto e o corpo atuais dos campos desta página.'
                : 'Salva o corpo atual do campo desta página (sem assunto).'}
            </p>

            {actionError !== null && (
              <Callout variant="danger" title="Biblioteca de templates">
                <p>{actionError}</p>
              </Callout>
            )}

            {/* ===== Lista ===== */}
            {loading && templates.length === 0 ? (
              <p className="muted">Carregando templates…</p>
            ) : templates.length === 0 ? (
              <p className="muted">
                Nenhum template salvo ainda — preencha os campos da página e use "Salvar atual como template".
              </p>
            ) : (
              <ul className="tmpl-list" aria-busy={loading}>
                {templates.map((entry) => (
                  <li key={entry.id} className="tmpl-row">
                    <span className="tmpl-name">{entry.name}</span>
                    {variant === 'sg6' && entry.subject !== undefined && (
                      <span className="muted tmpl-subject">{entry.subject}</span>
                    )}
                    {entry.isDefault && (
                      <span className="tmpl-badge">
                        <Star size={12} aria-hidden="true" /> padrão
                      </span>
                    )}
                    <span className="tmpl-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy || loading}
                        onClick={() => applyTemplate(entry)}
                      >
                        <ArrowRight size={14} aria-hidden="true" />
                        Aplicar
                      </button>
                      {!entry.isDefault && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={busy || loading}
                          onClick={() => void makeDefault(entry)}
                        >
                          <Star size={14} aria-hidden="true" />
                          Definir padrão
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-ghost--danger btn-sm"
                        disabled={busy || loading}
                        onClick={() => void removeEntry(entry)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                        Remover template
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {/* ===== Documentação dos placeholders ===== */}
            <div className="tmpl-placeholders">
              <p className="muted">Placeholders substituídos no envio:</p>
              <ul className="muted">
                {MP_PLACEHOLDERS.map((placeholder) => (
                  <li key={placeholder.token}>
                    <code>{placeholder.token}</code> — {placeholder.description}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>

    </section>
  );
}
