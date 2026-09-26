import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { sourceIdentity } from "../../tooling/source-identity.mjs";

// S35-TA-15 (U2a): why a run reported `sourceDirty: true` on a worktree that
// `git status --porcelain` shows clean immediately afterwards. Seen four
// times, never explained, and an unexplained dirty flag makes every
// attribution arguable.
//
// The flag itself is NOT touched here: `sourceIdentity` owns it, it lives in
// shared tooling this packet does not edit, and a flag flipped to false
// because a digest matched would be exactly the self-deception the amendment
// forbids. What is added is the observation that was missing — taken in the
// SAME operation, so it describes the instant the flag was computed rather
// than the tidy state a later check finds.
//
// Content-free by construction: this records repository-relative PATHS and
// git's own two-letter status codes, never file contents, and it stops after
// a bound. A path is what distinguishes "the owner edited a tracked source"
// from "something wrote scratch into the working directory during the run",
// and that distinction is the entire question.
const DIRTY_DIAGNOSTIC_LIMIT = 24;

function gitResult(repositoryRoot, args) {
  try {
    return {
      status: 0,
      stdout: execFileSync("git", ["-C", repositoryRoot, ...args], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      }),
    };
  } catch (error) {
    return {
      status: typeof error?.status === "number" ? error.status : null,
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
    };
  }
}

/**
 * What the working tree looked like at the instant the identity was built.
 * `entries` carries git's own porcelain code plus the path; `tracked` is the
 * subset git does not call untracked, which is the half that would mean a
 * real source edit rather than scratch.
 */
export function captureWorkingTreeObservation(repositoryRoot, scope = ".") {
  const status = gitResult(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    scope,
  ]);
  const lines = status.stdout.split("\n").filter((line) => line.length > 0);
  const entries = lines.slice(0, DIRTY_DIAGNOSTIC_LIMIT).map((line) => ({
    code: line.slice(0, 2),
    path: line.slice(3),
  }));
  return {
    gitStatusExit: status.status,
    entryCount: lines.length,
    truncated: lines.length > entries.length,
    entries,
    trackedEntryCount: entries.filter((entry) => !entry.code.startsWith("??"))
      .length,
  };
}

/** The digest of the bundle this run actually imported (U2b). */
export function bundleDigest(bundlePath) {
  try {
    return createHash("sha256").update(readFileSync(bundlePath)).digest("hex");
  } catch {
    return null;
  }
}

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
 * `hostlessPhases` is the third field, and it exists because a phase can
 * legitimately run no binary at all: `app-host-discovery` inspects the
 * filesystem and the process table and never executes the host. Recording
 * that is not bookkeeping — an unattributed phase and a phase nobody wrote
 * down look identical in a report, and only one of them is fine. It is
 * RECORDED by the journey, to the same standard as the binaries.
 *
 * `hosts` is a LIST, because one journey runs more than one binary. Measured
 * on this machine: `which codex` finds a Node shim, while the product's own
 * discovery offers the signed ChatGPT.app binary, and the phases that test
 * discovery deliberately run the latter. They are not even the same release
 * — measured on 0f850a7f, the shim reported `codex-cli 0.153.4` and the
 * discovered binary `codex-cli 0.155.0-alpha.9.2` — and before each was
 * asked for its own version the report attributed the alpha's phases to the
 * stable release's string. Each entry carries the phase ids it
 * answered, and `assertReportIdentity` refuses a report containing a phase
 * no entry claims — otherwise a reader can see which binaries were involved
 * without being able to attribute a single result to one.
 */
/**
 * The construction the journey itself performs: raw records in, a validated
 * identity out.
 *
 * S35-TA-14: `writeReport` used to do this inline and, while grouping, it
 * FILTERED the host-less list against the runs — so a phase recorded
 * host-less that later ran a binary was quietly normalised into an ordinary
 * binary claim, and `PHASE_HOST_AMBIGUOUS` could never fire from the real
 * journey however wrong the records were. (The filter also compared a phase
 * id against a map keyed by binary path, which matches nothing and was dead
 * on its own terms.) The contradiction is exactly what the validator exists
 * to catch, so nothing normalises it any more: the records are grouped as
 * they are and the validator is told the truth about them.
 */
export function identityFromRunRecords(input) {
  const { hostRuns, hostlessPhases, hostVersions, phaseIds, ...rest } = input;
  // S35-TA-15 (U2b): a path is not a binding. The descriptor claims a bundle;
  // this re-digests that file and refuses when the claim does not match the
  // bytes on disk, so a report cannot name source it did not load.
  if (rest.loader?.kind === "source-level") {
    // Shape first, then the binding: a descriptor with no digest at all is
    // MALFORMED, not a mismatch. Reporting "mismatch" for it would tell a
    // reader the bytes disagreed when in fact nothing was ever claimed.
    assertLoader(rest.loader);
    const actual = bundleDigest(rest.loader.bundlePath);
    if (actual === null) {
      throw new Error("FAROL_MODEL_E2E_REPORT_LOADER_UNREADABLE");
    }
    if (actual !== rest.loader.bundleSha256) {
      throw new Error("FAROL_MODEL_E2E_REPORT_LOADER_MISMATCH");
    }
  }
  const byBinary = new Map();
  for (const run of hostRuns) {
    const phases = byBinary.get(run.binary) ?? [];
    if (!phases.includes(run.phase)) phases.push(run.phase);
    byBinary.set(run.binary, phases);
  }
  const workingTree =
    input.observeWorkingTree === false
      ? null
      : captureWorkingTreeObservation(rest.repositoryRoot);
  const identity = buildReportIdentity({
    ...rest,
    hosts: [...byBinary].map(([binary, phases]) => {
      // The journey asked each binary for its own `--version`; a binary it
      // ran without recording one is a gap in the records, not a reason to
      // borrow another binary's string. Borrowing is exactly how an alpha
      // host's phases came to be reported under a stable release.
      const version = hostVersions.get(binary);
      if (typeof version !== "string" || version.length === 0) {
        throw new Error("FAROL_MODEL_E2E_REPORT_HOST_VERSION_MISSING");
      }
      return { binary, version, phases };
    }),
    hostlessPhases: [...hostlessPhases],
  });
  assertPhaseAttribution(identity, phaseIds);
  // Recorded whatever the flag says, so a clean run is evidence too: "dirty
  // false with zero entries" and "dirty true with zero entries" are
  // different facts, and only the second is a puzzle.
  return workingTree ? { ...identity, workingTree } : identity;
}

export function buildReportIdentity(options) {
  const { repositoryRoot, loader, hosts, hostlessPhases, nodeVersion } =
    options;
  assertLoader(loader);
  assertHosts(hosts);
  if (!Array.isArray(hostlessPhases)) {
    throw new Error("FAROL_MODEL_E2E_REPORT_HOSTLESS_PHASES_MISSING");
  }
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
    hostlessPhases: [...hostlessPhases],
    nodeVersion,
  };
}

function assertLoader(loader) {
  if (!loader || typeof loader !== "object") {
    throw new Error("FAROL_MODEL_E2E_REPORT_LOADER_MISSING");
  }
  if (loader.kind === "source-level") {
    if (
      !/^[0-9a-f]{64}$/u.test(loader.bundleSha256 ?? "") ||
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
  if (!Array.isArray(identity.hostlessPhases)) {
    throw new Error("FAROL_MODEL_E2E_REPORT_HOSTLESS_PHASES_MISSING");
  }
  for (const host of identity.hosts) {
    if (typeof host.version !== "string" || host.version.length === 0) {
      throw new Error("FAROL_MODEL_E2E_REPORT_HOST_VERSION_MISSING");
    }
  }
  if (!SUPPORTED_NODE_VERSIONS.includes(identity.nodeVersion)) {
    throw new Error("FAROL_MODEL_E2E_REPORT_NODE_UNSUPPORTED");
  }
  // Every phase the report contains must be attributable to exactly one
  // recorded binary, or recorded as having run none.
  assertPhaseAttribution(
    identity,
    (report.phases ?? []).map((phase) => phase.id),
  );
  return identity;
}

/**
 * Every phase is claimed by exactly one binary, or recorded host-less, and
 * never both. Shared by the validator and by `identityFromRunRecords`, so
 * the journey's own construction is held to the same rule a report is.
 */
function assertPhaseAttribution(identity, phaseIds) {
  const claimed = new Map();
  for (const host of identity.hosts) {
    for (const phase of host.phases) {
      if (claimed.has(phase)) {
        throw new Error("FAROL_MODEL_E2E_REPORT_PHASE_HOST_AMBIGUOUS");
      }
      claimed.set(phase, host.binary);
    }
  }
  // A phase recorded host-less must not ALSO be claimed by a binary: both
  // would be true of it, so neither would be a fact about the run.
  for (const phase of identity.hostlessPhases) {
    if (claimed.has(phase)) {
      throw new Error("FAROL_MODEL_E2E_REPORT_PHASE_HOST_AMBIGUOUS");
    }
  }
  const hostless = new Set(identity.hostlessPhases);
  for (const phase of phaseIds) {
    if (!claimed.has(phase) && !hostless.has(phase)) {
      throw new Error("FAROL_MODEL_E2E_REPORT_PHASE_HOST_UNKNOWN");
    }
  }
}
