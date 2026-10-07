import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// Native children need resolved JavaScript imports, unlike the Vitest loader.
// Compile the exact production entrypoint and its dependencies without policy
// substitutes. The caller owns this disposable root and its cleanup; these
// bytes are a test fixture, not a packaged or installed product qualification.
export async function installedUpdateHelperModule(
  root: string,
): Promise<string> {
  const outfile = path.join(root, "installed-update-helper.mjs");
  await build({
    entryPoints: [
      path.resolve(
        "src/modules/release/infra/native/installed-update-helper.ts",
      ),
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
  });
  return pathToFileURL(outfile).href;
}
