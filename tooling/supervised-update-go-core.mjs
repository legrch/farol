import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertBuildIdentity } from "./build-identity-contract.mjs";
import { assertGoCoreDeclaration } from "./go-core-artifact.mjs";

const MAX_BYTES = 256 * 1024;
const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const SHARED_CLAIMS = Object.freeze(["version", "buildVersion", "buildId"]);

function requireValue(condition) {
  if (!condition) throw new Error("UPDATE_HELPER_GO_CORE_REQUIRED");
}

async function readJson(file) {
  const handle = await fs.open(file, READ_FLAGS);
  try {
    const before = await handle.stat({ bigint: true });
    requireValue(
      before.isFile() &&
        before.nlink === 1n &&
        before.uid === BigInt(process.geteuid()) &&
        (before.mode & 0o022n) === 0n &&
        before.size > 0n &&
        before.size <= BigInt(MAX_BYTES),
    );
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const part = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (part.bytesRead === 0) break;
      offset += part.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    requireValue(
      offset === Number(before.size) &&
        ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].every(
          (key) => before[key] === after[key],
        ),
    );
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } finally {
    await handle.close();
  }
}

/**
 * The supervised controller runs the accepted TARGET package's Go release
 * helper. Its compiled declaration and build identity are the package's own
 * `build-manifest.json` core entry and `build-identity.json`, which the
 * caller's captured resources already verified byte for byte (tree digest and
 * the full package verifier) and re-verify before every use. They are not
 * adopted as provenance here: the claimed identity must equal the exact build
 * the owner selected, and the runtime still measures the executable against
 * this declaration before each launch.
 *
 * A package without a compiled core cannot run a helper and refuses before
 * the predecessor is asked to quit. There is no Python alternative.
 */
export async function readSupervisedGoCore({ appPath, expected }) {
  requireValue(path.isAbsolute(appPath) && path.resolve(appPath) === appPath);
  const resources = path.join(appPath, "Contents/Resources/app");
  const manifest = await readJson(path.join(resources, "build-manifest.json"));
  requireValue(
    manifest !== null &&
      typeof manifest === "object" &&
      !Array.isArray(manifest) &&
      manifest.schema === 4 &&
      manifest.core !== null &&
      typeof manifest.core === "object",
  );
  const identity = assertBuildIdentity(
    await readJson(path.join(resources, "build-identity.json")),
  );
  requireValue(
    SHARED_CLAIMS.every((key) => identity[key] === expected[key]) &&
      identity.sourceCommit === expected.sourceCommit &&
      identity.sourceTreeDigest === expected.sourceTreeDigest &&
      identity.sourceDirty === false,
  );
  const declaration = assertGoCoreDeclaration(manifest.core, identity);
  return Object.freeze({ goCoreArtifact: declaration, goCoreBuild: identity });
}
