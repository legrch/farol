import { describe, expect, it, vi } from "vitest";
import {
  prepareClosedStartupCompatibility,
  type Beta3StartupChoice,
  type ClosedStartupCompatibilityGuards,
} from "../../src/apps/desktop/closed-startup-compatibility";
import type {
  ConditionalSettingsWrite,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../src/pkg/product-settings/contract";

// Controlled in-memory store and guard ports only. No real file, process, app,
// helper, provider, lease, admission, closure or native-state proof is exercised.
function settings(): ProductSettings {
  const readiness = {
    visited: true,
    skipped: false,
    configured: true,
    reachable: "unknown",
    verified: {
      profile: "retained-profile",
      configRevision: 27,
      workspaceId: "00000000-0000-4000-8000-000000000004",
      runtimeGeneration: "retained-runtime",
      buildId: "b".repeat(64),
      protocol: "retained-verification/v1",
      verifiedAt: "2026-10-08T09:00:00.000Z",
    },
    needsAction: "Retain unresolved verification",
    unavailable: null,
    outcomeUnknown: true,
  };
  return ProductSettingsSchema.parse({
    schema: 1,
    revision: 31,
    general: {
      openAtLaunch: "home",
      sidebarDefault: "rail",
      activityDetail: "technical",
    },
    tasks: { retained: { policy: "unrelated", delivery: "unknown" } },
    computer: {
      computerId: "00000000-0000-4000-8000-000000000001",
      generation: 12,
      name: "Current Computer",
      commands: "workspace",
      filePolicy: "approved-roots-v1",
      workspaces: [
        {
          workspaceId: "00000000-0000-4000-8000-000000000004",
          root: "/fixture/approved",
          label: "Retained root",
          access: "write",
          excludedPaths: ["/fixture/approved/private"],
          rootIdentity: { device: "11", inode: "23" },
          gitHistoryApproved: false,
          accessCheck: {
            buildId: "b".repeat(64),
            computerGeneration: 12,
            verifiedAt: "2026-10-08T09:00:00.000Z",
            rootIdentity: { device: "11", inode: "23" },
          },
        },
      ],
      pendingEdit: {
        backend: "go-owner-v2",
        profileId: "00000000-0000-4000-8000-000000000002",
        operationId: "00000000-0000-4000-8000-000000000003",
        workspaceId: "00000000-0000-4000-8000-000000000004",
        relativePath: "retained.txt",
        computerGeneration: 12,
        submittedAt: "2026-10-09T09:00:00.000Z",
        beforeSha256: "a".repeat(64),
      },
    },
    nativeHosts: { generation: 9, codex: null, taskRoute: null },
    connectors: {
      secureMcp: {
        generation: 17,
        profile: "farol-next",
        tunnelId: null,
        tunnelClient: null,
        credential: "stored",
        runtime: {
          state: "outcome_unknown",
          connectorGeneration: 17,
          runtimeGeneration: "c".repeat(64),
          computerGeneration: 12,
          buildId: "b".repeat(64),
          observedAt: "2026-10-09T09:00:00.000Z",
        },
        challenge: null,
        attachment: null,
      },
    },
    setup: {
      journey: { currentStep: "verify", dismissed: true },
      chatgpt: readiness,
      computer: readiness,
      connect: readiness,
      hosts: readiness,
      verify: readiness,
    },
  });
}
const guardNames = [
  "closure",
  "appPair",
  "currentSettings",
  "originalOperation",
  "promotionLease",
] as const;
function fixture(choice: Beta3StartupChoice = "activity") {
  const currentSettings = settings();
  let durable = structuredClone(currentSettings);
  let fenced = false;
  const guards = {
    closure: {
      beforeWrite: vi.fn(async () => {}),
      assertBeforePublication: vi.fn(),
    },
    appPair: {
      beforeWrite: vi.fn(async () => {}),
      assertBeforePublication: vi.fn(),
    },
    currentSettings: {
      beforeWrite: vi.fn(async () => {}),
      assertBeforePublication: vi.fn(),
    },
    originalOperation: {
      beforeWrite: vi.fn(async () => {}),
      assertBeforePublication: vi.fn(),
    },
    promotionLease: {
      beforeWrite: vi.fn(async () => {}),
      assertBeforePublication: vi.fn(),
    },
  } satisfies ClosedStartupCompatibilityGuards;
  const saveConditional = vi.fn<ProductSettingsStore["saveConditional"]>(
    async (expected, next, fence) => {
      if (fenced) return { status: "unknown" };
      if (JSON.stringify(expected) !== JSON.stringify(durable))
        return { status: "not_written" };
      try {
        await fence?.beforeWrite?.();
        fence?.assertBeforePublication?.();
      } catch {
        return { status: "not_written" };
      }
      durable = structuredClone(next);
      return { status: "committed", settings: structuredClone(durable) };
    },
  );
  const fenceConditionalWrites = vi.fn(() => {
    fenced = true;
  });
  const store = { saveConditional, fenceConditionalWrites };
  const input = {
    currentSettings,
    retainedStartupChoice: choice,
    store,
    guards,
  };
  const prepare = () => prepareClosedStartupCompatibility(input);
  const ready = () => {
    const result = prepare();
    if (result.status !== "ready") throw new Error("Fixture was not ready");
    return result;
  };
  return { input, guards, store, prepare, ready, durable: () => durable };
}

describe("unwired beta3 closed startup compatibility", () => {
  it.each<Beta3StartupChoice>(["browser", "computer", "activity", "settings"])(
    "changes only Home and revision using explicit retained %s",
    async (choice) => {
      const f = fixture(choice);
      const before = structuredClone(f.input.currentSettings);
      const adapter = f.ready();
      expect(adapter.plan).toEqual({
        expectedRevision: 31,
        nextRevision: 32,
        openAtLaunch: choice,
      });
      expect(f.store.saveConditional).not.toHaveBeenCalled();
      expect(await adapter.apply()).toMatchObject({ status: "committed" });
      expect(f.durable()).toEqual({
        ...before,
        revision: 32,
        general: { ...before.general, openAtLaunch: choice },
      });
      expect(f.input.currentSettings).toEqual(before);
      expect(f.store.saveConditional).toHaveBeenCalledTimes(1);
      for (const name of guardNames) {
        expect(f.guards[name].beforeWrite).toHaveBeenCalledTimes(2);
        expect(f.guards[name].assertBeforePublication).toHaveBeenCalledTimes(2);
      }
    },
  );
  it.each([undefined, "home", "unknown", null])(
    "never discovers/defaults an invalid retained choice %s",
    (choice) => {
      const f = fixture();
      const result = prepareClosedStartupCompatibility({
        ...f.input,
        retainedStartupChoice: choice as Beta3StartupChoice,
      });
      expect(result).toEqual({
        status: "refused",
        reason: "invalid_retained_choice",
      });
      expect(f.store.saveConditional).not.toHaveBeenCalled();
    },
  );
  it.each<Beta3StartupChoice>(["browser", "computer", "activity", "settings"])(
    "does not rewrite already-compatible current %s",
    (choice) => {
      const f = fixture();
      f.input.currentSettings.general.openAtLaunch = choice;
      expect(f.prepare()).toEqual({ status: "not_applicable" });
      expect(f.store.saveConditional).not.toHaveBeenCalled();
    },
  );
  it("rejects corrupt or incomplete Settings and revision overflow", () => {
    const f = fixture();
    const incomplete = structuredClone(f.input.currentSettings);
    Reflect.deleteProperty(incomplete, "nativeHosts");
    expect(
      prepareClosedStartupCompatibility({
        ...f.input,
        currentSettings: incomplete,
      }),
    ).toEqual({ status: "refused", reason: "invalid_current_settings" });
    f.input.currentSettings.computer.name = " Normalized ";
    expect(f.prepare()).toEqual({
      status: "refused",
      reason: "invalid_current_settings",
    });
    f.input.currentSettings = settings();
    f.input.currentSettings.revision = Number.MAX_SAFE_INTEGER;
    expect(f.prepare()).toEqual({
      status: "refused",
      reason: "revision_exhausted",
    });
    expect(f.store.saveConditional).not.toHaveBeenCalled();
  });
  it("retains a complete independent snapshot and refuses a late unrelated writer change", async () => {
    const f = fixture();
    const adapter = f.ready();
    f.input.currentSettings.tasks = { changed: "caller" };
    f.durable().tasks = { changed: "original writer" };
    expect(await adapter.apply()).toMatchObject({
      status: "not_written",
      originalStoreResult: { status: "not_written" },
    });
    expect(f.store.saveConditional.mock.calls[0]?.[0].tasks).toEqual(
      settings().tasks,
    );
    expect(f.durable().tasks).toEqual({ changed: "original writer" });
    await adapter.apply();
    expect(f.store.saveConditional).toHaveBeenCalledTimes(1);
  });
  it.each(guardNames)(
    "refuses initial loss of the original %s guard without entering the store",
    async (name) => {
      const f = fixture();
      f.guards[name].beforeWrite.mockRejectedValue(
        new Error("original guard lost"),
      );
      const adapter = f.ready();
      expect(await adapter.apply()).toEqual({
        status: "not_written",
        originalStoreResult: null,
      });
      await adapter.apply();
      expect(f.store.saveConditional).not.toHaveBeenCalled();
    },
  );
  it.each(guardNames)(
    "rechecks %s before and synchronously at store publication",
    async (name) => {
      for (const synchronous of [false, true]) {
        const f = fixture();
        const guard = f.guards[name];
        if (synchronous)
          guard.assertBeforePublication
            .mockImplementationOnce(() => {})
            .mockImplementationOnce(() => {
              throw new Error("lost at publication");
            });
        else
          guard.beforeWrite
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("lost before publication"));
        const adapter = f.ready();
        expect(await adapter.apply()).toEqual({
          status: "not_written",
          originalStoreResult: { status: "not_written" },
        });
        expect(f.durable()).toEqual(settings());
        await adapter.apply();
        expect(f.store.saveConditional).toHaveBeenCalledTimes(1);
      }
    },
  );
  it("shares one original in-flight attempt across concurrent and reentrant calls", async () => {
    const f = fixture();
    const adapter = f.ready();
    let reentrant: ReturnType<typeof adapter.apply> | undefined;
    f.guards.closure.beforeWrite.mockImplementation(async () => {
      reentrant = adapter.apply();
    });
    const first = adapter.apply();
    expect(adapter.apply()).toBe(first);
    await first;
    expect(reentrant).toBe(first);
    expect(adapter.apply()).toBe(first);
    expect(f.store.saveConditional).toHaveBeenCalledTimes(1);
  });
  it("preserves the original unknown ACK even when complete candidate bytes are visible", async () => {
    const f = fixture();
    const original: ConditionalSettingsWrite = { status: "unknown" };
    f.store.saveConditional.mockImplementationOnce(async (_expected, next) => {
      Object.assign(f.durable(), structuredClone(next));
      return original;
    });
    const adapter = f.ready();
    const result = await adapter.apply();
    expect(result).toEqual({
      status: "unknown",
      originalStoreResult: original,
    });
    expect(result.originalStoreResult).toBe(original);
    expect(f.durable().general.openAtLaunch).toBe("activity");
    await adapter.apply();
    expect(f.store.saveConditional).toHaveBeenCalledTimes(1);
    expect(f.store.fenceConditionalWrites).toHaveBeenCalledTimes(1);
  });
  it("keeps a rejected original store ACK unknown and fences the same store", async () => {
    const f = fixture();
    f.store.saveConditional.mockRejectedValueOnce(new Error("ACK lost"));
    const adapter = f.ready();
    expect(await adapter.apply()).toEqual({
      status: "unknown",
      originalStoreResult: null,
    });
    await adapter.apply();
    expect(f.store.saveConditional).toHaveBeenCalledTimes(1);
    expect(f.store.fenceConditionalWrites).toHaveBeenCalledTimes(1);
  });
  it("retains a mismatched committed response as evidence without claiming compatibility", async () => {
    const f = fixture();
    const original: ConditionalSettingsWrite = {
      status: "committed",
      settings: settings(),
    };
    f.store.saveConditional.mockResolvedValueOnce(original);
    const adapter = f.ready();
    expect(await adapter.apply()).toEqual({
      status: "unknown",
      originalStoreResult: original,
    });
    expect(f.store.fenceConditionalWrites).toHaveBeenCalledTimes(1);
  });
  it("does not retry a failed unknown fence", async () => {
    const f = fixture();
    f.store.saveConditional.mockResolvedValueOnce({ status: "unknown" });
    f.store.fenceConditionalWrites.mockImplementationOnce(() => {
      throw new Error("fence unavailable");
    });
    const adapter = f.ready();
    expect(await adapter.apply()).toMatchObject({ status: "unknown" });
    await adapter.apply();
    expect(f.store.fenceConditionalWrites).toHaveBeenCalledTimes(1);
  });
});
