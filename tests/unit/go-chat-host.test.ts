import { describe, expect, it, vi } from "vitest";
import { createDesktopChatBrowser } from "../../apps/desktop/go-chat-host.ts";
import type { BrowserDriver } from "../../apps/desktop/bridge/browser.ts";
import type {
  BrowserBinding,
  BrowserLease,
  BrowserPrepare,
  BrowserObservation,
} from "../../apps/desktop/bridge/wire.ts";
import type { ChatGptPhysicalApi } from "../../apps/desktop/chatgpt-physical-api.ts";
import type { AssignedChatBrowser } from "../../apps/desktop/go-chat-browser.ts";

// Host assignment aggregate only. Physical creation and the wire adapter are
// explicit doubles; this does not exercise Go, Electron or provider behavior.
const context = { profileId: "profile", backendGeneration: "backend" };
function prepared(slot = 1, generation = "1"): BrowserPrepare {
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
  return {
    lease: {
      identity: {
        profileId: "profile",
        ownerId: "owner",
        sessionId: "session",
        taskId: `task-${slot}`,
        turnId: `turn-${generation}`,
        operationId: `operation-${slot}-${generation}`,
        turnGeneration: generation,
      },
      backendGeneration: "backend",
      slotOrdinal: slot,
      slotGeneration: generation,
    },
    target: {
      mode: "new-saved",
      conversationId: "",
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
}
function binding(lease: BrowserLease): BrowserBinding {
  return {
    lease,
    viewId: "view",
    viewGeneration: "1",
    documentGeneration: "1",
    conversationId: "",
    providerState: "home",
  };
}
function fixture() {
  let lookup!: (lease: BrowserLease) => AssignedChatBrowser | undefined;
  let events: BrowserObservation[] = [];
  const create = vi.fn(async () => ({}) as ChatGptPhysicalApi);
  const delegate: BrowserDriver = {
    prepare: vi.fn<BrowserDriver["prepare"]>(async (input) => {
      expect(lookup(input.lease)?.lease).toEqual(input.lease);
      return {
        saved: false,
        readiness: "ready",
        binding: binding(input.lease),
        code: "",
      };
    }),
    verifySend: vi.fn<BrowserDriver["verifySend"]>(async () => {
      throw new Error("unexpected verification");
    }),
    send: vi.fn<BrowserDriver["send"]>(async (input) => ({
      binding: input.binding,
      verificationId: "evidence",
      status: "submitted",
      code: "",
    })),
    observe: vi.fn<BrowserDriver["observe"]>(async () => ({
      events,
      gap: false,
    })),
    cancel: vi.fn<BrowserDriver["cancel"]>(async (input) => ({
      binding: input.binding,
      status: "requested",
      code: "",
    })),
    dispose: vi.fn<BrowserDriver["dispose"]>(async (input) => ({
      lease: input.lease,
      confirmed: true,
      code: "",
    })),
  };
  const host = createDesktopChatBrowser({
    context,
    partition: "persist:farol-app-chatgpt",
    create,
    nowMillis: () => 1000,
    driver: (selected) => {
      lookup = selected;
      return delegate;
    },
  });
  const settle = async (input: BrowserPrepare) => {
    events = [
      {
        binding: binding(input.lease),
        sequence: "1",
        observedAtMillis: "1000",
        kind: "quiescent",
        providerConversationId: "",
        userTurnId: "user",
        replyId: "reply",
        segmentId: "",
        text: "",
        code: "",
      },
    ];
    await host.driver.observe({
      binding: binding(input.lease),
      afterSequence: "0",
      limit: 1,
      deadlineMillis: "15000",
    });
  };
  return {
    host,
    create,
    delegate,
    settle,
    lookup: (lease: BrowserLease) => lookup(lease),
  };
}
describe("normal host Go browser assignments", () => {
  it("creates at most the five Go slots lazily, without allocating a sixth", async () => {
    const f = fixture();
    expect(f.create).not.toHaveBeenCalled();
    for (let n = 1; n <= 5; n++) await f.host.driver.prepare(prepared(n));
    await expect(f.host.driver.prepare(prepared(6))).rejects.toMatchObject({
      code: "host_browser_prepare_invalid",
    });
    expect(f.create).toHaveBeenCalledTimes(5);
  });
  it("rejects a new generation until physical settlement, then reuses the same dedicated API", async () => {
    const f = fixture(),
      first = prepared(),
      next = prepared(1, "2");
    await f.host.driver.prepare(first);
    const api = f.lookup(first.lease)!.api;
    await expect(f.host.driver.prepare(next)).rejects.toMatchObject({
      code: "host_browser_slot_unsettled",
    });
    await f.settle(first);
    await f.host.driver.prepare(next);
    expect(f.lookup(first.lease)).toBeUndefined();
    expect(f.lookup(next.lease)!.api).toBe(api);
    expect(f.create).toHaveBeenCalledTimes(1);
    await expect(f.host.driver.prepare(first)).rejects.toMatchObject({
      state: "refused",
    });
  });
  it.each(["profile", "backend", "operation"])(
    "does not resolve a reused ordinal with crossed %s identity",
    async (field) => {
      const f = fixture(),
        first = prepared();
      await f.host.driver.prepare(first);
      const crossed = structuredClone(first.lease);
      if (field === "profile")
        Object.assign(crossed.identity, { profileId: "foreign" });
      if (field === "backend")
        Object.assign(crossed, { backendGeneration: "foreign" });
      if (field === "operation")
        Object.assign(crossed.identity, { operationId: "foreign" });
      expect(f.lookup(crossed)).toBeUndefined();
      await expect(
        f.host.driver.observe({
          binding: binding(crossed),
          afterSequence: "0",
          limit: 1,
          deadlineMillis: "15000",
        }),
      ).rejects.toMatchObject({ code: "host_browser_assignment_mismatch" });
      expect(f.delegate.observe).not.toHaveBeenCalled();
    },
  );
  it("creates a new view only after exact confirmed destruction and a newer Go lease", async () => {
    const f = fixture(),
      first = prepared(),
      next = prepared(1, "2");
    await f.host.driver.prepare(first);
    const api = f.lookup(first.lease)!.api;
    await f.host.driver.dispose({
      lease: first.lease,
      deadlineMillis: "15000",
    });
    await f.host.driver.prepare(next);
    expect(f.lookup(next.lease)!.api).not.toBe(api);
    expect(f.create).toHaveBeenCalledTimes(2);
  });
  it("keeps an unconfirmed destruction fenced even if the Go ordinal advances", async () => {
    const f = fixture(),
      first = prepared();
    await f.host.driver.prepare(first);
    vi.mocked(f.delegate.dispose).mockResolvedValue({
      lease: first.lease,
      confirmed: false,
      code: "unknown",
    });
    await f.host.driver.dispose({
      lease: first.lease,
      deadlineMillis: "15000",
    });
    await expect(f.host.driver.prepare(prepared(1, "2"))).rejects.toMatchObject(
      { code: "host_browser_slot_unsettled" },
    );
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it("withdraws all exact assignments and prevents post-await creation from dispatching prepare", async () => {
    const f = fixture(),
      first = prepared();
    let resolve!: (api: ChatGptPhysicalApi) => void;
    f.create.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const result = f.host.driver.prepare(first);
    f.host.withdraw();
    resolve({} as ChatGptPhysicalApi);
    await expect(result).rejects.toMatchObject({
      state: "unknown",
      code: "host_browser_creation_unconfirmed",
    });
    expect(f.lookup(first.lease)).toBeUndefined();
    expect(f.delegate.prepare).not.toHaveBeenCalled();
    await expect(f.host.driver.prepare(first)).rejects.toMatchObject({
      state: "refused",
    });
    expect(f.create).toHaveBeenCalledTimes(1);
  });
});
