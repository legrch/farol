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
        | "write-failed";
    }>;

export type TunnelClientAdoptionDependencies = Readonly<{
  home: string;
  arch: string;
  reviewedDigests: ReviewedTunnelClientDigests;
}>;

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
    try {
      await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    } catch {
      return { ok: false, reason: "write-failed" };
    }
    let output;
    try {
      output = await fsPromises.open(
        partial,
        fsConstants.O_WRONLY |
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
    const digest = createHash("sha256");
    let total = 0;
    try {
      const buffer = Buffer.allocUnsafe(64 * 1_024);
      for (;;) {
        const { bytesRead } = await source.read(
          buffer,
          0,
          buffer.length,
          total,
        );
        if (bytesRead === 0) break;
        total += bytesRead;
        // Never copy more than the reviewed build: a growing source is not it.
        if (total > expected.bytes) break;
        const chunk = buffer.subarray(0, bytesRead);
        digest.update(chunk);
        await output.write(chunk);
      }
      await output.sync();
    } finally {
      await output.close();
    }
    // The decision is made on the bytes that were written, not on the source.
    if (total !== expected.bytes || digest.digest("hex") !== expected.sha256)
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
