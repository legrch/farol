import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { channels } from "../../../src/pkg/ipc/channels";
import { createRuntimeStatus, type RuntimeStatusPorts } from "./status";

// The runtime status over scripted owners. Main's `let`s are fields the ports
// read afresh, so a test changes one field and the next call sees it. The
// window, the native image constructor and the runtime's HTTP endpoint are
// fakes that record what they were given; no window, image file or socket
// exists. The bootstrap payload is compared by key order as well as by value,
// because the renderer contract reads it positionally in places.

function fake<T>(value: unknown): T {
  return value as T;
}

type State = {
  runtime: {
    port: number;
    token: string;
    identity:
      "farol-runtime" | "farol-dev-runtime" | "farol-owner-preview-runtime";
    embeddedNode: string;
    embeddedElectron: string;
  } | null;
  runtimeState: "starting" | "ready" | "offline" | "failed";
  runtimeError: string | null;
  window: { webContents: { send: ReturnType<typeof vi.fn> } } | null;
  desktopGoCore: { historyContext: unknown; limitedSession: boolean } | null;
  configuration: { snapshot: () => unknown } | null;
  selectedTaskId: string;
  chatGptRoute: {
    loadState: () => string;
    navigationHistory: () => { back: boolean; forward: boolean };
  } | null;
  recoverableChatGptTask: object | null;
  chatGptSignInOutcome: unknown;
};

const readyRuntime = {
  port: 4242,
  token: "t".repeat(32),
  identity: "farol-runtime" as const,
  embeddedNode: "24.1.0",
  embeddedElectron: "41.0.0",
};

type Build = Readonly<{
  state?: Partial<State>;
  environment?: "production" | "dev" | "owner-preview";
  demoMode?: boolean;
  legacySetupTestMode?: boolean;
  compiledGoCore?: unknown;
  env?: Record<string, string | undefined>;
  liveTaskRoutes?: Map<string, unknown>;
  fetch?: RuntimeStatusPorts["fetch"];
  image?: { isEmpty: () => boolean };
}>;

function build(options: Build = {}) {
  const log: string[] = [];
  const state: State = {
    runtime: readyRuntime,
    runtimeState: "ready",
    runtimeError: null,
    window: null,
    desktopGoCore: null,
    configuration: null,
    selectedTaskId: "",
    chatGptRoute: null,
    recoverableChatGptTask: null,
    chatGptSignInOutcome: null,
    ...options.state,
  };
  const createFromPath = vi.fn((file: string) => {
    log.push(`image:${file}`);
    return options.image ?? { isEmpty: () => false };
  });
  const fetchMock = vi.fn(
    options.fetch ??
      (async () => ({
        status: 200,
        ok: true,
        json: async () => ({ answered: true }),
      })),
  );
  const environment = options.environment ?? "production";
  const buildIdentity = {
    version: "1.2.3",
    updateChannel: "stable",
    buildId: "build-1",
  };
  const ports = {
    runtime: () => state.runtime,
    runtimeState: () => state.runtimeState,
    runtimeError: () => state.runtimeError,
    window: () => fake<ReturnType<RuntimeStatusPorts["window"]>>(state.window),
    desktopGoCore: () =>
      fake<ReturnType<RuntimeStatusPorts["desktopGoCore"]>>(
        state.desktopGoCore,
      ),
    configuration: () =>
      fake<ReturnType<RuntimeStatusPorts["configuration"]>>(
        state.configuration,
      ),
    selectedTaskId: () => state.selectedTaskId,
    chatGptRoute: () =>
      fake<ReturnType<RuntimeStatusPorts["chatGptRoute"]>>(state.chatGptRoute),
    liveTaskRoutes: fake<RuntimeStatusPorts["liveTaskRoutes"]>(
      options.liveTaskRoutes ?? new Map(),
    ),
    recoverableChatGptTask: () =>
      fake<ReturnType<RuntimeStatusPorts["recoverableChatGptTask"]>>(
        state.recoverableChatGptTask,
      ),
    chatGptSignInOutcome: () =>
      fake<ReturnType<RuntimeStatusPorts["chatGptSignInOutcome"]>>(
        state.chatGptSignInOutcome,
      ),
    chatGptSignInBlocked: {
      current: () =>
        fake<ReturnType<RuntimeStatusPorts["chatGptSignInBlocked"]["current"]>>(
          "blocked-now",
        ),
    },
    nativeImage: {
      createFromPath:
        fake<RuntimeStatusPorts["nativeImage"]["createFromPath"]>(
          createFromPath,
        ),
    },
    fetch: (input: string, init: RequestInit) => fetchMock(input, init),
    directory: "/app/dir",
    env: options.env ?? {},
    versions: { electron: "40.9.9" },
    productName: "Farol",
    bundleId: "io.example.farol",
    activeDesktopIdentity: fake<RuntimeStatusPorts["activeDesktopIdentity"]>({
      environment,
      displayName: "Farol Name",
      displayEdition: "Edition",
      applicationId: "app-id",
      runtimePartition: "persist:runtime",
      chatGptPartition: "persist:chatgpt",
    }),
    buildIdentity: fake<RuntimeStatusPorts["buildIdentity"]>(buildIdentity),
    demoMode: options.demoMode ?? false,
    legacySetupTestMode: options.legacySetupTestMode ?? false,
    compiledGoCore: "compiledGoCore" in options ? options.compiledGoCore : null,
    WORKSPACE_EDIT_ACK_HOLD_ENV: "ACK_HOLD",
    WORKSPACE_EDIT_ACK_HOLD_INVALID: "ACK_HOLD_INVALID",
    e2eBudget: (
      env: Readonly<Record<string, string | undefined>>,
      name: string,
      invalidCode: string,
    ) => {
      log.push(`budget:${name}:${invalidCode}`);
      if (env.FAROL_E2E !== "1") return null;
      const raw = env[name];
      if (raw === undefined) return null;
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(invalidCode);
      }
      return value;
    },
    productTasksState: () => {
      log.push("tasks");
      return fake<ReturnType<RuntimeStatusPorts["productTasksState"]>>({
        revision: 7,
        tasks: [{ taskId: "t1" }],
      });
    },
    currentConnectionStatus: () => ({ connection: "status" }),
    chatGptConversationState: () => "retained",
    productAgentCapabilityAvailable: () => true,
    currentWindowState: () =>
      fake<ReturnType<RuntimeStatusPorts["currentWindowState"]>>({
        window: "state",
      }),
  } satisfies RuntimeStatusPorts;
  return {
    status: createRuntimeStatus(ports),
    state,
    log,
    createFromPath,
    fetchMock,
  };
}

const payloadKeys = [
  "schema",
  "chatHistoryContext",
  "productName",
  "bundleId",
  "environment",
  "displayName",
  "displayEdition",
  "applicationId",
  "build",
  "demoMode",
  "legacySetupTestMode",
  "configuration",
  "runtimeState",
  "independentSession",
  "browserRouteState",
  "browserHistoryState",
  "connectionStatus",
  "runtimeError",
  "runtimeIdentity",
  "embeddedNode",
  "embeddedElectron",
  "taskRevision",
  "tasks",
  "selectedTaskId",
  "partition",
  "chatgptPartition",
  "chatgptRecoveryPending",
  "chatgptConversationState",
  "updateChannel",
  "nativeFilesystem",
  "nativeAgent",
  "gitVerificationAvailable",
  "liveProvider",
  "windowState",
  "chatgptSignInBlocked",
  "chatgptSignInOutcome",
  "e2eWorkspaceEditAckHold",
];

describe("runtime base", () => {
  it("is the loopback address of the ready runtime and null without one", () => {
    const { status, state } = build();
    expect(status.runtimeBase()).toBe("http://127.0.0.1:4242");
    state.runtime = null;
    expect(status.runtimeBase()).toBeNull();
    state.runtime = { ...readyRuntime, port: 5151 };
    expect(status.runtimeBase()).toBe("http://127.0.0.1:5151");
  });
});

describe("bootstrap payload", () => {
  it("keeps every field and its order", () => {
    const { status } = build();
    expect(Object.keys(status.bootstrap())).toEqual(payloadKeys);
  });

  it("describes a normal run from the state read at the call", () => {
    const snapshot = { status: "ready", settings: {} };
    const history = { back: true, forward: false };
    const { status, state, log } = build({
      state: {
        desktopGoCore: { historyContext: { id: "ctx" }, limitedSession: true },
        configuration: { snapshot: () => snapshot },
        chatGptRoute: {
          loadState: () => "loaded",
          navigationHistory: () => history,
        },
        recoverableChatGptTask: {},
        chatGptSignInOutcome: { outcome: "diag" },
      },
      compiledGoCore: { declared: true },
    });
    expect(status.bootstrap()).toEqual({
      schema: 3,
      chatHistoryContext: { id: "ctx" },
      productName: "Farol",
      bundleId: "io.example.farol",
      environment: "production",
      displayName: "Farol Name",
      displayEdition: "Edition",
      applicationId: "app-id",
      build: { version: "1.2.3", updateChannel: "stable", buildId: "build-1" },
      demoMode: false,
      legacySetupTestMode: false,
      configuration: snapshot,
      runtimeState: "ready",
      independentSession: true,
      browserRouteState: { state: "loaded" },
      browserHistoryState: { taskId: "", back: true, forward: false },
      connectionStatus: { connection: "status" },
      runtimeError: null,
      runtimeIdentity: "farol-runtime",
      embeddedNode: "24.1.0",
      embeddedElectron: "41.0.0",
      taskRevision: 7,
      tasks: [{ taskId: "t1" }],
      selectedTaskId: "",
      partition: "persist:runtime",
      chatgptPartition: "persist:chatgpt",
      chatgptRecoveryPending: true,
      chatgptConversationState: "retained",
      updateChannel: "stable",
      nativeFilesystem: true,
      nativeAgent: true,
      gitVerificationAvailable: false,
      liveProvider: false,
      windowState: { window: "state" },
      chatgptSignInBlocked: "blocked-now",
      chatgptSignInOutcome: { outcome: "diag" },
      e2eWorkspaceEditAckHold: null,
    });
    expect(log.filter((entry) => entry === "tasks")).toHaveLength(1);
    // A change in main between two calls is seen by the next one.
    state.runtimeState = "failed";
    state.runtimeError = "RUNTIME_FAILED";
    state.selectedTaskId = "task-9";
    state.recoverableChatGptTask = null;
    const next = status.bootstrap() as Record<string, unknown>;
    expect(next.runtimeState).toBe("failed");
    expect(next.runtimeError).toBe("RUNTIME_FAILED");
    expect(next.selectedTaskId).toBe("task-9");
    expect(next.chatgptRecoveryPending).toBe(false);
  });

  it("falls back where an owner is absent", () => {
    const { status } = build({ state: { runtime: null } });
    expect(status.bootstrap()).toMatchObject({
      chatHistoryContext: null,
      configuration: { status: "error", error: "SETTINGS_READ_FAILED" },
      independentSession: false,
      browserRouteState: { state: "loading" },
      browserHistoryState: { taskId: "", back: false, forward: false },
      runtimeIdentity: null,
      embeddedNode: null,
      embeddedElectron: "40.9.9",
      gitVerificationAvailable: true,
      chatgptRecoveryPending: false,
      chatgptSignInOutcome: null,
    });
  });

  it("takes the navigation of the selected task's route and omits the browser route state", () => {
    const routes = new Map<string, unknown>([
      ["task-1", { navigationHistory: () => ({ back: false, forward: true }) }],
    ]);
    const { status, state } = build({
      state: {
        selectedTaskId: "task-1",
        chatGptRoute: {
          loadState: () => "failed",
          navigationHistory: () => ({ back: true, forward: true }),
        },
      },
      liveTaskRoutes: routes,
    });
    const payload = status.bootstrap() as Record<string, unknown>;
    expect(payload.browserRouteState).toBeUndefined();
    expect(Object.keys(payload)).toEqual(payloadKeys);
    expect(payload.browserHistoryState).toEqual({
      taskId: "task-1",
      back: false,
      forward: true,
    });
    state.selectedTaskId = "unrouted";
    expect(
      (status.bootstrap() as Record<string, unknown>).browserHistoryState,
    ).toEqual({ taskId: "unrouted", back: false, forward: false });
  });

  it("states the demo mode and the legacy setup mode", () => {
    const { status } = build({
      demoMode: true,
      legacySetupTestMode: true,
      environment: "dev",
    });
    expect(status.bootstrap()).toMatchObject({
      demoMode: true,
      legacySetupTestMode: true,
      environment: "dev",
    });
  });

  it("states the preview identity", () => {
    const { status } = build({ environment: "owner-preview" });
    expect(status.bootstrap()).toMatchObject({
      environment: "owner-preview",
      partition: "persist:runtime",
      chatgptPartition: "persist:chatgpt",
    });
  });

  it("publishes the guarded edit hold only under the E2E gate", () => {
    const off = build({ env: { ACK_HOLD: "5" } });
    expect(
      (off.status.bootstrap() as Record<string, unknown>)
        .e2eWorkspaceEditAckHold,
    ).toBeNull();
    const on = build({ env: { FAROL_E2E: "1", ACK_HOLD: "5" } });
    expect(
      (on.status.bootstrap() as Record<string, unknown>)
        .e2eWorkspaceEditAckHold,
    ).toBe(5);
    expect(on.log).toContain("budget:ACK_HOLD:ACK_HOLD_INVALID");
    const invalid = build({ env: { FAROL_E2E: "1", ACK_HOLD: "-1" } });
    expect(() => invalid.status.bootstrap()).toThrow("ACK_HOLD_INVALID");
  });
});

describe("runtime status event", () => {
  it("reads the current state", () => {
    const { status, state } = build();
    expect(status.currentRuntimeStatus()).toEqual({
      state: "ready",
      error: null,
      identity: "farol-runtime",
      embeddedNode: "24.1.0",
      embeddedElectron: "41.0.0",
    });
    state.runtime = null;
    state.runtimeState = "offline";
    state.runtimeError = "RUNTIME_STOPPED";
    expect(status.currentRuntimeStatus()).toEqual({
      state: "offline",
      error: "RUNTIME_STOPPED",
      identity: null,
      embeddedNode: null,
      embeddedElectron: "40.9.9",
    });
  });

  it("sends the status to the window that exists at the call", () => {
    const { status, state } = build();
    expect(() => status.publishRuntimeStatus()).not.toThrow();
    const send = vi.fn();
    state.window = { webContents: { send } };
    status.publishRuntimeStatus();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(channels.runtimeState, {
      state: "ready",
      error: null,
      identity: "farol-runtime",
      embeddedNode: "24.1.0",
      embeddedElectron: "41.0.0",
    });
    state.window = null;
    status.publishRuntimeStatus();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("brand image", () => {
  it.each([
    ["dev", "farol-dev-mark.png"],
    ["owner-preview", "farol-preview-mark.png"],
    ["production", "farol-mark.png"],
  ] as const)(
    "loads the %s mark from the app directory",
    (environment, file) => {
      const { status, createFromPath, log } = build({ environment });
      const image = status.desktopBrandImage();
      expect(createFromPath).toHaveBeenCalledWith(path.join("/app/dir", file));
      expect(log).toEqual([`image:${path.join("/app/dir", file)}`]);
      expect(image.isEmpty()).toBe(false);
    },
  );

  it("refuses an image that did not load", () => {
    const { status } = build({ image: { isEmpty: () => true } });
    expect(() => status.desktopBrandImage()).toThrow(
      "DESKTOP_BRAND_IMAGE_INVALID",
    );
  });
});

describe("runtime json", () => {
  it("reports an offline runtime without a request", async () => {
    const { status, state, fetchMock } = build({ state: { runtime: null } });
    await expect(status.runtimeJson("/x")).resolves.toEqual({
      error: "RUNTIME_OFFLINE",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    state.runtime = readyRuntime;
    await expect(status.runtimeJson("/x")).resolves.toEqual({
      answered: true,
    });
  });

  it("sends an authenticated GET without a body", async () => {
    const { status, fetchMock } = build();
    await expect(status.runtimeJson("/health")).resolves.toEqual({
      answered: true,
    });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4242/health", {
      method: "GET",
      headers: { authorization: `Bearer ${"t".repeat(32)}` },
    });
  });

  it("sends a JSON body with its content type", async () => {
    const { status, fetchMock } = build();
    await status.runtimeJson("/mutate", "POST", { a: 1 });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4242/mutate", {
      method: "POST",
      headers: {
        authorization: `Bearer ${"t".repeat(32)}`,
        "content-type": "application/json",
      },
      body: '{"a":1}',
    });
  });

  it("answers ok for no content", async () => {
    const json = vi.fn();
    const { status } = build({
      fetch: async () => ({ status: 204, ok: true, json }),
    });
    await expect(status.runtimeJson("/x", "DELETE")).resolves.toEqual({
      ok: true,
    });
    expect(json).not.toHaveBeenCalled();
  });

  it("wraps a failing status with its body", async () => {
    const { status } = build({
      fetch: async () => ({
        status: 409,
        ok: false,
        json: async () => ({ error: "CONFLICT" }),
      }),
    });
    await expect(status.runtimeJson("/x", "POST", {})).resolves.toEqual({
      ok: false,
      status: 409,
      value: { error: "CONFLICT" },
    });
  });

  it("lets a failing request surface", async () => {
    const { status } = build({
      fetch: async () => {
        throw new Error("socket closed");
      },
    });
    await expect(status.runtimeJson("/x")).rejects.toThrow("socket closed");
  });
});
