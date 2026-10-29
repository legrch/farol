import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SelfTestPanel } from "../../src/ui/renderer/self-test-panel";
import type { RendererFacade } from "../../src/ui/renderer/contract";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("preserves an unconfirmed selection and observes it without starting again", async () => {
  const selection = {
    operationId: "e0b07fee-f300-46c6-a6e0-33a31aa25639",
    workspaceId: "ws",
    computerGeneration: "1",
    planVersion: "2" as const,
  };
  const selfTest = vi.fn(async (command: { kind: string }) => {
    if (command.kind === "history")
      return {
        ok: true,
        kind: "history",
        history: { markers: [], records: [], unresolved: [] },
      };
    return {
      ok: true,
      kind: command.kind,
      observation: { selection, state: "unknown" },
    };
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <SelfTestPanel
        facade={{ selfTest } as unknown as RendererFacade}
        workspaces={[{ workspaceId: "ws", label: "Test" }]}
      />,
    ),
  );
  const select = host.querySelector("select")!;
  await act(async () => {
    select.value = "ws";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const start = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Run deep test",
  )!;
  expect(start.disabled).toBe(false);
  await act(async () => start.click());
  expect(start.disabled).toBe(true);
  expect(host.textContent).toContain(selection.operationId);
  const observe = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Check original result",
  )!;
  await act(async () => observe.click());
  expect(selfTest.mock.calls.map(([command]) => command.kind)).toEqual([
    "history",
    "start",
    "observe",
  ]);
  expect(start.disabled).toBe(true);
  await act(async () => root.unmount());
  host.remove();
});

it("does not start when history cannot be read", async () => {
  const selfTest = vi.fn(async () => {
    throw new Error("unavailable");
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <SelfTestPanel
        facade={{ selfTest } as unknown as RendererFacade}
        workspaces={[{ workspaceId: "ws", label: "Test" }]}
      />,
    ),
  );
  const select = host.querySelector("select")!;
  await act(async () => {
    select.value = "ws";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.textContent).toContain("Test history is unavailable");
  expect(host.querySelector("button")!.disabled).toBe(true);
  expect(selfTest).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  host.remove();
});
