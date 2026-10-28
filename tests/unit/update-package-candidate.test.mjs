import { describe, expect, it } from "vitest";
import { assertUpdatePackageSource } from "../../tooling/update-package-candidate.mjs";

const commit = "a".repeat(40);
const treeDigest = "b".repeat(64);
const artifact = {
  sourceCommit: commit,
  sourceTreeDigest: treeDigest,
  sourceDirty: false,
};
const source = { commit, treeDigest, dirty: false };

describe("update package source identity", () => {
  it("accepts the exact clean source and artifact", () => {
    expect(() => assertUpdatePackageSource(artifact, source)).not.toThrow();
  });

  it.each([
    [{ ...artifact, sourceCommit: "c".repeat(40) }, source],
    [{ ...artifact, sourceTreeDigest: "c".repeat(64) }, source],
    [{ ...artifact, sourceDirty: true }, source],
    [artifact, { ...source, dirty: true }],
    [{ ...artifact, sourceCommit: "bad" }, source],
    [null, source],
    [artifact, null],
  ])("refuses stale, dirty or invalid evidence", (candidate, checkout) => {
    expect(() => assertUpdatePackageSource(candidate, checkout)).toThrow(
      "UPDATE_PACKAGE_SOURCE_MISMATCH",
    );
  });
});
