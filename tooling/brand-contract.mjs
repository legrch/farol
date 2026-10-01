import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const BRAND_RESOURCES = Object.freeze([
  {
    output: "farol-mark.svg",
    sha256: "fc0daa315c24ed389a4755f2af115a2a79d514d3db6ae87a71ebfbc23a035be3",
  },
  {
    output: "farol-dev-mark.svg",
    sha256: "6982704b2df988af9ce023463c1a4ecf9680789e59c237b65e5ccea8e4801df1",
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
