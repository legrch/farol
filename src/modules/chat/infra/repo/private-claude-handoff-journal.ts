import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { TaskModelBindingSchema } from "../../../../pkg/owner-config/contract";
import type {
  ClaudeIntent,
  ClaudeJournal,
  ClaudeTerminal,
} from "../../app/port/claude-handoff";
const UUID = z.string().uuid();
const Absolute = z
  .string()
  .max(4096)
  .refine(
    (v) =>
      v !== "/" &&
      path.isAbsolute(v) &&
      path.normalize(v) === v &&
      !/[\u0000-\u001f\u007f\\]/u.test(v),
  );
const Root = z.strictObject({
  root: Absolute,
  device: z.string().regex(/^[0-9]+$/u),
  inode: z.string().regex(/^[0-9]+$/u),
  gitCommonDirectory: Absolute,
});
const Intent = z.strictObject({
  sessionId: UUID,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  workspaceId: z.string().min(1).max(120),
  projectId: z.string().min(1).max(120),
  workspace: Root.extend({
    project: Root,
    execution: z.strictObject({
      sandbox: z.enum(["read-only", "workspace-write"]),
      approvalPolicy: z.enum(["untrusted", "on-request"]),
    }),
  }),
  modelBinding: TaskModelBindingSchema.refine(
    (v) => v.selection.harness === "claude-code",
  ),
});
const Terminal = z
  .strictObject({
    lifecycle: z.enum(["completed", "failed", "needs_input"]),
    sessionId: UUID,
    actualModel: z.string().min(1).max(120),
    exitCode: z.number().int().min(0).max(1),
    text: z
      .string()
      .refine((v) => !v.includes("\0") && Buffer.byteLength(v) <= 32768),
  })
  .refine((v) => v.lifecycle === "failed" || v.exitCode === 0);
function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
async function directory(root: string, create: boolean) {
  if (create) await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    stat.uid !== process.getuid?.() ||
    (await fs.realpath(root)) !== root
  )
    throw Error("CLAUDE_JOURNAL_DIRECTORY_UNSAFE");
}
async function syncDirectory(root: string) {
  const file = await fs.open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function readFile(file: string, limit: number): Promise<unknown> {
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK)
    throw Error("CLAUDE_JOURNAL_HOST_UNSUPPORTED");
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 ||
      before.uid !== process.getuid?.() ||
      before.size > limit
    )
      throw Error("CLAUDE_JOURNAL_FILE_UNSAFE");
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw Error("CLAUDE_JOURNAL_FILE_CHANGED");
    return value;
  } finally {
    await handle.close();
  }
}
async function publish(file: string, value: unknown, limit: number) {
  const text = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(text) > limit) throw Error("CLAUDE_JOURNAL_TOO_LARGE");
  const handle = await fs.open(
    file,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}
/** A crash-created empty/partial claim is unknown, never another dispatch. */
export class PrivateClaudeHandoffJournal implements ClaudeJournal {
  constructor(private readonly root: string) {
    if (!Absolute.safeParse(root).success)
      throw Error("CLAUDE_JOURNAL_ROOT_INVALID");
  }
  private entry(key: string) {
    return path.join(this.root, UUID.parse(key).toLowerCase());
  }
  async read(key: string): Promise<ClaudeIntent | null> {
    const entry = this.entry(key);
    await directory(this.root, true);
    try {
      await directory(entry, false);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    const record = Intent.parse(
      await readFile(path.join(entry, "intent.json"), 16384),
    );
    if (record.sessionId !== key.toLowerCase())
      throw Error("CLAUDE_JOURNAL_CORRELATION");
    return record;
  }
  async claim(key: string, value: ClaudeIntent): Promise<boolean> {
    const entry = this.entry(key);
    const parsed = Intent.parse(value);
    if (parsed.sessionId !== key.toLowerCase())
      throw Error("CLAUDE_JOURNAL_CORRELATION");
    await directory(this.root, true);
    try {
      await fs.mkdir(entry, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    await syncDirectory(this.root);
    await publish(path.join(entry, "intent.json"), parsed, 16384);
    return true;
  }
  async terminal(key: string): Promise<ClaudeTerminal | null> {
    const intent = await this.read(key);
    if (!intent) return null;
    let value: unknown;
    try {
      value = await readFile(
        path.join(this.entry(key), "terminal.json"),
        40000,
      );
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    const terminal = Terminal.parse(value);
    if (
      terminal.sessionId !== intent.sessionId ||
      terminal.actualModel !== intent.modelBinding.selection.model
    )
      throw Error("CLAUDE_JOURNAL_CORRELATION");
    return terminal;
  }
  async finish(key: string, value: ClaudeTerminal): Promise<ClaudeTerminal> {
    const intent = await this.read(key);
    const parsed = Terminal.parse(value);
    if (
      !intent ||
      parsed.sessionId !== intent.sessionId ||
      parsed.actualModel !== intent.modelBinding.selection.model
    )
      throw Error("CLAUDE_JOURNAL_CORRELATION");
    try {
      await publish(path.join(this.entry(key), "terminal.json"), parsed, 40000);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const result = await this.terminal(key);
    if (!result) throw Error("CLAUDE_JOURNAL_READBACK_MISSING");
    return result;
  }
}
