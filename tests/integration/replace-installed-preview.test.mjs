// Native disposable lock/custody/placement evidence, with synthetic package and
// source verification. No Electron package, owner profile or provider qualifies.
import { spawn, spawnSync } from "node:child_process";
import { constants as C } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import { promotionUserData } from "../../tooling/promotion-obligations.mjs";
import {
  replaceInstalledPreview,
  snapshotInstalledReplacement,
} from "../../tooling/replace-installed-preview.mjs";
import { isPromotionLeaseHeld } from "../../tooling/promotion-lease.mjs";
const roots = [];
const originalCloses = new Set();
const unconfirmedHelpers = new Set();
function observe(child) {
  let stdout = "",
    stderr = "",
    failure;
  child.stdout.on("data", (part) => {
    stdout += part;
  });
  child.stderr.on("data", (part) => {
    stderr += part;
  });
  child.once("error", (error) => {
    failure = error;
  });
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      originalCloses.delete(closed);
      resolve({ code, signal, stdout, stderr, failure });
    });
  });
  originalCloses.add(closed);
  return { child, closed, output: () => stdout };
}
async function kernelLockHeld(file) {
  let handle;
  try {
    handle = await fs.open(file, C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK | 0x20);
    return false;
  } catch (error) {
    if (error.code === "EAGAIN") return true;
    throw error;
  } finally {
    await handle?.close();
  }
}
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw Error("REPLACEMENT_FIXTURE_WAIT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function exactProcess(pid, column) {
  return spawnSync("/bin/ps", ["-p", String(pid), "-o", `${column}=`], {
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    encoding: "utf8",
    timeout: 1000,
  });
}
afterEach(async () => {
  if (originalCloses.size || unconfirmedHelpers.size)
    throw Error(`REPLACEMENT_FIXTURE_CLOSE_UNCONFIRMED:${roots.join(",")}`);
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true });
});

async function fixture() {
  const temporary = await fs.realpath(os.tmpdir());
  const r = await fs.mkdtemp(path.join(temporary, "farol-replacement-"));
  roots.push(r);
  const home = path.join(r, "home");
  const userData = promotionUserData(home);
  const apps = path.join(home, "Applications");
  const oldApp = path.join(apps, "Farol.app");
  const candidateApp = path.join(r, "candidate/Farol.app");
  const build = (n) =>
    createBuildIdentity({
      version: `0.2.0-owner.beta.${n}`,
      buildVersion: String(n + 14),
      updateChannel: "github-owner-beta",
      builtAt: "2026-10-10T00:00:00.000Z",
      sourceCommit: String(n).repeat(40),
      sourceTreeDigest: String(n).repeat(64),
      sourceDirty: false,
    });
  const oldBuild = build(5),
    target = build(6);
  for (const [app, identity] of [
    [oldApp, oldBuild],
    [candidateApp, target],
  ]) {
    await fs.mkdir(path.join(app, "Contents/Resources/app"), {
      recursive: true,
      mode: 0o755,
    });
    await fs.writeFile(
      path.join(app, "Contents/Resources/app/build-identity.json"),
      JSON.stringify(identity),
      { mode: 0o644 },
    );
  }
  await fs.chmod(home, 0o700);
  await fs.mkdir(path.join(userData, "farol-next-state"), {
    recursive: true,
    mode: 0o700,
  });
  const updates = path.join(userData, "installed-updates");
  await fs.mkdir(updates, { mode: 0o700 });
  for (const [name, raw] of [
    ["lock", ""],
    ["ready.json", '{"helper":null}'],
    ["last-update.json", '{"helper":null,"phase":"verified"}'],
  ])
    await fs.writeFile(path.join(updates, name), raw, { mode: 0o600 });
  const op = path.join(updates, "a".repeat(32));
  await fs.mkdir(path.join(op, "previous.app"), {
    recursive: true,
    mode: 0o700,
  });
  const journal = '{"phase":"launch_requested","fixtureOnly":true}\n';
  await fs.writeFile(path.join(op, "journal.json"), journal, { mode: 0o600 });
  const oldDigest = await treeDigest(oldApp);
  const receipt = {
    schema: "farol.next.promotion-plan/1",
    operation: "applied",
    product: "Farol Next Preview",
    version: oldBuild.version,
    sourceCommit: oldBuild.sourceCommit,
    sourceTreeDigest: oldBuild.sourceTreeDigest,
    sourceDirty: false,
    artifactSha256: oldDigest,
    source: path.join(r, "original-source"),
    destination: oldApp,
    receipt: oldApp + ".receipt.json",
    overwrite: false,
    legacyMutation: false,
    activation: { userData, drained: true, obligations: [] },
    verifiedDestinationSha256: oldDigest,
  };
  const oldReceipt = JSON.stringify(receipt) + "\n";
  await fs.writeFile(oldApp + ".receipt.json", oldReceipt, { mode: 0o600 });
  const artifact = {
    ...target,
    schema: 7,
    artifactSha256: await treeDigest(candidateApp),
    artifactPath: candidateApp,
  };
  const snapshot = await snapshotInstalledReplacement(home);
  const selection = {
    schema: "farol.installed-replacement-selection/1",
    sourceCommit: target.sourceCommit,
    operationId: "b".repeat(32),
    snapshot,
    helpers: [],
  };
  const deps = {
    home,
    artifact,
    candidate: {
      artifactFile: path.join(r, "fixture-artifact.json"),
      appPath: candidateApp,
    },
    sourceIdentity: () => ({
      commit: target.sourceCommit,
      treeDigest: target.sourceTreeDigest,
      dirty: false,
    }),
    processProof: () => {},
    verify: async (_artifact, app) => {
      expect(await treeDigest(app)).toBe(artifact.artifactSha256);
    },
  };
  return {
    r,
    home,
    userData,
    apps,
    updates,
    oldApp,
    oldReceipt,
    journal,
    selection,
    deps,
    artifact,
    custody: path.join(apps, `.farol-replacement-${selection.operationId}`),
  };
}

describe("one-shot installed replacement", () => {
  it("plans without intent, custody, lock creation or app mutation", async () => {
    const f = await fixture();
    const result = await replaceInstalledPreview(f.selection, false, f.deps);
    expect(result.operation).toBe("plan-only");
    await expect(fs.lstat(f.custody)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.lstat(path.join(f.userData, "farol-next-state/promotion.lease")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(f.oldApp + ".receipt.json", "utf8")).toBe(
      f.oldReceipt,
    );
  });
  it.each(["occupied", "inode", "digest", "journal", "drain"])(
    "refuses %s before custody",
    async (kind) => {
      const f = await fixture();
      if (kind === "occupied") await fs.mkdir(f.custody);
      if (kind === "inode") f.selection.snapshot.appIdentity = ["0", "0"];
      if (kind === "digest")
        f.selection.snapshot.receiptSha256 = "0".repeat(64);
      if (kind === "journal")
        await fs.writeFile(path.join(f.updates, "pending.json"), "unknown", {
          mode: 0o600,
        });
      if (kind === "drain")
        f.deps.activation = async () => ({
          obligations: ["QUIT_UNCONFIRMED"],
          unreadable: [],
          changed: [],
          drained: false,
        });
      await expect(
        replaceInstalledPreview(f.selection, true, f.deps),
      ).rejects.toThrow();
      expect(await fs.readFile(f.oldApp + ".receipt.json", "utf8")).toBe(
        f.oldReceipt,
      );
      await expect(
        fs.lstat(
          path.join(
            f.userData,
            "farol-next-state/installed-replacement.pending",
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it.each([false, true])(
    "refuses oversized intent before any native child in apply=%s",
    async (apply) => {
      const f = await fixture();
      const op = path.join(f.updates, "a".repeat(32));
      // Immediate metadata exceeds the native record cap; no archive contents.
      for (let i = 0; i < 280; i += 1)
        await fs.mkdir(path.join(op, `${"é".repeat(90)}-${i}`), {
          mode: 0o700,
        });
      f.selection.snapshot = await snapshotInstalledReplacement(f.home);
      const metadata = JSON.stringify(f.selection.snapshot);
      expect(metadata.length).toBeLessThan(64 * 1024);
      expect(Buffer.byteLength(metadata, "utf8")).toBeGreaterThanOrEqual(
        64 * 1024,
      );
      let placementCalled = false,
        nativeCalled = false;
      f.deps.native = async () => {
        nativeCalled = true;
      };
      f.deps.promotion = async () => {
        placementCalled = true;
      };
      await expect(
        replaceInstalledPreview(f.selection, apply, f.deps),
      ).rejects.toThrow("REPLACEMENT_INTENT_TOO_LARGE");
      expect(placementCalled).toBe(false);
      expect(nativeCalled).toBe(false);
      await expect(fs.lstat(f.custody)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        fs.lstat(
          path.join(
            f.userData,
            "farol-next-state/installed-replacement.pending",
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(f.oldApp + ".receipt.json", "utf8")).toBe(
        f.oldReceipt,
      );
      expect(await treeDigest(f.oldApp)).toBe(f.selection.snapshot.appSha256);
      // No effectsStarted retention interval or unresolved original child exists.
      expect(await isPromotionLeaseHeld(f.userData)).toBe(false);
      const lock = await fs.open(
        path.join(f.updates, "lock"),
        C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK | 0x20,
      );
      await lock.close();
    },
  );
  it("keeps both original lock inodes held by the genuine placement child after exact owner death", async () => {
    const f = await fixture();
    const packet = path.join(f.r, "fixture.json");
    await fs.writeFile(
      packet,
      JSON.stringify({ selection: f.selection, deps: f.deps }),
      { mode: 0o600 },
    );
    const runner = path.join(f.r, "owner.mjs");
    const producerUrl = new URL(
      "../../tooling/replace-installed-preview.mjs",
      import.meta.url,
    ).href;
    const promotionUrl = new URL(
      "../../tooling/promotion-apply.mjs",
      import.meta.url,
    ).href;
    // This is the real producer and unmodified, hash-pinned placement helper.
    // Only package/source/process proofs are synthetic. The ordinary helper's
    // existing pre-effect hook gives a deterministic pause, not a copy fault.
    await fs.writeFile(
      runner,
      `
import fs from "node:fs/promises";
import { replaceInstalledPreview } from ${JSON.stringify(producerUrl)};
import { runPromotionApply } from ${JSON.stringify(promotionUrl)};
const { selection, deps } = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
deps.sourceIdentity = () => ({ commit: deps.artifact.sourceCommit, treeDigest: deps.artifact.sourceTreeDigest, dirty: false });
deps.verify = async () => {};
deps.processProof = () => {};
deps.promotion = (options) => runPromotionApply({ ...options, onChildStarted: (closed, identity) => {
  options.onChildStarted(closed);
  process.send({ kind: "placement-child-started", pid: identity.pid });
}, afterParentOpened: async () => {
  await options.afterParentOpened();
  process.send({ kind: "placement-child-waiting" });
  await new Promise(() => {});
}});
await replaceInstalledPreview(selection, true, deps);
`,
      { mode: 0o600 },
    );
    const owner = observe(
      spawn(process.execPath, [runner, packet], {
        cwd: process.cwd(),
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }),
    );
    const messages = [];
    let helperPid,
      watcher,
      helperExited = false;
    owner.child.on("message", (message) => {
      messages.push(message);
      if (message.kind === "placement-child-started") {
        helperPid = message.pid;
        unconfirmedHelpers.add(f.r);
      }
    });
    try {
      await waitFor(() =>
        messages.some((message) => message.kind === "placement-child-waiting"),
      );
      expect(
        messages.filter(
          (message) => message.kind === "placement-child-started",
        ),
      ).toHaveLength(1);
      expect(Number.isSafeInteger(helperPid) && helperPid > 1).toBe(true);
      const command = exactProcess(helperPid, "command");
      expect(command.status).toBe(0);
      expect(command.stderr).toBe("");
      expect(command.stdout.trim()).toMatch(/[Pp]ython3? -I -S -B -$/u);
      const initialStart = exactProcess(helperPid, "lstart").stdout;
      process.kill(helperPid, "SIGSTOP");
      await waitFor(() =>
        exactProcess(helperPid, "state").stdout.trim().startsWith("T"),
      );
      // Register a native NOTE_EXIT watcher while the exact original child is
      // stopped/alive. Its kernel exit event is terminal proof, not PID absence.
      watcher = observe(
        spawn(
          "/usr/bin/python3",
          [
            "-I",
            "-S",
            "-B",
            "-c",
            String.raw`
import os, select, sys
pid = int(sys.argv[1])
kq = select.kqueue()
kq.control([select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT)], 0, 0)
os.write(1, b"WATCHING\n")
events = kq.control(None, 1, 10)
if len(events) != 1 or events[0].ident != pid or not events[0].fflags & select.KQ_NOTE_EXIT:
    raise SystemExit(1)
os.write(1, b"EXIT\n")
`,
            String(helperPid),
          ],
          {
            env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      );
      await waitFor(() => watcher.output() === "WATCHING\n");
      expect(await isPromotionLeaseHeld(f.userData)).toBe(true);
      const promotionFile = path.join(
        f.userData,
        "farol-next-state/promotion.lease",
      );
      const updaterFile = path.join(f.custody, "installed-updates/lock");

      const promotionBefore = await fs.lstat(promotionFile, { bigint: true });
      process.kill(owner.child.pid, "SIGKILL");
      expect(await owner.closed).toMatchObject({
        code: null,
        signal: "SIGKILL",
        stderr: "",
        failure: undefined,
      });
      expect(exactProcess(helperPid, "lstart").stdout).toBe(initialStart);
      expect(
        exactProcess(helperPid, "state").stdout.trim().startsWith("T"),
      ).toBe(true);
      const files = [
        [
          promotionFile,
          [String(promotionBefore.dev), String(promotionBefore.ino)],
        ],
        [updaterFile, f.selection.snapshot.updaterLockIdentity],
      ];
      for (const [file, expected] of files) {
        const named = await fs.lstat(file, { bigint: true });
        expect([String(named.dev), String(named.ino)]).toEqual(expected);
        expect(await kernelLockHeld(file)).toBe(true);
      }
      expect(watcher.output()).toBe("WATCHING\n");
      // Parent pipes closed on death. Resuming this original child makes its
      // hook refuse EOF and close; no replacement or replay child is started.
      process.kill(helperPid, "SIGCONT");
      const exit = await watcher.closed;
      if (
        exit.code === 0 &&
        exit.stdout === "WATCHING\nEXIT\n" &&
        !exit.stderr &&
        !exit.failure
      ) {
        helperExited = true;
        unconfirmedHelpers.delete(f.r);
      }
      expect(exit).toEqual({
        code: 0,
        signal: null,
        stdout: "WATCHING\nEXIT\n",
        stderr: "",
        failure: undefined,
      });
      for (const [file, expected] of files) {
        const lock = await fs.open(
          file,
          C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK | 0x20,
        );
        try {
          const opened = await lock.stat({ bigint: true });
          expect([String(opened.dev), String(opened.ino)]).toEqual(expected);
        } finally {
          await lock.close();
        }
      }
      expect(
        (
          await fs.lstat(
            path.join(
              f.userData,
              "farol-next-state/installed-replacement.pending",
            ),
          )
        ).isFile(),
      ).toBe(true);
      await expect(fs.lstat(f.oldApp)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        await fs.readFile(
          path.join(f.custody, "previous.receipt.json"),
          "utf8",
        ),
      ).toBe(f.oldReceipt);
    } finally {
      if (owner.child.exitCode === null && owner.child.signalCode === null)
        owner.child.kill("SIGKILL");
      await owner.closed;
      if (helperPid && !helperExited) {
        // Exact fixture child only; use the already-registered exit observer.
        try {
          process.kill(helperPid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        if (watcher) {
          const exit = await watcher.closed;
          if (
            exit.code !== 0 ||
            exit.stdout !== "WATCHING\nEXIT\n" ||
            exit.stderr
          )
            throw Error("REPLACEMENT_FIXTURE_HELPER_EXIT_UNCONFIRMED");
          unconfirmedHelpers.delete(f.r);
        } else throw Error("REPLACEMENT_FIXTURE_HELPER_EXIT_UNCONFIRMED");
      }
    }
  }, 15000);
  it("refuses a waiting old helper's updater lock even though promotion is available", async () => {
    const f = await fixture();
    const lock = await fs.open(
      path.join(f.updates, "lock"),
      C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK | 0x20,
    );
    try {
      await expect(
        replaceInstalledPreview(f.selection, true, f.deps),
      ).rejects.toThrow();
    } finally {
      await lock.close();
    }
    expect(await fs.readFile(f.oldApp + ".receipt.json", "utf8")).toBe(
      f.oldReceipt,
    );
  });
  it("custodies every original byte and retains an unconfirmed journal through genuine promotion", async () => {
    const f = await fixture();
    const result = await replaceInstalledPreview(f.selection, true, f.deps);
    expect(result.operation).toBe("completed");
    expect(await treeDigest(path.join(f.custody, "previous.app"))).toBe(
      f.selection.snapshot.appSha256,
    );
    expect(
      await fs.readFile(path.join(f.custody, "previous.receipt.json"), "utf8"),
    ).toBe(f.oldReceipt);
    expect(
      await fs.readFile(
        path.join(
          f.custody,
          "installed-updates",
          "a".repeat(32),
          "journal.json",
        ),
        "utf8",
      ),
    ).toBe(f.journal);
    expect(await treeDigest(f.oldApp)).toBe(f.artifact.artifactSha256);
    const receipt = JSON.parse(
      await fs.readFile(f.oldApp + ".receipt.json", "utf8"),
    );
    expect(receipt).toEqual(result.receipt);
    expect(receipt.schema).toBe("farol.next.promotion-plan/1");
    expect(receipt.sourceCommit).toBe(f.artifact.sourceCommit);
    await expect(
      fs.lstat(
        path.join(f.userData, "farol-next-state/installed-replacement.pending"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([
    "partial-intent",
    "retirement-and-uncertainty",
    "placement-lost-result",
    "completion-lost-result",
  ])(
    "retains both original locks and live owner after %s, regardless of pending presence after original child close",
    async (fault) => {
      const f = await fixture();
      const packet = path.join(f.r, "fault-fixture.json");
      await fs.writeFile(
        packet,
        JSON.stringify({ selection: f.selection, deps: f.deps }),
        { mode: 0o600 },
      );
      const runner = path.join(f.r, "fault-owner.mjs");
      const producerUrl = new URL(
        "../../tooling/replace-installed-preview.mjs",
        import.meta.url,
      ).href;
      const promotionUrl = new URL(
        "../../tooling/promotion-apply.mjs",
        import.meta.url,
      ).href;
      const leaseUrl = new URL(
        "../../tooling/promotion-lease.mjs",
        import.meta.url,
      ).href;
      const helperFile = new URL(
        "../../tooling/replace-installed-preview.py",
        import.meta.url,
      ).pathname;
      const libraryFile = new URL(
        "../../tooling/promotion-apply.py",
        import.meta.url,
      ).pathname;
      // Code-attested fixture only. It executes exact hash-pinned helper bytes
      // with two local fsync faults; the CLI has no seam/flag to select this.
      const prefix = String.raw`
import errno, os, stat
real_sync = os.fsync
retirement_failed = False
state = STATE_PATH
pending = os.path.join(state, "installed-replacement.pending")
retired = RETIRED_PATH
fault = FAULT_KIND
def fault_sync(fd):
    global retirement_failed
    info = os.fstat(fd)
    if fault == "partial-intent" and stat.S_ISREG(info.st_mode):
        named = os.stat(pending, follow_symlinks=False)
        if (info.st_dev, info.st_ino) == (named.st_dev, named.st_ino):
            os.write(9, b"INITIAL_INTENT_FILE_FSYNC_FAILED\n")
            raise OSError(errno.EIO, "fixture initial intent fsync")
    if fault == "retirement-and-uncertainty" and stat.S_ISDIR(info.st_mode) and os.path.exists(retired):
        named = os.stat(state, follow_symlinks=False)
        if (info.st_dev, info.st_ino) == (named.st_dev, named.st_ino):
            if not retirement_failed and not os.path.lexists(pending):
                retirement_failed = True
                os.write(9, b"RETIREMENT_DIRECTORY_FSYNC_FAILED\n")
                raise OSError(errno.EIO, "fixture retirement fsync")
            if retirement_failed and os.path.lexists(pending):
                os.write(9, b"UNCERTAINTY_DIRECTORY_FSYNC_FAILED\n")
                raise OSError(errno.EIO, "fixture uncertainty fsync")
    return real_sync(fd)
os.fsync = fault_sync
`;
      const nativePrefix = prefix
        .replace(
          "STATE_PATH",
          JSON.stringify(path.join(f.userData, "farol-next-state")),
        )
        .replace(
          "RETIRED_PATH",
          JSON.stringify(path.join(f.custody, "completed-intent.json")),
        )
        .replace("FAULT_KIND", JSON.stringify(fault));
      await fs.writeFile(
        runner,
        `
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { replaceInstalledPreview, runReplacementNative } from ${JSON.stringify(producerUrl)};
import { runPromotionApply } from ${JSON.stringify(promotionUrl)};
import { promotionLeaseDescriptor } from ${JSON.stringify(leaseUrl)};
const { selection, deps } = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
deps.sourceIdentity = () => ({ commit: deps.artifact.sourceCommit, treeDigest: deps.artifact.sourceTreeDigest, dirty: false });
deps.verify = async () => {};
deps.processProof = () => {};
const fault = ${JSON.stringify(fault)};
const sha = (raw) => createHash("sha256").update(raw).digest("hex");
deps.native = async (request, lease, updater, register) => {
  if (fault === "completion-lost-result") {
    const result = await runReplacementNative(request, lease, updater, register);
    if (request.action === "complete") {
      process.send({ kind: "original-completion-child-closed" });
      throw Error("FIXTURE_COMPLETION_RESULT_LOST");
    }
    return result;
  }
  if ((fault === "partial-intent" && request.action !== "custody") ||
      (fault !== "partial-intent" && request.action !== "complete") ||
      fault === "placement-lost-result")
    return runReplacementNative(request, lease, updater, register);
  const helper = await fs.readFile(${JSON.stringify(helperFile)});
  const library = await fs.readFile(${JSON.stringify(libraryFile)});
  if (sha(helper) !== "479edb96545dc2ba30938aed7af3ba22f3098b8c3cc8dbac17176c891dbefcb5" ||
      sha(library) !== "53eee38236103b140d95ab27342c522b7a9a1f4fc8fe8442b2cdd44f07be32db")
    throw Error("FIXTURE_HELPER_ATTESTATION_FAILED");
  const child = spawn("/usr/bin/python3", ["-I", "-S", "-B", "-"], {
    cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    stdio: ["pipe", "pipe", "pipe", "pipe", "ignore", "ignore", promotionLeaseDescriptor(lease), updater.fd, "pipe", "pipe"],
  });
  let stdout = "", stderr = "", failure;
  child.stdout.on("data", (part) => { stdout += part; });
  child.stderr.on("data", (part) => { stderr += part; });
  child.stdio[9].on("data", (part) => process.send({ kind: "fixture-native-fault", text: part.toString("utf8") }));
  child.once("error", (error) => { failure = error; });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  register(closed);
  for (const stream of [child.stdin, child.stdio[3], child.stdio[8]]) stream.on("error", (error) => { failure = error; });
  child.stdin.end(Buffer.concat([Buffer.from(${JSON.stringify(nativePrefix)}), helper]));
  child.stdio[8].end(library);
  child.stdio[3].end(JSON.stringify(request));
  const outcome = await closed;
  process.send({ kind: "original-native-child-closed", outcome, stderr, stdout });
  if (failure || outcome.code !== 0 || outcome.signal || stderr)
    throw Error(stderr.trim() || "FIXTURE_NATIVE_FAILURE");
  return JSON.parse(stdout);
};
if (fault === "placement-lost-result") deps.promotion = async (options) => {
  await runPromotionApply(options);
  process.send({ kind: "original-placement-child-closed" });
  throw Error("FIXTURE_PLACEMENT_RESULT_LOST");
};
try { await replaceInstalledPreview(selection, true, deps); }
catch (error) { process.send({ kind: "replacement-failed", message: error.message }); }
`,
        { mode: 0o600 },
      );
      const owner = observe(
        spawn(process.execPath, [runner, packet], {
          cwd: process.cwd(),
          env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        }),
      );
      const messages = [];
      unconfirmedHelpers.add(f.r);
      owner.child.on("message", (message) => {
        messages.push(message);
        if (
          message.kind === "original-native-child-closed" ||
          message.kind === "original-placement-child-closed" ||
          message.kind === "original-completion-child-closed"
        )
          unconfirmedHelpers.delete(f.r);
      });
      try {
        await waitFor(() =>
          messages.some((message) => message.kind === "replacement-failed"),
        );
        expect(owner.child.exitCode).toBe(null);
        expect(owner.child.signalCode).toBe(null);
        const pending = path.join(
          f.userData,
          "farol-next-state/installed-replacement.pending",
        );
        if (fault === "completion-lost-result")
          await expect(fs.lstat(pending)).rejects.toMatchObject({
            code: "ENOENT",
          });
        else expect((await fs.lstat(pending)).isFile()).toBe(true);
        const text = messages
          .filter((message) => message.kind === "fixture-native-fault")
          .map((message) => message.text)
          .join("");
        if (fault === "partial-intent") {
          expect(text).toBe("INITIAL_INTENT_FILE_FSYNC_FAILED\n");
          expect(await treeDigest(f.oldApp)).toBe(
            f.selection.snapshot.appSha256,
          );
          expect(await fs.readFile(f.oldApp + ".receipt.json", "utf8")).toBe(
            f.oldReceipt,
          );
          await expect(fs.lstat(f.custody)).rejects.toMatchObject({
            code: "ENOENT",
          });
        } else {
          expect(await treeDigest(f.oldApp)).toBe(f.artifact.artifactSha256);
          if (fault === "retirement-and-uncertainty") {
            expect(text).toBe(
              "RETIREMENT_DIRECTORY_FSYNC_FAILED\nUNCERTAINTY_DIRECTORY_FSYNC_FAILED\n",
            );
            expect(
              messages.find((message) => message.kind === "replacement-failed")
                .message,
            ).toBe("REPLACEMENT_COMPLETION_AND_FENCE_UNKNOWN");
            expect(JSON.parse(await fs.readFile(pending, "utf8")).schema).toBe(
              "farol.installed-replacement-unknown/1",
            );
          } else
            expect(
              messages.some(
                (message) =>
                  message.kind ===
                  (fault === "completion-lost-result"
                    ? "original-completion-child-closed"
                    : "original-placement-child-closed"),
              ),
            ).toBe(true);
        }
        if (
          fault !== "placement-lost-result" &&
          fault !== "completion-lost-result"
        ) {
          const closed = messages.find(
            (message) => message.kind === "original-native-child-closed",
          );
          expect(closed.outcome).toEqual({ code: 1, signal: null });
          expect(closed.stderr).toMatch(/^REPLACEMENT_[A-Z_]+\n$/u);
        }
        const lockFile = path.join(
          fault === "partial-intent"
            ? f.updates
            : path.join(f.custody, "installed-updates"),
          "lock",
        );
        const named = await fs.lstat(lockFile, { bigint: true });
        expect([String(named.dev), String(named.ino)]).toEqual(
          f.selection.snapshot.updaterLockIdentity,
        );
        expect(await kernelLockHeld(lockFile)).toBe(true);
        expect(
          await kernelLockHeld(
            path.join(f.userData, "farol-next-state/promotion.lease"),
          ),
        ).toBe(true);
        process.kill(owner.child.pid, "SIGKILL");
        const exit = await owner.closed;
        expect(exit.signal).toBe("SIGKILL");
        expect(exit.stderr).toBe(
          "REPLACEMENT_UNKNOWN_RETAINS_LOCKS_OWNER_REQUIRED\n",
        );
        expect(await kernelLockHeld(lockFile)).toBe(false);
        expect(
          await kernelLockHeld(
            path.join(f.userData, "farol-next-state/promotion.lease"),
          ),
        ).toBe(false);
      } finally {
        if (owner.child.exitCode === null && owner.child.signalCode === null)
          owner.child.kill("SIGKILL");
        await owner.closed;
      }
    },
    15000,
  );
});
