import { Home } from "../../src/ui/renderer/home";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { OperationsActivity } from "../../apps/desktop/renderer/operations-view";
import { unresolvedActions } from "../../apps/desktop/renderer/unresolved-actions";
import { WindowController } from "../../src/ui/renderer/controller";
import { fixture } from "./fixture";
import type {
  ActivityEntry,
  RendererFacade,
} from "../../src/ui/renderer/contract";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const entries: ActivityEntry[] = [
  {
    id: "one",
    at: 1,
    source: "You",
    kind: "workspace.add",
    label: "workspace add",
    outcome: "done",
    target: { workspace: "Docs" },
    operation: "Docs",
    phase: "done",
    code: null,
    durationMs: 12,
    taskId: "",
    turnId: "",
    generation: 0,
  },
  {
    id: "two",
    at: 2,
    source: "ChatGPT",
    kind: "workspace.read",
    label: "workspace read",
    outcome: "unknown",
    target: { relativePath: "README.md" },
    operation: "README.md",
    phase: "outcome_unknown",
    code: "READ_UNCONFIRMED",
    durationMs: 2,
    taskId: "",
    turnId: "",
    generation: 0,
  },
  {
    id: "three",
    at: 3,
    source: "Codex",
    kind: "model.turn",
    label: "model turn",
    outcome: "pending",
    target: {},
    operation: null,
    phase: "pending",
    code: null,
    durationMs: 3,
    taskId: "",
    turnId: "",
    generation: 0,
  },
];
it("filters shared operations, expands metadata and links attention to the unresolved sheet", async () => {
  const f = fixture(),
    c = new WindowController(f.api);
  await c.start();
  const snapshot = {
    ...c.getSnapshot(),
    activity: entries,
    activityDiagnostics: {
      corruptLines: 1,
      writeFailures: 2,
      droppedEntries: 7,
      unrecordedUncertainEntries: 1,
      unmappedCodes: 4,
    },
  };
  const overlay = vi.fn();
  const facade = { overlay } as unknown as RendererFacade;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<OperationsActivity snapshot={snapshot} facade={facade} />),
    );
    expect(host.querySelectorAll("details")).toHaveLength(3);
    expect(host.querySelector("summary")?.textContent).toContain("model turn");
    expect(host.textContent).toContain("1 unreadable log lines skipped");
    expect(host.textContent).toContain("7 entries were not recorded");
    expect(host.textContent).toContain(
      "4 unmapped result codes were recorded as unknown",
    );
    expect(host.textContent).toContain("2 log writes or reads unavailable");
    expect(
      host.textContent?.match(/7 entries were not recorded/g),
    ).toHaveLength(1);
    const selects = host.querySelectorAll("select");
    await act(async () => {
      selects[1]!.value = "attention";
      selects[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelectorAll("details")).toHaveLength(2);
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Review unresolved actions")!
        .click(),
    );
    expect(overlay).toHaveBeenCalledWith("unresolved-actions");
    await act(async () => {
      selects[0]!.value = "ChatGPT";
      selects[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelectorAll("details")).toHaveLength(1);
    const details = host.querySelector("details")!;
    details.open = true;
    expect(details.textContent).toContain("README.md");
    expect(details.textContent).toContain("2 ms");
    expect(
      unresolvedActions(snapshot).filter((row) =>
        row.id.startsWith("operation:"),
      ),
    ).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    c.dispose();
    host.remove();
  }
});
it("loads durable operations independently of the empty runtime tasks and refresh", async () => {
  const f = fixture();
  const operation = {
    id: crypto.randomUUID(),
    at: 1,
    source: "Setup",
    kind: "connector.check-health",
    target: {},
    outcome: "refused",
    code: "CONNECTION_NOT_READY",
    durationMs: 7,
  };
  const c = new WindowController({
    ...f.api,
    operations: async () => ({
      entries: [operation],
      corruptLines: 0,
      writeFailures: 0,
      unmappedCodes: 3,
    }),
  });
  try {
    await c.start();
    await Promise.resolve();
    expect(c.getSnapshot().activity).toMatchObject([operation]);
    expect(c.getSnapshot().activityDiagnostics?.unmappedCodes).toBe(3);
    await c.refresh();
    expect(c.getSnapshot().activity).toMatchObject([operation]);
  } finally {
    c.dispose();
  }
});

it("Home shows the same recorded operations while Setup is unfinished", async () => {
  const f = fixture(),
    c = new WindowController(f.api);
  await c.start();
  const state = c.getSnapshot();
  const configuration = state.configuration;
  if (configuration?.status !== "ready") throw Error("fixture settings");
  const snapshot = {
    ...state,
    configuration: {
      ...configuration,
      settings: {
        ...configuration.settings,
        setup: {
          ...configuration.settings.setup,
          chatgpt: { ...configuration.settings.setup.chatgpt, verified: null },
        },
      },
    },
    activity: entries,
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Home snapshot={snapshot} facade={c} />));
    expect(host.textContent).toContain("Finish setup");
    expect(host.textContent).toContain("Recent activity");
    expect(host.querySelectorAll(".home-recent .home-row")).toHaveLength(3);
    expect(host.querySelector(".home-recent .home-row")?.textContent).toContain(
      "model turn",
    );
  } finally {
    await act(async () => root.unmount());
    c.dispose();
    host.remove();
  }
});

it("shows only resolved owner targets from current and legacy store records", async () => {
  // Disposable store + scripted IPC only; no Electron or live provider evidence.
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { OperationsStore } =
    await import("../../apps/desktop/operations/store");
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-b14-activity-"),
  );
  const store = new OperationsStore(directory);
  const privateSentence = "My private sentence about an appointment";
  const privatePath = "private appointment notes.txt";
  const f = fixture();
  const c = new WindowController({
    ...f.api,
    operations: () => store.snapshot(5000),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    store.setWorkspaceLabels([{ workspaceId: "w", label: "Owner Docs" }]);
    for (const workspace of [privateSentence, "w"])
      store.record(
        {
          source: "ChatGPT",
          kind: "computer_workspace_read",
          target: {
            workspace,
            relativePath: workspace === "w" ? "README.md" : privatePath,
          },
        },
        "refused",
        "OPERATION_REFUSED",
        1,
      );
    expect(await store.flush(5000)).toBe(true);
    const snapshot = await store.snapshot(5000);
    const segment = (await fs.readdir(directory)).find((name) =>
      name.endsWith(".jsonl"),
    )!;
    await fs.appendFile(
      path.join(directory, segment),
      JSON.stringify({
        ...snapshot.entries[0],
        id: crypto.randomUUID(),
        // Fixture chronology must not depend on whether Date.now calls tie.
        at: Math.max(...snapshot.entries.map((entry) => entry.at)) + 1,
        target: { workspace: privateSentence, relativePath: privatePath },
      }) + "\n",
    );
    await c.start();
    await c.refresh();
    await expect.poll(() => c.getSnapshot().activity.length).toBe(3);
    const activity = c.getSnapshot().activity;
    expect(activity).toHaveLength(3);
    expect(JSON.stringify(activity)).not.toContain(privateSentence);
    expect(JSON.stringify(activity)).not.toContain(privatePath);
    expect(activity.map((entry) => entry.operation)).toEqual([
      "[unknown workspace]",
      "Owner Docs · README.md",
      "[unknown workspace]",
    ]);
    await act(async () =>
      root.render(
        <OperationsActivity
          snapshot={c.getSnapshot()}
          facade={{} as RendererFacade}
        />,
      ),
    );
    expect(host.textContent).toContain("Owner Docs · README.md");
    expect(host.textContent).toContain("[unknown workspace]");
    expect(host.textContent).not.toContain(privateSentence);
    expect(host.textContent).not.toContain(privatePath);
  } finally {
    await act(async () => root.unmount());
    c.dispose();
    host.remove();
    await store.shutdown(5000);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("keeps historical sign-in query diagnostics in Activity without presenting them as replayable effects", async () => {
  const f = fixture(),
    c = new WindowController(f.api);
  await c.start();
  try {
    const diagnostic = {
      ...entries[1]!,
      id: "status-read",
      kind: "chatgpt.observe-sign-in",
    };
    const snapshot = {
      ...c.getSnapshot(),
      activity: [diagnostic, entries[1]!],
    };
    const rows = unresolvedActions(snapshot);
    expect(rows.some((row) => row.id === "operation:status-read")).toBe(false);
    expect(rows.some((row) => row.id === "operation:two")).toBe(true);
    expect(snapshot.activity).toEqual([diagnostic, entries[1]!]);
  } finally {
    c.dispose();
  }
});

it("keeps running work inspectable without treating it as abandoned and never hides UNKNOWN", async () => {
  const f = fixture(),
    c = new WindowController(f.api);
  await c.start();
  try {
    const live = { ...entries[2]!, id: "live", inFlight: true as const };
    const unknown = { ...entries[1]!, inFlight: true as const };
    const busy = {
      ...entries[2]!,
      id: "busy",
      kind: "chatgpt.open-browser",
      code: "CHATGPT_TASK_IN_PROGRESS",
      lifecycle: { id: crypto.randomUUID(), phase: "observed" as const },
    };
    const snapshot = {
      ...c.getSnapshot(),
      status: "current" as const,
      runtime: "ready" as const,
      activity: [live, unknown, busy],
    };
    const rows = unresolvedActions(snapshot);
    expect(rows.some((r) => r.id === "operation:live")).toBe(false);
    expect(snapshot.activity.some((entry) => entry.id === "live")).toBe(true);
    expect(rows.find((r) => r.id === "operation:two")?.inProgress).toBe(false);
    expect(rows.some((r) => r.id === "operation:busy")).toBe(false);
    expect(
      unresolvedActions({ ...snapshot, status: "stale" }).find(
        (r) => r.id === "operation:live",
      )?.inProgress,
    ).toBe(false);
    expect(snapshot.activity).toEqual([live, unknown, busy]);
  } finally {
    c.dispose();
  }
});

it("retains historical shell observations without hiding unknown command outcomes", async () => {
  const f = fixture(),
    c = new WindowController(f.api);
  await c.start();
  try {
    const observations = ["computer_shell_read", "computer_shell_cancel"].map(
      (kind) => ({
        ...entries[2]!,
        id: kind,
        kind,
        lifecycle: { id: crypto.randomUUID(), phase: "observed" as const },
      }),
    );
    const unknown = {
      ...observations[1]!,
      id: "cancel-unknown",
      outcome: "unknown" as const,
      code: "PROCESS_OUTCOME_UNKNOWN",
    };
    const snapshot = {
      ...c.getSnapshot(),
      activity: [...observations, unknown],
    };
    expect(unresolvedActions(snapshot).map((row) => row.id)).toEqual([
      "operation:cancel-unknown",
    ]);
    expect(snapshot.activity).toEqual([...observations, unknown]);
  } finally {
    c.dispose();
  }
});
