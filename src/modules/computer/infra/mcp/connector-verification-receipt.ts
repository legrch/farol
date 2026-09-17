import { createHash, timingSafeEqual } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const CONNECTOR_VERIFICATION_RECEIPT_BASENAME =
  "connector-verification-receipt.json";
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const MAXIMUM_BYTES = 16 * 1_024;

const IdentifierSchema = z.string().min(1).max(120);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const ChallengeSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code >= 33 && code <= 126;
    }),
  );
const TimestampSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
});

const BindingSchema = z.strictObject({
  ownerId: IdentifierSchema,
  sessionId: IdentifierSchema,
  taskId: IdentifierSchema,
  taskEpoch: z.number().int().nonnegative(),
  participantId: IdentifierSchema,
  turnId: IdentifierSchema,
  generation: z.number().int().nonnegative(),
});

export const ConnectorVerificationReceiptSchema = BindingSchema.extend({
  schema: z.literal(1),
  challengeSha256: Sha256Schema,
  callIdSha256: Sha256Schema,
  workspaceId: IdentifierSchema,
  operation: z.literal("workspace.list"),
  entryCount: z.number().int().nonnegative().max(500),
  truncated: z.boolean(),
  recordedAt: TimestampSchema,
});

export type ConnectorVerificationReceipt = z.infer<
  typeof ConnectorVerificationReceiptSchema
>;

export type ConnectorVerificationRecordInput = Readonly<{
  challenge: string;
  binding: z.infer<typeof BindingSchema>;
  callId: string;
  workspaceId: string;
  entryCount: number;
  truncated: boolean;
}>;

export interface ConnectorVerificationRecorder {
  accepts(challenge: string): boolean;
  record(input: ConnectorVerificationRecordInput): Promise<
    Readonly<{
      receipt: ConnectorVerificationReceipt;
      receiptSha256: string;
    }>
  >;
}

type RecorderOptions = Readonly<{
  root: string;
  challengeSha256: string;
}>;

type RecorderDependencies = Readonly<{ now?: () => number }>;

function receiptError(code: string): never {
  throw new Error(code);
}

function assertRoot(root: string): void {
  if (!path.isAbsolute(root) || root.includes("\0")) {
    receiptError("CONNECTOR_VERIFICATION_ROOT_INVALID");
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
    receiptError("CONNECTOR_VERIFICATION_RECEIPT_UNSAFE");
  }
}

async function ensureRoot(root: string): Promise<void> {
  assertRoot(root);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(root);
  const effectiveUser = process.geteuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (effectiveUser !== undefined && info.uid !== effectiveUser)
  ) {
    receiptError("CONNECTOR_VERIFICATION_RECEIPT_UNSAFE");
  }
  if ((info.mode & 0o077) !== 0) await fs.chmod(root, 0o700);
}

async function syncRoot(root: string): Promise<void> {
  const directory = await fs.open(
    root,
    fsConstants.O_RDONLY |
      (fsConstants.O_DIRECTORY ?? 0) |
      NO_FOLLOW |
      CLOSE_ON_EXEC,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export class PrivateConnectorVerificationRecorder implements ConnectorVerificationRecorder {
  private readonly now: () => number;
  private readonly expectedDigest: Buffer;

  constructor(
    private readonly options: RecorderOptions,
    dependencies: RecorderDependencies = {},
  ) {
    assertRoot(options.root);
    this.expectedDigest = Buffer.from(
      Sha256Schema.parse(options.challengeSha256),
      "hex",
    );
    this.now = dependencies.now ?? Date.now;
  }

  accepts(challenge: string): boolean {
    const parsed = ChallengeSchema.safeParse(challenge);
    if (!parsed.success) return false;
    const observed = createHash("sha256").update(parsed.data).digest();
    return timingSafeEqual(this.expectedDigest, observed);
  }

  async record(input: ConnectorVerificationRecordInput): Promise<
    Readonly<{
      receipt: ConnectorVerificationReceipt;
      receiptSha256: string;
    }>
  > {
    const parsed = z
      .strictObject({
        challenge: ChallengeSchema,
        binding: BindingSchema,
        callId: IdentifierSchema,
        workspaceId: IdentifierSchema,
        entryCount: z.number().int().nonnegative().max(500),
        truncated: z.boolean(),
      })
      .safeParse(input);
    if (!parsed.success) receiptError("CONNECTOR_VERIFICATION_INPUT_INVALID");
    if (!this.accepts(parsed.data.challenge)) {
      receiptError("CONNECTOR_VERIFICATION_CHALLENGE_MISMATCH");
    }
    await ensureRoot(this.options.root);
    const receipt = ConnectorVerificationReceiptSchema.parse({
      schema: 1,
      challengeSha256: this.options.challengeSha256,
      ...parsed.data.binding,
      callIdSha256: createHash("sha256")
        .update(parsed.data.callId)
        .digest("hex"),
      workspaceId: parsed.data.workspaceId,
      operation: "workspace.list",
      entryCount: parsed.data.entryCount,
      truncated: parsed.data.truncated,
      recordedAt: new Date(this.now()).toISOString(),
    });
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
    const target = path.join(
      this.options.root,
      CONNECTOR_VERIFICATION_RECEIPT_BASENAME,
    );
    let handle;
    try {
      handle = await fs.open(
        target,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          NO_FOLLOW |
          CLOSE_ON_EXEC,
        0o600,
      );
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await syncRoot(this.options.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        receiptError("CONNECTOR_VERIFICATION_ALREADY_RECORDED");
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    return {
      receipt,
      receiptSha256: createHash("sha256").update(serialized).digest("hex"),
    };
  }
}

export async function readConnectorVerificationReceipt(
  root: string,
): Promise<ConnectorVerificationReceipt | null> {
  await ensureRoot(root);
  const target = path.join(root, CONNECTOR_VERIFICATION_RECEIPT_BASENAME);
  let handle;
  try {
    handle = await fs.open(
      target,
      fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    assertPrivateFile(info);
    if (info.size < 1 || info.size > MAXIMUM_BYTES) {
      receiptError("CONNECTOR_VERIFICATION_RECEIPT_INVALID");
    }
    const parsed = ConnectorVerificationReceiptSchema.safeParse(
      JSON.parse(await handle.readFile("utf8")) as unknown,
    );
    if (!parsed.success) {
      receiptError("CONNECTOR_VERIFICATION_RECEIPT_INVALID");
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof SyntaxError) {
      receiptError("CONNECTOR_VERIFICATION_RECEIPT_INVALID");
    }
    throw error;
  } finally {
    await handle.close();
  }
}

export async function clearConnectorVerificationReceipt(
  root: string,
): Promise<void> {
  await ensureRoot(root);
  const target = path.join(root, CONNECTOR_VERIFICATION_RECEIPT_BASENAME);
  try {
    assertPrivateFile(await fs.lstat(target));
    await fs.unlink(target);
    await syncRoot(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
