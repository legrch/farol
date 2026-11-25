import { describe, expect, it, vi } from "vitest";
import type { InstalledUpdateView } from "../../../src/modules/release/contract/installed-update";
import { createUpdateDockAttention } from "./attention";

const view = (phase: string, version = "1.2.3") =>
  ({ phase, version, deferred: false }) as unknown as InstalledUpdateView;

function fixture(enabled = true, focused = false) {
  const state = { focused };
  const bounce = vi.fn();
  const notify = createUpdateDockAttention({
    enabled,
    focused: () => state.focused,
    bounce,
  });
  return { state, bounce, notify };
}

describe("update Dock attention", () => {
  it("bounces once per version across available and ready", () => {
    const f = fixture();
    f.notify(view("available"));
    f.notify(view("available"));
    f.notify(view("ready"));
    expect(f.bounce).toHaveBeenCalledOnce();
    f.notify(view("available", "1.2.4"));
    expect(f.bounce).toHaveBeenCalledTimes(2);
  });
  it("ignores other phases", () => {
    const f = fixture();
    for (const phase of ["idle", "checking", "downloading", "applying"])
      f.notify(view(phase));
    expect(f.bounce).not.toHaveBeenCalled();
  });
  it("stays quiet while focused and bounces later once unfocused", () => {
    const f = fixture(true, true);
    f.notify(view("available"));
    expect(f.bounce).not.toHaveBeenCalled();
    f.state.focused = false;
    f.notify(view("ready"));
    expect(f.bounce).toHaveBeenCalledOnce();
  });
  it("never bounces when disabled (hidden, test or E2E)", () => {
    const f = fixture(false);
    f.notify(view("available"));
    expect(f.bounce).not.toHaveBeenCalled();
  });
});
