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
    source: "sunrise/master.png",
    sha256: "d97ba675a63d121ba0f8b6b9f4b7f3511f2a3b697b9ee623551baae80162ea1d",
  },
  {
    output: "farol-dev-mark.png",
    source: "sunrise/master.png",
    sha256: "d97ba675a63d121ba0f8b6b9f4b7f3511f2a3b697b9ee623551baae80162ea1d",
  },
  {
    output: "farol.icns",
    source: "sunrise/farol.icns",
    maxBytes: 1413163,
    sha256: "58a47e3db012eeec25f4cf3569c396a73c2b91c6e0347e99aa94c00f264aed5f",
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
