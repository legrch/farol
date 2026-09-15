import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

function git(repositoryRoot, arguments_, encoding = null) {
  return execFileSync("git", ["-C", repositoryRoot, ...arguments_], {
    encoding,
  });
}

export function sourceIdentity(repositoryRoot, scope = "vnext") {
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

  const status = git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    scope,
  ]);
  return {
    commit,
    treeDigest: createHash("sha256")
      .update("git-ls-tree-v1\0")
      .update(tree)
      .digest("hex"),
    dirty: status.length > 0,
  };
}
