import { spawnSync } from "node:child_process";
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
// directly against the real helper, and prove the S35-02 semantics the
// mechanism actually has: a hard link is the source's own inode, not a
// point-in-time copy of its bytes.

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
  it("links a named tracked file, and leaves an untracked file and an excluded subtree out entirely", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "a.txt"), "tracked\n", { mode: 0o600 });
    await fs.mkdir(path.join(root, "secret"), { mode: 0o700 });
    await fs.writeFile(path.join(root, "secret", "tracked.txt"), "hidden\n", {
      mode: 0o600,
    });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    await fs.writeFile(path.join(root, "b.txt"), "untracked\n", { mode: 0o600 });
    await fs.writeFile(path.join(root, "secret", "other.txt"), "also-hidden\n", {
      mode: 0o600,
    });

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
      expect((await fs.stat(path.join(outcome.path, ".git"))).isDirectory()).toBe(
        true,
      );
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
      expect((await fs.stat(path.join(outcome.path, ".git"))).isDirectory()).toBe(
        true,
      );
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
  });

  it("refuses a named path whose identity changes between listing and linking", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "original\n", { mode: 0o600 });

    const outcome = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root), paths: ["a.txt"] },
      options(),
      {
        testHookRequest: { phase: "snapshot-link-path-entry", index: 0 },
        testHook: async () => {
          // Between the listing this walk already took and the `linkat`
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

  it("charges a hard-linked file's own size against the byte bound, not only bytes it copies", async () => {
    await initRepo(root);
    const large = Buffer.alloc(64 * 1024, "x");
    await fs.writeFile(path.join(root, "big.bin"), large, { mode: 0o600 });

    const bounded = await createWorkspaceSnapshot(
      {
        root,
        approvedRoot: approvedRootOf(root),
        paths: ["big.bin"],
        maxBytes: large.length - 1,
      },
      options(),
    );
    expect(bounded).toEqual({ ok: false, code: "SNAPSHOT_TOO_LARGE" });

    // The same file, linked by the whole-tree walk instead of a named path,
    // is charged the same way: the byte bound is not something the bounded
    // mode alone enforces.
    const wholeTree = await createWorkspaceSnapshot(
      { root, approvedRoot: approvedRootOf(root), maxBytes: large.length - 1 },
      options(),
    );
    expect(wholeTree).toEqual({ ok: false, code: "SNAPSHOT_TOO_LARGE" });

    // Generous enough to cover a fresh `.git`'s own overhead (hook samples,
    // refs, etc. -- around 80 KiB on this Git) plus the linked file itself,
    // without depending on an exact figure that varies by Git version.
    const fits = await createWorkspaceSnapshot(
      {
        root,
        approvedRoot: approvedRootOf(root),
        paths: ["big.bin"],
        maxBytes: large.length + 500_000,
      },
      options(),
    );
    expect(fits.ok).toBe(true);
    if (fits.ok) await fits.remove();
  });

  // S35-02 (1): a hard link resolves to the source's *inode*, not a
  // point-in-time copy of its bytes. This is not an incidental detail: it is
  // the semantics the product's own wording must match, proven here rather
  // than assumed.
  it("exposes a write made in place, through a descriptor opened before the snapshot, through the link", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "a.txt"), "AAAAA-----\n", { mode: 0o600 });
    const handle = await fs.open(path.join(root, "a.txt"), "r+");
    try {
      const outcome = await createWorkspaceSnapshot(
        { root, approvedRoot: approvedRootOf(root), paths: ["a.txt"] },
        options(),
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      try {
        // Not a rename, not a new open by name: the same descriptor opened
        // before the snapshot writes into the file already linked in.
        await handle.write(Buffer.from("BBBBB"), 0, 5, 0);
        expect(await fs.readFile(path.join(outcome.path, "a.txt"), "utf8")).toBe(
          "BBBBB-----\n",
        );
      } finally {
        await outcome.remove();
      }
    } finally {
      await handle.close();
    }
  });

  // S35-02 (2): a write through the snapshot path is not stopped by the
  // filesystem -- the same inode is writable from either name, because a
  // hard link shares one set of bytes and one set of permission bits.
  // Disclosed rather than assumed: the actual command flow (git.status /
  // git.head) never issues such a write -- it only rewrites the *copied*
  // `.git/index` -- so this gap is closed today by what the two fixed
  // commands do, not by the filesystem or (currently) by the Seatbelt
  // profile's write grant, which still spans the whole snapshot subtree.
  it("DISCLOSED: a write through the snapshot path is neither impossible nor confined by the filesystem", async () => {
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
      await fs.writeFile(path.join(outcome.path, "a.txt"), "SENTINEL-MUTATION\n", {
        mode: 0o600,
      });
      expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe(
        "SENTINEL-MUTATION\n",
      );
    } finally {
      await outcome.remove();
    }
  });

  // S35-02 (2), the actual command flow: a real `git status`/`git rev-parse
  // HEAD` run over a bounded snapshot, plus its cleanup, never changes a
  // source file's bytes or mode -- because both commands only ever rewrite
  // the snapshot's own *copied* `.git/index`, never a linked working-tree
  // file.
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
    await fs.writeFile(path.join(root, "build", "kept.txt"), "tracked-anyway\n", {
      mode: 0o600,
    });
    await fs.writeFile(path.join(root, ".gitignore"), "build/\n", { mode: 0o600 });
    git(root, "add", "-A", "-f", "build/kept.txt", ".gitignore");
    git(root, "commit", "-q", "-m", "init");
    await fs.writeFile(path.join(root, "build", "kept.txt"), "changed\n", {
      mode: 0o600,
    });
    await fs.writeFile(path.join(root, "untracked.txt"), "new\n", { mode: 0o600 });

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
