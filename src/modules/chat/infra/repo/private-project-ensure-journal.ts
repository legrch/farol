import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type {
  ProjectEnsureIntent,
  ProjectEnsureJournal,
} from "../../app/port/codex-project-ensure";
import type { HandoffWorkspace } from "../../app/service/persistent-codex-handoff";

const absolute = z
  .string()
  .refine(
    (value) =>
      value !== "/" &&
      path.isAbsolute(value) &&
      path.normalize(value) === value &&
      Buffer.byteLength(value) <= 4096 &&
      !/[\u0000-\u001f\u007f\\]/u.test(value),
  );
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/u);
const keySchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
const projectSchema = z.strictObject({
  root: absolute,
  device: z.string().regex(/^(0|[1-9][0-9]*)$/u),
  inode: z.string().regex(/^(0|[1-9][0-9]*)$/u),
  gitCommonDirectory: absolute,
});
const intentSchema = z.strictObject({
  key: keySchema,
  name: z
    .string()
    .refine(
      (value) =>
        value.length > 0 &&
        value.trim() === value &&
        !/[\u0000-\u001f\u007f]/u.test(value) &&
        Buffer.byteLength(value) <= 200,
    ),
  project: projectSchema,
  acknowledgedProjectId: z.null(),
});
const confirmationSchema = z.strictObject({
  key: keySchema,
  projectId: identifier,
});
type Identity = Readonly<{ dev: bigint; ino: bigint }>;
const sameIdentity = (a: Identity, b: Identity) =>
  a.dev === b.dev && a.ino === b.ino;
const sameProject = (
  a: HandoffWorkspace["project"],
  b: HandoffWorkspace["project"],
) =>
  a.root === b.root &&
  a.device === b.device &&
  a.inode === b.inode &&
  a.gitCommonDirectory === b.gitCommonDirectory;
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const exists = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "EEXIST";
function hostSupported() {
  if (
    ![constants.O_NOFOLLOW, constants.O_NONBLOCK, constants.O_DIRECTORY].every(
      (flag) => Number.isInteger(flag) && flag > 0,
    ) ||
    process.getuid?.() === undefined
  )
    throw Error("PROJECT_ENSURE_JOURNAL_HOST_UNSUPPORTED");
}
function owned(info: BigIntStats, mode: bigint) {
  return (
    info.uid === BigInt(process.getuid!()) && (info.mode & 0o777n) === mode
  );
}

/** Unwired private journal. The caller supplies an existing canonical 0700 root.
 * Atomic mkdir reserves one physical repository across all request keys. No
 * failed/partial intent is removed; there is no TTL, PID-based stealing or retry.
 * Directory pinning is observational, not protection against a hostile same-owner
 * process atomically replacing paths between Node pathname operations. */
export class PrivateProjectEnsureJournal implements ProjectEnsureJournal {
  private rootIdentity: Identity | undefined;
  private readonly entryIdentities = new Map<string, Identity>();
  constructor(private readonly root: string) {
    if (!absolute.safeParse(root).success)
      throw Error("PROJECT_ENSURE_JOURNAL_ROOT_INVALID");
  }
  private async directory(target: string, expected?: Identity) {
    hostSupported();
    const info = await fs.lstat(target, { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !owned(info, 0o700n) ||
      (await fs.realpath(target)) !== target ||
      (expected && !sameIdentity(expected, info))
    )
      throw Error("PROJECT_ENSURE_JOURNAL_DIRECTORY_UNSAFE");
    return info;
  }
  private async rootDirectory() {
    const info = await this.directory(this.root, this.rootIdentity);
    if (this.rootIdentity && !sameIdentity(this.rootIdentity, info))
      throw Error("PROJECT_ENSURE_JOURNAL_ROOT_CHANGED");
    this.rootIdentity ??= { dev: info.dev, ino: info.ino };
    return info;
  }
  private entry(project: HandoffWorkspace["project"]) {
    // Path aliases or metadata drift must hit the old intent and refuse rather
    // than create a second bucket for the same physical canonical directory.
    const parsed = projectSchema.parse(project);
    return path.join(
      this.root,
      createHash("sha256")
        .update(JSON.stringify([parsed.device, parsed.inode]))
        .digest("hex"),
    );
  }
  private async entryDirectory(entry: string) {
    const info = await this.directory(entry, this.entryIdentities.get(entry));
    const current = this.entryIdentities.get(entry);
    if (current && !sameIdentity(current, info))
      throw Error("PROJECT_ENSURE_JOURNAL_ENTRY_CHANGED");
    this.entryIdentities.set(entry, { dev: info.dev, ino: info.ino });
    return info;
  }
  private async check(entry: string) {
    await this.rootDirectory();
    await this.entryDirectory(entry);
  }
  private async syncDirectory(target: string, identity: Identity) {
    const handle = await fs.open(
      target,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const current = await handle.stat({ bigint: true });
      if (
        !current.isDirectory() ||
        !sameIdentity(identity, current) ||
        !owned(current, 0o700n)
      )
        throw Error("PROJECT_ENSURE_JOURNAL_DIRECTORY_CHANGED");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  private async readFile(file: string, limit: number): Promise<unknown> {
    const handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        !owned(before, 0o600n) ||
        before.size > BigInt(limit)
      )
        throw Error("PROJECT_ENSURE_JOURNAL_FILE_UNSAFE");
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await handle.readFile(),
        ),
      );
      const after = await handle.stat({ bigint: true });
      const named = await fs.lstat(file, { bigint: true });
      if (
        !sameIdentity(before, after) ||
        !sameIdentity(after, named) ||
        named.isSymbolicLink() ||
        !owned(after, 0o600n) ||
        after.nlink !== 1n ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw Error("PROJECT_ENSURE_JOURNAL_FILE_CHANGED");
      // Recovery stabilizes a complete record left before its writer's fsync
      // acknowledgement. It cannot produce another provider-side operation.
      await handle.sync();
      return value;
    } finally {
      await handle.close();
    }
  }
  private async publish(file: string, value: unknown, limit: number) {
    const text = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(text) > limit)
      throw Error("PROJECT_ENSURE_JOURNAL_RECORD_TOO_LARGE");
    const handle = await fs.open(
      file,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.nlink !== 1n || !owned(info, 0o600n))
        throw Error("PROJECT_ENSURE_JOURNAL_FILE_UNSAFE");
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async read(
    project: HandoffWorkspace["project"],
  ): Promise<ProjectEnsureIntent | null> {
    const selected = projectSchema.parse(project),
      entry = this.entry(selected);
    await this.rootDirectory();
    try {
      await this.entryDirectory(entry);
    } catch (error) {
      if (!missing(error)) throw error;
      if (this.entryIdentities.has(entry))
        throw Error("PROJECT_ENSURE_JOURNAL_ENTRY_LOST");
      await this.rootDirectory();
      return null;
    }
    const pending = intentSchema.parse(
      await this.readFile(path.join(entry, "intent.json"), 16384),
    );
    if (!sameProject(pending.project, selected))
      throw Error("PROJECT_ENSURE_JOURNAL_PROJECT_CHANGED");
    let confirmation: z.infer<typeof confirmationSchema> | null = null;
    try {
      confirmation = confirmationSchema.parse(
        await this.readFile(path.join(entry, "confirmation.json"), 2048),
      );
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (confirmation && confirmation.key !== pending.key)
      throw Error("PROJECT_ENSURE_JOURNAL_CONFIRMATION_CONFLICT");
    await this.check(entry);
    await this.syncDirectory(entry, this.entryIdentities.get(entry)!);
    await this.syncDirectory(this.root, this.rootIdentity!);
    await this.check(entry);
    return {
      ...pending,
      acknowledgedProjectId: confirmation?.projectId ?? null,
    };
  }
  async claim(intent: ProjectEnsureIntent): Promise<boolean> {
    const pending = intentSchema.parse(intent),
      entry = this.entry(pending.project);
    await this.rootDirectory();
    if (this.entryIdentities.has(entry)) {
      await this.check(entry);
      return false;
    }
    try {
      await fs.mkdir(entry, { mode: 0o700 });
    } catch (error) {
      if (!exists(error)) throw error;
      await this.check(entry);
      return false;
    }
    await this.check(entry);
    await this.syncDirectory(this.root, this.rootIdentity!);
    await this.publish(path.join(entry, "intent.json"), pending, 16384);
    await this.check(entry);
    await this.syncDirectory(entry, this.entryIdentities.get(entry)!);
    await this.syncDirectory(this.root, this.rootIdentity!);
    await this.check(entry);
    const stored = await this.read(pending.project);
    if (
      !stored ||
      stored.key !== pending.key ||
      stored.name !== pending.name ||
      stored.acknowledgedProjectId !== null
    )
      throw Error("PROJECT_ENSURE_JOURNAL_INTENT_READBACK_UNKNOWN");
    return true;
  }
  async confirm(
    project: HandoffWorkspace["project"],
    key: string,
    projectId: string,
  ): Promise<void> {
    const selected = projectSchema.parse(project),
      value = confirmationSchema.parse({ key, projectId });
    const current = await this.read(selected);
    if (!current || current.key !== value.key)
      throw Error("PROJECT_ENSURE_JOURNAL_CONFIRMATION_CONFLICT");
    if (
      current.acknowledgedProjectId !== null &&
      current.acknowledgedProjectId !== value.projectId
    )
      throw Error("PROJECT_ENSURE_JOURNAL_CONFIRMATION_CONFLICT");
    const entry = this.entry(selected);
    await this.check(entry);
    if (current.acknowledgedProjectId === null) {
      try {
        await this.publish(path.join(entry, "confirmation.json"), value, 2048);
      } catch (error) {
        if (!exists(error)) throw error;
      }
    }
    const after = await this.read(selected);
    if (
      !after ||
      after.key !== value.key ||
      after.acknowledgedProjectId !== value.projectId
    )
      throw Error("PROJECT_ENSURE_JOURNAL_CONFIRMATION_CONFLICT");
  }
}
