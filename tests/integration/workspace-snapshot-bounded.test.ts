import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

// N02c -- the bounded path mode (`paths`/`denied`) safe_open.py's
// `workspace-snapshot` verb grew so `native-verification-command.ts` can
// snapshot only `.git` plus the tracked paths a command actually needs,
// instead of the whole approved tree. These tests exercise that mode
// directly against the real helper, and prove the semantics the mechanism
// actually has: a tracked file is attached as an APFS clone made from a
// verified descriptor -- a point-in-time copy of its bytes on an inode of
// its own -- so the owner's file is never linked to, never written through
// the snapshot, and never read through it after the instant of the clone.

const nextRoot = path.resolve(import.meta.dirname, "../..");
const sourceHelper = path.join(nextRoot, "resources/native/safe_open.py");

let root = "";
let runtimeDirectory = "";

function options(
  overrides: Partial<WorkspaceSnapshotOptions> = {},
): WorkspaceSnapshotOptions {
  return {
    helperPath: sourceHelper,
    helper: NEXT_SAFE_OPEN_HELPER,
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

async function initRepo(dir: string): Promise<void> {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "n02c@example.com");
  git(dir, "config", "user.name", "N02c Fixture");
}

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-bounded-src-")),
  );
  await fs.chmod(root, 0o700);
  runtimeDirectory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-bounded-runtime-")),
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(runtimeDirectory, { recursive: true, force: true });
});

describe("workspace snapshot bounded path mode (N02c)", () => {
  it("clones a named tracked file, and leaves an untracked file and an excluded subtree out entirely", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "a.txt"), "tracked\n", { mode: 0o600 });
    await fs.mkdir(path.join(root, "secret"), { mode: 0o700 });
    await fs.writeFile(path.join(root, "secret", "tracked.txt"), "hidden\n", {
      mode: 0o600,
    });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    await fs.writeFile(path.join(root, "b.txt"), "untracked\n", {
      mode: 0o600,
    });
    await fs.writeFile(
      path.join(root, "secret", "other.txt"),
      "also-hidden\n",
      {
        mode: 0o600,
      },
    );

    const outcome = await createWorkspaceSnapshot(
      {
        root,
        approvedRoot: approvedRootOf(root),
        paths: ["a.txt"],
        denied: ["secret"],
      },
      options(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    try {
      expect(await fs.readFile(path.join(outcome.path, "a.txt"), "utf8")).toBe(
        "tracked\n",
      );
      await expect(
        fs.stat(path.join(outcome.path, "b.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.stat(path.join(outcome.path, "secret")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      // `.git` is always present -- Git needs its own metadata regardless of
      // which working-tree paths were requested.
      expect(
        (await fs.stat(path.join(outcome.path, ".git"))).isDirectory(),
      ).toBe(true);
    } finally {
      await outcome.remove();
    }
  });

  it("builds a metadata-only snapshot when `paths` is an empty list", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "a.txt"), "tracked\n", { mode: 0o600 });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");

    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root), paths: [] },
      options(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    try {
      expect(
        (await fs.stat(path.join(outcome.path, ".git"))).isDirectory(),
      ).toBe(true);
      await expect(
        fs.stat(path.join(outcome.path, "a.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      // `ls-files` reads only the index this snapshot already copied -- it
      // needs no working-tree file to be present.
      expect(git(outcome.path, "ls-files").stdout).toBe("a.txt\n");
    } finally {
      await outcome.remove();
    }
  });

  it("refuses a named path that is itself denied, or sits under a denied prefix", async () => {
    await initRepo(root);
    await fs.mkdir(path.join(root, "secret"), { mode: 0o700 });
    await fs.writeFile(path.join(root, "secret", "tracked.txt"), "hidden\n", {
      mode: 0o600,
    });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");

    const outcome = await createWorkspaceSnapshot(
      {
        root,
        approvedRoot: approvedRootOf(root),
        paths: ["secret/tracked.txt"],
        denied: ["secret"],
      },
      options(),
    );
    expect(outcome).toEqual({ ok: false, code: "SNAPSHOT_PATH_REFUSED" });

    // The exclusion is decided before existence: a denied path that is also
    // missing is still a refusal, never a silent skip.
    const missing = await createWorkspaceSnapshot(
      {
        root,
        approvedRoot: approvedRootOf(root),
        paths: ["secret/missing.txt"],
        denied: ["secret"],
      },
      options(),
    );
    expect(missing).toEqual({ ok: false, code: "SNAPSHOT_PATH_REFUSED" });
  });

  it("refuses a named path whose identity changes between listing and cloning", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "original\n", { mode: 0o600 });

    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root), paths: ["a.txt"] },
      options(),
      {
        testHookRequest: { phase: "snapshot-clone-path-entry", index: 0 },
        testHook: async () => {
          // Between the listing this walk already took and the clone
          // below, the very object at this name is swapped for a different
          // one -- a rename away plus a fresh file, not a write in place.
          await fs.rm(path.join(root, "a.txt"));
          await fs.writeFile(path.join(root, "a.txt"), "replaced\n", {
            mode: 0o600,
          });
        },
      },
    );

    expect(outcome).toEqual({ ok: false, code: "SNAPSHOT_ROOT_CHANGED" });
  });

  it("charges a cloned file's size against its own clone budget, never against the copied-byte budget", async () => {
    await initRepo(root);
    const large = Buffer.alloc(64 * 1024, "x");
    await fs.writeFile(path.join(root, "big.bin"), large, { mode: 0o600 });

    const bounded = await createWorkspaceSnapshot(
      {
        root,
        approvedRoot: approvedRootOf(root),
        paths: ["big.bin"],
        maxClonedBytes: large.length - 1,
      },
      options(),
    );
    expect(bounded).toEqual({ ok: false, code: "SNAPSHOT_TOO_LARGE" });

    // The same file, cloned by the whole-tree walk instead of a named path,
    // is charged the same way: the clone budget is not something the bounded
    // mode alone enforces.
    const wholeTree = await createWorkspaceSnapshot(
      {
        root,
        approvedRoot: approvedRootOf(root),
        maxClonedBytes: large.length - 1,
      },
      options(),
    );
    expect(wholeTree).toEqual({ ok: false, code: "SNAPSHOT_TOO_LARGE" });

    // The copied-byte budget sees only what the helper itself writes -- here
    // the rewritten config, since nothing is staged yet -- so a ceiling far
    // below the clone's size still admits it, and the response accounts for
    // the two separately.
    const fits = await createWorkspaceSnapshot(
      {
        root,
        approvedRoot: approvedRootOf(root),
        paths: ["big.bin"],
        maxBytes: large.length - 1,
      },
      options(),
    );
    expect(fits.ok).toBe(true);
    if (!fits.ok) return;
    try {
      // The clone budget also counts the `.git` files cloned alongside (hook
      // samples, refs, objects), so it is at least the file's own size.
      expect(fits.clonedBytes).toBeGreaterThanOrEqual(large.length);
      expect(fits.bytes).toBeGreaterThan(0);
      expect(fits.bytes).toBeLessThan(large.length);
      expect(fits.skipped).toBe(0);
    } finally {
      await fits.remove();
    }
  });

  // A clone is a point-in-time copy of the source's bytes on an inode of its
  // own. This is the semantics the product's own wording rests on, proven
  // here rather than assumed: the owner's file keeps a link count of one
  // while the snapshot exists, and a write made afterwards through a
  // descriptor opened before the snapshot -- the one write a rename-based
  // identity check could never see -- does not reach the snapshot.
  it("keeps the owner's link count at one and never exposes a later in-place write through the snapshot", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "a.txt"), "AAAAA-----\n", {
      mode: 0o600,
    });
    const handle = await fs.open(path.join(root, "a.txt"), "r+");
    try {
      const outcome = await createWorkspaceSnapshot(
        { root, approvedRoot: approvedRootOf(root), paths: ["a.txt"] },
        options(),
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      try {
        const owner = await fs.stat(path.join(root, "a.txt"), { bigint: true });
        const cloned = await fs.stat(path.join(outcome.path, "a.txt"), {
          bigint: true,
        });
        expect(owner.nlink).toBe(1n);
        expect(cloned.nlink).toBe(1n);
        expect(cloned.ino).not.toBe(owner.ino);
        expect(cloned.dev).toBe(owner.dev);
        // Not a rename, not a new open by name: the same descriptor opened
        // before the snapshot writes into the owner's file.
        await handle.write(Buffer.from("BBBBB"), 0, 5, 0);
        expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe(
          "BBBBB-----\n",
        );
        expect(
          await fs.readFile(path.join(outcome.path, "a.txt"), "utf8"),
        ).toBe("AAAAA-----\n");
      } finally {
        await outcome.remove();
      }
    } finally {
      await handle.close();
    }
  });

  // The other direction of the same property: the snapshot's copy is
  // writable (it is the sandboxed command's private file), and writing it
  // changes nothing the owner can see.
  it("never lets a write through the snapshot path reach the owner's file", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "a.txt"), "owner-original\n", {
      mode: 0o600,
    });
    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root), paths: ["a.txt"] },
      options(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    try {
      await fs.writeFile(
        path.join(outcome.path, "a.txt"),
        "SENTINEL-MUTATION\n",
        {
          mode: 0o600,
        },
      );
      expect(await fs.readFile(path.join(outcome.path, "a.txt"), "utf8")).toBe(
        "SENTINEL-MUTATION\n",
      );
      expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe(
        "owner-original\n",
      );
    } finally {
      await outcome.remove();
    }
  });

  it("skips a named path that is missing from the working tree, or present as a directory, and Git then reports it deleted", async () => {
    await initRepo(root);
    for (const name of ["kept.txt", "gone.txt", "dir-now.txt"]) {
      await fs.writeFile(path.join(root, name), `${name}\n`, { mode: 0o600 });
    }
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    await fs.rm(path.join(root, "gone.txt"));
    await fs.rm(path.join(root, "dir-now.txt"));
    await fs.mkdir(path.join(root, "dir-now.txt"), { mode: 0o700 });
    await fs.writeFile(path.join(root, "dir-now.txt", "inner"), "i\n", {
      mode: 0o600,
    });

    const outcome = await createWorkspaceSnapshot(
      {
        root,
        approvedRoot: approvedRootOf(root),
        paths: ["kept.txt", "gone.txt", "dir-now.txt"],
      },
      options(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    try {
      expect(outcome.skipped).toBe(2);
      await expect(
        fs.lstat(path.join(outcome.path, "gone.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.lstat(path.join(outcome.path, "dir-now.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const status = git(
        outcome.path,
        "status",
        "--porcelain",
        "--untracked-files=no",
      );
      expect(status.status).toBe(0);
      expect(status.stdout).toBe(" D dir-now.txt\n D gone.txt\n");
    } finally {
      await outcome.remove();
    }
  });

  it("reports the SHA-256 of the index it copied and refuses a second snapshot pinned to a stale one", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "a.txt"), "a\n", { mode: 0o600 });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    const ownerIndex = createHash("sha256")
      .update(await fs.readFile(path.join(root, ".git", "index")))
      .digest("hex");

    const first = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root), paths: [] },
      options(),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.remove();
    expect(first.indexSha256).toBe(ownerIndex);

    const pinned = await createWorkspaceSnapshot(
      {
        root,
        approvedRoot: approvedRootOf(root),
        paths: ["a.txt"],
        expectedIndexSha256: first.indexSha256,
      },
      options(),
    );
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    await pinned.remove();
    expect(pinned.indexSha256).toBe(ownerIndex);

    await fs.writeFile(path.join(root, "b.txt"), "b\n", { mode: 0o600 });
    git(root, "add", "b.txt");
    const stale = await createWorkspaceSnapshot(
      {
        root,
        approvedRoot: approvedRootOf(root),
        paths: ["a.txt"],
        expectedIndexSha256: first.indexSha256,
      },
      options(),
    );
    expect(stale).toEqual({ ok: false, code: "SNAPSHOT_INDEX_CHANGED" });
    // "No index" is a pin too, and an index that now exists breaks it.
    const pinnedToNone = await createWorkspaceSnapshot(
      {
        root,
        approvedRoot: approvedRootOf(root),
        paths: ["a.txt"],
        expectedIndexSha256: null,
      },
      options(),
    );
    expect(pinnedToNone).toEqual({
      ok: false,
      code: "SNAPSHOT_INDEX_CHANGED",
    });
    // A refused pin leaves nothing behind.
    expect(await fs.readdir(runtimeDirectory)).toEqual([]);
  });

  it("reports a null index digest for a repository without an index, and honours a null pin", async () => {
    await initRepo(root);

    const first = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root), paths: [] },
      options(),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.remove();
    expect(first.indexSha256).toBeNull();

    const pinned = await createWorkspaceSnapshot(
      {
        root,
        approvedRoot: approvedRootOf(root),
        paths: [],
        expectedIndexSha256: null,
      },
      options(),
    );
    expect(pinned.ok).toBe(true);
    if (pinned.ok) await pinned.remove();

    const mismatched = await createWorkspaceSnapshot(
      {
        root,
        approvedRoot: approvedRootOf(root),
        paths: [],
        expectedIndexSha256: "0".repeat(64),
      },
      options(),
    );
    expect(mismatched).toEqual({ ok: false, code: "SNAPSHOT_INDEX_CHANGED" });
  });

  // The actual command flow: a real `git status`/`git rev-parse HEAD` run
  // over a bounded snapshot, plus its cleanup, never changes a source file's
  // bytes or mode -- both commands only ever rewrite the snapshot's own
  // *copied* `.git/index`, and every working-tree file there is a clone.
  it("leaves every source file's bytes and mode unchanged after a real status/head run and cleanup", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "a.txt"), "tracked\n", { mode: 0o640 });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    const before = await fs.stat(path.join(root, "a.txt"));
    const beforeBytes = await fs.readFile(path.join(root, "a.txt"));

    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root), paths: ["a.txt"] },
      options(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const status = spawnSync(
      "git",
      ["-C", outcome.path, "status", "--short", "--branch"],
      { encoding: "utf8" },
    );
    const head = spawnSync(
      "git",
      ["-C", outcome.path, "rev-parse", "--verify", "HEAD"],
      { encoding: "utf8" },
    );
    await outcome.remove();
    expect(status.status).toBe(0);
    expect(head.status).toBe(0);

    const after = await fs.stat(path.join(root, "a.txt"));
    const afterBytes = await fs.readFile(path.join(root, "a.txt"));
    expect(afterBytes.equals(beforeBytes)).toBe(true);
    expect(after.mode).toBe(before.mode);
    expect(after.size).toBe(before.size);
  });

  // S35-02 (5): the bounded mode changes what `git status` can see -- only
  // tracked paths are ever linked -- so a positive control matters as much
  // as the exclusion tests: an untracked file stays invisible, and a tracked
  // file inside an otherwise-ignored directory is still reported, because it
  // was never subject to `.gitignore` in the first place.
  it("still reports a tracked file inside an otherwise-ignored directory, and keeps an untracked file invisible", async () => {
    await initRepo(root);
    await fs.mkdir(path.join(root, "build"), { mode: 0o700 });
    await fs.writeFile(
      path.join(root, "build", "kept.txt"),
      "tracked-anyway\n",
      {
        mode: 0o600,
      },
    );
    await fs.writeFile(path.join(root, ".gitignore"), "build/\n", {
      mode: 0o600,
    });
    git(root, "add", "-A", "-f", "build/kept.txt", ".gitignore");
    git(root, "commit", "-q", "-m", "init");
    await fs.writeFile(path.join(root, "build", "kept.txt"), "changed\n", {
      mode: 0o600,
    });
    await fs.writeFile(path.join(root, "untracked.txt"), "new\n", {
      mode: 0o600,
    });

    const listing = spawnSync("git", ["-C", root, "ls-files"], {
      encoding: "utf8",
    });
    const trackedPaths = listing.stdout.split("\n").filter(Boolean);
    expect(trackedPaths).toContain("build/kept.txt");

    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root), paths: trackedPaths },
      options(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    try {
      const status = spawnSync(
        "git",
        ["-C", outcome.path, "status", "--short", "--untracked-files=no"],
        { encoding: "utf8" },
      );
      expect(status.stdout).toContain("build/kept.txt");
      expect(status.stdout).not.toContain("untracked.txt");
    } finally {
      await outcome.remove();
    }
  });
});
