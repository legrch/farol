// Hermetic inert fixtures only: no Electron, Go executable, native subprocess,
// installed profile or native acceptance. Mach-O headers below are test data.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import {
  BUILD_ENTRIES,
  snapshotBuildEntries,
} from "../../tooling/build-contract.mjs";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import {
  treeDigest,
  TREE_DIGEST_VERSION,
} from "../../tooling/artifact-digest.mjs";
import {
  parseArguments,
  executePacket,
  checkPair,
  parseFrame,
  parseACK,
  classifyTerminal,
  assertDrainedQuit,
  startLiveHelper,
  completeHandoff,
  slotBinding,
  copyApp,
  readBounded,
  recheckHome,
  LIMITS,
  NOT_RUN,
} from "../e2e/lib/owner-beta-update-pair.mjs";

const forbidden = vi.hoisted(() => ({
  spawn: 0,
  electron: 0,
  allocation: 0,
  writes: 0,
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original()),
  spawn() {
    forbidden.spawn++;
    throw Error("unexpected native spawn in hermetic test");
  },
}));
vi.mock("playwright-core", () => ({
  _electron: {
    launch() {
      forbidden.electron++;
      throw Error("unexpected Electron launch in hermetic test");
    },
  },
}));

// Guard the real allocation/write owners, in addition to the injected native
// boundary. The canonical execFileSync Git provenance owner remains available.
async function preflightWithoutEffects(selection, dependencies) {
  const spies = [];
  for (const name of ["mkdtemp", "mkdir", "writeFile", "chmod", "rename"]) {
    spies.push(
      vi.spyOn(fs, name).mockImplementation(() => {
        if (name === "mkdtemp") forbidden.allocation++;
        else forbidden.writes++;
        throw Error("unexpected preflight filesystem effect");
      }),
    );
  }
  try {
    return await executePacket(selection, dependencies);
  } finally {
    for (const spy of spies) spy.mockRestore();
    expect(forbidden).toEqual({
      spawn: 0,
      electron: 0,
      allocation: 0,
      writes: 0,
    });
  }
}

const roots = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const frame = (value) => Buffer.from(JSON.stringify(value) + "\n");
async function temporary() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-pair-unit-")),
  );
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const key of Object.keys(forbidden)) forbidden[key] = 0;
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture(ordinal) {
  const root = await temporary();
  const appPath = path.join(root, "_output/package/Farol.app");
  const resources = path.join(appPath, "Contents/Resources/app");
  await fs.mkdir(resources, { recursive: true });
  await fs.mkdir(path.join(root, "src/apps/desktop"), { recursive: true });
  await fs.mkdir(path.join(root, "boot"));
  const build = createBuildIdentity({
    version: `0.2.7-owner.beta.${ordinal}`,
    buildVersion: `${ordinal}`,
    updateChannel: "github-owner-beta",
    builtAt: "2026-10-23T00:00:00.000Z",
    sourceCommit: `${ordinal}`.repeat(40),
    sourceTreeDigest: `${ordinal}`.repeat(64),
    sourceDirty: false,
  });
  const binary = Buffer.alloc(512);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(0x0100000c, 4);
  binary.writeUInt32LE(2, 12);
  binary.write("run-live-release-helper publish-installed-slot-binding", 32);
  binary.write(build.buildId, 128);
  binary.write(
    "farol.installed-update-handoff/1 farol.installed-update/1",
    256,
  );
  const core = {
    schema: "farol-core-artifact/1",
    build: {
      buildId: build.buildId,
      sourceSHA: build.sourceCommit,
      sourceTreeDigest: build.sourceTreeDigest,
      platform: { goos: "darwin", goarch: "arm64" },
    },
    binary: {
      path: "farol-backend",
      size: binary.length,
      sha256: digest(binary),
    },
  };
  const entries = [
    ...BUILD_ENTRIES,
    "core-artifact.json",
    "farol-backend",
  ].sort();
  for (const entry of entries)
    await fs.writeFile(path.join(resources, entry), "inert fixture\n");
  await fs.writeFile(
    path.join(resources, "build-identity.json"),
    JSON.stringify(build),
  );
  await fs.writeFile(
    path.join(resources, "core-artifact.json"),
    JSON.stringify(core),
  );
  await fs.writeFile(path.join(resources, "farol-backend"), binary);
  await fs.chmod(path.join(resources, "farol-backend"), 0o500);
  await fs.writeFile(path.join(resources, "input-manifest.json"), "[]");
  await fs.writeFile(
    path.join(resources, "main.cjs"),
    "function assertNativeE2EAppData() {} // inert, never executed\n",
  );
  await fs.writeFile(
    path.join(root, "src/apps/desktop/desktop-environment.ts"),
    "function assertNativeE2EAppData() {} // inert source capability fixture\n",
  );
  await fs.writeFile(
    path.join(root, "boot/releasehelperlive.go"),
    'r.Predecessor == nil; r.InstallLocation != nil; r.Action == "rollback"; protocolapp.WaitingForExit',
  );
  const manifest = {
    schema: 4,
    inputExact: true,
    sourceMode: "head-exact",
    dirty: false,
    sourceCommit: build.sourceCommit,
    sourceTreeDigest: build.sourceTreeDigest,
    buildId: build.buildId,
    core,
    entries,
    entrySha256: await snapshotBuildEntries(resources, entries),
    inputLedgerSha256: digest("[]"),
    sourceInputCount: 0,
    dependencyInputCount: 0,
  };
  await fs.writeFile(
    path.join(resources, "build-manifest.json"),
    JSON.stringify(manifest),
  );
  const artifact = {
    schema: 7,
    treeDigestVersion: TREE_DIGEST_VERSION,
    artifactPath: appPath,
    artifactSha256: await treeDigest(appPath),
    buildId: build.buildId,
    sourceCommit: build.sourceCommit,
    sourceTreeDigest: build.sourceTreeDigest,
    sourceDirty: false,
    product: build.product,
    bundleId: build.bundleId,
    version: build.version,
    updateChannel: build.updateChannel,
  };
  const artifactFile = path.join(root, "_output/package/artifact.json");
  await fs.writeFile(artifactFile, JSON.stringify(artifact));
  return {
    root,
    resources,
    appPath,
    artifactFile,
    artifact,
    build,
    manifest,
    expected: {
      root,
      sourceSHA: build.sourceCommit,
      buildId: build.buildId,
      artifactSha256: artifact.artifactSha256,
    },
  };
}
async function pairFixture() {
  const source = await fixture(1),
    target = await fixture(2);
  const selection = {
    mode: "--check",
    source: source.expected,
    target: target.expected,
  };
  const counts = { gitOwner: 0, allocation: 0, helper: 0, electron: 0 };
  const provenance = (root) => {
    counts.gitOwner++;
    const chosen = root === source.root ? source : target;
    return {
      dirty: false,
      commit: chosen.build.sourceCommit,
      treeDigest: chosen.build.sourceTreeDigest,
    };
  };
  const native = () => {
    counts.allocation++;
    counts.helper++;
    counts.electron++;
    throw Error("native effects forbidden in unit test");
  };
  return { source, target, selection, counts, provenance, native };
}

it("requires both explicit pins and rejects arbitrary home/slot/report or unknown options", () => {
  const args = [
    "--check",
    "--source-root",
    "/fixture/source",
    "--source-sha",
    "1".repeat(40),
    "--source-build-id",
    "a".repeat(64),
    "--source-artifact-sha",
    "b".repeat(64),
    "--target-root",
    "/fixture/target",
    "--target-sha",
    "2".repeat(40),
    "--target-build-id",
    "c".repeat(64),
    "--target-artifact-sha",
    "d".repeat(64),
  ];
  expect(parseArguments(args).mode).toBe("--check");
  for (const extra of [
    "--home",
    "--slot",
    "--report",
    "--retry",
    "--allow-primary-display",
  ])
    expect(() => parseArguments([...args, extra, "/arbitrary"])).toThrow(
      "OWNER_BETA_ARGUMENTS",
    );
  expect(() => parseArguments(args.slice(0, -2))).toThrow();
  expect(() => parseArguments([...args, "--source-root", "/other"])).toThrow();
});

describe("preflight has no native/allocation capability", () => {
  it("checks two sealed inert trees without calling any effect", async () => {
    const f = await pairFixture();
    const result = await preflightWithoutEffects(f.selection, f);
    expect(result.status).toBe("checked");
    expect(result.native).toBe("NOT RUN");
    expect(f.counts).toEqual({
      gitOwner: 4,
      allocation: 0,
      helper: 0,
      electron: 0,
    });
  });
  it.each([
    "schema",
    "canonical-path",
    "pin",
    "dirty",
    "binary",
    "tree",
    "seam",
    "protocol",
  ])("refuses %s before all effects", async (kind) => {
    const f = await pairFixture();
    f.selection.mode = "--run-native";
    if (kind === "schema") f.target.artifact.schema = 6;
    if (kind === "canonical-path")
      f.target.artifact.artifactPath = f.source.appPath;
    if (kind === "pin") f.target.expected.buildId = "f".repeat(64);
    if (kind === "dirty")
      f.provenance = () => {
        f.counts.gitOwner++;
        return { dirty: true };
      };
    if (kind === "binary") {
      const executable = path.join(f.target.resources, "farol-backend");
      const bytes = await fs.readFile(executable);
      bytes.writeUInt32LE(0, 0); // A sealed digest cannot make this Mach-O.
      await fs.chmod(executable, 0o700);
      await fs.writeFile(executable, bytes);
      await fs.chmod(executable, 0o500);
      f.target.manifest.core.binary.sha256 = digest(bytes);
      await fs.writeFile(
        path.join(f.target.resources, "core-artifact.json"),
        JSON.stringify(f.target.manifest.core),
      );
      f.target.manifest.entrySha256 = await snapshotBuildEntries(
        f.target.resources,
        f.target.manifest.entries,
      );
      await fs.writeFile(
        path.join(f.target.resources, "build-manifest.json"),
        JSON.stringify(f.target.manifest),
      );
      f.target.artifact.artifactSha256 = await treeDigest(f.target.appPath);
      f.target.expected.artifactSha256 = f.target.artifact.artifactSha256;
    }
    if (kind === "tree")
      await fs.writeFile(
        path.join(f.target.appPath, "unexpected"),
        "extra bytes",
      );
    if (kind === "seam")
      await fs.writeFile(
        path.join(f.target.root, "src/apps/desktop/desktop-environment.ts"),
        "old unsupported seam",
      );
    if (kind === "protocol")
      await fs.writeFile(
        path.join(f.target.root, "boot/releasehelperlive.go"),
        "old unsupported protocol",
      );
    await fs.writeFile(
      f.target.artifactFile,
      JSON.stringify(f.target.artifact),
    );
    await expect(preflightWithoutEffects(f.selection, f)).rejects.toThrow();
    expect(f.counts.allocation).toBe(0);
    expect(f.counts.helper).toBe(0);
    expect(f.counts.electron).toBe(0);
  });
  it("allows the actual canonical fixed Git provenance owner on a malformed candidate without native effects", async () => {
    const f = await pairFixture();
    let gitCalls = 0;
    // Only this worktree is inspected; the fixture claims are deliberately
    // incompatible with its real source identity. No Git mutation is issued.
    f.provenance = () => {
      gitCalls++;
      return sourceIdentity(path.resolve(import.meta.dirname, "../.."));
    };
    await expect(preflightWithoutEffects(f.selection, f)).rejects.toThrow(
      "CANDIDATE_SOURCE_NOT_EXACT",
    );
    expect(gitCalls).toBe(1);
    expect(f.counts).toEqual({
      gitOwner: 0,
      allocation: 0,
      helper: 0,
      electron: 0,
    });
  });
  it("rejects a physical candidate alias before reading it", async () => {
    const f = await pairFixture();
    const alias = path.join(await temporary(), "alias");
    await fs.symlink(f.source.root, alias);
    f.selection.source.root = alias;
    await expect(checkPair(f.selection, f.provenance)).rejects.toThrow(
      "DIRECTORY_UNSAFE",
    );
    expect(f.counts.gitOwner).toBe(0);
  });
});

function request(action = "apply") {
  return {
    schema: "farol.installed-update/1",
    action,
    home: "/private/var/folders/aa/bb/T/farol-e2e-home-ABC123/home",
    installLocation: "legacy",
    operationId: "a".repeat(32),
    source: {
      buildId: "1".repeat(64),
      digest: "2".repeat(64),
      version: "0.2.7-owner.beta.1",
    },
    target: {
      buildId: "3".repeat(64),
      digest: "4".repeat(64),
      version: "0.2.7-owner.beta.2",
    },
    drain: {
      status: "reconciled",
      acceptedSource: "1".repeat(64),
      acceptedTarget: "3".repeat(64),
    },
    pid: 4321,
    processStart: "Fri Oct 23 01:00:00 2026",
    waitSeconds: 120,
    relaunch: false,
  };
}
function ack(r, phase = "waiting_for_exit") {
  return {
    schema: "farol.installed-update-handoff/1",
    phase,
    operationId: r.operationId,
    action: r.action,
    source: r.source,
    target: r.target,
    pid: r.pid,
    processStart: r.processStart,
    ...(phase === "refused" ? { error: "slot_binding_invalid" } : {}),
  };
}
function inertSpawn(onRequest, calls) {
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.pid = 12345;
    child.stdout = new PassThrough();
    child.stdio = [
      null,
      child.stdout,
      null,
      new PassThrough(),
      new PassThrough(),
    ];
    let data = Buffer.alloc(0);
    child.stdio[3].on("data", (bytes) => {
      data = Buffer.concat([data, bytes]);
    });
    child.stdio[3].once("finish", () =>
      onRequest(child, JSON.parse(data.toString("utf8"))),
    );
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
}
function terminate(child, bytes, exit = { code: 0, signal: null }) {
  child.stdout.end(bytes);
  setImmediate(() => child.emit("close", exit.code, exit.signal));
}

it.each(["apply", "rollback"])(
  "uses strict fd3 request/fd4 ACK and one exact terminal for %s",
  async (action) => {
    const r = request(action),
      calls = [],
      receipt = {};
    const helper = startLiveHelper(
      "/inert/farol-backend",
      r,
      receipt,
      inertSpawn((child, actual) => {
        expect(actual).toEqual(r);
        child.stdio[4].end(frame(ack(r)));
        terminate(
          child,
          frame({
            operationId: r.operationId,
            phase: action === "apply" ? "verified" : "rolled_back",
          }),
        );
      }, calls),
    );
    let quits = 0;
    await completeHandoff(helper, async () => {
      quits++;
    });
    expect(quits).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["run-live-release-helper"]);
    expect(calls[0].options.stdio).toEqual([
      "ignore",
      "pipe",
      "ignore",
      "pipe",
      "pipe",
    ]);
    expect(calls[0].options.env).toEqual({
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    });
    expect(receipt.result.status).toBe("passed");
  },
);

it.each([
  "duplicate",
  "multiple",
  "no-lf",
  "oversized",
  "utf8",
  "wrong-pid",
  "extra-key",
  "closed-predecessor",
])("never authorizes Quit for %s ACK", async (kind) => {
  const r = request(),
    calls = [];
  let bytes = frame(ack(r));
  if (kind === "duplicate")
    bytes = Buffer.from(
      bytes.toString().replace('"pid":4321', '"pid":4321,"p\\u0069d":4321'),
    );
  if (kind === "multiple") bytes = Buffer.concat([bytes, bytes]);
  if (kind === "no-lf") bytes = bytes.subarray(0, -1);
  if (kind === "oversized") bytes = Buffer.alloc(LIMITS.frame + 1, 32);
  if (kind === "utf8") bytes = Buffer.from([0xff, 10]);
  if (kind === "wrong-pid") bytes = frame({ ...ack(r), pid: r.pid + 1 });
  if (kind === "extra-key") bytes = frame({ ...ack(r), override: true });
  if (kind === "closed-predecessor")
    bytes = frame({ ...ack(r), phase: "closed_predecessor_ready" });
  const helper = startLiveHelper(
    "/inert/farol-backend",
    r,
    {},
    inertSpawn((child) => {
      child.stdio[4].end(bytes);
      terminate(
        child,
        frame({ operationId: r.operationId, phase: "verified" }),
      );
    }, calls),
  );
  let quits = 0;
  await expect(
    completeHandoff(helper, async () => {
      quits++;
    }),
  ).rejects.toThrow();
  await helper.completed;
  expect(quits).toBe(0);
  expect(calls).toHaveLength(1);
});

it("retains a correlated refusal and never quits", async () => {
  const r = request(),
    receipt = {},
    calls = [];
  const helper = startLiveHelper(
    "/inert/farol-backend",
    r,
    receipt,
    inertSpawn((child) => {
      child.stdio[4].end(frame(ack(r, "refused")));
      terminate(
        child,
        frame({
          operationId: r.operationId,
          phase: "refused",
          error: "slot_binding_invalid",
        }),
        { code: 70, signal: null },
      );
    }, calls),
  );
  let quits = 0;
  await expect(
    completeHandoff(helper, async () => {
      quits++;
    }),
  ).rejects.toThrow("HELPER_REFUSED");
  expect(receipt.result.status).toBe("refused");
  expect(quits).toBe(0);
  expect(calls).toHaveLength(1);
});

it("a timeout and a late valid ACK cannot reopen the Quit barrier or spawn again", async () => {
  vi.useFakeTimers();
  const r = request(),
    calls = [],
    receipt = {};
  let retained;
  const helper = startLiveHelper(
    "/inert/farol-backend",
    r,
    receipt,
    inertSpawn((child) => {
      retained = child;
    }, calls),
  );
  let quits = 0;
  const result = completeHandoff(helper, async () => {
    quits++;
  });
  const rejected = expect(result).rejects.toThrow("ACK_TIMEOUT");
  await vi.advanceTimersByTimeAsync(LIMITS.ackMs + 1);
  await rejected;
  retained.stdio[4].end(frame(ack(r)));
  retained.stdout.end(frame({ operationId: r.operationId, phase: "verified" }));
  retained.emit("close", 0, null);
  expect((await helper.completed).status).toBe("outcome_unknown");
  expect(quits).toBe(0);
  expect(calls).toHaveLength(1);
});

it.each([
  [
    { operationId: "a".repeat(32), phase: "unknown", error: "internal" },
    { code: 79, signal: null },
  ],
  [
    { operationId: "a".repeat(32), phase: "verified" },
    { code: 1, signal: null },
  ],
  [
    { operationId: "a".repeat(32), phase: "verified" },
    { code: null, signal: "SIGTERM" },
  ],
  [
    { operationId: "a".repeat(32), phase: "completed" },
    { code: 0, signal: null },
  ],
  [
    { operationId: "b".repeat(32), phase: "verified" },
    { code: 0, signal: null },
  ],
])(
  "does not upgrade uncertain or conflicting terminal evidence %#",
  (terminal, exit) => {
    const r = request();
    expect(classifyTerminal(frame(terminal), r, exit, ack(r)).status).toBe(
      "outcome_unknown",
    );
  },
);
it("rejects malformed, oversized and duplicate terminal frames despite exit0", () => {
  const r = request();
  for (const bytes of [
    Buffer.from("not json\n"),
    Buffer.alloc(4097),
    Buffer.concat([
      frame({ operationId: r.operationId, phase: "verified" }),
      frame({}),
    ]),
    Buffer.from(
      `{"phase":"verified","phase":"verified","operationId":"${r.operationId}"}\n`,
    ),
  ])
    expect(
      classifyTerminal(bytes, r, { code: 0, signal: null }, ack(r)).status,
    ).toBe("outcome_unknown");
});
it("validates all correlation fields and no alternate ACK phase", () => {
  const r = request();
  expect(parseACK(frame(ack(r)), r).phase).toBe("waiting_for_exit");
  for (const change of [
    { processStart: "other" },
    { operationId: "b".repeat(32) },
    { action: "rollback" },
    { source: r.target },
    { target: { ...r.target, version: "0.2.7-owner.beta.3" } },
  ])
    expect(() => parseACK(frame({ ...ack(r), ...change }), r)).toThrow(
      "ACK_CORRELATION",
    );
  expect(() => parseFrame(Buffer.from("{}\n{}\n"))).toThrow();
});
it("refuses recovery, relaunch and forged closed proof before even injected spawn", () => {
  const calls = [];
  for (const change of [
    { action: "recover" },
    { relaunch: true },
    { predecessor: { kind: "confirmed_closed" } },
    { installLocation: "shared" },
    { drain: { status: "reconciled" } },
  ])
    expect(() =>
      startLiveHelper(
        "/inert/farol-backend",
        { ...request(), ...change },
        {},
        inertSpawn(() => {}, calls),
      ),
    ).toThrow();
  expect(calls).toHaveLength(0);
});
it("a clean exit requires a fresh parsed drained receipt with no unconfirmed children", () => {
  const at = "2026-10-23T01:00:00.000Z",
    requested = Date.parse(at),
    exit = { code: 0, signal: null };
  const receipt = { schema: 1, at, drained: true, unconfirmed: [] };
  expect(assertDrainedQuit(JSON.stringify(receipt), requested, exit)).toEqual(
    receipt,
  );
  for (const changed of [
    { ...receipt, drained: false },
    { ...receipt, unconfirmed: ["runtime"] },
    { ...receipt, at: "2026-10-22T01:00:00.000Z" },
    { schema: 2 },
  ])
    expect(() =>
      assertDrainedQuit(JSON.stringify(changed), requested, exit),
    ).toThrow("QUIT_UNCONFIRMED");
  expect(() =>
    assertDrainedQuit(JSON.stringify(receipt), requested, {
      code: 1,
      signal: null,
    }),
  ).toThrow();
  expect(() => assertDrainedQuit("corrupt", requested, exit)).toThrow();
});
it("serializes only the actual legacy slot pair in the frozen canonical order", () => {
  const r = request();
  expect(slotBinding(r).toString()).toBe(
    `{"installLocation":"legacy","operationId":"${r.operationId}","schema":"farol.installed-operation-slot/1","source":{"buildId":"${r.source.buildId}","digest":"${r.source.digest}","version":"${r.source.version}"},"target":{"buildId":"${r.target.buildId}","digest":"${r.target.digest}","version":"${r.target.version}"}}\n`,
  );
  expect(NOT_RUN.recovery).toContain("relaunch:true");
});
it("copies real fixture bytes and modes with internal symlinks without changing the source", async () => {
  const root = await temporary(),
    source = path.join(root, "source"),
    target = path.join(root, "target");
  await fs.mkdir(source, { mode: 0o755 });
  await fs.mkdir(path.join(source, "nested"), { mode: 0o750 });
  await fs.writeFile(path.join(source, "nested/file"), "different bytes", {
    mode: 0o500,
  });
  await fs.symlink("nested/file", path.join(source, "alias"));
  const before = await treeDigest(source);
  await copyApp(source, target, before);
  expect(await treeDigest(target)).toBe(before);
  expect(await fs.readlink(path.join(target, "alias"))).toBe("nested/file");
  expect((await fs.stat(path.join(target, "nested/file"))).mode & 0o777).toBe(
    0o500,
  );
  expect(await treeDigest(source)).toBe(before);
});
it("refuses a changed tree and escaping alias before creating the copy", async () => {
  const root = await temporary(),
    source = path.join(root, "source"),
    target = path.join(root, "target");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "file"), "one");
  const before = await treeDigest(source);
  await fs.writeFile(path.join(source, "file"), "two");
  await expect(copyApp(source, target, before)).rejects.toThrow(
    "COPY_SOURCE_CHANGED",
  );
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  await fs.symlink("../outside", path.join(source, "alias"));
  await expect(copyApp(source, target, before)).rejects.toThrow(
    "ARTIFACT_SYMLINK_ESCAPES_ROOT",
  );
});
it("bounded reads refuse aliases and oversize without following their contents", async () => {
  const root = await temporary(),
    file = path.join(root, "file"),
    alias = path.join(root, "alias");
  await fs.writeFile(file, "12345");
  await fs.symlink(file, alias);
  await expect(readBounded(alias, 10)).rejects.toThrow();
  await expect(readBounded(file, 4)).rejects.toThrow("FILE_UNSAFE");
  expect((await readBounded(file, 5)).toString()).toBe("12345");
});
it("refuses arbitrary home/slot selections before inspecting a path", async () => {
  await expect(
    recheckHome({ root: "/fixture", home: "/arbitrary", appData: "/outside" }),
  ).rejects.toThrow("HOME_SELECTION");
});

it.each(["nonzero-terminal", "drain-failure"])(
  "stops after one authorized Quit on %s without retry",
  async (kind) => {
    const r = request(),
      calls = [];
    const helper = startLiveHelper(
      "/inert/farol-backend",
      r,
      {},
      inertSpawn((child) => {
        child.stdio[4].end(frame(ack(r)));
        terminate(
          child,
          frame({ operationId: r.operationId, phase: "verified" }),
          { code: kind === "nonzero-terminal" ? 79 : 0, signal: null },
        );
      }, calls),
    );
    let quits = 0;
    await expect(
      completeHandoff(helper, async () => {
        quits++;
        if (kind === "drain-failure")
          assertDrainedQuit(
            JSON.stringify({
              schema: 1,
              at: new Date().toISOString(),
              drained: false,
              unconfirmed: ["runtime"],
            }),
            0,
            { code: 0, signal: null },
          );
      }),
    ).rejects.toThrow(
      kind === "drain-failure"
        ? "QUIT_UNCONFIRMED"
        : "HELPER_TERMINAL_UNCONFIRMED",
    );
    await helper.completed;
    expect(quits).toBe(1);
    expect(calls).toHaveLength(1);
  },
);

it("pins request correlation before asynchronous handoff", async () => {
  const r = request(),
    original = structuredClone(r),
    calls = [];
  const helper = startLiveHelper(
    "/inert/farol-backend",
    r,
    {},
    inertSpawn((child, actual) => {
      expect(actual).toEqual(original);
      child.stdio[4].end(frame(ack(original)));
      terminate(
        child,
        frame({ operationId: original.operationId, phase: "verified" }),
      );
    }, calls),
  );
  r.source.buildId = "f".repeat(64);
  r.processStart = "caller changed after dispatch";
  expect((await helper.ready).processStart).toBe(original.processStart);
  expect((await helper.completed).status).toBe("passed");
  expect(calls).toHaveLength(1);
});
