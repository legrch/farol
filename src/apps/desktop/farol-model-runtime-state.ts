import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// Private, on-disk state for the Farol Model loopback endpoint: the bearer
// token Codex authenticates with, the port the endpoint binds and reuses
// across launches, and a liveness marker the shipped token helper reads to
// tell "Farol is running" from "Farol is not running" without a network
// round trip. Every file here is 0600, inside a 0700 root this process owns
// — the same shape `connector-key-store.ts` uses for the tunnel credential.

const TOKEN_FILE = "model-endpoint-token";
const PORT_FILE = "model-endpoint-port";
const LIVENESS_FILE = "model-endpoint-liveness";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

/**
 * The only shape a minted token ever has: 32 random bytes as base64url, 43
 * characters, nothing else. Anything on disk that does not match — an empty
 * file, a stray newline, a hand-edited value — is treated as no token at
 * all, so the endpoint can never end up accepting `Bearer ` with nothing
 * after it.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/u;

export function isFarolModelToken(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}

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
 * liveness marker the token helper reads.
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

  /**
   * Returns the current token, minting one on first use — and re-minting
   * when the file on disk is empty or does not hold a well-formed token.
   */
  async ensureToken(): Promise<string> {
    const existing = await this.currentToken();
    if (existing !== undefined) return existing;
    return this.rotateToken();
  }

  /** The current token, or undefined when there is none or the file is unusable. */
  async currentToken(): Promise<string | undefined> {
    await this.ensureRoot();
    const raw = await readPrivateFile(this.root, TOKEN_FILE);
    if (raw === undefined || !isFarolModelToken(raw)) return undefined;
    return raw;
  }

  /** Rotates the token on demand; the previous token stops authenticating. */
  async rotateToken(): Promise<string> {
    await this.ensureRoot();
    const token = randomBytes(32).toString("base64url");
    await atomicWrite(this.root, TOKEN_FILE, token);
    return token;
  }

  /**
   * Puts a token this process previously read back in place. Used only to
   * undo a rotation whose config-block rewrite then failed (S35-H2-1): the
   * owner's Codex config still carries the earlier literal, so leaving the
   * new token in place would silently stop that config authenticating.
   * Refuses anything that is not a well-formed token, so this can never
   * install a value a caller invented.
   */
  async restoreToken(token: string): Promise<void> {
    if (!isFarolModelToken(token)) {
      stateError("FAROL_MODEL_STATE_TOKEN_INVALID");
    }
    await this.ensureRoot();
    await atomicWrite(this.root, TOKEN_FILE, token);
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
