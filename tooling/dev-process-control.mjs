// Development launcher mechanics only. Never selects the installed application,
// changes a profile or claims a signal settled application work.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { readGoBuildInputs } from "./go-build-inputs.mjs";
import { buildDevControl } from "./go-backend-build.mjs";
import { stopRetainedDevProcess } from "./dev-owned-stop.mjs";
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
  return readRunMarker(path.join(profilePath, "farol-next-state"));
}

export function retainedDevMarkerMatches(markerFile, original) {
  let fd;
  try {
    fd = fs.openSync(
      markerFile,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 4096
    )
      return false;
    const bytes = Buffer.alloc(4097);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 4096) return false;
    return (
      JSON.stringify(JSON.parse(bytes.subarray(0, size).toString("utf8"))) ===
      JSON.stringify(original)
    );
  } catch (error) {
    // Normal Quit removes its marker before Electron necessarily exits. This
    // is only continuation of the already-correlated lifetime: every poll and
    // signal still verifies the retained native token, UID and executable.
    // A replacement marker or any unreadable/malformed file still refuses.
    return error?.code === "ENOENT";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
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
  const executable = `${scope.writerRoot}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`;
  if (
    !match ||
    native.status !== "present" ||
    native.commandVerified !== true ||
    Number(match[1]) !== scope.uid ||
    native.uid !== scope.uid ||
    native.pid !== marker.pid ||
    match[2].trim() !== marker.processStart ||
    !sameBoot(marker.bootTime, bootTime) ||
    (![
      executable + " _output/build/app/main.cjs",
      executable + " " + scope.appPath,
    ].some(
      (prefix) => match[3] === prefix || match[3].startsWith(prefix + " "),
    ) &&
      match[3] !== "Farol Dev") ||
    /--(?:acceptance|user-data|profile|type)(?:[=\s-]|$)/u.test(match[3])
  )
    throw Error("DEV_PROCESS_IDENTITY_REFUSED");
  return Object.freeze({
    ...scope,
    pid: marker.pid,
    startIdentity: native.token,
    executable,
    environment: "dev",
    applicationId: "local.farol.dev",
    installed: false,
  });
}

async function buildControl(root, buildArguments) {
  const inputs = await readGoBuildInputs(buildArguments);
  if (!inputs || process.platform !== "darwin")
    throw Error("DEV_CONTROL_TOOLCHAIN_REFUSED");
  return buildDevControl(root, inputs);
}

function nativeCall(binary, request, remaining = 3000) {
  const timeout = devControlTimeout(remaining);
  const result = spawnSync(binary, [], {
    input: JSON.stringify(request),
    encoding: "utf8",
    timeout,
    maxBuffer: 4096,
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || ![0, 1].includes(result.status))
    return { status: "unreadable" };
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { status: "unreadable" };
  }
}

export async function prepareDevBuild({
  root,
  buildArguments,
  replace,
  log = () => {},
}) {
  if (process.platform !== "darwin")
    throw Error("DEV_PROCESS_PLATFORM_REFUSED");
  const writerRoot = fs.realpathSync(root);
  const appPath = path.join(writerRoot, "_output/build/app/main.cjs");
  const home = os.userInfo().homedir;
  if (process.env.HOME !== home) throw Error("DEV_PROCESS_HOME_REFUSED");
  const profileName = path.join(home, "Library/Application Support/Farol Dev");
  const profilePath = fs.existsSync(profileName)
    ? fs.realpathSync(profileName)
    : profileName;
  const scope = { uid: process.getuid(), writerRoot, appPath, profilePath };
  const markerFile = path.join(profilePath, "farol-next-state/running.json");
  const marker = await readDevRunMarker(profilePath);
  if (marker.status === "unreadable") throw Error("DEV_RUN_MARKER_UNREADABLE");
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
      if (!replace) throw Error("DEV_BUILD_LIVE_OUTPUTS_REFUSED");
      const binary = await buildControl(writerRoot, buildArguments);
      const native = nativeCall(binary, {
        action: "inspect",
        pid: marker.marker.pid,
        executable: path.join(
          writerRoot,
          "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        ),
        appPath,
      });
      if (native.status === "present") {
        const retained = correlateDevCommand(
          command.text,
          marker.marker,
          scope,
          native,
          currentBootTimeMs(),
        );
        const inspect = (pid, remaining) => {
          const deadline = performance.now() + remaining;
          const seen = nativeCall(
            binary,
            {
              action: "inspect",
              pid,
              executable: retained.executable,
              appPath,
            },
            deadline - performance.now(),
          );
          if (seen.status === "absent") return seen;
          if (seen.status !== "present") return { status: "unreadable" };
          if (!retainedDevMarkerMatches(markerFile, marker.marker))
            return { status: "unreadable" };
          const line = ps(
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
          );
          try {
            return {
              status: "present",
              identity: correlateDevCommand(
                line.text,
                marker.marker,
                scope,
                seen,
                currentBootTimeMs(),
              ),
            };
          } catch {
            return { status: "unreadable" };
          }
        };
        log(
          "Stopping the previous Farol Dev before rebuilding its app outputs...",
        );
        const result = await stopRetainedDevProcess(retained, scope, {
          clock: () => performance.now(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          inspect,
          signal: (pid, signal, expected, remaining) =>
            nativeCall(
              binary,
              {
                action: "signal",
                pid,
                signal,
                token: expected.startIdentity,
                uid: expected.uid,
                executable: expected.executable,
                appPath: expected.appPath,
              },
              remaining,
            ),
        });
        if (result.status !== "absent")
          throw Error(`DEV_STOP_${result.reason}`);
        log(
          `Previous Dev process is absent (${result.attemptedSignals.join(", ") || "already stopped"}). Profile outcomes remain unchanged.`,
        );
      } else if (native.status !== "absent")
        throw Error("DEV_PROCESS_IDENTITY_UNREADABLE");
    } else if (command.status !== 1 || command.text)
      throw Error("DEV_PROCESS_ABSENCE_UNCONFIRMED");
  }
  // Other profiles/review windows and retained native children sharing these
  // outputs must also be absent. They are never killed by this launcher.
  const inventory = ps(["-ww", "-axo", "pid=,command="]);
  const ownedRoots = [
    path.join(writerRoot, "node_modules/electron/dist/Electron.app/"),
    path.join(writerRoot, "_output/build/app/"),
    path.join(profilePath, "farol-next-state/"),
  ];
  if (
    inventory.text
      .split("\n")
      .some(
        (line) =>
          /^\s*\d+\s+Farol Dev$/u.test(line) ||
          ownedRoots.some((prefix) => line.includes(prefix)),
      )
  )
    throw Error("DEV_BUILD_OWNED_PROCESSES_REMAIN");
  return { profilePath, marker: marker.status };
}
