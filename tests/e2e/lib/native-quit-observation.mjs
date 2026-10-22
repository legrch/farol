import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  parseQuitReceipt,
  QUIT_RECEIPT_FILE_NAME,
  MAX_QUIT_RECEIPT_BYTES,
} from "../../../src/apps/desktop/quit-receipt.ts";

const observations = new WeakMap();
const require = (ok, name) => {
  if (!ok) throw new Error(`NATIVE_LIFETIME_${name}`);
};
const fileKeys = [
  "dev",
  "ino",
  "mode",
  "uid",
  "nlink",
  "size",
  "mtimeNs",
  "ctimeNs",
];
const sameFile = (a, b) => fileKeys.every((key) => a[key] === b[key]);
const directoryPin = (info) =>
  Object.freeze({
    dev: String(info.dev),
    ino: String(info.ino),
    mode: String(info.mode),
    uid: String(info.uid),
  });
const sameDirectory = (a, b) =>
  Object.keys(a).every((key) => a[key] === b[key]);

// Reads only one fixed private receipt. An observation is branded in memory;
// serialized reports or caller-built metadata cannot qualify a later lifetime.
export async function readQuitObservation(stateRoot) {
  require(path.isAbsolute(stateRoot) &&
    path.resolve(stateRoot) === stateRoot &&
    !stateRoot.includes("\0"), "QUIT_PATH_INVALID");
  const parent = await fs.lstat(stateRoot, { bigint: true });
  require(parent.isDirectory() &&
    !parent.isSymbolicLink() &&
    parent.uid === BigInt(process.getuid?.() ?? -1) &&
    (parent.mode & 0o7777n) === 0o700n &&
    (await fs.realpath(stateRoot)) === stateRoot, "QUIT_DIRECTORY_UNSAFE");
  const directory = directoryPin(parent);
  const file = path.join(stateRoot, QUIT_RECEIPT_FILE_NAME);
  let handle;
  try {
    handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    require(sameDirectory(
      directory,
      directoryPin(await fs.lstat(stateRoot, { bigint: true })),
    ) &&
      (await fs.realpath(stateRoot)) === stateRoot, "QUIT_DIRECTORY_CHANGED");
    const missing = Object.freeze({
      status: "absent",
      file,
      directory,
      observedAtMs: Date.now(),
      identity: null,
      sha256: null,
    });
    observations.set(missing, null);
    return missing;
  }
  try {
    const before = await handle.stat({ bigint: true });
    require(before.isFile() &&
      before.nlink === 1n &&
      before.uid === BigInt(process.getuid?.() ?? -1) &&
      (before.mode & 0o7777n) === 0o600n &&
      before.size <= BigInt(MAX_QUIT_RECEIPT_BYTES), "QUIT_FILE_UNSAFE");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat({ bigint: true });
    const named = await fs.lstat(file, { bigint: true });
    require(sameFile(before, after) &&
      sameFile(before, named) &&
      bytesRead === Number(before.size) &&
      sameDirectory(
        directory,
        directoryPin(await fs.lstat(stateRoot, { bigint: true })),
      ) &&
      (await fs.realpath(stateRoot)) === stateRoot, "QUIT_FILE_CHANGED");
    const data = bytes.subarray(0, bytesRead);
    const identity = Object.freeze(
      Object.fromEntries(fileKeys.map((key) => [key, String(before[key])])),
    );
    const result = Object.freeze({
      status: "present",
      file,
      directory,
      observedAtMs: Date.now(),
      identity,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
    observations.set(result, data.toString("utf8"));
    return result;
  } finally {
    await handle.close();
  }
}

// Payload validation is deliberately weaker than a native lifetime witness.
// Native callers must also prove actual atomic replacement with assertFreshQuit.
export function parseDrainedQuit(text, requestedAt, exit) {
  const parsed = parseQuitReceipt(text);
  require(exit.code === 0 &&
    exit.signal === null &&
    parsed.ok &&
    parsed.receipt.drained &&
    parsed.receipt.unconfirmed.length === 0 &&
    Date.parse(parsed.receipt.at) >= requestedAt, "QUIT_UNCONFIRMED");
  return parsed.receipt;
}

export function assertFreshQuit(before, after, { requestedAt, exit }) {
  require(observations.has(before) &&
    observations.has(after) &&
    before !== after &&
    before.file === after.file &&
    sameDirectory(before.directory, after.directory) &&
    after.status === "present", "QUIT_OBSERVATION_REQUIRED");
  require(before.status === "absent" ||
    (before.status === "present" &&
      before.identity.dev === after.identity.dev &&
      before.identity.ino !== after.identity.ino), "QUIT_NOT_REPLACED");
  const receipt = parseDrainedQuit(observations.get(after), requestedAt, exit);
  require(Number.isSafeInteger(requestedAt) &&
    after.observedAtMs >= requestedAt &&
    Date.parse(receipt.at) <= after.observedAtMs, "QUIT_CLOCK_UNCONFIRMED");
  return receipt;
}
