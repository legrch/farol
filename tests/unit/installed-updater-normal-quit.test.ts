import { describe, expect, it, vi } from "vitest";
import {
  InstalledUpdater,
  type InstalledUpdaterPorts,
  type ReadyUpdate,
  type UpdateHandoff,
} from "../../src/modules/release/app/installed-updater";
import { parseInstallOnQuitPreference } from "../../src/modules/release/domain/installed-update";
import {
  InstallOnQuitPreferenceSchema,
  InstallOnQuitPreferenceResultSchema,
  InstalledUpdateCommandSchema,
  InstalledUpdateViewSchema,
  NormalQuitApplyContextSchema,
  NormalQuitUpdateRequestSchema,
  NormalQuitUpdateReceiptSchema,
  NormalQuitUpdateStateSchema,
  type InstallOnQuitPreferenceResult,
  type NormalQuitUpdateRequest,
  type NormalQuitUpdateReceipt,
} from "../../src/modules/release/contract/installed-update";

// Port-only fixture. No real filesystem, helper, Electron, profile or provider.
const staged: ReadyUpdate = {
  handle: "normal-quit-owned-stage",
  manifest: {
    schema: "farol.github-release/1",
    repository: "legrch/farol",
    channel: "owner-beta",
    product: "Farol Next Preview",
    bundleId: "local.farol.next.preview",
    version: "0.2.0-owner.beta.5",
    buildVersion: "19",
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: "b".repeat(64),
    buildId: "c".repeat(64),
    artifactSha256: "d".repeat(64),
    archiveSha256: "e".repeat(64),
    archiveName: "Farol-normal-quit-fixture.zip",
    archiveSize: 1,
    platform: "darwin",
    arch: "arm64",
    signing: "unsigned",
    notarized: false,
    sourceDirty: false,
  },
};
const consent = {
  status: "confirmed",
  scope: "install-on-normal-quit",
  enabled: true,
} as const;
const request = { kind: "ordinary-quit", deadlineAt: 2_000 } as const;

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fixture(choice: unknown = consent) {
  let now = 1_000;
  const ports = {
    now: () => now,
    readAutomaticUpdatePreference: vi
      .fn()
      .mockResolvedValue({ status: "confirmed", enabled: false }),
    writeAutomaticUpdatePreference: vi
      .fn<
        NonNullable<InstalledUpdaterPorts["writeAutomaticUpdatePreference"]>
      >()
      .mockResolvedValue({ status: "confirmed", enabled: true }),
    readInstallOnQuitPreference: vi.fn().mockResolvedValue(choice),
    writeInstallOnQuitPreference: vi
      .fn<NonNullable<InstalledUpdaterPorts["writeInstallOnQuitPreference"]>>()
      .mockImplementation(async (enabled) => ({ ...consent, enabled })),
    cancelPending: vi.fn(),
    recover: vi
      .fn<InstalledUpdaterPorts["recover"]>()
      .mockResolvedValue({ ok: true, update: staged }),
    discover: vi.fn<InstalledUpdaterPorts["discover"]>().mockResolvedValue({
      ok: true,
      available: true,
      version: staged.manifest.version,
      buildId: staged.manifest.buildId,
      deferred: false,
    }),
    download: vi
      .fn<InstalledUpdaterPorts["download"]>()
      .mockResolvedValue({ ok: true, update: staged }),
    retain: vi.fn<InstalledUpdaterPorts["retain"]>().mockResolvedValue(),
    skip: vi
      .fn<InstalledUpdaterPorts["skip"]>()
      .mockResolvedValue({ ok: true }),
    defer: vi
      .fn<InstalledUpdaterPorts["defer"]>()
      .mockResolvedValue({ ok: true }),
    restart: vi
      .fn<InstalledUpdaterPorts["restart"]>()
      .mockResolvedValue({ status: "accepted" }),
    applyOnQuit: vi
      .fn<NonNullable<InstalledUpdaterPorts["applyOnQuit"]>>()
      .mockResolvedValue({ status: "accepted" }),
    restore: vi
      .fn<InstalledUpdaterPorts["restore"]>()
      .mockResolvedValue({ status: "accepted" }),
    publish: vi.fn<InstalledUpdaterPorts["publish"]>(),
  } satisfies InstalledUpdaterPorts;
  const updater = new InstalledUpdater(ports);
  return {
    updater,
    ports,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("normal-Quit release contracts (pure consent, no persistent format change)", () => {
  it.each([
    undefined,
    null,
    true,
    [],
    { status: "confirmed", enabled: true },
    { status: "confirmed", scope: "automatic-download", enabled: true },
    { ...consent, enabled: "true" },
    { ...consent, legacy: true },
    { status: "blocked", enabled: true, code: "UPDATE_STATE_UNKNOWN" },
    { status: "unknown", enabled: false, code: "invalid-code" },
  ])("rejects legacy or malformed consent: %j", (value) => {
    expect(parseInstallOnQuitPreference(value)).toBeNull();
    expect(InstallOnQuitPreferenceSchema.safeParse(value).success).toBe(false);
    expect(InstallOnQuitPreferenceResultSchema.safeParse(value).success).toBe(
      false,
    );
  });

  it.each([
    consent,
    { ...consent, enabled: false },
    {
      status: "blocked",
      enabled: false,
      code: "UPDATE_QUIT_PREFERENCE_UNREADABLE",
    },
    {
      status: "unknown",
      enabled: false,
      code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
    },
  ])("agrees across domain and wire consent parsers: %j", (value) => {
    expect(parseInstallOnQuitPreference(value)).toEqual(
      InstallOnQuitPreferenceSchema.parse(value),
    );
  });

  it("exposes a separate command and rejects renderer apply/deadline/quit controls", () => {
    expect(
      InstalledUpdateCommandSchema.parse({
        kind: "set-install-on-quit-preference",
        enabled: true,
      }),
    ).toEqual({ kind: "set-install-on-quit-preference", enabled: true });
    expect(
      InstalledUpdateCommandSchema.safeParse({
        ...request,
        kind: "apply-on-normal-quit",
      }).success,
    ).toBe(false);
    expect(
      InstalledUpdateCommandSchema.safeParse({
        kind: "set-install-on-quit-preference",
        enabled: true,
        deadlineAt: 2_000,
      }).success,
    ).toBe(false);
    expect(
      NormalQuitApplyContextSchema.safeParse({
        ...request,
        relaunch: false,
        requestQuit: false,
      }).success,
    ).toBe(true);
    expect(
      NormalQuitApplyContextSchema.safeParse({
        ...request,
        relaunch: true,
        requestQuit: false,
      }).success,
    ).toBe(false);
    expect(
      NormalQuitApplyContextSchema.safeParse({
        ...request,
        relaunch: false,
        requestQuit: true,
      }).success,
    ).toBe(false);
    expect(
      NormalQuitUpdateRequestSchema.safeParse({
        ...request,
        deadlineAt: Infinity,
      }).success,
    ).toBe(false);
    expect(
      NormalQuitUpdateReceiptSchema.safeParse({
        status: "accepted",
        relaunch: true,
      }).success,
    ).toBe(false);
  });
});

describe("normal-Quit application owner (hermetic ports, no native/installed acceptance)", () => {
  it("declines a clock observation failure before the engine has any effect", async () => {
    const f = fixture();
    const updater = new InstalledUpdater({
      ...f.ports,
      now: () => {
        throw new Error("clock unreadable");
      },
    });
    await updater.initialize();
    expect(await updater.applyOnNormalQuit(request)).toEqual({
      status: "blocked",
      code: "UPDATE_QUIT_CLOCK_UNREADABLE",
    });
    expect(f.ports.applyOnQuit).not.toHaveBeenCalled();
    expect(updater.snapshot()).toMatchObject({
      phase: "ready",
      blockedBy: null,
    });
    await updater.close();
  });

  it.each([
    { ok: false, code: "UPDATE_HANDOFF_UNKNOWN", recoveryRequired: true },
    { ok: false, code: "UPDATE_JOURNAL_UNRECONCILED", recoveryRequired: true },
    { ok: true, update: null, recoveryVersion: staged.manifest.version },
  ] satisfies Awaited<ReturnType<InstalledUpdaterPorts["recover"]>>[])(
    "preserves startup recovery fences, never calling restore implicitly: %j",
    async (recovery) => {
      const f = fixture();
      f.ports.recover.mockResolvedValue(recovery);
      await f.updater.initialize();
      const previous = f.updater.snapshot();
      expect(await f.updater.applyOnNormalQuit(request)).toEqual(
        !recovery.ok
          ? {
              status: recovery.code.includes("UNKNOWN") ? "unknown" : "blocked",
              code: recovery.code,
            }
          : { status: "blocked", code: "UPDATE_RECOVERY_REQUIRED" },
      );
      expect(f.updater.snapshot()).toEqual(previous);
      expect(f.ports.applyOnQuit).not.toHaveBeenCalled();
      expect(f.ports.restore).not.toHaveBeenCalled();
    },
  );

  it("publishes one attempt before even a synchronous host re-entry", async () => {
    const f = fixture();
    await f.updater.initialize();
    let reentrant: Promise<NormalQuitUpdateReceipt> | undefined;
    f.ports.applyOnQuit.mockImplementation(() => {
      reentrant = f.updater.applyOnNormalQuit({
        ...request,
        deadlineAt: 9_000,
      });
      return Promise.resolve({ status: "accepted" });
    });
    const first = f.updater.applyOnNormalQuit(request);
    expect(reentrant).toBe(first);
    expect(await first).toEqual({ status: "accepted", relaunch: false });
    expect(f.ports.applyOnQuit).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    { kind: "restart", deadlineAt: 2_000 },
    { ...request, relaunch: true },
  ])("rejects host request shape violations: %j", async (value) => {
    const f = fixture();
    await f.updater.initialize();
    expect(
      await f.updater.applyOnNormalQuit(value as NormalQuitUpdateRequest),
    ).toEqual({ status: "blocked", code: "UPDATE_QUIT_REQUEST_INVALID" });
    expect(f.updater.normalQuitUpdateState()).toEqual({ status: "idle" });
  });

  it("drains a download already dispatched and retains its original bytes without applying them", async () => {
    const f = fixture();
    f.ports.recover.mockResolvedValue({ ok: true, update: null });
    const started = pending<void>();
    const downloaded =
      pending<Awaited<ReturnType<InstalledUpdaterPorts["download"]>>>();
    f.ports.download.mockImplementation(() => {
      started.resolve();
      return downloaded.promise;
    });
    await f.updater.initialize();
    await f.updater.check(true);
    const downloading = f.updater.download();
    await started.promise;
    expect(await f.updater.applyOnNormalQuit(request)).toEqual({
      status: "skipped",
      code: "UPDATE_QUIT_OWNER_UNAVAILABLE",
    });
    const closing = f.updater.close();
    downloaded.resolve({ ok: true, update: staged });
    await Promise.all([downloading, closing]);
    expect(f.ports.retain).toHaveBeenCalledExactlyOnceWith(staged);
    expect(f.ports.applyOnQuit).not.toHaveBeenCalled();
    expect(f.ports.cancelPending).toHaveBeenCalledTimes(1);
  });

  it("explicit Later allows the separately opted-in retained candidate to wait for ordinary Quit", async () => {
    const f = fixture();
    f.ports.recover.mockResolvedValue({ ok: true, update: null });
    await f.updater.initialize();
    await f.updater.check(true);
    await f.updater.download();
    await f.updater.later();
    expect(f.updater.snapshot()).toMatchObject({
      phase: "ready",
      deferred: true,
    });
    expect(await f.updater.applyOnNormalQuit(request)).toEqual({
      status: "accepted",
      relaunch: false,
    });
    expect(f.ports.download).toHaveBeenCalledTimes(1);
    expect(f.ports.retain).toHaveBeenCalledTimes(1);
  });

  it("preserves a prior ready admission refusal and declines to clear it automatically", async () => {
    const f = fixture();
    f.ports.restart.mockResolvedValue({
      status: "blocked",
      code: "UPDATE_TASK_ROUTE_NEEDS_DRAIN",
    });
    await f.updater.initialize();
    await f.updater.restart();
    expect(await f.updater.applyOnNormalQuit(request)).toEqual({
      status: "blocked",
      code: "UPDATE_TASK_ROUTE_NEEDS_DRAIN",
    });
    await f.updater.check(true);
    expect(f.updater.snapshot()).toMatchObject({
      phase: "ready",
      blockedBy: "UPDATE_TASK_ROUTE_NEEDS_DRAIN",
    });
    expect(f.ports.applyOnQuit).not.toHaveBeenCalled();
  });
  it("hands the existing retained candidate to the original engine without relaunch or recursive Quit", async () => {
    const f = fixture();
    await f.updater.initialize();
    expect(f.updater.snapshot()).toMatchObject({
      phase: "ready",
      deferred: true,
      automaticUpdatePreference: { enabled: false },
      installOnQuitPreference: consent,
    });
    f.ports.publish.mockClear();
    expect(await f.updater.applyOnNormalQuit(request)).toEqual({
      status: "accepted",
      relaunch: false,
    });
    expect(f.ports.applyOnQuit).toHaveBeenCalledExactlyOnceWith(staged, {
      ...request,
      relaunch: false,
      requestQuit: false,
    });
    expect(f.ports.restart).not.toHaveBeenCalled();
    expect(f.ports.restore).not.toHaveBeenCalled();
    expect(f.ports.discover).not.toHaveBeenCalled();
    expect(f.ports.download).not.toHaveBeenCalled();
    expect(f.ports.retain).not.toHaveBeenCalled();
    expect(f.ports.publish).not.toHaveBeenCalled();
    expect(f.ports.cancelPending).not.toHaveBeenCalled();
    expect(
      NormalQuitUpdateStateSchema.parse(f.updater.normalQuitUpdateState()),
    ).toEqual({
      status: "settled",
      deadlineAt: request.deadlineAt,
      receipt: { status: "accepted", relaunch: false },
    });
    expect(
      InstalledUpdateViewSchema.safeParse(f.updater.snapshot()).success,
    ).toBe(true);
  });

  it("never converts confirmed legacy auto-download consent into install consent", async () => {
    const f = fixture({ ...consent, enabled: false });
    const { readInstallOnQuitPreference: omitted, ...legacyPorts } = f.ports;
    expect(omitted).toBeDefined();
    legacyPorts.readAutomaticUpdatePreference.mockResolvedValue({
      status: "confirmed",
      enabled: true,
    });
    const legacy = new InstalledUpdater(legacyPorts);
    await legacy.initialize();
    expect(legacy.snapshot()).not.toHaveProperty("installOnQuitPreference");
    expect(await legacy.applyOnNormalQuit(request)).toEqual({
      status: "skipped",
      code: "UPDATE_QUIT_NOT_OPTED_IN",
    });
    expect(f.ports.applyOnQuit).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...consent, enabled: false }, "skipped", "UPDATE_QUIT_NOT_OPTED_IN"],
    [
      { status: "confirmed", enabled: true },
      "blocked",
      "UPDATE_QUIT_PREFERENCE_INVALID",
    ],
    [
      {
        status: "blocked",
        enabled: false,
        code: "UPDATE_QUIT_PREFERENCE_UNREADABLE",
      },
      "blocked",
      "UPDATE_QUIT_PREFERENCE_UNREADABLE",
    ],
    [
      {
        status: "unknown",
        enabled: false,
        code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
      },
      "unknown",
      "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
    ],
  ])(
    "fences disabled/invalid/blocked/unknown consent: %j",
    async (choice, status, code) => {
      const f = fixture(choice);
      await f.updater.initialize();
      expect(await f.updater.applyOnNormalQuit(request)).toEqual({
        status,
        code,
      });
      expect(f.ports.applyOnQuit).not.toHaveBeenCalled();
    },
  );

  it("classifies an unreadable consent port without changing the legacy preference", async () => {
    const f = fixture();
    f.ports.readInstallOnQuitPreference.mockRejectedValue(
      new Error("fixture read failed"),
    );
    await f.updater.initialize();
    expect(f.updater.installOnQuitPreference()).toEqual({
      status: "blocked",
      enabled: false,
      code: "UPDATE_QUIT_PREFERENCE_UNREADABLE",
    });
    expect(f.updater.automaticUpdatePreference()).toEqual({
      status: "confirmed",
      enabled: false,
    });
    expect(await f.updater.setInstallOnQuitPreference(true)).toEqual({
      status: "refused",
      code: "UPDATE_QUIT_PREFERENCE_UNREADABLE",
    });
    expect(f.ports.writeInstallOnQuitPreference).not.toHaveBeenCalled();
  });

  it("requires an explicit new durable ACK and leaves scheduled downloads independent", async () => {
    const f = fixture({ ...consent, enabled: false });
    await f.updater.initialize();
    expect(await f.updater.setInstallOnQuitPreference(true)).toEqual(consent);
    expect(
      f.ports.writeInstallOnQuitPreference,
    ).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.ports.writeAutomaticUpdatePreference).not.toHaveBeenCalled();
    expect(f.ports.applyOnQuit).not.toHaveBeenCalled();
    expect(await f.updater.applyOnNormalQuit(request)).toEqual({
      status: "accepted",
      relaunch: false,
    });

    const fresh = fixture();
    fresh.ports.recover.mockResolvedValue({ ok: true, update: null });
    await fresh.updater.initialize();
    await fresh.updater.scheduledCheck();
    expect(fresh.ports.discover).toHaveBeenCalledTimes(1);
    expect(fresh.ports.download).not.toHaveBeenCalled();
    expect(fresh.ports.applyOnQuit).not.toHaveBeenCalled();
  });

  it.each([
    { status: "confirmed", enabled: true },
    { ...consent, enabled: false },
    { ...consent, unexpected: "field" },
    { status: "refused", code: "unclassified" },
  ])(
    "fences a mismatched/unscoped durable write ACK without retry: %j",
    async (ack) => {
      const f = fixture({ ...consent, enabled: false });
      // Simulate unknown boundary data despite the host's declared port type.
      f.ports.writeInstallOnQuitPreference.mockResolvedValue(
        ack as InstallOnQuitPreferenceResult,
      );
      await f.updater.initialize();
      expect(await f.updater.setInstallOnQuitPreference(true)).toEqual({
        status: "unknown",
        code: "UPDATE_QUIT_PREFERENCE_ACK_MISMATCH",
      });
      expect(await f.updater.setInstallOnQuitPreference(false)).toEqual({
        status: "unknown",
        code: "UPDATE_QUIT_PREFERENCE_ACK_MISMATCH",
      });
      expect(await f.updater.applyOnNormalQuit(request)).toEqual({
        status: "unknown",
        code: "UPDATE_QUIT_PREFERENCE_ACK_MISMATCH",
      });
      expect(f.ports.writeInstallOnQuitPreference).toHaveBeenCalledTimes(1);
      expect(f.ports.applyOnQuit).not.toHaveBeenCalled();
    },
  );

  it.each(["refused", "unknown"] as const)(
    "retains the %s write outcome and fences another write",
    async (status) => {
      const f = fixture();
      f.ports.writeInstallOnQuitPreference.mockResolvedValue({
        status,
        code: "UPDATE_WRITE_UNCONFIRMED",
      });
      await f.updater.initialize();
      expect(await f.updater.setInstallOnQuitPreference(false)).toEqual({
        status,
        code: "UPDATE_WRITE_UNCONFIRMED",
      });
      expect(f.updater.installOnQuitPreference()).toEqual({
        status: status === "refused" ? "blocked" : "unknown",
        enabled: false,
        code: "UPDATE_WRITE_UNCONFIRMED",
      });
      await f.updater.setInstallOnQuitPreference(true);
      expect(f.ports.writeInstallOnQuitPreference).toHaveBeenCalledTimes(1);
    },
  );

  it("a thrown write is unknown; a destroyed projection cannot revoke a confirmed OFF ACK", async () => {
    const f = fixture();
    await f.updater.initialize();
    f.ports.writeInstallOnQuitPreference.mockRejectedValue(
      new Error("ACK lost"),
    );
    expect(await f.updater.setInstallOnQuitPreference(false)).toEqual({
      status: "unknown",
      code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
    });
    const off = fixture();
    await off.updater.initialize();
    off.ports.publish.mockImplementation(() => {
      throw new Error("projection unavailable");
    });
    expect(await off.updater.setInstallOnQuitPreference(false)).toEqual({
      ...consent,
      enabled: false,
    });
    expect(await off.updater.applyOnNormalQuit(request)).toEqual({
      status: "skipped",
      code: "UPDATE_QUIT_NOT_OPTED_IN",
    });
  });

  it("never waits for unsettled consent to authorize the current Quit; close still drains it", async () => {
    const f = fixture({ ...consent, enabled: false });
    const write = pending<InstallOnQuitPreferenceResult>();
    f.ports.writeInstallOnQuitPreference.mockReturnValue(write.promise);
    await f.updater.initialize();
    const writing = f.updater.setInstallOnQuitPreference(true);
    expect(await f.updater.setAutomaticUpdatePreference(true)).toMatchObject({
      status: "refused",
    });
    expect(await f.updater.applyOnNormalQuit(request)).toEqual({
      status: "skipped",
      code: "UPDATE_QUIT_OWNER_UNAVAILABLE",
    });
    let closed = false;
    const closing = f.updater.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    write.resolve(consent);
    await Promise.all([writing, closing]);
    expect(
      await f.updater.applyOnNormalQuit({ ...request, deadlineAt: 9_000 }),
    ).toEqual({ status: "skipped", code: "UPDATE_QUIT_OWNER_UNAVAILABLE" });
    expect(f.ports.applyOnQuit).not.toHaveBeenCalled();
  });

  it("requires readiness and adapter support; never downloads to satisfy Quit", async () => {
    const f = fixture();
    f.ports.recover.mockResolvedValue({ ok: true, update: null });
    await f.updater.initialize();
    await f.updater.check(true);
    expect(await f.updater.applyOnNormalQuit(request)).toEqual({
      status: "skipped",
      code: "UPDATE_PACKAGE_NOT_READY",
    });
    expect(f.ports.download).not.toHaveBeenCalled();
    const missing = fixture();
    const { applyOnQuit: omitted, ...ports } = missing.ports;
    expect(omitted).toBeDefined();
    const updater = new InstalledUpdater(ports);
    await updater.initialize();
    expect(await updater.applyOnNormalQuit(request)).toEqual({
      status: "blocked",
      code: "UPDATE_QUIT_APPLY_UNSUPPORTED",
    });
  });

  it("does not drain or interrupt another active release operation to gain readiness", async () => {
    const f = fixture();
    const recovery =
      pending<Awaited<ReturnType<InstalledUpdaterPorts["recover"]>>>();
    f.ports.recover.mockReturnValue(recovery.promise);
    const initializing = f.updater.initialize();
    expect(await f.updater.applyOnNormalQuit(request)).toEqual({
      status: "skipped",
      code: "UPDATE_QUIT_OWNER_UNAVAILABLE",
    });
    expect(f.ports.cancelPending).not.toHaveBeenCalled();
    expect(f.ports.applyOnQuit).not.toHaveBeenCalled();
    recovery.resolve({ ok: true, update: staged });
    await initializing;
  });

  it.each([2_000, 2_001, Infinity, NaN])(
    "does not dispatch at/after the deadline or with an invalid clock: %s",
    async (now) => {
      const f = fixture();
      await f.updater.initialize();
      f.setNow(now);
      expect(await f.updater.applyOnNormalQuit(request)).toEqual({
        status: "skipped",
        code: "UPDATE_QUIT_DEADLINE_EXPIRED",
      });
      expect(f.ports.applyOnQuit).not.toHaveBeenCalled();
      expect(f.updater.snapshot()).toMatchObject({ phase: "ready" });
    },
  );

  it.each([-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid host deadline before claiming Quit: %s",
    async (deadlineAt) => {
      const f = fixture();
      await f.updater.initialize();
      expect(
        await f.updater.applyOnNormalQuit({ ...request, deadlineAt }),
      ).toEqual({ status: "blocked", code: "UPDATE_QUIT_REQUEST_INVALID" });
      expect(f.updater.normalQuitUpdateState()).toEqual({ status: "idle" });
      expect(f.ports.applyOnQuit).not.toHaveBeenCalled();
    },
  );

  it("keeps one attempt/deadline across repeated events, rejects other effects, and drains the same pending handoff", async () => {
    const f = fixture();
    const handoff = pending<UpdateHandoff>();
    f.ports.applyOnQuit.mockReturnValue(handoff.promise);
    await f.updater.initialize();
    const mutable: { kind: "ordinary-quit"; deadlineAt: number } = {
      ...request,
    };
    const first = f.updater.applyOnNormalQuit(mutable);
    mutable.deadlineAt = 9_000;
    expect(f.updater.applyOnNormalQuit({ ...request, deadlineAt: 9_000 })).toBe(
      first,
    );
    expect(f.updater.normalQuitUpdateState()).toEqual({
      status: "pending",
      deadlineAt: 2_000,
    });
    await Promise.all([
      f.updater.restart(),
      f.updater.restore("rollback"),
      f.updater.check(true),
      f.updater.download(),
      f.updater.prepareLocal(),
      f.updater.later(),
      f.updater.skip(),
    ]);
    expect(await f.updater.setInstallOnQuitPreference(false)).toMatchObject({
      status: "refused",
    });
    expect(await f.updater.setAutomaticUpdatePreference(true)).toMatchObject({
      status: "refused",
    });
    let closed = false;
    const closing = f.updater.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    handoff.resolve({ status: "accepted" });
    await Promise.all([first, closing]);
    expect(f.ports.applyOnQuit).toHaveBeenCalledExactlyOnceWith(staged, {
      ...request,
      relaunch: false,
      requestQuit: false,
    });
    expect(f.ports.cancelPending).toHaveBeenCalledTimes(1);
    expect(f.ports.restart).not.toHaveBeenCalled();
    expect(f.ports.restore).not.toHaveBeenCalled();
    expect(f.ports.writeInstallOnQuitPreference).not.toHaveBeenCalled();
    expect(f.updater.applyOnNormalQuit(request)).toBe(first);
  });

  it.each([
    { status: "blocked", code: "UPDATE_WORK_PENDING" },
    { status: "blocked", code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED" },
    { status: "unknown", code: "UPDATE_HANDOFF_UNRECONCILED" },
    { status: "unknown", code: "UPDATE_STAGING_OUTCOME_UNKNOWN" },
  ] satisfies UpdateHandoff[])(
    "preserves the original engine outcome without another attempt: %j",
    async (outcome) => {
      const f = fixture();
      f.ports.applyOnQuit.mockResolvedValue(outcome);
      await f.updater.initialize();
      expect(await f.updater.applyOnNormalQuit(request)).toEqual(outcome);
      expect(
        await f.updater.applyOnNormalQuit({ ...request, deadlineAt: 9_000 }),
      ).toEqual(outcome);
      expect(f.ports.applyOnQuit).toHaveBeenCalledTimes(1);
      expect(f.updater.snapshot()).toMatchObject(
        outcome.status === "unknown"
          ? { phase: "failed", code: outcome.code, recoveryRequired: true }
          : { phase: "ready", blockedBy: outcome.code },
      );
      expect(
        InstalledUpdateViewSchema.safeParse(f.updater.snapshot()).success,
      ).toBe(true);
    },
  );

  it.each([
    { status: "accepted", relaunch: true },
    { status: "blocked", code: "bad-result" },
    { status: "skipped", code: "UPDATE_WORK_PENDING" },
    null,
  ])("treats malformed engine acknowledgment as unknown: %j", async (ack) => {
    const f = fixture();
    f.ports.applyOnQuit.mockResolvedValue(ack as UpdateHandoff);
    await f.updater.initialize();
    expect(await f.updater.applyOnNormalQuit(request)).toEqual({
      status: "unknown",
      code: "UPDATE_HANDOFF_UNKNOWN",
    });
    expect(f.updater.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    await f.updater.restart();
    expect(f.ports.restart).not.toHaveBeenCalled();
  });

  it("an engine throw may have dispatched; close preserves its unknown result and no replacement", async () => {
    const f = fixture();
    f.ports.applyOnQuit.mockRejectedValue(new Error("lost readiness ACK"));
    await f.updater.initialize();
    expect(await f.updater.applyOnNormalQuit(request)).toEqual({
      status: "unknown",
      code: "UPDATE_HANDOFF_UNKNOWN",
    });
    await f.updater.close();
    expect(await f.updater.applyOnNormalQuit(request)).toEqual({
      status: "unknown",
      code: "UPDATE_HANDOFF_UNKNOWN",
    });
    expect(f.ports.applyOnQuit).toHaveBeenCalledTimes(1);
    expect(f.updater.snapshot()).toMatchObject({
      phase: "failed",
      code: "UPDATE_HANDOFF_UNKNOWN",
      recoveryRequired: true,
    });
  });

  it("preserves manual Restart behavior and declines a hook called after close", async () => {
    const f = fixture({ ...consent, enabled: false });
    await f.updater.initialize();
    await f.updater.restart();
    expect(f.ports.restart).toHaveBeenCalledExactlyOnceWith(staged);
    expect(f.ports.applyOnQuit).not.toHaveBeenCalled();
    const closed = fixture();
    await closed.updater.initialize();
    await closed.updater.close();
    expect(await closed.updater.applyOnNormalQuit(request)).toEqual({
      status: "skipped",
      code: "UPDATE_QUIT_OWNER_UNAVAILABLE",
    });
    expect(closed.ports.applyOnQuit).not.toHaveBeenCalled();
  });
});
