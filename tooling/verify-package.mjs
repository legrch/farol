import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCanonicalArtifactPath,
  candidatePaths,
} from "./candidate-contract.mjs";
import { verifyPackageContent } from "./verify-package-content.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const canonical = candidatePaths(root);
const arguments_ = process.argv.slice(2);
function option(name) {
  const indexes = arguments_
    .map((argument, index) => (argument === name ? index : -1))
    .filter((index) => index !== -1);
  if (indexes.length > 1) throw new Error(`PACKAGE_OPTION_REPEATED:${name}`);
  if (indexes.length === 0) return null;
  const value = arguments_[indexes[0] + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`PACKAGE_OPTION_VALUE_MISSING:${name}`);
  return value;
}
const artifactOption = option("--artifact");
const appOption = option("--app");
const known = new Set(["--artifact", "--app"]);
for (let index = 0; index < arguments_.length; index += 1) {
  const argument = arguments_[index];
  if (!known.has(argument))
    throw new Error(`PACKAGE_OPTION_INVALID:${argument}`);
  index += 1;
}
const artifactFile = path.resolve(
  artifactOption ?? path.join(root, "_output/package/artifact.json"),
);
const artifact = JSON.parse(await fs.readFile(artifactFile, "utf8"));
const appPath = path.resolve(appOption ?? canonical.appPath);
const packageDocument = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
const expectedChannel =
  /^[0-9]+\.[0-9]+\.[0-9]+-owner\.beta\.[1-9][0-9]*$/u.test(
    packageDocument.version,
  )
    ? "github-owner-beta"
    : "local-preview-only";
const sourceResourceManifest = JSON.parse(
  await fs.readFile(path.join(root, "resources.json"), "utf8"),
);
const identity = await verifyPackageContent({
  artifact,
  appPath,
  expectedVersion: packageDocument.version,
  expectedChannel,
  sourceResourceManifest,
  assertArtifactPath: () => assertCanonicalArtifactPath(root, artifact),
});
process.stdout.write(
  `verified ${identity.product} ${identity.version} ${identity.artifactSha256} (${artifact.sourceDirty ? "dirty" : "clean"}) at ${appPath}\n`,
);
