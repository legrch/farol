import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// Private, on-disk state for the Farol Model loopback endpoint: the bearer
// token Codex authenticates with, the port the endpoint binds and reuses
// across launches, and a liveness marker the shipped credential helper reads
// to tell "Farol is running" from "Farol is not running" without a network
// round trip. Every file here is 0600, inside a 0700 root this process owns
// — the same shape `connector-key-store.ts` uses for the tunnel credential.

const TOKEN_FILE = "model-endpoint-token";
const PORT_FILE = "model-endpoint-port";
const LIVENESS_FILE = "model-endpoint-liveness";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

export type FarolModelLiveness = Readonly<{
  pid: number;
  port: number;
  startedAtIso: string;
}>;

function stateError(code: string): never {
  throw new Error(code);
}

async function atomicWrite(
  root: string,
  fileName: string,
  contents: string,
): Promise<void> {
  const target = path.join(root, fileName);
  await assertReplaceableTarget(target);
  const temporary = path.join(root, `.${fileName}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
      0o600,
    );
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function assertPrivateFile(info: Stats): void {
  const effectiveUser = process.geteuid?.();
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (effectiveUser !== undefined && info.uid !== effectiveUser) ||
    (info.mode & 0o077) !== 0
  ) {
    stateError("FAROL_MODEL_STATE_UNSAFE");
  }
}

async function assertReplaceableTarget(target: string): Promise<void> {
  try {
    assertPrivateFile(await fs.lstat(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function readPrivateFile(
  root: string,
  fileName: string,
): Promise<string | undefined> {
  const target = path.join(root, fileName);
  try {
    assertPrivateFile(await fs.lstat(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return fs.readFile(target, "utf8");
}

/**
 * Private on-disk state for one Farol Model endpoint instance: the bearer
 * token Codex authenticates with, the port persisted across launches, and a
 * liveness marker the credential helper reads.
 */
export class FarolModelRuntimeState {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root) || root.includes("\0")) {
      throw new Error("FAROL_MODEL_STATE_ROOT_NOT_ABSOLUTE");
    }
  }

  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.root);
    const effectiveUser = process.geteuid?.();
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (effectiveUser !== undefined && info.uid !== effectiveUser)
    ) {
      stateError("FAROL_MODEL_STATE_UNSAFE");
    }
    if ((info.mode & 0o077) !== 0) await fs.chmod(this.root, 0o700);
  }

  /** Returns the current token, minting one on first use. */
  async ensureToken(): Promise<string> {
    await this.ensureRoot();
    const existing = await readPrivateFile(this.root, TOKEN_FILE);
    if (existing !== undefined && existing.length > 0) return existing;
    return this.rotateToken();
  }

  async currentToken(): Promise<string | undefined> {
    await this.ensureRoot();
    return readPrivateFile(this.root, TOKEN_FILE);
  }

  /** Rotates the token on demand; the previous token stops authenticating. */
  async rotateToken(): Promise<string> {
    await this.ensureRoot();
    const token = randomBytes(32).toString("base64url");
    await atomicWrite(this.root, TOKEN_FILE, token);
    return token;
  }

  async persistPort(port: number): Promise<void> {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error("FAROL_MODEL_STATE_PORT_INVALID");
    }
    await this.ensureRoot();
    await atomicWrite(this.root, PORT_FILE, String(port));
  }

  async persistedPort(): Promise<number | undefined> {
    await this.ensureRoot();
    const raw = await readPrivateFile(this.root, PORT_FILE);
    if (raw === undefined) return undefined;
    const port = Number.parseInt(raw, 10);
    return Number.isInteger(port) && port > 0 && port <= 65535
      ? port
      : undefined;
  }

  async markLive(liveness: FarolModelLiveness): Promise<void> {
    await this.ensureRoot();
    await atomicWrite(this.root, LIVENESS_FILE, JSON.stringify(liveness));
  }

  async clearLiveness(): Promise<void> {
    await this.ensureRoot();
    await fs
      .rm(path.join(this.root, LIVENESS_FILE), { force: true })
      .catch(() => undefined);
  }

  /**
   * Reads the liveness marker and confirms the recorded process still
   * exists. A marker whose process is gone (a crash that skipped cleanup)
   * reads as not running, never as a stale positive.
   */
  async readLiveness(): Promise<FarolModelLiveness | undefined> {
    await this.ensureRoot();
    const raw = await readPrivateFile(this.root, LIVENESS_FILE);
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { pid?: unknown }).pid !== "number" ||
      typeof (parsed as { port?: unknown }).port !== "number" ||
      typeof (parsed as { startedAtIso?: unknown }).startedAtIso !== "string"
    ) {
      return undefined;
    }
    const liveness = parsed as FarolModelLiveness;
    if (!processIsAlive(liveness.pid)) return undefined;
    return liveness;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
