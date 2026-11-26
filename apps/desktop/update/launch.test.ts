import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalBuildIdentityPayload,
  type BuildIdentity,
} from "../../../src/pkg/build-info/identity";
import { buildRefused, launchOperation } from "./launch";

const base = {
  schema: 1,
  product: "Farol",
  version: "1.2.3",
  bundleId: "io.github.legrch.farol",
  updateChannel: "github-stable",
  buildVersion: "7",
  builtAt: "2026-01-01T00:00:00.000Z",
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: "b".repeat(64),
  sourceDirty: false,
  buildId: "",
} as BuildIdentity;
const sealed = (patch: Partial<BuildIdentity> = {}): BuildIdentity => {
  const build = { ...base, ...patch } as BuildIdentity;
  return {
    ...build,
    buildId: createHash("sha256")
      .update(canonicalBuildIdentityPayload(build))
      .digest("hex"),
  };
};

describe("build refusal", () => {
  it("accepts a sealed clean release build", () => {
    expect(buildRefused(sealed())).toBe(false);
    expect(buildRefused(sealed({ updateChannel: "github-owner-beta" }))).toBe(
      false,
    );
  });

  it("refuses dirty, unversioned, preview and unsealed builds", () => {
    expect(buildRefused(sealed({ sourceDirty: true }))).toBe(true);
    expect(buildRefused(sealed({ buildVersion: undefined }))).toBe(true);
    expect(buildRefused(sealed({ updateChannel: "local-preview-only" }))).toBe(
      true,
    );
    expect(buildRefused({ ...sealed(), buildId: "c".repeat(64) })).toBe(true);
  });
});

describe("launch operation", () => {
  const root = "/u/installed-updates";
  const id = "1".repeat(32);

  it("names the operation of a private launch image", () => {
    expect(launchOperation(root, `${root}/${id}/launch-Farol.app`)).toBe(id);
  });

  it("returns null for any other location", () => {
    expect(launchOperation(root, "/Applications/Farol.app")).toBeNull();
    expect(launchOperation(root, `${root}/${id}/Farol.app`)).toBeNull();
    expect(launchOperation(root, `${root}/XYZ/launch-Farol.app`)).toBeNull();
    expect(
      launchOperation(root, `${root}/${id}/x/launch-Farol.app`),
    ).toBeNull();
  });
});
