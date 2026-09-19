import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NEXT_SAFE_OPEN_HELPER } from "../../src/modules/computer/infra/native/native-readonly-workspace";
import {
  createWorkspaceSnapshot,
  type WorkspaceSnapshotOptions,
} from "../../src/modules/computer/infra/native/workspace-snapshot";
import { approvedRootOf } from "../fixtures/root-identity";

const nextRoot = path.resolve(import.meta.dirname, "../..");
const sourceHelper = path.join(nextRoot, "resources/native/safe_open.py");

let root = "";
let runtimeDirectory = "";

function options(overrides: Partial<WorkspaceSnapshotOptions> = {}): WorkspaceSnapshotOptions {
  return {
    helperPath: sourceHelper,
    helper: NEXT_SAFE_OPEN_HELPER,
    attestInterpreter: async () => "/usr/bin/python3",
    runtimeDirectory,
    ...overrides,
  };
}

function git(cwd: string, ...args: string[]): Readonly<{ status: number | null; stdout: string; stderr: string }> {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-snapshot-src-")),
  );
  await fs.chmod(root, 0o700);
  runtimeDirectory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-snapshot-runtime-")),
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
    await fs.writeFile(path.join(root, "README.md"), "first\n", { mode: 0o600 });
    await fs.mkdir(path.join(root, "src"), { mode: 0o700 });
    await fs.writeFile(path.join(root, "src", "kept.ts"), "export const kept = 1;\n", {
      mode: 0o600,
    });
    await fs.writeFile(path.join(root, "removed.txt"), "gone\n", { mode: 0o600 });
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
          await fs.writeFile(path.join(root, "sentinel.txt"), "ATTACKER-CONTROLLED\n");
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
            path.join(os.tmpdir(), "farol-next-snapshot-outside-"),
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
    await fs.writeFile(path.join(root, "kept.txt"), "stable\n", { mode: 0o600 });
    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root) },
      options(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    try {
      await fs.rm(root, { recursive: true, force: true });
      await fs.mkdir(root, { mode: 0o700 });
      await fs.writeFile(path.join(root, "sentinel.txt"), "ATTACKER-CONTROLLED\n");

      expect(await fs.readFile(path.join(outcome.path, "kept.txt"), "utf8")).toBe(
        "stable\n",
      );
      expect(await grepTree(outcome.path, "ATTACKER-CONTROLLED")).toBe(false);
    } finally {
      await outcome.remove();
    }
  });

  it("refuses a .git file pointing outside the approved tree", async () => {
    const outside = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-snapshot-external-")),
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
      expect(outcome).toEqual({ ok: false, code: "SNAPSHOT_METADATA_UNAPPROVED" });
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
    git(root, "config", "include.path", "/tmp/n02a-malicious-include.gitconfig");
    git(root, "config", "filter.n02a-secrets.clean", "/tmp/n02a-malicious-clean.sh");
    git(root, "config", "core.ignorecase", "true");
    git(root, "config", "core.precomposeunicode", "true");

    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root) },
      options(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    try {
      const config = await fs.readFile(path.join(outcome.path, ".git", "config"), "utf8");
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
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-snapshot-linktarget-")),
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
        expect(await fs.readlink(linkPath)).toBe(path.join(outside, "secret.txt"));
        expect(await grepTree(outcome.path, "OUTSIDE-SENTINEL-CONTENT")).toBe(false);
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

      expect(await fs.readFile(path.join(outcome.path, "value.txt"), "utf8")).toBe(
        "captured\n",
      );
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

  // A hard link across two volumes is impossible: this proves the refusal
  // fires for a real device boundary rather than only when the request says
  // so. A private user-owned RAM disk is the one portable way to get a
  // second real device on a developer Mac without special privileges; if
  // this sandbox cannot create one, the test reports that instead of
  // silently passing.
  it("refuses when the destination volume cannot hold a hard link to the source", async () => {
    let device: string | null = null;
    let mountPoint: string | null = null;
    try {
      device = execFileSync("hdiutil", ["attach", "-nomount", "ram://16384"], {
        encoding: "utf8",
      })
        .trim()
        .split(/\s+/)[0] ?? null;
      if (!device) throw new Error("no ram disk device returned");
      const volumeName = `N02ARAM${process.pid}`;
      execFileSync("diskutil", ["eraseVolume", "HFS+", volumeName, device]);
      mountPoint = `/Volumes/${volumeName}`;
      await fs.access(mountPoint);
    } catch (error) {
      // Environment cannot create a second real device (locked-down CI,
      // missing hdiutil/diskutil, or no permission). The mechanism this test
      // targets is still exercised by the entry/byte bound tests above; this
      // one specific volume-boundary case is reported skipped rather than
      // faked.
      console.warn(
        `workspace-snapshot cross-volume test skipped: ${(error as Error).message}`,
      );
      return;
    }
    try {
      await fs.writeFile(path.join(root, "f.txt"), "x\n", { mode: 0o600 });
      const outcome = await createWorkspaceSnapshot(
        { root, approvedRoot: approvedRootOf(root) },
        options({ runtimeDirectory: mountPoint }),
      );
      expect(outcome).toEqual({ ok: false, code: "SNAPSHOT_CROSS_VOLUME" });
    } finally {
      execFileSync("hdiutil", ["detach", device]);
    }
  });

  it("snapshots a linked worktree's own gitdir and the repository's common gitdir", async () => {
    const primary = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-snapshot-primary-")),
    );
    let worktree = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-snapshot-wt-")),
    );
    await fs.rm(worktree, { recursive: true, force: true });
    try {
      await initRepo(primary);
      await fs.writeFile(path.join(primary, "main.txt"), "main\n", { mode: 0o600 });
      git(primary, "add", "-A");
      git(primary, "commit", "-q", "-m", "init");
      git(primary, "worktree", "add", "-q", worktree, "-b", "n02a-wt-branch");
      await fs.writeFile(path.join(worktree, "wt.txt"), "wt\n", { mode: 0o600 });

      const gitFile = await fs.readFile(path.join(worktree, ".git"), "utf8");
      const gitdirValue = gitFile.slice("gitdir: ".length).trim();
      const commondirValue = (
        await fs.readFile(path.join(gitdirValue, "commondir"), "utf8")
      ).trim();
      const commonDirectory = path.normalize(path.join(gitdirValue, commondirValue));

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
        expect(gitStatus(outcome.path).stdout).toEqual(gitStatus(worktree).stdout);
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
