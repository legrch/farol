import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const GEIST_VERSION = "1.7.2";

export const GEIST_RESOURCES = Object.freeze([
  Object.freeze({
    source: "design-lab/fonts/geist/Geist-Variable.woff2",
    output: "Geist-Variable.woff2",
    sha256: "a369fcf5628ea2aa4e1b9e2ec6a5b3624e365bda588e1f0f2f12b564f728fbb8",
  }),
  Object.freeze({
    source: "design-lab/fonts/geist/GeistMono-Variable.woff2",
    output: "GeistMono-Variable.woff2",
    sha256: "fba8f577f38a2bbcbe818efa6348dd58f36303a10b8737c42fefad275be563ab",
  }),
  Object.freeze({
    source: "design-lab/fonts/geist/OFL.txt",
    output: "Geist-OFL.txt",
    sha256: "930853ee1daa68554d9e35c8a9175affb74f699fad9a5da6ee5ebe76379d9137",
  }),
]);

async function digest(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`GEIST_RESOURCE_TYPE_INVALID:${path.basename(file)}`);
  }
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

export async function verifyGeistSources(root) {
  for (const resource of GEIST_RESOURCES) {
    if ((await digest(path.join(root, resource.source))) !== resource.sha256) {
      throw new Error(`GEIST_SOURCE_DIGEST_MISMATCH:${resource.output}`);
    }
  }
}

export async function verifyGeistBuild(root) {
  for (const resource of GEIST_RESOURCES) {
    if ((await digest(path.join(root, resource.output))) !== resource.sha256) {
      throw new Error(`GEIST_BUILD_DIGEST_MISMATCH:${resource.output}`);
    }
  }
}
