import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { isStartupRecoveryDocument } from "../../apps/desktop/renderer/recovery/entry";
import { StartupRecovery } from "../../apps/desktop/renderer/recovery/view";

// React/document fixture only; native startup and predecessor custody need E2E.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("explains the paused state and exposes only the explicit Quit action", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host),
    quit = vi.fn();
  try {
    await act(async () => root.render(<StartupRecovery quit={quit} />));
    expect(host.querySelector("h1")?.textContent).toBe(
      "Your previous session needs recovery",
    );
    expect(host.textContent).toContain(
      "Your settings and work records have been kept.",
    );
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(host.querySelectorAll("iframe, a, input")).toHaveLength(0);
    await act(async () => host.querySelector("button")!.click());
    expect(quit).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("admits recovery rendering only for its fixed local document fragment", () => {
  expect(
    isStartupRecoveryDocument(
      new URL("file:///fixture/shell.html#farol-startup-recovery"),
    ),
  ).toBe(true);
  for (const url of [
    "https://example.invalid/shell.html#farol-startup-recovery",
    "file:///fixture/other.html#farol-startup-recovery",
    "file:///fixture/shell.html?recovery=1#farol-startup-recovery",
    "file:///fixture/shell.html",
    "file://remote/shell.html#farol-startup-recovery",
  ]) {
    expect(isStartupRecoveryDocument(new URL(url))).toBe(false);
  }
});
