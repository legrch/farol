import { createHash, randomBytes } from "node:crypto";
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
import { parseCoreArtifactDeclaration } from "../../../apps/desktop/bridge/attested-core";
import type { BuildIdentity } from "../../pkg/build-info/identity";
import type { DesktopEnvironment } from "./desktop-environment";

const sourceCommit = z.string().regex(/^[a-f0-9]{40}$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const sourceTreeDigest = sha256;
const nonce = z.string().regex(/^[a-f0-9]{32}$/u);

const buildIdentityFields = z.object({
  buildId: sha256,
  sourceCommit,
  sourceTreeDigest,
  dirty: z.boolean(),
  inputExact: z.boolean(),
  inputLedgerSha256: sha256,
});
const buildIdentitySchema = z.discriminatedUnion("schema", [
  buildIdentityFields.extend({
    schema: z.literal(3),
    core: z.never().optional(),
  }),
  buildIdentityFields.extend({ schema: z.literal(4), core: z.unknown() }),
]);

const instanceIdentitySchema = z.strictObject({
  schema: z.literal("farol.next.single-instance/2"),
  nonce,
  environment: z.enum(["preview", "dev"]),
  sourceCommit,
  sourceTreeDigest,
  inputLedgerSha256: sha256,
});

const backgroundInstanceRequestSchema = instanceIdentitySchema.extend({
  schema: z.literal("farol.next.single-instance/3"),
  backgroundOnly: z.literal(true),
});

const instanceRequestSchema = z.discriminatedUnion("schema", [
  instanceIdentitySchema,
  backgroundInstanceRequestSchema,
]);

const instanceAcknowledgementSchema = instanceIdentitySchema.extend({
  status: z.enum(["reopened", "identity-mismatch", "reopen-failed"]),
});

export type LaunchIdentity = Readonly<{
  environment: DesktopEnvironment;
  sourceCommit: string;
  sourceTreeDigest: string;
  inputLedgerSha256: string;
}>;

export type InstanceRequest =
  | (z.infer<typeof instanceIdentitySchema> & { backgroundOnly?: never })
  | z.infer<typeof backgroundInstanceRequestSchema>;
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
const MAX_INPUT_MANIFEST_BYTES = 16 * 1024 * 1024;
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
    left.environment === right.environment &&
    left.sourceCommit === right.sourceCommit &&
    left.sourceTreeDigest === right.sourceTreeDigest &&
    left.inputLedgerSha256 === right.inputLedgerSha256
  );
}

export function createInstanceRequest(
  identity: LaunchIdentity,
  backgroundOnly = false,
): InstanceRequest {
  const request = {
    nonce: randomBytes(16).toString("hex"),
    ...identity,
  };
  return backgroundOnly
    ? {
        schema: "farol.next.single-instance/3",
        ...request,
        backgroundOnly: true,
      }
    : { schema: "farol.next.single-instance/2", ...request };
}

export function secondInstanceRefusalMessage(
  request: InstanceRequest,
  acknowledgement: InstanceAcknowledgement | null,
): string {
  if (request.backgroundOnly && acknowledgement === null) {
    return "Farol Next could not confirm background-only admission with the running instance. Quit it before starting a hidden instance.";
  }
  if (
    request.backgroundOnly &&
    acknowledgement?.status === "reopen-failed" &&
    sameLaunchIdentity(request, acknowledgement)
  ) {
    return "Farol Next refused the background launch because this exact candidate is already running. Quit it before starting a hidden instance.";
  }
  return "Farol Next refused the second launch because the running build could not be verified as this exact candidate.";
}

export function decideSecondInstance(
  primary: LaunchIdentity,
  candidate: unknown,
): SecondInstanceDecision | null {
  const request = parseRequest(candidate);
  if (!request) return null;
  return {
    nonce: request.nonce,
    status: !sameLaunchIdentity(primary, request)
      ? "identity-mismatch"
      : request.backgroundOnly
        ? "reopen-failed"
        : "reopened",
  };
}

function readBoundedRegularFile(file: string, maximumBytes: number): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      file,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | CLOSE_ON_EXEC,
    );
    const info = fstatSync(descriptor);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size < 1 ||
      info.size > maximumBytes
    ) {
      throw new Error("invalid manifest type");
    }
    return readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readBuildLaunchIdentity(
  directory: string,
  environment: DesktopEnvironment,
  runtimeIdentity: BuildIdentity,
): LaunchIdentity {
  try {
    const parsed = buildIdentitySchema.safeParse(
      JSON.parse(
        readBoundedRegularFile(
          path.join(directory, "build-manifest.json"),
          MAX_MANIFEST_BYTES,
        ).toString("utf8"),
      ),
    );
    if (!parsed.success) throw new Error("invalid manifest identity");
    const manifest = parsed.data;
    if (
      manifest.buildId !== runtimeIdentity.buildId ||
      manifest.sourceCommit !== runtimeIdentity.sourceCommit ||
      manifest.sourceTreeDigest !== runtimeIdentity.sourceTreeDigest ||
      manifest.dirty !== runtimeIdentity.sourceDirty
    ) {
      throw new Error("manifest does not match runtime identity");
    }
    if (manifest.schema === 4) {
      const core = parseCoreArtifactDeclaration(manifest.core);
      if (
        core.build.buildId !== manifest.buildId ||
        core.build.sourceSHA !== manifest.sourceCommit ||
        core.build.sourceTreeDigest !== manifest.sourceTreeDigest ||
        manifest.dirty ||
        !manifest.inputExact
      ) {
        throw new Error("Go manifest does not match exact build identity");
      }
    }
    if (environment === "preview" && (manifest.dirty || !manifest.inputExact)) {
      throw new Error("candidate identity is not exact");
    }
    const ledger = readBoundedRegularFile(
      path.join(directory, "input-manifest.json"),
      MAX_INPUT_MANIFEST_BYTES,
    );
    const ledgerDigest = createHash("sha256").update(ledger).digest("hex");
    if (ledgerDigest !== manifest.inputLedgerSha256) {
      throw new Error("input manifest digest mismatch");
    }
    return {
      environment,
      sourceCommit: manifest.sourceCommit,
      sourceTreeDigest: manifest.sourceTreeDigest,
      inputLedgerSha256: manifest.inputLedgerSha256,
    };
  } catch {
    throw new Error("INSTANCE_BUILD_IDENTITY_INVALID");
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
    schema: "farol.next.single-instance/2",
    nonce: request.nonce,
    environment: identity.environment,
    sourceCommit: identity.sourceCommit,
    sourceTreeDigest: identity.sourceTreeDigest,
    inputLedgerSha256: identity.inputLedgerSha256,
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

/**
 * How many published acknowledgements are present that this launch is not
 * waiting for.
 *
 * A timeout has two very different causes and one message today. Either the
 * primary published nothing, or it published an acknowledgement addressed to
 * a different launch — which means the two sides disagree about the nonce and
 * no amount of waiting will ever help. The count says which, and a count of
 * files is content-free.
 */
export async function foreignAcknowledgementCount(
  userData: string,
  candidate: unknown,
): Promise<number> {
  const request = parseRequest(candidate);
  if (!request) throw new Error("INSTANCE_REQUEST_INVALID");
  const entries = await fs
    .readdir(acknowledgementDirectory(userData))
    .catch(() => [] as string[]);
  return entries.filter(
    (entry) => entry.endsWith(".json") && entry !== `${request.nonce}.json`,
  ).length;
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
