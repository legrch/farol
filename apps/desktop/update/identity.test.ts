import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalBuildIdentityPayload,
  type BuildIdentity,
} from "../../../src/pkg/build-info/identity";
import {
  buildForPhase,
  buildIdentityCanonical,
  manifestTarget,
  runsAsBuild,
  settledBuild,
} from "./identity";

const d = (c: string) => c.repeat(64);
const source = { digest: d("a"), version: "1.2.3", buildId: d("b") };
const target = { digest: d("c"), version: "1.2.4", buildId: d("d") };
const operation = { operationId: "1".repeat(32), source, target };

const identity = (buildId: string): BuildIdentity => ({
  schema: 1,
  product: "Farol",
  version: "1.2.3",
  bundleId: "io.github.legrch.farol",
  updateChannel: "github-stable",
  buildVersion: "7",
  builtAt: "2026-01-01T00:00:00.000Z",
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: d("e"),
  sourceDirty: false,
  buildId,
});

describe("buildIdentityCanonical", () => {
  it("accepts only an id that digests the canonical payload", () => {
    const base = identity(d("0"));
    const id = createHash("sha256")
      .update(canonicalBuildIdentityPayload(base))
      .digest("hex");
    expect(buildIdentityCanonical(identity(id))).toBe(true);
    expect(buildIdentityCanonical(identity(d("f")))).toBe(false);
  });
});

describe("manifestTarget", () => {
  it("renames the artifact digest and keeps version and id", () => {
    expect(
      manifestTarget({
        artifactSha256: d("a"),
        version: "1.0.0",
        buildId: d("b"),
      }),
    ).toEqual({ digest: d("a"), version: "1.0.0", buildId: d("b") });
  });
});

describe("runsAsBuild", () => {
  it("needs the same id and the same version", () => {
    const running = { buildId: d("b"), version: "1.2.3" };
    expect(runsAsBuild(source, running)).toBe(true);
    expect(runsAsBuild({ ...source, version: "1.2.4" }, running)).toBe(false);
    expect(runsAsBuild({ ...source, buildId: d("c") }, running)).toBe(false);
  });
});

describe("settledBuild", () => {
  it("names the installed build only for a settled phase", () => {
    expect(settledBuild("completed", operation)).toBe(target);
    expect(settledBuild("rolled_back", operation)).toBe(source);
    expect(settledBuild("verified", operation)).toBeNull();
    expect(settledBuild("rollback_completed", operation)).toBeNull();
  });
});

describe("buildForPhase", () => {
  it("maps target, rollback and cancel phases and refuses the rest", () => {
    for (const phase of ["verified", "launch_requested", "completed"])
      expect(buildForPhase(phase, operation)).toBe(target);
    for (const phase of [
      "rolled_back",
      "rollback_launch_requested",
      "rollback_completed",
      "cancelled",
      "cancel_launch_requested",
      "cancel_completed",
    ])
      expect(buildForPhase(phase, operation)).toBe(source);
    for (const phase of ["prepared", "new_installed", "unknown"])
      expect(buildForPhase(phase, operation)).toBeNull();
  });
});
