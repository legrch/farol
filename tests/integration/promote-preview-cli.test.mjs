import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PrivateChatGptTaskJournal } from "../../src/apps/desktop/chatgpt-task-journal.ts";
import { PrivateLiveTaskStore } from "../../src/apps/desktop/live-task-store.ts";
import { ProductSettingsStore } from "../../src/apps/desktop/product-configuration.ts";
import { serializeQuitReceipt } from "../../src/apps/desktop/quit-receipt.ts";
import { writeRunMarker } from "../../src/apps/desktop/run-marker.ts";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { promotionUserData } from "../../tooling/promotion-obligations.mjs";

// The promotion CLI end to end, as processes. Two entry points are spawned:
//
// - `tooling/promote-preview.mjs` itself, for what the real entry can prove
//   from a test: every `--user-data` refusal and option error happens
//   before the candidate, the source or the owner's profile is touched.
// - `promote-preview-cli.fixture-entry.mjs`, which runs the same exported
//   composition (`runPromotionCli`) in a child process against a throwaway
//   home, a throwaway candidate with a real tree digest, and a profile
//   seeded by the REAL stores. The real entry cannot be driven to a
//   placement from a test — it demands exact clean HEAD bytes and a sealed
//   Electron package — so these cases prove the composition around those
//   checks: the lease, the drain check, the run marker, placement, the
//   receipt and the exit status. They do not prove `verify-package.mjs` or
//   the source-identity read; those have their own tests.
const nextRoot = path.resolve(import.meta.dirname, "../..");
const realCli = path.join(nextRoot, "tooling", "promote-preview.mjs");
const fixtureEntry = fileURLToPath(
  new URL("./promote-preview-cli.fixture-entry.mjs", import.meta.url),
);
const leaseChild = fileURLToPath(
  new URL("./fixtures/promotion-lease-child.mjs", import.meta.url),
);
// Any whole-second epoch instant; every marker below is written with it.
const FIXTURE_BOOT = 1_758_000_000_000;
// The opaque `ps -o lstart=` token this fixture's markers record.
const FIXTURE_PROCESS_START = "Sat Sep 20 10:00:00 2026";
const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function run(script, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...arguments_], {
      cwd: nextRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

// The promotion-apply helper walks every path component with
// follow_symlinks=False, so the tmp root (macOS's `/tmp` -> `/private/tmp`)
// is resolved first, as promotion-flow.test.mjs does.
async function temporary(prefix) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), prefix),
  );
  roots.push(root);
  return root;
}

async function exitedChildPid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  await new Promise((resolve) => child.once("close", resolve));
  return child.pid;
}

// A throwaway home, a throwaway candidate under its own root (so
// `candidatePaths(candidateRoot)` and the manifest's `artifactPath` agree,
// as they must for the real candidate), and the fixture file the entry
// reads its seams from.
async function fixture() {
  const root = await temporary("farol-next-promote-cli-");
  const home = path.join(root, "home");
  await fs.mkdir(path.join(home, "Applications"), {
    recursive: true,
    mode: 0o755,
  });
  await fs.chmod(home, 0o700);
  const candidateRoot = path.join(root, "candidate");
  const packageRoot = path.join(candidateRoot, "dist", "package");
  const app = path.join(packageRoot, "Farol Next Preview.app");
  await fs.mkdir(path.join(app, "Contents"), { recursive: true });
  await fs.writeFile(
    path.join(app, "Contents", "payload"),
    "generation-under-test\n",
    { mode: 0o600 },
  );
  const artifact = {
    schema: 5,
    product: "Farol Next Preview",
    version: "0.1.0-preview.0",
    bundleId: "local.farol.next.preview",
    buildId: "b".repeat(64),
    builtAt: "2026-09-20T10:00:00.000Z",
    sourceCommit: "c".repeat(40),
    sourceTreeDigest: "d".repeat(64),
    sourceDirty: false,
    artifactPath: app,
    artifactSha256: await treeDigest(app),
  };
  const artifactFile = path.join(packageRoot, "artifact.json");
  await fs.writeFile(artifactFile, `${JSON.stringify(artifact, null, 2)}\n`, {
    mode: 0o600,
  });
  const fixtureFile = path.join(root, "fixture.json");
  await fs.writeFile(
    fixtureFile,
    JSON.stringify({
      home,
      candidateRoot,
      sourceIdentity: {
        commit: artifact.sourceCommit,
        treeDigest: artifact.sourceTreeDigest,
        dirty: false,
      },
      bootTime: FIXTURE_BOOT,
      // S35-H1-3: the CLI's process-start probe, pid -> `ps -o lstart=`
      // token. This process is the one the "running app" markers name, and
      // it still wears the token they record.
      processStart: { [String(process.pid)]: FIXTURE_PROCESS_START },
    }),
    { mode: 0o600 },
  );
  const destination = path.join(home, "Applications", "Farol Next Preview.app");
  return {
    root,
    home,
    userData: promotionUserData(home),
    artifact,
    artifactFile,
    app,
    destination,
    receipt: `${destination}.receipt.json`,
    fixtureFile,
    cli: (...arguments_) =>
      run(fixtureEntry, [...arguments_, "--fixture", fixtureFile]),
  };
}

function task(overrides = {}) {
  return {
    taskId: "task-a",
    sessionId: "task-a",
    turnId: "turn-a",
    label: "Task",
    provider: "chatgpt",
    requestedModel: null,
    observedModel: null,
    requestedMode: null,
    observedMode: null,
    hasComputer: false,
    pinned: false,
    lifecycle: "idle",
    conversationUrl: null,
    ...overrides,
  };
}

const readiness = () => ({
  visited: false,
  skipped: false,
  configured: false,
  reachable: "unknown",
  verified: null,
  needsAction: null,
  unavailable: null,
  outcomeUnknown: false,
});

const settings = {
  schema: 1,
  revision: 7,
  general: {
    openAtLaunch: "browser",
    sidebarDefault: "full",
    activityDetail: "summary",
  },
  computer: {
    computerId: "00000000-0000-4000-8000-000000000c01",
    generation: 3,
    name: "Test",
    commands: "none",
    workspaces: [],
    pendingEdit: null,
  },
  setup: {
    chatgpt: readiness(),
    computer: readiness(),
    connect: readiness(),
    hosts: readiness(),
    verify: readiness(),
  },
};

// A profile written by the real stores: settled tasks, a delivered ChatGPT
// turn, saved settings with no pending edit, and a drained quit receipt in
// exactly the bytes the desktop writes.
async function seedProfile(
  userData,
  { tasks = [task(), task({ taskId: "task-b", lifecycle: "completed" })] } = {},
) {
  const state = path.join(userData, "farol-next-state");
  await new PrivateLiveTaskStore({
    root: path.join(state, "live-tasks"),
  }).save({ revision: 1, tasks });
  const journal = new PrivateChatGptTaskJournal({
    root: path.join(state, "chatgpt-task-journal"),
  });
  const operationId = "00000000-0000-4000-8000-000000000abc";
  await journal.prepare({ operationId, kind: "readonly" });
  await journal.markDispatchIntent(operationId);
  await journal.retainResult(operationId, {
    state: "completed",
    code: null,
    deltaCount: 1,
    observedCharacters: 12,
  });
  await journal.acknowledgeDelivery(operationId);
  await new ProductSettingsStore({ root: state }).save(settings);
  await fs.writeFile(
    path.join(state, "last-quit.json"),
    serializeQuitReceipt(
      { drained: true, unconfirmed: [] },
      "2026-09-20T10:00:00.000Z",
    ),
    { mode: 0o600 },
  );
  return state;
}

async function absent(target) {
  return fs.lstat(target).then(
    () => false,
    (error) => error.code === "ENOENT",
  );
}

function waitForLine(child, needle) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes(needle)) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    setTimeout(
      () => reject(new Error(`timed out waiting for ${needle}`)),
      10_000,
    ).unref();
  });
}

describe("promote-preview CLI as a process: the composition around a seeded profile", () => {
  it("(a) plans, then places a drained profile's candidate with a receipt, and refuses to place over it again", async () => {
    const f = await fixture();
    await seedProfile(f.userData);

    const planned = await f.cli("--destination", f.destination);
    expect(planned.stderr).toBe("");
    expect(planned.code).toBe(0);
    const plan = JSON.parse(planned.stdout);
    expect(plan).toMatchObject({
      schema: "farol.next.promotion-plan/1",
      operation: "plan-only",
      destination: f.destination,
      receipt: f.receipt,
      artifactSha256: f.artifact.artifactSha256,
      activation: { userData: f.userData, drained: true, obligations: [] },
    });
    expect(await absent(f.destination)).toBe(true);

    const applied = await f.cli("--apply", "--destination", f.destination);
    expect(applied.stderr).toBe("");
    expect(applied.code).toBe(0);
    const receipt = JSON.parse(applied.stdout);
    expect(receipt).toMatchObject({
      operation: "applied",
      verifiedDestinationSha256: f.artifact.artifactSha256,
      activation: { userData: f.userData, drained: true },
    });
    expect(await treeDigest(f.destination)).toBe(f.artifact.artifactSha256);
    expect(JSON.parse(await fs.readFile(f.receipt, "utf8"))).toEqual(receipt);
    // The source generation is untouched by its own promotion.
    expect(await treeDigest(f.app)).toBe(f.artifact.artifactSha256);

    const again = await f.cli("--apply", "--destination", f.destination);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("PROMOTION_DESTINATION_EXISTS");
    expect(await treeDigest(f.destination)).toBe(f.artifact.artifactSha256);
  }, 30_000);

  it("(b) refuses while a task is running, naming the obligation, and leaves the destination untouched", async () => {
    const f = await fixture();
    await seedProfile(f.userData, {
      tasks: [task({ lifecycle: "running" })],
    });
    const result = await f.cli("--apply", "--destination", f.destination);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("PROMOTION_DRAIN_REQUIRED");
    expect(result.stderr).toContain("TASK_RUNNING:1");
    expect(await absent(f.destination)).toBe(true);
    expect(await absent(f.receipt)).toBe(true);
  }, 30_000);

  it("(c) refuses while a real separate process holds the lease, and leaves the destination untouched", async () => {
    const f = await fixture();
    await seedProfile(f.userData);
    const holder = spawn(
      process.execPath,
      [leaseChild, f.userData, "hold", "held-generation"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await waitForLine(holder, "ACQUIRED");
      const result = await f.cli("--apply", "--destination", f.destination);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("PROMOTION_LEASE_HELD");
      expect(await absent(f.destination)).toBe(true);
      expect(await absent(f.receipt)).toBe(true);
    } finally {
      holder.kill("SIGKILL");
      await new Promise((resolve) => holder.once("close", resolve));
    }
    // With the holder gone, the same profile promotes.
    const after = await f.cli("--apply", "--destination", f.destination);
    expect(after.stderr).toBe("");
    expect(after.code).toBe(0);
    expect(await treeDigest(f.destination)).toBe(f.artifact.artifactSha256);
  }, 30_000);

  it("(d) a run marker decides: a dead pid is an unconfirmed quit, a live pid on this boot is a running app, a live pid on another boot is a crash", async () => {
    const f = await fixture();
    const state = await seedProfile(f.userData);

    await writeRunMarker(state, {
      pid: await exitedChildPid(),
      now: Date.now(),
      bootTime: FIXTURE_BOOT,
      processStart: FIXTURE_PROCESS_START,
    });
    const crashed = await f.cli("--apply", "--destination", f.destination);
    expect(crashed.code).toBe(1);
    expect(crashed.stderr).toContain(
      "PROMOTION_DRAIN_REQUIRED:QUIT_UNCONFIRMED:crash",
    );
    expect(await absent(f.destination)).toBe(true);

    // This test process is alive and, by the fixture's boot probe, on the
    // marker's boot: exactly what a running app looks like.
    await writeRunMarker(state, {
      pid: process.pid,
      now: Date.now(),
      bootTime: FIXTURE_BOOT,
      processStart: FIXTURE_PROCESS_START,
    });
    const running = await f.cli("--apply", "--destination", f.destination);
    expect(running.code).toBe(1);
    expect(running.stderr).toContain(
      `PROMOTION_DRAIN_REQUIRED:APP_RUNNING:${process.pid}`,
    );
    expect(await absent(f.destination)).toBe(true);

    await writeRunMarker(state, {
      pid: process.pid,
      now: Date.now(),
      bootTime: FIXTURE_BOOT - 86_400_000,
      processStart: FIXTURE_PROCESS_START,
    });
    const rebooted = await f.cli("--apply", "--destination", f.destination);
    expect(rebooted.code).toBe(1);
    expect(rebooted.stderr).toContain(
      "PROMOTION_DRAIN_REQUIRED:QUIT_UNCONFIRMED:crash",
    );
    expect(await absent(f.destination)).toBe(true);

    // S35-H1-3: the same live pid, on the same boot, but the process
    // wearing the number now started at a different time — the marker's
    // writer is gone and its number was reused.
    await writeRunMarker(state, {
      pid: process.pid,
      now: Date.now(),
      bootTime: FIXTURE_BOOT,
      processStart: `${FIXTURE_PROCESS_START} (reused)`,
    });
    const reused = await f.cli("--apply", "--destination", f.destination);
    expect(reused.code).toBe(1);
    expect(reused.stderr).toContain(
      "PROMOTION_DRAIN_REQUIRED:QUIT_UNCONFIRMED:crash",
    );
    expect(reused.stderr).not.toContain("APP_RUNNING");
    expect(await absent(f.destination)).toBe(true);

    // A confirmed drain removes the marker; only then does it promote.
    await fs.rm(path.join(state, "running.json"));
    const drained = await f.cli("--apply", "--destination", f.destination);
    expect(drained.stderr).toBe("");
    expect(drained.code).toBe(0);
  }, 30_000);

  it("(e) --user-data points a plan at another profile, reports it in the plan, and is never combined with --apply", async () => {
    const f = await fixture();
    await seedProfile(f.userData);
    const other = path.join(f.root, "other-profile");
    await seedProfile(other, { tasks: [task({ lifecycle: "running" })] });

    const owing = await f.cli("--user-data", other);
    expect(owing.code).toBe(1);
    expect(owing.stderr).toContain("PROMOTION_DRAIN_REQUIRED:TASK_RUNNING:1");

    await seedProfile(other);
    const planned = await f.cli("--user-data", other);
    expect(planned.stderr).toBe("");
    expect(planned.code).toBe(0);
    expect(JSON.parse(planned.stdout)).toMatchObject({
      operation: "plan-only",
      activation: { userData: other, drained: true },
    });

    const applied = await f.cli("--apply", "--user-data", other);
    expect(applied.code).toBe(1);
    expect(applied.stderr).toContain("PROMOTION_USER_DATA_APPLY_REFUSED");
    expect(await absent(f.destination)).toBe(true);

    // The profile this home actually runs is refused as an explicit value.
    const own = await f.cli("--user-data", f.userData);
    expect(own.code).toBe(1);
    expect(own.stderr).toContain("PROMOTION_USER_DATA_IS_OWNER_PROFILE");
  }, 30_000);

  it("(D5) reads artifact.json only as a bounded, private, regular file, with a closed refusal per failure", async () => {
    const f = await fixture();
    await seedProfile(f.userData);
    const original = await fs.readFile(f.artifactFile, "utf8");
    const cases = [
      [
        "SYMLINK",
        async () => {
          const decoy = path.join(f.root, "decoy-artifact.json");
          await fs.writeFile(decoy, original, { mode: 0o600 });
          await fs.symlink(decoy, f.artifactFile);
        },
      ],
      [
        "OVERSIZED",
        () =>
          fs.writeFile(f.artifactFile, `${" ".repeat(64 * 1024)}${original}`, {
            mode: 0o600,
          }),
      ],
      [
        "CORRUPT",
        () => fs.writeFile(f.artifactFile, "{not json", { mode: 0o600 }),
      ],
      ["CORRUPT", () => fs.writeFile(f.artifactFile, "[]", { mode: 0o600 })],
      ["UNSAFE", () => fs.mkdir(f.artifactFile)],
      [
        "UNSAFE",
        async () => {
          // `writeFile`'s mode is masked by the umask; only chmod really
          // makes the manifest writable by others.
          await fs.writeFile(f.artifactFile, original, { mode: 0o600 });
          await fs.chmod(f.artifactFile, 0o666);
        },
      ],
      ["ABSENT", async () => {}],
    ];
    for (const [reason, arrange] of cases) {
      await fs.rm(f.artifactFile, { recursive: true, force: true });
      await arrange();
      const result = await f.cli("--apply", "--destination", f.destination);
      expect(result.code, reason).toBe(1);
      expect(result.stderr, reason).toContain(
        `PROMOTION_ARTIFACT_UNREADABLE:${reason}`,
      );
      expect(await absent(f.destination), reason).toBe(true);
    }
    await fs.rm(f.artifactFile, { recursive: true, force: true });
    await fs.writeFile(f.artifactFile, original, { mode: 0o600 });
    const restored = await f.cli("--destination", f.destination);
    expect(restored.stderr).toBe("");
    expect(restored.code).toBe(0);
  }, 30_000);
});

describe("promote-preview CLI as a process: the real entry point's own refusals", () => {
  // Every case below is refused before the candidate manifest, the source
  // identity or the owner's profile is read, so it holds on any checkout
  // and never touches the owner's installation. A run that got past these
  // checks is not attempted here: from a test it would either be refused
  // for the checkout's state or, on an exact clean checkout, act on the
  // owner's real Applications folder.
  const ownerProfile = promotionUserData(os.userInfo().homedir);

  it("refuses a relative, an owner-profile, or an --apply --user-data before touching anything", async () => {
    const scratch = await temporary("farol-next-promote-real-");
    const cases = [
      [["--user-data", "relative/profile"], "PROMOTION_USER_DATA_NOT_ABSOLUTE"],
      [["--user-data", ownerProfile], "PROMOTION_USER_DATA_IS_OWNER_PROFILE"],
      [
        ["--user-data", path.join(ownerProfile, "farol-next-state")],
        "PROMOTION_USER_DATA_IS_OWNER_PROFILE",
      ],
      [
        ["--apply", "--user-data", scratch],
        "PROMOTION_USER_DATA_APPLY_REFUSED",
      ],
      [["--user-data"], "PROMOTION_OPTION_VALUE_MISSING:--user-data"],
      [
        ["--user-data", "--apply"],
        "PROMOTION_OPTION_VALUE_MISSING:--user-data",
      ],
      [
        ["--user-data", scratch, "--user-data", scratch],
        "PROMOTION_OPTION_REPEATED:--user-data",
      ],
      [["--bogus"], "PROMOTION_OPTION_INVALID:--bogus"],
    ];
    for (const [arguments_, code] of cases) {
      const result = await run(realCli, arguments_);
      expect(result.code, arguments_.join(" ")).toBe(1);
      expect(result.stdout, arguments_.join(" ")).toBe("");
      expect(result.stderr, arguments_.join(" ")).toBe(
        `Farol Next Preview promotion refused: ${code}\n`,
      );
    }
  }, 30_000);
});
