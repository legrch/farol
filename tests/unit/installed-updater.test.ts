import { describe, expect, it, vi } from "vitest";
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
    repository: "legrch/farol-releases",
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
    recover: vi
      .fn<InstalledUpdaterPorts["recover"]>()
      .mockResolvedValue({ ok: true, update: null }),
    discover: vi
      .fn<InstalledUpdaterPorts["discover"]>()
      .mockResolvedValue({ ok: true, available: true }),
    download: vi
      .fn<InstalledUpdaterPorts["download"]>()
      .mockResolvedValue({ ok: true, update: staged }),
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
  it("downloads and persists once; Later keeps working and never restarts", async () => {
    const { updater, ports } = fixture();
    await updater.initialize();
    await updater.check();
    updater.later();
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
    const pending = updater.check();
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
    await updater.restart();
    expect(ports.download).not.toHaveBeenCalled();
    expect(ports.restart).toHaveBeenCalledWith(staged);
  });

  it("a failed retained-state write cannot expose Restart & Update", async () => {
    const { updater, ports } = fixture();
    ports.retain.mockRejectedValue(new Error("disk full"));
    await updater.initialize();
    await updater.check();
    await updater.restart();
    expect(updater.snapshot().phase).toBe("failed");
    expect(ports.restart).not.toHaveBeenCalled();
  });
});
