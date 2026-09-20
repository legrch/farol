import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const sourceCommit = z.string().regex(/^[a-f0-9]{40}$/u);
const sourceTreeDigest = z.string().regex(/^[a-f0-9]{64}$/u);
const nonce = z.string().regex(/^[a-f0-9]{32}$/u);

const buildIdentitySchema = z.object({
  schema: z.literal(3),
  sourceCommit,
  sourceTreeDigest,
  dirty: z.literal(false),
  inputExact: z.literal(true),
});

const instanceRequestSchema = z.strictObject({
  schema: z.literal("farol.next.single-instance/1"),
  nonce,
  sourceCommit,
  sourceTreeDigest,
});

const instanceAcknowledgementSchema = instanceRequestSchema.extend({
  status: z.enum(["reopened", "identity-mismatch", "reopen-failed"]),
});

export type LaunchIdentity = Readonly<{
  sourceCommit: string;
  sourceTreeDigest: string;
}>;

export type InstanceRequest = z.infer<typeof instanceRequestSchema>;
export type InstanceAcknowledgement = z.infer<
  typeof instanceAcknowledgementSchema
>;

export type SecondInstanceDecision = Readonly<{
  nonce: string;
  status: InstanceAcknowledgement["status"];
}>;

export type AcknowledgementPublicationOptions = Readonly<{
  afterAtomicPublish?: () => Promise<void>;
}>;

const ACK_DIRECTORY = "single-instance-acks";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ACK_BYTES = 4 * 1024;
const DEFAULT_ACK_TIMEOUT_MS = 10_000;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

function parseRequest(value: unknown): InstanceRequest | null {
  const parsed = instanceRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The reasons publishing an acknowledgement can fail, as a fixed vocabulary.
 *
 * The primary cannot print the error itself: a filesystem error carries the
 * user-data path, and this product does not put private paths in a log. A
 * token from this list says what went wrong without saying where.
 */
const ACKNOWLEDGEMENT_FAILURES = new Set([
  "INSTANCE_REQUEST_INVALID",
  "INSTANCE_ACK_DIRECTORY_UNSAFE",
  "INSTANCE_ACK_UNSAFE",
  "INSTANCE_ACK_INVALID",
]);

export function acknowledgementFailureCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9]*$/u.test(code)) return code;
  const message = error instanceof Error ? error.message : "";
  return ACKNOWLEDGEMENT_FAILURES.has(message) ? message : "unknown";
}

export function sameLaunchIdentity(
  left: LaunchIdentity,
  right: LaunchIdentity,
): boolean {
  return (
    left.sourceCommit === right.sourceCommit &&
    left.sourceTreeDigest === right.sourceTreeDigest
  );
}

export function createInstanceRequest(
  identity: LaunchIdentity,
): InstanceRequest {
  return {
    schema: "farol.next.single-instance/1",
    nonce: randomBytes(16).toString("hex"),
    ...identity,
  };
}

export function decideSecondInstance(
  primary: LaunchIdentity,
  candidate: unknown,
): SecondInstanceDecision | null {
  const request = parseRequest(candidate);
  if (!request) return null;
  return {
    nonce: request.nonce,
    status: sameLaunchIdentity(primary, request)
      ? "reopened"
      : "identity-mismatch",
  };
}

export function readBuildLaunchIdentity(directory: string): LaunchIdentity {
  const manifestPath = path.join(directory, "build-manifest.json");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      manifestPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | CLOSE_ON_EXEC,
    );
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_MANIFEST_BYTES) {
      throw new Error("invalid manifest type");
    }
    const parsed = buildIdentitySchema.safeParse(
      JSON.parse(readFileSync(descriptor, "utf8")),
    );
    if (!parsed.success) throw new Error("invalid manifest identity");
    return {
      sourceCommit: parsed.data.sourceCommit,
      sourceTreeDigest: parsed.data.sourceTreeDigest,
    };
  } catch {
    throw new Error("INSTANCE_BUILD_IDENTITY_INVALID");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function acknowledgementDirectory(userData: string): string {
  return path.join(userData, ACK_DIRECTORY);
}

function acknowledgementPath(userData: string, requestNonce: string): string {
  return path.join(acknowledgementDirectory(userData), `${requestNonce}.json`);
}

async function ensureAcknowledgementDirectory(userData: string): Promise<void> {
  const directory = acknowledgementDirectory(userData);
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await fs.lstat(directory);
  const effectiveUser = process.geteuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (effectiveUser !== undefined && info.uid !== effectiveUser) ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error("INSTANCE_ACK_DIRECTORY_UNSAFE");
  }
}

export async function writeInstanceAcknowledgement(
  userData: string,
  candidate: unknown,
  status: InstanceAcknowledgement["status"],
  primary?: LaunchIdentity,
  options: AcknowledgementPublicationOptions = {},
): Promise<void> {
  const request = parseRequest(candidate);
  if (!request) throw new Error("INSTANCE_REQUEST_INVALID");
  await ensureAcknowledgementDirectory(userData);
  const identity = primary ?? request;
  const acknowledgement: InstanceAcknowledgement = {
    schema: request.schema,
    nonce: request.nonce,
    sourceCommit: identity.sourceCommit,
    sourceTreeDigest: identity.sourceTreeDigest,
    status,
  };
  const file = acknowledgementPath(userData, request.nonce);
  const temporary = path.join(
    acknowledgementDirectory(userData),
    `.${request.nonce}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const handle = await fs.open(
    temporary,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0) |
      CLOSE_ON_EXEC,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(acknowledgement)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  let temporaryExists = true;
  try {
    await fs.link(temporary, file);
    await options.afterAtomicPublish?.();
    await fs.unlink(temporary);
    temporaryExists = false;
    const directory = await fs.open(
      acknowledgementDirectory(userData),
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        (fsConstants.O_NOFOLLOW ?? 0) |
        CLOSE_ON_EXEC,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (temporaryExists) {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
}

async function readAcknowledgement(
  userData: string,
  request: InstanceRequest,
): Promise<InstanceAcknowledgement | null> {
  const file = acknowledgementPath(userData, request.nonce);
  let handle;
  try {
    handle = await fs.open(
      file,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | CLOSE_ON_EXEC,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    const effectiveUser = process.geteuid?.();
    if (
      !info.isFile() ||
      info.nlink > 2 ||
      info.size < 1 ||
      info.size > MAX_ACK_BYTES ||
      (effectiveUser !== undefined && info.uid !== effectiveUser) ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error("INSTANCE_ACK_UNSAFE");
    }
    if (info.nlink === 2) return null;
    const parsed = instanceAcknowledgementSchema.safeParse(
      JSON.parse(await handle.readFile("utf8")),
    );
    if (!parsed.success || parsed.data.nonce !== request.nonce) {
      throw new Error("INSTANCE_ACK_INVALID");
    }
    await fs.unlink(file);
    return parsed.data;
  } finally {
    await handle.close();
  }
}

export async function waitForInstanceAcknowledgement(
  userData: string,
  candidate: unknown,
  options: Readonly<{ timeoutMs?: number; pollMs?: number }> = {},
): Promise<InstanceAcknowledgement | null> {
  const request = parseRequest(candidate);
  if (!request) throw new Error("INSTANCE_REQUEST_INVALID");
  await ensureAcknowledgementDirectory(userData);
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  do {
    const acknowledgement = await readAcknowledgement(userData, request);
    if (acknowledgement) return acknowledgement;
    await delay(pollMs);
  } while (Date.now() < deadline);
  return null;
}
