import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BridgeError } from "./client.ts";

export type NativeProfileStorage = Readonly<{
  profileId: string;
  root: string;
  storeMode: "create" | "open";
}>;
const ID = /^[A-Za-z0-9._:/-]{1,120}$/u;
function refused(): never {
  throw new BridgeError("refused", "native_profile_storage_invalid");
}
function privateDirectory(directory: string): fs.BigIntStats {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== BigInt(process.getuid!()) ||
    (stat.mode & 0o777n) !== 0o700n ||
    fs.realpathSync(directory) !== directory
  )
    refused();
  return stat;
}
function unchanged(directory: string, before: fs.BigIntStats): void {
  const after = privateDirectory(directory);
  if (before.dev !== after.dev || before.ino !== after.ino) refused();
}

// Host resource provisioning only, below the already selected private desktop
// state root. It creates no approval, task or journal and never retries create
// after a failed open. Partial initialization is retained and refuses next launch.
export function openNativeProfileStorage(
  stateRoot: string,
  computerId: string,
): NativeProfileStorage {
  if (
    process.platform !== "darwin" ||
    typeof process.getuid !== "function" ||
    !path.isAbsolute(stateRoot) ||
    path.resolve(stateRoot) !== stateRoot ||
    stateRoot.includes("\0") ||
    !ID.test(computerId)
  )
    refused();
  const parent = privateDirectory(stateRoot);
  const root = path.join(stateRoot, "go-core");
  let created = false;
  try {
    fs.mkdirSync(root, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  unchanged(stateRoot, parent);
  const directory = privateDirectory(root);
  const marker = path.join(root, "profile.json");
  let profileId: string;
  if (created) {
    fs.mkdirSync(path.join(root, "computer"), { mode: 0o700 });
    fs.mkdirSync(path.join(root, "chat"), { mode: 0o700 });
    profileId = randomUUID();
    const fd = fs.openSync(
      marker,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify({
          schema: "farol-native-profile/1",
          profileId,
          computerId,
        }) + "\n",
      );
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const directoryFd = fs.openSync(
      root,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const held = fs.fstatSync(directoryFd, { bigint: true });
      if (held.dev !== directory.dev || held.ino !== directory.ino) refused();
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
    const parentFd = fs.openSync(
      stateRoot,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const held = fs.fstatSync(parentFd, { bigint: true });
      if (held.dev !== parent.dev || held.ino !== parent.ino) refused();
      fs.fsyncSync(parentFd);
    } finally {
      fs.closeSync(parentFd);
    }
  } else {
    const fd = fs.openSync(
      marker,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const before = fs.fstatSync(fd, { bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.uid !== BigInt(process.getuid()) ||
        (before.mode & 0o777n) !== 0o600n ||
        before.size > 4096n
      )
        refused();
      const bytes = Buffer.alloc(4097);
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      const after = fs.fstatSync(fd, { bigint: true });
      if (
        BigInt(count) !== before.size ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        before.nlink !== after.nlink
      )
        refused();
      const value: unknown = JSON.parse(
        bytes.subarray(0, count).toString("utf8"),
      );
      if (value === null || typeof value !== "object" || Array.isArray(value))
        refused();
      const record = value as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(",") !==
          "computerId,profileId,schema" ||
        record.schema !== "farol-native-profile/1" ||
        record.computerId !== computerId ||
        typeof record.profileId !== "string" ||
        !ID.test(record.profileId)
      )
        refused();
      profileId = record.profileId;
    } finally {
      fs.closeSync(fd);
    }
  }
  privateDirectory(path.join(root, "computer"));
  privateDirectory(path.join(root, "chat"));
  unchanged(root, directory);
  unchanged(stateRoot, parent);
  return Object.freeze({
    profileId,
    root,
    storeMode: created ? "create" : "open",
  });
}
