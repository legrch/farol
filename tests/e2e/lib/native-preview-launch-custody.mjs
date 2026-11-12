// Test-only custody for a packaged Go launcher and its one Electron child.
// Native observations are read-only and never authorize a signal, repair, or
// another launch. An unknown process/stream keeps the disposable root held.
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readProcessStart } from "../../../src/apps/desktop/run-marker.ts";
import { readOwnedChildProcesses } from "../runtime-process.mjs";
import { desktopIdentity } from "../../../src/apps/desktop/desktop-environment.ts";
import {
  nativeExecutableWitness,
  qualifyDesktopMain,
  qualifyGuardianAfterExec,
  collectDesktopExit,
  requireDesktopExit,
} from "./desktop-main-identity.mjs";

const refuse = (code) => new Error(`NATIVE_ISOLATION_${code}`);
const live = (child) =>
  child instanceof ChildProcess &&
  Number.isSafeInteger(child.pid) &&
  child.pid > 1 &&
  child.exitCode === null &&
  child.signalCode === null;

// Only a real .app/Contents/MacOS launch path selects the dual-PID contract.
// Standalone/dev Electron keeps the original direct-child contract.
export function packagedNativePaths(executablePath) {
  if (typeof executablePath !== "string" || !path.isAbsolute(executablePath))
    return null;
  const macos = path.dirname(executablePath);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  if (
    path.basename(macos) !== "MacOS" ||
    path.basename(contents) !== "Contents" ||
    path.basename(bundle) !==
      `${desktopIdentity("preview", "/").applicationName}.app` ||
    path.basename(executablePath) !== path.basename(bundle, ".app")
  )
    return null;
  return Object.freeze({
    guardian: path.join(contents, "Resources/app/farol-backend"),
    desktop: path.join(
      contents,
      "Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
    ),
  });
}

// Pure contract used by deterministic tests; the native adapter below supplies
// all facts from the same retained ChildProcess and actual kernel observations.
export function qualifyNativePreviewPair({
  launcherPath,
  launcherPid,
  marker,
  desktop,
  children,
  guardianBefore,
  guardianAfter,
  desktopBefore,
  desktopAfter,
}) {
  const paths = packagedNativePaths(launcherPath);
  if (!paths) throw refuse("PACKAGED_LAUNCHER_UNQUALIFIED");
  if (desktop?.pid === launcherPid)
    throw refuse("PACKAGED_GUARDIAN_IS_DESKTOP");
  let identity;
  try {
    identity = qualifyDesktopMain({
      packaged: true,
      guardianPid: launcherPid,
      marker,
      desktop,
      children,
      expectedExecutable: paths.desktop,
      nativeExecutableBefore: desktopBefore,
      nativeExecutable: desktopAfter,
    });
    qualifyGuardianAfterExec({
      before: guardianBefore,
      after: guardianAfter,
      expectedExecutable: paths.guardian,
    });
  } catch (error) {
    throw refuse("PROCESS_PAIR_UNQUALIFIED");
  }
  return Object.freeze(identity);
}

// Exact first kernel sampling before a process can be treated as the owner of
// Chromium singleton or relay. processStart is deliberately compared against
// the original on-disk Electron run marker, not inferred from a later PID.
export function captureNativePreviewPair(
  launch,
  actual,
  child,
  marker,
  observed,
) {
  if (!live(child) || !observed || !child.stderr)
    throw refuse("PACKAGED_CHILD_UNOWNED");
  if (
    !Number.isSafeInteger(actual?.pid) ||
    actual.pid <= 1 ||
    actual.pid === child.pid ||
    typeof marker?.processStart !== "string" ||
    !marker.processStart ||
    marker.pid !== actual.pid ||
    typeof observed.launcherStart !== "string" ||
    !observed.launcherStart ||
    observed.desktopStart !== marker.processStart
  )
    throw refuse("PROCESS_PAIR_UNQUALIFIED");
  const identity = qualifyNativePreviewPair({
    launcherPath: launch.executablePath,
    launcherPid: child.pid,
    marker,
    desktop: {
      pid: actual.pid,
      ppid: observed.desktopBefore?.parentPid,
      executable: observed.desktopBefore?.executable,
    },
    children: observed.children,
    guardianBefore: observed.guardianBefore,
    guardianAfter: observed.guardianAfter,
    desktopBefore: observed.desktopBefore,
    desktopAfter: observed.desktopAfter,
  });
  return Object.freeze({
    child,
    identity,
    launcherStart: observed.launcherStart,
    guardianNative: observed.guardianAfter,
    desktopNative: observed.desktopAfter,
    desktopStart: observed.desktopStart,
    marker,
    desktopExit: collectDesktopExit(child.stderr),
  });
}

function observePair(pair) {
  const child = pair.child;
  if (!live(child)) throw refuse("PACKAGED_CHILD_NOT_LIVE");
  const guardian = nativeExecutableWitness(child.pid);
  const desktop = nativeExecutableWitness(pair.identity.desktopPid);
  if (
    !isDeepStrictEqual(guardian, pair.guardianNative) ||
    !isDeepStrictEqual(desktop, pair.desktopNative) ||
    readProcessStart(child.pid) !== pair.launcherStart ||
    readProcessStart(pair.identity.desktopPid) !== pair.desktopStart
  )
    throw refuse("PROCESS_PAIR_CHANGED");
  const children = readOwnedChildProcesses(child.pid);
  const matches = children.filter(
    (entry) =>
      entry.pid === pair.identity.desktopPid &&
      entry.parentPid === child.pid &&
      entry.processStart === pair.desktopStart,
  );
  if (matches.length !== 1) throw refuse("PROCESS_PAIR_CHANGED");
}

// A live readback must continue to observe both original kernel starts and the
// same parent, not merely the current numeric PIDs. A terminal readback instead
// needs the guardian's own exit AND the distinct, complete original Go Wait
// receipt for Electron. Neither an absent PID nor a closed singleton suffices.
export function requalifyNativePreviewPair(pair, actual, child) {
  if (
    pair?.child !== child ||
    pair.identity.guardianPid !== child?.pid ||
    pair.identity.desktopPid !== actual?.pid
  )
    throw refuse("PROCESS_PAIR_CHANGED");
  if (live(child)) {
    observePair(pair);
    return null;
  }
  if (child.exitCode !== 0 || child.signalCode !== null)
    throw refuse("GUARDIAN_TERMINAL_UNCONFIRMED");
  try {
    return requireDesktopExit(pair.desktopExit.snapshot(), pair.identity, {
      pid: child.pid,
      code: child.exitCode,
      signal: child.signalCode,
    });
  } catch {
    throw refuse("DESKTOP_TERMINAL_UNCONFIRMED");
  }
}

export async function firstNativePreviewPair(launch, actual, child, marker) {
  if (!live(child) || !child.stderr) throw refuse("PACKAGED_CHILD_UNOWNED");
  const observed = {
    guardianBefore: nativeExecutableWitness(child.pid),
    desktopBefore: nativeExecutableWitness(actual.pid),
    launcherStart: readProcessStart(child.pid),
    desktopStart: readProcessStart(actual.pid),
    children: readOwnedChildProcesses(child.pid),
    guardianAfter: nativeExecutableWitness(child.pid),
    desktopAfter: nativeExecutableWitness(actual.pid),
  };
  const pair = captureNativePreviewPair(
    launch,
    actual,
    child,
    marker,
    observed,
  );
  observePair(pair);
  return pair;
}
