import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { BridgeError } from "./client.ts";
import { parseJSON } from "./frame.ts";
import type { ProfileLaunchBinding } from "./profile.ts";
import {
  validate,
  type CoreRetirementAcknowledged,
  type CoreTerminalObservation,
} from "./wire.ts";

// Called only with an independently re-attested executable and the retained
// original profile binding. This short Go mode owns durable terminal policy;
// this adapter only owns one child, bounded pipe bytes and exact cleanup.
export function recordTerminal(
  executable: string,
  profile: ProfileLaunchBinding,
  observation: CoreTerminalObservation,
  expected: CoreRetirementAcknowledged,
): Promise<void> {
  if (
    !validate("CoreTerminalObservation", observation) ||
    !validate("CoreRetirementAcknowledged", expected)
  )
    return Promise.reject(
      new BridgeError("refused", "terminal_record_invalid"),
    );
  const payload = JSON.stringify(observation);
  const expectedCopy = structuredClone(expected);
  return new Promise<void>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        executable,
        [
          "record-native-terminal",
          "--profile",
          profile.profileId,
          "--profile-root",
          profile.root,
          "--profile-device",
          profile.device,
          "--profile-inode",
          profile.inode,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch {
      reject(new BridgeError("unknown", "terminal_record_launch_unconfirmed"));
      return;
    }
    if (!child.stdin || !child.stdout || !child.stderr) {
      reject(new BridgeError("unknown", "terminal_record_pipes_unavailable"));
      return;
    }
    let stdout = "";
    let diagnosticBytes = 0;
    let failed = false;
    let forced = false;
    let settled = false;
    const fail = () => {
      failed = true;
      if (!forced) {
        forced = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // Only the original close event confirms cleanup.
        }
      }
    };
    const deadline = setTimeout(fail, 3000);
    const cleanupDeadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(
        new BridgeError("unknown", "terminal_recorder_cleanup_unconfirmed"),
      );
    }, 4000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(data) > 8192) fail();
      else stdout += data;
    });
    child.stderr.on("data", (data: Buffer) => {
      diagnosticBytes += data.length;
      if (diagnosticBytes > 8192) fail();
    });
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.once("error", fail);
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      clearTimeout(cleanupDeadline);
      if (settled) return;
      settled = true;
      try {
        if (failed || forced || code !== 0 || signal !== null)
          throw new BridgeError("unknown", "terminal_record_unconfirmed");
        const value = parseJSON(stdout);
        if (
          !validate("CoreRetirementAcknowledged", value) ||
          !isDeepStrictEqual(value, expectedCopy)
        )
          throw new BridgeError("unknown", "terminal_record_reply_invalid");
        resolve();
      } catch {
        reject(new BridgeError("unknown", "terminal_record_unconfirmed"));
      }
    });
    child.stdin.end(payload);
  });
}
