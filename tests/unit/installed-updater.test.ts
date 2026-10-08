import { describe, expect, it, vi } from "vitest";
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
});
