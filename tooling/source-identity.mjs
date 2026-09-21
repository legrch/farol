import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// The system Git by absolute path, with a fixed environment: a `git` earlier on
// PATH, or GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* inherited from the caller, must
// not decide which bytes count as the source a build or candidate names.
const GIT = "/usr/bin/git";
const gitEnvironment = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/var/empty",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
});

// Tracked evidence such as a Retina comparison PNG exceeds Node's 1 MiB
// default spawn buffer; the cap is a limit, not an allocation.
const gitMaxBuffer = 256 * 1024 * 1024;

function git(repositoryRoot, arguments_, encoding = null) {
  return execFileSync(GIT, ["-C", repositoryRoot, ...arguments_], {
    encoding,
    env: gitEnvironment,
    maxBuffer: gitMaxBuffer,
  });
}

function parseTree(tree) {
  const entries = new Map();
  for (const record of tree.toString("utf8").split("\0")) {
    if (!record) continue;
    const match = /^(\d+) (blob|commit) ([a-f0-9]+)\t(.+)$/u.exec(record);
    if (!match?.[1] || !match[3] || !match[4]) {
      throw new Error("SOURCE_TREE_RECORD_INVALID");
    }
    entries.set(match[4], { mode: match[1], objectId: match[3] });
  }
  return entries;
}

export function sourceSnapshot(repositoryRoot, scope = "vnext") {
  const commit = git(
    repositoryRoot,
    ["rev-parse", "--verify", "HEAD"],
    "utf8",
  ).trim();
  const tree = git(repositoryRoot, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    commit,
    "--",
    scope,
  ]);
  if (tree.length === 0) throw new Error("SOURCE_TREE_EMPTY");

  const entries = parseTree(tree);
  // Six separate conditions used to collapse into one unnamed `exact = false`,
  // so `dirty: true` with a clean `git status` told the caller nothing about
  // which file or why. Worse, a read that FAILED was folded into the same
  // answer as a file that genuinely differed: an unreadable path was reported
  // as a modification. A failure is not a difference, and it is refused here
  // with the file named rather than folded into the verdict.
  const reasons = [];
  const unreadable = (relative, detail) => {
    throw new Error(`SOURCE_IDENTITY_UNREADABLE:${relative}:${detail}`);
  };
  for (const [relative, entry] of entries) {
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      reasons.push({ kind: "mode", path: relative, detail: entry.mode });
      continue;
    }
    const target = path.join(repositoryRoot, relative);
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      unreadable(relative, `lstat ${error?.code ?? "failed"}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      reasons.push({ kind: "not-a-regular-file", path: relative });
      continue;
    }
    let expected;
    try {
      expected = git(repositoryRoot, ["cat-file", "blob", entry.objectId]);
    } catch (error) {
      // A spawn that fails, is killed, or overflows its buffer throws rather
      // than returning short bytes. Naming the object is what makes the next
      // occurrence diagnosable instead of a bare stack trace.
      unreadable(
        relative,
        `git cat-file ${entry.objectId}: ${error?.code ?? error?.message ?? "failed"}`,
      );
    }
    let actual;
    try {
      actual = fs.readFileSync(target);
    } catch (error) {
      unreadable(relative, `read ${error?.code ?? "failed"}`);
    }
    entry.bytes = expected;
    if (!actual.equals(expected)) {
      reasons.push({
        kind: "content",
        path: relative,
        detail: `expected ${expected.length}B, found ${actual.length}B`,
      });
    }
  }

  // `git status` does not report a path marked assume-unchanged (`h`) or
  // skip-worktree (`S`), but `ls-files -v` does. That pairing is exactly how a
  // clean status and a dirty verdict can both be true, so the flag is named.
  const indexFlags = git(repositoryRoot, ["ls-files", "-v", "-z", "--", scope]);
  for (const record of indexFlags.toString("utf8").split("\0")) {
    if (record && !record.startsWith("H ")) {
      reasons.push({
        kind: "index-flag",
        path: record.slice(2),
        detail: record.slice(0, 1),
      });
    }
  }

  const status = git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    scope,
  ]);
  for (const record of status.toString("utf8").split("\0")) {
    if (!record) continue;
    reasons.push({
      kind: "status",
      path: record.slice(3),
      detail: record.slice(0, 2),
    });
  }
  const identity = {
    commit,
    treeDigest: createHash("sha256")
      .update("git-ls-tree-v1\0")
      .update(tree)
      .digest("hex"),
    dirty: reasons.length > 0,
    // Every dirty verdict now carries why, and a clean one carries nothing.
    reasons,
  };
  return { ...identity, entries };
}

export function sourceIdentity(repositoryRoot, scope = "vnext") {
  const { entries: _entries, ...identity } = sourceSnapshot(
    repositoryRoot,
    scope,
  );
  return identity;
}
