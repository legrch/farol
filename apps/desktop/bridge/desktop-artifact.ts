import fs from "node:fs";
import path from "node:path";
import {
  parseCoreArtifactDeclaration,
  type CoreArtifactDeclaration,
} from "./attested-core.ts";
import { BridgeError } from "./client.ts";
import type { BuildIdentity } from "../../../src/pkg/build-info/identity";

// Identical build/declaration selection for normal and recovery composition.
// Neither observed disk bytes nor wire identity can mint compiled expectations.
export function desktopCoreExpectation(
  selection: Readonly<{
    compiledArtifact: unknown;
    build: BuildIdentity;
  }>,
): CoreArtifactDeclaration {
  const expected = parseCoreArtifactDeclaration(selection.compiledArtifact);
  if (
    selection.build.sourceDirty ||
    expected.build.buildId !== selection.build.buildId ||
    expected.build.sourceSHA !== selection.build.sourceCommit ||
    expected.build.sourceTreeDigest !== selection.build.sourceTreeDigest ||
    expected.build.platform.goos !== process.platform ||
    expected.build.platform.goarch !== process.arch
  )
    throw new BridgeError("refused", "core_host_build_mismatch");
  return expected;
}

export function readDesktopCoreDeclaration(
  root: string,
  expected: CoreArtifactDeclaration,
): CoreArtifactDeclaration {
  const artifact = parseCoreArtifactDeclaration(readDeclaration(root));
  if (JSON.stringify(artifact) !== JSON.stringify(expected))
    throw new BridgeError("refused", "core_host_artifact_mismatch");
  return artifact;
}

function readDeclaration(root: string): unknown {
  const fd = fs.openSync(
    path.join(root, "core-artifact.json"),
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 8192n)
      throw new BridgeError("refused", "invalid_core_artifact");
    const bytes = Buffer.alloc(8193);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd, { bigint: true });
    if (
      BigInt(size) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.nlink !== after.nlink
    )
      throw new BridgeError("refused", "core_artifact_changed");
    return JSON.parse(bytes.subarray(0, size).toString("utf8")) as unknown;
  } finally {
    fs.closeSync(fd);
  }
}
