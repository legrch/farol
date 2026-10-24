import path from "node:path";

// A fixed launcher-owned resource layout, never a renderer/env-selected runtime.
// Packaged hosts keep their original resource root and all Shell attestation.
export function desktopCoreArtifactRoot(
  artifactRoot: string,
  environment: "dev" | "preview" | "owner-preview",
): string {
  if (
    !path.isAbsolute(artifactRoot) ||
    path.resolve(artifactRoot) !== artifactRoot
  )
    throw new Error("DEV_CORE_LAYOUT_INVALID");
  if (
    environment !== "dev" ||
    path.join(
      path.resolve(artifactRoot, "../../.."),
      "Contents/Resources/app",
    ) === artifactRoot
  )
    return artifactRoot;
  const output = path.resolve(artifactRoot, "../..");
  if (path.join(output, "build/app") !== artifactRoot)
    throw new Error("DEV_CORE_LAYOUT_INVALID");
  return path.join(output, "dev-core/Contents/Resources/app");
}
