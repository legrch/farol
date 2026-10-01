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
    sha256: "08a612b70b24e38e52c26c75c1a2bb8001e6755b0f2d17ce24c57179cba1a1e0",
  },
  {
    output: "farol-dev-mark.png",
    sha256: "2db2c0665c607501ce435110332f7e55190551fcdc1c1c612b26a95df28a616e",
  },
  {
    output: "farol.icns",
    sha256: "61722544638e8d017969b9c88edb69a0f4dcd6763e31d1e9f8122835e9b2e2d6",
  },
]);

export async function verifyBrandAssets(directory) {
  for (const resource of BRAND_RESOURCES) {
    const file = path.join(directory, resource.output);
    const info = await fs.lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 1 ||
      info.size > 1024 * 1024
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
