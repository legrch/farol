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
    source: "sunrise-dock/farol-sunrise.png",
    sha256: "f39686f1a403a2467ada335b57465c18a8d0e3fb24481cbc7afdfb8e183b933a",
  },
  {
    output: "farol-dev-mark.png",
    source: "sunrise-dock/farol-sunrise-dev.png",
    sha256: "df215365ee0e57768fb6c42e44c26822ea44c61e1a779e4166597936ef1ab94d",
  },
  {
    output: "farol.icns",
    source: "sunrise-dock/farol-sunrise.icns",
    maxBytes: 1517952,
    sha256: "5f224ce9c647a279cea50d109edbe6aca5cb264b0017efc62280bb47d664a2a1",
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
