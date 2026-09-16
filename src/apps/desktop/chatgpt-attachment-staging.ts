import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const MAX_CHATGPT_ATTACHMENTS = 4;
export const MAX_CHATGPT_ATTACHMENT_BYTES = 10 * 1_024 * 1_024;
export const MAX_CHATGPT_ATTACHMENT_TOTAL_BYTES = 20 * 1_024 * 1_024;

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type ChatGptAttachmentMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "application/pdf"
  | "text/plain"
  | "text/markdown";

export type StagedChatGptAttachment = Readonly<{
  name: string;
  mimeType: ChatGptAttachmentMimeType;
  bytes: number;
  sha256: string;
  stagedPath: string;
}>;

export type StagedChatGptAttachments = Readonly<{
  operationId: string;
  attachments: readonly StagedChatGptAttachment[];
}>;

function attachmentError(code: string): never {
  throw new Error(code);
}

function assertOwnedDirectory(info: Stats): void {
  const effectiveUser = process.geteuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (effectiveUser !== undefined && info.uid !== effectiveUser)
  ) {
    attachmentError("ATTACHMENT_STAGING_UNSAFE");
  }
}

async function ensurePrivateRoot(root: string): Promise<void> {
  if (!path.isAbsolute(root) || root.includes("\0")) {
    attachmentError("ATTACHMENT_STAGING_UNSAFE");
  }
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(root);
  assertOwnedDirectory(info);
  if ((info.mode & 0o077) !== 0) await fs.chmod(root, 0o700);
}

function assertOwnedSource(info: Stats): void {
  const effectiveUser = process.geteuid?.();
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (effectiveUser !== undefined && info.uid !== effectiveUser)
  ) {
    attachmentError("ATTACHMENT_SOURCE_UNSAFE");
  }
}

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function attachmentMimeType(
  name: string,
  bytes: Buffer,
): ChatGptAttachmentMimeType {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  const extension = path.extname(name).toLowerCase();
  if (![".txt", ".md", ".markdown"].includes(extension)) {
    attachmentError("ATTACHMENT_TYPE_UNSUPPORTED");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) attachmentError("ATTACHMENT_TYPE_UNSUPPORTED");
  } catch {
    attachmentError("ATTACHMENT_TYPE_UNSUPPORTED");
  }
  return extension === ".txt" ? "text/plain" : "text/markdown";
}

async function readAttachment(source: string): Promise<{
  name: string;
  bytes: Buffer;
  mimeType: ChatGptAttachmentMimeType;
}> {
  if (!path.isAbsolute(source) || source.includes("\0")) {
    attachmentError("ATTACHMENT_SOURCE_UNSAFE");
  }
  const name = path.basename(source);
  if (name.length === 0 || name === "." || name === "..") {
    attachmentError("ATTACHMENT_SOURCE_UNSAFE");
  }
  let handle;
  try {
    handle = await fs.open(
      source,
      fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") attachmentError("ATTACHMENT_SOURCE_MISSING");
    attachmentError("ATTACHMENT_SOURCE_UNSAFE");
  }
  try {
    const info = await handle.stat();
    assertOwnedSource(info);
    if (info.size <= 0) attachmentError("ATTACHMENT_EMPTY");
    if (info.size > MAX_CHATGPT_ATTACHMENT_BYTES) {
      attachmentError("ATTACHMENT_TOO_LARGE");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== info.size) {
      attachmentError("ATTACHMENT_SOURCE_CHANGED");
    }
    return { name, bytes, mimeType: attachmentMimeType(name, bytes) };
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(target: string, bytes: Buffer): Promise<void> {
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
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function stageChatGptAttachments(
  input: Readonly<{
    root: string;
    operationId: string;
    paths: readonly string[];
  }>,
): Promise<StagedChatGptAttachments> {
  if (!OPERATION_ID.test(input.operationId)) {
    attachmentError("ATTACHMENT_OPERATION_INVALID");
  }
  if (
    input.paths.length === 0 ||
    input.paths.length > MAX_CHATGPT_ATTACHMENTS ||
    input.paths.length !== new Set(input.paths).size
  ) {
    attachmentError("ATTACHMENT_SELECTION_INVALID");
  }
  await ensurePrivateRoot(input.root);
  const operationRoot = path.join(input.root, input.operationId);
  try {
    await fs.mkdir(operationRoot, { mode: 0o700 });
  } catch {
    attachmentError("ATTACHMENT_OPERATION_CONFLICT");
  }

  const attachments: StagedChatGptAttachment[] = [];
  const names = new Set<string>();
  let totalBytes = 0;
  try {
    for (const source of input.paths) {
      const selected = await readAttachment(source);
      if (names.has(selected.name)) {
        attachmentError("ATTACHMENT_DUPLICATE_NAME");
      }
      names.add(selected.name);
      totalBytes += selected.bytes.byteLength;
      if (totalBytes > MAX_CHATGPT_ATTACHMENT_TOTAL_BYTES) {
        attachmentError("ATTACHMENT_TOTAL_TOO_LARGE");
      }
      const stagedPath = path.join(operationRoot, selected.name);
      await writePrivateFile(stagedPath, selected.bytes);
      attachments.push({
        name: selected.name,
        mimeType: selected.mimeType,
        bytes: selected.bytes.byteLength,
        sha256: createHash("sha256").update(selected.bytes).digest("hex"),
        stagedPath,
      });
    }
    return { operationId: input.operationId, attachments };
  } catch (error) {
    await fs.rm(operationRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function discardChatGptAttachments(
  root: string,
  operationId: string,
): Promise<void> {
  if (!path.isAbsolute(root) || !OPERATION_ID.test(operationId)) {
    attachmentError("ATTACHMENT_STAGING_UNSAFE");
  }
  try {
    assertOwnedDirectory(await fs.lstat(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await fs.rm(path.join(root, operationId), { recursive: true, force: true });
}

export async function verifyStagedChatGptAttachments(
  staged: StagedChatGptAttachments,
): Promise<void> {
  for (const attachment of staged.attachments) {
    let handle;
    try {
      handle = await fs.open(
        attachment.stagedPath,
        fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        attachmentError("ATTACHMENT_REFERENCE_MISSING");
      }
      attachmentError("ATTACHMENT_REFERENCE_UNSAFE");
    }
    try {
      const info = await handle.stat();
      const effectiveUser = process.geteuid?.();
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        (effectiveUser !== undefined && info.uid !== effectiveUser) ||
        (info.mode & 0o077) !== 0
      ) {
        attachmentError("ATTACHMENT_REFERENCE_UNSAFE");
      }
      if (info.size !== attachment.bytes) {
        attachmentError("ATTACHMENT_REFERENCE_CHANGED");
      }
      const bytes = await handle.readFile();
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (
        bytes.byteLength !== attachment.bytes ||
        digest !== attachment.sha256
      ) {
        attachmentError("ATTACHMENT_REFERENCE_CHANGED");
      }
    } finally {
      await handle.close();
    }
  }
}

export async function cleanupChatGptAttachmentStaging(
  root: string,
): Promise<void> {
  if (!path.isAbsolute(root)) attachmentError("ATTACHMENT_STAGING_UNSAFE");
  let entries;
  try {
    assertOwnedDirectory(await fs.lstat(root));
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((entry) => OPERATION_ID.test(entry.name))
      .map((entry) =>
        fs.rm(path.join(root, entry.name), { recursive: true, force: true }),
      ),
  );
}
