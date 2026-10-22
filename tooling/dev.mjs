#!/usr/bin/env node
import { productName } from "./harness-identity.ts";
import { desktopIdentity as harnessDesktopIdentity } from "./harness-identity.ts";
// The single development entrypoint for the product: find the declared
// toolchain, make sure dependencies are the locked ones, build the current
// development bytes, and run the product's own local processes in this terminal.
//
// This is deliberately not `task package` / `task run`, which build
// and verify an exact, committed candidate and refuse a stale or dirty one.
// Go-enabled Dev requires clean committed source and approved local inputs.
// Ctrl+C stops only what it started.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOwnerLaunchResultCollector } from "./owner-launch-result.mjs";
import { ownerLaunchEnvironment } from "./launch-snapshot.mjs";
import { readGoBuildInputs } from "./go-build-inputs.mjs";
import { parseDevDisplay } from "../src/apps/desktop/window-placement.ts";
import { DevRuntimeSignatureError, prepareDevRuntime } from "./dev-runtime.mjs";
import { prepareDevBuild } from "./dev-process-control.mjs";
import { resolvePhysicalDevDataDirectoryName } from "./harness-identity.ts";
import {
  dependencyDrift,
  readDependencyDigests,
  toolchainPackageRoots,
} from "./dependency-digests.mjs";

export const DECLARED_NODE_VERSIONS = Object.freeze(["24.20.0", "26.7.0"]);
export const DECLARED_NPM_VERSION = "11.19.0";
export const TOOLCHAIN_PINNED_ENV = "FAROL_DEV_TOOLCHAIN_PINNED";
export const DESKTOP_ENVIRONMENT_ENV = "FAROL_ENVIRONMENT";
export const OWNER_STOP_EXIT_CODE = 130;

const here = path.dirname(fileURLToPath(import.meta.url));
const vnextRoot = path.resolve(here, "..");
export const DEFAULT_GO_INPUTS_FILE = path.join(
  vnextRoot,
  "_output/go-build-inputs.json",
);

// ---------------------------------------------------------------------------
// Toolchain selection
// ---------------------------------------------------------------------------

export function isDeclaredToolchain(nodeVersion, npmVersion) {
  return (
    DECLARED_NODE_VERSIONS.includes(nodeVersion) &&
    npmVersion === DECLARED_NPM_VERSION
  );
}

/** The fixed places a declared Node/npm pair may already live on this Mac. */
export function candidateToolchainDirectories(home) {
  return [
    path.join(home ?? "", ".nvm/versions/node/v24.20.0/bin"),
    "/opt/homebrew/Cellar/node/26.7.0/bin",
    "/opt/homebrew/bin",
  ];
}

export function toolchainMissingMessage() {
  return (
    `${harnessDesktopIdentity("dev", "/").applicationName} needs Node ${DECLARED_NODE_VERSIONS.join(" or ")} with npm ${DECLARED_NPM_VERSION}, and none was found ` +
    "at the running interpreter or at the usual nvm/Homebrew locations. Install one, for example " +
    "'nvm install 24.20.0' or 'brew install node@26', then run 'task dev' again."
  );
}

/**
 * Decide which Node/npm pair to run under.
 *
 * `probe(dir)` is injected so tests can fake what lives at each candidate
 * directory without touching the real filesystem or spawning processes.
 */
export function resolveToolchain({
  currentNode,
  currentNpm,
  candidates,
  probe,
}) {
  if (isDeclaredToolchain(currentNode, currentNpm)) {
    return { status: "current" };
  }
  for (const directory of candidates) {
    const info = probe(directory);
    if (info && isDeclaredToolchain(info.nodeVersion, info.npmVersion)) {
      return {
        status: "found",
        binDir: directory,
        nodeBin: info.nodeBin,
        npmBin: info.npmBin,
      };
    }
  }
  return { status: "missing" };
}

function probeToolchainAt(directory) {
  const nodeBin = path.join(directory, "node");
  const npmBin = path.join(directory, "npm");
  if (!fs.existsSync(nodeBin) || !fs.existsSync(npmBin)) return null;
  const node = spawnSync(nodeBin, ["--version"], { encoding: "utf8" });
  const npm = spawnSync(npmBin, ["--version"], { encoding: "utf8" });
  if (node.status !== 0 || npm.status !== 0) return null;
  return {
    nodeBin,
    npmBin,
    nodeVersion: (node.stdout ?? "").trim().replace(/^v/u, ""),
    npmVersion: (npm.stdout ?? "").trim(),
  };
}

function currentNpmVersion() {
  const result = spawnSync("npm", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return (result.stdout ?? "").trim();
}

function signalExitCode(signal) {
  const numbers = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1, SIGQUIT: 3 };
  return 128 + (numbers[signal] ?? 1);
}

/** Re-exec this same script under a declared Node, relaying signals once. */
export async function reExecUnderDeclaredToolchain(target, argv) {
  const environment = {
    ...process.env,
    PATH: `${target.binDir}:${process.env.PATH ?? ""}`,
    [TOOLCHAIN_PINNED_ENV]: "1",
  };
  const child = spawn(
    target.nodeBin,
    [fileURLToPath(import.meta.url), ...argv],
    {
      stdio: "inherit",
      env: environment,
    },
  );
  let exited = false;
  const forward = (signal) => {
    // `child.killed` only means "a signal was sent at least once" - it does
    // not mean the process has actually exited - so it cannot gate repeated
    // forwarding across several owner Ctrl+C presses. `exited` tracks the
    // real thing instead.
    if (!exited) {
      try {
        child.kill(signal);
      } catch {
        // the child is already gone; nothing left to forward to.
      }
    }
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  const exitCode = await new Promise((resolve) => {
    child.once("error", () => {
      exited = true;
      resolve(1);
    });
    child.once("close", (code, signal) => {
      exited = true;
      resolve(signal ? signalExitCode(signal) : (code ?? 1));
    });
  });
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Dependency check
// ---------------------------------------------------------------------------

/**
 * Compare npm's own record of what is actually installed
 * (`node_modules/.package-lock.json`) against the committed lock. Pure, so
 * tests can exercise it with plain objects instead of a real node_modules.
 */
export function evaluateDependencies({ committedPackages, installedPackages }) {
  const reasons = [];
  for (const [key, entry] of Object.entries(installedPackages)) {
    if (key === "") continue;
    const wanted = committedPackages[key];
    if (!wanted) {
      reasons.push(`${key} is installed but not in package-lock.json`);
      continue;
    }
    if (wanted.version && entry.version && wanted.version !== entry.version) {
      reasons.push(
        `${key} is ${entry.version}, package-lock.json wants ${wanted.version}`,
      );
      continue;
    }
    if (
      wanted.integrity &&
      entry.integrity &&
      wanted.integrity !== entry.integrity
    ) {
      reasons.push(`${key} does not match the integrity in package-lock.json`);
    }
  }
  for (const [key, entry] of Object.entries(committedPackages)) {
    if (key === "" || entry.optional) continue;
    if (!installedPackages[key]) {
      reasons.push(`${key} is in package-lock.json but not installed`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export function readDependencyState(
  root,
  platform = process.platform,
  arch = process.arch,
) {
  const nodeModules = path.join(root, "node_modules");
  if (!fs.existsSync(nodeModules)) {
    return { ok: false, reasons: ["node_modules is missing"] };
  }
  const hiddenLockPath = path.join(nodeModules, ".package-lock.json");
  if (!fs.existsSync(hiddenLockPath)) {
    return {
      ok: false,
      reasons: ["node_modules has no npm-managed .package-lock.json"],
    };
  }
  const committedPackages =
    JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"))
      .packages ?? {};
  const installedPackages =
    JSON.parse(fs.readFileSync(hiddenLockPath, "utf8")).packages ?? {};
  const metadata = evaluateDependencies({
    committedPackages,
    installedPackages,
  });
  if (!metadata.ok) return metadata;

  // npm's hidden lock describes the installation, not its current bytes.
  // Reuse the builder's reviewed tree digests, including unexpected files,
  // rather than blessing local content or ignoring Finder metadata.
  const expected = readDependencyDigests(root);
  const compiler = toolchainPackageRoots(platform, arch);
  // Every manifest key is validated, including foreign-platform compiler
  // entries that this platform does not verify.
  if (
    ![...Object.keys(expected), ...compiler].every(
      (name) =>
        /^node_modules\/(?:@[^/]+\/)?[^/]+$/u.test(name) &&
        !name.split("/").some((part) => part === "." || part === ".."),
    )
  )
    throw new Error("DEV_DEPENDENCY_MANIFEST_INVALID");
  const roots = [
    ...Object.keys(expected).filter(
      (name) => !name.startsWith("node_modules/@esbuild/"),
    ),
    ...compiler,
  ];
  const reasons = dependencyDrift(root, roots, expected).map(
    ({ packageRoot, reason }) =>
      `${packageRoot} does not match reviewed bytes (${reason})`,
  );
  return { ok: reasons.length === 0, reasons };
}

function electronBinaryPresent(root) {
  return fs.existsSync(
    path.join(root, "node_modules/electron/dist/Electron.app"),
  );
}

/**
 * What needs to happen before the product can be built, given what is already on
 * disk. Pure — `dependencyState` and `electronPresent` are plain values, so
 * tests can drive every combination without a real node_modules.
 */
export function planDependencyActions({ dependencyState, electronPresent }) {
  return {
    needsInstall: !dependencyState.ok,
    needsElectronInstall: !electronPresent,
    reasons: dependencyState.reasons,
  };
}

/**
 * Carry out a dependency plan. `runNpmCi` and `runElectronInstall` are
 * injected so tests can prove each is (or is not) invoked without running a
 * real network install.
 */
export async function applyDependencyPlan(
  plan,
  {
    runNpmCi,
    runElectronInstall,
    electronPresent,
    verifyDependencies,
    log = () => {},
  },
) {
  if (plan.needsInstall) {
    log(
      `Dependencies are not the locked ones:\n${plan.reasons.map((r) => `  - ${r}`).join("\n")}\n` +
        "Running npm ci to match package-lock.json...",
    );
    const status = await runNpmCi();
    if (status !== 0) return status;
  }
  // npm ci replaces node_modules. Reobserve after it, since a previously
  // present Electron can disappear, or npm can already have installed it.
  const needsElectronInstall = electronPresent
    ? !(await electronPresent())
    : plan.needsElectronInstall;
  if (needsElectronInstall) {
    log(
      "Electron's own binary is missing (its postinstall did not run); fetching it now...",
    );
    const status = await runElectronInstall();
    if (status !== 0) return status;
  }
  // An installer exit code is not proof of repaired inputs. Never loop,
  // rewrite digests, launch, or let the Go builder consume unresolved drift.
  if (verifyDependencies) {
    const verified = await verifyDependencies();
    if (!verified.ok) {
      log(
        `Dependencies still fail verification after preparation:\n${verified.reasons.map((reason) => `  - ${reason}`).join("\n")}\n` +
          "No build or launch was attempted. Preserve the mismatch and repair the locked installation; do not refresh expected digests.",
      );
      return 1;
    }
  }
  if (electronPresent && !(await electronPresent())) {
    log(
      "Electron is still missing after preparation. No build or launch was attempted.",
    );
    return 1;
  }
  return 0;
}

function runInherited(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** The real wiring: read the actual filesystem, run the actual commands. */
async function ensureDependencies(root, npmBin, log) {
  const plan = planDependencyActions({
    dependencyState: readDependencyState(root),
    electronPresent: electronBinaryPresent(root),
  });
  return applyDependencyPlan(plan, {
    log,
    electronPresent: () => electronBinaryPresent(root),
    verifyDependencies: () => readDependencyState(root),
    runNpmCi: () =>
      runInherited(npmBin, ["ci", "--no-audit", "--no-fund"], { cwd: root }),
    runElectronInstall: () =>
      runInherited(
        process.execPath,
        [path.join(root, "node_modules/electron/install.js")],
        { cwd: root },
      ),
  });
}

// ---------------------------------------------------------------------------
// Signal escalation
// ---------------------------------------------------------------------------

const ESCALATION_SEQUENCE = Object.freeze(["SIGINT", "SIGTERM", "SIGKILL"]);
export const ESCALATION_MESSAGES = Object.freeze({
  SIGINT: `Stopping ${productName} (Ctrl+C)...`,
  SIGTERM: `${productName} did not stop; sending SIGTERM.`,
  SIGKILL: `${productName} still did not stop; forcing it with SIGKILL.`,
});

/** Each call returns the next signal to send, saturating at SIGKILL. */
export function createSignalEscalation(sequence = ESCALATION_SEQUENCE) {
  let index = 0;
  return {
    next() {
      const signal = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      return signal;
    },
  };
}

export function exitCodeForOwnerStop(stopLabel) {
  return stopLabel ? OWNER_STOP_EXIT_CODE : null;
}

// ---------------------------------------------------------------------------
// Second-instance handling
// ---------------------------------------------------------------------------

/** What to tell the owner once the launched process has announced itself. */
export function describeLaunchResult(outcome) {
  if (outcome === "primary-recovery") {
    return {
      exitCode: null,
      message: `${productName} opened in recovery mode. Previous work records are retained; Computer access is paused.`,
    };
  }
  if (outcome === "primary-started") {
    return { exitCode: null, message: null };
  }
  if (outcome === "reopened") {
    return {
      exitCode: 0,
      message: `${productName} is already running as this exact build; its existing window was reopened instead of starting a second copy.`,
    };
  }
  if (outcome === "startup-failed") {
    return {
      exitCode: 1,
      message: `${harnessDesktopIdentity("dev", "/").applicationName} main-process startup failed. The classified cause is above; fix it, then run 'task dev' again.`,
    };
  }
  return {
    exitCode: 1,
    message:
      `${productName} is already running as a different build (${outcome}); ` +
      "quit that instance yourself, then run 'task dev' again. It was left running untouched.",
  };
}

// ---------------------------------------------------------------------------
// Run a child in the foreground, forwarding owner Ctrl+C/SIGTERM with
// escalation. Split out from `launchPreview` so tests can drive it against a
// small fixture process and a fake signal source instead of real Electron
// and real OS signals.
// ---------------------------------------------------------------------------

/**
 * `signals` defaults to the real `process` but accepts any EventEmitter-like
 * object with `on`/`removeListener`, so a test can simulate repeated owner
 * Ctrl+C presses deterministically by calling `.emit("SIGINT")` on a fake.
 */
export async function runOwnerManagedChild({
  spawnChild,
  signals = process,
  log = (line) => process.stdout.write(`${line}\n`),
  relayOutput = true,
  schedule = (callback, delay) => setTimeout(callback, delay),
  clearScheduled = (timer) => clearTimeout(timer),
}) {
  const child = spawnChild();
  if (relayOutput) {
    child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  }
  const resultCollector = createOwnerLaunchResultCollector();
  let protocolError = null;
  child.stderr?.on("data", (chunk) => {
    if (relayOutput) process.stderr.write(chunk);
    if (protocolError) return;
    try {
      resultCollector.push(chunk);
    } catch (error) {
      protocolError = error;
    }
  });

  let stopLabel = null;
  let exited = false;
  const escalation = createSignalEscalation();
  let stopTimer;
  const onOwnerSignal = (signalName) => {
    if (!stopLabel) stopLabel = signalName === "SIGTERM" ? "SIGTERM" : "Ctrl+C";
    const toSend = escalation.next();
    log(ESCALATION_MESSAGES[toSend]);
    // `child.killed` only means "a signal was sent at least once successfully"
    // - Node sets it right after the first `kill()` call, whether or not the
    // process actually died - so it cannot gate the second and third steps
    // of the escalation. `exited` tracks the real thing: has the child's
    // 'close'/'error' event already fired.
    if (!exited) {
      try {
        child.kill(toSend);
      } catch {
        // already gone
      }
      if (stopTimer !== undefined) clearScheduled(stopTimer);
      if (toSend !== "SIGKILL") {
        stopTimer = schedule(
          () => onOwnerSignal(signalName),
          toSend === "SIGINT" ? 30000 : 2000,
        );
      }
    }
  };
  const onSigint = () => onOwnerSignal("SIGINT");
  const onSigterm = () => onOwnerSignal("SIGTERM");
  signals.on("SIGINT", onSigint);
  signals.on("SIGTERM", onSigterm);

  const outcome = await new Promise((resolve) => {
    child.once("error", (error) => {
      exited = true;
      resolve({ status: 1, signal: null, error });
    });
    child.once("close", (status, signal) => {
      exited = true;
      resolve({ status, signal });
    });
  });
  signals.removeListener("SIGINT", onSigint);
  signals.removeListener("SIGTERM", onSigterm);
  if (stopTimer !== undefined) clearScheduled(stopTimer);

  return { stopLabel, outcome, protocolError, resultCollector };
}

// A fresh review has a fixed namespace and a launcher-minted identity. It never
// accepts an owner path, HOME override, E2E seam, or a reusable acceptance root.
const REVIEW_NAMESPACE = `${harnessDesktopIdentity("dev", "/").applicationName} Review`;
const REVIEW_RECEIPT = ".farol-dev-review-profile";
const REVIEW_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function devGoBuildArguments(argv) {
  const selected = argv.filter((argument) =>
    argument.startsWith("--go-inputs"),
  );
  if (selected.length === 0) return [`--go-inputs=${DEFAULT_GO_INPUTS_FILE}`];
  const argument = selected[0];
  const file = argument.slice("--go-inputs=".length);
  if (
    selected.length !== 1 ||
    !argument.startsWith("--go-inputs=") ||
    file.includes("\0") ||
    !path.isAbsolute(file) ||
    path.resolve(file) !== file
  ) {
    throw new Error("DEV_GO_INPUTS_ARGUMENT_INVALID");
  }
  // The existing builder owns file parsing, SDK authentication and dirty-Go
  // refusal. Forward its one argument verbatim; never substitute local inputs.
  return [argument];
}

// Ordinary Dev uses the same authenticated Go producer as an explicit build.
// Missing or invalid local declarations refuse before compilation or launch;
// never turn an unavailable backend into a legacy-only desktop implicitly.
export async function runDevBuild(
  arguments_,
  {
    readInputs = readGoBuildInputs,
    run = (args) =>
      runInherited(process.execPath, ["tooling/build.mjs", ...args], {
        cwd: vnextRoot,
      }),
    report = (line) => process.stderr.write(`${line}\n`),
  } = {},
) {
  try {
    if (!(await readInputs(arguments_)))
      throw new Error("DEV_GO_INPUTS_REQUIRED");
  } catch {
    report(
      `${harnessDesktopIdentity("dev", "/").applicationName} requires a valid approved Go input declaration. Place it at ` +
        `${DEFAULT_GO_INPUTS_FILE} or select --go-inputs=/absolute/path.json. ` +
        "See docs/development/setup.md. No desktop was launched.",
    );
    return 1;
  }
  return run(arguments_);
}

function reviewDirectory(directory, privateMode) {
  const info = fs.lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0 ||
    (privateMode && (info.mode & 0o777) !== 0o700) ||
    fs.realpathSync(directory) !== directory
  ) {
    throw new Error("DEV_REVIEW_PROFILE_ROOT_UNSAFE");
  }
  return info;
}

export function createFreshReviewProfile(nativeAppData, token = randomUUID()) {
  if (
    !REVIEW_TOKEN.test(token) ||
    !path.isAbsolute(nativeAppData) ||
    path.resolve(nativeAppData) !== nativeAppData ||
    nativeAppData.includes("\0")
  ) {
    throw new Error("DEV_REVIEW_PROFILE_INVALID");
  }
  reviewDirectory(nativeAppData, false);
  const namespace = path.join(nativeAppData, REVIEW_NAMESPACE);
  const appData = path.join(namespace, token);
  try {
    try {
      fs.mkdirSync(namespace, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    reviewDirectory(namespace, true);
    // No recursive leaf creation, collision retry, reuse, or failure cleanup.
    fs.mkdirSync(appData, { mode: 0o700 });
    reviewDirectory(appData, true);
    fs.writeFileSync(path.join(appData, REVIEW_RECEIPT), token, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    // Preserve identity evidence even if a partial creation was refused.
    throw new Error(
      `DEV_REVIEW_PROFILE_CREATE_FAILED (review:${token}; appData: ${appData}): ${error.message}`,
      { cause: error },
    );
  }
  return Object.freeze({
    marker: `review:${token}`,
    appData,
    userData: harnessDesktopIdentity("dev", appData).userData,
  });
}

export function createOwnerFreshReviewProfile(
  environment = process.env,
  resolveSystemHome = () => os.userInfo().homedir,
  platform = process.platform,
) {
  if (platform !== "darwin")
    throw new Error("DEV_REVIEW_PROFILE_PLATFORM_INVALID");
  const home = ownerLaunchEnvironment(environment).HOME;
  // userInfo reads the account database; homedir would trust HOME itself.
  if (home !== resolveSystemHome())
    throw new Error("DEV_REVIEW_PROFILE_HOME_INVALID");
  return createFreshReviewProfile(
    path.join(home, "Library/Application Support"),
  );
}

/**
 * The environment the development preview is launched with.
 *
 * Built from a fixed key allowlist, exactly as `ownerLaunchEnvironment`
 * builds the packaged launcher's, rather than passed through from whoever
 * ran `task dev`. This entrypoint used to hand Electron `process.env`
 * whole, and it is the one product launcher that did: a shell that
 * happened to export `FAROL_E2E=1` and a seam value gave an ordinary
 * development launch the E2E fault seams — substituted file and directory
 * pickers, a fabricated model reply, live-task commit faults, and a
 * ChatGPT egress allowlist widened to a loopback origin. Nothing is
 * inherited now, so none of them can arrive by accident.
 *
 * PATH is this process's own declared Node followed by the same system
 * directories the packaged launcher pins, because `node_modules/.bin/
 * electron` is a `#!/usr/bin/env node` shim and must find the toolchain
 * dev.mjs resolved rather than whatever the caller's PATH held.
 *
 * The sealed E2E lanes are unaffected: they launch Electron through
 * Playwright's `electron.launch({ env })` with their own explicit
 * environment and never run through this entrypoint.
 */
export function devLaunchEnvironment(
  environment = process.env,
  nodeBinDirectory = path.dirname(process.execPath),
  acceptanceProfile = false,
  reviewMarker,
) {
  if (
    reviewMarker !== undefined &&
    (acceptanceProfile ||
      !reviewMarker.startsWith("review:") ||
      !REVIEW_TOKEN.test(reviewMarker.slice(7)))
  ) {
    throw new Error("DEV_REVIEW_PROFILE_INVALID");
  }
  const owned = ownerLaunchEnvironment(environment);
  if (reviewMarker !== undefined) delete owned.FAROL_SAVED_CHAT_PREVIEW;
  return {
    ...owned,
    PATH: `${nodeBinDirectory}:${owned.PATH}`,
    // Ordinary Dev owns its separate profile. Acceptance uses another isolated
    // profile, while both remain development builds rather than candidates.
    [DESKTOP_ENVIRONMENT_ENV]: "dev",
    ...(acceptanceProfile ? { FAROL_ACCEPTANCE_PROFILE: "1" } : {}),
    ...(reviewMarker !== undefined
      ? { FAROL_ACCEPTANCE_PROFILE: reviewMarker }
      : {}),
  };
}

// Keep the selected profile in the kernel-visible argv. The desktop validates
// this assertion against its independently selected userData before using it.
// A product-specific flag avoids Chromium creating state before fresh-review admission.
export function devLaunchProfile(
  acceptanceProfile = false,
  reviewMarker,
  home = os.userInfo().homedir,
) {
  if (
    reviewMarker !== undefined &&
    (acceptanceProfile ||
      !reviewMarker.startsWith("review:") ||
      !REVIEW_TOKEN.test(reviewMarker.slice(7)))
  )
    throw new Error("DEV_REVIEW_PROFILE_INVALID");
  const nativeAppData = path.join(home, "Library/Application Support");
  const appData =
    reviewMarker !== undefined
      ? path.join(nativeAppData, REVIEW_NAMESPACE, reviewMarker.slice(7))
      : acceptanceProfile
        ? path.join(
            nativeAppData,
            `${harnessDesktopIdentity("dev", "/").applicationName} Acceptance`,
          )
        : nativeAppData;
  return path.join(appData, resolvePhysicalDevDataDirectoryName(appData));
}

export async function launchPreview(
  root,
  spawnProcess = spawn,
  acceptanceProfile = false,
  secondaryDisplay = false,
  reviewMarker,
  displayOptions = {},
  prepareRuntime = prepareDevRuntime,
) {
  const electronBin = await prepareRuntime(root);
  const { stopLabel, outcome, protocolError, resultCollector } =
    await runOwnerManagedChild({
      spawnChild: () =>
        spawnProcess(
          electronBin,
          [
            path.join(root, "_output/build/app/main.cjs"),
            `--farol-dev-user-data-dir=${devLaunchProfile(acceptanceProfile, reviewMarker)}`,
            ...(displayOptions.devSecondaryDisplay === true
              ? ["--display=secondary"]
              : []),
            ...(displayOptions.devSecondaryDisplay !== true &&
            (acceptanceProfile ||
              secondaryDisplay ||
              displayOptions.builtInDisplayOnly === true)
              ? ["--preview-window-mode=secondary-visible"]
              : []),
            ...(displayOptions.builtInDisplayOnly === true
              ? ["--built-in-display-only"]
              : []),
            ...(displayOptions.allowPrimaryDisplay === true
              ? ["--allow-primary-display"]
              : []),
          ],
          {
            cwd: root,
            env: devLaunchEnvironment(
              process.env,
              path.dirname(process.execPath),
              acceptanceProfile,
              reviewMarker,
            ),
            stdio: ["inherit", "pipe", "pipe"],
          },
        ),
    });

  const ownerExitCode = exitCodeForOwnerStop(stopLabel);
  if (ownerExitCode !== null) {
    process.stdout.write(
      `${productName} stopped (${stopLabel}). Nothing else was touched.\n`,
    );
    process.exit(ownerExitCode);
  }

  if (outcome.error) {
    process.stderr.write(
      `${productName} could not be launched: ${outcome.error.message}\n`,
    );
    process.exit(1);
  }

  if (protocolError) {
    process.stderr.write(
      `${productName}'s launch could not be read: ${protocolError.message}\n`,
    );
    process.exit(1);
  }

  let launchResult;
  try {
    launchResult = resultCollector.finish();
  } catch (error) {
    process.stderr.write(
      `${productName} exited before it announced its launch result: ${error.message}\n`,
    );
    process.exit(outcome.status ?? 1);
  }

  const description = describeLaunchResult(launchResult);
  if (description.message) {
    process.stdout.write(`${description.message}\n`);
    process.exit(description.exitCode ?? 0);
  }

  if (outcome.signal) {
    process.stderr.write(
      `${productName} stopped unexpectedly (${outcome.signal}).\n`,
    );
    process.exit(1);
  }
  process.exit(outcome.status ?? 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * The default dependencies wire up the real filesystem, the real toolchain
 * and the real launch. Tests override the pieces they want to observe
 * (`ensureDependencies`, `runBuild`, `launch`, `reExec`, `exit`, ...) and
 * leave the rest as safe no-ops, so `main` itself stays the single place
 * that decides the order of operations and never needs to be duplicated.
 */
export async function main(argv, overrides = {}) {
  const {
    currentNode = process.versions.node,
    getCurrentNpmVersion = currentNpmVersion,
    candidates = candidateToolchainDirectories(process.env.HOME),
    probe = probeToolchainAt,
    reExec = reExecUnderDeclaredToolchain,
    pinned = process.env[TOOLCHAIN_PINNED_ENV] === "1",
    ensureDependencies: ensureDependenciesFn = () =>
      ensureDependencies(vnextRoot, "npm", log),
    runBuild = runDevBuild,
    prepareBuild = (options) =>
      prepareDevBuild({ root: vnextRoot, ...options, log }),
    createReviewProfile = createOwnerFreshReviewProfile,
    launch = (
      acceptanceProfile,
      secondaryDisplay,
      reviewMarker,
      displayOptions,
    ) =>
      launchPreview(
        vnextRoot,
        spawn,
        acceptanceProfile,
        secondaryDisplay,
        reviewMarker,
        displayOptions,
      ),
    log = (line) => process.stdout.write(`${line}\n`),
    logError = (line) => process.stderr.write(`${line}\n`),
    exit = (code) => process.exit(code),
  } = overrides;

  const launchDev = async (...args) => {
    try {
      await launch(...args);
    } catch (error) {
      if (!(error instanceof DevRuntimeSignatureError)) throw error;
      logError(error.message);
      exit(1);
    }
  };

  const checkOnly = argv.includes("--check");
  const acceptanceProfile = argv.includes("--acceptance-profile");
  const secondaryDisplay = argv.includes("--secondary-display");
  const displayOptions = {
    builtInDisplayOnly: argv.includes("--built-in-display-only"),
    allowPrimaryDisplay: argv.includes("--allow-primary-display"),
  };
  const reviewFlags = argv.filter((argument) =>
    argument.startsWith("--fresh-review-profile"),
  );
  const freshReview =
    reviewFlags.length === 1 && reviewFlags[0] === "--fresh-review-profile";
  let buildArguments;
  try {
    if (
      reviewFlags.length > 1 ||
      (reviewFlags.length === 1 && !freshReview) ||
      (freshReview && acceptanceProfile)
    )
      throw new Error("DEV_REVIEW_PROFILE_ARGUMENT_INVALID");
    if (parseDevDisplay(argv)) displayOptions.devSecondaryDisplay = true;
    buildArguments = devGoBuildArguments(argv);
  } catch (error) {
    logError(error.message);
    exit(1);
    return;
  }

  if (!pinned) {
    const decision = resolveToolchain({
      currentNode,
      currentNpm: getCurrentNpmVersion(),
      candidates,
      probe,
    });
    if (decision.status === "missing") {
      logError(toolchainMissingMessage());
      exit(1);
      return;
    }
    if (decision.status === "found") {
      await reExec(decision, argv);
      return;
    }
  }

  log(
    `${harnessDesktopIdentity("dev", "/").applicationName} toolchain: Node ${currentNode}, npm ${getCurrentNpmVersion()}.`,
  );

  // Close the exact prior Dev BEFORE dependency replacement or shared builds.
  // Check/review/acceptance do not stop the owner's ordinary profile.
  try {
    await prepareBuild({
      buildArguments,
      replace: !checkOnly && !freshReview && !acceptanceProfile,
    });
  } catch (error) {
    logError(error.message);
    exit(1);
    return;
  }
  const dependencyStatus = await ensureDependenciesFn();
  if (dependencyStatus !== 0) {
    exit(dependencyStatus);
    return;
  }

  log(
    "Building the current development bytes (this is not a candidate build)...",
  );
  const buildStatus = await runBuild(buildArguments);
  if (buildStatus !== 0) {
    exit(buildStatus);
    return;
  }

  if (checkOnly) {
    log(
      `${harnessDesktopIdentity("dev", "/").applicationName} check complete: toolchain, dependencies, and build are current. Not launching.`,
    );
    return;
  }

  if (freshReview) {
    let review;
    try {
      review = createReviewProfile();
    } catch (error) {
      logError(
        `Fresh review profile refused: ${error.message}. No launch or retry.`,
      );
      exit(1);
      return;
    }
    log(`Fresh Dev review identity: ${review.marker}`);
    log(`Fresh Dev review appData: ${review.appData}`);
    log(`Fresh Dev review userData/sessionData: ${review.userData}`);
    log(
      "Development bytes, not a packaged candidate. Profile retained; this opener cannot reopen it. No automatic retry or recovery.",
    );
    log(
      `Running ${harnessDesktopIdentity("dev", "/").applicationName} in this terminal. Press Ctrl+C to stop.`,
    );
    await launchDev(false, secondaryDisplay, review.marker, displayOptions);
    return;
  }
  log(
    `Running ${harnessDesktopIdentity("dev", "/").applicationName} in this terminal. Press Ctrl+C to stop.`,
  );
  await launchDev(
    acceptanceProfile,
    secondaryDisplay,
    undefined,
    displayOptions,
  );
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main(process.argv.slice(2));
}
