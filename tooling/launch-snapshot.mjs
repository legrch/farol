import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PRODUCT_APP_NAME } from "./package-layout.mjs";

const APP_NAME = PRODUCT_APP_NAME;
const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

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

// Every `*.app` inside the snapshot (the product bundle, `Electron Runtime.app`
// and its helpers), deepest first, as exact paths. Symlinks are not followed.
// Best effort: a directory that vanishes mid-walk is skipped, and any other
// read error is recorded in `errors` while the walk continues elsewhere.
async function snapshotBundlePaths(directory, errors, found = []) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      errors.push(
        `${directory}: ${error?.code ?? error?.message ?? "read failed"}`,
      );
    }
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(directory, entry.name);
    await snapshotBundlePaths(entryPath, errors, found);
    if (entry.name.endsWith(".app")) found.push(entryPath);
  }
  return found;
}

// `lsregister -u` exits 1 with -10814 for a bundle LaunchServices has no record
// of (a helper the run never started). That is the state we want, not a failure.
const NOT_REGISTERED = /-10814/u;

function runLsregisterUnregister(lsregister, bundlePath) {
  return new Promise((resolve) => {
    execFile(
      lsregister,
      ["-u", bundlePath],
      { env: { PATH: SAFE_PATH }, timeout: 15_000 },
      (error, stdout, stderr) =>
        resolve(error === null || NOT_REGISTERED.test(`${stdout}${stderr}`)),
    );
  });
}

// Running a bundle out of the snapshot makes LaunchServices register it, and
// its nested helper bundles, under the production bundle identifier; deleting
// the directory does not unregister them. Unregister each exact path the
// snapshot owns before the directory goes away. Never a prefix or global
// unregister, and strictly best effort: nothing here may throw, because the
// snapshot must be deleted and the launch outcome must not depend on it.
//
// Private on purpose: it trusts `realRoot`, which only `removeLaunchSnapshot`
// supplies after validating the descriptor and resolving the real path. A path
// that does not resolve to itself inside `realRoot` is refused, not unregistered.
async function unregisterSnapshotBundles(
  realRoot,
  { lsregister = LSREGISTER, unregister = runLsregisterUnregister } = {},
  result,
) {
  const bundles = await snapshotBundlePaths(realRoot, result.errors);
  if (bundles.length === 0) return;
  try {
    await fs.access(lsregister);
  } catch {
    return;
  }
  for (const bundlePath of bundles) {
    let resolved = null;
    try {
      resolved = await fs.realpath(bundlePath);
    } catch {
      // Gone or unreadable: not a path this run can vouch for.
    }
    // The resolve-then-unregister window is not closed against a concurrent
    // rewrite, deliberately: exploiting it needs a same-uid process able to
    // modify this private 0700 snapshot, and such a process can already run
    // `lsregister -u` on any path itself, so no privilege boundary is crossed.
    // This check stops an accidental foreign path, not a same-user attacker.
    if (
      resolved !== bundlePath ||
      !bundlePath.startsWith(`${realRoot}${path.sep}`)
    ) {
      result.refused.push(bundlePath);
      continue;
    }
    try {
      ((await unregister(lsregister, bundlePath))
        ? result.unregistered
        : result.failed
      ).push(bundlePath);
    } catch (error) {
      result.errors.push(
        `${bundlePath}: ${error?.message ?? "unregister failed"}`,
      );
    }
  }
}

function emptyOutcome() {
  return { unregistered: [], failed: [], refused: [], errors: [] };
}

export async function removeLaunchSnapshot(snapshot, options) {
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
  let realRoot;
  try {
    const info = await fs.lstat(snapshot.root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("LAUNCH_SNAPSHOT_CLEANUP_INVALID");
    }
    realRoot = await fs.realpath(snapshot.root);
    const realTemporaryRoot = await fs.realpath(snapshot.temporaryRoot);
    if (
      realRoot !== path.join(realTemporaryRoot, path.basename(snapshot.root))
    ) {
      throw new Error("LAUNCH_SNAPSHOT_CLEANUP_INVALID");
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return emptyOutcome();
    }
    throw error;
  }
  const outcome = emptyOutcome();
  try {
    await unregisterSnapshotBundles(realRoot, options, outcome);
  } catch (error) {
    outcome.errors.push(error?.message ?? "unregister failed");
  } finally {
    await fs.rm(snapshot.root, { recursive: true, force: true });
  }
  return outcome;
}
