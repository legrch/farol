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
