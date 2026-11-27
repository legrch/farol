import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  canonicalBuildIdentityPayload,
  type BuildIdentity,
} from "../../../src/pkg/build-info/identity";
import {
  CANCELLED_PHASES,
  ROLLED_BACK_PHASES,
  TARGET_PHASES,
  type AcceptedBuild,
  type Operation,
} from "./record";

// Identity comparisons the installed-update runtime repeats. Each reads only the
// values it is handed: no file, no process, no clock, and no write.

type Build = z.infer<typeof AcceptedBuild>;
type OperationRecord = z.infer<typeof Operation>;

/** True when the build's id is the digest of its own canonical identity. */
export function buildIdentityCanonical(build: BuildIdentity): boolean {
  return (
    createHash("sha256")
      .update(canonicalBuildIdentityPayload(build))
      .digest("hex") === build.buildId
  );
}

/** The accepted-build shape a release manifest or verified package names. */
export function manifestTarget(
  release: Readonly<{
    artifactSha256: string;
    version: string;
    buildId: string;
  }>,
): Build {
  return {
    digest: release.artifactSha256,
    version: release.version,
    buildId: release.buildId,
  };
}

/** True when a measured build is the running one by id and version. */
export function runsAsBuild(
  measured: Readonly<{ buildId: string; version: string }>,
  running: Readonly<{ buildId: string; version: string }>,
): boolean {
  return (
    measured.buildId === running.buildId && measured.version === running.version
  );
}

/** The build a settled receipt phase leaves installed, or null if unsettled. */
export function settledBuild(
  phase: string,
  operation: OperationRecord,
): Build | null {
  return phase === "completed"
    ? operation.target
    : phase === "rolled_back"
      ? operation.source
      : null;
}

/** The build a journal phase expects on disk, or null for an unknown phase. */
export function buildForPhase(
  phase: string,
  operation: OperationRecord,
): Build | null {
  if (TARGET_PHASES.includes(phase)) return operation.target;
  if ([...ROLLED_BACK_PHASES, ...CANCELLED_PHASES].includes(phase))
    return operation.source;
  return null;
}
