import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCanonicalArtifactPath,
  assertExactSourceIdentity,
  candidatePaths,
} from "../../tooling/candidate-contract.mjs";

const root = "/tmp/farol-next-candidate";
const exactIdentity = {
  commit: "a".repeat(40),
  treeDigest: "b".repeat(64),
  dirty: false,
};
const exactArtifact = {
  schema: 6,
  artifactPath: path.join(root, "_output/package/Farol.app"),
  sourceCommit: exactIdentity.commit,
  sourceTreeDigest: exactIdentity.treeDigest,
  sourceDirty: false,
};

describe("owner preview candidate contract", () => {
  it("pins the manifest and launch to the repository package path", () => {
    expect(candidatePaths(root)).toEqual({
      artifactFile: path.join(root, "_output/package/artifact.json"),
      appPath: path.join(root, "_output/package/Farol.app"),
    });
    expect(() =>
      assertCanonicalArtifactPath(root, exactArtifact),
    ).not.toThrow();
    expect(() =>
      assertCanonicalArtifactPath(root, {
        ...exactArtifact,
        artifactPath: "/tmp/foreign/Farol Next Preview.app",
      }),
    ).toThrow("PACKAGE_ARTIFACT_PATH_INVALID");
    expect(() =>
      assertCanonicalArtifactPath(root, {
        ...exactArtifact,
        artifactPath: "_output/package/Farol Next Preview.app",
      }),
    ).toThrow("PACKAGE_ARTIFACT_PATH_INVALID");
  });

  it.each([
    ["current dirty source", { ...exactIdentity, dirty: true }, exactArtifact],
    [
      "dirty packaged source",
      exactIdentity,
      { ...exactArtifact, sourceDirty: true },
    ],
    [
      "stale commit",
      exactIdentity,
      { ...exactArtifact, sourceCommit: "c".repeat(40) },
    ],
    [
      "stale tree",
      exactIdentity,
      { ...exactArtifact, sourceTreeDigest: "d".repeat(64) },
    ],
  ])("rejects %s before launch or promotion", (_name, current, artifact) => {
    expect(() =>
      assertExactSourceIdentity(
        current,
        artifact,
        "CANDIDATE_SOURCE_NOT_EXACT",
      ),
    ).toThrow("CANDIDATE_SOURCE_NOT_EXACT");
  });

  it("accepts only a clean package matching the current commit and tree", () => {
    expect(() =>
      assertExactSourceIdentity(
        exactIdentity,
        exactArtifact,
        "CANDIDATE_SOURCE_NOT_EXACT",
      ),
    ).not.toThrow();
  });
});
