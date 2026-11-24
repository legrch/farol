import { createServer } from "node:net";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexCallerRelayRuntime } from "../../../src/apps/desktop/codex-caller-relay";
import { createBridge, type BridgePorts } from "./bridge";

// The relay and bridge starts over scripted owners. Main's `let`s are fields
// the ports read afresh; the two launchers are fakes that record what they
// were given; the state directories are real private temporary directories so
// the socket cleanup and the private-root checks run on a real file system. No
// socket server of the product, window, dialog, account or Browser route runs.
const partition = "persist:farol-dev-chatgpt" as const;
const buildId = "build-1";
const verified = {
  profile: "chatgpt.app-partition/1",
  runtimeGeneration: `${partition}:${buildId}`,
  buildId,
  protocol: "chatgpt-page-readiness/1",
};

function fake<T>(value: unknown): T {
  return value as T;
}

type Snapshot = Readonly<{
  status: string;
  settings?: {
    setup: { chatgpt: { outcomeUnknown: boolean; verified: unknown } };
  };
}>;

const ready = (
  overrides: Partial<{ outcomeUnknown: boolean; verified: unknown }> = {},
): Snapshot => ({
  status: "ready",
  settings: {
    setup: { chatgpt: { outcomeUnknown: false, verified, ...overrides } },
  },
});

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function privateTemp(base: string = os.tmpdir()): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(base, "bridge-")));
  roots.push(root);
  return root;
}

function build(
  options: Readonly<{
    root: string;
    e2eHome?: string;
    environment?: string;
    optIn?: string | undefined;
    snapshot?: Snapshot | null;
    fence?: boolean;
    window?: "none" | "destroyed" | "live";
    response?: number;
    relayStart?: () => Promise<unknown>;
    bridgeStart?: () => Promise<unknown>;
    handoffThrows?: boolean;
    homeUrl?: string;
    origin?: string | null;
  }>,
) {
  const events: string[] = [];
  const state = {
    snapshot: options.snapshot === undefined ? ready() : options.snapshot,
    homeUrl: options.homeUrl ?? "https://chatgpt.test/",
    origin: options.origin === undefined ? null : options.origin,
    fence: options.fence ?? true,
    window: options.window ?? "live",
    response: options.response ?? 1,
  };
  const relayHandle = { close: vi.fn(async () => {}), id: "relay" };
  const bridgeHandle = { close: vi.fn(async () => {}), id: "bridge" };
  const relayStarts: unknown[] = [];
  const bridgeStarts: { service: unknown; admission: unknown }[] = [];
  const handoffs: {
    root: string;
    canonical: (url: string) => string | null;
    browser: { prepare(): Promise<string> };
    approve: (
      request: { key: string; title: string; firstMessage: string },
      digest: string,
    ) => Promise<boolean>;
  }[] = [];
  const routeOptions: unknown[] = [];
  const dialogs: { window: unknown; options: Record<string, unknown> }[] = [];
  const destroyed = options.window === "destroyed";
  const owner = { isDestroyed: () => destroyed, id: "window" };
  const admission = { admitted: true as const, release: async () => {} };
  const acquireAdmission = vi.fn(async () => admission);

  const ports: BridgePorts = {
    statePaths: () => ({
      callerRelay: path.join(options.root, "relay"),
      savedChatHandoff: path.join(options.root, "handoff"),
    }),
    isolatedE2EHome: options.e2eHome,
    runtimeEnvironment: options.environment ?? "dev",
    activeDesktopIdentity: {
      chatGptPartition: partition,
      displayName: "Farol Dev",
    },
    buildIdentity: { buildId },
    env: {
      FAROL_SAVED_CHAT_PREVIEW: "optIn" in options ? options.optIn : "1",
    },
    configuration: () =>
      state.snapshot === null
        ? null
        : fake<ReturnType<BridgePorts["configuration"]>>({
            snapshot: () => state.snapshot,
          }),
    summaryExecutionFence: () => (state.fence ? { acquireAdmission } : null),
    window: () => (state.window === "none" ? null : fake<BrowserWindow>(owner)),
    chatGptHomeUrl: () => state.homeUrl,
    chatGptE2eOrigin: () => state.origin,
    createManagedChatGptRoute: (routeOptionsValue) => {
      routeOptions.push(routeOptionsValue);
      return fake({
        open: async () => ({ status: "failed" }),
        dispose: () => events.push("route-dispose"),
      });
    },
    showMessageBox: async (target, boxOptions) => {
      dialogs.push({ window: target, options: { ...boxOptions } });
      return { response: state.response };
    },
    startCodexCallerRelay: async (startOptions) => {
      relayStarts.push(startOptions);
      events.push("relay-start");
      return fake<CodexCallerRelayRuntime>(
        (await options.relayStart?.()) ?? relayHandle,
      );
    },
    startSavedChatBridge: async (service, admissionPort) => {
      bridgeStarts.push({ service, admission: admissionPort });
      events.push("bridge-start");
      return fake(await (options.bridgeStart?.() ?? bridgeHandle));
    },
    createSavedChatHandoff: (root, canonical, browser, approve) => {
      events.push("handoff");
      if (options.handoffThrows) throw new Error("HANDOFF_FAILED");
      handoffs.push({ root, canonical, browser, approve });
      return fake({ create: vi.fn(), status: vi.fn() });
    },
  };
  return {
    bridge: createBridge(ports),
    state,
    events,
    relayHandle,
    bridgeHandle,
    relayStarts,
    bridgeStarts,
    handoffs,
    routeOptions,
    dialogs,
    owner,
    acquireAdmission,
  };
}

describe("caller relay", () => {
  it("starts the relay under the profile directory and keeps it in the owner cell", async () => {
    const root = await privateTemp();
    const h = build({ root });
    expect(h.bridge.relay.get()).toBeNull();
    await h.bridge.initializeCallerRelay();
    expect(h.relayStarts).toEqual([{ root: path.join(root, "relay") }]);
    expect(h.bridge.relay.get()).toBe(h.relayHandle);
  });

  it("starts nothing when a relay is already held", async () => {
    const root = await privateTemp();
    const h = build({ root });
    await h.bridge.initializeCallerRelay();
    await h.bridge.initializeCallerRelay();
    expect(h.relayStarts).toHaveLength(1);
  });

  it("starts nothing when main already put a relay in the cell", async () => {
    const root = await privateTemp();
    const h = build({ root });
    const mine = fake<CodexCallerRelayRuntime>({ id: "main" });
    h.bridge.relay.set(mine);
    await h.bridge.initializeCallerRelay();
    expect(h.relayStarts).toHaveLength(0);
    expect(h.bridge.relay.get()).toBe(mine);
  });

  it("swallows a failed start and leaves the cell empty", async () => {
    const root = await privateTemp();
    const h = build({
      root,
      relayStart: async () => {
        throw new Error("RELAY_FAILED");
      },
    });
    await expect(h.bridge.initializeCallerRelay()).resolves.toBeUndefined();
    expect(h.bridge.relay.get()).toBeNull();
    expect(h.relayStarts).toHaveLength(1);
  });

  it("clears a handle from an earlier run when a later start fails", async () => {
    const root = await privateTemp();
    let fail = false;
    const h = build({
      root,
      relayStart: async () => {
        if (fail) throw new Error("RELAY_FAILED");
        return { id: "first" };
      },
    });
    await h.bridge.initializeCallerRelay();
    h.bridge.relay.set(null);
    fail = true;
    await h.bridge.initializeCallerRelay();
    expect(h.bridge.relay.get()).toBeNull();
  });

  it("removes a socket of this user before it starts", async () => {
    // A unix socket path must stay short, so the profile directory is not used.
    const short = await privateTemp("/tmp");
    const relayRoot = path.join(short, "relay");
    await mkdir(relayRoot);
    const socket = path.join(relayRoot, "caller-relay.sock");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      expect((await lstat(socket)).isSocket()).toBe(true);
      const h = build({ root: short });
      await h.bridge.initializeCallerRelay();
      await expect(lstat(socket)).rejects.toThrow();
      expect(h.relayStarts).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("leaves a regular file named like the socket alone", async () => {
    const root = await privateTemp();
    await mkdir(path.join(root, "relay"));
    const file = path.join(root, "relay", "caller-relay.sock");
    await writeFile(file, "not a socket");
    const h = build({ root });
    await h.bridge.initializeCallerRelay();
    expect((await stat(file)).isFile()).toBe(true);
    expect(h.relayStarts).toHaveLength(1);
  });

  it("starts when there is no previous socket", async () => {
    const root = await privateTemp();
    const h = build({ root });
    await h.bridge.initializeCallerRelay();
    expect(h.events).toEqual(["relay-start"]);
  });

  it("asks for the directory witness only under an isolated E2E home", async () => {
    const root = await privateTemp();
    const plain = build({ root });
    await plain.bridge.initializeCallerRelay();
    expect(plain.relayStarts[0]).not.toHaveProperty("onDirectoryPrepared");

    const e2e = build({ root, e2eHome: "/e2e/home" });
    await e2e.bridge.initializeCallerRelay();
    const given = e2e.relayStarts[0] as {
      root: string;
      onDirectoryPrepared: (witness: unknown) => void;
    };
    expect(typeof given.onDirectoryPrepared).toBe("function");
    expect(e2e.bridge.directoryWitness.get()).toBeNull();
    const witness = { created: true };
    given.onDirectoryPrepared(witness);
    expect(e2e.bridge.directoryWitness.get()).toBe(witness);
    expect(plain.bridge.directoryWitness.get()).toBeNull();
  });
});

describe("saved-chat bridge gating", () => {
  async function untouched(h: ReturnType<typeof build>, root: string) {
    await h.bridge.initializeSavedChatBridge();
    expect(h.bridgeStarts).toHaveLength(0);
    expect(h.events).toEqual([]);
    expect(h.bridge.saved.get()).toBeNull();
    await expect(lstat(path.join(root, "handoff"))).rejects.toThrow();
  }

  it("does nothing without a summary fence", async () => {
    const root = await privateTemp();
    await untouched(build({ root, fence: false }), root);
  });

  it("does nothing without a configuration", async () => {
    const root = await privateTemp();
    await untouched(build({ root, snapshot: null }), root);
  });

  it("does nothing while the configuration is not ready", async () => {
    const root = await privateTemp();
    await untouched(build({ root, snapshot: { status: "failed" } }), root);
  });

  it("does nothing without the owner opt-in", async () => {
    const root = await privateTemp();
    await untouched(build({ root, optIn: undefined }), root);
    await untouched(build({ root, optIn: "0" }), root);
  });

  it("does nothing outside a Dev, preview or owner-preview environment", async () => {
    const root = await privateTemp();
    await untouched(build({ root, environment: "production" }), root);
  });

  it("does nothing while an outcome is unknown or the verification is missing or mismatched", async () => {
    const root = await privateTemp();
    await untouched(
      build({ root, snapshot: ready({ outcomeUnknown: true }) }),
      root,
    );
    await untouched(build({ root, snapshot: ready({ verified: null }) }), root);
    await untouched(
      build({
        root,
        snapshot: ready({ verified: { ...verified, buildId: "other" } }),
      }),
      root,
    );
  });

  it.each(["dev", "preview", "owner-preview"])(
    "qualifies in the %s environment",
    async (environment) => {
      const root = await privateTemp();
      const h = build({ root, environment });
      await h.bridge.initializeSavedChatBridge();
      expect(h.bridgeStarts).toHaveLength(1);
    },
  );

  it("starts nothing when a bridge is already held", async () => {
    const root = await privateTemp();
    const h = build({ root });
    await h.bridge.initializeSavedChatBridge();
    await h.bridge.initializeSavedChatBridge();
    expect(h.bridgeStarts).toHaveLength(1);
  });

  it("reads the fence once, before qualifying", async () => {
    const root = await privateTemp();
    const h = build({ root });
    await h.bridge.initializeSavedChatBridge();
    expect(h.bridgeStarts[0]?.admission).toBeTypeOf("function");
    expect(h.acquireAdmission).not.toHaveBeenCalled();
    await (h.bridgeStarts[0]?.admission as () => Promise<unknown>)();
    expect(h.acquireAdmission).toHaveBeenCalledOnce();
  });
});

describe("saved-chat bridge start", () => {
  it("creates a private root, hands the journal root to the handoff and keeps the bridge in the owner cell", async () => {
    const root = await privateTemp();
    const h = build({ root });
    await h.bridge.initializeSavedChatBridge();
    const handoffRoot = path.join(root, "handoff");
    expect((await stat(handoffRoot)).mode & 0o777).toBe(0o700);
    expect(h.handoffs[0]?.root).toBe(handoffRoot);
    expect(h.events).toEqual(["handoff", "bridge-start"]);
    expect(h.bridgeStarts[0]?.service).toBeDefined();
    expect(h.bridge.saved.get()).toBe(h.bridgeHandle);
  });

  it("leaves the cell empty and starts nothing when the root is not private", async () => {
    const root = await privateTemp();
    const handoffRoot = path.join(root, "handoff");
    await mkdir(handoffRoot);
    await chmod(handoffRoot, 0o755);
    const h = build({ root });
    await h.bridge.initializeSavedChatBridge();
    expect(h.bridgeStarts).toHaveLength(0);
    expect(h.events).toEqual([]);
    expect(h.bridge.saved.get()).toBeNull();
  });

  it("refuses a root reached through a symbolic link", async () => {
    const root = await privateTemp();
    const target = path.join(root, "elsewhere");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, path.join(root, "handoff"));
    const h = build({ root });
    await h.bridge.initializeSavedChatBridge();
    expect(h.bridgeStarts).toHaveLength(0);
    expect(h.bridge.saved.get()).toBeNull();
  });

  it("swallows a failed bridge start and leaves the cell empty", async () => {
    const root = await privateTemp();
    const h = build({
      root,
      bridgeStart: async () => {
        throw new Error("BRIDGE_FAILED");
      },
    });
    await expect(h.bridge.initializeSavedChatBridge()).resolves.toBeUndefined();
    expect(h.bridge.saved.get()).toBeNull();
    expect(h.bridgeStarts).toHaveLength(1);
  });

  it("swallows a failure while building the handoff", async () => {
    const root = await privateTemp();
    const h = build({ root, handoffThrows: true });
    await expect(h.bridge.initializeSavedChatBridge()).resolves.toBeUndefined();
    expect(h.bridge.saved.get()).toBeNull();
    expect(h.bridgeStarts).toHaveLength(0);
  });

  it("canonicalizes against the E2E origin main holds when the URL is asked", async () => {
    const root = await privateTemp();
    const h = build({ root });
    await h.bridge.initializeSavedChatBridge();
    const canonical = h.handoffs[0]!.canonical;
    expect(canonical("https://chatgpt.com/c/abcdef-12345/")).toBe(
      "https://chatgpt.com/c/abcdef-12345",
    );
    expect(
      canonical("http://127.0.0.1:4010/chatgpt/c/abcdef-12345"),
    ).toBeNull();
    h.state.origin = "http://127.0.0.1:4010";
    expect(canonical("http://127.0.0.1:4010/chatgpt/c/abcdef-12345")).toBe(
      "http://127.0.0.1:4010/chatgpt/c/abcdef-12345",
    );
  });

  it("opens the Browser route on the dedicated partition and the home main holds", async () => {
    const root = await privateTemp();
    const h = build({ root, origin: "http://127.0.0.1:4010" });
    await h.bridge.initializeSavedChatBridge();
    await expect(h.handoffs[0]!.browser.prepare()).resolves.toBe("unavailable");
    expect(h.routeOptions).toHaveLength(1);
    expect(h.routeOptions[0]).toMatchObject({
      homeUrl: "https://chatgpt.test/",
      initialUrl: "https://chatgpt.test/",
      e2eOrigin: "http://127.0.0.1:4010",
      partition,
      title: "Farol · Saved ChatGPT handoff",
    });
  });

  it("requires the Dev app name only in the dev environment", async () => {
    const dev = build({ root: await privateTemp(), environment: "dev" });
    await dev.bridge.initializeSavedChatBridge();
    await dev.handoffs[0]!.browser.prepare();
    expect(dev.routeOptions[0]).toMatchObject({ requiredAppName: "Farol Dev" });

    const preview = build({
      root: await privateTemp(),
      environment: "preview",
    });
    await preview.bridge.initializeSavedChatBridge();
    await preview.handoffs[0]!.browser.prepare();
    expect(preview.routeOptions[0]).not.toHaveProperty("requiredAppName");
  });
});

describe("saved-chat send approval", () => {
  const request = { key: "key-1", title: "Title 1", firstMessage: "Hello" };

  async function approval(h: ReturnType<typeof build>) {
    await h.bridge.initializeSavedChatBridge();
    return h.handoffs[0]!.approve;
  }

  it("shows the receipt in a modal on the window and sends once on the account-checked choice", async () => {
    const h = build({ root: await privateTemp(), response: 1 });
    const approve = await approval(h);
    await expect(approve(request, "digest-1")).resolves.toBe(true);
    expect(h.dialogs).toHaveLength(1);
    expect(h.dialogs[0]?.window).toBe(h.owner);
    expect(h.dialogs[0]?.options).toMatchObject({
      type: "warning",
      buttons: ["Do not send", "Account checked — send once"],
      defaultId: 0,
      cancelId: 0,
      message: "Send this first message through Farol Browser?",
    });
    const detail = String(h.dialogs[0]?.options.detail);
    expect(detail).toContain("Title: Title 1");
    expect(detail).toContain("Key: key-1");
    expect(detail).toContain("Digest: digest-1");
    expect(detail.endsWith("\n\nHello")).toBe(true);
  });

  it("does not send on the default choice", async () => {
    const h = build({ root: await privateTemp(), response: 0 });
    const approve = await approval(h);
    await expect(approve(request, "digest-1")).resolves.toBe(false);
  });

  it("refuses without a window or with a destroyed one, and shows nothing", async () => {
    const none = build({ root: await privateTemp(), window: "none" });
    await expect((await approval(none))(request, "d")).resolves.toBe(false);
    expect(none.dialogs).toHaveLength(0);

    const gone = build({ root: await privateTemp(), window: "destroyed" });
    await expect((await approval(gone))(request, "d")).resolves.toBe(false);
    expect(gone.dialogs).toHaveLength(0);
  });

  it("reads the window afresh when the owner approves", async () => {
    const h = build({ root: await privateTemp() });
    const approve = await approval(h);
    h.state.window = "none";
    await expect(approve(request, "d")).resolves.toBe(false);
    h.state.window = "live";
    await expect(approve(request, "d")).resolves.toBe(true);
  });

  it("refuses before asking once the preview no longer qualifies", async () => {
    const h = build({ root: await privateTemp() });
    const approve = await approval(h);
    h.state.snapshot = { status: "failed" };
    await expect(approve(request, "d")).resolves.toBe(false);
    expect(h.dialogs).toHaveLength(0);
  });

  it("refuses an approval the owner gave after the preview stopped qualifying", async () => {
    const h = build({ root: await privateTemp() });
    const approve = await approval(h);
    const original = h.state.snapshot;
    // The choice is made while the dialog waits; qualification is read again after.
    h.state.response = 1;
    const asked = approve(request, "d");
    h.state.snapshot = ready({ outcomeUnknown: true });
    await expect(asked).resolves.toBe(false);
    h.state.snapshot = original;
  });
});

describe("owner cells", () => {
  it("keeps the relay, the witness and the bridge independent", async () => {
    const root = await privateTemp();
    const h = build({ root, e2eHome: "/e2e/home" });
    await h.bridge.initializeCallerRelay();
    await h.bridge.initializeSavedChatBridge();
    expect(h.bridge.relay.get()).toBe(h.relayHandle);
    expect(h.bridge.saved.get()).toBe(h.bridgeHandle);
    h.bridge.relay.set(null);
    expect(h.bridge.saved.get()).toBe(h.bridgeHandle);
    expect(h.bridge.directoryWitness.get()).toBeNull();
  });

  it("starts a replacement after main clears the cell, as Quit and Stop do", async () => {
    const root = await privateTemp();
    const h = build({ root });
    await h.bridge.initializeCallerRelay();
    await h.bridge.initializeSavedChatBridge();
    h.bridge.relay.set(null);
    h.bridge.saved.set(null);
    await h.bridge.initializeCallerRelay();
    await h.bridge.initializeSavedChatBridge();
    expect(h.relayStarts).toHaveLength(2);
    expect(h.bridgeStarts).toHaveLength(2);
  });

  it("does not close a handle by itself", async () => {
    const root = await privateTemp();
    const h = build({ root });
    await h.bridge.initializeCallerRelay();
    await h.bridge.initializeSavedChatBridge();
    h.bridge.relay.set(null);
    h.bridge.saved.set(null);
    expect(h.relayHandle.close).not.toHaveBeenCalled();
    expect(h.bridgeHandle.close).not.toHaveBeenCalled();
  });
});
