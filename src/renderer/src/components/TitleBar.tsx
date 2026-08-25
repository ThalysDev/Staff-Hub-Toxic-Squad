import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { BRAND_LOGO_SQUARE } from '../assets';

/**
 * Titlebar personalizada (frame:false na janela): barra arrastável com a logo
 * e o nome do app + controles minimizar/maximizar/fechar no tema pergaminho.
 * Região drag segue a doc do Electron (app-region); botões são no-drag.
 */
export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.staffhub.window.isMaximized().then((value) => {
      if (!cancelled) setMaximized(value);
    }).catch(() => undefined);
    const unsubscribe = window.staffhub.events.onWindowMaxChanged(setMaximized);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    <header className="titlebar" role="banner" aria-label="Barra de título">
      <div className="titlebar-brand">
        <img src={BRAND_LOGO_SQUARE} alt="" width={18} height={18} style={{ borderRadius: 4 }} />
        <span className="titlebar-title">Staff Hub Toxic Squad</span>
      </div>
      <div className="titlebar-actions">
        <button
          type="button"
          className="titlebar-btn"
          title="Minimizar"
          aria-label="Minimizar"
          onClick={() => void window.staffhub.window.minimize()}
        >
          <Minus size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="titlebar-btn"
          title={maximized ? 'Restaurar' : 'Maximizar'}
          aria-label={maximized ? 'Restaurar' : 'Maximizar'}
          onClick={() => void window.staffhub.window.toggleMaximize().then(setMaximized).catch(() => undefined)}
        >
          {maximized ? <Copy size={12} aria-hidden="true" /> : <Square size={11} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-btn--close"
          title="Fechar"
          aria-label="Fechar"
          onClick={() => void window.staffhub.window.close()}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
