import { describe, expect, it } from "vitest";
import {
  assertBuildIdentity,
  createBuildIdentity,
} from "../../tooling/build-identity-contract.mjs";

const input = {
  version: "0.1.0-preview.0",
  builtAt: "2026-09-16T10:00:00.000Z",
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: "b".repeat(64),
  sourceDirty: false,
};

describe("Farol Next build identity", () => {
  it("creates one self-verifying identity for the running build", () => {
    const identity = createBuildIdentity(input);

    expect(identity).toMatchObject({
      schema: 1,
      product: "Farol Next Preview",
      bundleId: "local.farol.next.preview",
      updateChannel: "local-preview-only",
      ...input,
    });
    expect(identity.buildId).toMatch(/^[a-f0-9]{64}$/u);
    expect(assertBuildIdentity(identity)).toEqual(identity);
  });

  it("binds an owner-beta channel and monotonic bundle build to the identity", () => {
    const release = createBuildIdentity({
      ...input,
      version: "0.1.0-owner.beta.1",
      updateChannel: "github-owner-beta",
      buildVersion: "2",
    });
    expect(release.updateChannel).toBe("github-owner-beta");
    expect(release.buildVersion).toBe("2");
    expect(() =>
      assertBuildIdentity({ ...release, buildVersion: "3" }),
    ).toThrow();
    expect(() =>
      assertBuildIdentity({ ...release, updateChannel: "local-preview-only" }),
    ).toThrow();
  });

  it.each([undefined, "0", "01", "-1", "2.0", "99999999999999999999"])(
    "refuses owner-beta identity without a valid numeric build: %s",
    (buildVersion) => {
      expect(() =>
        createBuildIdentity({
          ...input,
          version: "0.1.0-owner.beta.1",
          updateChannel: "github-owner-beta",
          ...(buildVersion === undefined ? {} : { buildVersion }),
        }),
      ).toThrow("BUILD_IDENTITY_INVALID");
    },
  );

  it.each([
    ["version", { version: "preview" }],
    ["build time", { builtAt: "yesterday" }],
    ["source commit", { sourceCommit: "c".repeat(39) }],
    ["source digest", { sourceTreeDigest: "d".repeat(63) }],
    ["build id", { buildId: "e".repeat(64) }],
    ["unknown field", { unexpected: true }],
  ])("rejects a tampered %s", (_name, mutation) => {
    expect(() =>
      assertBuildIdentity({ ...createBuildIdentity(input), ...mutation }),
    ).toThrow("BUILD_IDENTITY_INVALID");
  });
});

it("keeps stable versions and valid numeric build numbers bound", () => {
  const stable = createBuildIdentity({
    ...input,
    version: "0.2.1",
    updateChannel: "github-stable",
    buildVersion: "30",
  });
  expect(assertBuildIdentity(stable)).toEqual(stable);
  for (const change of [
    { version: "0.2.1-owner.beta.1" },
    { version: "01.2.1" },
    { buildVersion: undefined },
    { updateChannel: "github-owner-beta" },
  ]) {
    expect(() =>
      createBuildIdentity({
        ...input,
        version: "0.2.1",
        updateChannel: "github-stable",
        buildVersion: "30",
        ...change,
      }),
    ).toThrow("BUILD_IDENTITY_INVALID");
  }
});
