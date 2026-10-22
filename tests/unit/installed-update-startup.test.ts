import { installedSlotBindingBytes } from "../../src/modules/release/infra/native/installed-update-helper";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const captureMock = vi.hoisted(() => vi.fn());
const adoptionMocks = vi.hoisted(() => ({
  find: vi.fn(),
  transport: vi.fn(),
}));
vi.mock("../../src/apps/desktop/installed-execution-snapshot", () => ({
  captureInstalledExecutionSnapshot: captureMock,
}));
// Only the catalogue lookup and the transport are doubled: no network is ever
// reached from this file, and the rest of the release module stays real.
vi.mock("../../src/modules/release/app/github-release", async (original) => ({
  ...(await original<
    typeof import("../../src/modules/release/app/github-release")
  >()),
  findGithubReleaseManifest: adoptionMocks.find,
}));
vi.mock(
  "../../src/modules/release/infra/native/github-update-transport",
  () => ({
    createGithubUpdateTransport: (...args: unknown[]) => {
      adoptionMocks.transport(...args);
      return { fetchJson: vi.fn() };
    },
  }),
);
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
  "Library/Application Support/io.github.legrch.farol",
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
    product: "Farol",
    bundleId: "io.github.legrch.farol",
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
        if (records.has(file))
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

// Ordinary shared-slot observation only; no helper, migration or mutation authority.
function unboundSharedFixture(
  kind: "operation" | "preparation" | "completed" | "rollback",
) {
  const f = fixture();
  const current = kind === "completed" ? targetBuild : sourceBuild;
  const accepted = kind === "completed" ? target : source;
  const manifest = {
    schema: "farol.github-release/1",
    repository: "legrch/farol",
    channel: "owner-beta",
    product: "Farol",
    bundleId: "io.github.legrch.farol",
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
  };
  const retained = {
    schema: "farol.ready-update/1",
    handle: "/private/retained.zip",
    manifest,
  };
  f.records.delete(f.receiptFile);
  if (kind === "completed" || kind === "rollback") {
    f.records.set(path.join(root, "last-update.json"), {
      ...retained,
      operation,
      phase: kind === "completed" ? "completed" : "rollback_completed",
      observedAt: "2026-10-06T13:00:00.000Z",
      runningBuildId: current.buildId,
    });
  } else {
    f.records.set(path.join(root, "ready.json"), {
      ...retained,
      ...(kind === "preparation"
        ? { operation: null, preparation: operation }
        : { operation }),
    });
  }
  f.records.delete(path.join(opRoot, "slot-binding.json"));
  f.builds.set("/Applications/Farol.app", accepted);
  const recheck = vi.fn().mockResolvedValue(undefined);
  captureMock.mockResolvedValue({
    app: "/fixture-private/image",
    directory: "/fixture-private/resources",
    executable: "/fixture-private/executable",
    digest: accepted.digest,
    recheck,
  });
  const options: InstalledUpdateRelaunchOptions = {
    ...f.options,
    args: [],
    directory: "/Applications/Farol.app/Contents/Resources/app",
    build: current,
    physicalFiles: fs,
    copyApp: vi.fn().mockResolvedValue(undefined),
  };
  return { ...f, options, accepted, manifest, recheck };
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
  adoptionMocks.find.mockReset();
  adoptionMocks.transport.mockReset();
  vi.spyOn(process, "getuid").mockReturnValue(501);
  vi.spyOn(process, "geteuid").mockReturnValue(501);
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
  it("refuses startup when the selected user does not match the effective UID", async () => {
    const f = fixture();
    vi.spyOn(process, "geteuid").mockReturnValue(502);

    await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
      "INSTALLED_UPDATE_SLOT_INVALID",
    );
    expect(f.observation.readRecord).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("authenticates ordinary shared startup resources before Go can use them", async () => {
    const f = fixture();
    f.builds.set("/Applications/Farol.app", target);
    f.records.delete(f.receiptFile);
    f.records.set("/Applications/Farol.app.receipt.json", {
      schema: "farol.promotion-plan/1",
      operation: "applied",
      product: "Farol",
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
    await guard!.resourcesOrigin!.recheckUpdateSource();
    f.builds.set("/Applications/Farol.app", source);
    await guard!.resourcesOrigin!.recheck();
    await expect(guard!.resourcesOrigin!.recheckUpdateSource()).rejects.toThrow(
      "UPDATE_ACCEPTED_SOURCE_CHANGED",
    );
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
        product: "Farol",
        bundleId: "io.github.legrch.farol",
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
    await guard!.resourcesOrigin!.recheckUpdateSource();
    f.builds.set("/Applications/Farol.app", source);
    // The retained runtime remains valid; only a new updater admission refuses.
    await guard!.resourcesOrigin!.recheck();
    await expect(guard!.resourcesOrigin!.recheckUpdateSource()).rejects.toThrow(
      "UPDATE_ACCEPTED_SOURCE_CHANGED",
    );
    f.builds.set("/Applications/Farol.app", target);
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
        product: "Farol",
        bundleId: "io.github.legrch.farol",
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
    await guard!.resourcesOrigin!.recheckUpdateSource();
    f.builds.set("/Applications/Farol.app", source);
    await guard!.resourcesOrigin!.recheck();
    await expect(guard!.resourcesOrigin!.recheckUpdateSource()).rejects.toThrow(
      "UPDATE_ACCEPTED_SOURCE_CHANGED",
    );
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

  it.each(["operation", "preparation", "completed", "rollback"] as const)(
    "opens the exact shared executable with an old unbound %s without adopting its update",
    async (kind) => {
      const f = unboundSharedFixture(kind);
      const before = structuredClone([...f.records]);
      const guard = await waitForInstalledUpdateRelaunch(f.options);
      expect(guard!.resourcesOrigin).toMatchObject({
        kind: "shared-slot",
        app: "/Applications/Farol.app",
      });
      expect(captureMock.mock.calls[0]![0]).toMatchObject({
        sourceApp: "/Applications/Farol.app",
        expectedDigest: f.accepted.digest,
      });
      await guard!.recheck();
      await guard!.resourcesOrigin!.recheckUpdateSource();
      expect([...f.records]).toEqual(before);
      expect(f.options.copyApp).not.toHaveBeenCalled();
      expect(f.observation.readProcess).not.toHaveBeenCalled();
      expect(f.options.pause).not.toHaveBeenCalled();
      expect(f.records.has(path.join(opRoot, "slot-binding.json"))).toBe(false);
      f.builds.set(
        "/Applications/Farol.app",
        kind === "completed" ? source : target,
      );
      await expect(
        guard!.resourcesOrigin!.recheckUpdateSource(),
      ).rejects.toThrow("UPDATE_ACCEPTED_SOURCE_CHANGED");
    },
  );

  it.each(["operation", "preparation", "completed", "rollback"] as const)(
    "refuses a present JSON-null binding for an ordinary %s baseline",
    async (kind) => {
      const f = unboundSharedFixture(kind);
      f.records.set(path.join(opRoot, "slot-binding.json"), null);
      const before = structuredClone([...f.records]);
      await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
        "UPDATE_SLOT_BINDING_UNCONFIRMED",
      );
      expect(captureMock).not.toHaveBeenCalled();
      expect([...f.records]).toEqual(before);
      expect(f.options.copyApp).not.toHaveBeenCalled();
      expect(f.observation.readProcess).not.toHaveBeenCalled();
    },
  );

  it.each(["slot", "source", "target"] as const)(
    "still refuses an existing wrong %s binding during ordinary shared startup",
    async (change) => {
      const f = unboundSharedFixture("completed");
      const op =
        change === "slot"
          ? operation
          : {
              ...operation,
              [change]: { ...operation[change], digest: "e".repeat(64) },
            };
      f.records.set(
        path.join(opRoot, "slot-binding.json"),
        JSON.parse(
          installedSlotBindingBytes(
            op,
            change === "slot" ? "legacy" : "shared",
          ).toString(),
        ),
      );
      await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
        "UPDATE_SLOT_BINDING_UNCONFIRMED",
      );
      expect(captureMock).not.toHaveBeenCalled();
    },
  );

  it.each(["manifest", "executing-build"] as const)(
    "refuses an unbound ordinary baseline with changed %s",
    async (change) => {
      const f = unboundSharedFixture("completed");
      if (change === "manifest") f.manifest.artifactSha256 = "e".repeat(64);
      const options =
        change === "executing-build"
          ? { ...f.options, build: identity("0.1.2-owner.beta.1", "3", "5") }
          : f.options;
      if (change === "manifest") {
        const record = f.records.get(
          path.join(root, "last-update.json"),
        ) as Record<string, unknown>;
        record.manifest = { ...f.manifest };
      }
      await expect(waitForInstalledUpdateRelaunch(options)).rejects.toThrow(
        "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED",
      );
      expect(captureMock).not.toHaveBeenCalled();
    },
  );

  it.each(["legacy", "shared"] as const)(
    "does not grant a correlated %s updater relaunch from an unbound operation",
    async (location) => {
      const f = fixture();
      f.records.delete(path.join(opRoot, "slot-binding.json"));
      const options =
        location === "legacy"
          ? f.options
          : {
              ...f.options,
              directory: "/Applications/Farol.app/Contents/Resources/app",
              physicalFiles: fs,
              copyApp: vi.fn().mockResolvedValue(undefined),
            };
      await expect(waitForInstalledUpdateRelaunch(options)).rejects.toThrow(
        "UPDATE_SLOT_BINDING_UNCONFIRMED",
      );
      expect(captureMock).not.toHaveBeenCalled();
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

// Shared-slot first-launch adoption: a recipient who dragged the app into
// /Applications has no owner-tool receipt. The expectation comes from the
// published manifest at startup, never from the slot being measured.
describe("shared-slot first-launch adoption at startup (pure ports; GitHub doubled)", () => {
  const publicDirectory = "/Applications/Farol.app/Contents/Resources/app";
  const adoptedFile = path.join(root, "adopted-baseline.json");
  const sharedApp = "/Applications/Farol.app";

  function adoptionFixture(build = targetBuild, accepted = target) {
    const f = unboundSharedFixture("completed");
    // Nothing anchors this copy: no ready, last-update, receipt or repair file.
    f.records.delete(path.join(root, "last-update.json"));
    f.builds.set(sharedApp, accepted);
    const published = {
      ...f.manifest,
      version: build.version,
      buildVersion: build.buildVersion,
      sourceCommit: build.sourceCommit,
      sourceTreeDigest: build.sourceTreeDigest,
      buildId: build.buildId,
      artifactSha256: accepted.digest,
    };
    const log: string[] = [];
    const written: string[] = [];
    const write = vi.fn(async (file: string, value: unknown) => {
      log.push("write");
      written.push(file);
      f.records.set(file, structuredClone(value));
    });
    captureMock.mockImplementation(async () => {
      log.push("capture");
      return {
        app: "/fixture-private/image",
        directory: "/fixture-private/resources",
        executable: "/fixture-private/executable",
        digest: accepted.digest,
        recheck: vi.fn().mockResolvedValue(undefined),
      };
    });
    adoptionMocks.find.mockImplementation(async () => {
      log.push("find");
      return { ok: true, value: structuredClone(published) };
    });
    const options: InstalledUpdateRelaunchOptions = {
      ...f.options,
      args: [],
      directory: publicDirectory,
      build,
      physicalFiles: fs,
      copyApp: vi.fn().mockResolvedValue(undefined),
      observation: {
        ...f.observation,
        recordAbsent: async (file: string) => !f.records.has(file),
        writeRecord: write,
      },
    };
    const record = (overrides: Record<string, unknown> = {}) => ({
      schema: "farol.adopted-baseline/1",
      slot: sharedApp,
      userData: profile,
      manifest: structuredClone(published),
      adoptedAt: "2026-10-21T00:00:00.000Z",
      ...overrides,
    });
    return { ...f, options, published, log, written, write, record };
  }
  const noEffects = (f: ReturnType<typeof adoptionFixture>) => {
    expect(captureMock).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.records.has(adoptedFile)).toBe(false);
  };

  it("adopts from the published manifest, captures that digest, then records once", async () => {
    const f = adoptionFixture();
    const guard = await waitForInstalledUpdateRelaunch(f.options);
    expect(guard!.resourcesOrigin).toMatchObject({ kind: "shared-slot" });
    expect(adoptionMocks.find).toHaveBeenCalledExactlyOnceWith(
      { version: targetBuild.version, buildVersion: targetBuild.buildVersion },
      "owner-beta",
      expect.anything(),
    );
    expect(adoptionMocks.transport).toHaveBeenCalledOnce();
    const transportOptions = adoptionMocks.transport.mock.calls[0]![0] as {
      privateStateDirectory: string;
      verifyPackage(): Promise<unknown>;
    };
    expect(transportOptions.privateStateDirectory).toBe(root);
    await expect(transportOptions.verifyPackage()).rejects.toThrow(
      "UPDATE_ADOPTION_PACKAGE_UNUSED",
    );
    expect(captureMock).toHaveBeenCalledOnce();
    expect(captureMock.mock.calls[0]![0]).toMatchObject({
      sourceApp: sharedApp,
      privateParent: root,
      expectedDigest: f.published.artifactSha256,
    });
    // The record follows the capture and stays in the private profile.
    expect(f.log).toEqual(["find", "capture", "write"]);
    expect(f.written).toEqual([adoptedFile]);
    expect(f.written.every((file) => !file.startsWith("/Applications"))).toBe(
      true,
    );
    expect(f.records.get(adoptedFile)).toEqual({
      schema: "farol.adopted-baseline/1",
      slot: sharedApp,
      userData: profile,
      manifest: f.published,
      adoptedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
    });
  });

  it("measures the slot only after the manifest and refuses a tree that differs before any capture", async () => {
    const f = adoptionFixture();
    f.builds.set(sharedApp, { ...target, digest: "9".repeat(64) });
    await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
      "UPDATE_ADOPTION_TREE_MISMATCH",
    );
    noEffects(f);
  });

  it("never takes the expectation from the measured slot", async () => {
    const f = adoptionFixture();
    f.builds.set(sharedApp, { ...target, digest: "8".repeat(64) });
    f.published.artifactSha256 = "7".repeat(64);
    await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
      "UPDATE_ADOPTION_TREE_MISMATCH",
    );
    noEffects(f);
  });

  it("closes with a distinct code when the tree cannot be measured", async () => {
    const f = adoptionFixture();
    f.observation.readBuild.mockRejectedValue(new Error("private /Users path"));
    await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
      "UPDATE_ADOPTION_TREE_UNREADABLE",
    );
    noEffects(f);
  });

  it.each([
    [
      "offline",
      () => Promise.reject(new Error("ENOTFOUND")),
      "NETWORK_FAILURE",
    ],
    [
      "an unpublished version",
      () => Promise.resolve({ ok: false, code: "release_not_found" }),
      "RELEASE_NOT_FOUND",
    ],
    [
      "a refused catalogue",
      () => Promise.resolve({ ok: false, code: "invalid_release_metadata" }),
      "INVALID_RELEASE_METADATA",
    ],
  ])("refuses %s without capture or a record", async (_n, lookup, suffix) => {
    const f = adoptionFixture();
    adoptionMocks.find.mockImplementation(lookup);
    await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
      `UPDATE_ADOPTION_${suffix}`,
    );
    noEffects(f);
  });

  it.each([
    ["buildId", { buildId: "7".repeat(64) }],
    ["sourceCommit", { sourceCommit: "7".repeat(40) }],
    ["sourceTreeDigest", { sourceTreeDigest: "7".repeat(64) }],
    ["channel", { channel: "stable" }],
    ["version", { version: "0.1.0-owner.beta.9" }],
    ["buildVersion", { buildVersion: "9" }],
  ])(
    "refuses a manifest whose %s is not the running build",
    async (_name, drift) => {
      const f = adoptionFixture();
      adoptionMocks.find.mockResolvedValue({
        ok: true,
        value: { ...f.published, ...drift },
      });
      await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
        "UPDATE_ADOPTION_RELEASE_MISMATCH",
      );
      expect(f.observation.readBuild).not.toHaveBeenCalled();
      noEffects(f);
    },
  );

  it("records nothing when the capture refuses", async () => {
    const f = adoptionFixture();
    captureMock.mockRejectedValue(
      new Error("UPDATE_EXECUTION_RESOURCES_UNCONFIRMED"),
    );
    await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
      "UPDATE_EXECUTION_RESOURCES_UNCONFIRMED",
    );
    expect(f.write).not.toHaveBeenCalled();
    expect(f.records.has(adoptedFile)).toBe(false);
  });

  it("fails closed when the record cannot be written", async () => {
    const f = adoptionFixture();
    f.write.mockRejectedValue(new Error("EACCES /private/path"));
    await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
      "UPDATE_ADOPTION_RECORD_UNWRITTEN",
    );
    expect(f.records.has(adoptedFile)).toBe(false);
  });

  it("uses an existing valid record without touching the network or rewriting it", async () => {
    const f = adoptionFixture();
    f.records.set(adoptedFile, f.record());
    const guard = await waitForInstalledUpdateRelaunch(f.options);
    expect(guard!.resourcesOrigin).toMatchObject({ kind: "shared-slot" });
    expect(adoptionMocks.find).not.toHaveBeenCalled();
    expect(adoptionMocks.transport).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    expect(captureMock.mock.calls[0]![0]).toMatchObject({
      expectedDigest: f.published.artifactSha256,
    });
  });

  describe("a superseded record (valid for this slot, another published build)", () => {
    const other = (f: ReturnType<typeof adoptionFixture>) =>
      f.record({
        manifest: {
          ...f.published,
          version: sourceBuild.version,
          buildVersion: sourceBuild.buildVersion,
          sourceCommit: sourceBuild.sourceCommit,
          sourceTreeDigest: sourceBuild.sourceTreeDigest,
          buildId: sourceBuild.buildId,
          artifactSha256: source.digest,
          archiveName: `Farol-${sourceBuild.version}-darwin-arm64.zip`,
        },
      });

    it("re-adopts and replaces it after a successful capture", async () => {
      const f = adoptionFixture();
      f.records.set(adoptedFile, other(f));
      await waitForInstalledUpdateRelaunch(f.options);
      expect(f.log).toEqual(["find", "capture", "write"]);
      expect(
        (f.records.get(adoptedFile) as { manifest: unknown }).manifest,
      ).toEqual(f.published);
    });

    it("keeps the old record when the new copy fails to verify", async () => {
      const f = adoptionFixture();
      const old = other(f);
      f.records.set(adoptedFile, old);
      f.builds.set(sharedApp, { ...target, digest: "9".repeat(64) });
      await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
        "UPDATE_ADOPTION_TREE_MISMATCH",
      );
      expect(f.records.get(adoptedFile)).toEqual(old);
      expect(f.write).not.toHaveBeenCalled();
    });

    it("leaves a record another writer published meanwhile, if it describes this build", async () => {
      const f = adoptionFixture();
      f.records.set(adoptedFile, other(f));
      const winner = f.record({ adoptedAt: "2026-10-21T01:00:00.000Z" });
      captureMock.mockImplementationOnce(async () => {
        f.records.set(adoptedFile, structuredClone(winner));
        return {
          app: "/fixture-private/image",
          directory: "/fixture-private/resources",
          executable: "/fixture-private/executable",
          digest: target.digest,
          recheck: vi.fn().mockResolvedValue(undefined),
        };
      });
      await waitForInstalledUpdateRelaunch(f.options);
      expect(f.write).not.toHaveBeenCalled();
      expect(f.records.get(adoptedFile)).toEqual(winner);
    });

    it("refuses when the changed record does not describe this build", async () => {
      const f = adoptionFixture();
      f.records.set(adoptedFile, other(f));
      const intruder = f.record({ slot: "/elsewhere/Farol.app" });
      captureMock.mockImplementationOnce(async () => {
        f.records.set(adoptedFile, structuredClone(intruder));
        return {
          app: "/fixture-private/image",
          directory: "/fixture-private/resources",
          executable: "/fixture-private/executable",
          digest: target.digest,
          recheck: vi.fn().mockResolvedValue(undefined),
        };
      });
      await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
        "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED",
      );
      expect(f.write).not.toHaveBeenCalled();
      expect(f.records.get(adoptedFile)).toEqual(intruder);
    });
  });

  it.each([
    ["JSON null", () => null],
    [
      "another slot",
      (f: ReturnType<typeof adoptionFixture>) =>
        f.record({ slot: "/Users/x/Applications/Farol.app" }),
    ],
    [
      "another profile",
      (f: ReturnType<typeof adoptionFixture>) =>
        f.record({ userData: "/elsewhere" }),
    ],
    [
      "an invalid manifest",
      (f: ReturnType<typeof adoptionFixture>) =>
        f.record({ manifest: { ...f.published, artifactSha256: "nope" } }),
    ],
    [
      "an unknown field",
      (f: ReturnType<typeof adoptionFixture>) => f.record({ extra: true }),
    ],
    [
      "a missing field",
      (f: ReturnType<typeof adoptionFixture>) => {
        const { adoptedAt: _omitted, ...rest } = f.record();
        return rest;
      },
    ],
    ["a non-object value", () => 42],
    ["an array", () => []],
    [
      "a manifest that is not an object",
      (f: ReturnType<typeof adoptionFixture>) => f.record({ manifest: "x" }),
    ],
  ])(
    "refuses a tampered record (%s) with the exact unconfirmed code",
    async (_n, make) => {
      const f = adoptionFixture();
      const tampered = make(f);
      f.records.set(adoptedFile, tampered);
      await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
        /^UPDATE_ACCEPTED_SOURCE_UNCONFIRMED$/u,
      );
      expect(adoptionMocks.find).not.toHaveBeenCalled();
      noEffectsExceptRecord(f, tampered);
    },
  );

  it.each([
    [
      "malformed JSON bytes",
      () => new SyntaxError("Unexpected token } in JSON"),
    ],
    ["a changed file", () => new Error("UPDATE_RECORD_CHANGED")],
    ["an unsafe file", () => new Error("UPDATE_RECORD_INVALID")],
  ])(
    "refuses an adopted record that cannot be read (%s) with the exact unconfirmed code",
    async (_n, failure) => {
      const f = adoptionFixture();
      f.records.set(adoptedFile, f.record());
      const base = f.options.observation!.readRecord;
      (f.options.observation as { readRecord: typeof base }).readRecord = vi.fn(
        async (file: string, ...rest: [boolean?, ...unknown[]]) => {
          if (file === adoptedFile) throw failure();
          return (base as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
        },
      ) as typeof base;
      await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow(
        /^UPDATE_ACCEPTED_SOURCE_UNCONFIRMED$/u,
      );
      expect(adoptionMocks.find).not.toHaveBeenCalled();
      expect(captureMock).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
    },
  );
  function noEffectsExceptRecord(
    f: ReturnType<typeof adoptionFixture>,
    kept: unknown,
  ) {
    expect(captureMock).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.records.get(adoptedFile)).toEqual(kept);
  }

  describe("other baseline evidence, even a null file, forbids adoption", () => {
    it.each([
      ["last-update.json", path.join(root, "last-update.json")],
      ["the promotion receipt", "/Applications/Farol.app.receipt.json"],
      ["the repair receipt", "/Applications/Farol.app.repair.json"],
      ["the repair journal", "/Applications/.farol-closed-repair.json"],
      ["ready.json", path.join(root, "ready.json")],
    ])("%s present as JSON null", async (_name, file) => {
      const f = adoptionFixture();
      f.records.set(file, null);
      await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow();
      expect(adoptionMocks.find).not.toHaveBeenCalled();
      noEffects(f);
    });

    it.each([
      ["last-update.json", path.join(root, "last-update.json")],
      ["the promotion receipt", "/Applications/Farol.app.receipt.json"],
      ["the repair receipt", "/Applications/Farol.app.repair.json"],
      ["the repair journal", "/Applications/.farol-closed-repair.json"],
      ["ready.json", path.join(root, "ready.json")],
    ])("%s present but unusable", async (_name, file) => {
      const f = adoptionFixture();
      f.records.set(file, { schema: "unknown" });
      await expect(waitForInstalledUpdateRelaunch(f.options)).rejects.toThrow();
      expect(adoptionMocks.find).not.toHaveBeenCalled();
      noEffects(f);
    });

    const retainedDownload = (
      f: ReturnType<typeof adoptionFixture>,
      overrides: Record<string, unknown> = {},
    ) => ({
      schema: "farol.ready-update/1",
      handle: "/private/retained.zip",
      manifest: structuredClone(f.published),
      operation: null,
      ...overrides,
    });

    it("a genuinely valid retained download does not strand an adopted copy", async () => {
      const f = adoptionFixture();
      f.records.set(adoptedFile, f.record());
      f.records.set(path.join(root, "ready.json"), retainedDownload(f));
      const guard = await waitForInstalledUpdateRelaunch(f.options);
      expect(guard!.resourcesOrigin).toMatchObject({ kind: "shared-slot" });
      expect(adoptionMocks.find).not.toHaveBeenCalled();
    });

    it("a valid retained download still lets an unrecorded copy adopt", async () => {
      const f = adoptionFixture();
      f.records.set(path.join(root, "ready.json"), retainedDownload(f));
      await waitForInstalledUpdateRelaunch(f.options);
      expect(f.log).toEqual(["find", "capture", "write"]);
    });

    it.each([
      ["an empty manifest object", { manifest: {} }],
      ["an empty handle", { handle: "" }],
      ["an oversized handle", { handle: "h".repeat(4097) }],
      [
        "an invalid manifest",
        (f: ReturnType<typeof adoptionFixture>) => ({
          manifest: { ...f.published, artifactSha256: "nope" },
        }),
      ],
      ["a null manifest", { manifest: null }],
    ])(
      "refuses malformed retained evidence (%s) with no adoption, capture or write",
      async (_name, drift) => {
        for (const recorded of [false, true]) {
          captureMock.mockClear();
          adoptionMocks.find.mockClear();
          const f = adoptionFixture();
          if (recorded) f.records.set(adoptedFile, f.record());
          const before = structuredClone(f.records.get(adoptedFile));
          f.records.set(
            path.join(root, "ready.json"),
            retainedDownload(f, typeof drift === "function" ? drift(f) : drift),
          );
          await expect(
            waitForInstalledUpdateRelaunch(f.options),
          ).rejects.toThrow();
          expect(adoptionMocks.find).not.toHaveBeenCalled();
          expect(captureMock).not.toHaveBeenCalled();
          expect(f.write).not.toHaveBeenCalled();
          expect(f.records.get(adoptedFile)).toEqual(before);
        }
      },
    );
  });

  it("keeps the update-receipt path unchanged and offline even beside an adopted record", async () => {
    const f = unboundSharedFixture("completed");
    f.records.set(adoptedFile, {
      schema: "farol.adopted-baseline/1",
      slot: sharedApp,
      userData: profile,
      manifest: f.manifest,
      adoptedAt: "2026-10-21T00:00:00.000Z",
    });
    const guard = await waitForInstalledUpdateRelaunch(f.options);
    expect(guard!.resourcesOrigin).toMatchObject({ kind: "shared-slot" });
    expect(adoptionMocks.find).not.toHaveBeenCalled();
    expect(captureMock.mock.calls[0]![0]).toMatchObject({
      expectedDigest: f.accepted.digest,
    });
  });

  it("keeps the owner-tool receipt path unchanged and offline", async () => {
    const f = unboundSharedFixture("operation");
    f.records.set("/Applications/Farol.app.receipt.json", {
      schema: "farol.promotion-plan/1",
      operation: "applied",
      product: "Farol",
      version: sourceBuild.version,
      sourceCommit: sourceBuild.sourceCommit,
      sourceTreeDigest: sourceBuild.sourceTreeDigest,
      sourceDirty: false,
      artifactSha256: source.digest,
      source: "/tmp/source",
      destination: sharedApp,
      receipt: "/Applications/Farol.app.receipt.json",
      overwrite: false,
      legacyMutation: false,
      activation: { userData: profile, drained: true, obligations: [] },
      verifiedDestinationSha256: source.digest,
    });
    f.records.delete(path.join(root, "ready.json"));
    await waitForInstalledUpdateRelaunch(f.options);
    expect(adoptionMocks.find).not.toHaveBeenCalled();
    expect(captureMock.mock.calls[0]![0]).toMatchObject({
      expectedDigest: source.digest,
    });
  });

  it.each([
    ["a dirty build", { sourceDirty: true }],
    ["a build without a build version", { buildVersion: undefined }],
    ["a local-channel build", { updateChannel: "local" }],
  ])("never adopts %s", async (_name, drift) => {
    const f = adoptionFixture();
    const bad = { ...f.options.build, ...drift } as typeof targetBuild;
    await expect(
      waitForInstalledUpdateRelaunch({ ...f.options, build: bad }),
    ).rejects.toThrow();
    expect(adoptionMocks.find).not.toHaveBeenCalled();
    noEffects(f);
  });

  it("never adopts a private launch image", async () => {
    const f = adoptionFixture();
    const privateDirectory = path.join(
      opRoot,
      "launch-Farol.app/Contents/Resources/app",
    );
    await expect(
      waitForInstalledUpdateRelaunch({
        ...f.options,
        directory: privateDirectory,
      }),
    ).rejects.toThrow();
    expect(adoptionMocks.find).not.toHaveBeenCalled();
    noEffects(f);
  });

  it("never adopts for a checkout or another install location", async () => {
    const f = adoptionFixture();
    await expect(
      waitForInstalledUpdateRelaunch({
        ...f.options,
        directory: "/Users/farol-startup-fixture/code/farol/app",
      }),
    ).resolves.toBeNull();
    expect(adoptionMocks.find).not.toHaveBeenCalled();
    noEffects(f);
  });
});
