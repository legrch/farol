// Shared E2E admission only. Production verifiers own source, entry and core
// attestation; this does not build, launch, or qualify a native/product journey.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import {
  BUILD_ENTRIES,
  verifyBuildEntries,
  verifyInputManifest,
} from "../../tooling/build-contract.mjs";
import {
  GO_CORE_ENTRIES,
  verifyGoCoreArtifact,
} from "../../tooling/go-core-artifact.mjs";

export async function qualifyGoBuild(
  buildRoot,
  source,
  ports = {
    readFile: fs.readFile,
    verifyBuildEntries,
    verifyInputManifest,
    verifyGoCoreArtifact,
  },
) {
  assert.equal(source.dirty, false, "E2E_SOURCE_NOT_EXACT");
  const bytes = await ports.readFile(
    path.join(buildRoot, "build-manifest.json"),
  );
  const manifest = JSON.parse(bytes.toString("utf8"));
  assert.equal(manifest.schema, 4, "E2E_GO_BUILD_REQUIRED");
  assert.equal(manifest.sourceMode, "head-exact", "E2E_BUILD_SOURCE_MODE");
  assert.equal(manifest.dirty, false, "E2E_BUILD_DIRTY");
  assert.equal(manifest.inputExact, true, "E2E_BUILD_INPUTS_NOT_EXACT");
  assert.equal(manifest.sourceCommit, source.commit, "E2E_BUILD_COMMIT");
  assert.equal(manifest.sourceTreeDigest, source.treeDigest, "E2E_BUILD_TREE");
  const entries = [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort();
  assert.deepEqual(manifest.entries, entries, "E2E_GO_BUILD_ENTRIES");
  const identity = assertBuildIdentity(
    JSON.parse(
      await ports.readFile(path.join(buildRoot, "build-identity.json"), "utf8"),
    ),
  );
  assert.equal(identity.sourceDirty, false, "E2E_IDENTITY_DIRTY");
  assert.equal(identity.sourceCommit, source.commit, "E2E_IDENTITY_COMMIT");
  assert.equal(
    identity.sourceTreeDigest,
    source.treeDigest,
    "E2E_IDENTITY_TREE",
  );
  assert.equal(identity.buildId, manifest.buildId, "E2E_BUILD_ID");
  await ports.verifyInputManifest(buildRoot, manifest);
  await ports.verifyBuildEntries(buildRoot, manifest.entrySha256, entries);
  await ports.verifyGoCoreArtifact(buildRoot, manifest.core, identity);
  return {
    manifest,
    identity,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
