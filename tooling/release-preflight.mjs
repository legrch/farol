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
// past every earlier release of its channel; rebuilding the same version's
// own tag is excluded from the comparison.
export function assertBuildAdvances(pkg, releases) {
  const { buildVersion, updateChannel } = releaseBuildFields(pkg);
  let highest = 0n;
  for (const release of releases) {
    if (release.version === pkg.version) continue;
    if (release.updateChannel !== updateChannel) continue;
    const build = BigInt(release.buildVersion);
    if (build > highest) highest = build;
  }
  if (BigInt(buildVersion) <= highest)
    throw new Error("RELEASE_BUILD_VERSION_NOT_ADVANCED");
}

const RELEASE_TAG =
  /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-owner\.beta\.[1-9][0-9]*)?$/u;

// Every release tag reachable from HEAD, read from Git without network. Fails
// closed on a shallow checkout or any Git error instead of skipping: a missing
// history must never look like a first release.
export function reachableReleases(git) {
  if (git("rev-parse", "--is-shallow-repository") !== "false")
    throw new Error("RELEASE_HISTORY_UNAVAILABLE");
  const tags = git("tag", "--merged", "HEAD", "--list", "v*")
    .split("\n")
    .filter((tag) => RELEASE_TAG.test(tag));
  // A tag whose package.json names another version (historical owner-beta
  // tags v0.2.0-owner.beta.3/4/7 point at 0.1.8 sources) could never pass the
  // release-tag identity check, so it is not a release and is skipped.
  return tags.flatMap((tag) => {
    const tagged = JSON.parse(git("show", `${tag}:package.json`));
    if (`v${tagged.version}` !== tag) return [];
    const { buildVersion, updateChannel } = releaseBuildFields(tagged);
    if (!buildVersion || !updateChannel)
      throw new Error("RELEASE_TAG_IDENTITY_INVALID");
    return [{ version: tagged.version, buildVersion, updateChannel }];
  });
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
    const git = (...args) =>
      execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    assertBuildAdvances(read("package.json"), reachableReleases(git));
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
