import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { afterEach, expect, it, vi } from "vitest";
import { goCoreQuitClosers } from "../../apps/desktop/go-core-quit-closers";
import { observeOperation } from "../../apps/desktop/operations/observe";
import { drainComputerConnector } from "../../src/apps/desktop/computer-connector-drain";
import {
  createQuitDrain,
  type OwnedCloser,
} from "../../src/apps/desktop/quit-drain";

// Execute Main's actual start observer, stop and Quit collection with controlled
// ports and time. No Electron, provider, process or profile evidence is claimed.
const source = fs.readFileSync(
  new URL("../../src/apps/desktop/main.ts", import.meta.url),
  "utf8",
);
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
function declaration(name: string): string {
  const node = tree.program.body.find(
    (value) => value.type === "FunctionDeclaration" && value.id?.name === name,
  );
  if (!node || node.start == null || node.end == null)
    throw Error(`Missing Main function: ${name}`);
  return source.slice(node.start, node.end);
}
const main = tree.program.body.find(
  (value) => value.type === "FunctionDeclaration" && value.id?.name === "main",
);
if (main?.type !== "FunctionDeclaration") throw Error("Missing Main");
const quit = main.body.body.find(
  (value) =>
    value.type === "VariableDeclaration" &&
    value.declarations.some(
      (item) => item.id.type === "Identifier" && item.id.name === "quitDrain",
    ),
);
const call = quit?.type === "VariableDeclaration" && quit.declarations[0]?.init;
const ports = call && call.type === "CallExpression" && call.arguments[0];
const collect =
  ports &&
  ports.type === "ObjectExpression" &&
  ports.properties.find(
    (value) =>
      value.type === "ObjectProperty" &&
      value.key.type === "Identifier" &&
      value.key.name === "collect",
  );
if (
  !collect ||
  collect.type !== "ObjectProperty" ||
  collect.value.start == null ||
  collect.value.end == null
)
  throw Error("Missing Main Quit collection");
const collectSource = source.slice(collect.value.start, collect.value.end);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

function fixture(honoursCancellation = false, startupAdmission = false) {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const pending = deferred<void>();
  const cancelled = vi.fn(() => pending.resolve());
  const beginStop = vi.fn(async () => {});
  const waitForStop = vi.fn(async () => {});
  const confirmStop = vi.fn(async () => {});
  const connector = {
    stop: vi.fn(async () => {}),
    observeStopAttempt: <T>(work: () => Promise<T>) => work(),
  };
  const core = {
    close: vi.fn(async () => {}),
    closeComputerConnector: vi.fn(async () => {}),
    observeOriginalStop: vi.fn(async () => ({ restricted: false })),
  };
  const context = vm.createContext({
    AbortController,
    Date,
    setTimeout,
    clearTimeout,
    goCoreQuitClosers,
    drainComputerConnector,
    observeOperation,
    operationsStore: () => ({ record() {} }),
    connectorStartInFlight: null,
    connectorStartCancellation: null,
    startupConnectionChecking: startupAdmission,
    CONNECTOR_START_QUIT_BUDGET_MS: 8_000,
    secureMcpConnectorRuntime: connector,
    desktopGoCore: core,
    savedChatBridgeRuntime: null,
    computerMcpLifecycle: () => ({ beginStop, waitForStop, confirmStop }),
    installedUpdater: null,
    installedUpdaterInitialization: null,
    pendingChatGptAttachmentTask: null,
    activeCodexAgentCheck: null,
    activeProductAgentSession: null,
    persistedProductAgentExpiry: null,
    hostCheckClients: [],
    modelLifecycle: null,
    routeBRuntime: null,
    callerRelayRuntime: null,
    disposeChatGptRoutes() {},
    disposeTaskViews() {},
    ownedLocalRuntimes: new Map(),
    stopRuntime() {},
  });
  vm.runInContext(
    stripTypeScriptTypes(
      declaration("observeConnectorStart") +
        "\n" +
        declaration("stopAndConfirmComputerMcp"),
      { mode: "strip" },
    ),
    context,
  );
  const observeStart = vm.runInContext("observeConnectorStart", context) as (
    work: () => Promise<unknown>,
  ) => Promise<unknown>;
  const start = vi.fn(() => {
    const signal = context.connectorStartCancellation?.signal as
      AbortSignal | undefined;
    signal?.addEventListener("abort", () => {
      if (honoursCancellation) cancelled();
    });
    return pending.promise;
  });
  const originalStart = startupAdmission
    ? Promise.resolve()
    : observeStart(start);
  const actualCollect = vm.runInContext(
    stripTypeScriptTypes(`(${collectSource})`, { mode: "strip" }),
    context,
  ) as (value: { deadlineAt: number }) => readonly OwnedCloser[];
  const collectOnce = vi.fn(actualCollect);
  const record = vi.fn(async () => {});
  const quit = vi.fn();
  const drain = createQuitDrain({
    deadlineMs: 60_000,
    recordReserveMs: 2_000,
    collect: collectOnce,
    record,
    quit,
  });
  return {
    drain,
    record,
    quit,
    collectOnce,
    start,
    originalStart,
    pending,
    cancelled,
    core,
    connector,
    beginStop,
    waitForStop,
    confirmStop,
  };
}

it("Quit bounds a never-settling admitted start, names connector unconfirmed and closes Go core", async () => {
  const f = fixture();
  f.drain.onBeforeQuit({ preventDefault() {} });
  await vi.advanceTimersByTimeAsync(7_999);
  expect(f.quit).not.toHaveBeenCalled();
  expect(f.core.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.record).toHaveBeenCalledExactlyOnceWith({
    drained: false,
    unconfirmed: ["connector"],
  });
  expect(f.quit).toHaveBeenCalledOnce();
  expect(f.core.close).toHaveBeenCalledOnce();
  expect(f.confirmStop).not.toHaveBeenCalled();
  // A late original completion cannot re-enter the expired Stop sequence or
  // upgrade the receipt. No second Start or cleanup is dispatched.
  f.pending.resolve();
  await f.originalStart;
  await vi.advanceTimersByTimeAsync(0);
  expect(f.waitForStop).not.toHaveBeenCalled();
  expect(f.connector.stop).not.toHaveBeenCalled();
  expect(f.core.close).toHaveBeenCalledOnce();
  expect(f.record).toHaveBeenCalledOnce();
  expect(f.start).toHaveBeenCalledOnce();
});

it("Quit cancels a cooperative admitted start and confirms its existing Stop", async () => {
  const f = fixture(true);
  f.drain.onBeforeQuit({ preventDefault() {} });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.cancelled).toHaveBeenCalledOnce();
  expect(f.record).toHaveBeenCalledExactlyOnceWith({
    drained: true,
    unconfirmed: [],
  });
  expect(f.quit).toHaveBeenCalledOnce();
  expect(f.core.close).toHaveBeenCalledOnce();
  expect(f.connector.stop).toHaveBeenCalledOnce();
  expect(f.confirmStop).toHaveBeenCalledOnce();
  expect(f.start).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("re-entrant Quit during pending-start cancellation keeps one drain and replays no effect", async () => {
  const f = fixture();
  const preventDefault = vi.fn();
  f.drain.onBeforeQuit({ preventDefault });
  await vi.advanceTimersByTimeAsync(4_000);
  f.drain.onBeforeQuit({ preventDefault });
  await vi.advanceTimersByTimeAsync(4_000);
  expect(preventDefault).toHaveBeenCalledTimes(2);
  expect(f.collectOnce).toHaveBeenCalledOnce();
  expect(f.beginStop).toHaveBeenCalledOnce();
  expect(f.record).toHaveBeenCalledExactlyOnceWith({
    drained: false,
    unconfirmed: ["connector"],
  });
  expect(f.core.close).toHaveBeenCalledOnce();
  expect(f.quit).toHaveBeenCalledOnce();
  expect(f.start).toHaveBeenCalledOnce();
  f.drain.onBeforeQuit({ preventDefault });
  expect(preventDefault).toHaveBeenCalledTimes(2);
  expect(f.collectOnce).toHaveBeenCalledOnce();
});

it("cancelled Main admission does not continue into connector effects after its original reply", async () => {
  const admitted = deferred<{ restricted: boolean }>();
  const cancellation = new AbortController();
  const snapshot = vi.fn(() => ({ status: "unavailable" }));
  const context = vm.createContext({
    connectorStartCancellation: cancellation,
    connectorTaskAdmission: true,
    authorityTransitions: { current: () => true },
    quitInProgress: false,
    installedUpdateAdmission: false,
    desktopGoCore: { observeOriginalStop: () => admitted.promise },
    configuration: { snapshot },
    connectorCredentialStore: {},
    secureMcpConnectorRuntime: { hasUnresolvedEffect: () => false },
    computerConnectorAdmission: () => ({ admissible: false, code: "FENCE" }),
    summaryFenceRecovery: {},
    transitionRefusal: () => ({ ok: false, error: "TRANSITION" }),
    configurationFailure: (error: string) => ({ ok: false, error }),
  });
  const start = vm.runInContext(
    stripTypeScriptTypes(
      declaration("startAdmittedSecureMcpConnector") +
        "\nstartAdmittedSecureMcpConnector;",
      { mode: "strip" },
    ),
    context,
  ) as (repair: boolean) => Promise<unknown>;
  const original = start(false);
  cancellation.abort();
  admitted.resolve({ restricted: false });
  await expect(original).resolves.toEqual({
    ok: false,
    error: "CONNECTOR_START_FAILED",
  });
  expect(snapshot).not.toHaveBeenCalled();
});

it("Quit reserves Go-core budget while the startup check is still awaiting workspace admission", async () => {
  const f = fixture(false, true);
  f.core.observeOriginalStop.mockImplementation(() => new Promise(() => {}));
  f.drain.onBeforeQuit({ preventDefault() {} });
  await vi.advanceTimersByTimeAsync(8_000);
  expect(f.record).toHaveBeenCalledExactlyOnceWith({
    drained: false,
    unconfirmed: ["connector"],
  });
  expect(f.core.close).toHaveBeenCalledOnce();
  expect(f.quit).toHaveBeenCalledOnce();
  expect(f.start).not.toHaveBeenCalled();
  expect(f.confirmStop).not.toHaveBeenCalled();
});
