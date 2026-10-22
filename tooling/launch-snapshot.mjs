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
  // preview. No other inherited the product/E2E seam crosses this allowlist.
  if (environment.FAROL_SAVED_CHAT_PREVIEW === "1") {
    launchEnvironment.FAROL_SAVED_CHAT_PREVIEW = "1";
  }
  return launchEnvironment;
}

// The exact descriptor objects `createLaunchSnapshot` returned in this process,
// each with the exact bundle paths it created (the product `.app` and the nested
// `.app` bundles, deepest first, real-path form). Module-private, so no caller
// can add to it: a descriptor that merely has the right fields, or a copy of an
// issued one, is not in it. The recorded paths let cleanup unregister a
// snapshot even when its directory was deleted before the launcher got there.
const issuedSnapshots = new WeakMap();

const NOT_ISSUED = "descriptor not issued by this process";

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
  const prefix = `farol-launch-${artifactSha256.slice(0, 12)}-`;
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
    const snapshot = Object.freeze({
      appPath,
      artifactFile,
      artifactSha256,
      prefix,
      root,
      temporaryRoot: resolvedTemporaryRoot,
    });
    const bundles = await snapshotBundlePaths(await fs.realpath(root), []);
    issuedSnapshots.set(snapshot, Object.freeze({ bundles }));
    return snapshot;
  } catch (error) {
    // Best effort: a failed delete must not replace the creation error.
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
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

// Measured 2026-10-21 on macOS 27.0.1 (26A434): `lsregister -u <path>` on a
// bundle LaunchServices has never registered exits 1, writes nothing to stdout,
// and writes exactly this to stderr, with no trailing newline:
//   failed to scan <path>: -10814\n from spotlight
// That is the state we want, so only that exact status and message count as
// "not registered". Any other exit status, verb, path, extra output or error
// code, even one that mentions -10814, is a failure and keeps its raw message.
function notRegisteredMessage(bundlePath) {
  return `failed to scan ${bundlePath}: -10814\n from spotlight`;
}

// Resolves `true` when the bundle is unregistered or was not registered;
// otherwise a string with the raw failure for the outcome's `errors`.
function runLsregisterUnregister(lsregister, bundlePath) {
  return new Promise((resolve) => {
    execFile(
      lsregister,
      ["-u", bundlePath],
      { env: { PATH: SAFE_PATH }, timeout: 15_000 },
      (error, stdout, stderr) => {
        if (error === null) return resolve(true);
        if (
          error.code === 1 &&
          stdout === "" &&
          stderr === notRegisteredMessage(bundlePath)
        ) {
          return resolve(true);
        }
        const output = `${stdout}${stderr}`.trim();
        resolve(
          `exit ${error.code ?? error.signal ?? "error"}: ${output || error.message}`,
        );
      },
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
// Invariant: every bundle path the walk finds ends in exactly one of
// `unregistered`, `failed` or `refused`; `errors` carries the diagnostics. A
// directory the walk could not read is named in `errors`. No branch returns
// with a found bundle unaccounted for.
//
// Private on purpose: it trusts `realRoot`, which only `removeLaunchSnapshot`
// supplies after validating the descriptor and resolving the real path. A path
// that does not resolve to itself inside `realRoot` is refused, not unregistered.
async function unregisterSnapshotBundles(realRoot, options, result) {
  const bundles = await snapshotBundlePaths(realRoot, result.errors);
  await unregisterBundlePaths(bundles, options, result, async (bundlePath) => {
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
    return (
      resolved === bundlePath && bundlePath.startsWith(`${realRoot}${path.sep}`)
    );
  });
}

// Shared by both entry points above. `verify`, when given, must approve each
// path before it is unregistered; the recorded paths of an issued descriptor
// need none, because this module recorded them itself.
async function unregisterBundlePaths(
  bundles,
  { lsregister = LSREGISTER, unregister = runLsregisterUnregister } = {},
  result,
  verify = null,
) {
  if (bundles.length === 0) return;
  try {
    await fs.access(lsregister);
  } catch (error) {
    // Without the tool nothing can be unregistered: say so once, and account
    // for every bundle the walk found instead of returning with it unreported.
    result.errors.push(
      `${lsregister}: ${error?.code ?? error?.message ?? "not accessible"}`,
    );
    result.failed.push(...bundles);
    return;
  }
  for (const bundlePath of bundles) {
    if (verify && !(await verify(bundlePath))) {
      result.refused.push(bundlePath);
      continue;
    }
    try {
      // `true` is success; anything else is a failure, and a string is its raw
      // message, kept in `errors` next to the path.
      const done = await unregister(lsregister, bundlePath);
      if (done === true) {
        result.unregistered.push(bundlePath);
      } else {
        result.failed.push(bundlePath);
        if (typeof done === "string" && done !== "") {
          result.errors.push(`${bundlePath}: ${done}`);
        }
      }
    } catch (error) {
      result.failed.push(bundlePath);
      result.errors.push(
        `${bundlePath}: ${error?.message ?? "unregister failed"}`,
      );
    }
  }
}

function emptyOutcome() {
  return {
    unregistered: [],
    failed: [],
    refused: [],
    errors: [],
    removed: false,
    rootMissing: false,
  };
}

// The validated root is already gone (something deleted it before the launcher's
// cleanup ran), which leaves LaunchServices' records behind. An issued
// descriptor still unregisters the exact bundle paths recorded when it was
// created; an unissued one is refused. Never a silent success: `removed` is
// false and `errors` names the missing root.
async function cleanUpMissingRoot(snapshot, options) {
  const outcome = emptyOutcome();
  outcome.rootMissing = true;
  outcome.errors.push(`snapshot root already gone: ${snapshot.root}`);
  const record = issuedSnapshots.get(snapshot);
  if (record === undefined) {
    outcome.refused.push(NOT_ISSUED);
    return outcome;
  }
  try {
    await unregisterBundlePaths(record.bundles, options, outcome);
  } catch (error) {
    outcome.errors.push(error?.message ?? "unregister failed");
  }
  return outcome;
}

// Validation first: a descriptor that does not name an owned snapshot, or a
// root that is a symlink or does not resolve directly under its temporary root,
// throws `LAUNCH_SNAPSHOT_CLEANUP_INVALID` (or the underlying fs error) before
// any side effect, because it guards against deleting the wrong directory.
// Once validation has passed this function never throws: the walk, the tool
// check, each unregister and the final delete are best effort, and every
// failure comes back in the outcome (`errors`, `failed`, `refused`, and
// `removed: false` when the directory is still there). A root that is already
// missing is not a success: see `cleanUpMissingRoot`.
//
// Unregistering from LaunchServices happens only for a descriptor this process
// got from `createLaunchSnapshot`. A shape-valid descriptor that was not issued
// here makes no lsregister call and is reported as `refused`. Deleting is
// deliberately unchanged for it: the validated directory is still removed, so
// cleanup of a snapshot left by another process keeps working. The only
// repository caller, `run-preview`, always passes the descriptor it created.
export async function removeLaunchSnapshot(snapshot, options) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("LAUNCH_SNAPSHOT_CLEANUP_INVALID");
  }
  const expectedPrefix = `farol-launch-${snapshot.artifactSha256?.slice(0, 12)}-`;
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
    if (error?.code === "ENOENT") return cleanUpMissingRoot(snapshot, options);
    throw error;
  }
  const outcome = emptyOutcome();
  if (issuedSnapshots.has(snapshot)) {
    try {
      await unregisterSnapshotBundles(realRoot, options, outcome);
    } catch (error) {
      outcome.errors.push(error?.message ?? "unregister failed");
    }
  } else {
    outcome.refused.push(NOT_ISSUED);
  }
  try {
    await fs.rm(snapshot.root, { recursive: true, force: true });
    outcome.removed = true;
  } catch (error) {
    outcome.errors.push(
      `remove ${snapshot.root}: ${error?.code ?? error?.message ?? "failed"}`,
    );
  }
  return outcome;
}

// The launcher's cleanup step. It reports on stderr and never throws or sets an
// exit status: cleaning up must not change what the launch itself did. A
// descriptor refused by validation is reported too, and nothing is deleted.
export async function finishLaunchSnapshot(
  snapshot,
  {
    remove = removeLaunchSnapshot,
    write = (text) => process.stderr.write(text),
  } = {},
) {
  const problems = [];
  try {
    const outcome = await remove(snapshot);
    if (outcome.failed.length > 0) {
      problems.push(`not unregistered: ${outcome.failed.join(", ")}`);
    }
    if (outcome.refused.length > 0) {
      problems.push(`refused: ${outcome.refused.join(", ")}`);
    }
    problems.push(...outcome.errors);
    if (outcome.removed !== true && outcome.rootMissing !== true)
      problems.push("snapshot directory not removed");
  } catch (error) {
    problems.push(`cleanup refused: ${error?.message ?? "unknown failure"}`);
  }
  if (problems.length > 0) {
    try {
      write(`launch snapshot cleanup problems: ${problems.join("; ")}\n`);
    } catch {
      // Nowhere left to report; the launch outcome still stands.
    }
  }
}
