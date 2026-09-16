import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import {
  BuildIdentitySchema,
  canonicalBuildIdentityPayload,
  type BuildIdentity,
} from "../../pkg/build-info/identity";

const MAX_BUILD_IDENTITY_BYTES = 16 * 1024;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

export function readRuntimeBuildIdentity(directory: string): BuildIdentity {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path.join(directory, "build-identity.json"),
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | CLOSE_ON_EXEC,
    );
    const info = fstatSync(descriptor);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > MAX_BUILD_IDENTITY_BYTES
    ) {
      throw new Error("invalid build identity type");
    }
    const parsed = BuildIdentitySchema.parse(
      JSON.parse(readFileSync(descriptor, "utf8")) as unknown,
    );
    const expected = createHash("sha256")
      .update(canonicalBuildIdentityPayload(parsed))
      .digest("hex");
    if (parsed.buildId !== expected) throw new Error("BUILD_ID_MISMATCH");
    return parsed;
  } catch {
    throw new Error("RUNTIME_BUILD_IDENTITY_INVALID");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
