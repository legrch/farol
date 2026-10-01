import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PRODUCT_APP_NAME } from "./package-layout.mjs";

const APP_NAME = PRODUCT_APP_NAME;
const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function textValue(value, fallback) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0")
    ? value
    : fallback;
}

export function ownerLaunchArguments(arguments_) {
  const allowed = new Set(["--demo", "--hidden"]);
  if (
    !Array.isArray(arguments_) ||
    arguments_.length > 2 ||
    new Set(arguments_).size !== arguments_.length ||
    !arguments_.every((argument) => allowed.has(argument))
  ) {
    throw new Error(
      "task run accepts only '--demo' and '--hidden', each at most once",
    );
  }
  return arguments_.flatMap((argument) =>
    argument === "--hidden"
      ? ["--preview-window-mode=hidden", "--owner-background-only"]
      : [argument],
  );
}

export function ownerLaunchEnvironment(environment = process.env) {
  const launchEnvironment = {
    HOME: textValue(environment.HOME, os.homedir()),
    LANG: textValue(environment.LANG, "en_US.UTF-8"),
    PATH: SAFE_PATH,
    TMPDIR: textValue(environment.TMPDIR, os.tmpdir()),
  };
  if (
    typeof environment.LC_ALL === "string" &&
    environment.LC_ALL.length > 0 &&
    !environment.LC_ALL.includes("\0")
  ) {
    launchEnvironment.LC_ALL = environment.LC_ALL;
  }
  // Deliberate per-launch owner opt-in for the account-writing saved-chat
  // preview. No other inherited Farol/E2E seam crosses this allowlist.
  if (environment.FAROL_NEXT_SAVED_CHAT_PREVIEW === "1") {
    launchEnvironment.FAROL_NEXT_SAVED_CHAT_PREVIEW = "1";
  }
  return launchEnvironment;
}

export async function createLaunchSnapshot({
  sourceApp,
  artifactBytes,
  artifactSha256,
  temporaryRoot = os.tmpdir(),
}) {
  if (
    path.basename(sourceApp) !== APP_NAME ||
    !(artifactBytes instanceof Uint8Array) ||
    !/^[a-f0-9]{64}$/u.test(artifactSha256)
  ) {
    throw new Error("LAUNCH_SNAPSHOT_INPUT_INVALID");
  }
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const prefix = `farol-next-launch-${artifactSha256.slice(0, 12)}-`;
  const root = await fs.mkdtemp(path.join(resolvedTemporaryRoot, prefix));
  const appPath = path.join(root, APP_NAME);
  const artifactFile = path.join(root, "artifact.json");
  try {
    await fs.chmod(root, 0o700);
    await fs.writeFile(artifactFile, artifactBytes, {
      flag: "wx",
      mode: 0o600,
    });
    await fs.cp(sourceApp, appPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    return Object.freeze({
      appPath,
      artifactFile,
      artifactSha256,
      prefix,
      root,
      temporaryRoot: resolvedTemporaryRoot,
    });
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function removeLaunchSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("LAUNCH_SNAPSHOT_CLEANUP_INVALID");
  }
  const expectedPrefix = `farol-next-launch-${snapshot.artifactSha256?.slice(0, 12)}-`;
  if (
    !/^[a-f0-9]{64}$/u.test(snapshot.artifactSha256 ?? "") ||
    snapshot.prefix !== expectedPrefix ||
    path.dirname(snapshot.root ?? "") !== snapshot.temporaryRoot ||
    !path.basename(snapshot.root ?? "").startsWith(expectedPrefix) ||
    snapshot.appPath !== path.join(snapshot.root ?? "", APP_NAME) ||
    snapshot.artifactFile !== path.join(snapshot.root ?? "", "artifact.json")
  ) {
    throw new Error("LAUNCH_SNAPSHOT_CLEANUP_INVALID");
  }
  try {
    const info = await fs.lstat(snapshot.root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("LAUNCH_SNAPSHOT_CLEANUP_INVALID");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await fs.rm(snapshot.root, { recursive: true, force: true });
}
