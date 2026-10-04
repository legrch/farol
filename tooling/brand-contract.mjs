import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const BRAND_RESOURCES = Object.freeze([
  {
    output: "farol-mark.svg",
    sha256: "847406dda7c5311f3368767cd99666bcd22d2ed5a0a2451d41956339dd3aa533",
  },
  {
    output: "farol-dev-mark.svg",
    sha256: "9cf355aee04f7a171501f7891a56b086e6a214a403d4c2f7e4b468062a0af667",
  },
  {
    output: "farol-mark.png",
    source: "signal-color/master.png",
    sha256: "17655e603019d11a309ab94da781c3b39c000a45521bcd8bee6881d9b7b484d9",
  },
  {
    output: "farol-dev-mark.png",
    sha256: "2db2c0665c607501ce435110332f7e55190551fcdc1c1c612b26a95df28a616e",
  },
  {
    output: "farol.icns",
    source: "signal-color/farol.icns",
    maxBytes: 1137653,
    sha256: "5190df7cdfabf89a9481c1e66a5ccd1a924c2d94de47905f48b200a88d311919",
  },
]);

export async function verifyBrandAssets(directory, { source = false } = {}) {
  for (const resource of BRAND_RESOURCES) {
    const file = path.join(
      directory,
      source ? (resource.source ?? resource.output) : resource.output,
    );
    const info = await fs.lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 1 ||
      info.size > (resource.maxBytes ?? 1024 * 1024)
    )
      throw new Error(`BRAND_RESOURCE_TYPE_INVALID:${resource.output}`);
    if (
      createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex") !== resource.sha256
    )
      throw new Error(`BRAND_RESOURCE_DIGEST_MISMATCH:${resource.output}`);
  }
}
