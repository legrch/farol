import { StrictMode, act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Home, HomeNavigation, homeTitle } from "../../src/ui/renderer/home";
import {
  designIconPath,
  designIconViewBox,
} from "../../src/ui/renderer/design-icons";
import { WindowController } from "../../src/ui/renderer/controller";
import type {
  ActivityEntry,
  WindowSnapshot,
} from "../../src/ui/renderer/contract";
import type { ProductTask } from "../../src/modules/chat/contract/product-task";
import { bootstrap, fixture, settings, task } from "./fixture";

// React/controller fixtures only: no pixels, native filesystem or provider proof.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  document.body.replaceChildren();
});
const running: ProductTask = {
  ...task(),
  provider: "chatgpt",
  lifecycle: "running",
  label: "Review Atlas",
};
const completed: ProductTask = { ...running, lifecycle: "completed" };
const event = (
  id: string,
  at: number,
  turnId = running.turnId,
): ActivityEntry => ({
  id,
  at,
  taskId: running.taskId,
  turnId,
  generation: 1,
  label: `Event ${id}`,
  kind: "task.phase",
  phase: "completed",
  operation: null,
  code: null,
});
const folder = {
  workspaceId: "22222222-2222-4222-8222-222222222222",
  root: "/work/Atlas",
  label: "Atlas",
  access: "read" as const,
  excludedPaths: [],
  rootIdentity: { device: "1", inode: "2" },
  accessCheck: null,
};
function readySettings() {
  const value = settings();
  const buildId = bootstrap().build.buildId;
  const runtimeGeneration = "a".repeat(64);
  const verifiedAt = "2026-10-06T10:00:00.000Z";
  value.computer.workspaces = [
    {
      ...folder,
      accessCheck: {
        buildId,
        computerGeneration: 1,
        verifiedAt,
        rootIdentity: folder.rootIdentity,
      },
    },
  ];
  const witness = {
    profile: "farol-next",
    configRevision: 1,
    workspaceId: folder.workspaceId,
    runtimeGeneration,
    buildId,
    protocol: "secure-mcp",
    verifiedAt,
  };
  value.setup.computer.verified = witness;
  value.setup.connect.verified = witness;
  value.connectors.secureMcp = {
    ...value.connectors.secureMcp,
    tunnelId: "fixture-tunnel",
    credential: "stored",
    tunnelClient: {
      executablePath: "/fixture/tunnel",
      executableSha256: "b".repeat(64),
      version: "1.0.0",
      protocol: "openai-tunnel-client/v1",
      verifiedAt,
    },
    runtime: {
      state: "ready",
      connectorGeneration: 1,
      computerGeneration: 1,
      runtimeGeneration,
      buildId,
      observedAt: verifiedAt,
    },
    attachment: {
      tunnelId: "fixture-tunnel",
      workspaceId: folder.workspaceId,
      connectorGeneration: 1,
      computerGeneration: 1,
      runtimeGeneration,
      buildId,
      challengeSha256: "c".repeat(64),
      receiptSha256: "d".repeat(64),
      verifiedAt,
    },
  };
  return value;
}
async function mount(
  tasks: ProductTask[] = [],
  initial: Partial<WindowSnapshot> = {},
) {
  const f = fixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    taskRevision: 1,
    tasks,
  });
  const c = new WindowController(f.api);
  await c.start();
  // Controller startup reads update status; Home must add no calls after it.
  vi.mocked(f.api.installedUpdate).mockClear();
  let patch = initial;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function View() {
    const value = useSyncExternalStore(c.subscribe, c.getSnapshot);
    const snapshot = { ...value, ...patch };
    return (
      <>
        <HomeNavigation snapshot={snapshot} facade={c} />
        <Home snapshot={snapshot} facade={c} />
      </>
    );
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
  cleanup.push(async () => {
    await act(async () => root.unmount());
    c.dispose();
  });
  const button = (label: string, scope: Element = host) => {
    const result = [...scope.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === label,
    );
    if (!result) throw new Error(`Missing button: ${label}`);
    return result;
  };
  return {
    f,
    c,
    host,
    button,
    content: () => host.querySelector(".home-candidate")!,
    click: (label: string, scope?: Element) =>
      act(async () => button(label, scope).click()),
    set: async (value: Partial<WindowSnapshot>) => {
      patch = value;
      await render();
    },
  };
}
function noEffects(f: ReturnType<typeof fixture>) {
  expect(f.api.task).not.toHaveBeenCalled();
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.installedUpdate).not.toHaveBeenCalled();
  expect(f.api.snapshot).not.toHaveBeenCalled();
}

it("defaults to Overview and projects all five sidebar views without effects", async () => {
  const h = await mount();
  expect(h.content().getAttribute("data-home-view")).toBe("overview");
  expect(homeTitle(h.c.getSnapshot())).toBe("Overview");
  expect(h.content().textContent).toContain("Your workspace starts here");
  for (const [label, view, text] of [
    ["Current work", "work", "No current work"],
    ["Needs attention", "attention", "To review"],
    ["Recent activity", "activity", "No recent events"],
    ["Connection & access", "access", "No workspaces added"],
    ["Overview", "overview", "Your workspace starts here"],
  ]) {
    // Count badges are intentionally omitted by the semantic label lookup.
    const navButton = [
      ...h.host.querySelectorAll('nav[aria-label="Home views"] button'),
    ].find(
      (button) =>
        button.querySelector(".home-candidate-label")?.textContent === label,
    )! as HTMLButtonElement;
    await act(async () => navButton.click());
    expect(h.c.getSnapshot().destination).toMatchObject({
      area: "home",
      homeView: view,
      homeSelection: null,
    });
    expect(h.content().textContent).toContain(text);
  }
  noEffects(h.f);
});
it("keeps task inspectors in Home and clears them when reselecting the same view", async () => {
  const h = await mount([running]);
  await h.click("View work");
  const row = h
    .content()
    .querySelector<HTMLButtonElement>(".home-candidate-record")!;
  await act(async () => row.click());
  expect(h.c.getSnapshot().destination).toMatchObject({
    area: "home",
    homeView: "work",
    homeSelection: { kind: "task", id: running.taskId, turnId: running.turnId },
  });
  expect(homeTitle(h.c.getSnapshot())).toBe("Review Atlas");
  expect(h.content().textContent).toContain(
    "Task completion does not verify workspace access",
  );
  await act(async () =>
    (
      h.host.querySelector(
        'nav button[aria-current="page"]',
      ) as HTMLButtonElement
    ).click(),
  );
  expect(h.c.getSnapshot().destination.homeSelection).toBeNull();
  noEffects(h.f);
});
it("opens only the explicit matching ChatGPT destination without task activation effects", async () => {
  const h = await mount([running]);
  await act(async () =>
    h.c.navigate({
      area: "home",
      homeView: "work",
      homeSelection: {
        kind: "task",
        id: running.taskId,
        turnId: running.turnId,
      },
    }),
  );
  await h.click("Open ChatGPT");
  expect(h.c.getSnapshot().destination).toMatchObject({
    area: "chatgpt",
    taskId: running.taskId,
  });
  noEffects(h.f);
});
it("cannot open a different task or turn after a current window is reused", async () => {
  const h = await mount([running]);
  await act(async () =>
    h.c.navigate({
      area: "home",
      homeView: "work",
      homeSelection: {
        kind: "task",
        id: running.taskId,
        turnId: running.turnId,
      },
    }),
  );
  await act(async () =>
    h.f.emit("tasks", {
      revision: 2,
      tasks: [{ ...running, turnId: "new-turn", label: "Different work" }],
    }),
  );
  expect(h.content().textContent).toContain("This window has moved on");
  expect(h.content().querySelector(".home-candidate-actions")).toBeNull();
  noEffects(h.f);
});
it("rechecks task identity at click time even before React has rerendered", async () => {
  const h = await mount([running]);
  await act(async () =>
    h.c.navigate({
      area: "home",
      homeView: "work",
      homeSelection: {
        kind: "task",
        id: running.taskId,
        turnId: running.turnId,
      },
    }),
  );
  const captured = h.button("Open ChatGPT");
  const original = h.c.getSnapshot();
  const navigate = vi.spyOn(h.c, "navigate");
  vi.spyOn(h.c, "getSnapshot").mockReturnValue({
    ...original,
    tasks: { revision: 2, tasks: [{ ...running, turnId: "reused" }] },
  });
  await act(async () => captured.click());
  expect(navigate).not.toHaveBeenCalled();
  noEffects(h.f);
});
it("shows only three recent records, while retained selected events remain inspectable", async () => {
  const records = [
    event("old", 1),
    event("two", 2),
    event("three", 3),
    event("four", 4),
  ];
  const h = await mount([running], { activity: records });
  await h.click("View recent");
  expect(
    [...h.content().querySelectorAll(".home-candidate-record strong")].map(
      (node) => node.textContent,
    ),
  ).toEqual(["Event four", "Event three", "Event two"]);
  await act(async () =>
    h.c.navigate({
      area: "home",
      homeView: "activity",
      homeSelection: { kind: "activity", id: "old", turnId: running.turnId },
    }),
  );
  expect(h.content().textContent).toContain("Event old");
  expect(h.content().textContent).toContain("No operation recorded");
  await h.click("Open in Activity");
  expect(h.c.getSnapshot().destination.area).toBe("activity");
  expect(h.c.getSnapshot().destination.activityId).toBe("old");
  expect(h.c.getSnapshot().overlay).toBe("activity");
  noEffects(h.f);
});
it("does not route an old event to a reused turn and preserves unknown event evidence", async () => {
  const old = { ...event("old", 1, "prior-turn"), phase: "outcome_unknown" };
  const h = await mount([running], { activity: [old] });
  await act(async () =>
    h.c.navigate({
      area: "home",
      homeView: "activity",
      homeSelection: { kind: "activity", id: old.id, turnId: old.turnId },
    }),
  );
  expect(h.button("Open ChatGPT").disabled).toBe(true);
  expect(h.content().textContent).toContain("outcome unknown");
  await h.click("Open ChatGPT");
  expect(h.c.getSnapshot().destination.area).toBe("home");
  noEffects(h.f);
});
it.each(["starting", "stale", "unavailable", "incompatible"] as const)(
  "keeps %s evidence honest and disables retained ChatGPT routing",
  async (status) => {
    const h = await mount([completed], { status });
    await act(async () =>
      h.c.navigate({
        area: "home",
        homeView: "work",
        homeSelection: {
          kind: "task",
          id: running.taskId,
          turnId: running.turnId,
        },
      }),
    );
    expect(h.content().textContent).toContain(
      `Current evidence unavailable · ${status}`,
    );
    expect(h.button("Open ChatGPT").disabled).toBe(true);
    noEffects(h.f);
  },
);
it("keeps unavailable observations separate from confirmed running work", async () => {
  const unavailable: ProductTask = {
    ...running,
    agent: {
      phase: "running",
      workspaceId: "atlas",
      parentDelivery: "pending",
      workspaceEnforcement: "not_applicable",
      resultAvailable: false,
      observation: "unavailable",
    },
  };
  const h = await mount([unavailable]);
  expect(h.content().textContent).toContain("Observation unavailable");
  expect(h.host.querySelector('[aria-label="1 working"]')).toBeNull();
  await act(async () =>
    h.c.navigate({
      area: "home",
      homeView: "work",
      homeSelection: {
        kind: "task",
        id: running.taskId,
        turnId: running.turnId,
      },
    }),
  );
  expect(h.button("Open ChatGPT").disabled).toBe(true);
  noEffects(h.f);
});
it("shows all-clear only from current Computer evidence, independently of optional embedded sign-in", async () => {
  const value = readySettings();
  const h = await mount([completed], {
    configuration: { status: "ready", settings: value },
  });
  expect(h.content().textContent).toContain("Ready when you are");
  expect(h.content().textContent).toContain("All clear");
  await act(async () => h.c.navigate({ area: "home", homeView: "attention" }));
  expect(h.content().textContent).toContain(
    "There are no unresolved items in the available evidence",
  );
  noEffects(h.f);
});
it("opens Setup explicitly from an empty overview without claiming folder access is optional", async () => {
  const h = await mount();
  expect(h.host.querySelector(".home-candidate-navigation h2")).toBeNull();
  await h.click("Continue setup");
  expect(h.c.getSnapshot().destination.area).toBe("setup");
  noEffects(h.f);
});
it("keeps optional embedded unknown evidence distinct from confirmed Computer readiness", async () => {
  const value = readySettings();
  value.setup.chatgpt.outcomeUnknown = true;
  const h = await mount([completed], {
    configuration: { status: "ready", settings: value },
  });
  await act(async () => h.c.navigate({ area: "home", homeView: "access" }));
  expect(h.content().textContent).toContain("Computer ready");
  expect(h.content().textContent).toContain("Outcome unknown");
  await act(async () => h.c.navigate({ area: "home", homeView: "attention" }));
  expect(h.content().textContent).toContain(
    "Embedded ChatGPT sign-in is not confirmed",
  );
  expect(h.content().textContent).not.toContain("Review connection evidence");
  noEffects(h.f);
});
it("task completion cannot verify a configured folder; only matching access evidence can", async () => {
  const value = settings();
  value.computer.workspaces = [folder];
  const h = await mount([completed], {
    configuration: { status: "ready", settings: value },
  });
  await act(async () => h.c.navigate({ area: "home", homeView: "access" }));
  expect(h.content().textContent).toContain("1 shared · 0 verified");
  expect(h.content().textContent).toContain("Not checked");
  const checked = {
    ...value,
    computer: {
      ...value.computer,
      workspaces: [
        {
          ...folder,
          accessCheck: {
            buildId: bootstrap().build.buildId,
            computerGeneration: value.computer.generation,
            verifiedAt: "2026-10-06T10:00:00.000Z",
            rootIdentity: folder.rootIdentity,
          },
        },
      ],
    },
  };
  await h.set({ configuration: { status: "ready", settings: checked } });
  expect(h.content().textContent).toContain("1 shared · 1 verified");
  await h.set({
    configuration: {
      status: "ready",
      settings: {
        ...checked,
        computer: { ...checked.computer, generation: 2 },
      },
    },
  });
  expect(h.content().textContent).toContain("1 shared · 0 verified");
  expect(h.content().textContent).toContain("Check needed");
  noEffects(h.f);
});
it("does not treat missing configuration as zero folders or verified access", async () => {
  const h = await mount([], { configuration: null });
  expect(h.c.getSnapshot().status).toBe("current");
  expect(h.content().textContent).not.toContain("Current state needs review");
  await act(async () => h.c.navigate({ area: "home", homeView: "attention" }));
  expect(h.content().textContent).toContain("Setup evidence is unavailable");
  await act(async () => h.c.navigate({ area: "home", homeView: "overview" }));
  await h.click("Review setup status");
  expect(h.content().textContent).toContain("Evidence unavailable");
  expect(h.content().textContent).not.toContain("No workspaces added");
  noEffects(h.f);
});
it("derives unknown and refused attention without rerunning operations", async () => {
  const h = await mount([{ ...running, lifecycle: "outcome_unknown" }], {
    intents: {
      uncertain: { id: "uncertain", state: "unknown", code: null },
      refused: { id: "refused", state: "refused", code: "REFUSED" },
    },
  });
  await act(async () => h.c.navigate({ area: "home", homeView: "attention" }));
  expect(h.content().textContent).toContain("Outcome unknown");
  expect(h.content().textContent).toContain("Refused");
  const row = [
    ...h
      .content()
      .querySelectorAll<HTMLButtonElement>(".home-candidate-record"),
  ].find((row) => row.textContent?.includes("Refused"))!;
  await act(async () => row.click());
  expect(h.c.getSnapshot().destination.homeSelection).toEqual({
    kind: "attention",
    id: "intent:refused",
  });
  expect(h.content().textContent).toContain("does not retry");
  expect(h.content().textContent).toContain("refused");
  expect(h.content().textContent).toContain("REFUSED");
  await h.click("Inspect action details");
  expect(h.c.getSnapshot().destination).toMatchObject({
    area: "settings",
    page: "diagnostics",
  });
  noEffects(h.f);
});
it("keeps unknown action identity and directs its review to retained Diagnostics", async () => {
  const h = await mount([], {
    intents: {
      "settings:model.preview:": {
        id: "settings:model.preview:",
        state: "unknown",
        code: "MODEL_PREVIEW_UNKNOWN",
      },
    },
  });
  await act(async () =>
    h.c.navigate({
      area: "home",
      homeView: "attention",
      homeSelection: {
        kind: "attention",
        id: "intent:settings:model.preview:",
      },
    }),
  );
  expect(h.content().textContent).toContain("settings:model.preview:");
  expect(h.content().textContent).toContain("MODEL_PREVIEW_UNKNOWN");
  expect(h.content().textContent).not.toContain("Open full Activity");
  await h.click("Inspect action details");
  expect(h.c.getSnapshot().destination).toMatchObject({
    area: "settings",
    page: "diagnostics",
  });
  noEffects(h.f);
});
it.each(["pending", "delivery"] as const)(
  "routes a %s folder edit to its existing observation surface without substituting another operation",
  async (state) => {
    const value = readySettings();
    const operationId = "33333333-3333-4333-8333-333333333333";
    if (state === "pending")
      value.computer.pendingEdit = {
        operationId,
        workspaceId: folder.workspaceId,
        relativePath: "file.txt",
        computerGeneration: 1,
        submittedAt: "2026-10-06T10:00:00.000Z",
      };
    const h = await mount([], {
      configuration: { status: "ready", settings: value },
      workspaceEditDelivery: state === "delivery" ? operationId : null,
    });
    await act(async () =>
      h.c.navigate({
        area: "home",
        homeView: "attention",
        homeSelection: { kind: "attention", id: `folder-edit:${operationId}` },
      }),
    );
    expect(h.content().textContent).toContain(operationId);
    await h.click("Inspect action details");
    expect(h.c.getSnapshot().destination).toMatchObject({
      area: "settings",
      page: "diagnostics",
    });
    await act(async () => h.c.travel(-1));
    await h.set({
      configuration: { status: "ready", settings: readySettings() },
      workspaceEditDelivery: "44444444-4444-4444-8444-444444444444",
    });
    expect(h.content().textContent).toContain("This item is no longer present");
    expect(h.content().textContent).not.toContain("44444444");
    noEffects(h.f);
  },
);
it("shows missing attention and event inspectors without substituting another record", async () => {
  const h = await mount();
  await act(async () =>
    h.c.navigate({
      area: "home",
      homeView: "attention",
      homeSelection: { kind: "attention", id: "removed" },
    }),
  );
  expect(h.content().textContent).toContain("This item is no longer present");
  await act(async () =>
    h.c.navigate({
      area: "home",
      homeView: "activity",
      homeSelection: { kind: "activity", id: "removed" },
    }),
  );
  expect(h.content().textContent).toContain(
    "This event is no longer available",
  );
  noEffects(h.f);
});
it.each([
  ["Manage connection", "settings", "connection"],
  ["Manage workspaces", "settings", "folders"],
  ["Open Setup", "setup", null],
] as const)(
  "leaves Home only through the named %s destination",
  async (label, area, page) => {
    const h = await mount();
    await h.click("Review setup status");
    await h.click(label);
    expect(h.c.getSnapshot().destination.area).toBe(area);
    if (page) expect(h.c.getSnapshot().destination.page).toBe(page);
    noEffects(h.f);
  },
);

it("uses the approved icon vocabulary for Home views and explicit ChatGPT actions", async () => {
  const h = await mount([running]);
  const glyphs = [
    ...h.host.querySelectorAll('nav[aria-label="Home views"] svg'),
  ];
  expect(glyphs).toHaveLength(5);
  for (const [index, name] of [
    "home",
    "chat",
    "attention",
    "activity",
    "connection",
  ].entries()) {
    expect(glyphs[index]?.getAttribute("viewBox")).toBe(designIconViewBox);
    expect(glyphs[index]?.querySelector("path")?.getAttribute("d")).toBe(
      designIconPath(name),
    );
  }
  await h.click("View work");
  await act(async () =>
    h
      .content()
      .querySelector<HTMLButtonElement>(".home-candidate-record")!
      .click(),
  );
  const heading = h.content().querySelector(".home-candidate-detail-heading")!;
  expect(heading.querySelector("h2")?.textContent).toBe(running.label);
  expect(heading.querySelector(".home-candidate-number")?.textContent).toBe(
    "1",
  );
  expect(heading.querySelector(".home-candidate-badge")?.textContent).toBe(
    "Working",
  );
  const open = h.button("Open ChatGPT");
  expect(open.classList.contains("home-candidate-primary")).toBe(true);
  expect(open.querySelector("path")?.getAttribute("d")).toBe(
    designIconPath("chat"),
  );
  noEffects(h.f);
});
it("keeps the sidebar readiness symbol tied to current verified Computer evidence", async () => {
  const h = await mount([completed]);
  const symbol = () =>
    h.host.querySelector(".home-candidate-connection-symbol")!;
  expect(symbol().classList.contains("is-ready")).toBe(false);
  expect(symbol().querySelector("path")?.getAttribute("d")).toBe(
    designIconPath("connection"),
  );
  const configuration = { status: "ready" as const, settings: readySettings() };
  await h.set({ configuration });
  expect(symbol().classList.contains("is-ready")).toBe(true);
  expect(symbol().querySelector("path")?.getAttribute("d")).toBe(
    designIconPath("check"),
  );
  await h.set({ configuration, status: "stale" });
  expect(symbol().classList.contains("is-ready")).toBe(false);
  expect(
    h.host.querySelector(".home-candidate-connection-link")?.textContent,
  ).toContain("Evidence unavailable");
  noEffects(h.f);
});
it("preserves the Home view and stable inspector selection across Back and Forward", async () => {
  const h = await mount([running]);
  await h.click("View work");
  await act(async () =>
    h
      .content()
      .querySelector<HTMLButtonElement>(".home-candidate-record")!
      .click(),
  );
  const selected = h.c.getSnapshot().destination;
  await h.click("Open ChatGPT");
  await act(async () => h.c.travel(-1));
  expect(h.c.getSnapshot().destination).toEqual(selected);
  expect(
    h.content().querySelector(".home-candidate-detail-heading h2")?.textContent,
  ).toBe(running.label);
  await act(async () => h.c.travel(-1));
  expect(h.c.getSnapshot().destination).toMatchObject({
    area: "home",
    homeView: "work",
    homeSelection: null,
  });
  await act(async () => h.c.travel(1));
  expect(h.c.getSnapshot().destination).toEqual(selected);
  await act(async () => h.c.travel(1));
  expect(h.c.getSnapshot().destination).toMatchObject({
    area: "chatgpt",
    taskId: running.taskId,
  });
  noEffects(h.f);
});
