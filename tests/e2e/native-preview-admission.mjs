import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MAX_RUN_MARKER_BYTES,
  RunMarkerSchema,
} from "../../src/apps/desktop/run-marker.ts";

// Test preflight only. Never read, remove or repair the owner's marker. Even a
// stale or malformed marker refuses a competing native test until reconciled.
export async function assertOwnerPreviewIdle(stateRoot, metadata = fs.lstat) {
  try {
    await metadata(path.join(stateRoot, "running.json"));
  } catch (error) {
    if (error.code === "ENOENT") return { stateRoot, marker: "absent" };
    throw new Error("NATIVE_OWNER_PREVIEW_STATE_UNREADABLE", { cause: error });
  }
  throw new Error("NATIVE_OWNER_PREVIEW_NOT_CONFIRMED_IDLE");
}

// Only the already verified disposable root is eligible for startup evidence.
// Bound and type-check the opened descriptor so a substituted special object
// cannot turn diagnostic collection into a blocking stream or an outside read.
export async function readOwnedStartupMarker(stateRoot, profileRoot, pid) {
  const physical = await fs.realpath(stateRoot);
  const profile = await fs.realpath(profileRoot);
  if (!physical.startsWith(`${profile}${path.sep}`))
    throw new Error("NATIVE_STARTUP_STATE_NOT_OWNED");
  const file = path.join(physical, "running.json");
  const before = await fs.lstat(file);
  if (!before.isFile() || before.size > MAX_RUN_MARKER_BYTES)
    throw new Error("NATIVE_STARTUP_MARKER_TYPE_OR_SIZE");
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > MAX_RUN_MARKER_BYTES
    )
      throw new Error("NATIVE_STARTUP_MARKER_CHANGED");
    const buffer = Buffer.alloc(MAX_RUN_MARKER_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    const finalPath = await fs.lstat(file);
    if (
      bytesRead > MAX_RUN_MARKER_BYTES ||
      bytesRead !== after.size ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      finalPath.dev !== opened.dev ||
      finalPath.ino !== opened.ino ||
      !finalPath.isFile()
    )
      throw new Error("NATIVE_STARTUP_MARKER_CHANGED");
    const marker = RunMarkerSchema.parse(
      JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
    );
    if (marker.pid !== pid)
      throw new Error("NATIVE_STARTUP_MARKER_WRONG_PROCESS");
    return marker;
  } finally {
    await handle.close();
  }
}
