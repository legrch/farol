import { StrictMode, act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Home } from "../../src/ui/renderer/home";
import { WindowController } from "../../src/ui/renderer/controller";
import type {
  ActivityEntry,
  WindowSnapshot,
} from "../../src/ui/renderer/contract";
import { bootstrap, fixture, settings, task, deferred } from "./fixture";
import { readySettings } from "./setup-fixture";

// DOM + scripted evidence only; no live connection, account or filesystem.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.replaceChildren();
});
function working(): Partial<WindowSnapshot> {
  const buildId = bootstrap().build.buildId;
  const settings = readySettings(true);
  settings.setup.journey.dismissed = true;
  return {
    configuration: { status: "ready", settings },
    signInObservation: {
      observationId: "fixture",
      buildId,
      counter: 1,
      pending: false,
      state: "authenticated",
      binding: { documentGeneration: 0, sequence: 1 },
    },
    setupSignInCheck: {
      buildId,
      binding: { documentGeneration: 0, sequence: 1 },
    },
  };
}
const event = (id: string, at: number): ActivityEntry => ({
  id,
  at,
  taskId: "task-1",
  turnId: "task-1",
  generation: 1,
  label: `Event ${id}`,
  kind: "task.phase",
  phase: "completed",
  operation: null,
  code: null,
});
async function mount(initial: Partial<WindowSnapshot> = {}) {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  let patch = initial;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function View() {
    const value = useSyncExternalStore(c.subscribe, c.getSnapshot);
    return <Home snapshot={{ ...value, ...patch }} facade={c} />;
  }
  const render = () =>
    act(async () =>
      root.render(
        <StrictMode>
          <View />
        </StrictMode>,
      ),
    );
  await render();
  cleanups.push(async () => {
    await act(async () => root.unmount());
    c.dispose();
  });
  return {
    f,
    c,
    host,
    set: async (value: Partial<WindowSnapshot>) => {
      patch = value;
      await render();
    },
    click: async (label: string) => {
      const b = [...host.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === label,
      );
      expect(b, label).toBeTruthy();
      await act(async () => b!.click());
    },
  };
}
it("shows only Finish setup and the four truthful steps when unfinished", async () => {
  const h = await mount();
  expect(h.host.querySelectorAll("section")).toHaveLength(1);
  expect(h.host.querySelectorAll(".home-setup-steps li")).toHaveLength(4);
  expect(h.host.querySelector('[aria-current="step"]')?.textContent).toContain(
    "Sign in to ChatGPT",
  );
  expect(h.host.textContent).not.toMatch(
    /Connection settings|Manage access|Check sign-in|Recent activity|Current work|Computer access|tunnel client|observation/,
  );
  expect(h.f.api.configure).not.toHaveBeenCalled();
  expect(h.f.api.task).not.toHaveBeenCalled();
  await h.click("Continue setup");
  expect(h.c.getSnapshot().destination).toMatchObject({
    area: "setup",
    setupStep: "signin",
  });
});
it("marks done/current/pending steps and continues at the first unfinished step", async () => {
  const value = working();
  const settings = readySettings(true);
  settings.connectors.secureMcp.runtime = null;
  settings.connectors.secureMcp.attachment = null;
  const h = await mount({
    ...value,
    configuration: { status: "ready", settings },
  });
  expect(h.host.querySelectorAll('[data-state="done"]')).toHaveLength(2);
  expect(h.host.querySelector('[aria-current="step"]')?.textContent).toContain(
    "Connect this Mac",
  );
  expect(h.host.querySelectorAll('[data-state="pending"]')).toHaveLength(1);
  await h.click("Continue setup");
  expect(h.c.getSnapshot().destination.setupStep).toBe("connection");
});
it("keeps Finish setup when all four checks pass without persisted completion", async () => {
  const value = working();
  const settings = readySettings(true);
  const h = await mount({
    ...value,
    configuration: { status: "ready", settings },
  });
  expect(h.c.getSnapshot().destination).toMatchObject({
    area: "setup",
    setupStep: "overview",
  });
  expect(h.host.querySelectorAll('[data-state="done"]')).toHaveLength(4);
  expect(h.host.textContent).toContain("Finish setup");
  expect(h.host.textContent).not.toContain("Farol is working");
  expect(h.f.api.configure).not.toHaveBeenCalled();
  await h.click("Continue setup");
  expect(h.c.getSnapshot().destination.setupStep).toBe("attachment");
  expect(h.f.api.configure).not.toHaveBeenCalled();
});
it("working Home has one status card, newest three events, and no empty attention section", async () => {
  const h = await mount({
    ...working(),
    activity: [
      event("old", 1),
      event("middle", 4),
      event("new", 7),
      event("last", 10),
    ],
  });
  expect(h.host.textContent).toContain("Farol is working");
  expect(h.host.textContent).toContain(
    "ChatGPT can reach this Mac · 1 workspace · checked",
  );
  expect(h.host.querySelector(".home-attention")).toBeNull();
  expect(h.host.querySelector(".home-setup-card")).toBeNull();
  expect(
    [...h.host.querySelectorAll(".home-row-label")].map((e) => e.textContent),
  ).toEqual(["Event last", "Event new", "Event middle"]);
  expect(h.f.api.configure).not.toHaveBeenCalled();
  await h.click("Show all");
  expect(h.c.getSnapshot().destination.area).toBe("activity");
});
it("opens the exact recent event in Activity without a command", async () => {
  const h = await mount({ ...working(), activity: [event("event-1", 1)] });
  await act(async () =>
    h.host.querySelector<HTMLButtonElement>(".home-row")!.click(),
  );
  expect(h.c.getSnapshot().destination).toMatchObject({
    area: "activity",
    activityId: "event-1",
  });
  expect(h.f.api.configure).not.toHaveBeenCalled();
});
it("keeps task attention and routes the same task without activating or retrying it", async () => {
  const failed = {
    ...task(),
    provider: "chatgpt" as const,
    lifecycle: "failed" as const,
  };
  const h = await mount({
    ...working(),
    tasks: { revision: 1, tasks: [failed] },
  });
  expect(h.host.querySelector(".home-attention")?.textContent).toContain(
    "Task 1",
  );
  // Latest controller state must still contain the same exact task.
  await act(async () => h.f.emit("tasks", { revision: 1, tasks: [failed] }));
  await act(async () =>
    h.host.querySelector<HTMLButtonElement>(".home-attention button")!.click(),
  );
  expect(h.c.getSnapshot().destination).toMatchObject({
    area: "chatgpt",
    taskId: failed.taskId,
  });
  expect(h.f.api.task).not.toHaveBeenCalled();
});
it.each(["stale", "unavailable"] as const)(
  "does not claim working from %s records",
  async (status) => {
    const h = await mount({ ...working(), status });
    expect(h.host.textContent).toContain(
      "Setup complete · connection needs attention",
    );
    expect(h.host.textContent).not.toContain("Farol is working");
  },
);
it("never claims working from saved connection evidence without the required sign-in check", async () => {
  const value = working();
  const h = await mount({ ...value, setupSignInCheck: null });
  expect(h.host.textContent).toContain(
    "Setup complete · connection needs attention",
  );
});
it("Check now uses the existing health command once and does not submit another while pending", async () => {
  const h = await mount(working());
  const value = working();
  vi.mocked(h.f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    configuration: value.configuration as ReturnType<
      typeof bootstrap
    >["configuration"],
  });
  await act(async () => h.c.refresh());
  const result = deferred<unknown>();
  vi.mocked(h.f.api.configure).mockReturnValue(result.promise);
  await h.click("Check now");
  expect(h.f.api.configure).toHaveBeenCalledExactlyOnceWith({
    kind: "connector.check-health",
  });
  expect(h.host.querySelector(".home-status-card button")?.textContent).toBe(
    "Checking…",
  );
  await act(async () =>
    h.host
      .querySelector<HTMLButtonElement>(".home-status-card button")!
      .click(),
  );
  expect(h.f.api.configure).toHaveBeenCalledTimes(1);
  await act(async () =>
    result.resolve({ ok: true, snapshot: value.configuration }),
  );
  expect(h.host.textContent).toContain("Connection check finished at");
});
it("missing configuration cannot become a fabricated zero-workspace success", async () => {
  const h = await mount({
    ...working(),
    configuration: { status: "ready", settings: settings() },
  });
  expect(h.host.textContent).toContain("Finish setup");
  expect(h.host.textContent).not.toContain("0 workspaces · checked");
});

it("routes unresolved update evidence to the existing sheet from working Home", async () => {
  const h = await mount({
    ...working(),
    update: {
      phase: "failed",
      code: "UPDATE_UNCONFIRMED",
      recoveryRequired: true,
    },
  });
  expect(h.host.querySelector(".home-attention")?.textContent).toContain(
    "Update recovery",
  );
  await act(async () =>
    h.host.querySelector<HTMLButtonElement>(".home-attention button")!.click(),
  );
  expect(h.c.getSnapshot().overlay).toBe("unresolved-actions");
  expect(h.f.api.installedUpdate).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: "restart-confirmed" }),
  );
});

it("shows that ChatGPT needs checking when the tunnel is connected but attachment is unconfirmed", async () => {
  const value = working();
  if (value.configuration?.status !== "ready")
    throw Error("fixture settings missing");
  value.configuration.settings.connectors.secureMcp.attachment = null;
  const h = await mount(value);
  expect(h.host.textContent).toContain("ChatGPT connection needs a check");
  expect(h.host.textContent).not.toContain("Farol is working");
  expect(h.host.textContent).toContain(
    "Tunnel connected · Check the ChatGPT app connection",
  );
  expect(h.host.textContent).not.toContain("ChatGPT can reach this Mac");
  expect(h.host.textContent).not.toContain("Review connection");
  expect(h.f.api.configure).not.toHaveBeenCalled();
  await h.click("Review ChatGPT connection");
  expect(h.c.getSnapshot().destination).toMatchObject({
    area: "setup",
    setupStep: "attachment",
  });
  expect(h.f.api.configure).not.toHaveBeenCalled();
});
it("shows a matching earlier ChatGPT verification as history, not current readiness", async () => {
  const value = working();
  if (value.configuration?.status !== "ready")
    throw Error("fixture settings missing");
  const connector = value.configuration.settings.connectors.secureMcp;
  connector.lastVerifiedAttachment = connector.attachment;
  connector.attachment = null;
  const h = await mount(value);
  expect(h.host.textContent).toContain("Last ChatGPT verification:");
  expect(h.host.textContent).toContain("ChatGPT connection needs a check");
  expect(h.host.textContent).not.toContain("ChatGPT can reach this Mac");
  expect(h.f.api.configure).not.toHaveBeenCalled();
});
it("labels an earlier verification for a different tunnel as previous settings", async () => {
  const value = working();
  if (value.configuration?.status !== "ready")
    throw Error("fixture settings missing");
  const connector = value.configuration.settings.connectors.secureMcp;
  connector.lastVerifiedAttachment = {
    ...connector.attachment!,
    tunnelId: "different",
  };
  connector.attachment = null;
  const h = await mount(value);
  expect(h.host.textContent).not.toContain("Last ChatGPT verification:");
  expect(h.host.textContent).toContain(
    "Earlier ChatGPT verification (previous settings):",
  );
  expect(h.host.textContent).not.toContain("ChatGPT can reach this Mac");
});
it("keeps recorded unknown history out of Home without clearing it", async () => {
  const events = ["one", "two", "three"].map((id) => ({
    ...event(id, 1),
    kind: "hub.lifecycle",
    outcome: "unknown" as const,
    phase: "outcome_unknown" as const,
  }));
  const h = await mount({ ...working(), activity: events });
  expect(h.host.querySelector(".home-attention")).toBeNull();
  expect(h.host.textContent).not.toContain("Review history");
  expect(events.every((e) => e.outcome === "unknown")).toBe(true);
  expect(h.f.api.configure).not.toHaveBeenCalled();
});

it("shows a saved fresh session with limited tools without claiming all tools work", async () => {
  const h = await mount({ ...working(), independentSession: true });
  expect(h.host.textContent).toContain("New session · tools limited");
  expect(h.host.textContent).toContain("File changes and commands are paused");
  expect(h.host.textContent).not.toContain("Farol is working");
  expect(h.host.querySelector(".home-setup-card")).toBeNull();
});
