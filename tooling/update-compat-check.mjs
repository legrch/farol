import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { candidatePaths } from "./candidate-contract.mjs";

// Release gate for the update path. An installed app verifies a downloaded
// package with ITS OWN bundled update-package.mjs, so a candidate must be
// accepted by the verifier of every previous release that is still supported
// as an update source. Run this explicit operator step before a release, with
// each supported previous release's own update-package.mjs
// (Contents/Resources/app/update-package.mjs of its built or installed app).
// Missing, unreadable, unknown or unrun verifiers are refusals, never skips.
//
// It reads the candidate package and the given verifiers only. It needs no
// network and no installed app, and it never touches an installed profile.

const CHANNELS = ["github-owner-beta", "github-stable"];
const VERIFIER_TIMEOUT_MS = 120_000;

// Reviewed list of releases that are still supported as update sources. A
// verifier is accepted only when its bytes hash to an entry's digest, so a
// renamed copy of the candidate's own verifier (or any other file) is refused.
// Measure a new entry from Contents/Resources/app/update-package.mjs of the
// built app of that exact tag, and add it in the change that ships the release.
export const SUPPORTED_PREVIOUS_RELEASES = Object.freeze([
  Object.freeze({
    version: "0.5.29",
    buildVersion: "84",
    verifierSha256:
      "ac194b2c7bca92d14113b12d4e6f72254305a1d3f4655b68a61d25d209f7db44",
  }),
]);

// The identity every verifier prints. The installed updater compares exactly
// these fields (measuredMatches and packageMatchesRelease) with the release.
const IDENTITY_FIELDS = [
  "product",
  "bundleId",
  "version",
  "buildVersion",
  "updateChannel",
  "buildId",
  "sourceCommit",
  "sourceTreeDigest",
  "artifactSha256",
  "signing",
  "notarized",
];

export class UpdateCompatUsageError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function expectedIdentity(artifact) {
  return {
    product: artifact.product,
    bundleId: artifact.bundleId,
    version: artifact.version,
    buildVersion: artifact.buildVersion,
    updateChannel: artifact.updateChannel,
    buildId: artifact.buildId,
    sourceCommit: artifact.sourceCommit,
    sourceTreeDigest: artifact.sourceTreeDigest,
    artifactSha256: artifact.artifactSha256,
    signing: artifact.signing?.kind ?? artifact.signing,
    notarized: artifact.notarized,
  };
}

function identityMismatch(identity, expected) {
  if (
    identity === null ||
    typeof identity !== "object" ||
    Array.isArray(identity)
  )
    return "UPDATE_COMPAT_IDENTITY_INVALID";
  const keys = Object.keys(identity).sort().join();
  if (keys !== [...IDENTITY_FIELDS].sort().join())
    return "UPDATE_COMPAT_IDENTITY_FIELDS_INVALID";
  for (const field of IDENTITY_FIELDS)
    if (identity[field] !== expected[field])
      return `UPDATE_COMPAT_IDENTITY_MISMATCH:${field}`;
  return null;
}

async function sha256OfFile(file) {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

export function parseUpdateCompatArguments(argv) {
  const options = { verifiers: [] };
  const valued = new Map([
    ["--verifier", "verifier"],
    ["--artifact", "artifact"],
    ["--app", "app"],
    ["--version", "version"],
    ["--build-version", "buildVersion"],
    ["--channel", "channel"],
    ["--runtime", "runtime"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--allow-partial") {
      if (options.allowPartial)
        throw new UpdateCompatUsageError("UPDATE_COMPAT_ARGUMENTS_INVALID");
      options.allowPartial = true;
      continue;
    }
    const key = valued.get(argv[index]);
    index += 1;
    const value = argv[index];
    if (key === undefined || typeof value !== "string" || value === "")
      throw new UpdateCompatUsageError("UPDATE_COMPAT_ARGUMENTS_INVALID");
    if (key === "verifier") options.verifiers.push(value);
    else if (options[key] !== undefined)
      throw new UpdateCompatUsageError("UPDATE_COMPAT_ARGUMENTS_INVALID");
    else options[key] = value;
  }
  if (options.verifiers.length === 0)
    throw new UpdateCompatUsageError("UPDATE_COMPAT_NO_VERIFIER");
  return options;
}

function reasonOf(result) {
  if (result.error)
    return `UPDATE_COMPAT_VERIFIER_NOT_RUN:${result.error.code ?? "error"}`;
  if (result.signal) return `UPDATE_COMPAT_VERIFIER_SIGNAL:${result.signal}`;
  const text = `${result.stderr ?? ""}`;
  const named = /(?:Error: )([A-Z][A-Z0-9_]+(?::[^\n]{0,200})?)/u.exec(text);
  return named ? named[1] : `UPDATE_COMPAT_VERIFIER_EXIT:${result.status}`;
}

// Runs every given verifier against one candidate. Returns `results`, one
// entry per verifier in the order given, and `skipped`, the supported previous
// releases no accepted-by-digest verifier was given for. An entry is `ok` only
// when its digest belongs to a supported release, the verifier exited 0 and its
// printed identity equals the candidate's artifact.json on every compared field.
export async function checkUpdateCompatibility({
  verifiers,
  artifact,
  artifactFile,
  appPath,
  version,
  buildVersion,
  channel,
  runtime = process.execPath,
  run = spawnSync,
  releases = SUPPORTED_PREVIOUS_RELEASES,
}) {
  if (!Array.isArray(verifiers) || verifiers.length === 0)
    throw new UpdateCompatUsageError("UPDATE_COMPAT_NO_VERIFIER");
  if (!CHANNELS.includes(channel))
    throw new UpdateCompatUsageError("UPDATE_COMPAT_CHANNEL_INVALID");
  const expected = expectedIdentity(artifact);
  const ownVerifier = path.resolve(
    appPath,
    "Contents/Resources/app/update-package.mjs",
  );
  let ownDigest = null;
  try {
    ownDigest = await sha256OfFile(ownVerifier);
  } catch {
    ownDigest = null;
  }
  const results = [];
  const covered = new Set();
  for (const given of verifiers) {
    const verifier = path.resolve(given);
    if (verifier === ownVerifier) {
      // The candidate's own verifier says nothing about installed clients.
      results.push({
        verifier,
        ok: false,
        reason: "UPDATE_COMPAT_VERIFIER_IS_CANDIDATE",
      });
      continue;
    }
    let stat;
    try {
      stat = await fs.lstat(verifier);
    } catch {
      results.push({
        verifier,
        ok: false,
        reason: "UPDATE_COMPAT_VERIFIER_MISSING",
      });
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      results.push({
        verifier,
        ok: false,
        reason: "UPDATE_COMPAT_VERIFIER_INVALID",
      });
      continue;
    }
    let digest;
    try {
      digest = await sha256OfFile(verifier);
    } catch {
      results.push({
        verifier,
        ok: false,
        reason: "UPDATE_COMPAT_VERIFIER_INVALID",
      });
      continue;
    }
    if (ownDigest !== null && digest === ownDigest) {
      results.push({
        verifier,
        ok: false,
        reason: "UPDATE_COMPAT_VERIFIER_IS_CANDIDATE",
      });
      continue;
    }
    const release = releases.find((entry) => entry.verifierSha256 === digest);
    if (release === undefined) {
      results.push({
        verifier,
        ok: false,
        reason: "UPDATE_COMPAT_VERIFIER_UNKNOWN",
      });
      continue;
    }
    covered.add(release.version);
    const result = run(
      runtime,
      [verifier, artifactFile, appPath, version, buildVersion, channel],
      {
        encoding: "utf8",
        maxBuffer: 1 << 20,
        timeout: VERIFIER_TIMEOUT_MS,
        killSignal: "SIGKILL",
        env: {
          PATH: "/usr/bin:/bin",
          ELECTRON_RUN_AS_NODE: "1",
          ELECTRON_NO_ASAR: "1",
        },
      },
    );
    if (result.error || result.signal || result.status !== 0) {
      results.push({
        verifier,
        release: release.version,
        ok: false,
        reason: reasonOf(result),
      });
      continue;
    }
    let identity;
    try {
      identity = JSON.parse(result.stdout);
    } catch {
      identity = null;
    }
    const mismatch = identityMismatch(identity, expected);
    results.push({
      verifier,
      release: release.version,
      ok: mismatch === null,
      reason: mismatch,
    });
  }
  const skipped = releases
    .filter((entry) => !covered.has(entry.version))
    .map((entry) => entry.version);
  return { results, skipped };
}

export function formatUpdateCompatReport(
  { results, skipped },
  subject,
  allowPartial = false,
) {
  const lines = results.map((entry) =>
    entry.ok
      ? `PASS     ${entry.verifier}  (release ${entry.release})`
      : `REFUSED  ${entry.verifier}  ${entry.reason}`,
  );
  for (const version of skipped)
    lines.push(
      allowPartial
        ? `SKIPPED  release ${version}  no verifier was run`
        : `REFUSED  release ${version}  UPDATE_COMPAT_RELEASE_NOT_COVERED`,
    );
  const failed = results.filter((entry) => !entry.ok).length;
  if (failed > 0)
    lines.push(
      `UPDATE COMPATIBILITY FAILED: ${subject} refused by ${failed} of ${results.length} previous verifier(s). Do not publish this candidate.`,
    );
  else if (skipped.length > 0)
    lines.push(
      allowPartial
        ? `UPDATE COMPATIBILITY PARTIAL: ${subject} was NOT checked against ${skipped.join(", ")}. This is not a pass. Do not publish this candidate.`
        : `UPDATE COMPATIBILITY FAILED: ${subject} was not checked against ${skipped.join(", ")}. Do not publish this candidate.`,
    );
  else
    lines.push(
      `UPDATE COMPATIBILITY PASSED: ${subject} accepted by ${results.length} previous verifier(s), covering every supported release.`,
    );
  return lines.join("\n");
}

// 0 only for a complete pass. A partial run never exits 0.
export function updateCompatExitCode({ results, skipped }, allowPartial) {
  if (results.some((entry) => !entry.ok)) return 1;
  if (skipped.length > 0) return allowPartial ? 3 : 1;
  return 0;
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..");
  let options;
  try {
    options = parseUpdateCompatArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error.code ?? error.message}\n` +
        "usage: node tooling/update-compat-check.mjs --verifier <previous update-package.mjs> " +
        "[--verifier ...] [--allow-partial] [--artifact artifact.json] [--app <app bundle>] " +
        "[--version V] [--build-version N] [--channel github-stable|github-owner-beta] " +
        "[--runtime node]\n",
    );
    process.exit(2);
  }
  const defaults = candidatePaths(root);
  const artifactFile = path.resolve(options.artifact ?? defaults.artifactFile);
  const appPath = path.resolve(options.app ?? defaults.appPath);
  const artifact = JSON.parse(await fs.readFile(artifactFile, "utf8"));
  const version = options.version ?? artifact.version;
  const buildVersion = options.buildVersion ?? artifact.buildVersion;
  const channel = options.channel ?? artifact.updateChannel;
  if (!version || buildVersion === undefined || !channel)
    throw new Error("UPDATE_COMPAT_CANDIDATE_IDENTITY_MISSING");
  const outcome = await checkUpdateCompatibility({
    verifiers: options.verifiers,
    artifact,
    artifactFile,
    appPath,
    version: String(version),
    buildVersion: String(buildVersion),
    channel,
    runtime: options.runtime,
  });
  const allowPartial = options.allowPartial === true;
  const code = updateCompatExitCode(outcome, allowPartial);
  const report = formatUpdateCompatReport(
    outcome,
    `Release ${version} (build ${buildVersion}, ${channel})`,
    allowPartial,
  );
  (code === 0 ? process.stdout : process.stderr).write(`${report}\n`);
  process.exit(code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
