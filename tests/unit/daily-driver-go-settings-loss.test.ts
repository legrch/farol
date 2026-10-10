import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { expect, it, vi, type MockInstance } from "vitest";
import { DesktopGoCore } from "../../apps/desktop/go-core-host.ts";
import { BridgeError, type Client } from "../../apps/desktop/bridge/client.ts";
import type { ConnectorHostBridge } from "../../apps/desktop/bridge/connector-host.ts";
import type {
  SettingsStoreDriver,
  SettingsStorePump,
} from "../../apps/desktop/bridge/settings-store.ts";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration.ts";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";

// Actual main composition, service, pump and connector bridge; only persistence,
// terminal peer replies and the Electron notification sink are controlled.
// Seeding the original validated Open ACK is not launch/native authority proof.
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
const callbacks: string[] = [];
function visit(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (node.type === "CallExpression") {
    const callee = node.callee as { name?: string };
    const args = node.arguments as {
      value?: string;
      start: number;
      end: number;
    }[];
    if (
      callee.name === "runDesktopStartupBoundary" &&
      args[0]?.value === "go-settings" &&
      args[1]
    )
      callbacks.push(source.slice(args[1].start, args[1].end));
  }
  for (const nested of Object.values(node)) {
    if (Array.isArray(nested)) nested.forEach(visit);
    else if (nested && typeof nested === "object") visit(nested);
  }
}
visit(ast);
if (callbacks.length !== 1)
  throw Error("GO_SETTINGS_COMPOSITION_SOURCE_MISSING");
const compiled = `(${stripTypeScriptTypes(callbacks[0]!)})()`;
const build = "b".repeat(64);
const generation = "a".repeat(64);
const peer = { profileId: "profile", backendGeneration: "backend" };

async function fixture(withWindow = true) {
  let document: ProductSettings | null = null;
  const store = new ProductSettingsStore({ root: "/synthetic/settings" });
  vi.spyOn(store, "load").mockImplementation(async () =>
    structuredClone(document),
  );
  const save = vi.spyOn(store, "save").mockImplementation(async (value) => {
    document = structuredClone(value);
  });
  const writeFence = vi.spyOn(store, "fenceConditionalWrites");
  const initial = new ProductConfigurationService(store);
  await initial.initialize();
  if (!document) throw Error("SETTINGS_FIXTURE_NOT_INITIALIZED");
  const seeded = document as ProductSettings;
  seeded.connectors.secureMcp = {
    ...seeded.connectors.secureMcp,
    generation: 3,
    credential: "stored",
    runtime: {
      state: "ready",
      buildId: build,
      connectorGeneration: 3,
      computerGeneration: seeded.computer.generation,
      runtimeGeneration: generation,
      observedAt: "2026-10-10T00:00:00.000Z",
    },
  };
  const owner = new ProductConfigurationService(store);
  await owner.initialize();
  let rejectPoll!: (error: unknown) => void;
  const poll = new Promise<never>((_resolve, reject) => {
    rejectPoll = reject;
  });
  let dead = false;
  const requests: string[] = [];
  const client = {
    get verifiedContext() {
      if (dead) throw new BridgeError("unavailable", "backend_unavailable");
      return peer;
    },
    request: async (
      method: string,
      _body: unknown,
      options: { id: string; operationId: string },
    ) => {
      requests.push(method);
      if (dead) throw new BridgeError("unavailable", "backend_unavailable");
      if (method === "computer.settings.store.next") return poll;
      if (method === "computer.connector.open")
        return {
          status: "ok",
          requestId: options.id,
          operationId: options.operationId,
          context: peer,
          data: {
            endpoint: {
              binding: {
                ...peer,
                buildId: build,
                runtimeId: "original-runtime",
                connectorGeneration: "3",
              },
              socketPath: "/synthetic/connector.sock",
              token: "c".repeat(64),
            },
            execution: {
              ownerId: "owner",
              sessionId: "session",
              taskId: "scope",
              taskEpoch: "1",
              participantId: "participant",
              turnId: "correlation",
              generation: "1",
            },
            admissionOperationId: options.operationId,
          },
        };
      throw Error(`UNEXPECTED_REQUEST:${method}`);
    },
  } as unknown as Client;
  const core = new DesktopGoCore(
    client,
    () => document!,
    undefined,
    true,
    build,
  );
  const internals = core as unknown as {
    connector: ConnectorHostBridge;
    settingsStorePump: SettingsStorePump;
  };
  await internals.connector.open({
    publication: {
      fence: "1",
      storeRevision: "1",
      settingsRevision: "1",
      generation: "1",
      approvalDigest: "d".repeat(64),
      publishOperationId: "publish",
    },
    runtimeId: "original-runtime",
    connectorGeneration: "3",
    launchDigest: "e".repeat(64),
  });
  const binding = core.currentComputerConnectorBinding();
  const originalWithdraw = vi.spyOn(core, "withdraw");
  let originalFencePromise: Promise<void> | undefined;
  const attach = owner.attachSettingsDeliveryStore.bind(owner);
  let duringFence = () => {};
  vi.spyOn(owner, "attachSettingsDeliveryStore").mockImplementation(
    (identity) => {
      const driver = attach(identity);
      const fence = driver.fence.bind(driver);
      return {
        ...driver,
        fence: () => {
          originalFencePromise = fence();
          duringFence();
          return originalFencePromise;
        },
      };
    },
  );
  let driverFence: MockInstance<SettingsStoreDriver["fence"]>;
  const connect = core.connectSettingsStore.bind(core);
  vi.spyOn(core, "connectSettingsStore").mockImplementation((factory) => {
    connect((profile) => {
      const driver = factory(profile);
      driverFence = vi.spyOn(driver, "fence");
      return driver;
    });
  });
  let renderer = owner.snapshot();
  const deliveries: {
    snapshot: ReturnType<typeof owner.snapshot>;
    writeFences: number;
  }[] = [];
  const send = vi.fn(() => {
    renderer = owner.snapshot();
    deliveries.push({
      snapshot: renderer,
      writeFences: writeFence.mock.calls.length,
    });
  });
  const window = { isDestroyed: () => false, webContents: { send } };
  const context = {
    configuration: owner as ProductConfigurationService | null,
    desktopGoCore: core as DesktopGoCore | null,
    window: (withWindow ? window : null) as typeof window | null,
    quitInProgress: false,
    installedUpdateAdmission: false,
    channels: { configurationChanged: "configuration-changed" },
  };
  vm.runInNewContext(compiled, context);
  expect(requests).toContain("computer.settings.store.next");
  const savedBeforeLoss = save.mock.calls.length;
  async function lose() {
    dead = true;
    rejectPoll(new BridgeError("unknown", "backend_unavailable"));
    for (let n = 0; n < 80; n += 1) await Promise.resolve();
    expect(internals.settingsStorePump.state).toBe("unknown");
    expect(internals.settingsStorePump.fenceState).toBe("failed");
    expect(owner.snapshot()).toEqual({
      status: "error",
      error: "SETTINGS_READ_FAILED",
    });
    expect(core.currentComputerConnectorBinding()).toBe(binding);
    expect(save.mock.calls).toHaveLength(savedBeforeLoss);
    expect(document?.connectors.secureMcp.runtime?.state).toBe("ready");
    expect(
      requests.filter((method) => method === "computer.settings.store.next"),
    ).toHaveLength(1);
    expect(driverFence!.mock.results[0]?.value).toBe(originalFencePromise);
  }
  return {
    context,
    window,
    send,
    deliveries,
    owner,
    core,
    originalWithdraw,
    lose,
    renderer: () => renderer,
    fencePromise: () => originalFencePromise,
    duringFence: (action: () => void) => {
      duringFence = action;
    },
  };
}

it("publishes terminal peer loss after the original store fence despite failed withdrawal", async () => {
  const f = await fixture();
  expect(f.renderer().status).toBe("ready");
  await f.lose();
  expect(f.send).toHaveBeenCalledExactlyOnceWith("configuration-changed");
  expect(f.renderer().status).toBe("error");
  expect(f.deliveries).toEqual([
    {
      snapshot: { status: "error", error: "SETTINGS_READ_FAILED" },
      writeFences: 1,
    },
  ]);
  expect(f.originalWithdraw).toHaveBeenCalledOnce();
});

for (const state of [
  "no-window",
  "quit",
  "update",
  "destroyed",
  "owner",
  "core",
  "window",
] as const) {
  it(`retains the original loss fence without notifying ${state}`, async () => {
    const f = await fixture();
    const replacementWithdraw = vi.fn(async () => {});
    if (state === "no-window") f.context.window = null;
    if (state === "quit") f.context.quitInProgress = true;
    if (state === "update") f.context.installedUpdateAdmission = true;
    if (state === "destroyed") f.window.isDestroyed = () => true;
    if (state === "owner")
      f.context.configuration = {} as ProductConfigurationService;
    if (state === "core")
      f.context.desktopGoCore = {
        withdraw: replacementWithdraw,
      } as unknown as DesktopGoCore;
    if (state === "window")
      f.duringFence(() => {
        f.context.window = { ...f.window };
      });
    await f.lose();
    expect(f.send).not.toHaveBeenCalled();
    expect(replacementWithdraw).not.toHaveBeenCalled();
    expect(f.originalWithdraw).toHaveBeenCalledOnce();
  });
}

it("keeps the rejected original fence promise observed when renderer publication throws", async () => {
  const f = await fixture();
  f.send.mockImplementation(() => {
    throw Error("CONTROLLED_RENDERER_SEND_FAILED");
  });
  await f.lose();
  expect(f.send).toHaveBeenCalledExactlyOnceWith("configuration-changed");
  await expect(f.fencePromise()).rejects.toMatchObject({
    code: "backend_unavailable",
  });
  expect(f.originalWithdraw).toHaveBeenCalledOnce();
});

it("keeps an early terminal loss fenced when startup has no window", async () => {
  const f = await fixture(false);
  await f.lose();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.originalWithdraw).toHaveBeenCalledOnce();
});

it("does not publish when Quit begins inside the synchronous original fence", async () => {
  const f = await fixture();
  f.duringFence(() => {
    f.context.quitInProgress = true;
  });
  await f.lose();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.originalWithdraw).toHaveBeenCalledOnce();
});
