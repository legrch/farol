import { Component } from "react";
import type { ReactNode } from "react";
export class PanelBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <section role="alert">
        <h2>This view could not be displayed</h2>
        <p>
          Your work continues. Reopen the view to inspect its current state.
        </p>
        <button onClick={() => this.setState({ failed: false })}>
          Reopen view
        </button>
      </section>
    ) : (
      this.props.children
    );
  }
}
