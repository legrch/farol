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
 * The identity block. Two things it must not flatten:
 *
 * `loader` is REQUIRED and has no default. The journey either bundled the
 * TypeScript under test and imported that (`kind: "source-level"`, with the
 * bundle it actually loaded) or ran built bytes (`kind: "built"`, with that
 * build's id and artifact digest). A default would let a report claim the
 * first while doing the second; the caller has to say which, because only
 * the caller knows.
 *
 * `hosts` is a LIST, because one journey runs more than one binary. Measured
 * on this machine: `which codex` finds a Node shim, while the product's own
 * discovery offers the signed ChatGPT.app binary, and the phases that test
 * discovery deliberately run the latter. Both report `codex-cli 0.153.4`, so
 * the version does not tell them apart. Each entry carries the phase ids it
 * answered, and `assertReportIdentity` refuses a report containing a phase
 * no entry claims — otherwise a reader can see which binaries were involved
 * without being able to attribute a single result to one.
 */
export function buildReportIdentity(options) {
  const { repositoryRoot, loader, hosts, nodeVersion } = options;
  assertLoader(loader);
  assertHosts(hosts);
  const source = sourceIdentity(repositoryRoot);
  return {
    sourceCommit: source.commit,
    sourceTreeDigest: source.treeDigest,
    sourceDirty: source.dirty,
    loader,
    hosts: hosts.map((host) => ({
      binary: host.binary,
      version: host.version ?? null,
      phases: [...host.phases],
    })),
    nodeVersion,
  };
}

function assertLoader(loader) {
  if (!loader || typeof loader !== "object") {
    throw new Error("FAROL_MODEL_E2E_REPORT_LOADER_MISSING");
  }
  if (loader.kind === "source-level") {
    if (
      typeof loader.bundlePath !== "string" ||
      loader.bundlePath.length === 0
    ) {
      throw new Error("FAROL_MODEL_E2E_REPORT_LOADER_INVALID");
    }
    return;
  }
  if (loader.kind === "built") {
    if (
      !/^[0-9a-f]{64}$/u.test(loader.buildId ?? "") ||
      !/^[0-9a-f]{64}$/u.test(loader.artifactSha256 ?? "")
    ) {
      throw new Error("FAROL_MODEL_E2E_REPORT_LOADER_INVALID");
    }
    return;
  }
  throw new Error("FAROL_MODEL_E2E_REPORT_LOADER_INVALID");
}

function assertHosts(hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new Error("FAROL_MODEL_E2E_REPORT_HOST_BINARY_MISSING");
  }
  for (const host of hosts) {
    if (typeof host?.binary !== "string" || host.binary.length === 0) {
      throw new Error("FAROL_MODEL_E2E_REPORT_HOST_BINARY_MISSING");
    }
    if (!Array.isArray(host.phases) || host.phases.length === 0) {
      throw new Error("FAROL_MODEL_E2E_REPORT_HOST_PHASES_MISSING");
    }
  }
}

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
  assertLoader(identity.loader);
  assertHosts(identity.hosts);
  for (const host of identity.hosts) {
    if (typeof host.version !== "string" || host.version.length === 0) {
      throw new Error("FAROL_MODEL_E2E_REPORT_HOST_VERSION_MISSING");
    }
  }
  if (!SUPPORTED_NODE_VERSIONS.includes(identity.nodeVersion)) {
    throw new Error("FAROL_MODEL_E2E_REPORT_NODE_UNSUPPORTED");
  }
  // Every phase the report contains must be attributable to exactly one
  // recorded binary. A phase no entry claims is the failure this exists for:
  // the report would name binaries without saying which produced a result.
  const claimed = new Map();
  for (const host of identity.hosts) {
    for (const phase of host.phases) {
      if (claimed.has(phase)) {
        throw new Error("FAROL_MODEL_E2E_REPORT_PHASE_HOST_AMBIGUOUS");
      }
      claimed.set(phase, host.binary);
    }
  }
  for (const phase of report.phases ?? []) {
    if (!claimed.has(phase.id)) {
      throw new Error("FAROL_MODEL_E2E_REPORT_PHASE_HOST_UNKNOWN");
    }
  }
  return identity;
}
