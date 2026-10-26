import fs from "node:fs";
import path from "node:path";
import { RunMarkerSchema } from "../src/apps/desktop/run-marker.ts";
import { parseQuitReceipt } from "../src/apps/desktop/quit-receipt.ts";

function identity(directory) {
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o700 ||
    fs.realpathSync(directory) !== directory
  )
    throw Error("DEV_QUIT_ROOT_UNSAFE");
  return `${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}`;
}
function readRecord(file) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 8192 ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600
    )
      throw Error("DEV_QUIT_RECORD_UNSAFE");
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}
/** Observe this original child's marker before forwarding its first stop. */
export function captureDevQuit(stateRoot, pid, now = Date.now()) {
  try {
    const root = identity(stateRoot);
    const marker = RunMarkerSchema.parse(
      JSON.parse(readRecord(path.join(stateRoot, "running.json"))),
    );
    if (marker.pid !== pid || Date.parse(marker.startedAt) > now) return null;
    let previous = null;
    try {
      previous = readRecord(path.join(stateRoot, "last-quit.json"));
    } catch (error) {
      if (error.code !== "ENOENT") return null;
    }
    if (identity(stateRoot) !== root) return null;
    return { stateRoot, root, pid, requestedAt: now, previous };
  } catch {
    return null;
  }
}
/** Exit zero requires actual original close plus a fresh durable drain, never absence alone. */
export function confirmedDevQuit(
  request,
  outcome,
  escalated,
  now = Date.now(),
) {
  if (
    !request ||
    outcome.status !== 0 ||
    outcome.signal !== null ||
    outcome.error ||
    escalated
  )
    return false;
  try {
    if (identity(request.stateRoot) !== request.root) return false;
    try {
      fs.lstatSync(path.join(request.stateRoot, "running.json"));
      return false;
    } catch (error) {
      if (error.code !== "ENOENT") return false;
    }
    const text = readRecord(path.join(request.stateRoot, "last-quit.json"));
    const parsed = parseQuitReceipt(text);
    return (
      text !== request.previous &&
      parsed.ok &&
      parsed.receipt.drained &&
      parsed.receipt.unconfirmed.length === 0 &&
      Date.parse(parsed.receipt.at) >= request.requestedAt &&
      Date.parse(parsed.receipt.at) <= now &&
      identity(request.stateRoot) === request.root
    );
  } catch {
    return false;
  }
}
