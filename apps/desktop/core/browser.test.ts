import { describe, expect, it, vi } from "vitest";
import { createCoreBrowser, type CoreBrowserPorts } from "./browser";
import { BridgeError } from "../bridge/client";
import type { BrowserPrepare } from "../bridge/wire";
import { GoChatBrowserDriver } from "../go-chat-browser";
import { createDesktopChatBrowser } from "../go-chat-host";
import { captureChatStartupProfile } from "../go-chat-startup-profile";
import type { OperationsRecorder } from "../renderer/operations-contract";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";

// The chat browser the Go core is started with, over the real physical
// assignment host and driver and a recording route. The cases pin what each
// late getter is read for and when (the profile at driver creation, the home
// URL, the E2E origin and the profile route at worker-view creation), the
// route options of a hidden managed view, the owned-saved reopening URL, and
// that an unconfirmed open is classified unknown, never retried and never
// replaced by another route.

const context = { profileId: "profile", backendGeneration: "backend" };
const operations: OperationsRecorder = { record: vi.fn() };

function prepare(target: { mode: "new-saved" | "owned-saved"; id: string }) {
  const selection = {
    provider: "chatgpt",
    alias: "configured",
    accountId: "account",
    modelId: "model",
    effort: "",
    mode: "",
    connectorId: "",
    connectorGrantId: "",
    toolsEnabled: false,
  };
  const input: BrowserPrepare = {
    lease: {
      identity: {
        profileId: "profile",
        ownerId: "owner",
        sessionId: "session",
        taskId: "task-1",
        turnId: "turn-1",
        operationId: "operation-1",
        turnGeneration: "1",
      },
      backendGeneration: "backend",
      slotOrdinal: 1,
      slotGeneration: "1",
    },
    target: {
      mode: target.mode,
      conversationId: target.id,
      previousUserTurnId: "",
      previousReplyId: "",
      selection,
      required: { model: true, effort: false, mode: false, connector: false },
      resolution: {
        requestedAlias: "configured",
        requestedExecutor: "browser",
        requestedEffort: "",
        requestedMode: "",
        resolved: selection,
        configSHA256: "a".repeat(64),
        translationId: "fixture",
      },
    },
    deadlineMillis: "15000",
  };
  return input;
}

const profile = captureChatStartupProfile({
  environment: "dev",
  e2e: true,
  origin: "http://127.0.0.1:34567",
  tasks: {
    defaultHarness: "browser",
    harnesses: {
      browser: {
        defaultModel: "chatgpt",
        models: {
          chatgpt: { model: "controlled-model", defaultEffort: "low" },
        },
      },
    },
  },
});

function fixture(overrides: Partial<CoreBrowserPorts> = {}) {
  const log: string[] = [];
  const state = {
    profile: null as ReturnType<typeof captureChatStartupProfile>,
    home: "https://chatgpt.com/",
    origin: null as string | null,
  };
  const driverDeps: Parameters<CoreBrowserPorts["createDriver"]>[0][] = [];
  const hostOptions: Parameters<CoreBrowserPorts["createBrowser"]>[0][] = [];
  const physical = vi.fn<ChatGptRoute["chatPhysical"]>();
  const open = vi.fn<ChatGptRoute["open"]>(async () => {
    log.push("open");
    return { status: "opened" };
  });
  const createRoute = vi.fn<CoreBrowserPorts["createRoute"]>(() => {
    log.push("route");
    return { open, chatPhysical: physical };
  });
  const ports: CoreBrowserPorts = {
    createBrowser: (options) => {
      hostOptions.push(options);
      return createDesktopChatBrowser(options);
    },
    createDriver: (dependencies) => {
      driverDeps.push(dependencies);
      return new GoChatBrowserDriver(dependencies);
    },
    partition: "persist:farol-dev-chatgpt",
    operationsStore: () => operations,
    startupProfile: () => state.profile,
    homeUrl: () => state.home,
    e2eOrigin: () => state.origin,
    createRoute,
    displayProductName: "Farol Dev",
    ...overrides,
  };
  const browser = createCoreBrowser(ports);
  return {
    browser,
    state,
    driverDeps,
    hostOptions,
    createRoute,
    open,
    physical,
    log,
  };
}

describe("core chat browser", () => {
  it("hands the host the core's context and the identity's partition", () => {
    const f = fixture();
    const connection = f.browser(context);
    expect(f.hostOptions).toHaveLength(1);
    expect(f.hostOptions[0]!.context).toBe(context);
    expect(f.hostOptions[0]!.partition).toBe("persist:farol-dev-chatgpt");
    expect(typeof connection.withdraw).toBe("function");
  });

  it("builds the driver without a profile: the store, no translations, no origin", () => {
    const f = fixture();
    f.browser(context);
    expect(f.driverDeps).toHaveLength(1);
    const deps = f.driverDeps[0]!;
    expect(deps.operations).toBe(operations);
    expect(deps.translations).toEqual([]);
    expect("e2eOrigin" in deps).toBe(false);
  });

  it("builds the driver from the profile read at driver creation", () => {
    const f = fixture();
    f.state.profile = profile;
    f.browser(context);
    const deps = f.driverDeps[0]!;
    expect(deps.translations).toBe(profile!.snapshot.translations);
    expect(deps.e2eOrigin).toBe("http://127.0.0.1:34567");
  });

  it("opens a hidden managed route for a new saved target at the home URL", async () => {
    const f = fixture();
    f.state.profile = profile;
    f.state.origin = "http://127.0.0.1:34567";
    f.state.home = "http://127.0.0.1:34567/chatgpt";
    f.browser(context);
    // An identity sentinel: the physical API is returned, never inspected.
    const api = {} as ReturnType<ChatGptRoute["chatPhysical"]>;
    f.physical.mockReturnValue(api);
    const created = await f.hostOptions[0]!.create(
      prepare({ mode: "new-saved", id: "" }),
    );
    expect(created).toBe(api);
    expect(f.createRoute).toHaveBeenCalledTimes(1);
    const options = f.createRoute.mock.calls[0]![0];
    expect(options).toMatchObject({
      ...profile!.route,
      homeUrl: "http://127.0.0.1:34567/chatgpt",
      initialUrl: "http://127.0.0.1:34567/chatgpt",
      e2eOrigin: "http://127.0.0.1:34567",
      windowPresentation: { mode: "hidden" },
      title: "ChatGPT · Farol Dev",
    });
    expect(options.parent()).toBeNull();
    expect(f.log).toEqual(["route", "open"]);
  });

  it("reopens an owned saved target at its conversation URL", async () => {
    const f = fixture();
    f.browser(context);
    await f.hostOptions[0]!.create(
      prepare({ mode: "owned-saved", id: "conv_1-ok" }),
    );
    expect(f.createRoute.mock.calls[0]![0]).toMatchObject({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/c/conv_1-ok",
      e2eOrigin: null,
    });
  });

  it("reads the home URL, origin and profile route when the view is created", async () => {
    const f = fixture();
    f.browser(context);
    // Everything below changes after the builder exists and before the view.
    f.state.profile = profile;
    f.state.origin = "http://127.0.0.1:34567";
    f.state.home = "http://127.0.0.1:34567/chatgpt/";
    await f.hostOptions[0]!.create(prepare({ mode: "new-saved", id: "" }));
    expect(f.createRoute.mock.calls[0]![0]).toMatchObject({
      ...profile!.route,
      homeUrl: "http://127.0.0.1:34567/chatgpt/",
      e2eOrigin: "http://127.0.0.1:34567",
    });
  });

  it("refuses an invalid owned conversation before any route exists", async () => {
    const f = fixture();
    f.browser(context);
    await expect(
      f.hostOptions[0]!.create(
        prepare({ mode: "owned-saved", id: "../replacement" }),
      ),
    ).rejects.toThrow("CHAT_WORKER_CONVERSATION_INVALID");
    expect(f.createRoute).not.toHaveBeenCalled();
  });

  it("classifies an unreachable open unknown and never retries it", async () => {
    const f = fixture();
    f.open.mockResolvedValue({ status: "unreachable" });
    f.browser(context);
    const failure = await f.hostOptions[0]!.create(
      prepare({ mode: "new-saved", id: "" }),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BridgeError);
    expect(failure).toMatchObject({
      state: "unknown",
      code: "host_chat_browser_open_unconfirmed",
    });
    expect(f.createRoute).toHaveBeenCalledTimes(1);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.physical).not.toHaveBeenCalled();
  });

  it("lets a rejecting open propagate without a second route", async () => {
    const f = fixture();
    f.open.mockRejectedValue(new Error("window gone"));
    f.browser(context);
    await expect(
      f.hostOptions[0]!.create(prepare({ mode: "new-saved", id: "" })),
    ).rejects.toThrow("window gone");
    expect(f.createRoute).toHaveBeenCalledTimes(1);
    expect(f.physical).not.toHaveBeenCalled();
  });
});
