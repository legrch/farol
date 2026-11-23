import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseBuildFields } from "./release-identity.mjs";
import { assertPackageResourceManifest } from "./verify-package-content.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function assertReleasePreflight(pkg, lock, resources) {
  const { updateChannel, buildVersion } = releaseBuildFields(pkg);
  if (!updateChannel || !buildVersion)
    throw new Error("RELEASE_BUILD_FIELDS_REQUIRED");
  if (
    lock?.name !== pkg.name ||
    lock?.version !== pkg.version ||
    lock?.packages?.[""]?.name !== pkg.name ||
    lock?.packages?.[""]?.version !== pkg.version
  )
    throw new Error("RELEASE_LOCK_IDENTITY_MISMATCH");
  assertPackageResourceManifest(
    resources,
    { version: pkg.version, updateChannel },
    pkg.version,
    updateChannel,
  );
  return { version: pkg.version, buildVersion, updateChannel };
}

// An installed updater accepts a newer release only when its buildVersion is
// strictly greater than its own (0.5.27 shipped with 0.5.26's build 82 and no
// installation could reach it). A new version must advance the build number
// past the previous release tag; rebuilding the same version may keep it.
export function assertBuildAdvances(pkg, previous) {
  if (previous === null || previous.version === pkg.version) return;
  const { buildVersion } = releaseBuildFields(pkg);
  if (
    !previous.buildVersion ||
    BigInt(buildVersion) <= BigInt(previous.buildVersion)
  )
    throw new Error("RELEASE_BUILD_VERSION_NOT_ADVANCED");
}

// The newest v* release tag reachable from HEAD other than this version's own
// tag, read from Git without network. A checkout without tags has no
// previous release to compare against.
function previousRelease(version) {
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  let tag;
  try {
    tag = git(
      "describe",
      "--tags",
      "--abbrev=0",
      "--match",
      "v*",
      "--exclude",
      `v${version}`,
      "HEAD",
    );
  } catch {
    return null;
  }
  const tagged = JSON.parse(git("show", `${tag}:package.json`));
  return {
    version: tagged.version,
    buildVersion: tagged.farolRelease?.buildVersion,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const read = (name) =>
      JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    const identity = assertReleasePreflight(
      read("package.json"),
      read("package-lock.json"),
      read("resources.json"),
    );
    const pkg = read("package.json");
    assertBuildAdvances(pkg, previousRelease(pkg.version));
    process.stdout.write(
      `Release preflight: ${identity.version} build ${identity.buildVersion} · ${identity.updateChannel}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `Release preflight failed: ${error instanceof Error ? error.message : "UNKNOWN"}\n`,
    );
    process.exitCode = 1;
  }
}
