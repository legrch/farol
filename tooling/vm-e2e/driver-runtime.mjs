// In-guest result protocol for bundled Farol vm-e2e drivers (farol.vm-e2e/1).
// Keep this module free of anything but node: builtins so it can be inlined
// into a self-contained driver bundle that runs inside a guest with no
// node_modules. Durability ordering mirrors tooling/vm-smoke.py
// write_durable_json: the temp file is fsynced before the atomic replace and
// the directory entry is fsynced after it, so a result is either absent or
// fully published after a crash.
//
// Prototype scope: this proves the bundled-result shape only. It is NOT guest
// evidence, NOT network containment evidence, and claims no VM qualification.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RESULT_FILE = "result.json";

const WRITE_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  (fs.constants.O_NOFOLLOW ?? 0);
const DIRECTORY_FLAGS =
  fs.constants.O_RDONLY |
  fs.constants.O_DIRECTORY |
  (fs.constants.O_NOFOLLOW ?? 0);

export function resultDirectory() {
  const override = process.env.VM_E2E_RESULT_DIR;
  return override && override.length > 0 ? override : "results";
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, DIRECTORY_FLAGS);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function writeResult(value) {
  const directory = resultDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, RESULT_FILE);
  const temp = path.join(
    directory,
    "." + crypto.randomBytes(16).toString("hex") + ".tmp",
  );
  let handle;
  try {
    handle = fs.openSync(temp, WRITE_FLAGS, 0o600);
    fs.writeFileSync(handle, JSON.stringify(value) + "\n");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temp, target);
  } catch (error) {
    if (handle !== undefined) fs.closeSync(handle);
    try {
      fs.unlinkSync(temp);
    } catch {
      // The temp entry may already be gone; residue-free failure is the goal.
    }
    throw error;
  }
  fsyncDirectory(directory);
  return target;
}
