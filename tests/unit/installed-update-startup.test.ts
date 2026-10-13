import { installedSlotBindingBytes } from "../../src/modules/release/infra/native/installed-update-helper";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const captureMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/apps/desktop/installed-execution-snapshot", () => ({
  captureInstalledExecutionSnapshot: captureMock,
}));
import fs from "node:fs/promises";
import {
  waitForInstalledUpdateRelaunch,
  type InstalledUpdateRelaunchOptions,
} from "../../src/apps/desktop/installed-update-runtime";
import {
  BuildIdentitySchema,
  canonicalBuildIdentityPayload,
} from "../../src/pkg/build-info/identity";

// Pure read/clock fixtures: no filesystem, native process, lease or app launch.
const home = "/Users/farol-startup-fixture";
const profile = path.join(
  home,
  "Library/Application Support/Farol Next Preview",
);
const slot = path.join(home, "Applications/Farol.app");
const directory = path.join(slot, "Contents/Resources/app");
const root = path.join(profile, "installed-updates");
const operationId = "a".repeat(32);
const opRoot = path.join(root, operationId);
const helper = { pid: 1234, processStart: "Tue Oct  6 12:00:00 2026" };
const prefix = "--farol-installed-update-relaunch=";

function identity(version: string, buildVersion: string, commit: string) {
  const build = BuildIdentitySchema.parse({
    schema: 1,
    product: "Farol Next Preview",
    bundleId: "local.farol.next.preview",
    updateChannel: "github-owner-beta",
    version,
    buildVersion,
    builtAt: "2026-10-06T00:00:00.000Z",
    sourceCommit: commit.repeat(40),
    sourceTreeDigest: commit.repeat(64),
    sourceDirty: false,
    buildId: "0".repeat(64),
  });
  build.buildId = createHash("sha256")
    .update(canonicalBuildIdentityPayload(build))
    .digest("hex");
  return build;
}
const sourceBuild = identity("0.1.0-owner.beta.1", "1", "1");
const targetBuild = identity("0.1.1-owner.beta.1", "2", "2");
const source = {
  digest: "3".repeat(64),
  version: sourceBuild.version,
  buildId: sourceBuild.buildId,
};
const target = {
  digest: "4".repeat(64),
  version: targetBuild.version,
  buildId: targetBuild.buildId,
};
const operation = { operationId, source, target };
type Phase = "completed" | "cancel_completed" | "rollback_completed";
type Action = "apply" | "recover" | "rollback";

function fixture(phase: Phase = "completed", action: Action = "apply") {
  const build = phase === "completed" ? targetBuild : sourceBuild;
  const hint = {
    operationId,
    action,
    phase,
    helper: { ...helper },
    buildId: build.buildId,
  };
  const receiptFile = path.join(
    root,
    action === "apply" ? "ready.json" : "restore-pending.json",
  );
  const receipt: Record<string, unknown> =
    action === "apply"
      ? {
          schema: "farol.ready-update/1",
          handle: "/private/retained.zip",
          manifest: {},
          operation,
          helper: { ...helper },
        }
      : {
          schema: "farol.update-restore-intent/1",
          action,
          operation,
          priorPhase: action === "rollback" ? "completed" : "prepared",
          installedBefore: source,
          helper: { ...helper },
        };
  const journal: Record<string, unknown> = {
    schema: "farol.installed-update-journal/1",
    ...operation,
    phase,
  };
  const companion =
    phase === "completed"
      ? "previous.app"
      : phase === "cancel_completed"
        ? "staged.app"
        : "failed.app";
  const companionPath = path.join(opRoot, companion);
  const records = new Map<string, unknown>([
    [receiptFile, receipt],
    [path.join(opRoot, "journal.json"), journal],
    [
      path.join(opRoot, "slot-binding.json"),
      JSON.parse(installedSlotBindingBytes(operation, "legacy").toString()),
    ],
    [path.join(directory, "build-identity.json"), build],
  ]);
  const builds = new Map<string, unknown>([
    [slot, phase === "completed" ? target : source],
    [companionPath, phase === "completed" ? source : target],
  ]);
  let time = 0;
  const events: string[] = [];
  const transitions: (() => void)[] = [];
  const rejectedMetadata = {
    dev: 7n,
    ino: 8n,
    uid: 501n,
    mode: 0o700n,
    isDirectory: () => true,
  };
  const rejectedHandle = {
    stat: vi.fn(async () => ({ ...rejectedMetadata })),
    close: vi.fn(async () => undefined),
  };
  const observation = {
    canonicalOwnedDirectory: vi.fn(
      async (_file: string, _privateMode: boolean) => undefined,
    ),
    readRecord: vi.fn(
      async (
        file: string,
        _privateMode?: boolean,
        observeDigest?: (digest: string) => void,
      ) => {
        events.push("record:" + path.basename(file));
        const value = structuredClone(records.get(file) ?? null);
        if (value !== null)
          observeDigest?.(
            createHash("sha256")
              .update(JSON.stringify(value) + "\n")
              .digest("hex"),
          );
        return value;
      },
    ),
    readBuild: vi.fn(
      async (_directory: string, file: string, _timeoutMs: number) =>
        structuredClone(builds.get(file)),
    ),
    readProcess: vi.fn(
      async (_pid: number): Promise<{ stdout: string; stderr: string }> => {
        events.push("process");
        throw { code: 1, stdout: "", stderr: "" };
      },
    ),
    rejectedDirectory: {
      openDirectory: vi.fn(async (_file: string) => rejectedHandle),
      lstat: vi.fn(async (file: string) => {
        if (file !== path.join(opRoot, "failed.app")) throw { code: "ENOENT" };
        return { ...rejectedMetadata };
      }),
    },
  };
  const options: InstalledUpdateRelaunchOptions = {
    args: [prefix + JSON.stringify(hint)],
    directory,
    userData: profile,
    build,
    observation,
    timeoutMs: 100,
    intervalMs: 10,
    now: () => time,
    pause: vi.fn(async (ms: number) => {
      events.push("pause");
      time += ms;
      transitions.shift()?.();
    }),
  };
  const withHint = (value: unknown) => ({
    ...options,
    args: [prefix + JSON.stringify(value)],
  });
  return {
    options,
    observation,
    records,
    builds,
    receipt,
    receiptFile,
    journal,
    hint,
    withHint,
    events,
    transitions,
    companionPath,
    rejectedMetadata,
    rejectedHandle,
  };
}

function forwardRecoveryFixture(
  sourceVersion = "0.2.0-owner.beta.11",
  targetVersion = "0.2.0-owner.beta.12",
) {
  const f = fixture("completed", "recover");
  const predecessor = identity(sourceVersion, "25", "5");
  const current = identity(targetVersion, "26", "6");
  const pair = {
    operationId,
    source: {
      digest: "7".repeat(64),
      version: predecessor.version,
      buildId: predecessor.buildId,
    },
    target: {
      digest: "8".repeat(64),
      version: current.version,
      buildId: current.buildId,
    },
  };
  f.receipt.operation = pair;
  f.records.set(
    path.join(opRoot, "slot-binding.json"),
    JSON.parse(installedSlotBindingBytes(pair, "legacy").toString()),
  );
  f.receipt.priorPhase = "rollback_started";
  f.receipt.installedBefore = pair.target;
  Object.assign(f.journal, pair);
  f.hint.buildId = current.buildId;
  const options = {
    ...f.options,
    build: current,
    args: [prefix + JSON.stringify(f.hint)],
  };
  f.records.set(path.join(directory, "build-identity.json"), current);
  f.builds.set(slot, pair.target);
  f.builds.set(f.companionPath, pair.source);
  return { ...f, options, pair };
}

function rejectedFixture() {
  const f = fixture("rollback_completed", "recover");
  f.receipt.priorPhase = "rolled_back";
  const proof = {
    schema: "farol.rejected-update-target/1",
    ...operation,
    directoryIdentity: { device: "7", inode: "8" },
  };
  const proofFile = path.join(opRoot, "rejected-target.json");
  f.records.set(proofFile, proof);
  f.observation.readBuild.mockImplementation(async (_directory, file) => {
    if (file === f.companionPath) throw new Error("REJECTED_VERIFIER_EXECUTED");
    return structuredClone(f.builds.get(file));
  });
  return { ...f, proof, proofFile };
}

beforeEach(() => {
  captureMock.mockReset();
  vi.spyOn(process, "getuid").mockReturnValue(501);
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "fixture",
    uid: 501,
    gid: 20,
    homedir: home,
    shell: "/bin/zsh",
  });
});
afterEach(() => vi.restoreAllMocks());

describe("installed updater startup correlation (pure ports only)", () => {
  it("authenticates ordinary shared startup resources before Go can use them", async () => {
    const f = fixture();
    f.records.delete(f.receiptFile);
    f.records.set("/Applications/Farol.app.receipt.json", {
      schema: "farol.next.promotion-plan/1",
      operation: "applied",
      product: "Farol Next Preview",
      version: targetBuild.version,
      sourceCommit: targetBuild.sourceCommit,
      sourceTreeDigest: targetBuild.sourceTreeDigest,
      sourceDirty: false,
      artifactSha256: target.digest,
      verifiedDestinationSha256: target.digest,
      source: "/qualified/Farol.app",
      destination: "/Applications/Farol.app",
      receipt: "/Applications/Farol.app.receipt.json",
      overwrite: false,
      legacyMutation: false,
      activation: { userData: profile, drained: true, obligations: [] },
    });
    const recheck = vi.fn().mockResolvedValue(undefined);
    captureMock.mockResolvedValue({
      app: "/owner-private/Farol.app",
      directory: "/owner-private/Farol.app/Contents/Resources/app",
      executable: "/owner-private/Electron",
      digest: target.digest,
      recheck,
    });
    const guard = await waitForInstalledUpdateRelaunch({
      ...f.options,
      args: [],
      directory: "/Applications/Farol.app/Contents/Resources/app",
      physicalFiles: fs,
      copyApp: vi.fn().mockResolvedValue(undefined),
    });
    expect(guard!.resourcesOrigin).toMatchObject({
      kind: "shared-slot",
      app: "/Applications/Farol.app",
      execution: {
        directory: "/owner-private/Farol.app/Contents/Resources/app",
      },
    });
    expect(captureMock.mock.calls[0]![0]).toMatchObject({
      sourceApp: "/Applications/Farol.app",
      expectedDigest: target.digest,
    });
    await guard!.recheck();
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(f.observation.readProcess).not.toHaveBeenCalled();
  });
  function sharedRollbackFixture() {
    const f = fixture("rollback_completed", "rollback");
    f.records.set(
      path.join(opRoot, "slot-binding.json"),
      JSON.parse(installedSlotBindingBytes(operation, "shared").toString()),
    );
    f.records.set(path.join(opRoot, "journal.json"), {
      schema: "farol.installed-update-journal/1",
      ...operation,
      phase: "rolled_back",
    });
    f.records.set(path.join(root, "restore-pending.json"), {
      ...f.receipt,
      installedBefore: target,
    });
    f.records.set(path.join(root, "last-update.json"), {
      schema: "farol.ready-update/1",
      handle: "/private/retained.zip",
      operation,
      helper: { ...helper },
      observedAt: "2026-10-06T13:00:00.000Z",
      phase: "completed",
      runningBuildId: target.buildId,
      manifest: {
        schema: "farol.github-release/1",
        repository: "legrch/farol",
        channel: "owner-beta",
        product: "Farol Next Preview",
        bundleId: "local.farol.next.preview",
        version: targetBuild.version,
        buildVersion: targetBuild.buildVersion,
        sourceCommit: targetBuild.sourceCommit,
        sourceTreeDigest: targetBuild.sourceTreeDigest,
        buildId: targetBuild.buildId,
        artifactSha256: target.digest,
        archiveSha256: "a".repeat(64),
        archiveName: "Farol-" + targetBuild.version + "-darwin-arm64.zip",
        archiveSize: 100,
        platform: "darwin",
        arch: "arm64",
        signing: "unsigned",
        notarized: false,
        sourceDirty: false,
      },
    });
    captureMock.mockResolvedValue({
      app: "/owner-private/Farol.app",
      directory: "/owner-private/resources",
      executable: "/owner-private/Electron",
      digest: source.digest,
      recheck: vi.fn().mockResolvedValue(undefined),
    });
    return {
      ...f,
      options: {
        ...f.options,
        args: [],
        directory: "/Applications/Farol.app/Contents/Resources/app",
        physicalFiles: fs,
        copyApp: vi.fn().mockResolvedValue(undefined),
      },
    };
  }

  it("authenticates no-hint shared startup after terminal rollback before receipt reconciliation", async () => {
    const f = sharedRollbackFixture();
    const before = structuredClone(
      f.records.get(path.join(root, "last-update.json")),
    );
    const guard = await waitForInstalledUpdateRelaunch(f.options);
    expect(guard!.resourcesOrigin?.kind).toBe("shared-slot");
    expect(captureMock.mock.calls[0]![0].expectedDigest).toBe(source.digest);
    expect(f.records.get(path.join(root, "last-update.json"))).toEqual(before);
    expect(f.observation.readBuild).not.toHaveBeenCalled();
  });

  it.each([
    "missing-intent",
    "different-operation",
    "not-started",
    "wrong-before",
    "nonterminal-journal",
    "live-helper",
    "unknown-helper",
    "wrong-saved-build",
  ])(
    "refuses no-hint restored startup with unconfirmed rollback: %s",
    async (variant) => {
      const f = sharedRollbackFixture();
      const intent = f.records.get(
        path.join(root, "restore-pending.json"),
      ) as Record<string, unknown>;
      if (variant === "missing-intent")
        f.records.delete(path.join(root, "restore-pending.json"));
      if (variant === "different-operation")
        intent.operation = { ...operation, operationId: "b".repeat(32) };
      if (variant === "not-started") intent.notStartedAt = source;
      if (variant === "wrong-before") intent.installedBefore = source;
      if (variant === "nonterminal-journal")
        (
          f.records.get(path.join(opRoot, "journal.json")) as Record<
            string,
            unknown
          >
        ).phase = "rollback_started";
      if (variant === "live-helper")
        f.observation.readProcess.mockResolvedValue({
          stdout: helper.processStart + "\n",
          stderr: "",
        });
      if (variant === "wrong-saved-build")
        (
          f.records.get(path.join(root, "last-update.json")) as Record<
            string,
            unknown
          >
        ).runningBuildId = "f".repeat(64);
      if (variant === "unknown-helper")
        f.observation.readProcess.mockRejectedValue({
          code: 2,
          stdout: "",
          stderr: "refused",
        });
      await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow();
      expect(captureMock).not.toHaveBeenCalled();
    },
  );

  it("refuses ordinary shared startup before capture without an independent baseline", async () => {
    const f = fixture();
    f.records.delete(f.receiptFile);
    await expect(
      waitForInstalledUpdateRelaunch({
        ...f.options,
        args: [],
        directory: "/Applications/Farol.app/Contents/Resources/app",
        physicalFiles: fs,
        copyApp: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow();
    expect(captureMock).not.toHaveBeenCalled();
  });
  it("carries an accepted public shared relaunch hint into immutable backend resources", async () => {
    const f = fixture();
    const publicDirectory = "/Applications/Farol.app/Contents/Resources/app";
    f.records.set(
      path.join(opRoot, "slot-binding.json"),
      JSON.parse(installedSlotBindingBytes(operation, "shared").toString()),
    );
    f.records.set(
      path.join(publicDirectory, "build-identity.json"),
      targetBuild,
    );
    f.builds.set("/Applications/Farol.app", target);
    const recheck = vi.fn().mockResolvedValue(undefined);
    captureMock.mockResolvedValue({
      app: "/owner-private/Farol.app",
      directory: "/owner-private/Farol.app/Contents/Resources/app",
      executable: "/owner-private/Electron",
      digest: target.digest,
      recheck,
    });
    const guard = await waitForInstalledUpdateRelaunch({
      ...f.options,
      directory: publicDirectory,
      physicalFiles: fs,
      copyApp: vi.fn().mockResolvedValue(undefined),
    });
    expect(guard!.resourcesOrigin).toMatchObject({
      kind: "shared-slot",
      app: "/Applications/Farol.app",
      execution: {
        directory: "/owner-private/Farol.app/Contents/Resources/app",
      },
    });
    expect(captureMock.mock.calls[0]![0]).toMatchObject({
      sourceApp: "/Applications/Farol.app",
      expectedDigest: target.digest,
    });
  });
  it("carries a correlated private shared launch into updater execution after Ready is consumed", async () => {
    const f = fixture();
    const privateApp = path.join(opRoot, "launch-Farol.app");
    const privateDirectory = path.join(privateApp, "Contents/Resources/app");
    f.records.set(
      path.join(opRoot, "slot-binding.json"),
      JSON.parse(installedSlotBindingBytes(operation, "shared").toString()),
    );
    f.records.set(
      path.join(privateDirectory, "build-identity.json"),
      targetBuild,
    );
    f.builds.set("/Applications/Farol.app", target);
    const recheck = vi.fn().mockResolvedValue(undefined);
    captureMock.mockResolvedValue({
      app: "/fixture-private/image",
      directory: "/fixture-private/resources",
      executable: "/fixture-private/executable",
      digest: target.digest,
      recheck,
    });
    const guard = await waitForInstalledUpdateRelaunch({
      ...f.options,
      directory: privateDirectory,
      physicalFiles: fs,
      copyApp: vi.fn().mockResolvedValue(undefined),
    });
    expect(guard!.resourcesOrigin).toMatchObject({
      slot: "/Applications/Farol.app",
      app: privateApp,
      operationId,
    });
    expect(captureMock.mock.calls[0]![0]).toMatchObject({
      sourceApp: privateApp,
      expectedDigest: target.digest,
    });
    f.records.delete(f.receiptFile);
    await guard!.resourcesOrigin!.recheck();
    expect(recheck).toHaveBeenCalledTimes(1);
    f.records.set(
      path.join(opRoot, "slot-binding.json"),
      JSON.parse(installedSlotBindingBytes(operation, "legacy").toString()),
    );
    await expect(guard!.resourcesOrigin!.recheck()).rejects.toThrow(
      "UPDATE_SLOT_BINDING_UNCONFIRMED",
    );
  });
  it("reopens a settled private target without repeating the original helper hint", async () => {
    const f = fixture();
    const privateApp = path.join(opRoot, "launch-Farol.app");
    f.records.set(
      path.join(opRoot, "slot-binding.json"),
      JSON.parse(installedSlotBindingBytes(operation, "shared").toString()),
    );
    f.records.set(path.join(root, "last-update.json"), {
      ...f.receipt,
      operation,
      observedAt: "2026-10-06T13:00:00.000Z",
      phase: "completed",
      runningBuildId: targetBuild.buildId,
      manifest: {
        schema: "farol.github-release/1",
        repository: "legrch/farol",
        channel: "owner-beta",
        product: "Farol Next Preview",
        bundleId: "local.farol.next.preview",
        version: targetBuild.version,
        buildVersion: targetBuild.buildVersion,
        sourceCommit: targetBuild.sourceCommit,
        sourceTreeDigest: targetBuild.sourceTreeDigest,
        buildId: targetBuild.buildId,
        artifactSha256: target.digest,
        archiveSha256: "a".repeat(64),
        archiveName: "Farol-" + targetBuild.version + "-darwin-arm64.zip",
        archiveSize: 100,
        platform: "darwin",
        arch: "arm64",
        signing: "unsigned",
        notarized: false,
        sourceDirty: false,
      },
    });
    f.records.delete(f.receiptFile);
    f.builds.set("/Applications/Farol.app", target);
    const recheck = vi.fn().mockResolvedValue(undefined);
    captureMock.mockResolvedValue({
      app: "/fixture-private/image",
      directory: "/fixture-private/resources",
      executable: "/fixture-private/executable",
      digest: target.digest,
      recheck,
    });
    const guard = await waitForInstalledUpdateRelaunch({
      ...f.options,
      args: [],
      directory: path.join(privateApp, "Contents/Resources/app"),
      physicalFiles: fs,
      copyApp: vi.fn().mockResolvedValue(undefined),
    });
    expect(guard!.resourcesOrigin!.app).toBe(privateApp);
    await guard!.recheck();
    expect(f.observation.readProcess).not.toHaveBeenCalled();
    expect(f.options.pause).not.toHaveBeenCalled();
    expect(captureMock).toHaveBeenCalledTimes(1);
  });
  it("refuses normal private reopen without a settled current receipt", async () => {
    const f = fixture();
    f.records.set(
      path.join(opRoot, "slot-binding.json"),
      JSON.parse(installedSlotBindingBytes(operation, "shared").toString()),
    );
    await expect(
      waitForInstalledUpdateRelaunch({
        ...f.options,
        args: [],
        directory: path.join(opRoot, "launch-Farol.app/Contents/Resources/app"),
        physicalFiles: fs,
        copyApp: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow();
    expect(captureMock).not.toHaveBeenCalled();
    expect(f.observation.readProcess).not.toHaveBeenCalled();
  });
  it("rejects a private launch bound to the legacy slot before capture", async () => {
    const f = fixture();
    await expect(
      waitForInstalledUpdateRelaunch({
        ...f.options,
        directory: path.join(opRoot, "launch-Farol.app/Contents/Resources/app"),
        physicalFiles: fs,
        copyApp: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow("UPDATE_SLOT_BINDING_UNCONFIRMED");
    expect(captureMock).not.toHaveBeenCalled();
  });
  it("admits the healthy source with exact rejected-corrupt proof without verifying rejected bytes", async () => {
    const f = rejectedFixture();
    const admission = await waitForInstalledUpdateRelaunch(f.options);
    expect(admission).not.toBeNull();
    await admission!.recheck();
    expect(
      f.observation.readBuild.mock.calls.every((call) => call[1] === slot),
    ).toBe(true);
    expect(f.rejectedHandle.close).toHaveBeenCalledTimes(2);
  });

  it("waits for the current recovery helper to end before accepting rejected proof", async () => {
    const f = rejectedFixture();
    f.journal.phase = "rollback_launch_requested";
    f.observation.readProcess.mockResolvedValue({
      stdout: helper.processStart,
      stderr: "",
    });
    f.transitions.push(() => {
      expect(f.observation.readBuild).not.toHaveBeenCalled();
      expect(
        f.observation.rejectedDirectory.openDirectory,
      ).not.toHaveBeenCalled();
      f.journal.phase = "rollback_completed";
      f.observation.readProcess.mockRejectedValue({
        code: 1,
        stdout: "",
        stderr: "",
      });
    });
    expect(await waitForInstalledUpdateRelaunch(f.options)).not.toBeNull();
    expect(f.options.pause).toHaveBeenCalledTimes(1);
    expect(
      f.observation.readBuild.mock.calls.every((call) => call[1] === slot),
    ).toBe(true);
  });

  it.each([
    "missing",
    "malformed",
    "operation",
    "target",
    "device",
    "inode",
    "layout",
    "named",
    "owner",
    "mode",
    "type",
  ])("refuses %s rejected-target proof", async (failure) => {
    const f = rejectedFixture();
    if (failure === "missing") f.records.delete(f.proofFile);
    if (failure === "malformed")
      f.records.set(f.proofFile, { schema: "farol.rejected-update-target/1" });
    if (failure === "operation") f.proof.operationId = "b".repeat(32);
    if (failure === "target")
      f.records.set(f.proofFile, {
        ...f.proof,
        target: { ...target, digest: "f".repeat(64) },
      });
    if (failure === "device") f.rejectedMetadata.dev = 9n;
    if (failure === "inode") f.rejectedMetadata.ino = 9n;
    if (failure === "layout")
      f.observation.rejectedDirectory.lstat.mockResolvedValue({
        ...f.rejectedMetadata,
      });
    if (failure === "named")
      f.observation.rejectedDirectory.lstat.mockImplementation(async (file) => {
        if (file !== f.companionPath) throw { code: "ENOENT" };
        return { ...f.rejectedMetadata, ino: 9n };
      });
    if (failure === "owner") f.rejectedMetadata.uid = 502n;
    if (failure === "mode") f.rejectedMetadata.mode = 0o722n;
    if (failure === "type") f.rejectedMetadata.isDirectory = () => false;
    await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow();
    if (failure !== "missing")
      expect(
        f.observation.readBuild.mock.calls.every((call) => call[1] === slot),
      ).toBe(true);
  });

  it.each(["withdrawn", "operation", "inode", "layout", "replaced", "source"])(
    "rejects %s evidence in the under-lease recheck",
    async (change) => {
      const f = rejectedFixture();
      const admission = await waitForInstalledUpdateRelaunch(f.options);
      if (change === "withdrawn") f.records.delete(f.proofFile);
      if (change === "operation") f.proof.operationId = "b".repeat(32);
      if (change === "inode") f.rejectedMetadata.ino = 9n;
      if (change === "layout")
        f.observation.rejectedDirectory.lstat.mockResolvedValue({
          ...f.rejectedMetadata,
        });
      if (change === "replaced") {
        f.rejectedMetadata.ino = 9n;
        f.proof.directoryIdentity.inode = "9";
      }
      if (change === "source") f.builds.set(slot, target);
      await expect(admission!.recheck()).rejects.toThrow();
      expect(
        f.observation.readBuild.mock.calls.every((call) => call[1] === slot),
      ).toBe(true);
      expect(f.options.pause).not.toHaveBeenCalled();
    },
  );

  it("returns null without a hint and never reads or waits", async () => {
    const f = fixture();
    expect(
      await waitForInstalledUpdateRelaunch({
        ...f.options,
        args: [],
        directory: "/checkout",
        userData: "/other",
      }),
    ).toBeNull();
    expect(f.observation.readRecord).not.toHaveBeenCalled();
    expect(f.observation.canonicalOwnedDirectory).not.toHaveBeenCalled();
    expect(f.observation.readBuild).not.toHaveBeenCalled();
    expect(f.observation.readProcess).not.toHaveBeenCalled();
    expect(f.options.pause).not.toHaveBeenCalled();
  });

  it.each([
    ["completed", "apply"],
    ["completed", "recover"],
    ["cancel_completed", "recover"],
    ["rollback_completed", "recover"],
    ["rollback_completed", "rollback"],
  ] as const)(
    "binds %s/%s to the executing build and preserved companion",
    async (phase, action) => {
      const f = fixture(phase, action);
      const admission = await waitForInstalledUpdateRelaunch(f.options);
      expect(admission).not.toBeNull();
      await admission!.recheck();
      expect(f.observation.readBuild).toHaveBeenCalledWith(
        directory,
        slot,
        expect.any(Number),
      );
      expect(f.observation.readBuild).toHaveBeenCalledWith(
        directory,
        f.companionPath,
        expect.any(Number),
      );
      expect(f.options.pause).not.toHaveBeenCalled();
    },
  );

  it("admits forward recovery only after completed journal and original helper exit", async () => {
    const f = forwardRecoveryFixture();
    f.journal.phase = "launch_requested";
    f.observation.readProcess.mockResolvedValue({
      stdout: helper.processStart,
      stderr: "",
    });
    f.transitions.push(
      () => {
        f.journal.phase = "completed";
      },
      () => {
        f.observation.readProcess.mockRejectedValue({
          code: 1,
          stdout: "",
          stderr: "",
        });
      },
    );
    const admission = await waitForInstalledUpdateRelaunch(f.options);
    expect(admission).not.toBeNull();
    expect(f.options.pause).toHaveBeenCalledTimes(2);
    await admission!.recheck();
    expect(f.observation.readBuild).toHaveBeenCalledWith(
      directory,
      slot,
      expect.any(Number),
    );
    expect(f.observation.readBuild).toHaveBeenCalledWith(
      directory,
      f.companionPath,
      expect.any(Number),
    );
    f.builds.set(f.companionPath, f.pair.target);
    await expect(admission!.recheck()).rejects.toThrow(
      "UPDATE_RELAUNCH_PHYSICAL_PAIR_CHANGED",
    );
  });

  it.each([
    "compatible-pair",
    "wrong-action",
    "wrong-journal",
    "wrong-target",
    "wrong-predecessor",
  ])("refuses forward recovery with %s", async (change) => {
    const f =
      change === "compatible-pair"
        ? forwardRecoveryFixture("0.2.0-owner.beta.10", "0.2.0-owner.beta.11")
        : forwardRecoveryFixture();
    let options = f.options;
    if (change === "wrong-action") {
      f.receipt.action = "rollback";
      f.hint.action = "rollback";
      options = { ...options, args: [prefix + JSON.stringify(f.hint)] };
    }
    if (change === "wrong-journal") f.journal.phase = "rolled_back";
    if (change === "wrong-target") f.builds.set(slot, f.pair.source);
    if (change === "wrong-predecessor")
      f.builds.set(f.companionPath, f.pair.target);
    await expect(waitForInstalledUpdateRelaunch(options)).rejects.toThrow();
  });

  it("waits for completion and exact helper exit, with process observation before journal read", async () => {
    const f = fixture();
    f.journal.phase = "launch_requested";
    f.observation.readProcess.mockResolvedValue({
      stdout: helper.processStart + "\n",
      stderr: "",
    });
    f.transitions.push(
      () => {
        f.journal.phase = "completed";
      },
      () => {
        f.observation.readProcess.mockRejectedValue({
          code: 1,
          stdout: "",
          stderr: "",
        });
      },
    );
    const admission = await waitForInstalledUpdateRelaunch(f.options);
    expect(admission).not.toBeNull();
    expect(f.options.pause).toHaveBeenCalledTimes(2);
    expect(f.events.indexOf("process")).toBeLessThan(
      f.events.indexOf("record:journal.json"),
    );
  });

  it("observes completion written between the process probe and journal read", async () => {
    const f = fixture();
    f.journal.phase = "launch_requested";
    f.observation.readProcess.mockImplementation(async () => {
      f.journal.phase = "completed";
      throw { code: 1, stdout: "", stderr: "" };
    });
    expect(await waitForInstalledUpdateRelaunch(f.options)).not.toBeNull();
  });

  it("times out a live helper without another operation or startup acquire", async () => {
    const f = fixture();
    f.journal.phase = "launch_requested";
    f.observation.readProcess.mockResolvedValue({
      stdout: helper.processStart,
      stderr: "",
    });
    await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
      "UPDATE_RELAUNCH_TIMEOUT",
    );
    expect(f.options.pause).toHaveBeenCalledTimes(10);
    expect(f.journal.phase).toBe("launch_requested");
  });

  it("bounds a read that never settles", async () => {
    const f = fixture();
    f.observation.readRecord.mockImplementation(() => new Promise(() => {}));
    await expect(
      waitForInstalledUpdateRelaunch({ ...f.options, timeoutMs: 5 }),
    ).rejects.toThrow("UPDATE_RELAUNCH_TIMEOUT");
    expect(f.observation.readProcess).not.toHaveBeenCalled();
  });

  it.each([
    { code: "EPERM", stdout: "", stderr: "" },
    { code: 1, stdout: "", stderr: "denied" },
    { code: "ETIMEDOUT", stdout: "", stderr: "" },
    null,
  ])("refuses unknown helper observation %j immediately", async (failure) => {
    const f = fixture();
    f.observation.readProcess.mockRejectedValue(failure);
    await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
      "UPDATE_RELAUNCH_HELPER_UNCONFIRMED",
    );
    expect(f.options.pause).not.toHaveBeenCalled();
  });

  it.each([
    { stdout: "Tue Oct  6 12:00:01 2026", stderr: "" },
    { stdout: "", stderr: "" },
    { stdout: "not a process start", stderr: "" },
  ])("refuses changed or malformed process identity %j", async (result) => {
    const f = fixture();
    f.observation.readProcess.mockResolvedValue(result);
    await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
      "UPDATE_RELAUNCH_HELPER_UNCONFIRMED",
    );
  });

  it("refuses helper exit without the expected durable completion", async () => {
    const f = fixture();
    f.journal.phase = "launch_requested";
    await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
      "UPDATE_RELAUNCH_COMPLETION_UNCONFIRMED",
    );
  });

  it.each(["prepared", "verified", "rollback_completed"])(
    "does not broaden phase authority to %s",
    async (phase) => {
      const f = fixture();
      f.journal.phase = phase;
      await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
        "UPDATE_RELAUNCH_PHASE_MISMATCH",
      );
    },
  );

  it.each(["slot", "companion", "metadata", "receipt", "journal", "helper"])(
    "rechecks %s under the caller's lease without waiting",
    async (change) => {
      const f = fixture();
      const admission = await waitForInstalledUpdateRelaunch(f.options);
      if (change === "slot") f.builds.set(slot, source);
      if (change === "companion") f.builds.set(f.companionPath, target);
      if (change === "metadata")
        f.records.set(path.join(directory, "build-identity.json"), sourceBuild);
      if (change === "receipt")
        f.receipt.helper = { ...helper, pid: helper.pid + 1 };
      if (change === "journal") f.journal.phase = "launch_requested";
      if (change === "helper")
        f.observation.readProcess.mockResolvedValue({
          stdout: helper.processStart,
          stderr: "",
        });
      await expect(admission!.recheck()).rejects.toThrow();
      expect(f.options.pause).not.toHaveBeenCalled();
    },
  );

  it("refuses a changed physical pair at the end of a live observation", async () => {
    const f = fixture();
    f.journal.phase = "launch_requested";
    f.observation.readProcess.mockResolvedValue({
      stdout: helper.processStart,
      stderr: "",
    });
    f.transitions.push(() => {
      f.journal.phase = "completed";
      f.builds.set(f.companionPath, target);
      f.observation.readProcess.mockRejectedValue({
        code: 1,
        stdout: "",
        stderr: "",
      });
    });
    await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
      "UPDATE_RELAUNCH_PHYSICAL_PAIR_CHANGED",
    );
  });

  it.each(["record", "route", "tree"])(
    "propagates unreadable %s instead of waiting",
    async (failure) => {
      const f = fixture();
      if (failure === "record")
        f.observation.readRecord.mockRejectedValue(new Error("READ_REFUSED"));
      if (failure === "route")
        f.observation.canonicalOwnedDirectory.mockRejectedValue(
          new Error("ROUTE_UNSAFE"),
        );
      if (failure === "tree")
        f.observation.readBuild.mockRejectedValue(new Error("TREE_UNKNOWN"));
      await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow();
      expect(f.options.pause).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "helper", "operation", "stale", "action"])(
    "refuses %s dispatch correlation",
    async (failure) => {
      const f = fixture("rollback_completed", "rollback");
      if (failure === "missing") f.records.delete(f.receiptFile);
      if (failure === "helper")
        f.receipt.helper = {
          ...helper,
          processStart: "Tue Oct  6 12:00:01 2026",
        };
      if (failure === "operation")
        f.receipt.operation = { ...operation, operationId: "b".repeat(32) };
      if (failure === "stale") f.receipt.notStartedAt = source;
      if (failure === "action") f.receipt.action = "recover";
      await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow();
    },
  );

  it("refuses recovery receipts already at the requested launch/completion", async () => {
    const f = fixture("cancel_completed", "recover");
    f.receipt.priorPhase = "cancel_launch_requested";
    await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
      "UPDATE_RELAUNCH_RECEIPT_MISMATCH",
    );
  });

  it("refuses an apply hint superseded by a restore dispatch", async () => {
    const f = fixture();
    f.records.set(path.join(root, "restore-pending.json"), {
      schema: "farol.update-restore-intent/1",
      action: "rollback",
      operation,
      priorPhase: "completed",
      helper,
    });
    await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
      "UPDATE_RELAUNCH_RECEIPT_MISMATCH",
    );
  });

  it("refuses an operation changed during observation", async () => {
    const f = fixture();
    f.journal.phase = "launch_requested";
    f.observation.readProcess.mockResolvedValue({
      stdout: helper.processStart,
      stderr: "",
    });
    f.transitions.push(() => {
      f.receipt.operation = {
        ...operation,
        source: { ...source, digest: "f".repeat(64) },
      };
    });
    await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
      "UPDATE_RELAUNCH_RECEIPT_MISMATCH",
    );
  });

  it.each([
    "duplicate",
    "bare",
    "json",
    "oversized",
    "extra",
    "badpid",
    "badstart",
    "badid",
  ])("rejects %s hints before observation", async (failure) => {
    const f = fixture();
    let args = f.options.args;
    if (failure === "duplicate") args = [...args, ...args];
    if (failure === "bare") args = [prefix.slice(0, -1)];
    if (failure === "json") args = [prefix + "{"];
    if (failure === "oversized") args = [prefix + " ".repeat(2049)];
    if (failure === "extra")
      args = [prefix + JSON.stringify({ ...f.hint, path: slot })];
    if (failure === "badpid")
      args = [
        prefix + JSON.stringify({ ...f.hint, helper: { ...helper, pid: 1 } }),
      ];
    if (failure === "badstart")
      args = [
        prefix +
          JSON.stringify({
            ...f.hint,
            helper: { ...helper, processStart: "unknown" },
          }),
      ];
    if (failure === "badid")
      args = [prefix + JSON.stringify({ ...f.hint, operationId: "../other" })];
    await expect(
      waitForInstalledUpdateRelaunch({ ...f.options, args }),
    ).rejects.toThrow();
    expect(f.observation.readRecord).not.toHaveBeenCalled();
    expect(f.observation.canonicalOwnedDirectory).not.toHaveBeenCalled();
    expect(f.observation.readProcess).not.toHaveBeenCalled();
  });

  it.each(["profile", "directory", "build", "action", "mapping"])(
    "rejects foreign %s before observation",
    async (failure) => {
      const f = fixture();
      let options = f.options;
      if (failure === "profile")
        options = { ...options, userData: profile + "-other" };
      if (failure === "directory")
        options = { ...options, directory: "/checkout" };
      if (failure === "build")
        options = f.withHint({ ...f.hint, buildId: source.buildId });
      if (failure === "action")
        options = f.withHint({ ...f.hint, action: "rollback" });
      if (failure === "mapping")
        options = f.withHint({ ...f.hint, phase: "cancel_completed" });
      await expect(waitForInstalledUpdateRelaunch(options)).rejects.toThrow();
      expect(f.observation.readRecord).not.toHaveBeenCalled();
    },
  );
});

it.each(["missing", "other-slot", "other-pair", "noncanonical"])(
  "rejects %s relaunch binding before observing a helper",
  async (variant) => {
    const f = fixture();
    const file = path.join(opRoot, "slot-binding.json");
    if (variant === "missing") f.records.delete(file);
    if (variant === "other-slot")
      f.records.set(
        file,
        JSON.parse(installedSlotBindingBytes(operation, "shared").toString()),
      );
    if (variant === "other-pair")
      f.records.set(
        file,
        JSON.parse(
          installedSlotBindingBytes(
            { ...operation, source: { ...source, digest: "f".repeat(64) } },
            "legacy",
          ).toString(),
        ),
      );
    if (variant === "noncanonical") {
      const binding = f.records.get(file) as Record<string, unknown>;
      f.records.set(file, { schema: binding.schema, ...binding });
    }
    await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
      "UPDATE_SLOT_BINDING_UNCONFIRMED",
    );
    expect(f.observation.readProcess).not.toHaveBeenCalled();
  },
);
