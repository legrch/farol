import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const EXECUTION_FENCE_DIRECTORY = "execution-fence";

const MAXIMUM_RECORD_BYTES = 4 * 1_024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

// A phase during which no Computer tool may execute. The desktop raises one
// per summary-only operation and the connector's MCP process reads them
// through the launch root both share. Records carry identities only.
const fenceRecordSchema = z.strictObject({
  schema: z.literal(1),
  kind: z.literal("summary_only_phase"),
  operationId: z.string().min(1).max(160),
  taskId: z.string().min(1).max(160),
  raisedAt: z.string().min(1).max(64),
});

export type ExecutionFenceRecord = z.infer<typeof fenceRecordSchema>;

export type ExecutionFenceAdmission =
  | Readonly<{ admitted: true }>
  | Readonly<{
      admitted: false;
      code:
        "COMPUTER_SUMMARY_PHASE_ACTIVE" | "COMPUTER_EXECUTION_FENCE_UNREADABLE";
    }>;

export type ExecutionFenceReader = Readonly<{
  admits(): Promise<ExecutionFenceAdmission>;
}>;

function fileName(operationId: string): string {
  return `${createHash("sha256").update(operationId).digest("hex")}.json`;
}

/**
 * The fence as files under the launch root: one record per raised
 * operation. Any record, readable or not, fences execution; the directory
 * being absent or empty admits it. The connector's process never writes.
 */
export class PrivateExecutionFence implements ExecutionFenceReader {
  private readonly directory: string;

  constructor(options: Readonly<{ root: string }>) {
    if (!path.isAbsolute(options.root) || options.root.includes("\0")) {
      throw new Error("EXECUTION_FENCE_ROOT_NOT_ABSOLUTE");
    }
    this.directory = path.join(options.root, EXECUTION_FENCE_DIRECTORY);
  }

  async raise(
    input: Readonly<{ operationId: string; taskId: string; now?: number }>,
  ): Promise<void> {
    const record = fenceRecordSchema.parse({
      schema: 1,
      kind: "summary_only_phase",
      operationId: input.operationId,
      taskId: input.taskId,
      raisedAt: new Date(input.now ?? Date.now()).toISOString(),
    });
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, fileName(input.operationId));
    const temporary = `${target}.${process.pid}.tmp`;
    const handle = await fs.open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    await this.syncDirectory();
  }

  async lower(operationId: string): Promise<void> {
    try {
      await fs.unlink(path.join(this.directory, fileName(operationId)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await this.syncDirectory();
  }

  // Every record, whatever raised it: for a start at which no summary can
  // be running, so a fence a crash left behind does not outlive it.
  async clear(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      await fs.rm(path.join(this.directory, entry), { force: true });
    }
    await this.syncDirectory();
  }

  async admits(): Promise<ExecutionFenceAdmission> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { admitted: true };
      }
      return { admitted: false, code: "COMPUTER_EXECUTION_FENCE_UNREADABLE" };
    }
    const records = entries.filter((entry) =>
      /^[a-f0-9]{64}\.json$/u.test(entry),
    );
    if (records.length === 0) return { admitted: true };
    for (const entry of records) {
      const file = path.join(this.directory, entry);
      try {
        const info = await fs.lstat(file);
        if (!info.isFile() || info.size > MAXIMUM_RECORD_BYTES) {
          return {
            admitted: false,
            code: "COMPUTER_EXECUTION_FENCE_UNREADABLE",
          };
        }
        const parsed = fenceRecordSchema.safeParse(
          JSON.parse(await fs.readFile(file, "utf8")),
        );
        if (!parsed.success) {
          return {
            admitted: false,
            code: "COMPUTER_EXECUTION_FENCE_UNREADABLE",
          };
        }
      } catch (error) {
        // A record removed between listing and reading is a lowered fence.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return { admitted: false, code: "COMPUTER_EXECUTION_FENCE_UNREADABLE" };
      }
      return { admitted: false, code: "COMPUTER_SUMMARY_PHASE_ACTIVE" };
    }
    return { admitted: true };
  }

  private async syncDirectory(): Promise<void> {
    const directory = await fs.open(
      this.directory,
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
}
