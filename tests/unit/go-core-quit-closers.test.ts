import { observeOperation } from "../../apps/desktop/operations/observe";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { goCoreQuitClosers } from "../../apps/desktop/go-core-quit-closers";
import {
  createQuitDrain,
  drainOwnedChildren,
  type OwnedCloser,
} from "../../src/apps/desktop/quit-drain";
import { drainComputerConnector } from "../../src/apps/desktop/computer-connector-drain";

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
const stopNode = tree.program.body.find(
  (node) =>
    node.type === "FunctionDeclaration" &&
    node.id?.name === "stopAndConfirmComputerMcp",
);
if (!stopNode || stopNode.start == null || stopNode.end == null)
  throw new Error("QUIT_STOP_SOURCE_MISSING");
const stopSource = source.slice(stopNode.start, stopNode.end);
const bridgeSource = fs.readFileSync(
  new URL("../../src/apps/desktop/saved-chat-bridge.ts", import.meta.url),
  "utf8",
);
const bridgeTree = parse(bridgeSource, {
  sourceType: "module",
  plugins: ["typescript"],
});
const bridgeExport = bridgeTree.program.body.find(
  (node) =>
    node.type === "ExportNamedDeclaration" &&
    node.declaration?.type === "FunctionDeclaration" &&
    node.declaration.id?.name === "startSavedChatBridge",
);
if (
  !bridgeExport ||
  bridgeExport.type !== "ExportNamedDeclaration" ||
  bridgeExport.declaration?.type !== "FunctionDeclaration" ||
  !bridgeExport.declaration.body
)
  throw new Error("SAVED_CHAT_CLOSE_OWNER_MISSING");
const bridgeReturn = bridgeExport.declaration.body.body.find(
  (node) =>
    node.type === "ReturnStatement" &&
    node.argument?.type === "ObjectExpression",
);
if (
  !bridgeReturn ||
  bridgeReturn.type !== "ReturnStatement" ||
  bridgeReturn.argument?.type !== "ObjectExpression"
)
  throw new Error("SAVED_CHAT_CLOSE_RETURN_MISSING");
const bridgeClose = bridgeReturn.argument.properties.find(
  (p) =>
    p.type === "ObjectProperty" &&
    p.key.type === "Identifier" &&
    p.key.name === "close",
);
if (
  !bridgeClose ||
  bridgeClose.type !== "ObjectProperty" ||
  bridgeClose.value.start == null ||
  bridgeClose.value.end == null
)
  throw new Error("SAVED_CHAT_CLOSE_SOURCE_MISSING");
const bridgeCloseSource = bridgeSource.slice(
  bridgeClose.value.start,
  bridgeClose.value.end,
);

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

describe("actual MCP stop retains its admitted saved-chat lifetime", () => {
  function bridge(active: readonly Promise<void>[] = [], error?: Error) {
    const destroyed = vi.fn();
    const serverClose = vi.fn((callback: () => void) => callback());
    const unlink = vi.fn(async () => undefined);
    const rmdir = vi.fn(async () => {
      if (error) throw error;
    });
    const context = vm.createContext({
      closePromise: null,
      closing: false,
      active: new Set(active),
      sockets: new Set([{ destroy: destroyed }]),
      server: { close: serverClose },
      fs: { unlink, rmdir },
      socketPath: "/controlled-only/chat.sock",
      root: "/controlled-only",
    });
    const originalClose = vm.runInContext(
      stripTypeScriptTypes(`(${bridgeCloseSource})`, { mode: "strip" }),
      context,
    ) as () => Promise<void>;
    return {
      close: vi.fn(originalClose),
      context,
      serverClose,
      unlink,
      rmdir,
      destroyed,
    };
  }

  function harness(originalBridge: ReturnType<typeof bridge> | null) {
    const stop = deferred<void>();
    const beginStop = vi.fn(async () => undefined);
    const waitForStop = vi.fn(() => stop.promise);
    const confirmStop = vi.fn(async () => undefined);
    const core = {
      close: vi.fn(async () => undefined),
      closeComputerConnector: vi.fn(async () => undefined),
    };
    const connector = { stop: vi.fn(async () => undefined) };
    const context = vm.createContext({
      observeOperation,
      operationsStore: () => ({ record() {} }),
      Date,
      goCoreQuitClosers,
      drainComputerConnector,
      desktopGoCore: core,
      secureMcpConnectorRuntime: connector,
      savedChatBridgeRuntime: originalBridge,
      computerMcpLifecycle: () => ({ beginStop, waitForStop, confirmStop }),
      installedUpdater: null,
      installedUpdaterInitialization: null,
      pendingChatGptAttachmentTask: null,
      activeCodexAgentCheck: null,
      activeProductAgentSession: null,
      persistedProductAgentExpiry: null,
      hostCheckClients: [],
      connectorStartInFlight: null,
      modelLifecycle: null,
      routeBRuntime: null,
      callerRelayRuntime: null,
      disposeChatGptRoutes() {},
      disposeTaskViews() {},
      ownedLocalRuntimes: new Map(),
      stopRuntime() {},
    });
    vm.runInContext(
      stripTypeScriptTypes(stopSource, { mode: "strip" }),
      context,
    );
    const collect = vm.runInContext(
      stripTypeScriptTypes(`(${collectSource})`, { mode: "strip" }),
      context,
    ) as (value: { deadlineAt: number }) => readonly OwnedCloser[];
    const stopCurrent = vm.runInContext(
      "stopAndConfirmComputerMcp",
      context,
    ) as (
      selectedConnector?: typeof connector,
      inFlight?: Promise<void> | null,
      selectedCore?: typeof core,
      savedChat?: ReturnType<typeof bridge> | null,
    ) => Promise<void>;
    return {
      context,
      collect,
      stopCurrent,
      stop,
      waitForStop,
      confirmStop,
      core,
      connector,
    };
  }

  it.each(["before-dispatch", "pending-mcp-stop"] as const)(
    "never closes or clears a replacement bridge during Quit: %s",
    async (replacementAt) => {
      const original = bridge();
      const replacement = bridge();
      const h = harness(original);
      const closers = h.collect({ deadlineAt: Date.now() + 1_000 });
      if (replacementAt === "before-dispatch")
        h.context.savedChatBridgeRuntime = replacement;
      const receipt = drainOwnedChildren(closers, 1_000);
      await vi.waitFor(() => expect(h.waitForStop).toHaveBeenCalledTimes(1));
      if (replacementAt === "pending-mcp-stop")
        h.context.savedChatBridgeRuntime = replacement;
      h.stop.resolve();
      await expect(receipt).resolves.toEqual({
        drained: true,
        unconfirmed: [],
      });
      expect(replacement.close).not.toHaveBeenCalled();
      expect(h.context.savedChatBridgeRuntime).toBe(replacement);
      expect(original.close).toHaveBeenCalledTimes(2);
      expect(original.close.mock.results[0]?.value).toBe(
        original.close.mock.results[1]?.value,
      );
      expect(original.serverClose).toHaveBeenCalledTimes(1);
      expect(original.unlink).toHaveBeenCalledTimes(1);
      expect(original.rmdir).toHaveBeenCalledTimes(1);
      expect(h.core.closeComputerConnector).toHaveBeenCalledTimes(1);
      expect(h.core.close).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps current admitted work pending until its original settlement, reusing close at outer cleanup", async () => {
    const admitted = deferred<void>();
    const original = bridge([admitted.promise]);
    const h = harness(original);
    const closers = h.collect({ deadlineAt: Date.now() + 1_000 });
    const receipt = drainOwnedChildren(closers, 1_000);
    await vi.waitFor(() => expect(h.waitForStop).toHaveBeenCalledTimes(1));
    h.stop.resolve();
    await vi.waitFor(() => expect(original.close).toHaveBeenCalledTimes(1));
    expect(original.context.closing).toBe(true);
    expect(h.core.closeComputerConnector).not.toHaveBeenCalled();
    expect(h.core.close).not.toHaveBeenCalled();
    expect(original.serverClose).not.toHaveBeenCalled();
    admitted.resolve();
    await expect(receipt).resolves.toEqual({ drained: true, unconfirmed: [] });
    expect(original.close).toHaveBeenCalledTimes(2);
    expect(original.close.mock.results[0]?.value).toBe(
      original.close.mock.results[1]?.value,
    );
    expect(original.serverClose).toHaveBeenCalledTimes(1);
  });

  it("preserves a rejected bridge cleanup attempt and does not rerun it in outer finally", async () => {
    const error = new Error("ORIGINAL_SAVED_CHAT_CLEANUP_UNKNOWN");
    const original = bridge([], error);
    const h = harness(original);
    const closers = h.collect({ deadlineAt: Date.now() + 1_000 });
    const receipt = drainOwnedChildren(closers, 1_000);
    h.stop.resolve();
    await expect(receipt).resolves.toEqual({
      drained: false,
      unconfirmed: ["connector"],
    });
    await expect(
      closers.find((c) => c.name === "connector")!.close(),
    ).rejects.toBe(error);
    expect(original.close).toHaveBeenCalledTimes(2);
    expect(original.close.mock.results[0]?.value).toBe(
      original.close.mock.results[1]?.value,
    );
    expect(original.rmdir).toHaveBeenCalledTimes(1);
    expect(h.core.closeComputerConnector).toHaveBeenCalledTimes(1);
    expect(h.core.close).toHaveBeenCalledTimes(1);
    expect(h.confirmStop).not.toHaveBeenCalled();
  });

  it("captures the default bridge at direct stop entry, before asynchronous MCP draining", async () => {
    const original = bridge();
    const replacement = bridge();
    const h = harness(original);
    const stopping = h.stopCurrent();
    await vi.waitFor(() => expect(h.waitForStop).toHaveBeenCalledTimes(1));
    h.context.savedChatBridgeRuntime = replacement;
    h.stop.resolve();
    await stopping;
    expect(original.close).toHaveBeenCalledTimes(1);
    expect(replacement.close).not.toHaveBeenCalled();
    expect(h.context.savedChatBridgeRuntime).toBe(replacement);
  });

  it("preserves an explicitly absent bridge instead of falling back to a mutable global", async () => {
    const unrelated = bridge();
    const h = harness(unrelated);
    const stopping = h.stopCurrent(h.connector, null, h.core, null);
    h.stop.resolve();
    await stopping;
    expect(unrelated.close).not.toHaveBeenCalled();
    expect(h.context.savedChatBridgeRuntime).toBe(unrelated);
    expect(h.core.closeComputerConnector).toHaveBeenCalledTimes(1);
  });

  it("keeps default absence at entry while another bridge appears during MCP draining", async () => {
    const replacement = bridge();
    const h = harness(null);
    const stopping = h.stopCurrent();
    await vi.waitFor(() => expect(h.waitForStop).toHaveBeenCalledTimes(1));
    h.context.savedChatBridgeRuntime = replacement;
    h.stop.resolve();
    await stopping;
    expect(replacement.close).not.toHaveBeenCalled();
    expect(h.context.savedChatBridgeRuntime).toBe(replacement);
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
      observeOperation,
      operationsStore: () => ({ record() {} }),
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
      ownedLocalRuntimes: new Map(),
      stopRuntime() {},
    });
    const collect = vm.runInContext(
      stripTypeScriptTypes(`(${collectSource})`, { mode: "strip" }),
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

  it("retains the exact local runtime lifetime in the actual Quit collection", async () => {
    const h = harness(false);
    const original = deferred<void>();
    const close = vi.fn(() => original.promise);
    h.context.ownedLocalRuntimes.set({ close }, "local-runtime-1");
    const closers = h.collect({ deadlineAt: Date.now() + 1000 });
    h.saved.resolve();
    const runtimeCloser = closers.find(
      (closer) => closer.name === "local-runtime-1",
    )!;
    expect(runtimeCloser).toBeDefined();
    h.context.ownedLocalRuntimes.clear();
    const receipt = drainOwnedChildren(closers, 5);
    expect(await receipt).toEqual({
      drained: false,
      unconfirmed: ["local-runtime-1"],
    });
    expect(close).toHaveBeenCalledOnce();
    original.resolve();
    await original.promise;
  });

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
          h.savedChat,
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
    expect(h.stop).toHaveBeenCalledWith(
      h.connector,
      h.inFlightStart,
      h.core,
      h.savedChat,
    );
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

// Retained Mac shutdown regressions from the pre-cloud integration.
it.each(["connector", "saved-chat-bridge"])(
  "keeps Go available until %s has finished, even if its closer is called first",
  async (name) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dependent = vi.fn(() => pending);
    const core = vi.fn(async () => undefined);
    const closers = goCoreQuitClosers({ name, close: dependent }, core);
    const closingCore = closers[1]!.close();
    const closingDependent = closers[0]!.close();
    await Promise.resolve();
    expect(dependent).toHaveBeenCalledTimes(1);
    expect(core).not.toHaveBeenCalled();
    release();
    await Promise.all([closingCore, closingDependent, closers[1]!.close()]);
    expect(core).toHaveBeenCalledTimes(1);
  },
);

it("retains a failed connector while closing Go once, without replay on reentrant Quit", async () => {
  vi.useFakeTimers();
  const dependent = vi.fn(async () => {
    throw new Error("MCP_UNCONFIRMED");
  });
  const core = vi.fn(async () => undefined);
  const record = vi.fn(async () => undefined);
  const quit = vi.fn();
  const drain = createQuitDrain({
    deadlineMs: 1_000,
    collect: () =>
      goCoreQuitClosers({ name: "connector", close: dependent }, core),
    record,
    quit,
  });
  const event = { preventDefault: vi.fn() };
  drain.onBeforeQuit(event);
  drain.onBeforeQuit(event);
  await vi.advanceTimersByTimeAsync(0);
  expect(record).toHaveBeenCalledWith({
    drained: false,
    unconfirmed: ["connector"],
  });
  expect(dependent).toHaveBeenCalledTimes(1);
  expect(core).toHaveBeenCalledTimes(1);
  expect(quit).toHaveBeenCalledTimes(1);
});

it("joins the original start and MCP cleanup before retiring Go", async () => {
  vi.useFakeTimers();
  let completeStart!: () => void;
  let completeMcp!: () => void;
  const start = new Promise<void>((resolve) => {
    completeStart = resolve;
  });
  const mcp = new Promise<void>((resolve) => {
    completeMcp = resolve;
  });
  const core = vi.fn(async () => undefined);
  const record = vi.fn(async () => undefined);
  const dependent = vi.fn(async () => {
    await start;
    await mcp;
  });
  const drain = createQuitDrain({
    deadlineMs: 2_000,
    recordReserveMs: 500,
    collect: () =>
      goCoreQuitClosers({ name: "connector", close: dependent }, core),
    record,
    quit: vi.fn(),
  });
  drain.onBeforeQuit({ preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(0);
  completeStart();
  await vi.advanceTimersByTimeAsync(0);
  expect(core).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
  completeMcp();
  await vi.advanceTimersByTimeAsync(0);
  expect(core).toHaveBeenCalledTimes(1);
  expect(record).toHaveBeenCalledWith({ drained: true, unconfirmed: [] });
});

it("does not retire Go past a still-pending connector just to claim a clean deadline", async () => {
  vi.useFakeTimers();
  const core = vi.fn(async () => undefined);
  const record = vi.fn(async () => undefined);
  const quit = vi.fn();
  const drain = createQuitDrain({
    deadlineMs: 1_000,
    recordReserveMs: 100,
    collect: () =>
      goCoreQuitClosers(
        { name: "connector", close: () => new Promise(() => {}) },
        core,
      ),
    record,
    quit,
  });
  drain.onBeforeQuit({ preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(core).not.toHaveBeenCalled();
  expect(record).toHaveBeenCalledWith({
    drained: false,
    unconfirmed: ["connector", "go-core"],
  });
  expect(quit).toHaveBeenCalledTimes(1);
});

it("does not start a late Go retirement from a connector that settled after its original deadline", async () => {
  let release!: () => void;
  const dependent = new Promise<void>((resolve) => {
    release = resolve;
  });
  let allowed = true;
  const core = vi.fn(async () => undefined);
  const closers = goCoreQuitClosers(
    { name: "connector", close: () => dependent },
    core,
    () => allowed,
  );
  const original = closers[1]!.close();
  allowed = false;
  release();
  await expect(original).rejects.toThrow("GO_CORE_QUIT_DEADLINE_EXPIRED");
  await expect(closers[1]!.close()).rejects.toThrow(
    "GO_CORE_QUIT_DEADLINE_EXPIRED",
  );
  expect(core).not.toHaveBeenCalled();
});
