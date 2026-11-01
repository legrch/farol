import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { RendererFacade } from "../../src/ui/renderer/contract";
import { PreviousSelfTests } from "../../src/ui/renderer/previous-self-tests";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("clears the previous report while a different original result fails to load", async () => {
  const a = {
    operationId: "e0b07fee-f300-46c6-a6e0-33a31aa25639",
    workspaceId: "ws",
    computerGeneration: "1",
    planVersion: "2" as const,
  };
  const b = { ...a, operationId: "44444444-4444-4444-8444-444444444444" };
  let rejectB!: (error: Error) => void;
  const pendingB = new Promise((_, reject) => {
    rejectB = reject;
  });
  const selfTest = vi.fn(
    async (command: { kind: string; selection?: typeof a }) => {
      if (command.kind === "history")
        return {
          ok: true,
          kind: "history",
          history: {
            markers: [],
            records: [{ selection: a, phase: "completed" }],
            unresolved: [b],
          },
        };
      if (command.selection?.operationId === b.operationId) return pendingB;
      return {
        ok: true,
        kind: "observe",
        observation: {
          selection: a,
          state: "observed",
          report: {
            ...a,
            status: "partial",
            steps: [{ name: "scratch", status: "pass" }],
          },
        },
      };
    },
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <PreviousSelfTests
          facade={{ selfTest } as unknown as RendererFacade}
          workspaces={[{ workspaceId: "ws", label: "Test" }]}
        />,
      ),
    );
    await act(async () => host.querySelector("button")!.click());
    const views = host.querySelectorAll<HTMLButtonElement>("p button");
    await act(async () => views[0]!.click());
    expect(host.textContent).toContain("scratch · pass");
    expect(host.textContent).toContain(`observed · ${a.operationId}`);

    await act(async () => views[1]!.click());
    expect(host.textContent).not.toContain("scratch · pass");
    expect(host.textContent).not.toContain(`observed · ${a.operationId}`);
    await act(async () => rejectB(new Error("unavailable")));
    expect(host.textContent).toContain("Previous test results are unavailable");
    expect(host.textContent).not.toContain("scratch · pass");
    expect(host.textContent).toContain(`completed · ${a.operationId}`);
    expect(host.textContent).toContain(`outcome_unknown · ${b.operationId}`);
    expect(selfTest.mock.calls.map(([command]) => command.kind)).toEqual([
      "history",
      "observe",
      "observe",
    ]);
    await act(async () =>
      root.render(
        <PreviousSelfTests
          facade={{ selfTest } as unknown as RendererFacade}
          workspaces={[{ workspaceId: "other", label: "Other" }]}
        />,
      ),
    );
    expect(host.textContent).not.toContain(a.operationId);
    expect(host.textContent).not.toContain(b.operationId);
    expect(host.textContent).not.toContain("scratch · pass");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
