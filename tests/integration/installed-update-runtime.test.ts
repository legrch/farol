import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BuildIdentitySchema } from "../../src/pkg/build-info/identity";
import type { ReleaseManifest } from "../../src/modules/release/domain/github-release-contract";

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  download: vi.fn(),
  verify: vi.fn(),
  helper: vi.fn(),
  exec: vi.fn(),
  copyApp: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: Object.assign((...args: unknown[]) => mocks.exec(...args), {
    [Symbol.for("nodejs.util.promisify.custom")]: (...args: unknown[]) =>
      mocks.exec(...args),
  }),
}));
vi.mock("../../src/modules/release/app/github-release", async (original) => ({
  ...(await original<
    typeof import("../../src/modules/release/app/github-release")
  >()),
  discoverGithubUpdate: mocks.discover,
  downloadAndVerifyGithubUpdate: mocks.download,
}));
vi.mock(
  "../../src/modules/release/infra/native/github-update-transport",
  () => ({
    createGithubUpdateTransport: () => ({ verifyPackage: mocks.verify }),
  }),
);
vi.mock(
  "../../src/modules/release/infra/native/installed-update-helper",
  async (original) => ({
    ...(await original<
      typeof import("../../src/modules/release/infra/native/installed-update-helper")
    >()),
    captureInstalledProcessStart: async () => "fixture-start",
    startInstalledUpdateHelper: mocks.helper,
  }),
);
import { createInstalledUpdateRuntime } from "../../src/apps/desktop/installed-update-runtime";

const manifest: ReleaseManifest = {
  schema: "farol.github-release/1",
  repository: "legrch/farol-releases",
  channel: "owner-beta",
  product: "Farol Next Preview",
  bundleId: "local.farol.next.preview",
  version: "0.1.1-owner.beta.1",
  buildVersion: "3",
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: "b".repeat(64),
  buildId: "c".repeat(64),
  artifactSha256: "d".repeat(64),
  archiveSha256: "e".repeat(64),
  archiveName: "Farol-0.1.1-owner.beta.1-darwin-arm64.zip",
  archiveSize: 100,
  platform: "darwin",
  arch: "arm64",
  signing: "unsigned",
  notarized: false,
  sourceDirty: false,
};
const build = BuildIdentitySchema.parse({
  schema: 1,
  product: "Farol Next Preview",
  bundleId: "local.farol.next.preview",
  buildId: "9".repeat(64),
  version: "0.1.0-owner.beta.1",
  updateChannel: "github-owner-beta",
  buildVersion: "2",
  builtAt: "2026-09-30T00:00:00.000Z",
  sourceCommit: "1".repeat(40),
  sourceTreeDigest: "2".repeat(64),
  sourceDirty: false,
});
let root: string;
let slot: string;
let userData: string;
let staging: string;
let ready: string;
const release = vi.fn(async () => undefined);
const quit = vi.fn();
const source = {
  digest: "f".repeat(64),
  version: build.version,
  buildId: build.buildId,
};
const target = {
  digest: manifest.artifactSha256,
  version: manifest.version,
  buildId: manifest.buildId,
};
function options() {
  return {
    directory: path.join(slot, "Contents/Resources/app"),
    userData,
    build,
    copyApp: mocks.copyApp,
    acquireAdmission: async () => ({ ok: true as const, release }),
    quit,
    publish: vi.fn(),
  };
}
async function prepared() {
  const controller = await createInstalledUpdateRuntime(options());
  expect(controller).not.toBeNull();
  await controller!.initialize();
  await controller!.check();
  expect(controller!.snapshot().phase).toBe("ready");
  return controller!;
}
beforeEach(async () => {
  vi.resetAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-update-composition-"));
  root = await fs.realpath(root);
  vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: root });
  slot = path.join(root, "Applications/Farol Next Preview.app");
  userData = path.join(root, "Library/Application Support/Farol Next Preview");
  staging = path.join(root, "verified-stage/Farol Next Preview.app");
  ready = path.join(userData, "installed-updates/ready.json");
  await fs.mkdir(slot, { recursive: true });
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(path.join(staging, "verified-payload"), "fixture");
  mocks.discover.mockResolvedValue({ ok: true, value: { manifest } });
  const identity = { ...manifest, updateChannel: "github-owner-beta" };
  mocks.download.mockResolvedValue({
    ok: true,
    value: {
      handle: path.join(root, "archive.zip"),
      manifest,
      identity,
      stagedAppPath: staging,
      stagingRoot: path.dirname(staging),
    },
  });
  mocks.verify.mockResolvedValue({
    ok: true,
    value: {
      identity,
      stagedAppPath: staging,
      stagingRoot: path.dirname(staging),
    },
  });
  mocks.exec.mockImplementation(async (_file: unknown, args: string[]) => ({
    stdout: JSON.stringify(
      args[0]!.endsWith("update-obligations.mjs")
        ? {
            drained: true,
            obligationCount: 0,
            unreadableCount: 0,
            changedCount: 0,
          }
        : source,
    ),
  }));
  mocks.copyApp.mockImplementation(
    async (source: string, destination: string) =>
      fs.cp(source, destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      }),
  );
  mocks.helper.mockResolvedValue({
    status: "ready",
    operation: {
      completion: new Promise(() => undefined),
      observe: () => ({}),
      pid: 123,
      operationId: "fixture",
    },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("installed updater composition (disposable filesystem and mocked native/GitHub ports)", () => {
  it("never enables updates for a task-run copy or redirected installed slot", async () => {
    expect(
      await createInstalledUpdateRuntime({
        ...options(),
        directory: path.join(root, "temporary/Contents/Resources/app"),
      }),
    ).toBeNull();
    expect(mocks.discover).not.toHaveBeenCalled();
  });
  it("persists the exact archive before showing ready and restores Later without another download", async () => {
    const first = await prepared();
    first.later();
    first.close();
    const retained = JSON.parse(await fs.readFile(ready, "utf8"));
    expect(retained.operation).toBeNull();
    expect(retained.manifest.buildId).toBe(manifest.buildId);
    const second = await createInstalledUpdateRuntime(options());
    await second!.initialize();
    expect(second!.snapshot()).toMatchObject({
      phase: "ready",
      deferred: true,
    });
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
  });
  it("restores an intact retained update when physical reads return short chunks", async () => {
    const first = await prepared();
    first.close();
    const open = fs.open.bind(fs);
    let reads = 0;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] !== ready) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "read")
            return (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => {
              reads++;
              return target.read(buffer, offset, Math.min(length, 7), position);
            };
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    const second = await createInstalledUpdateRuntime(options());
    await second!.initialize();
    expect(second!.snapshot()).toMatchObject({
      phase: "ready",
      deferred: true,
    });
    expect(reads).toBeGreaterThan(1);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.helper).not.toHaveBeenCalled();
  });
  it("retains an uncertain download across restart and never compensates with another download", async () => {
    mocks.download.mockRejectedValue(new Error("lost stage cleanup receipt"));
    const first = await createInstalledUpdateRuntime(options());
    await first!.initialize();
    await first!.check();
    expect(first!.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    first!.close();
    const second = await createInstalledUpdateRuntime(options());
    await second!.initialize();
    await second!.check(true);
    expect(second!.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.helper).not.toHaveBeenCalled();
  });

  it("does not launch the helper when existing work is not drained and releases admission", async () => {
    const controller = await prepared();
    mocks.exec.mockResolvedValue({
      stdout: JSON.stringify({
        drained: false,
        obligationCount: 1,
        unreadableCount: 0,
        changedCount: 0,
      }),
    });
    await controller.restart();
    expect(controller.snapshot()).toMatchObject({
      phase: "ready",
      blockedBy: "UPDATE_WORK_PENDING",
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(mocks.helper).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });
  it("reads and stages physical app bytes through raw filesystem boundaries", async () => {
    const controller = await prepared();
    await controller.restart();
    const record = JSON.parse(await fs.readFile(ready, "utf8"));
    const staged = path.join(
      userData,
      "installed-updates",
      record.operation.operationId,
      "staged.app",
    );
    expect(mocks.copyApp).toHaveBeenCalledExactlyOnceWith(staging, staged);
    expect(
      await fs.readFile(path.join(staged, "verified-payload"), "utf8"),
    ).toBe("fixture");
    for (const call of mocks.exec.mock.calls.filter(
      (call) => call[0] !== "/bin/ps",
    )) {
      expect(call[2].env).toMatchObject({
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_NO_ASAR: "1",
      });
    }
  });
  it("durably records intent before helper dispatch and quits only after exact readiness", async () => {
    const controller = await prepared();
    mocks.helper.mockImplementation(async () => {
      const retained = JSON.parse(await fs.readFile(ready, "utf8"));
      expect(retained.operation.source).toEqual(source);
      expect(retained.operation.target).toEqual(target);
      expect(quit).not.toHaveBeenCalled();
      return {
        status: "ready",
        operation: { pid: 123, completion: new Promise(() => undefined) },
      };
    });
    await controller.restart();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(controller.snapshot().phase).toBe("applying");
  });
  it("keeps a confirmed pre-readiness refusal retryable across app lifetimes", async () => {
    const controller = await prepared();
    mocks.helper.mockResolvedValueOnce({
      status: "refused",
      reason: "process_identity",
      operation: {
        pid: 123,
        completion: Promise.resolve({
          code: 70,
          signal: null,
          protocolError: null,
          terminal: { phase: "refused", error: "process_identity" },
        }),
      },
    });
    await controller.restart();
    expect(controller.snapshot()).toMatchObject({
      phase: "ready",
      blockedBy: "UPDATE_HELPER_REFUSED",
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    const refusedId = mocks.helper.mock.calls[0]![1].operationId;
    expect(JSON.parse(await fs.readFile(ready, "utf8")).operation).toBeNull();
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(userData, "installed-updates", refusedId, "refusal.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      action: "apply",
      operation: { operationId: refusedId },
      code: "process_identity",
    });
    controller.close();
    const next = await createInstalledUpdateRuntime(options());
    await next!.initialize();
    expect(next!.snapshot()).toMatchObject({ phase: "ready" });
    expect(mocks.helper).toHaveBeenCalledTimes(1);
    await next!.restart();
    expect(mocks.helper).toHaveBeenCalledTimes(2);
    expect(mocks.helper.mock.calls[1]![1].operationId).not.toBe(refusedId);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledTimes(1);
  });
  it("does not turn a refusal without terminal exit into a retry after the bounded wait", async () => {
    const controller = await prepared();
    mocks.helper.mockResolvedValue({
      status: "refused",
      reason: "process_identity",
      operation: { pid: 123, completion: new Promise(() => undefined) },
    });
    await controller.restart();
    expect(controller.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    expect(release).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(mocks.helper).toHaveBeenCalledTimes(1);
  }, 6000);

  for (const completion of [
    {
      code: 70,
      signal: null,
      protocolError: "terminal_output_invalid",
      terminal: null,
    },
    {
      code: null,
      signal: "SIGTERM",
      protocolError: null,
      terminal: { phase: "refused", error: "process_identity" },
    },
    {
      code: 70,
      signal: null,
      protocolError: null,
      terminal: { phase: "prepared", error: "process_identity" },
    },
  ]) {
    it(`retains refusal intent without an exact pre-mutation terminal result ${JSON.stringify(completion)}`, async () => {
      const controller = await prepared();
      mocks.helper.mockResolvedValue({
        status: "refused",
        reason: "process_identity",
        operation: { pid: 123, completion: Promise.resolve(completion) },
      });
      await controller.restart();
      await controller.restart();
      expect(controller.snapshot()).toMatchObject({
        phase: "failed",
        recoveryRequired: true,
      });
      expect(release).not.toHaveBeenCalled();
      expect(quit).not.toHaveBeenCalled();
      expect(mocks.helper).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(await fs.readFile(ready, "utf8")).operation,
      ).not.toBeNull();
    });
  }
  it("clears only a confirmed refused restore intent and preserves its original journal", async () => {
    const first = await prepared();
    await first.restart();
    const record = JSON.parse(await fs.readFile(ready, "utf8"));
    const op = record.operation;
    const opRoot = path.join(userData, "installed-updates", op.operationId);
    const journal = {
      schema: "farol.installed-update-journal/1",
      ...op,
      phase: "completed",
    };
    await fs.writeFile(
      path.join(opRoot, "journal.json"),
      JSON.stringify(journal),
      { mode: 0o600 },
    );
    await fs.mkdir(path.join(opRoot, "previous.app"));
    mocks.exec.mockImplementation(async (_file: unknown, args: string[]) => ({
      stdout: JSON.stringify(
        args[0]!.endsWith("update-obligations.mjs")
          ? {
              drained: true,
              obligationCount: 0,
              unreadableCount: 0,
              changedCount: 0,
            }
          : args[1]!.endsWith("previous.app")
            ? source
            : target,
      ),
    }));
    const updatedOptions = {
      ...options(),
      build: { ...build, version: target.version, buildId: target.buildId },
    };
    const next = await createInstalledUpdateRuntime(updatedOptions);
    await next!.initialize();
    mocks.helper.mockResolvedValueOnce({
      status: "refused",
      reason: "process_identity",
      operation: {
        pid: 234,
        completion: Promise.resolve({
          code: 70,
          signal: null,
          protocolError: null,
          terminal: { phase: "refused", error: "process_identity" },
        }),
      },
    });
    quit.mockClear();
    await next!.restore("rollback");
    expect(next!.snapshot()).toMatchObject({
      phase: "idle",
      rollbackVersion: source.version,
      blockedBy: "UPDATE_HELPER_REFUSED",
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    await expect(
      fs.stat(path.join(userData, "installed-updates/restore-pending.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      JSON.parse(await fs.readFile(path.join(opRoot, "journal.json"), "utf8")),
    ).toEqual(journal);
    const restarted = await createInstalledUpdateRuntime(updatedOptions);
    await restarted!.initialize();
    expect(restarted!.snapshot()).toMatchObject({
      phase: "idle",
      rollbackVersion: source.version,
    });
    expect(mocks.helper).toHaveBeenCalledTimes(2);
    await restarted!.restore("rollback");
    expect(mocks.helper).toHaveBeenCalledTimes(3);
    expect(mocks.helper.mock.calls[2]![1].operationId).toBe(op.operationId);
  });
  it("does not Quit or dispatch twice after unknown handoff, including the next app lifetime", async () => {
    const controller = await prepared();
    mocks.helper.mockResolvedValue({
      status: "outcome_unknown",
      operation: { pid: 123, completion: new Promise(() => undefined) },
    });
    await controller.restart();
    await controller.restart();
    expect(controller.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    expect(quit).not.toHaveBeenCalled();
    const second = await createInstalledUpdateRuntime(options());
    await second!.initialize();
    await second!.check(true);
    await second!.restart();
    expect(second!.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    expect(mocks.helper).toHaveBeenCalledTimes(1);
  });
  for (const crossedExchange of [false, true]) {
    it(`reconciles the interrupted exchange (${crossedExchange}) without replaying apply`, async () => {
      const first = await prepared();
      await first.restart();
      const record = JSON.parse(await fs.readFile(ready, "utf8"));
      const op = record.operation;
      const journal = path.join(
        userData,
        "installed-updates",
        op.operationId,
        "journal.json",
      );
      await fs.writeFile(
        journal,
        JSON.stringify({
          schema: "farol.installed-update-journal/1",
          ...op,
          phase: "prepared",
        }),
        { mode: 0o600 },
      );
      const current = crossedExchange ? target : source;
      mocks.exec.mockImplementation(async (_file: unknown, args: string[]) => ({
        stdout: JSON.stringify(
          args[0]!.endsWith("update-obligations.mjs")
            ? {
                drained: true,
                obligationCount: 0,
                unreadableCount: 0,
                changedCount: 0,
              }
            : args[1]!.endsWith("staged.app")
              ? crossedExchange
                ? source
                : target
              : current,
        ),
      }));
      const measured = mocks.exec.getMockImplementation()!;
      mocks.exec.mockImplementation((file: string, args: string[]) =>
        file === "/bin/ps"
          ? Promise.reject({ code: "EPERM", stdout: "", stderr: "" })
          : measured(file, args),
      );
      const unconfirmed = await createInstalledUpdateRuntime({
        ...options(),
        build: { ...build, version: current.version, buildId: current.buildId },
      });
      await unconfirmed!.initialize();
      await unconfirmed!.restore("recover");
      expect(unconfirmed!.snapshot()).toMatchObject({
        phase: "failed",
        code: "UPDATE_HELPER_EXIT_UNCONFIRMED",
      });
      expect(mocks.helper).toHaveBeenCalledTimes(1);
      mocks.exec.mockImplementation((file: string, args: string[]) =>
        file === "/bin/ps"
          ? Promise.reject({ code: 1, stdout: "", stderr: "" })
          : measured(file, args),
      );
      const next = await createInstalledUpdateRuntime({
        ...options(),
        build: { ...build, version: current.version, buildId: current.buildId },
      });
      await next!.initialize();
      expect(next!.snapshot()).toMatchObject({
        phase: "recovery",
        version: current.version,
      });
      expect(mocks.helper).toHaveBeenCalledTimes(1);
      await next!.restore("recover");
      await next!.restore("recover");
      expect(mocks.helper).toHaveBeenCalledTimes(2);
      expect(mocks.helper.mock.calls[1]![1]).toMatchObject({
        action: "recover",
        operationId: op.operationId,
        source,
        target,
        relaunch: true,
      });
      expect(mocks.copyApp).toHaveBeenCalledTimes(1);
      const same = await createInstalledUpdateRuntime({
        ...options(),
        build: { ...build, version: current.version, buildId: current.buildId },
      });
      await same!.initialize();
      await same!.restore("recover");
      expect(same!.snapshot()).toMatchObject({
        phase: "failed",
        code: "UPDATE_RESTORE_OUTCOME_UNKNOWN",
      });
      expect(mocks.helper).toHaveBeenCalledTimes(2);
    });
  }
  it("reconciles the new running build and retained predecessor against the same operation journal", async () => {
    const controller = await prepared();
    await controller.restart();
    const retained = JSON.parse(await fs.readFile(ready, "utf8"));
    const op = retained.operation;
    await fs.writeFile(
      path.join(userData, "installed-updates", op.operationId, "journal.json"),
      JSON.stringify({
        schema: "farol.installed-update-journal/1",
        ...op,
        phase: "completed",
      }),
      { mode: 0o600 },
    );
    await fs.mkdir(
      path.join(userData, "installed-updates", op.operationId, "previous.app"),
    );
    mocks.exec.mockImplementation(async (_file: unknown, args: string[]) => ({
      stdout: JSON.stringify(
        args[1]!.endsWith("previous.app") ? source : target,
      ),
    }));
    const next = await createInstalledUpdateRuntime({
      ...options(),
      build: {
        ...build,
        version: manifest.version,
        buildVersion: manifest.buildVersion,
        buildId: manifest.buildId,
      },
    });
    await next!.initialize();
    expect(next!.snapshot()).toMatchObject({
      phase: "idle",
      rollbackVersion: source.version,
    });
    await expect(fs.stat(ready)).rejects.toMatchObject({ code: "ENOENT" });
    const receipt = JSON.parse(
      await fs.readFile(
        path.join(userData, "installed-updates/last-update.json"),
        "utf8",
      ),
    );
    expect(receipt.runningBuildId).toBe(manifest.buildId);
    expect(receipt.operation.source).toEqual(source);
    expect(mocks.helper).toHaveBeenCalledTimes(1);
    mocks.exec.mockImplementation(async (_file: unknown, args: string[]) => ({
      stdout: JSON.stringify(
        args[0]!.endsWith("update-obligations.mjs")
          ? {
              drained: true,
              obligationCount: 0,
              unreadableCount: 0,
              changedCount: 0,
            }
          : args[1]!.endsWith("previous.app")
            ? source
            : target,
      ),
    }));
    await next!.restore("rollback");
    expect(mocks.helper).toHaveBeenCalledTimes(2);
    expect(mocks.helper.mock.calls[1]![1]).toMatchObject({
      action: "rollback",
      operationId: op.operationId,
      source,
      target,
      relaunch: true,
    });
    await next!.restore("rollback");
    expect(mocks.helper).toHaveBeenCalledTimes(2);
    const opRoot = path.join(userData, "installed-updates", op.operationId);
    await fs.mkdir(path.join(opRoot, "failed.app"));
    await fs.writeFile(
      path.join(opRoot, "journal.json"),
      JSON.stringify({
        schema: "farol.installed-update-journal/1",
        ...op,
        phase: "rollback_completed",
      }),
      { mode: 0o600 },
    );
    mocks.exec.mockImplementation(async (_file: unknown, args: string[]) => ({
      stdout: JSON.stringify(args[1]!.endsWith("failed.app") ? target : source),
    }));
    const rolledBack = await createInstalledUpdateRuntime(options());
    await rolledBack!.initialize();
    expect(rolledBack!.snapshot()).toMatchObject({ phase: "idle" });
    expect(rolledBack!.snapshot()).not.toHaveProperty("rollbackVersion");
    await rolledBack!.check(true);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.helper).toHaveBeenCalledTimes(2);
    await expect(
      fs.stat(path.join(userData, "installed-updates/restore-pending.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
