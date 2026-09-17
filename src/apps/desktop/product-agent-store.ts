import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const boundedId = z.string().min(1).max(120);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const absolutePath = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => path.isAbsolute(value) && path.normalize(value) === value);
const timestamp = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
});

export const ProductAgentInputSchema = z.strictObject({
  taskId: boundedId,
  sessionId: boundedId,
  assignmentId: boundedId,
  authorityId: boundedId,
  parentParticipantId: boundedId,
  agentParticipantId: boundedId,
  taskEpoch: z.number().int().nonnegative(),
  generation: z.number().int().positive(),
  workspaceId: boundedId,
  focusPath: absolutePath,
  objective: z
    .string()
    .trim()
    .min(1)
    .max(8_000)
    .refine((value) => !value.includes("\0")),
  computerGeneration: z.number().int().nonnegative(),
  executableSha256: sha256,
  schemaSha256: sha256,
  buildId: boundedId,
  expiresAt: z.number().int().positive(),
  createdAt: timestamp,
});

const envelopeSchema = z.strictObject({
  schema: z.literal(1),
  kind: z.literal("product_agent_input"),
  input: ProductAgentInputSchema,
});

export type ProductAgentInput = z.infer<typeof ProductAgentInputSchema>;

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const MAXIMUM_BYTES = 32 * 1_024;

type ProductAgentStoreOptions = Readonly<{ root: string }>;
type ProductAgentStoreDependencies = Readonly<{
  beforeCommit?: () => Promise<void>;
}>;

function stateError(code: string): never {
  throw new Error(code);
}

function digestTask(taskId: string): string {
  return createHash("sha256").update(taskId).digest("hex");
}

export class PrivateProductAgentStore {
  constructor(
    private readonly options: ProductAgentStoreOptions,
    private readonly dependencies: ProductAgentStoreDependencies = {},
  ) {
    if (!path.isAbsolute(options.root)) {
      throw new Error("PRODUCT_AGENT_ROOT_NOT_ABSOLUTE");
    }
  }

  async load(taskId: string): Promise<ProductAgentInput | null> {
    const parsedTaskId = boundedId.safeParse(taskId);
    if (!parsedTaskId.success) stateError("PRODUCT_AGENT_INPUT_INVALID");
    await this.ensureRoot();
    const target = this.target(parsedTaskId.data);
    let handle;
    try {
      handle = await fs.open(
        target,
        fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code === "ELOOP") stateError("PRODUCT_AGENT_STATE_UNSAFE");
      throw error;
    }
    try {
      const info = await handle.stat();
      this.assertPrivateFile(info);
      if (info.size > MAXIMUM_BYTES) stateError("PRODUCT_AGENT_STATE_CORRUPT");
      let value: unknown;
      try {
        value = JSON.parse(await handle.readFile("utf8")) as unknown;
      } catch {
        stateError("PRODUCT_AGENT_STATE_CORRUPT");
      }
      const parsed = envelopeSchema.safeParse(value);
      if (!parsed.success || parsed.data.input.taskId !== parsedTaskId.data) {
        stateError("PRODUCT_AGENT_STATE_CORRUPT");
      }
      return parsed.data.input;
    } finally {
      await handle.close();
    }
  }

  async save(input: ProductAgentInput): Promise<void> {
    const validated = ProductAgentInputSchema.parse(input);
    await this.ensureRoot();
    const target = this.target(validated.taskId);
    await this.assertReplaceableTarget(target);
    const temporary = path.join(
      this.options.root,
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
      await handle.writeFile(
        `${JSON.stringify({ schema: 1, kind: "product_agent_input", input: validated }, null, 2)}\n`,
        "utf8",
      );
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.dependencies.beforeCommit?.();
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600);
      await this.syncRoot();
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async remove(taskId: string): Promise<void> {
    const parsedTaskId = boundedId.safeParse(taskId);
    if (!parsedTaskId.success) stateError("PRODUCT_AGENT_INPUT_INVALID");
    await this.ensureRoot();
    const target = this.target(parsedTaskId.data);
    try {
      this.assertPrivateFile(await fs.lstat(target));
      await fs.unlink(target);
      await this.syncRoot();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private target(taskId: string): string {
    return path.join(this.options.root, `${digestTask(taskId)}.json`);
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.options.root);
    const effectiveUser = process.geteuid?.();
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (effectiveUser !== undefined && info.uid !== effectiveUser)
    ) {
      stateError("PRODUCT_AGENT_STATE_UNSAFE");
    }
    if ((info.mode & 0o077) !== 0) await fs.chmod(this.options.root, 0o700);
  }

  private assertPrivateFile(info: Stats): void {
    const effectiveUser = process.geteuid?.();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (effectiveUser !== undefined && info.uid !== effectiveUser) ||
      (info.mode & 0o077) !== 0
    ) {
      stateError("PRODUCT_AGENT_STATE_UNSAFE");
    }
  }

  private async assertReplaceableTarget(target: string): Promise<void> {
    try {
      this.assertPrivateFile(await fs.lstat(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private async syncRoot(): Promise<void> {
    const directory = await fs.open(
      this.options.root,
      fsConstants.O_RDONLY | DIRECTORY | NO_FOLLOW | CLOSE_ON_EXEC,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
