import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { candidatePaths } from "./candidate-contract.mjs";

// Release gate for the update path. An installed Farol verifies a downloaded
// package with ITS OWN bundled update-package.mjs, so a candidate must be
// accepted by the verifier of every previous release that is still supported
// as an update source. Run this explicit operator step before a release, once
// per supported previous release, with that release's own update-package.mjs
// (Contents/Resources/app/update-package.mjs of its built or installed app).
// Missing, unreadable or unrun verifiers are refusals, never skips.
//
// It reads the candidate package and the given verifiers only. It needs no
// network and no installed app, and it never touches an installed profile.

const CHANNELS = ["github-owner-beta", "github-stable"];
const VERIFIER_TIMEOUT_MS = 120_000;

export class UpdateCompatUsageError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
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
  for (let index = 0; index < argv.length; index += 2) {
    const key = valued.get(argv[index]);
    const value = argv[index + 1];
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

// Runs every given verifier against one candidate. Returns one entry per
// verifier, in the order given; `ok` is true only when that verifier exited 0
// and measured the candidate's own channel.
export async function checkUpdateCompatibility({
  verifiers,
  artifactFile,
  appPath,
  version,
  buildVersion,
  channel,
  runtime = process.execPath,
  run = spawnSync,
}) {
  if (!Array.isArray(verifiers) || verifiers.length === 0)
    throw new UpdateCompatUsageError("UPDATE_COMPAT_NO_VERIFIER");
  if (!CHANNELS.includes(channel))
    throw new UpdateCompatUsageError("UPDATE_COMPAT_CHANNEL_INVALID");
  const ownVerifier = path.resolve(
    appPath,
    "Contents/Resources/app/update-package.mjs",
  );
  const results = [];
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
      results.push({ verifier, ok: false, reason: reasonOf(result) });
      continue;
    }
    let identity;
    try {
      identity = JSON.parse(result.stdout);
    } catch {
      identity = null;
    }
    if (identity?.updateChannel !== channel) {
      results.push({
        verifier,
        ok: false,
        reason: "UPDATE_COMPAT_IDENTITY_CHANNEL_INVALID",
      });
      continue;
    }
    results.push({ verifier, ok: true, reason: null });
  }
  return results;
}

export function formatUpdateCompatReport(results, subject) {
  const lines = results.map((entry) =>
    entry.ok
      ? `PASS     ${entry.verifier}`
      : `REFUSED  ${entry.verifier}  ${entry.reason}`,
  );
  const failed = results.filter((entry) => !entry.ok).length;
  lines.push(
    failed === 0
      ? `UPDATE COMPATIBILITY PASSED: ${subject} accepted by ${results.length} previous verifier(s).`
      : `UPDATE COMPATIBILITY FAILED: ${subject} refused by ${failed} of ${results.length} previous verifier(s). Do not publish this candidate.`,
  );
  return lines.join("\n");
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
        "[--verifier ...] [--artifact artifact.json] [--app Farol.app] " +
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
  const results = await checkUpdateCompatibility({
    verifiers: options.verifiers,
    artifactFile,
    appPath,
    version: String(version),
    buildVersion: String(buildVersion),
    channel,
    runtime: options.runtime,
  });
  const report = formatUpdateCompatReport(
    results,
    `Farol ${version} (build ${buildVersion}, ${channel})`,
  );
  const passed = results.every((entry) => entry.ok);
  (passed ? process.stdout : process.stderr).write(`${report}\n`);
  process.exit(passed ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
