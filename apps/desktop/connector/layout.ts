import fs from "node:fs/promises";
import path from "node:path";
import { runtimeError } from "./command";

// Where the connector keeps its profile, state and runtime files under one
// private root, and the checked reads and writes of those files. Every path
// must be a directory or a single-link regular file owned by this user, never
// a symlink, so a planted entry is refused instead of followed. The root is a
// value passed in; the runtime keeps every owner of what these files describe.

const HEALTH_URL_FILE = "health.url";
const PID_FILE = "tunnel-client.pid";

export function profileRoot(root: string): string {
  return path.join(root, "profiles");
}

export function stateRoot(root: string): string {
  return path.join(root, "state");
}

export function runtimeRoot(root: string): string {
  return path.join(root, "runtime");
}

export function healthUrlFile(root: string): string {
  return path.join(runtimeRoot(root), HEALTH_URL_FILE);
}

export function pidFile(root: string): string {
  return path.join(runtimeRoot(root), PID_FILE);
}

export async function ensureRoots(root: string): Promise<void> {
  for (const directory of [
    root,
    profileRoot(root),
    stateRoot(root),
    runtimeRoot(root),
  ]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(directory);
    const effectiveUser = process.geteuid?.();
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (effectiveUser !== undefined && info.uid !== effectiveUser)
    ) {
      runtimeError("CONNECTOR_RUNTIME_UNSAFE");
    }
    if ((info.mode & 0o077) !== 0) await fs.chmod(directory, 0o700);
  }
}

export async function removeRuntimeFile(file: string): Promise<void> {
  try {
    const info = await fs.lstat(file);
    const effectiveUser = process.geteuid?.();
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (effectiveUser !== undefined && info.uid !== effectiveUser)
    ) {
      runtimeError("CONNECTOR_RUNTIME_UNSAFE");
    }
    await fs.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export async function readHealthBaseUrl(file: string): Promise<string | null> {
  try {
    const info = await fs.lstat(file);
    const effectiveUser = process.geteuid?.();
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size < 1 ||
      info.size > 256 ||
      (effectiveUser !== undefined && info.uid !== effectiveUser)
    ) {
      runtimeError("CONNECTOR_RUNTIME_UNSAFE");
    }
    const value = (await fs.readFile(file, "utf8")).trim();
    const parsed = new URL(value);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.port === ""
    ) {
      return null;
    }
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    if ((info.mode & 0o077) !== 0) {
      await fs.chmod(file, 0o600);
    }
    return `http://127.0.0.1:${port}`;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof TypeError
    ) {
      return null;
    }
    throw error;
  }
}
