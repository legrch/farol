import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  capture: vi.fn(),
  create: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  lease: vi.fn(),
  obligations: vi.fn(),
  resources: vi.fn(),
  backup: vi.fn(),
  slot: vi.fn(),
  observe: vi.fn(),
  ready: vi.fn(),
  goCore: vi.fn(),
}));
vi.mock("../../tooling/supervised-update-go-core.mjs", () => ({
  selectSupervisedGoCore: ports.goCore,
}));
vi.mock("../../src/apps/desktop/installed-predecessor.ts", () => ({
  captureInstalledPredecessor: ports.capture,
}));
vi.mock("../../src/apps/desktop/installed-update-runtime.ts", () => ({
  createSupervisedInstalledUpdateRuntime: ports.create,
  observeSupervisedReadyUpdate: ports.ready,
}));
vi.mock("../../src/apps/desktop/promotion-lease.ts", () => ({
  acquirePromotionLease: ports.acquire,
  releasePromotionLease: ports.release,
  verifyPromotionLease: ports.lease,
}));
vi.mock(
  "../../src/modules/release/infra/native/installed-update-helper.ts",
  () => ({ installedFarolSlot: ports.slot }),
);
vi.mock("../../tooling/promotion-obligations.mjs", async (original) => ({
  ...(await original()),
  activationObligations: ports.obligations,
}));
vi.mock("../../tooling/supervised-update-resources.mjs", () => ({
  captureSupervisedUpdateResources: ports.resources,
}));
vi.mock("../../tooling/supervised-update-backup.mjs", () => ({
  preserveClosedInstalledPair: ports.backup,
}));
vi.mock("../../tooling/update-slot-observer.mjs", () => ({
  observeUpdateSlot: ports.observe,
}));
import { runSupervisedUpdate } from "../../tooling/supervised-update-controller.mjs";
import { InstalledUpdater } from "../../src/modules/release/app/installed-updater.ts";

// Real disposable archive reads; installed roots/lifecycle/lease/package/helper
// adapters are mocked. No process, app, provider or actual profile is touched.
let root;
let input;
let predecessor;
let runtime;
let resource;
let goCore;
let backup;
let operation;
let selected;
let events;
const source = {
  version: "0.1.11-owner.beta.1",
  buildId: "1".repeat(64),
  digest: "2".repeat(64),
};
const target = {
  version: "0.2.0-owner.beta.2",
  buildId: "3".repeat(64),
  digest: "4".repeat(64),
};
const complete = {
  code: 0,
  signal: null,
  protocolError: null,
  terminal: { phase: "verified", error: null },
};
beforeEach(async () => {
  vi.clearAllMocks();
  for (const mock of Object.values(ports)) mock.mockReset();
  root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-supervised-controller-"),
  );
  const owner = os.userInfo();
  vi.spyOn(os, "userInfo").mockReturnValue({ ...owner, homedir: root });
  const archive = Buffer.from("synthetic archive fixture only");
  const manifest = {
    schema: "farol.github-release/1",
    repository: "legrch/farol",
    channel: "owner-beta",
    product: "Farol",
    bundleId: "io.github.legrch.farol",
    version: target.version,
    buildVersion: "16",
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: "b".repeat(64),
    buildId: target.buildId,
    artifactSha256: target.digest,
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    archiveName: `Farol-${target.version}-darwin-arm64.zip`,
    archiveSize: archive.length,
    platform: "darwin",
    arch: "arm64",
    signing: "unsigned",
    notarized: false,
    sourceDirty: false,
  };
  input = {
    appPath: path.join(root, "candidate/Farol.app"),
    artifactFile: path.join(root, "candidate/artifact.json"),
    expected: Object.fromEntries(
      [
        "version",
        "buildVersion",
        "buildId",
        "sourceCommit",
        "sourceTreeDigest",
        "artifactSha256",
      ].map((key) => [key, manifest[key]]),
    ),
    expectedSource: { ...source },
    archivePath: path.join(root, "candidate.zip"),
    manifest,
    recoveryParent: path.join(root, "recovery"),
  };
  await fs.writeFile(input.archivePath, archive, { mode: 0o600 });
  await fs.mkdir(input.recoveryParent, { mode: 0o700 });
  ports.slot.mockReturnValue(path.join(root, "Applications/Farol.app"));
  ports.observe.mockResolvedValueOnce(source).mockResolvedValue(target);
  events = [];
  predecessor = {
    original: {
      pid: 4321,
      processStart: "exact original",
      startedAt: "2026-10-06T00:00:00.000Z",
    },
    requestQuit: vi.fn(async () => {
      events.push("quit");
    }),
    observeClosed: vi.fn(async () => {
      events.push("closed");
      return { quitDigest: "c".repeat(64) };
    }),
  };
  ports.capture.mockResolvedValue(predecessor);
  ports.acquire.mockResolvedValue({ file: "same-owner-fixture" });
  ports.lease.mockResolvedValue(true);
  ports.release.mockResolvedValue(undefined);
  ports.obligations.mockResolvedValue({
    obligations: [],
    unreadable: [],
    changed: [],
    drained: true,
  });
  resource = {
    app: input.appPath,
    goCore: { core: { fixture: "verified core" }, identity: { fixture: true } },
    verify: vi.fn(async () => true),
  };
  ports.resources.mockResolvedValue(resource);
  goCore = {
    goCoreArtifact: { schema: "farol-core-artifact/1", fixture: true },
    goCoreBuild: { buildId: target.buildId, fixture: true },
  };
  ports.goCore.mockReturnValue(goCore);
  backup = {
    root: "private-copy",
    app: "private-copy/Farol.app",
    profile: "private-copy/profile",
    profileDigest: "d".repeat(64),
    verify: vi.fn(async () => true),
  };
  ports.backup.mockImplementation(async () => {
    events.push("backup");
    return backup;
  });
  operation = {
    operationId: "e".repeat(32),
    pid: 6789,
    completion: Promise.resolve(complete),
  };
  let view = { phase: "idle", checkedAt: null };
  runtime = {
    initialize: vi.fn(async () => {
      events.push("initialize");
    }),
    prepareLocal: vi.fn(async () => {
      events.push("stage");
      view = { phase: "ready", version: target.version, blockedBy: null };
    }),
    restart: vi.fn(async () => {
      events.push("restart");
      selected.observeHelper(operation);
      view = { phase: "applying", version: target.version };
    }),
    snapshot: vi.fn(() => view),
    close: vi.fn(async () => {
      events.push("close");
    }),
  };
  selected = null;
  ports.create.mockImplementation(async (options) => {
    selected = options;
    return runtime;
  });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("supervised update composition (mocked lifecycle)", () => {
  it("admits only the exact observed Ready and preserves it before local replacement", async () => {
    input.replaceReady = {
      recordSha256: "a".repeat(64),
      buildId: "b".repeat(64),
    };
    ports.ready.mockResolvedValue(true);
    runtime.snapshot.mockReturnValueOnce({
      phase: "ready",
      version: "old",
      blockedBy: null,
    });
    expect((await runSupervisedUpdate(input)).status).toBe("verified_closed");
    expect(ports.ready).toHaveBeenCalledWith(
      path.join(root, "Library/Application Support/io.github.legrch.farol"),
      input.replaceReady,
    );
    expect(selected.replaceReady).toEqual(input.replaceReady);
    expect(runtime.prepareLocal).toHaveBeenCalledExactlyOnceWith(
      input.replaceReady.buildId,
    );
    expect(events.indexOf("backup")).toBeLessThan(events.indexOf("stage"));
  });

  it("hands the accepted target package's own Go declaration and build to the runtime", async () => {
    expect((await runSupervisedUpdate(input)).status).toBe("verified_closed");
    // The declaration is the one the resource observation captured from the
    // verified package, never a fresh read of the package path.
    expect(ports.goCore).toHaveBeenCalledExactlyOnceWith({
      goCore: resource.goCore,
      expected: input.expected,
    });
    expect(selected.goCoreArtifact).toBe(goCore.goCoreArtifact);
    expect(selected.goCoreBuild).toBe(goCore.goCoreBuild);
    // Selected from the verified capture, then those resources are verified again.
    expect(resource.verify.mock.invocationCallOrder[0]).toBeGreaterThan(
      ports.goCore.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ["no compiled core", "UPDATE_HELPER_GO_CORE_REQUIRED"],
    ["an invalid declaration", "GO_CORE_ARTIFACT_INVALID"],
  ])(
    "refuses a target package with %s before the predecessor is asked to quit",
    async (_name, code) => {
      ports.goCore.mockImplementation(() => {
        throw new Error(code);
      });
      expect(await runSupervisedUpdate(input)).toMatchObject({
        status: "blocked",
        code,
        predecessorClosed: false,
        helper: null,
      });
      expect(predecessor.requestQuit).not.toHaveBeenCalled();
      expect(ports.acquire).not.toHaveBeenCalled();
      expect(ports.backup).not.toHaveBeenCalled();
      expect(ports.create).not.toHaveBeenCalled();
    },
  );

  it("refuses resources that change after the declaration is read", async () => {
    resource.verify.mockResolvedValueOnce(false);
    expect(await runSupervisedUpdate(input)).toMatchObject({
      status: "blocked",
      code: "UPDATE_RESOURCES_CHANGED",
    });
    expect(predecessor.requestQuit).not.toHaveBeenCalled();
    expect(ports.create).not.toHaveBeenCalled();
  });

  it("refuses an unconfirmed original Ready before Quit or staging", async () => {
    input.replaceReady = {
      recordSha256: "a".repeat(64),
      buildId: "b".repeat(64),
    };
    ports.ready.mockResolvedValue(false);
    expect(await runSupervisedUpdate(input)).toMatchObject({
      status: "blocked",
      code: "UPDATE_ORIGINAL_READY_UNCONFIRMED",
    });
    expect(predecessor.requestQuit).not.toHaveBeenCalled();
    expect(ports.create).not.toHaveBeenCalled();
  });

  it("preserves the closed pair before staging and observes the original terminal before slot success", async () => {
    ports.obligations.mockResolvedValueOnce({
      obligations: ["APP_RUNNING:4321"],
      unreadable: [],
      changed: [],
    });
    const result = await runSupervisedUpdate(input);
    expect(result).toMatchObject({
      status: "verified_closed",
      source,
      target,
      predecessorClosed: true,
      helper: {
        operationId: operation.operationId,
        pid: operation.pid,
        completion: complete,
      },
    });
    expect(events).toEqual([
      "quit",
      "closed",
      "backup",
      "initialize",
      "stage",
      "restart",
      "closed",
      "close",
    ]);
    expect(ports.backup).toHaveBeenCalledWith({
      destinationParent: input.recoveryParent,
      predecessor,
      lease: await ports.acquire.mock.results[0].value,
      expectedSource: source,
    });
    expect(selected.localArchive).toEqual({
      path: input.archivePath,
      manifest: input.manifest,
    });
    expect(selected.resources.app).toBe(resource.app);
    expect(await selected.resources.verify()).toBe(true);
    backup.verify.mockResolvedValueOnce(false);
    expect(await selected.resources.verify()).toBe(false);
    expect(predecessor.requestQuit).toHaveBeenCalledTimes(1);
    expect(runtime.restart).toHaveBeenCalledTimes(1);
    expect(ports.release).not.toHaveBeenCalled();
  });

  it.each([
    "changed-source",
    "bad-checksum",
    "bad-size",
    "symlink",
    "hardlink",
    "shared-backup",
    "other-running",
    "pending-work",
    "unreadable",
    "changing",
    "lease-busy",
    "resources-changed",
  ])("refuses %s before Quit", async (kind) => {
    if (kind === "changed-source")
      ports.observe.mockReset().mockResolvedValue(target);
    if (kind === "bad-checksum") input.manifest.archiveSha256 = "0".repeat(64);
    if (kind === "bad-size") input.manifest.archiveSize++;
    if (kind === "symlink") {
      await fs.rename(input.archivePath, input.archivePath + ".original");
      await fs.symlink(input.archivePath + ".original", input.archivePath);
    }
    if (kind === "hardlink")
      await fs.link(input.archivePath, input.archivePath + ".alias");
    if (kind === "shared-backup") await fs.chmod(input.recoveryParent, 0o755);
    if (kind === "other-running")
      ports.obligations.mockResolvedValue({
        obligations: ["APP_RUNNING:9999"],
        unreadable: [],
        changed: [],
      });
    if (kind === "pending-work")
      ports.obligations.mockResolvedValue({
        obligations: ["TASK_OUTCOME_UNKNOWN:1"],
        unreadable: [],
        changed: [],
      });
    if (kind === "unreadable")
      ports.obligations.mockResolvedValue({
        obligations: [],
        unreadable: ["running:UNSAFE"],
        changed: [],
      });
    if (kind === "changing")
      ports.obligations.mockResolvedValue({
        obligations: [],
        unreadable: [],
        changed: ["running"],
      });
    if (kind === "lease-busy") ports.acquire.mockResolvedValue(null);
    if (kind === "resources-changed") resource.verify.mockResolvedValue(false);
    expect((await runSupervisedUpdate(input)).status).toBe("blocked");
    expect(predecessor.requestQuit).not.toHaveBeenCalled();
    expect(ports.backup).not.toHaveBeenCalled();
    expect(ports.create).not.toHaveBeenCalled();
  });

  it.each([
    "ready.json",
    "restore-pending.json",
    "download-pending.json",
    "package-cleanup-pending.json",
  ])(
    "retains existing %s without interpreting it as retryable",
    async (name) => {
      const directory = path.join(
        root,
        "Library/Application Support/io.github.legrch.farol/installed-updates",
      );
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, name);
      await fs.writeFile(file, "original unknown record", { mode: 0o600 });
      expect(await runSupervisedUpdate(input)).toMatchObject({
        status: "blocked",
        code: "UPDATE_EXISTING_OPERATION_REQUIRES_REVIEW",
      });
      expect(await fs.readFile(file, "utf8")).toBe("original unknown record");
      expect(predecessor.requestQuit).not.toHaveBeenCalled();
    },
  );

  it("does not perform a second Quit when the original outcome is lost", async () => {
    predecessor.requestQuit.mockRejectedValue(
      new Error("UPDATE_QUIT_REPLY_UNKNOWN"),
    );
    expect(await runSupervisedUpdate(input)).toMatchObject({
      status: "unknown",
      stage: "quit",
      predecessorClosed: false,
    });
    expect(predecessor.requestQuit).toHaveBeenCalledTimes(1);
    expect(ports.create).not.toHaveBeenCalled();
  });

  it("waits for the original closure and does not poll an unknown closure", async () => {
    predecessor.observeClosed.mockRejectedValueOnce(
      new Error("UPDATE_PREDECESSOR_STILL_PRESENT"),
    );
    expect((await runSupervisedUpdate(input)).status).toBe("verified_closed");
    expect(predecessor.observeClosed).toHaveBeenCalledTimes(3);
    predecessor.observeClosed
      .mockReset()
      .mockRejectedValue(new Error("UPDATE_PREDECESSOR_CLOSURE_UNCONFIRMED"));
    ports.observe.mockReset().mockResolvedValue(source);
    expect((await runSupervisedUpdate(input)).status).toBe("unknown");
    expect(predecessor.observeClosed).toHaveBeenCalledTimes(1);
  });

  it.each([
    "backup-copy",
    "backup-verification",
    "baseline",
    "archive-staging",
    "before-restart-backup",
  ])("stops on %s and retains confirmed predecessor closure", async (kind) => {
    if (kind === "backup-copy")
      ports.backup.mockRejectedValue(new Error("BACKUP_COPY_REFUSED"));
    if (kind === "backup-verification") backup.verify.mockResolvedValue(false);
    if (kind === "baseline")
      runtime.initialize.mockImplementation(async () => {
        runtime.snapshot.mockReturnValue({
          phase: "failed",
          recoveryRequired: true,
        });
      });
    if (kind === "archive-staging")
      runtime.prepareLocal.mockImplementation(async () => {
        runtime.snapshot.mockReturnValue({
          phase: "failed",
          recoveryRequired: true,
        });
      });
    if (kind === "before-restart-backup")
      backup.verify.mockResolvedValueOnce(true).mockResolvedValue(false);
    const result = await runSupervisedUpdate(input);
    expect(result.status).toBe(
      ["baseline", "archive-staging"].includes(kind) ? "unknown" : "blocked",
    );
    expect(result.predecessorClosed).toBe(true);
    expect(runtime.restart).not.toHaveBeenCalled();
    expect(ports.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: 0, signal: null, protocolError: null, terminal: null },
    { ...complete, terminal: { phase: "launch_requested", error: null } },
    { ...complete, terminal: { phase: "completed", error: null } },
    { ...complete, protocolError: "lost_terminal" },
    { ...complete, code: 70 },
    { ...complete, signal: "SIGKILL" },
    { ...complete, terminal: { phase: "failed", error: "RENAME_FAILED" } },
  ])("never equates helper handoff/exit with completion: %j", async (value) => {
    operation.completion = Promise.resolve(value);
    const result = await runSupervisedUpdate(input);
    expect(result.status).toBe("unknown");
    expect(result.helper.completion).toEqual(value);
    expect(runtime.restart).toHaveBeenCalledTimes(1);
    expect(ports.release).not.toHaveBeenCalled();
    expect(ports.observe).toHaveBeenCalledTimes(1);
  });

  it("keeps a known helper refusal blocked and retains its original terminal", async () => {
    operation.completion = Promise.resolve({
      code: 70,
      signal: null,
      protocolError: null,
      terminal: { phase: "refused", error: "PRECONDITION" },
    });
    runtime.restart.mockImplementation(async () => {
      selected.observeHelper(operation);
      runtime.snapshot.mockReturnValue({
        phase: "ready",
        blockedBy: "UPDATE_HELPER_REFUSED",
      });
    });
    expect(await runSupervisedUpdate(input)).toMatchObject({
      status: "blocked",
      code: "UPDATE_HELPER_REFUSED",
      helper: { completion: { code: 70 } },
    });
  });

  it("keeps the original child when runtime recording fails after spawn", async () => {
    runtime.restart.mockImplementation(async () => {
      selected.observeHelper(operation);
      runtime.snapshot.mockReturnValue({
        phase: "failed",
        recoveryRequired: true,
      });
    });
    const result = await runSupervisedUpdate(input);
    expect(result).toMatchObject({
      status: "unknown",
      helper: { pid: operation.pid, completion: complete },
    });
    expect(runtime.restart).toHaveBeenCalledTimes(1);
    expect(ports.release).not.toHaveBeenCalled();
  });

  it("waits for useful original completion instead of treating applying as success", async () => {
    let finish;
    operation.completion = new Promise((resolve) => {
      finish = resolve;
    });
    const result = runSupervisedUpdate(input);
    await vi.waitFor(() => expect(runtime.restart).toHaveBeenCalledTimes(1));
    expect(
      await Promise.race([
        result.then(() => "returned"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 5)),
      ]),
    ).toBe("pending");
    finish(complete);
    expect((await result).status).toBe("verified_closed");
  });

  it("keeps a bounded referenced wait and preserves timeout without replacement", async () => {
    let finish;
    operation.completion = new Promise((resolve) => {
      finish = resolve;
    });
    const nativeTimeout = globalThis.setTimeout;
    let referenced = false;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (callback, ms, ...args) => {
        const timer = nativeTimeout(callback, ms === 300_000 ? 5 : ms, ...args);
        if (ms === 300_000) referenced = timer.hasRef();
        return timer;
      },
    );
    const result = await runSupervisedUpdate(input);
    expect(referenced).toBe(true);
    expect(result).toMatchObject({
      status: "unknown",
      helper: { pid: operation.pid, completion: null },
    });
    finish(complete);
    await operation.completion;
    expect(result.status).toBe("unknown");
    expect(runtime.restart).toHaveBeenCalledTimes(1);
    expect(predecessor.requestQuit).toHaveBeenCalledTimes(1);
    expect(ports.release).not.toHaveBeenCalled();
  });

  it("bounds original predecessor observation without force or another Quit", async () => {
    predecessor.observeClosed.mockRejectedValue(
      new Error("UPDATE_PREDECESSOR_STILL_PRESENT"),
    );
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(120_001);
    expect(await runSupervisedUpdate(input)).toMatchObject({
      status: "unknown",
      code: "UPDATE_PREDECESSOR_EXIT_UNCONFIRMED",
    });
    expect(predecessor.requestQuit).toHaveBeenCalledTimes(1);
    expect(predecessor.observeClosed).toHaveBeenCalledTimes(1);
    expect(ports.backup).not.toHaveBeenCalled();
  });

  it.each([
    "legacy-feed",
    "wrong-target",
    "same-version",
    "relative-archive",
    "extra-authority",
  ])("rejects %s selection before lifecycle effects", async (kind) => {
    if (kind === "legacy-feed")
      input.manifest.repository = "legrch/farol-releases";
    if (kind === "wrong-target") input.expected.buildId = "0".repeat(64);
    if (kind === "same-version")
      input.expectedSource.version = input.expected.version;
    if (kind === "relative-archive") input.archivePath = "candidate.zip";
    if (kind === "extra-authority") input.force = true;
    await expect(runSupervisedUpdate(input)).rejects.toThrow();
    expect(ports.capture).not.toHaveBeenCalled();
    expect(ports.acquire).not.toHaveBeenCalled();
    expect(ports.create).not.toHaveBeenCalled();
  });

  it("retains a failed snapshot location without claiming a valid backup", async () => {
    const partialRoot = path.join(
      input.recoveryParent,
      "farol-closed-pair-fixture",
    );
    ports.backup.mockRejectedValue(
      Object.assign(new Error("SUPERVISED_BACKUP_UNCONFIRMED"), {
        partialRoot,
      }),
    );
    expect(await runSupervisedUpdate(input)).toMatchObject({
      status: "blocked",
      predecessorClosed: true,
      backup: null,
      partialBackupRoot: partialRoot,
    });
    expect(runtime.restart).not.toHaveBeenCalled();
  });

  it("does not lose a recorded terminal when close fails", async () => {
    runtime.close.mockRejectedValue(new Error("CLOSE_LOST"));
    expect(await runSupervisedUpdate(input)).toMatchObject({
      status: "verified_closed",
      controllerClose: "unconfirmed",
      helper: { completion: complete },
    });
  });

  it("refuses a mismatched slot after the actual helper reports success", async () => {
    ports.observe.mockReset().mockResolvedValue(source);
    expect(await runSupervisedUpdate(input)).toMatchObject({
      status: "unknown",
      stage: "verify-slot",
      code: "UPDATE_TARGET_UNCONFIRMED",
      helper: { completion: complete },
    });
  });

  it.each([
    "UPDATE_PREDECESSOR_RUN_MARKER_PRESENT",
    "UPDATE_PREDECESSOR_QUIT_CHANGED",
    "UPDATE_PREDECESSOR_ROOT_CHANGED",
    "UPDATE_PREDECESSOR_STILL_PRESENT",
  ])(
    "retains closed apply but refuses post-swap closure drift: %s",
    async (code) => {
      predecessor.observeClosed
        .mockReset()
        .mockResolvedValueOnce({ quitDigest: "c".repeat(64) })
        .mockRejectedValue(new Error(code));
      const result = await runSupervisedUpdate(input);
      expect(result).toMatchObject({
        status: "unknown",
        stage: "verify-closed",
        code,
        helper: { completion: complete },
      });
      expect(predecessor.observeClosed).toHaveBeenCalledTimes(2);
      expect(predecessor.requestQuit).toHaveBeenCalledTimes(1);
      expect(runtime.restart).toHaveBeenCalledTimes(1);
      expect(ports.release).not.toHaveBeenCalled();
    },
  );
});

// Regression coverage for the beta-only supervised handoff. This is NOT the
// normal stable-channel updater or a real installed 0.4.0 -> 0.4.1 journey.
describe("supervised handoff security gaps (owned disposable fixtures)", () => {
  it("refuses stable 0.4.0 -> 0.4.1 through the beta-only supervisor, before any effect", async () => {
    input.expectedSource.version = "0.4.0";
    input.expected.version = "0.4.1";
    input.expected.buildVersion = "55";
    input.manifest = {
      ...input.manifest,
      channel: "stable",
      version: "0.4.1",
      buildVersion: "55",
      archiveName: "Farol-0.4.1-darwin-arm64.zip",
    };
    await expect(runSupervisedUpdate(input)).rejects.toThrow(
      "UPDATE_SELECTED_IDENTITIES_INVALID",
    );
    expect(ports.capture).not.toHaveBeenCalled();
    expect(ports.acquire).not.toHaveBeenCalled();
    expect(ports.create).not.toHaveBeenCalled();
  });

  it.each(["slot-repair", "closed-repair"])(
    "retains an existing %s journal and refuses Quit",
    async (kind) => {
      const slot = path.join(root, "Applications/Farol.app");
      const journal =
        kind === "slot-repair"
          ? slot + ".repair.json"
          : path.join(path.dirname(slot), ".farol-closed-repair.json");
      await fs.mkdir(path.dirname(journal), { recursive: true });
      const original = "retained repair outcome unknown";
      await fs.writeFile(journal, original, { mode: 0o600 });
      const result = await runSupervisedUpdate(input);
      expect(result).toMatchObject({
        status: "blocked",
        code: "UPDATE_EXISTING_OPERATION_REQUIRES_REVIEW",
        predecessorClosed: false,
      });
      expect(await fs.readFile(journal, "utf8")).toBe(original);
      expect(predecessor.requestQuit).not.toHaveBeenCalled();
      expect(ports.create).not.toHaveBeenCalled();
    },
  );

  it.each(["symlink", "shared-writable"])(
    "refuses unsafe installed-updates %s without deleting private state",
    async (kind) => {
      const directory = path.join(
        root,
        "Library/Application Support/io.github.legrch.farol/installed-updates",
      );
      await fs.mkdir(path.dirname(directory), { recursive: true });
      const retained = path.join(root, "owned-unknown-evidence");
      await fs.mkdir(retained, { mode: 0o700 });
      await fs.writeFile(path.join(retained, "receipt"), "UNKNOWN");
      if (kind === "symlink") {
        await fs.symlink(retained, directory);
      } else {
        await fs.mkdir(directory, { mode: 0o700 });
        await fs.chmod(directory, 0o770);
      }
      const result = await runSupervisedUpdate(input);
      expect(result).toMatchObject({
        status: "blocked",
        code: "UPDATE_EXISTING_STATE_UNSAFE",
        predecessorClosed: false,
      });
      expect(await fs.readFile(path.join(retained, "receipt"), "utf8")).toBe(
        "UNKNOWN",
      );
      expect(predecessor.requestQuit).not.toHaveBeenCalled();
      expect(ports.backup).not.toHaveBeenCalled();
    },
  );

  it("refuses an archive changed after resource capture and before byte verification", async () => {
    ports.resources.mockImplementationOnce(async () => {
      await fs.writeFile(input.archivePath, "changed input after selection");
      return resource;
    });
    const result = await runSupervisedUpdate(input);
    expect(result).toMatchObject({
      status: "blocked",
      code: "UPDATE_ARCHIVE_UNSAFE",
      predecessorClosed: false,
    });
    expect(predecessor.requestQuit).not.toHaveBeenCalled();
    expect(ports.backup).not.toHaveBeenCalled();
    expect(runtime.restart).not.toHaveBeenCalled();
  });

  it("blocks a competing supervised invocation at its promotion lease without a second Quit", async () => {
    let hasLease = false;
    ports.acquire.mockImplementation(async () => {
      if (hasLease) return null;
      hasLease = true;
      return { file: "one-owned-promotion-lease" };
    });
    ports.observe.mockImplementation(async () =>
      events.includes("restart") ? target : source,
    );
    let releaseFirstQuit;
    predecessor.requestQuit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          events.push("quit");
          releaseFirstQuit = resolve;
        }),
    );
    const original = runSupervisedUpdate(input);
    await vi.waitFor(() => expect(releaseFirstQuit).toBeTypeOf("function"));
    const competitor = await runSupervisedUpdate(input);
    expect(competitor).toMatchObject({
      status: "blocked",
      code: "UPDATE_PROMOTION_BUSY",
      predecessorClosed: false,
    });
    expect(predecessor.requestQuit).toHaveBeenCalledTimes(1);
    expect(ports.backup).not.toHaveBeenCalled();
    releaseFirstQuit();
    expect(await original).toMatchObject({
      status: "verified_closed",
      predecessorClosed: true,
    });
    expect(predecessor.requestQuit).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a helper after ENOSPC while preserving the original archive", async () => {
    const priorArchive = await fs.readFile(input.archivePath);
    ports.backup.mockRejectedValue(
      Object.assign(new Error("ENOSPC"), {
        code: "ENOSPC",
      }),
    );
    const result = await runSupervisedUpdate(input);
    expect(result).toMatchObject({
      status: "blocked",
      stage: "preserve",
      code: "ENOSPC",
      predecessorClosed: true,
      helper: null,
      backup: null,
    });
    expect(runtime.prepareLocal).not.toHaveBeenCalled();
    expect(runtime.restart).not.toHaveBeenCalled();
    expect(ports.release).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(input.archivePath)).toEqual(priorArchive);
  });
});

describe("supervisor reporting with the real updater lifecycle", () => {
  function useRealUpdater() {
    const effects = {
      prepareLocal: vi.fn(async () => ({
        ok: true,
        update: { handle: "retained-local-fixture", manifest: input.manifest },
      })),
      retain: vi.fn(async () => undefined),
      restart: vi.fn(async () => {
        selected.observeHelper(operation);
        return { status: "accepted" };
      }),
      cancelPending: vi.fn(),
    };
    ports.create.mockImplementation(async (options) => {
      selected = options;
      runtime = new InstalledUpdater({
        now: () => 0,
        recover: async () => ({ ok: true, update: null }),
        discover: async () => {
          throw new Error("UNEXPECTED_DISCOVERY");
        },
        download: async () => {
          throw new Error("UNEXPECTED_DOWNLOAD");
        },
        restore: async () => {
          throw new Error("UNEXPECTED_RESTORE");
        },
        publish: options.publish,
        ...effects,
      });
      vi.spyOn(runtime, "close");
      return runtime;
    });
    return effects;
  }

  async function boundedResult(run) {
    let timer;
    try {
      return await Promise.race([
        run,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ status: "DRAIN_HUNG" }), 250);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  it.each(["downloading", "ready"])(
    "settles actual staging after a %s reporter failure and does not dispatch",
    async (phase) => {
      const effects = useRealUpdater();
      const result = await boundedResult(
        runSupervisedUpdate(input, (event) => {
          if (event.view?.phase === phase)
            throw new Error("PRIVATE_SINK_ERROR");
        }),
      );
      expect(result).toMatchObject({
        status: "blocked",
        stage: "stage",
        code: "UPDATE_PROGRESS_REPORT_FAILED",
        reportingFailure: "UPDATE_PROGRESS_REPORT_FAILED",
        predecessorClosed: true,
        helper: null,
      });
      expect(effects.prepareLocal).toHaveBeenCalledTimes(1);
      expect(effects.retain).toHaveBeenCalledTimes(1);
      expect(effects.restart).not.toHaveBeenCalled();
      expect(effects.cancelPending).toHaveBeenCalledTimes(1);
      expect(runtime.close).toHaveBeenCalledTimes(1);
      expect(ports.release).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_SINK_ERROR");
    },
  );

  it("settles actual applying and retains the original terminal after a reporter failure", async () => {
    const effects = useRealUpdater();
    const result = await boundedResult(
      runSupervisedUpdate(input, (event) => {
        if (event.view?.phase === "applying") throw new Error("OUTPUT_CLOSED");
      }),
    );
    expect(result).toMatchObject({
      status: "verified_closed",
      reportingFailure: "UPDATE_PROGRESS_REPORT_FAILED",
      helper: { operationId: operation.operationId, completion: complete },
    });
    expect(effects.restart).toHaveBeenCalledTimes(1);
    expect(effects.cancelPending).toHaveBeenCalledTimes(1);
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(ports.release).not.toHaveBeenCalled();
  });

  it("does not Quit when the prepared report cannot be delivered", async () => {
    const result = await runSupervisedUpdate(input, () => {
      throw new Error("OUTPUT_CLOSED");
    });
    expect(result).toMatchObject({
      status: "blocked",
      stage: "preflight",
      code: "UPDATE_PROGRESS_REPORT_FAILED",
      reportingFailure: "UPDATE_PROGRESS_REPORT_FAILED",
      predecessorClosed: false,
    });
    expect(predecessor.requestQuit).not.toHaveBeenCalled();
    expect(ports.release).toHaveBeenCalledTimes(1);
  });

  it("refuses asynchronous reporting before Quit and consumes its rejection", async () => {
    const result = await runSupervisedUpdate(input, async () => {
      throw new Error("ASYNC_OUTPUT_CLOSED");
    });
    expect(result).toMatchObject({
      status: "blocked",
      code: "UPDATE_PROGRESS_REPORT_FAILED",
      reportingFailure: "UPDATE_PROGRESS_REPORT_FAILED",
      predecessorClosed: false,
    });
    expect(predecessor.requestQuit).not.toHaveBeenCalled();
    expect(ports.release).toHaveBeenCalledTimes(1);
  });
});
