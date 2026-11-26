import type { BigIntStats } from "node:fs";
import path from "node:path";

export function sameOwnedFile(
  current: BigIntStats,
  issued: BigIntStats,
  privateMode = true,
): boolean {
  return (
    current.isFile() &&
    issued.isFile() &&
    current.nlink === 1n &&
    current.uid === BigInt(process.getuid!()) &&
    (!privateMode || (current.mode & 0o077n) === 0n) &&
    current.dev === issued.dev &&
    current.ino === issued.ino &&
    current.size === issued.size &&
    current.mode === issued.mode &&
    current.mtimeNs === issued.mtimeNs &&
    current.ctimeNs === issued.ctimeNs
  );
}

export function stagedName(handle: string): boolean {
  return /^[a-f0-9-]{36}\.zip$/u.test(path.basename(handle));
}

export function retainedHandle(handle: string, directory: string): boolean {
  return (
    path.isAbsolute(handle) &&
    path.normalize(handle) === handle &&
    path.dirname(handle) === directory &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.zip$/u.test(
      path.basename(handle),
    )
  );
}
