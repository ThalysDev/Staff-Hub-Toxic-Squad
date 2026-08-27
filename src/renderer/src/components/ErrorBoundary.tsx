import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error Boundary da raiz do renderer: qualquer exceção num componente React
 * (parser malformado, estado inesperado, divide by zero) mostra uma tela de
 * recuperação em vez de TELA BRANCA — o estado da OP montada é preservado
 * porque as páginas SG nunca desmontam (U1); o boundary não as destrói.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Best-effort: registrar no console para diagnóstico (sem IPC que pode
    // também estar quebrado).
    console.error('[ErrorBoundary]', error.message, errorInfo.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleDismiss = (): void => {
    this.setState({ hasError: false, error: null });
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
