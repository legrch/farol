import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
// Process titles on macOS may replace argv. Ask the kernel for the executable
// instead of treating the display title as an executable path.
const executableWitnessScript = `function run(argv) {
  ObjC.import("Foundation");
  ObjC.bindFunction("proc_pidpath", ["int", ["int", "void *", "uint32_t"]]);
  ObjC.bindFunction("proc_pidinfo", ["int", ["int", "int", "uint64_t", "void *", "int"]]);
  const pid = Number(argv[0]);
  if (!Number.isSafeInteger(pid) || pid < 2) throw Error("invalid pid");
  function info() {
    const data = $.NSMutableData.dataWithLength(136);
    if ($.proc_pidinfo(pid, 3, 0, data.mutableBytes, 136) !== 136)
      throw Error("proc_pidinfo failed");
    return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
  }
  const before = info();
  const buffer = $.NSMutableData.dataWithLength(4096);
  const length = $.proc_pidpath(pid, buffer.mutableBytes, 4096);
  if (length <= 0 || length >= 4096) throw Error("proc_pidpath failed");
  const executable = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(
    buffer.subdataWithRange($.NSMakeRange(0, length)), $.NSUTF8StringEncoding));
  return JSON.stringify({ before, executable, after: info() });
}`;

export function parseNativeExecutableWitness(witness, pid) {
  const decode = (raw) => {
    const value = Buffer.from(raw, "base64");
    assert.equal(value.length, 136, "DESKTOP_NATIVE_INFO_INVALID");
    return {
      pid: value.readUInt32LE(12),
      parentPid: value.readUInt32LE(16),
      startSeconds: value.readBigUInt64LE(120),
      startMicroseconds: value.readBigUInt64LE(128),
    };
  };
  const before = decode(witness.before);
  const after = decode(witness.after);
  assert.deepEqual(after, before, "DESKTOP_NATIVE_LIFETIME_CHANGED");
  assert.equal(before.pid, pid, "DESKTOP_NATIVE_PID_MISMATCH");
  return {
    executable: witness.executable,
    parentPid: before.parentPid,
    startSeconds: before.startSeconds.toString(),
    startMicroseconds: before.startMicroseconds.toString(),
  };
}

export function nativeExecutableWitness(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1, "DESKTOP_PID_INVALID");
  const output = execFileSync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", executableWitnessScript, "--", String(pid)],
    { encoding: "utf8", timeout: 3000, maxBuffer: 8192 },
  );
  return parseNativeExecutableWitness(JSON.parse(output), pid);
}

// The packaged launcher is a retained Go guardian; Electron is its child.
// The Dev launcher still directly owns Electron under the same PID contract.
// This qualifies identity only, never terminal or descendant-cleanup evidence.
export function qualifyDesktopMain({
  packaged,
  guardianPid,
  marker,
  desktop,
  children,
  expectedExecutable,
  nativeExecutable,
  nativeExecutableBefore,
}) {
  assert.ok(
    Number.isSafeInteger(guardianPid) && guardianPid > 1,
    "GUARDIAN_PID_INVALID",
  );
  assert.ok(
    Number.isSafeInteger(desktop.pid) && desktop.pid > 1,
    "DESKTOP_PID_INVALID",
  );
  assert.equal(marker.pid, desktop.pid, "RUN_MARKER_DESKTOP_MISMATCH");
  if (!packaged) {
    assert.equal(desktop.pid, guardianPid, "DEV_MAIN_PID_MISMATCH");
    return { guardianPid, desktopPid: desktop.pid };
  }
  assert.notEqual(desktop.pid, guardianPid, "PACKAGED_GUARDIAN_IS_DESKTOP");
  assert.equal(desktop.ppid, guardianPid, "DESKTOP_PARENT_MISMATCH");
  assert.equal(
    desktop.executable,
    expectedExecutable,
    "DESKTOP_EXECUTABLE_MISMATCH",
  );
  const matches = children.filter((entry) => entry.pid === desktop.pid);
  assert.equal(matches.length, 1, "DESKTOP_CHILD_UNCONFIRMED");
  const observed = matches[0];
  assert.equal(
    observed.parentPid,
    guardianPid,
    "DESKTOP_CHILD_PARENT_MISMATCH",
  );
  assert.equal(
    observed.processStart,
    marker.processStart,
    "DESKTOP_START_MISMATCH",
  );
  assert.equal(
    nativeExecutable?.executable,
    expectedExecutable,
    "DESKTOP_NATIVE_EXECUTABLE_MISMATCH",
  );
  assert.equal(
    nativeExecutable?.parentPid,
    guardianPid,
    "DESKTOP_NATIVE_PARENT_MISMATCH",
  );
  assert.deepEqual(
    nativeExecutable,
    nativeExecutableBefore,
    "DESKTOP_NATIVE_LIFETIME_CHANGED",
  );
  return {
    guardianPid,
    desktopPid: desktop.pid,
    desktopStart: observed.processStart,
  };
}

// Only the retained guardian stderr is admitted. This is its original native
// Wait receipt for Electron, separate from the tester's guardian Wait.
export function collectDesktopExit(stream) {
  let buffer = "",
    receipt = null,
    invalid = false,
    complete = false;
  function line(value) {
    if (value.length > 4096) {
      invalid = true;
      return;
    }
    if (!value.startsWith("desktop_launcher_desktop_exit")) return;
    const match =
      /^desktop_launcher_desktop_exit pid=([1-9][0-9]*) code=([0-9]+)$/.exec(
        value,
      );
    if (!match || receipt) {
      invalid = true;
      return;
    }
    const pid = Number(match[1]),
      code = Number(match[2]);
    if (
      !Number.isSafeInteger(pid) ||
      pid < 2 ||
      !Number.isSafeInteger(code) ||
      code > 255
    ) {
      invalid = true;
      return;
    }
    receipt = { pid, code, signal: null, source: "guardian-native-wait" };
  }
  stream.on("data", (data) => {
    buffer += data.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      line(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
    if (buffer.length > 4096) {
      invalid = true;
      buffer = "";
    }
  });
  stream.once("error", () => {
    invalid = true;
  });
  stream.once("end", () => {
    if (buffer) line(buffer);
    complete = true;
  });
  return { snapshot: () => ({ receipt, invalid, complete }) };
}
export function requireDesktopExit(observation, identity, guardianTerminal) {
  assert.equal(
    guardianTerminal.pid,
    identity.guardianPid,
    "GUARDIAN_TERMINAL_MISMATCH",
  );
  assert.equal(guardianTerminal.code, 0, "GUARDIAN_EXIT_FAILED");
  assert.equal(guardianTerminal.signal, null, "GUARDIAN_SIGNAL_DEATH");
  assert.equal(observation.complete, true, "DESKTOP_WAIT_STREAM_INCOMPLETE");
  assert.equal(observation.invalid, false, "DESKTOP_WAIT_RECEIPT_INVALID");
  assert.equal(
    observation.receipt?.pid,
    identity.desktopPid,
    "DESKTOP_WAIT_PID_MISMATCH",
  );
  assert.equal(observation.receipt?.code, 0, "DESKTOP_WAIT_FAILED");
  return { ...observation.receipt, guardianTerminal };
}
