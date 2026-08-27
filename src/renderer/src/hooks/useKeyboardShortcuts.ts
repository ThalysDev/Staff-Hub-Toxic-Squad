import { useEffect } from 'react';
import type { PageId } from '../modules';
import { MODULES } from '../modules';

/**
 * Atalhos globais de teclado:
 * - Ctrl+K abre/alterna a paleta de comandos
 * - Alt+1..7 navega direto para os módulos SG_1..SG_7
 * - Alt+8 vai para a Sala de Guerra · Alt+9 volta ao Início
 * - Esc fecha modais/painéis de confirmação (delegado ao componente ativo)
 */
export function useKeyboardShortcuts(
  onNavigate: (page: PageId) => void,
  onTogglePalette: () => void = () => undefined,
): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      // Ctrl+K: paleta de comandos (navegação + ações rápidas).
      if (event.ctrlKey === true && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onTogglePalette();
        return;
      }

      // Alt+1..8: navegação rápida (não interferir com Alt+Tab do SO)
      if (event.altKey === true && event.ctrlKey === false && event.shiftKey === false) {
        const key = event.key;
        if (key >= '1' && key <= '7') {
          const index = Number(key) - 1;
          const module = MODULES[index];
          if (module !== undefined) {
            event.preventDefault();
            onNavigate(module.id);
          }
        } else if (key === '8') {
          event.preventDefault();
          onNavigate('guerra');
        } else if (key === '9') {
          event.preventDefault();
          onNavigate('dashboard');
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [onNavigate, onTogglePalette]);
}
