import { Component, type ReactNode } from "react";

interface Props { children: ReactNode }
interface State { error: Error | null }

/** Attrape les erreurs de rendu React au lieu de laisser un écran blanc. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown): void {
    console.error("[renderer] erreur React:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fatal">
          <h2>Une erreur est survenue</h2>
          <pre>{String(this.state.error)}</pre>
          <button onClick={() => this.setState({ error: null })}>Réessayer</button>
        </div>
      );
    }
    return this.props.children;
  }
}
