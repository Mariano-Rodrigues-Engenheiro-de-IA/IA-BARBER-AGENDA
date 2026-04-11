import React from "react";

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    // Ignore DOM manipulation errors caused by browser extensions (e.g. auto-translate)
    if (
      error.message?.includes("removeChild") ||
      error.message?.includes("insertBefore") ||
      error.message?.includes("NotFoundError")
    ) {
      console.warn("[ErrorBoundary] DOM mutation conflict (likely browser extension). Recovering...");
      this.setState({ hasError: false });
      return;
    }
    console.error("[ErrorBoundary]", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4">
          <div className="glass-card p-8 text-center max-w-md space-y-4">
            <h2 className="text-xl font-bold text-foreground">Algo deu errado</h2>
            <p className="text-muted-foreground">Ocorreu um erro inesperado.</p>
            <button
              onClick={() => {
                this.setState({ hasError: false });
                window.location.reload();
              }}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors"
            >
              Recarregar página
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
