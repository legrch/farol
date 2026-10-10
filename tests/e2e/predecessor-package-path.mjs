import path from "node:path";
import fs from "node:fs/promises";

const PACKAGE_LAYOUTS = new Set(["dist/package", "_output/package"]);

export function predecessorPackagePaths(artifactFile, manifest) {
  // Predecessor generations are historical constants, not the target's
  // package acceptance policy. All generations keep the same launcher.
  const appName =
    manifest?.schema === 5
      ? "Farol Next Preview.app"
      : manifest?.schema === 6 || manifest?.schema === 7
        ? "Farol.app"
        : null;
  if (appName === null) {
    throw new Error("E2E_PREDECESSOR_MANIFEST_SCHEMA");
  }
  const appPath = manifest.artifactPath;
  if (
    typeof artifactFile !== "string" ||
    typeof appPath !== "string" ||
    !path.isAbsolute(artifactFile) ||
    !path.isAbsolute(appPath) ||
    artifactFile !== path.resolve(artifactFile) ||
    appPath !== path.resolve(appPath)
  ) {
    throw new Error("E2E_PREDECESSOR_PATH_NOT_CANONICAL");
  }
  const packageRoot = path.dirname(appPath);
  const checkoutRoot = path.dirname(path.dirname(packageRoot));
  const relative = path
    .relative(checkoutRoot, packageRoot)
    .split(path.sep)
    .join("/");
  if (path.basename(appPath) !== appName || !PACKAGE_LAYOUTS.has(relative)) {
    throw new Error("E2E_PREDECESSOR_PATH_NOT_CANONICAL");
  }
  if (path.resolve(artifactFile) !== path.join(packageRoot, "artifact.json")) {
    throw new Error("E2E_PREDECESSOR_MANIFEST_NOT_CANONICAL");
  }
  return {
    checkoutRoot,
    packageRoot,
    executable: path.join(appPath, "Contents/MacOS/Farol Next Preview"),
  };
}

export async function latestPredecessorDirectory(checkoutRoot) {
  const candidates = [];
  for (const root of [
    path.join(checkoutRoot, "_output", "evidence", "predecessors"),
    path.join(checkoutRoot, "artifacts", "predecessors"),
  ]) {
    let names;
    try {
      names = await fs.readdir(root);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const name of names) {
      try {
        const manifest = JSON.parse(
          await fs.readFile(path.join(root, name, "artifact.json"), "utf8"),
        );
        if (manifest.schema === 5 && typeof manifest.builtAt === "string") {
          candidates.push({
            directory: path.join(root, name),
            builtAt: manifest.builtAt,
          });
        }
      } catch {
        // A predecessor without a readable manifest is not identified.
      }
    }
  }
  candidates.sort((left, right) =>
    left.builtAt < right.builtAt ? -1 : left.builtAt > right.builtAt ? 1 : 0,
  );
  return candidates.at(-1)?.directory ?? null;
}
