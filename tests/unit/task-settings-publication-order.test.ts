import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import { TaskExecutionSettingsSchema } from "../../src/pkg/owner-config/contract";
import {
  ProductSettingsSchema,
  type CodexTaskSource,
  type ProductSettings,
} from "../../src/pkg/product-settings/contract";
import { ownerSettingsComputerApproval } from "../../src/modules/computer/infra/repo/owner-settings-computer-approval";
import { taskPolicy } from "../fixtures/task-policy";

// Application-port ordering only: memory persistence and the existing trusted
// withdrawal/publication callback. No Go ACK, serving grant, account capability,
// filesystem identity, native executable or model operation is established here.
// Source/route records below are configured fixture data, not live approval.
afterEach(() => vi.restoreAllMocks());
const hostInput = {
  executablePath: "/fixture/bin/codex",
  executableSha256: "a".repeat(64),
  version: "0.153.4",
  protocol: "codex-app-server/v2",
  schemaSha256: "b".repeat(64),
  buildId: "c".repeat(64),
} as const;
const now = "2026-10-04T09:00:00.000Z";
function sourceEvidence(): CodexTaskSource {
  const binding = {
    executablePath: hostInput.executablePath,
    executableSha256: hostInput.executableSha256,
    baseSchemaSha256: hostInput.schemaSha256,
  };
  return {
    handoff: {
      ...binding,
      status: "supported",
      contract: {
        version: hostInput.version,
        protocol: hostInput.protocol,
        schemaSha256: "d".repeat(64),
        projectBoundCreateStatus: true,
      },
    },
    followup: {
      ...binding,
      status: "unavailable",
      code: "CODEX_HOST_FOLLOWUP_UNAVAILABLE",
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Mutation = ReturnType<ProductConfigurationService["clearCodexTaskRoute"]>;
type SettingsTransform = (settings: ProductSettings) => ProductSettings;

// There is no public tasks-section update API in this source snapshot. This
// narrow test-only structural view invokes the REAL queued mutation/commit path;
// it does not replace any service implementation. It proves final-projection
// comparison and publication order, not external owner-config ingestion or IPC.
function mutateTaskSettings(
  service: ProductConfigurationService,
  transform: SettingsTransform,
): Mutation {
  return (
    service as unknown as { mutate: (f: SettingsTransform) => Mutation }
  ).mutate(transform);
}
function changePolicy(
  service: ProductConfigurationService,
  edit: (tasks: ReturnType<typeof taskPolicy>) => void,
) {
  return mutateTaskSettings(service, (settings) => {
    const tasks = TaskExecutionSettingsSchema.parse(settings.tasks);
    edit(tasks);
    return { ...settings, revision: settings.revision + 1, tasks };
  });
}
function changeRoute(service: ProductConfigurationService) {
  return mutateTaskSettings(service, (settings) => {
    if (!settings.nativeHosts.taskRoute)
      throw new Error("Fixture route missing");
    return {
      ...settings,
      revision: settings.revision + 1,
      nativeHosts: {
        ...settings.nativeHosts,
        taskRoute: {
          ...settings.nativeHosts.taskRoute,
          execution: { sandbox: "read-only", approvalPolicy: "untrusted" },
        },
      },
    };
  });
}
async function fixture() {
  let stored: ProductSettings | null = null;
  let saveGate: ReturnType<typeof deferred> | undefined;
  let ackGate: ReturnType<typeof deferred> | undefined;
  let sequence = 0;
  const events: string[] = [];
  const store = new ProductSettingsStore({
    root: "/fixture/unused/task-settings",
  });
  const save = vi.spyOn(store, "save").mockImplementation(async (settings) => {
    events.push("save:started");
    if (saveGate) await saveGate.promise;
    stored = structuredClone(settings);
    events.push("save:landed");
  });
  const load = vi.spyOn(store, "load").mockImplementation(async () => {
    events.push("readback");
    return structuredClone(stored);
  });
  const dependencies = {
    now: () => now,
    id: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    homeDirectory: "/fixture/home",
  };
  const seed = new ProductConfigurationService(store, dependencies);
  await seed.initialize();
  expect(
    (await seed.recordCodexHost({ ...hostInput, taskSource: sourceEvidence() }))
      .ok,
  ).toBe(true);
  const seedSnapshot = seed.snapshot();
  if (seedSnapshot.status !== "ready") throw new Error("Fixture seed missing");
  const configured = seedSnapshot.settings;
  configured.tasks = taskPolicy();
  configured.nativeHosts.taskRoute = {
    transport: "codex-shared-proxy/v1",
    socketPath: "/fixture/private/codex.sock",
    expectedCodexHome: "/fixture/home",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    projectRoot: "/fixture/project",
    projectIdentity: { device: "1", inode: "2" },
    gitCommonDirectory: "/fixture/project/.git",
    execution: { sandbox: "read-only", approvalPolicy: "on-request" },
    harness: "codex",
    computerGeneration: configured.computer.generation,
    hostGeneration: configured.nativeHosts.generation,
    approvedAt: now,
    expiresAt: Date.parse("2026-10-04T12:00:00.000Z"),
  };
  stored = ProductSettingsSchema.parse(configured);
  const publish = vi.fn(async (_settings: ProductSettings) => {
    events.push("publish");
  });
  const withdraw = vi.fn(async () => {
    events.push("withdraw:requested");
    if (ackGate) await ackGate.promise;
    events.push("withdraw:acknowledged");
    return { publish };
  });
  const service = new ProductConfigurationService(store, {
    ...dependencies,
    withdrawComputerAuthority: withdraw,
  });
  await service.initialize();
  const settings = () => {
    const snapshot = service.snapshot();
    if (snapshot.status !== "ready")
      throw new Error("Fixture settings missing");
    return snapshot.settings;
  };
  expect(settings().nativeHosts.codex?.liveVerification).toBeNull();
  expect(settings().nativeHosts.codex?.agentVerification).toBeNull();
  expect(settings().setup.computer.verified).toBeNull();
  expect(settings().nativeHosts.taskRoute).not.toBeNull();
  events.length = 0;
  save.mockClear();
  load.mockClear();
  withdraw.mockClear();
  publish.mockClear();
  return {
    service,
    save,
    load,
    withdraw,
    publish,
    events,
    settings,
    disk: () => structuredClone(stored),
    pauseAck: () => {
      ackGate = deferred();
      return ackGate;
    },
    pauseSave: () => {
      saveGate = deferred();
      return saveGate;
    },
  };
}
const successfulOrder = [
  "withdraw:requested",
  "withdraw:acknowledged",
  "save:started",
  "save:landed",
  "readback",
  "publish",
];
const policyChanges = [
  {
    name: "selected model",
    edit: (tasks: ReturnType<typeof taskPolicy>) => {
      tasks.harnesses.codex!.models.luna!.model = "gpt-6-sol";
    },
  },
  {
    name: "default model",
    edit: (tasks: ReturnType<typeof taskPolicy>) => {
      tasks.harnesses.codex!.defaultModel = "sol";
    },
  },
  {
    name: "default effort",
    edit: (tasks: ReturnType<typeof taskPolicy>) => {
      tasks.harnesses.codex!.models.luna!.defaultEffort = "high";
    },
  },
  {
    name: "other configured policy entry",
    edit: (tasks: ReturnType<typeof taskPolicy>) => {
      tasks.harnesses.codex!.models.simple!.defaultEffort = "medium";
    },
  },
];
const taskChanges: {
  name: string;
  run: (service: ProductConfigurationService) => Mutation;
}[] = [
  {
    name: "Task model policy",
    run: (service) => changePolicy(service, policyChanges[0]!.edit),
  },
  { name: "Task route clear", run: (service) => service.clearCodexTaskRoute() },
  { name: "Task route execution policy", run: changeRoute },
  {
    name: "Task source withdrawal",
    run: (service) => service.recordCodexHost(hostInput),
  },
];

describe("Task settings negative publication before persistence", () => {
  it.each(policyChanges)(
    "withdraws for a Task-only $name change and publishes exact readback",
    async ({ edit }) => {
      const f = await fixture();
      const before = f.settings();
      const result = await changePolicy(f.service, edit);
      expect(result.ok).toBe(true);
      expect(f.settings().tasks).not.toEqual(before.tasks);
      expect(ownerSettingsComputerApproval(f.settings(), 0)).toEqual(
        ownerSettingsComputerApproval(before, 0),
      );
      expect(f.events).toEqual(successfulOrder);
      expect(f.withdraw).toHaveBeenCalledTimes(1);
      expect(f.publish).toHaveBeenCalledExactlyOnceWith(f.disk());
      expect(f.disk()).toEqual(f.settings());
    },
  );

  it.each(taskChanges.slice(1))(
    "withdraws for $name while Computer projection is unchanged",
    async ({ run }) => {
      const f = await fixture();
      const before = f.settings();
      const result = await run(f.service);
      expect(result.ok).toBe(true);
      expect(f.settings().nativeHosts).not.toEqual(before.nativeHosts);
      expect(ownerSettingsComputerApproval(f.settings(), 0)).toEqual(
        ownerSettingsComputerApproval(before, 0),
      );
      expect(f.events).toEqual(successfulOrder);
      expect(f.publish).toHaveBeenCalledExactlyOnceWith(f.disk());
    },
  );

  it.each(taskChanges)(
    "awaits the negative ACK and separately the save for $name",
    async ({ run }) => {
      const f = await fixture();
      const oldDisk = f.disk();
      const ack = f.pauseAck();
      const save = f.pauseSave();
      let settled = false;
      const pending = run(f.service).then((result) => {
        settled = true;
        return result;
      });
      try {
        await setImmediate();
        expect([...f.events]).toEqual(["withdraw:requested"]);
        expect(settled).toBe(false);
        expect(f.save).not.toHaveBeenCalled();
        expect(f.disk()).toEqual(oldDisk);
        expect(f.publish).not.toHaveBeenCalled();
        // Old disk still names its route/source. Only callback sequencing is
        // established: this does not claim to observe Root's actual authority.
        expect(f.disk()?.nativeHosts.taskRoute).not.toBeNull();
        ack.resolve();
        await setImmediate();
        expect([...f.events]).toEqual([
          "withdraw:requested",
          "withdraw:acknowledged",
          "save:started",
        ]);
        expect(settled).toBe(false);
        expect(f.save).toHaveBeenCalledTimes(1);
        expect(f.disk()).toEqual(oldDisk);
        expect(f.load).not.toHaveBeenCalled();
        expect(f.publish).not.toHaveBeenCalled();
        save.resolve();
        const result = await pending;
        expect(result.ok).toBe(true);
        expect(f.events).toEqual(successfulOrder);
        expect(f.publish).toHaveBeenCalledExactlyOnceWith(f.disk());
      } finally {
        ack.resolve();
        save.resolve();
        await pending;
      }
    },
  );

  it("does not save or publish a Task policy when the negative ACK is unknown", async () => {
    const f = await fixture();
    const oldDisk = f.disk();
    f.withdraw.mockRejectedValueOnce(new Error("Fixture negative ACK unknown"));
    const result = await changePolicy(f.service, policyChanges[0]!.edit);
    expect(result.ok).toBe(false);
    expect(f.withdraw).toHaveBeenCalledTimes(1);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.disk()).toEqual(oldDisk);
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("does not publish Task witness withdrawal after a failed save", async () => {
    const f = await fixture();
    const oldDisk = f.disk();
    f.save.mockRejectedValueOnce(new Error("Fixture save failed"));
    const result = await f.service.recordCodexHost(hostInput);
    expect(result.ok).toBe(false);
    expect(f.withdraw).toHaveBeenCalledTimes(1);
    expect(f.disk()).toEqual(oldDisk);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.settings().nativeHosts.codex?.taskSource).toBeNull();
    expect(f.settings().nativeHosts.taskRoute).toBeNull();
  });

  it.each(["missing", "mismatched", "rejected"] as const)(
    "does not publish a Task route after a $0 readback",
    async (failure) => {
      const f = await fixture();
      const oldDisk = f.disk();
      if (failure === "missing") f.load.mockResolvedValueOnce(null);
      if (failure === "mismatched") {
        f.load.mockImplementationOnce(async () => {
          f.events.push("readback");
          const landed = f.disk();
          if (!landed || !oldDisk) throw new Error("Fixture readback missing");
          expect(landed.revision).toBeGreaterThan(oldDisk.revision);
          expect(landed.nativeHosts.taskRoute).toBeNull();
          // Same revision as the actual saved candidate, different Task data.
          // Comparing only revision must never authorize this publication.
          return {
            ...landed,
            nativeHosts: {
              ...landed.nativeHosts,
              taskRoute: oldDisk.nativeHosts.taskRoute,
            },
          };
        });
      }
      if (failure === "rejected")
        f.load.mockRejectedValueOnce(new Error("Fixture readback failed"));
      const result = await f.service.clearCodexTaskRoute();
      expect(result.ok).toBe(false);
      expect(f.withdraw).toHaveBeenCalledTimes(1);
      expect(f.save).toHaveBeenCalledTimes(1);
      expect(f.disk()?.nativeHosts.taskRoute).toBeNull();
      expect(f.publish).not.toHaveBeenCalled();
      // The catch-path readback may adopt landed disk settings in the snapshot;
      // even exact recovery bytes are not a successful publication transaction.
      expect(f.load).toHaveBeenCalledTimes(2);
    },
  );

  it("retains source withdrawal through repeated persistence failure without publishing old disk", async () => {
    const f = await fixture();
    const oldDisk = f.disk();
    f.save.mockRejectedValue(new Error("Fixture persistent save failure"));
    expect((await f.service.recordCodexHost(hostInput)).ok).toBe(false);
    expect(f.withdraw).toHaveBeenCalledTimes(1);
    const later = await f.service.updateGeneral({
      ...f.settings().general,
      sidebarDefault: "rail",
    });
    expect(later.ok).toBe(false);
    expect(f.disk()).toEqual(oldDisk);
    expect(f.disk()?.nativeHosts.codex?.taskSource).not.toBeNull();
    expect(f.settings().nativeHosts.codex?.taskSource).toBeNull();
    expect(f.settings().nativeHosts.taskRoute).toBeNull();
    expect(f.withdraw).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("does not replay save or publication when Task publication becomes unknown", async () => {
    const f = await fixture();
    f.publish.mockRejectedValueOnce(new Error("Fixture publication unknown"));
    const result = await f.service.clearCodexTaskRoute();
    expect(result.ok).toBe(false);
    expect(f.withdraw).toHaveBeenCalledTimes(1);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.disk()?.nativeHosts.taskRoute).toBeNull();
  });

  it("does not withdraw or publish for unrelated UI-only settings", async () => {
    const f = await fixture();
    const before = f.settings();
    const result = await f.service.updateGeneral({
      ...before.general,
      sidebarDefault: "rail",
    });
    expect(result.ok).toBe(true);
    expect(f.settings().nativeHosts).toEqual(before.nativeHosts);
    expect(f.settings().tasks).toEqual(before.tasks);
    expect(f.withdraw).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.events).toEqual(["save:started", "save:landed", "readback"]);
  });
});
