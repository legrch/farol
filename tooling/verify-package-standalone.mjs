import fs from "node:fs/promises";
import { verifyPackageContent } from "./verify-package-content.mjs";

// Build tooling bundles this trusted entry into the installed app. Arguments
// are exact private staging paths and release claims, never executable payload.
const [
  artifactFile,
  appPath,
  expectedVersion,
  expectedBuildVersion,
  expectedChannel,
] = process.argv.slice(2);
if (
  !artifactFile ||
  !appPath ||
  !expectedVersion ||
  !expectedBuildVersion ||
  !["github-owner-beta", "github-stable"].includes(expectedChannel)
) {
  throw new Error("PACKAGE_ARGUMENTS_INVALID");
}
const artifact = JSON.parse(await fs.readFile(artifactFile, "utf8"));
const identity = await verifyPackageContent({
  artifact,
  appPath,
  expectedVersion,
  expectedBuildVersion,
  expectedChannel,
});
process.stdout.write(JSON.stringify(identity));
