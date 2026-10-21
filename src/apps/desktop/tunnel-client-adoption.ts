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
 * The destination is trusted only when nobody else can change it: the home
 * directory and every directory below it on the way to the copy must be a real
 * directory (never a symlink), owned by this user and not group- or
 * world-writable. A missing directory is created one level at a time, private
 * (0700), and checked again. Otherwise another account could replace the copy
 * between its verification and its use.
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

function privateDirectory(
  info: Readonly<{
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    uid: number;
    mode: number;
  }>,
): boolean {
  const effectiveUser = process.geteuid?.();
  return (
    !info.isSymbolicLink() &&
    info.isDirectory() &&
    (effectiveUser === undefined || info.uid === effectiveUser) &&
    (info.mode & 0o022) === 0
  );
}

// Walks from home to `directory`, creating what is missing, and accepts the
// path only when every component is a private directory of this user.
async function secureDirectory(
  home: string,
  directory: string,
): Promise<DirectoryOutcome> {
  const relative = path.relative(home, directory);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    return "unsafe";
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
    if (!privateDirectory(info)) return "unsafe";
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
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
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
  const target = reviewedTunnelClientPath(
    dependencies.home,
    dependencies.arch,
    dependencies.reviewedDigests,
  );
  if (!target) return { ok: false, reason: "unsupported-architecture" };
  const expected = target.digest;

  let source;
  try {
    source = await fsPromises.open(
      sourcePath,
      fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
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
    const secured = await secureDirectory(dependencies.home, directory);
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
