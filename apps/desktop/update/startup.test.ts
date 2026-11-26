import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BuildIdentitySchema,
  canonicalBuildIdentityPayload,
} from "../../../src/pkg/build-info/identity";
import {
  createStartup,
  type InstalledUpdateRelaunchOptions,
  type StartupPorts,
} from "./startup";
import type { ProcessRead } from "./process";

const captureMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/apps/desktop/installed-execution-snapshot", () => ({
  captureInstalledExecutionSnapshot: captureMock,
}));

// The startup observation is exercised through its ports and the read seams its
// options already carry: an in-memory record map for the shared slot and the
// private launch, real temporary directories for the guarded binding and journal
// reads and for installer custody. No release lookup, `ps`, app image or lease
// is ever reached.
const home = "/Users/farol-startup-fixture";
const profile = path.join(
  home,
  "Library/Application Support/io.github.legrch.farol",
);
const root = path.join(profile, "installed-updates");
const app = "/Applications/Farol.app";
const appDirectory = app + "/Contents/Resources/app";
const operationId = "a".repeat(32);
const opRoot = path.join(root, operationId);
const custodyFile = path.join(
  home,
  "Library/Application Support/io.github.legrch.farol-installer/current.json",
);
const ps = "Tue Oct  6 12:00:00 2026";
const helper = { pid: 1234, processStart: ps };

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
const newerBuild = identity("0.1.2-owner.beta.1", "3", "3");
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
const manifestOf = (build: typeof targetBuild, digest: string) => ({
  schema: "farol.github-release/1",
  repository: "legrch/farol",
  channel: "owner-beta",
  product: "Farol",
  bundleId: "io.github.legrch.farol",
  version: build.version,
  buildVersion: build.buildVersion,
  sourceCommit: build.sourceCommit,
  sourceTreeDigest: build.sourceTreeDigest,
  buildId: build.buildId,
  artifactSha256: digest,
  archiveSha256: "a".repeat(64),
  archiveName: "Farol-" + build.version + "-darwin-arm64.zip",
  archiveSize: 100,
  platform: "darwin",
  arch: "arm64",
  signing: "unsigned",
  notarized: false,
  sourceDirty: false,
});
const targetManifest = manifestOf(targetBuild, target.digest);

// The bytes the slot binding must hold. The strict shape is the private-launch
// binding's, so one fake serves both readers.
const bindingValue = (
  op: { operationId: string; source: unknown; target: unknown },
  location: string,
) => ({
  schema: "farol.installed-operation-slot/1",
  installLocation: location,
  operationId: op.operationId,
  source: op.source,
  target: op.target,
});
const slotBinding: StartupPorts["slotBinding"] = {
  file: "slot-binding.json",
  bytes: (op, location) =>
    Buffer.from(JSON.stringify(bindingValue(op, location)) + "\n"),
};

function ports(over: Partial<StartupPorts> = {}) {
  const value = {
    slotBinding,
    // The manifest field carries the parsed value, or nothing parseable.
    retained: vi.fn((record: { manifest?: unknown }) =>
      record.manifest && typeof record.manifest === "object"
        ? {
            ok: true as const,
            value: record.manifest as {
              artifactSha256: string;
              version: string;
              buildId: string;
              buildVersion: string;
            },
          }
        : { ok: false as const },
    ),
    compareVersions: vi.fn<StartupPorts["compareVersions"]>((left, right) =>
      left === right ? 0 : left > right ? 1 : -1,
    ),
    adoptionManifest: vi.fn<StartupPorts["adoptionManifest"]>(async () => ({
      ok: true,
      value: targetManifest as never,
    })),
    readProcess: vi.fn<ProcessRead>(async () => {
      throw { code: 1, stdout: "", stderr: "" };
    }),
  };
  // An override replaces a port wholesale; the mock type is kept for the caller.
  return { ...value, ...over } as typeof value;
}

// An explicitly undefined key removes the option, as a missing one would be.
type Override = {
  [K in keyof InstalledUpdateRelaunchOptions]?:
    InstalledUpdateRelaunchOptions[K] | undefined;
};
const withOverride = (
  options: InstalledUpdateRelaunchOptions,
  override: Override,
): InstalledUpdateRelaunchOptions => {
  const merged: Record<string, unknown> = { ...options, ...override };
  for (const key of Object.keys(merged))
    if (merged[key] === undefined) delete merged[key];
  return merged as InstalledUpdateRelaunchOptions;
};

type Phase = "completed" | "rolled_back" | "rollback_completed";

function fixture(
  build: typeof targetBuild = targetBuild,
  portOverrides: Partial<StartupPorts> = {},
) {
  const p = ports(portOverrides);
  const startup = createStartup(p);
  const records = new Map<string, unknown>();
  const builds = new Map<string, unknown>();
  const events: string[] = [];
  const observation = {
    recordAbsent: vi.fn(async (file: string) => !records.has(file)),
    canonicalOwnedDirectory: vi.fn(
      async (_file: string, _privateMode: boolean) => undefined,
    ),
    readRecord: vi.fn(
      async (
        file: string,
        _privateMode?: boolean,
        observeDigest?: (digest: string) => void,
        _maximumBytes?: number,
      ) => {
        events.push(path.basename(file));
        if (!records.has(file)) return null;
        const value = structuredClone(records.get(file));
        observeDigest?.(
          createHash("sha256")
            .update(JSON.stringify(value) + "\n")
            .digest("hex"),
        );
        return value;
      },
    ),
    readBuild: vi.fn(
      async (_directory: string, file: string, _timeoutMs: number) => {
        if (!builds.has(file)) throw new Error("ENOENT");
        return structuredClone(builds.get(file));
      },
    ),
    readProcess: vi.fn<ProcessRead>(async () => {
      events.push("process");
      throw { code: 1, stdout: "", stderr: "" };
    }),
    writeRecord: vi.fn(async (file: string, value: unknown) => {
      records.set(file, structuredClone(value));
    }),
  };
  const recheck = vi.fn(async () => undefined);
  captureMock.mockReset();
  captureMock.mockResolvedValue({
    app: "/fixture-private/image",
    directory: "/fixture-private/resources",
    executable: "/fixture-private/executable",
    digest: "unused",
    recheck,
  });
  const options: InstalledUpdateRelaunchOptions = {
    args: [],
    directory: appDirectory,
    userData: profile,
    build,
    observation,
    physicalFiles: fs,
    copyApp: vi.fn(async () => undefined),
  };
  const retained = (extra: Record<string, unknown> = {}) => ({
    schema: "farol.ready-update/1",
    handle: "/private/retained.zip",
    manifest: targetManifest,
    ...extra,
  });
  const journalOf = (phase: string, op = operation) => ({
    schema: "farol.installed-update-journal/1",
    ...op,
    phase,
  });
  const bind = (op = operation) =>
    records.set(
      path.join(root, op.operationId, "slot-binding.json"),
      bindingValue(op, "shared"),
    );
  const journal = (phase: string, op = operation) =>
    records.set(
      path.join(root, op.operationId, "journal.json"),
      journalOf(phase, op),
    );
  // An update the helper has finished: ready.json plus its binding and journal.
  const finished = (phase: Phase, installed: typeof target) => {
    records.set(
      path.join(root, "ready.json"),
      retained({ operation, helper: { ...helper } }),
    );
    bind();
    journal(phase);
    builds.set(app, installed);
  };
  return {
    p,
    startup,
    records,
    builds,
    events,
    observation,
    options,
    recheck,
    retained,
    journalOf,
    bind,
    journal,
    finished,
    observe: (override: Override = {}) =>
      startup.observeSharedSlotStartup(withOverride(options, override)),
    launch: (override: Override = {}) =>
      startup.observeCompletedPrivateLaunch(withOverride(options, override)),
  };
}

const message = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: Error) => error.message,
  );
const rejectsWith = async (promise: Promise<unknown>, expected: string) =>
  expect(await message(promise)).toBe(expected);

let spy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  spy = vi
    .spyOn(os, "userInfo")
    .mockReturnValue({ ...os.userInfo(), homedir: home });
});
afterEach(() => {
  spy?.mockRestore();
  vi.restoreAllMocks();
});

describe("operation binding and journal under a real directory", () => {
  let dir: string;
  let st: ReturnType<typeof createStartup>;
  beforeEach(async () => {
    dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "startup-")),
    );
    await fs.chmod(dir, 0o700);
    st = createStartup(ports());
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const opDir = () => path.join(dir, operationId);
  const write = async (name: string, value: unknown, mode = 0o600) => {
    await fs.mkdir(opDir(), { recursive: true, mode: 0o700 });
    await fs.chmod(opDir(), 0o700);
    const file = path.join(opDir(), name);
    await fs.writeFile(file, JSON.stringify(value) + "\n", { mode });
    await fs.chmod(file, mode);
  };
  const bound = () =>
    write("slot-binding.json", bindingValue(operation, "shared"));

  it("accepts the exact binding and returns the journal", async () => {
    await bound();
    await write("journal.json", {
      schema: "farol.installed-update-journal/1",
      ...operation,
      phase: "completed",
    });
    await st.readOperationBinding(dir, operation, "shared");
    expect(
      (await st.readOperationJournal(dir, operation, "shared")).phase,
    ).toBe("completed");
  });

  it("refuses a missing or different binding as unconfirmed", async () => {
    await fs.mkdir(opDir(), { mode: 0o700 });
    await rejectsWith(
      st.readOperationBinding(dir, operation, "shared"),
      "UPDATE_SLOT_BINDING_UNCONFIRMED",
    );
    await write("slot-binding.json", bindingValue(operation, "legacy"));
    await rejectsWith(
      st.readOperationBinding(dir, operation, "shared"),
      "UPDATE_SLOT_BINDING_UNCONFIRMED",
    );
  });

  it("lets an ordinary shared execution proceed without a binding, never with a wrong one", async () => {
    await fs.mkdir(opDir(), { mode: 0o700 });
    await st.readOperationBinding(
      dir,
      operation,
      "shared",
      undefined,
      "ordinary-shared-execution",
    );
    await write("slot-binding.json", bindingValue(operation, "legacy"));
    await rejectsWith(
      st.readOperationBinding(
        dir,
        operation,
        "shared",
        undefined,
        "ordinary-shared-execution",
      ),
      "UPDATE_SLOT_BINDING_UNCONFIRMED",
    );
  });

  it("refuses the ordinary purpose for a legacy location before reading anything", async () => {
    const read = vi.fn();
    await rejectsWith(
      st.readOperationBinding(
        dir,
        operation,
        "legacy",
        read,
        "ordinary-shared-execution",
      ),
      "UPDATE_SLOT_BINDING_UNCONFIRMED",
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses a binding file that is not private", async () => {
    await write("slot-binding.json", bindingValue(operation, "shared"), 0o644);
    await rejectsWith(
      st.readOperationBinding(dir, operation, "shared"),
      "UPDATE_RECORD_INVALID",
    );
  });

  it("refuses an operation directory that is not private", async () => {
    await bound();
    await fs.chmod(opDir(), 0o755);
    await rejectsWith(
      st.readOperationBinding(dir, operation, "shared"),
      "UPDATE_PRIVATE_STATE_INVALID",
    );
  });

  it("skips the physical directory checks only for an injected reader", async () => {
    await fs.mkdir(opDir(), { mode: 0o755 });
    await fs.chmod(opDir(), 0o755);
    const read = vi.fn(
      async (
        _file: string,
        _private?: boolean,
        observe?: (digest: string) => void,
        _maximum?: number,
      ) => {
        observe?.(
          createHash("sha256")
            .update(slotBinding.bytes(operation, "shared"))
            .digest("hex"),
        );
        return {};
      },
    );
    await st.readOperationBinding(dir, operation, "shared", read as never);
    expect(read).toHaveBeenCalledWith(
      path.join(opRoot.replace(root, dir), "slot-binding.json"),
      true,
      expect.any(Function),
      8192,
    );
  });

  it("reads the binding before the journal", async () => {
    await write("journal.json", {
      schema: "farol.installed-update-journal/1",
      ...operation,
      phase: "completed",
    });
    await rejectsWith(
      st.readStartupOperationJournal(dir, operation, "shared"),
      "UPDATE_SLOT_BINDING_UNCONFIRMED",
    );
  });

  it("reads a journal that is truly absent as none, in an authenticated operation only", async () => {
    await bound();
    expect(
      await st.readStartupOperationJournal(dir, operation, "shared"),
    ).toBeNull();
    // The strict journal reader has no none row.
    expect(
      await message(st.readOperationJournal(dir, operation, "shared")),
    ).toContain("invalid_type");
  });

  it("preserves a journal that is the JSON null as invalid evidence", async () => {
    await bound();
    await write("journal.json", null);
    await rejectsWith(
      st.readStartupOperationJournal(dir, operation, "shared"),
      "UPDATE_OPERATION_JOURNAL_INVALID",
    );
  });

  it("asks a separate absence observation before it accepts none", async () => {
    await bound();
    const absent = vi.fn(async () => false);
    await rejectsWith(
      st.readStartupOperationJournal(
        dir,
        operation,
        "shared",
        undefined,
        "update",
        absent,
      ),
      "UPDATE_OPERATION_JOURNAL_INVALID",
    );
    expect(absent).toHaveBeenCalledWith(path.join(opDir(), "journal.json"));
  });

  it("refuses a malformed journal and one of another operation", async () => {
    await bound();
    await write("journal.json", { schema: "wrong" });
    expect(
      await message(st.readStartupOperationJournal(dir, operation, "shared")),
    ).toContain("invalid");
    await write("journal.json", {
      schema: "farol.installed-update-journal/1",
      ...operation,
      target: { ...target, digest: "9".repeat(64) },
      phase: "completed",
    });
    await rejectsWith(
      st.readStartupOperationJournal(dir, operation, "shared"),
      "UPDATE_OPERATION_IDENTITY_MISMATCH",
    );
  });
});

describe("readInstallerManifestForStartup", () => {
  const custodyRecord = (over: Record<string, unknown> = {}) => ({
    schema: "farol.bootstrap-install/2",
    id: "b".repeat(32),
    phase: "completed",
    version: targetBuild.version,
    buildId: targetBuild.buildId,
    digest: target.digest,
    installed: app,
    profile,
    manifest: targetManifest,
    ...over,
  });

  it("reads absent custody as none and passes the bounded read", async () => {
    const f = fixture();
    expect(
      await f.startup.readInstallerManifestForStartup(
        f.options,
        profile,
        targetBuild,
      ),
    ).toBeNull();
    expect(f.observation.readRecord).toHaveBeenCalledWith(
      custodyFile,
      true,
      undefined,
      4096,
    );
  });

  it("refuses custody that exists but reads as null", async () => {
    const f = fixture();
    f.observation.readRecord.mockResolvedValueOnce(null as never);
    f.records.set(custodyFile, null);
    await rejectsWith(
      f.startup.readInstallerManifestForStartup(
        f.options,
        profile,
        targetBuild,
      ),
      "UPDATE_INSTALLER_CUSTODY_UNCONFIRMED",
    );
  });

  it("refuses a custody read that fails", async () => {
    const f = fixture();
    f.observation.readRecord.mockRejectedValueOnce(new Error("EIO"));
    await rejectsWith(
      f.startup.readInstallerManifestForStartup(
        f.options,
        profile,
        targetBuild,
      ),
      "UPDATE_INSTALLER_CUSTODY_UNCONFIRMED",
    );
  });

  it("refuses a pending placement, a malformed record and another profile", async () => {
    for (const record of [
      custodyRecord({ phase: "pending" }),
      { schema: "farol.bootstrap-install/2" },
      custodyRecord({ profile: "/elsewhere" }),
      custodyRecord({ digest: "9".repeat(64) }),
    ]) {
      const f = fixture();
      f.records.set(custodyFile, record);
      await rejectsWith(
        f.startup.readInstallerManifestForStartup(
          f.options,
          profile,
          targetBuild,
        ),
        "UPDATE_INSTALLER_CUSTODY_UNCONFIRMED",
      );
    }
  });

  it("returns the verified manifest of a completed placement of this build, and none for another", async () => {
    const f = fixture();
    f.records.set(custodyFile, custodyRecord());
    expect(
      (
        await f.startup.readInstallerManifestForStartup(
          f.options,
          profile,
          targetBuild,
        )
      )?.artifactSha256,
    ).toBe(target.digest);
    expect(
      await f.startup.readInstallerManifestForStartup(
        f.options,
        profile,
        sourceBuild,
      ),
    ).toBeNull();
  });

  describe("without read seams, under a real home", () => {
    let tmp: string;
    const install = () =>
      path.join(
        tmp,
        "Library/Application Support/io.github.legrch.farol-installer",
      );
    beforeEach(async () => {
      tmp = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "custody-")),
      );
      vi.mocked(os.userInfo).mockReturnValue({
        ...os.userInfo(),
        homedir: tmp,
      });
      await fs.mkdir(path.dirname(install()), { recursive: true });
    });
    afterEach(async () => {
      await fs.rm(tmp, { recursive: true, force: true });
    });
    const real = () => {
      const f = fixture();
      return f.startup.readInstallerManifestForStartup(
        withOverride(f.options, { observation: undefined }),
        profile,
        targetBuild,
      );
    };

    it("reads a missing custody directory as none", async () => {
      expect(await real()).toBeNull();
    });

    it("refuses custody that is not a directory", async () => {
      await fs.writeFile(install(), "x");
      await rejectsWith(real(), "UPDATE_INSTALLER_CUSTODY_UNCONFIRMED");
    });

    it("refuses a custody directory that others can write", async () => {
      await fs.mkdir(install(), { mode: 0o700 });
      await fs.chmod(install(), 0o755);
      await rejectsWith(real(), "UPDATE_INSTALLER_CUSTODY_UNCONFIRMED");
    });

    it("reads an owned private custody directory with no record as none", async () => {
      await fs.mkdir(install(), { mode: 0o700 });
      await fs.chmod(install(), 0o700);
      expect(await real()).toBeNull();
    });
  });
});

describe("recheckSharedUpdateSource", () => {
  it("accepts the unchanged source and checks the slot before and after the measure", async () => {
    const f = fixture();
    f.builds.set(app, target);
    await f.startup.recheckSharedUpdateSource(f.options, target);
    expect(f.observation.canonicalOwnedDirectory.mock.calls).toEqual([
      [app, false],
      [app, false],
    ]);
    expect(f.observation.readBuild).toHaveBeenCalledWith(
      appDirectory,
      app,
      30000,
    );
  });

  it("refuses a changed digest, version or build as a changed source", async () => {
    for (const changed of [
      { ...target, digest: "9".repeat(64) },
      { ...target, version: "9.9.9" },
      { ...target, buildId: "9".repeat(64) },
    ]) {
      const f = fixture();
      f.builds.set(app, changed);
      await rejectsWith(
        f.startup.recheckSharedUpdateSource(f.options, target),
        "UPDATE_ACCEPTED_SOURCE_CHANGED",
      );
    }
  });

  it("does not trust a malformed measure and refuses a slot that fails the second check", async () => {
    const f = fixture();
    f.builds.set(app, { digest: "x" });
    expect(
      await message(f.startup.recheckSharedUpdateSource(f.options, target)),
    ).toContain("invalid");
    const g = fixture();
    g.builds.set(app, target);
    g.observation.canonicalOwnedDirectory
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("UPDATE_PRIVATE_STATE_INVALID"));
    await rejectsWith(
      g.startup.recheckSharedUpdateSource(g.options, target),
      "UPDATE_PRIVATE_STATE_INVALID",
    );
  });
});

describe("observeSharedSlotStartup", () => {
  const receipt = (
    build = targetBuild,
    over: Record<string, unknown> = {},
  ) => ({
    schema: "farol.promotion-plan/1",
    operation: "applied",
    product: "Farol",
    version: build.version,
    sourceCommit: build.sourceCommit,
    sourceTreeDigest: build.sourceTreeDigest,
    sourceDirty: false,
    artifactSha256: target.digest,
    source: "/private/source",
    destination: app,
    receipt: app + ".receipt.json",
    overwrite: false,
    legacyMutation: false,
    activation: { userData: profile, drained: true, obligations: [] },
    verifiedDestinationSha256: target.digest,
    ...over,
  });

  it("is not its concern outside the shared slot", async () => {
    const f = fixture();
    expect(
      await f.observe({ directory: "/Users/x/Applications/Farol.app" }),
    ).toBeNull();
    expect(f.observation.readRecord).not.toHaveBeenCalled();
  });

  it("refuses any build or resource identity it cannot confirm", async () => {
    const cases: Override[] = [
      { userData: "/elsewhere" },
      { copyApp: undefined },
      { physicalFiles: undefined },
      { build: { ...targetBuild, sourceDirty: true } },
      { build: { ...targetBuild, buildId: "f".repeat(64) } },
    ];
    for (const override of cases) {
      const f = fixture();
      f.records.set(app + ".receipt.json", receipt());
      await rejectsWith(
        f.observe(override),
        "UPDATE_EXECUTION_RESOURCES_UNCONFIRMED",
      );
      expect(captureMock).not.toHaveBeenCalled();
    }
  });

  it("observes installer custody before any other baseline evidence", async () => {
    const f = fixture();
    f.records.set(app + ".receipt.json", receipt());
    f.records.set(custodyFile, { schema: "farol.bootstrap-install/2" });
    await rejectsWith(f.observe(), "UPDATE_INSTALLER_CUSTODY_UNCONFIRMED");
    expect(f.events).toEqual(["current.json"]);
  });

  describe("a promoted build", () => {
    it("is accepted and its captured image is anchored on the verified digest", async () => {
      const f = fixture();
      f.records.set(app + ".receipt.json", receipt());
      f.builds.set(app, target);
      const guard = await f.observe();
      expect(captureMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceApp: app,
          privateParent: root,
          expectedDigest: target.digest,
        }),
      );
      expect(guard?.resourcesOrigin).toMatchObject({
        kind: "shared-slot",
        slot: app,
      });
      await guard?.recheck();
      expect(f.recheck).toHaveBeenCalledTimes(1);
      await guard?.resourcesOrigin?.recheckUpdateSource();
      expect(f.observation.readBuild).toHaveBeenCalled();
    });

    it("reads the evidence in its stored order", async () => {
      const f = fixture();
      f.records.set(app + ".receipt.json", receipt());
      await f.observe();
      expect(f.events).toEqual([
        "current.json",
        "ready.json",
        "last-update.json",
        "Farol.app.repair.json",
        ".farol-closed-repair.json",
        "restore-pending.json",
        "Farol.app.receipt.json",
      ]);
    });

    it("refuses a receipt that does not describe this slot, profile and build", async () => {
      const bad: Record<string, unknown>[] = [
        { destination: "/Applications/Other.app" },
        { receipt: "/elsewhere.json" },
        { activation: { userData: "/x", drained: true, obligations: [] } },
        { sourceCommit: "9".repeat(40) },
        { sourceTreeDigest: "9".repeat(64) },
        { version: "9.9.9" },
        { artifactSha256: "9".repeat(64) },
      ];
      for (const over of bad) {
        const f = fixture();
        f.records.set(app + ".receipt.json", receipt(targetBuild, over));
        await rejectsWith(f.observe(), "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
        expect(captureMock).not.toHaveBeenCalled();
      }
    });

    it("refuses a restore intent beside a promoted baseline, null or valid", async () => {
      const f = fixture();
      f.records.set(app + ".receipt.json", receipt());
      f.builds.set(app, target);
      f.records.set(path.join(root, "restore-pending.json"), null);
      await rejectsWith(f.observe(), "UPDATE_RECORD_INVALID");
      const g = fixture();
      g.records.set(app + ".receipt.json", receipt());
      g.builds.set(app, target);
      g.records.set(path.join(root, "restore-pending.json"), {
        schema: "farol.update-restore-intent/1",
        action: "recover",
        operation,
        priorPhase: "prepared",
        helper: { ...helper },
      });
      await rejectsWith(g.observe(), "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
      expect(captureMock).not.toHaveBeenCalled();
    });

    it("refuses a receipt that exists as the JSON null", async () => {
      const f = fixture();
      f.records.set(app + ".receipt.json", null);
      expect(await message(f.observe())).toContain("invalid");
    });
  });

  describe("an operation in flight", () => {
    it.each([
      ["completed", target, targetBuild],
      ["rolled_back", source, sourceBuild],
    ] as const)(
      "lets the %s build start once the helper has ended",
      async (phase, installed, build) => {
        const f = fixture(build);
        f.finished(phase, installed);
        const guard = await f.observe();
        expect(guard).not.toBeNull();
        expect(captureMock).toHaveBeenCalledWith(
          expect.objectContaining({ expectedDigest: installed.digest }),
        );
      },
    );

    it("refuses while the helper is live", async () => {
      const f = fixture();
      f.finished("completed", target);
      f.observation.readProcess.mockResolvedValue({
        stdout: ps + "\n",
        stderr: "",
      });
      await rejectsWith(f.observe(), "UPDATE_HELPER_EXIT_UNCONFIRMED");
      expect(captureMock).not.toHaveBeenCalled();
    });

    it("refuses when the helper state is unknown", async () => {
      const unknown: [string, () => unknown][] = [
        ["unreadable", () => Promise.reject(new Error("EPERM"))],
        [
          "other start",
          () => ({ stdout: "Tue Oct  6 12:00:01 2026\n", stderr: "" }),
        ],
        ["stderr", () => ({ stdout: ps, stderr: "warning" })],
      ];
      for (const [, read] of unknown) {
        const f = fixture();
        f.finished("completed", target);
        f.observation.readProcess.mockImplementation(read as never);
        await rejectsWith(f.observe(), "UPDATE_HELPER_EXIT_UNCONFIRMED");
      }
    });

    it("refuses a record with no helper to observe", async () => {
      const f = fixture();
      f.finished("completed", target);
      f.records.set(
        path.join(root, "ready.json"),
        f.retained({ operation, helper: null }),
      );
      await rejectsWith(f.observe(), "UPDATE_HELPER_EXIT_UNCONFIRMED");
    });

    it("refuses when the installed build is neither side of the operation", async () => {
      const f = fixture();
      f.finished("completed", { ...target, digest: "9".repeat(64) });
      await rejectsWith(f.observe(), "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    });

    it("refuses when the installed build is not the one running", async () => {
      const f = fixture(targetBuild);
      f.finished("rolled_back", source);
      await rejectsWith(f.observe(), "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    });

    it("refuses a manifest that does not describe the operation target", async () => {
      const f = fixture();
      f.finished("completed", target);
      f.records.set(
        path.join(root, "ready.json"),
        f.retained({
          operation,
          helper: { ...helper },
          manifest: { ...targetManifest, artifactSha256: "9".repeat(64) },
        }),
      );
      await rejectsWith(f.observe(), "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    });

    it("refuses a manifest that does not parse", async () => {
      const f = fixture();
      f.finished("completed", target);
      f.records.set(
        path.join(root, "ready.json"),
        f.retained({ operation, helper: { ...helper }, manifest: null }),
      );
      await rejectsWith(f.observe(), "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    });

    it("lets a historical operation without a binding authenticate the image, but never a wrong binding", async () => {
      const f = fixture();
      f.finished("completed", target);
      f.records.delete(path.join(opRoot, "slot-binding.json"));
      expect(await f.observe()).not.toBeNull();
      const g = fixture();
      g.finished("completed", target);
      g.records.set(
        path.join(opRoot, "slot-binding.json"),
        bindingValue(operation, "legacy"),
      );
      await rejectsWith(g.observe(), "UPDATE_SLOT_BINDING_UNCONFIRMED");
    });

    it("refuses an operation that neither side of which is the running build", async () => {
      const f = fixture(newerBuild);
      f.finished("completed", target);
      await rejectsWith(f.observe(), "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    });

    it("treats an absent journal as the none row, not as a refusal", async () => {
      const f = fixture();
      f.finished("completed", target);
      f.records.delete(path.join(opRoot, "journal.json"));
      expect(await f.observe()).not.toBeNull();
    });

    it("refuses a restore intent of another operation", async () => {
      const f = fixture();
      f.finished("completed", target);
      f.records.set(path.join(root, "restore-pending.json"), {
        schema: "farol.update-restore-intent/1",
        action: "recover",
        operation: { ...operation, operationId: "c".repeat(32) },
        priorPhase: "prepared",
        helper: { ...helper },
      });
      await rejectsWith(f.observe(), "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    });

    it("refuses a restore intent that is present but holds JSON null", async () => {
      const f = fixture();
      f.finished("completed", target);
      f.records.set(path.join(root, "restore-pending.json"), null);
      await rejectsWith(f.observe(), "UPDATE_RECORD_INVALID");
    });

    it("reads a truly absent restore intent as no restore pending", async () => {
      const f = fixture();
      f.finished("completed", target);
      expect(f.records.has(path.join(root, "restore-pending.json"))).toBe(
        false,
      );
      expect(await f.observe()).not.toBeNull();
    });

    it("observes the helper of a started restore intent, not the record's", async () => {
      const f = fixture();
      f.finished("completed", target);
      f.records.set(path.join(root, "restore-pending.json"), {
        schema: "farol.update-restore-intent/1",
        action: "recover",
        operation,
        priorPhase: "prepared",
        helper: { pid: 4321, processStart: ps },
      });
      f.observation.readProcess.mockResolvedValue({ stdout: ps, stderr: "" });
      await rejectsWith(f.observe(), "UPDATE_HELPER_EXIT_UNCONFIRMED");
      expect(f.observation.readProcess).toHaveBeenCalledWith(4321);
    });

    it("observes the record's helper while the restore intent has not started", async () => {
      const f = fixture();
      f.finished("completed", target);
      f.records.set(path.join(root, "restore-pending.json"), {
        schema: "farol.update-restore-intent/1",
        action: "recover",
        operation,
        priorPhase: "prepared",
        notStartedAt: target,
        helper: { pid: 4321, processStart: ps },
      });
      await f.observe();
      expect(f.observation.readProcess).toHaveBeenCalledWith(helper.pid);
    });

    it("refuses a restore intent beside a preparation, null or valid", async () => {
      for (const [value, code] of [
        [null, "UPDATE_RECORD_INVALID"],
        [
          {
            schema: "farol.update-restore-intent/1",
            action: "recover",
            operation,
            priorPhase: "prepared",
            helper: { ...helper },
          },
          "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED",
        ],
      ] as const) {
        const f = fixture();
        f.records.set(
          path.join(root, "ready.json"),
          f.retained({ operation: null, preparation: operation }),
        );
        f.bind();
        f.builds.set(app, target);
        f.records.set(path.join(root, "restore-pending.json"), value);
        await rejectsWith(f.observe(), code);
      }
      expect(captureMock).not.toHaveBeenCalled();
    });

    it("accepts a preparation that names this build, unless its binding is wrong", async () => {
      const f = fixture();
      f.records.set(
        path.join(root, "ready.json"),
        f.retained({ operation: null, preparation: operation }),
      );
      f.bind();
      f.builds.set(app, target);
      expect(await f.observe()).not.toBeNull();
      expect(captureMock).toHaveBeenCalledWith(
        expect.objectContaining({ expectedDigest: target.digest }),
      );
      const g = fixture();
      g.records.set(
        path.join(root, "ready.json"),
        g.retained({ operation: null, preparation: operation }),
      );
      g.records.set(
        path.join(opRoot, "slot-binding.json"),
        bindingValue(operation, "legacy"),
      );
      await rejectsWith(g.observe(), "UPDATE_SLOT_BINDING_UNCONFIRMED");
    });
  });

  describe("a closed repair", () => {
    const repair = (over: Record<string, unknown> = {}) => ({
      schema: "farol.closed-repair/1",
      operationId,
      phase: "installed",
      destination: app,
      userData: profile,
      source,
      target,
      sourceCommit: "1".repeat(40),
      sourceTreeDigest: "1".repeat(64),
      sourceDirty: false,
      previous: "/p",
      quarantine: "/q",
      quarantined: false,
      quitDigest: "5".repeat(64),
      ...over,
    });
    const journalOfRepair = (receipt: ReturnType<typeof repair>) => ({
      schema: "farol.closed-repair-journal/1",
      phase: receipt.phase,
      receipt,
      sourceInode: [1, 2],
      targetInode: [3, 4],
      updatesInode: null,
    });
    const place = (f: ReturnType<typeof fixture>, receipt = repair()) => {
      f.records.set(app + ".repair.json", receipt);
      f.records.set(
        "/Applications/.farol-closed-repair.json",
        journalOfRepair(receipt),
      );
    };

    it("takes the target of an installed repair and the source of a rolled-back one", async () => {
      const f = fixture(targetBuild);
      place(f);
      f.builds.set(app, target);
      await f.observe();
      expect(captureMock).toHaveBeenCalledWith(
        expect.objectContaining({ expectedDigest: target.digest }),
      );
      const g = fixture(sourceBuild);
      place(g, repair({ phase: "rolled_back" }));
      await g.observe();
      expect(captureMock).toHaveBeenCalledWith(
        expect.objectContaining({ expectedDigest: source.digest }),
      );
    });

    it("refuses a restore intent beside a closed repair, null or valid", async () => {
      for (const [value, code] of [
        [null, "UPDATE_RECORD_INVALID"],
        [
          {
            schema: "farol.update-restore-intent/1",
            action: "recover",
            operation,
            priorPhase: "prepared",
            helper: { ...helper },
          },
          "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED",
        ],
      ] as const) {
        const f = fixture(targetBuild);
        place(f);
        f.builds.set(app, target);
        f.records.set(path.join(root, "restore-pending.json"), value);
        await rejectsWith(f.observe(), code);
      }
      expect(captureMock).not.toHaveBeenCalled();
    });

    it("refuses a repair whose receipt and journal disagree, or that is not for this slot and profile", async () => {
      const disagree = fixture();
      const receipt = repair();
      disagree.records.set(app + ".repair.json", receipt);
      disagree.records.set("/Applications/.farol-closed-repair.json", {
        ...journalOfRepair(receipt),
        receipt: repair({ quarantine: "/other" }),
      });
      await rejectsWith(disagree.observe(), "UPDATE_REPAIR_RECOVERY_REQUIRED");
      for (const over of [
        { destination: "/Applications/Other.app" },
        { userData: "/elsewhere" },
      ]) {
        const f = fixture();
        place(f, repair(over));
        await rejectsWith(f.observe(), "UPDATE_REPAIR_RECOVERY_REQUIRED");
      }
      const phase = fixture();
      phase.records.set(app + ".repair.json", receipt);
      phase.records.set("/Applications/.farol-closed-repair.json", {
        ...journalOfRepair(receipt),
        phase: "rolled_back",
      });
      await rejectsWith(phase.observe(), "UPDATE_REPAIR_RECOVERY_REQUIRED");
    });

    it("refuses half of the repair evidence", async () => {
      const f = fixture();
      f.records.set(app + ".repair.json", repair());
      expect(await message(f.observe())).toContain("invalid");
    });

    it("refuses a repaired build that is not the one running", async () => {
      const f = fixture(sourceBuild);
      place(f);
      await rejectsWith(f.observe(), "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    });
  });

  describe("first-launch adoption", () => {
    const adopted = path.join(root, "adopted-baseline.json");
    const baseline = (over: Record<string, unknown> = {}) => ({
      schema: "farol.adopted-baseline/1",
      slot: app,
      userData: profile,
      manifest: targetManifest,
      adoptedAt: "2026-10-06T00:00:00.000Z",
      ...over,
    });

    it("adopts a copy with no evidence once its tree matches the published manifest, then records it", async () => {
      const f = fixture();
      f.builds.set(app, target);
      await f.observe();
      expect(f.p.adoptionManifest).toHaveBeenCalledWith({
        build: targetBuild,
        root,
      });
      expect(f.observation.writeRecord).toHaveBeenCalledWith(
        adopted,
        expect.objectContaining({ slot: app, userData: profile }),
      );
      expect(captureMock).toHaveBeenCalledWith(
        expect.objectContaining({ expectedDigest: target.digest }),
      );
    });

    it("refuses a restore intent beside an adoptable copy, null or valid", async () => {
      for (const [value, code] of [
        [null, "UPDATE_RECORD_INVALID"],
        [
          {
            schema: "farol.update-restore-intent/1",
            action: "recover",
            operation,
            priorPhase: "prepared",
            helper: { ...helper },
          },
          "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED",
        ],
      ] as const) {
        const f = fixture();
        f.builds.set(app, target);
        f.records.set(path.join(root, "restore-pending.json"), value);
        await rejectsWith(f.observe(), code);
        expect(f.observation.writeRecord).not.toHaveBeenCalled();
      }
      expect(captureMock).not.toHaveBeenCalled();
    });

    it("adopts when the restore intent is truly absent", async () => {
      const f = fixture();
      f.builds.set(app, target);
      expect(f.records.has(path.join(root, "restore-pending.json"))).toBe(
        false,
      );
      expect(await f.observe()).not.toBeNull();
    });

    it("publishes the record only after the image is captured", async () => {
      const f = fixture();
      f.builds.set(app, target);
      captureMock.mockRejectedValueOnce(new Error("UPDATE_CAPTURE_FAILED"));
      await rejectsWith(f.observe(), "UPDATE_CAPTURE_FAILED");
      expect(f.observation.writeRecord).not.toHaveBeenCalled();
    });

    it("never touches the network for a recorded baseline", async () => {
      const f = fixture();
      f.records.set(adopted, baseline());
      await f.observe();
      expect(f.p.adoptionManifest).not.toHaveBeenCalled();
      expect(f.observation.writeRecord).not.toHaveBeenCalled();
    });

    it("refuses a recorded baseline for another slot or profile, or one that is the JSON null", async () => {
      for (const record of [
        baseline({ slot: "/Applications/Other.app" }),
        baseline({ userData: "/elsewhere" }),
        { schema: "wrong" },
        null,
      ]) {
        const f = fixture();
        f.records.set(adopted, record);
        await rejectsWith(f.observe(), "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
        expect(f.p.adoptionManifest).not.toHaveBeenCalled();
      }
    });

    it("surfaces the lookup's own refusal code", async () => {
      const f = fixture(targetBuild, {
        adoptionManifest: vi.fn(async () => ({
          ok: false as const,
          code: "UPDATE_ADOPTION_NETWORK_FAILURE",
        })),
      });
      await rejectsWith(f.observe(), "UPDATE_ADOPTION_NETWORK_FAILURE");
    });

    it("refuses a tree that is unreadable or differs from the manifest", async () => {
      const unreadable = fixture();
      await rejectsWith(
        unreadable.observe(),
        "UPDATE_ADOPTION_TREE_UNREADABLE",
      );
      const differs = fixture();
      differs.builds.set(app, { ...target, digest: "9".repeat(64) });
      await rejectsWith(differs.observe(), "UPDATE_ADOPTION_TREE_MISMATCH");
      expect(differs.observation.writeRecord).not.toHaveBeenCalled();
    });

    it("anchors a first launch on the installer's manifest without a lookup", async () => {
      const f = fixture();
      f.builds.set(app, target);
      f.records.set(custodyFile, {
        schema: "farol.bootstrap-install/2",
        id: "b".repeat(32),
        phase: "completed",
        version: targetBuild.version,
        buildId: targetBuild.buildId,
        digest: target.digest,
        installed: app,
        profile,
        manifest: targetManifest,
      });
      await f.observe();
      expect(f.p.adoptionManifest).not.toHaveBeenCalled();
    });

    it("closes the failure when the record cannot be written", async () => {
      const f = fixture();
      f.builds.set(app, target);
      f.observation.writeRecord.mockRejectedValueOnce(new Error("EIO"));
      await rejectsWith(f.observe(), "UPDATE_ADOPTION_RECORD_UNWRITTEN");
    });

    it("adopts alongside a plain retained download, but not a malformed one", async () => {
      const ok = fixture();
      ok.builds.set(app, target);
      ok.records.set(
        path.join(root, "ready.json"),
        ok.retained({ operation: null }),
      );
      await ok.observe();
      expect(captureMock).toHaveBeenCalled();
      const bad = fixture();
      bad.builds.set(app, target);
      bad.records.set(
        path.join(root, "ready.json"),
        bad.retained({ operation: null, manifest: null }),
      );
      // Not a retained download, so the promotion receipt it lacks is required.
      expect(await message(bad.observe())).toContain("invalid");
      expect(captureMock).not.toHaveBeenCalled();
    });

    it("refuses adoption while a saved receipt keeps another baseline in play", async () => {
      const f = fixture();
      f.builds.set(app, target);
      f.records.set(path.join(root, "last-update.json"), null);
      expect(await message(f.observe())).not.toBeNull();
      expect(f.p.adoptionManifest).not.toHaveBeenCalled();
      expect(captureMock).not.toHaveBeenCalled();
    });
  });

  describe("a manually replaced slot", () => {
    // The last settled update targeted 0.1.1; a newer 0.1.2 was dragged over it.
    const settle = (f: ReturnType<typeof fixture>, over = {}) => {
      f.records.set(path.join(root, "last-update.json"), {
        ...f.retained({ operation, helper: { ...helper } }),
        phase: "completed",
        observedAt: "2026-10-06T13:00:00.000Z",
        runningBuildId: target.buildId,
        ...over,
      });
      f.bind();
      f.journal("completed");
      f.builds.set(app, {
        digest: "6".repeat(64),
        version: newerBuild.version,
        buildId: newerBuild.buildId,
      });
      f.p.adoptionManifest.mockResolvedValue({
        ok: true,
        value: manifestOf(newerBuild, "6".repeat(64)) as never,
      });
    };

    it("falls through to adoption of the newer build", async () => {
      const f = fixture(newerBuild);
      settle(f);
      await f.observe();
      expect(f.p.adoptionManifest).toHaveBeenCalledTimes(1);
      expect(captureMock).toHaveBeenCalledWith(
        expect.objectContaining({ expectedDigest: "6".repeat(64) }),
      );
    });

    it("classifies a present null or malformed restore marker as an invalid record", async () => {
      for (const value of [null, {}, { schema: "other" }]) {
        const f = fixture(newerBuild);
        settle(f);
        f.records.set(path.join(root, "restore-pending.json"), value);
        await rejectsWith(f.observe(), "UPDATE_RECORD_INVALID");
      }
      expect(captureMock).not.toHaveBeenCalled();
    });

    it("refuses when the settled evidence does not hold", async () => {
      const cases: [string, (f: ReturnType<typeof fixture>) => void][] = [
        ["journal phase differs", (f) => f.journal("verified")],
        [
          "running build not the settled one",
          (f) =>
            f.records.set(path.join(root, "last-update.json"), {
              ...f.retained({ operation, helper: { ...helper } }),
              phase: "completed",
              observedAt: "x",
              runningBuildId: source.buildId,
            }),
        ],
        [
          "not a settled phase",
          (f) =>
            f.records.set(path.join(root, "last-update.json"), {
              ...f.retained({ operation, helper: { ...helper } }),
              phase: "verified",
              observedAt: "x",
              runningBuildId: target.buildId,
            }),
        ],
        [
          "manifest unparsed",
          (f) =>
            f.records.set(path.join(root, "last-update.json"), {
              ...f.retained({
                operation,
                helper: { ...helper },
                manifest: null,
              }),
              phase: "completed",
              observedAt: "x",
              runningBuildId: target.buildId,
            }),
        ],
        ["repair present", (f) => f.records.set(app + ".repair.json", {})],
        [
          "restore pending present",
          (f) =>
            f.records.set(path.join(root, "restore-pending.json"), {
              schema: "farol.update-restore-intent/1",
              action: "recover",
              operation,
              priorPhase: "prepared",
              helper: { ...helper },
            }),
        ],
        [
          "download pending present",
          (f) => f.records.set(path.join(root, "download-pending.json"), {}),
        ],
        [
          "cleanup pending present",
          (f) =>
            f.records.set(path.join(root, "package-cleanup-pending.json"), {}),
        ],
        [
          "cleanup pending holding JSON null",
          (f) =>
            f.records.set(
              path.join(root, "package-cleanup-pending.json"),
              null,
            ),
        ],
        [
          "helper live",
          (f) =>
            f.observation.readProcess.mockResolvedValue({
              stdout: ps,
              stderr: "",
            }),
        ],
        [
          "binding missing",
          (f) => f.records.delete(path.join(opRoot, "slot-binding.json")),
        ],
        ["version not newer", (f) => f.p.compareVersions.mockReturnValue(0)],
      ];
      for (const [, mutate] of cases) {
        const f = fixture(newerBuild);
        settle(f);
        mutate(f);
        await rejectsWith(f.observe(), "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
        expect(f.p.adoptionManifest).not.toHaveBeenCalled();
      }
    });

    it("refuses a build whose number does not exceed the settled release", async () => {
      const f = fixture(newerBuild);
      settle(f);
      f.records.set(path.join(root, "last-update.json"), {
        ...f.retained({
          operation,
          helper: { ...helper },
          manifest: { ...targetManifest, buildVersion: "3" },
        }),
        phase: "completed",
        observedAt: "x",
        runningBuildId: target.buildId,
      });
      await rejectsWith(f.observe(), "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    });
  });
});

describe("observeCompletedPrivateLaunch", () => {
  const image = path.join(root, operationId, "launch-Farol.app");
  const imageDirectory = path.join(image, "Contents/Resources/app");
  const settledRecords = (f: ReturnType<typeof fixture>) => {
    f.records.set(
      path.join(root, operationId, "slot-binding.json"),
      bindingValue(operation, "shared"),
    );
    f.records.set(path.join(root, "last-update.json"), {
      ...f.retained({ operation, helper: { ...helper } }),
      phase: "completed",
      observedAt: "2026-10-06T13:00:00.000Z",
      runningBuildId: target.buildId,
    });
    f.journal("completed");
    f.builds.set(app, target);
  };
  const settled = () => {
    const f = fixture();
    settledRecords(f);
    return f;
  };
  const run = (f: ReturnType<typeof fixture>) =>
    f.launch({ directory: imageDirectory });

  it("is not its concern outside the private launch layout", async () => {
    const f = settled();
    for (const directory of [
      appDirectory,
      path.join(
        root,
        "z".repeat(32),
        "launch-Farol.app/Contents/Resources/app",
      ),
      path.join(root, operationId, "other.app/Contents/Resources/app"),
    ])
      expect(await f.launch({ directory })).toBeNull();
    expect(f.observation.readRecord).not.toHaveBeenCalled();
  });

  it("accepts a settled generation and re-observes it on every recheck", async () => {
    const f = settled();
    const guard = await run(f);
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceApp: image,
        expectedDigest: target.digest,
      }),
    );
    expect(guard?.resourcesOrigin).toMatchObject({
      kind: "private-launch",
      operationId,
    });
    expect(
      f.observation.canonicalOwnedDirectory.mock.calls.slice(0, 5),
    ).toEqual([
      [profile, true],
      [root, true],
      [opRoot, true],
      [image, true],
      [app, false],
    ]);
    const measured = f.observation.readBuild.mock.calls.length;
    await guard?.recheck();
    expect(f.observation.readBuild.mock.calls.length).toBe(measured + 1);
    expect(f.recheck).toHaveBeenCalledTimes(1);
  });

  it("refuses an identity that does not belong to this image", async () => {
    const bad: Override[] = [
      { userData: "/elsewhere", directory: imageDirectory },
      { copyApp: undefined, directory: imageDirectory },
      { physicalFiles: undefined, directory: imageDirectory },
      {
        directory: imageDirectory,
        build: { ...targetBuild, sourceDirty: true },
      },
      {
        directory: imageDirectory,
        build: { ...targetBuild, buildId: "f".repeat(64) },
      },
      // The running build is the source of the operation, not its target.
      { directory: imageDirectory, build: sourceBuild },
    ];
    for (const override of bad) {
      const f = settled();
      await rejectsWith(
        f.launch(override),
        "UPDATE_RELAUNCH_IDENTITY_MISMATCH",
      );
      expect(captureMock).not.toHaveBeenCalled();
    }
  });

  it("refuses a binding for another operation or another location", async () => {
    const other = settled();
    other.records.set(path.join(root, operationId, "slot-binding.json"), {
      ...bindingValue(operation, "shared"),
      operationId: "c".repeat(32),
    });
    await rejectsWith(run(other), "UPDATE_RELAUNCH_IDENTITY_MISMATCH");
    const legacy = settled();
    legacy.records.set(
      path.join(root, operationId, "slot-binding.json"),
      bindingValue(operation, "legacy"),
    );
    expect(await message(run(legacy))).toContain("invalid");
    const missing = settled();
    missing.records.delete(path.join(root, operationId, "slot-binding.json"));
    expect(await message(run(missing))).toContain("invalid");
  });

  it("refuses a settled receipt that does not match the operation", async () => {
    const cases: [string, (f: ReturnType<typeof fixture>) => void][] = [
      [
        "manifest unparsed",
        (f) =>
          f.records.set(path.join(root, "last-update.json"), {
            ...f.retained({ operation, helper: { ...helper }, manifest: null }),
            phase: "completed",
            observedAt: "x",
            runningBuildId: target.buildId,
          }),
      ],
      [
        "no operation",
        (f) =>
          f.records.set(path.join(root, "last-update.json"), {
            ...f.retained({ operation: null }),
            phase: "completed",
            observedAt: "x",
            runningBuildId: target.buildId,
          }),
      ],
      [
        "another operation",
        (f) => {
          const other = { ...operation, operationId: "c".repeat(32) };
          f.bind(other);
          f.records.set(path.join(root, "last-update.json"), {
            ...f.retained({ operation: other, helper: { ...helper } }),
            phase: "completed",
            observedAt: "x",
            runningBuildId: target.buildId,
          });
        },
      ],
      ["installed build is the source", (f) => f.builds.set(app, source)],
      [
        "helper live",
        (f) =>
          f.observation.readProcess.mockResolvedValue({
            stdout: ps,
            stderr: "",
          }),
      ],
      [
        "helper unknown",
        (f) => f.observation.readProcess.mockRejectedValue(new Error("EPERM")),
      ],
    ];
    for (const [, mutate] of cases) {
      const f = settled();
      mutate(f);
      await rejectsWith(run(f), "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
      expect(captureMock).not.toHaveBeenCalled();
    }
  });

  it("lets the decision, not the journal phase, authorize the start", async () => {
    const f = settled();
    f.journal("verified");
    expect(await run(f)).not.toBeNull();
  });

  it("refuses a restore intent of another operation", async () => {
    const f = settled();
    f.records.set(path.join(root, "restore-pending.json"), {
      schema: "farol.update-restore-intent/1",
      action: "recover",
      operation: { ...operation, operationId: "c".repeat(32) },
      priorPhase: "prepared",
      helper: { ...helper },
    });
    await rejectsWith(run(f), "UPDATE_OPERATION_IDENTITY_MISMATCH");
  });

  it("refuses a restore intent that is present but holds JSON null", async () => {
    const f = settled();
    f.records.set(path.join(root, "restore-pending.json"), null);
    await rejectsWith(run(f), "UPDATE_RECORD_INVALID");
  });

  it("reads a truly absent restore intent as no restore pending", async () => {
    const f = settled();
    expect(f.records.has(path.join(root, "restore-pending.json"))).toBe(false);
    expect(await run(f)).not.toBeNull();
  });

  it("refuses when installer custody is unconfirmed, before the slot is read", async () => {
    const f = settled();
    f.records.set(custodyFile, { schema: "farol.bootstrap-install/2" });
    await rejectsWith(run(f), "UPDATE_INSTALLER_CUSTODY_UNCONFIRMED");
    expect(f.observation.readBuild).not.toHaveBeenCalled();
  });

  it("fails a recheck once the slot no longer holds the settled build", async () => {
    const f = settled();
    const guard = await run(f);
    f.builds.set(app, { ...target, digest: "9".repeat(64) });
    await rejectsWith(guard!.recheck(), "UPDATE_ACCEPTED_SOURCE_UNCONFIRMED");
    await rejectsWith(
      guard!.resourcesOrigin!.recheckUpdateSource(),
      "UPDATE_ACCEPTED_SOURCE_CHANGED",
    );
  });

  it("rechecks the origin's own binding before its image", async () => {
    const f = settled();
    const guard = await run(f);
    f.records.delete(path.join(root, operationId, "slot-binding.json"));
    await rejectsWith(
      guard!.resourcesOrigin!.recheck(),
      "UPDATE_SLOT_BINDING_UNCONFIRMED",
    );
    expect(f.recheck).not.toHaveBeenCalled();
  });
});
