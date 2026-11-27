import path from "node:path";

export const REVIEWED_DEVELOPER_ROOTS = Object.freeze([
  "/Applications/Xcode.app/Contents/Developer",
  "/Library/Developer/CommandLineTools",
]);

// N02 -- Git never reads the owner's folder. It reads only the private
// snapshot `createSnapshot` (workspace-snapshot.ts) assembles from
// descriptors Farol already holds, and the sandbox grants read access to
// that snapshot directory alone -- never to the owner's workspace pathname.
// The snapshot mirrors both a primary checkout and a linked worktree (its own
// gitdir and the repository's common gitdir rebuilt inside the same
// destination), so Git needs no path outside it.
//
// N02c -- one command may run over more than one such snapshot. `git.status`
// first snapshots `.git` alone, asks Git itself (inside that snapshot) which
// paths are tracked, and only then builds a second, bounded snapshot that
// carries exactly those paths (minus any the workspace's own exclusions
// cover) before running the fixed status command over it. The second
// snapshot is pinned to the first's index (`expectedIndexSha256`): the two
// describe one instant, or the command refuses. `git.head` never needs a
// second snapshot: `rev-parse` reads refs and objects, never a worktree
// file.
//
// N02d -- reads stay granted across the whole snapshot subtree, but writes
// are granted to exactly the files a plain `git status` may rewrite: the
// index and its lock, in whichever metadata directory the snapshot's layout
// puts them (`.git` for a primary checkout, `.gitmeta/worktree` for a linked
// worktree; the other pair simply does not exist in that snapshot, so naming
// both unconditionally costs nothing). Every working-tree file inside the
// snapshot is an APFS clone on an inode of its own (workspace-snapshot.ts /
// safe_open.py), so no write through the snapshot could reach the owner's
// bytes in any case; the literal grant additionally keeps the fixed command
// from altering its own evidence -- HEAD, refs, objects and config inside
// the snapshot are read-only to it.
export const COMMAND_PROFILE = `(version 1)
(import "dyld-support.sb")
(deny default)
(allow process-exec (literal (param "FAROL_GIT")))
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read*
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/private/etc")
  (literal "/dev/null")
  (literal "/dev/urandom")
  (subpath (param "FAROL_DEVELOPER"))
  (subpath (param "FAROL_EXECUTABLE_DIR"))
  (subpath (param "FAROL_SNAPSHOT")))
(allow file-write*
  (literal (param "FAROL_GIT_INDEX"))
  (literal (param "FAROL_GIT_INDEX_LOCK"))
  (literal (param "FAROL_GIT_META_INDEX"))
  (literal (param "FAROL_GIT_META_INDEX_LOCK"))
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/null")
  (regex #"^/dev/fd/[0-9]+$"))
(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))
(deny network*)`;

// `subpath` grants the snapshot's own subtree, never the chain of ordinary
// directories leading to it (the snapshot lives under Farol's runtime
// directory, itself under the OS temporary root). A linked worktree's `.git`
// file and its `commondir` name that chain by absolute path, and Git
// canonicalises them component by component, so each ancestor directory
// needs its metadata (never its contents) readable. A primary checkout never
// exercises this path -- `.git` is a plain directory at the snapshot's own
// top level -- but the grant costs nothing to always add.
export const MAX_SNAPSHOT_ANCESTORS = 128;

export function snapshotAncestors(snapshotPath: string): readonly string[] {
  const ancestors: string[] = [];
  let current = path.dirname(snapshotPath);
  while (current !== "/") {
    ancestors.push(current);
    current = path.dirname(current);
  }
  return ancestors;
}

export function sandboxDeveloperRoot(git: string): string {
  return (
    REVIEWED_DEVELOPER_ROOTS.find((root) => git.startsWith(`${root}/`)) ??
    "/System"
  );
}

export const HEAD_ARGUMENTS = [
  "rev-parse",
  "--verify",
  "--quiet",
  "HEAD",
] as const satisfies readonly string[];

// The `-c` flags every fixed Git invocation over a snapshot uses, whatever
// command it runs: no config-driven execution path from the owner's
// repository survives the minimal `.git/config` this snapshot already
// carries, but these still remove anything a caller-supplied override on the
// command line could otherwise reintroduce. (`core.quotepath` is moot for the
// `-z` listings this route reads, and is pinned so no other output shape can
// ever appear.)
export const FIXED_GIT_CONFIG_ARGUMENTS = [
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.excludesFile=/dev/null",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.quotepath=true",
  "-c",
  "submodule.recurse=false",
] as const;
