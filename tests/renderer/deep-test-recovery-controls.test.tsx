import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DeepTestPrompt } from "../../src/ui/renderer/deep-test-prompt";
import type {
  RendererFacade,
  WindowSnapshot,
} from "../../src/ui/renderer/contract";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("permits a status read while the original run reply remains pending", async () => {
  const id = "deep-test:run:44444444-4444-4444-8444-444444444444";
  const snapshot = {
    intents: { [id]: { id, state: "pending", code: null, inFlight: true } },
  } as unknown as WindowSnapshot;
  const configure = vi.fn(async (_command: unknown, _intention: string) => ({
    id: "read",
    state: "applied",
    code: null,
  }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <DeepTestPrompt
          snapshot={snapshot}
          facade={{ configure } as unknown as RendererFacade}
        />,
      ),
    );
    const button = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === "Review test results",
    )!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(configure).toHaveBeenCalledOnce();
    expect(configure.mock.calls[0]?.[0]).toEqual({
      kind: "chatgpt.deep-test-status",
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
