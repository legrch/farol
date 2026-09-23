#!/usr/bin/env node
// The single development entrypoint for Farol Next: find the declared
// toolchain, make sure dependencies are the locked ones, build the current
// development bytes, and run Farol's own local processes in this terminal.
//
// This is deliberately not `task next:package` / `task next:run`, which build
// and verify an exact, committed candidate and refuse a stale or dirty one.
// This command builds whatever is on disk right now, including uncommitted
// changes, and says so plainly. Ctrl+C stops only what it started.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOwnerLaunchResultCollector } from "./owner-launch-result.mjs";
import { ownerLaunchEnvironment } from "./launch-snapshot.mjs";

export const DECLARED_NODE_VERSIONS = Object.freeze(["24.20.0", "26.7.0"]);
export const DECLARED_NPM_VERSION = "11.19.0";
export const TOOLCHAIN_PINNED_ENV = "FAROL_DEV_TOOLCHAIN_PINNED";
export const DESKTOP_ENVIRONMENT_ENV = "FAROL_NEXT_ENVIRONMENT";
export const OWNER_STOP_EXIT_CODE = 130;

const here = path.dirname(fileURLToPath(import.meta.url));
const vnextRoot = path.resolve(here, "..");

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
    `Farol Dev needs Node ${DECLARED_NODE_VERSIONS.join(" or ")} with npm ${DECLARED_NPM_VERSION}, and none was found ` +
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

function readDependencyState(root) {
  const nodeModules = path.join(root, "node_modules");
  if (!fs.existsSync(nodeModules)) {
    return { ok: false, reasons: ["vnext/node_modules is missing"] };
  }
  const hiddenLockPath = path.join(nodeModules, ".package-lock.json");
  if (!fs.existsSync(hiddenLockPath)) {
    return {
      ok: false,
      reasons: ["vnext/node_modules has no npm-managed .package-lock.json"],
    };
  }
  const committedPackages =
    JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"))
      .packages ?? {};
  const installedPackages =
    JSON.parse(fs.readFileSync(hiddenLockPath, "utf8")).packages ?? {};
  return evaluateDependencies({ committedPackages, installedPackages });
}

function electronBinaryPresent(root) {
  return fs.existsSync(
    path.join(root, "node_modules/electron/dist/Electron.app"),
  );
}

/**
 * What needs to happen before Farol can be built, given what is already on
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
  { runNpmCi, runElectronInstall, log = () => {} },
) {
  if (plan.needsInstall) {
    log(
      `Dependencies are not the locked ones:\n${plan.reasons.map((r) => `  - ${r}`).join("\n")}\n` +
        "Running npm ci to match vnext/package-lock.json...",
    );
    const status = await runNpmCi();
    if (status !== 0) return status;
  }
  // npm 11 can skip Electron's own postinstall, so this is checked
  // unconditionally, even when the lockfile comparison above found nothing
  // to do.
  if (plan.needsElectronInstall) {
    log(
      "Electron's own binary is missing (its postinstall did not run); fetching it now...",
    );
    const status = await runElectronInstall();
    if (status !== 0) return status;
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
  SIGINT: "Stopping Farol (Ctrl+C)...",
  SIGTERM: "Farol did not stop; sending SIGTERM.",
  SIGKILL: "Farol still did not stop; forcing it with SIGKILL.",
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
  if (outcome === "primary-started") {
    return { exitCode: null, message: null };
  }
  if (outcome === "reopened") {
    return {
      exitCode: 0,
      message:
        "Farol Next is already running as this exact build; its existing window was reopened instead of starting a second copy.",
    };
  }
  if (outcome === "startup-failed") {
    return {
      exitCode: 1,
      message:
        "Farol Dev main-process startup failed. The classified cause is above; fix it, then run 'task dev' again.",
    };
  }
  return {
    exitCode: 1,
    message:
      `Farol Next is already running as a different build (${outcome}); ` +
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

  return { stopLabel, outcome, protocolError, resultCollector };
}

/**
 * The environment the development preview is launched with.
 *
 * Built from a fixed key allowlist, exactly as `ownerLaunchEnvironment`
 * builds the packaged launcher's, rather than passed through from whoever
 * ran `task dev`. This entrypoint used to hand Electron `process.env`
 * whole, and it is the one Farol Next launcher that did: a shell that
 * happened to export `FAROL_NEXT_E2E=1` and a seam value gave an ordinary
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
) {
  const owned = ownerLaunchEnvironment(environment);
  return {
    ...owned,
    PATH: `${nodeBinDirectory}:${owned.PATH}`,
    // This value is app-owned, not inherited. It selects the persistent DEV
    // identity before Electron takes its instance lock or opens any state.
    [DESKTOP_ENVIRONMENT_ENV]: "dev",
    ...(acceptanceProfile ? { FAROL_NEXT_ACCEPTANCE_PROFILE: "1" } : {}),
  };
}

export async function launchPreview(
  root,
  spawnProcess = spawn,
  acceptanceProfile = false,
) {
  const electronBin = path.join(root, "node_modules/.bin/electron");
  const { stopLabel, outcome, protocolError, resultCollector } =
    await runOwnerManagedChild({
      spawnChild: () =>
        spawnProcess(
          electronBin,
          [
            "dist/app/main.cjs",
            ...(acceptanceProfile
              ? ["--preview-window-mode=secondary-visible"]
              : []),
          ],
          {
            cwd: root,
            env: devLaunchEnvironment(
              process.env,
              path.dirname(process.execPath),
              acceptanceProfile,
            ),
            stdio: ["inherit", "pipe", "pipe"],
          },
        ),
    });

  const ownerExitCode = exitCodeForOwnerStop(stopLabel);
  if (ownerExitCode !== null) {
    process.stdout.write(
      `Farol stopped (${stopLabel}). Nothing else was touched.\n`,
    );
    process.exit(ownerExitCode);
  }

  if (outcome.error) {
    process.stderr.write(
      `Farol could not be launched: ${outcome.error.message}\n`,
    );
    process.exit(1);
  }

  if (protocolError) {
    process.stderr.write(
      `Farol's launch could not be read: ${protocolError.message}\n`,
    );
    process.exit(1);
  }

  let launchResult;
  try {
    launchResult = resultCollector.finish();
  } catch (error) {
    process.stderr.write(
      `Farol exited before it announced its launch result: ${error.message}\n`,
    );
    process.exit(outcome.status ?? 1);
  }

  const description = describeLaunchResult(launchResult);
  if (description.message) {
    process.stdout.write(`${description.message}\n`);
    process.exit(description.exitCode ?? 0);
  }

  if (outcome.signal) {
    process.stderr.write(`Farol stopped unexpectedly (${outcome.signal}).\n`);
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
    runBuild = () =>
      runInherited(process.execPath, ["tooling/build.mjs"], { cwd: vnextRoot }),
    launch = (acceptanceProfile) =>
      launchPreview(vnextRoot, spawn, acceptanceProfile),
    log = (line) => process.stdout.write(`${line}\n`),
    logError = (line) => process.stderr.write(`${line}\n`),
    exit = (code) => process.exit(code),
  } = overrides;

  const checkOnly = argv.includes("--check");
  const acceptanceProfile = argv.includes("--acceptance-profile");

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
    `Farol Dev toolchain: Node ${currentNode}, npm ${getCurrentNpmVersion()}.`,
  );

  const dependencyStatus = await ensureDependenciesFn();
  if (dependencyStatus !== 0) {
    exit(dependencyStatus);
    return;
  }

  log(
    "Building the current development bytes (this is not a candidate build)...",
  );
  const buildStatus = await runBuild();
  if (buildStatus !== 0) {
    exit(buildStatus);
    return;
  }

  if (checkOnly) {
    log(
      "Farol Dev check complete: toolchain, dependencies, and build are current. Not launching.",
    );
    return;
  }

  log("Running Farol Dev in this terminal. Press Ctrl+C to stop.");
  await launch(acceptanceProfile);
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main(process.argv.slice(2));
}
