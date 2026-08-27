/**
 * CommandPalette — paleta de comandos (Ctrl+K, disparo externo via `open`).
 * Overlay modal com busca fuzzy pt-BR (case/diacríticos-insensível) e
 * navegação por teclado (↑↓ com wrap, Home/End, Enter executa, Esc fecha).
 * O CSS das classes cmdk-* vive em styles/app.css (tema pergaminho).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, KeyboardEvent, MouseEvent } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';

export interface CommandItem {
  id: string;
  label: string;
  /** Texto de apoio exibido sob o label. */
  hint?: string;
  group: 'Navegação' | 'Ações' | 'Sistema';
  /** Palavras extras para a busca (além do label), separadas por espaço. */
  keywords?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: CommandItem[];
}

/** Normaliza texto para busca: caixa baixa + remove diacríticos (NFD). */
function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export default function CommandPalette({
  open,
  onClose,
  commands,
}: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cada abertura recomeça limpa: sem query e seleção no primeiro item.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  // Digitação sempre devolve a seleção ao primeiro resultado.
  useEffect(() => {
    setActive(0);
  }, [query]);

  // Foco garantido no campo de busca (o input remonta a cada abertura).
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Filtro: todas as palavras da query (AND) aparecem como substring em
  // qualquer campo (label + hint + keywords + group). Sem query: tudo,
  // na ordem dada.
  const visible = useMemo<CommandItem[]>(() => {
    const terms = query
      .trim()
      .split(/\s+/)
      .filter((term) => term.length > 0)
      .map(normalizeText);
    if (terms.length === 0) return [...commands];
    return commands.filter((command) => {
      const haystack = normalizeText(
        [command.label, command.hint ?? '', command.keywords ?? '', command.group].join(' '),
      );
      return terms.every((term) => haystack.includes(term));
    });
  }, [commands, query]);

  // A seleção vive num índice "plano" da lista visível; clamp cobre o
  // render intermediário em que a lista encolheu antes do efeito de reset.
  const activeIndex = visible.length > 0 ? Math.min(active, visible.length - 1) : -1;
  const activeCommand = activeIndex >= 0 ? visible[activeIndex] : undefined;
  const activeId = activeCommand !== undefined ? `cmdk-option-${activeIndex}` : undefined;

  // Agrupamento por `group`, preservando a ordem de primeiro aparecimento.
  const groups = useMemo(() => {
    const order: CommandItem['group'][] = [];
    const byGroup = new Map<CommandItem['group'], Array<{ item: CommandItem; index: number }>>();
    visible.forEach((item, index) => {
      const bucket = byGroup.get(item.group);
      if (bucket) bucket.push({ item, index });
      else {
        byGroup.set(item.group, [{ item, index }]);
        order.push(item.group);
      }
    });
    return order.map((group) => ({ group, items: byGroup.get(group) ?? [] }));
  }, [visible]);

  // Item ativo sempre rolado para dentro da área visível da lista.
  useEffect(() => {
    if (!open || activeId === undefined) return;
    document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId, open]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (visible.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((activeIndex + 1) % visible.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((activeIndex - 1 + visible.length) % visible.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(visible.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (activeCommand) {
        activeCommand.run();
        onClose();
      }
    }
  }

  // Clique no fundo escurecido (fora do painel) também fecha.
  function handleOverlayClick(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onClose();
  }

  if (!open) return null;

  return (
    <div className="cmdk-overlay" onClick={handleOverlayClick}>
      <div className="cmdk-panel" role="dialog" aria-modal="true" aria-label="Paleta de comandos">
        <div className="cmdk-input-row">
          <Search size={16} className="cmdk-search-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            className="cmdk-input"
            placeholder="Buscar comando…"
            aria-label="Buscar comando"
            aria-controls="cmdk-list"
            aria-activedescendant={activeId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {visible.length === 0 ? (
          <p className="cmdk-empty muted">Nenhum comando encontrado.</p>
        ) : (
          <div className="cmdk-list" id="cmdk-list" role="listbox" aria-label="Comandos">
            {groups.map(({ group, items }) => (
              <div key={group} className="cmdk-group">
                <div className="cmdk-group-title">{group}</div>
                {items.map(({ item, index }) => {
                  const isActive = index === activeIndex;
                  return (
                    <div
                      key={item.id}
                      id={`cmdk-option-${index}`}
                      role="option"
                      aria-selected={isActive}
                      className={`cmdk-item${isActive ? ' is-active' : ''}`}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => {
                        item.run();
                        onClose();
                      }}
                    >
                      <span className="cmdk-item-text">
                        <span className="cmdk-item-label">{item.label}</span>
                        {item.hint !== undefined ? (
                          <span className="cmdk-item-hint">{item.hint}</span>
                        ) : null}
                      </span>
                      {isActive ? (
                        <CornerDownLeft size={14} className="cmdk-item-enter" aria-hidden="true" />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        <footer className="cmdk-footer">
          <kbd>↑↓</kbd> navegar · <kbd>Enter</kbd> executar · <kbd>Esc</kbd> fechar
        </footer>
      </div>
    </div>
  );
}
