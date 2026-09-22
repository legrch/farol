import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const IdentifierSchema = z.string().min(1).max(120);
const AbsolutePathSchema = z
  .string()
  .refine((value) => path.isAbsolute(value) && !value.includes("\0"));

export const DEV_MCP_PROOF_PREPARATION_BASENAME =
  "dev-mcp-proof-preparation.json";
export const DEV_MCP_PROOF_RECEIPT_BASENAME = "dev-mcp-proof-receipt.json";
export const DEV_MCP_PROOF_ATTEMPT_BASENAME = "dev-mcp-proof-attempt.json";
export const DEV_MCP_PROOF_ALLOWED_PATH = "sentinel.txt";
export const DEV_MCP_PROOF_DENIED_PATH = "outside-link.txt";

export const DevMcpProofPreparationSchema = z.strictObject({
  schema: z.literal(1),
  proofId: IdentifierSchema,
  environment: z.literal("dev"),
  buildId: Sha256Schema,
  workspaceId: IdentifierSchema,
  workspaceRoot: AbsolutePathSchema,
  computerGeneration: z.number().int().positive(),
  sentinelSha256: Sha256Schema,
  allowedPath: z.literal(DEV_MCP_PROOF_ALLOWED_PATH),
  deniedPath: z.literal(DEV_MCP_PROOF_DENIED_PATH),
  preparedAt: z.string().datetime(),
});

export type DevMcpProofPreparation = z.infer<
  typeof DevMcpProofPreparationSchema
>;

const ProofCallSchema = z.strictObject({
  callIdSha256: Sha256Schema,
  ownerId: IdentifierSchema,
  sessionId: IdentifierSchema,
  taskId: IdentifierSchema,
  taskEpoch: z.number().int().nonnegative(),
  participantId: IdentifierSchema,
  turnId: IdentifierSchema,
  generation: z.number().int().nonnegative(),
  recordedAt: z.string().datetime(),
});

export const DevMcpProofReceiptSchema = z.strictObject({
  schema: z.literal(1),
  proofId: IdentifierSchema,
  environment: z.literal("dev"),
  buildId: Sha256Schema,
  computerGeneration: z.number().int().positive(),
  workspaceId: IdentifierSchema,
  sentinelSha256: Sha256Schema,
  allowed: ProofCallSchema.extend({
    relativePath: z.literal(DEV_MCP_PROOF_ALLOWED_PATH),
    outputSha256: Sha256Schema,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(256 * 1_024),
  }).nullable(),
  denied: ProofCallSchema.extend({
    relativePath: z.literal(DEV_MCP_PROOF_DENIED_PATH),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/u)
      .max(120),
  }).nullable(),
});

export type DevMcpProofReceipt = z.infer<typeof DevMcpProofReceiptSchema>;

const DevMcpProofAttemptSchema = z.strictObject({
  schema: z.literal(1),
  proofId: IdentifierSchema,
  attemptedAt: z.string().datetime(),
});

function proofError(code: string): never {
  throw new Error(code);
}

async function ensurePrivateDirectory(root: string): Promise<void> {
  if (!path.isAbsolute(root) || root.includes("\0")) {
    proofError("DEV_MCP_PROOF_ROOT_INVALID");
  }
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(root);
  const effectiveUser = process.geteuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (effectiveUser !== undefined && info.uid !== effectiveUser)
  ) {
    proofError("DEV_MCP_PROOF_STATE_UNSAFE");
  }
  if ((info.mode & 0o077) !== 0) await fs.chmod(root, 0o700);
}

async function syncPrivateDirectory(root: string): Promise<void> {
  const directory = await fs.open(
    root,
    fsConstants.O_RDONLY | DIRECTORY | NO_FOLLOW | CLOSE_ON_EXEC,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writePrivateJson(target: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(path.dirname(target));
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
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
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
    await syncPrivateDirectory(path.dirname(target));
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readPrivateJson(target: string): Promise<unknown | null> {
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
    const effectiveUser = process.geteuid?.();
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size < 1 ||
      info.size > 32 * 1_024 ||
      (effectiveUser !== undefined && info.uid !== effectiveUser) ||
      (info.mode & 0o077) !== 0
    ) {
      proofError("DEV_MCP_PROOF_STATE_UNSAFE");
    }
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

export async function createDevMcpProofFixture(stateRoot: string): Promise<
  Readonly<{
    proofId: string;
    workspaceRoot: string;
    sentinelSha256: string;
  }>
> {
  await ensurePrivateDirectory(stateRoot);
  const proofId = randomUUID();
  const root = path.join(stateRoot, `proof-${proofId}`);
  const workspaceRoot = path.join(root, "grant");
  const outsideRoot = path.join(root, "outside");
  await ensurePrivateDirectory(workspaceRoot);
  await ensurePrivateDirectory(outsideRoot);
  const sentinel = `FAROL_DEV_${randomBytes(32).toString("base64url")}`;
  await fs.writeFile(
    path.join(workspaceRoot, DEV_MCP_PROOF_ALLOWED_PATH),
    sentinel,
    { mode: 0o600, flag: "wx" },
  );
  const outside = path.join(outsideRoot, "outside.txt");
  await fs.writeFile(outside, randomBytes(32).toString("base64url"), {
    mode: 0o600,
    flag: "wx",
  });
  await fs.symlink(
    outside,
    path.join(workspaceRoot, DEV_MCP_PROOF_DENIED_PATH),
  );
  return {
    proofId,
    workspaceRoot,
    sentinelSha256: createHash("sha256").update(sentinel).digest("hex"),
  };
}

export async function writeDevMcpProofPreparation(
  stateRoot: string,
  preparation: DevMcpProofPreparation,
): Promise<void> {
  await writePrivateJson(
    path.join(stateRoot, DEV_MCP_PROOF_PREPARATION_BASENAME),
    DevMcpProofPreparationSchema.parse(preparation),
  );
  await fs.rm(path.join(stateRoot, DEV_MCP_PROOF_RECEIPT_BASENAME), {
    force: true,
  });
  await fs.rm(path.join(stateRoot, DEV_MCP_PROOF_ATTEMPT_BASENAME), {
    force: true,
  });
}

export async function claimDevMcpProofAttempt(
  stateRoot: string,
  proofId: string,
): Promise<string> {
  await ensurePrivateDirectory(stateRoot);
  const target = path.join(stateRoot, DEV_MCP_PROOF_ATTEMPT_BASENAME);
  const attempt = DevMcpProofAttemptSchema.parse({
    schema: 1,
    proofId,
    attemptedAt: new Date().toISOString(),
  });
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
    await handle.writeFile(`${JSON.stringify(attempt, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncPrivateDirectory(stateRoot);
    return attempt.attemptedAt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      proofError("DEV_MCP_PROOF_ALREADY_ATTEMPTED");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readDevMcpProofPreparation(
  stateRoot: string,
): Promise<DevMcpProofPreparation | null> {
  const raw = await readPrivateJson(
    path.join(stateRoot, DEV_MCP_PROOF_PREPARATION_BASENAME),
  );
  if (raw === null) return null;
  const parsed = DevMcpProofPreparationSchema.safeParse(raw);
  if (!parsed.success) proofError("DEV_MCP_PROOF_STATE_INVALID");
  return parsed.data;
}

export async function readDevMcpProofReceipt(
  stateRoot: string,
): Promise<DevMcpProofReceipt | null> {
  const raw = await readPrivateJson(
    path.join(stateRoot, DEV_MCP_PROOF_RECEIPT_BASENAME),
  );
  if (raw === null) return null;
  const parsed = DevMcpProofReceiptSchema.safeParse(raw);
  if (!parsed.success) proofError("DEV_MCP_PROOF_RECEIPT_INVALID");
  return parsed.data;
}

export class PrivateDevMcpProofRecorder {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly preparation: DevMcpProofPreparation,
  ) {
    DevMcpProofPreparationSchema.parse(preparation);
    if (
      path.basename(preparation.workspaceRoot) !== "grant" ||
      path.basename(path.dirname(preparation.workspaceRoot)) !==
        `proof-${preparation.proofId}` ||
      path.dirname(path.dirname(preparation.workspaceRoot)) !== root
    ) {
      proofError("DEV_MCP_PROOF_ROOT_MISMATCH");
    }
  }

  observe(
    input: Readonly<{
      request: Readonly<{
        ownerId: string;
        sessionId: string;
        taskId: string;
        taskEpoch: number;
        participantId: string;
        turnId: string;
        generation: number;
        callId: string;
        workspaceId: string;
        operation: Readonly<{ kind: string; relativePath: string }>;
      }>;
      response:
        | Readonly<{
            ok: true;
            output: Readonly<{ kind: string; text?: string; bytes?: number }>;
          }>
        | Readonly<{ ok: false; errorCode: string }>;
    }>,
  ): Promise<void> {
    const { request } = input;
    if (
      request.workspaceId !== this.preparation.workspaceId ||
      request.operation.kind !== "workspace.read" ||
      (request.operation.relativePath !== this.preparation.allowedPath &&
        request.operation.relativePath !== this.preparation.deniedPath)
    ) {
      return Promise.resolve();
    }
    const write = this.writes.then(async () => {
      const existing =
        (await readDevMcpProofReceipt(this.root)) ??
        DevMcpProofReceiptSchema.parse({
          schema: 1,
          proofId: this.preparation.proofId,
          environment: "dev",
          buildId: this.preparation.buildId,
          computerGeneration: this.preparation.computerGeneration,
          workspaceId: this.preparation.workspaceId,
          sentinelSha256: this.preparation.sentinelSha256,
          allowed: null,
          denied: null,
        });
      const call = {
        callIdSha256: createHash("sha256").update(request.callId).digest("hex"),
        ownerId: request.ownerId,
        sessionId: request.sessionId,
        taskId: request.taskId,
        taskEpoch: request.taskEpoch,
        participantId: request.participantId,
        turnId: request.turnId,
        generation: request.generation,
        recordedAt: new Date().toISOString(),
      };
      let next = existing;
      if (
        request.operation.relativePath === this.preparation.allowedPath &&
        existing.allowed === null &&
        input.response.ok &&
        input.response.output.kind === "workspace.text" &&
        typeof input.response.output.text === "string" &&
        typeof input.response.output.bytes === "number"
      ) {
        next = {
          ...existing,
          allowed: {
            ...call,
            relativePath: DEV_MCP_PROOF_ALLOWED_PATH,
            outputSha256: createHash("sha256")
              .update(input.response.output.text)
              .digest("hex"),
            bytes: input.response.output.bytes,
          },
        };
      } else if (
        request.operation.relativePath === this.preparation.deniedPath &&
        existing.denied === null &&
        !input.response.ok
      ) {
        next = {
          ...existing,
          denied: {
            ...call,
            relativePath: DEV_MCP_PROOF_DENIED_PATH,
            errorCode: input.response.errorCode,
          },
        };
      } else {
        return;
      }
      await writePrivateJson(
        path.join(this.root, DEV_MCP_PROOF_RECEIPT_BASENAME),
        DevMcpProofReceiptSchema.parse(next),
      );
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
