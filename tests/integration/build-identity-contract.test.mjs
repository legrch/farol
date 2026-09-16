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
