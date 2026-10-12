import { describe, expect, it, vi } from "vitest";
import {
  AutomaticUpdatePreferenceResultSchema,
  InstalledUpdateCommandSchema,
  InstalledUpdateViewSchema,
} from "../../src/modules/release/contract/installed-update";
import { drainOwnedChildren } from "../../src/apps/desktop/quit-drain";
import {
  InstalledUpdater,
  UPDATE_RECHECK_MS,
  type InstalledUpdaterPorts,
  type ReadyUpdate,
} from "../../src/modules/release/app/installed-updater";

const staged: ReadyUpdate = {
  handle: "owned-stage",
  manifest: {
    schema: "farol.github-release/1",
    repository: "legrch/farol",
    channel: "owner-beta",
    product: "Farol Next Preview",
    bundleId: "local.farol.next.preview",
    version: "0.1.0-owner.beta.2",
    buildVersion: "3",
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: "b".repeat(64),
    buildId: "c".repeat(64),
    artifactSha256: "d".repeat(64),
    archiveSha256: "e".repeat(64),
    archiveName: "Farol-0.1.0-owner.beta.2-darwin-arm64.zip",
    archiveSize: 1,
    platform: "darwin",
    arch: "arm64",
    signing: "unsigned",
    notarized: false,
    sourceDirty: false,
  },
};

function fixture() {
  let now = 1_000;
  const ports = {
    now: () => now,
    cancelPending: vi.fn(),
    recover: vi
      .fn<InstalledUpdaterPorts["recover"]>()
      .mockResolvedValue({ ok: true, update: null }),
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
    skip: vi
      .fn<InstalledUpdaterPorts["skip"]>()
      .mockResolvedValue({ ok: true }),
    defer: vi
      .fn<InstalledUpdaterPorts["defer"]>()
      .mockResolvedValue({ ok: true }),
    retain: vi.fn<InstalledUpdaterPorts["retain"]>().mockResolvedValue(),
    restart: vi
      .fn<InstalledUpdaterPorts["restart"]>()
      .mockResolvedValue({ status: "accepted" }),
    restore: vi.fn().mockResolvedValue({ status: "accepted" }),
    publish: vi.fn<InstalledUpdaterPorts["publish"]>(),
  } satisfies InstalledUpdaterPorts;
  return {
    ports,
    updater: new InstalledUpdater(ports),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("installed update orchestration (port fixture, no native or GitHub acceptance)", () => {
  it("bounds and throttles original transfer observations without making a package ready", async () => {
    const f = fixture();
    let report!: NonNullable<Parameters<InstalledUpdaterPorts["download"]>[0]>;
    let finish!: (
      value: Awaited<ReturnType<InstalledUpdaterPorts["download"]>>,
    ) => void;
    f.ports.download.mockImplementation((observer) => {
      report = observer!;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    await f.updater.initialize();
    await f.updater.check(true);
    const work = f.updater.download();
    await vi.waitFor(() => expect(report).toBeTypeOf("function"));
    const emit = (receivedBytes: number, totalBytes = 100) =>
      report({ stage: "transferring", receivedBytes, totalBytes });
    emit(10);
    expect(f.updater.snapshot()).toMatchObject({
      phase: "downloading",
      progress: { receivedBytes: 10, totalBytes: 100 },
    });
    const publications = f.ports.publish.mock.calls.length;
    emit(20);
    expect(f.ports.publish).toHaveBeenCalledTimes(publications);
    f.advance(250);
    for (const bytes of [-1, NaN, Infinity, 1.5, 101, 9]) emit(bytes);
    emit(30, 200);
    expect(f.ports.publish).toHaveBeenCalledTimes(publications);
    emit(30);
    expect(f.updater.snapshot()).toMatchObject({
      progress: { receivedBytes: 30 },
    });
    emit(100);
    expect(f.updater.snapshot()).toMatchObject({
      phase: "downloading",
      progress: { receivedBytes: 100 },
    });
    expect(f.ports.retain).not.toHaveBeenCalled();
    report({ stage: "verifying" });
    emit(100);
    expect(f.updater.snapshot()).toMatchObject({
      phase: "downloading",
      progress: { stage: "verifying" },
    });
    finish({ ok: true, update: staged });
    await work;
    report({ stage: "verifying" });
    emit(100);
    expect(f.updater.snapshot()).toMatchObject({ phase: "ready" });
    expect(f.ports.download).toHaveBeenCalledTimes(1);
  });

  it("ignores progress after Quit and isolates observation failures from the transfer", async () => {
    const f = fixture();
    let report!: NonNullable<Parameters<InstalledUpdaterPorts["download"]>[0]>;
    let finish!: (
      value: Awaited<ReturnType<InstalledUpdaterPorts["download"]>>,
    ) => void;
    f.ports.download.mockImplementation((observer) => {
      report = observer!;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    await f.updater.initialize();
    await f.updater.check(true);
    const work = f.updater.download();
    await vi.waitFor(() => expect(report).toBeTypeOf("function"));
    f.ports.publish.mockImplementationOnce(() => {
      throw new Error("window closed");
    });
    expect(() =>
      report({ stage: "transferring", receivedBytes: 1, totalBytes: 10 }),
    ).not.toThrow();
    const before = f.updater.snapshot();
    const close = f.updater.close();
    report({ stage: "verifying" });
    expect(f.updater.snapshot()).toEqual(before);
    finish({ ok: false, code: "UPDATE_INTERRUPTED" });
    await Promise.all([work, close]);
    const settled = f.updater.snapshot();
    report({ stage: "verifying" });
    expect(f.updater.snapshot()).toEqual(settled);
    expect(f.ports.restart).not.toHaveBeenCalled();
  });

  it("validates byte progress on the IPC boundary", () => {
    const view = (progress: unknown) =>
      InstalledUpdateViewSchema.safeParse({ phase: "downloading", progress })
        .success;
    expect(
      view({ stage: "transferring", receivedBytes: 50, totalBytes: 100 }),
    ).toBe(true);
    expect(view({ stage: "verifying" })).toBe(true);
    for (const progress of [
      { stage: "transferring", receivedBytes: 101, totalBytes: 100 },
      { stage: "transferring", receivedBytes: 0, totalBytes: 0 },
      { stage: "transferring", receivedBytes: -1, totalBytes: 100 },
      { stage: "transferring", receivedBytes: 1.5, totalBytes: 100 },
      { stage: "transferring", receivedBytes: 1, totalBytes: 2_147_483_649 },
      { stage: "verifying", receivedBytes: 100 },
    ])
      expect(view(progress)).toBe(false);
  });

  it("does not dispatch release effects after Quit closes a pending status publication", async () => {
    const check = fixture();
    await check.updater.initialize();
    const checking = check.updater.check(true);
    const checkClose = check.updater.close();
    await Promise.all([checking, checkClose]);
    expect(check.ports.discover).not.toHaveBeenCalled();

    const download = fixture();
    await download.updater.initialize();
    await download.updater.check(true);
    const downloading = download.updater.download();
    const downloadClose = download.updater.close();
    await Promise.all([downloading, downloadClose]);
    expect(download.ports.download).not.toHaveBeenCalled();

    const local = fixture();
    const prepareLocal = vi
      .fn<NonNullable<InstalledUpdaterPorts["prepareLocal"]>>()
      .mockResolvedValue({ ok: true, update: staged });
    const localUpdater = new InstalledUpdater({
      ...local.ports,
      prepareLocal,
    });
    await localUpdater.initialize();
    const preparing = localUpdater.prepareLocal();
    const localClose = localUpdater.close();
    await Promise.all([preparing, localClose]);
    expect(prepareLocal).not.toHaveBeenCalled();

    const restart = fixture();
    await restart.updater.initialize();
    await restart.updater.check(true);
    await restart.updater.download();
    const restarting = restart.updater.restart();
    const restartClose = restart.updater.close();
    await Promise.all([restarting, restartClose]);
    expect(restart.ports.restart).not.toHaveBeenCalled();

    const restore = fixture();
    restore.ports.recover.mockResolvedValue({
      ok: true,
      update: null,
      rollbackVersion: "0.1.0-owner.beta.1",
    });
    await restore.updater.initialize();
    const restoring = restore.updater.restore("rollback");
    const restoreClose = restore.updater.close();
    await Promise.all([restoring, restoreClose]);
    expect(restore.ports.restore).not.toHaveBeenCalled();
  });

  it("drains a failed status publication without inventing a staging or helper outcome", async () => {
    const checking = fixture();
    await checking.updater.initialize();
    checking.ports.publish.mockImplementationOnce(() => {
      throw new Error("window was destroyed before status delivery");
    });
    await checking.updater.check(true);
    await checking.updater.close();
    expect(checking.ports.discover).not.toHaveBeenCalled();

    const downloading = fixture();
    await downloading.updater.initialize();
    await downloading.updater.check(true);
    downloading.ports.publish.mockImplementationOnce(() => {
      throw new Error("window was destroyed before status delivery");
    });
    await downloading.updater.download();
    await downloading.updater.close();
    expect(downloading.ports.download).not.toHaveBeenCalled();
    expect(downloading.updater.snapshot()).toMatchObject({
      phase: "available",
      version: staged.manifest.version,
    });

    const restarting = fixture();
    await restarting.updater.initialize();
    await restarting.updater.check(true);
    await restarting.updater.download();
    restarting.ports.publish.mockImplementationOnce(() => {
      throw new Error("window was destroyed before status delivery");
    });
    await restarting.updater.restart();
    await restarting.updater.close();
    expect(restarting.ports.restart).not.toHaveBeenCalled();
    expect(restarting.updater.snapshot()).toMatchObject({
      phase: "ready",
      version: staged.manifest.version,
    });
  });

  it.each(["ready", "recovery", "rollback"] as const)(
    "preserves reconciled %s truth when the restored renderer publication throws",
    async (restoredState) => {
      const { updater, ports } = fixture();
      const recovered =
        restoredState === "ready"
          ? { ok: true as const, update: staged }
          : restoredState === "recovery"
            ? {
                ok: true as const,
                update: null,
                recoveryVersion: staged.manifest.version,
              }
            : {
                ok: true as const,
                update: null,
                rollbackVersion: "0.1.0-owner.beta.1",
              };
      ports.recover.mockResolvedValue(recovered);
      ports.publish.mockImplementationOnce(() => {
        throw new Error("renderer destroyed after recovery completed");
      });

      await updater.initialize();
      expect(updater.snapshot()).toMatchObject(
        restoredState === "ready"
          ? {
              phase: "ready",
              version: staged.manifest.version,
              deferred: true,
              blockedBy: null,
            }
          : restoredState === "recovery"
            ? {
                phase: "recovery",
                version: staged.manifest.version,
                blockedBy: null,
              }
            : {
                phase: "idle",
                rollbackVersion: "0.1.0-owner.beta.1",
              },
      );
      expect(ports.recover).toHaveBeenCalledTimes(1);
      expect(ports.retain).not.toHaveBeenCalled();
      expect(ports.restart).not.toHaveBeenCalled();
      expect(ports.restore).not.toHaveBeenCalled();
      await updater.close();
    },
  );

  it("settles loaded preferences when their final initialization publication throws", async () => {
    const { ports } = fixture();
    const updater = new InstalledUpdater({
      ...ports,
      readAutomaticUpdatePreference: async () => ({
        status: "confirmed",
        enabled: false,
      }),
    });
    ports.publish.mockImplementation(() => {
      throw new Error("renderer destroyed before loaded preferences arrived");
    });

    await expect(updater.initialize()).resolves.toBeUndefined();
    expect(updater.snapshot()).toMatchObject({
      phase: "idle",
      automaticUpdatePreference: { status: "confirmed", enabled: false },
    });
    await updater.initialize();
    await updater.close();
    expect(ports.recover).toHaveBeenCalledTimes(1);
    expect(ports.cancelPending).toHaveBeenCalledTimes(1);
  });

  it.each(["UPDATE_STATE_UNREADABLE", "UPDATE_HANDOFF_UNRECONCILED"])(
    "retains the original %s recovery failure when its renderer publication throws",
    async (code) => {
      const { updater, ports } = fixture();
      ports.recover.mockResolvedValue({
        ok: false,
        code,
        recoveryRequired: true,
      });
      ports.publish.mockImplementation(() => {
        throw new Error("renderer destroyed after recovery failure");
      });

      await expect(updater.initialize()).resolves.toBeUndefined();
      expect(updater.snapshot()).toEqual({
        phase: "failed",
        code,
        recoveryRequired: true,
      });
      await updater.initialize();
      await updater.check(true);
      await updater.download();
      await updater.restart();
      await updater.close();
      expect(ports.recover).toHaveBeenCalledTimes(1);
      expect(ports.discover).not.toHaveBeenCalled();
      expect(ports.download).not.toHaveBeenCalled();
      expect(ports.restart).not.toHaveBeenCalled();
    },
  );

  it("discovers without staging and downloads the same candidate only on explicit command", async () => {
    const { updater, ports } = fixture();
    await updater.initialize();
    await updater.check();
    expect(updater.snapshot()).toEqual({
      phase: "available",
      version: staged.manifest.version,
      deferred: false,
    });
    expect(ports.download).not.toHaveBeenCalled();
    expect(ports.retain).not.toHaveBeenCalled();
    await updater.restart();
    expect(ports.restart).not.toHaveBeenCalled();
    await updater.later();
    expect(updater.snapshot()).toMatchObject({
      phase: "available",
      deferred: true,
    });
    await updater.download();
    await updater.download();
    expect(ports.download).toHaveBeenCalledTimes(1);
    expect(ports.retain).toHaveBeenCalledExactlyOnceWith(staged);
    expect(updater.snapshot()).toMatchObject({ phase: "ready" });
  });

  it("fences a changed discovered build and an uncertain staging outcome", async () => {
    const changed = fixture();
    await changed.updater.initialize();
    await changed.updater.check(true);
    changed.ports.download.mockResolvedValueOnce({
      ok: true,
      update: {
        ...staged,
        manifest: { ...staged.manifest, buildId: "f".repeat(64) },
      },
    });
    await changed.updater.download();
    expect(changed.updater.snapshot()).toEqual({
      phase: "failed",
      code: "UPDATE_CANDIDATE_CHANGED",
      recoveryRequired: true,
    });
    expect(changed.ports.retain).not.toHaveBeenCalled();
    await changed.updater.download();
    expect(changed.ports.download).toHaveBeenCalledTimes(1);

    const uncertain = fixture();
    await uncertain.updater.initialize();
    await uncertain.updater.check(true);
    uncertain.ports.download.mockRejectedValueOnce(
      new Error("private transport"),
    );
    await uncertain.updater.download();
    await uncertain.updater.check(true);
    await uncertain.updater.download();
    expect(uncertain.updater.snapshot()).toEqual({
      phase: "failed",
      code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
      recoveryRequired: true,
    });
    expect(uncertain.ports.download).toHaveBeenCalledTimes(1);
  });

  it("skips the exact available build once without downloading or mistaking Later for Skip", async () => {
    const { updater, ports } = fixture();
    await updater.initialize();
    await updater.check();
    await updater.later();
    expect(ports.skip).not.toHaveBeenCalled();
    await updater.skip();
    await updater.skip();
    expect(ports.skip).toHaveBeenCalledExactlyOnceWith(staged.manifest.buildId);
    expect(ports.download).not.toHaveBeenCalled();
    expect(updater.snapshot()).toMatchObject({ phase: "idle" });
  });

  it("keeps uncertain Skip fenced instead of retrying its possibly persisted effect", async () => {
    const { updater, ports } = fixture();
    ports.skip.mockRejectedValueOnce(
      new Error("lost preference acknowledgment"),
    );
    await updater.initialize();
    await updater.check();
    await updater.skip();
    await updater.skip();
    await updater.check(true);
    expect(updater.snapshot()).toEqual({
      phase: "failed",
      code: "UPDATE_SKIP_OUTCOME_UNKNOWN",
      recoveryRequired: true,
    });
    expect(ports.skip).toHaveBeenCalledTimes(1);
    expect(ports.discover).toHaveBeenCalledTimes(1);
  });

  it("defers an available candidate through its port without skipping or downloading it", async () => {
    const { updater, ports } = fixture();
    await updater.initialize();
    await updater.check();
    await updater.later();
    await updater.later();
    expect(ports.defer).toHaveBeenCalledExactlyOnceWith(
      staged.manifest.buildId,
    );
    expect(ports.skip).not.toHaveBeenCalled();
    expect(ports.download).not.toHaveBeenCalled();
    expect(updater.snapshot()).toMatchObject({
      phase: "available",
      deferred: true,
    });
    ports.discover.mockResolvedValueOnce({
      ok: true,
      available: true,
      version: staged.manifest.version,
      buildId: staged.manifest.buildId,
      deferred: true,
    });
    await updater.check(true);
    expect(updater.snapshot()).toMatchObject({
      phase: "available",
      deferred: true,
    });
  });

  it("fences a lost Later acknowledgment and does not repeat the preference write", async () => {
    const { updater, ports } = fixture();
    ports.defer.mockRejectedValueOnce(
      new Error("lost preference acknowledgment"),
    );
    await updater.initialize();
    await updater.check();
    await updater.later();
    await updater.later();
    await updater.check(true);
    expect(updater.snapshot()).toEqual({
      phase: "failed",
      code: "UPDATE_LATER_OUTCOME_UNKNOWN",
      recoveryRequired: true,
    });
    expect(ports.defer).toHaveBeenCalledTimes(1);
    expect(ports.discover).toHaveBeenCalledTimes(1);
  });

  it("keeps an exactly recovered old-feed archive Ready without rediscovery or download", async () => {
    const { updater, ports } = fixture();
    const historical: ReadyUpdate = {
      ...staged,
      manifest: { ...staged.manifest, repository: "legrch/farol-releases" },
    };
    ports.recover.mockResolvedValueOnce({ ok: true, update: historical });
    await updater.initialize();
    await updater.check(true);
    await updater.later();
    expect(updater.snapshot()).toMatchObject({
      phase: "ready",
      version: historical.manifest.version,
      deferred: true,
    });
    expect(ports.discover).not.toHaveBeenCalled();
    expect(ports.download).not.toHaveBeenCalled();
    expect(ports.retain).not.toHaveBeenCalled();
    expect(ports.restart).not.toHaveBeenCalled();
    await updater.restart();
    expect(ports.restart).toHaveBeenCalledExactlyOnceWith(historical);
    await updater.close();
  });

  it("keeps refused retained context fenced without querying another feed", async () => {
    const { updater, ports } = fixture();
    ports.recover.mockResolvedValueOnce({
      ok: false,
      code: "UPDATE_RETAINED_MANIFEST_INVALID",
      recoveryRequired: true,
    });
    await updater.initialize();
    await updater.check(true);
    await updater.restart();
    expect(updater.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
      code: "UPDATE_RETAINED_MANIFEST_INVALID",
    });
    expect(ports.discover).not.toHaveBeenCalled();
    expect(ports.download).not.toHaveBeenCalled();
    expect(ports.restart).not.toHaveBeenCalled();
    await updater.close();
  });

  it("drains and durably retains a completed download after Quit without publishing or restarting", async () => {
    const { updater, ports } = fixture();
    let finish!: (
      value: Awaited<ReturnType<InstalledUpdaterPorts["download"]>>,
    ) => void;
    let saved!: () => void;
    ports.download.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    ports.retain.mockImplementation(
      () =>
        new Promise((resolve) => {
          saved = resolve;
        }),
    );
    await updater.initialize();
    await updater.check();
    const checking = updater.download();
    await Promise.resolve();
    ports.publish.mockClear();
    let drained = false;
    const closing = Promise.resolve(updater.close()).then(() => {
      drained = true;
    });
    await Promise.resolve();
    const drainedBeforeDownload = drained;
    finish({ ok: true, update: staged });
    await Promise.resolve();
    const drainedBeforeRetain = drained;
    saved?.();
    await Promise.all([checking, closing]);
    expect(drainedBeforeDownload).toBe(false);
    expect(drainedBeforeRetain).toBe(false);
    expect(ports.cancelPending).toHaveBeenCalledTimes(1);
    expect(ports.retain).toHaveBeenCalledExactlyOnceWith(staged);
    expect(ports.publish).not.toHaveBeenCalled();
    expect(ports.restart).not.toHaveBeenCalled();
    await updater.check(true);
    expect(ports.download).toHaveBeenCalledTimes(1);
  });

  it("keeps an uncertain close-time retain failure fenced instead of retrying", async () => {
    const { updater, ports } = fixture();
    let finish!: (
      value: Awaited<ReturnType<InstalledUpdaterPorts["download"]>>,
    ) => void;
    ports.download.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    ports.retain.mockRejectedValue(
      new Error("fixture persistence uncertainty"),
    );
    await updater.initialize();
    await updater.check();
    const checking = updater.download();
    await Promise.resolve();
    const closing = updater.close();
    finish({ ok: true, update: staged });
    await Promise.all([checking, closing]);
    expect(updater.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    await updater.check(true);
    expect(ports.download).toHaveBeenCalledTimes(1);
  });

  it("records an unconfirmed updater when cancellation cannot drain by the existing quit deadline", async () => {
    const { updater, ports } = fixture();
    let finish!: (
      value: Awaited<ReturnType<InstalledUpdaterPorts["download"]>>,
    ) => void;
    ports.download.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await updater.initialize();
    await updater.check();
    const checking = updater.download();
    await Promise.resolve();
    const receipt = await drainOwnedChildren(
      [{ name: "installed-updater", close: () => updater.close() }],
      10,
    );
    finish({
      ok: false,
      code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
      recoveryRequired: true,
    });
    await checking;
    await updater.close();
    expect(receipt).toEqual({
      drained: false,
      unconfirmed: ["installed-updater"],
    });
    expect(updater.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    expect(ports.cancelPending).toHaveBeenCalledTimes(1);
    expect(ports.retain).not.toHaveBeenCalled();
  });

  it("offers explicit recovery after boot without replaying download or apply", async () => {
    const { updater, ports } = fixture();
    ports.recover.mockResolvedValue({
      ok: true,
      update: null,
      recoveryVersion: "0.1.1-owner.beta.1",
    });
    await updater.initialize();
    await updater.check(true);
    expect(updater.snapshot()).toMatchObject({
      phase: "recovery",
      version: "0.1.1-owner.beta.1",
    });
    expect(ports.restore).not.toHaveBeenCalled();
    expect(ports.discover).not.toHaveBeenCalled();
    await updater.restore("recover");
    await updater.restore("recover");
    expect(ports.restore).toHaveBeenCalledExactlyOnceWith("recover");
    expect(ports.restart).not.toHaveBeenCalled();
  });
  it("offers measured predecessor rollback and fences an unknown rollback outcome", async () => {
    const { updater, ports } = fixture();
    ports.recover.mockResolvedValue({
      ok: true,
      update: null,
      rollbackVersion: "0.1.0-owner.beta.1",
    });
    ports.restore.mockResolvedValue({
      status: "unknown",
      code: "UPDATE_HANDOFF_UNKNOWN",
    });
    await updater.initialize();
    expect(updater.snapshot()).toMatchObject({
      phase: "idle",
      rollbackVersion: "0.1.0-owner.beta.1",
    });
    await updater.restore("rollback");
    await updater.restore("rollback");
    await updater.check(true);
    expect(ports.restore).toHaveBeenCalledExactlyOnceWith("rollback");
    expect(updater.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
  });
  for (const outcome of ["accepted", "blocked", "unknown"] as const) {
    it(`keeps verified local rollback after a known offline check (${outcome})`, async () => {
      const { updater, ports } = fixture();
      ports.recover.mockResolvedValue({
        ok: true,
        update: null,
        rollbackVersion: "0.1.0-owner.beta.1",
      });
      ports.discover.mockResolvedValue({
        ok: false,
        code: "UPDATE_NETWORK_FAILURE",
      });
      ports.restore.mockResolvedValue({
        status: outcome,
        code: "UPDATE_WORK_PENDING",
      });
      await updater.initialize();
      await updater.check();
      expect(updater.snapshot()).toMatchObject({
        phase: "failed",
        recoveryRequired: false,
        code: "UPDATE_NETWORK_FAILURE",
        rollbackVersion: "0.1.0-owner.beta.1",
      });
      expect(ports.download).not.toHaveBeenCalled();
      await updater.restore("rollback");
      expect(ports.restore).toHaveBeenCalledExactlyOnceWith("rollback");
      if (outcome === "blocked") {
        expect(updater.snapshot()).toMatchObject({
          phase: "failed",
          recoveryRequired: false,
          code: "UPDATE_WORK_PENDING",
          rollbackVersion: "0.1.0-owner.beta.1",
        });
        ports.restore.mockResolvedValue({ status: "accepted" });
        await updater.restore("rollback");
        expect(ports.restore).toHaveBeenCalledTimes(2);
      } else {
        await updater.restore("rollback");
        await updater.check(true);
        expect(ports.restore).toHaveBeenCalledTimes(1);
        expect(ports.discover).toHaveBeenCalledTimes(1);
        if (outcome === "unknown")
          expect(updater.snapshot()).toEqual({
            phase: "failed",
            recoveryRequired: true,
            code: "UPDATE_WORK_PENDING",
          });
      }
    });
  }

  it("does not expose rollback after uncertain discovery or download", async () => {
    for (const failureStage of ["discover", "download"] as const) {
      const { updater, ports } = fixture();
      ports.recover.mockResolvedValue({
        ok: true,
        update: null,
        rollbackVersion: "0.1.0-owner.beta.1",
      });
      ports[failureStage].mockResolvedValue({
        ok: false,
        code: "UPDATE_OUTCOME_UNKNOWN",
        recoveryRequired: true,
      });
      await updater.initialize();
      await updater.check();
      if (failureStage === "download") await updater.download();
      await updater.restore("rollback");
      expect(ports.restore).not.toHaveBeenCalled();
      expect(updater.snapshot()).toEqual({
        phase: "failed",
        code: "UPDATE_OUTCOME_UNKNOWN",
        recoveryRequired: true,
      });
    }
  });

  it("downloads and persists once; Later keeps working and never restarts", async () => {
    const { updater, ports } = fixture();
    await updater.initialize();
    await updater.check();
    await updater.download();
    await updater.later();
    await updater.check(true);
    expect(updater.snapshot()).toEqual({
      phase: "ready",
      version: staged.manifest.version,
      deferred: true,
      blockedBy: null,
    });
    expect(ports.retain).toHaveBeenCalledWith(staged);
    expect(ports.download).toHaveBeenCalledTimes(1);
    expect(ports.restart).not.toHaveBeenCalled();
  });

  it("remains quiet without an update and uses a six-hour automatic interval", async () => {
    const { updater, ports, advance } = fixture();
    ports.discover.mockResolvedValue({ ok: true, available: false });
    await updater.initialize();
    await updater.check();
    await updater.check();
    expect(ports.download).not.toHaveBeenCalled();
    expect(ports.discover).toHaveBeenCalledTimes(1);
    expect(updater.snapshot()).toEqual({ phase: "idle", checkedAt: 1_000 });
    advance(UPDATE_RECHECK_MS);
    await updater.check();
    expect(ports.discover).toHaveBeenCalledTimes(2);
    await updater.check(true);
    expect(ports.discover).toHaveBeenCalledTimes(3);
  });

  it("serializes concurrent checks and does not restart during download", async () => {
    const { updater, ports } = fixture();
    let finish!: (
      value: Awaited<ReturnType<InstalledUpdaterPorts["download"]>>,
    ) => void;
    ports.download.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await updater.initialize();
    await updater.check();
    const pending = updater.download();
    await Promise.resolve();
    await updater.check(true);
    await updater.restart();
    expect(ports.discover).toHaveBeenCalledTimes(1);
    expect(ports.restart).not.toHaveBeenCalled();
    finish({ ok: true, update: staged });
    await pending;
  });

  it("retains the ready update when existing task admission reports pending work", async () => {
    const { updater, ports } = fixture();
    ports.restart.mockResolvedValue({
      status: "blocked",
      code: "TASK_OUTCOME_UNKNOWN",
    });
    await updater.initialize();
    await updater.check();
    await updater.download();
    await updater.restart();
    expect(updater.snapshot()).toMatchObject({
      phase: "ready",
      blockedBy: "TASK_OUTCOME_UNKNOWN",
    });
  });

  it("allows an explicit admission recheck after a known work blocker without redownload", async () => {
    const { updater, ports } = fixture();
    ports.restart.mockResolvedValue({
      status: "blocked",
      code: "UPDATE_WORK_PENDING",
    });
    await updater.initialize();
    await updater.check();
    await updater.download();
    await updater.restart();
    await updater.check(true);
    expect(updater.snapshot()).toMatchObject({
      phase: "ready",
      blockedBy: null,
      deferred: true,
    });
    expect(ports.restart).toHaveBeenCalledTimes(1);
    expect(ports.download).toHaveBeenCalledTimes(1);
  });

  it.each([
    "UPDATE_BROWSER_STATE_UNKNOWN",
    "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
    "TASK_OUTCOME_UNKNOWN",
    "UPDATE_UNCLASSIFIED",
  ])("retains %s across Check and refuses another Restart", async (code) => {
    const { updater, ports } = fixture();
    ports.restart.mockResolvedValueOnce({ status: "blocked", code });
    await updater.initialize();
    await updater.check();
    await updater.download();
    await updater.restart();
    expect(updater.snapshot()).toMatchObject({
      phase: "ready",
      blockedBy: code,
    });
    await updater.check(true);
    await updater.restart();
    expect(updater.snapshot()).toMatchObject({
      phase: "ready",
      blockedBy: code,
    });
    expect(ports.restart).toHaveBeenCalledTimes(1);
    expect(ports.discover).toHaveBeenCalledTimes(1);
    expect(ports.download).toHaveBeenCalledTimes(1);
  });

  it.each(["accepted", "unknown", "throw"])(
    "never repeats a helper handoff after %s",
    async (mode) => {
      const { updater, ports } = fixture();
      if (mode === "unknown")
        ports.restart.mockResolvedValue({
          status: "unknown",
          code: "UNCONFIRMED",
        });
      if (mode === "throw")
        ports.restart.mockRejectedValue(
          new Error("private stderr must not escape"),
        );
      await updater.initialize();
      await updater.check();
      await updater.download();
      await updater.restart();
      await updater.restart();
      await updater.check(true);
      expect(ports.restart).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(updater.snapshot())).not.toContain("private");
      expect(updater.snapshot().phase).toBe(
        mode === "accepted" ? "applying" : "failed",
      );
    },
  );

  it("locks automatic retries if the archive exists but its ready record cannot be confirmed", async () => {
    const { updater, ports, advance } = fixture();
    ports.retain.mockRejectedValue(new Error("uncertain fsync"));
    await updater.initialize();
    await updater.check();
    await updater.download();
    expect(updater.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    advance(UPDATE_RECHECK_MS);
    await updater.check();
    await updater.check(true);
    expect(ports.download).toHaveBeenCalledTimes(1);
    expect(ports.restart).not.toHaveBeenCalled();
  });

  it("does not call a retained archive ready until recovery verifies it", async () => {
    const { updater, ports } = fixture();
    ports.recover.mockResolvedValue({
      ok: false,
      code: "UPDATE_RECEIPT_UNRECONCILED",
    });
    await updater.initialize();
    await updater.check(true);
    await updater.restart();
    expect(updater.snapshot()).toEqual({
      phase: "failed",
      code: "UPDATE_RECEIPT_UNRECONCILED",
      recoveryRequired: true,
    });
    expect(ports.discover).not.toHaveBeenCalled();
    expect(ports.restart).not.toHaveBeenCalled();
  });

  it("reuses a reverified ready archive after normal restart without another download", async () => {
    const { updater, ports } = fixture();
    ports.recover.mockResolvedValue({ ok: true, update: staged });
    await updater.initialize();
    await updater.check();
    await updater.download();
    await updater.restart();
    expect(ports.download).not.toHaveBeenCalled();
    expect(ports.restart).toHaveBeenCalledWith(staged);
  });

  it("a failed retained-state write cannot expose Restart & Update", async () => {
    const { updater, ports } = fixture();
    ports.retain.mockRejectedValue(new Error("disk full"));
    await updater.initialize();
    await updater.check();
    await updater.download();
    await updater.restart();
    expect(updater.snapshot().phase).toBe("failed");
    expect(ports.restart).not.toHaveBeenCalled();
  });
});

describe("explicit local preparation (ports only, no archive or installed acceptance)", () => {
  function localFixture() {
    const { ports } = fixture();
    const selected = {
      ...ports,
      prepareLocal: vi
        .fn<NonNullable<InstalledUpdaterPorts["prepareLocal"]>>()
        .mockResolvedValue({ ok: true, update: staged }),
    };
    return { ports: selected, updater: new InstalledUpdater(selected) };
  }

  const replacement: ReadyUpdate = {
    handle: "owned-new-stage",
    manifest: {
      ...staged.manifest,
      version: "0.1.0-owner.beta.3",
      buildVersion: "4",
      buildId: "1".repeat(64),
      archiveSha256: "2".repeat(64),
      artifactSha256: "3".repeat(64),
    },
  };

  function replacementFixture() {
    const f = localFixture();
    f.ports.recover.mockResolvedValue({ ok: true, update: staged });
    f.ports.prepareLocal.mockResolvedValue({ ok: true, update: replacement });
    return f;
  }

  it("replaces only the admitted Ready after verified retention and restarts the new identity", async () => {
    const { updater, ports } = replacementFixture();
    let saved!: () => void;
    ports.retain.mockImplementation(
      () =>
        new Promise((resolve) => {
          saved = resolve;
        }),
    );
    await updater.initialize();
    const preparing = updater.prepareLocal(staged.manifest.buildId);
    await vi.waitFor(() =>
      expect(ports.retain).toHaveBeenCalledExactlyOnceWith(replacement),
    );
    expect(updater.snapshot()).toEqual({ phase: "downloading" });
    await Promise.all([
      updater.prepareLocal(staged.manifest.buildId),
      updater.prepareLocal(),
      updater.check(true),
      updater.download(),
      updater.restart(),
      updater.later(),
    ]);
    expect(ports.prepareLocal).toHaveBeenCalledTimes(1);
    expect(ports.restart).not.toHaveBeenCalled();
    saved();
    await preparing;
    expect(updater.snapshot()).toEqual({
      phase: "ready",
      version: replacement.manifest.version,
      deferred: false,
      blockedBy: null,
    });
    await updater.prepareLocal(staged.manifest.buildId);
    expect(ports.prepareLocal).toHaveBeenCalledTimes(1);
    await updater.restart();
    expect(ports.restart).toHaveBeenCalledExactlyOnceWith(replacement);
    expect(ports.discover).not.toHaveBeenCalled();
    expect(ports.download).not.toHaveBeenCalled();
  });

  it.each([
    "wrong-build",
    "no-argument",
    "missing-ready",
    "recovery",
    "unknown",
    "uninitialized",
    "busy",
    "applying",
    "closed",
    "normal-quit",
    "blocked-ready",
    "unknown-ready",
  ])("does not dispatch a replacement from %s", async (state) => {
    const { updater, ports } = replacementFixture();
    if (state === "missing-ready")
      ports.recover.mockResolvedValue({ ok: true, update: null });
    if (state === "recovery")
      ports.recover.mockResolvedValue({
        ok: true,
        update: staged,
        recoveryVersion: staged.manifest.version,
      });
    if (state === "unknown")
      ports.recover.mockResolvedValue({
        ok: false,
        code: "UPDATE_RECOVERY_UNKNOWN",
        recoveryRequired: true,
      });
    if (state !== "uninitialized") await updater.initialize();
    let applied!: () => void;
    let restarting: Promise<void> | undefined;
    if (state === "busy" || state === "applying") {
      ports.restart.mockImplementation(
        () =>
          new Promise((resolve) => {
            applied = () => resolve({ status: "accepted" });
          }),
      );
      restarting = updater.restart();
      if (state === "applying")
        await vi.waitFor(() => expect(ports.restart).toHaveBeenCalledTimes(1));
    }
    if (state === "closed") await updater.close();
    if (state === "normal-quit")
      await updater.applyOnNormalQuit({
        kind: "ordinary-quit",
        deadlineAt: 2_000,
      });
    if (state === "blocked-ready" || state === "unknown-ready") {
      ports.restart.mockResolvedValue({
        status: "blocked",
        code:
          state === "unknown-ready"
            ? "UPDATE_ADMISSION_UNKNOWN"
            : "UPDATE_BROWSER_OPEN",
      });
      await updater.restart();
    }
    const before = updater.snapshot();
    await updater.prepareLocal(
      state === "no-argument"
        ? undefined
        : state === "wrong-build"
          ? "4".repeat(64)
          : staged.manifest.buildId,
    );
    expect(updater.snapshot()).toEqual(before);
    expect(ports.prepareLocal).not.toHaveBeenCalled();
    expect(ports.retain).not.toHaveBeenCalled();
    if (restarting) {
      await vi.waitFor(() => expect(ports.restart).toHaveBeenCalledTimes(1));
      applied();
      await restarting;
    }
    await updater.close();
  });

  it.each(["available", "failed"])(
    "keeps no-argument preparation Idle-only from %s",
    async (state) => {
      const { updater, ports } = localFixture();
      await updater.initialize();
      if (state === "failed")
        ports.discover.mockResolvedValue({ ok: false, code: "UPDATE_OFFLINE" });
      await updater.check(true);
      const before = updater.snapshot();
      await updater.prepareLocal();
      expect(updater.snapshot()).toEqual(before);
      expect(ports.prepareLocal).not.toHaveBeenCalled();
      expect(ports.retain).not.toHaveBeenCalled();
    },
  );

  it.each(["build", "handle", "archive", "artifact"])(
    "fences a replacement aliasing the original %s identity",
    async (identity) => {
      const { updater, ports } = replacementFixture();
      const candidate: ReadyUpdate = {
        ...replacement,
        ...(identity === "handle" ? { handle: staged.handle } : {}),
        manifest: {
          ...replacement.manifest,
          ...(identity === "build" ? { buildId: staged.manifest.buildId } : {}),
          ...(identity === "archive"
            ? { archiveSha256: staged.manifest.archiveSha256 }
            : {}),
          ...(identity === "artifact"
            ? { artifactSha256: staged.manifest.artifactSha256 }
            : {}),
        },
      };
      ports.prepareLocal.mockResolvedValue({ ok: true, update: candidate });
      await updater.initialize();
      await updater.prepareLocal(staged.manifest.buildId);
      expect(updater.snapshot()).toEqual({
        phase: "failed",
        code: "UPDATE_LOCAL_CANDIDATE_NOT_NEW",
        recoveryRequired: true,
      });
      await updater.prepareLocal(staged.manifest.buildId);
      await updater.prepareLocal();
      await updater.restart();
      expect(ports.prepareLocal).toHaveBeenCalledTimes(1);
      expect(ports.retain).not.toHaveBeenCalled();
      expect(ports.restart).not.toHaveBeenCalled();
    },
  );

  it.each(["refused", "unavailable", "publication"])(
    "keeps the original owned before retention on %s",
    async (fault) => {
      const f = replacementFixture();
      const { ports } = f;
      const updater =
        fault === "unavailable"
          ? new InstalledUpdater(
              (({ prepareLocal: _local, ...ordinary }) => ordinary)(ports),
            )
          : f.updater;
      await updater.initialize();
      const original = updater.snapshot();
      if (fault === "refused")
        ports.prepareLocal.mockResolvedValue({
          ok: false,
          code: "UPDATE_LOCAL_MANIFEST_INVALID",
          recoveryRequired: false,
        });
      if (fault === "publication")
        ports.publish.mockImplementationOnce(() => {
          throw new Error("status unavailable");
        });
      await updater.prepareLocal(staged.manifest.buildId);
      expect(updater.snapshot()).toEqual(
        fault === "publication"
          ? original
          : {
              ...original,
              blockedBy:
                fault === "refused"
                  ? "UPDATE_LOCAL_MANIFEST_INVALID"
                  : "UPDATE_LOCAL_IMPORT_UNAVAILABLE",
            },
      );
      expect(ports.retain).not.toHaveBeenCalled();
      if (fault === "publication") {
        await updater.restart();
        expect(ports.restart).toHaveBeenCalledExactlyOnceWith(staged);
      } else {
        await updater.prepareLocal(staged.manifest.buildId);
        await updater.restart();
        expect(ports.prepareLocal).toHaveBeenCalledTimes(
          fault === "refused" ? 1 : 0,
        );
        expect(ports.restart).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    "producer-throw",
    "producer-recovery",
    "producer-unknown",
    "retain-refused",
    "retain-unknown",
    "retain-throw",
    "post-retain-publication",
  ])(
    "keeps %s sticky without asserting the original is unaffected",
    async (fault) => {
      const { updater, ports } = replacementFixture();
      if (fault === "producer-throw")
        ports.prepareLocal.mockRejectedValue(new Error("lost producer ACK"));
      if (fault === "producer-recovery")
        ports.prepareLocal.mockResolvedValue({
          ok: false,
          code: "UPDATE_STAGING_FAILED",
          recoveryRequired: true,
        });
      if (fault === "producer-unknown")
        ports.prepareLocal.mockResolvedValue({
          ok: false,
          code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
          recoveryRequired: false,
        });
      if (fault === "retain-refused")
        ports.retain.mockResolvedValue({
          ok: false,
          code: "UPDATE_READY_PERSIST_FAILED",
          recoveryRequired: false,
        });
      if (fault === "retain-unknown")
        ports.retain.mockResolvedValue({
          ok: false,
          code: "UPDATE_READY_COMMIT_UNKNOWN",
          recoveryRequired: false,
        });
      if (fault === "retain-throw")
        ports.retain.mockRejectedValue(new Error("lost retention ACK"));
      await updater.initialize();
      if (fault === "post-retain-publication")
        ports.publish
          .mockImplementationOnce(() => undefined)
          .mockImplementationOnce(() => {
            throw new Error("lost Ready publication");
          });
      await updater.prepareLocal(staged.manifest.buildId);
      expect(updater.snapshot()).toMatchObject({
        phase: "failed",
        recoveryRequired: true,
      });
      const failed = updater.snapshot();
      await updater.prepareLocal(staged.manifest.buildId);
      await updater.prepareLocal(replacement.manifest.buildId);
      await updater.prepareLocal();
      await updater.check(true);
      await updater.download();
      await updater.restart();
      await updater.restore("rollback");
      await updater.initialize();
      expect(updater.snapshot()).toEqual(failed);
      expect(ports.prepareLocal).toHaveBeenCalledTimes(1);
      expect(ports.retain).toHaveBeenCalledTimes(
        fault.startsWith("producer-") ? 0 : 1,
      );
      expect(ports.discover).not.toHaveBeenCalled();
      expect(ports.download).not.toHaveBeenCalled();
      expect(ports.restart).not.toHaveBeenCalled();
      expect(ports.restore).not.toHaveBeenCalled();
    },
  );

  it("does not dispatch replacement after Quit closes the initial publication", async () => {
    const { updater, ports } = replacementFixture();
    await updater.initialize();
    const preparing = updater.prepareLocal(staged.manifest.buildId);
    await Promise.all([preparing, updater.close()]);
    expect(ports.prepareLocal).not.toHaveBeenCalled();
    expect(ports.retain).not.toHaveBeenCalled();
  });

  it.each(["producer", "retention", "retention-unknown"])(
    "drains replacement during Quit at %s without late publication or replay",
    async (boundary) => {
      const { updater, ports } = replacementFixture();
      let complete!: () => void;
      const gate = new Promise<void>((resolve) => {
        complete = resolve;
      });
      if (boundary === "producer")
        ports.prepareLocal.mockImplementation(async () => {
          await gate;
          return { ok: true, update: replacement };
        });
      else
        ports.retain.mockImplementation(async () => {
          await gate;
          if (boundary === "retention-unknown")
            throw new Error("lost retain ACK after Quit");
        });
      await updater.initialize();
      const preparing = updater.prepareLocal(staged.manifest.buildId);
      await vi.waitFor(() =>
        expect(
          boundary === "producer" ? ports.prepareLocal : ports.retain,
        ).toHaveBeenCalledTimes(1),
      );
      const closed = vi.fn();
      const closing = updater.close().then(closed);
      const publications = ports.publish.mock.calls.length;
      await Promise.resolve();
      expect(closed).not.toHaveBeenCalled();
      complete();
      await Promise.all([preparing, closing]);
      if (boundary === "retention-unknown")
        expect(updater.snapshot()).toEqual({
          phase: "failed",
          code: "UPDATE_LOCAL_IMPORT_UNKNOWN",
          recoveryRequired: true,
        });
      await updater.prepareLocal(staged.manifest.buildId);
      await updater.restart();
      expect(ports.prepareLocal).toHaveBeenCalledTimes(1);
      expect(ports.retain).toHaveBeenCalledExactlyOnceWith(replacement);
      expect(ports.publish).toHaveBeenCalledTimes(publications);
      expect(ports.restart).not.toHaveBeenCalled();
      expect(ports.cancelPending).toHaveBeenCalledTimes(1);
    },
  );

  it("uses the selected importer and durable retention before offering restart", async () => {
    const { updater, ports } = localFixture();
    let saved!: () => void;
    ports.retain.mockImplementation(
      () =>
        new Promise((resolve) => {
          saved = resolve;
        }),
    );
    await updater.prepareLocal();
    expect(ports.prepareLocal).not.toHaveBeenCalled();
    await updater.initialize();
    const importing = updater.prepareLocal();
    await Promise.resolve();
    expect(updater.snapshot().phase).toBe("downloading");
    await updater.restart();
    expect(ports.restart).not.toHaveBeenCalled();
    saved();
    await importing;
    expect(ports.prepareLocal).toHaveBeenCalledTimes(1);
    expect(ports.retain).toHaveBeenCalledExactlyOnceWith(staged);
    expect(ports.discover).not.toHaveBeenCalled();
    expect(ports.download).not.toHaveBeenCalled();
    expect(updater.snapshot()).toMatchObject({
      phase: "ready",
      version: staged.manifest.version,
    });
    await updater.later();
    await updater.prepareLocal();
    expect(ports.prepareLocal).toHaveBeenCalledTimes(1);
    await updater.restart();
    expect(ports.restart).toHaveBeenCalledExactlyOnceWith(staged);
    await updater.close();
  });

  it.each(["retained", "recovery", "unknown", "closed"])(
    "does not import over %s ownership",
    async (state) => {
      const { updater, ports } = localFixture();
      if (state === "retained")
        ports.recover.mockResolvedValue({ ok: true, update: staged });
      if (state === "recovery")
        ports.recover.mockResolvedValue({
          ok: true,
          update: null,
          recoveryVersion: staged.manifest.version,
        });
      if (state === "unknown")
        ports.recover.mockResolvedValue({
          ok: false,
          code: "UPDATE_RECOVERY_UNAVAILABLE",
          recoveryRequired: true,
        });
      await updater.initialize();
      if (state === "closed") await updater.close();
      await updater.prepareLocal();
      expect(ports.prepareLocal).not.toHaveBeenCalled();
      expect(ports.discover).not.toHaveBeenCalled();
      expect(ports.download).not.toHaveBeenCalled();
      await updater.close();
    },
  );

  it("serializes local preparation with Check and retains completed import during Quit", async () => {
    const { updater, ports } = localFixture();
    let imported!: (
      value: Awaited<
        ReturnType<NonNullable<InstalledUpdaterPorts["prepareLocal"]>>
      >,
    ) => void;
    let saved!: () => void;
    ports.prepareLocal.mockImplementation(
      () =>
        new Promise((resolve) => {
          imported = resolve;
        }),
    );
    ports.retain.mockImplementation(
      () =>
        new Promise((resolve) => {
          saved = resolve;
        }),
    );
    await updater.initialize();
    const preparing = updater.prepareLocal();
    await updater.prepareLocal();
    await updater.check(true);
    expect(ports.prepareLocal).toHaveBeenCalledTimes(1);
    expect(ports.discover).not.toHaveBeenCalled();
    ports.publish.mockClear();
    let drained = false;
    const closing = updater.close().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    imported({ ok: true, update: staged });
    await Promise.resolve();
    expect(drained).toBe(false);
    saved();
    await Promise.all([preparing, closing]);
    expect(ports.cancelPending).toHaveBeenCalledTimes(1);
    expect(ports.retain).toHaveBeenCalledExactlyOnceWith(staged);
    expect(ports.publish).not.toHaveBeenCalled();
    expect(ports.restart).not.toHaveBeenCalled();
  });

  it.each(["import", "retention"])(
    "keeps an unknown %s result fenced across both preparation routes",
    async (boundary) => {
      const { updater, ports } = localFixture();
      ports.recover.mockResolvedValue({
        ok: true,
        update: null,
        rollbackVersion: "0.1.0-owner.beta.1",
      });
      if (boundary === "import")
        ports.prepareLocal.mockRejectedValue(new Error("lost import reply"));
      else ports.retain.mockRejectedValue(new Error("lost retention reply"));
      await updater.initialize();
      await updater.prepareLocal();
      expect(updater.snapshot()).toEqual({
        phase: "failed",
        code: "UPDATE_LOCAL_IMPORT_UNKNOWN",
        recoveryRequired: true,
      });
      await updater.prepareLocal();
      await updater.check(true);
      await updater.restart();
      await updater.restore("rollback");
      expect(ports.prepareLocal).toHaveBeenCalledTimes(1);
      expect(ports.discover).not.toHaveBeenCalled();
      expect(ports.download).not.toHaveBeenCalled();
      expect(ports.restart).not.toHaveBeenCalled();
      expect(ports.restore).not.toHaveBeenCalled();
      await updater.close();
    },
  );

  it.each(["unavailable", "refused", "retention"])(
    "preserves a reconciled rollback after known local %s",
    async (boundary) => {
      const fixture = localFixture();
      const { ports } = fixture;
      ports.recover.mockResolvedValue({
        ok: true,
        update: null,
        rollbackVersion: "0.1.0-owner.beta.1",
      });
      const updater =
        boundary === "unavailable"
          ? new InstalledUpdater(
              (({ prepareLocal: _local, ...ordinary }) => ordinary)(ports),
            )
          : fixture.updater;
      if (boundary === "refused")
        ports.prepareLocal.mockResolvedValue({
          ok: false,
          code: "UPDATE_LOCAL_MANIFEST_INVALID",
        });
      if (boundary === "retention")
        ports.retain.mockResolvedValue({
          ok: false,
          code: "UPDATE_READY_PERSIST_FAILED",
        });
      await updater.initialize();
      await updater.prepareLocal();
      expect(updater.snapshot()).toMatchObject({
        phase: "failed",
        recoveryRequired: false,
        rollbackVersion: "0.1.0-owner.beta.1",
      });
      await updater.restore("rollback");
      expect(ports.restore).toHaveBeenCalledExactlyOnceWith("rollback");
      expect(ports.discover).not.toHaveBeenCalled();
      expect(ports.download).not.toHaveBeenCalled();
      await updater.close();
    },
  );

  it("does not silently replace an unavailable local source with network discovery", async () => {
    const { updater, ports } = fixture();
    await updater.initialize();
    await updater.prepareLocal();
    expect(updater.snapshot()).toEqual({
      phase: "failed",
      code: "UPDATE_LOCAL_IMPORT_UNAVAILABLE",
      recoveryRequired: false,
    });
    expect(ports.discover).not.toHaveBeenCalled();
    expect(ports.download).not.toHaveBeenCalled();
    expect(ports.retain).not.toHaveBeenCalled();
    await updater.close();
  });
});

// Notice-only ports. These tests exercise owner fencing without native effects.
describe("release-owned notice acknowledgement", () => {
  function noticeFixture() {
    const f = fixture();
    const notice = vi
      .fn<NonNullable<InstalledUpdaterPorts["notice"]>>()
      .mockImplementation(async (view) => ({
        key:
          view.phase === "failed"
            ? "failure:fixture"
            : `version:${staged.manifest.version}`,
        seen: false,
        blockedBy: null,
      }));
    const noticeSeen = vi
      .fn<NonNullable<InstalledUpdaterPorts["noticeSeen"]>>()
      .mockResolvedValue({ ok: true });
    return {
      ...f,
      notice,
      noticeSeen,
      updater: new InstalledUpdater({ ...f.ports, notice, noticeSeen }),
    };
  }
  it("acknowledges only the exact available notice without Skip/Later/staging", async () => {
    const f = noticeFixture();
    await f.updater.initialize();
    await f.updater.check(true);
    await f.updater.acknowledgeNotice("version:stale");
    expect(f.noticeSeen).not.toHaveBeenCalled();
    const before = f.updater.snapshot();
    expect(before.phase).toBe("available");
    await f.updater.acknowledgeNotice(`version:${staged.manifest.version}`);
    expect(f.updater.snapshot()).toEqual({
      ...before,
      notice: {
        key: `version:${staged.manifest.version}`,
        seen: true,
        blockedBy: null,
      },
    });
    await f.updater.acknowledgeNotice(`version:${staged.manifest.version}`);
    expect(f.noticeSeen).toHaveBeenCalledTimes(1);
    expect(f.ports.skip).not.toHaveBeenCalled();
    expect(f.ports.defer).not.toHaveBeenCalled();
    expect(f.ports.download).not.toHaveBeenCalled();
    expect(f.ports.restart).not.toHaveBeenCalled();
  });
  it("keeps a known failure and recovery requirement intact after notice acknowledgement", async () => {
    const f = noticeFixture();
    f.ports.recover.mockResolvedValue({
      ok: false,
      code: "UPDATE_RECEIPT_INVALID",
      recoveryRequired: true,
    });
    await f.updater.initialize();
    await f.updater.acknowledgeNotice("failure:fixture");
    expect(f.updater.snapshot()).toMatchObject({
      phase: "failed",
      code: "UPDATE_RECEIPT_INVALID",
      recoveryRequired: true,
      notice: { seen: true },
    });
    await f.updater.check(true);
    expect(f.ports.discover).not.toHaveBeenCalled();
    expect(f.ports.restore).not.toHaveBeenCalled();
  });
  it("does not acknowledge an unknown update or admission outcome", async () => {
    const f = noticeFixture();
    f.ports.recover.mockResolvedValue({
      ok: false,
      code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
      recoveryRequired: true,
    });
    await f.updater.initialize();
    await f.updater.acknowledgeNotice("failure:fixture");
    expect(f.noticeSeen).not.toHaveBeenCalled();
    expect(f.updater.snapshot()).toMatchObject({
      code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
      notice: { seen: false },
    });
    const ready = noticeFixture();
    await ready.updater.initialize();
    await ready.updater.check(true);
    await ready.updater.download();
    ready.ports.restart.mockResolvedValue({
      status: "blocked",
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    await ready.updater.restart();
    await ready.updater.acknowledgeNotice(`version:${staged.manifest.version}`);
    expect(ready.noticeSeen).not.toHaveBeenCalled();
    expect(ready.updater.snapshot()).toMatchObject({
      phase: "ready",
      blockedBy: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
  });
  it("fences a lost notice write acknowledgement without retrying the notice or blocking update authority", async () => {
    const f = noticeFixture();
    f.noticeSeen.mockRejectedValue(new Error("write reply lost"));
    await f.updater.initialize();
    await f.updater.check(true);
    await f.updater.acknowledgeNotice(`version:${staged.manifest.version}`);
    await f.updater.acknowledgeNotice(`version:${staged.manifest.version}`);
    await f.updater.download();
    await f.updater.skip();
    await f.updater.later();
    await f.updater.check(true);
    expect(f.noticeSeen).toHaveBeenCalledTimes(1);
    expect(f.ports.discover).toHaveBeenCalledTimes(1);
    expect(f.ports.download).toHaveBeenCalledTimes(1);
    expect(f.ports.skip).not.toHaveBeenCalled();
    expect(f.ports.defer).not.toHaveBeenCalled();
    expect(f.updater.snapshot()).toMatchObject({
      phase: "ready",
      deferred: true,
      notice: { seen: false, blockedBy: "UPDATE_NOTICE_OUTCOME_UNKNOWN" },
    });
  });
  it("allows Later independently and drains a pending notice write on close", async () => {
    const f = noticeFixture();
    let resolve!: (result: { ok: true }) => void;
    f.noticeSeen.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await f.updater.initialize();
    await f.updater.check(true);
    await f.updater.download();
    const marking = f.updater.acknowledgeNotice(
      `version:${staged.manifest.version}`,
    );
    await f.updater.later();
    expect(f.updater.snapshot()).toMatchObject({
      phase: "ready",
      deferred: true,
    });
    let closed = false;
    const closing = f.updater.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    resolve({ ok: true });
    await marking;
    await closing;
    expect(closed).toBe(true);
  });
  it.each(["confirmed", "unknown"] as const)(
    "drains a settled %s notice write even when presentation publication throws",
    async (outcome) => {
      const f = noticeFixture();
      if (outcome === "unknown")
        f.noticeSeen.mockRejectedValue(new Error("original notice ACK lost"));
      await f.updater.initialize();
      await f.updater.check(true);
      f.ports.publish.mockImplementation(() => {
        throw new Error("renderer publication unavailable");
      });
      const acknowledgement = await f.updater
        .acknowledgeNotice(`version:${staged.manifest.version}`)
        .then(
          () => ({ status: "resolved" as const }),
          () => ({ status: "rejected" as const }),
        );
      expect(f.updater.snapshot()).toMatchObject({
        phase: "available",
        notice: {
          seen: outcome === "confirmed",
          blockedBy:
            outcome === "confirmed" ? null : "UPDATE_NOTICE_OUTCOME_UNKNOWN",
        },
      });
      await f.updater.acknowledgeNotice(`version:${staged.manifest.version}`);
      expect(f.noticeSeen).toHaveBeenCalledTimes(1);
      let closed = false;
      const closing = f.updater.close().then(() => {
        closed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(true);
      await closing;
      expect(acknowledgement.status).toBe("resolved");
      expect(f.ports.cancelPending).toHaveBeenCalledTimes(1);
      expect(f.ports.restart).not.toHaveBeenCalled();
      expect(f.ports.restore).not.toHaveBeenCalled();
      expect(f.ports.download).not.toHaveBeenCalled();
    },
  );
  it("retains an unknown notice write after failed publication while update authority stays independent", async () => {
    const f = noticeFixture();
    f.noticeSeen.mockRejectedValue(new Error("original notice ACK lost"));
    await f.updater.initialize();
    await f.updater.check(true);
    f.ports.publish.mockImplementation(() => {
      throw new Error("renderer publication unavailable");
    });
    await f.updater.acknowledgeNotice(`version:${staged.manifest.version}`);
    f.ports.publish.mockReset();
    await f.updater.download();
    await f.updater.acknowledgeNotice("unconfirmed");
    await f.updater.acknowledgeNotice(`version:${staged.manifest.version}`);
    expect(f.updater.snapshot()).toMatchObject({
      phase: "ready",
      blockedBy: null,
      notice: { seen: false, blockedBy: "UPDATE_NOTICE_OUTCOME_UNKNOWN" },
    });
    expect(f.noticeSeen).toHaveBeenCalledTimes(1);
    expect(f.ports.download).toHaveBeenCalledTimes(1);
    expect(f.ports.retain).toHaveBeenCalledTimes(1);
    expect(f.ports.restart).not.toHaveBeenCalled();
    await f.updater.close();
  });
  it("settles the original notice lane when failed publication synchronously starts Close", async () => {
    const f = noticeFixture();
    await f.updater.initialize();
    await f.updater.check(true);
    let closing: Promise<void> | undefined;
    f.ports.publish.mockImplementation(() => {
      closing = f.updater.close();
      throw new Error("renderer closed during publication");
    });
    await f.updater.acknowledgeNotice(`version:${staged.manifest.version}`);
    await closing;
    expect(f.updater.snapshot()).toMatchObject({ notice: { seen: true } });
    expect(f.noticeSeen).toHaveBeenCalledTimes(1);
    expect(f.ports.cancelPending).toHaveBeenCalledTimes(1);
  });
});

describe("automatic update preference (ports only; no automatic release acceptance)", () => {
  function preferenceFixture(enabled = false) {
    const base = fixture();
    const ports = {
      ...base.ports,
      readAutomaticUpdatePreference: vi
        .fn<
          NonNullable<InstalledUpdaterPorts["readAutomaticUpdatePreference"]>
        >()
        .mockResolvedValue({ status: "confirmed", enabled }),
      writeAutomaticUpdatePreference: vi
        .fn<
          NonNullable<InstalledUpdaterPorts["writeAutomaticUpdatePreference"]>
        >()
        .mockImplementation(async (choice) => ({
          status: "confirmed",
          enabled: choice,
        })),
    };
    return {
      ports,
      updater: new InstalledUpdater(ports),
      advance: base.advance,
    };
  }

  it.each([false, true])(
    "scheduled checks discover with automatic=%s and download only for ON",
    async (enabled) => {
      const { updater, ports, advance } = preferenceFixture(enabled);
      await updater.initialize();
      await updater.scheduledCheck();
      expect(ports.discover).toHaveBeenCalledTimes(1);
      expect(ports.download).toHaveBeenCalledTimes(enabled ? 1 : 0);
      expect(ports.retain).toHaveBeenCalledTimes(enabled ? 1 : 0);
      expect(updater.snapshot().phase).toBe(enabled ? "ready" : "available");
      await updater.scheduledCheck();
      advance(UPDATE_RECHECK_MS);
      await updater.scheduledCheck();
      expect(ports.discover).toHaveBeenCalledTimes(enabled ? 1 : 2);
      expect(ports.download).toHaveBeenCalledTimes(enabled ? 1 : 0);
      expect(ports.restart).not.toHaveBeenCalled();
      expect(ports.restore).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "manual discovery with automatic=%s returns without waiting for transfer",
    async (enabled) => {
      const { updater, ports } = preferenceFixture(enabled);
      let finish!: (
        value: Awaited<ReturnType<InstalledUpdaterPorts["download"]>>,
      ) => void;
      ports.download.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await updater.initialize();
      await updater.manualCheck();
      if (!enabled) {
        expect(updater.snapshot().phase).toBe("available");
        expect(ports.download).not.toHaveBeenCalled();
        return;
      }
      await vi.waitFor(() => expect(ports.download).toHaveBeenCalledTimes(1));
      expect(updater.snapshot().phase).toBe("downloading");
      await updater.scheduledCheck();
      await updater.manualCheck();
      expect(ports.discover).toHaveBeenCalledTimes(1);
      expect(ports.download).toHaveBeenCalledTimes(1);
      finish({ ok: true, update: staged });
      await vi.waitFor(() => expect(updater.snapshot().phase).toBe("ready"));
      expect(ports.retain).toHaveBeenCalledExactlyOnceWith(staged);
      expect(ports.restart).not.toHaveBeenCalled();
      await updater.close();
    },
  );

  it("manual discovery respects postponement and an opt-out during discovery", async () => {
    const deferred = preferenceFixture(true);
    deferred.ports.discover.mockResolvedValue({
      ok: true,
      available: true,
      version: staged.manifest.version,
      buildId: staged.manifest.buildId,
      deferred: true,
    });
    await deferred.updater.initialize();
    await deferred.updater.manualCheck();
    expect(deferred.ports.download).not.toHaveBeenCalled();
    const f = preferenceFixture(true);
    let finish!: (
      value: Awaited<ReturnType<InstalledUpdaterPorts["discover"]>>,
    ) => void;
    f.ports.discover.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await f.updater.initialize();
    const checking = f.updater.manualCheck();
    await vi.waitFor(() => expect(f.ports.discover).toHaveBeenCalledTimes(1));
    await f.updater.setAutomaticUpdatePreference(false);
    finish({
      ok: true,
      available: true,
      version: staged.manifest.version,
      buildId: staged.manifest.buildId,
      deferred: false,
    });
    await checking;
    expect(f.ports.download).not.toHaveBeenCalled();
    expect(f.ports.restart).not.toHaveBeenCalled();
    await f.updater.close();
  });

  it("manual discovery uses the existing idle admission for full automatic opt-in", async () => {
    const { updater, ports } = preferenceFixture(true);
    ports.readAutomaticUpdatePreference.mockResolvedValue({
      status: "confirmed",
      enabled: true,
      scope: "download-and-install",
    });
    ports.restart.mockResolvedValue({
      status: "blocked",
      code: "UPDATE_BROWSER_BUSY",
    });
    await updater.initialize();
    await updater.manualCheck();
    await vi.waitFor(() => expect(ports.restart).toHaveBeenCalledTimes(1));
    expect(updater.snapshot()).toMatchObject({
      phase: "ready",
      blockedBy: "UPDATE_BROWSER_BUSY",
    });
    expect(ports.retain).toHaveBeenCalledExactlyOnceWith(staged);
    await updater.close();
  });

  it("Close drains the original manual automatic transfer and prevents a late restart", async () => {
    const { updater, ports } = preferenceFixture(true);
    ports.readAutomaticUpdatePreference.mockResolvedValue({
      status: "confirmed",
      enabled: true,
      scope: "download-and-install",
    });
    let finish!: (
      value: Awaited<ReturnType<InstalledUpdaterPorts["download"]>>,
    ) => void;
    ports.download.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await updater.initialize();
    await updater.manualCheck();
    await vi.waitFor(() => expect(ports.download).toHaveBeenCalledTimes(1));
    let drained = false;
    const closing = updater.close().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish({ ok: true, update: staged });
    await closing;
    expect(ports.download).toHaveBeenCalledTimes(1);
    expect(ports.restart).not.toHaveBeenCalled();
    expect(
      ports.publish.mock.calls.filter(([view]) => view.phase === "ready"),
    ).toHaveLength(0);
  });

  it("manual preparation preserves an unknown transfer without automatic replay", async () => {
    const { updater, ports, advance } = preferenceFixture(true);
    ports.download.mockResolvedValue({
      ok: false,
      code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
      recoveryRequired: true,
    });
    await updater.initialize();
    await updater.manualCheck();
    await vi.waitFor(() =>
      expect(updater.snapshot()).toMatchObject({
        phase: "failed",
        recoveryRequired: true,
      }),
    );
    advance(UPDATE_RECHECK_MS);
    await updater.manualCheck();
    await updater.scheduledCheck();
    expect(ports.discover).toHaveBeenCalledTimes(1);
    expect(ports.download).toHaveBeenCalledTimes(1);
    expect(ports.restart).not.toHaveBeenCalled();
    await updater.close();
  });

  it("keeps transitional callers without a preference port check-only", async () => {
    const { updater, ports } = fixture();
    await updater.initialize();
    await updater.scheduledCheck();
    expect(ports.discover).toHaveBeenCalledTimes(1);
    expect(ports.download).not.toHaveBeenCalled();
  });

  it("does not download a throttled manual candidate or dispatch on opt-in alone", async () => {
    const { updater, ports, advance } = preferenceFixture();
    await updater.initialize();
    await updater.check(true);
    await updater.setAutomaticUpdatePreference(true);
    await updater.scheduledCheck();
    expect(ports.discover).toHaveBeenCalledTimes(1);
    expect(ports.download).not.toHaveBeenCalled();
    advance(UPDATE_RECHECK_MS);
    await updater.scheduledCheck();
    expect(ports.discover).toHaveBeenCalledTimes(2);
    expect(ports.download).toHaveBeenCalledTimes(1);
  });

  it("preserves Later and downloads a newly discovered version", async () => {
    const { updater, ports, advance } = preferenceFixture(true);
    ports.discover.mockResolvedValue({
      ok: true,
      available: true,
      version: staged.manifest.version,
      buildId: staged.manifest.buildId,
      deferred: true,
    });
    await updater.initialize();
    await updater.scheduledCheck();
    expect(updater.snapshot()).toMatchObject({
      phase: "available",
      deferred: true,
    });
    expect(ports.download).not.toHaveBeenCalled();
    const newer = {
      ...staged,
      manifest: {
        ...staged.manifest,
        version: "0.1.0-owner.beta.3",
        buildId: "8".repeat(64),
      },
    };
    ports.discover.mockResolvedValue({
      ok: true,
      available: true,
      version: newer.manifest.version,
      buildId: newer.manifest.buildId,
      deferred: false,
    });
    ports.download.mockResolvedValue({ ok: true, update: newer });
    advance(UPDATE_RECHECK_MS);
    await updater.scheduledCheck();
    expect(ports.retain).toHaveBeenCalledExactlyOnceWith(newer);
    expect(updater.snapshot()).toMatchObject({
      phase: "ready",
      version: newer.manifest.version,
    });
  });

  it.each([
    "absent",
    "offline",
    "known-download",
    "unknown-download",
    "unknown-retain",
    "changed",
  ])(
    "preserves scheduled %s classification and does not overlap or retry uncertainty",
    async (fault) => {
      const { updater, ports, advance } = preferenceFixture(true);
      if (fault === "absent")
        ports.discover.mockResolvedValue({ ok: true, available: false });
      if (fault === "offline")
        ports.discover.mockResolvedValue({ ok: false, code: "UPDATE_OFFLINE" });
      if (fault === "known-download")
        ports.download.mockResolvedValue({
          ok: false,
          code: "UPDATE_CHECKSUM_MISMATCH",
        });
      if (fault === "unknown-download")
        ports.download.mockRejectedValue(new Error("lost staging ACK"));
      if (fault === "unknown-retain")
        ports.retain.mockRejectedValue(new Error("lost retention ACK"));
      if (fault === "changed")
        ports.download.mockResolvedValue({
          ok: true,
          update: {
            ...staged,
            manifest: { ...staged.manifest, buildId: "8".repeat(64) },
          },
        });
      await updater.initialize();
      await updater.scheduledCheck();
      const expectedCode = {
        absent: null,
        offline: "UPDATE_OFFLINE",
        "known-download": "UPDATE_CHECKSUM_MISMATCH",
        "unknown-download": "UPDATE_STAGING_OUTCOME_UNKNOWN",
        "unknown-retain": "UPDATE_STAGING_OUTCOME_UNKNOWN",
        changed: "UPDATE_CANDIDATE_CHANGED",
      }[fault];
      const fenced = ["unknown-download", "unknown-retain", "changed"].includes(
        fault,
      );
      expect(updater.snapshot()).toMatchObject(
        expectedCode === null
          ? { phase: "idle" }
          : { phase: "failed", code: expectedCode, recoveryRequired: fenced },
      );
      await updater.scheduledCheck();
      expect(ports.discover).toHaveBeenCalledTimes(1);
      advance(UPDATE_RECHECK_MS);
      await updater.scheduledCheck();
      expect(ports.discover).toHaveBeenCalledTimes(fenced ? 1 : 2);
      expect(ports.download).toHaveBeenCalledTimes(
        ["absent", "offline"].includes(fault) ? 0 : fenced ? 1 : 2,
      );
      expect(ports.restart).not.toHaveBeenCalled();
    },
  );

  it.each(["off", "writing", "unknown"])(
    "rechecks preference %s after pending discovery",
    async (choice) => {
      const { updater, ports } = preferenceFixture(true);
      const found = await ports.discover();
      ports.discover.mockClear();
      let complete!: (value: typeof found) => void;
      ports.discover.mockImplementation(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      await updater.initialize();
      const checking = updater.scheduledCheck();
      await vi.waitFor(() => expect(ports.discover).toHaveBeenCalledTimes(1));
      let finishWrite!: (value: {
        status: "confirmed";
        enabled: boolean;
      }) => void;
      if (choice === "writing")
        ports.writeAutomaticUpdatePreference.mockImplementation(
          () =>
            new Promise((resolve) => {
              finishWrite = resolve;
            }),
        );
      if (choice === "unknown")
        ports.writeAutomaticUpdatePreference.mockRejectedValue(
          new Error("lost ACK"),
        );
      const writing = updater.setAutomaticUpdatePreference(false);
      if (choice !== "writing") await writing;
      complete(found);
      await checking;
      expect(ports.download).not.toHaveBeenCalled();
      if (choice === "writing") {
        finishWrite({ status: "confirmed", enabled: false });
        await writing;
      }
      await updater.close();
    },
  );

  it("does not act on an opt-in that settles during an OFF tick", async () => {
    const { updater, ports } = preferenceFixture();
    await updater.initialize();
    ports.discover.mockImplementation(async () => {
      await updater.setAutomaticUpdatePreference(true);
      return {
        ok: true,
        available: true,
        version: staged.manifest.version,
        buildId: staged.manifest.buildId,
        deferred: false,
      };
    });
    await updater.scheduledCheck();
    expect(ports.download).not.toHaveBeenCalled();
  });

  it("ignores uninitialized, busy and reentrant ticks without duplicating download", async () => {
    const { updater, ports } = preferenceFixture(true);
    await updater.scheduledCheck();
    expect(ports.discover).not.toHaveBeenCalled();
    const initializing = updater.initialize();
    await updater.scheduledCheck();
    await initializing;
    let complete!: (value: { ok: true; update: ReadyUpdate }) => void;
    ports.download.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    ports.publish.mockImplementation(() => {
      void updater.scheduledCheck();
    });
    const checking = updater.scheduledCheck();
    await updater.scheduledCheck();
    await vi.waitFor(() => expect(ports.download).toHaveBeenCalledTimes(1));
    await Promise.all([
      updater.scheduledCheck(),
      updater.check(true),
      updater.download(),
      updater.skip(),
      updater.later(),
    ]);
    complete({ ok: true, update: staged });
    await checking;
    expect(ports.discover).toHaveBeenCalledTimes(1);
    expect(ports.download).toHaveBeenCalledTimes(1);
    expect(ports.retain).toHaveBeenCalledExactlyOnceWith(staged);
    expect(ports.skip).not.toHaveBeenCalled();
    expect(ports.defer).not.toHaveBeenCalled();
  });

  it.each(["publication", "discovery", "download", "retention"])(
    "closes and drains scheduled %s without a late effect or publication",
    async (stage) => {
      const { updater, ports } = preferenceFixture(true);
      await updater.initialize();
      let complete!: () => void;
      const gate = new Promise<void>((resolve) => {
        complete = resolve;
      });
      if (stage === "discovery")
        ports.discover.mockImplementation(async () => {
          await gate;
          return {
            ok: true,
            available: true,
            version: staged.manifest.version,
            buildId: staged.manifest.buildId,
            deferred: false,
          };
        });
      if (stage === "download")
        ports.download.mockImplementation(async () => {
          await gate;
          return { ok: true, update: staged };
        });
      if (stage === "retention")
        ports.retain.mockImplementation(async () => {
          await gate;
        });
      const checking = updater.scheduledCheck();
      if (stage !== "publication")
        await vi.waitFor(() =>
          expect(
            ports[
              stage === "discovery"
                ? "discover"
                : stage === "download"
                  ? "download"
                  : "retain"
            ],
          ).toHaveBeenCalledTimes(1),
        );
      const closed = vi.fn();
      const closing = updater.close().then(closed);
      const publications = ports.publish.mock.calls.length;
      await Promise.resolve();
      expect(closed).not.toHaveBeenCalled();
      complete();
      await Promise.all([checking, closing]);
      await updater.scheduledCheck();
      expect(ports.publish).toHaveBeenCalledTimes(publications);
      expect(ports.download).toHaveBeenCalledTimes(
        ["download", "retention"].includes(stage) ? 1 : 0,
      );
      expect(ports.retain).toHaveBeenCalledTimes(
        ["download", "retention"].includes(stage) ? 1 : 0,
      );
      expect(ports.cancelPending).toHaveBeenCalledTimes(1);
      expect(ports.restart).not.toHaveBeenCalled();
    },
  );

  it("strictly parses commands, preference states and exact ACKs", () => {
    expect(
      InstalledUpdateCommandSchema.parse({
        kind: "set-automatic-update-preference",
        enabled: false,
      }),
    ).toEqual({ kind: "set-automatic-update-preference", enabled: false });
    for (const invalid of [
      { kind: "set-automatic-update-preference" },
      { kind: "set-automatic-update-preference", enabled: "true" },
      { kind: "set-automatic-update-preference", enabled: true, restart: true },
    ])
      expect(InstalledUpdateCommandSchema.safeParse(invalid).success).toBe(
        false,
      );
    expect(
      InstalledUpdateViewSchema.safeParse({
        phase: "idle",
        checkedAt: null,
        automaticUpdatePreference: {
          status: "unknown",
          enabled: true,
          code: "UNKNOWN",
        },
      }).success,
    ).toBe(false);
    expect(
      AutomaticUpdatePreferenceResultSchema.safeParse({ status: "confirmed" })
        .success,
    ).toBe(false);
    expect(
      InstalledUpdateViewSchema.parse({ phase: "idle", checkedAt: null }),
    ).toEqual({ phase: "idle", checkedAt: null });
  });

  it("loads default OFF and changes only the preference, including while Ready", async () => {
    const { updater, ports } = preferenceFixture();
    await updater.initialize();
    expect(updater.automaticUpdatePreference()).toEqual({
      status: "confirmed",
      enabled: false,
    });
    expect(InstalledUpdateViewSchema.parse(updater.snapshot())).toMatchObject({
      automaticUpdatePreference: { status: "confirmed", enabled: false },
    });
    expect(await updater.setAutomaticUpdatePreference(true)).toEqual({
      status: "confirmed",
      enabled: true,
    });
    expect(ports.discover).not.toHaveBeenCalled();
    expect(ports.download).not.toHaveBeenCalled();
    expect(ports.restart).not.toHaveBeenCalled();
    await updater.check(true);
    expect(ports.download).not.toHaveBeenCalled();
    await updater.download();
    const before = updater.snapshot();
    await updater.setAutomaticUpdatePreference(false);
    expect(updater.snapshot()).toEqual({
      ...before,
      automaticUpdatePreference: { status: "confirmed", enabled: false },
    });
    expect(ports.restart).not.toHaveBeenCalled();
    expect(ports.restore).not.toHaveBeenCalled();
    expect(ports.skip).not.toHaveBeenCalled();
    expect(ports.defer).not.toHaveBeenCalled();
  });

  it.each(["throw", "unknown", "mismatch"])(
    "fences %s without retry and projects OFF",
    async (fault) => {
      const { updater, ports } = preferenceFixture();
      await updater.initialize();
      if (fault === "throw")
        ports.writeAutomaticUpdatePreference.mockRejectedValue(
          new Error("lost ACK"),
        );
      else if (fault === "unknown")
        ports.writeAutomaticUpdatePreference.mockResolvedValue({
          status: "unknown",
          code: "UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN",
        });
      else
        ports.writeAutomaticUpdatePreference.mockResolvedValue({
          status: "confirmed",
          enabled: false,
        });
      expect(await updater.setAutomaticUpdatePreference(true)).toMatchObject({
        status: "unknown",
      });
      expect(updater.automaticUpdatePreference()).toMatchObject({
        status: "unknown",
        enabled: false,
      });
      await updater.setAutomaticUpdatePreference(false);
      await updater.initialize();
      await updater.check(true);
      expect(updater.snapshot()).toMatchObject({
        phase: "available",
        automaticUpdatePreference: { status: "unknown", enabled: false },
      });
      expect(ports.writeAutomaticUpdatePreference).toHaveBeenCalledTimes(1);
      expect(ports.readAutomaticUpdatePreference).toHaveBeenCalledTimes(1);
      expect(ports.download).not.toHaveBeenCalled();
      expect(ports.restart).not.toHaveBeenCalled();
    },
  );

  it("isolates unreadable/refused preferences from release state", async () => {
    const { updater, ports } = preferenceFixture();
    ports.readAutomaticUpdatePreference.mockRejectedValue(
      new Error("unreadable"),
    );
    await updater.initialize();
    expect(await updater.setAutomaticUpdatePreference(true)).toEqual({
      status: "refused",
      code: "UPDATE_AUTOMATIC_PREFERENCE_UNREADABLE",
    });
    expect(ports.writeAutomaticUpdatePreference).not.toHaveBeenCalled();
    await updater.check(true);
    expect(updater.snapshot()).toMatchObject({
      phase: "available",
      automaticUpdatePreference: { status: "blocked", enabled: false },
    });

    const refused = preferenceFixture(true);
    await refused.updater.initialize();
    refused.ports.writeAutomaticUpdatePreference.mockResolvedValue({
      status: "refused",
      code: "UPDATE_AUTOMATIC_PREFERENCE_UNREADABLE",
    });
    expect(
      await refused.updater.setAutomaticUpdatePreference(false),
    ).toMatchObject({ status: "refused" });
    expect(refused.updater.automaticUpdatePreference()).toMatchObject({
      status: "blocked",
      enabled: false,
    });
  });

  it("rejects concurrent writes, projects OFF until ACK and drains the write on close", async () => {
    const { updater, ports } = preferenceFixture(true);
    let complete!: (value: { status: "confirmed"; enabled: boolean }) => void;
    ports.writeAutomaticUpdatePreference.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    expect(await updater.setAutomaticUpdatePreference(false)).toMatchObject({
      status: "refused",
    });
    await updater.initialize();
    const saving = updater.setAutomaticUpdatePreference(false);
    expect(updater.snapshot()).toMatchObject({
      automaticUpdatePreference: {
        status: "blocked",
        enabled: false,
        code: "UPDATE_AUTOMATIC_PREFERENCE_WRITING",
      },
    });
    expect(await updater.setAutomaticUpdatePreference(true)).toMatchObject({
      status: "refused",
    });
    const closed = vi.fn();
    const closing = updater.close().then(closed);
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    const published = ports.publish.mock.calls.length;
    complete({ status: "confirmed", enabled: false });
    expect(await saving).toEqual({ status: "confirmed", enabled: false });
    await closing;
    expect(ports.publish).toHaveBeenCalledTimes(published);
    expect(await updater.setAutomaticUpdatePreference(true)).toMatchObject({
      status: "refused",
    });
    expect(ports.writeAutomaticUpdatePreference).toHaveBeenCalledTimes(1);
  });

  it("retains the durable ACK when renderer publication fails", async () => {
    const { updater, ports } = preferenceFixture();
    await updater.initialize();
    ports.publish.mockImplementation(() => {
      throw new Error("destroyed renderer");
    });
    expect(await updater.setAutomaticUpdatePreference(true)).toEqual({
      status: "confirmed",
      enabled: true,
    });
    expect(updater.automaticUpdatePreference()).toEqual({
      status: "confirmed",
      enabled: true,
    });
    await updater.close();
  });
});

describe("explicit browser interruption and scoped automatic installation", () => {
  it.each([
    "UPDATE_BROWSER_STATE_UNKNOWN",
    "UPDATE_BROWSER_BUSY",
    "UPDATE_BROWSER_DRAFT",
    "UPDATE_BROWSER_OPEN",
  ])("permits version-bound confirmation after %s", async (code) => {
    const f = fixture();
    await f.updater.initialize();
    await f.updater.check(true);
    await f.updater.download();
    f.ports.restart.mockResolvedValueOnce({ status: "blocked", code });
    await f.updater.restart();
    await f.updater.restartConfirmed("0.0.0");
    expect(f.ports.restart).toHaveBeenCalledTimes(1);
    await f.updater.restartConfirmed(staged.manifest.version);
    expect(f.ports.restart).toHaveBeenLastCalledWith(staged, {
      kind: "interrupt-browser",
      version: staged.manifest.version,
    });
    expect(f.updater.snapshot().phase).toBe("applying");
  });
  it.each([
    "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
    "UPDATE_RETAINED_PACKAGE_INVALID",
  ])("does not override %s", async (code) => {
    const f = fixture();
    await f.updater.initialize();
    await f.updater.check(true);
    await f.updater.download();
    f.ports.restart.mockResolvedValueOnce({ status: "blocked", code });
    await f.updater.restart();
    await f.updater.restartConfirmed(staged.manifest.version);
    expect(f.ports.restart).toHaveBeenCalledTimes(1);
  });
  it("does not repeat an unknown installation after confirmation", async () => {
    const f = fixture();
    await f.updater.initialize();
    await f.updater.check(true);
    await f.updater.download();
    f.ports.restart.mockResolvedValueOnce({
      status: "unknown",
      code: "UPDATE_HANDOFF_UNKNOWN",
    });
    await f.updater.restartConfirmed(staged.manifest.version);
    await f.updater.restartConfirmed(staged.manifest.version);
    expect(f.ports.restart).toHaveBeenCalledTimes(1);
    expect(f.updater.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
  });
  it("requires strict version-bound wire consent", () => {
    expect(
      InstalledUpdateCommandSchema.safeParse({ kind: "restart-confirmed" })
        .success,
    ).toBe(false);
    expect(
      InstalledUpdateCommandSchema.safeParse({
        kind: "restart-confirmed",
        version: staged.manifest.version,
        force: true,
      }).success,
    ).toBe(false);
    expect(
      InstalledUpdateCommandSchema.safeParse({
        kind: "restart-confirmed",
        version: staged.manifest.version,
      }).success,
    ).toBe(true);
  });
  it("downloads and installs when the new choice is confirmed, with no interruption consent", async () => {
    const f = fixture();
    const updater = new InstalledUpdater({
      ...f.ports,
      readAutomaticUpdatePreference: async () => ({
        status: "confirmed",
        enabled: true,
        scope: "download-and-install",
      }),
    });
    await updater.initialize();
    await updater.scheduledCheck();
    expect(f.ports.download).toHaveBeenCalledTimes(1);
    expect(f.ports.restart).toHaveBeenCalledWith(staged);
  });
  it("observes idle later after a known pre-dispatch refusal, but never repeats unknown handoff", async () => {
    const f = fixture();
    const updater = new InstalledUpdater({
      ...f.ports,
      readAutomaticUpdatePreference: async () => ({
        status: "confirmed",
        enabled: true,
        scope: "download-and-install",
      }),
    });
    f.ports.restart
      .mockResolvedValueOnce({
        status: "blocked",
        code: "UPDATE_BROWSER_STATE_UNKNOWN",
      })
      .mockResolvedValueOnce({
        status: "unknown",
        code: "UPDATE_HANDOFF_UNKNOWN",
      });
    await updater.initialize();
    await updater.scheduledCheck();
    await updater.scheduledCheck();
    await updater.scheduledCheck();
    expect(f.ports.restart).toHaveBeenCalledTimes(2);
    expect(f.ports.download).toHaveBeenCalledTimes(1);
    expect(updater.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
  });
  it("explicitly postpones a ready candidate after a temporary admission refusal", async () => {
    const f = fixture();
    const updater = new InstalledUpdater({
      ...f.ports,
      readAutomaticUpdatePreference: async () => ({
        status: "confirmed",
        enabled: true,
        scope: "download-and-install",
      }),
    });
    f.ports.restart.mockResolvedValueOnce({
      status: "blocked",
      code: "UPDATE_BROWSER_DRAFT",
    });
    await updater.initialize();
    await updater.scheduledCheck();
    expect(updater.snapshot()).toMatchObject({
      phase: "ready",
      deferred: true,
      blockedBy: "UPDATE_BROWSER_DRAFT",
    });
    await updater.later();
    f.ports.restart.mockResolvedValue({ status: "accepted" });
    await updater.scheduledCheck();
    await updater.scheduledCheck();
    expect(f.ports.restart).toHaveBeenCalledTimes(1);
    expect(f.ports.download).toHaveBeenCalledTimes(1);
    expect(updater.snapshot()).toMatchObject({
      phase: "ready",
      deferred: true,
    });
  });
  it("never converts legacy download-only consent into installation consent", async () => {
    const f = fixture();
    const updater = new InstalledUpdater({
      ...f.ports,
      readAutomaticUpdatePreference: async () => ({
        status: "confirmed",
        enabled: true,
      }),
    });
    await updater.initialize();
    await updater.scheduledCheck();
    await updater.scheduledCheck();
    expect(f.ports.download).toHaveBeenCalledTimes(1);
    expect(f.ports.restart).not.toHaveBeenCalled();
  });
  it("respects Remind Me Later for this runtime", async () => {
    const f = fixture();
    const updater = new InstalledUpdater({
      ...f.ports,
      readAutomaticUpdatePreference: async () => ({
        status: "confirmed",
        enabled: true,
        scope: "download-and-install",
      }),
    });
    await updater.initialize();
    await updater.check(true);
    await updater.download();
    await updater.later();
    await updater.scheduledCheck();
    expect(f.ports.restart).not.toHaveBeenCalled();
  });
});
