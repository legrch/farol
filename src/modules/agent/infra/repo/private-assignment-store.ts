import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  AssignmentAdmission,
  AssignmentRepository,
  StoredAssignment,
} from "../../app/port/assignment-repository";
import type { AssignmentIdentity } from "../../domain/assignment";

const boundedId = z.string().min(1).max(160);

const identitySchema = z.strictObject({
  assignmentId: boundedId,
  ownerId: boundedId,
  sessionId: boundedId,
  taskId: boundedId,
  taskEpoch: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
});

const authoritySchema = z.strictObject({
  authorityId: boundedId,
  participantId: boundedId,
  parentParticipantId: boundedId,
  role: z.enum(["agent", "critic"]),
  mutationOwnership: z.enum(["none", "task"]),
});

const terminalReasonSchema = z.strictObject({
  code: boundedId,
  source: z.enum(["native-host", "native-host-transport", "recovery"]),
  retry: z.literal("never"),
});

const assignmentSchema = z.strictObject({
  identity: identitySchema,
  authority: authoritySchema,
  phase: z.enum([
    "prepared",
    "running",
    "completed",
    "failed",
    "outcome_unknown",
  ]),
  childId: boundedId.nullable(),
  terminal: z.boolean(),
  terminalReason: terminalReasonSchema.nullable(),
});

const storedAssignmentSchema = z.strictObject({
  assignment: assignmentSchema,
  resultRef: z.string().min(1).max(4_096).nullable(),
});

const envelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("agent_assignment"),
  record: storedAssignmentSchema,
});

const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const DEFAULT_MAXIMUM_RECORD_BYTES = 64 * 1_024;

export type PrivateAssignmentStoreOptions = Readonly<{
  root: string;
  maximumRecordBytes?: number;
}>;

export type AssignmentAtomicWriteHooks = Readonly<{
  beforeCommit?: (target: string) => Promise<void>;
}>;

function digestIdentity(identity: AssignmentIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity.assignmentId,
        identity.ownerId,
        identity.sessionId,
        identity.taskId,
        identity.taskEpoch,
        identity.generation,
      ]),
    )
    .digest("hex");
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function phaseRank(phase: StoredAssignment["assignment"]["phase"]): number {
  return phase === "prepared" ? 0 : phase === "running" ? 1 : 2;
}

export class PrivateAssignmentStore implements AssignmentRepository {
  private readonly maximumRecordBytes: number;

  constructor(
    private readonly options: PrivateAssignmentStoreOptions,
    private readonly hooks: AssignmentAtomicWriteHooks = {},
  ) {
    if (!path.isAbsolute(options.root)) {
      throw new Error("AGENT_ASSIGNMENT_ROOT_NOT_ABSOLUTE");
    }
    this.maximumRecordBytes = positiveInteger(
      options.maximumRecordBytes ?? DEFAULT_MAXIMUM_RECORD_BYTES,
      "AGENT_ASSIGNMENT_BUDGET_INVALID",
    );
  }

  async admit(record: StoredAssignment): Promise<AssignmentAdmission> {
    const validated = this.validateRecord(
      record,
      "AGENT_ASSIGNMENT_STATE_INVALID",
    );
    const directory = await this.ensureRoot();
    const target = this.recordFile(validated.assignment.identity);
    const existing = await this.readRecord(
      target,
      validated.assignment.identity,
    );
    if (existing) return { status: "existing", record: existing };

    try {
      await this.createExclusive(target, validated);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await this.readRecord(
        target,
        validated.assignment.identity,
      );
      if (!raced) throw new Error("AGENT_ASSIGNMENT_ADMISSION_UNCERTAIN");
      return { status: "existing", record: raced };
    }
    await this.syncDirectory(directory);
    return { status: "admitted", record: structuredClone(validated) };
  }

  async save(record: StoredAssignment): Promise<void> {
    const validated = this.validateRecord(
      record,
      "AGENT_ASSIGNMENT_STATE_INVALID",
    );
    await this.ensureRoot();
    const target = this.recordFile(validated.assignment.identity);
    const existing = await this.readRecord(
      target,
      validated.assignment.identity,
    );
    if (!existing) throw new Error("AGENT_ASSIGNMENT_STATE_MISSING");
    if (sameValue(existing, validated)) return;
    this.assertMonotonic(existing, validated);
    await this.atomicWrite(target, validated);
  }

  private validateRecord(candidate: unknown, code: string): StoredAssignment {
    const parsed = storedAssignmentSchema.safeParse(candidate);
    if (!parsed.success) throw new Error(code);
    const record = parsed.data;
    const assignment = record.assignment;
    const valid =
      (assignment.phase === "prepared" &&
        !assignment.terminal &&
        assignment.childId === null &&
        assignment.terminalReason === null &&
        record.resultRef === null) ||
      (assignment.phase === "running" &&
        !assignment.terminal &&
        assignment.childId !== null &&
        assignment.terminalReason === null &&
        record.resultRef === null) ||
      (assignment.phase === "completed" &&
        assignment.terminal &&
        assignment.childId !== null &&
        assignment.terminalReason === null &&
        record.resultRef !== null) ||
      ((assignment.phase === "failed" ||
        assignment.phase === "outcome_unknown") &&
        assignment.terminal &&
        assignment.terminalReason !== null &&
        record.resultRef === null);
    if (!valid) throw new Error(code);
    return structuredClone(record);
  }

  private assertMonotonic(
    existing: StoredAssignment,
    replacement: StoredAssignment,
  ): void {
    if (
      !sameValue(
        existing.assignment.identity,
        replacement.assignment.identity,
      ) ||
      !sameValue(
        existing.assignment.authority,
        replacement.assignment.authority,
      )
    ) {
      throw new Error("AGENT_ASSIGNMENT_BINDING_MISMATCH");
    }
    if (existing.assignment.terminal) {
      throw new Error("AGENT_ASSIGNMENT_TERMINAL_IMMUTABLE");
    }
    if (
      phaseRank(replacement.assignment.phase) <
      phaseRank(existing.assignment.phase)
    ) {
      throw new Error("AGENT_ASSIGNMENT_STALE_WRITE");
    }
    if (
      existing.assignment.childId !== null &&
      replacement.assignment.childId !== existing.assignment.childId
    ) {
      throw new Error("AGENT_ASSIGNMENT_CHILD_MISMATCH");
    }
  }

  private async readRecord(
    file: string,
    identity: AssignmentIdentity,
  ): Promise<StoredAssignment | null> {
    let handle;
    try {
      handle = await fs.open(
        file,
        fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const info = await handle.stat();
      this.assertPrivateFile(info);
      const serialized = await handle.readFile("utf8");
      let value: unknown;
      try {
        value = JSON.parse(serialized);
      } catch {
        throw new Error("AGENT_ASSIGNMENT_STATE_CORRUPT");
      }
      const parsed = envelopeSchema.safeParse(value);
      if (!parsed.success) throw this.schemaError(value);
      const record = this.validateRecord(
        parsed.data.record,
        "AGENT_ASSIGNMENT_STATE_CORRUPT",
      );
      if (!sameValue(record.assignment.identity, identity)) {
        throw new Error("AGENT_ASSIGNMENT_BINDING_MISMATCH");
      }
      return record;
    } finally {
      await handle.close();
    }
  }

  private schemaError(value: unknown): Error {
    if (
      value &&
      typeof value === "object" &&
      "schemaVersion" in value &&
      (value as { schemaVersion?: unknown }).schemaVersion !== 1
    ) {
      return new Error("AGENT_ASSIGNMENT_STATE_UNSUPPORTED");
    }
    return new Error("AGENT_ASSIGNMENT_STATE_CORRUPT");
  }

  private async createExclusive(
    target: string,
    record: StoredAssignment,
  ): Promise<void> {
    const serialized = this.serialize(record);
    const handle = await fs.open(
      target,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
      0o600,
    );
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async atomicWrite(
    target: string,
    record: StoredAssignment,
  ): Promise<void> {
    const serialized = this.serialize(record);
    const directory = path.dirname(target);
    const temporary = path.join(
      directory,
      `.${path.basename(target)}.tmp-${randomBytes(8).toString("hex")}`,
    );
    const handle = await fs.open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
      0o600,
    );
    let temporaryExists = true;
    try {
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.hooks.beforeCommit?.(target);
      await fs.rename(temporary, target);
      temporaryExists = false;
      await this.syncDirectory(directory);
    } finally {
      if (temporaryExists) {
        await fs.unlink(temporary).catch(() => undefined);
      }
    }
  }

  private serialize(record: StoredAssignment): string {
    const serialized = `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent_assignment",
      record,
    })}\n`;
    if (Buffer.byteLength(serialized, "utf8") > this.maximumRecordBytes) {
      throw new Error("AGENT_ASSIGNMENT_STATE_OVERSIZED");
    }
    return serialized;
  }

  private async ensureRoot(): Promise<string> {
    await this.ensurePrivateDirectory(this.options.root);
    const directory = path.join(this.options.root, "assignments");
    await this.ensurePrivateDirectory(directory);
    return directory;
  }

  private async ensurePrivateDirectory(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.geteuid?.() !== undefined && info.uid !== process.geteuid())
    ) {
      throw new Error("AGENT_ASSIGNMENT_DIRECTORY_UNSAFE");
    }
    if ((info.mode & 0o077) !== 0) await fs.chmod(directory, 0o700);
  }

  private assertPrivateFile(info: Stats): void {
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size < 1 ||
      info.size > this.maximumRecordBytes ||
      (process.geteuid?.() !== undefined && info.uid !== process.geteuid()) ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error("AGENT_ASSIGNMENT_STATE_UNSAFE");
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(
      directory,
      fsConstants.O_RDONLY | DIRECTORY | NO_FOLLOW | CLOSE_ON_EXEC,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private recordFile(identity: AssignmentIdentity): string {
    return path.join(
      this.options.root,
      "assignments",
      `${digestIdentity(identity)}.json`,
    );
  }
}
