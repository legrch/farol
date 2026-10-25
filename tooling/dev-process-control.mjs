import { desktopIdentity as harnessDesktopIdentity } from "./harness-identity.ts";
// Development launcher mechanics only. Never selects the installed application,
// changes a profile or claims a signal settled application work.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { devExecutables, devEntrypointForExecutable } from "./dev-runtime.mjs";
import { resolvePhysicalDevDataDirectoryName } from "./harness-identity.ts";
import { performance } from "node:perf_hooks";
import { readGoBuildInputs } from "./go-build-inputs.mjs";
import { buildDevControl } from "./go-backend-build.mjs";
import { stopRetainedDevProcess } from "./dev-owned-stop.mjs";
import { readPreparedDevCore } from "./dev-core-resources.mjs";
import {
  readRunMarker,
  currentBootTimeMs,
  sameBoot,
} from "../src/apps/desktop/run-marker.ts";

export function devControlTimeout(budget) {
  if (!Number.isFinite(budget) || Math.floor(budget) < 1)
    throw Error("DEV_CONTROL_BUDGET_EXHAUSTED");
  return Math.min(3000, Math.floor(budget));
}

export function readDevRunMarker(profilePath) {
  return readRunMarker(path.join(profilePath, "farol-state"));
}

export function readRetainedDevMarker(markerFile, original) {
  let fd;
  const failed = (reason) => ({ matches: false, reason });
  try {
    fd = fs.openSync(
      markerFile,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1)
      return failed("RUN_MARKER_NOT_REGULAR_PRIVATE_FILE");
    if (stat.uid !== process.getuid()) return failed("RUN_MARKER_UID_CHANGED");
    if ((stat.mode & 0o777) !== 0o600) return failed("RUN_MARKER_MODE_UNSAFE");
    if (stat.size > 4096) return failed("RUN_MARKER_OVERSIZED");
    const bytes = Buffer.alloc(4097);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 4096) return failed("RUN_MARKER_OVERSIZED");
    let current;
    try {
      current = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    } catch {
      return failed("RUN_MARKER_JSON_INVALID");
    }
    return JSON.stringify(current) === JSON.stringify(original)
      ? { matches: true }
      : failed("RUN_MARKER_CHANGED");
  } catch (error) {
    // Normal Quit removes its marker before Electron necessarily exits. Every
    // poll/signal still verifies the independently retained native lifetime.
    if (error?.code === "ENOENT") return { matches: true };
    return failed(
      `RUN_MARKER_READ_${["ELOOP", "EACCES", "EPERM", "EISDIR"].includes(error?.code) ? error.code : "FAILED"}`,
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function retainedDevMarkerMatches(markerFile, original) {
  return readRetainedDevMarker(markerFile, original).matches;
}

function ps(args, budget = 3000) {
  const result = spawnSync("/bin/ps", args, {
    encoding: "utf8",
    timeout: devControlTimeout(budget),
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || (result.status !== 0 && result.status !== 1))
    throw Error("DEV_PROCESS_LOOKUP_UNREADABLE");
  return { status: result.status, text: result.stdout.trim() };
}

// Pure correlation of an independently observed native lifetime with the
// private run marker and this exact checkout's Electron command.
export function correlateDevCommand(line, marker, scope, native, bootTime) {
  const match = /^(\d+)\s+(.{24})\s+(.+)$/u.exec(line.trim());
  const refuse = (field) => {
    throw Error(`DEV_PROCESS_IDENTITY_REFUSED: ${field}`);
  };
  const { executable, appPath, profilePath } = native;
  if (
    !devExecutables(scope.writerRoot).includes(executable) ||
    devEntrypointForExecutable(scope.writerRoot, executable) !== appPath
  )
    refuse("executable");
  if (!match) refuse("ps UID/start/command format");
  if (match[3] === harnessDesktopIdentity("dev", "/").applicationName)
    refuse("erased process title");
  if (native.status !== "present" || native.commandVerified !== true)
    refuse("native command verification");
  if (
    !/^darwin-v1:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:[1-9][0-9]{6,18}$/u.test(
      native.token ?? "",
    )
  )
    refuse("native boot/start identity");
  if (Number(match[1]) !== scope.uid || native.uid !== scope.uid)
    refuse("account UID");
  if (native.pid !== marker.pid) refuse("run-marker PID");
  if (match[2].trim() !== marker.processStart)
    refuse("ps start time differs from run marker");
  if (!sameBoot(marker.bootTime, bootTime)) refuse("run-marker boot time");
  if (appPath !== scope.appPath || profilePath !== scope.profilePath)
    refuse("checkout entrypoint/profile command");
  // ps is only a coarse marker witness. The native helper independently proves
  // the executable and exact argv; a display title supplies no authority.
  return Object.freeze({
    ...scope,
    appPath,
    profilePath,
    pid: marker.pid,
    startIdentity: native.token,
    executable,
    environment: "dev",
    applicationId: harnessDesktopIdentity("dev", "/").applicationId,
    installed: false,
  });
}

// Each observation has a closed source label so an unreadable step is actionable.
// A process can exit after the native read but before ps. Confirm that exact PID's
// absence independently; an empty ps result alone never grants rebuild authority.
export function inspectDevStopIdentity({
  marker,
  scope,
  native,
  command,
  markerMatches,
  bootTime,
}) {
  const unreadable = (reason) => ({ status: "unreadable", reason });
  try {
    const seen = native();
    if (seen.status === "absent") return seen;
    if (seen.status !== "present")
      return unreadable(
        `native inspection: ${seen.status}/${seen.reason ?? "no reason"}`,
      );
    const markerRead = markerMatches();
    if (markerRead !== true && markerRead?.matches !== true)
      return unreadable(
        `retained run marker: ${markerRead?.reason ?? "changed or could not be read"}`,
      );
    const line = command();
    if (line.status === 1 && line.text === "") {
      const confirmed = native();
      return confirmed.status === "absent"
        ? confirmed
        : unreadable(
            `ps reported absence; native confirmation: ${confirmed.status}/${confirmed.reason ?? "no reason"}`,
          );
    }
    return {
      status: "present",
      identity: correlateDevCommand(line.text, marker, scope, seen, bootTime()),
    };
  } catch (error) {
    return unreadable(`identity read: ${error.message}`);
  }
}

export function devOwnedOutputRoots(writerRoot, profilePath) {
  return [
    path.join(writerRoot, "node_modules/electron/dist/Electron.app/"),
    path.join(writerRoot, "_output/build/app/"),
    path.join(writerRoot, "_output/dev-runtime/"),
    path.join(writerRoot, "_output/dev-core/"),
    path.join(writerRoot, "_output/.dev-core-retired-"),
    path.join(profilePath, "farol-state/"),
  ];
}

export function devInventoryOwnsLine(line, ownedRoots) {
  // A product title alone does not identify a checkout. Its runtime/native
  // children retain exact writer paths and still block shared-output rebuilds.
  return ownedRoots.some((prefix) => line.includes(prefix));
}

export function devInventoryCandidateAbsent(seen) {
  return (
    seen.status === "absent" ||
    (seen.status === "refused" && seen.reason === "WRITER_EXECUTABLE_MISMATCH")
  );
}

async function buildControl(root, buildArguments) {
  const inputs = await readGoBuildInputs(buildArguments);
  if (!inputs || process.platform !== "darwin")
    throw Error("DEV_CONTROL_TOOLCHAIN_REFUSED");
  return buildDevControl(root, inputs);
}

export function inspectDevExecutable(
  binary,
  pid,
  root,
  profilePath,
  remaining = 3000,
  observe = nativeCall,
) {
  const deadline = performance.now() + remaining;
  for (const executable of devExecutables(root)) {
    const appPath = devEntrypointForExecutable(root, executable);
    const seen = observe(
      binary,
      { action: "inspect", pid, executable, appPath, profilePath },
      deadline - performance.now(),
    );
    if (
      seen.status === "refused" &&
      seen.reason === "WRITER_EXECUTABLE_MISMATCH"
    )
      continue;
    return seen;
  }
  return { status: "refused", reason: "WRITER_EXECUTABLE_MISMATCH" };
}

function nativeCall(binary, request, remaining = 3000) {
  const timeout = devControlTimeout(remaining);
  const result = spawnSync(binary, [], {
    input: JSON.stringify(request),
    encoding: "utf8",
    timeout,
    maxBuffer: 32768,
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || ![0, 1].includes(result.status))
    return {
      status: "unreadable",
      reason:
        result.error?.code === "ETIMEDOUT"
          ? "NATIVE_HELPER_TIMEOUT"
          : "NATIVE_HELPER_EXECUTION_FAILED",
    };
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { status: "unreadable", reason: "NATIVE_HELPER_RESPONSE_INVALID" };
  }
}

export async function prepareDevBuild({
  root,
  buildArguments,
  replace,
  reuse = false,
  qualifyImage = readPreparedDevCore,
  profilePath: selectedProfilePath,
  createControl = buildControl,
  log = () => {},
}) {
  if (process.platform !== "darwin")
    throw Error("DEV_PROCESS_PLATFORM_REFUSED");
  const writerRoot = fs.realpathSync(root);
  const appPath = path.join(
    writerRoot,
    "_output/dev-core/Contents/Resources/app/main.cjs",
  );
  const home = os.userInfo().homedir;
  if (process.env.HOME !== home) throw Error("DEV_PROCESS_HOME_REFUSED");
  const profileName =
    selectedProfilePath ??
    path.join(
      home,
      "Library/Application Support",
      resolvePhysicalDevDataDirectoryName(
        path.join(home, "Library/Application Support"),
      ),
    );
  const profilePath = fs.existsSync(profileName)
    ? fs.realpathSync(profileName)
    : profileName;
  const scope = { uid: process.getuid(), writerRoot, appPath, profilePath };
  let controlBinary;
  const getControl = async () =>
    (controlBinary ??= await createControl(writerRoot, buildArguments));
  const markerFile = path.join(profilePath, "farol-state/running.json");
  const marker = await readDevRunMarker(profilePath);
  if (marker.status === "unreadable")
    throw Error(
      `DEV_RUN_MARKER_UNREADABLE: ${marker.reason}. Quit the previous ${harnessDesktopIdentity("dev", "/").applicationName} from this checkout/profile using its own Quit command, then run task dev again.`,
    );
  if (marker.status === "read") {
    const command = ps([
      "-ww",
      "-p",
      String(marker.marker.pid),
      "-o",
      "uid=",
      "-o",
      "lstart=",
      "-o",
      "command=",
    ]);
    if (command.status === 0 && command.text) {
      if (!replace && !reuse)
        throw Error(
          "DEV_BUILD_LIVE_OUTPUTS_REFUSED: Quit the running Dev normally before rebuilding shared outputs.",
        );
      const binary = await getControl();
      const native = inspectDevExecutable(
        binary,
        marker.marker.pid,
        writerRoot,
        profilePath,
      );
      if (native.status === "present") {
        const retainedScope = {
          ...scope,
          appPath: devEntrypointForExecutable(writerRoot, native.executable),
        };
        let retained;
        try {
          retained = correlateDevCommand(
            command.text,
            marker.marker,
            retainedScope,
            native,
            currentBootTimeMs(),
          );
        } catch (error) {
          throw Error(
            `${error.message}. Quit the previous ${harnessDesktopIdentity("dev", "/").applicationName} from this checkout/profile using its own Quit command, then run task dev again.`,
          );
        }
        if (reuse) {
          const image = await qualifyImage(writerRoot);
          if (
            native.executable !== image.executable ||
            retained.appPath !== appPath
          )
            throw Error("DEV_RUNNING_IMAGE_UNCONFIRMED");
          // The secondary-only opener repeats exact-build/profile correlation
          // through Electron's acknowledged singleton. It cannot become primary.
          return {
            status: "running",
            profilePath,
            existing: { ...image, pid: retained.pid },
          };
        }
        let inspectionFailure = "none";
        const unreadable = (reason) => {
          inspectionFailure = reason;
          log(
            `Dev stop identity read failed: ${reason} (pid ${retained.pid}).`,
          );
          return { status: "unreadable" };
        };
        const inspect = (pid, remaining) => {
          const deadline = performance.now() + remaining;
          const observation = inspectDevStopIdentity({
            marker: marker.marker,
            scope: retainedScope,
            native: () =>
              nativeCall(
                binary,
                {
                  action: "inspect",
                  pid,
                  executable: retained.executable,
                  appPath: retained.appPath,
                  profilePath,
                },
                deadline - performance.now(),
              ),
            markerMatches: () =>
              readRetainedDevMarker(markerFile, marker.marker),
            command: () =>
              ps(
                [
                  "-ww",
                  "-p",
                  String(pid),
                  "-o",
                  "uid=",
                  "-o",
                  "lstart=",
                  "-o",
                  "command=",
                ],
                deadline - performance.now(),
              ),
            bootTime: currentBootTimeMs,
          });
          return observation.status === "unreadable"
            ? unreadable(observation.reason)
            : observation;
        };
        log(
          `Stopping the previous ${harnessDesktopIdentity("dev", "/").applicationName} before rebuilding its app outputs...`,
        );
        const result = await stopRetainedDevProcess(retained, retainedScope, {
          clock: () => performance.now(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          inspect,
          signal: (pid, signal, expected, remaining) => {
            const outcome = nativeCall(
              binary,
              {
                action: "signal",
                pid,
                signal,
                token: expected.startIdentity,
                uid: expected.uid,
                executable: expected.executable,
                appPath: expected.appPath,
                profilePath: expected.profilePath,
              },
              remaining,
            );
            if (outcome.status !== "sent" && outcome.status !== "absent")
              inspectionFailure = `${signal}: ${outcome.status}/${outcome.reason ?? "no reason"}`;
            return outcome;
          },
        });
        if (result.status !== "absent")
          throw Error(
            `DEV_STOP_${result.reason}: ${inspectionFailure}. Quit the previous ${harnessDesktopIdentity("dev", "/").applicationName} from this checkout/profile using its own Quit command, then run task dev again.`,
          );
        log(
          `Previous Dev process is absent (${result.attemptedSignals.join(", ") || "already stopped"}). Profile outcomes remain unchanged.`,
        );
      } else if (native.status !== "absent")
        throw Error(
          `DEV_PROCESS_IDENTITY_UNREADABLE: native inspection ${native.status}/${native.reason ?? "no reason"} (pid ${marker.marker.pid}). Quit the previous ${harnessDesktopIdentity("dev", "/").applicationName} from this checkout/profile using its own Quit command, then run task dev again.`,
        );
    } else if (command.status !== 1 || command.text)
      throw Error("DEV_PROCESS_ABSENCE_UNCONFIRMED");
  }
  // Other profiles/review windows and retained native children sharing these
  // outputs must also be absent. They are never killed by this launcher.
  const inventory = ps(["-ww", "-axo", "pid=,command="]);
  const ownedRoots = devOwnedOutputRoots(writerRoot, profilePath);
  for (const line of inventory.text.split("\n")) {
    if (devInventoryOwnsLine(line, ownedRoots))
      throw Error(
        "DEV_BUILD_OWNED_PROCESSES_REMAIN: Another Dev profile or child uses this checkout. Quit it normally before switching profiles or rebuilding.",
      );
    const titled = new RegExp(
      `^\\s*(\\d+)\\s+${RegExp.escape(harnessDesktopIdentity("dev", "/").applicationName)}$`,
      "u",
    ).exec(line);
    if (!titled) continue;
    // Erased argv cannot prove a writer. Qualify the exact selected executable
    // without reading another profile or signaling an inventory candidate.
    const seen = inspectDevExecutable(
      await getControl(),
      Number(titled[1]),
      writerRoot,
      profilePath,
    );
    if (!devInventoryCandidateAbsent(seen))
      throw Error(
        `DEV_BUILD_OWNED_PROCESSES_REMAIN: named Dev identity ${seen.status}/${seen.reason ?? "no reason"}. Quit the Dev using this checkout's app outputs before rebuilding.`,
      );
  }
  return { profilePath, marker: marker.status };
}
