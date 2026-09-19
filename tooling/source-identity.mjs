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
  let exact = true;
  for (const [relative, entry] of entries) {
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      exact = false;
      continue;
    }
    const target = path.join(repositoryRoot, relative);
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      exact = false;
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      exact = false;
      continue;
    }
    const expected = git(repositoryRoot, ["cat-file", "blob", entry.objectId]);
    const actual = fs.readFileSync(target);
    entry.bytes = expected;
    if (!actual.equals(expected)) exact = false;
  }

  const indexFlags = git(repositoryRoot, ["ls-files", "-v", "-z", "--", scope]);
  for (const record of indexFlags.toString("utf8").split("\0")) {
    if (record && !record.startsWith("H ")) exact = false;
  }

  const status = git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    scope,
  ]);
  const identity = {
    commit,
    treeDigest: createHash("sha256")
      .update("git-ls-tree-v1\0")
      .update(tree)
      .digest("hex"),
    dirty: status.length > 0 || !exact,
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
