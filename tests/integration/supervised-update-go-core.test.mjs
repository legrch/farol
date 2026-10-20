import { describe, expect, it } from "vitest";
import { createBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import { selectSupervisedGoCore } from "../../tooling/supervised-update-go-core.mjs";

// Pure values only. The resource observation captures the declaration from the
// verified package (see supervised-update-resources.test.mjs); this selector
// only checks it against the owner's selected build.
const identity = createBuildIdentity({
  version: "0.3.0-owner.beta.1",
  updateChannel: "github-owner-beta",
  buildVersion: "18",
  builtAt: "2026-10-20T00:00:00.000Z",
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: "b".repeat(64),
  sourceDirty: false,
});
const expected = {
  version: identity.version,
  buildVersion: identity.buildVersion,
  buildId: identity.buildId,
  sourceCommit: identity.sourceCommit,
  sourceTreeDigest: identity.sourceTreeDigest,
  artifactSha256: "c".repeat(64),
};
const declaration = (changes = {}) => ({
  schema: "farol-core-artifact/1",
  build: {
    buildId: identity.buildId,
    sourceSHA: identity.sourceCommit,
    sourceTreeDigest: identity.sourceTreeDigest,
    platform: { goos: "darwin", goarch: "arm64" },
  },
  binary: { path: "farol-backend", size: 4096, sha256: "d".repeat(64) },
  ...changes,
});
const captured = (changes = {}) => ({
  core: declaration(),
  identity,
  ...changes,
});

describe("supervised target Go declaration", () => {
  it("returns the verified package's own declaration and canonical build", () => {
    const result = selectSupervisedGoCore({ goCore: captured(), expected });
    expect(result.goCoreArtifact).toEqual(declaration());
    expect(result.goCoreBuild).toEqual(identity);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ["a package with no compiled core", null],
    ["a null core", captured({ core: null })],
    ["an array core", captured({ core: [] })],
    ["a non-object capture", "core"],
  ])("requires a compiled core: %s", (_name, goCore) => {
    expect(() => selectSupervisedGoCore({ goCore, expected })).toThrow(
      "UPDATE_HELPER_GO_CORE_REQUIRED",
    );
  });

  it.each([
    ["version", { version: "0.3.0-owner.beta.2" }],
    ["build version", { buildVersion: "19" }],
    ["build id", { buildId: "e".repeat(64) }],
    ["source commit", { sourceCommit: "f".repeat(40) }],
    ["source tree", { sourceTreeDigest: "e".repeat(64) }],
  ])("refuses a build that is not the selected %s", (_name, claim) => {
    expect(() =>
      selectSupervisedGoCore({
        goCore: captured(),
        expected: { ...expected, ...claim },
      }),
    ).toThrow("UPDATE_HELPER_GO_CORE_REQUIRED");
  });

  it("refuses a dirty build identity", () => {
    const dirty = createBuildIdentity({ ...identity, sourceDirty: true });
    expect(() =>
      selectSupervisedGoCore({
        goCore: captured({ identity: dirty }),
        expected: { ...expected, buildId: dirty.buildId },
      }),
    ).toThrow("UPDATE_HELPER_GO_CORE_REQUIRED");
  });

  it("refuses a non-canonical build identity and a declaration for another build", () => {
    expect(() =>
      selectSupervisedGoCore({
        goCore: captured({ identity: { ...identity, builtAt: "yesterday" } }),
        expected,
      }),
    ).toThrow("BUILD_IDENTITY_INVALID");
    expect(() =>
      selectSupervisedGoCore({
        goCore: captured({
          core: declaration({
            build: { ...declaration().build, sourceSHA: "9".repeat(40) },
          }),
        }),
        expected,
      }),
    ).toThrow("GO_CORE_ARTIFACT_INVALID");
  });
});
