import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useActivityNotifications } from "../../apps/desktop/renderer/activity-notifications";
import { unresolvedActions } from "../../apps/desktop/renderer/unresolved-actions";
import { commandAllowed } from "../../src/ui/renderer/command-eligibility";
import { WindowController } from "../../src/ui/renderer/controller";
import type { WindowSnapshot } from "../../src/ui/renderer/contract";
import { fixture } from "./fixture";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  localStorage.clear();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
async function mount() {
  const f = fixture(),
    c = new WindowController(f.api);
  await c.start();
  let snapshot: WindowSnapshot = {
    ...c.getSnapshot(),
    activity: [
      {
        id: "saved-op",
        at: 1,
        source: "Setup",
        kind: "hub.stop",
        label: "hub stop",
        outcome: "unknown",
        target: {},
        operation: null,
        phase: "outcome_unknown",
        code: "BACKEND_UNAVAILABLE",
        durationMs: 1,
        taskId: "",
        turnId: "",
        generation: 0,
      },
    ],
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function View() {
    const n = useActivityNotifications(snapshot);
    return (
      <>
        <output>{n.unread.length}</output>
        <button onClick={() => n.markRead()}>Read</button>
        {n.error && <p>{n.error}</p>}
      </>
    );
  }
  const render = () => act(async () => root.render(<View />));
  await render();
  cleanup.push(async () => {
    await act(async () => root.unmount());
    c.dispose();
  });
  return {
    host,
    f,
    c,
    get snapshot() {
      return snapshot;
    },
    set: async (patch: Partial<WindowSnapshot>) => {
      snapshot = { ...snapshot, ...patch };
      await render();
    },
    remount: async () => {
      await act(async () => root.render(null));
      await render();
    },
    read: () => act(async () => host.querySelector("button")!.click()),
  };
}
it("acknowledges a notification across remount without resolving history or issuing a command", async () => {
  const h = await mount();
  expect(h.host.querySelector("output")!.textContent).toBe("1");
  await h.read();
  await h.remount();
  expect(h.host.querySelector("output")!.textContent).toBe("0");
  expect(unresolvedActions(h.snapshot)).toHaveLength(1);
  expect(h.snapshot.activity[0]!.outcome).toBe("unknown");
  expect(h.f.api.configure).not.toHaveBeenCalled();
});
it("new operation/outcome remains unread and owner profiles never share acknowledgements", async () => {
  const h = await mount();
  await h.read();
  await h.set({
    activity: [{ ...h.snapshot.activity[0]!, code: "NEW_UNKNOWN" }],
  });
  expect(h.host.querySelector("output")!.textContent).toBe("1");
  await h.read();
  const configuration = structuredClone(h.snapshot.configuration);
  if (configuration?.status !== "ready") throw Error("fixture");
  configuration.settings.computer.computerId = "other-computer";
  await h.set({ configuration });
  expect(h.host.querySelector("output")!.textContent).toBe("1");
  await h.set({ activity: [{ ...h.snapshot.activity[0]!, id: "another-op" }] });
  expect(h.host.querySelector("output")!.textContent).toBe("1");
});
it("reading cannot lift an unknown settings fence, even across restart", async () => {
  const h = await mount();
  const configuration = structuredClone(h.snapshot.configuration);
  if (configuration?.status !== "ready") throw Error("fixture");
  configuration.settings.setup.computer.outcomeUnknown = true;
  await h.set({ configuration });
  expect(commandAllowed(h.snapshot, "computer.update-commands")).toBe(false);
  await h.read();
  await h.remount();
  expect(commandAllowed(h.snapshot, "computer.update-commands")).toBe(false);
});
it("does not hide uncertainty when storage fails", async () => {
  const h = await mount();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("full");
  });
  await h.read();
  expect(h.host.textContent).toContain("Read status could not be saved");
  expect(h.host.querySelector("output")!.textContent).toBe("1");
});

it("presents the fresh history observation as an interrupted command without blocking new work", async () => {
  const f = fixture();
  const operations = vi.fn(async () => ({
    entries: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        at: 1,
        source: "Setup",
        kind: "computer_shell_start",
        target: {},
        outcome: "unknown",
        code: "FRESH_SESSION_INTERRUPTED_COMMAND_UNKNOWN",
        durationMs: 0,
      },
    ],
    corruptLines: 0,
    writeFailures: 0,
    droppedEntries: 0,
    unrecordedUncertainEntries: 0,
    unmappedCodes: 0,
  }));
  const controller = new WindowController({ ...f.api, operations });
  try {
    await controller.start();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().activity).toHaveLength(1),
    );
    const snapshot = controller.getSnapshot();
    expect(snapshot.activity[0]!.label).toBe(
      "Interrupted command: outcome unknown",
    );
    const notices = unresolvedActions(snapshot);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      state: "unknown",
      code: "FRESH_SESSION_INTERRUPTED_COMMAND_UNKNOWN",
    });
    expect(notices[0]!.cause).toContain("New work is available");
    expect(commandAllowed(snapshot, "computer.update-commands")).toBe(true);
    expect(f.api.configure).not.toHaveBeenCalled();
  } finally {
    controller.dispose();
  }
});
