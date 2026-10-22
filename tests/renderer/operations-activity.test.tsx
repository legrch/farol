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
      host.querySelector<HTMLButtonElement>("button")!.click(),
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
    code: "CONNECTOR_NOT_READY",
    durationMs: 7,
  };
  const c = new WindowController({
    ...f.api,
    operations: async () => ({
      entries: [operation],
      corruptLines: 0,
      writeFailures: 0,
    }),
  });
  try {
    await c.start();
    await Promise.resolve();
    expect(c.getSnapshot().activity).toMatchObject([operation]);
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
