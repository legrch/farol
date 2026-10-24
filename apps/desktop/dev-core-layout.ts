import path from "node:path";

// Runtime composition always uses the resources it actually executes. Only the
// build producer may compute a different destination for a prepared Dev image.
export function desktopCoreArtifactRoot(
  artifactRoot: string,
  _environment: "dev" | "preview" | "owner-preview",
): string {
  if (
    !path.isAbsolute(artifactRoot) ||
    path.resolve(artifactRoot) !== artifactRoot
  )
    throw new Error("DEV_CORE_LAYOUT_INVALID");
  return artifactRoot;
}

export function desktopDevShellImageMatches(
  artifactRoot: string,
  executable: string,
): boolean {
  if (
    !path.isAbsolute(artifactRoot) ||
    path.resolve(artifactRoot) !== artifactRoot ||
    !path.isAbsolute(executable) ||
    path.resolve(executable) !== executable
  )
    return false;
  const image = path.resolve(artifactRoot, "../../..");
  return (
    path.basename(image) === "dev-core" &&
    path.basename(path.dirname(image)) === "_output" &&
    path.join(image, "Contents/Resources/app") === artifactRoot &&
    path.join(
      image,
      "Contents/Frameworks/Farol Dev.app/Contents/MacOS/Electron",
    ) === executable
  );
}
