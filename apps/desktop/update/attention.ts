import type { InstalledUpdateView } from "../../../src/modules/release/contract/installed-update";

export type DockAttentionPorts = Readonly<{
  /** False in hidden, test and E2E runs: automation must not move the Dock. */
  enabled: boolean;
  /** True while any Farol window has keyboard focus. */
  focused(): boolean;
  /** A non-stealing Dock bounce ("informational"). */
  bounce(): void;
}>;

/**
 * Bounce the Dock once per version when an update becomes available or ready
 * and Farol is in the background. `informational` never takes focus.
 */
export function createUpdateDockAttention(ports: DockAttentionPorts) {
  const announced = new Set<string>();
  return (view: InstalledUpdateView): void => {
    if (view.phase !== "available" && view.phase !== "ready") return;
    if (!ports.enabled || announced.has(view.version)) return;
    if (ports.focused()) return;
    announced.add(view.version);
    ports.bounce();
  };
}
