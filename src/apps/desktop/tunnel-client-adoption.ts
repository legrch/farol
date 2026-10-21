import { execFile } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

import {
  reviewedTunnelClientPath,
  type ReviewedTunnelClientDigests,
} from "./executable-discovery";

/**
 * Adopts a reviewed tunnel-client build that discovery found but had to refuse
 * because another macOS user owns it (the common case: Homebrew installed by
 * the Mac's first account, Farol run from a second one). Running a binary that
 * another user can replace is unsafe, so the bytes are copied into this user's
 * own reviewed build directory instead, and the copy is accepted only when its
 * SHA-256 and size equal the pinned reviewed build for this architecture.
 *
 * The source is only read, never executed or modified. Whatever the other user
 * does to the source during the copy, the result is either exactly the
 * reviewed build, owned by this user and not group/world-writable, or nothing:
 * a mismatching or partial copy is removed and never renamed into place.
 *
 * The destination is trusted only when nobody but root and this user can
 * change any part of its path (the rule ssh's StrictModes applies). The home
 * directory is first resolved to its real path; then every directory from `/`
 * down to the copy, and the copy itself, must be a real entry (never a
 * symlink) with no group or world write bit and no ACL entry that allows anyone
 * a change. The ancestors of home may belong to root or this user; home and
 * everything below it must belong to this user. A deny-only ACL (macOS homes
 * carry "everyone deny delete") is fine. A missing directory is created one
 * level at a time, private (0700), and checked again. Otherwise another
 * account could redirect or replace the copy between its verification and its
 * use.
 */

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

export type TunnelClientAdoption =
  | Readonly<{ ok: true; path: string; sha256: string }>
  | Readonly<{
      ok: false;
      reason:
        | "unsupported-architecture"
        | "source-unreadable"
        | "source-not-a-regular-file"
        | "source-not-reviewed"
        | "destination-unsafe"
        | "write-failed";
    }>;

export type TunnelClientAdoptionDependencies = Readonly<{
  home: string;
  arch: string;
  reviewedDigests: ReviewedTunnelClientDigests;
}>;

type DirectoryOutcome = "safe" | "unsafe" | "failed";

// ACL permissions that let a principal change a directory or file.
const ACL_CHANGE = new Set([
  "write",
  "append",
  "add_file",
  "add_subdirectory",
  "delete_child",
  "delete",
  "writeattr",
  "writeextattr",
  "writesecurity",
  "chown",
]);
const ACL_ENTRY =
  /^ *\d+: (?:\S+:)?\S+ (?:inherited )?(allow|deny) ([a-z_,]+)$/u;

// `ls -lde` prints the mode line, then one line per ACL entry. Any entry that
// allows a change, or any line that does not parse, is unsafe.
export function aclVerdict(listing: string): "safe" | "unsafe" {
  const lines = listing.split("\n").filter((line) => line !== "");
  for (const line of lines.slice(1)) {
    const entry = ACL_ENTRY.exec(line);
    if (entry === null) return "unsafe";
    if (
      entry[1] === "allow" &&
      (entry[2] ?? "").split(",").some((right) => ACL_CHANGE.has(right))
    )
      return "unsafe";
  }
  return lines.length === 0 ? "unsafe" : "safe";
}

async function aclOutcome(entryPath: string): Promise<DirectoryOutcome> {
  try {
    const listing = await new Promise<string>((resolve, reject) => {
      execFile(
        "/bin/ls",
        ["-lde", entryPath],
        { timeout: 5_000, maxBuffer: 64 * 1_024, encoding: "utf8" },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    return aclVerdict(listing);
  } catch {
    return "failed";
  }
}

function protectedDirectory(
  info: Readonly<{
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    uid: number;
    mode: number;
  }>,
  rootMayOwn: boolean,
): boolean {
  const effectiveUser = process.geteuid?.();
  return (
    !info.isSymbolicLink() &&
    info.isDirectory() &&
    (effectiveUser === undefined ||
      info.uid === effectiveUser ||
      (rootMayOwn && info.uid === 0)) &&
    (info.mode & 0o022) === 0
  );
}

async function protectedEntry(
  entryPath: string,
  rootMayOwn: boolean,
): Promise<DirectoryOutcome> {
  let info;
  try {
    info = await fsPromises.lstat(entryPath);
  } catch {
    return "failed";
  }
  if (!protectedDirectory(info, rootMayOwn)) return "unsafe";
  return aclOutcome(entryPath);
}

// Checks every ancestor of the canonical home from `/`, then walks from home to
// `directory`, creating what is missing; every component must be protected.
async function secureDirectory(
  home: string,
  directory: string,
): Promise<DirectoryOutcome> {
  const relative = path.relative(home, directory);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    return "unsafe";
  const ancestors: string[] = [];
  for (let current = path.dirname(home); ; current = path.dirname(current)) {
    ancestors.unshift(current);
    if (current === path.dirname(current)) break;
  }
  for (const ancestor of ancestors) {
    const outcome = await protectedEntry(ancestor, true);
    if (outcome !== "safe") return outcome;
  }
  let current = home;
  for (const component of ["", ...relative.split(path.sep)]) {
    if (component !== "") current = path.join(current, component);
    let info;
    try {
      info = await fsPromises.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "failed";
      try {
        await fsPromises.mkdir(current, { mode: 0o700 });
        info = await fsPromises.lstat(current);
      } catch {
        return "failed";
      }
    }
    if (!protectedDirectory(info, false)) return "unsafe";
    const acl = await aclOutcome(current);
    if (acl !== "safe") return acl;
  }
  return "safe";
}

type OpenFile = Awaited<ReturnType<typeof fsPromises.open>>;

// Copies at most `limit + 1` bytes (a longer source is not the reviewed build),
// writing each chunk completely, then reads the written file back from the
// start and returns the size and SHA-256 of what is actually on disk.
async function copyThenReadBack(
  source: OpenFile,
  output: OpenFile,
  limit: number,
): Promise<Readonly<{ bytes: number; sha256: string }>> {
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  let position = 0;
  while (position <= limit) {
    // Read no further than one byte past the reviewed size.
    const want = Math.min(buffer.length, limit + 1 - position);
    const { bytesRead } = await source.read(buffer, 0, want, position);
    if (bytesRead === 0) break;
    let offset = 0;
    while (offset < bytesRead) {
      const { bytesWritten } = await output.write(
        buffer,
        offset,
        bytesRead - offset,
        position + offset,
      );
      if (bytesWritten === 0) throw new Error("TUNNEL_CLIENT_COPY_STALLED");
      offset += bytesWritten;
    }
    position += bytesRead;
  }
  await output.sync();
  const digest = createHash("sha256");
  let bytes = 0;
  for (;;) {
    const { bytesRead } = await output.read(buffer, 0, buffer.length, bytes);
    if (bytesRead === 0) break;
    digest.update(buffer.subarray(0, bytesRead));
    bytes += bytesRead;
  }
  return { bytes, sha256: digest.digest("hex") };
}

export async function adoptReviewedTunnelClient(
  sourcePath: string,
  dependencies: TunnelClientAdoptionDependencies,
): Promise<TunnelClientAdoption> {
  // Every later check and write uses the real path of home, never a symlink.
  let home;
  try {
    home = await fsPromises.realpath(dependencies.home);
  } catch {
    return { ok: false, reason: "destination-unsafe" };
  }
  const target = reviewedTunnelClientPath(
    home,
    dependencies.arch,
    dependencies.reviewedDigests,
  );
  if (!target) return { ok: false, reason: "unsupported-architecture" };
  const expected = target.digest;

  let source;
  try {
    // O_NONBLOCK: the source belongs to another account and may have been
    // replaced by a FIFO, whose open must not wait for a writer; anything that
    // is not a regular file is refused right after the open.
    source = await fsPromises.open(
      sourcePath,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | NO_FOLLOW | CLOSE_ON_EXEC,
    );
  } catch {
    return { ok: false, reason: "source-unreadable" };
  }
  const directory = path.dirname(target.path);
  const partial = path.join(
    directory,
    `.tunnel-client.partial-${randomBytes(8).toString("hex")}`,
  );
  let written = false;
  try {
    const info = await source.stat();
    if (!info.isFile())
      return { ok: false, reason: "source-not-a-regular-file" };
    if (info.size !== expected.bytes)
      return { ok: false, reason: "source-not-reviewed" };
    const secured = await secureDirectory(home, directory);
    if (secured === "unsafe")
      return { ok: false, reason: "destination-unsafe" };
    if (secured === "failed") return { ok: false, reason: "write-failed" };
    let output;
    try {
      output = await fsPromises.open(
        partial,
        fsConstants.O_RDWR |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          NO_FOLLOW |
          CLOSE_ON_EXEC,
        0o700,
      );
    } catch {
      return { ok: false, reason: "write-failed" };
    }
    written = true;
    let copied;
    try {
      copied = await copyThenReadBack(source, output, expected.bytes);
    } finally {
      await output.close();
    }
    // The decision is made on the bytes read back from the written file, not
    // on what was read from the source or what each write reported.
    if (copied.bytes !== expected.bytes || copied.sha256 !== expected.sha256)
      return { ok: false, reason: "source-not-reviewed" };
    try {
      await fsPromises.chmod(partial, 0o755);
      // The copy may have inherited an ACL; it must allow nobody a change.
      const acl = await aclOutcome(partial);
      if (acl === "unsafe") return { ok: false, reason: "destination-unsafe" };
      if (acl === "failed") return { ok: false, reason: "write-failed" };
      await fsPromises.rename(partial, target.path);
    } catch {
      return { ok: false, reason: "write-failed" };
    }
    written = false;
    return { ok: true, path: target.path, sha256: expected.sha256 };
  } catch {
    return { ok: false, reason: "source-unreadable" };
  } finally {
    await source.close();
    if (written) await fsPromises.rm(partial, { force: true }).catch(() => {});
  }
}
