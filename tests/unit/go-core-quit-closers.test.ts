import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { goCoreQuitClosers } from "../../apps/desktop/go-core-quit-closers";
import {
  drainOwnedChildren,
  type OwnedCloser,
} from "../../src/apps/desktop/quit-drain";

// Real helper and extracted Quit collection; resource lifetimes and clock are
// controlled. No Electron, process, account, provider or retirement effects.
const source = fs.readFileSync(
  new URL("../../src/apps/desktop/main.ts", import.meta.url),
  "utf8",
);
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
const main = tree.program.body.find(
  (node) => node.type === "FunctionDeclaration" && node.id?.name === "main",
);
if (!main || main.type !== "FunctionDeclaration" || !main.body)
  throw new Error("QUIT_MAIN_SOURCE_MISSING");
const declaration = main.body.body.find(
  (node) =>
    node.type === "VariableDeclaration" &&
    node.declarations.some(
      (d) => d.id.type === "Identifier" && d.id.name === "quitDrain",
    ),
);
if (!declaration || declaration.type !== "VariableDeclaration")
  throw new Error("QUIT_COMPOSITION_SOURCE_MISSING");
const call = declaration.declarations[0]?.init;
if (!call || call.type !== "CallExpression")
  throw new Error("QUIT_COMPOSITION_CALL_MISSING");
const composition = call.arguments[0];
if (!composition || composition.type !== "ObjectExpression")
  throw new Error("QUIT_COMPOSITION_PORTS_MISSING");
const collect = composition.properties.find(
  (p) =>
    p.type === "ObjectProperty" &&
    p.key.type === "Identifier" &&
    p.key.name === "collect",
);
if (
  !collect ||
  collect.type !== "ObjectProperty" ||
  collect.value.start == null ||
  collect.value.end == null
)
  throw new Error("QUIT_COLLECTION_SOURCE_MISSING");
const collectSource = source.slice(collect.value.start, collect.value.end);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe("Go core Quit dependency retains original closer promises", () => {
  it.each(["connector", "saved-chat-bridge"])(
    "keeps the core alive through pending %s closure, once",
    async (name) => {
      const dependent = deferred<void>();
      const core = deferred<void>();
      const events: string[] = [];
      const closeDependent = vi.fn(() => {
        events.push("dependent");
        return dependent.promise;
      });
      const closeCore = vi.fn(() => {
        events.push("core");
        return core.promise;
      });
      const closers = goCoreQuitClosers(
        { name, close: closeDependent },
        closeCore,
      );
      const dependencyCloser = closers[0]!;
      const coreCloser = closers[1]!;
      const first = dependencyCloser.close();
      const retirement = coreCloser.close();
      expect(dependencyCloser.close()).toBe(first);
      expect(coreCloser.close()).toBe(retirement);
      await Promise.resolve();
      expect(events).toEqual(["dependent"]);
      dependent.resolve();
      await first;
      await vi.waitFor(() => expect(closeCore).toHaveBeenCalledTimes(1));
      expect(events).toEqual(["dependent", "core"]);
      core.resolve();
      await retirement;
      expect(closeDependent.mock.results[0]?.value).toBe(dependent.promise);
      expect(closeCore.mock.results[0]?.value).toBe(core.promise);
      expect(closeDependent).toHaveBeenCalledTimes(1);
    },
  );

  it("closes the exact core after a dependent rejection but names the dependent unconfirmed", async () => {
    const error = new Error("ORIGINAL_DEPENDENT_UNKNOWN");
    const dependent = deferred<void>();
    const close = vi.fn(() => dependent.promise);
    const closeCore = vi.fn(async () => undefined);
    const closers = goCoreQuitClosers({ name: "connector", close }, closeCore);
    const receipt = drainOwnedChildren(closers, 1_000);
    dependent.reject(error);
    await expect(closers[0]!.close()).rejects.toBe(error);
    await expect(dependent.promise).rejects.toBe(error);
    await expect(receipt).resolves.toEqual({
      drained: false,
      unconfirmed: ["connector"],
    });
    expect(closeCore).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("names a separately rejected core and preserves the original error", async () => {
    const error = new Error("ORIGINAL_CORE_UNKNOWN");
    const closeCore = vi.fn(async () => {
      throw error;
    });
    const closers = goCoreQuitClosers(
      { name: "connector", close: async () => undefined },
      closeCore,
    );
    await expect(drainOwnedChildren(closers, 1_000)).resolves.toEqual({
      drained: false,
      unconfirmed: ["go-core"],
    });
    await expect(closers[1]!.close()).rejects.toBe(error);
    expect(closeCore).toHaveBeenCalledTimes(1);
  });

  it("does not start a late core close after the dependent original Promise crosses the drain deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const deadlineAt = Date.now() + 58_000;
    const dependent = deferred<void>();
    const close = vi.fn(() => dependent.promise);
    const closeCore = vi.fn(async () => undefined);
    const closers = goCoreQuitClosers(
      { name: "connector", close },
      closeCore,
      () => Date.now() < deadlineAt,
    );
    const receipt = drainOwnedChildren(closers, 58_000, deadlineAt);
    await vi.advanceTimersByTimeAsync(58_000);
    await expect(receipt).resolves.toEqual({
      drained: false,
      unconfirmed: ["connector", "go-core"],
    });
    dependent.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(dependent.promise).resolves.toBeUndefined();
    await expect(closers[1]!.close()).rejects.toThrow(
      "GO_CORE_QUIT_DEADLINE_EXPIRED",
    );
    expect(closeCore).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(["fulfilled", "rejected"] as const)(
    "retains a late dependent %s outcome without replay or core admission",
    async (outcome) => {
      const dependent = deferred<void>();
      const error = new Error("LATE_DEPENDENT_UNKNOWN");
      const close = vi.fn(() => dependent.promise);
      const closeCore = vi.fn(async () => undefined);
      let allowed = true;
      const closers = goCoreQuitClosers(
        { name: "connector", close },
        closeCore,
        () => allowed,
      );
      const original = closers[0]!.close();
      const retirement = closers[1]!.close();
      allowed = false;
      if (outcome === "fulfilled") dependent.resolve();
      else dependent.reject(error);
      if (outcome === "fulfilled")
        await expect(original).resolves.toBeUndefined();
      else await expect(original).rejects.toBe(error);
      await expect(retirement).rejects.toThrow("GO_CORE_QUIT_DEADLINE_EXPIRED");
      expect(closeCore).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it("supports dependent-only, core-only and absent lifetimes", async () => {
    const dependent = vi.fn(async () => undefined);
    const core = vi.fn(async () => undefined);
    const dependencyOnly = goCoreQuitClosers(
      { name: "saved-chat-bridge", close: dependent },
      null,
    );
    expect(dependencyOnly.map((c) => c.name)).toEqual(["saved-chat-bridge"]);
    const first = dependencyOnly[0]!.close();
    expect(dependencyOnly[0]!.close()).toBe(first);
    await first;
    expect(dependent).toHaveBeenCalledTimes(1);
    const coreOnly = goCoreQuitClosers(null, core);
    expect(coreOnly.map((c) => c.name)).toEqual(["go-core"]);
    const closing = coreOnly[0]!.close();
    expect(coreOnly[0]!.close()).toBe(closing);
    await closing;
    expect(core).toHaveBeenCalledTimes(1);
    expect(goCoreQuitClosers(null, null)).toEqual([]);
  });
});

describe("actual desktop Quit collection", () => {
  function harness(connectorPresent: boolean) {
    let coreAlive = true;
    const events: string[] = [];
    const stopped = deferred<void>();
    const saved = deferred<void>();
    const core = {
      close: vi.fn(async () => {
        events.push("core");
        coreAlive = false;
      }),
    };
    const connector = connectorPresent ? {} : null;
    const inFlightStart = Promise.resolve();
    const savedChat = {
      close: vi.fn(async () => {
        events.push("saved-chat");
        expect(coreAlive).toBe(true);
        await saved.promise;
      }),
    };
    const stop = vi.fn(async () => {
      events.push("connector");
      expect(coreAlive).toBe(true);
      await stopped.promise;
    });
    const context = vm.createContext({
      Date,
      goCoreQuitClosers,
      desktopGoCore: core,
      installedUpdater: null,
      installedUpdaterInitialization: null,
      pendingChatGptAttachmentTask: null,
      activeCodexAgentCheck: null,
      activeProductAgentSession: null,
      persistedProductAgentExpiry: null,
      hostCheckClients: [],
      connectorStartInFlight: inFlightStart,
      secureMcpConnectorRuntime: connector,
      savedChatBridgeRuntime: savedChat,
      modelLifecycle: null,
      routeBRuntime: null,
      callerRelayRuntime: null,
      stopAndConfirmComputerMcp: stop,
      disposeChatGptRoutes() {},
      disposeTaskViews() {},
      stopRuntime() {},
    });
    const collect = vm.runInContext(
      stripTypeScriptTypes(`(${collectSource})`, { mode: "transform" }),
      context,
    ) as (value: { deadlineAt: number }) => readonly OwnedCloser[];
    return {
      context,
      collect,
      core,
      connector,
      inFlightStart,
      savedChat,
      stopped,
      saved,
      stop,
      events,
    };
  }

  it.each([false, true])(
    "keeps original core through dependent closure (connector=%s)",
    async (connectorPresent) => {
      const h = harness(connectorPresent);
      const closers = h.collect({ deadlineAt: Date.now() + 1_000 });
      const receipt = drainOwnedChildren(closers, 1_000);
      if (connectorPresent) {
        await vi.waitFor(() => expect(h.stop).toHaveBeenCalledTimes(1));
        expect(h.stop).toHaveBeenCalledWith(
          h.connector,
          h.inFlightStart,
          h.core,
        );
        h.stopped.resolve();
      }
      await vi.waitFor(() =>
        expect(h.savedChat.close).toHaveBeenCalledTimes(1),
      );
      expect(h.core.close).not.toHaveBeenCalled();
      h.saved.resolve();
      await expect(receipt).resolves.toEqual({
        drained: true,
        unconfirmed: [],
      });
      expect(h.events).toEqual(
        connectorPresent
          ? ["connector", "saved-chat", "core"]
          : ["saved-chat", "core"],
      );
    },
  );

  it("captures original core, connector and saved-chat lifetimes before deferred closing", async () => {
    const h = harness(true);
    const replacementCore = { close: vi.fn(async () => undefined) };
    const replacementSaved = { close: vi.fn(async () => undefined) };
    const closers = h.collect({ deadlineAt: Date.now() + 1_000 });
    h.context.desktopGoCore = replacementCore;
    h.context.savedChatBridgeRuntime = replacementSaved;
    h.context.secureMcpConnectorRuntime = {};
    const receipt = drainOwnedChildren(closers, 1_000);
    h.stopped.resolve();
    h.saved.resolve();
    await expect(receipt).resolves.toEqual({ drained: true, unconfirmed: [] });
    expect(h.stop).toHaveBeenCalledWith(h.connector, h.inFlightStart, h.core);
    expect(h.core.close).toHaveBeenCalledTimes(1);
    expect(h.savedChat.close).toHaveBeenCalledTimes(1);
    expect(replacementCore.close).not.toHaveBeenCalled();
    expect(replacementSaved.close).not.toHaveBeenCalled();
    expect(h.context.savedChatBridgeRuntime).toBe(replacementSaved);
  });

  it("runs saved-chat cleanup after the original connector rejection and keeps it separately unconfirmed", async () => {
    const h = harness(true);
    const error = new Error("ORIGINAL_CONNECTOR_UNKNOWN");
    h.stop.mockImplementation(async () => {
      throw error;
    });
    const closers = h.collect({ deadlineAt: Date.now() + 1_000 });
    const receipt = drainOwnedChildren(closers, 1_000);
    await vi.waitFor(() => expect(h.savedChat.close).toHaveBeenCalledTimes(1));
    expect(h.core.close).not.toHaveBeenCalled();
    h.saved.resolve();
    await expect(receipt).resolves.toEqual({
      drained: false,
      unconfirmed: ["connector"],
    });
    await expect(
      closers.find((c) => c.name === "connector")!.close(),
    ).rejects.toBe(error);
    expect(h.core.close).toHaveBeenCalledTimes(1);
  });

  it("refuses a new captured core close when dependent cleanup finishes after collection's deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const h = harness(false);
    const deadlineAt = Date.now() + 58_000;
    const closers = h.collect({ deadlineAt });
    const receipt = drainOwnedChildren(closers, 58_000, deadlineAt);
    await vi.advanceTimersByTimeAsync(58_000);
    await expect(receipt).resolves.toEqual({
      drained: false,
      unconfirmed: ["saved-chat-bridge", "go-core"],
    });
    h.saved.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.core.close).not.toHaveBeenCalled();
    await expect(
      closers.find((c) => c.name === "go-core")!.close(),
    ).rejects.toThrow("GO_CORE_QUIT_DEADLINE_EXPIRED");
  });
});
