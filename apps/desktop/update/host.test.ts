import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAdmission } from "../host/admission";
import { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import { TaskMutationGate } from "../../../src/apps/desktop/task-mutation-gate";
import type { InstalledUpdateRuntimeOptions } from "../../../src/apps/desktop/installed-update-runtime";
import {
  InstalledUpdateCommandSchema,
  type InstalledUpdateView,
  type NormalQuitUpdateRequest,
  type NormalQuitUpdateReceipt,
} from "../../../src/modules/release/contract/installed-update";
import { guidedSettingsFixture } from "../../../tests/fixtures/guided-onboarding";
import {
  createInstalledUpdateHost,
  type InstalledUpdateHostPorts,
  type InstalledUpdateOwner,
} from "./host";

// Composition with scripted runtime/browser ports. No helper, installed image,
// promotion lease, real provider or production profile is exercised here.
const hosts: ReturnType<typeof createInstalledUpdateHost>[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.stopTimer();
  vi.useRealTimers();
});
function fixture(
  view: InstalledUpdateView = {
    phase: "unavailable",
    code: "UPDATE_NOT_INSTALLED",
  },
) {
  vi.useFakeTimers();
  const admission = new DesktopAdmission({
    chatGptReadonlyTask: () => false,
    directChatStart: () => false,
    chatGptAttachmentTask: () => false,
    workspaceEdit: () => false,
    computer: () => false,
    codexAgent: () => false,
    hostCheck: () => false,
    connectorStart: () => false,
  });
  const transition = new AuthorityTransitionReservation();
  const tasks = new TaskMutationGate();
  const updater = {
    snapshot: () => view,
    initialize: vi.fn(async () => {}),
    scheduledCheck: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    manualCheck: vi.fn(async () => {}),
    applyOnNormalQuit: vi.fn(
      async (
        _request: NormalQuitUpdateRequest,
      ): Promise<NormalQuitUpdateReceipt> => ({
        status: "skipped",
        code: "UPDATE_NOT_INSTALLED",
      }),
    ),
  };
  let captured!: InstalledUpdateRuntimeOptions;
  const ports: InstalledUpdateHostPorts = {
    buildEnvironment: "preview",
    sidecarOnly: false,
    directory: "/scripted/resources",
    build: { buildId: "scripted-build" } as InstalledUpdateHostPorts["build"],
    goCoreArtifact: null,
    physicalFiles: fs,
    idleCheckMs: 1000,
    createRuntime: vi.fn(async (options) => {
      captured = options;
      return updater as unknown as InstalledUpdateOwner;
    }),
    createHelperLifetime: () =>
      ({}) as ReturnType<InstalledUpdateHostPorts["createHelperLifetime"]>,
    operations: () => ({ record: vi.fn() }),
    userData: () => "/scripted/state",
    quit: vi.fn(),
    publish: vi.fn(),
    configurationChanged: vi.fn(),
    admission,
    configuration: () => ({
      snapshot: () => ({
        status: "ready" as const,
        settings: guidedSettingsFixture(),
      }),
      recordSecureMcpDrainedForUpdate: async () => {
        throw new Error("Unexpected scripted drain");
      },
    }),
    authorityTransitions: transition,
    taskMutations: () => tasks,
    connector: () => null,
    routes: () => [],
    persistence: () => Promise.resolve(),
    launchRoot: () => "/scripted/launch",
    stopConnector: vi.fn(async () => {}),
    startConnector: vi.fn(async () => {
      throw new Error("Unexpected scripted start");
    }),
    stage: vi.fn(),
    applyLayout: vi.fn(),
  };
  const host = createInstalledUpdateHost(ports);
  hosts.push(host);
  return {
    host,
    ports,
    admission,
    transition,
    tasks,
    updater,
    runtime: () => captured,
  };
}

describe("installed update host", () => {
  it.each(["dev", "owner-preview"])(
    "%s never observes installed runtime inputs",
    async (buildEnvironment) => {
      const ports = new Proxy(
        { buildEnvironment },
        {
          get(target, key) {
            if (key === "buildEnvironment") return target.buildEnvironment;
            throw new Error(`Unexpected installed input: ${String(key)}`);
          },
        },
      ) as InstalledUpdateHostPorts;
      const host = createInstalledUpdateHost(ports);
      await host.initialize();
      expect(host.updater).toBeNull();
      expect(host.view).toEqual({
        phase: "unavailable",
        code: "UPDATE_NOT_INSTALLED",
      });
    },
  );

  it("joins repeated initialization without creating another runtime or timer", async () => {
    const f = fixture();
    const first = f.host.initialize();
    expect(f.host.initialize()).toBe(first);
    await first;
    expect(f.ports.createRuntime).toHaveBeenCalledOnce();
    expect(f.updater.initialize).toHaveBeenCalledOnce();
    expect(f.updater.scheduledCheck).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    f.host.stopTimer();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("joins a runtime created after Quit without initializing or checking it", async () => {
    const f = fixture();
    let resolve!: (value: InstalledUpdateOwner) => void;
    const creation = new Promise<InstalledUpdateOwner>((finish) => {
      resolve = finish;
    });
    vi.mocked(f.ports.createRuntime).mockImplementation(() => creation);
    const initialization = f.host.initialize();
    f.admission.beginQuit();
    let closed = false;
    const closing = f.host.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    resolve(f.updater as unknown as InstalledUpdateOwner);
    await initialization;
    await closing;
    expect(closed).toBe(true);
    expect(f.updater.initialize).not.toHaveBeenCalled();
    expect(f.updater.scheduledCheck).not.toHaveBeenCalled();
    expect(f.updater.close).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("routes a current command but fences later commands after Quit", async () => {
    const f = fixture();
    await f.host.initialize();
    await f.host.command({ kind: "check" });
    expect(f.updater.manualCheck).toHaveBeenCalledOnce();
    f.admission.beginQuit();
    await f.host.command({ kind: "check" });
    expect(f.updater.manualCheck).toHaveBeenCalledOnce();
  });

  it("offers each published view to the attention port", async () => {
    const f = fixture();
    const attention = vi.fn();
    f.ports.attention = attention;
    await f.host.initialize();
    const view = { phase: "available", version: "2", deferred: false };
    f.runtime().publish(view as unknown as InstalledUpdateView);
    expect(attention).toHaveBeenCalledWith(view);
  });

  describe("explicit Check for Updates", () => {
    const idle = {
      phase: "idle",
      checkedAt: 1,
    } as unknown as InstalledUpdateView;
    const failed = {
      phase: "failed",
      code: "UPDATE_CHECK_FAILED",
      recoveryRequired: false,
    } as unknown as InstalledUpdateView;
    it.each([idle, failed])("runs one manual check when %#", async (view) => {
      const f = fixture();
      await f.host.initialize();
      f.runtime().publish(view);
      const first = f.host.requestCheck();
      expect(f.host.requestCheck()).toBe(first);
      await first;
      expect(f.updater.manualCheck).toHaveBeenCalledOnce();
    });
    it.each(["checking", "downloading", "ready", "applying", "available"])(
      "does not check while %s",
      async (phase) => {
        const f = fixture();
        await f.host.initialize();
        f.runtime().publish({
          phase,
          version: "1",
        } as unknown as InstalledUpdateView);
        await f.host.requestCheck();
        expect(f.updater.manualCheck).not.toHaveBeenCalled();
      },
    );
    it("does not check after Quit begins", async () => {
      const f = fixture();
      await f.host.initialize();
      f.runtime().publish(idle);
      f.admission.beginQuit();
      await f.host.requestCheck();
      expect(f.updater.manualCheck).not.toHaveBeenCalled();
    });
  });

  it.each(["rollback", "recover"])(
    "refuses retired %s without changing retained state",
    async (kind) => {
      const retained = Object.freeze({
        phase: "failed" as const,
        code: "UPDATE_HANDOFF_UNKNOWN",
        recoveryRequired: true,
      });
      const f = fixture(retained);
      await f.host.initialize();
      for (const value of [{ kind }, { kind, staleField: true }]) {
        expect(InstalledUpdateCommandSchema.safeParse(value).success).toBe(
          false,
        );
        expect(await f.host.command(value)).toEqual({
          phase: "unavailable",
          code: "UPDATE_FORWARD_ONLY",
        });
        expect(f.host.view).toBe(retained);
      }
      expect(f.updater.manualCheck).not.toHaveBeenCalled();
    },
  );

  it("borrows Quit admission only inside its original preparation and keeps Quit closed after release", async () => {
    const f = fixture();
    const browser = vi.fn(async () => ({
      ok: false as const,
      code: "UPDATE_BROWSER_BUSY",
    }));
    const host = createInstalledUpdateHost({
      ...f.ports,
      routes: () => [
        { acquireUpdateIdle: browser, acquireUpdateClose: browser },
      ],
    });
    hosts.push(host);
    await host.initialize();
    f.admission.beginQuit();
    const original = {
      kind: "ordinary-quit" as const,
      deadlineAt: Date.now() + 1000,
      relaunch: false as const,
      requestQuit: false as const,
    };
    expect(
      await f.runtime().acquireAdmission(async () => true, original),
    ).toEqual({ ok: false, code: "UPDATE_WORK_PENDING" });
    f.updater.applyOnNormalQuit.mockImplementation(async (request) => {
      expect(request.deadlineAt).toBe(original.deadlineAt);
      const result = await f
        .runtime()
        .acquireAdmission(async () => true, original);
      expect(result).toEqual({ ok: false, code: "UPDATE_BROWSER_BUSY" });
      return { status: "skipped", code: "UPDATE_BROWSER_BUSY" };
    });
    await expect(
      host.quitPreparation.prepare({
        deadlineAt: original.deadlineAt,
        canStartEffect: () => true,
      }),
    ).resolves.toEqual({ status: "skipped", code: "UPDATE_BROWSER_BUSY" });
    expect(f.admission.quitInProgress).toBe(true);
    expect(f.admission.installedUpdateAdmission).toBe(false);
    expect(f.admission.acquire("chatgpt-task")).toBeNull();
    expect(
      await f.runtime().acquireAdmission(async () => true, original),
    ).toEqual({ ok: false, code: "UPDATE_WORK_PENDING" });
    expect(browser).toHaveBeenCalledOnce();
  });

  it.each(["UPDATE_BROWSER_BUSY", "UPDATE_BROWSER_RELEASE_UNCONFIRMED"])(
    "preserves release certainty for %s",
    async (code) => {
      const f = fixture();
      const browser = vi.fn(async () => ({ ok: false as const, code }));
      const route = { acquireUpdateIdle: browser, acquireUpdateClose: browser };
      // A single scripted browser refusal prevents all promotion/native effects.
      const host = createInstalledUpdateHost({
        ...f.ports,
        routes: () => [route],
      });
      hosts.push(host);
      await host.initialize();
      const result = await f.runtime().acquireAdmission(async () => true);
      expect(result).toEqual({ ok: false, code });
      const unknown = code === "UPDATE_BROWSER_RELEASE_UNCONFIRMED";
      expect(f.admission.installedUpdateAdmission).toBe(unknown);
      expect(f.transition.current() !== null).toBe(unknown);
      const claim = f.tasks.tryEnter();
      expect(claim === null).toBe(unknown);
      claim?.release();
      expect(f.ports.stopConnector).not.toHaveBeenCalled();
      if (unknown) {
        expect(await f.runtime().acquireAdmission(async () => true)).toEqual({
          ok: false,
          code: "UPDATE_WORK_PENDING",
        });
        expect(browser).toHaveBeenCalledOnce();
      }
    },
  );
});
