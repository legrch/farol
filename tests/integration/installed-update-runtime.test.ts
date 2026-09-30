import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BuildIdentitySchema } from "../../src/pkg/build-info/identity";
import type { ReleaseManifest } from "../../src/modules/release/domain/github-release-contract";

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  download: vi.fn(),
  archiveDownload: vi.fn(),
  discardArchive: vi.fn(),
  reclaimArchive: vi.fn(),
  discardPackage: vi.fn(),
  verify: vi.fn(),
  helper: vi.fn(),
  captureStart: vi.fn(),
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
    createGithubUpdateTransport: () => ({
      verifyPackage: mocks.verify,
      download: mocks.archiveDownload,
      discard: mocks.discardArchive,
      reclaimRetained: mocks.reclaimArchive,
    }),
  }),
);
vi.mock(
  "../../src/modules/release/infra/native/update-package-verifier",
  () => ({
    createUpdatePackageVerifier: () => ({ discard: mocks.discardPackage }),
  }),
);
vi.mock(
  "../../src/modules/release/infra/native/installed-update-helper",
  async (original) => ({
    ...(await original<
      typeof import("../../src/modules/release/infra/native/installed-update-helper")
    >()),
    captureInstalledProcessStart: mocks.captureStart,
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
  mocks.captureStart.mockResolvedValue("fixture-start");
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
  mocks.discardPackage.mockResolvedValue(undefined);
  mocks.discardArchive.mockResolvedValue({ ok: true, value: undefined });
  mocks.reclaimArchive.mockResolvedValue({ ok: true, value: undefined });
  mocks.archiveDownload.mockResolvedValue({
    ok: true,
    value: { handle: path.join(root, "downloaded.zip") },
  });
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
  it("bounds abandoned extraction directories before invoking a verifier or opening an archive", async () => {
    const { createUpdatePackageVerifier } = await vi.importActual<
      typeof import("../../src/modules/release/infra/native/update-package-verifier")
    >("../../src/modules/release/infra/native/update-package-verifier");
    const directory = path.join(root, "bounded-extractions");
    await fs.mkdir(directory, { mode: 0o700 });
    for (const name of [
      "farol-update-verify-abandoned1",
      "farol-update-verify-abandoned2",
    ])
      await fs.mkdir(path.join(directory, name));
    const lookup = vi.fn();
    const verifier = createUpdatePackageVerifier({
      stagingParent: directory,
      extractorPath: "/unused",
      verifierPath: "/unused",
      archivePathForHandle: lookup,
    });
    await expect(
      verifier.verifyPackage("opaque", manifest),
    ).rejects.toMatchObject({ code: "stage_capacity" });
    expect(lookup).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
    expect((await fs.readdir(directory)).sort()).toEqual([
      "farol-update-verify-abandoned1",
      "farol-update-verify-abandoned2",
    ]);
  });

  it.each(["checksum_mismatch", "package_mismatch", "wrong_provenance"])(
    "discards the owned stage before clearing a known %s failure",
    async (code) => {
      mocks.download.mockImplementation(async (_candidate, ports) => {
        await ports.download("fixture", 100);
        return { ok: false, code };
      });
      const controller = await createInstalledUpdateRuntime(options());
      await controller!.initialize();
      await controller!.check();
      const handle = path.join(root, "downloaded.zip");
      expect(mocks.discardPackage).toHaveBeenCalledExactlyOnceWith(handle);
      expect(mocks.discardArchive).toHaveBeenCalledExactlyOnceWith(handle);
      await expect(
        fs.lstat(
          path.join(userData, "installed-updates/download-pending.json"),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(controller!.snapshot()).toMatchObject({
        phase: "failed",
        code: `UPDATE_${code.toUpperCase()}`,
      });
      controller!.close();
    },
  );
  it("retains the intent and prevents redownload when rejection cleanup is unknown", async () => {
    mocks.download.mockImplementation(async (_candidate, ports) => {
      await ports.download("fixture", 100);
      return { ok: false, code: "checksum_mismatch" };
    });
    mocks.discardArchive.mockResolvedValue({
      ok: false,
      kind: "interrupted",
      certainty: "unknown",
      reason: "stage_cleanup",
    });
    const controller = await createInstalledUpdateRuntime(options());
    await controller!.initialize();
    await controller!.check();
    expect(controller!.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
      code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
    });
    await fs.access(
      path.join(userData, "installed-updates/download-pending.json"),
    );
    await controller!.check(true);
    expect(mocks.archiveDownload).toHaveBeenCalledTimes(1);
    controller!.close();
  });
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
  it("recovers the same archive if the app exits during retention cleanup", async () => {
    let entered!: () => void;
    const atCleanup = new Promise<void>((resolve) => {
      entered = resolve;
    });
    mocks.discardPackage.mockImplementationOnce(async () => {
      entered();
      // Freeze this lifetime at the crash boundary. It never resumes effects.
      await new Promise(() => undefined);
    });
    const first = await createInstalledUpdateRuntime(options());
    await first!.initialize();
    void first!.check();
    await atCleanup;
    first!.close();
    const recovered = await createInstalledUpdateRuntime(options());
    await recovered!.initialize();
    expect(recovered!.snapshot()).toMatchObject({
      phase: "ready",
      deferred: true,
    });
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith(
      path.join(root, "archive.zip"),
      manifest,
    );
    expect(mocks.helper).not.toHaveBeenCalled();
    recovered!.close();
  });
  it.each(["before-copy", "after-copy"])(
    "reconciles an interrupted %s preparation before permitting another helper",
    async (boundary) => {
      const first = await prepared();
      let entered!: () => void;
      let destination = "";
      const atCopy = new Promise<void>((resolve) => {
        entered = resolve;
      });
      mocks.copyApp.mockImplementationOnce(async (from: string, to: string) => {
        destination = to;
        if (boundary === "after-copy")
          await fs.cp(from, to, { recursive: true });
        entered();
        await new Promise(() => undefined);
      });
      void first.restart();
      await atCopy;
      first.close();
      const recorded = JSON.parse(await fs.readFile(ready, "utf8"));
      expect(recorded.preparation).toMatchObject({ source, target });
      expect(recorded.operation).toBeNull();
      const recovered = await createInstalledUpdateRuntime(options());
      await recovered!.initialize();
      expect(recovered!.snapshot()).toMatchObject({
        phase: "ready",
        deferred: true,
      });
      await expect(fs.lstat(path.dirname(destination))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        JSON.parse(await fs.readFile(ready, "utf8")).preparation,
      ).toBeUndefined();
      expect(mocks.download).toHaveBeenCalledTimes(1);
      expect(mocks.copyApp).toHaveBeenCalledTimes(1);
      expect(mocks.helper).not.toHaveBeenCalled();
      expect(quit).not.toHaveBeenCalled();
      recovered!.close();
    },
  );
  it.each(["journal", "source"])(
    "does not reclaim preparation when %s contradicts its pre-dispatch identity",
    async (conflict) => {
      const first = await prepared();
      first.close();
      const operationId = "7".repeat(32);
      const opRoot = path.join(userData, "installed-updates", operationId);
      await fs.mkdir(path.join(opRoot, "staged.app"), {
        recursive: true,
        mode: 0o700,
      });
      await fs.chmod(opRoot, 0o700);
      await fs.writeFile(path.join(opRoot, "staged.app/payload"), "keep");
      const record = JSON.parse(await fs.readFile(ready, "utf8"));
      await fs.writeFile(
        ready,
        JSON.stringify({
          ...record,
          preparation: { operationId, source, target },
        }),
      );
      if (conflict === "journal")
        await fs.writeFile(path.join(opRoot, "journal.json"), "{}", {
          mode: 0o600,
        });
      else mocks.exec.mockResolvedValue({ stdout: JSON.stringify(target) });
      const recovered = await createInstalledUpdateRuntime(options());
      await recovered!.initialize();
      expect(recovered!.snapshot()).toMatchObject({
        phase: "failed",
        recoveryRequired: true,
        code: "UPDATE_PREPARATION_UNRECONCILED",
      });
      expect(
        await fs.readFile(path.join(opRoot, "staged.app/payload"), "utf8"),
      ).toBe("keep");
      expect(mocks.verify).not.toHaveBeenCalled();
      expect(mocks.helper).not.toHaveBeenCalled();
      recovered!.close();
    },
  );
  it("reconciles an interrupted ready-record commit without downloading or sending again", async () => {
    const unlink = fs.unlink.bind(fs);
    const pending = path.join(
      userData,
      "installed-updates/download-pending.json",
    );
    vi.spyOn(fs, "unlink").mockImplementationOnce(async (file) => {
      expect(file).toBe(pending);
      throw Object.assign(new Error("fixture interrupted unlink"), {
        code: "EIO",
      });
    });
    const first = await createInstalledUpdateRuntime(options());
    await first!.initialize();
    await first!.check();
    expect(first!.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    await fs.access(ready);
    await fs.access(pending);
    vi.mocked(fs.unlink).mockImplementation(unlink);
    first!.close();
    const recovered = await createInstalledUpdateRuntime(options());
    await recovered!.initialize();
    expect(recovered!.snapshot()).toMatchObject({
      phase: "ready",
      deferred: true,
    });
    await expect(fs.lstat(pending)).rejects.toMatchObject({ code: "ENOENT" });
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(mocks.helper).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });
  it.each(["buildId", "archiveSha256"])(
    "does not reconcile a different pending %s",
    async (field) => {
      const first = await prepared();
      first.close();
      await fs.writeFile(
        path.join(userData, "installed-updates/download-pending.json"),
        JSON.stringify({
          schema: "farol.update-download-intent/1",
          buildId: manifest.buildId,
          archiveSha256: manifest.archiveSha256,
          [field]: "0".repeat(64),
        }),
        { mode: 0o600 },
      );
      const recovered = await createInstalledUpdateRuntime(options());
      await recovered!.initialize();
      expect(recovered!.snapshot()).toMatchObject({
        phase: "failed",
        recoveryRequired: true,
        code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
      });
      expect(mocks.verify).not.toHaveBeenCalled();
      expect(mocks.download).toHaveBeenCalledTimes(1);
    },
  );
  it("releases successful extraction stages on ready, restore and after copying", async () => {
    const first = await prepared();
    const handle = path.join(root, "archive.zip");
    expect(mocks.discardPackage).toHaveBeenCalledExactlyOnceWith(handle);
    first.close();
    const second = await createInstalledUpdateRuntime(options());
    await second!.initialize();
    expect(mocks.discardPackage).toHaveBeenCalledTimes(2);
    mocks.copyApp.mockImplementationOnce(async (from: string, to: string) => {
      expect(mocks.discardPackage).toHaveBeenCalledTimes(2);
      await fs.cp(from, to, { recursive: true });
    });
    mocks.helper.mockImplementationOnce(async () => {
      expect(mocks.discardPackage).toHaveBeenCalledTimes(3);
      return {
        status: "ready",
        operation: { pid: 123, completion: new Promise(() => undefined) },
      };
    });
    await second!.restart();
    expect(mocks.verify).toHaveBeenCalledTimes(2);
    expect(mocks.discardPackage).toHaveBeenCalledTimes(3);
    expect(quit).toHaveBeenCalledTimes(1);
  });
  it("preserves intent when successful extraction cleanup is uncertain", async () => {
    mocks.discardPackage.mockRejectedValue(
      new Error("fixture cleanup uncertainty"),
    );
    const first = await createInstalledUpdateRuntime(options());
    await first!.initialize();
    await first!.check();
    expect(first!.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    await fs.access(
      path.join(userData, "installed-updates/download-pending.json"),
    );
    await fs.access(ready);
    first!.close();
    const recovered = await createInstalledUpdateRuntime(options());
    await recovered!.initialize();
    await recovered!.check(true);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.helper).not.toHaveBeenCalled();
  });
  it("does not dispatch or retry after uncertain cleanup of a copied stage", async () => {
    const controller = await prepared();
    mocks.discardPackage.mockRejectedValueOnce(
      new Error("fixture cleanup uncertainty"),
    );
    await controller.restart();
    expect(controller.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
      code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
    });
    await controller.restart();
    const recovered = await createInstalledUpdateRuntime(options());
    await recovered!.initialize();
    await recovered!.restart();
    expect(recovered!.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
      code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
    });
    expect(mocks.helper).not.toHaveBeenCalled();
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
  it("retains admission when the dispatch record commits but its acknowledgment is lost", async () => {
    const first = await prepared();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (
        to === ready &&
        JSON.parse(await fs.readFile(ready, "utf8")).operation
      )
        throw new Error("fixture lost dispatch commit acknowledgment");
    });
    await first.restart();
    expect(first.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
      code: "UPDATE_HANDOFF_UNKNOWN",
    });
    expect(release).not.toHaveBeenCalled();
    expect(mocks.helper).not.toHaveBeenCalled();
    await first.restart();
    expect(mocks.copyApp).toHaveBeenCalledTimes(1);
    first.close();
    const second = await createInstalledUpdateRuntime(options());
    await second!.initialize();
    await second!.restart();
    expect(second!.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    expect(mocks.helper).not.toHaveBeenCalled();
    expect(mocks.copyApp).toHaveBeenCalledTimes(1);
    second!.close();
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
  it.each([false, true])(
    "preserves a confirmed no-spawn result through cleanup interruption=%s",
    async (interrupted) => {
      const first = await prepared();
      mocks.helper.mockResolvedValueOnce({
        status: "not_started",
        reason: "helper_spawn_failed",
        operation: {
          pid: null,
          completion: Promise.resolve({
            code: -2,
            signal: null,
            terminal: null,
            protocolError: "helper_spawn_failed",
          }),
        },
      });
      const remove = fs.rm.bind(fs);
      if (interrupted)
        vi.spyOn(fs, "rm").mockRejectedValueOnce(
          new Error("fixture cleanup interruption"),
        );
      await first.restart();
      expect(quit).not.toHaveBeenCalled();
      expect(mocks.helper).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await fs.readFile(ready, "utf8")).operation).toBeNull();
      if (interrupted) {
        expect(first.snapshot()).toMatchObject({
          phase: "failed",
          recoveryRequired: true,
        });
        expect(
          JSON.parse(await fs.readFile(ready, "utf8")).preparation,
        ).toMatchObject({ source, target });
        vi.mocked(fs.rm).mockImplementation(remove);
      } else {
        expect(first.snapshot()).toMatchObject({
          phase: "ready",
          blockedBy: "UPDATE_HELPER_NOT_STARTED",
        });
        expect(release).toHaveBeenCalledTimes(1);
      }
      first.close();
      const next = await createInstalledUpdateRuntime(options());
      await next!.initialize();
      expect(next!.snapshot()).toMatchObject({
        phase: "ready",
        deferred: true,
      });
      expect(mocks.helper).toHaveBeenCalledTimes(1);
      expect(mocks.download).toHaveBeenCalledTimes(1);
      next!.close();
    },
  );

  it("does not turn a no-PID unknown outcome into a known non-launch", async () => {
    const controller = await prepared();
    mocks.helper.mockResolvedValueOnce({
      status: "outcome_unknown",
      reason: "helper_process_error",
      operation: {
        pid: null,
        completion: Promise.resolve({
          code: -2,
          signal: null,
          terminal: null,
          protocolError: "helper_process_error",
        }),
      },
    });
    await controller.restart();
    expect(controller.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    controller.close();
    const next = await createInstalledUpdateRuntime(options());
    await next!.initialize();
    expect(next!.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    expect(mocks.helper).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    next!.close();
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
    await expect(
      fs.lstat(
        path.join(userData, "installed-updates", refusedId, "staged.app"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await fs.readFile(ready, "utf8")).operation).toBeNull();
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(userData, "installed-updates", `${refusedId}-refusal.json`),
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
  it("recovers confirmed refusal after the staged copy was removed but the final ready write failed", async () => {
    const first = await prepared();
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
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === ready && mocks.helper.mock.calls.length === 1) {
        const next = JSON.parse(await fs.readFile(from, "utf8"));
        if (next.operation === null && next.preparation === undefined)
          throw new Error(
            "fixture crash after reclamation before final ready commit",
          );
      }
      return rename(from, to);
    });
    await first.restart();
    expect(first.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    const op = mocks.helper.mock.calls[0]![1];
    await expect(
      fs.stat(
        path.join(userData, "installed-updates", op.operationId, "staged.app"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    first.close();
    vi.mocked(fs.rename).mockImplementation(rename);
    const next = await createInstalledUpdateRuntime(options());
    await next!.initialize();
    expect(next!.snapshot()).toMatchObject({ phase: "ready", deferred: true });
    expect(mocks.helper).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    expect(mocks.download).toHaveBeenCalledTimes(1);
    next!.close();
  });

  it.each(["helper", "home"])(
    "keeps a real %s preflight failure known and recoverable without spawning",
    async (failure) => {
      const first = await prepared();
      const actual = await vi.importActual<
        typeof import("../../src/modules/release/infra/native/installed-update-helper")
      >("../../src/modules/release/infra/native/installed-update-helper");
      mocks.helper.mockImplementationOnce(async (_path, request) => {
        if (failure === "home")
          vi.mocked(os.userInfo).mockReturnValueOnce({
            ...os.userInfo(),
            uid: -1,
          });
        return actual.startInstalledUpdateHelper(
          failure === "helper"
            ? path.join(root, "missing-helper.py")
            : path.join(process.cwd(), "resources/native/update_helper.py"),
          request,
        );
      });
      await first.restart();
      expect(first.snapshot()).toMatchObject({
        phase: "ready",
        blockedBy: "UPDATE_HELPER_NOT_STARTED",
      });
      expect(release).toHaveBeenCalledTimes(1);
      expect(quit).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(ready, "utf8")).operation).toBeNull();
      first.close();
      const next = await createInstalledUpdateRuntime(options());
      await next!.initialize();
      expect(next!.snapshot()).toMatchObject({
        phase: "ready",
        deferred: true,
      });
      expect(mocks.helper).toHaveBeenCalledTimes(1);
      next!.close();
    },
  );

  it("reconciles an interrupted confirmed-refusal cleanup before a later explicit attempt", async () => {
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
    const remove = fs.rm.bind(fs);
    const removal = vi
      .spyOn(fs, "rm")
      .mockImplementation(async (file, options) => {
        if (String(file).endsWith("/staged.app"))
          throw Object.assign(new Error("fixture cleanup denied"), {
            code: "EPERM",
          });
        return remove(file, options);
      });
    await controller.restart();
    expect(controller.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    expect(
      JSON.parse(await fs.readFile(ready, "utf8")).preparation,
    ).toMatchObject({ source, target });
    expect(release).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    controller.close();
    removal.mockRestore();
    const next = await createInstalledUpdateRuntime(options());
    await next!.initialize();
    expect(next!.snapshot()).toMatchObject({
      phase: "ready",
      deferred: true,
    });
    expect(mocks.helper).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    next!.close();
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
  it.each([
    "refused",
    "not_started",
    "not_started_interrupted",
    "not_started_changed",
  ])(
    "clears only a confirmed %s restore intent and preserves its original journal",
    async (scenario) => {
      const status = scenario === "refused" ? "refused" : "not_started";
      const interrupted =
        scenario.endsWith("interrupted") || scenario.endsWith("changed");
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
        status,
        reason:
          status === "refused" ? "process_identity" : "helper_spawn_failed",
        operation: {
          pid: status === "refused" ? 234 : null,
          completion: Promise.resolve({
            code: status === "refused" ? 70 : -2,
            signal: null,
            protocolError: status === "refused" ? null : "helper_spawn_failed",
            terminal:
              status === "refused"
                ? { phase: "refused", error: "process_identity" }
                : null,
          }),
        },
      });
      quit.mockClear();
      const intentPath = path.join(
        userData,
        "installed-updates/restore-pending.json",
      );
      const unlink = fs.unlink.bind(fs);
      if (interrupted)
        vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
          if (file === intentPath)
            throw new Error("fixture interrupted intent cleanup");
          return unlink(file);
        });
      await next!.restore("rollback");
      if (interrupted) {
        expect(next!.snapshot()).toMatchObject({
          phase: "failed",
          recoveryRequired: true,
        });
        expect(JSON.parse(await fs.readFile(intentPath, "utf8"))).toMatchObject(
          { notStartedAt: target, operation: op, priorPhase: journal.phase },
        );
        expect(release).not.toHaveBeenCalled();
        expect(quit).not.toHaveBeenCalled();
        next!.close();
        vi.mocked(fs.unlink).mockImplementation(unlink);
        if (scenario.endsWith("changed"))
          await fs.writeFile(
            path.join(opRoot, "journal.json"),
            JSON.stringify({ ...journal, phase: "rollback_started" }),
          );
        const recovered = await createInstalledUpdateRuntime(updatedOptions);
        await recovered!.initialize();
        expect(mocks.helper).toHaveBeenCalledTimes(2);
        if (scenario.endsWith("changed")) {
          expect(recovered!.snapshot()).toMatchObject({
            phase: "failed",
            recoveryRequired: true,
            code: "UPDATE_RECOVERY_IDENTITY_MISMATCH",
          });
          expect(
            JSON.parse(await fs.readFile(intentPath, "utf8")).notStartedAt,
          ).toEqual(target);
        } else {
          expect(recovered!.snapshot()).toMatchObject({
            phase: "idle",
            rollbackVersion: source.version,
          });
          await expect(fs.stat(intentPath)).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        recovered!.close();
        return;
      }
      expect(next!.snapshot()).toMatchObject({
        phase: "idle",
        rollbackVersion: source.version,
        blockedBy:
          status === "refused"
            ? "UPDATE_HELPER_REFUSED"
            : "UPDATE_HELPER_NOT_STARTED",
      });
      expect(release).toHaveBeenCalledTimes(1);
      expect(quit).not.toHaveBeenCalled();
      await expect(
        fs.stat(path.join(userData, "installed-updates/restore-pending.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        JSON.parse(
          await fs.readFile(path.join(opRoot, "journal.json"), "utf8"),
        ),
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
    },
  );
  it.each(["absent", "unreadable", "present"])(
    "keeps the original helper PID when start-time capture fails, then reconciles only %s",
    async (observation) => {
      const first = await prepared();
      mocks.captureStart
        .mockResolvedValueOnce("fixture-start")
        .mockRejectedValueOnce(new Error("fixture process readback failed"));
      await first.restart();
      expect(first.snapshot()).toMatchObject({
        phase: "failed",
        recoveryRequired: true,
      });
      expect(quit).not.toHaveBeenCalled();
      const record = JSON.parse(await fs.readFile(ready, "utf8"));
      expect(record.helper).toEqual({ pid: 123, processStart: null });
      expect(mocks.helper).toHaveBeenCalledTimes(1);
      first.close();
      mocks.exec.mockImplementation(async (file: string, args: string[]) => {
        if (file === "/bin/ps") {
          if (observation === "absent")
            throw { code: 1, stdout: "", stderr: "" };
          if (observation === "unreadable")
            throw { code: "EPERM", stdout: "", stderr: "" };
          return { stdout: "Wed Sep 30 04:00:00 2026", stderr: "" };
        }
        return {
          stdout: JSON.stringify(
            args[1]!.endsWith("staged.app") ? target : source,
          ),
        };
      });
      const second = await createInstalledUpdateRuntime(options());
      await second!.initialize();
      if (observation === "absent") {
        expect(second!.snapshot()).toMatchObject({
          phase: "ready",
          deferred: true,
        });
        expect(
          JSON.parse(await fs.readFile(ready, "utf8")).operation,
        ).toBeNull();
        await expect(
          fs.lstat(
            path.join(
              userData,
              "installed-updates",
              record.operation.operationId,
              "staged.app",
            ),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(second!.snapshot()).toMatchObject({
          phase: "failed",
          recoveryRequired: true,
          code: "UPDATE_HELPER_EXIT_UNCONFIRMED",
        });
        await second!.restart();
        expect(JSON.parse(await fs.readFile(ready, "utf8")).operation).toEqual(
          record.operation,
        );
      }
      expect(mocks.helper).toHaveBeenCalledTimes(1);
      expect(mocks.download).toHaveBeenCalledTimes(1);
      second!.close();
    },
  );
  it("keeps a reconciled pre-mutation exit recoverable if its cleanup is interrupted", async () => {
    const first = await prepared();
    mocks.captureStart
      .mockResolvedValueOnce("fixture-start")
      .mockRejectedValueOnce(new Error("fixture readback failed"));
    await first.restart();
    first.close();
    mocks.exec.mockImplementation(async (file: string, args: string[]) => {
      if (file === "/bin/ps") throw { code: 1, stdout: "", stderr: "" };
      return {
        stdout: JSON.stringify(
          args[1]!.endsWith("staged.app") ? target : source,
        ),
      };
    });
    const remove = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockRejectedValueOnce(
      new Error("fixture interrupted cleanup"),
    );
    const second = await createInstalledUpdateRuntime(options());
    await second!.initialize();
    expect(second!.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    expect(
      JSON.parse(await fs.readFile(ready, "utf8")).preparation,
    ).toMatchObject({ source, target });
    second!.close();
    vi.mocked(fs.rm).mockImplementation(remove);
    const third = await createInstalledUpdateRuntime(options());
    await third!.initialize();
    expect(third!.snapshot()).toMatchObject({ phase: "ready", deferred: true });
    expect(mocks.copyApp).toHaveBeenCalledTimes(1);
    expect(mocks.helper).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    third!.close();
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
    const updatedOptions = {
      ...options(),
      build: {
        ...build,
        version: manifest.version,
        buildVersion: manifest.buildVersion,
        buildId: manifest.buildId,
      },
    };
    mocks.reclaimArchive.mockResolvedValueOnce({
      ok: false,
      certainty: "unknown",
      kind: "interrupted",
      reason: "stage_cleanup",
    });
    const uncertain = await createInstalledUpdateRuntime(updatedOptions);
    await uncertain!.initialize();
    expect(uncertain!.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
      code: "UPDATE_ARCHIVE_CLEANUP_UNCONFIRMED",
    });
    await fs.access(ready);
    expect(mocks.helper).toHaveBeenCalledTimes(1);
    const next = await createInstalledUpdateRuntime(updatedOptions);
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
    expect(receipt.archiveReleased).toBe(true);
    expect(mocks.reclaimArchive).toHaveBeenCalledTimes(2);
    expect(mocks.reclaimArchive).toHaveBeenLastCalledWith(
      path.join(root, "archive.zip"),
      manifest,
    );
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
    expect(mocks.reclaimArchive).toHaveBeenCalledTimes(2);
    await expect(
      fs.stat(path.join(userData, "installed-updates/restore-pending.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
