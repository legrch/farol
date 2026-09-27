import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Disposable direct-MCP fixtures do not run Desktop's connector.start. Give
// their exact launch bytes the same prepared identity before opening stdio.
export async function prepareMcpLifecycle(launchFile) {
  const digest = createHash("sha256")
    .update(await fs.readFile(launchFile))
    .digest("hex");
  const directory = path.join(path.dirname(launchFile), "mcp-lifecycle");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const marker = path.join(directory, `prepared-${digest}`);
  await fs
    .writeFile(marker, "1\n", { flag: "wx", mode: 0o600 })
    .catch(async (error) => {
      if (
        error.code !== "EEXIST" ||
        (await fs.readFile(marker, "utf8")) !== "1\n"
      )
        throw error;
    });
  return digest;
}
