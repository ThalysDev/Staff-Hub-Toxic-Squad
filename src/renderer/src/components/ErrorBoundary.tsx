import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  /** Pilha de componentes (componentDidCatch) — diagnósticos sem console. */
  componentStack: string | null;
}

/** Stack técnico truncado para a tela (o resto continua no console). */
function clip(text: string, max = 6000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncado)`;
}

/**
 * Error Boundary da raiz do renderer: qualquer exceção num componente React
 * (parser malformado, estado inesperado, divide by zero) mostra uma tela de
 * recuperação em vez de TELA BRANCA — o estado da OP montada é preservado
 * porque as páginas SG nunca desmontam (U1); o boundary não as destrói.
 * v0.32: o stack completo (erro + componentes) fica visível em "Detalhes
 * técnicos" — sem isso, "Maximum call stack size exceeded" chegava à staff
 * sem NENHUMA pista de onde veio.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, componentStack: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error, componentStack: null };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Best-effort: registrar no console para diagnóstico (sem IPC que pode
    // também estar quebrado) e guardar a pilha de componentes para a tela.
    console.error('[ErrorBoundary]', error.message, errorInfo.componentStack);
    this.setState({ componentStack: errorInfo.componentStack ?? null });
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleDismiss = (): void => {
    this.setState({ hasError: false, error: null, componentStack: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="error-boundary" role="alert">
          <div className="error-boundary-card">
            <h1>Algo quebrou nesta tela</h1>
            <p className="muted">
              Um erro inesperado aconteceu. Seus dados (distribuição, agenda, grupos) estão
              preservados nas páginas SG — o erro é apenas visual.
            </p>
            {this.state.error !== null && (
              <pre className="sg7-code">{this.state.error.message}</pre>
            )}
            <details style={{ marginTop: 8, fontSize: 12 }}>
              <summary className="muted">Detalhes técnicos (mande o print para a staff)</summary>
              <pre className="sg7-code" style={{ maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                {this.state.error?.stack ? `${clip(this.state.error.stack)}\n\n` : ''}
                {this.state.componentStack !== null ? `— componentes —\n${clip(this.state.componentStack)}` : ''}
              </pre>
            </details>
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button type="button" className="btn" onClick={this.handleDismiss}>
                Tentar continuar
              </button>
              <button type="button" className="btn btn-ghost" onClick={this.handleReload}>
                Recarregar o hub
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
