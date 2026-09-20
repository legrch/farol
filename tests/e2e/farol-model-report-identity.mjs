import { sourceIdentity } from "../../tooling/source-identity.mjs";

// S35-TA-5: what a real-host report must say about the bytes it exercised.
//
// The report used to carry the host binary and its version and nothing about
// Farol, so a passing run could not be attributed to a candidate: two reports
// from different commits were indistinguishable. This is the same identity the
// ordinary lanes derive, through the same `sourceIdentity` they use, plus the
// two things only this journey knows — which `codex` answered, and which Node
// actually launched it.
//
// Deliberately NOT an evidence attempt: no attempt id, no lane contract. This
// journey stays a witness note on the Route B rows until a real-host lane
// contract exists; an identity block is what makes the note attributable, not
// a claim that it is a lane.

/** The Node versions this project builds and runs with (`check-toolchain.mjs`). */
export const SUPPORTED_NODE_VERSIONS = Object.freeze(["24.20.0", "26.7.0"]);

/**
 * The identity block for a source-level journey: this checkout's commit, the
 * digest of its `vnext` tree, and whether the working tree differed from it.
 *
 * `build` is `"source-level"` because the journey bundles the TypeScript under
 * test with esbuild and never loads `dist/app`; a journey that did would carry
 * that build's own id and artifact digest instead, and saying "source-level"
 * is how a reader tells the two apart rather than assuming.
 */
export function buildReportIdentity(options) {
  const { repositoryRoot, hostBinary, hostVersion, nodeVersion, build } =
    options;
  // S35-TA-10 (R4 P2): the builder used to emit `hostBinary ?? null` and the
  // validator never looked at it, so a report could carry a host VERSION
  // without naming the executable that produced it — two `codex` binaries on
  // one machine, and two reports nothing could tell apart. A report that
  // cannot say which executable it exercised is not built at all.
  if (typeof hostBinary !== "string" || hostBinary.length === 0) {
    throw new Error("FAROL_MODEL_E2E_REPORT_HOST_BINARY_MISSING");
  }
  const source = sourceIdentity(repositoryRoot);
  return {
    sourceCommit: source.commit,
    sourceTreeDigest: source.treeDigest,
    sourceDirty: source.dirty,
    build: build ?? "source-level",
    hostBinary,
    hostVersion: hostVersion ?? null,
    nodeVersion,
  };
}

/**
 * Refuses a report that cannot be attributed. A run that passed every phase
 * but cannot say which bytes it exercised is not evidence of anything, so the
 * script fails rather than writing one.
 */
export function assertReportIdentity(report) {
  const identity = report?.identity;
  if (!identity || typeof identity !== "object") {
    throw new Error("FAROL_MODEL_E2E_REPORT_IDENTITY_MISSING");
  }
  if (!/^[0-9a-f]{40}$/u.test(identity.sourceCommit ?? "")) {
    throw new Error("FAROL_MODEL_E2E_REPORT_SOURCE_COMMIT_INVALID");
  }
  if (!/^[0-9a-f]{64}$/u.test(identity.sourceTreeDigest ?? "")) {
    throw new Error("FAROL_MODEL_E2E_REPORT_SOURCE_TREE_DIGEST_INVALID");
  }
  if (typeof identity.sourceDirty !== "boolean") {
    throw new Error("FAROL_MODEL_E2E_REPORT_SOURCE_DIRTY_INVALID");
  }
  if (
    identity.build !== "source-level" &&
    !/^[0-9a-f]{64}$/u.test(identity.build?.buildId ?? "")
  ) {
    throw new Error("FAROL_MODEL_E2E_REPORT_BUILD_INVALID");
  }
  // A report whose host or Node is unknown cannot say what it exercised
  // either: both are part of the claim, not decoration.
  // Both halves of "which host answered": the executable and its version.
  // The version alone identifies a release, not the binary that ran.
  if (
    typeof identity.hostBinary !== "string" ||
    identity.hostBinary.length === 0
  ) {
    throw new Error("FAROL_MODEL_E2E_REPORT_HOST_BINARY_MISSING");
  }
  if (
    typeof identity.hostVersion !== "string" ||
    identity.hostVersion.length === 0
  ) {
    throw new Error("FAROL_MODEL_E2E_REPORT_HOST_VERSION_MISSING");
  }
  if (!SUPPORTED_NODE_VERSIONS.includes(identity.nodeVersion)) {
    throw new Error("FAROL_MODEL_E2E_REPORT_NODE_UNSUPPORTED");
  }
  return identity;
}
