import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type {
  StoredWorkspaceMutation,
  WorkspaceMutationAdmission,
  WorkspaceMutationIdentity,
  WorkspaceMutationRepository,
} from "../../app/port/workspace-mutation-repository";

const boundedId = z.string().min(1).max(160);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

const identitySchema = z.strictObject({
  operationId: boundedId,
  ownerId: boundedId,
  sessionId: boundedId,
  taskId: boundedId,
  taskEpoch: z.number().int().nonnegative(),
  participantId: boundedId,
});

const receiptSchema = z.strictObject({
  kind: z.literal("workspace.mutation"),
  operation: z.enum(["edit", "write"]),
  relativePath: z.string().min(1).max(4_096),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(8 * 1_024 * 1_024),
  replacements: z.number().int().nonnegative().max(256),
  beforeSha256: sha256.nullable(),
  afterSha256: sha256,
});

const mutationErrorCodeSchema = z.enum([
  "WORKSPACE_INVALID_REQUEST",
  "WORKSPACE_POLICY_TOO_LARGE",
  "WORKSPACE_MUTATION_CANCELLED",
  "WORKSPACE_HELPER_UNTRUSTED",
  "WORKSPACE_INTERPRETER_UNTRUSTED",
  "WORKSPACE_PATH_REFUSED",
  "WORKSPACE_ROOT_CHANGED",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_NOT_A_FILE",
  "WORKSPACE_FILE_TOO_LARGE",
  "WORKSPACE_MUTATION_CONFLICT",
  "WORKSPACE_NOT_TEXT",
  "WORKSPACE_EDIT_NO_MATCH",
  "WORKSPACE_EDIT_NOT_UNIQUE",
  "WORKSPACE_EDIT_OVERLAP",
  "WORKSPACE_HELPER_FAILED",
  "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
]);

const authorityErrorCodeSchema = z.enum([
  "AUTHORITY_OWNER_MISMATCH",
  "AUTHORITY_TASK_MISMATCH",
  "AUTHORITY_COMPUTER_MISMATCH",
  "AUTHORITY_EXPIRED",
  "AUTHORITY_INFLATION_DENIED",
  "AUTHORITY_CAPABILITY_DENIED",
  "AUTHORITY_PATH_DENIED",
  "AUTHORITY_NETWORK_DENIED",
  "AUTHORITY_COMMAND_DENIED",
  "AUTHORITY_MUTATION_OWNERSHIP_DENIED",
]);

const authorityFailureSourceSchema = z.enum([
  "computer-approval",
  "task-admission",
  "task-grant",
  "owner-restriction",
  "role",
  "computer-policy",
  "native-host",
]);

const commonSchema = z.strictObject({
  identity: identitySchema,
  workspaceId: boundedId,
  requestDigest: sha256,
});

const storedMutationSchema = z.discriminatedUnion("phase", [
  commonSchema.extend({ phase: z.literal("prepared"), outcome: z.null() }),
  commonSchema.extend({
    phase: z.literal("completed"),
    outcome: z.strictObject({ receipt: receiptSchema }),
  }),
  commonSchema.extend({
    phase: z.literal("failed"),
    outcome: z.strictObject({
      code: z.union([
        mutationErrorCodeSchema.exclude(["WORKSPACE_MUTATION_OUTCOME_UNKNOWN"]),
        authorityErrorCodeSchema,
      ]),
      source: z.union([
        z.enum(["native-workspace", "operation-store"]),
        authorityFailureSourceSchema,
      ]),
    }),
  }),
  commonSchema.extend({
    phase: z.literal("outcome_unknown"),
    outcome: z.strictObject({
      code: z.literal("WORKSPACE_MUTATION_OUTCOME_UNKNOWN"),
      source: z.enum(["native-workspace", "operation-store"]),
    }),
  }),
]);

const envelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("workspace_mutation"),
  record: storedMutationSchema,
});

const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const MAXIMUM_RECORD_BYTES = 64 * 1_024;

const mutationOperations = new Map<string, Promise<void>>();

async function withMutationOperation<Value>(
  key: string,
  operation: () => Promise<Value>,
): Promise<Value> {
  const previous = mutationOperations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutationOperations.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationOperations.get(key) === current) {
      mutationOperations.delete(key);
    }
  }
}

function identityKey(identity: WorkspaceMutationIdentity): string {
  return JSON.stringify([
    identity.operationId,
    identity.ownerId,
    identity.sessionId,
    identity.taskId,
    identity.taskEpoch,
    identity.participantId,
  ]);
}

function digestIdentity(identity: WorkspaceMutationIdentity): string {
  return createHash("sha256").update(identityKey(identity)).digest("hex");
}

function sameBinding(
  left: StoredWorkspaceMutation,
  right: StoredWorkspaceMutation,
): boolean {
  return (
    identityKey(left.identity) === identityKey(right.identity) &&
    left.workspaceId === right.workspaceId &&
    left.requestDigest === right.requestDigest
  );
}

export type PrivateWorkspaceMutationStoreOptions = Readonly<{ root: string }>;

export class PrivateWorkspaceMutationStore implements WorkspaceMutationRepository {
  constructor(private readonly options: PrivateWorkspaceMutationStoreOptions) {
    if (!path.isAbsolute(options.root)) {
      throw new Error("WORKSPACE_MUTATION_ROOT_NOT_ABSOLUTE");
    }
  }

  /** Read-only admission check under the exclusive Computer fence. */
  async settledForUpdate(): Promise<boolean> {
    const directory = path.join(this.options.root, "mutations");
    let before: Stats;
    try {
      before = await fs.lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      (before.mode & 0o077) !== 0 ||
      before.uid !== process.geteuid?.() ||
      (await fs.realpath(directory)) !== directory
    )
      throw new Error("WORKSPACE_MUTATION_DIRECTORY_UNSAFE");
    let count = 0;
    for await (const entry of await fs.opendir(directory)) {
      if (++count > 4096 || !/^[a-f0-9]{64}\.json$/u.test(entry.name))
        return false;
      const handle = await fs.open(
        path.join(directory, entry.name),
        fsConstants.O_RDONLY |
          NO_FOLLOW |
          CLOSE_ON_EXEC |
          fsConstants.O_NONBLOCK,
      );
      try {
        const info = await handle.stat();
        this.assertPrivateFile(info);
        const bytes = Buffer.alloc(MAXIMUM_RECORD_BYTES + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        const after = await handle.stat();
        if (
          bytesRead !== info.size ||
          info.size !== after.size ||
          info.mtimeMs !== after.mtimeMs
        )
          return false;
        const envelope = envelopeSchema.parse(
          JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
        );
        const record = this.validateRecord(envelope.record);
        if (
          entry.name !== `${digestIdentity(record.identity)}.json` ||
          !["completed", "failed"].includes(record.phase)
        )
          return false;
      } finally {
        await handle.close();
      }
    }
    const after = await fs.lstat(directory);
    return (
      after.isDirectory() &&
      !after.isSymbolicLink() &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.mtimeMs === after.mtimeMs
    );
  }

  async admit(
    record: StoredWorkspaceMutation,
  ): Promise<WorkspaceMutationAdmission> {
    const validated = this.validateRecord(record);
    if (validated.phase !== "prepared") {
      throw new Error("WORKSPACE_MUTATION_ADMISSION_NOT_PREPARED");
    }
    const target = this.recordFile(validated.identity);
    return withMutationOperation(target, async () => {
      const directory = await this.ensureRoot();
      await this.cleanupTemporaryFiles(target);
      const existing = await this.readRecord(target, validated.identity);
      if (existing) return { status: "existing", record: existing };
      try {
        await this.createExclusive(target, validated);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const raced = await this.readRecord(target, validated.identity);
        if (!raced) throw new Error("WORKSPACE_MUTATION_ADMISSION_UNCERTAIN");
        return { status: "existing", record: raced };
      }
      await this.syncDirectory(directory);
      return { status: "admitted", record: structuredClone(validated) };
    });
  }

  async load(
    identity: WorkspaceMutationIdentity,
  ): Promise<StoredWorkspaceMutation | null> {
    const target = this.recordFile(identity);
    return withMutationOperation(target, async () => {
      await this.ensureRoot();
      await this.cleanupTemporaryFiles(target);
      return this.readRecord(target, identity);
    });
  }

  // Historical delivery observation must not provision, repair or sweep the
  // old writer's state. This is not admission or permission to execute again.
  async loadExisting(
    identity: WorkspaceMutationIdentity,
  ): Promise<StoredWorkspaceMutation | null> {
    const target = this.recordFile(identity);
    return withMutationOperation(target, async () => {
      const directories = [this.options.root, path.dirname(target)];
      const before: Stats[] = [];
      for (const directory of directories) {
        let info;
        try {
          info = await fs.lstat(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          info.uid !== process.geteuid?.() ||
          (info.mode & 0o077) !== 0 ||
          (await fs.realpath(directory)) !== directory
        )
          throw new Error("WORKSPACE_MUTATION_DIRECTORY_UNSAFE");
        before.push(info);
      }
      const prefix = `.${path.basename(target)}.tmp-`;
      let count = 0;
      for await (const entry of await fs.opendir(path.dirname(target))) {
        if (++count > 4096 || entry.name.startsWith(prefix))
          throw new Error("WORKSPACE_MUTATION_OBSERVATION_UNCERTAIN");
      }
      const record = await this.readRecord(target, identity, true);
      for (const [index, directory] of directories.entries()) {
        const after = await fs.lstat(directory),
          prior = before[index]!;
        if (
          !after.isDirectory() ||
          after.isSymbolicLink() ||
          after.dev !== prior.dev ||
          after.ino !== prior.ino ||
          after.mode !== prior.mode ||
          after.uid !== prior.uid ||
          after.mtimeMs !== prior.mtimeMs ||
          after.ctimeMs !== prior.ctimeMs ||
          (await fs.realpath(directory)) !== directory
        )
          throw new Error("WORKSPACE_MUTATION_OBSERVATION_UNCERTAIN");
      }
      return record;
    });
  }

  async save(record: StoredWorkspaceMutation): Promise<void> {
    const validated = this.validateRecord(record);
    const target = this.recordFile(validated.identity);
    await withMutationOperation(target, async () => {
      await this.ensureRoot();
      await this.cleanupTemporaryFiles(target);
      const existing = await this.readRecord(target, validated.identity);
      if (!existing) throw new Error("WORKSPACE_MUTATION_STATE_MISSING");
      if (!sameBinding(existing, validated)) {
        throw new Error("WORKSPACE_MUTATION_BINDING_MISMATCH");
      }
      if (JSON.stringify(existing) === JSON.stringify(validated)) return;
      if (existing.phase !== "prepared" || validated.phase === "prepared") {
        throw new Error("WORKSPACE_MUTATION_TERMINAL_IMMUTABLE");
      }
      await this.atomicWrite(target, validated);
    });
  }

  private validateRecord(candidate: unknown): StoredWorkspaceMutation {
    const parsed = storedMutationSchema.safeParse(candidate);
    if (!parsed.success) throw new Error("WORKSPACE_MUTATION_STATE_INVALID");
    return structuredClone(parsed.data) as StoredWorkspaceMutation;
  }

  private async readRecord(
    file: string,
    identity: WorkspaceMutationIdentity,
    observationOnly = false,
  ): Promise<StoredWorkspaceMutation | null> {
    let handle;
    try {
      handle = await fs.open(
        file,
        fsConstants.O_RDONLY |
          NO_FOLLOW |
          CLOSE_ON_EXEC |
          (observationOnly ? fsConstants.O_NONBLOCK : 0),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const info = await handle.stat();
      this.assertPrivateFile(info);
      let serialized: string;
      if (observationOnly) {
        const bytes = Buffer.alloc(MAXIMUM_RECORD_BYTES + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        const after = await handle.stat(),
          named = await fs.lstat(file);
        this.assertPrivateFile(after);
        this.assertPrivateFile(named);
        if (
          bytesRead !== info.size ||
          [after, named].some(
            (value) =>
              value.dev !== info.dev ||
              value.ino !== info.ino ||
              value.size !== info.size ||
              value.mtimeMs !== info.mtimeMs ||
              value.ctimeMs !== info.ctimeMs,
          )
        )
          throw new Error("WORKSPACE_MUTATION_OBSERVATION_UNCERTAIN");
        serialized = bytes.subarray(0, bytesRead).toString("utf8");
      } else serialized = await handle.readFile("utf8");
      let value: unknown;
      try {
        value = JSON.parse(serialized);
      } catch {
        throw new Error("WORKSPACE_MUTATION_STATE_CORRUPT");
      }
      const parsed = envelopeSchema.safeParse(value);
      if (!parsed.success) throw new Error("WORKSPACE_MUTATION_STATE_CORRUPT");
      const record = this.validateRecord(parsed.data.record);
      if (identityKey(record.identity) !== identityKey(identity)) {
        throw new Error("WORKSPACE_MUTATION_BINDING_MISMATCH");
      }
      return record;
    } finally {
      await handle.close();
    }
  }

  private async createExclusive(
    target: string,
    record: StoredWorkspaceMutation,
  ): Promise<void> {
    const temporary = this.temporaryFile(target);
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
        await handle.writeFile(this.serialize(record), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.link(temporary, target);
      await fs.unlink(temporary);
      temporaryExists = false;
    } finally {
      if (temporaryExists) {
        await fs.unlink(temporary).catch(() => undefined);
      }
    }
  }

  private async atomicWrite(
    target: string,
    record: StoredWorkspaceMutation,
  ): Promise<void> {
    const temporary = this.temporaryFile(target);
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
        await handle.writeFile(this.serialize(record), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, target);
      temporaryExists = false;
      await this.syncDirectory(path.dirname(target));
    } finally {
      if (temporaryExists) {
        await fs.unlink(temporary).catch(() => undefined);
      }
    }
  }

  private serialize(record: StoredWorkspaceMutation): string {
    const serialized = `${JSON.stringify({
      schemaVersion: 1,
      kind: "workspace_mutation",
      record,
    })}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_RECORD_BYTES) {
      throw new Error("WORKSPACE_MUTATION_STATE_OVERSIZED");
    }
    return serialized;
  }

  private async ensureRoot(): Promise<string> {
    await this.ensurePrivateDirectory(this.options.root);
    const directory = path.join(this.options.root, "mutations");
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
      throw new Error("WORKSPACE_MUTATION_DIRECTORY_UNSAFE");
    }
    if ((info.mode & 0o077) !== 0) await fs.chmod(directory, 0o700);
  }

  private assertPrivateFile(info: Stats): void {
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size < 1 ||
      info.size > MAXIMUM_RECORD_BYTES ||
      (process.geteuid?.() !== undefined && info.uid !== process.geteuid()) ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error("WORKSPACE_MUTATION_STATE_UNSAFE");
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

  private async cleanupTemporaryFiles(target: string): Promise<void> {
    const directory = path.dirname(target);
    const prefix = `.${path.basename(target)}.tmp-`;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    let changed = false;
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix)) continue;
      const temporary = path.join(directory, entry.name);
      const info = await fs.lstat(temporary);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (process.geteuid?.() !== undefined && info.uid !== process.geteuid()) ||
        (info.mode & 0o077) !== 0
      ) {
        throw new Error("WORKSPACE_MUTATION_STATE_UNSAFE");
      }
      await fs.unlink(temporary);
      changed = true;
    }
    if (changed) await this.syncDirectory(directory);
  }

  private temporaryFile(target: string): string {
    return path.join(
      path.dirname(target),
      `.${path.basename(target)}.tmp-${randomBytes(8).toString("hex")}`,
    );
  }

  private recordFile(identity: WorkspaceMutationIdentity): string {
    return path.join(
      this.options.root,
      "mutations",
      `${digestIdentity(identity)}.json`,
    );
  }
}
