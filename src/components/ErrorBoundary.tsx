import { Component, type ErrorInfo, type ReactNode } from "react";
/**
 * Keeps a rendering error from leaving a blank window. The gateway keeps
 * running underneath, so reloading the window loses nothing.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Wagate could not draw this screen", error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="crash-screen">
        <div className="panel">
          <h2>Something went wrong on this screen</h2>
          <p className="muted">
            WhatsApp stays connected and nothing was lost. Reload to carry on.
          </p>
          <pre className="crash-detail">{this.state.error.message}</pre>
          <button onClick={() => window.location.reload()}>Reload Wagate</button>
        </div>
      </div>
    );
  }
}
