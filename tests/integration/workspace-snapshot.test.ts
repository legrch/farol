import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NativeReadonlyWorkspace,
  SAFE_OPEN_HELPER,
} from "../../src/modules/computer/infra/native/native-readonly-workspace";
import {
  createWorkspaceSnapshot,
  type WorkspaceSnapshotOptions,
} from "../../src/modules/computer/infra/native/workspace-snapshot";
import { approvedRootOf } from "../fixtures/root-identity";

const nextRoot = path.resolve(import.meta.dirname, "../..");
const sourceHelper = path.join(nextRoot, "resources/native/safe_open.py");

let root = "";
let runtimeDirectory = "";

function options(
  overrides: Partial<WorkspaceSnapshotOptions> = {},
): WorkspaceSnapshotOptions {
  return {
    helperPath: sourceHelper,
    helper: SAFE_OPEN_HELPER,
    attestInterpreter: async () => "/usr/bin/python3",
    runtimeDirectory,
    ...overrides,
  };
}

function git(
  cwd: string,
  ...args: string[]
): Readonly<{ status: number | null; stdout: string; stderr: string }> {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function gitStatus(cwd: string) {
  return git(cwd, "status", "--porcelain=v1", "-b", "--untracked-files=no");
}

function gitHead(cwd: string) {
  return git(cwd, "rev-parse", "--verify", "HEAD");
}

async function initRepo(dir: string): Promise<void> {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "n02a@example.com");
  git(dir, "config", "user.name", "N02a Fixture");
}

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-snapshot-src-")),
  );
  await fs.chmod(root, 0o700);
  runtimeDirectory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-snapshot-runtime-")),
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(runtimeDirectory, { recursive: true, force: true });
});

async function grepTree(dir: string, needle: string): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (await grepTree(full, needle)) return true;
      continue;
    }
    if (!entry.isFile()) continue;
    const content = await fs.readFile(full).catch(() => Buffer.alloc(0));
    if (content.includes(needle)) return true;
  }
  return false;
}

describe("workspace snapshot (N02)", () => {
  it("reports the same status and HEAD as the owner's Git for a healthy repository", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "README.md"), "first\n", {
      mode: 0o600,
    });
    await fs.mkdir(path.join(root, "src"), { mode: 0o700 });
    await fs.writeFile(
      path.join(root, "src", "kept.ts"),
      "export const kept = 1;\n",
      {
        mode: 0o600,
      },
    );
    await fs.writeFile(path.join(root, "removed.txt"), "gone\n", {
      mode: 0o600,
    });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    // A legitimate tracked change of every kind: modified, staged, deleted.
    await fs.writeFile(path.join(root, "README.md"), "first\nmodified\n", {
      mode: 0o600,
    });
    await fs.writeFile(path.join(root, "staged.txt"), "new\n", { mode: 0o600 });
    git(root, "add", "staged.txt");
    await fs.rm(path.join(root, "removed.txt"));

    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root) },
      options(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    try {
      expect(gitStatus(root).stdout).toEqual(gitStatus(outcome.path).stdout);
      expect(gitHead(root).stdout).toEqual(gitHead(outcome.path).stdout);
      expect(gitStatus(outcome.path).stdout).toContain("M README.md");
      expect(gitStatus(outcome.path).stdout).toContain("A  staged.txt");
      expect(gitStatus(outcome.path).stdout).toContain("D removed.txt");
    } finally {
      await outcome.remove();
    }
    await expect(fs.stat(outcome.path)).rejects.toThrow();
  });

  it("keeps the original tree when the root is replaced between the descriptor bind and the walk", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "original.txt"), "descriptor-bound\n", {
      mode: 0o600,
    });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    const approvedRoot = approvedRootOf(root);

    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot },
      options(),
      {
        testHookRequest: { phase: "before-snapshot-walk", index: null },
        testHook: async () => {
          await fs.rm(root, { recursive: true, force: true });
          await fs.mkdir(root, { mode: 0o700 });
          await fs.writeFile(
            path.join(root, "sentinel.txt"),
            "ATTACKER-CONTROLLED\n",
          );
        },
      },
    );

    // The root object itself was destroyed and recreated at the same path,
    // so its identity changed: the helper is expected to refuse rather than
    // silently snapshot nothing. Either outcome is safe; what must never
    // happen is the sentinel appearing in a successful snapshot.
    if (outcome.ok) {
      expect(await grepTree(outcome.path, "ATTACKER-CONTROLLED")).toBe(false);
      await outcome.remove();
    } else {
      expect(outcome.code).toBe("SNAPSHOT_ROOT_CHANGED");
    }
  });

  it("reads only the original inodes -- or refuses -- when the source changes mid-walk", async () => {
    await fs.writeFile(path.join(root, "a-first.txt"), "original-a\n", {
      mode: 0o600,
    });
    await fs.writeFile(path.join(root, "z-second.txt"), "original-z\n", {
      mode: 0o600,
    });

    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root) },
      options(),
      {
        testHookRequest: { phase: "snapshot-walk-entry", index: 0 },
        testHook: async () => {
          // The directory listing was already taken and the root descriptor
          // is already open; renaming the directory's contents away now must
          // not be visible to the walk that is already in progress.
          const outside = await fs.mkdtemp(
            path.join(os.tmpdir(), "farol-snapshot-outside-"),
          );
          await fs.writeFile(
            path.join(outside, "sentinel.txt"),
            "ATTACKER-CONTROLLED\n",
          );
          await fs.rm(path.join(root, "a-first.txt"));
          await fs.rm(path.join(root, "z-second.txt"));
          await fs.rename(
            path.join(outside, "sentinel.txt"),
            path.join(root, "a-first.txt"),
          );
        },
      },
    );

    // The directory that is being walked changed while it was being walked
    // (its own mtime/ctime moved), which the walk's own before/after check
    // may notice and refuse on -- the same race discipline every other walk
    // in this helper already applies. Either a refusal or a snapshot that
    // still shows only the original inodes is a safe outcome; what must
    // never happen is the replacement's content reaching the snapshot.
    if (outcome.ok) {
      try {
        const first = await fs
          .readFile(path.join(outcome.path, "a-first.txt"), "utf8")
          .catch(() => "");
        expect(first === "" || first === "original-a\n").toBe(true);
        expect(await grepTree(outcome.path, "ATTACKER-CONTROLLED")).toBe(false);
      } finally {
        await outcome.remove();
      }
    } else {
      expect(outcome.code).toBe("SNAPSHOT_ROOT_CHANGED");
    }
  });

  it("stays independent once the source is replaced after the snapshot exists", async () => {
    await fs.writeFile(path.join(root, "kept.txt"), "stable\n", {
      mode: 0o600,
    });
    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root) },
      options(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    try {
      await fs.rm(root, { recursive: true, force: true });
      await fs.mkdir(root, { mode: 0o700 });
      await fs.writeFile(
        path.join(root, "sentinel.txt"),
        "ATTACKER-CONTROLLED\n",
      );

      expect(
        await fs.readFile(path.join(outcome.path, "kept.txt"), "utf8"),
      ).toBe("stable\n");
      expect(await grepTree(outcome.path, "ATTACKER-CONTROLLED")).toBe(false);
    } finally {
      await outcome.remove();
    }
  });

  it("refuses a .git file pointing outside the approved tree", async () => {
    const outside = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-snapshot-external-")),
    );
    try {
      await fs.writeFile(
        path.join(root, ".git"),
        `gitdir: ${path.join(outside, "worktrees", "wt")}\n`,
      );
      const outcome = await createWorkspaceSnapshot(
        { root, approvedRoot: approvedRootOf(root) },
        options(),
      );
      expect(outcome).toEqual({
        ok: false,
        code: "SNAPSHOT_METADATA_UNAPPROVED",
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("reduces a .git/config carrying fsmonitor, include.path and a clean filter to its minimal form", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "f.txt"), "x\n", { mode: 0o600 });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    git(root, "config", "core.fsmonitor", "/bin/false");
    git(
      root,
      "config",
      "include.path",
      "/tmp/n02a-malicious-include.gitconfig",
    );
    git(
      root,
      "config",
      "filter.n02a-secrets.clean",
      "/tmp/n02a-malicious-clean.sh",
    );
    git(root, "config", "core.ignorecase", "true");
    git(root, "config", "core.precomposeunicode", "true");

    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root) },
      options(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    try {
      const config = await fs.readFile(
        path.join(outcome.path, ".git", "config"),
        "utf8",
      );
      expect(config).toBe(
        "[core]\n" +
          "\trepositoryformatversion = 0\n" +
          "\tfilemode = true\n" +
          "\tbare = false\n" +
          "\tignorecase = true\n" +
          "\tprecomposeunicode = true\n" +
          "\tsymlinks = true\n",
      );
      expect(config).not.toContain("fsmonitor");
      expect(config).not.toContain("include");
      expect(config).not.toContain("filter");
      expect(gitStatus(outcome.path).status).toBe(0);
    } finally {
      await outcome.remove();
    }
  });

  it("recreates a symlink without ever following it, and never discloses what it points to", async () => {
    const outside = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-snapshot-linktarget-")),
    );
    try {
      await fs.writeFile(
        path.join(outside, "secret.txt"),
        "OUTSIDE-SENTINEL-CONTENT\n",
      );
      await fs.symlink(
        path.join(outside, "secret.txt"),
        path.join(root, "link.txt"),
      );

      const outcome = await createWorkspaceSnapshot(
        { root, approvedRoot: approvedRootOf(root) },
        options(),
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      try {
        const linkPath = path.join(outcome.path, "link.txt");
        const stat = await fs.lstat(linkPath);
        expect(stat.isSymbolicLink()).toBe(true);
        expect(await fs.readlink(linkPath)).toBe(
          path.join(outside, "secret.txt"),
        );
        expect(await grepTree(outcome.path, "OUTSIDE-SENTINEL-CONTENT")).toBe(
          false,
        );
      } finally {
        await outcome.remove();
      }
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps the snapshot's content when the source file is replaced by rename afterwards", async () => {
    await fs.writeFile(path.join(root, "value.txt"), "captured\n", {
      mode: 0o600,
    });
    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root) },
      options(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    try {
      const replacement = path.join(root, "value.txt.new");
      await fs.writeFile(replacement, "replaced\n", { mode: 0o600 });
      await fs.rename(replacement, path.join(root, "value.txt"));

      expect(
        await fs.readFile(path.join(outcome.path, "value.txt"), "utf8"),
      ).toBe("captured\n");
    } finally {
      await outcome.remove();
    }
  });

  it("refuses once the tree exceeds the requested entry bound", async () => {
    await fs.mkdir(path.join(root, "a"));
    await fs.mkdir(path.join(root, "b"));
    await fs.mkdir(path.join(root, "c"));

    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root), maxEntries: 2 },
      options(),
    );
    expect(outcome).toEqual({ ok: false, code: "SNAPSHOT_TOO_LARGE" });
  });

  it("refuses once the copied-byte bound is too small for the rewritten config", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "f.txt"), "x\n", { mode: 0o600 });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");

    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root), maxBytes: 1 },
      options(),
    );
    expect(outcome).toEqual({ ok: false, code: "SNAPSHOT_TOO_LARGE" });
  });

  // A private user-owned RAM disk is the one portable way to get a second
  // real device on a developer Mac without special privileges; if this
  // sandbox cannot create one, the test reports that instead of silently
  // passing. HFS+ on purpose: it is also a volume without clone support,
  // which the second test below needs.
  // How many volume-dependent cases could not run. A runner that cannot
  // attach a second device has not proven any of the three refusals below,
  // and must say so: reported once at the end, because a case that quietly
  // returns is indistinguishable from one that passed.
  let unattachableVolumeCases = 0;

  afterAll(() => {
    if (unattachableVolumeCases === 0) return;
    console.warn(
      `workspace-snapshot: ${unattachableVolumeCases} of 3 volume-dependent ` +
        "case(s) skipped -- no second device could be attached, so the " +
        "cross-volume and clone-support refusals are NOT proven by this run",
    );
  });

  // `hdiutil detach` can return before the device is actually gone, leaving
  // a filesystem-less `ram://` device behind under rapid back-to-back runs.
  // Verify, retry exactly once, and say what happened either way -- a loop
  // here would turn a stuck device into a stuck suite.
  function ramDiskAttached(device: string): boolean {
    try {
      return execFileSync("hdiutil", ["info"], { encoding: "utf8" }).includes(
        device,
      );
    } catch {
      // Without a working `hdiutil info` there is nothing to verify against,
      // and inventing a retry from no evidence is worse than stopping.
      return false;
    }
  }

  function detachRamDisk(device: string, label: string): void {
    execFileSync("hdiutil", ["detach", device]);
    if (!ramDiskAttached(device)) return;
    console.warn(
      `workspace-snapshot ${label}: ${device} survived its detach; retrying once`,
    );
    try {
      execFileSync("hdiutil", ["detach", device]);
    } catch (error) {
      console.warn(
        `workspace-snapshot ${label}: retry detach failed: ${(error as Error).message}`,
      );
    }
    if (ramDiskAttached(device)) {
      console.warn(
        `workspace-snapshot ${label}: ${device} still attached after one retry; left in place`,
      );
    }
  }

  async function attachRamDisk(
    label: string,
  ): Promise<Readonly<{ device: string; mountPoint: string }> | null> {
    try {
      const device =
        execFileSync("hdiutil", ["attach", "-nomount", "ram://16384"], {
          encoding: "utf8",
        })
          .trim()
          .split(/\s+/)[0] ?? null;
      if (!device) throw new Error("no ram disk device returned");
      const volumeName = `N02ARAM${process.pid}${label}`;
      execFileSync("diskutil", ["eraseVolume", "HFS+", volumeName, device]);
      const mountPoint = `/Volumes/${volumeName}`;
      await fs.access(mountPoint);
      return { device, mountPoint };
    } catch (error) {
      // Environment cannot create a second real device (locked-down CI,
      // missing hdiutil/diskutil, or no permission). The mechanism this test
      // targets is still exercised by the entry/byte bound tests above; this
      // one specific volume case is reported skipped rather than faked.
      unattachableVolumeCases += 1;
      console.warn(
        `workspace-snapshot ${label} test skipped: ${(error as Error).message}`,
      );
      return null;
    }
  }

  // A clone across two volumes is impossible: this proves the refusal fires
  // for a real device boundary rather than only when the request says so.
  //
  // S35-TA-7: every case below attaches a volume, so none of them fits
  // vitest's 5 s default on a loaded machine — this one was measured at
  // 5.7 s in a full run at load average 44 while passing in well under a
  // second idle. The budget is the only thing widened; the assertions are
  // untouched. A test that passes alone and fails in the suite is a red
  // that gets explained away rather than read.
  it("refuses when the destination volume cannot hold a clone of the source", async (ctx) => {
    const disk = await attachRamDisk("cross-volume");
    // Skipped, not passed: the reporter must show this case as unproven.
    // `ctx.skip()` throws, so the `return` never runs -- it is there because
    // its type is not `never` and TypeScript cannot otherwise narrow `disk`.
    if (disk === null) {
      ctx.skip();
      return;
    }
    try {
      await fs.writeFile(path.join(root, "f.txt"), "x\n", { mode: 0o600 });
      const outcome = await createWorkspaceSnapshot(
        { root, approvedRoot: approvedRootOf(root) },
        options({ runtimeDirectory: disk.mountPoint }),
      );
      expect(outcome).toEqual({ ok: false, code: "SNAPSHOT_CROSS_VOLUME" });
    } finally {
      detachRamDisk(disk.device, "cross-volume");
    }
  }, 60_000);

  // Source and destination on one volume that cannot clone at all (HFS+):
  // the refusal is distinct from the cross-volume one, and nothing falls
  // back to copying the tree.
  it("refuses distinctly when the shared volume has no clone support", async (ctx) => {
    const disk = await attachRamDisk("clone-unsupported");
    // Skipped, not passed: the reporter must show this case as unproven.
    // `ctx.skip()` throws, so the `return` never runs -- it is there because
    // its type is not `never` and TypeScript cannot otherwise narrow `disk`.
    if (disk === null) {
      ctx.skip();
      return;
    }
    try {
      const sourceRoot = await fs.realpath(
        await fs.mkdtemp(path.join(disk.mountPoint, "src-")),
      );
      const runtime = await fs.realpath(
        await fs.mkdtemp(path.join(disk.mountPoint, "runtime-")),
      );
      await fs.chmod(sourceRoot, 0o700);
      await fs.writeFile(path.join(sourceRoot, "f.txt"), "x\n", {
        mode: 0o600,
      });
      const outcome = await createWorkspaceSnapshot(
        { root: sourceRoot, approvedRoot: approvedRootOf(sourceRoot) },
        options({ runtimeDirectory: runtime }),
      );
      expect(outcome).toEqual({
        ok: false,
        code: "SNAPSHOT_CLONE_UNSUPPORTED",
      });
      expect(await fs.readdir(runtime)).toEqual([]);
    } finally {
      detachRamDisk(disk.device, "clone-unsupported");
    }
  }, 60_000);

  // The two tests above prove the clone/EXDEV mechanism with a plain
  // directory: a request that never touches Git. This one drives the actual
  // end-to-end statement an audit flagged as unproven -- a `git.status`
  // against a *real, approved Git repository* whose root happens to live on
  // another volume must refuse with the same closed code instead of
  // answering, through the exact production route the desktop and the
  // Computer MCP server call (`NativeReadonlyWorkspace.execute`), not the
  // snapshot layer alone. The repository lives on the second volume and the
  // runtime directory (where the private snapshot would be built) stays on
  // the default one from `beforeEach`, so the two are genuinely on different
  // devices -- the same real boundary the mechanism test above exercises,
  // just with the source and destination swapped and a real repository in
  // place of a plain directory.
  it("refuses git.status through the production route when the approved repository root sits on another volume", async (ctx) => {
    const disk = await attachRamDisk("git-status-cross-volume");
    // Skipped, not passed: the reporter must show this case as unproven.
    // `ctx.skip()` throws, so the `return` never runs -- it is there because
    // its type is not `never` and TypeScript cannot otherwise narrow `disk`.
    if (disk === null) {
      ctx.skip();
      return;
    }
    try {
      const repoRoot = await fs.realpath(
        await fs.mkdtemp(path.join(disk.mountPoint, "repo-")),
      );
      await fs.chmod(repoRoot, 0o700);
      await initRepo(repoRoot);
      await fs.writeFile(
        path.join(repoRoot, "tracked.txt"),
        "SECOND-VOLUME-SENTINEL\n",
        { mode: 0o600 },
      );
      git(repoRoot, "add", "-A");
      git(repoRoot, "commit", "-q", "-m", "init");

      const workspace = new NativeReadonlyWorkspace({
        helperPath: sourceHelper,
        helper: SAFE_OPEN_HELPER,
        attestInterpreter: async () => "/usr/bin/python3",
        // Resolved the same way the sibling native-verification-command
        // tests resolve it: the real reviewed Apple Git, without repeating
        // the full codesign/version attestation chain (already proven
        // elsewhere) on every run of this one.
        attestGit: async () =>
          execFileSync("/usr/bin/xcrun", ["--find", "git"], {
            encoding: "utf8",
          }).trim(),
        runtimeDirectory,
      });

      const result = await workspace.execute({
        workspace: {
          workspaceId: "workspace-cross-volume",
          root: repoRoot,
          approvedRoot: approvedRootOf(repoRoot),
          deniedPaths: [],
        },
        operation: {
          kind: "verification.run",
          command: "git.status",
          relativePath: ".",
        },
      });

      expect(result).toEqual({
        ok: false,
        error: { code: "WORKSPACE_SNAPSHOT_CROSS_VOLUME", retry: "never" },
      });
      // Refused before any clone and before any Git process ever ran: no
      // snapshot survives under the runtime directory this route was given,
      // and the repository's own tracked content never reaches the result.
      expect(await fs.readdir(runtimeDirectory)).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("SECOND-VOLUME-SENTINEL");
    } finally {
      detachRamDisk(disk.device, "git-status-cross-volume");
    }
    // S35-TA-7: this case attaches a volume, runs `git init`, makes a
    // commit, spawns the attested helper AND builds a snapshot, so it is
    // several times the work of the two mechanism cases above and does not
    // fit vitest's 5 s default on a loaded machine (measured: 14.1 s before
    // failing, while passing in 2 s idle). The budget is the only thing
    // widened — every assertion above is unchanged — following the same
    // per-test budgets `native-verification-command.test.ts` already uses
    // for its real-Git cases.
  }, 60_000);

  it("carries the structural extensions through the reduced config and reduces config.worktree the same way", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "f.txt"), "x\n", { mode: 0o600 });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    git(root, "config", "core.repositoryformatversion", "1");
    git(root, "config", "extensions.worktreeConfig", "true");
    git(root, "config", "extensions.partialClone", "origin");
    git(root, "config", "--worktree", "core.fsmonitor", "/bin/false");
    git(root, "config", "--worktree", "core.hooksPath", "/tmp/n02-hooks");
    git(root, "config", "--worktree", "core.ignorecase", "true");
    git(root, "config", "--worktree", "core.precomposeunicode", "true");

    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root) },
      options(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    try {
      const config = await fs.readFile(
        path.join(outcome.path, ".git", "config"),
        "utf8",
      );
      expect(config).toBe(
        "[core]\n" +
          "\trepositoryformatversion = 1\n" +
          "\tfilemode = true\n" +
          "\tbare = false\n" +
          "\tignorecase = true\n" +
          "\tprecomposeunicode = true\n" +
          "\tsymlinks = true\n" +
          "[extensions]\n" +
          "\tworktreeconfig = true\n",
      );
      // Only keys the file actually set, only the reviewed booleans, and no
      // default that would override the main config.
      expect(
        await fs.readFile(
          path.join(outcome.path, ".git", "config.worktree"),
          "utf8",
        ),
      ).toBe("[core]\n\tignorecase = true\n\tprecomposeunicode = true\n");
      expect(gitStatus(outcome.path).stdout).toEqual(gitStatus(root).stdout);
    } finally {
      await outcome.remove();
    }
  });

  it("carries extensions.objectFormat so a sha256 repository stays readable", async () => {
    git(root, "init", "-q", "--object-format=sha256");
    git(root, "config", "user.email", "n02a@example.com");
    git(root, "config", "user.name", "N02a Fixture");
    await fs.writeFile(path.join(root, "f.txt"), "x\n", { mode: 0o600 });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    const ownerHead = gitHead(root).stdout;
    expect(ownerHead).toMatch(/^[0-9a-f]{64}\n$/u);

    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root) },
      options(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    try {
      expect(
        await fs.readFile(path.join(outcome.path, ".git", "config"), "utf8"),
      ).toContain("[extensions]\n\tobjectformat = sha256\n");
      expect(gitHead(outcome.path).stdout).toBe(ownerHead);
      expect(gitStatus(outcome.path).stdout).toEqual(gitStatus(root).stdout);
    } finally {
      await outcome.remove();
    }
  });

  // The refusal rests on the entry's existence alone -- the helper never
  // opens it -- so the file may name anything; nothing is read from it and
  // no snapshot is left behind. (That the bytes were not read cannot be
  // observed from outside; what is asserted is the refusal and the absence
  // of any destination.)
  it("refuses a repository with objects/info/alternates before any clone is made", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "f.txt"), "x\n", { mode: 0o600 });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    await fs.writeFile(
      path.join(root, ".git", "objects", "info", "alternates"),
      "/nonexistent/OUTSIDE-SENTINEL/objects\n",
      { mode: 0o600 },
    );

    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root) },
      options(),
    );
    expect(outcome).toEqual({
      ok: false,
      code: "SNAPSHOT_ALTERNATES_UNSUPPORTED",
    });
    expect(await fs.readdir(runtimeDirectory)).toEqual([]);
  });

  it("snapshots a linked worktree's own gitdir and the repository's common gitdir", async () => {
    const primary = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-snapshot-primary-")),
    );
    let worktree = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-snapshot-wt-")),
    );
    await fs.rm(worktree, { recursive: true, force: true });
    try {
      await initRepo(primary);
      await fs.writeFile(path.join(primary, "main.txt"), "main\n", {
        mode: 0o600,
      });
      git(primary, "add", "-A");
      git(primary, "commit", "-q", "-m", "init");
      git(primary, "worktree", "add", "-q", worktree, "-b", "n02a-wt-branch");
      await fs.writeFile(path.join(worktree, "wt.txt"), "wt\n", {
        mode: 0o600,
      });

      const gitFile = await fs.readFile(path.join(worktree, ".git"), "utf8");
      const gitdirValue = gitFile.slice("gitdir: ".length).trim();
      const commondirValue = (
        await fs.readFile(path.join(gitdirValue, "commondir"), "utf8")
      ).trim();
      const commonDirectory = path.normalize(
        path.join(gitdirValue, commondirValue),
      );

      const outcome = await createWorkspaceSnapshot(
        {
          root: worktree,
          approvedRoot: approvedRootOf(worktree),
          externalGitDir: approvedRootOf(gitdirValue),
          externalCommonDir: approvedRootOf(commonDirectory),
        },
        options(),
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      try {
        expect(gitStatus(outcome.path).stdout).toEqual(
          gitStatus(worktree).stdout,
        );
        expect(gitHead(outcome.path).stdout).toEqual(gitHead(worktree).stdout);
      } finally {
        await outcome.remove();
      }
    } finally {
      git(primary, "worktree", "remove", "--force", worktree);
      await fs.rm(primary, { recursive: true, force: true });
      await fs.rm(worktree, { recursive: true, force: true });
    }
  });
});

// The refusals of the Node side of the snapshot boundary: a request this
// module will not even forward, an attestation that fails, and a helper
// response it will not trust. None of these needs a misbehaving real helper:
// whatever executable the attestation names is what runs the helper source,
// so a script standing in for the interpreter can answer with any bytes and
// any exit status.
describe("workspace snapshot refusals (N02)", () => {
  let fixturesDirectory = "";

  beforeEach(async () => {
    fixturesDirectory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-snapshot-fake-")),
    );
  });

  afterEach(async () => {
    await fs.rm(fixturesDirectory, { recursive: true, force: true });
  });

  function octal(bytes: Buffer): string {
    return [...bytes]
      .map((byte) => `\\${byte.toString(8).padStart(3, "0")}`)
      .join("");
  }

  // A stand-in interpreter: drains the helper source (stdin) and the request
  // (fd 3) so neither pipe breaks, optionally writes `stderr`, then answers
  // with `response` bytes and exits with `code`.
  async function fakeInterpreter(
    name: string,
    response: Buffer,
    code = 0,
    stderr = "",
  ): Promise<string> {
    const file = path.join(fixturesDirectory, `${name}.sh`);
    await fs.writeFile(
      file,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        "cat <&3 >/dev/null",
        ...(stderr === "" ? [] : [`printf '%s' '${stderr}' >&2`]),
        ...(response.length === 0 ? [] : [`printf '${octal(response)}'`]),
        `exit ${code}`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    return file;
  }

  function framed(payload: string, claimedLength?: number): Buffer {
    const header = Buffer.concat([
      Buffer.from("FAROLR1\0", "ascii"),
      Buffer.alloc(8),
    ]);
    header.writeBigUInt64BE(
      BigInt(claimedLength ?? Buffer.byteLength(payload)),
      8,
    );
    return Buffer.concat([header, Buffer.from(payload, "utf8")]);
  }

  const wellFormed =
    '{"bytes":1,"clonedBytes":2,"entries":3,"indexSha256":null,"skipped":0}';

  it("refuses a malformed request before touching the filesystem", async () => {
    const approvedRoot = approvedRootOf(root);
    const cases: ReadonlyArray<
      readonly [string, Parameters<typeof createWorkspaceSnapshot>[0]]
    > = [
      ["relative root", { root: "relative/root", approvedRoot }],
      [
        "grant with a non-numeric device",
        { root, approvedRoot: { ...approvedRoot, device: "x" } },
      ],
      ["absolute path in paths", { root, approvedRoot, paths: ["/etc/hosts"] }],
      ["traversal in paths", { root, approvedRoot, paths: ["../outside"] }],
      ["backslash in denied", { root, approvedRoot, denied: ["a\\b"] }],
      ["zero entry ceiling", { root, approvedRoot, maxEntries: 0 }],
      ["zero byte ceiling", { root, approvedRoot, maxBytes: 0 }],
      ["zero clone ceiling", { root, approvedRoot, maxClonedBytes: 0 }],
      [
        "malformed index pin",
        { root, approvedRoot, paths: [], expectedIndexSha256: "nope" },
      ],
      [
        "malformed external gitdir grant",
        {
          root,
          approvedRoot,
          externalGitDir: { path: "relative", device: "1", inode: "2" },
        },
      ],
    ];
    for (const [label, request] of cases) {
      expect(await createWorkspaceSnapshot(request, options()), label).toEqual({
        ok: false,
        code: "SNAPSHOT_INVALID_REQUEST",
      });
    }
    expect(
      await createWorkspaceSnapshot(
        { root, approvedRoot },
        options({ runtimeDirectory: "relative/runtime" }),
      ),
    ).toEqual({ ok: false, code: "SNAPSHOT_INVALID_REQUEST" });
    expect(await fs.readdir(runtimeDirectory)).toEqual([]);
  });

  it("refuses when the runtime directory cannot hold a destination", async () => {
    expect(
      await createWorkspaceSnapshot(
        { root, approvedRoot: approvedRootOf(root) },
        options({ runtimeDirectory: path.join(runtimeDirectory, "missing") }),
      ),
    ).toEqual({ ok: false, code: "SNAPSHOT_DESTINATION_INVALID" });
  });

  it("refuses an interpreter or helper that fails its own attestation, and leaves nothing behind", async () => {
    const request = { root, approvedRoot: approvedRootOf(root) };
    const untrusted = { ok: false, code: "SNAPSHOT_HELPER_UNTRUSTED" };
    expect(
      await createWorkspaceSnapshot(
        request,
        options({
          attestInterpreter: async () => {
            throw new Error("no reviewed interpreter");
          },
        }),
      ),
    ).toEqual(untrusted);
    expect(
      await createWorkspaceSnapshot(
        request,
        options({ attestInterpreter: async () => "python3" }),
      ),
    ).toEqual(untrusted);
    expect(
      await createWorkspaceSnapshot(
        request,
        options({
          helper: { ...SAFE_OPEN_HELPER, sha256: "0".repeat(64) },
        }),
      ),
    ).toEqual(untrusted);
    expect(
      await createWorkspaceSnapshot(
        request,
        options({
          helper: {
            ...SAFE_OPEN_HELPER,
            size: SAFE_OPEN_HELPER.size + 1,
          },
        }),
      ),
    ).toEqual(untrusted);
    expect(
      await createWorkspaceSnapshot(
        request,
        options({ helperPath: path.join(fixturesDirectory, "missing.py") }),
      ),
    ).toEqual(untrusted);
    expect(await fs.readdir(runtimeDirectory)).toEqual([]);
  });

  it("maps a helper refusal exit status onto its code, and an unknown status onto the generic failure", async () => {
    const request = { root, approvedRoot: approvedRootOf(root) };
    for (const [status, code] of [
      [38, "SNAPSHOT_CLONE_UNSUPPORTED"],
      [39, "SNAPSHOT_INDEX_CHANGED"],
      [40, "SNAPSHOT_ALTERNATES_UNSUPPORTED"],
      [21, "SNAPSHOT_NOT_FOUND"],
      [25, "SNAPSHOT_RACE_DETECTED"],
      [99, "SNAPSHOT_HELPER_FAILED"],
    ] as const) {
      const interpreter = await fakeInterpreter(
        `exit-${status}`,
        Buffer.alloc(0),
        status,
      );
      expect(
        await createWorkspaceSnapshot(
          request,
          options({ attestInterpreter: async () => interpreter }),
        ),
        String(status),
      ).toEqual({ ok: false, code });
    }
    expect(await fs.readdir(runtimeDirectory)).toEqual([]);
  });

  it("refuses a helper response it cannot trust: no frame, a wrong length, stderr noise, an oversize payload or a malformed record", async () => {
    const request = { root, approvedRoot: approvedRootOf(root) };
    const responses: ReadonlyArray<readonly [string, Buffer, string?]> = [
      ["no-frame", Buffer.from("hello", "ascii")],
      ["wrong-length", framed(wellFormed, 100)],
      ["stderr-noise", framed(wellFormed), "helper-noise"],
      [
        "oversize",
        Buffer.concat([framed("", 5_000), Buffer.alloc(5_000, 0x78)]),
      ],
      ["not-json", framed("{not json")],
      ["not-an-object", framed("[1]")],
      ["missing-fields", framed('{"bytes":1,"entries":2}')],
      [
        "bad-digest",
        framed(
          '{"bytes":1,"clonedBytes":2,"entries":3,"indexSha256":"zz","skipped":0}',
        ),
      ],
      [
        "negative-count",
        framed(
          '{"bytes":1,"clonedBytes":2,"entries":-3,"indexSha256":null,"skipped":0}',
        ),
      ],
    ];
    for (const [name, response, stderr] of responses) {
      const interpreter = await fakeInterpreter(
        name,
        response,
        0,
        stderr ?? "",
      );
      expect(
        await createWorkspaceSnapshot(
          request,
          options({ attestInterpreter: async () => interpreter }),
        ),
        name,
      ).toEqual({ ok: false, code: "SNAPSHOT_HELPER_FAILED" });
    }
    // The same frame with a well-formed record is accepted: the refusals
    // above are about the shape, not the stand-in.
    const accepted = await fakeInterpreter("accepted", framed(wellFormed));
    const outcome = await createWorkspaceSnapshot(
      request,
      options({ attestInterpreter: async () => accepted }),
    );
    expect(outcome).toMatchObject({
      ok: true,
      bytes: 1,
      clonedBytes: 2,
      entries: 3,
      indexSha256: null,
      skipped: 0,
    });
    if (outcome.ok) {
      await outcome.remove();
      // Idempotent: a second removal is a no-op, not an error.
      await outcome.remove();
    }
    expect(await fs.readdir(runtimeDirectory)).toEqual([]);
  });

  it("fails closed when the test-hook seam itself breaks", async () => {
    await initRepo(root);
    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root) },
      options(),
      {
        testHookRequest: { phase: "before-snapshot-walk", index: null },
        testHook: async () => {
          throw new Error("hook failed");
        },
      },
    );
    expect(outcome).toEqual({ ok: false, code: "SNAPSHOT_HELPER_FAILED" });
    expect(await fs.readdir(runtimeDirectory)).toEqual([]);
  });
});
