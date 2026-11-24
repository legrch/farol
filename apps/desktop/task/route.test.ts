import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatGptRouteOptions } from "../../../src/apps/desktop/chatgpt-route";
import { LiveTaskRegistry } from "../../../src/apps/desktop/live-task-registry";
import type { ProductTask } from "../../../src/modules/chat/contract/product-task";
import { createTaskRoutes, type TaskRoutesPorts } from "./route";

// The three route builders over scripted owners. Main's `let`s are fields the
// ports read afresh, the route class is `openRoute` (it records the options it
// is given and returns a numbered stand-in), and no window, surface, provider
// or profile runs. A real registry holds the saved tasks the callbacks look up.
const home = "https://chatgpt.com/";
const fixtureOrigin = "http://127.0.0.1:4567";
const fixtureHome = `${fixtureOrigin}/`;

function task(lifecycle: ProductTask["lifecycle"] = "idle") {
  return {
    taskId: randomUUID(),
    sessionId: randomUUID(),
    turnId: randomUUID(),
    label: "ChatGPT task 1",
    provider: "chatgpt" as const,
    requestedModel: "Account default",
    observedModel: null,
    requestedMode: "Account default",
    observedMode: null,
    hasComputer: false,
    pinned: false,
    lifecycle,
  } satisfies ProductTask;
}

type Stand = Readonly<{ id: number }>;

function build(
  options: Readonly<{
    runtime?: string;
    e2eOrigin?: string | null;
    homeUrl?: string;
    env?: Record<string, string | undefined>;
  }> = {},
) {
  const state = {
    homeUrl: options.homeUrl ?? home,
    e2eOrigin: options.e2eOrigin ?? null,
  };
  const registry = new LiveTaskRegistry(5);
  const managed = new Set<Stand>();
  const conversationUrls = new Map<string, string | null>();
  const opened: { options: ChatGptRouteOptions; route: Stand }[] = [];
  const stderr: string[] = [];
  const lifecycles: { taskId: string; lifecycle: string }[] = [];
  const failures: string[] = [];
  const surfaceRequests: string[] = [];
  const persist = vi.fn(() => Promise.resolve());
  const ports: TaskRoutesPorts<Stand> = {
    window: () => null,
    chatGptHomeUrl: () => state.homeUrl,
    chatGptE2eOrigin: () => state.e2eOrigin,
    managedChatGptRoutes: managed,
    liveTaskRegistry: registry,
    liveTaskConversationUrls: conversationUrls,
    activeDesktopIdentity: {
      chatGptPartition: "persist:farol-dev-chatgpt",
      displayName: "Farol Dev",
    },
    channels: { browserHistoryState: "farol:browser-history-state" },
    displayProductName: "Farol Dev",
    runtimeEnvironment: options.runtime ?? "dev",
    persistLiveTaskState: persist,
    surfaceLiveTaskPersistenceFailure: (taskId) => {
      failures.push(taskId);
    },
    setLiveTaskLifecycle: (taskId, lifecycle) => {
      lifecycles.push({ taskId, lifecycle });
    },
    chatGptWindowPresentationOption: () => ({
      windowPresentation: { mode: "hidden" },
    }),
    liveChatGptSurfaceFactory: (taskId) => {
      surfaceRequests.push(taskId);
      return () => {
        throw new Error("SURFACE_NOT_OPENED_IN_THIS_TEST");
      };
    },
    openRoute: (routeOptions) => {
      const route = { id: opened.length + 1 };
      opened.push({ options: routeOptions, route });
      return route;
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
    env: options.env ?? {},
  };
  return {
    state,
    registry,
    managed,
    conversationUrls,
    opened,
    stderr,
    lifecycles,
    failures,
    surfaceRequests,
    persist,
    subject: createTaskRoutes(ports),
  };
}

function managedOptions(
  extra: Readonly<{
    title?: string;
    onUpdateAdmissionDiagnostic?: NonNullable<
      ChatGptRouteOptions["onUpdateAdmissionDiagnostic"]
    >;
    onProfilePreparationDiagnostic?: NonNullable<
      ChatGptRouteOptions["onProfilePreparationDiagnostic"]
    >;
  }> = {},
): ChatGptRouteOptions {
  return {
    homeUrl: home,
    initialUrl: home,
    e2eOrigin: null,
    parent: () => null,
    ...extra,
  };
}

describe("managed route", () => {
  it("binds the ChatGPT partition and names the app only in dev", () => {
    const dev = build({ runtime: "dev" });
    dev.subject.managed(managedOptions());
    expect(dev.opened[0]?.options).toMatchObject({
      partition: "persist:farol-dev-chatgpt",
      requiredAppName: "Farol Dev",
      title: "ChatGPT · Farol Dev",
    });

    const explicit = build({ runtime: "dev" });
    explicit.subject.managed(managedOptions({ title: "Mine" }));
    expect(explicit.opened[0]?.options.title).toBe("Mine");
    expect(explicit.opened[0]?.options.requiredAppName).toBe("Farol Dev");

    const production = build({ runtime: "production" });
    production.subject.managed(managedOptions());
    const options = production.opened[0]?.options;
    expect(options?.partition).toBe("persist:farol-dev-chatgpt");
    expect(options).not.toHaveProperty("requiredAppName");
    expect(options).not.toHaveProperty("title");
  });

  it("writes the fixed update-admission line and still tells the caller", () => {
    const subject = build({ runtime: "production" });
    const forwarded = vi.fn();
    subject.subject.managed(
      managedOptions({ onUpdateAdmissionDiagnostic: forwarded }),
    );
    const diagnostic = { stage: "admission", reason: "busy" } as const;
    subject.opened[0]?.options.onUpdateAdmissionDiagnostic?.(diagnostic);
    expect(subject.stderr).toEqual([
      "FAROL_UPDATE_ADMISSION_DIAGNOSTIC admission:busy\n",
    ]);
    expect(forwarded).toHaveBeenCalledExactlyOnceWith(diagnostic);

    // A caller that passed no listener is still diagnosed, never refused.
    const bare = build({ runtime: "production" });
    bare.subject.managed(managedOptions());
    bare.opened[0]?.options.onUpdateAdmissionDiagnostic?.({
      stage: "surface",
      reason: "destroyed",
    });
    expect(bare.stderr).toEqual([
      "FAROL_UPDATE_ADMISSION_DIAGNOSTIC surface:destroyed\n",
    ]);
  });

  it("writes the profile-preparation line only in dev and always forwards it", () => {
    const diagnostic = {
      stage: "picker",
      expectedTemporary: true,
      logicalDocumentChanged: false,
      physicalDocumentChanged: false,
      urlChanged: false,
      operationChanged: false,
      surfaceChanged: false,
      probe: null,
      sliderReady: false,
      sliderAtMinimum: false,
    } as const;
    for (const [runtime, lines] of [
      [
        "dev",
        [
          `FAROL_PROFILE_PREPARATION_DIAGNOSTIC ${JSON.stringify(diagnostic)}\n`,
        ],
      ],
      ["owner-preview", []],
      ["production", []],
    ] as const) {
      const subject = build({ runtime });
      const forwarded = vi.fn();
      subject.subject.managed(
        managedOptions({ onProfilePreparationDiagnostic: forwarded }),
      );
      subject.opened[0]?.options.onProfilePreparationDiagnostic?.(diagnostic);
      expect(subject.stderr, runtime).toEqual(lines);
      expect(forwarded, runtime).toHaveBeenCalledExactlyOnceWith(diagnostic);
    }
  });

  it("tracks each route in the managed set until it is disposed", () => {
    const subject = build();
    const first = subject.subject.managed(managedOptions());
    const second = subject.subject.managed(managedOptions());
    expect([...subject.managed]).toEqual([first, second]);

    subject.opened[0]?.options.onDisposed?.();
    expect([...subject.managed]).toEqual([second]);
    subject.opened[1]?.options.onDisposed?.();
    expect(subject.managed.size).toBe(0);
  });
});

describe("live route", () => {
  it("opens at the home url, names the surface and asks the surface factory for the task", () => {
    const subject = build({ runtime: "production" });
    const route = subject.subject.live("task-1", "Billing");
    expect(route).toEqual({ id: 1 });
    const options = subject.opened[0]?.options;
    expect(options).toMatchObject({
      homeUrl: home,
      initialUrl: home,
      e2eOrigin: null,
      title: "Billing · Farol Dev",
      windowPresentation: { mode: "hidden" },
    });
    expect(options?.parent()).toBeNull();
    expect(subject.surfaceRequests).toEqual(["task-1"]);
    expect(subject.managed.size).toBe(1);
    expect(options).not.toHaveProperty("taskTimeoutMs");
    expect(options).not.toHaveProperty("taskPollMs");
  });

  it("keeps a given initial url and reads the home url when the route is built", () => {
    const subject = build({ runtime: "production" });
    subject.subject.live("t", "L", "https://chatgpt.com/c/known");
    expect(subject.opened[0]?.options.initialUrl).toBe(
      "https://chatgpt.com/c/known",
    );
    subject.state.homeUrl = "https://chatgpt.com/?changed=1";
    subject.subject.live("t", "L");
    expect(subject.opened[1]?.options).toMatchObject({
      homeUrl: "https://chatgpt.com/?changed=1",
      initialUrl: "https://chatgpt.com/?changed=1",
    });
  });

  it("rewrites the fixture home for the task and moves a default initial url with it", () => {
    const subject = build({ e2eOrigin: fixtureOrigin, homeUrl: fixtureHome });
    subject.subject.live("task-9", "Fixture");
    const rewritten = `${fixtureHome}?farol-e2e-task=task-9`;
    expect(subject.opened[0]?.options).toMatchObject({
      homeUrl: rewritten,
      initialUrl: rewritten,
      e2eOrigin: fixtureOrigin,
    });

    // A recovered conversation address is not the home, so it stays.
    subject.subject.live("task-9", "Fixture", `${fixtureOrigin}/c/known`);
    expect(subject.opened[1]?.options).toMatchObject({
      homeUrl: rewritten,
      initialUrl: `${fixtureOrigin}/c/known`,
    });
  });

  it("shortens the task timeouts only for an e2e run on a fixture origin", () => {
    const e2e = build({
      e2eOrigin: fixtureOrigin,
      homeUrl: fixtureHome,
      env: { FAROL_E2E: "1" },
    });
    e2e.subject.live("t", "L");
    expect(e2e.opened[0]?.options).toMatchObject({
      taskTimeoutMs: 5_000,
      taskPollMs: 50,
    });

    const noOrigin = build({ env: { FAROL_E2E: "1" } });
    noOrigin.subject.live("t", "L");
    expect(noOrigin.opened[0]?.options).not.toHaveProperty("taskTimeoutMs");

    const noFlag = build({ e2eOrigin: fixtureOrigin, homeUrl: fixtureHome });
    noFlag.subject.live("t", "L");
    expect(noFlag.opened[0]?.options).not.toHaveProperty("taskTimeoutMs");
  });

  it("records a conversation url only for a saved task and a changed address", async () => {
    const subject = build();
    const saved = task();
    expect(subject.registry.admit(saved).status).toBe("admitted");
    subject.subject.live(saved.taskId, "Saved");
    subject.subject.live("unknown-task", "Unknown");
    const [savedOptions, unknownOptions] = subject.opened.map(
      (entry) => entry.options,
    );

    unknownOptions?.onConversationChanged?.("https://chatgpt.com/c/x");
    expect(subject.persist).not.toHaveBeenCalled();
    expect(subject.conversationUrls.has("unknown-task")).toBe(false);

    savedOptions?.onConversationChanged?.("https://chatgpt.com/c/a");
    expect(subject.conversationUrls.get(saved.taskId)).toBe(
      "https://chatgpt.com/c/a",
    );
    expect(subject.persist).toHaveBeenCalledTimes(1);

    // The same address again is not a change.
    savedOptions?.onConversationChanged?.("https://chatgpt.com/c/a");
    expect(subject.persist).toHaveBeenCalledTimes(1);

    // A lost address is a change too.
    savedOptions?.onConversationChanged?.(null);
    expect(subject.conversationUrls.get(saved.taskId)).toBeNull();
    expect(subject.persist).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(subject.failures).toEqual([]);
  });

  it("surfaces a failed save once and never repeats it", async () => {
    const subject = build();
    const saved = task();
    subject.registry.admit(saved);
    subject.persist.mockRejectedValueOnce(new Error("SAVE_FAILED"));
    subject.subject.live(saved.taskId, "Saved");
    subject.opened[0]?.options.onConversationChanged?.(
      "https://chatgpt.com/c/a",
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(subject.failures).toEqual([saved.taskId]);
    expect(subject.persist).toHaveBeenCalledTimes(1);
  });

  it("maps surface activity onto the lifecycle the registry holds", () => {
    const cases = [
      ["running", "idle", "running"],
      ["outcome_unknown", "running", "outcome_unknown"],
      ["idle", "running", "completed"],
      ["idle", "idle", "idle"],
      ["idle", "failed", "failed"],
    ] as const;
    for (const [state, before, after] of cases) {
      const subject = build();
      const saved = task(before);
      subject.registry.admit(saved);
      subject.subject.live(saved.taskId, "Saved");
      subject.opened[0]?.options.onTaskActivityChanged?.(state);
      expect(subject.lifecycles, `${state} from ${before}`).toEqual([
        { taskId: saved.taskId, lifecycle: after },
      ]);
    }

    const unknown = build();
    unknown.subject.live("unknown-task", "Unknown");
    unknown.opened[0]?.options.onTaskActivityChanged?.("running");
    expect(unknown.lifecycles).toEqual([]);
  });

  it("records the address and then the activity when the surface closes", () => {
    const subject = build();
    const saved = task("running");
    subject.registry.admit(saved);
    subject.subject.live(saved.taskId, "Saved");
    const closed = subject.opened[0]?.options.onClosed;

    closed?.("https://chatgpt.com/c/z", true);
    expect(subject.conversationUrls.get(saved.taskId)).toBe(
      "https://chatgpt.com/c/z",
    );
    expect(subject.lifecycles).toEqual([
      { taskId: saved.taskId, lifecycle: "outcome_unknown" },
    ]);

    closed?.("https://chatgpt.com/c/z", false);
    expect(subject.persist).toHaveBeenCalledTimes(1);
    expect(subject.lifecycles.at(-1)).toEqual({
      taskId: saved.taskId,
      lifecycle: "completed",
    });
  });
});

describe("context-summary fallback route", () => {
  it("opens at the home url on a fresh title", () => {
    const subject = build({ runtime: "production" });
    subject.subject.contextSummaryFallback({ taskId: "t" });
    const options = subject.opened[0]?.options;
    expect(options).toMatchObject({
      homeUrl: home,
      initialUrl: home,
      e2eOrigin: null,
      title: "Context recovery · Farol Dev",
      windowPresentation: { mode: "hidden" },
    });
    expect(options).not.toHaveProperty("surfaceFactory");
    expect(options).not.toHaveProperty("taskTimeoutMs");
    expect(subject.managed.size).toBe(1);
  });

  it("gives an e2e run its own fixture address and short timeouts", () => {
    const subject = build({
      e2eOrigin: fixtureOrigin,
      homeUrl: fixtureHome,
      env: { FAROL_E2E: "1" },
    });
    subject.subject.contextSummaryFallback({ taskId: "task-4" });
    expect(subject.opened[0]?.options).toMatchObject({
      homeUrl: fixtureHome,
      initialUrl: `${fixtureHome}?farol-e2e-task=context-task-4`,
      e2eOrigin: fixtureOrigin,
      taskTimeoutMs: 5_000,
      taskPollMs: 50,
    });
  });

  it("uses a recovered conversation url unchanged, even on a fixture origin", () => {
    const subject = build({ e2eOrigin: fixtureOrigin, homeUrl: fixtureHome });
    subject.subject.contextSummaryFallback(
      { taskId: "task-4" },
      `${fixtureOrigin}/c/recovered`,
    );
    expect(subject.opened[0]?.options.initialUrl).toBe(
      `${fixtureOrigin}/c/recovered`,
    );
    expect(subject.opened[0]?.options.homeUrl).toBe(fixtureHome);
  });
});
