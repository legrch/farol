import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  acquirePromotionLease,
  releasePromotionLease,
  type PromotionLeaseHandle,
} from "../../src/apps/desktop/promotion-lease";
import { BuildIdentitySchema } from "../../src/pkg/build-info/identity";
import type { ReleaseManifest } from "../../src/modules/release/domain/github-release-contract";

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  download: vi.fn(),
  archiveDownload: vi.fn(),
  cancelPending: vi.fn(),
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
      cancelPending: mocks.cancelPending,
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
import { drainInstalledComputerWork } from "../../src/apps/desktop/installed-computer-drain";

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
    removeDirectory: (directory: string, force: boolean) =>
      fs.rm(directory, { recursive: true, force }),
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
  slot = path.join(root, "Applications/Farol.app");
  userData = path.join(root, "Library/Application Support/Farol Next Preview");
  staging = path.join(root, "verified-stage/Farol.app");
  ready = path.join(userData, "installed-updates/ready.json");
  await fs.mkdir(slot, { recursive: true });
  await fs.mkdir(userData, { recursive: true, mode: 0o700 });
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(
    slot + ".receipt.json",
    JSON.stringify({
      schema: "farol.next.promotion-plan/1",
      operation: "applied",
      product: "Farol Next Preview",
      version: build.version,
      sourceCommit: build.sourceCommit,
      sourceTreeDigest: build.sourceTreeDigest,
      sourceDirty: false,
      artifactSha256: source.digest,
      source: path.join(root, "accepted-package/Farol.app"),
      destination: slot,
      receipt: slot + ".receipt.json",
      overwrite: false,
      legacyMutation: false,
      activation: { userData, drained: true, obligations: [] },
      verifiedDestinationSha256: source.digest,
    }),
    { mode: 0o600 },
  );
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
  mocks.helper.mockImplementation(async (_path, _input, launchOptions) => {
    const operation = {
      completion: new Promise(() => undefined),
      observe: () => ({}),
      pid: 123,
      operationId: "fixture",
    };
    await launchOptions?.recordSpawn?.(operation);
    return { status: "ready", operation };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("installed updater composition (disposable filesystem and mocked native/GitHub ports)", () => {
  it.each(["before-copy", "after-copy", "observation-error"] as const)(
    "rechecks browser admission %s and never dispatches after a late refusal",
    async (boundary) => {
      const recheck = vi
        .fn()
        .mockResolvedValueOnce(
          boundary === "before-copy"
            ? { ok: false, code: "UPDATE_BROWSER_BUSY" }
            : { ok: true },
        )
        .mockImplementationOnce(async () => {
          if (boundary === "observation-error")
            throw new Error("fixture observation failed");
          return { ok: false, code: "UPDATE_BROWSER_DRAFT" };
        });
      const controller = await createInstalledUpdateRuntime({
        ...options(),
        acquireAdmission: async () => ({ ok: true, release, recheck }),
      });
      await controller!.initialize();
      await controller!.check();
      await controller!.restart();
      const code =
        boundary === "before-copy"
          ? "UPDATE_BROWSER_BUSY"
          : boundary === "after-copy"
            ? "UPDATE_BROWSER_DRAFT"
            : "UPDATE_BROWSER_STATE_UNKNOWN";
      expect(controller!.snapshot()).toMatchObject({
        phase: "ready",
        blockedBy: code,
      });
      const retained = JSON.parse(await fs.readFile(ready, "utf8"));
      expect(retained.operation).toBeNull();
      expect(retained.preparation).toBeUndefined();
      expect(mocks.helper).not.toHaveBeenCalled();
      expect(quit).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      const stateFiles = await fs.readdir(
        path.join(userData, "installed-updates"),
      );
      expect(stateFiles.some((name) => /^[a-f0-9]{32}$/u.test(name))).toBe(
        false,
      );
      if (boundary === "before-copy")
        expect(mocks.copyApp).not.toHaveBeenCalled();
      else expect(mocks.copyApp).toHaveBeenCalledOnce();
      await controller!.close();
    },
  );
  it("holds admission through helper handoff after two fresh idle observations", async () => {
    const recheck = vi.fn(async () => ({ ok: true as const }));
    const controller = await createInstalledUpdateRuntime({
      ...options(),
      acquireAdmission: async () => ({ ok: true, release, recheck }),
    });
    await controller!.initialize();
    await controller!.check();
    await controller!.restart();
    expect(recheck).toHaveBeenCalledTimes(2);
    expect(mocks.helper).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(
      JSON.parse(await fs.readFile(ready, "utf8")).operation,
    ).not.toBeNull();
    await controller!.close();
  });
  it.each([
    ["restart", "obligationCount"],
    ["rollback", "unreadableCount"],
    ["recover", "changedCount"],
  ] as const)(
    "checks durable Desktop %s obligations before stopping owned clients",
    async (action, blocker) => {
      let current = source;
      if (action !== "restart") {
        const first = await prepared();
        await first.restart();
        await first.close();
        const { operation: op } = JSON.parse(await fs.readFile(ready, "utf8"));
        const opRoot = path.join(userData, "installed-updates", op.operationId);
        if (action === "rollback") {
          current = target;
          await fs.mkdir(path.join(opRoot, "previous.app"));
        }
        await fs.writeFile(
          path.join(opRoot, "journal.json"),
          JSON.stringify({
            schema: "farol.installed-update-journal/1",
            ...op,
            phase: action === "rollback" ? "completed" : "prepared",
          }),
          { mode: 0o600 },
        );
      }
      mocks.exec.mockImplementation(async (file: string, args: string[]) => {
        if (file === "/bin/ps") throw { code: 1, stdout: "", stderr: "" };
        return {
          stdout: JSON.stringify(
            args[0]!.endsWith("update-obligations.mjs")
              ? {
                  drained: false,
                  obligationCount: 0,
                  unreadableCount: 0,
                  changedCount: 0,
                  [blocker]: 1,
                }
              : args[1]!.endsWith("previous.app")
                ? source
                : args[1]!.endsWith("staged.app")
                  ? target
                  : current,
          ),
        };
      });
      const stopOwnedClients = vi.fn(async () => undefined);
      const openTaskReader = vi.fn();
      const controller = await createInstalledUpdateRuntime({
        ...options(),
        build: { ...build, version: current.version, buildId: current.buildId },
        acquireAdmission: async (desktopWorkSettled) => {
          const drained = await drainInstalledComputerWork({
            routeConfigured: true,
            exclusive: (work) => work(),
            desktopWorkSettled,
            mutationsSettled: async () => true,
            taskKeys: async () => [],
            openTaskReader,
            stillCurrent: () => true,
            stopOwnedClients,
          });
          if (!drained.ok) {
            await release();
            return drained;
          }
          return { ok: true as const, release };
        },
      });
      await controller!.initialize();
      if (action === "restart") await controller!.check();
      mocks.helper.mockClear();
      quit.mockClear();
      release.mockClear();
      if (action === "restart") await controller!.restart();
      else await controller!.restore(action);
      expect(stopOwnedClients).not.toHaveBeenCalled();
      expect(controller!.snapshot()).toMatchObject({
        phase:
          action === "restart"
            ? "ready"
            : action === "recover"
              ? "recovery"
              : "idle",
        blockedBy: "UPDATE_WORK_PENDING",
      });
      expect(openTaskReader).not.toHaveBeenCalled();
      expect(mocks.helper).not.toHaveBeenCalled();
      expect(quit).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      await controller!.close();
    },
  );
  it.each(["apply-unknown", "apply-ready", "rollback", "recover"] as const)(
    "keeps the real promotion lease through GC after %s returns and closes",
    async (scenario) => {
      let current = source;
      if (scenario === "rollback" || scenario === "recover") {
        const first = await prepared();
        await first.restart();
        await first.close();
        const { operation: op } = JSON.parse(await fs.readFile(ready, "utf8"));
        const opRoot = path.join(userData, "installed-updates", op.operationId);
        const companion =
          scenario === "rollback" ? "previous.app" : "staged.app";
        current = scenario === "rollback" ? target : source;
        if (scenario === "rollback")
          await fs.mkdir(path.join(opRoot, companion));
        await fs.writeFile(
          path.join(opRoot, "journal.json"),
          JSON.stringify({
            schema: "farol.installed-update-journal/1",
            ...op,
            phase: scenario === "rollback" ? "completed" : "prepared",
          }),
          { mode: 0o600 },
        );
        mocks.exec.mockImplementation(async (file: string, args: string[]) => {
          if (file === "/bin/ps") throw { code: 1, stdout: "", stderr: "" };
          return {
            stdout: JSON.stringify(
              args[0]!.endsWith("update-obligations.mjs")
                ? {
                    drained: true,
                    obligationCount: 0,
                    unreadableCount: 0,
                    changedCount: 0,
                  }
                : args[1]!.endsWith(companion)
                  ? scenario === "rollback"
                    ? source
                    : target
                  : current,
            ),
          };
        });
        mocks.helper.mockResolvedValueOnce({
          status: "outcome_unknown",
          operation: { pid: 234, completion: new Promise(() => undefined) },
        });
      }
      let leaseWitness: WeakRef<PromotionLeaseHandle> | undefined;
      const controller = await createInstalledUpdateRuntime({
        ...options(),
        build: { ...build, version: current.version, buildId: current.buildId },
        acquireAdmission: async () => {
          const lease = await acquirePromotionLease(
            userData,
            current.buildId,
            "promotion",
          );
          if (!lease) return { ok: false as const, code: "FIXTURE_LEASE_HELD" };
          // No strong test reference may keep the production lease alive.
          leaseWitness = new WeakRef(lease);
          return {
            ok: true as const,
            release: () => releasePromotionLease(lease),
          };
        },
      });
      await controller!.initialize();
      if (scenario.startsWith("apply")) await controller!.check();
      if (scenario === "apply-unknown") {
        const rename = fs.rename.bind(fs);
        vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
          await rename(from, to);
          if (
            to === ready &&
            JSON.parse(await fs.readFile(ready, "utf8")).operation
          )
            throw new Error("fixture lost dispatch commit acknowledgment");
        });
      }
      setFlagsFromString("--expose_gc");
      const collect = runInNewContext("gc") as () => void;
      const probe = () =>
        spawnSync(
          process.execPath,
          [
            fileURLToPath(
              new URL("./fixtures/promotion-lease-child.mjs", import.meta.url),
            ),
            userData,
            "probe",
            "competing-promotion",
          ],
          { encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
        );
      try {
        if (scenario === "rollback" || scenario === "recover")
          await controller!.restore(scenario);
        else await controller!.restart();
        expect(controller!.snapshot()).toMatchObject(
          scenario === "apply-ready"
            ? { phase: "applying" }
            : { phase: "failed", recoveryRequired: true },
        );
        for (const closing of [false, true]) {
          if (closing) await controller!.close();
          for (let cycle = 0; cycle < 5; cycle += 1) {
            await nextTurn();
            collect();
            await nextTurn();
          }
          const competitor = probe();
          expect(competitor.error).toBeUndefined();
          expect(competitor.signal).toBeNull();
          expect(competitor.status).toBe(1);
          expect(competitor.stdout).toBe("REFUSED\n");
        }
      } finally {
        await controller!.close();
        const lease = leaseWitness?.deref();
        if (lease) await releasePromotionLease(lease);
        const afterCleanup = probe();
        expect(afterCleanup.error).toBeUndefined();
        expect(afterCleanup.signal).toBeNull();
        expect(afterCleanup.status).toBe(0);
        expect(afterCleanup.stdout).toBe("ACQUIRED\nRELEASED\n");
      }
    },
  );

  it("does not start a request when Quit races durable download allocation", async () => {
    const controller = await createInstalledUpdateRuntime(options());
    await controller!.initialize();
    const rename = fs.rename.bind(fs);
    let closing: Promise<void> | null = null;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (
        to === path.join(userData, "installed-updates/download-pending.json") &&
        !closing
      )
        closing = controller!.close();
    });
    await controller!.check();
    await closing;
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.helper).not.toHaveBeenCalled();
    await expect(
      fs.stat(path.join(userData, "installed-updates/download-pending.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["complete", "cleanup-interrupted"] as const)(
    "reconciles a crashed download as %s without another request",
    async (scenario) => {
      mocks.download.mockRejectedValue(new Error("fixture process crash"));
      const first = await createInstalledUpdateRuntime(options());
      await first!.initialize();
      await first!.check();
      await first!.close();
      const pending = path.join(
        userData,
        "installed-updates/download-pending.json",
      );
      const intent = JSON.parse(await fs.readFile(pending, "utf8"));
      const stage = intent.download
        ? path.join(
            userData,
            "installed-updates",
            `download-${intent.download.id}`,
          )
        : path.join(userData, "installed-updates", "untracked-old-stage");
      await fs.mkdir(path.join(stage, "github-updates"), { recursive: true });
      await fs.writeFile(
        path.join(stage, "github-updates/partial.zip"),
        "partial bytes",
      );
      const outside = path.join(root, "outside-stage");
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "sentinel"), "keep");
      await fs.symlink(outside, path.join(stage, "outside-link"));
      const predecessor = path.join(
        userData,
        "installed-updates",
        "older-operation",
      );
      await fs.mkdir(predecessor);
      await fs.writeFile(path.join(predecessor, "sentinel"), "rollback");
      const native = mocks.exec.getMockImplementation()!;
      mocks.exec.mockImplementation((file: string, args: string[]) => {
        if (file === "/bin/ps") throw { code: 1, stdout: "", stderr: "" };
        return native(file, args);
      });
      const unlink = fs.unlink.bind(fs);
      if (scenario === "cleanup-interrupted") {
        vi.spyOn(fs, "unlink").mockImplementationOnce(async (file) => {
          expect(file).toBe(pending);
          throw Object.assign(new Error("fixture interrupted acknowledgment"), {
            code: "EIO",
          });
        });
        const interrupted = await createInstalledUpdateRuntime(options());
        await interrupted!.initialize();
        expect(interrupted!.snapshot()).toMatchObject({
          phase: "failed",
          recoveryRequired: true,
        });
        await interrupted!.close();
        vi.mocked(fs.unlink).mockImplementation(unlink);
      }
      const recovered = await createInstalledUpdateRuntime(options());
      await recovered!.initialize();
      expect(recovered!.snapshot()).toMatchObject({
        phase: "failed",
        code: "UPDATE_DOWNLOAD_INTERRUPTED",
        recoveryRequired: false,
      });
      await expect(fs.lstat(stage)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(pending)).rejects.toMatchObject({ code: "ENOENT" });
      expect(mocks.download).toHaveBeenCalledTimes(1);
      expect(mocks.helper).not.toHaveBeenCalled();
      mocks.discover.mockClear();
      mocks.discover.mockResolvedValue({ ok: true, value: null });
      await recovered!.check(true);
      expect(recovered!.snapshot()).toMatchObject({ phase: "idle" });
      expect(mocks.discover).toHaveBeenCalledTimes(1);
      expect(mocks.download).toHaveBeenCalledTimes(1);
      expect(quit).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(outside, "sentinel"), "utf8")).toBe(
        "keep",
      );
      expect(
        await fs.readFile(path.join(predecessor, "sentinel"), "utf8"),
      ).toBe("rollback");
      await recovered!.close();
    },
  );

  it("keeps an unconfirmed native verification fenced after the producer exits", async () => {
    mocks.download.mockImplementation(async (_candidate, ports) => {
      await ports.verifyPackage(path.join(root, "archive.zip"), manifest);
      throw new Error("fixture lost verifier result");
    });
    const first = await createInstalledUpdateRuntime(options());
    await first!.initialize();
    await first!.check();
    await first!.close();
    const pending = path.join(
      userData,
      "installed-updates/download-pending.json",
    );
    const intent = JSON.parse(await fs.readFile(pending, "utf8"));
    expect(intent.download.phase).toBe("verifying");
    mocks.exec.mockRejectedValue({ code: 1, stdout: "", stderr: "" });
    const recovered = await createInstalledUpdateRuntime(options());
    await recovered!.initialize();
    await recovered!.check(true);
    expect(recovered!.snapshot()).toMatchObject({
      phase: "failed",
      recoveryRequired: true,
    });
    await fs.access(
      path.join(
        userData,
        "installed-updates",
        `download-${intent.download.id}`,
      ),
    );
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.helper).not.toHaveBeenCalled();
    await recovered!.close();
  });

  it.each([false, true])(
    "reconciles unbound allocation only when empty (contents=%s)",
    async (hasContents) => {
      mocks.download.mockRejectedValue(new Error("fixture crash"));
      const first = await createInstalledUpdateRuntime(options());
      await first!.initialize();
      await first!.check();
      await first!.close();
      const pending = path.join(
        userData,
        "installed-updates/download-pending.json",
      );
      const intent = JSON.parse(await fs.readFile(pending, "utf8"));
      const stage = path.join(
        userData,
        "installed-updates",
        `download-${intent.download.id}`,
      );
      // Model the durable first record, before the directory witness committed.
      delete intent.download.identity;
      await fs.writeFile(pending, JSON.stringify(intent), { mode: 0o600 });
      if (hasContents)
        await fs.writeFile(path.join(stage, "unclaimed"), "keep");
      mocks.exec.mockRejectedValue({ code: 1, stdout: "", stderr: "" });
      const recovered = await createInstalledUpdateRuntime(options());
      await recovered!.initialize();
      expect(recovered!.snapshot()).toMatchObject({
        phase: "failed",
        recoveryRequired: hasContents,
      });
      if (hasContents)
        expect(await fs.readFile(path.join(stage, "unclaimed"), "utf8")).toBe(
          "keep",
        );
      else
        await expect(fs.lstat(stage)).rejects.toMatchObject({ code: "ENOENT" });
      expect(mocks.download).toHaveBeenCalledTimes(1);
      expect(mocks.helper).not.toHaveBeenCalled();
      await recovered!.close();
    },
  );

  it.each(["alive", "observation-unknown", "replaced-stage"] as const)(
    "retains a crashed download when its producer or stage is %s",
    async (scenario) => {
      mocks.download.mockRejectedValue(new Error("fixture process crash"));
      const first = await createInstalledUpdateRuntime(options());
      await first!.initialize();
      await first!.check();
      await first!.close();
      const pending = path.join(
        userData,
        "installed-updates/download-pending.json",
      );
      const intent = JSON.parse(await fs.readFile(pending, "utf8"));
      expect(intent.download).toMatchObject({
        producer: { pid: process.pid, processStart: "fixture-start" },
      });
      const stage = path.join(
        userData,
        "installed-updates",
        `download-${intent.download.id}`,
      );
      if (scenario === "replaced-stage") {
        await fs.rename(stage, stage + ".original");
        await fs.mkdir(stage, { mode: 0o700 });
      }
      await fs.writeFile(path.join(stage, "sentinel"), "keep");
      const native = mocks.exec.getMockImplementation()!;
      mocks.exec.mockImplementation((file: string, args: string[]) => {
        if (file === "/bin/ps") {
          if (scenario === "replaced-stage")
            throw { code: 1, stdout: "", stderr: "" };
          if (scenario === "observation-unknown") throw { code: "EPERM" };
          return { stdout: "fixture-start", stderr: "" };
        }
        return native(file, args);
      });
      const recovered = await createInstalledUpdateRuntime(options());
      await recovered!.initialize();
      await recovered!.check(true);
      expect(recovered!.snapshot()).toMatchObject({
        phase: "failed",
        recoveryRequired: true,
      });
      expect(await fs.readFile(path.join(stage, "sentinel"), "utf8")).toBe(
        "keep",
      );
      await fs.access(pending);
      expect(mocks.download).toHaveBeenCalledTimes(1);
      expect(mocks.helper).not.toHaveBeenCalled();
      await recovered!.close();
    },
  );

  it.each(["matching", "mismatched", "missing"] as const)(
    "measures the installed plist before accepting a %s build baseline",
    async (scenario) => {
      const { createBuildIdentity } = await vi.importActual<{
        createBuildIdentity: (input: unknown) => unknown;
      }>("../../tooling/build-identity-contract.mjs");
      const app = path.join(slot, "Contents/Resources/app");
      await fs.mkdir(app, { recursive: true });
      await fs.writeFile(
        path.join(app, "build-identity.json"),
        JSON.stringify(createBuildIdentity(build)),
      );
      await fs.writeFile(
        path.join(slot, "Contents/Info.plist"),
        `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${build.bundleId}</string>
<key>CFBundleShortVersionString</key><string>${build.version.split("-", 1)[0]}</string>
${scenario === "missing" ? "" : `<key>CFBundleVersion</key><string>${scenario === "matching" ? build.buildVersion : "9"}</string>`}
</dict></plist>`,
      );
      const result = spawnSync(
        process.execPath,
        [path.resolve("tooling/update-slot.mjs"), slot],
        { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      if (scenario === "matching") {
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          version: build.version,
        });
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe("");
      }
    },
  );

  it.each([
    "accepted",
    "wrong-path",
    "changed-predecessor",
    "wrong-build",
    "unsafe-receipt",
    "missing-journal",
    "pending-journal",
    "different-journal-receipt",
    "replaced-slot",
    "replaced-predecessor",
    "missing-quarantine",
    "replaced-quarantine",
    "unsafe-container",
    "journal-only-allocate",
    "journal-only-copy",
    "journal-only-installed",
  ])(
    "binds the explicit closed-repair installed baseline (%s)",
    async (scenario) => {
      const operationId = "7".repeat(32);
      const previous = path.join(
        root,
        "Applications",
        `.farol-repair-${operationId}`,
        "previous.app",
      );
      await fs.mkdir(path.dirname(previous), { mode: 0o700 });
      await fs.mkdir(previous, { mode: 0o755 });
      if (scenario === "unsafe-container")
        await fs.chmod(path.dirname(previous), 0o755);
      const predecessor = {
        digest: "8".repeat(64),
        version: "0.0.9-owner.beta.1",
        buildId: "6".repeat(64),
      };
      const receipt = {
        schema: "farol.next.closed-repair/1",
        operationId,
        phase: "installed",
        destination: slot,
        userData,
        source: predecessor,
        target: source,
        sourceCommit: build.sourceCommit,
        sourceTreeDigest: build.sourceTreeDigest,
        sourceDirty: false,
        previous,
        quarantine: path.join(
          userData,
          `installed-updates-quarantine-${operationId}`,
        ),
        quarantined: true,
        quitDigest: "5".repeat(64),
      };
      if (scenario === "wrong-path")
        receipt.previous = path.join(root, "other.app");
      if (scenario === "wrong-build") receipt.sourceCommit = "0".repeat(40);
      await fs.writeFile(slot + ".repair.json", JSON.stringify(receipt), {
        mode: 0o600,
      });
      if (scenario === "unsafe-receipt")
        await fs.chmod(slot + ".repair.json", 0o644);
      await fs.mkdir(receipt.quarantine, { mode: 0o700 });
      await fs.writeFile(
        path.join(receipt.quarantine, "retained.bin"),
        "unknown retained bytes",
      );
      const slotStat = await fs.lstat(slot);
      const previousStat = await fs.lstat(previous);
      const quarantineStat = await fs.lstat(receipt.quarantine);
      if (scenario !== "missing-journal")
        await fs.writeFile(
          path.join(root, "Applications", ".farol-closed-repair.json"),
          JSON.stringify({
            schema: "farol.next.closed-repair-journal/1",
            phase:
              scenario === "pending-journal"
                ? "receipt_intent"
                : scenario === "journal-only-allocate"
                  ? "allocate_intent"
                  : scenario === "journal-only-copy"
                    ? "copy_intent"
                    : "installed",
            receipt:
              scenario === "different-journal-receipt"
                ? { ...receipt, quitDigest: "4".repeat(64) }
                : receipt,
            sourceInode: [previousStat.dev, previousStat.ino],
            targetInode:
              scenario === "journal-only-allocate" ||
              scenario === "journal-only-copy"
                ? null
                : [slotStat.dev, slotStat.ino],
            updatesInode: [quarantineStat.dev, quarantineStat.ino],
          }),
          { mode: 0o600 },
        );
      if (scenario.startsWith("journal-only-")) {
        await fs.unlink(slot + ".repair.json");
        // Before repair swaps the slot, the genuine normal receipt still
        // matches the running predecessor. An unresolved journal must fence it.
      }
      if (scenario === "replaced-slot" || scenario === "replaced-predecessor") {
        const changed = scenario === "replaced-slot" ? slot : previous;
        await fs.rename(changed, changed + ".saved");
        await fs.cp(changed + ".saved", changed, { recursive: true });
      }
      if (
        scenario === "missing-quarantine" ||
        scenario === "replaced-quarantine"
      ) {
        await fs.rename(receipt.quarantine, receipt.quarantine + ".saved");
        if (scenario === "replaced-quarantine")
          await fs.cp(receipt.quarantine + ".saved", receipt.quarantine, {
            recursive: true,
          });
      }
      // The old normal promotion receipt refers to the predecessor, not the repair target.
      const original = JSON.parse(
        await fs.readFile(slot + ".receipt.json", "utf8"),
      );
      await fs.writeFile(
        slot + ".receipt.json",
        JSON.stringify({
          ...original,
          artifactSha256: scenario.startsWith("journal-only-")
            ? source.digest
            : predecessor.digest,
          verifiedDestinationSha256: scenario.startsWith("journal-only-")
            ? source.digest
            : predecessor.digest,
        }),
      );
      const measured = mocks.exec.getMockImplementation()!;
      mocks.exec.mockImplementation((file: unknown, args: string[]) =>
        args[0]!.endsWith("update-slot.mjs") && args[1] === previous
          ? Promise.resolve({
              stdout: JSON.stringify(
                scenario === "changed-predecessor"
                  ? { ...predecessor, digest: "0".repeat(64) }
                  : predecessor,
              ),
            })
          : measured(file, args),
      );
      const controller = await createInstalledUpdateRuntime(options());
      await controller!.initialize();
      await controller!.check();
      if (scenario === "accepted") {
        expect(controller!.snapshot().phase).toBe("ready");
        expect(mocks.discover).toHaveBeenCalledTimes(1);
      } else {
        expect(controller!.snapshot().phase).toBe("failed");
        expect(mocks.discover).not.toHaveBeenCalled();
        expect(mocks.download).not.toHaveBeenCalled();
        expect(mocks.helper).not.toHaveBeenCalled();
      }
      await controller!.close();
    },
  );

  it.each([
    "changed-bytes",
    "missing-receipt",
    "wrong-destination",
    "writable-receipt",
    "symlink-receipt",
  ] as const)(
    "requires accepted installed bytes before discovery (%s)",
    async (scenario) => {
      const receipt = slot + ".receipt.json";
      if (scenario === "missing-receipt") await fs.unlink(receipt);
      if (scenario === "wrong-destination") {
        const data = JSON.parse(await fs.readFile(receipt, "utf8"));
        await fs.writeFile(
          receipt,
          JSON.stringify({ ...data, destination: slot + ".other" }),
        );
      }
      if (scenario === "writable-receipt") await fs.chmod(receipt, 0o644);
      if (scenario === "symlink-receipt") {
        await fs.rename(receipt, receipt + ".original");
        await fs.symlink(receipt + ".original", receipt);
      }
      if (scenario === "changed-bytes")
        mocks.exec.mockResolvedValue({
          stdout: JSON.stringify({ ...source, digest: "0".repeat(64) }),
        });
      const controller = await createInstalledUpdateRuntime(options());
      await controller!.initialize();
      await controller!.check();
      expect(controller!.snapshot()).toMatchObject({ phase: "failed" });
      expect(mocks.discover).not.toHaveBeenCalled();
      expect(mocks.download).not.toHaveBeenCalled();
      expect(mocks.helper).not.toHaveBeenCalled();
      await controller!.close();
    },
  );

  it("rechecks the accepted source after download before copying or launching a helper", async () => {
    const controller = await prepared();
    const measured = mocks.exec.getMockImplementation()!;
    mocks.exec.mockImplementation((file: unknown, args: string[]) =>
      args[0]!.endsWith("update-slot.mjs") && args[1] === slot
        ? Promise.resolve({
            stdout: JSON.stringify({ ...source, digest: "0".repeat(64) }),
          })
        : measured(file, args),
    );
    await controller.restart();
    expect(mocks.copyApp).not.toHaveBeenCalled();
    expect(mocks.helper).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(ready, "utf8")).operation).toBeNull();
    await controller.close();
  });

  it.each(["unreadable", "changed-build"] as const)(
    "refuses %s installed identity before GitHub discovery or download",
    async (scenario) => {
      const controller = await createInstalledUpdateRuntime(options());
      await controller!.initialize();
      if (scenario === "unreadable")
        mocks.exec.mockRejectedValue(new Error("UPDATE_SLOT_IDENTITY_INVALID"));
      else mocks.exec.mockResolvedValue({ stdout: JSON.stringify(target) });
      await controller!.check();
      expect(controller!.snapshot()).toMatchObject({ phase: "failed" });
      expect(mocks.discover).not.toHaveBeenCalled();
      expect(mocks.download).not.toHaveBeenCalled();
      expect(mocks.helper).not.toHaveBeenCalled();
      controller!.close();
    },
  );

  it.each(["profile", "ancestor", "update-root"] as const)(
    "refuses a symlinked %s before creating or reading updater state",
    async (kind) => {
      const outside = path.join(root, "unrelated-private-state");
      await fs.mkdir(outside, { mode: 0o700 });
      const sentinel = path.join(outside, "sentinel");
      await fs.writeFile(sentinel, "unchanged", { mode: 0o600 });
      const replaced =
        kind === "profile"
          ? userData
          : kind === "ancestor"
            ? path.dirname(userData)
            : path.join(userData, "installed-updates");
      if (kind !== "update-root")
        await fs.rename(replaced, replaced + ".original");
      if (kind === "ancestor") {
        await fs.mkdir(path.join(outside, "Farol Next Preview"), {
          mode: 0o700,
        });
      }
      await fs.symlink(outside, replaced);
      const before = await fs.readdir(outside, { recursive: true });
      const read = vi.spyOn(fs, "open");
      await expect(createInstalledUpdateRuntime(options())).rejects.toThrow(
        "UPDATE_PRIVATE_STATE_INVALID",
      );
      expect(read).not.toHaveBeenCalled();
      expect(await fs.readdir(outside, { recursive: true })).toEqual(before);
      expect(await fs.readFile(sentinel, "utf8")).toBe("unchanged");
      expect(mocks.discover).not.toHaveBeenCalled();
      expect(mocks.download).not.toHaveBeenCalled();
      expect(mocks.helper).not.toHaveBeenCalled();
    },
  );

  it.each(["completed", "cancelled"] as const)(
    "reconciles a %s download on normal Quit and recovers on the next launch",
    async (outcome) => {
      const downloaded = await mocks.download();
      let finish!: (value: unknown) => void;
      mocks.download.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const controller = await createInstalledUpdateRuntime(options());
      await controller!.initialize();
      const checking = controller!.check();
      const pending = path.join(
        userData,
        "installed-updates/download-pending.json",
      );
      await vi.waitFor(async () => {
        expect(await fs.readFile(pending, "utf8")).toContain(manifest.buildId);
        expect(finish).toBeTypeOf("function");
      });
      const closing = controller!.close();
      finish(
        outcome === "completed"
          ? downloaded
          : { ok: false, code: "archive_download_failed" },
      );
      await Promise.all([checking, closing]);
      expect(mocks.cancelPending).toHaveBeenCalledTimes(1);
      await expect(fs.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
      const restarted = await createInstalledUpdateRuntime(options());
      await restarted!.initialize();
      expect(restarted!.snapshot().phase).toBe(
        outcome === "completed" ? "ready" : "idle",
      );
      expect(mocks.helper).not.toHaveBeenCalled();
      expect(quit).not.toHaveBeenCalled();
    },
  );

  it.each(["before-commit", "after-commit", "cleanup-unknown"] as const)(
    "reconciles retention write failure %s without losing or replaying the archive",
    async (fault) => {
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (to === ready) {
          if (fault === "after-commit") await rename(from, to);
          throw new Error("fixture ready commit failure");
        }
        return rename(from, to);
      });
      if (fault === "cleanup-unknown")
        mocks.discardArchive.mockResolvedValue({
          ok: false,
          certainty: "unknown",
        });
      const first = await createInstalledUpdateRuntime(options());
      await first!.initialize();
      await first!.check();
      const state = first!.snapshot();
      vi.mocked(fs.rename).mockImplementation(rename);
      await first!.close();
      const second = await createInstalledUpdateRuntime(options());
      await second!.initialize();
      if (fault === "before-commit") {
        expect(state).toMatchObject({
          phase: "failed",
          code: "UPDATE_READY_PERSIST_FAILED",
          recoveryRequired: false,
        });
        expect(second!.snapshot().phase).toBe("idle");
        expect(mocks.discardArchive).toHaveBeenCalledExactlyOnceWith(
          path.join(root, "archive.zip"),
        );
        await expect(
          fs.stat(
            path.join(userData, "installed-updates/download-pending.json"),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(state).toMatchObject({
          phase: "failed",
          recoveryRequired: true,
        });
        expect(second!.snapshot().phase).toBe(
          fault === "after-commit" ? "ready" : "failed",
        );
        if (fault === "after-commit")
          expect(mocks.discardArchive).not.toHaveBeenCalled();
      }
      expect(mocks.download).toHaveBeenCalledTimes(1);
      expect(mocks.helper).not.toHaveBeenCalled();
      await second!.close();
    },
  );

  it("recovers the recorded helper after interruption before readiness returns", async () => {
    const first = await prepared();
    let observed!: () => void;
    const atSpawn = new Promise<void>((resolve) => {
      observed = resolve;
    });
    mocks.helper.mockImplementation(async (_path, _input, launchOptions) => {
      await launchOptions?.recordSpawn?.({
        pid: 123,
        completion: new Promise(() => undefined),
        observe: () => ({}),
      });
      observed();
      // The crashed lifetime never resumes. This mock owns no live child or I/O.
      return new Promise(() => undefined);
    });
    void first.restart();
    await atSpawn;
    const dispatched = JSON.parse(await fs.readFile(ready, "utf8"));
    expect(dispatched.helper).toEqual({
      pid: 123,
      processStart: "fixture-start",
    });
    mocks.exec.mockImplementation(async (file: string, args: string[]) => {
      if (file === "/bin/ps") throw { code: 1, stdout: "", stderr: "" };
      return {
        stdout: JSON.stringify(
          args[1]!.endsWith("staged.app") ? target : source,
        ),
      };
    });
    const second = await createInstalledUpdateRuntime(options());
    await second!.initialize();
    expect(second!.snapshot()).toMatchObject({
      phase: "ready",
      deferred: true,
    });
    expect(JSON.parse(await fs.readFile(ready, "utf8")).operation).toBeNull();
    expect(mocks.helper).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    await second!.close();
  });

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
  for (const action of ["rollback", "recover"] as const) {
    it.each([
      "absent",
      "capture-failed",
      "present",
      "unreadable",
      "capture-failed-present",
      "changed-journal",
      "changed-companion",
      "changed-installed",
      "legacy",
      "cleanup-interrupted",
    ])(
      `reconciles only an ended unchanged ${action} helper (%s)`,
      async (scenario) => {
        const first = await prepared();
        await first.restart();
        const { operation: op } = JSON.parse(await fs.readFile(ready, "utf8"));
        const opRoot = path.join(userData, "installed-updates", op.operationId);
        const journalFile = path.join(opRoot, "journal.json");
        const intentFile = path.join(
          userData,
          "installed-updates/restore-pending.json",
        );
        const current = action === "rollback" ? target : source;
        const companion = action === "rollback" ? "previous.app" : "staged.app";
        const other = action === "rollback" ? source : target;
        const journal = {
          schema: "farol.installed-update-journal/1",
          ...op,
          phase: action === "rollback" ? "completed" : "prepared",
        };
        await fs.writeFile(journalFile, JSON.stringify(journal), {
          mode: 0o600,
        });
        if (action === "rollback") await fs.mkdir(path.join(opRoot, companion));
        let restoring = false;
        let brokenCompanion = false;
        const helperStart = "Wed Sep 30 04:00:00 2026";
        mocks.exec.mockImplementation(async (file: string, args: string[]) => {
          if (file === "/bin/ps") {
            if (args[1] === "123" || !restoring)
              throw { code: 1, stdout: "", stderr: "" };
            if (scenario === "unreadable")
              throw { code: "EPERM", stdout: "", stderr: "" };
            if (scenario === "present" || scenario === "capture-failed-present")
              return { stdout: helperStart, stderr: "" };
            throw { code: 1, stdout: "", stderr: "" };
          }
          return {
            stdout: JSON.stringify(
              args[0]!.endsWith("update-obligations.mjs")
                ? {
                    drained: true,
                    obligationCount: 0,
                    unreadableCount: 0,
                    changedCount: 0,
                  }
                : args[1]!.endsWith(companion)
                  ? brokenCompanion
                    ? { ...other, digest: "0".repeat(64) }
                    : other
                  : restoring && scenario === "changed-installed"
                    ? { ...current, digest: "0".repeat(64) }
                    : current,
            ),
          };
        });
        const currentOptions = {
          ...options(),
          build: {
            ...build,
            version: current.version,
            buildId: current.buildId,
          },
        };
        const second = await createInstalledUpdateRuntime(currentOptions);
        await second!.initialize();
        expect(second!.snapshot().phase).toBe(
          action === "rollback" ? "idle" : "recovery",
        );
        mocks.helper.mockImplementationOnce(
          async (_path, _input, launchOptions) => {
            const operation = {
              pid: 234,
              operationId: op.operationId,
              completion: new Promise(() => undefined),
              observe: () => ({}),
            };
            await launchOptions?.recordSpawn?.(operation);
            return {
              status: "outcome_unknown",
              reason: "fixture_interrupted_ack",
              operation,
            };
          },
        );
        mocks.captureStart.mockImplementation(async (pid: number) => {
          if (pid === 234 && scenario.startsWith("capture-failed"))
            throw new Error("fixture readback failed");
          return pid === 234 ? helperStart : "fixture-start";
        });
        quit.mockClear();
        await second!.restore(action);
        expect(second!.snapshot()).toMatchObject({
          phase: "failed",
          recoveryRequired: true,
        });
        expect(quit).not.toHaveBeenCalled();
        await second!.close();
        restoring = true;
        if (scenario === "changed-journal")
          await fs.writeFile(
            journalFile,
            JSON.stringify({ ...journal, phase: "rollback_started" }),
          );
        brokenCompanion = scenario === "changed-companion";
        if (scenario === "legacy") {
          const {
            helper: _helper,
            installedBefore: _before,
            ...old
          } = JSON.parse(await fs.readFile(intentFile, "utf8"));
          await fs.writeFile(intentFile, JSON.stringify(old));
        }
        const unlink = fs.unlink.bind(fs);
        if (scenario === "cleanup-interrupted")
          vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
            if (file === intentFile)
              throw new Error("fixture interrupted cleanup");
            return unlink(file);
          });
        const next = await createInstalledUpdateRuntime(currentOptions);
        await next!.initialize();
        if (scenario === "absent" || scenario === "capture-failed") {
          expect(next!.snapshot()).toMatchObject(
            action === "rollback"
              ? { phase: "idle", rollbackVersion: source.version }
              : { phase: "recovery", version: source.version },
          );
          await expect(fs.stat(intentFile)).rejects.toMatchObject({
            code: "ENOENT",
          });
          const receipt = JSON.parse(
            await fs.readFile(path.join(opRoot, "restore-exit.json"), "utf8"),
          );
          expect(receipt).toMatchObject({
            action,
            operation: op,
            code: "helper_exited_without_journal_change",
            helper: {
              pid: 234,
              processStart: scenario === "capture-failed" ? null : helperStart,
            },
          });
        } else {
          expect(next!.snapshot()).toMatchObject({
            phase: "failed",
            recoveryRequired: true,
          });
          await fs.access(intentFile);
          await next!.restore(action);
        }
        expect(mocks.helper).toHaveBeenCalledTimes(2);
        expect(mocks.download).toHaveBeenCalledTimes(1);
        expect(mocks.copyApp).toHaveBeenCalledTimes(1);
        if (scenario === "absent" || scenario === "capture-failed") {
          // Readback itself launches nothing; one explicit action may now use
          // the reconciled operation, and another click cannot dispatch twice.
          await next!.restore(action);
          await next!.restore(action);
          expect(mocks.helper).toHaveBeenCalledTimes(3);
          expect(mocks.helper.mock.calls[2]![1].operationId).toBe(
            op.operationId,
          );
        }
        await next!.close();
        if (scenario === "cleanup-interrupted") {
          vi.mocked(fs.unlink).mockImplementation(unlink);
          const retryReadback =
            await createInstalledUpdateRuntime(currentOptions);
          await retryReadback!.initialize();
          expect(retryReadback!.snapshot().phase).toBe(
            action === "rollback" ? "idle" : "recovery",
          );
          expect(mocks.helper).toHaveBeenCalledTimes(2);
          await retryReadback!.close();
        }
      },
    );
  }

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
  it.each([
    "corrupt",
    "replaced",
    "alive",
    "missing-witness",
    "interrupted",
    "mismatched-witness",
    "unexpected-predecessor",
  ] as const)(
    "reconciles a protective rollback only with its terminal rejected-directory witness (%s)",
    async (scenario) => {
      const first = await prepared();
      await first.restart();
      await first.close();
      const { operation: op } = JSON.parse(await fs.readFile(ready, "utf8"));
      const opRoot = path.join(userData, "installed-updates", op.operationId);
      const rejected = path.join(opRoot, "failed.app");
      await fs.rename(path.join(opRoot, "staged.app"), rejected);
      await fs.writeFile(path.join(rejected, "verified-payload"), "corrupt");
      const metadata = await fs.lstat(rejected, { bigint: true });
      await fs.writeFile(
        path.join(opRoot, "journal.json"),
        JSON.stringify({
          schema: "farol.installed-update-journal/1",
          ...op,
          phase:
            scenario === "interrupted" ? "rollback_started" : "rolled_back",
        }),
        { mode: 0o600 },
      );
      if (scenario !== "missing-witness")
        await fs.writeFile(
          path.join(opRoot, "rejected-target.json"),
          JSON.stringify({
            schema: "farol.rejected-update-target/1",
            ...op,
            ...(scenario === "mismatched-witness"
              ? { operationId: "b".repeat(32) }
              : {}),
            directoryIdentity: {
              device: String(metadata.dev),
              inode: String(metadata.ino),
            },
          }),
          { mode: 0o600 },
        );
      if (scenario === "unexpected-predecessor")
        await fs.mkdir(path.join(opRoot, "previous.app"));
      if (scenario === "replaced") {
        await fs.rename(rejected, rejected + ".original");
        await fs.mkdir(rejected);
        await fs.writeFile(
          path.join(rejected, "verified-payload"),
          "replacement",
        );
      }
      const measured = mocks.exec.getMockImplementation()!;
      mocks.exec.mockImplementation((file: string, args: string[]) => {
        if (file === "/bin/ps") {
          if (scenario === "alive")
            return Promise.resolve({ stdout: "fixture-start", stderr: "" });
          return Promise.reject({ code: 1, stdout: "", stderr: "" });
        }
        if (args[1] === rejected)
          throw new Error("Rejected target is not an accepted build");
        return measured(file, args);
      });
      const next = await createInstalledUpdateRuntime(options());
      await next!.initialize();
      if (scenario === "corrupt") {
        expect(next!.snapshot()).toMatchObject({ phase: "idle" });
        expect(
          mocks.exec.mock.calls.some((call) => call[1]?.[1] === rejected),
        ).toBe(false);
      } else {
        expect(next!.snapshot()).toMatchObject({
          phase: "failed",
          recoveryRequired: true,
        });
        await fs.access(ready);
        expect(mocks.reclaimArchive).not.toHaveBeenCalled();
      }
      await next!.check(true);
      await next!.restore("recover");
      expect(mocks.download).toHaveBeenCalledTimes(1);
      expect(mocks.helper).toHaveBeenCalledTimes(1);
      expect(
        await fs.readFile(path.join(rejected, "verified-payload"), "utf8"),
      ).toBe(scenario === "replaced" ? "replacement" : "corrupt");
      await next!.close();
    },
  );

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
      // The second restore outcome is still unknown: do not give its PID an
      // absent-process witness merely because the original apply helper ended.
      mocks.exec.mockImplementation((file: string, args: string[]) =>
        file === "/bin/ps"
          ? Promise.reject({ code: "EPERM", stdout: "", stderr: "" })
          : measured(file, args),
      );
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
    // N+1 uses the settled update receipt, not N's original promotion digest.
    mocks.discover.mockResolvedValueOnce({ ok: true, value: null });
    await next!.check(true);
    expect(next!.snapshot()).toMatchObject({
      phase: "idle",
      rollbackVersion: source.version,
    });
    expect(mocks.discover).toHaveBeenCalledTimes(2);
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
